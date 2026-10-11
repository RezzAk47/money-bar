//! Money Bar: the Tauri shell. A tray icon (menu bar on macOS, notification area on Windows, indicator on Linux) and one
//! frameless, always-on-top popup that hosts the page in ../dist. Everything about money is in the page; this side owns
//! the OS: the tray, the window, the data folder and the CSV export file.

mod datadir;
mod files;
mod position;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Rect as TauriRect, State,
    WebviewWindow, WindowEvent,
};

use datadir::Os;
use position::{
    fallback_corner, popup_height_logical, popup_position, popup_width_logical, settled_size,
    usable_icon, Rect,
};

const MARGIN: i32 = 8;

/// After the popup hides itself on blur, a tray click within this long is the click that caused the blur and must not reopen it.
/// 400 ms so a click held a little longer (hide on mouse-down, reopen on release) is still covered.
const BLUR_SUPPRESS: Duration = Duration::from_millis(400);
/// How long a native menu may hold the popup open.
const HOLD: Duration = Duration::from_millis(1500);

/// True when no hold is active at `now`.
fn hold_expired(hold: Option<Instant>, now: Instant) -> bool {
    !hold.is_some_and(|t| now < t)
}

/// After a dialog or hold ended: if the popup is still visible but nothing has the focus, the blur that was swallowed will never
/// come again, so hide it now (the same way the blur handler does).
fn hide_if_unfocused(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let st = app.state::<AppState>();
    if st.dialog_open.load(std::sync::atomic::Ordering::SeqCst)
        || !hold_expired(*st.hold_until.lock().unwrap(), Instant::now())
    {
        return;
    }
    if win.is_visible().unwrap_or(false) && !win.is_focused().unwrap_or(true) {
        *st.blurred_at.lock().unwrap() = Some(Instant::now());
        let _ = win.hide();
    }
}

struct AppState {
    data_dir: PathBuf,
    /// When the popup last hid itself because it lost focus: the tray click that caused the blur must not re-open it.
    blurred_at: Mutex<Option<Instant>>,
    /// The tray icon rectangle of the last click (physical pixels), when the OS tells us.
    last_icon: Mutex<Option<Rect>>,
    tray: Mutex<Option<TrayIcon>>,
    /// True while the native save dialog is open (the popup must not hide when the dialog takes the focus).
    dialog_open: std::sync::atomic::AtomicBool,
    /// While set and in the future, losing focus does not hide the popup (a native select menu is a separate window on some systems).
    hold_until: Mutex<Option<Instant>>,
    /// The folder of the last export (its stale temp files are cleaned at the next one).
    last_export_dir: Mutex<Option<PathBuf>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    platform: &'static str,
    data_dir: String,
    no_notifications: bool,
    /// Only with MONEYBAR_SEED_SAMPLE=1 AND a MONEYBAR_DATA_DIR override: the page fills an empty temp folder with fake data.
    seed_sample: bool,
    /// Only with MONEYBAR_SELFTEST=1 AND a MONEYBAR_DATA_DIR override: the page does 50 saves through the real commands and reports.
    self_test: bool,
    tray_note: Option<&'static str>,
}

