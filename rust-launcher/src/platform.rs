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
        // No universal Linux terminal: the shared chain (linux_terminal
        // below) — the desktop's declared default, the pixel-capable
        // emulators, then the distro ones. With none present, degrade to
        // the file manager on the logs dir (still a working "show me the
        // logs", just not a live tail).
        let cmd = format!(
            "cd {dir}; echo '== launcher.log =='; tail -n 50 launcher.log 2>/dev/null; echo; echo '== server-console.log: full server log for this session (following; Ctrl+C to stop) =='; exec tail -n +1 -F server-console.log",
            dir = sh_quote(logs_dir)
        );
        let candidates = linux_terminal::candidates(&cmd, None, linux_terminal::on_wayland());
        let chain_err = match linux_terminal::spawn_first_alive(&candidates) {
            Ok(_) => return Ok(()),
            Err(e) => e,
        };
        std::process::Command::new("xdg-open")
            .arg(logs_dir)
            .spawn()
            .map(|_| ())
            .map_err(|_| format!("{chain_err} and xdg-open failed"))
    }
}

/// Columns × rows the wizard pages (setup, Quick Connect) ask for, where a
/// terminal takes a size: the VTE family opens 80×24 by default, which
/// cannot hold the pairing QR drawn in half-blocks (77×39 cells), and the
/// XTWINOPS resize the macOS .command script sends is ignored by VTE,
/// kitty and stock xterm alike.
pub const WIZARD_SIZE: (u16, u16) = (120, 42);

/// Columns × rows the desktop player asks for: the GUI's design size (its
/// cell-exact 100×30 mockups). Its floor is 100×24 — below that it draws
/// "please make the terminal a little larger" instead of a layout — and no
/// terminal we launch through (Terminal.app, Windows Terminal, the Linux
/// chain) can be told a MINIMUM size, only an initial one. So the
/// initial size is the whole lever, and it must clear the floor.
pub const PLAYER_SIZE: (u16, u16) = (100, 30);

/// Which player page a terminal launch opens. Each carries its own argv,
/// window title, window size and scratch file names, so no two tray items
/// ever clobber each other's launch files.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PlayerPage {
    /// The full first-run wizard (`mstream-player setup`).
    Setup,
    /// The standalone Quick Connect page (`mstream-player qr`) — the
    /// wizard's Done screen: pairing QR plus the app buttons.
    QuickConnect,
    /// The desktop player (`mstream-player gui --bundled-server <url>`):
    /// the bundled player's mouse-first GUI face (player PR #18; the first
    /// release carrying it is paths::GUI_MIN_PLAYER_VERSION). The URL
    /// rides as `--bundled-server`, never `--server`: an explicit --server
    /// would re-pin the player to this server on every launch, overriding
    /// a default the user chose among their saved servers, where the
    /// bundled flag only seeds this server on first boot, makes it the
    /// default then, and marks it unremovable (the player's multi-server
    /// contract, clauses 50–51). `--same-machine` is not passed: the gui
    /// subcommand does not take it yet. `instance_lock` is the launcher's
    /// one-player rule (paths::desktop_player_lock): the player holds an
    /// exclusive lock on that file for its lifetime, so the launcher can
    /// tell an open player from a closed one before it opens another —
    /// None for a player release without the flag. `serve_port` is the
    /// control face's port (paths::rust_player_port): the GUI hosts the
    /// server-audio control API there, always, and the server takes it up
    /// while autoBootServerAudio is on, so the machine has one player —
    /// None for a release without the face.
    Player { instance_lock: Option<std::path::PathBuf>, serve_port: Option<u16> },
}

impl PlayerPage {
    /// The player's argv for this page, before the `<server_flag> <url>`
    /// every launch appends. Static words only: nothing here ever needs
    /// quoting (the instance lock's path rides separately: instance_lock).
    fn args(&self) -> Vec<&'static str> {
        match self {
            PlayerPage::Setup => vec!["setup"],
            PlayerPage::QuickConnect => vec!["qr"],
            PlayerPage::Player { .. } => vec!["gui"],
        }
    }
    /// The flag this launcher's server URL rides on — see the Player
    /// variant for why the desktop player is the one page that must not
    /// be told `--server`.
    fn server_flag(&self) -> &'static str {
        match self {
            PlayerPage::Player { .. } => "--bundled-server",
            _ => "--server",
        }
    }
    /// The path a `--instance-lock <path>` pair carries, when this launch
    /// has one (the Player variant of a player that takes it).
    fn instance_lock(&self) -> Option<&std::path::Path> {
        match self {
            PlayerPage::Player { instance_lock, .. } => instance_lock.as_deref(),
            _ => None,
        }
    }
    /// The port a `--serve-port <port>` pair carries, when this launch has
    /// one (the Player variant of a player whose GUI hosts the control
    /// face). Rides after the lock pair, before the server flag.
    fn serve_port(&self) -> Option<u16> {
        match self {
            PlayerPage::Player { serve_port, .. } => *serve_port,
            _ => None,
        }
    }
    /// Columns × rows to open the page's window at, where the terminal
    /// takes a size (Terminal.app's XTWINOPS resize, wt.exe --size, the
    /// sized dialects of the Linux chain); the rest open at their default
    /// and the pages reflow or ask for room.
    fn size(&self) -> (u16, u16) {
        match self {
            PlayerPage::Player { .. } => PLAYER_SIZE,
            _ => WIZARD_SIZE,
        }
    }
    #[cfg(target_os = "macos")]
    fn script_name(&self) -> String {
        match self {
            PlayerPage::Setup => "setup-mstream.command".into(),
            PlayerPage::QuickConnect => "quickconnect-mstream.command".into(),
            PlayerPage::Player { .. } => "player-mstream.command".into(),
        }
    }
}

/// Run one of the terminal player's pages — the setup wizard, Quick
/// Connect, or the desktop player — in a fresh terminal window, pointed at
/// this launcher's server and opened at the page's own size wherever the
/// terminal takes one. Same per-OS "what is a terminal" seams as
/// open_logs_terminal; the caller logs a failure — a missing terminal
/// emulator must never take the tray down. Ok carries WHICH surface
/// opened (a support surface: which terminal took the page should be one
/// log line away).
///
/// This is the terminal route, and since the window route it is also the
/// fallback route: the desktop player's when its window cannot open
/// (spawn_player_window), and the setup wizard's and Quick Connect's the
/// same way once a desktop build hosts them in a window of its own
/// (`window-pages`, paths::PlayerProbe) — and their only route on every
/// build without that word.
///
/// macOS takes Terminal.app. Apple's terminal has no pixel protocol, so
/// the wizard's wordmark and QR degrade to character art there — the
/// fallback's price now that the pages draw their pixels in the player's
/// own window; the bundled Ghostty that drew them before left with player
/// v0.12.0.
pub fn open_player_terminal(
    player_bin: &std::path::Path,
    server_url: &str,
    scratch_dir: &std::path::Path,
    page: PlayerPage,
) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;
        // Terminal.app opens an executable .command file as a document — no
        // AppleEvents automation consent (see open_logs_terminal). The CSI 8
        // resize asks for the page's window (the wizard's two-column pages
        // were designed around theirs; the player's floor needs its own);
        // Terminal.app honors it, and a terminal that doesn't just keeps
        // its size (the pages reflow, the player asks for room).
        let script = scratch_dir.join(page.script_name());
        let (cols, rows) = page.size();
        let body = format!(
            "#!/bin/sh\n# Written by mStream's tray - safe to delete.\nprintf '\\033[8;{rows};{cols}t'\nclear\nexec {}\n",
            player_shell_words(&page, player_bin, server_url),
        );
        std::fs::write(&script, body).map_err(|e| format!("write {}: {e}", script.display()))?;
        let _ = std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755));
        std::process::Command::new("/usr/bin/open")
            .arg(&script)
            .spawn()
            .map(|_| "Terminal.app".into())
            .map_err(|e| format!("open {}: {e}", script.display()))
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = scratch_dir; // no script file on this path
        // Windows Terminal first (App Execution Alias on PATH, preinstalled
        // on Win11): it draws the wizard's pixel art via sixel, and its CLI
        // takes the page's window size (wt_invocation). Without it, a fresh
        // conhost window still runs the page — crossterm enables VT there
        // and the art degrades to half-blocks; conhost's stock 120×30
        // clears the player's floor, and the wizard reflows.
        if std::process::Command::new("wt.exe")
            .args(wt_invocation(&page, player_bin, server_url))
            .spawn()
            .is_ok()
        {
            return Ok("wt.exe".into());
        }
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        std::process::Command::new(player_bin)
            .args(player_argv(&page, server_url, false))
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map(|_| "conhost fallback".into())
            .map_err(|e| format!("spawn {}: {e}", player_bin.display()))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = scratch_dir; // no script file on this path
        // No `exec`: the shell stays the window's parent, so a page that
        // dies at once (a missing libasound, a bad binary) leaves its error
        // on screen behind a "press Enter" instead of a window that flashed
        // and vanished — the support surface for "nothing happened".
        let cmd = format!(
            "{}; s=$?; if [ \"$s\" -ne 0 ]; then printf '\\nmstream-player exited with status %s - press Enter to close this window\\n' \"$s\"; read dummy; fi",
            player_shell_words(&page, player_bin, server_url),
        );
        let candidates = linux_terminal::candidates(&cmd, Some(page.size()), linux_terminal::on_wayland());
        linux_terminal::spawn_first_alive(&candidates)
    }
}

