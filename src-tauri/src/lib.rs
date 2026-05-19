use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
mod import_extract;
use base64::{engine::general_purpose, Engine as _};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewWindow,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .setup(|app| {
            if let Ok(resource_dir) = app.path().resource_dir() {
                import_extract::set_pdfium_resource_dir_hint(resource_dir);
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            configure_frog_window(app.handle());
            create_tray(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if matches!(window.label(), "main" | "frog") {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            http_post_json,
            open_external_url,
            import_extract::import_extract_text,
            import_extract::import_extract_url,
            workspace_default_root,
            workspace_ensure_dir,
            workspace_exists,
            workspace_write_text_file,
            workspace_write_binary_file,
            workspace_read_text_file,
            workspace_list_markdown_files,
            workspace_list_files,
            workspace_delete_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[derive(serde::Deserialize)]
struct HttpJsonRequest {
    url: String,
    headers: Option<HashMap<String, String>>,
    body: serde_json::Value,
}

#[derive(serde::Serialize)]
struct HttpJsonResponse {
    status: u16,
    ok: bool,
    body: String,
}

#[tauri::command]
async fn http_post_json(request: HttpJsonRequest) -> Result<HttpJsonResponse, String> {
    let url = request.url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only HTTP(S) URLs are supported.".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|error| error.to_string())?;
    let mut builder = client.post(url).json(&request.body);

    for (key, value) in request.headers.unwrap_or_default() {
        builder = builder.header(key, value);
    }

    let response = builder.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|error| error.to_string())?;

    Ok(HttpJsonResponse {
        status: status.as_u16(),
        ok: status.is_success(),
        body,
    })
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let target = url.trim();
    if !(target.starts_with("https://") || target.starts_with("http://")) {
        return Err("Only HTTP(S) URLs can be opened.".to_string());
    }
    if target.chars().any(|ch| ch.is_control()) {
        return Err("URL contains an invalid control character.".to_string());
    }

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("rundll32");
        command.arg("url.dll,FileProtocolHandler").arg(target);
        command
    };

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(target);
        command
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(target);
        command
    };

    command.spawn().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn workspace_default_root(app: tauri::AppHandle) -> Result<String, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("workspace");
    Ok(root.to_string_lossy().replace('\\', "/"))
}

#[tauri::command]
fn workspace_ensure_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|error| error.to_string())
}

#[tauri::command]
fn workspace_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
fn workspace_write_text_file(path: String, content: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    if let Some(parent) = path_buf.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path_buf, content).map_err(|error| error.to_string())
}

#[tauri::command]
fn workspace_write_binary_file(path: String, data_base64: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    if let Some(parent) = path_buf.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let data = data_base64
        .split_once(',')
        .map(|(_, value)| value)
        .unwrap_or(data_base64.as_str());
    let bytes = general_purpose::STANDARD
        .decode(data)
        .map_err(|error| format!("Failed to decode base64 file data: {error}"))?;
    fs::write(path_buf, bytes).map_err(|error| error.to_string())
}

#[tauri::command]
fn workspace_read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn workspace_list_markdown_files(root: String) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    collect_markdown_files(Path::new(&root), &mut files)?;
    files.sort();
    Ok(files)
}

#[tauri::command]
fn workspace_list_files(root: String) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    collect_files(Path::new(&root), &mut files)?;
    files.sort();
    Ok(files)
}

#[tauri::command]
fn workspace_delete_path(root: String, path: String) -> Result<(), String> {
    let root_path = PathBuf::from(&root);
    let target_path = PathBuf::from(&path);
    if !target_path.exists() {
        return Ok(());
    }

    let canonical_root = root_path.canonicalize().map_err(|error| error.to_string())?;
    let canonical_target = target_path.canonicalize().map_err(|error| error.to_string())?;
    if canonical_target == canonical_root {
        return Err("Refusing to delete the workspace root.".to_string());
    }
    if !canonical_target.starts_with(&canonical_root) {
        return Err("Refusing to delete a path outside the active workspace.".to_string());
    }

    if canonical_target.is_dir() {
        fs::remove_dir_all(canonical_target).map_err(|error| error.to_string())
    } else {
        fs::remove_file(canonical_target).map_err(|error| error.to_string())
    }
}

fn collect_markdown_files(path: &Path, files: &mut Vec<String>) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            collect_markdown_files(&path, files)?;
        } else if path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
        {
            files.push(path.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}

fn collect_files(path: &Path, files: &mut Vec<String>) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, files)?;
        } else {
            files.push(path.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}

fn create_tray(app: &tauri::App) -> tauri::Result<()> {
    let show_main = MenuItem::with_id(app, "show_main", "打开 MyWiki 主窗口", true, None::<&str>)?;
    let show_frog = MenuItem::with_id(app, "show_frog", "显示 Froggy 捕获蛙", true, None::<&str>)?;
    let hide_frog = MenuItem::with_id(app, "hide_frog", "隐藏 Froggy 捕获蛙", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 MyWiki", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_main, &show_frog, &hide_frog, &quit])?;

    let mut tray = TrayIconBuilder::new()
        .tooltip("MyWiki")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show_main" => show_window(app.get_webview_window("main")),
            "show_frog" => show_window(app.get_webview_window("frog")),
            "hide_frog" => hide_window(app.get_webview_window("frog")),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_window(tray.app_handle().get_webview_window("frog"));
            }
        });

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }

    tray.build(app)?;
    Ok(())
}

fn configure_frog_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("frog") {
        let _ = window.set_always_on_top(true);
        let _ = window.set_decorations(false);
    }
}

fn show_window(window: Option<WebviewWindow>) {
    if let Some(window) = window {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn hide_window(window: Option<WebviewWindow>) {
    if let Some(window) = window {
        let _ = window.hide();
    }
}

fn toggle_window(window: Option<WebviewWindow>) {
    if let Some(window) = window {
        let is_visible = window.is_visible().unwrap_or(false);
        if is_visible {
            let _ = window.hide();
        } else {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}