fn env_var(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// The home folder, or None when neither HOME nor USERPROFILE is set to something (never "." or the current folder).
fn home_dir() -> Option<String> {
    env_var("HOME")
        .filter(|h| !h.trim().is_empty())
        .or_else(|| env_var("USERPROFILE").filter(|h| !h.trim().is_empty()))
}

#[tauri::command]
fn app_info(state: State<AppState>) -> AppInfo {
    let os = Os::current();
    AppInfo {
        platform: os.name(),
        data_dir: state.data_dir.display().to_string(),
        no_notifications: env_var("MONEYBAR_NO_NOTIFICATIONS").is_some(),
        self_test: env_var("MONEYBAR_SELFTEST").is_some()
            && env_var("MONEYBAR_DATA_DIR").is_some_and(|d| !d.trim().is_empty()),
        seed_sample: env_var("MONEYBAR_SEED_SAMPLE").is_some()
            && env_var("MONEYBAR_DATA_DIR").is_some_and(|d| !d.trim().is_empty()),
        tray_note: if os == Os::Linux {
            Some("Linux: tray icons cannot report clicks, so open Money Bar from the tray icon's menu (Show Money Bar). The window opens near the top right on most desktops; on Wayland the compositor chooses the place (often the centre). On GNOME the AppIndicator extension is required.")
        } else {
            None
        },
    }
}

/// Runs a file operation on its own thread and gives up after `limit`, so nothing a file does can freeze the tray or the popup.
/// The operation gets a `Cancel`: a write passes it to `files::write_cancellable`, and when the limit passes first the write
/// is told to stop before its final rename, so a save the page was told timed out can never land afterwards. If the rename was
/// already under way, the timeout waits for it and reports its real result.
fn off_main_for<T: Send + 'static>(
    limit: Duration,
    f: impl FnOnce(&files::Cancel) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let cancel = std::sync::Arc::new(files::Cancel::new());
    let theirs = cancel.clone();
    std::thread::spawn(move || {
        let _ = tx.send(f(&theirs));
    });
    match rx.recv_timeout(limit) {
        Ok(r) => r,
        Err(_) => {
            // blocks only while a rename is in flight; afterwards the thread either finished its commit or will refuse to start it
            cancel.cancel();
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(r) => r,
                Err(_) => Err("the file did not answer in time".into()),
            }
        }
    }
}

fn off_main<T: Send + 'static>(
    f: impl FnOnce(&files::Cancel) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    off_main_for(Duration::from_secs(5), f)
}

#[tauri::command]
async fn fs_read(state: State<'_, AppState>, name: String) -> Result<Option<String>, String> {
    let dir = state.data_dir.clone();
    off_main(move |_| files::read(&dir, &name))
}

#[tauri::command]
async fn fs_stat(state: State<'_, AppState>, name: String) -> Result<Option<files::Stamp>, String> {
    let dir = state.data_dir.clone();
    off_main(move |_| files::stat(&dir, &name))
}

#[tauri::command]
async fn fs_write(
    state: State<'_, AppState>,
    name: String,
    text: String,
    check: bool,
    expected: Option<files::Stamp>,
) -> Result<(), String> {
    // check = false: write without comparing; check = true with expected None: the file must not exist; with a stamp: it must still match
    let dir = state.data_dir.clone();
    off_main(move |cancel| {
        files::write_cancellable(
            &dir,
            &name,
            &text,
            if check { Some(expected) } else { None },
            cancel,
        )
    })
}

#[tauri::command]
async fn fs_move_aside(
    state: State<'_, AppState>,
    name: String,
    backup_name: String,
) -> Result<String, String> {
    let dir = state.data_dir.clone();
    off_main(move |_| files::move_aside(&dir, &name, &backup_name))
}

#[tauri::command]
async fn fs_clean_temps(state: State<'_, AppState>, older_than_sec: u64) -> Result<usize, String> {
    let dir = state.data_dir.clone();
    off_main(move |_| Ok(files::remove_stray_temps(&dir, older_than_sec)))
}

/// The CSV export. The native save dialog is opened HERE, by this command: the page supplies only the text and a suggested
/// file name, never a path, so a compromised page cannot choose where a file is written. The path the dialog returns is
/// validated again in `files::run_export`. Resolves to the saved path, or None when the user cancelled.
#[tauri::command]
async fn export_csv(
    app: AppHandle,
    text: String,
    suggested_name: String,
) -> Result<Option<String>, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let state = handle.state::<AppState>();
        // the popup hides when it loses focus; not while the dialog (which takes the focus) is open
        state
            .dialog_open
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let result = files::run_export(
            |name| {
                handle
                    .dialog()
                    .file()
                    .set_file_name(name)
                    .add_filter("CSV", &["csv"])
                    .blocking_save_file()
                    .and_then(|p| p.into_path().ok())
            },
            &suggested_name,
            &text,
            &state.data_dir,
            &state.last_export_dir,
        );
        state
            .dialog_open
            .store(false, std::sync::atomic::Ordering::SeqCst);
        hide_if_unfocused(&handle);
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn set_tray_label(state: State<AppState>, label: String) {
    let label: String = label
        .chars()
        .filter(|c| !c.is_control())
        .take(120)
        .collect();
    if env_var("MONEYBAR_SELFTEST").is_some() {
        eprintln!("money-bar: tray-label {label}"); // lets the opt-in self test report its result
    }
    if let Some(tray) = state.tray.lock().unwrap().as_ref() {
        let _ = tray.set_tooltip(Some(&label));
        #[cfg(target_os = "macos")]
        let _ = tray.set_title(Some(&label));
    }
}

