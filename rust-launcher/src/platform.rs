// Platform seams: console attach/pass-through and fatal user-visible errors.
//
// The pass-through exists so ONE shipped binary serves both audiences: a
// GUI-subsystem exe double-clicked from Explorer shows no console, while the
// same exe run from a terminal behaves exactly like running the server
// directly (argv, stdio, exit code). The #802 lesson applies in reverse too:
// a GUI launch must never die silently, hence fatal_alert.
use crate::LauncherArgs;
use crate::paths;

/// Attach to the parent process's console if there is one. Windows: a
/// windows-subsystem exe starts with no console even when launched from
/// cmd/PowerShell — AttachConsole(ATTACH_PARENT_PROCESS) succeeds exactly
/// when a terminal launched us. Unix: a tty on stdin or stdout is the
/// equivalent signal (and there is nothing to attach).
pub fn attach_parent_console() -> bool {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
        AttachConsole(ATTACH_PARENT_PROCESS) != 0
    }
    #[cfg(unix)]
    unsafe {
        libc::isatty(0) == 1 || libc::isatty(1) == 1
    }
}

/// Terminal face: run the server with our forwarded argv and the caller's
/// console, then mirror its exit. Never returns on success.
pub fn run_console_passthrough(args: &LauncherArgs) {
    let bin = match paths::find_server_bin(args.server_bin.as_deref()) {
        Ok(b) => b,
        Err(e) => {
            console_err(&format!("mStream launcher: {e}"));
            return;
        }
    };

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // exec() replaces this process outright — signals, tty, exit code
        // all belong to the server, the perfect pass-through.
        let err = std::process::Command::new(&bin).args(&args.server_args).exec();
        console_err(&format!("mStream launcher: could not exec {}: {err}", bin.display()));
    }

    #[cfg(windows)]
    {
        use std::fs::File;
        use std::process::{Command, Stdio};
        use windows_sys::Win32::System::Console::{
            SetConsoleCtrlHandler, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
        };

        // Std handles come in two shapes here (same rules console_out relies
        // on): NULL when a GUI-subsystem exe was launched bare from a console
        // — bind those to the real console devices so the pass-through has a
        // face — but REAL when the caller redirected or piped them
        // (`mStream.exe -h > out.txt`, `... | findstr`). A real handle must
        // be INHERITED, not rebound: forcing CONOUT$ over a redirect sends
        // the server's output to the visible console and leaves the
        // caller's file/pipe empty, silently breaking the "same flags, same
        // output, same exit code" promise install.md makes for the terminal
        // face. (Command's default stdio is inherit, so "real" needs no arm.)
        let mut cmd = Command::new(&bin);
        cmd.args(&args.server_args);
        if !std_handle_is_real(STD_INPUT_HANDLE) {
            if let Ok(f) = File::options().read(true).write(true).open("CONIN$") {
                cmd.stdin(Stdio::from(f));
            }
        }
        let conout = || File::options().read(true).write(true).open("CONOUT$").ok();
        if !std_handle_is_real(STD_OUTPUT_HANDLE) {
            if let Some(f) = conout() {
                cmd.stdout(Stdio::from(f));
            }
        }
        if !std_handle_is_real(STD_ERROR_HANDLE) {
            if let Some(f) = conout() {
                cmd.stderr(Stdio::from(f));
            }
        }

        match cmd.spawn() {
            Ok(mut child) => {
                // Ctrl+C is the CHILD's to handle (the server shuts down
                // cleanly on it); if we died on it first we'd abandon the
                // wait and print a spurious launcher error.
                unsafe { SetConsoleCtrlHandler(None, 1) };
                let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(1);
                std::process::exit(code);
            }
            Err(e) => console_err(&format!(
                "mStream launcher: could not start {}: {e}",
                bin.display()
            )),
        }
    }
}

/// RESULT output for the scriptable CLI surface (--autostart=status and
/// friends): stdout on unix so pipes and `grep` see it — the Docker smoke
/// caught status answering on stderr. On Windows a GUI-subsystem exe's std
/// handles are NULL when launched bare (Explorer, or cmd without
/// redirection), but REAL when the parent redirected them — pipes, `$()`
/// command substitution, `> file`. The CI self-test captures stdout exactly
/// that way (and bash on the runners always has a hidden console, so
/// AttachConsole succeeding says nothing about where stdout points). Honor a
/// real handle first — println! reaches the caller — and only a detached
/// stdout falls back to the attached console device.
pub fn console_out(msg: &str) {
    #[cfg(windows)]
    {
        use std::io::Write;
        use windows_sys::Win32::System::Console::STD_OUTPUT_HANDLE;
        if !std_handle_is_real(STD_OUTPUT_HANDLE) {
            if let Ok(mut f) = std::fs::File::options().write(true).open("CONOUT$") {
                let _ = writeln!(f, "{msg}");
                return;
            }
        }
    }
    println!("{msg}");
}

