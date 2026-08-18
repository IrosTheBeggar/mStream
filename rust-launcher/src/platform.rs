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
        let dir = logs_dir.display().to_string().replace('\'', "''");
        std::process::Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoExit",
                "-Command",
                &format!(
                    "Set-Location '{dir}'; Write-Host '== launcher.log =='; \
                     Get-Content .\\launcher.log -Tail 50 -Encoding UTF8 -ErrorAction SilentlyContinue; \
                     Write-Host ''; Write-Host '== server-console.log: full server log for this session (following; close the window to stop) =='; \
                     Get-Content .\\server-console.log -Wait -Encoding UTF8"
                ),
            ])
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

/// Tray "Quick Connect": open a terminal window that paints the pairing-code
/// QR and a short explanation, so a phone can scan it and reach this server
/// over the Iroh tunnel. The window runs THIS launcher binary again with
/// `--show-quick-connect=<addr>` (see quick_connect.rs) — no external script,
/// no `node`, nothing the shipped bundle might be missing. `addr` is the
/// host:port the health probe uses; `script_dir` (the logs dir) holds the
/// tiny macOS `.command` shim. Same per-OS "what is a terminal" seams as
/// open_logs_terminal; the caller logs a failure and falls back to the web
/// modal — a missing terminal must never take the tray down.
pub fn open_quick_connect_terminal(script_dir: &std::path::Path, addr: &str) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let flag = format!("--show-quick-connect={addr}");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = script_dir;
        // A fresh console for the GUI-subsystem launcher; the subcommand opens
        // CONOUT$/CONIN$, enables VT + UTF-8, and sizes the window itself.
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        std::process::Command::new(&exe)
            .arg(&flag)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("spawn {}: {e}", exe.display()))
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;
        // Terminal.app opens an executable .command as a document — no
        // AppleEvents automation consent (an osascript tell would prompt).
        let script = script_dir.join("quick-connect.command");
        let body = format!(
            "#!/bin/sh\n# Written by mStream's tray 'Quick Connect' item - safe to delete.\nexec {exe} {flag}\n",
            exe = sh_quote(&exe),
            flag = sh_quote_str(&flag),
        );
        std::fs::write(&script, body).map_err(|e| format!("write {}: {e}", script.display()))?;
        let _ = std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755));
        std::process::Command::new("/usr/bin/open")
            .arg(&script)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("open {}: {e}", script.display()))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = script_dir;
        let cmd = format!("exec {exe} {flag}", exe = sh_quote(&exe), flag = sh_quote_str(&flag));
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

/// POSIX single-quote a path for embedding in `sh -c` text — the macOS data
/// home ("Application Support") guarantees a space.
#[cfg(unix)]
fn sh_quote(p: &std::path::Path) -> String {
    format!("'{}'", p.display().to_string().replace('\'', "'\\''"))
}

/// POSIX single-quote an arbitrary string for `sh -c` text.
#[cfg(unix)]
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
}