/// The page calls this when a native menu (a select) is about to open: the popup stays open for the next 1.5 seconds even if it
/// loses focus to the menu.
#[tauri::command]
fn hold_popup_open(app: AppHandle, state: State<AppState>) {
    *state.hold_until.lock().unwrap() = Some(Instant::now() + HOLD);
    // one sleep per call (no polling): when the hold has run out, hide the popup if focus never came back
    std::thread::spawn(move || {
        std::thread::sleep(HOLD + Duration::from_millis(100));
        hide_if_unfocused(&app);
    });
}

#[tauri::command]
fn hide_popup(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

fn to_rect(r: &TauriRect, scale: f64) -> Rect {
    let p = r.position.to_physical::<i32>(scale);
    let s = r.size.to_physical::<u32>(scale);
    Rect {
        x: p.x,
        y: p.y,
        w: s.width as i32,
        h: s.height as i32,
    }
}

/// Work area (screen minus menu bar and taskbar) of the monitor that holds the point, else the primary monitor.
fn work_area(app: &AppHandle, around: Option<Rect>) -> Rect {
    let monitor = around
        .and_then(|r| {
            app.monitor_from_point((r.x + r.w / 2) as f64, (r.y + r.h / 2) as f64)
                .ok()
                .flatten()
        })
        .or_else(|| app.primary_monitor().ok().flatten());
    match monitor {
        Some(m) => {
            let a = m.work_area();
            Rect {
                x: a.position.x,
                y: a.position.y,
                w: a.size.width as i32,
                h: a.size.height as i32,
            }
        }
        None => Rect {
            x: 0,
            y: 0,
            w: 1280,
            h: 720,
        },
    }
}

/// Sizes the popup for the screen it will be on (640 high, less on a short work area, never under 320) and puts it next to
/// the tray icon, or in the corner nearest the OS convention when the icon position is unknown or empty.
fn size_and_place(app: &AppHandle, win: &WebviewWindow, icon: Option<Rect>) {
    let icon = usable_icon(icon);
    let work = work_area(app, icon);
    let scale = win.scale_factor().unwrap_or(1.0);
    let (w, h) = (
        popup_width_logical(work.w, scale, MARGIN),
        popup_height_logical(work.h, scale, MARGIN),
    );
    let _ = win.set_size(LogicalSize::new(w as f64, h as f64));
    let requested = (
        (w as f64 * scale).round() as i32,
        (h as f64 * scale).round() as i32,
    );
    let size = settled_size(
        win.outer_size()
            .ok()
            .map(|s| (s.width as i32, s.height as i32)),
        requested,
    );
    let margin = (MARGIN as f64 * scale).round() as i32;
    let (x, y) = popup_position(
        icon,
        work,
        size.0,
        size.1,
        margin,
        fallback_corner(Os::current() == Os::Windows),
    );
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

fn place_and_show(app: &AppHandle, win: &WebviewWindow, icon: Option<Rect>) {
    size_and_place(app, win, icon);
    let _ = win.show();
    let _ = win.set_focus();
    // mixed-DPI setups: the window may have moved to a screen with another scale factor, which changes its physical size
    size_and_place(app, win, icon);
    let _ = app.emit("popup-shown", ());
}

fn toggle_popup(app: &AppHandle, icon: Option<Rect>) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let state = app.state::<AppState>();
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        return;
    }
    if let Some(t) = *state.blurred_at.lock().unwrap() {
        if t.elapsed() < BLUR_SUPPRESS {
            return; // this click is the one that made the popup lose focus and hide
        }
    }
    let icon = icon.or(*state.last_icon.lock().unwrap());
    place_and_show(app, &win, icon);
}