/// The wt.exe command line for a page: a NEW window (`-w new` — under a
/// `windowingBehavior` of "use existing", a bare wt would hand the page to
/// a tab in whatever Windows Terminal window the user has open; a page
/// wants a window of its own, and `--size` only applies to a new window),
/// the page's size in cells, then the player's command line as separate
/// argv elements, which wt passes through to the new tab's process. Pure,
/// so the Windows argv is pinned by a test on every host.
#[cfg(any(windows, test))]
fn wt_invocation(page: &PlayerPage, player_bin: &std::path::Path, server_url: &str) -> Vec<std::ffi::OsString> {
    let (cols, rows) = page.size();
    let mut argv: Vec<std::ffi::OsString> =
        vec!["-w".into(), "new".into(), "--size".into(), format!("{cols},{rows}").into()];
    argv.push(player_bin.as_os_str().to_owned());
    argv.extend(player_argv(page, server_url, false));
    argv
}

/// Whether this session can show a window at all — the window route's
/// precondition beside the probe's flavour. macOS and Windows always can
/// (a launcher with a tray has a desktop); Linux only with an X11 or
/// Wayland display to draw on — a headless or SSH session without one goes
/// the terminal way, as before.
pub fn window_display_available() -> bool {
    display_available_on(std::env::consts::OS, |name| std::env::var_os(name))
}

/// The pure half: `os` is std::env::consts::OS, `var` the environment. An
/// exported-but-empty variable is no display (the same "empty means unset"
/// rule paths::env_dir applies).
pub(crate) fn display_available_on(os: &str, var: impl Fn(&str) -> Option<std::ffi::OsString>) -> bool {
    match os {
        "macos" | "windows" => true,
        _ => ["DISPLAY", "WAYLAND_DISPLAY"].into_iter().any(|name| var(name).is_some_and(|v| !v.is_empty())),
    }
}

/// Windows: no console window for the child (the desktop exe is
/// console-subsystem, and a GUI launcher's console child would otherwise
/// flash one up for its lifetime) — the exe still GETS a console, hidden,
/// which its CLI half expects to hold (DETACHED_PROCESS would leave it
/// none at all, so it is never used here).
#[cfg(any(windows, test))]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// Windows: the child leads a process group of its own, so a console
/// Ctrl+C/Ctrl+Break aimed at the launcher's group never reaches it.
#[cfg(any(windows, test))]
pub(crate) const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
/// Windows: never this (see CREATE_NO_WINDOW); named so a test can say so.
#[cfg(test)]
pub(crate) const DETACHED_PROCESS: u32 = 0x0000_0008;
/// The window route's creation flags on Windows.
#[cfg(any(windows, test))]
pub(crate) const WINDOW_CREATION_FLAGS: u32 = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP;
/// Unix: the process group the window route's child joins — 0 is a NEW
/// group, led by the child itself, so a signal to the launcher's group (a
/// Ctrl+C in the terminal that ran it, a smoke's group kill) never takes
/// the player's window with it.
#[cfg(any(unix, test))]
pub(crate) const WINDOW_PROCESS_GROUP: i32 = 0;

/// The window route: start the DESKTOP player straight into its own window
/// (`gui --window …`, the same values the terminal route passes — see
/// player_words), detached from the launcher: stdin null, stdout and stderr
/// to `log_file` (truncated here: one window's session per file — the
/// caller rotates the previous one aside), its own process group, and on
/// Windows no console window. Ok hands back the child for the caller's
/// watcher, which decides what an early exit means (exit 3: no window could
/// open; exit 0: refused by the instance lock for the player, a normal
/// close for the lock-free wizard and Quick Connect pages, whose window
/// route is `setup --window` / `qr --window` with no lock or port); the
/// launcher itself never waits on it.
pub fn spawn_player_window(
    player_bin: &std::path::Path,
    server_url: &str,
    page: &PlayerPage,
    log_file: &std::path::Path,
) -> Result<std::process::Child, String> {
    use std::process::{Command, Stdio};
    let out = std::fs::File::options()
        .create(true)
        .write(true)
        .truncate(true)
        .open(log_file)
        .map_err(|e| format!("open {}: {e}", log_file.display()))?;
    let err = out.try_clone().map_err(|e| format!("dup {}: {e}", log_file.display()))?;
    let mut cmd = Command::new(player_bin);
    cmd.args(player_argv(page, server_url, true))
        .stdin(Stdio::null())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err));
    // The player is an app of its own (io.mstream.player, its own Dock
    // icon), not part of the mStream.app bundle the launcher runs as: drop
    // the bundle marker LaunchServices stamped into our env (server::spawn
    // does the same for the server).
    cmd.env_remove("__CFBundleIdentifier");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(WINDOW_PROCESS_GROUP);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(WINDOW_CREATION_FLAGS);
    }
    cmd.spawn().map_err(|e| format!("spawn {}: {e}", player_bin.display()))
}

