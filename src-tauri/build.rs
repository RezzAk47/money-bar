fn main() {
    // Only these commands exist for the webview; each one needs an explicit permission in capabilities/default.json.
    let app = tauri_build::AppManifest::new().commands(&[
        "app_info",
        "fs_read",
        "fs_stat",
        "fs_write",
        "fs_move_aside",
        "fs_clean_temps",
        "export_csv",
        "set_tray_label",
        "hold_popup_open",
        "hide_popup",
        "quit_app",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(app))
        .expect("tauri build failed");
}
