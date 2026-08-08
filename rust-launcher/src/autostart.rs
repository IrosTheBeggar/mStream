// Login-item management. Policy (approved in the binary-releases plan):
// autostart is ON BY DEFAULT for the desktop product, with a one-click
// tray toggle off. "Default" means configured ONCE, on the first launcher
// run — after that the user's choice (tray toggle, or --autostart=disable)
// is never overridden, which is why the first-run marker exists.
use crate::paths;
use auto_launch::{AutoLaunch, AutoLaunchBuilder};

fn launcher() -> Option<AutoLaunch> {
    let exe = std::env::current_exe().ok()?;
    AutoLaunchBuilder::new()
        .set_app_name("mStream")
        .set_app_path(&exe.to_string_lossy())
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
    let r = if on { a.enable() } else { a.disable() };
    r.map_err(|e| e.to_string())
}

/// First run of the desktop face: enable autostart once and remember that
/// we did. MSTREAM_LAUNCHER_SKIP_AUTOSTART=1 is a testing hook so smokes
/// never touch the real login items.
pub fn ensure_default_on() {
    if std::env::var_os("MSTREAM_LAUNCHER_SKIP_AUTOSTART").is_some() {
        return;
    }
    let state_path = paths::state_file();
    let state: serde_json::Value = std::fs::read_to_string(&state_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if state.get("autostartConfigured").and_then(|v| v.as_bool()) == Some(true) {
        return;
    }
    let _ = set_enabled(true); // best-effort: a locked-down env must not block the server
    let mut state = state;
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
                crate::platform::console_err(&format!("autostart {cmd}d"));
                0
            }
            Err(e) => {
                crate::platform::console_err(&format!("autostart {cmd} failed: {e}"));
                1
            }
        },
        "status" => {
            crate::platform::console_err(if is_enabled() { "enabled" } else { "disabled" });
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
