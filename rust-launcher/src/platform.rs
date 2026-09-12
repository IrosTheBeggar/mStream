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

/// One of the terminal player's admin rooms — `mstream-player admin <room>`,
/// the server's management screens drawn in a terminal (player PR #21;
/// pin v0.7.0 is the first with all five plus the in-room sign-in).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdminRoom {
    /// The server's music folders.
    Libraries,
    /// The discovery network (P2P): the mesh, follows, invites, settings.
    Discovery,
    /// Federation: requests, minted tickets, readable peers.
    Federation,
    /// Backups: each library's copies elsewhere, schedules, runs.
    Backups,
    /// Torrents: the client, its list, per-library paths, seeding.
    Torrents,
}

impl AdminRoom {
    /// Menu order — the player's own `admin` help order.
    pub const ALL: [AdminRoom; 5] = [
        AdminRoom::Libraries,
        AdminRoom::Discovery,
        AdminRoom::Federation,
        AdminRoom::Backups,
        AdminRoom::Torrents,
    ];

    /// The room's name in the player's CLI (`mstream-player admin <this>`).
    pub fn subcommand(self) -> &'static str {
        match self {
            AdminRoom::Libraries => "libraries",
            AdminRoom::Discovery => "discovery",
            AdminRoom::Federation => "federation",
            AdminRoom::Backups => "backups",
            AdminRoom::Torrents => "torrents",
        }
    }

    /// The inverse of [`AdminRoom::subcommand`].
    pub fn from_subcommand(name: &str) -> Option<AdminRoom> {
        AdminRoom::ALL.into_iter().find(|r| r.subcommand() == name)
    }
}

/// Which player page a terminal launch opens. Each carries its own argv,
/// window title, and scratch script name, so no two tray items ever clobber
/// each other's launch files.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlayerPage {
    /// The full first-run wizard (`mstream-player setup`).
    Setup,
    /// The standalone Quick Connect page (`mstream-player qr`) — the
    /// wizard's Done screen: pairing QR plus the app buttons.
    QuickConnect,
    /// One admin room (`mstream-player admin <room> --same-machine`). The
    /// launcher only ever runs on the server's own machine, so the rooms'
    /// folder pickers may open the OS dialog and treat what it picks as the
    /// server's paths — exactly what `--same-machine` declares.
    Admin(AdminRoom),
}

