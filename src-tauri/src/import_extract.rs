use std::{
    fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Mutex, MutexGuard, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use base64::{engine::general_purpose, Engine as _};
use calamine::{open_workbook_auto, Reader};
use tauri::Manager;
use zip::ZipArchive;

use crate::ffmpeg_component;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

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

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportExtractUrlRequest {
    url: String,
}

#[derive(serde::Serialize)]
pub struct ImportExtractUrlResponse {
    url: String,
    text: String,
}

static PDFIUM: OnceLock<Result<pdfium_render::prelude::Pdfium, String>> = OnceLock::new();
static PDFIUM_LOCK: Mutex<()> = Mutex::new(());
static PDFIUM_RESOURCE_DIR_HINT: OnceLock<PathBuf> = OnceLock::new();

pub fn set_pdfium_resource_dir_hint(dir: PathBuf) {
    let _ = PDFIUM_RESOURCE_DIR_HINT.set(dir);
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

#[tauri::command]
pub async fn import_extract_url(
    app: tauri::AppHandle,
    request: ImportExtractUrlRequest,
) -> Result<ImportExtractUrlResponse, String> {
    let url = normalize_import_url(&request.url)?;
    let sidecar_app = app.clone();
    let sidecar_url = url.clone();
    let sidecar_result =
        tauri::async_runtime::spawn_blocking(move || extract_url_with_markitdown(&sidecar_app, &sidecar_url))
            .await
            .map_err(|error| format!("URL extraction thread failed: {error}"))?;

    if let Ok(text) = sidecar_result.as_ref() {
        if is_useful_imported_web_text(text) {
            return Ok(ImportExtractUrlResponse {
                url,
                text: text.trim().to_string(),
            });
        }
    }

    let fallback_text = fetch_url_readable_text(&url)
        .await
        .map_err(|error| match sidecar_result {
            Ok(_) => error,
            Err(sidecar_error) => format!("{error}; MarkItDown URL conversion failed: {sidecar_error}"),
        })?;
    if !is_useful_imported_web_text(&fallback_text) {
        return Err("URL extraction did not return useful page content. The site may require verification, login, or block automated access.".to_string());
    }

    Ok(ImportExtractUrlResponse {
        url,
        text: fallback_text.trim().to_string(),
    })
}

fn extract_bytes_to_markdown(
    app: &tauri::AppHandle,
    filename: &str,
    mime_type: &str,
    bytes: &[u8],
) -> Result<String, String> {
    let extension = file_extension(filename);
    let normalized_mime = mime_type.to_ascii_lowercase();

    if extension == "pdf" || normalized_mime == "application/pdf" {
        if let Ok(text) = extract_pdf_text(bytes) {
            if is_useful_pdf_text(&text) {
                return Ok(text);
            }
        }
        if let Ok(text) = extract_with_markitdown(app, filename, &extension, bytes) {
            if is_useful_pdf_text(&text) {
                return Ok(text);
            }
        }
        return extract_pdf_text_with_pdf_extract(bytes);
    }

    if is_audio_video_extension(&extension) || normalized_mime.starts_with("audio/") || normalized_mime.starts_with("video/") {
        if !ffmpeg_component::has_usable_ffmpeg(app) {
            return Err(
                "音视频解析需要先安装 MyWiki 音视频解析组件 ffmpeg。请到设置页安装后重试。".to_string(),
            );
        }
        let text = extract_with_markitdown(app, filename, &extension, bytes)?;
        if text.trim().is_empty() {
            return Err(format!("{filename} 没有提取到可用的音视频转写内容。"));
        }
        return Ok(text);
    }

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

    if extension == "pptx" || normalized_mime.contains("presentationml") {
        return extract_pptx_text(bytes);
    }

    if extension == "zip" || normalized_mime.contains("zip") {
        return extract_zip_text(filename, bytes);
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
    let result = run_markitdown_converter(app, &converter_path, &input_path);
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

fn run_markitdown_converter(app: &tauri::AppHandle, converter_path: &Path, input_path: &Path) -> Result<String, String> {
    let mut command = Command::new(converter_path);
    hide_child_console(&mut command);
    ffmpeg_component::configure_ffmpeg_env(app, &mut command);
    let output = command
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

fn extract_url_with_markitdown(app: &tauri::AppHandle, url: &str) -> Result<String, String> {
    let converter_path = find_markitdown_converter(app)
        .ok_or_else(|| "Bundled MarkItDown converter was not found.".to_string())?;
    run_markitdown_url_converter(app, &converter_path, url)
}

fn run_markitdown_url_converter(app: &tauri::AppHandle, converter_path: &Path, url: &str) -> Result<String, String> {
    let mut command = Command::new(converter_path);
    hide_child_console(&mut command);
    ffmpeg_component::configure_ffmpeg_env(app, &mut command);
    let output = command
        .arg("--url")
        .arg(url)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("MarkItDown URL converter failed to start: {error}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() && !stdout.is_empty() {
        return Ok(normalize_text(&stdout));
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("MarkItDown URL converter exited with {}", output.status)
    } else {
        format!("MarkItDown URL conversion failed: {stderr}")
    })
}

#[cfg(windows)]
fn hide_child_console(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_child_console(_command: &mut Command) {}

async fn fetch_url_readable_text(url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(std::time::Duration::from_secs(45))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MyWiki/0.1 Safari/537.36")
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(url)
        .header(
            reqwest::header::ACCEPT,
            "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        )
        .send()
        .await
        .map_err(|error| format!("URL fetch failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("URL fetch failed with HTTP {status}."));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let body = response
        .text()
        .await
        .map_err(|error| format!("URL response could not be read: {error}"))?;

    let trimmed = body.trim_start().to_ascii_lowercase();
    if content_type.contains("html") || trimmed.starts_with("<!doctype") || trimmed.starts_with("<html") {
        Ok(strip_html_text(&body))
    } else {
        Ok(normalize_text(&body))
    }
}

fn normalize_import_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("Only HTTP(S) URLs are supported.".to_string());
    }
    if trimmed.chars().any(|ch| ch.is_control()) {
        return Err("URL contains an invalid control character.".to_string());
    }
    Ok(trimmed.to_string())
}

fn is_useful_imported_web_text(value: &str) -> bool {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = normalized.to_ascii_lowercase();
    normalized.chars().count() >= 80
        && !lower.contains("captcha")
        && !lower.contains("verify you are human")
        && !lower.contains("server error")
        && !lower.contains("521")
        && !normalized.contains("环境异常")
        && !normalized.contains("完成验证")
        && !normalized.contains("去验证")
        && !normalized.contains("访问验证")
        && !normalized.contains("安全验证")
        && !normalized.contains("验证码")
        && !normalized.contains("滑块验证")
}

fn extract_pdf_text(bytes: &[u8]) -> Result<String, String> {
    match extract_pdf_text_with_pdfium(bytes) {
        Ok(text) if is_useful_pdf_text(&text) => Ok(text),
        Ok(_) => extract_pdf_text_with_pdf_extract(bytes),
        Err(pdfium_error) => extract_pdf_text_with_pdf_extract(bytes)
            .map_err(|fallback_error| format!("{pdfium_error}; fallback failed: {fallback_error}")),
    }
}

fn extract_pdf_text_with_pdfium(bytes: &[u8]) -> Result<String, String> {
    use pdfium_render::prelude::*;

    let _guard = lock_pdfium();
    let pdfium = pdfium()?;
    let document = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|error| match error {
            PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::PasswordError) => {
                "PDF is password-protected and cannot be read.".to_string()
            }
            _ => format!("PDFium failed to open PDF: {error}"),
        })?;

    let page_count = document.pages().len();
    let mut output = String::new();
    for (page_index, page) in document.pages().iter().enumerate() {
        let page_number = page_index + 1;
        if !output.is_empty() {
            output.push_str("\n\n");
        }
        output.push_str(&format!("-- {page_number} of {page_count} --\n\n"));
        let page_text = page
            .text()
            .map_err(|error| format!("PDFium failed to extract text from page {page_number}: {error}"))?;
        output.push_str(&page_text.all());
    }

    let normalized = normalize_text(&output);
    if is_useful_pdf_text(&normalized) {
        Ok(normalized)
    } else {
        Err("PDFium extracted too little useful text.".to_string())
    }
}

fn extract_pdf_text_with_pdf_extract(bytes: &[u8]) -> Result<String, String> {
    let result = std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem(bytes));
    match result {
        Ok(Ok(text)) => Ok(normalize_text(&text)),
        Ok(Err(error)) => Err(format!("PDF 文本解析失败：{error}")),
        Err(_) => Err("PDF 文本解析失败：解析器遇到异常。".to_string()),
    }
}

fn lock_pdfium() -> MutexGuard<'static, ()> {
    PDFIUM_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn pdfium() -> Result<&'static pdfium_render::prelude::Pdfium, String> {
    PDFIUM
        .get_or_init(|| {
            use pdfium_render::prelude::*;
            let candidates = pdfium_candidate_paths();
            for path in &candidates {
                if let Ok(bindings) = Pdfium::bind_to_library(path) {
                    return Ok(Pdfium::new(bindings));
                }
            }
            Pdfium::bind_to_system_library()
                .map(Pdfium::new)
                .map_err(|error| {
                    let tried = if candidates.is_empty() {
                        "(no bundled candidates)".to_string()
                    } else {
                        candidates.join(", ")
                    };
                    format!("Failed to locate Pdfium library. Tried: {tried}. Last error: {error}")
                })
        })
        .as_ref()
        .map_err(|error| error.clone())
}

fn pdfium_candidate_paths() -> Vec<String> {
    let mut paths = Vec::new();
    if let Ok(path) = std::env::var("PDFIUM_DYNAMIC_LIB_PATH") {
        paths.push(path);
    }

    if let Some(resource_dir) = PDFIUM_RESOURCE_DIR_HINT.get() {
        push_pdfium_paths(&mut paths, resource_dir);
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            push_pdfium_paths(&mut paths, exe_dir);
            push_pdfium_paths(&mut paths, &exe_dir.join("resources"));
            #[cfg(target_os = "macos")]
            {
                push_pdfium_paths(&mut paths, &exe_dir.join("../Frameworks"));
                push_pdfium_paths(&mut paths, &exe_dir.join("../Resources"));
            }
        }
    }

    push_pdfium_paths(&mut paths, Path::new("src-tauri"));
    paths
}

fn push_pdfium_paths(paths: &mut Vec<String>, root: &Path) {
    #[cfg(target_os = "windows")]
    {
        paths.push(root.join("pdfium").join("pdfium.dll").to_string_lossy().into_owned());
        paths.push(root.join("pdfium.dll").to_string_lossy().into_owned());
        paths.push(root.join("libpdfium.dll").to_string_lossy().into_owned());
    }
    #[cfg(target_os = "macos")]
    {
        paths.push(root.join("pdfium").join("libpdfium.dylib").to_string_lossy().into_owned());
        paths.push(root.join("libpdfium.dylib").to_string_lossy().into_owned());
    }
    #[cfg(target_os = "linux")]
    {
        paths.push(root.join("pdfium").join("libpdfium.so").to_string_lossy().into_owned());
        paths.push(root.join("libpdfium.so").to_string_lossy().into_owned());
    }
}

fn is_useful_pdf_text(value: &str) -> bool {
    let semantic_len = value
        .replace(|ch: char| ch.is_whitespace() || ch.is_ascii_punctuation() || ch.is_ascii_digit(), "")
        .chars()
        .count();
    semantic_len >= 80 || value.contains("-- 1 of ")
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

fn extract_zip_text(filename: &str, bytes: &[u8]) -> Result<String, String> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|error| format!("ZIP 读取失败：{error}"))?;
    let mut sections = vec![format!("# 压缩包：{filename}")];
    let mut extracted = 0usize;
    let mut skipped = 0usize;

    for index in 0..archive.len() {
        if extracted >= 40 {
            skipped += 1;
            continue;
        }
        let mut file = archive
            .by_index(index)
            .map_err(|error| format!("ZIP 文件列表读取失败：{error}"))?;
        if file.is_dir() {
            continue;
        }
        let name = file.name().to_string();
        let extension = file_extension(&name);
        if !is_readable_zip_member(&extension) {
            skipped += 1;
            continue;
        }
        let mut text = String::new();
        file.read_to_string(&mut text)
            .map_err(|error| format!("ZIP 内文件 {name} 不是可读 UTF-8 文本：{error}"))?;
        let normalized = if is_html_extension(&extension) {
            strip_html_text(&text)
        } else {
            normalize_text(&text)
        };
        if normalized.trim().is_empty() {
            continue;
        }
        extracted += 1;
        sections.push(format!("## {name}\n\n{}", truncate_chars(&normalized, 12000)));
    }

    if skipped > 0 {
        sections.push(format!("...压缩包中还有 {skipped} 个未展开文件或超出上限文件。"));
    }
    if extracted == 0 {
        return Err(format!("{filename} 没有提取到可读文本文件。"));
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

fn is_audio_video_extension(extension: &str) -> bool {
    matches!(extension, "wav" | "mp3" | "m4a" | "mp4")
}

fn is_readable_zip_member(extension: &str) -> bool {
    matches!(
        extension,
        "txt" | "md" | "markdown" | "json" | "jsonl" | "xml" | "html" | "htm" | "csv" | "tsv"
    )
}

fn should_try_markitdown(extension: &str, mime_type: &str) -> bool {
    matches!(
        extension,
        "pdf" | "doc" | "docx" | "ppt" | "pptx" | "xls" | "xlsx" | "xlsm" | "xlsb" | "ods" | "html" | "htm" | "zip" | "wav" | "mp3" | "m4a" | "mp4"
    ) || mime_type.contains("pdf")
        || mime_type.contains("word")
        || mime_type.contains("presentation")
        || mime_type.contains("powerpoint")
        || mime_type.contains("spreadsheet")
        || mime_type.contains("excel")
        || mime_type.contains("html")
        || mime_type.contains("zip")
        || mime_type.starts_with("audio/")
        || mime_type.starts_with("video/")
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

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut output = String::new();
    for (index, ch) in value.chars().enumerate() {
        if index >= max_chars {
            output.push_str("\n\n...内容已截断。");
            break;
        }
        output.push(ch);
    }
    output
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
