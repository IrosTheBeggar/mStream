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
mod quick_connect;
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
    /// Internal: `--show-quick-connect=<ip:port>` — render the Quick Connect
    /// QR into this terminal and exit. The tray re-invokes the launcher this
    /// way inside a fresh terminal (see quick_connect.rs); never user-typed.
    pub show_quick_connect: Option<String>,
    /// Everything not launcher-specific, forwarded to the server verbatim
    /// (-j, --portable, --quick-connect-off-by-default, ...).
    pub server_args: Vec<String>,
}

/// Split argv into the launcher's own flags and the server's, without ever
/// interpreting a token that is another flag's VALUE. `-j <value>` is the
/// load-bearing case: the value is the server's config path, and stripping a
/// launcher-flag lookalike out of that position would shift the next token
/// into the -j slot — in the worst alignment the server reads the literal
/// string "--supervised" as its config path and never arms the supervision
/// pipe, un-fixing the orphan guarantee.
fn parse_cli(argv: impl Iterator<Item = String>) -> (LauncherArgs, Option<String>) {
    let mut args = LauncherArgs {
        tray: false,
        autostarted: false,
        no_open: false,
        server_bin: std::env::var_os("MSTREAM_SERVER_BIN").map(PathBuf::from),
        show_quick_connect: None,
        server_args: Vec::new(),
    };
    let mut autostart_cmd: Option<String> = None;

    let mut it = argv;
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
            other if other.starts_with("--show-quick-connect=") => {
                args.show_quick_connect = Some(other["--show-quick-connect=".len()..].to_string());
            }
            // The server's config flag: forward it AND its value verbatim
            // (cli-boot-wrapper.js consumes the next token as the path, so
            // ours to pass through, never to read). `--json=path` needs no
            // arm — it falls through whole.
            "-j" | "--json" => {
                args.server_args.push(arg);
                if let Some(v) = it.next() {
                    args.server_args.push(v);
                }
            }
            // Not ours — the server owns the rest of the CLI surface
            // (including -h/--help/-V: in a terminal the pass-through makes
            // the SERVER answer them, which is the truthful contract).
            other => args.server_args.push(other.to_string()),
        }
    }
    (args, autostart_cmd)
}

fn main() {
    // Attach to a parent console first (Windows: a GUI-subsystem exe starts
    // detached even when launched FROM a terminal) so anything we print below
    // — autostart CLI output, pass-through errors — is actually visible.
    let has_console = platform::attach_parent_console();

    let (args, autostart_cmd) = parse_cli(std::env::args().skip(1));

    // Scriptable login-item control (`--autostart=enable|disable|status`) —
    // used by smokes today, by the installer/uninstaller later. Runs before
    // any window/tray machinery and exits.
    if let Some(cmd) = autostart_cmd {
        std::process::exit(autostart::run_cli(&cmd));
    }

    // Quick Connect QR face: the tray spawns us in a fresh terminal with this
    // flag to paint the pairing-code QR. Runs before the passthrough below —
    // that terminal gives us a console, so has_console would otherwise send
    // us down the server pass-through path.
    if let Some(addr) = args.show_quick_connect.as_deref() {
        std::process::exit(quick_connect::show(addr));
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

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(argv: &[&str]) -> (LauncherArgs, Option<String>) {
        parse_cli(argv.iter().map(|s| s.to_string()))
    }

    #[test]
    fn j_values_are_forwarded_not_interpreted() {
        let (args, _) = parse(&["-j", "--tray"]);
        assert!(!args.tray, "a -j value spelling a launcher flag must not engage it");
        assert_eq!(args.server_args, vec!["-j", "--tray"], "both tokens reach the server");

        let (args, _) = parse(&["--tray", "--json", "--no-open", "-j", "b.json"]);
        assert!(args.tray);
        assert!(!args.no_open, "--no-open here is --json's value, not our flag");
        assert_eq!(args.server_args, vec!["--json", "--no-open", "-j", "b.json"]);
    }

    #[test]
    fn launcher_flags_still_parse_outside_j() {
        let (args, cmd) = parse(&["--tray", "--no-open", "--server-bin", "/x/srv", "--portable"]);
        assert!(args.tray && args.no_open);
        assert_eq!(args.server_bin.as_deref(), Some(std::path::Path::new("/x/srv")));
        assert_eq!(args.server_args, vec!["--portable"]);
        assert_eq!(cmd, None);
    }
}
