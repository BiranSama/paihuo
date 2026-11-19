#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod core;

use crate::core::{CorePaths, CoreStatus, CoreSupervisor};
use tauri::{
    Manager, RunEvent, WindowEvent,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::WebviewWindowBuilder,
};

fn app_origin() -> &'static str {
    if tauri::is_dev() {
        "http://127.0.0.1:1420"
    } else {
        "http://tauri.localhost"
    }
}

#[tauri::command]
fn core_status(
    window: tauri::WebviewWindow,
    core: tauri::State<'_, CoreSupervisor>,
) -> Result<CoreStatus, &'static str> {
    if window.label() == "main"
        && window
            .url()
            .is_ok_and(|url| url.origin().ascii_serialization() == app_origin())
    {
        Ok(core.status())
    } else {
        Err("当前窗口无权查询内核状态")
    }
}

fn show_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let runtime = if tauri::is_dev() {
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("build/runtime")
            } else {
                app.path().resource_dir()?.join("runtime")
            };
            let paths = CorePaths {
                runtime,
                data: app.path().local_data_dir()?.join("paihuo"),
                origin: app_origin(),
            };
            app.manage(CoreSupervisor::start(paths));

            let open = MenuItem::with_id(app, "open", "打开派活", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let icon = app.default_window_icon().expect("缺少派活托盘图标").clone();
            TrayIconBuilder::new()
                .icon(icon.clone())
                .tooltip("派活")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_window(app),
                    "quit" => {
                        app.state::<CoreSupervisor>().shutdown();
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_window(tray.app_handle());
                    }
                })
                .build(app)?;

            WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                .title("派活")
                .inner_size(800.0, 630.0)
                .min_inner_size(370.0, 440.0)
                .resizable(true)
                .center()
                .icon(icon)?
                .on_navigation(|url| url.origin().ascii_serialization() == app_origin())
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![core_status])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("无法启动派活")
        .run(|app, event| {
            if matches!(event, RunEvent::Exit) {
                app.state::<CoreSupervisor>().shutdown();
            }
        });
}