/// Bring the open desktop player's window forward — the answer to "Open
/// mStream Player" (or --player, a re-click, a second launch) while the
/// player's instance lock is held. `who` is the player's sidecar
/// (paths::read_player_sidecar), read behind the lock check; its `host`
/// picks the way. Ok carries what was activated, Err why nothing could be
/// — a focus that fails is a log line, never a second player.
///
/// macOS activates the app hosting the player: the player itself when it
/// draws in its own window (host `window`: the desktop build, activated
/// by its pid), Terminal.app for an Apple Terminal host (all its windows
/// come forward; close enough), and nothing for any other host — a Ghostty
/// of the user's own included, since `open -a` on an app that is not
/// running would launch one. Windows raises the top-level window the
/// sidecar's pid owns when there is one (the desktop build's own window),
/// else finds the window by the title the player sets — in Windows Terminal
/// that is the window whose active tab is the player's. Linux asks `wmctrl`
/// or `xdotool` when one is installed (by title, which the desktop build's
/// window carries too).
pub fn focus_player(who: Option<&crate::paths::PlayerSidecar>) -> Result<String, String> {
    let host = who.map(|w| w.host.as_str()).unwrap_or("unknown");
    #[cfg(target_os = "macos")]
    {
        match mac_focus_plan(host) {
            MacFocus::Window => {
                let pid = who.expect("the plan names the window only from a sidecar").pid;
                activate_pid(pid)?;
                Ok(format!("the player's own window (pid {pid})"))
            }
            MacFocus::Terminal => {
                open_app(std::ffi::OsStr::new("Terminal"))?;
                Ok("Terminal.app".into())
            }
            MacFocus::Nothing(why) => Err(why),
        }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            FindWindowW, IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE,
        };
        // The pid first: the desktop build's window belongs to the player's
        // own process, so the sidecar's pid names it exactly (a terminal-
        // hosted player's window belongs to its terminal, so the search
        // comes back empty there and the title has it, as before). The
        // title search does not share the pid search's helper-window trap
        // (top_level_window_of): winit creates its helper with no title, so
        // only a window titled exactly "mStream Player" answers — the
        // terminal whose active tab is the player, conhost's own window, or
        // the desktop build's window should the pid search miss it.
        let by_pid = who.and_then(|w| top_level_window_of(w.pid));
        let (hwnd, what) = match by_pid {
            Some(hwnd) => (hwnd, format!("the player's own window (pid {})", who.map(|w| w.pid).unwrap_or(0))),
            None => {
                let title: Vec<u16> = "mStream Player".encode_utf16().chain(std::iter::once(0)).collect();
                let hwnd = unsafe { FindWindowW(std::ptr::null(), title.as_ptr()) };
                if hwnd.is_null() {
                    return Err(format!(
                        "no window titled 'mStream Player' to raise (the player runs under {host}; in Windows Terminal its tab must be the active one)"
                    ));
                }
                (hwnd, "the 'mStream Player' window".to_string())
            }
        };
        unsafe {
            if IsIconic(hwnd) != 0 {
                ShowWindow(hwnd, SW_RESTORE);
            }
            SetForegroundWindow(hwnd);
        }
        Ok(what)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        use std::process::{Command, Stdio};
        let mut tried = Vec::new();
        let tools: [(&str, &[&str]); 2] = [
            ("wmctrl", &["-a", "mStream Player"]),
            ("xdotool", &["search", "--name", "^mStream Player$", "windowactivate"]),
        ];
        for (bin, args) in tools {
            match Command::new(bin).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status() {
                Ok(st) if st.success() => return Ok(format!("the 'mStream Player' window via {bin}")),
                Ok(_) => tried.push(format!("{bin}: no window named 'mStream Player'")),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => tried.push(format!("{bin}: not installed")),
                Err(e) => tried.push(format!("{bin}: {e}")),
            }
        }
        Err(format!("could not raise the player's window ({}); it runs under {host}", tried.join("; ")))
    }
}

/// The macOS focus decision, pure so the matrix is unit-tested on every
/// host: what to activate for the host the sidecar names.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, PartialEq, Eq)]
enum MacFocus {
    /// The player's own window (host `window`): activate its pid.
    Window,
    Terminal,
    Nothing(String),
}

#[cfg(any(target_os = "macos", test))]
fn mac_focus_plan(host: &str) -> MacFocus {
    match host {
        "window" => MacFocus::Window,
        "ghostty" => MacFocus::Nothing("the player runs in Ghostty; nothing to activate (open -a would launch one)".into()),
        "apple-terminal" => MacFocus::Terminal,
        other => MacFocus::Nothing(format!("the player runs under {}; nothing to activate", if other.is_empty() { "an unknown terminal" } else { other })),
    }
}

/// Bring the process `pid` to the front by its NSRunningApplication — the
/// desktop player draws in a window of its own, so the app to activate is
/// the player itself. No AppleEvents (System Events would ask the user for
/// automation consent first), no `open -a` (the player is not a bundle the
/// way LaunchServices names apps). The same steps the player's own second
/// launch takes (its src/desktop.rs focus_window_holder): on macOS 14 and
/// later activation is cooperative — an app may be activated only by one
/// that yields to it, and a plain `activateWithOptions:` from outside
/// answers YES and moves nothing — so the launcher (an NSApplication
/// already, tao's) yields to the holder and asks for it from itself. Off
/// the main thread (the window watcher) the yield is skipped; the request
/// still goes out.
#[cfg(target_os = "macos")]
fn activate_pid(pid: u32) -> Result<(), String> {
    use objc2::runtime::NSObjectProtocol;
    use objc2::{sel, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSApplicationActivationOptions, NSRunningApplication};

    let pid_t = i32::try_from(pid).map_err(|_| format!("pid {pid} out of range"))?;
    if pid == std::process::id() {
        return Err(format!("pid {pid} is the launcher itself"));
    }
    let holder = NSRunningApplication::runningApplicationWithProcessIdentifier(pid_t)
        .ok_or_else(|| format!("no running application with pid {pid}"))?;
    if holder.isTerminated() {
        return Err(format!("pid {pid} has terminated"));
    }
    let this = NSRunningApplication::currentApplication();
    let asked = if this.respondsToSelector(sel!(activateFromApplication:options:)) {
        if let Some(main) = MainThreadMarker::new() {
            NSApplication::sharedApplication(main).yieldActivationToApplication(&holder);
        }
        holder.activateFromApplication_options(&this, NSApplicationActivationOptions::ActivateAllWindows)
    } else {
        // Before macOS 14 a request that ignores the frontmost app is
        // honoured (the flag is deprecated, and inert, from 14 on).
        #[allow(deprecated)]
        let options = NSApplicationActivationOptions::ActivateAllWindows
            | NSApplicationActivationOptions::ActivateIgnoringOtherApps;
        holder.activateWithOptions(options)
    };
    if asked {
        Ok(())
    } else {
        Err(format!("AppKit refused to activate pid {pid}"))
    }
}

/// Whether the Control key is down right now. On macOS a Control-click is
/// the system's secondary click, the one a mouse or trackpad without a
/// right button makes, so the tray reads this at a left press on its icon
/// (tray_app's icon_click_of) and shows the menu instead of opening the
/// player. `+[NSEvent modifierFlags]` reports the keyboard's modifier state
/// at the moment of the call; it is sent by name because this crate does
/// not enable objc2-app-kit's NSEvent binding for one class method.
/// Elsewhere Control means nothing to a tray click: always false.
pub fn control_key_held() -> bool {
    #[cfg(target_os = "macos")]
    {
        // NSEventModifierFlagControl.
        const CONTROL: usize = 1 << 18;
        // SAFETY: a class method taking no arguments and returning an
        // NSUInteger (NSEventModifierFlags), on a class AppKit always has.
        let flags: usize = unsafe { objc2::msg_send![objc2::class!(NSEvent), modifierFlags] };
        flags & CONTROL != 0
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Pass this process's right to take the foreground on to whatever it opens
/// next. On Windows a window comes to the front only when its process may
/// put it there. The taskbar grants that right to the process whose
/// notification icon was just clicked, but a freshly spawned player (or
/// terminal, or browser) is another process, and it inherits the right only
/// when its parent IS the foreground process. That holds after a menu pick,
/// because tray-icon makes the launcher's hidden window the foreground
/// before it pops the menu (show_tray_menu), and not after a left click,
/// which tray-icon only reports. AllowSetForegroundWindow(ASFW_ANY) hands
/// the right on, so a left click brings a new player window to the front as
/// the menu item does. False when this process had no right to pass on (the
/// call then changes nothing); always true elsewhere, where no such rule
/// keeps a new window back.
pub fn allow_foreground_handoff() -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY};
        // SAFETY: takes a process id (or ASFW_ANY) by value and nothing else.
        unsafe { AllowSetForegroundWindow(ASFW_ANY) != 0 }
    }
    #[cfg(not(windows))]
    {
        true
    }
}

