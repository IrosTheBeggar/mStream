// Login-item management. Policy (approved in the binary-releases plan):
// autostart is ON BY DEFAULT for the desktop product, with a one-click
// tray toggle off. "Default" means configured ONCE, on the first launcher
// run — after that the user's choice (tray toggle, or --autostart=disable)
// is never overridden, which is why the first-run marker exists.
use crate::paths;
use auto_launch::{AutoLaunch, AutoLaunchBuilder};

fn launcher() -> Option<AutoLaunch> {
    let exe = std::env::current_exe().ok()?;
    let path = exe.to_string_lossy();
    // auto-launch 0.5 does no quoting: the Windows Run value and the XDG
    // .desktop Exec line are written as `{path} {args}` verbatim, so an
    // install path with a space ("...\My Apps\mStream.exe") word-splits and
    // login-start silently launches nothing while the entry reads enabled.
    // Quote it ourselves on those platforms. macOS stays raw: the
    // LaunchAgent plist carries the path as its own <string> element, where
    // quotes would become part of the filename.
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
        // macOS: a LaunchAgent plist, NOT the AppleScript/System Events
        // login-item route (fragile, and prompts for automation consent).
        .set_use_launch_agent(true)
        .build()
        .ok()
}

pub fn is_enabled() -> bool {
    launcher().map(|a| a.is_enabled().unwrap_or(false)).unwrap_or(false)
}

pub fn set_enabled(on: bool) -> Result<(), String> {
    let a = launcher().ok_or("could not resolve the launcher executable")?;
    if on {
        ensure_autostart_parent_dir();
    }
    let r = if on { a.enable() } else { a.disable() };
    r.map_err(|e| e.to_string())
}

// auto-launch writes a file into a per-user dir it does NOT create:
// ~/.config/autostart on Linux, ~/Library/LaunchAgents on macOS. Real
// desktop sessions always have them, but fresh or minimal accounts may
// not — surfaced by the Docker smoke, where enable() failed with ENOENT
// in a bare-$HOME container. Windows registers via the registry; nothing
// to create there. Best-effort: a failure here just re-surfaces in
// enable()'s own error.
fn ensure_autostart_parent_dir() {
    #[cfg(target_os = "macos")]
    {
        let _ = std::fs::create_dir_all(
            crate::paths::home_dir().join("Library").join("LaunchAgents"),
        );
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let base = std::env::var_os("XDG_CONFIG_HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| crate::paths::home_dir().join(".config"));
        let _ = std::fs::create_dir_all(base.join("autostart"));
    }
}

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