/// Write a line to stderr, or the attached console when stderr is detached
/// (Windows GUI subsystem: same handle rules as console_out above).
pub fn console_err(msg: &str) {
    #[cfg(windows)]
    {
        use std::io::Write;
        use windows_sys::Win32::System::Console::STD_ERROR_HANDLE;
        if !std_handle_is_real(STD_ERROR_HANDLE) {
            if let Ok(mut f) = std::fs::File::options().write(true).open("CONOUT$") {
                let _ = writeln!(f, "{msg}");
                return;
            }
        }
    }
    eprintln!("{msg}");
}

/// Whether the given std handle points at something a parent process gave us
/// (pipe, file, or console handle) rather than the GUI-subsystem NULL.
#[cfg(windows)]
fn std_handle_is_real(which: windows_sys::Win32::System::Console::STD_HANDLE) -> bool {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Console::GetStdHandle;
    let h = unsafe { GetStdHandle(which) };
    !h.is_null() && h != INVALID_HANDLE_VALUE
}

/// Fatal error with a visible face on a GUI launch: message box on Windows,
/// osascript alert on macOS, stderr+log elsewhere. A desktop launch that
/// dies silently is exactly the #802 failure class this launcher replaces.
pub fn fatal_alert(msg: &str) {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        MessageBoxW(std::ptr::null_mut(), wide(msg).as_ptr(), wide("mStream").as_ptr(), MB_OK | MB_ICONERROR);
    }
    #[cfg(target_os = "macos")]
    {
        // Message rides in as argv — no quoting/injection concerns.
        let _ = std::process::Command::new("/usr/bin/osascript")
            .args(["-e", "on run argv", "-e", "display alert \"mStream\" message (item 1 of argv) as critical", "-e", "end run", msg])
            .spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        eprintln!("mStream: {msg}");
    }
}