impl PlayerPage {
    /// The player's argv for this page, before the `--server <url>` every
    /// launch appends. Static words only: nothing here ever needs quoting.
    fn args(self) -> Vec<&'static str> {
        match self {
            PlayerPage::Setup => vec!["setup"],
            PlayerPage::QuickConnect => vec!["qr"],
            PlayerPage::Admin(room) => vec!["admin", room.subcommand(), "--same-machine"],
        }
    }
    // Only the mac ghostty config (and this file's tests) call this; allow,
    // not cfg, keeps the enum's surface uniform across platforms.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn title(self) -> String {
        match self {
            PlayerPage::Setup => "mStream Setup".into(),
            PlayerPage::QuickConnect => "mStream Quick Connect".into(),
            PlayerPage::Admin(room) => format!("mStream {}", capitalized(room.subcommand())),
        }
    }
    #[cfg(target_os = "macos")]
    fn script_name(self) -> String {
        match self {
            PlayerPage::Setup => "setup-mstream.command".into(),
            PlayerPage::QuickConnect => "quickconnect-mstream.command".into(),
            PlayerPage::Admin(room) => format!("admin-{}-mstream.command", room.subcommand()),
        }
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn capitalized(word: &str) -> String {
    let mut c = word.chars();
    match c.next() {
        Some(first) => first.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// Run one of the terminal player's pages — the setup wizard, Quick
/// Connect, or an admin room — in a fresh terminal window, pointed at this
/// launcher's server. Same per-OS "what is a terminal" seams as
/// open_logs_terminal; the caller logs a failure — a missing terminal
/// emulator must never take the tray down. Ok carries WHICH surface opened
/// (support surface: "it opened in Terminal, not the mStream console —
/// why?" should be one log line away).
///
/// `console`: the bundled Ghostty (macOS bundles only, resolved by
/// paths::find_console_app) — preferred over Terminal.app because Apple's
/// terminal has no pixel protocol at all, so the wizard's wordmark and QR
/// degrade to character art there. Ignored on the other platforms.
pub fn open_player_terminal(
    player_bin: &std::path::Path,
    server_url: &str,
    scratch_dir: &std::path::Path,
    console: Option<&crate::paths::ConsoleLaunch>,
    page: PlayerPage,
) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut console_note = String::new();
        if let Some(c) = console {
            match spawn_ghostty_page(c, player_bin, server_url, scratch_dir, page) {
                Ok(()) => return Ok("bundled Ghostty console".into()),
                // A broken bundled console must degrade to Terminal.app, not
                // dead-end the button — but the reason rides along.
                Err(e) => console_note = format!(" (bundled console failed: {e})"),
            }
        }
        // Terminal.app opens an executable .command file as a document — no
        // AppleEvents automation consent (see open_logs_terminal). The CSI 8
        // resize asks for the window the wizard's two-column pages were
        // designed around; Terminal.app honors it, and a terminal that
        // doesn't just keeps its size (the wizard reflows).
        let script = scratch_dir.join(page.script_name());
        let body = format!(
            "#!/bin/sh\n# Written by mStream's tray - safe to delete.\nprintf '\\033[8;42;120t'\nclear\nexec {}\n",
            player_shell_words(page, player_bin, server_url),
        );
        std::fs::write(&script, body).map_err(|e| format!("write {}: {e}", script.display()))?;
        let _ = std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755));
        std::process::Command::new("/usr/bin/open")
            .arg(&script)
            .spawn()
            .map(|_| format!("Terminal.app{console_note}"))
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
        let _ = console;
        if std::process::Command::new("wt.exe")
            .arg(player_bin)
            .args(page.args())
            .args(["--server", server_url])
            .spawn()
            .is_ok()
        {
            return Ok("wt.exe".into());
        }
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        std::process::Command::new(player_bin)
            .args(page.args())
            .args(["--server", server_url])
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map(|_| "conhost fallback".into())
            .map_err(|e| format!("spawn {}: {e}", player_bin.display()))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = (scratch_dir, console); // no script file / no bundled console here
        // No `exec`: the shell stays the window's parent, so a page that
        // dies at once (a missing libasound, a bad binary) leaves its error
        // on screen behind a "press Enter" instead of a window that flashed
        // and vanished — the support surface for "nothing happened".
        let cmd = format!(
            "{}; s=$?; if [ \"$s\" -ne 0 ]; then printf '\\nmstream-player exited with status %s - press Enter to close this window\\n' \"$s\"; read dummy; fi",
            player_shell_words(page, player_bin, server_url),
        );
        let candidates =
            linux_terminal::candidates(&cmd, Some(linux_terminal::WIZARD_SIZE), linux_terminal::on_wayland());
        linux_terminal::spawn_first_alive(&candidates)
    }
}

