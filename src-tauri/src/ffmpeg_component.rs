use std::{
    fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

use sha2::{Digest, Sha256};
use tauri::Manager;
use zip::ZipArchive;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const FFMPEG_COMPONENT_VERSION: &str = "6.1.1";
const FFMPEG_COMPONENT_MAX_BYTES: usize = 200 * 1024 * 1024;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegInstallRequest {
    download_url: String,
    sha256_url: Option<String>,
    expected_sha256: Option<String>,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegComponentStatus {
    supported: bool,
    available: bool,
    installed: bool,
    source: String,
    version: Option<String>,
    executable_path: Option<String>,
    component_path: String,
    install_dir: String,
    component_version: String,
    platform: String,
    arch: String,
    asset_name: Option<String>,
    message: Option<String>,
}

#[tauri::command]
pub fn ffmpeg_component_status(app: tauri::AppHandle) -> Result<FfmpegComponentStatus, String> {
    build_status(&app)
}

#[tauri::command]
pub async fn ffmpeg_component_install(
    app: tauri::AppHandle,
    request: FfmpegInstallRequest,
) -> Result<FfmpegComponentStatus, String> {
    if asset_name().is_none() {
        return Err("当前平台暂不支持 MyWiki 音视频解析组件。".to_string());
    }

    let download_url = validate_http_url(&request.download_url)?;
    let sha256_url = request
        .sha256_url
        .as_deref()
        .map(validate_http_url)
        .transpose()?;
    let expected_sha256 = expected_sha256(&download_url, sha256_url.as_deref(), request.expected_sha256.as_deref()).await?;
    let archive_bytes = download_component_archive(&download_url).await?;
    verify_sha256(&archive_bytes, &expected_sha256)?;

    tauri::async_runtime::spawn_blocking(move || {
        let install_dir = component_install_dir(&app)?;
        install_ffmpeg_zip_bytes(&archive_bytes, &install_dir)?;
        build_status(&app)
    })
    .await
    .map_err(|error| format!("音视频解析组件安装线程失败：{error}"))?
}

#[tauri::command]
pub fn ffmpeg_component_remove(app: tauri::AppHandle) -> Result<FfmpegComponentStatus, String> {
    let install_dir = component_install_dir(&app)?;
    if install_dir.exists() {
        fs::remove_dir_all(&install_dir).map_err(|error| format!("移除音视频解析组件失败：{error}"))?;
    }
    build_status(&app)
}

pub fn configure_ffmpeg_env(app: &tauri::AppHandle, command: &mut Command) {
    let Some(path) = find_component_ffmpeg(app) else {
        return;
    };
    let Some(parent) = path.parent() else {
        return;
    };

    command.env("MYWIKI_FFMPEG_PATH", &path);
    command.env("FFMPEG_BINARY", &path);
    let path_value = std::env::var_os("PATH").unwrap_or_default();
    let mut paths = std::env::split_paths(&path_value).collect::<Vec<_>>();
    paths.insert(0, parent.to_path_buf());
    if let Ok(joined) = std::env::join_paths(paths) {
        command.env("PATH", joined);
    }
}

pub fn has_usable_ffmpeg(app: &tauri::AppHandle) -> bool {
    find_component_ffmpeg(app).is_some() || command_version("ffmpeg").is_ok()
}

fn build_status(app: &tauri::AppHandle) -> Result<FfmpegComponentStatus, String> {
    let install_dir = component_install_dir(app)?;
    let component_path = install_dir.join(executable_name());
    let supported = asset_name().is_some();

    if component_path.exists() {
        match executable_version(&component_path) {
            Ok(version) => {
                return Ok(status(
                    supported,
                    true,
                    true,
                    "component",
                    Some(version),
                    Some(component_path.clone()),
                    install_dir,
                    None,
                ));
            }
            Err(error) => {
                return Ok(status(
                    supported,
                    false,
                    true,
                    "broken",
                    None,
                    Some(component_path.clone()),
                    install_dir,
                    Some(format!("已安装的音视频解析组件无法启动：{error}")),
                ));
            }
        }
    }

    if let Ok(version) = command_version("ffmpeg") {
        return Ok(status(
            supported,
            true,
            false,
            "system",
            Some(version),
            Some(PathBuf::from("ffmpeg")),
            install_dir,
            None,
        ));
    }

    Ok(status(
        supported,
        false,
        false,
        "missing",
        None,
        None,
        install_dir,
        if supported {
            Some("未安装音视频解析组件；处理 MP3、MP4、M4A、WAV 等材料前需要先安装 ffmpeg。".to_string())
        } else {
            Some("当前平台暂不支持 MyWiki 自动安装音视频解析组件。".to_string())
        },
    ))
}

fn status(
    supported: bool,
    available: bool,
    installed: bool,
    source: &str,
    version: Option<String>,
    executable_path: Option<PathBuf>,
    install_dir: PathBuf,
    message: Option<String>,
) -> FfmpegComponentStatus {
    let component_path = install_dir.join(executable_name());
    FfmpegComponentStatus {
        supported,
        available,
        installed,
        source: source.to_string(),
        version,
        executable_path: executable_path.map(|path| path.to_string_lossy().replace('\\', "/")),
        component_path: component_path.to_string_lossy().replace('\\', "/"),
        install_dir: install_dir.to_string_lossy().replace('\\', "/"),
        component_version: FFMPEG_COMPONENT_VERSION.to_string(),
        platform: platform_label().to_string(),
        arch: arch_label().to_string(),
        asset_name: asset_name(),
        message,
    }
}

fn find_component_ffmpeg(app: &tauri::AppHandle) -> Option<PathBuf> {
    let path = component_install_dir(app).ok()?.join(executable_name());
    executable_version(&path).ok()?;
    Some(path)
}

fn component_install_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("tools")
        .join("ffmpeg")
        .join(FFMPEG_COMPONENT_VERSION))
}

