// mStream Desktop launcher — the double-click entrypoint for the standalone
// bundles (binary-releases roadmap, phase 1b).
//
// One binary, two faces:
//
//   double-click / login item  →  background server + tray icon (tray_app.rs)
//   terminal                   →  transparent pass-through to mstream-server,
//                                 same argv, same stdio, same exit code — so
//                                 "downloaded and double-clicked" and
//                                 "launched via a terminal" both just work.
//
// The GUI face spawns `mstream-server --supervised` and HOLDS ITS STDIN: the
// server's supervision contract (src/util/supervision.js) exits the server the
// moment that pipe hits EOF, so even a force-killed launcher can never leak an
// orphan server holding the port.
#![cfg_attr(windows, windows_subsystem = "windows")]

mod autostart;
mod paths;
mod platform;
mod server;
mod tray_app;

use std::path::PathBuf;

pub struct LauncherArgs {
    /// Force tray mode even when a parent console exists (`--tray`).
    pub tray: bool,
    /// Launched by the login item (`--autostarted`): never open the browser,
    /// never treat this as a first run worth announcing.
    pub autostarted: bool,
    /// Never open the browser (`--no-open`; smokes and scripts).
    pub no_open: bool,
    /// Server binary override (`--server-bin <p>` / MSTREAM_SERVER_BIN).
    pub server_bin: Option<PathBuf>,
    /// Everything not launcher-specific, forwarded to the server verbatim
    /// (-j, --portable, --quick-connect-off-by-default, ...).
    pub server_args: Vec<String>,
}

fn main() {
    // Attach to a parent console first (Windows: a GUI-subsystem exe starts
    // detached even when launched FROM a terminal) so anything we print below
    // — autostart CLI output, pass-through errors — is actually visible.
    let has_console = platform::attach_parent_console();

    let mut args = LauncherArgs {
        tray: false,
        autostarted: false,
        no_open: false,
        server_bin: std::env::var_os("MSTREAM_SERVER_BIN").map(PathBuf::from),
        server_args: Vec::new(),
    };
    let mut autostart_cmd: Option<String> = None;

    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--tray" => args.tray = true,
            "--autostarted" => args.autostarted = true,
            "--no-open" => args.no_open = true,
            "--server-bin" => {
                if let Some(p) = it.next() {
                    args.server_bin = Some(PathBuf::from(p));
                }
            }
            other if other.starts_with("--server-bin=") => {
                args.server_bin = Some(PathBuf::from(&other["--server-bin=".len()..]));
            }
            other if other.starts_with("--autostart=") => {
                autostart_cmd = Some(other["--autostart=".len()..].to_string());
            }
            // Not ours — the server owns the rest of the CLI surface
            // (including -h/--help/-V: in a terminal the pass-through makes
            // the SERVER answer them, which is the truthful contract).
            other => args.server_args.push(other.to_string()),
        }
    }

    // Scriptable login-item control (`--autostart=enable|disable|status`) —
    // used by smokes today, by the installer/uninstaller later. Runs before
    // any window/tray machinery and exits.
    if let Some(cmd) = autostart_cmd {
        std::process::exit(autostart::run_cli(&cmd));
    }

    // Terminal face: hand the whole invocation to the server.
    if has_console && !args.tray {
        platform::run_console_passthrough(&args);
        // (only returns on spawn failure, which it has already reported)
        std::process::exit(1);
    }

    // Desktop face.
    tray_app::run(args);
}