/// Write the config and launch the bundled Ghostty console running the
/// wizard. Everything rides in the CONFIG FILE, never `-e`: Ghostty confirms
/// argument-passed commands with an "Allow Ghostty to execute…" dialog (its
/// anti-injection guard) but treats config-declared commands as user-trusted
/// and prompts for nothing (probed 2026-08-24, player PLAN.md Phase 8).
/// XDG_CONFIG_HOME is scoped to the spawn, so a user's own Ghostty install
/// keeps its own configuration untouched.
#[cfg(target_os = "macos")]
fn spawn_ghostty_page(
    console: &crate::paths::ConsoleLaunch,
    player_bin: &std::path::Path,
    server_url: &str,
    scratch_dir: &std::path::Path,
    page: WizardPage,
) -> Result<(), String> {
    let bin = console.ghostty_app.join("Contents").join("MacOS").join("ghostty");
    if !bin.exists() {
        return Err(format!("no ghostty binary at {}", bin.display()));
    }
    let cfg_home = scratch_dir.join("console-config");
    let cfg_dir = cfg_home.join("ghostty");
    std::fs::create_dir_all(&cfg_dir).map_err(|e| format!("mkdir {}: {e}", cfg_dir.display()))?;
    let cfg = cfg_dir.join("config");
    std::fs::write(&cfg, ghostty_page_config(console, player_bin, server_url, page))
        .map_err(|e| format!("write {}: {e}", cfg.display()))?;
    std::process::Command::new(&bin)
        .env("XDG_CONFIG_HOME", &cfg_home)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("spawn {}: {e}", bin.display()))
}