/// The desktop player's own window: the first top-level window `pid` owns
/// that is_app_window admits. None when the pid owns none, which is every
/// terminal-hosted player (its window is its terminal's).
///
/// "Visible" alone does not find it. winit (the player's windowing) gives
/// its event loop a helper window, class "Winit Thread Event Target", and
/// makes it WS_VISIBLE on purpose (only a visible window is sent WM_PAINT,
/// which winit uses to deliver events during a resize); it stays out of
/// sight by being tiny, at 0,0, layered and transparent, a tool window and
/// no-activate. It is unowned, so a visible-and-unowned search can return
/// it — and does whenever the real window is minimised, because a
/// minimised window sinks to the bottom of the z-order EnumWindows walks.
/// Measured on Windows 10 with player v0.12.0 minimised: focus_player found
/// the helper, IsIconic(helper) was false so the real window was never
/// restored, SetForegroundWindow went to the invisible helper, and the log
/// still said the player's window was activated.
#[cfg(windows)]
fn top_level_window_of(pid: u32) -> Option<windows_sys::Win32::Foundation::HWND> {
    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowLongW, GetWindowThreadProcessId, IsWindowVisible, GWL_EXSTYLE, GW_OWNER,
    };
    struct Search {
        pid: u32,
        found: HWND,
    }
    unsafe extern "system" fn visit(hwnd: HWND, search: LPARAM) -> BOOL {
        // SAFETY: `search` is the `&mut Search` EnumWindows was handed,
        // alive for the whole enumeration; the calls take any HWND.
        unsafe {
            let search = &mut *(search as *mut Search);
            let mut owner = 0u32;
            GetWindowThreadProcessId(hwnd, &mut owner);
            if owner != search.pid {
                return 1;
            }
            let visible = IsWindowVisible(hwnd) != 0;
            let owned = !GetWindow(hwnd, GW_OWNER).is_null();
            // The extended styles are a DWORD; GetWindowLongW hands them
            // back as its i32 (GetWindowLongPtrW's isize adds nothing here).
            let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
            if is_app_window(visible, owned, ex_style) {
                search.found = hwnd;
                return 0;
            }
        }
        1
    }
    if pid == 0 {
        return None;
    }
    let mut search = Search { pid, found: std::ptr::null_mut() };
    unsafe { EnumWindows(Some(visit), &mut search as *mut Search as LPARAM) };
    (!search.found.is_null()).then_some(search.found)
}

/// WS_EX_TOOLWINDOW and WS_EX_NOACTIVATE, spelled out so is_app_window and
/// its tests build on every host; a Windows-only test pins them to
/// windows-sys's values.
#[cfg(any(windows, test))]
const EX_TOOLWINDOW: u32 = 0x0000_0080;
#[cfg(any(windows, test))]
const EX_NOACTIVATE: u32 = 0x0800_0000;

/// Is a top-level window one a user would call the app's window — the one
/// focus_player may restore and bring forward? Visible (a minimised window
/// still is), unowned (a dialog is owned by the window it belongs to), and
/// neither a tool window nor a no-activate one. Those two extended styles
/// are how a program tells Windows a window is not for the user to switch
/// to: a WS_EX_TOOLWINDOW window gets no taskbar button and no Alt+Tab
/// entry (the shell's own rule for "an app window" is visible, unowned and
/// not a tool window), and a WS_EX_NOACTIVATE window never becomes the
/// foreground when clicked — so neither is a window the user minimised or
/// expects to see come forward, and activating one shows nothing. winit's
/// thread helper carries both (top_level_window_of); the player's real
/// window carries neither. The player's own second-launch focus applies the
/// same rule to the same windows; keep the two in step. Pure, so the rule
/// is unit-tested on every host.
#[cfg(any(windows, test))]
fn is_app_window(visible: bool, owned: bool, ex_style: u32) -> bool {
    visible && !owned && ex_style & (EX_TOOLWINDOW | EX_NOACTIVATE) == 0
}