/// The tray icon for Windows and Linux: mid-grey, because the panel colour is unknown (tests check its contrast on white and near-black).
const TRAY_MID: &[u8] = include_bytes!("../icons/tray-mid.png");

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Money Bar", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let template = Image::from_bytes(include_bytes!("../icons/tray-template.png"))?;
    let mid = Image::from_bytes(TRAY_MID)?;
    let os = Os::current();
    let mut b = TrayIconBuilder::with_id("main")
        .tooltip("Money Bar")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                let state = app.state::<AppState>();
                let icon = *state.last_icon.lock().unwrap();
                if let Some(win) = app.get_webview_window("main") {
                    place_and_show(app, &win, icon);
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                let app = tray.app_handle();
                let scale = app
                    .get_webview_window("main")
                    .and_then(|w| w.scale_factor().ok())
                    .unwrap_or(1.0);
                let r = to_rect(&rect, scale);
                *app.state::<AppState>().last_icon.lock().unwrap() = Some(r);
                toggle_popup(app, Some(r));
            }
        });
    b = match os {
        // macOS wants a black template image that the system tints for light and dark menu bars
        Os::Mac => b.icon(template).icon_as_template(true),
        // Windows and Linux panels can be light or dark and the app cannot tell: a mid-grey glyph reads on both
        _ => b.icon(mid),
    };
    let tray = b.build(app)?;
    *app.state::<AppState>().tray.lock().unwrap() = Some(tray);
    Ok(())
}