/// Tray "View logs": open a terminal window showing the two launcher-owned
/// logs — a static tail of the quiet launcher.log, then server-console.log
/// FROM LINE 1, followed live (-F, so the per-session rotation doesn't end
/// the view). Whole-file is deliberate: the same winston stream that feeds
/// the admin panel's in-memory live-log ring (src/logger.js — Console +
/// MemoryRingTransport on one root logger) is what the launcher captures
/// into server-console.log, and the capture starts at server spawn — so
/// from line 1 this window shows everything the admin viewer has, uncapped
/// (the ring holds the last N entries, 4KB each), plus anything the ring
/// already evicted. Fetching /api/v1/admin/logs/recent instead would add
/// an auth dependency (the wall, once accounts exist) for a subset of this
/// file. Per-OS "what is a terminal" seams; the caller logs a failure —
/// a missing terminal emulator must never take the tray down.
pub fn open_logs_terminal(logs_dir: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;
        // Terminal.app opens an executable .command file as a document — no
        // AppleEvents automation consent (an osascript `tell app "Terminal"`
        // would prompt "mStream wants to control Terminal" on first use).
        // Regenerated on every click so it always reflects this build's
        // idea of the logs dir; header says whose file it is.
        let script = logs_dir.join("view-logs.command");
        let body = format!(
            "#!/bin/sh\n# Written by mStream's tray 'View logs' item - safe to delete.\ncd {dir}\necho '== launcher.log =='\ntail -n 50 launcher.log 2>/dev/null\necho\necho '== server-console.log: full server log for this session (following; close the window to stop) =='\nexec tail -n +1 -F server-console.log\n",
            dir = sh_quote(logs_dir)
        );
        std::fs::write(&script, body).map_err(|e| format!("write {}: {e}", script.display()))?;
        let _ = std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755));
        std::process::Command::new("/usr/bin/open")
            .arg(&script)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("open {}: {e}", script.display()))
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // The launcher is a GUI-subsystem exe with no console of its own to
        // lend — give the tail a brand-new console window. -Encoding UTF8 on
        // both reads: the server writes UTF-8 (winston's em-dashes), and
        // Windows PowerShell 5.1's Get-Content defaults to the ANSI codepage
        // for BOM-less files — without it every "—" renders as "â€"".
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        // The logs dir travels in an ENVIRONMENT VARIABLE, never inside the
        // script text: interpolating it into a single-quoted PowerShell
        // string only escapes ASCII apostrophes — a curly apostrophe in the
        // user name (`O’Brien`: legal in a Windows account, and PowerShell
        // treats U+2018/U+2019 as string delimiters) ended the literal early
        // and the window opened on a parse error; and -Path is a wildcard
        // parameter, so `[`/`]` in the path made Set-Location fail and the
        // Get-Contents then read from the launcher's cwd. Every file is
        // named by an ABSOLUTE -LiteralPath built with Join-Path: a relative
        // `.\launcher.log` after Set-Location is resolved against the current
        // directory with the wildcard characters backtick-ESCAPED (Windows
        // PowerShell 5.1: `O'Brien `[work`]\logs\...`) and not found. -NoProfile:
        // a user profile that errors under the default execution policy must
        // not prefix the support window with unrelated red text.
        std::process::Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NoExit",
                "-Command",
                "$d = $env:MSTREAM_LOGS_DIR; Set-Location -LiteralPath $d; Write-Host '== launcher.log =='; \
                 Get-Content -LiteralPath (Join-Path $d 'launcher.log') -Tail 50 -Encoding UTF8 -ErrorAction SilentlyContinue; \
                 Write-Host ''; Write-Host '== server-console.log: full server log for this session (following; close the window to stop) =='; \
                 Get-Content -LiteralPath (Join-Path $d 'server-console.log') -Wait -Encoding UTF8",
            ])
            .env("MSTREAM_LOGS_DIR", logs_dir)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("spawn powershell: {e}"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // No universal Linux terminal. Try the common emulators — each with
        // its own execute-argument dialect — first successful spawn wins;
        // with none present, degrade to the file manager on the logs dir
        // (still a working "show me the logs", just not a live tail).
        let cmd = format!(
            "cd {dir}; echo '== launcher.log =='; tail -n 50 launcher.log 2>/dev/null; echo; echo '== server-console.log: full server log for this session (following; Ctrl+C to stop) =='; exec tail -n +1 -F server-console.log",
            dir = sh_quote(logs_dir)
        );
        let candidates = [
            ("x-terminal-emulator", ["-e", "sh", "-c", cmd.as_str()]),
            ("gnome-terminal", ["--", "sh", "-c", cmd.as_str()]),
            ("konsole", ["-e", "sh", "-c", cmd.as_str()]),
            ("xfce4-terminal", ["-x", "sh", "-c", cmd.as_str()]),
            ("xterm", ["-e", "sh", "-c", cmd.as_str()]),
        ];
        for (bin, args) in candidates {
            if std::process::Command::new(bin).args(args).spawn().is_ok() {
                return Ok(());
            }
        }
        std::process::Command::new("xdg-open")
            .arg(logs_dir)
            .spawn()
            .map(|_| ())
            .map_err(|_| {
                "no terminal emulator found (tried x-terminal-emulator, gnome-terminal, \
                 konsole, xfce4-terminal, xterm) and xdg-open failed"
                    .to_string()
            })
    }
}