/// `open -a <app>`: activate a running app (or launch it — which is why
/// focus_player only calls this for something it knows is running). Waits
/// for `open`'s own exit: a nonzero status is LaunchServices refusing.
#[cfg(target_os = "macos")]
fn open_app(app: &std::ffi::OsStr) -> Result<(), String> {
    match std::process::Command::new("/usr/bin/open").arg("-a").arg(app).status() {
        Ok(st) if st.success() => Ok(()),
        Ok(st) => Err(format!("open -a {}: {st}", app.to_string_lossy())),
        Err(e) => Err(format!("open -a {}: {e}", app.to_string_lossy())),
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

/// The Linux terminal chain, shared by View logs and the wizard pages.
/// There is no universal Linux terminal, so this is a preference list —
/// each entry in its own execute-argument dialect — and the first one that
/// actually opens wins.
#[cfg(all(unix, not(target_os = "macos")))]
mod linux_terminal {
    use std::process::{Command, Stdio};
    use std::time::Duration;

    /// How long a spawned emulator gets to fail. A spawn that succeeds and
    /// then exits non-zero at once opened nothing — a Wayland-only terminal
    /// on X11, a GPU terminal without GL, a D-Bus factory that refused —
    /// and must not end the chain: before this probe, such a "success"
    /// left the user with no window and no fallback.
    const GRACE: Duration = Duration::from_millis(250);

    pub fn on_wayland() -> bool {
        std::env::var_os("WAYLAND_DISPLAY").is_some_and(|v| !v.is_empty())
    }

    /// The chain for one `sh -c` program, in preference order:
    ///  1. `xdg-terminal-exec` — the freedesktop "run this in the user's
    ///     chosen terminal" entry point, authoritative where installed;
    ///  2. the pixel-capable emulators (kitty, Ghostty, WezTerm, foot):
    ///     they draw the wizard's wordmark and QR as real pixels, so a user
    ///     who has one gets the best page even when it isn't the desktop's
    ///     default (the player repo's Phase 8 verdict);
    ///  3. Debian's `x-terminal-emulator` alternative, then the desktop
    ///     defaults — Ptyxis (Fedora 41+ ships no gnome-terminal), GNOME
    ///     Console, GNOME Terminal, Konsole, the Xfce and MATE terminals,
    ///     Alacritty — and xterm last.
    ///
    /// `size` (the page's — WIZARD_SIZE or PLAYER_SIZE) rides only where
    /// the CLI takes one (the rest open at their default and the pages
    /// reflow); `wayland` admits foot, which cannot run without a Wayland
    /// socket.
    pub fn candidates(cmd: &str, size: Option<(u16, u16)>, wayland: bool) -> Vec<(&'static str, Vec<String>)> {
        // Every dialect ends in the program itself as three argv elements —
        // `sh -c <cmd>` — so no emulator re-parses the command text.
        let with = |lead: Vec<String>| -> Vec<String> {
            let mut a = lead;
            a.extend(["sh", "-c", cmd].map(String::from));
            a
        };
        let owned = |parts: &[&str]| -> Vec<String> { parts.iter().map(|p| (*p).to_string()).collect() };
        let geo = size.map(|(c, r)| format!("{c}x{r}"));
        let mut chain: Vec<(&'static str, Vec<String>)> = Vec::new();
        chain.push(("xdg-terminal-exec", with(vec![])));
        chain.push((
            "kitty",
            with(match size {
                Some((c, r)) => vec![
                    "-o".into(),
                    format!("initial_window_width={c}c"),
                    "-o".into(),
                    format!("initial_window_height={r}c"),
                ],
                None => vec![],
            }),
        ));
        chain.push((
            "ghostty",
            with(match size {
                Some((c, r)) => vec![format!("--window-width={c}"), format!("--window-height={r}"), "-e".into()],
                None => owned(&["-e"]),
            }),
        ));
        chain.push((
            "wezterm",
            with(match size {
                Some((c, r)) => vec![
                    "--config".into(),
                    format!("initial_cols={c}"),
                    "--config".into(),
                    format!("initial_rows={r}"),
                    "start".into(),
                    "--".into(),
                ],
                None => owned(&["start", "--"]),
            }),
        ));
        if wayland {
            chain.push((
                "foot",
                with(match &geo {
                    Some(g) => vec!["-W".into(), g.clone(), "--".into()],
                    None => owned(&["--"]),
                }),
            ));
        }
        chain.push(("x-terminal-emulator", with(owned(&["-e"]))));
        chain.push(("ptyxis", with(owned(&["--"]))));
        chain.push(("kgx", with(owned(&["--"]))));
        chain.push((
            "gnome-terminal",
            with(match &geo {
                Some(g) => vec![format!("--geometry={g}"), "--".into()],
                None => owned(&["--"]),
            }),
        ));
        chain.push(("konsole", with(owned(&["-e"]))));
        chain.push((
            "xfce4-terminal",
            with(match &geo {
                Some(g) => vec![format!("--geometry={g}"), "-x".into()],
                None => owned(&["-x"]),
            }),
        ));
        chain.push((
            "mate-terminal",
            with(match &geo {
                Some(g) => vec![format!("--geometry={g}"), "-x".into()],
                None => owned(&["-x"]),
            }),
        ));
        chain.push((
            "alacritty",
            with(match size {
                Some((c, r)) => vec![
                    "-o".into(),
                    format!("window.dimensions.columns={c}"),
                    "-o".into(),
                    format!("window.dimensions.lines={r}"),
                    "-e".into(),
                ],
                None => owned(&["-e"]),
            }),
        ));
        chain.push((
            "xterm",
            with(match &geo {
                Some(g) => vec!["-geometry".into(), g.clone(), "-e".into()],
                None => owned(&["-e"]),
            }),
        ));
        chain
    }

    /// Spawn the first candidate that is still alive after GRACE — or that
    /// exited 0 within it: the D-Bus-factory clients (gnome-terminal and
    /// kin) hand the window to a running service and return at once. Ok
    /// carries the emulator that opened; Err lists what each one did, for
    /// the launcher log.
    pub fn spawn_first_alive(candidates: &[(&str, Vec<String>)]) -> Result<String, String> {
        let mut tried = Vec::with_capacity(candidates.len());
        for (bin, args) in candidates {
            let mut child = match Command::new(bin).args(args).stdin(Stdio::null()).spawn() {
                Ok(c) => c,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    tried.push(format!("{bin}: not installed"));
                    continue;
                }
                Err(e) => {
                    tried.push(format!("{bin}: {e}"));
                    continue;
                }
            };
            std::thread::sleep(GRACE);
            if let Ok(Some(status)) = child.try_wait() {
                if !status.success() {
                    tried.push(format!("{bin}: {status}"));
                    continue;
                }
            }
            // Reap it eventually, so a session of clicks leaves no zombies.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            return Ok((*bin).to_string());
        }
        Err(format!("no terminal emulator opened ({})", tried.join("; ")))
    }
}

#[cfg(all(test, unix, not(target_os = "macos")))]
mod linux_tests {
    use super::linux_terminal::{candidates, spawn_first_alive};
    use super::{PLAYER_SIZE, WIZARD_SIZE};

    const CMD: &str = "'/opt/m stream/bin/mstream-player' setup --server 'http://x:1'";

    #[test]
    fn every_dialect_carries_the_program_as_sh_dash_c() {
        for size in [None, Some(WIZARD_SIZE)] {
            for wayland in [false, true] {
                for (bin, args) in candidates(CMD, size, wayland) {
                    let n = args.len();
                    assert!(n >= 3, "{bin}: {args:?}");
                    assert_eq!(&args[n - 3..], ["sh", "-c", CMD], "{bin}: {args:?}");
                }
            }
        }
    }

    #[test]
    fn size_rides_only_where_the_cli_takes_one() {
        let sized = candidates(CMD, Some(WIZARD_SIZE), true);
        let args_of = |bin: &str| -> Vec<String> {
            sized.iter().find(|(b, _)| *b == bin).map(|(_, a)| a.clone()).unwrap_or_else(|| panic!("{bin} missing"))
        };
        let pair = |bin: &str, a: &str, b: &str| args_of(bin).windows(2).any(|w| w[0] == a && w[1] == b);
        assert!(pair("xterm", "-geometry", "120x42"));
        assert!(pair("foot", "-W", "120x42"));
        assert!(args_of("gnome-terminal").contains(&"--geometry=120x42".to_string()));
        assert!(args_of("xfce4-terminal").contains(&"--geometry=120x42".to_string()));
        assert!(args_of("mate-terminal").contains(&"--geometry=120x42".to_string()));
        assert!(args_of("kitty").contains(&"initial_window_width=120c".to_string()));
        assert!(args_of("ghostty").contains(&"--window-height=42".to_string()));
        assert!(args_of("wezterm").contains(&"initial_rows=42".to_string()));
        assert!(args_of("alacritty").contains(&"window.dimensions.lines=42".to_string()));
        // The player's size rides the same seats.
        let player = candidates(CMD, Some(PLAYER_SIZE), true);
        let p_args = |bin: &str| -> Vec<String> {
            player.iter().find(|(b, _)| *b == bin).map(|(_, a)| a.clone()).unwrap_or_else(|| panic!("{bin} missing"))
        };
        assert!(p_args("xterm").windows(2).any(|w| w[0] == "-geometry" && w[1] == "100x30"));
        assert!(p_args("ghostty").contains(&"--window-width=100".to_string()));
        assert!(p_args("kitty").contains(&"initial_window_height=30c".to_string()));
        // These CLIs take no size: the pages reflow into the default window.
        for bin in ["xdg-terminal-exec", "x-terminal-emulator", "ptyxis", "kgx", "konsole"] {
            let a = args_of(bin);
            assert!(!a.iter().any(|x| x.contains("120") || x.contains("42")), "{bin}: {a:?}");
        }
        // Without a size, nobody asks for one.
        for (bin, args) in candidates(CMD, None, true) {
            assert!(
                !args.iter().any(|a| a.contains("120x42") || a.contains("=120") || a.contains("=42")),
                "{bin}: {args:?}"
            );
        }
    }

    #[test]
    fn foot_is_offered_only_on_wayland() {
        assert!(candidates(CMD, None, false).iter().all(|(b, _)| *b != "foot"));
        assert!(candidates(CMD, None, true).iter().any(|(b, _)| *b == "foot"));
    }

    #[test]
    fn order_is_declared_default_then_pixel_capable_then_distro_then_xterm() {
        let names: Vec<&str> = candidates(CMD, None, true).into_iter().map(|(b, _)| b).collect();
        assert_eq!(names.first(), Some(&"xdg-terminal-exec"));
        assert_eq!(names.last(), Some(&"xterm"));
        let pos = |n: &str| names.iter().position(|b| *b == n).unwrap_or_else(|| panic!("{n} missing"));
        assert!(pos("kitty") < pos("x-terminal-emulator"), "pixel-capable before the distro default");
        assert!(pos("x-terminal-emulator") < pos("ptyxis") && pos("ptyxis") < pos("gnome-terminal"));
    }

    #[test]
    fn a_spawn_that_dies_at_once_does_not_end_the_chain() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("mstream-term-chain-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = |name: &str, body: &str| -> String {
            let p = dir.join(name);
            std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            p.to_string_lossy().into_owned()
        };
        let dead = script("dead-terminal", "exit 3");
        let alive = script("alive-terminal", "sleep 1");
        let handed_off = script("factory-client", "exit 0");
        let missing = dir.join("no-such-terminal").to_string_lossy().into_owned();

        let chain = vec![(missing.as_str(), vec![]), (dead.as_str(), vec![]), (alive.as_str(), vec![])];
        assert_eq!(spawn_first_alive(&chain).unwrap(), alive, "the first one still running wins");

        let factory = vec![(dead.as_str(), vec![]), (handed_off.as_str(), vec![]), (alive.as_str(), vec![])];
        assert_eq!(spawn_first_alive(&factory).unwrap(), handed_off, "a clean exit 0 counts as opened");

        let hopeless = vec![(missing.as_str(), vec![]), (dead.as_str(), vec![])];
        let err = spawn_first_alive(&hopeless).unwrap_err();
        assert!(err.contains("not installed") && err.contains("exit status: 3"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// POSIX single-quote a path for embedding in `sh -c` text — the macOS data
/// home ("Application Support") guarantees a space.
#[cfg(unix)]
fn sh_quote(p: &std::path::Path) -> String {
    sh_quote_str(&p.display().to_string())
}

#[cfg(unix)]
fn sh_quote_str(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The one `sh -c` program every unix launch of a player page runs —
/// `'<player>' <page args…> <server flag> '<url>'` — shared by the macOS
/// .command script and the Linux chain, so both agree on the argv and its
/// quoting.
#[cfg(unix)]
fn player_shell_words(page: &PlayerPage, player_bin: &std::path::Path, server_url: &str) -> String {
    let mut words = vec![sh_quote(player_bin)];
    words.extend(player_words(page, server_url, false).into_iter().map(|w| {
        if w.data {
            sh_quote_str(&w.text.to_string_lossy())
        } else {
            w.text.to_string_lossy().into_owned()
        }
    }));
    words.join(" ")
}

/// One word of a player launch's argv after the binary. `data` marks the
/// words that come from outside this code — the lock's path, the server's
/// URL — which the sh line single-quotes; the rest are the page's static
/// words, flags and port numbers, which never need it.
struct PlayerWord {
    text: std::ffi::OsString,
    // Read by the sh line only; Windows hosts take argv elements.
    #[cfg_attr(windows, allow(dead_code))]
    data: bool,
}

/// THE argv of a player launch, after the binary — shared by every route
/// so they cannot drift: the sh line (macOS .command, Linux chain), wt.exe,
/// the conhost fallback, and the window route.
/// `<page words> [--window] [--instance-lock <path>] [--serve-port <port>]
/// <server flag> <url>`. `window` adds the one word the window route
/// differs by, right after the page's own (`gui --window`); every value
/// is the terminal route's.
fn player_words(page: &PlayerPage, server_url: &str, window: bool) -> Vec<PlayerWord> {
    let flag = |s: &str| PlayerWord { text: s.into(), data: false };
    let mut words: Vec<PlayerWord> = page.args().into_iter().map(flag).collect();
    if window {
        words.push(flag("--window"));
    }
    if let Some(lock) = page.instance_lock() {
        words.push(flag("--instance-lock"));
        words.push(PlayerWord { text: lock.as_os_str().to_owned(), data: true });
    }
    if let Some(port) = page.serve_port() {
        words.push(flag("--serve-port"));
        words.push(flag(&port.to_string()));
    }
    words.push(flag(page.server_flag()));
    words.push(PlayerWord { text: server_url.into(), data: true });
    words
}

/// player_words as plain argv elements (Command::args, wt.exe's tail).
fn player_argv(page: &PlayerPage, server_url: &str, window: bool) -> Vec<std::ffi::OsString> {
    player_words(page, server_url, window).into_iter().map(|w| w.text).collect()
}

#[cfg(test)]
mod page_tests {
    use super::{PlayerPage, PLAYER_SIZE, WIZARD_SIZE};

    /// The desktop player page of a player without the lock flag.
    fn player() -> PlayerPage {
        PlayerPage::Player { instance_lock: None, serve_port: None }
    }

    fn every_page() -> Vec<PlayerPage> {
        vec![PlayerPage::Setup, PlayerPage::QuickConnect, player()]
    }

    #[test]
    fn each_page_maps_to_its_own_argv() {
        assert_eq!(PlayerPage::Setup.args(), ["setup"]);
        assert_eq!(PlayerPage::QuickConnect.args(), ["qr"]);
        assert_eq!(player().args(), ["gui"]);
        // Three pages, three argvs: no two tray items may open the same
        // thing.
        let pages = every_page();
        for (i, a) in pages.iter().enumerate() {
            for b in &pages[i + 1..] {
                assert_ne!(a.args(), b.args(), "{a:?} vs {b:?}");
            }
        }
    }

    #[test]
    fn the_player_page_seeds_the_bundled_server_and_opens_at_its_own_size() {
        // The desktop player is the one page told --bundled-server: an
        // explicit --server would re-pin it to this server on every launch,
        // over a default the user chose among their saved servers.
        assert_eq!(player().server_flag(), "--bundled-server");
        assert_eq!(player().size(), PLAYER_SIZE);
        for page in every_page().into_iter().filter(|p| !matches!(p, PlayerPage::Player { .. })) {
            assert_eq!(page.server_flag(), "--server", "{page:?}");
            assert_eq!(page.size(), WIZARD_SIZE, "{page:?}");
        }
        // The GUI's floor is 100×24 (src/gui/mod.rs MIN_W/MIN_H in the
        // player repo): under it the player draws a "make the terminal
        // larger" line instead of a layout, and no terminal we open can be
        // told a minimum — the initial size is the only lever we hold.
        assert!(PLAYER_SIZE.0 >= 100 && PLAYER_SIZE.1 >= 24, "{PLAYER_SIZE:?} is under the GUI's floor");
    }

    #[test]
    fn wt_invocation_opens_a_sized_new_window() {
        let words = |page: PlayerPage| -> Vec<String> {
            super::wt_invocation(&page, std::path::Path::new(r"C:\mStream\bin\mstream-player.exe"), "http://localhost:3000")
                .iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect()
        };
        // A new window (never a tab in the user's own Windows Terminal),
        // the page's size, then the player's own command line verbatim.
        assert_eq!(
            words(player()),
            ["-w", "new", "--size", "100,30", r"C:\mStream\bin\mstream-player.exe", "gui", "--bundled-server", "http://localhost:3000"]
        );
        assert_eq!(
            words(PlayerPage::Setup),
            ["-w", "new", "--size", "120,42", r"C:\mStream\bin\mstream-player.exe", "setup", "--server", "http://localhost:3000"]
        );
        assert_eq!(
            words(PlayerPage::QuickConnect)[4..],
            [r"C:\mStream\bin\mstream-player.exe", "qr", "--server", "http://localhost:3000"]
        );
    }

    #[test]
    fn the_player_page_carries_the_launchers_instance_lock() {
        let locked = PlayerPage::Player { instance_lock: Some("/Application Support/mStream/desktop-player.lock".into()), serve_port: None };
        assert_eq!(
            locked.instance_lock().map(|p| p.to_string_lossy().into_owned()).as_deref(),
            Some("/Application Support/mStream/desktop-player.lock")
        );
        assert_eq!(player().instance_lock(), None);
        for page in [PlayerPage::Setup, PlayerPage::QuickConnect] {
            assert_eq!(page.instance_lock(), None, "{page:?}");
        }
        // The pair rides between the page's own words and the server flag,
        // quoted like every other path on the sh line…
        #[cfg(unix)]
        {
            assert_eq!(
                super::player_shell_words(&locked, std::path::Path::new("/p"), "http://x:1"),
                "'/p' gui --instance-lock '/Application Support/mStream/desktop-player.lock' --bundled-server 'http://x:1'"
            );
        }
        // …and as its own argv elements for wt.exe.
        let page = PlayerPage::Player { instance_lock: Some(r"C:\Users\me\AppData\Local\mStream\desktop-player.lock".into()), serve_port: None };
        let wt: Vec<String> = super::wt_invocation(&page, std::path::Path::new(r"C:\m\p.exe"), "http://x:1")
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            wt[4..],
            [r"C:\m\p.exe", "gui", "--instance-lock", r"C:\Users\me\AppData\Local\mStream\desktop-player.lock", "--bundled-server", "http://x:1"]
        );
    }

    #[test]
    fn the_player_page_carries_the_control_faces_port() {
        let faced = PlayerPage::Player { instance_lock: Some("/d/desktop-player.lock".into()), serve_port: Some(3333) };
        assert_eq!(faced.serve_port(), Some(3333));
        assert_eq!(player().serve_port(), None);
        for page in [PlayerPage::Setup, PlayerPage::QuickConnect] {
            assert_eq!(page.serve_port(), None, "{page:?}");
        }
        // After the lock pair, before the server flag — on the sh line…
        #[cfg(unix)]
        assert_eq!(
            super::player_shell_words(&faced, std::path::Path::new("/p"), "http://x:1"),
            "'/p' gui --instance-lock '/d/desktop-player.lock' --serve-port 3333 --bundled-server 'http://x:1'"
        );
        // …and as argv elements for wt.exe. The two pairs are independent
        // (no release has one without the other, but the page does not
        // know that).
        let faced_only = PlayerPage::Player { instance_lock: None, serve_port: Some(4444) };
        let wt: Vec<String> = super::wt_invocation(&faced_only, std::path::Path::new(r"C:\m\p.exe"), "http://x:1")
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(wt[4..], [r"C:\m\p.exe", "gui", "--serve-port", "4444", "--bundled-server", "http://x:1"]);
    }

    #[test]
    fn the_focus_search_skips_tool_and_no_activate_windows() {
        use super::{is_app_window, EX_NOACTIVATE, EX_TOOLWINDOW};
        const WINDOWEDGE: u32 = 0x0000_0100;
        const ACCEPTFILES: u32 = 0x0000_0010;
        const APPWINDOW: u32 = 0x0004_0000;
        const TRANSPARENT: u32 = 0x0000_0020;
        const LAYERED: u32 = 0x0008_0000;
        // An ordinary app window (the player's own, minimised or not:
        // IsWindowVisible stays true for a minimised window).
        assert!(is_app_window(true, false, 0));
        assert!(is_app_window(true, false, WINDOWEDGE | ACCEPTFILES | APPWINDOW), "the player's own window");
        // winit's "Winit Thread Event Target": visible, unowned, and both.
        let helper = EX_NOACTIVATE | TRANSPARENT | LAYERED | EX_TOOLWINDOW;
        assert!(!is_app_window(true, false, helper), "winit's thread helper");
        assert!(!is_app_window(true, false, EX_TOOLWINDOW), "a tool window alone");
        assert!(!is_app_window(true, false, EX_NOACTIVATE), "a no-activate window alone");
        // APPWINDOW does not rescue a tool window (nor does the shell).
        assert!(!is_app_window(true, false, EX_TOOLWINDOW | APPWINDOW));
        assert!(!is_app_window(false, false, 0), "a hidden window");
        assert!(!is_app_window(true, true, 0), "an owned window: a dialog");
    }

    #[cfg(windows)]
    #[test]
    fn the_spelled_out_styles_are_windows_sys_values() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW};
        assert_eq!(super::EX_TOOLWINDOW, WS_EX_TOOLWINDOW);
        assert_eq!(super::EX_NOACTIVATE, WS_EX_NOACTIVATE);
    }

    #[test]
    fn the_mac_focus_plan_activates_only_what_is_ours() {
        use super::MacFocus;
        // The desktop build in its own window: the player itself, by pid.
        assert_eq!(super::mac_focus_plan("window"), MacFocus::Window);
        assert_eq!(super::mac_focus_plan("apple-terminal"), MacFocus::Terminal);
        // A Ghostty host is the user's own Ghostty (the bundled one left
        // with player v0.12.0): `open -a` on one that is not running would
        // launch it, so nothing is activated.
        assert!(matches!(super::mac_focus_plan("ghostty"), MacFocus::Nothing(_)));
        for other in ["iterm", "windows-terminal", "conhost", "unknown", "", "windows", "window-terminal"] {
            assert!(matches!(super::mac_focus_plan(other), MacFocus::Nothing(_)), "{other}");
        }
    }

    #[test]
    fn the_window_route_passes_the_terminal_routes_values_plus_window() {
        let page = PlayerPage::Player { instance_lock: Some("/Application Support/mStream/desktop-player.lock".into()), serve_port: Some(3333) };
        let argv = |window: bool| -> Vec<String> {
            super::player_argv(&page, "http://localhost:3000", window).iter().map(|a| a.to_string_lossy().into_owned()).collect()
        };
        // The terminal route's argv, the one every terminal host runs.
        assert_eq!(
            argv(false),
            ["gui", "--instance-lock", "/Application Support/mStream/desktop-player.lock", "--serve-port", "3333", "--bundled-server", "http://localhost:3000"]
        );
        // The window route: the same values, `--window` right after `gui`.
        assert_eq!(
            argv(true),
            ["gui", "--window", "--instance-lock", "/Application Support/mStream/desktop-player.lock", "--serve-port", "3333", "--bundled-server", "http://localhost:3000"]
        );
        let mut without: Vec<String> = argv(true);
        without.retain(|w| w != "--window");
        assert_eq!(without, argv(false), "--window is the only difference");
        // A player without the lock or the face: still just --window more.
        let bare = PlayerPage::Player { instance_lock: None, serve_port: None };
        let words: Vec<String> = super::player_argv(&bare, "http://x:1", true).iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(words, ["gui", "--window", "--bundled-server", "http://x:1"]);
        // The sh line still quotes exactly the data words (the lock, the
        // URL) and is built from the same list.
        #[cfg(unix)]
        assert_eq!(
            super::player_shell_words(&page, std::path::Path::new("/p"), "http://localhost:3000"),
            "'/p' gui --instance-lock '/Application Support/mStream/desktop-player.lock' --serve-port 3333 --bundled-server 'http://localhost:3000'"
        );
        // The wizard and Quick Connect take the same route once the player
        // says `window-pages`: `--window` after the page's own word, the
        // terminal route's `--server <url>`, and never a lock or a port —
        // a page holds no instance lock and hosts no control face.
        let url = "http://localhost:3000";
        let page_argv = |page: &PlayerPage, window: bool| -> Vec<String> {
            super::player_argv(page, url, window).iter().map(|a| a.to_string_lossy().into_owned()).collect()
        };
        assert_eq!(page_argv(&PlayerPage::Setup, true), ["setup", "--window", "--server", url]);
        assert_eq!(page_argv(&PlayerPage::QuickConnect, true), ["qr", "--window", "--server", url]);
        assert_eq!(page_argv(&PlayerPage::Setup, false), ["setup", "--server", url], "the terminal route's argv");
        assert_eq!(page_argv(&PlayerPage::QuickConnect, false), ["qr", "--server", url], "the terminal route's argv");
        for page in [PlayerPage::Setup, PlayerPage::QuickConnect] {
            let words = page_argv(&page, true);
            assert!(!words.iter().any(|w| w == "--instance-lock" || w == "--serve-port" || w == "--bundled-server"), "{page:?}: {words:?}");
            let mut without = words.clone();
            without.retain(|w| w != "--window");
            assert_eq!(without, page_argv(&page, false), "{page:?}: --window is the only difference");
        }
    }

    #[test]
    fn the_window_route_needs_a_display_only_on_linux() {
        use std::ffi::OsString;
        let none = |_: &str| -> Option<OsString> { None };
        assert!(super::display_available_on("macos", none));
        assert!(super::display_available_on("windows", none));
        assert!(!super::display_available_on("linux", none), "a headless Linux session goes the terminal way");
        let only = |key: &'static str, val: &'static str| move |name: &str| (name == key).then(|| OsString::from(val));
        assert!(super::display_available_on("linux", only("DISPLAY", ":0")));
        assert!(super::display_available_on("linux", only("WAYLAND_DISPLAY", "wayland-0")));
        assert!(!super::display_available_on("linux", only("DISPLAY", "")), "empty means unset");
        assert!(!super::display_available_on("freebsd", only("XDG_SESSION_TYPE", "x11")));
    }

    #[test]
    fn the_window_routes_spawn_flags() {
        // Windows: no console window, a process group of its own — and
        // never DETACHED_PROCESS: the desktop exe is console-subsystem and
        // its CLI half expects a console handle.
        assert_eq!(super::CREATE_NO_WINDOW, 0x0800_0000);
        assert_eq!(super::CREATE_NEW_PROCESS_GROUP, 0x0000_0200);
        assert_eq!(super::WINDOW_CREATION_FLAGS, 0x0800_0200);
        assert_eq!(super::WINDOW_CREATION_FLAGS & super::DETACHED_PROCESS, 0);
        // Unix: process_group(0) — a new group led by the child.
        assert_eq!(super::WINDOW_PROCESS_GROUP, 0);
    }

    #[cfg(unix)]
    #[test]
    fn the_window_route_spawns_detached_into_its_log() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("mstream-launcher-window-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // A stand-in that reports its argv, its stdin and its process group
        // on stdout and stderr, then exits 3 (no window).
        let stub = dir.join("mstream-player");
        std::fs::write(
            &stub,
            "#!/bin/sh\necho \"argv: $*\"\nif read line; then echo \"stdin: $line\"; else echo 'stdin: eof'; fi\necho \"pgid: $(ps -o pgid= -p $$ | tr -d ' ')\" >&2\nexit 3\n",
        )
        .unwrap();
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
        let log = dir.join("desktop-player.log");
        std::fs::write(&log, "a previous session's output\n").unwrap();
        let page = PlayerPage::Player { instance_lock: Some(dir.join("desktop-player.lock")), serve_port: Some(3333) };
        let mut child = super::spawn_player_window(&stub, "http://localhost:3000", &page, &log).unwrap();
        let pid = child.id();
        let status = child.wait().unwrap();
        assert_eq!(status.code(), Some(3));
        let out = std::fs::read_to_string(&log).unwrap();
        assert!(!out.contains("previous session"), "the file is truncated per open: {out}");
        assert!(
            out.contains(&format!(
                "argv: gui --window --instance-lock {} --serve-port 3333 --bundled-server http://localhost:3000",
                dir.join("desktop-player.lock").display()
            )),
            "{out}"
        );
        assert!(out.contains("stdin: eof"), "stdin is null: {out}");
        assert!(out.contains(&format!("pgid: {pid}")), "the child leads a process group of its own: {out}");
        // A binary that cannot be spawned is an Err, never a panic.
        assert!(super::spawn_player_window(&dir.join("missing"), "http://x:1", &page, &log).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn unix_launches_share_one_quoted_command_line() {
        let player = std::path::Path::new("/Application Support/bin/mstream-player");
        assert_eq!(
            super::player_shell_words(&PlayerPage::Setup, player, "http://localhost:3000"),
            "'/Application Support/bin/mstream-player' setup --server 'http://localhost:3000'"
        );
        assert_eq!(
            super::player_shell_words(&PlayerPage::QuickConnect, player, "http://x:1"),
            "'/Application Support/bin/mstream-player' qr --server 'http://x:1'"
        );
        // The desktop player names the server as its bundled one.
        assert_eq!(
            super::player_shell_words(&PlayerPage::Player { instance_lock: None, serve_port: None }, player, "http://localhost:3000"),
            "'/Application Support/bin/mstream-player' gui --bundled-server 'http://localhost:3000'"
        );
        // A quote inside a path survives as the POSIX '\'' dance.
        let odd = std::path::Path::new("/it's/player");
        let words = super::player_shell_words(&PlayerPage::QuickConnect, odd, "http://x:1");
        assert!(words.starts_with("'/it'\\''s/player' qr "), "{words}");
    }

    #[test]
    #[ignore = "spawns a real terminal window - run manually with --ignored"]
    fn manual_open_player_terminal() {
        // MSTREAM_DEMO_PLAYER = a real player binary; MSTREAM_DEMO_SERVER =
        // the URL to point it at; MSTREAM_DEMO_PAGE = setup (default), qr or
        // gui (the desktop player).
        let player = std::path::PathBuf::from(std::env::var("MSTREAM_DEMO_PLAYER").expect("set MSTREAM_DEMO_PLAYER"));
        let url = std::env::var("MSTREAM_DEMO_SERVER").unwrap_or_else(|_| "http://localhost:3000".into());
        let dir = std::env::temp_dir().join("mstream-page-demo");
        std::fs::create_dir_all(&dir).unwrap();
        let page = match std::env::var("MSTREAM_DEMO_PAGE").as_deref() {
            Ok("qr") => PlayerPage::QuickConnect,
            Ok("gui") => PlayerPage::Player { instance_lock: None, serve_port: None },
            _ => PlayerPage::Setup,
        };
        let label = format!("{page:?}");
        let via = super::open_player_terminal(&player, &url, &dir, page).unwrap();
        eprintln!("opened {label} via {via}");
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[test]
    fn the_control_key_is_read_without_a_click() {
        // The message is sent by name, so the call itself is what this
        // pins: a wrong class, selector or return type panics here in a
        // debug build (objc2 checks the encoding), not at a user's click.
        // The value is whatever the keyboard says, so it is not asserted.
        let _ = super::control_key_held();
    }

    #[test]
    fn each_page_writes_its_own_command_script() {
        // Distinct script files: no two tray items may clobber each
        // other's .command while both windows are open.
        let pages = [super::PlayerPage::Setup, super::PlayerPage::QuickConnect, super::PlayerPage::Player { instance_lock: None, serve_port: None }];
        let names: Vec<String> = pages.iter().map(|p| p.script_name()).collect();
        for (i, a) in names.iter().enumerate() {
            assert!(a.ends_with(".command"), "{a}");
            for b in &names[i + 1..] {
                assert_ne!(a, b);
            }
        }
        assert_eq!(super::PlayerPage::QuickConnect.script_name(), "quickconnect-mstream.command");
        assert_eq!(super::PlayerPage::Player { instance_lock: None, serve_port: None }.script_name(), "player-mstream.command");
    }

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