fn install_ffmpeg_zip_bytes(bytes: &[u8], install_dir: &Path) -> Result<(), String> {
    let parent = install_dir
        .parent()
        .ok_or_else(|| "音视频解析组件安装目录无效。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建音视频组件目录失败：{error}"))?;

    let temp_dir = parent.join(format!("installing-{}", unique_suffix()?));
    if temp_dir.exists() {
        fs::remove_dir_all(&temp_dir).map_err(|error| format!("清理临时组件目录失败：{error}"))?;
    }
    fs::create_dir_all(&temp_dir).map_err(|error| format!("创建临时组件目录失败：{error}"))?;

    let result = extract_ffmpeg_zip_bytes(bytes, &temp_dir).and_then(|path| {
        let version = executable_version(&path)?;
        write_manifest(&temp_dir, &version)?;
        if install_dir.exists() {
            fs::remove_dir_all(install_dir).map_err(|error| format!("替换旧音视频组件失败：{error}"))?;
        }
        fs::rename(&temp_dir, install_dir).map_err(|error| format!("提交音视频组件安装失败：{error}"))
    });

    if result.is_err() {
        let _ = fs::remove_dir_all(&temp_dir);
    }
    result
}

fn extract_ffmpeg_zip_bytes(bytes: &[u8], target_dir: &Path) -> Result<PathBuf, String> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|error| format!("音视频组件压缩包无效：{error}"))?;
    let mut ffmpeg_bytes = None;
    let exe_name = executable_name();

    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|error| format!("读取音视频组件压缩包失败：{error}"))?;
        if file.is_dir() {
            continue;
        }
        let name = Path::new(file.name())
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        if name.eq_ignore_ascii_case(exe_name) {
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)
                .map_err(|error| format!("读取 ffmpeg 可执行文件失败：{error}"))?;
            ffmpeg_bytes = Some(bytes);
            break;
        }
    }

    let ffmpeg_bytes = ffmpeg_bytes.ok_or_else(|| format!("音视频组件压缩包中没有找到 {exe_name}。"))?;
    let output_path = target_dir.join(exe_name);
    fs::write(&output_path, ffmpeg_bytes).map_err(|error| format!("写入 ffmpeg 可执行文件失败：{error}"))?;
    make_executable(&output_path)?;
    Ok(output_path)
}

fn write_manifest(dir: &Path, version: &str) -> Result<(), String> {
    let manifest = serde_json::json!({
        "component": "ffmpeg",
        "componentVersion": FFMPEG_COMPONENT_VERSION,
        "version": version,
        "installedAt": unique_suffix()?,
    });
    fs::write(dir.join("manifest.json"), serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?)
        .map_err(|error| format!("写入音视频组件清单失败：{error}"))
}

async fn expected_sha256(download_url: &str, sha256_url: Option<&str>, explicit: Option<&str>) -> Result<String, String> {
    if let Some(value) = explicit {
        return normalize_sha256(value);
    }
    let sha_url = sha256_url.ok_or_else(|| "安装音视频解析组件必须提供 SHA256 校验文件。".to_string())?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(45))
        .user_agent("MyWiki/0.1 ffmpeg-component")
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(sha_url)
        .send()
        .await
        .map_err(|error| format!("下载音视频组件校验文件失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("下载音视频组件校验文件失败：HTTP {}", response.status()));
    }
    let text = response
        .text()
        .await
        .map_err(|error| format!("读取音视频组件校验文件失败：{error}"))?;
    normalize_sha256(&text).map_err(|error| format!("{error} 下载地址：{download_url}"))
}

async fn download_component_archive(url: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .timeout(std::time::Duration::from_secs(300))
        .user_agent("MyWiki/0.1 ffmpeg-component")
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("下载音视频解析组件失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("下载音视频解析组件失败：HTTP {}", response.status()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取音视频解析组件失败：{error}"))?;
    if bytes.len() > FFMPEG_COMPONENT_MAX_BYTES {
        return Err(format!(
            "音视频解析组件过大：{} MB，已拒绝安装。",
            bytes.len() / 1024 / 1024
        ));
    }
    Ok(bytes.to_vec())
}