/// The console's config, regenerated on every click so it always reflects
/// this build's idea of the paths. `command` uses the explicit `shell:`
/// prefix — the value runs via `/bin/sh -c`, so the sh-quoting handles the
/// "Application Support" spaces every managed install has.
/// `quit-after-last-window-closed` keeps the console from lingering in the
/// Dock as a windowless app after the wizard exits; `macos-icon = custom`
/// puts the mStream mark on that Dock tile while it lives.
#[cfg(target_os = "macos")]
fn ghostty_page_config(
    console: &crate::paths::ConsoleLaunch,
    player_bin: &std::path::Path,
    server_url: &str,
    page: WizardPage,
) -> String {
    let mut body = format!(
        "# Written by mStream's tray - safe to delete.\n\
         auto-update = off\n\
         title = {title}\n\
         window-width = 120\n\
         window-height = 42\n\
         confirm-close-surface = false\n\
         quit-after-last-window-closed = true\n",
        title = page.title(),
    );
    if let Some(icns) = &console.icon_icns {
        // Config values run to end of line — a spaced path needs no quoting.
        body.push_str(&format!("macos-icon = custom\nmacos-custom-icon = {}\n", icns.display()));
    }
    body.push_str(&format!("command = shell:{}\n", player_shell_words(page, player_bin, server_url)));
    body
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

    /// Columns × rows the wizard pages ask for, where an emulator's CLI can
    /// take a size: the VTE family opens 80×24 by default, which cannot
    /// hold the pairing QR drawn in half-blocks (77×39 cells), and the
    /// XTWINOPS resize the macOS .command script sends is ignored by VTE,
    /// kitty and stock xterm alike. The same window the mac Ghostty config
    /// asks for.
    pub const WIZARD_SIZE: (u16, u16) = (120, 42);

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
    /// `size` rides only where the CLI takes one (the rest open at their
    /// default and the pages reflow); `wayland` admits foot, which cannot
    /// run without a Wayland socket.
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
    use super::linux_terminal::{candidates, spawn_first_alive, WIZARD_SIZE};

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
/// `'<player>' <page args…> --server '<url>'` — shared by the macOS
/// .command script, the bundled-console config and the Linux chain, so all
/// three agree on the argv and its quoting.
#[cfg(unix)]
fn player_shell_words(page: PlayerPage, player_bin: &std::path::Path, server_url: &str) -> String {
    let mut words = vec![sh_quote(player_bin)];
    words.extend(page.args().into_iter().map(String::from));
    words.push("--server".into());
    words.push(sh_quote_str(server_url));
    words.join(" ")
}

#[cfg(test)]
mod page_tests {
    use super::{AdminRoom, PlayerPage};

    fn every_page() -> Vec<PlayerPage> {
        let mut pages = vec![PlayerPage::Setup, PlayerPage::QuickConnect];
        pages.extend(AdminRoom::ALL.into_iter().map(PlayerPage::Admin));
        pages
    }

    #[test]
    fn each_page_maps_to_its_own_argv_and_title() {
        assert_eq!(PlayerPage::Setup.args(), ["setup"]);
        assert_eq!(PlayerPage::QuickConnect.args(), ["qr"]);
        // A room always declares --same-machine: the launcher IS the
        // server's machine, so the room's folder picker may use the OS
        // dialog and hand the server the paths it picks.
        assert_eq!(
            PlayerPage::Admin(AdminRoom::Libraries).args(),
            ["admin", "libraries", "--same-machine"]
        );
        assert_eq!(PlayerPage::Admin(AdminRoom::Torrents).args(), ["admin", "torrents", "--same-machine"]);
        assert_eq!(PlayerPage::Setup.title(), "mStream Setup");
        assert_eq!(PlayerPage::QuickConnect.title(), "mStream Quick Connect");
        assert_eq!(PlayerPage::Admin(AdminRoom::Discovery).title(), "mStream Discovery");
        // Seven pages, seven argvs, seven titles: no two tray items may
        // open the same thing or the same-named window.
        let pages = every_page();
        for (i, a) in pages.iter().enumerate() {
            for b in &pages[i + 1..] {
                assert_ne!(a.args(), b.args(), "{a:?} vs {b:?}");
                assert_ne!(a.title(), b.title(), "{a:?} vs {b:?}");
            }
        }
    }

    #[test]
    fn rooms_round_trip_through_their_cli_names() {
        for room in AdminRoom::ALL {
            assert_eq!(AdminRoom::from_subcommand(room.subcommand()), Some(room));
        }
        assert_eq!(AdminRoom::from_subcommand("setup"), None);
        assert_eq!(AdminRoom::from_subcommand("Libraries"), None, "the CLI names are lowercase");
        assert_eq!(AdminRoom::from_subcommand(""), None);
    }

    #[cfg(unix)]
    #[test]
    fn unix_launches_share_one_quoted_command_line() {
        let player = std::path::Path::new("/Application Support/bin/mstream-player");
        assert_eq!(
            super::player_shell_words(PlayerPage::Setup, player, "http://localhost:3000"),
            "'/Application Support/bin/mstream-player' setup --server 'http://localhost:3000'"
        );
        assert_eq!(
            super::player_shell_words(PlayerPage::Admin(AdminRoom::Backups), player, "http://x:1"),
            "'/Application Support/bin/mstream-player' admin backups --same-machine --server 'http://x:1'"
        );
        // A quote inside a path survives as the POSIX '\'' dance.
        let odd = std::path::Path::new("/it's/player");
        let words = super::player_shell_words(PlayerPage::QuickConnect, odd, "http://x:1");
        assert!(words.starts_with("'/it'\\''s/player' qr "), "{words}");
    }

    #[test]
    #[ignore = "spawns a real terminal window - run manually with --ignored"]
    fn manual_open_player_terminal() {
        // MSTREAM_DEMO_PLAYER = a real player binary; MSTREAM_DEMO_SERVER =
        // the URL to point it at; MSTREAM_DEMO_PAGE = setup (default), qr,
        // or a room name (libraries, discovery, federation, backups,
        // torrents); on macOS MSTREAM_DEMO_CONSOLE = optionally a Ghostty.app
        // to prefer (with MSTREAM_DEMO_ICNS for the Dock icon).
        let player = std::path::PathBuf::from(std::env::var("MSTREAM_DEMO_PLAYER").expect("set MSTREAM_DEMO_PLAYER"));
        let url = std::env::var("MSTREAM_DEMO_SERVER").unwrap_or_else(|_| "http://localhost:3000".into());
        let console = std::env::var("MSTREAM_DEMO_CONSOLE").ok().map(|app| crate::paths::ConsoleLaunch {
            ghostty_app: std::path::PathBuf::from(app),
            icon_icns: std::env::var("MSTREAM_DEMO_ICNS").ok().map(std::path::PathBuf::from),
        });
        let dir = std::env::temp_dir().join("mstream-page-demo");
        std::fs::create_dir_all(&dir).unwrap();
        let page = match std::env::var("MSTREAM_DEMO_PAGE").as_deref() {
            Ok("qr") => PlayerPage::QuickConnect,
            Ok(name) => AdminRoom::from_subcommand(name).map(PlayerPage::Admin).unwrap_or(PlayerPage::Setup),
            Err(_) => PlayerPage::Setup,
        };
        let via = super::open_player_terminal(&player, &url, &dir, console.as_ref(), page).unwrap();
        eprintln!("opened {page:?} via {via}");
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[test]
    fn ghostty_config_quotes_spaced_paths_and_never_uses_dash_e() {
        let c = crate::paths::ConsoleLaunch {
            ghostty_app: "/tmp/x/Ghostty.app".into(),
            icon_icns: Some("/App Root/Resources/mStream.icns".into()),
        };
        let cfg = super::ghostty_page_config(
            &c,
            std::path::Path::new("/Application Support/bin/mstream-player"),
            "http://localhost:3000",
            super::PlayerPage::Setup,
        );
        // shell: + sh-quoting is what survives "Application Support" spaces;
        // the command must live in the CONFIG, never a -e argument (consent
        // dialog).
        assert!(
            cfg.contains("command = shell:'/Application Support/bin/mstream-player' setup --server 'http://localhost:3000'"),
            "{cfg}"
        );
        // Config values run to end of line — the spaced icns path rides raw.
        assert!(cfg.contains("macos-custom-icon = /App Root/Resources/mStream.icns\n"), "{cfg}");
        assert!(cfg.contains("macos-icon = custom\n"), "{cfg}");
        assert!(cfg.contains("auto-update = off\n"), "{cfg}");
        assert!(cfg.contains("quit-after-last-window-closed = true\n"), "{cfg}");

        let plain = crate::paths::ConsoleLaunch { ghostty_app: "/t/G.app".into(), icon_icns: None };
        let cfg2 = super::ghostty_page_config(&plain, std::path::Path::new("/p"), "http://x:1", super::PlayerPage::Setup);
        assert!(!cfg2.contains("macos-icon"), "no icns means Ghostty keeps its own icon: {cfg2}");

        // The Quick Connect page: same machinery, its own subcommand + title.
        let qc = super::ghostty_page_config(&plain, std::path::Path::new("/p"), "http://x:1", super::PlayerPage::QuickConnect);
        assert!(qc.contains("command = shell:'/p' qr --server 'http://x:1'"), "{qc}");
        assert!(qc.contains("title = mStream Quick Connect\n"), "{qc}");

        // An admin room: the same window, its own argv (with --same-machine)
        // and title.
        let room = super::PlayerPage::Admin(super::AdminRoom::Federation);
        let fed = super::ghostty_page_config(&plain, std::path::Path::new("/p"), "http://x:1", room);
        assert!(fed.contains("command = shell:'/p' admin federation --same-machine --server 'http://x:1'"), "{fed}");
        assert!(fed.contains("title = mStream Federation\n"), "{fed}");
    }

    #[test]
    fn each_page_writes_its_own_command_script() {
        // Distinct script files: no two tray items may clobber each
        // other's .command while both windows are open.
        let mut pages = vec![super::PlayerPage::Setup, super::PlayerPage::QuickConnect];
        pages.extend(super::AdminRoom::ALL.into_iter().map(super::PlayerPage::Admin));
        let names: Vec<String> = pages.iter().map(|p| p.script_name()).collect();
        for (i, a) in names.iter().enumerate() {
            assert!(a.ends_with(".command"), "{a}");
            for b in &names[i + 1..] {
                assert_ne!(a, b);
            }
        }
        assert_eq!(super::PlayerPage::Admin(super::AdminRoom::Libraries).script_name(), "admin-libraries-mstream.command");
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
