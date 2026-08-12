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
        use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;

        // Our own std handles are still the detached ones from the GUI
        // subsystem; hand the child the REAL console devices instead.
        let conin = File::options().read(true).write(true).open("CONIN$").ok();
        let conout = File::options().read(true).write(true).open("CONOUT$").ok();
        let conerr = conout.as_ref().and_then(|f| f.try_clone().ok());

        let mut cmd = Command::new(&bin);
        cmd.args(&args.server_args);
        if let Some(f) = conin { cmd.stdin(Stdio::from(f)); }
        if let Some(f) = conout { cmd.stdout(Stdio::from(f)); }
        if let Some(f) = conerr { cmd.stderr(Stdio::from(f)); }

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
/// caught status answering on stderr — and the real console device on
/// Windows, where a windows-subsystem exe's own stdout handle is detached
/// even after AttachConsole (piping there is a pre-existing GUI-subsystem
/// limitation; the visible console is the best available contract).
pub fn console_out(msg: &str) {
    #[cfg(windows)]
    {
        use std::io::Write;
        if let Ok(mut f) = std::fs::File::options().write(true).open("CONOUT$") {
            let _ = writeln!(f, "{msg}");
            return;
        }
    }
    println!("{msg}");
}

/// Write a line to the attached console (Windows GUI subsystem can't just
/// eprintln — the std handles are detached; CONOUT$ is the real device).
pub fn console_err(msg: &str) {
    #[cfg(windows)]
    {
        use std::io::Write;
        if let Ok(mut f) = std::fs::File::options().write(true).open("CONOUT$") {
            let _ = writeln!(f, "{msg}");
            return;
        }
    }
    eprintln!("{msg}");
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
