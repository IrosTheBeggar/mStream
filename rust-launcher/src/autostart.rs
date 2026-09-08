// Login-item management. Policy (approved in the binary-releases plan):
// autostart is ON BY DEFAULT for the desktop product, with a one-click
// tray toggle off. "Default" means configured ONCE, on the first launcher
// run — after that the user's choice (tray toggle, or --autostart=disable)
// is never overridden, which is why the first-run marker exists.
use crate::paths;
use auto_launch::{AutoLaunch, AutoLaunchBuilder, LinuxLaunchMode, MacOSLaunchMode, WindowsEnableMode};

fn launcher() -> Option<AutoLaunch> {
    let exe = std::env::current_exe().ok()?;
    let path = exe.to_string_lossy();
    // auto-launch does no quoting (0.6 included — its windows.rs and
    // linux.rs writers are still `format!("{} {}", path, args)`): the
    // Windows Run value and the XDG .desktop Exec line are written as
    // `{path} {args}` verbatim, so an install path with a space
    // ("...\My Apps\mStream.exe") word-splits and login-start silently
    // launches nothing while the entry reads enabled. Quote it ourselves on
    // those platforms. macOS stays raw: the LaunchAgent plist carries the
    // path as its own <string> element, where quotes would become part of
    // the filename — and 0.6's enable() also insists the raw path EXISTS.
    #[cfg(target_os = "macos")]
    let path = path.into_owned();
    #[cfg(not(target_os = "macos"))]
    let path = format!("\"{path}\"");
    AutoLaunchBuilder::new()
        .set_app_name("mStream")
        .set_app_path(&path)
        // The login-item launch must come up silent (tray only, no browser
        // tab over the user's login) — that's what --autostarted means.
        .set_args(&["--autostarted"])
        // macOS: a LaunchAgent plist — NOT the AppleScript/System Events
        // login-item route (fragile, and prompts for automation consent),
        // and NOT 0.6's SMAppService route (macOS 13+ only, and it registers
        // the running *bundle* — nothing for the bare mstream-desktop binary
        // or an unsigned .app).
        .set_macos_launch_mode(MacOSLaunchMode::LaunchAgent)
        // Windows: HKCU only. 0.6's default (Dynamic) tries HKLM first and
        // only falls back to HKCU on access-denied — an ELEVATED launcher
        // would register a machine-wide login item for every account,
        // pointing at this user's install.
        .set_windows_enable_mode(WindowsEnableMode::CurrentUser)
        // Linux: the XDG autostart .desktop entry, as before 0.6. The new
        // systemd --user alternative has no session/display guarantee for a
        // tray app.
        .set_linux_launch_mode(LinuxLaunchMode::XdgAutostart)
        .build()
        .ok()
}

/// On Windows, auto-launch 0.6 also honours Task Manager's Startup tab
/// (the StartupApproved\Run override): an entry the user switched off there
/// reads disabled here, so the tray checkbox follows the OS's own view.
pub fn is_enabled() -> bool {
    launcher().map(|a| a.is_enabled().unwrap_or(false)).unwrap_or(false)
}

pub fn set_enabled(on: bool) -> Result<(), String> {
    let a = launcher().ok_or("could not resolve the launcher executable")?;
    match if on { a.enable() } else { a.disable() } {
        Ok(()) => Ok(()),
        // Disable is idempotent. With auto-launch 0.5 the Windows disable()
        // was a bare `delete_value` that failed with "cannot find the file
        // specified (os error 2)" when the Run value didn't exist; 0.6 maps
        // that to Ok itself (and a missing Run KEY now reads "disabled"
        // instead of erroring). The guard stays as the contract regardless
        // of the crate's error surface: an uninstaller or script asking for
        // a state that already holds must not get exit 1. Judge by the
        // outcome: if the item is not enabled after the attempt, the request
        // is satisfied. (An unreadable state stays an error — nothing was
        // proven.)
        Err(_) if !on && !a.is_enabled().unwrap_or(true) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// Container directories/keys are the crate's job since auto-launch 0.6:
// `Key::create` on the HKCU Run key (open-or-create — 0.5 only ever OPENED
// it, which failed with `os error 2` on a fresh CI runner image at the
// v6.20.0 tag build), create_dir_all on ~/.config/autostart (the ENOENT a
// bare-$HOME Docker smoke hit), create_dir on ~/Library/LaunchAgents. The
// winreg pre-create this file used to carry for the Windows gap is gone with
// it. Known limitation carried over from 0.5: the Linux dir is hardcoded to
// ~/.config/autostart — XDG_CONFIG_HOME is never consulted, so with it
// pointed elsewhere a spec-compliant session manager reads autostart entries
// from a directory the crate never writes.

/// First run of the desktop face: enable autostart once and remember that
/// we did. MSTREAM_LAUNCHER_SKIP_AUTOSTART=1 is a testing hook so smokes
/// never touch the real login items.
pub fn ensure_default_on() {
    if std::env::var_os("MSTREAM_LAUNCHER_SKIP_AUTOSTART").is_some() {
        return;
    }
    let state_path = paths::state_file();
    let mut state: serde_json::Value = std::fs::read_to_string(&state_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    // Valid-but-non-object JSON (a hand-edited `[]` or `true`) survives the
    // lenient parse above but panics serde_json's IndexMut assignment below
    // — on the GUI face, before the server spawns, with nowhere for the
    // panic to go. Treat it exactly like corruption.
    if !state.is_object() {
        state = serde_json::json!({});
    }
    if state.get("autostartConfigured").and_then(|v| v.as_bool()) == Some(true) {
        // Configured already: the user's choice rules — but a LIVE
        // registration's stored path needs refreshing. The entry pins the
        // absolute exe path from whenever it was written; bundles extract
        // into versioned folders and .apps get dragged from ~/Downloads to
        // /Applications, so a stale path silently kills login-start while
        // the checkbox still reads enabled. Re-assert only when enabled —
        // never resurrect a disable.
        if is_enabled() {
            let _ = set_enabled(true);
        }
        return;
    }
    let _ = set_enabled(true); // best-effort: a locked-down env must not block the server
    state["autostartConfigured"] = serde_json::Value::Bool(true);
    if let Some(dir) = state_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&state_path, serde_json::to_string_pretty(&state).unwrap_or_default());
}

/// `--autostart=enable|disable|status` — scriptable control for smokes now,
/// the installer/uninstaller later. Returns the process exit code.
pub fn run_cli(cmd: &str) -> i32 {
    match cmd {
        "enable" | "disable" => match set_enabled(cmd == "enable") {
            Ok(()) => {
                crate::platform::console_out(&format!("autostart {cmd}d"));
                0
            }
            Err(e) => {
                crate::platform::console_err(&format!("autostart {cmd} failed: {e}"));
                1
            }
        },
        "status" => {
            // Results go to stdout (console_out) — scripts pipe this; only
            // failures belong on stderr.
            crate::platform::console_out(if is_enabled() { "enabled" } else { "disabled" });
            0
        }
        other => {
            crate::platform::console_err(&format!(
                "unknown --autostart command '{other}' (expected enable|disable|status)"
            ));
            2
        }
    }
}