pub fn run() {
    let os = Os::current();
    let data_dir = match datadir::default_data_dir(os, &env_var, home_dir().as_deref()) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("Money Bar cannot start: {e}");
            std::process::exit(1);
        }
    };

    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            toggle_popup(app, None);
        }));
    }
    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(AppState {
            data_dir,
            blurred_at: Mutex::new(None),
            last_icon: Mutex::new(None),
            tray: Mutex::new(None),
            dialog_open: std::sync::atomic::AtomicBool::new(false),
            last_export_dir: Mutex::new(None),
            hold_until: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            fs_read,
            fs_stat,
            fs_write,
            fs_move_aside,
            fs_clean_temps,
            export_csv,
            set_tray_label,
            hold_popup_open,
            hide_popup,
            quit_app
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory); // no Dock icon
            build_tray(app.handle())?;
            eprintln!(
                "money-bar: tray icon created; data folder {}",
                app.state::<AppState>().data_dir.display()
            );
            if let Some(win) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                let w = win.clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::Focused(false) = event {
                        let st = handle.state::<AppState>();
                        if st.dialog_open.load(std::sync::atomic::Ordering::SeqCst)
                            || !hold_expired(*st.hold_until.lock().unwrap(), Instant::now())
                        {
                            return;
                        }
                        *handle.state::<AppState>().blurred_at.lock().unwrap() =
                            Some(Instant::now());
                        let _ = w.hide();
                    }
                });
            }
            // the page polls the files on this beat (cheap: one stat per file when nothing changed)
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(2));
                let _ = handle.emit("tick", ());
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Money Bar")
        .run(|_app, event| {
            // a tray app keeps running with no window
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}

#[cfg(test)]
mod shell_tests {
    use super::*;

    #[test]
    fn the_blur_suppression_window_covers_a_slow_click() {
        assert_eq!(BLUR_SUPPRESS, Duration::from_millis(400));
    }

    #[test]
    fn a_hold_expires() {
        let now = Instant::now();
        assert!(hold_expired(None, now));
        assert!(!hold_expired(Some(now + Duration::from_millis(1)), now));
        assert!(hold_expired(Some(now), now));
    }

    #[test]
    fn a_stuck_file_operation_does_not_block_the_caller() {
        let started = std::time::Instant::now();
        let r: Result<u8, String> = off_main_for(Duration::from_millis(100), |_| {
            std::thread::sleep(Duration::from_secs(3)); // a lock wait, a slow disk
            Ok(1)
        });
        assert!(r.is_err(), "gave up instead of waiting");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "the caller was released after the limit, not after the file"
        );
    }

    #[test]
    fn a_quick_file_operation_returns_its_value() {
        assert_eq!(
            off_main_for(Duration::from_secs(2), |_| Ok::<_, String>(7)),
            Ok(7)
        );
        assert_eq!(
            off_main_for::<u8>(Duration::from_secs(2), |_| Err("disk full".into())),
            Err("disk full".to_string())
        );
    }

    #[test]
    fn a_save_that_timed_out_never_lands_afterwards() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().to_path_buf();
        let dir2 = dir.clone();
        let r = off_main_for(Duration::from_millis(100), move |cancel| {
            std::thread::sleep(Duration::from_millis(400)); // a slow disk before the final rename
            files::write_cancellable(&dir2, "entries.json", "late", None, cancel)
        });
        assert!(r.is_err(), "the page is told it timed out");
        std::thread::sleep(Duration::from_millis(700));
        assert_eq!(
            files::read(&dir, "entries.json").unwrap(),
            None,
            "so the write must not land after that"
        );
        let leftovers: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().collect();
        assert!(
            leftovers
                .iter()
                .all(|e| !e.file_name().to_string_lossy().contains(".tmp")),
            "no temp file is left"
        );
    }

    #[test]
    fn a_save_that_finishes_in_time_still_lands() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().to_path_buf();
        let d2 = dir.clone();
        off_main_for(Duration::from_secs(5), move |c| {
            files::write_cancellable(&d2, "entries.json", "on time", None, c)
        })
        .unwrap();
        assert_eq!(
            files::read(&dir, "entries.json").unwrap().as_deref(),
            Some("on time")
        );
    }

    /// Why the page refuses a lone surrogate escape in entries.json (src/core/jsonparse.ts): the page sends command arguments as
    /// JSON.stringify output, which writes a lone surrogate as "\ud800", and serde_json cannot make a Rust String of it, so a
    /// file holding one could be shown but never saved.
    #[test]
    fn a_lone_surrogate_from_the_page_cannot_become_a_rust_string() {
        assert!(serde_json::from_str::<String>(r#""a\ud800b""#).is_err());
        assert_eq!(
            serde_json::from_str::<String>(r#""😀""#).unwrap(),
            "\u{1F600}"
        );
    }

    /// WCAG relative luminance of an sRGB channel triple.
    fn luminance(r: u8, g: u8, b: u8) -> f64 {
        let lin = |c: u8| {
            let c = c as f64 / 255.0;
            if c <= 0.03928 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    }

    #[test]
    fn the_windows_linux_tray_icon_is_visible_on_light_and_dark_panels() {
        let img = tauri::image::Image::from_bytes(TRAY_MID).expect("tray-mid.png decodes");
        let (mut n, mut worst_white, mut worst_dark) = (0, f64::MAX, f64::MAX);
        for px in img.rgba().chunks(4).filter(|p| p[3] >= 200) {
            let l = luminance(px[0], px[1], px[2]);
            n += 1;
            worst_white = worst_white.min((1.05) / (l + 0.05));
            worst_dark = worst_dark.min((l + 0.05) / (luminance(26, 26, 26) + 0.05));
        }
        assert!(n >= 100, "the glyph has opaque pixels (found {n})");
        assert!(
            worst_white >= 3.0,
            "contrast on a white panel is {worst_white:.2}"
        );
        assert!(
            worst_dark >= 3.0,
            "contrast on a near-black panel is {worst_dark:.2}"
        );
    }
}
