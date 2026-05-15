use std::{
    fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose, Engine as _};
use calamine::{open_workbook_auto, Reader};
use tauri::Manager;
use zip::ZipArchive;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportExtractRequest {
    filename: String,
    mime_type: Option<String>,
    data_base64: String,
}

#[derive(serde::Serialize)]
pub struct ImportExtractResponse {
    text: String,
}

#[tauri::command]
pub async fn import_extract_text(
    app: tauri::AppHandle,
    request: ImportExtractRequest,
) -> Result<ImportExtractResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let data_base64 = request
            .data_base64
            .split_once(',')
            .map(|(_, value)| value)
            .unwrap_or(request.data_base64.as_str());
        let bytes = general_purpose::STANDARD
            .decode(data_base64)
            .map_err(|error| format!("文件内容 Base64 解码失败：{error}"))?;
        let text = extract_bytes_to_markdown(
            &app,
            &request.filename,
            request.mime_type.as_deref().unwrap_or(""),
            &bytes,
        )?;
        Ok(ImportExtractResponse { text })
    })
    .await
    .map_err(|error| format!("文件解析线程失败：{error}"))?
}

fn extract_bytes_to_markdown(
    app: &tauri::AppHandle,
    filename: &str,
    mime_type: &str,
    bytes: &[u8],
) -> Result<String, String> {
    let extension = file_extension(filename);
    let normalized_mime = mime_type.to_ascii_lowercase();

    if should_try_markitdown(&extension, &normalized_mime) {
        if let Ok(text) = extract_with_markitdown(app, filename, &extension, bytes) {
            if !text.trim().is_empty() {
                return Ok(text);
            }
        }
    }

    if is_text_extension(&extension) || normalized_mime.starts_with("text/") {
        return Ok(normalize_text(&String::from_utf8_lossy(bytes)));
    }

    if is_html_extension(&extension) || normalized_mime.contains("html") {
        return Ok(strip_html_text(&String::from_utf8_lossy(bytes)));
    }

    if is_csv_extension(&extension) || normalized_mime.contains("csv") || normalized_mime.contains("tab-separated-values") {
        return extract_csv_text(bytes, if extension == "tsv" { b'\t' } else { b',' });
    }

    if is_spreadsheet_extension(&extension) || is_spreadsheet_mime(&normalized_mime) {
        return extract_spreadsheet_text(filename, &extension, bytes);
    }

    if extension == "docx" || normalized_mime.contains("wordprocessingml") {
        return extract_docx_text(bytes);
    }

    if extension == "pdf" || normalized_mime == "application/pdf" {
        return extract_pdf_text(bytes);
    }

    if extension == "pptx" || normalized_mime.contains("presentationml") {
        return extract_pptx_text(bytes);
    }

    if is_image_extension(&extension) || normalized_mime.starts_with("image/") {
        return Ok(String::new());
    }

    Err(format!("{filename} 的格式暂不支持。"))
}

fn extract_with_markitdown(
    app: &tauri::AppHandle,
    filename: &str,
    extension: &str,
    bytes: &[u8],
) -> Result<String, String> {
    let converter_path = find_markitdown_converter(app)
        .ok_or_else(|| "未找到随安装包分发的 MarkItDown 转换器。".to_string())?;
    let input_path = write_temp_import_file(filename, extension, bytes)?;
    let result = run_markitdown_converter(&converter_path, &input_path);
    let _ = fs::remove_file(&input_path);
    result
}

fn find_markitdown_converter(app: &tauri::AppHandle) -> Option<PathBuf> {
    let exe_name = if cfg!(windows) {
        "mywiki-markitdown.exe"
    } else {
        "mywiki-markitdown"
    };
    let mut candidates = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join(exe_name));
        candidates.push(resource_dir.join("binaries").join(exe_name));
        candidates.push(resource_dir.join("resources").join(exe_name));
    }
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            candidates.push(exe_dir.join(exe_name));
            candidates.push(exe_dir.join("binaries").join(exe_name));
            candidates.push(exe_dir.join("resources").join(exe_name));
        }
    }
    candidates.push(PathBuf::from("src-tauri").join("binaries").join(exe_name));
    candidates.push(PathBuf::from("resources").join(exe_name));

    candidates.into_iter().find(|path| path.exists())
}

