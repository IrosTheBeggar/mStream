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
