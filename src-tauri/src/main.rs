// Aria Buddy — minimal Tauri shell. All product logic lives in the webview;
// this side provides the transparent overlay window, a tray icon, macOS
// accessory mode (no Dock icon), and the native overlay command.
//
// macOS: a plain NSWindow can NEVER reliably follow all Spaces or draw over
// full-screen apps (confirmed by the Tauri maintainers — tauri#5566/#9556).
// The window must be swizzled to an NSPanel with the right level and
// collection behavior. That's what tauri-nspanel does below.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

#[cfg(target_os = "macos")]
use tauri_nspanel::{
    cocoa::appkit::NSWindowCollectionBehavior, ManagerExt, WebviewWindowExt,
};

/// Put the pet where the user wants it, natively and atomically.
/// - "overlay": above everything (incl. full-screen apps), on every Space.
/// - "desktop": just above the wallpaper, under app windows, on every Space.
#[tauri::command]
fn set_overlay(app: tauri::AppHandle, window: tauri::WebviewWindow, mode: String) {
    #[cfg(target_os = "macos")]
    {
        let _ = &window; // panel lookup goes through the app handle
        if let Ok(panel) = app.get_webview_panel("main") {
            // NSMainMenuWindowLevel + 1 = 25 -> draws over full-screen apps.
            panel.set_level(if mode == "desktop" { -1 } else { 25 });
            // REQUIRED for full-screen Spaces: a panel that can activate the
            // app is refused entry to full-screen spaces (per tauri-nspanel's
            // fullscreen example). The panel still becomes key on click, so
            // the chat input keeps working.
            #[allow(non_upper_case_globals)]
            const NSWindowStyleMaskNonActivatingPanel: i32 = 1 << 7;
            panel.set_style_mask(NSWindowStyleMaskNonActivatingPanel);
            panel.set_collection_behaviour(
                NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
                    | NSWindowCollectionBehavior::NSWindowCollectionBehaviorStationary
                    | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary,
            );
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = &app;
        if mode == "desktop" {
            let _ = window.set_always_on_top(false);
            let _ = window.set_always_on_bottom(true);
        } else {
            let _ = window.set_always_on_bottom(false);
            let _ = window.set_always_on_top(true);
        }
    }
}

fn main() {
    let mut builder = tauri::Builder::default()
        // One buddy only: launching the app again focuses the existing pet
        // instead of spawning a second one. Must be the FIRST plugin so a
        // second launch bails before anything else initializes.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        // Rust-proxied fetch for the community gallery: codex-pets.net sends
        // no Access-Control-Allow-Origin, so webview fetch is CORS-blocked.
        .plugin(tauri_plugin_http::init());

    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_nspanel::init());
    }

    builder
        .invoke_handler(tauri::generate_handler![set_overlay])
        .setup(|app| {
            // No Dock icon on macOS — the buddy lives on the desktop + tray.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Swizzle the window to an NSPanel, then apply overlay mode.
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.to_panel(); // once, at startup
                set_overlay(app.handle().clone(), window, "overlay".into());
            }

            let show = MenuItem::with_id(app, "show", "Show Buddy", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "Hide Buddy", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Aria Buddy", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &hide, &quit])?;

            TrayIconBuilder::with_id("aria-buddy-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "hide" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Aria Buddy");
}