fn run_markitdown_converter(converter_path: &Path, input_path: &Path) -> Result<String, String> {
    let output = Command::new(converter_path)
        .arg(input_path)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("MarkItDown 转换器启动失败：{error}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() && !stdout.is_empty() {
        return Ok(normalize_text(&stdout));
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("MarkItDown 转换器退出失败：{}", output.status)
    } else {
        format!("MarkItDown 转换失败：{stderr}")
    })
}

fn extract_pdf_text(bytes: &[u8]) -> Result<String, String> {
    let result = std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem(bytes));
    match result {
        Ok(Ok(text)) => Ok(normalize_text(&text)),
        Ok(Err(error)) => Err(format!("PDF 文本解析失败：{error}")),
        Err(_) => Err("PDF 文本解析失败：解析器遇到异常。".to_string()),
    }
}

fn extract_docx_text(bytes: &[u8]) -> Result<String, String> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|error| format!("DOCX 压缩包读取失败：{error}"))?;
    let xml = read_zip_file_to_string(&mut archive, "word/document.xml")?;
    Ok(extract_office_xml_text(&xml))
}

fn extract_pptx_text(bytes: &[u8]) -> Result<String, String> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|error| format!("PPTX 压缩包读取失败：{error}"))?;
    let mut slide_files = Vec::new();
    for index in 0..archive.len() {
        let file = archive
            .by_index(index)
            .map_err(|error| format!("PPTX 文件列表读取失败：{error}"))?;
        let name = file.name().to_string();
        if is_pptx_slide_file(&name) {
            slide_files.push(name);
        }
    }
    slide_files.sort_by_key(|name| pptx_slide_number(name));

    let mut sections = Vec::new();
    for name in slide_files {
        let xml = read_zip_file_to_string(&mut archive, &name)?;
        let text = extract_office_xml_text(&xml);
        if !text.is_empty() {
            sections.push(format!("## 幻灯片 {}\n\n{text}", pptx_slide_number(&name)));
        }
    }

    Ok(sections.join("\n\n"))
}

fn extract_spreadsheet_text(filename: &str, extension: &str, bytes: &[u8]) -> Result<String, String> {
    let temp_path = write_temp_import_file(filename, extension, bytes)?;
    let result = extract_spreadsheet_text_from_path(&temp_path);
    let _ = fs::remove_file(&temp_path);
    result
}

fn extract_spreadsheet_text_from_path(path: &Path) -> Result<String, String> {
    let mut workbook = open_workbook_auto(path).map_err(|error| format!("表格文件读取失败：{error}"))?;
    let sheet_names = workbook.sheet_names().to_owned();
    let mut sections = Vec::new();

    for sheet_name in sheet_names {
        let range = workbook
            .worksheet_range(&sheet_name)
            .map_err(|error| format!("工作表 {sheet_name} 读取失败：{error}"))?;
        let mut rows = Vec::new();
        for (index, row) in range.rows().enumerate() {
            if index >= 500 {
                rows.push(format!("...该工作表还有更多行，已保留前 500 行用于编译。"));
                break;
            }
            let line = row
                .iter()
                .map(|cell| clean_cell_text(&cell.to_string()))
                .filter(|cell| !cell.is_empty())
                .collect::<Vec<_>>()
                .join(" | ");
            if !line.is_empty() {
                rows.push(line);
            }
        }
        if !rows.is_empty() {
            sections.push(format!("## 工作表：{sheet_name}\n\n{}", rows.join("\n")));
        }
    }

    Ok(sections.join("\n\n"))
}