/// Run the bundled terminal player's setup wizard in a fresh terminal
/// window, pointed at this launcher's server. Same per-OS "what is a
/// terminal" seams as open_logs_terminal; the caller logs a failure — a
/// missing terminal emulator must never take the tray down.
pub fn open_setup_terminal(
    player_bin: &std::path::Path,
    server_url: &str,
    scratch_dir: &std::path::Path,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;
        // Terminal.app opens an executable .command file as a document — no
        // AppleEvents automation consent (see open_logs_terminal). The CSI 8
        // resize asks for the window the wizard's two-column pages were
        // designed around; Terminal.app honors it, and a terminal that
        // doesn't just keeps its size (the wizard reflows).
        let script = scratch_dir.join("setup-mstream.command");
        let body = format!(
            "#!/bin/sh\n# Written by mStream's tray 'Set up mStream' item - safe to delete.\nprintf '\\033[8;42;120t'\nclear\nexec {player} setup --server {url}\n",
            player = sh_quote(player_bin),
            url = sh_quote_str(server_url),
        );
        std::fs::write(&script, body).map_err(|e| format!("write {}: {e}", script.display()))?;
        let _ = std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755));
        std::process::Command::new("/usr/bin/open")
            .arg(&script)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("open {}: {e}", script.display()))
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = scratch_dir; // no script file on this path
        // Windows Terminal first (App Execution Alias on PATH, preinstalled
        // on Win11): it draws the wizard's pixel art via sixel. Without it,
        // a fresh conhost window still runs the wizard — crossterm enables
        // VT there and the art degrades to half-blocks.
        if std::process::Command::new("wt.exe")
            .arg(player_bin)
            .args(["setup", "--server", server_url])
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        std::process::Command::new(player_bin)
            .args(["setup", "--server", server_url])
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("spawn {}: {e}", player_bin.display()))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = scratch_dir; // no script file on this path
        let cmd = format!(
            "exec {player} setup --server {url}",
            player = sh_quote(player_bin),
            url = sh_quote_str(server_url),
        );
        let candidates = [
            ("x-terminal-emulator", ["-e", "sh", "-c", cmd.as_str()]),
            ("gnome-terminal", ["--", "sh", "-c", cmd.as_str()]),
            ("konsole", ["-e", "sh", "-c", cmd.as_str()]),
            ("xfce4-terminal", ["-x", "sh", "-c", cmd.as_str()]),
            ("xterm", ["-e", "sh", "-c", cmd.as_str()]),
        ];
        for (bin, args) in candidates {
            if std::process::Command::new(bin).args(args).spawn().is_ok() {
                return Ok(());
            }
        }
        Err("no terminal emulator found (tried x-terminal-emulator, gnome-terminal, \
             konsole, xfce4-terminal, xterm)"
            .to_string())
    }
}

/// Start the NEW launcher for the apply-update handoff, detached, and return
/// so the caller can exit. Always passes `--takeover`: the new instance
/// retries the single-instance lock briefly (we still hold it for the last
/// few milliseconds of our life) and skips first-run behavior like the
/// browser announce.
///
/// macOS .app targets go through `open -n`: a bare exec of the inner binary
/// works, but LaunchServices activation is what keeps the menu-bar
/// registration and reopen events behaving like an app the user launched.
/// This is a spawn+exit handoff, NOT an exec-in-place: AppKit/gtk state does
/// not survive exec, and PID continuity buys nothing here (nothing
/// supervises the launcher).
/// `server_args` are the current session's forwarded server flags (-j, --portable,
/// ...) — the relaunched instance must serve the SAME config, so they ride
/// along. (Env-shaped overrides like MSTREAM_SERVER_BIN survive the direct
/// spawn but not `open -n`, which launches through LaunchServices; argv is
/// the reliable carrier.)
pub fn relaunch(target: &std::path::Path, server_args: &[String]) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // Testing hook (same family as MSTREAM_LAUNCHER_SKIP_AUTOSTART):
        // smokes run inside a redirected HOME, which `open -n` would discard
        // — launchd starts apps with the session's real environment. Direct
        // spawn keeps the sandbox; real usage wants LaunchServices below.
        let direct = std::env::var_os("MSTREAM_LAUNCHER_DIRECT_RELAUNCH").is_some();
        // .../mStream.app/Contents/MacOS/mStream -> the .app root.
        let app_root = target
            .ancestors()
            .find(|p| p.extension().is_some_and(|e| e == "app"))
            .filter(|_| !direct);
        if let Some(app) = app_root {
            // status(), not spawn(): `open` exits nonzero when LaunchServices
            // refuses the launch (damaged bundle, Gatekeeper). A fire-and-
            // forget spawn would report Ok on a launch that never happened,
            // and the caller — who already stopped the server — would exit
            // into nothing. `open` returns promptly either way.
            return match std::process::Command::new("/usr/bin/open")
                .arg("-n")
                .arg(app)
                .arg("--args")
                .arg("--takeover")
                .args(server_args)
                .status()
            {
                Ok(st) if st.success() => {
                    // Exit 0 only proves LaunchServices ACCEPTED the launch:
                    // a takeover that execs and dies instantly (missing
                    // server sibling in a bad staged copy, an early panic)
                    // still reports success — measured with a bundle whose
                    // executable is `exit 7`. Poll briefly for a live
                    // process under the app path that is not US (the old
                    // launcher may share the exact path); the takeover
                    // stays alive through its ~12s lock retry, so any
                    // healthy handoff is visible well within this window.
                    let pat = format!("^{}/", crate::paths::escape_ere(&app.display().to_string()));
                    let me = std::process::id().to_string();
                    for _ in 0..8 {
                        std::thread::sleep(std::time::Duration::from_millis(250));
                        match std::process::Command::new("/usr/bin/pgrep").arg("-f").arg(&pat).output() {
                            Ok(out) => {
                                if String::from_utf8_lossy(&out.stdout)
                                    .lines()
                                    .any(|l| !l.trim().is_empty() && l.trim() != me)
                                {
                                    return Ok(());
                                }
                            }
                            // pgrep itself failing must not fail a possibly
                            // healthy handoff.
                            Err(_) => return Ok(()),
                        }
                    }
                    Err(format!("takeover under {} never appeared after open", app.display()))
                }
                Ok(st) => Err(format!("open -n {} exited {st}", app.display())),
                Err(e) => Err(format!("open -n {}: {e}", app.display())),
            };
        }
    }
    let mut cmd = std::process::Command::new(target);
    cmd.arg("--takeover");
    cmd.args(server_args);
    // The child must outlive US and our whole session: null stdio (an
    // inherited pty dies with the old session and would SIGHUP the update —
    // measured) and, on unix, its own session via setsid (no controlling
    // terminal at all).
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        cmd.creation_flags(DETACHED_PROCESS);
    }
    match cmd.spawn() {
        Ok(mut child) => {
            // A brief liveness check: a takeover that dies within its first
            // beat (bad interpreter, immediate loader failure) means the
            // handoff did NOT happen — report it so the caller can recover
            // instead of exiting into nothing. Past this window the child
            // owns its own fate (its lock retry outlives us).
            std::thread::sleep(std::time::Duration::from_millis(250));
            match child.try_wait() {
                Ok(Some(st)) => Err(format!("{} exited immediately: {st}", target.display())),
                _ => Ok(()),
            }
        }
        Err(e) => Err(format!("spawn {}: {e}", target.display())),
    }
}

