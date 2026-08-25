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
mod rollback;
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
    /// Apply-update handoff (`--takeover`): the previous launcher spawned us
    /// and is exiting — retry its single-instance lock briefly instead of
    /// yielding, and skip first-run behavior (no browser announce).
    pub takeover: bool,
    /// Server binary override (`--server-bin <p>` / MSTREAM_SERVER_BIN).
    pub server_bin: Option<PathBuf>,
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
        takeover: false,
        server_bin: std::env::var_os("MSTREAM_SERVER_BIN").map(PathBuf::from),
        server_args: Vec::new(),
    };
    let mut autostart_cmd: Option<String> = None;

    let mut it = argv;
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--tray" => args.tray = true,
            "--autostarted" => args.autostarted = true,
            "--no-open" => args.no_open = true,
            // Ours, never the server's: without this arm the fall-through
            // would forward --takeover to mstream-server, which exits on
            // unknown options — the relaunched update would die at boot.
            "--takeover" => args.takeover = true,
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

    // Terminal face: hand the whole invocation to the server. A --takeover
    // relaunch is always the tray taking over from a previous tray — even
    // when it inherited a tty-shaped stdio from the session that spawned it,
    // the console face would be wrong (measured: the update handoff became a
    // bare pass-through server and the tray vanished).
    if has_console && !args.tray && !args.takeover {
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

    #[test]
    fn takeover_is_ours_and_never_reaches_the_server() {
        let (args, _) = parse(&["--takeover"]);
        assert!(args.takeover);
        assert!(args.server_args.is_empty(), "--takeover must not leak into server argv");
        // ...except when it's a -j VALUE, which belongs to the server verbatim.
        let (args, _) = parse(&["-j", "--takeover"]);
        assert!(!args.takeover);
        assert_eq!(args.server_args, vec!["-j", "--takeover"]);
    }
}