fn extract_csv_text(bytes: &[u8], delimiter: u8) -> Result<String, String> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(delimiter)
        .from_reader(bytes);
    let mut rows = Vec::new();
    for (index, record) in reader.records().enumerate() {
        if index >= 500 {
            rows.push("...该表格还有更多行，已保留前 500 行用于编译。".to_string());
            break;
        }
        let record = record.map_err(|error| format!("CSV/TSV 读取失败：{error}"))?;
        let line = record
            .iter()
            .map(clean_cell_text)
            .filter(|cell| !cell.is_empty())
            .collect::<Vec<_>>()
            .join(" | ");
        if !line.is_empty() {
            rows.push(line);
        }
    }
    Ok(rows.join("\n"))
}

fn read_zip_file_to_string(archive: &mut ZipArchive<Cursor<&[u8]>>, name: &str) -> Result<String, String> {
    let mut file = archive
        .by_name(name)
        .map_err(|error| format!("压缩包内文件 {name} 读取失败：{error}"))?;
    let mut xml = String::new();
    file.read_to_string(&mut xml)
        .map_err(|error| format!("压缩包内文件 {name} 不是有效 UTF-8：{error}"))?;
    Ok(xml)
}

fn extract_office_xml_text(xml: &str) -> String {
    let mut output = String::new();
    let mut cursor = 0;
    while let Some(relative_start) = xml[cursor..].find('<') {
        let start = cursor + relative_start;
        let Some(relative_end) = xml[start..].find('>') else {
            break;
        };
        let end = start + relative_end;
        let tag = xml[start + 1..end].trim();
        let local = xml_local_name(tag);

        if is_text_start_tag(tag, local) {
            let tag_name = tag.split_whitespace().next().unwrap_or("").trim_end_matches('/');
            let closing = format!("</{tag_name}>");
            let content_start = end + 1;
            if let Some(relative_close) = xml[content_start..].find(&closing) {
                let close_start = content_start + relative_close;
                output.push_str(&decode_xml_entities(&xml[content_start..close_start]));
                cursor = close_start + closing.len();
                continue;
            }
        }

        if tag.starts_with('/') {
            match local {
                "p" | "tr" => push_line_break(&mut output),
                "tc" => push_cell_separator(&mut output),
                _ => {}
            }
        } else if local == "br" {
            push_line_break(&mut output);
        }

        cursor = end + 1;
    }

    normalize_text(&output)
}

fn strip_html_text(html: &str) -> String {
    let mut output = String::new();
    let mut in_tag = false;
    let mut tag = String::new();

    for ch in html.chars() {
        match ch {
            '<' => {
                in_tag = true;
                tag.clear();
            }
            '>' if in_tag => {
                in_tag = false;
                let tag_name = tag
                    .trim()
                    .trim_start_matches('/')
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if matches!(
                    tag_name.as_str(),
                    "p" | "div" | "section" | "article" | "li" | "tr" | "br" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
                ) {
                    push_line_break(&mut output);
                }
            }
            _ if in_tag => tag.push(ch),
            _ => output.push(ch),
        }
    }

    normalize_text(&decode_xml_entities(&output))
}

fn write_temp_import_file(filename: &str, extension: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let safe_stem = sanitize_filename(
        Path::new(filename)
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("input"),
    );
    let ext = if extension.is_empty() { "bin" } else { extension };
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let path = std::env::temp_dir().join(format!("mywiki-import-{}-{nanos}-{safe_stem}.{ext}", std::process::id()));
    fs::write(&path, bytes).map_err(|error| format!("临时文件写入失败：{error}"))?;
    Ok(path)
}

fn sanitize_filename(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect::<String>();
    if sanitized.trim().is_empty() {
        "input".to_string()
    } else {
        sanitized
    }
}