/// Windows: run the verified update installer, detached, and return so the
/// tray can exit before the installer's process sweep begins. Silent =
/// Inno's /VERYSILENT unattended path (a param-gated [Run] entry in the .iss
/// relaunches the tray afterwards); non-silent shows the familiar wizard.
#[cfg(windows)]
pub fn spawn_installer_detached(installer: &std::path::Path, silent: bool) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    let mut cmd = std::process::Command::new(installer);
    if silent {
        cmd.args(["/VERYSILENT", "/NORESTART", "/MSTREAMRELAUNCH=1"]);
    }
    cmd.creation_flags(DETACHED_PROCESS);
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("spawn {}: {e}", installer.display()))
}

/// POSIX single-quote a path for embedding in `sh -c` text — the macOS data
/// home ("Application Support") guarantees a space.
#[cfg(unix)]
fn sh_quote(p: &std::path::Path) -> String {
    sh_quote_str(&p.display().to_string())
}

fn sh_quote_str(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[test]
    #[ignore = "spawns a real Terminal window - run manually with --ignored"]
    fn manual_open_logs_terminal() {
        let dir = std::env::temp_dir().join("mstream-viewlogs-demo").join("logs");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("launcher.log"), "[demo] launcher.log content\n").unwrap();
        std::fs::write(dir.join("server-console.log"), "[demo] server-console.log content\n").unwrap();
        super::open_logs_terminal(&dir).unwrap();
    }

    #[test]
    #[ignore = "spawns a real Terminal window - run manually with --ignored"]
    fn manual_open_setup_terminal() {
        // MSTREAM_DEMO_PLAYER = a real player binary; MSTREAM_DEMO_SERVER =
        // the URL to point its wizard at.
        let player = std::path::PathBuf::from(
            std::env::var("MSTREAM_DEMO_PLAYER").expect("set MSTREAM_DEMO_PLAYER"),
        );
        let url = std::env::var("MSTREAM_DEMO_SERVER")
            .unwrap_or_else(|_| "http://localhost:3000".into());
        let dir = std::env::temp_dir().join("mstream-setup-demo");
        std::fs::create_dir_all(&dir).unwrap();
        super::open_setup_terminal(&player, &url, &dir).unwrap();
    }
}