fn verify_sha256(bytes: &[u8], expected: &str) -> Result<(), String> {
    let actual = sha256_hex(bytes);
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(format!("音视频解析组件 SHA256 校验失败：期望 {expected}，实际 {actual}。"))
    }
}

fn normalize_sha256(value: &str) -> Result<String, String> {
    let hash = value
        .split_whitespace()
        .find(|part| part.len() == 64 && part.chars().all(|ch| ch.is_ascii_hexdigit()))
        .ok_or_else(|| "SHA256 校验文件格式无效。".to_string())?;
    Ok(hash.to_ascii_lowercase())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn executable_version(path: &Path) -> Result<String, String> {
    let mut command = Command::new(path);
    hide_child_console(&mut command);
    let output = command
        .arg("-version")
        .stdin(Stdio::null())
        .output()
        .map_err(|error| error.to_string())?;
    parse_version_output(output.status.success(), &output.stdout, &output.stderr)
}

fn command_version(name: &str) -> Result<String, String> {
    let mut command = Command::new(name);
    hide_child_console(&mut command);
    let output = command
        .arg("-version")
        .stdin(Stdio::null())
        .output()
        .map_err(|error| error.to_string())?;
    parse_version_output(output.status.success(), &output.stdout, &output.stderr)
}

fn parse_version_output(success: bool, stdout: &[u8], stderr: &[u8]) -> Result<String, String> {
    if !success {
        let error = String::from_utf8_lossy(stderr).trim().to_string();
        return Err(if error.is_empty() {
            "ffmpeg -version 执行失败。".to_string()
        } else {
            error
        });
    }
    let text = String::from_utf8_lossy(stdout);
    let line = text.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        Err("ffmpeg -version 没有返回版本信息。".to_string())
    } else {
        Ok(line.to_string())
    }
}

fn validate_http_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("音视频解析组件只允许从 HTTP(S) 地址下载。".to_string());
    }
    if trimmed.chars().any(|ch| ch.is_control()) {
        return Err("音视频解析组件下载地址包含非法控制字符。".to_string());
    }
    Ok(trimmed.to_string())
}

fn unique_suffix() -> Result<String, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    Ok(format!("{}-{millis}", std::process::id()))
}

fn executable_name() -> &'static str {
    if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}

fn platform_label() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "unsupported"
    }
}

fn arch_label() -> &'static str {
    if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "ARM64"
    } else {
        "unknown"
    }
}

fn asset_name() -> Option<String> {
    let platform = platform_label();
    let arch = arch_label();
    if platform == "unsupported" || arch == "unknown" {
        None
    } else {
        Some(format!("MyWiki_ffmpeg_0.1.7_{platform}_{arch}.zip"))
    }
}

fn make_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(path)
            .map_err(|error| format!("读取 ffmpeg 权限失败：{error}"))?
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).map_err(|error| format!("设置 ffmpeg 可执行权限失败：{error}"))?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

#[cfg(windows)]
fn hide_child_console(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_child_console(_command: &mut Command) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::{write::SimpleFileOptions, ZipWriter};

    #[test]
    fn parses_sha256_from_hash_file_line() {
        let hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        assert_eq!(normalize_sha256(&format!("{hash}  MyWiki_ffmpeg.zip")).unwrap(), hash);
    }

    #[test]
    fn rejects_invalid_sha256_text() {
        assert!(normalize_sha256("not-a-hash").is_err());
    }

    #[test]
    fn extracts_ffmpeg_from_component_zip() {
        let archive = build_test_zip(executable_name(), b"fake ffmpeg");
        let target = std::env::temp_dir().join(format!("mywiki-ffmpeg-test-{}", unique_suffix().unwrap()));
        fs::create_dir_all(&target).unwrap();
        let extracted = extract_ffmpeg_zip_bytes(&archive, &target).unwrap();
        assert_eq!(extracted.file_name().and_then(|value| value.to_str()), Some(executable_name()));
        assert_eq!(fs::read(&extracted).unwrap(), b"fake ffmpeg");
        let _ = fs::remove_dir_all(target);
    }

    #[test]
    fn refuses_zip_without_ffmpeg() {
        let archive = build_test_zip("readme.txt", b"no binary");
        let target = std::env::temp_dir().join(format!("mywiki-ffmpeg-test-{}", unique_suffix().unwrap()));
        fs::create_dir_all(&target).unwrap();
        assert!(extract_ffmpeg_zip_bytes(&archive, &target).is_err());
        let _ = fs::remove_dir_all(target);
    }

    fn build_test_zip(name: &str, content: &[u8]) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut writer = ZipWriter::new(cursor);
        writer.start_file(name, SimpleFileOptions::default()).unwrap();
        writer.write_all(content).unwrap();
        writer.finish().unwrap().into_inner()
    }
}
