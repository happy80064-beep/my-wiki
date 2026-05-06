use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewWindow,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .setup(|app| {
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn create_tray(app: &tauri::App) -> tauri::Result<()> {
    let show_main = MenuItem::with_id(app, "show_main", "Show MyWiki", true, None::<&str>)?;
    let show_frog = MenuItem::with_id(app, "show_frog", "Show Froggy", true, None::<&str>)?;
    let hide_frog = MenuItem::with_id(app, "hide_frog", "Hide Froggy", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit MyWiki", true, None::<&str>)?;
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