fn file_extension(filename: &str) -> String {
    Path::new(filename)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn is_text_extension(extension: &str) -> bool {
    matches!(extension, "txt" | "md" | "markdown" | "json" | "jsonl" | "xml")
}

fn is_html_extension(extension: &str) -> bool {
    matches!(extension, "html" | "htm")
}

fn is_csv_extension(extension: &str) -> bool {
    matches!(extension, "csv" | "tsv")
}

fn is_spreadsheet_extension(extension: &str) -> bool {
    matches!(extension, "xls" | "xlsx" | "xlsm" | "xlsb" | "ods")
}

fn is_spreadsheet_mime(mime_type: &str) -> bool {
    mime_type.contains("spreadsheet")
        || mime_type.contains("excel")
        || mime_type.contains("opendocument.spreadsheet")
}

fn is_image_extension(extension: &str) -> bool {
    matches!(extension, "png" | "jpg" | "jpeg" | "webp" | "bmp" | "gif" | "tif" | "tiff")
}

fn should_try_markitdown(extension: &str, mime_type: &str) -> bool {
    matches!(
        extension,
        "pdf" | "doc" | "docx" | "ppt" | "pptx" | "xls" | "xlsx" | "xlsm" | "xlsb" | "ods" | "html" | "htm"
    ) || mime_type.contains("pdf")
        || mime_type.contains("word")
        || mime_type.contains("presentation")
        || mime_type.contains("powerpoint")
        || mime_type.contains("spreadsheet")
        || mime_type.contains("excel")
        || mime_type.contains("html")
}

fn is_pptx_slide_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with("ppt/slides/slide") && lower.ends_with(".xml")
}

fn pptx_slide_number(name: &str) -> u32 {
    name.rsplit_once("slide")
        .and_then(|(_, tail)| tail.strip_suffix(".xml"))
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0)
}

fn is_text_start_tag(tag: &str, local: &str) -> bool {
    !tag.starts_with('/') && !tag.starts_with('?') && !tag.starts_with('!') && local == "t"
}

fn xml_local_name(tag: &str) -> &str {
    let name = tag
        .trim_start_matches('/')
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim_end_matches('/');
    name.rsplit_once(':').map(|(_, local)| local).unwrap_or(name)
}

fn push_line_break(output: &mut String) {
    if !output.ends_with('\n') {
        output.push('\n');
    }
}

fn push_cell_separator(output: &mut String) {
    if !output.trim_end().ends_with('|') && !output.ends_with('\n') {
        output.push_str(" | ");
    }
}

fn clean_cell_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn decode_xml_entities(value: &str) -> String {
    let mut output = String::new();
    let mut cursor = 0;
    while let Some(relative_start) = value[cursor..].find('&') {
        let start = cursor + relative_start;
        output.push_str(&value[cursor..start]);
        let Some(relative_end) = value[start..].find(';') else {
            output.push_str(&value[start..]);
            return output;
        };
        let end = start + relative_end;
        let entity = &value[start + 1..end];
        match decode_entity(entity) {
            Some(ch) => output.push(ch),
            None => {
                output.push('&');
                output.push_str(entity);
                output.push(';');
            }
        }
        cursor = end + 1;
    }
    output.push_str(&value[cursor..]);
    output
}

fn decode_entity(entity: &str) -> Option<char> {
    match entity {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "nbsp" => Some(' '),
        _ if entity.starts_with("#x") => u32::from_str_radix(&entity[2..], 16).ok().and_then(char::from_u32),
        _ if entity.starts_with('#') => entity[1..].parse::<u32>().ok().and_then(char::from_u32),
        _ => None,
    }
}

fn normalize_text(value: &str) -> String {
    let mut normalized = String::new();
    let mut blank_count = 0;
    for line in value.replace('\r', "\n").lines() {
        let trimmed = clean_cell_text(line);
        if trimmed.is_empty() {
            blank_count += 1;
            if blank_count <= 1 && !normalized.ends_with("\n\n") && !normalized.is_empty() {
                normalized.push('\n');
            }
            continue;
        }
        blank_count = 0;
        if !normalized.is_empty() && !normalized.ends_with('\n') {
            normalized.push('\n');
        }
        normalized.push_str(&trimmed);
        normalized.push('\n');
    }
    normalized.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_text_from_office_xml() {
        let xml = r#"<w:document><w:p><w:r><w:t>项目</w:t></w:r><w:r><w:t>计划</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:document>"#;
        assert_eq!(extract_office_xml_text(xml), "项目计划\n第二段");
    }

    #[test]
    fn strips_html_text() {
        assert_eq!(strip_html_text("<h1>标题</h1><p>A&amp;B</p>"), "标题\nA&B");
    }
}
