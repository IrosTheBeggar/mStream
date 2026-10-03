// The desktop face: single-instance guard, autostart default, server spawn,
// tray icon + menu, and the event loop that ties them together.
//
// Threading model: tao's event loop owns the main thread (a hard requirement
// on macOS and for gtk). Two helper threads exist per server generation — a
// health prober and an exit watcher — and both talk to the loop only through
// the EventLoopProxy. The server child lives in an Arc<Mutex<...>> shared
// with the watcher; a generation counter keeps a stale watcher (from before
// a restart) from reporting the new child's state.
use crate::{autostart, paths, platform, rollback, server, LauncherArgs};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};

const STOP_GRACE: Duration = Duration::from_secs(8);
const BOOT_TIMEOUT: Duration = Duration::from_secs(60);
/// Spawns a crash-before-serving server gets before the boot watchdog steps
/// in: the second attempt absorbs transient causes (a port released late, a
/// filesystem hiccup) so a rollback is only ever answered to a REPEATED
/// boot failure.
const MAX_BOOT_ATTEMPTS: u32 = 2;
/// How long a `--takeover` relaunch retries the single-instance lock: the
/// old launcher holds it for at most its own stop_current (STOP_GRACE) plus
/// process teardown, so this only needs to comfortably exceed that.
const TAKEOVER_LOCK_PATIENCE: Duration = Duration::from_secs(12);
/// Where a click on a non-actionable "update available" lands. Hardcoded on
/// purpose: the status file is another process's data and never supplies a
/// URL the launcher would open. Its downloadUrl is compared with the URL
/// the launcher builds, never opened (UpdateAction::DownloadInstaller).
const RELEASES_URL: &str = "https://github.com/IrosTheBeggar/mStream/releases/latest";
/// Where the browser fetches a release's own .pkg when the server has not
/// downloaded it (UpdateAction::DownloadInstaller) and no mirror is set:
/// the tag-pinned asset path update-check.js's assetUrl downloads from.
/// Hardcoded for the same reason as RELEASES_URL; pkg_download_url fills
/// in only a sanitized version and this build's CPU, and swaps this base
/// for the operator's own mirror when one is set, as assetUrl does.
const RELEASE_DOWNLOAD_BASE: &str = "https://github.com/IrosTheBeggar/mStream/releases/download";
/// The CPU half of this build's macOS asset names (darwin-arm64 /
/// darwin-x64), fixed at compile time like the bundle version: the .pkg a
/// Mac downloads is the one for the launcher already running there.
const THIS_PKG_CPU: &str = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
/// A left click on the tray icon this soon after the last one the launcher
/// acted on is ignored. A double click arrives as two clicks (on Windows:
/// down, up, dblclk, up), and the second would open the player again: a
/// player that takes the instance lock refuses it and the launcher
/// refocuses the first (harmless, but a second spawn and its log lines for
/// one gesture), and one that predates the lock would open a second
/// window. 500 ms is Windows' default double-click time, the longest gap
/// the system itself still counts as one gesture.
const TRAY_CLICK_DEBOUNCE: Duration = Duration::from_millis(500);

#[derive(Debug)]
enum AppEvent {
    Menu(String),
    /// A left click on the tray icon itself, reported on the button's
    /// release (macOS and Windows; Linux's appindicator reports no clicks —
    /// see the builder in StartCause::Init), with what it asks for
    /// (icon_click_of).
    TrayClick(IconClick),
    ServerUp(u64),
    /// The identity probe gave up (BOOT_TIMEOUT) while the child is still
    /// alive: a serving-but-unverifiable server (an SSL-terminated config,
    /// a bind the plaintext probe can't reach), not a boot failure.
    ProbeGaveUp(u64),
    ServerExited(u64),
    /// The status line's minute boundary, from the ticker thread — a
    /// generation-stamped user event, NOT a ControlFlow::WaitUntil timer:
    /// tao's gtk backend has no timer behind WaitUntil (run_return blocks in
    /// gtk::main_iteration_do(true) until some other event wakes the loop),
    /// so on Wayland the "one wake a minute" never came and the menu line
    /// went stale for hours; the X11 backend only appeared to work because
    /// its device thread woke the loop on mouse motion. A proxy event wakes
    /// all three backends identically.
    Tick(u64),
    /// The update-surface poll, from its own always-running thread —
    /// deliberately NOT tied to a server generation: a server that never
    /// came up (or a restart whose spawn failed) has no ticker, and the
    /// update menu line must keep tracking the status file regardless.
    UpdatePoll,
}

struct Shared {
    proc: Mutex<Option<server::ServerProc>>,
    generation: AtomicU64,
    quitting: AtomicBool,
}

pub fn run(args: LauncherArgs) -> ! {
    let data_home = paths::data_home();
    let logs_dir = data_home.join("logs");
    let _ = std::fs::create_dir_all(&logs_dir);
    let log_path = logs_dir.join("launcher.log");
    let log = Logger(log_path);

    // ── Locate the server binary FIRST: the config ladder's legacy/portable
    // rung anchors at the SERVER binary's directory (the server resolves
    // appRoot = dirname(process.execPath), src/util/boot-config.js), which
    // equals our own exe_dir only in the shipped sibling layout —
    // --server-bin/MSTREAM_SERVER_BIN break that on purpose, and anchoring
    // at the launcher would make the two sides resolve different configs.
    let bin = match paths::find_server_bin(args.server_bin.as_deref()) {
        Ok(b) => paths::absolutize(b),
        Err(e) => {
            log.line(&e);
            platform::fatal_alert(&format!("mStream could not start: {e}"));
            std::process::exit(1);
        }
    };
    let server_dir = bin.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
    let config = paths::resolve_config_path(&args.server_args, &server_dir);
    let ep = paths::read_endpoint(&config);
    // The terminal setup wizard the "Set up mStream" item runs — resolved
    // once, like the server binary: an install doesn't gain or lose its
    // bundled player mid-session.
    let player_bin = paths::find_player_bin(&bin, &data_home);
    // The desktop player behind "Open mStream Player": the same binary,
    // admitted only from the release that grew its `gui` face — one
    // `--version` probe, at boot, for the same reason. A bundle ships the
    // pinned player, so this only ever refuses a mismatched layout
    // (--server-bin against an older tree, a stale managed copy in the
    // data home); those get the web player, and the log says why once.
    // The same probe decides whether the player takes the instance lock
    // that keeps it to one window (paths::desktop_player_lock), and whether
    // its GUI hosts the control face the server adopts as its server-audio
    // engine — on the server's configured player port, always
    // (paths::rust_player_port).
    // The same run's second line says which build it is (paths::PlayerProbe):
    // a desktop build opens straight into a window of its own where this
    // session can show one, a terminal build in a terminal as before — and
    // a desktop build that names `window-pages` hosts the wizard and Quick
    // Connect in a window of its own too (open_player_page).
    let desktop_player = player_bin.as_deref().and_then(|p| match paths::player_probe(p) {
        Some(paths::PlayerProbe { version: v, desktop, pages }) if paths::player_has_gui(v) => {
            if desktop {
                log.line(&format!(
                    "player {} is a desktop build - the player item opens it in its own window{}{}",
                    paths::version_label(v),
                    if pages { ", as do Setup and Quick Connect (window-pages)" } else { "" },
                    if platform::window_display_available() { "" } else { " once there is a display (none in this session: the terminal route)" }
                ));
            }
            if !paths::player_has_control_face(v) {
                log.line(&format!(
                    "player {} has no control face (needs {}) - server audio keeps its headless engine while the player is open",
                    paths::version_label(v),
                    paths::version_label(paths::CONTROL_FACE_MIN_PLAYER_VERSION)
                ));
            }
            Some(DesktopPlayer {
                bin: p.to_path_buf(),
                instance_lock: paths::player_has_instance_lock(v).then(|| paths::desktop_player_lock(&data_home)),
                serve_port: paths::player_has_control_face(v).then(|| paths::rust_player_port(&config)),
                desktop,
                pages,
            })
        }
        Some(paths::PlayerProbe { version: v, .. }) => {
            log.line(&format!(
                "player {} predates the GUI (needs {}) - the player item opens the web player",
                paths::version_label(v),
                paths::version_label(paths::GUI_MIN_PLAYER_VERSION)
            ));
            None
        }
        None => {
            log.line("player binary did not answer --version - the player item opens the web player");
            None
        }
    });
    // ── Single instance: the lock lives in the data home, so two launchers
    // managing the same data/port exclude each other (two --portable
    // launchers in different folders are genuinely different servers and
    // don't). The loser's job is to bring the USER to the running server,
    // not to error out.
    let _ = std::fs::create_dir_all(&data_home);
    let lock_path = data_home.join("launcher.lock").to_string_lossy().into_owned();
    let mut lock = match fslock::LockFile::open(&lock_path) {
        Ok(l) => l,
        Err(e) => {
            log.line(&format!("cannot open launcher.lock: {e}"));
            platform::fatal_alert(&format!("mStream could not start: cannot open {lock_path}: {e}"));
            std::process::exit(1);
        }
    };
    let mut locked = lock.try_lock().unwrap_or(false);
    if !locked && args.takeover {
        // Apply-update handoff: the previous launcher spawned us and is in
        // its last milliseconds of teardown, still holding the lock. Wait it
        // out briefly instead of yielding to it.
        log.line("takeover: waiting for the previous launcher to release the lock");
        let deadline = Instant::now() + TAKEOVER_LOCK_PATIENCE;
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(250));
            if lock.try_lock().unwrap_or(false) {
                locked = true;
                break;
            }
        }
    }
    if !locked {
        log.line("another launcher instance holds the lock - focusing it and exiting");
        if args.player {
            // `--player` from a shortcut or a second launch: the running
            // launcher's server is the one to show, and the player is its
            // own process either way — nothing to ask the other instance.
            // An open player is brought forward, not doubled (its lock).
            let fallback = (!args.no_open).then(|| paths::browse_target(&config, &ep));
            // This process exits next: a window route's watch must settle
            // first, or its fallback (exit 3: the terminal route) and its
            // focus (exit 0) would die with us.
            if let Some(watch) = open_desktop_player(
                desktop_player.as_ref(),
                &paths::server_url(&ep),
                &data_home,
                fallback.as_deref(),
                &log,
            ) {
                watch.settle();
            }
        } else if !args.autostarted && !args.no_open && !args.takeover {
            // A plain second launch — the app icon clicked again on Windows
            // or Linux, where that starts a second process (macOS hands the
            // running app a reopen event instead: Event::Reopen) — means
            // "take me to mStream": the desktop player, brought forward
            // when it is already open, the web player where there is none.
            log.line("second launch - opening the desktop player");
            let fallback = paths::browse_target(&config, &ep);
            if let Some(watch) = open_desktop_player(
                desktop_player.as_ref(),
                &paths::server_url(&ep),
                &data_home,
                Some(&fallback),
                &log,
            ) {
                watch.settle();
            }
        }
        std::process::exit(0);
    }

    // ── The lock just proved every previous launcher session dead — the
    // one moment the ~/Applications asides (trees an upgrade moved aside
    // for a then-running app) are provably reclaimable. Without this,
    // always-on tray users leak one full .app copy per release: the
    // installer's own sweep only runs when nothing runs from the copy,
    // which for them is never.
    #[cfg(target_os = "macos")]
    sweep_apps_asides(&log);

    // ── Headless Linux (ssh without -t, cron, a misused systemd unit):
    // tao's event-loop build would die inside gtk's initializer with a raw
    // panic — before any of our diagnostics, and with nothing in the log.
    // Fail it ourselves instead, logged and explained. (xvfb and real
    // sessions both set DISPLAY/WAYLAND_DISPLAY; headless boxes run
    // mstream-server directly, as install.md says.)
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let has_display = ["DISPLAY", "WAYLAND_DISPLAY"]
            .iter()
            .any(|v| std::env::var_os(v).is_some_and(|s| !s.is_empty()));
        if !has_display {
            log.line("no DISPLAY/WAYLAND_DISPLAY - the desktop face needs a graphical session");
            platform::fatal_alert(
                "mstream-desktop needs a graphical session (no DISPLAY or WAYLAND_DISPLAY is set).\nOn a headless machine, run mstream-server instead.",
            );
            std::process::exit(1);
        }
    }

    // ── Autostart default (on) — configured once, then the user's choice
    // rules. An --autostarted run is by definition already configured.
    if !args.autostarted {
        autostart::ensure_default_on();
    }

    // ── Bounded logs. An always-on login item appends forever, and the
    // server-console capture (full stdout+stderr: request logs, scan
    // progress) has no other ceiling — a year of daily sessions quietly
    // accretes hundreds of MB. Policy: server-console.log starts fresh
    // every launcher session (previous session kept as .1 for diagnosis;
    // in-session Restart keeps appending so evidence survives a crash
    // loop); launcher.log is a low-volume narrative, rotated only past a
    // size cap. Rotation MUST sit after the lock is won — a losing second
    // instance passing through here must not rotate the live instance's
    // logs out from under it.
    let server_log = logs_dir.join("server-console.log");
    rotate_log(&log.0, Some(512 * 1024));
    rotate_log(&server_log, None);

    // ── Spawn the server.
    let shared = Arc::new(Shared {
        proc: Mutex::new(None),
        generation: AtomicU64::new(0),
        quitting: AtomicBool::new(false),
    });
    // Same "port N" text as always (smokes grep this log); the address only
    // appears when the config pins one — the interesting case for support.
    let addr_note = if ep.ip.is_loopback() {
        String::new()
    } else {
        format!(", address {}", ep.ip)
    };
    log.line(&format!(
        "starting server: {} (config {}, port {}{addr_note})",
        bin.display(),
        config.display(),
        ep.port
    ));

    // ── Event loop + tray.
    #[allow(unused_mut)]
    let mut event_loop = EventLoopBuilder::<AppEvent>::with_user_event().build();
    #[cfg(target_os = "macos")]
    {
        // Menu-bar app: no Dock icon, no app switcher entry. The .app's
        // LSUIElement (staged in phase 1c) says the same thing to
        // LaunchServices; this covers a bare-binary run.
        use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
        event_loop.set_activation_policy(ActivationPolicy::Accessory);
    }

    let proxy = event_loop.create_proxy();
    {
        let proxy = proxy.clone();
        MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
            let _ = proxy.send_event(AppEvent::Menu(event.id().0.clone()));
        }));
    }
    // Clicks on the icon itself: only the left button's release wakes the
    // loop, judged by the press before it (icon_click_of). tray-icon calls
    // this handler synchronously from the click's own mouse-down/up on the
    // main thread, so the Control key read at the press is the one the
    // click was made with. Installing a handler also matters on its own:
    // without one, tray-icon queues every icon event, hover traffic
    // included, into an unbounded channel that nothing here reads.
    {
        let proxy = proxy.clone();
        let pressed_with_control = AtomicBool::new(false);
        TrayIconEvent::set_event_handler(Some(move |event: TrayIconEvent| {
            if let Some(click) = icon_click_of(&event, platform::control_key_held, &pressed_with_control) {
                let _ = proxy.send_event(AppEvent::TrayClick(click));
            }
        }));
    }

    // The update-surface poll: ONE always-running thread for the whole
    // session, deliberately not tied to a server generation (see
    // AppEvent::UpdatePoll — a Stopped/never-verified server has no ticker,
    // and the update menu line must keep tracking the status file anyway).
    {
        let proxy = proxy.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(60));
            if proxy.send_event(AppEvent::UpdatePoll).is_err() {
                return; // the loop is gone
            }
        });
    }

    // ── Our own REAL location (canonicalized so a start through the
    // `current` symlink still resolves to the versioned tree the walk-ups
    // need) — the update surface below and the boot watchdog both key off it.
    let exe_real = std::env::current_exe()
        .ok()
        .map(|p| std::fs::canonicalize(&p).unwrap_or(p));
    // A --server-bin/MSTREAM_SERVER_BIN override means a failing server is
    // NOT the bundle's own build — a rollback would punish the wrong version.
    let watchdog_eligible = args.server_bin.is_none();

    match spawn_generation(&shared, &bin, &args.server_args, &server_log, ep, &proxy, &log) {
        Ok(()) => {}
        Err(e) => {
            log.line(&format!("server failed to spawn: {e}"));
            // A managed layout whose committed version cannot even SPAWN its
            // server is the boot watchdog's case too — same recovery as a
            // crash-before-serving, just caught one step earlier.
            if watchdog_eligible {
                if let Some(face) = attempt_boot_rollback(exe_real.as_deref(), &log) {
                    match platform::relaunch(&face, &args.server_args) {
                        Ok(()) => {
                            log.line("update watchdog: handed off to the previous version");
                            std::process::exit(0);
                        }
                        Err(re) => log.line(&format!("update watchdog: relaunch failed: {re}")),
                    }
                }
            }
            platform::fatal_alert(&format!(
                "mStream could not start its server process:\n{e}\n\nSee {}",
                server_log.display()
            ));
            std::process::exit(1);
        }
    }

    // State owned by the loop closure.
    let mut tray: Option<TrayIcon> = None;
    let mut autostart_item: Option<CheckMenuItem> = None;
    // The status line at the top of the menu ("Running · up 3h 12m") and
    // the phase it renders. The launcher's own clock is the uptime source:
    // it IS the supervisor, and the server has no uptime API to ask.
    let mut status_item: Option<MenuItem> = None;
    let mut phase = Phase::Starting;
    // Last time a tick re-rendered the status. The status can only change
    // on a minute boundary, so ticks are throttled to 1 Hz: a stale ticker
    // (from before a restart) or any other timer this loop is asked for
    // must not re-set the same tooltip text under a hovering cursor. Phase
    // changes render unconditionally.
    let mut status_rendered_at: Option<Instant> = None;
    // When the current generation was spawned: the uptime origin for a
    // server the probe could not verify (Phase::Unverified).
    let mut spawned_at = Instant::now();
    let mut ever_up = false;
    // Crash-before-serving spawns for the CURRENT boot cycle (reset the
    // moment a server proves alive): past MAX_BOOT_ATTEMPTS the boot
    // watchdog decides whether a staged update gets rolled back.
    let mut boot_failures: u32 = 0;
    let mut opened = false;
    // When a left click on the icon last opened the player (the debounce:
    // TRAY_CLICK_DEBOUNCE).
    let mut last_tray_click: Option<Instant> = None;
    // `--player`: an explicit ask for the desktop player, served once the
    // server answers (the GUI dials it at once) and once per session — a
    // restart's ServerUp must not pop a second window.
    let mut player_requested = args.player;
    // Update-awareness: the server's checker writes update-status.json in
    // the shared data home; the tray re-reads it on every minute tick.
    let mut update_item: Option<MenuItem> = None;
    let mut upd: Option<paths::UpdateStatus> = paths::read_update_status();
    let mut upd_text = String::new();
    // The apply request we last ACTED on (the file's applyRequestedAt, else
    // the staged version): a failed handoff must not auto-retry itself into
    // a spawn loop, but a NEW request — a later version, or the operator
    // clicking "restart to update" again in the webapp — starts fresh.
    let mut auto_apply_attempted: Option<String> = None;
    // The token alone cannot bound retries: every failed apply respawns the
    // server, and the fresh process re-stages and mints a fresh
    // applyRequestedAt within ~2 minutes — an unbounded stop/fail/respawn
    // flap on a PERSISTENT relaunch failure. So failures are also counted
    // per staged VERSION; past the cap, auto-apply stands down for that
    // version (the tray menu still lets a human retry) until a different
    // version stages.
    let mut apply_failures: Option<(String, u32)> = None;
    let url = paths::server_url(&ep);
    // A --takeover relaunch is mid-update, not a first run: never announce.
    let announce = !args.autostarted && !args.no_open && !args.takeover;
    let shared_loop = shared.clone();
    let server_log_loop = server_log.clone();
    // For launcher-initiated opens inside the loop (announce, macOS reopen):
    // re-read the config each time so the destination tracks the library —
    // admin panel while no folders exist (a fresh install's player is a dead
    // end), the player once music is configured.
    let config_loop = config.clone();

    event_loop.run(move |event, _target, control_flow| {
        // Idle. Everything that must wake this loop arrives as a user event
        // through the proxy — menu clicks, the prober, the exit watcher, and
        // the status line's minute tick (see AppEvent::Tick for why a timer
        // wouldn't do). Exit is sticky in tao, so Quit's ControlFlow::Exit
        // survives this assignment.
        *control_flow = ControlFlow::Wait;
        match event {
            // Tray creation belongs HERE, not before run(): on Linux the
            // tray needs the gtk main context tao initializes, and on macOS
            // it must follow NSApplication activation. Windows tolerates
            // either; one code path keeps all three honest.
            Event::NewEvents(StartCause::Init) => {
                let menu = Menu::new();
                // Disabled = the greyed, unclickable status line every tray
                // app leads with (Docker Desktop, Tailscale). Text tracks
                // `phase` via show_status; the id never fires a MenuEvent.
                let status = MenuItem::with_id("status", phase.menu_text(&version_label(upd.as_ref())), false, None);
                // The update line right under it: disabled "Up to date" most
                // of its life, an enabled action ("Restart to update to X")
                // when the server has one staged. Text/enabled track the
                // status file via refresh below.
                let (utext, uaction) = update_item_view(
                    upd.as_ref(),
                    &updates_dir(),
                    relaunch_target_exists(exe_real.as_deref()),
                    THIS_INSTALLER_HOST,
                    paths::release_mirror().as_deref(),
                );
                let update = MenuItem::with_id("update", utext.clone(), uaction != UpdateAction::None, None);
                upd_text = utext;
                // "Open mStream Player": the bundled player's desktop face
                // in a window of its own — the web player in the browser
                // when this install's player predates the GUI or no
                // terminal opens (open_desktop_player). Always present, so
                // the menu keeps one shape across installs; a left click on
                // the icon does the same (AppEvent::TrayClick). There is no
                // server-management section: since player v0.11.0 the
                // desktop player hosts the admin rooms in its own Admin tab,
                // and the browser panel stays one URL away at /admin.
                let player_item = MenuItem::with_id("player", "Open mStream Player", true, None);
                let qc_item = MenuItem::with_id("quick-connect", "Quick Connect", true, None);
                // "Open Web App": the server's web app in the browser — the
                // web player, with the admin panel behind its own menu. A
                // human asked for it by name, so it opens the server's root
                // as it is, with none of browse_target's routing (that is
                // for opens the launcher initiates, which must land
                // somewhere useful before setup).
                let webapp_item = MenuItem::with_id("webapp", "Open Web App", true, None);
                let auto_item =
                    CheckMenuItem::with_id("autostart", "Start at login", true, autostart::is_enabled(), None);
                let logs_item = MenuItem::with_id("logs", "View logs", true, None);
                let restart_item = MenuItem::with_id("restart", "Restart server", true, None);
                let quit_item = MenuItem::with_id("quit", "Quit mStream", true, None);
                let _ = menu.append(&status);
                let _ = menu.append(&update);
                let _ = menu.append(&PredefinedMenuItem::separator());
                let _ = menu.append(&player_item);
                let _ = menu.append(&qc_item);
                let _ = menu.append(&webapp_item);
                let _ = menu.append(&PredefinedMenuItem::separator());
                let _ = menu.append(&auto_item);
                let _ = menu.append(&PredefinedMenuItem::separator());
                let _ = menu.append(&logs_item);
                let _ = menu.append(&restart_item);
                let _ = menu.append(&quit_item);
                status_item = Some(status);
                update_item = Some(update);
                autostart_item = Some(auto_item);

                // catch_unwind because "no tray" arrives two ways: as a
                // build Err (no StatusNotifier host), but ALSO as a PANIC —
                // libappindicator-sys dlopens libayatana-appindicator3 at
                // first use and panic!()s when no variant is installed
                // (stock Fedora/Arch desktops without an appindicator
                // package), which would take down the whole launcher here.
                // Both fold into the same degrade: server keeps serving.
                let built = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let builder = TrayIconBuilder::new()
                        .with_tooltip("mStream Server")
                        .with_menu(Box::new(menu))
                        .with_icon(load_icon());
                    // A left click opens the player and the right click
                    // keeps the menu. What tray-icon 0.24.2 does with the
                    // flag off, read from its sources: on macOS its view
                    // over the status item's button sends Click{Left, Down}
                    // on mouseDown and only highlights the button (the
                    // menu pops from mouseDown solely while the flag is
                    // on), then Click{Left, Up} on mouseUp; rightMouseDown
                    // still pops the menu. It reads no modifier flags and
                    // its view carries no menu of its own, so a
                    // Control-click (the Mac's secondary click on a mouse
                    // or trackpad without one) reaches it as a plain left
                    // click; the handler above reads Control at the press
                    // and that click shows the menu instead
                    // (IconClick::ShowMenu, TrayIcon::show_menu), so the
                    // menu stays reachable without a right button. On
                    // Windows every WM_LBUTTONDOWN/UP becomes a Click with
                    // that state, a WM_LBUTTONDBLCLK a DoubleClick on top,
                    // and the menu pops on WM_RBUTTONUP, and on
                    // WM_LBUTTONUP only while the flag is on. Linux keeps
                    // the default: the appindicator backend emits no click
                    // events and ignores the flag (the StatusNotifier host
                    // owns the clicks and shows the menu), so there the
                    // player stays one menu item away.
                    #[cfg(any(target_os = "macos", windows))]
                    let builder = builder.with_menu_on_left_click(false);
                    builder.build()
                }));
                match built {
                    Ok(Ok(t)) => tray = Some(t),
                    Ok(Err(e)) => {
                        log.line(&format!("tray unavailable ({e}) - server continues without it"));
                    }
                    Err(p) => {
                        let msg = p
                            .downcast_ref::<String>()
                            .map(|s| s.as_str())
                            .or_else(|| p.downcast_ref::<&str>().copied())
                            .unwrap_or("panic in the tray library")
                            .replace('\n', " / ");
                        log.line(&format!("tray unavailable ({msg}) - server continues without it"));
                    }
                }
                show_status(status_item.as_ref(), tray.as_ref(), &phase, &url, &version_label(upd.as_ref()));
            }
            Event::UserEvent(app_event) => match app_event {
                // The minute tick from the current generation's ticker
                // thread: re-render the uptime. Only here and on phase
                // changes — never on unrelated events, so the tooltip isn't
                // re-set under a hovering cursor. Stale generations are
                // ignored outright and the rest is throttled to 1 Hz.
                AppEvent::UpdatePoll => {
                    // The update surface tracks the status file on its own
                    // cadence — independent of any server generation, so a
                    // server that never came up (or a failed restart) still
                    // has a live update menu. One small file read; the item
                    // re-renders only on change (never re-set under a
                    // hovering cursor).
                    upd = paths::read_update_status();
                    let action = render_update_item(
                        update_item.as_ref(),
                        upd.as_ref(),
                        &updates_dir(),
                        relaunch_target_exists(exe_real.as_deref()),
                        &mut upd_text,
                    );
                    // auto mode / a webapp "restart to update" click: the
                    // server flags applyRequested and this launcher acts on
                    // the next poll. Once PER REQUEST TOKEN — a failed
                    // handoff never retries itself into a spawn loop, but a
                    // NEW request (a later version, another webapp click)
                    // starts fresh. And never while quitting: a queued poll
                    // must not resurrect mStream on the way out.
                    let token = upd.as_ref().and_then(auto_apply_token);
                    let staged_ver = upd.as_ref().and_then(|s| s.staged_version.clone());
                    if !shared_loop.quitting.load(Ordering::SeqCst)
                        && upd.as_ref().is_some_and(|s| s.apply_requested)
                        && token.is_some()
                        && token != auto_apply_attempted
                        // Only while a server is actually alive. Not mid-boot
                        // (Starting): the takeover launcher's first poll can
                        // land while the new server is still migrating,
                        // reading a status file the OLD session armed — an
                        // apply here kills a healthy boot. And not Stopped:
                        // a dead server cannot have MEANT the armed request
                        // still in the file — acting on it from Stopped is
                        // how a stale arm turns into a relaunch loop after a
                        // crash (each relaunch is a fresh process whose
                        // attempted-token starts empty).
                        && matches!(phase, Phase::Running { .. } | Phase::Unverified { .. })
                        // Never into a version the boot watchdog held after
                        // a failed start (rollback.rs) — the hold outranks
                        // whatever the status file still advertises.
                        && !staged_ver
                            .as_deref()
                            .is_some_and(|v| rollback::held_versions(&paths::data_home()).iter().any(|h| h == v))
                        // Never into OURSELVES: after a successful handoff
                        // the stale file still says "apply X" until the new
                        // server rewrites it — but this launcher shipped IN
                        // bundle X; applying it again is a kill-loop, not
                        // an update.
                        && staged_ver.as_deref() != Some(env!("MSTREAM_BUNDLE_VERSION"))
                        && !auto_apply_capped(&apply_failures, staged_ver.as_deref())
                        // Only a handoff: the launcher never pops Installer.app
                        // (OpenInstaller) or a browser unasked.
                        && action.is_handoff()
                    {
                        auto_apply_attempted = token;
                        log.line("update: the server requested apply - restarting into the staged version");
                        match perform_apply(&shared_loop, &action, exe_real.as_deref(), &args.server_args, &log) {
                            Ok(()) => {
                                tray.take();
                                *control_flow = ControlFlow::Exit;
                            }
                            Err(e) => {
                                log.line(&format!("update apply failed: {e}"));
                                record_apply_failure(&mut apply_failures, staged_ver.as_deref(), &log);
                                spawned_at = Instant::now();
                                phase = recover_after_failed_apply(
                                    &shared_loop, &bin, &args.server_args, &server_log_loop, ep, &proxy, &log,
                                );
                                show_status(status_item.as_ref(), tray.as_ref(), &phase, &url, &version_label(upd.as_ref()));
                            }
                        }
                    }
                }
                AppEvent::Tick(generation) => {
                    let now = Instant::now();
                    if generation == shared_loop.generation.load(Ordering::SeqCst)
                        && phase.ticks()
                        && status_rendered_at.is_none_or(|t| now.duration_since(t) >= Duration::from_secs(1))
                    {
                        status_rendered_at = Some(now);
                        show_status(status_item.as_ref(), tray.as_ref(), &phase, &url, &version_label(upd.as_ref()));
                    }
                }
                AppEvent::TrayClick(IconClick::ShowMenu) => {
                    // A Control-click on macOS: the menu a right click
                    // shows, popped from the status item's button, and the
                    // item picked arrives as AppEvent::Menu like any other.
                    // No debounce: a menu is modal, so a second cannot
                    // stack on the first.
                    log.line("tray: control-click - show menu");
                    if let Some(t) = tray.as_ref() {
                        t.show_menu();
                    }
                }
                AppEvent::TrayClick(IconClick::OpenPlayer) => {
                    // A Windows double click is two of these; the second
                    // inside TRAY_CLICK_DEBOUNCE is dropped without a word.
                    let now = Instant::now();
                    if tray_click_acts(last_tray_click, now) {
                        last_tray_click = Some(now);
                        log.line("tray: left click - open player");
                        open_player_from_tray(desktop_player.as_ref(), &url, &data_home, &config_loop, &ep, &log);
                    }
                }
                AppEvent::Menu(id) => match id.as_str() {
                    "player" => {
                        log.line("menu: open player");
                        open_player_from_tray(desktop_player.as_ref(), &url, &data_home, &config_loop, &ep, &log);
                    }
                    "webapp" => {
                        log.line("menu: open web app");
                        let _ = open::that_detached(&url);
                    }
                    "quick-connect" => {
                        // The wizard's Quick Connect page (pairing QR) in
                        // the player's own window when the desktop build
                        // says it hosts the pages, else in a real terminal
                        // on every desktop platform; the webapp's modal
                        // hash (webapp/assets/js/quick-connect.js) is the
                        // fallback when this install has no player binary,
                        // the page failed in its window, or no terminal
                        // opened (a Linux desktop without an emulator the
                        // chain knows). open_player_page owns the route.
                        log.line("menu: quick connect");
                        open_player_page(
                            desktop_player.as_ref(),
                            player_bin.as_deref(),
                            TrayPage::QuickConnect,
                            &url,
                            &data_home,
                            &format!("{url}/#quick-connect"),
                            &log,
                        );
                    }
                    "autostart" => {
                        // muda toggles the checkbox before we hear about it,
                        // so is_checked() is the DESIRED state.
                        if let Some(item) = &autostart_item {
                            let want = item.is_checked();
                            if let Err(e) = autostart::set_enabled(want) {
                                log.line(&format!("autostart toggle failed: {e}"));
                                item.set_checked(!want);
                            } else {
                                log.line(&format!("autostart {}", if want { "enabled" } else { "disabled" }));
                            }
                        }
                    }
                    "logs" => {
                        // Support surface: "click View logs and read me what it
                        // says" beats digging paths out of Application Support.
                        log.line("menu: view logs");
                        if let Err(e) = platform::open_logs_terminal(&logs_dir) {
                            log.line(&format!("view logs failed: {e}"));
                        }
                    }
                    "restart" => {
                        log.line("menu: restart server");
                        stop_current(&shared_loop);
                        spawned_at = Instant::now();
                        // A human-initiated restart is a fresh intent: the
                        // watchdog's failure budget starts over.
                        boot_failures = 0;
                        phase = match spawn_generation(
                            &shared_loop,
                            &bin,
                            &args.server_args,
                            &server_log_loop,
                            ep,
                            &proxy,
                            &log,
                        ) {
                            Ok(()) => Phase::Starting,
                            Err(e) => {
                                log.line(&format!("restart failed: {e}"));
                                platform::fatal_alert(&format!("mStream could not restart its server:\n{e}"));
                                Phase::Stopped
                            }
                        };
                        show_status(status_item.as_ref(), tray.as_ref(), &phase, &url, &version_label(upd.as_ref()));
                    }
                    "update" => {
                        // Recompute from the file at click time — the menu
                        // could have been open across a state change.
                        upd = paths::read_update_status();
                        let action = render_update_item(
                            update_item.as_ref(),
                            upd.as_ref(),
                            &updates_dir(),
                            relaunch_target_exists(exe_real.as_deref()),
                            &mut upd_text,
                        );
                        match action {
                            UpdateAction::OpenReleases => {
                                let _ = open::that_detached(RELEASES_URL);
                            }
                            UpdateAction::OpenInstaller(pkg) => {
                                // Installer.app takes the package from here,
                                // and nothing here stops or exits: its human
                                // may cancel, and once the install really
                                // happens the pkg's postinstall restarts this
                                // launcher into the new version (--takeover).
                                // A failure to open is a log line, never an
                                // apply failure: the server never stopped.
                                let name = pkg.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                                log.line(&format!("menu: open installer {name}"));
                                if let Err(e) = open::that_detached(&pkg) {
                                    log.line(&format!("open installer failed: {e}"));
                                }
                            }
                            UpdateAction::DownloadInstaller(pkg_url) => {
                                // The browser downloads the release's .pkg
                                // (an attachment, not a page); the human
                                // opens it from there and the pkg's
                                // postinstall restarts this launcher, as
                                // with OpenInstaller. Nothing stops here.
                                log.line(&format!("menu: download installer {pkg_url}"));
                                if let Err(e) = open::that_detached(&pkg_url) {
                                    log.line(&format!("download installer failed: {e}"));
                                }
                            }
                            UpdateAction::None => {}
                            UpdateAction::Relaunch | UpdateAction::RunInstaller(_) => {
                                log.line("menu: apply update");
                                // The click consumes any pending server-side
                                // request too: a failed MANUAL apply must not
                                // be auto-repeated seconds later by a poll
                                // reading the still-armed file.
                                auto_apply_attempted = upd.as_ref().and_then(auto_apply_token);
                                match perform_apply(&shared_loop, &action, exe_real.as_deref(), &args.server_args, &log) {
                                    Ok(()) => {
                                        tray.take();
                                        *control_flow = ControlFlow::Exit;
                                    }
                                    Err(e) => {
                                        log.line(&format!("update apply failed: {e}"));
                                        record_apply_failure(
                                            &mut apply_failures,
                                            upd.as_ref().and_then(|s| s.staged_version.as_deref()),
                                            &log,
                                        );
                                        spawned_at = Instant::now();
                                        phase = recover_after_failed_apply(
                                            &shared_loop, &bin, &args.server_args, &server_log_loop, ep, &proxy, &log,
                                        );
                                        show_status(status_item.as_ref(), tray.as_ref(), &phase, &url, &version_label(upd.as_ref()));
                                    }
                                }
                            }
                        }
                    }
                    "quit" => {
                        log.line("menu: quit");
                        shared_loop.quitting.store(true, Ordering::SeqCst);
                        stop_current(&shared_loop);
                        tray.take(); // remove the icon before the process exits
                        *control_flow = ControlFlow::Exit;
                    }
                    _ => {}
                },
                AppEvent::ServerUp(generation) => {
                    // The probe proved SOMETHING on the port speaks mStream —
                    // make sure it's OUR child and not a foreign instance the
                    // port was lost to (child already dead on EADDRINUSE).
                    // Announcing then would set ever_up and mask the boot
                    // failure the ServerExited path is about to dialog.
                    let child_alive = shared_loop
                        .proc
                        .lock()
                        .unwrap()
                        .as_mut()
                        .map(|p| matches!(p.child.try_wait(), Ok(None)))
                        .unwrap_or(false);
                    if child_alive && generation == shared_loop.generation.load(Ordering::SeqCst) {
                        ever_up = true;
                        boot_failures = 0;
                        log.line("server is up");
                        // The booting server just rewrote the status file
                        // (its version, cleared staged flags) — pick that up
                        // now instead of a minute from now.
                        upd = paths::read_update_status();
                        let _ = render_update_item(
                            update_item.as_ref(),
                            upd.as_ref(),
                            &updates_dir(),
                            relaunch_target_exists(exe_real.as_deref()),
                            &mut upd_text,
                        );
                        // Uptime counts from here — "up" means serving, not
                        // spawned. A restart or crash lands back in
                        // Starting/Stopped, so the count resets with it.
                        let since = Instant::now();
                        phase = Phase::Running { since };
                        show_status(status_item.as_ref(), tray.as_ref(), &phase, &url, &version_label(upd.as_ref()));
                        start_ticker(&shared_loop, generation, since, &proxy);
                        // Logged unconditionally (even under --no-open) so
                        // smokes and support can see the routing decision.
                        let target = paths::browse_target(&config_loop, &ep);
                        if target.ends_with("/admin") {
                            log.line("no music folders configured yet - browser target is the admin panel");
                        }
                        if player_requested {
                            player_requested = false;
                            if target.ends_with("/admin") {
                                // A fresh install: the wizard (below) is the
                                // useful window; the player would show a
                                // server with no music. The ask stands down —
                                // the tray item is one click away after setup.
                                log.line("--player: not set up yet - the setup wizard comes first");
                            } else {
                                opened = true;
                                let fallback = (!args.no_open).then_some(target.as_str());
                                open_desktop_player(
                                    desktop_player.as_ref(),
                                    &url,
                                    &data_home,
                                    fallback,
                                    &log,
                                );
                            }
                        }
                        if announce && !opened {
                            opened = true;
                            // First install: open the guided wizard — in the
                            // player's own window when the desktop build says
                            // it hosts the pages, else in a terminal (browser
                            // admin panel as the fallback when no player
                            // binary exists, the wizard failed in its window,
                            // or no terminal opened — on Linux, a desktop
                            // without an emulator the platform chain knows;
                            // open_player_page owns the route). CONFIGURED
                            // installs boot QUIETLY — the wizard quick-start
                            // superseded the old open-the-player-on-every-
                            // boot announce (operator decision, pre-6.24):
                            // the player stays one deliberate gesture away
                            // (re-click the app / second launch / a click on
                            // the tray icon) and its Admin tab holds the
                            // admin rooms. The announce gates (--takeover,
                            // --autostarted, --no-open) suppress the
                            // first-run open exactly like the old browser
                            // pop — an update relaunch must never pop a
                            // terminal.
                            if target.ends_with("/admin") {
                                open_player_page(
                                    desktop_player.as_ref(),
                                    player_bin.as_deref(),
                                    TrayPage::Setup,
                                    &url,
                                    &data_home,
                                    &target,
                                    &log,
                                );
                            } else {
                                log.line("boot announce: quiet (already set up)");
                            }
                        }
                    }
                }
                AppEvent::ProbeGaveUp(generation) => {
                    // The child outlived BOOT_TIMEOUT without answering the
                    // plaintext identity probe. It is serving something we
                    // cannot read — an SSL-terminated config, or a bind the
                    // probe's address doesn't reach — not failing to boot:
                    // that shape is ServerExited's. Before this arm existed
                    // the menu said "Starting…" for the rest of the session,
                    // inviting a needless Restart. Say what we know instead.
                    let child_alive = shared_loop
                        .proc
                        .lock()
                        .unwrap()
                        .as_mut()
                        .map(|p| matches!(p.child.try_wait(), Ok(None)))
                        .unwrap_or(false);
                    if child_alive
                        && generation == shared_loop.generation.load(Ordering::SeqCst)
                        && phase == Phase::Starting
                    {
                        // Alive this long is not a boot failure: a later exit
                        // is "exited unexpectedly", not "stopped before it
                        // finished starting".
                        ever_up = true;
                        boot_failures = 0;
                        log.line(&format!(
                            "server did not answer the identity probe within {}s but is still running - showing it as running (unverified); an SSL-only config or a bind the plaintext probe can't reach looks like this",
                            BOOT_TIMEOUT.as_secs()
                        ));
                        let since = spawned_at;
                        phase = Phase::Unverified { since };
                        show_status(status_item.as_ref(), tray.as_ref(), &phase, &url, &version_label(upd.as_ref()));
                        start_ticker(&shared_loop, generation, since, &proxy);
                    }
                }
                AppEvent::ServerExited(generation) => {
                    let current = shared_loop.generation.load(Ordering::SeqCst);
                    if generation == current && !shared_loop.quitting.load(Ordering::SeqCst) {
                        log.line("server exited unexpectedly");
                        if ever_up {
                            phase = Phase::Stopped;
                        } else {
                            // Died before ever serving = a boot failure. One
                            // respawn absorbs transient causes; a repeated
                            // failure goes to the boot watchdog, which rolls
                            // a freshly applied update back to the previous
                            // version (rollback.rs). Before the watchdog this
                            // was a dead install: no server means no update
                            // checker, so even a FIXED release could never
                            // arrive on its own.
                            boot_failures += 1;
                            let mut exhausted = boot_failures >= MAX_BOOT_ATTEMPTS;
                            if !exhausted {
                                log.line(&format!(
                                    "server died before serving (attempt {boot_failures}/{MAX_BOOT_ATTEMPTS}) - retrying"
                                ));
                                spawned_at = Instant::now();
                                match spawn_generation(
                                    &shared_loop, &bin, &args.server_args, &server_log_loop, ep, &proxy, &log,
                                ) {
                                    Ok(()) => phase = Phase::Starting,
                                    Err(e) => {
                                        log.line(&format!("retry spawn failed: {e}"));
                                        exhausted = true;
                                    }
                                }
                            }
                            if exhausted {
                                let face = if watchdog_eligible {
                                    attempt_boot_rollback(exe_real.as_deref(), &log)
                                } else {
                                    None
                                };
                                if let Some(face) = face {
                                    shared_loop.quitting.store(true, Ordering::SeqCst);
                                    match platform::relaunch(&face, &args.server_args) {
                                        Ok(()) => {
                                            log.line("update watchdog: handed off to the previous version");
                                            tray.take();
                                            *control_flow = ControlFlow::Exit;
                                            return;
                                        }
                                        Err(e) => {
                                            // `current` is already re-pointed, so the
                                            // next manual start (or reboot) lands on
                                            // the good version despite this handoff
                                            // failing.
                                            shared_loop.quitting.store(false, Ordering::SeqCst);
                                            log.line(&format!("update watchdog: relaunch failed: {e}"));
                                            phase = Phase::Stopped;
                                            platform::fatal_alert(&format!(
                                                "The updated mStream could not start and was rolled back.\nStart mStream again to run the previous version.\n\nSee {}",
                                                server_log_loop.display()
                                            ));
                                        }
                                    }
                                } else {
                                    phase = Phase::Stopped;
                                    // The dialog the user would otherwise
                                    // never see (no console on a GUI launch).
                                    platform::fatal_alert(&format!(
                                        "The mStream server stopped before it finished starting.\n\nSee {}",
                                        server_log_loop.display()
                                    ));
                                }
                            }
                        }
                        show_status(status_item.as_ref(), tray.as_ref(), &phase, &url, &version_label(upd.as_ref()));
                    }
                }
            },
            // macOS: re-clicking the running .app arrives as a reopen
            // AppleEvent (applicationShouldHandleReopen), never as a second
            // process — the single-instance lock never sees it, and the
            // menu-bar icon is easy to miss. Treat a re-click as "take me to
            // mStream": the desktop player, brought forward when it is
            // already open, with the web player where this install has none
            // (--no-open keeps the browser shut). (Other platforms never
            // emit this event; their second launch does the same above.)
            Event::Reopen { .. } => {
                log.line("reopen event - opening the desktop player");
                let target = paths::browse_target(&config_loop, &ep);
                let fallback = (!args.no_open).then_some(target.as_str());
                open_desktop_player(desktop_player.as_ref(), &url, &data_home, fallback, &log);
            }
            Event::LoopDestroyed => {
                // Belt to Quit's suspenders: whatever ends the loop, never
                // leave the child running unsupervised.
                stop_current(&shared_loop);
            }
            _ => {}
        }
    })
}

/// What a left click on the tray icon asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum IconClick {
    /// A plain click: the player, exactly as "Open mStream Player" opens it.
    OpenPlayer,
    /// A Control-click, macOS's own secondary click: the menu, exactly as
    /// a right click shows it.
    ShowMenu,
}

/// What a tray-icon event asks of the event loop: the left button's
/// release, and nothing else. Whether Control was held is read at the press
/// (`control_held`, called only then) and carried to the release in
/// `pressed_with_control`, because AppKit judges a Control-click by the
/// mouse-down too: letting go of Control before the button still makes a
/// menu click, and pressing it mid-click does not. The press itself, a
/// Windows DoubleClick (sent on top of the clicks it is made of), the other
/// buttons (the right one pops the menu on its own) and the hover traffic
/// (Enter/Move/Leave, one Move per pixel) all stay off the event loop.
fn icon_click_of(
    event: &TrayIconEvent,
    control_held: impl FnOnce() -> bool,
    pressed_with_control: &AtomicBool,
) -> Option<IconClick> {
    match event {
        TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Down, .. } => {
            pressed_with_control.store(control_held(), Ordering::Relaxed);
            None
        }
        TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } => {
            Some(if pressed_with_control.swap(false, Ordering::Relaxed) {
                IconClick::ShowMenu
            } else {
                IconClick::OpenPlayer
            })
        }
        _ => None,
    }
}

/// Whether a left click on the icon at `now` acts, given when the last one
/// that acted did: not within TRAY_CLICK_DEBOUNCE of it.
fn tray_click_acts(last: Option<Instant>, now: Instant) -> bool {
    last.is_none_or(|t| now.saturating_duration_since(t) >= TRAY_CLICK_DEBOUNCE)
}

/// "Open mStream Player" from the tray: the menu item and a left click on
/// the icon both come here, so the two gestures cannot drift apart. A human
/// asked, so the browser fallback is always on the table when no desktop
/// player opens, routed like every launcher-initiated open
/// (paths::browse_target: the player once set up, the admin panel before).
fn open_player_from_tray(
    player: Option<&DesktopPlayer>,
    server_url: &str,
    data_home: &Path,
    config: &Path,
    ep: &paths::Endpoint,
    log: &Logger,
) {
    // On Windows a left click leaves the taskbar in the foreground where a
    // menu pick leaves the launcher, so the right to come to the front is
    // handed on first, for either gesture, before anything opens.
    if !platform::allow_foreground_handoff() {
        log.line("player: no foreground right to pass on - a new window may open behind the active one");
    }
    let fallback = paths::browse_target(config, ep);
    open_desktop_player(player, server_url, data_home, Some(&fallback), log);
}

/// The desktop player this install can open: the GUI-capable binary and,
/// when its release takes the instance lock, the lock path in the data
/// home (paths::desktop_player_lock) — handed to the player on every open
/// and tried before one (desktop_player_running) — and, when its GUI hosts
/// the control face, the port to host it on (paths::rust_player_port):
/// the server's player port, so the server can adopt the open player as
/// its server-audio engine. `desktop`: the probe named a desktop build
/// (paths::PlayerProbe), which opens in a window of its own (the window
/// route) wherever this session can show one. `pages`: the probe named
/// `window-pages` too, so Setup and Quick Connect take a window route of
/// their own (open_player_page).
#[derive(Clone)]
struct DesktopPlayer {
    bin: PathBuf,
    instance_lock: Option<PathBuf>,
    serve_port: Option<u16>,
    desktop: bool,
    pages: bool,
}

impl DesktopPlayer {
    /// The player page every route opens — the window route adds only
    /// `--window` to it (platform::player_words).
    fn page(&self) -> platform::PlayerPage {
        platform::PlayerPage::Player { instance_lock: self.instance_lock.clone(), serve_port: self.serve_port }
    }
}

/// Where the window route's player writes its stdout and stderr: one file
/// in the launcher's logs dir, rotated to `.1` before every open (each
/// window's session gets the file to itself, the previous one is kept for
/// diagnosis, and nothing grows past one session).
fn player_window_log(data_home: &Path) -> PathBuf {
    data_home.join("logs").join("desktop-player.log")
}

/// The two pages the tray opens besides the player: the first-run
/// announce's setup wizard and the menu's Quick Connect. A page holds no
/// instance lock (a second click opens a second one), so it shares neither
/// the player's lock check nor its window verdicts (page_verdict).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TrayPage {
    Setup,
    QuickConnect,
}

impl TrayPage {
    /// The player page it opens — one argv on every route
    /// (platform::player_words: `setup` / `qr`, `--window` on the window
    /// route, then `--server <url>`; never a lock or a port).
    fn player_page(self) -> platform::PlayerPage {
        match self {
            TrayPage::Setup => platform::PlayerPage::Setup,
            TrayPage::QuickConnect => platform::PlayerPage::QuickConnect,
        }
    }
    /// The subject of the page's "opened via …" line — one phrase whichever
    /// route opened it, so support and the smokes read one line.
    fn opener(self) -> &'static str {
        match self {
            TrayPage::Setup => "first-run announce: setup wizard",
            TrayPage::QuickConnect => "quick connect",
        }
    }
    /// The page's window in the watcher's lines.
    fn window_name(self) -> &'static str {
        match self {
            TrayPage::Setup => "setup wizard window",
            TrayPage::QuickConnect => "quick connect window",
        }
    }
    /// The terminal route's failure line; it names the browser fallback
    /// that follows it.
    fn terminal_failed(self, e: &str) -> String {
        match self {
            TrayPage::Setup => format!("first-run announce: wizard failed ({e}) - {}", self.browser_words()),
            TrayPage::QuickConnect => format!("quick connect terminal failed: {e} - {}", self.browser_words()),
        }
    }
    /// What the browser fallback opens, as a log line says it.
    fn browser_words(self) -> &'static str {
        match self {
            TrayPage::Setup => "opening the admin panel",
            TrayPage::QuickConnect => "falling back to the webapp",
        }
    }
}

/// Where a page's window writes its stdout and stderr: a file of its own
/// per page beside the player's, rotated to `.1` before every open like
/// desktop-player.log, so a page's window and the player's window never
/// truncate each other's file.
fn player_page_log(data_home: &Path, page: TrayPage) -> PathBuf {
    let name = match page {
        TrayPage::Setup => "desktop-setup.log",
        TrayPage::QuickConnect => "desktop-quick-connect.log",
    };
    data_home.join("logs").join(name)
}

/// Open the desktop player — a DESKTOP build straight into a window of its
/// own (the window route: spawned detached, watched for its first
/// WINDOW_WATCH by a thread of its own), a terminal build (or a desktop
/// build in a session with no display, or one whose window could not open)
/// as the GUI face in a terminal window of its own, at its size, with this
/// server as its bundled server — or bring it forward when it is already
/// open (its instance lock is held: focus, never a second window) — or,
/// when this install has no GUI-capable player or no terminal opened, the
/// web player in the browser (`fallback`: None where the browser must stay
/// shut, i.e. under --no-open; a menu click always passes one). Shared by
/// the tray item, the --player flag, the macOS re-click and the
/// second-launch path, so every gesture logs and degrades the same way.
/// Some when a window route's watch is under way: a caller about to exit
/// settles it first (WindowWatch::settle); the tray loop lets it run.
fn open_desktop_player(
    player: Option<&DesktopPlayer>,
    server_url: &str,
    data_home: &Path,
    fallback: Option<&str>,
    log: &Logger,
) -> Option<WindowWatch> {
    let Some(player) = player else {
        log.line("player: no GUI-capable player binary in this install - falling back to the web player");
        web_player_fallback(fallback, log);
        return None;
    };
    if let Some(lock) = &player.instance_lock {
        match desktop_player_running(lock) {
            Ok(true) => {
                // Already open: the sidecar (read behind the lock) says
                // where it lives, and the focus step does what it can.
                // No fallback here — a browser beside an open player is
                // exactly the double this guards against.
                focus_open_player(lock, log);
                return None;
            }
            Ok(false) => {}
            Err(e) => log.line(&format!("instance lock check failed ({e}) - opening the player anyway")),
        }
    }
    if player.desktop {
        if platform::window_display_available() {
            let out = player_window_log(data_home);
            rotate_log(&out, None);
            match platform::spawn_player_window(&player.bin, server_url, &player.page(), &out) {
                Ok(child) => {
                    // "player opened via" like every route: support and the
                    // smokes read one phrase whichever way it opened.
                    log.line(&format!("player opened via its own window (pid {}; output in {})", child.id(), out.display()));
                    return Some(watch_player_window(
                        child,
                        WindowFallback {
                            player: player.clone(),
                            server_url: server_url.to_string(),
                            data_home: data_home.to_path_buf(),
                            fallback: fallback.map(str::to_string),
                            log: log.clone(),
                            output: out,
                        },
                    ));
                }
                Err(e) => log.line(&format!("player window could not start: {e} - opening it in a terminal instead")),
            }
        } else {
            log.line("player: a desktop build, but this session has no display (DISPLAY/WAYLAND_DISPLAY unset) - opening it in a terminal");
        }
    }
    open_player_in_terminal(player, server_url, data_home, fallback, log);
    None
}

/// The terminal route — the GUI face in a terminal window — then the web
/// player when no terminal opened.
fn open_player_in_terminal(
    player: &DesktopPlayer,
    server_url: &str,
    data_home: &Path,
    fallback: Option<&str>,
    log: &Logger,
) {
    match platform::open_player_terminal(&player.bin, server_url, data_home, player.page()) {
        Ok(via) => {
            log.line(&format!("player opened via {via}"));
            return;
        }
        Err(e) => log.line(&format!("player terminal failed: {e} - falling back to the web player")),
    }
    web_player_fallback(fallback, log);
}

fn web_player_fallback(fallback: Option<&str>, log: &Logger) {
    match fallback {
        Some(target) => {
            let _ = open::that_detached(target);
        }
        None => log.line("player: web player fallback suppressed (--no-open)"),
    }
}

/// Open one of the tray's pages. A desktop build that names `window-pages`
/// (DesktopPlayer.pages) opens it straight into a window of its own where
/// this session can show one — spawned detached and watched for its first
/// WINDOW_WATCH by a thread of its own (watch_player_page), which owns the
/// fallbacks from there. Every other install takes the terminal route as
/// before (open_page_in_terminal): a terminal build, a desktop build
/// without the word (every player through v0.11.0), a session with no
/// display, a window that could not start. `player_bin` is the terminal
/// route's binary — any player this install has, admitted by the GUI gate
/// or not, as the pages have always run — and `fallback` the browser's
/// target when no terminal opens: the admin panel for Setup, the webapp's
/// Quick Connect modal (webapp/assets/js/quick-connect.js) for Quick
/// Connect. The tray loop never waits on any of it.
fn open_player_page(
    player: Option<&DesktopPlayer>,
    player_bin: Option<&Path>,
    page: TrayPage,
    server_url: &str,
    data_home: &Path,
    fallback: &str,
    log: &Logger,
) {
    if let Some(player) = player.filter(|p| p.desktop && p.pages) {
        if platform::window_display_available() {
            let out = player_page_log(data_home, page);
            rotate_log(&out, None);
            match platform::spawn_player_window(&player.bin, server_url, &page.player_page(), &out) {
                Ok(child) => {
                    log.line(&format!("{} opened via its own window (pid {}) - output in {}", page.opener(), child.id(), out.display()));
                    watch_player_page(
                        child,
                        PageFallback {
                            page,
                            player_bin: player.bin.clone(),
                            server_url: server_url.to_string(),
                            data_home: data_home.to_path_buf(),
                            fallback: fallback.to_string(),
                            log: log.clone(),
                            output: out,
                        },
                    );
                    return;
                }
                Err(e) => log.line(&format!("{} window could not start: {e} - opening it in a terminal instead", page.opener())),
            }
        } else {
            log.line(&format!(
                "{}: a desktop build, but this session has no display (DISPLAY/WAYLAND_DISPLAY unset) - opening it in a terminal",
                page.opener()
            ));
        }
    }
    open_page_in_terminal(player_bin, page, server_url, data_home, fallback, log);
}

/// A page's terminal route — the pages' route before window-pages, and its
/// fallback after: the page in a terminal window of its own
/// (platform::open_player_terminal), then the browser when this install
/// has no player binary or no terminal opened.
fn open_page_in_terminal(
    player_bin: Option<&Path>,
    page: TrayPage,
    server_url: &str,
    data_home: &Path,
    fallback: &str,
    log: &Logger,
) {
    if let Some(bin) = player_bin {
        match platform::open_player_terminal(bin, server_url, data_home, page.player_page()) {
            Ok(via) => {
                log.line(&format!("{} opened via {via}", page.opener()));
                return;
            }
            Err(e) => log.line(&page.terminal_failed(&e)),
        }
    }
    let _ = open::that_detached(fallback);
}

/// The open player is brought forward through whatever hosts it — the
/// sidecar beside its lock says what that is (read behind the lock check).
fn focus_open_player(lock: &Path, log: &Logger) {
    let who = paths::read_player_sidecar(lock);
    let desc = who.as_ref().map(|w| format!(" (pid {}, under {})", w.pid, w.host)).unwrap_or_default();
    match platform::focus_player(who.as_ref()) {
        Ok(what) => log.line(&format!("player already open{desc} - activated {what}")),
        Err(e) => log.line(&format!("player already open{desc} - could not bring it forward: {e}")),
    }
}

/// How long the window route's watcher waits on the fresh player before it
/// calls the window up. A desktop build that cannot open a window says so
/// with exit 3 well inside it (its probe of the display and the GPU runs
/// before the first frame — measured locally: under a second), and one the
/// instance lock refuses leaves at once with 0.
const WINDOW_WATCH: Duration = Duration::from_secs(5);
const WINDOW_POLL: Duration = Duration::from_millis(100);
/// The desktop build's "no window could open at all" exit: no display, no
/// GPU backend, missing libxkbcommon-x11 on X11 (the player's
/// gui::window::NO_WINDOW).
const PLAYER_NO_WINDOW: i32 = 3;

/// What the watcher sees of the window route's child at one poll.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChildState {
    Running,
    /// Exited, with its code (None: killed by a signal).
    Exited(Option<i32>),
}

/// What the watcher does about what it saw.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WindowVerdict {
    /// Inside the watch and still running: look again.
    Watching,
    /// Still running when the watch ends: the window is up; done.
    Up,
    /// Exit 0 inside the watch: the player's instance lock refused it (an
    /// open player won the race since our lock check) — focus the holder.
    Refused,
    /// Exit 3 inside the watch: no window could open here — the terminal
    /// route.
    NoWindow,
    /// Any other exit inside the watch — the terminal route too, the code
    /// in the log.
    Failed(Option<i32>),
    /// An exit seen only past the watch (the poll's last beat): the window
    /// was up and has closed; nothing to do. Exit 3 is the exception: it
    /// means no window ever opened, however late it is reported.
    Closed(Option<i32>),
}

/// THE window route decision, pure: one place maps (exit status, time
/// since the spawn) to what the watcher does.
fn window_verdict(state: ChildState, elapsed: Duration) -> WindowVerdict {
    let inside = elapsed < WINDOW_WATCH;
    match state {
        ChildState::Running if inside => WindowVerdict::Watching,
        ChildState::Running => WindowVerdict::Up,
        // Before the time check: a slow GPU can take the player past the
        // watch and still fail to open anything, and that is never a window
        // that was up.
        ChildState::Exited(Some(PLAYER_NO_WINDOW)) => WindowVerdict::NoWindow,
        ChildState::Exited(code) if !inside => WindowVerdict::Closed(code),
        ChildState::Exited(Some(0)) => WindowVerdict::Refused,
        ChildState::Exited(code) => WindowVerdict::Failed(code),
    }
}

/// What a page's watcher makes of what it saw — the window verdicts without
/// Refused: a page holds no instance lock, so nothing ever refuses it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PageVerdict {
    /// Inside the watch and still running: look again.
    Watching,
    /// Still running when the watch ends: the page's window is up.
    Up,
    /// Exit 3, at any time: no window could open here.
    NoWindow,
    /// Any other exit inside the watch, a signal's too: the page failed in
    /// its window, the code in the log.
    Failed(Option<i32>),
    /// Exit 0 at any time — the page's every way out (finished, Esc,
    /// Ctrl+C, the close button) — the reserved PAGE_ABANDONED at any time,
    /// or any other exit past the watch: the window was there and has
    /// closed.
    Closed(Option<i32>),
}

/// THE page route decision, pure: (exit status, time since the spawn) to a
/// verdict, with the window route's clock and exit 3. Exit 0 is a close at
/// any time — a quick one is a user who was done (Esc on the Done page),
/// never a refusal and never a reason to bring anything forward.
fn page_verdict(state: ChildState, elapsed: Duration) -> PageVerdict {
    let inside = elapsed < WINDOW_WATCH;
    match state {
        ChildState::Running if inside => PageVerdict::Watching,
        ChildState::Running => PageVerdict::Up,
        ChildState::Exited(Some(PLAYER_NO_WINDOW)) => PageVerdict::NoWindow,
        ChildState::Exited(Some(0)) => PageVerdict::Closed(Some(0)),
        ChildState::Exited(Some(PAGE_ABANDONED)) => PageVerdict::Closed(Some(PAGE_ABANDONED)),
        ChildState::Exited(code) if inside => PageVerdict::Failed(code),
        ChildState::Exited(code) => PageVerdict::Closed(code),
    }
}

/// The exit the launcher reserves for a page "left before it finished" (the
/// wizard abandoned rather than completed), written into the `window-pages`
/// contract beside PlayerProbe. No player sends it yet — every way out is 0
/// today — and its row in page_verdict is here so the player can start
/// sending it without a launcher change: it is a close at every layer, never
/// a failure, so no fallback and no focus follow it.
const PAGE_ABANDONED: i32 = 4;

/// What the page's watcher does about a verdict.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PageAction {
    /// Log it; the page is up, or was and has closed.
    Nothing,
    /// The page in a terminal window instead (no window could open here).
    Terminal,
    /// The page's browser fallback: a page that failed in its window would
    /// fail the same way in a terminal.
    Browser,
}

/// The page route's fallback table, pure.
fn page_outcome(verdict: PageVerdict) -> PageAction {
    match verdict {
        PageVerdict::NoWindow => PageAction::Terminal,
        PageVerdict::Failed(_) => PageAction::Browser,
        PageVerdict::Watching | PageVerdict::Up | PageVerdict::Closed(_) => PageAction::Nothing,
    }
}

/// Everything the watcher needs to take the fallback on its own thread.
struct WindowFallback {
    player: DesktopPlayer,
    server_url: String,
    data_home: PathBuf,
    fallback: Option<String>,
    log: Logger,
    /// The child's output file — its last line rides into a failure's log.
    output: PathBuf,
}

/// A window route's watch under way: settle() waits (bounded) until the
/// watcher has decided and acted.
struct WindowWatch(std::sync::mpsc::Receiver<()>);

impl WindowWatch {
    fn settle(self) {
        // The watch itself plus room for a terminal fallback's own spawn
        // (the Linux chain's per-emulator grace, macOS `open`).
        let _ = self.0.recv_timeout(WINDOW_WATCH + Duration::from_secs(10));
    }
}

/// The window route's watcher: a thread of its own polls the child for
/// WINDOW_WATCH and acts on window_verdict — the launcher itself never
/// waits. Once the window is up it stays to reap the child (no zombie for
/// the tray's lifetime) and logs its exit.
fn watch_player_window(mut child: std::process::Child, ctx: WindowFallback) -> WindowWatch {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let pid = child.id();
        let start = Instant::now();
        let verdict = loop {
            let state = match child.try_wait() {
                Ok(Some(st)) => ChildState::Exited(st.code()),
                Ok(None) => ChildState::Running,
                Err(e) => {
                    ctx.log.line(&format!("player window (pid {pid}): cannot watch it ({e}) - leaving it be"));
                    let _ = tx.send(());
                    return;
                }
            };
            match window_verdict(state, start.elapsed()) {
                WindowVerdict::Watching => std::thread::sleep(WINDOW_POLL),
                v => break v,
            }
        };
        let ms = start.elapsed().as_millis();
        let to_terminal = |why: String, ms: u128| {
            ctx.log.line(&format!("player window (pid {pid}) {why} after {ms} ms - falling back to the terminal route"));
            open_player_in_terminal(&ctx.player, &ctx.server_url, &ctx.data_home, ctx.fallback.as_deref(), &ctx.log);
        };
        match verdict {
            WindowVerdict::Watching => unreachable!("the loop only breaks on a decision"),
            WindowVerdict::Up => ctx.log.line(&format!("player window (pid {pid}) is up")),
            WindowVerdict::Closed(code) => ctx.log.line(&format!("player window (pid {pid}) closed after {ms} ms ({})", exit_words(code))),
            WindowVerdict::NoWindow => to_terminal(format!("could not open a window (exit {PLAYER_NO_WINDOW}{})", last_words(&ctx.output)), ms),
            WindowVerdict::Failed(code) => to_terminal(format!("failed ({}{})", exit_words(code), last_words(&ctx.output)), ms),
            WindowVerdict::Refused => {
                let held = ctx.player.instance_lock.as_deref().map(desktop_player_running);
                match (ctx.player.instance_lock.as_deref(), held) {
                    (Some(lock), Some(Ok(true))) => {
                        ctx.log.line(&format!("player window (pid {pid}) refused by the instance lock after {ms} ms - another player is open"));
                        focus_open_player(lock, &ctx.log);
                    }
                    _ => ctx.log.line(&format!("player window (pid {pid}) exited 0 after {ms} ms and no player holds the lock - closed at once; nothing to do")),
                }
            }
        }
        let _ = tx.send(());
        if verdict == WindowVerdict::Up {
            match child.wait() {
                // Up only meant "still running at the watch's end": a GPU that
                // took longer than that and then gave up reports here.
                Ok(st) if st.code() == Some(PLAYER_NO_WINDOW) => to_terminal(
                    format!("could not open a window (exit {PLAYER_NO_WINDOW}{})", last_words(&ctx.output)),
                    start.elapsed().as_millis(),
                ),
                Ok(st) => ctx.log.line(&format!("player window (pid {pid}) closed ({})", exit_words(st.code()))),
                Err(e) => ctx.log.line(&format!("player window (pid {pid}): wait failed: {e}")),
            }
        }
    });
    WindowWatch(rx)
}

/// Everything a page's watcher needs to take the fallbacks on its own
/// thread.
struct PageFallback {
    page: TrayPage,
    player_bin: PathBuf,
    server_url: String,
    data_home: PathBuf,
    /// The browser's target (open_player_page).
    fallback: String,
    log: Logger,
    /// The child's output file — its last line rides into a failure's log.
    output: PathBuf,
}

/// A page's watcher: a thread of its own polls the child for WINDOW_WATCH
/// and acts on page_outcome(page_verdict(..)) — the terminal route for no
/// window, the browser for a failure, a log line for the rest. Once the
/// window is up it stays to reap the child and logs its close; a late exit
/// 3 still means no window ever opened, and takes the terminal route as
/// the player's watcher does. Nothing waits on it: the tray loop runs on,
/// and the pages never ride an exiting launcher.
fn watch_player_page(mut child: std::process::Child, ctx: PageFallback) {
    std::thread::spawn(move || {
        let pid = child.id();
        let name = ctx.page.window_name();
        let start = Instant::now();
        let act = |verdict: PageVerdict| {
            let ms = start.elapsed().as_millis();
            match (page_outcome(verdict), verdict) {
                (PageAction::Terminal, _) => {
                    ctx.log.line(&format!(
                        "{name} (pid {pid}) could not open a window (exit {PLAYER_NO_WINDOW}{}) after {ms} ms - falling back to the terminal route",
                        last_words(&ctx.output)
                    ));
                    open_page_in_terminal(Some(&ctx.player_bin), ctx.page, &ctx.server_url, &ctx.data_home, &ctx.fallback, &ctx.log);
                }
                (PageAction::Browser, PageVerdict::Failed(code)) => {
                    ctx.log.line(&format!(
                        "{name} (pid {pid}) failed ({}{}) after {ms} ms - {}",
                        exit_words(code),
                        last_words(&ctx.output),
                        ctx.page.browser_words()
                    ));
                    let _ = open::that_detached(&ctx.fallback);
                }
                (_, PageVerdict::Up) => ctx.log.line(&format!("{name} (pid {pid}) is up")),
                (_, PageVerdict::Failed(code) | PageVerdict::Closed(code)) => {
                    ctx.log.line(&format!("{name} (pid {pid}) closed after {ms} ms ({})", exit_words(code)))
                }
                (_, PageVerdict::Watching | PageVerdict::NoWindow) => unreachable!("the loop only breaks on a decision; no window is the terminal's"),
            }
        };
        let verdict = loop {
            let state = match child.try_wait() {
                Ok(Some(st)) => ChildState::Exited(st.code()),
                Ok(None) => ChildState::Running,
                Err(e) => {
                    ctx.log.line(&format!("{name} (pid {pid}): cannot watch it ({e}) - leaving it be"));
                    return;
                }
            };
            match page_verdict(state, start.elapsed()) {
                PageVerdict::Watching => std::thread::sleep(WINDOW_POLL),
                v => break v,
            }
        };
        act(verdict);
        if verdict == PageVerdict::Up {
            // Up only meant "still running at the watch's end": its close
            // reads through the same table, past the watch — exit 3 is the
            // terminal route still, anything else a close.
            match child.wait() {
                Ok(st) => act(page_verdict(ChildState::Exited(st.code()), start.elapsed())),
                Err(e) => ctx.log.line(&format!("{name} (pid {pid}): wait failed: {e}")),
            }
        }
    });
}

fn exit_words(code: Option<i32>) -> String {
    match code {
        Some(c) => format!("exit {c}"),
        None => "killed by a signal".into(),
    }
}

/// `: <the child's last output line>` for a failure's log line — bounded,
/// and empty when it said nothing.
fn last_words(output: &Path) -> String {
    let text = std::fs::read(output).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    match text.lines().rev().map(str::trim).find(|l| !l.is_empty()) {
        Some(line) => format!(": {}", line.chars().take(200).collect::<String>()),
        None => String::new(),
    }
}

/// Is a desktop player holding its instance lock? The lock is tried and,
/// when won, released at once: the player takes it for real within its
/// first moments, and an open sneaking into that gap is answered by the
/// player's own refusal (it prints one line and leaves). Err is the lock
/// file itself being unusable — the caller opens the player regardless.
fn desktop_player_running(lock: &Path) -> Result<bool, String> {
    let mut file = fslock::LockFile::open(lock.as_os_str()).map_err(|e| format!("{}: {e}", lock.display()))?;
    let won = file.try_lock().map_err(|e| format!("{}: {e}", lock.display()))?;
    if won {
        let _ = file.unlock();
    }
    Ok(!won)
}

/// Spawn a server generation plus its two helper threads.
fn spawn_generation(
    shared: &Arc<Shared>,
    bin: &Path,
    server_args: &[String],
    server_log: &Path,
    ep: paths::Endpoint,
    proxy: &tao::event_loop::EventLoopProxy<AppEvent>,
    log: &Logger,
) -> Result<(), String> {
    let proc = server::spawn(bin, server_args, server_log).map_err(|e| e.to_string())?;
    let generation = shared.generation.fetch_add(1, Ordering::SeqCst) + 1;
    *shared.proc.lock().unwrap() = Some(proc);
    log.line(&format!("server generation {generation} spawned"));

    // Health prober: poll until the endpoint answers as mStream (an identity
    // probe, not a bare connect — see wait_serving), then report up — or,
    // past BOOT_TIMEOUT, report that it gave up so the loop can tell a
    // still-alive-but-unverifiable server from one that is still starting.
    {
        let proxy = proxy.clone();
        std::thread::spawn(move || {
            let _ = proxy.send_event(if server::wait_serving(ep, BOOT_TIMEOUT) {
                AppEvent::ServerUp(generation)
            } else {
                AppEvent::ProbeGaveUp(generation)
            });
        });
    }
    // Exit watcher: polls try_wait (wait() would hold the mutex across a
    // block and deadlock the quit path). Generation-stamped so a watcher
    // outliving a restart can't misreport the replacement child.
    {
        let proxy = proxy.clone();
        let shared = shared.clone();
        std::thread::spawn(move || loop {
            if shared.generation.load(Ordering::SeqCst) != generation {
                return; // superseded by a restart
            }
            {
                let mut guard = shared.proc.lock().unwrap();
                match guard.as_mut().map(|p| p.child.try_wait()) {
                    Some(Ok(Some(_))) | None => {
                        drop(guard);
                        let _ = proxy.send_event(AppEvent::ServerExited(generation));
                        return;
                    }
                    Some(Ok(None)) => {}
                    Some(Err(_)) => {
                        drop(guard);
                        let _ = proxy.send_event(AppEvent::ServerExited(generation));
                        return;
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(500));
        });
    }
    Ok(())
}

/// The status line's minute tick for one server generation: sleep to each
/// minute boundary counted from `since` (so the shown minutes are exact,
/// not up to a minute stale) and nudge the loop with a generation-stamped
/// Tick. Ends on its own once a restart moves the generation on; a stopped
/// server keeps a harmless one-wake-a-minute ticker until then. See
/// AppEvent::Tick for why this is a thread and not ControlFlow::WaitUntil.
fn start_ticker(
    shared: &Arc<Shared>,
    generation: u64,
    since: Instant,
    proxy: &tao::event_loop::EventLoopProxy<AppEvent>,
) {
    let proxy = proxy.clone();
    let shared = shared.clone();
    std::thread::spawn(move || loop {
        let at = next_minute_boundary(since, Instant::now());
        std::thread::sleep(at.saturating_duration_since(Instant::now()));
        if shared.generation.load(Ordering::SeqCst) != generation {
            return; // superseded by a restart
        }
        if proxy.send_event(AppEvent::Tick(generation)).is_err() {
            return; // the loop is gone
        }
    });
}

/// Move `path` aside to `path.1` (replacing any previous `.1`). With a cap,
/// only when the file has outgrown it; with None, whenever it exists. Rename
/// is atomic-enough and never blocks on a reader; all failures are ignored —
/// log hygiene must never be the reason the launcher dies.
fn rotate_log(path: &Path, keep_if_under: Option<u64>) {
    let rotate = match (keep_if_under, std::fs::metadata(path)) {
        (_, Err(_)) => false,
        (None, Ok(_)) => true,
        (Some(cap), Ok(m)) => m.len() > cap,
    };
    if rotate {
        let mut rotated = path.as_os_str().to_owned();
        rotated.push(".1");
        let _ = std::fs::rename(path, PathBuf::from(rotated));
    }
}

fn stop_current(shared: &Arc<Shared>) {
    // Bump the generation FIRST so watcher threads stand down and this stop
    // is never reported as an unexpected exit.
    shared.generation.fetch_add(1, Ordering::SeqCst);
    if let Some(mut proc) = shared.proc.lock().unwrap().take() {
        server::stop(&mut proc, STOP_GRACE);
    }
}

/// What clicking the update menu item does in its current state.
#[derive(Clone, Debug, PartialEq, Eq)]
enum UpdateAction {
    None,
    OpenReleases,
    /// Managed layout with a staged version: quit-path teardown, then spawn
    /// the launcher behind `current` with --takeover.
    Relaunch,
    /// Windows Inno install with a verified downloaded installer: the
    /// server stops, the silent installer runs, and its [Run] entry
    /// relaunches the tray afterwards.
    RunInstaller(PathBuf),
    /// macOS .pkg install with a verified downloaded installer: opened in
    /// Installer.app, and nothing else. Installer.app needs a human, who may
    /// cancel it, so the server keeps serving and the tray keeps running;
    /// the pkg's postinstall (build/pkg-postinstall.sh) is what restarts
    /// the running launcher into the new version, with --takeover, once the
    /// install has really happened.
    OpenInstaller(PathBuf),
    /// macOS .pkg install with no verified installer on disk yet (notify
    /// mode, a background download that failed or has not started): the
    /// browser downloads the release's .pkg, and the human opens it from
    /// there. The URL is always the one built here (pkg_download_url:
    /// GitHub's tag-pinned asset, or the operator's mirror's copy), never
    /// the status file's: the file's downloadUrl only confirms it, by
    /// naming the same string. Nothing stops and nothing exits, as with
    /// OpenInstaller. Never offered for a release the server withholds
    /// (paths::UpdateStatus::latest_withheld), nor when the server names a
    /// download other than the one built here, a URL or not.
    DownloadInstaller(String),
}

impl UpdateAction {
    /// Whether this action hands the install to a new process and ends this
    /// launcher (perform_apply) — the only kind the server's apply request
    /// may trigger unasked. OpenInstaller and DownloadInstaller are not:
    /// both wait on a human, so only a click starts either.
    fn is_handoff(&self) -> bool {
        matches!(self, UpdateAction::Relaunch | UpdateAction::RunInstaller(_))
    }
}

/// The native-installer family of the host the launcher runs on — a
/// parameter of the update view rather than a cfg inside it, so the tests
/// pin every platform's rule on every host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InstallerHost {
    /// The Inno setup.exe, run silently (UpdateAction::RunInstaller).
    Windows,
    /// The .pkg, opened in Installer.app once the server downloaded it
    /// (UpdateAction::OpenInstaller), downloaded by the browser before then
    /// (UpdateAction::DownloadInstaller).
    MacOs,
    /// No installer the launcher hands off to: Linux installs update
    /// through their packages or the managed layout.
    Other,
}

const THIS_INSTALLER_HOST: InstallerHost = if cfg!(windows) {
    InstallerHost::Windows
} else if cfg!(target_os = "macos") {
    InstallerHost::MacOs
} else {
    InstallerHost::Other
};

/// Where the server's updater downloads native installers (validated
/// against, never trusted from the status file alone).
fn updates_dir() -> PathBuf {
    paths::data_home().join("updates")
}

/// The version shown in the status line: the running server's own report
/// (status file), else the version this launcher was built into the bundle
/// with (build.rs stamp) — present before the server's first boot.
fn version_label(s: Option<&paths::UpdateStatus>) -> String {
    s.and_then(|s| s.current.clone())
        .unwrap_or_else(|| env!("MSTREAM_BUNDLE_VERSION").to_string())
}

/// The installer path the launcher will actually run or open: must sit
/// directly in OUR updates dir (where the server's stageInstaller writes
/// it), carry this host's asset name and exist. Everything else in the
/// status file's installerPath is ignored — the file is another process's
/// data, not an instruction stream.
fn valid_installer(p: Option<&Path>, updates_dir: &Path, host: InstallerHost) -> Option<PathBuf> {
    let p = p?;
    // The parent itself, not starts_with: a `..` component would pass a
    // prefix test and still point elsewhere.
    if p.parent() != Some(updates_dir) {
        return None;
    }
    let name = p.file_name()?.to_str()?;
    (installer_name_ok(name, host) && p.exists()).then(|| p.to_path_buf())
}

/// The release asset names the server downloads (installerAssetName in
/// src/util/update-check.js): `mStream-<version>-win-x64-setup.exe` on
/// Windows, `mStream-<version>-darwin-<arm64|x64>.pkg` on macOS, nothing
/// elsewhere. The version must be made of a version's characters, so the
/// name cannot smuggle anything else between the fixed parts.
fn installer_name_ok(name: &str, host: InstallerHost) -> bool {
    let suffixes: &[&str] = match host {
        InstallerHost::Windows => &["-win-x64-setup.exe"],
        InstallerHost::MacOs => &["-darwin-arm64.pkg", "-darwin-x64.pkg"],
        InstallerHost::Other => &[],
    };
    let Some(rest) = name.strip_prefix("mStream-") else { return false };
    suffixes.iter().any(|suffix| {
        rest.strip_suffix(suffix).is_some_and(|v| {
            v.starts_with(|c: char| c.is_ascii_digit())
                && v.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
        })
    })
}

/// The name of release `version`'s .pkg for a `cpu` Mac (`arm64` or
/// `x64`), installerAssetName in update-check.js, or None when the version
/// is not a plain X.Y.Z (paths::sanitize_version: the status file's
/// `latest` has passed it already, and the name does not rely on that) or
/// the CPU is one no release builds for.
fn pkg_asset_name(version: &str, cpu: &str) -> Option<String> {
    let v = paths::sanitize_version(version)?;
    matches!(cpu, "arm64" | "x64").then(|| format!("mStream-{v}-darwin-{cpu}.pkg"))
}

/// The direct download of release `version`'s .pkg for a `cpu` Mac, built
/// as update-check.js's assetUrl builds it in the server: the tag-pinned
/// GitHub asset, or the file of that name in the flat directory a mirror
/// serves (`mirror`, paths::release_mirror). None where pkg_asset_name has
/// no name, and for a mirror that would not make an http(s) URL of
/// paths::download_url_shaped's shape: the server fetches over nothing
/// else (isAcceptedUrl in ffmpeg-bootstrap.js), and the browser's opener
/// is handed nothing else.
fn pkg_download_url(version: &str, cpu: &str, mirror: Option<&str>) -> Option<String> {
    let name = pkg_asset_name(version, cpu)?;
    let Some(base) = mirror else {
        // A name exists only for a plain X.Y.Z, so `version` is one here.
        return Some(format!("{RELEASE_DOWNLOAD_BASE}/v{version}/{name}"));
    };
    let url = format!("{}/{name}", base.trim_end_matches('/'));
    let http = url.starts_with("https://") || url.starts_with("http://");
    (http && paths::download_url_shaped(&url)).then_some(url)
}

/// The update line's text + action for a given status-file state. Pure so
/// the matrix is unit-testable; `relaunch_ok` is whether
/// derive_relaunch_target currently resolves (a staged update on a layout
/// we can't relaunch from renders informational, not clickable), and
/// `host` whose installers this launcher hands off to (THIS_INSTALLER_HOST
/// outside the tests). A downloaded installer the host cannot use, or one
/// that fails valid_installer, falls through to the availability line: on
/// a Mac's .pkg install the release's own .pkg ("Download update"), from
/// `mirror` when one is set (paths::release_mirror outside the tests); the
/// releases page ("Update available") elsewhere, for a release the server
/// withholds, and when the server names a download other than that one.
fn update_item_view(
    s: Option<&paths::UpdateStatus>,
    updates_dir: &Path,
    relaunch_ok: bool,
    host: InstallerHost,
    mirror: Option<&str>,
) -> (String, UpdateAction) {
    let Some(s) = s else {
        return (
            format!("Up to date ({})", env!("MSTREAM_BUNDLE_VERSION")),
            UpdateAction::None,
        );
    };
    if s.downloading {
        return ("Downloading update…".to_string(), UpdateAction::None);
    }
    if s.staged {
        if let Some(v) = &s.staged_version {
            let is_new = s.current.as_ref().is_none_or(|c| c != v);
            if is_new {
                match s.method.as_deref() {
                    Some("managed") if relaunch_ok => {
                        return (format!("Restart to update to {v}"), UpdateAction::Relaunch);
                    }
                    Some("managed") => {
                        return (
                            format!("Update {v} staged - restart mStream to finish"),
                            UpdateAction::None,
                        );
                    }
                    Some("inno") if host == InstallerHost::Windows => {
                        if let Some(p) = valid_installer(s.installer_path.as_deref(), updates_dir, host) {
                            return (format!("Install update {v}"), UpdateAction::RunInstaller(p));
                        }
                    }
                    Some("pkg") if host == InstallerHost::MacOs => {
                        if let Some(p) = valid_installer(s.installer_path.as_deref(), updates_dir, host) {
                            return (format!("Install update {v}"), UpdateAction::OpenInstaller(p));
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    if s.available {
        if let Some(v) = &s.latest {
            // A .pkg install's click fetches the installer itself, not the
            // page that lists it: the Mac is one double-click from the
            // update even when the server downloaded nothing. Not for a
            // release the server withholds (skipped, held, or a feed this
            // server cannot read): the server refuses to fetch it, so the
            // tray keeps to the line and the page it always showed.
            if host == InstallerHost::MacOs && s.method.as_deref() == Some("pkg") && !s.latest_withheld() {
                // The URL is built here, from the mirror the server fetches
                // from too (it is this launcher's child). What the server
                // knows and the launcher does not is whether the release
                // carries this install's .pkg at all (downloadUrlFor: the
                // asset's URL when the manifest lists it, the releases page
                // when not), so its downloadUrl is read as that answer and
                // nothing more: the same string as the one built here is
                // yes. Anything else it names keeps the page: the releases
                // page (the URL built here would 404), another file or host
                // (the file's URLs are never opened), a value the status
                // parse refused, a file left by a run that saw another
                // mirror. Only a status file that names no download at all
                // gets the built URL unconfirmed.
                let built = pkg_download_url(v, THIS_PKG_CPU, mirror);
                let url = match &s.download_url {
                    paths::DownloadUrl::Absent => built,
                    paths::DownloadUrl::Named(named) => built.filter(|b| b == named),
                    paths::DownloadUrl::Unusable => None,
                };
                if let Some(url) = url {
                    return (format!("Download update {v}"), UpdateAction::DownloadInstaller(url));
                }
            }
            return (format!("Update available ({v})"), UpdateAction::OpenReleases);
        }
    }
    (
        format!(
            "Up to date ({})",
            s.current.as_deref().unwrap_or(env!("MSTREAM_BUNDLE_VERSION"))
        ),
        UpdateAction::None,
    )
}

/// Push the view into the held menu item — only on change, so the text is
/// never re-set under a hovering cursor. Returns the action for the caller.
fn render_update_item(
    item: Option<&MenuItem>,
    s: Option<&paths::UpdateStatus>,
    updates_dir: &Path,
    relaunch_ok: bool,
    last_text: &mut String,
) -> UpdateAction {
    let (text, action) =
        update_item_view(s, updates_dir, relaunch_ok, THIS_INSTALLER_HOST, paths::release_mirror().as_deref());
    if let Some(i) = item {
        if text != *last_text {
            i.set_text(text.clone());
            i.set_enabled(action != UpdateAction::None);
            *last_text = text;
        }
    }
    action
}

/// How many failed applies one staged version gets before auto-apply
/// stands down for it (the tray menu still allows manual retries).
const MAX_APPLY_FAILURES: u32 = 2;

/// True when auto-apply should stand down: this staged version has already
/// burned its failure budget. Pure for the tests; None staged never caps.
fn auto_apply_capped(failures: &Option<(String, u32)>, staged: Option<&str>) -> bool {
    match (failures, staged) {
        (Some((v, n)), Some(s)) => v == s && *n >= MAX_APPLY_FAILURES,
        _ => false,
    }
}

fn record_apply_failure(failures: &mut Option<(String, u32)>, staged: Option<&str>, log: &Logger) {
    let Some(s) = staged else { return };
    let n = match failures {
        Some((v, n)) if v == s => *n + 1,
        _ => 1,
    };
    *failures = Some((s.to_string(), n));
    if n >= MAX_APPLY_FAILURES {
        log.line(&format!(
            "update: {n} failed applies for {s} - auto-apply stands down for this version (use the tray menu to retry)"
        ));
    }
}

/// The identity of an apply request: the server's applyRequestedAt stamp,
/// else (an older server writing no stamp) the staged version. A failed
/// attempt consumes exactly this token; a fresh request mints a new one.
fn auto_apply_token(s: &paths::UpdateStatus) -> Option<String> {
    s.apply_requested_at.clone().or_else(|| s.staged_version.clone())
}

/// Reclaim ~/Applications/mStream.app.old.* asides. Called only right after
/// the single-instance lock is won: previous launcher sessions (whose
/// processes report the ORIGINAL ~/Applications path even after their tree
/// was renamed aside) are provably dead, so the only live risk is something
/// launched directly FROM an aside path — which pgrep sees and spares.
#[cfg(target_os = "macos")]
fn sweep_apps_asides(log: &Logger) {
    let apps = paths::home_dir().join("Applications");
    let Ok(entries) = std::fs::read_dir(&apps) else { return };
    for e in entries.flatten() {
        let name = e.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with("mStream.app.old.") {
            continue;
        }
        let p = e.path();
        // Metacharacters in the path (a '+' or brackets in the user name)
        // must match themselves — an ERE that silently narrows would read
        // a live tree as idle.
        let pat = format!("^{}/", crate::paths::escape_ere(&p.display().to_string()));
        let pgrep_busy = std::process::Command::new("/usr/bin/pgrep")
            .arg("-f")
            .arg(&pat)
            .output()
            // pgrep: 1 = no match; anything else (match, or pgrep itself
            // failing) counts as busy — never delete blind.
            .map(|o| o.status.code() != Some(1))
            .unwrap_or(true);
        // lsof sees what argv text cannot: a process whose cwd or open
        // files live inside the tree (someone cd'd in and ran the server
        // by relative path). Any output — or lsof failing — is busy.
        let lsof_busy = std::process::Command::new("/usr/sbin/lsof")
            .arg("+D")
            .arg(&p)
            .output()
            .map(|o| !o.stdout.is_empty())
            .unwrap_or(true);
        if pgrep_busy || lsof_busy {
            continue;
        }
        log.line(&format!("sweeping stale ~/Applications aside {name}"));
        let _ = std::fs::remove_dir_all(&p);
    }
}

fn relaunch_target_exists(exe: Option<&Path>) -> bool {
    exe.and_then(paths::derive_relaunch_target).is_some()
}

/// Stop the child, then hand off to the update: spawn the new launcher
/// (managed) or the verified installer (inno). Ok = a handoff process is
/// running and the caller must exit the loop NOW; Err = nothing was spawned
/// and the caller must recover — the server is already stopped. An action
/// that is no handoff (UpdateAction::is_handoff) is refused before
/// anything stops.
fn perform_apply(
    shared: &Arc<Shared>,
    action: &UpdateAction,
    exe_real: Option<&Path>,
    server_args: &[String],
    log: &Logger,
) -> Result<(), String> {
    if !action.is_handoff() {
        return Err("not an applicable update action".to_string());
    }
    shared.quitting.store(true, Ordering::SeqCst);
    stop_current(shared);
    match action {
        UpdateAction::Relaunch => {
            let target = exe_real
                .and_then(paths::derive_relaunch_target)
                .ok_or_else(|| "no relaunch target under a managed layout".to_string())?;
            log.line(&format!("update: relaunching via {}", target.display()));
            platform::relaunch(&target, server_args)
        }
        #[cfg(windows)]
        UpdateAction::RunInstaller(p) => {
            log.line(&format!("update: running installer {}", p.display()));
            platform::spawn_installer_detached(p, true)
        }
        _ => Err("not an applicable update action".to_string()),
    }
}

/// A failed handoff left the server stopped: bring it back and say so. The
/// launcher survives; the update stays offered for a later retry.
#[allow(clippy::too_many_arguments)]
fn recover_after_failed_apply(
    shared: &Arc<Shared>,
    bin: &Path,
    server_args: &[String],
    server_log: &Path,
    ep: paths::Endpoint,
    proxy: &tao::event_loop::EventLoopProxy<AppEvent>,
    log: &Logger,
) -> Phase {
    shared.quitting.store(false, Ordering::SeqCst);
    match spawn_generation(shared, bin, server_args, server_log, ep, proxy, log) {
        Ok(()) => Phase::Starting,
        Err(e) => {
            platform::fatal_alert(&format!("mStream could not restart its server:\n{e}"));
            Phase::Stopped
        }
    }
}

/// The boot watchdog's decision + execution: roll a managed layout back to
/// the previous version after repeated crash-before-serving boots (see
/// rollback.rs for the full contract). Returns the launcher face to hand
/// off to, or None when rollback does not apply (not a managed layout,
/// `current` not committed to us, nothing usable to roll back to) — the
/// caller then falls through to the Stopped-with-dialog behavior.
fn attempt_boot_rollback(exe_real: Option<&Path>, log: &Logger) -> Option<PathBuf> {
    let data_home = paths::data_home();
    let plan = rollback::plan_rollback(
        exe_real,
        env!("MSTREAM_BUNDLE_VERSION"),
        &paths::home_dir(),
        &data_home,
        &rollback::probe_server,
    )?;
    log.line(&format!(
        "update watchdog: mStream {} cannot boot here - rolling back to {}",
        plan.failed_version, plan.target_version
    ));
    match rollback::execute_rollback(&plan, &data_home, &|m| log.line(m)) {
        Ok(face) => Some(face),
        Err(e) => {
            log.line(&format!("update watchdog: rollback failed: {e}"));
            None
        }
    }
}

/// The server's lifecycle as the tray reports it. Running carries the
/// instant the identity probe first answered (ServerUp), which is what the
/// uptime counts from; Unverified is a child that outlived the probe's
/// patience without ever answering it (an SSL-only config, a bind the
/// plaintext probe can't reach) — alive and presumably serving, counted
/// from its spawn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Starting,
    Running { since: Instant },
    Unverified { since: Instant },
    Stopped,
}

impl Phase {
    /// The disabled first menu line. `ver` is the server version the status
    /// file reports (fallback: the bundle version baked in at build time) —
    /// on the line so "what version am I running" is one glance at the tray.
    fn menu_text(&self, ver: &str) -> String {
        match self {
            Phase::Starting => format!("mStream {ver} · starting…"),
            Phase::Running { since } => format!("mStream {ver} · up {}", format_uptime(since.elapsed())),
            Phase::Unverified { since } => {
                format!("mStream {ver} · up {} (unverified)", format_uptime(since.elapsed()))
            }
            Phase::Stopped => format!("mStream {ver} · stopped — use Restart server"),
        }
    }

    /// The icon tooltip (Windows/macOS; tray-icon's Linux tooltip is a
    /// no-op, so the menu line is the cross-platform carrier).
    fn tooltip(&self, url: &str, ver: &str) -> String {
        match self {
            Phase::Starting => format!("mStream {ver} - starting"),
            Phase::Running { since } => format!("mStream {ver} - {url} (up {})", format_uptime(since.elapsed())),
            Phase::Unverified { since } => {
                format!("mStream {ver} - {url} (up {}, not verified by the launcher)", format_uptime(since.elapsed()))
            }
            Phase::Stopped => format!("mStream {ver} - stopped (use Restart server)"),
        }
    }

    /// Whether the status line carries an uptime that a minute tick must
    /// refresh.
    fn ticks(&self) -> bool {
        matches!(self, Phase::Running { .. } | Phase::Unverified { .. })
    }
}

/// Push the phase into the status line and tooltip. Both handles are
/// Options because the tray can be degraded away (no StatusNotifier host)
/// while the loop, and the server, carry on.
fn show_status(item: Option<&MenuItem>, tray: Option<&TrayIcon>, phase: &Phase, url: &str, ver: &str) {
    if let Some(i) = item {
        i.set_text(phase.menu_text(ver));
    }
    if let Some(t) = tray {
        let _ = t.set_tooltip(Some(phase.tooltip(url, ver)));
    }
}

/// The first minute boundary after `now`, counted from `since`. A timer
/// that fires a hair early lands on the same boundary again — one cheap
/// extra wake, then the value flips; never a skipped or a stale minute.
fn next_minute_boundary(since: Instant, now: Instant) -> Instant {
    let elapsed = now.saturating_duration_since(since);
    since + Duration::from_secs((elapsed.as_secs() / 60 + 1) * 60)
}

/// Uptime at the resolution the tick refreshes it: the two most significant
/// units, `uptime(1)`-style, so a menu line never grows past "12d 3h".
fn format_uptime(d: Duration) -> String {
    let mins = d.as_secs() / 60;
    let (days, hours, minutes) = (mins / 1440, (mins / 60) % 24, mins % 60);
    if mins == 0 {
        "<1m".to_string()
    } else if days > 0 {
        format!("{days}d {hours}h")
    } else if hours > 0 {
        format!("{hours}h {minutes}m")
    } else {
        format!("{minutes}m")
    }
}

/// Tray icon: the repo logo (build/icon.png), embedded at compile time; a
/// plain fallback square if decoding ever fails — an icon must never be the
/// reason the launcher dies.
fn load_icon() -> Icon {
    fn decode() -> Option<(Vec<u8>, u32, u32)> {
        let bytes: &[u8] = include_bytes!("../../build/icon.png");
        let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
        let mut reader = decoder.read_info().ok()?;
        let mut buf = vec![0u8; reader.output_buffer_size()?];
        let info = reader.next_frame(&mut buf).ok()?;
        buf.truncate(info.buffer_size());
        let rgba = match info.color_type {
            png::ColorType::Rgba => buf,
            png::ColorType::Rgb => buf.as_chunks::<3>().0.iter().flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
            _ => return None,
        };
        Some((rgba, info.width, info.height))
    }
    let (rgba, w, h) = decode().unwrap_or_else(|| ([124, 77, 255, 255].repeat(32 * 32), 32, 32));
    Icon::from_rgba(rgba, w, h).unwrap_or_else(|_| {
        Icon::from_rgba([124, 77, 255, 255].repeat(32 * 32), 32, 32).expect("solid icon")
    })
}

#[derive(Clone)]
struct Logger(std::path::PathBuf);

impl Logger {
    fn line(&self, msg: &str) {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if let Ok(mut f) = std::fs::File::options().create(true).append(true).open(&self.0) {
            let _ = writeln!(f, "[{ts}] {msg}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: u64 = 60;
    const HOUR: u64 = 60 * MIN;
    const DAY: u64 = 24 * HOUR;

    #[test]
    fn the_window_watch_decides_from_the_exit_and_the_clock() {
        let ms = Duration::from_millis;
        let early = ms(300);
        let late = WINDOW_WATCH + ms(50);
        // Still running: keep looking inside the watch, done after it.
        assert_eq!(window_verdict(ChildState::Running, ms(0)), WindowVerdict::Watching);
        assert_eq!(window_verdict(ChildState::Running, WINDOW_WATCH - ms(1)), WindowVerdict::Watching);
        assert_eq!(window_verdict(ChildState::Running, WINDOW_WATCH), WindowVerdict::Up);
        assert_eq!(window_verdict(ChildState::Running, late), WindowVerdict::Up);
        // Exit 3 inside the watch: no window could open - the terminal route.
        assert_eq!(window_verdict(ChildState::Exited(Some(3)), early), WindowVerdict::NoWindow);
        assert_eq!(PLAYER_NO_WINDOW, 3, "the player's gui::window::NO_WINDOW");
        // Exit 0 inside the watch: the instance lock refused it - focus.
        assert_eq!(window_verdict(ChildState::Exited(Some(0)), early), WindowVerdict::Refused);
        // Anything else inside the watch: the terminal route, with the code.
        assert_eq!(window_verdict(ChildState::Exited(Some(1)), early), WindowVerdict::Failed(Some(1)));
        assert_eq!(window_verdict(ChildState::Exited(Some(101)), early), WindowVerdict::Failed(Some(101)));
        assert_eq!(window_verdict(ChildState::Exited(None), early), WindowVerdict::Failed(None), "a signal");
        // An exit seen only past the watch is a window that was up and
        // closed - never a fallback, whatever the code, except 3: no window
        // ever opened, so the terminal route is still owed.
        for code in [Some(0), Some(1), None] {
            assert_eq!(window_verdict(ChildState::Exited(code), late), WindowVerdict::Closed(code), "{code:?}");
        }
        assert_eq!(window_verdict(ChildState::Exited(Some(3)), late), WindowVerdict::NoWindow, "a late exit 3");
        assert!(WINDOW_WATCH >= Duration::from_secs(3) && WINDOW_WATCH <= Duration::from_secs(10));
    }

    #[test]
    fn the_page_watch_never_refuses_and_takes_exit_3_at_any_time() {
        let ms = Duration::from_millis;
        let early = ms(300);
        let late = WINDOW_WATCH + ms(50);
        // The window route's clock: look again inside the watch, up after it.
        assert_eq!(page_verdict(ChildState::Running, ms(0)), PageVerdict::Watching);
        assert_eq!(page_verdict(ChildState::Running, WINDOW_WATCH - ms(1)), PageVerdict::Watching);
        assert_eq!(page_verdict(ChildState::Running, WINDOW_WATCH), PageVerdict::Up);
        assert_eq!(page_verdict(ChildState::Running, late), PageVerdict::Up);
        // Exit 0 is a close at any time — Esc on the Done page a moment in
        // is a user who was done, never a refusal (a page holds no lock).
        assert_eq!(page_verdict(ChildState::Exited(Some(0)), early), PageVerdict::Closed(Some(0)));
        assert_eq!(page_verdict(ChildState::Exited(Some(0)), ms(0)), PageVerdict::Closed(Some(0)));
        assert_eq!(page_verdict(ChildState::Exited(Some(0)), late), PageVerdict::Closed(Some(0)));
        // Exit 3 at any time: no window ever opened.
        assert_eq!(page_verdict(ChildState::Exited(Some(PLAYER_NO_WINDOW)), early), PageVerdict::NoWindow);
        assert_eq!(page_verdict(ChildState::Exited(Some(PLAYER_NO_WINDOW)), late), PageVerdict::NoWindow, "a late exit 3");
        // Any other exit inside the watch failed in the window, with its code.
        assert_eq!(page_verdict(ChildState::Exited(Some(1)), early), PageVerdict::Failed(Some(1)), "a frame error");
        assert_eq!(page_verdict(ChildState::Exited(Some(2)), early), PageVerdict::Failed(Some(2)), "clap refused the argv");
        assert_eq!(page_verdict(ChildState::Exited(None), early), PageVerdict::Failed(None), "a signal");
        // Past the watch, the window was up and has closed, whatever the code.
        for code in [Some(1), Some(101), None] {
            assert_eq!(page_verdict(ChildState::Exited(code), late), PageVerdict::Closed(code), "{code:?}");
        }
    }

    #[test]
    fn a_pages_outcome_is_a_terminal_for_no_window_and_the_browser_for_a_failure() {
        assert_eq!(page_outcome(PageVerdict::NoWindow), PageAction::Terminal);
        assert_eq!(page_outcome(PageVerdict::Failed(Some(1))), PageAction::Browser);
        assert_eq!(page_outcome(PageVerdict::Failed(Some(101))), PageAction::Browser);
        assert_eq!(page_outcome(PageVerdict::Failed(None)), PageAction::Browser, "a signal");
        for quiet in [PageVerdict::Watching, PageVerdict::Up, PageVerdict::Closed(Some(0)), PageVerdict::Closed(Some(1)), PageVerdict::Closed(None)] {
            assert_eq!(page_outcome(quiet), PageAction::Nothing, "{quiet:?}");
        }
        // The reserved "abandoned" exit is a close at every layer and at any
        // time: the verdict says Closed, and the table takes no fallback.
        for at in [Duration::from_millis(300), WINDOW_WATCH] {
            let verdict = page_verdict(ChildState::Exited(Some(PAGE_ABANDONED)), at);
            assert_eq!(verdict, PageVerdict::Closed(Some(PAGE_ABANDONED)), "{at:?}");
            assert_eq!(page_outcome(verdict), PageAction::Nothing, "{at:?}");
        }
        assert!(![0, 1, PLAYER_NO_WINDOW].contains(&PAGE_ABANDONED), "the reserved code stays apart from the codes a page sends today: 0, 1 and 3");
        // The whole table end to end, as the watcher reads it.
        assert_eq!(page_outcome(page_verdict(ChildState::Exited(Some(0)), Duration::ZERO)), PageAction::Nothing);
        assert_eq!(page_outcome(page_verdict(ChildState::Exited(Some(3)), WINDOW_WATCH * 2)), PageAction::Terminal);
    }

    #[test]
    fn each_page_writes_a_log_of_its_own() {
        let home = Path::new("/data/home");
        let setup = player_page_log(home, TrayPage::Setup);
        let qc = player_page_log(home, TrayPage::QuickConnect);
        assert_eq!(setup, PathBuf::from("/data/home/logs/desktop-setup.log"));
        assert_eq!(qc, PathBuf::from("/data/home/logs/desktop-quick-connect.log"));
        assert_ne!(setup, qc);
        for page in [&setup, &qc] {
            assert_ne!(page, &player_window_log(home), "a page never truncates the player's log");
            assert_eq!(page.parent(), player_window_log(home).parent(), "beside it, in the logs dir");
        }
        // One argv per page on every route, never the player's.
        assert_eq!(TrayPage::Setup.player_page(), platform::PlayerPage::Setup);
        assert_eq!(TrayPage::QuickConnect.player_page(), platform::PlayerPage::QuickConnect);
        // The phrases support and the smokes read.
        assert_eq!(TrayPage::Setup.opener(), "first-run announce: setup wizard");
        assert_eq!(TrayPage::QuickConnect.opener(), "quick connect");
        assert!(TrayPage::Setup.terminal_failed("x").ends_with("opening the admin panel"));
        assert!(TrayPage::QuickConnect.terminal_failed("x").ends_with("falling back to the webapp"));
    }

    #[test]
    fn a_failures_log_line_carries_the_childs_last_words() {
        let dir = std::env::temp_dir().join(format!("mstream-launcher-lastwords-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let f = dir.join("out.log");
        std::fs::write(&f, "starting\nerror: no GPU adapter\n\n").unwrap();
        assert_eq!(last_words(&f), ": error: no GPU adapter");
        std::fs::write(&f, "").unwrap();
        assert_eq!(last_words(&f), "");
        assert_eq!(last_words(&dir.join("missing")), "");
        std::fs::write(&f, "x".repeat(1000)).unwrap();
        assert_eq!(last_words(&f).len(), 2 + 200, "bounded");
        assert_eq!(exit_words(Some(2)), "exit 2");
        assert_eq!(exit_words(None), "killed by a signal");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn uptime_shows_the_two_most_significant_units() {
        let f = |s: u64| format_uptime(Duration::from_secs(s));
        assert_eq!(f(0), "<1m");
        assert_eq!(f(59), "<1m", "sub-minute is <1m, never 0m");
        assert_eq!(f(MIN), "1m");
        assert_eq!(f(45 * MIN + 59), "45m", "seconds are dropped, not rounded up");
        assert_eq!(f(HOUR), "1h 0m");
        assert_eq!(f(3 * HOUR + 12 * MIN), "3h 12m");
        assert_eq!(f(DAY), "1d 0h");
        assert_eq!(f(3 * DAY + 4 * HOUR + 59 * MIN), "3d 4h", "minutes vanish once days show");
        assert_eq!(f(400 * DAY + 23 * HOUR), "400d 23h");
    }

    #[test]
    fn next_tick_lands_on_the_minute_boundary_after_now() {
        let t0 = Instant::now();
        let at = |secs_ms: (u64, u32)| t0 + Duration::new(secs_ms.0, secs_ms.1 * 1_000_000);
        assert_eq!(next_minute_boundary(t0, t0), at((60, 0)), "fresh: first boundary");
        assert_eq!(next_minute_boundary(t0, at((59, 900))), at((60, 0)), "just before: same boundary");
        assert_eq!(next_minute_boundary(t0, at((60, 0))), at((120, 0)), "on the boundary: the next one");
        assert_eq!(next_minute_boundary(t0, at((60, 1))), at((120, 0)), "just after: the next one");
        assert_eq!(next_minute_boundary(t0, at((3 * HOUR + 12 * MIN + 30, 0))), at((3 * HOUR + 13 * MIN, 0)));
        // A clock that reads BEFORE `since` (never expected; Instant is
        // monotonic) still yields the first boundary, not a panic.
        assert_eq!(next_minute_boundary(at((10, 0)), t0), at((70, 0)));
    }

    #[test]
    fn phase_texts() {
        let v = "6.21.2";
        assert_eq!(Phase::Starting.menu_text(v), "mStream 6.21.2 · starting…");
        assert_eq!(Phase::Stopped.menu_text(v), "mStream 6.21.2 · stopped — use Restart server");
        assert_eq!(Phase::Starting.tooltip("http://localhost:3000", v), "mStream 6.21.2 - starting");
        assert_eq!(
            Phase::Stopped.tooltip("http://localhost:3000", v),
            "mStream 6.21.2 - stopped (use Restart server)"
        );
        // A just-started server (Instant can't be rewound on a freshly
        // booted CI box; the big-number formatting is pinned above).
        let running = Phase::Running { since: Instant::now() };
        assert_eq!(running.menu_text(v), "mStream 6.21.2 · up <1m");
        assert_eq!(running.tooltip("http://localhost:3000", v), "mStream 6.21.2 - http://localhost:3000 (up <1m)");
        // A child that outlived the probe without answering it: alive,
        // presumably serving, and the tray must say so rather than
        // "Starting…" for the rest of the session.
        let unverified = Phase::Unverified { since: Instant::now() };
        assert_eq!(unverified.menu_text(v), "mStream 6.21.2 · up <1m (unverified)");
        assert_eq!(
            unverified.tooltip("http://localhost:3000", v),
            "mStream 6.21.2 - http://localhost:3000 (up <1m, not verified by the launcher)"
        );
        assert!(running.ticks());
        assert!(unverified.ticks());
        assert!(!Phase::Starting.ticks(), "no ticks unless an uptime is showing");
        assert!(!Phase::Stopped.ticks());
    }

    fn click(button: MouseButton, button_state: MouseButtonState) -> TrayIconEvent {
        TrayIconEvent::Click {
            id: tray_icon::TrayIconId::new("t"),
            position: tray_icon::dpi::PhysicalPosition::new(0.0, 0.0),
            rect: tray_icon::Rect::default(),
            button,
            button_state,
        }
    }

    #[test]
    fn only_a_left_release_on_the_icon_opens_the_player() {
        let pressed = AtomicBool::new(false);
        let plain = || false;
        let never_read = || -> bool { panic!("the modifiers are read at the left press only") };
        // The press says nothing yet; its release opens one player.
        assert_eq!(icon_click_of(&click(MouseButton::Left, MouseButtonState::Down), plain, &pressed), None);
        assert_eq!(
            icon_click_of(&click(MouseButton::Left, MouseButtonState::Up), never_read, &pressed),
            Some(IconClick::OpenPlayer)
        );
        // The right button pops the menu on its own; the middle one is
        // nobody's gesture.
        for state in [MouseButtonState::Down, MouseButtonState::Up] {
            assert_eq!(icon_click_of(&click(MouseButton::Right, state), never_read, &pressed), None, "{state:?}");
            assert_eq!(icon_click_of(&click(MouseButton::Middle, state), never_read, &pressed), None, "{state:?}");
        }
        // Windows' DoubleClick rides on top of the two clicks it is made of,
        // and the hover traffic never opens anything.
        let id = || tray_icon::TrayIconId::new("t");
        let position = tray_icon::dpi::PhysicalPosition::new(0.0, 0.0);
        let rect = tray_icon::Rect::default();
        for event in [
            TrayIconEvent::DoubleClick { id: id(), position, rect, button: MouseButton::Left },
            TrayIconEvent::Enter { id: id(), position, rect },
            TrayIconEvent::Move { id: id(), position, rect },
            TrayIconEvent::Leave { id: id(), position, rect },
        ] {
            assert_eq!(icon_click_of(&event, never_read, &pressed), None, "{event:?}");
        }
    }

    #[test]
    fn a_control_click_on_the_icon_shows_the_menu() {
        let pressed = AtomicBool::new(false);
        let down = click(MouseButton::Left, MouseButtonState::Down);
        let up = click(MouseButton::Left, MouseButtonState::Up);
        // Control held at the press: the menu, whatever Control does before
        // the release (AppKit judges a Control-click at mouse-down).
        assert_eq!(icon_click_of(&down, || true, &pressed), None);
        assert_eq!(icon_click_of(&up, || false, &pressed), Some(IconClick::ShowMenu));
        // The press's Control is spent on its own release, and Control
        // pressed only after the press makes no menu click: a plain click
        // opens the player again.
        assert_eq!(icon_click_of(&down, || false, &pressed), None);
        assert_eq!(icon_click_of(&up, || true, &pressed), Some(IconClick::OpenPlayer));
        // A right click, Control or not, leaves the next left click alone.
        assert_eq!(icon_click_of(&click(MouseButton::Right, MouseButtonState::Down), || true, &pressed), None);
        assert_eq!(icon_click_of(&click(MouseButton::Right, MouseButtonState::Up), || true, &pressed), None);
        assert_eq!(icon_click_of(&down, || false, &pressed), None);
        assert_eq!(icon_click_of(&up, || false, &pressed), Some(IconClick::OpenPlayer));
    }

    #[test]
    fn a_second_left_click_inside_the_debounce_is_ignored() {
        let t0 = Instant::now();
        let ms = Duration::from_millis;
        assert!(tray_click_acts(None, t0), "the session's first click acts");
        assert!(!tray_click_acts(Some(t0), t0 + ms(1)));
        assert!(!tray_click_acts(Some(t0), t0 + TRAY_CLICK_DEBOUNCE - ms(1)), "a double click's second half");
        assert!(tray_click_acts(Some(t0), t0 + TRAY_CLICK_DEBOUNCE));
        assert!(tray_click_acts(Some(t0), t0 + ms(3000)), "a deliberate second click, later");
        // A clock that reads before the last click (Instant is monotonic;
        // never expected) is ignored, not a panic.
        assert!(!tray_click_acts(Some(t0 + ms(10)), t0));
        // Long enough to swallow a double click at Windows' default speed,
        // short enough that no deliberate second click lands inside it.
        assert!(TRAY_CLICK_DEBOUNCE >= ms(300) && TRAY_CLICK_DEBOUNCE <= ms(1000));
    }

    fn status(json: &str) -> Option<crate::paths::UpdateStatus> {
        crate::paths::parse_update_status(json)
    }

    #[test]
    fn update_view_matrix() {
        let ud = std::path::Path::new("/data/updates");
        // Nothing here involves an installer, so every host renders it alike.
        for host in [InstallerHost::Windows, InstallerHost::MacOs, InstallerHost::Other] {
            let view = |s: Option<&crate::paths::UpdateStatus>, relaunch_ok: bool| update_item_view(s, ud, relaunch_ok, host, None);
            let view_m = |s: Option<&crate::paths::UpdateStatus>, mirror: Option<&str>| update_item_view(s, ud, true, host, mirror);
            // No file at all: bundle-version fallback, inert.
            let (t, a) = view(None, true);
            assert_eq!(t, format!("Up to date ({})", env!("MSTREAM_BUNDLE_VERSION")));
            assert_eq!(a, UpdateAction::None);
            // Up to date per the server.
            let s = status(r#"{"current":"6.21.2","available":false}"#);
            let (t, a) = view(s.as_ref(), true);
            assert_eq!(t, "Up to date (6.21.2)");
            assert_eq!(a, UpdateAction::None);
            // Downloading — the installer families included: a .pkg is ~150 MB.
            for method in ["managed", "inno", "pkg"] {
                let s = status(&format!(
                    r#"{{"current":"6.21.2","available":true,"latest":"6.22.0","method":"{method}","downloading":true}}"#
                ));
                let (t, a) = view(s.as_ref(), true);
                assert_eq!(t, "Downloading update…", "{method} on {host:?}");
                assert_eq!(a, UpdateAction::None, "{method} on {host:?}");
            }
            // Staged on a managed layout with a resolvable relaunch target.
            let s = status(
                r#"{"current":"6.21.2","available":true,"latest":"6.22.0","method":"managed",
                    "staged":true,"stagedVersion":"6.22.0"}"#,
            );
            let (t, a) = view(s.as_ref(), true);
            assert_eq!(t, "Restart to update to 6.22.0");
            assert_eq!(a, UpdateAction::Relaunch);
            // Same, but the layout can't be relaunched from: informational only.
            let (t, a) = view(s.as_ref(), false);
            assert_eq!(t, "Update 6.22.0 staged - restart mStream to finish");
            assert_eq!(a, UpdateAction::None);
            // Staged version already running (post-apply file lag): up to date.
            let s = status(
                r#"{"current":"6.22.0","available":false,"method":"managed",
                    "staged":true,"stagedVersion":"6.22.0"}"#,
            );
            let (t, a) = view(s.as_ref(), true);
            assert_eq!(t, "Up to date (6.22.0)");
            assert_eq!(a, UpdateAction::None);
            // Non-managed with an update: availability + the releases page.
            let s = status(r#"{"current":"6.21.2","available":true,"latest":"6.22.0","method":"docker"}"#);
            let (t, a) = view(s.as_ref(), true);
            assert_eq!(t, "Update available (6.22.0)");
            assert_eq!(a, UpdateAction::OpenReleases);
            // A pkg install the server has not downloaded for (notify mode,
            // a failed or not-yet-started background download): a Mac
            // downloads the release's own .pkg, never a page; any other
            // host (a status file that cannot be its own) the releases page.
            // With no downloadUrl in the file, the URL built here, unconfirmed.
            let s = status(r#"{"current":"6.21.2","available":true,"latest":"6.22.0","method":"pkg"}"#);
            let (t, a) = view(s.as_ref(), true);
            if host == InstallerHost::MacOs {
                assert_eq!(t, "Download update 6.22.0");
                assert_eq!(
                    a,
                    UpdateAction::DownloadInstaller(format!(
                        "https://github.com/IrosTheBeggar/mStream/releases/download/v6.22.0/mStream-6.22.0-darwin-{THIS_PKG_CPU}.pkg"
                    ))
                );
                assert!(!a.is_handoff());
            } else {
                assert_eq!(t, "Update available (6.22.0)", "{host:?}");
                assert_eq!(a, UpdateAction::OpenReleases, "{host:?}");
            }
            // The server names the download (downloadUrl): the same string as
            // the URL built here confirms it, and the Mac opens the URL built
            // here. With no mirror that is GitHub's tag-pinned asset; with
            // one (the server's own MSTREAM_RELEASE_BASE: it is this
            // launcher's child) the mirror's copy, over http or https. No
            // downloadUrl, or a null one, names none: the URL built here,
            // unconfirmed.
            let pkg_status_raw = |download_url: &str| {
                status(&format!(
                    r#"{{"current":"6.21.2","available":true,"latest":"6.22.0","method":"pkg","downloadUrl":{download_url}}}"#
                ))
            };
            let pkg_status = |url: &str| pkg_status_raw(&format!(r#""{url}""#));
            let page = ("Update available (6.22.0)".to_string(), UpdateAction::OpenReleases);
            let name = format!("mStream-6.22.0-darwin-{THIS_PKG_CPU}.pkg");
            let github = format!("https://github.com/IrosTheBeggar/mStream/releases/download/v6.22.0/{name}");
            let mirror_http = "http://mirror.local/mstream";
            let mirror_https = "https://files.corp.example:8443/a/b/c/";
            let at_mirror_http = format!("{mirror_http}/{name}");
            let at_mirror_https = format!("{mirror_https}{name}");
            for (mirror, url) in [(None, &github), (Some(mirror_http), &at_mirror_http), (Some(mirror_https), &at_mirror_https)] {
                let download = ("Download update 6.22.0".to_string(), UpdateAction::DownloadInstaller(url.clone()));
                let want = if host == InstallerHost::MacOs { &download } else { &page };
                for (s, how) in [(pkg_status(url), "named"), (pkg_status_raw("null"), "null"), (status(r#"{"current":"6.21.2","available":true,"latest":"6.22.0","method":"pkg"}"#), "absent")] {
                    assert_eq!(&view_m(s.as_ref(), mirror), want, "{how} {url} with {mirror:?} on {host:?}");
                }
            }
            // Anything else the server names keeps the page on every host,
            // mirror or none: the releases page itself (the release carries
            // no .pkg for this install, so the URL built here would 404),
            // the very asset on a host the operator never configured (the
            // file's URL is never opened), GitHub's asset while a mirror is
            // set or the mirror's without one (a file left by a run under
            // another environment), another CPU's, and what the status
            // parse refuses: a path with a space, one past 512 bytes, a
            // value that is not a string. The server named a download each
            // time, so none of them reads as naming none.
            let other_cpu = if THIS_PKG_CPU == "arm64" { "x64" } else { "arm64" };
            let deep = "a".repeat(600);
            let releases_page = r#""https://github.com/IrosTheBeggar/mStream/releases/latest""#.to_string();
            for (mirror, raw) in [
                (None, releases_page.clone()),
                (Some(mirror_https), releases_page),
                (None, format!(r#""https://evil.example/{name}""#)),
                (None, format!(r#""https://github.com/evil/mStream/releases/download/v6.22.0/{name}""#)),
                (Some(mirror_http), format!(r#""https://evil.example/mstream/{name}""#)),
                (Some(mirror_https), format!(r#""{github}""#)),
                (None, format!(r#""{at_mirror_https}""#)),
                (None, format!(r#""{}""#, github.replace(THIS_PKG_CPU, other_cpu))),
                (None, format!(r#""https://nas.local/mStream releases/{name}""#)),
                (None, format!(r#""https://mirror.local/{deep}/{name}""#)),
                (None, "42".to_string()),
                (None, r#"{"href":"x"}"#.to_string()),
            ] {
                assert_eq!(view_m(pkg_status_raw(&raw).as_ref(), mirror), page, "{raw} with {mirror:?} on {host:?}");
            }
            // A release the server withholds: skipped by the operator, held
            // by the boot watchdog, or from a feed this server cannot read.
            // The server fetches none of them, so no host downloads one,
            // not even when the server's URL confirms the one built here:
            // the line and the page the tray always showed for them.
            for reason in ["skipped", "held", "notifyOnly"] {
                for (mirror, named) in [
                    (None, String::new()),
                    (None, format!(r#","downloadUrl":"{github}""#)),
                    (Some(mirror_http), format!(r#","downloadUrl":"{at_mirror_http}""#)),
                ] {
                    let s = status(&format!(
                        r#"{{"current":"6.21.2","available":true,"latest":"6.22.0","method":"pkg","{reason}":true{named}}}"#
                    ));
                    assert_eq!(view_m(s.as_ref(), mirror), page, "{reason}{named} with {mirror:?} on {host:?}");
                }
            }
            // Up to date on a pkg install: nothing to download.
            let s = status(r#"{"current":"6.22.0","available":false,"latest":"6.22.0","method":"pkg"}"#);
            assert_eq!(view(s.as_ref(), true), ("Up to date (6.22.0)".to_string(), UpdateAction::None), "{host:?}");
        }
    }

    #[test]
    fn a_macs_download_url_is_built_as_the_server_builds_it() {
        // "Download update" opens this URL and no other, never the status
        // file's (whose downloadUrl only confirms it): exactly the asset
        // update-check.js downloads (assetUrl + installerAssetName), for
        // each CPU a release builds. Without a mirror, the tag-pinned
        // GitHub asset.
        assert_eq!(
            pkg_download_url("6.22.0", "arm64", None).as_deref(),
            Some("https://github.com/IrosTheBeggar/mStream/releases/download/v6.22.0/mStream-6.22.0-darwin-arm64.pkg")
        );
        assert_eq!(
            pkg_download_url("10.0.1", "x64", None).as_deref(),
            Some("https://github.com/IrosTheBeggar/mStream/releases/download/v10.0.1/mStream-10.0.1-darwin-x64.pkg")
        );
        // With one, the file of that name in the mirror's flat directory,
        // its trailing slashes trimmed as assetUrl trims them: http or
        // https, on a port, under a deep path, on loopback as CI's is.
        for (mirror, url) in [
            ("http://mirror.local/mstream", "http://mirror.local/mstream/mStream-6.22.0-darwin-arm64.pkg"),
            ("https://mirror.local/mstream///", "https://mirror.local/mstream/mStream-6.22.0-darwin-arm64.pkg"),
            (
                "https://files.corp.example:8443/a/b/c",
                "https://files.corp.example:8443/a/b/c/mStream-6.22.0-darwin-arm64.pkg",
            ),
            ("http://127.0.0.1:8765", "http://127.0.0.1:8765/mStream-6.22.0-darwin-arm64.pkg"),
        ] {
            assert_eq!(pkg_download_url("6.22.0", "arm64", Some(mirror)).as_deref(), Some(url), "{mirror}");
        }
        // A mirror the server cannot fetch from, or one that would hand
        // the browser's opener anything but one http(s) token, builds
        // nothing (the releases page instead): another scheme or an
        // uppercase one, none at all, an option-shaped value, whitespace,
        // a control character, non-ASCII (a value that was not UTF-8
        // included), past 512 bytes.
        let long = format!("https://mirror.local/{}", "a".repeat(512));
        for mirror in [
            "file:///Volumes/releases",
            "javascript:alert(1)//",
            "ftp://mirror.local",
            "HTTPS://mirror.local",
            "mirror.local/mstream",
            "-aCalculator",
            " ",
            "https://nas.local/mStream releases",
            "https://mirror.local/\n",
            "https://mirr\u{f6}r.local",
            "https://mirror.local/\u{fffd}",
            long.as_str(),
        ] {
            assert_eq!(pkg_download_url("6.22.0", "arm64", Some(mirror)), None, "{mirror:?}");
        }
        // This build names one of them.
        assert!(pkg_download_url("6.22.0", THIS_PKG_CPU, None).is_some());
        // Nothing but a plain X.Y.Z reaches the URL, and no other CPU,
        // mirror or none.
        for mirror in [None, Some("https://mirror.local/mstream")] {
            for v in ["", "6.22", "v6.22.0", "6.22.0-rc.1", "6.22.0/../../evil", "6.22.0?x=1", "6.22.0#", "1.2.3 "] {
                assert_eq!(pkg_download_url(v, "arm64", mirror), None, "{v:?} with {mirror:?}");
            }
            for cpu in ["", "aarch64", "x86_64", "universal", "arm64/../x"] {
                assert_eq!(pkg_download_url("6.22.0", cpu, mirror), None, "{cpu:?} with {mirror:?}");
            }
        }
    }

    #[test]
    fn a_servers_download_url_only_confirms_the_url_built_here() {
        // A Mac's pkg status that names `named` as its download.
        let ud = std::path::Path::new("/data/updates");
        let view = |named: &str, mirror: Option<&str>| {
            let s = status(&format!(
                r#"{{"current":"6.21.2","available":true,"latest":"6.22.0","method":"pkg","downloadUrl":{}}}"#,
                serde_json::json!(named)
            ));
            update_item_view(s.as_ref(), ud, true, InstallerHost::MacOs, mirror)
        };
        let page = ("Update available (6.22.0)".to_string(), UpdateAction::OpenReleases);
        let other_cpu = if THIS_PKG_CPU == "arm64" { "x64" } else { "arm64" };
        for mirror in [None, Some("https://mirror.local/mstream"), Some("http://mirror.local/mstream")] {
            let built = pkg_download_url("6.22.0", THIS_PKG_CPU, mirror).unwrap();
            // The very string: the URL built here, opened as built.
            assert_eq!(
                view(&built, mirror),
                ("Download update 6.22.0".to_string(), UpdateAction::DownloadInstaller(built.clone())),
                "{mirror:?}"
            );
            // Every near miss of it keeps the page, whatever a browser
            // would make of it: there is no URL parser to get wrong.
            let (scheme, rest) = built.split_once("://").unwrap();
            let (host, path) = rest.split_once('/').unwrap();
            let name = path.rsplit('/').next().unwrap();
            for near in [
                // The releases page: the release carries no .pkg for this
                // install.
                RELEASES_URL.to_string(),
                // The other CPU's, another version's.
                built.replace(THIS_PKG_CPU, other_cpu),
                built.replace("6.22.0", "6.23.0"),
                // A query, a fragment, a trailing slash, the name as the
                // prefix of another.
                format!("{built}?x=1"),
                format!("{built}#x"),
                format!("{built}/"),
                format!("{built}.exe"),
                // Userinfo, an empty host, another host.
                format!("{scheme}://evil@{host}/{path}"),
                format!("{scheme}:///{path}"),
                format!("{scheme}://evil.example/{path}"),
                // Another scheme, an uppercase one.
                format!("javascript:alert(1)//{name}"),
                format!("file:///Users/x/Downloads/{name}"),
                format!("{}://{rest}", scheme.to_uppercase()),
                // A `..` segment, whitespace inside, nothing at all.
                format!("{scheme}://{host}/x/../{path}"),
                format!("{scheme}://{host}/my mirror/{name}"),
                String::new(),
            ] {
                assert_eq!(view(&near, mirror), page, "{near:?} with {mirror:?}");
            }
        }
    }

    /// A status file whose server staged `installer` under `method`.
    fn staged_installer(method: &str, installer: &std::path::Path) -> Option<crate::paths::UpdateStatus> {
        status(&format!(
            r#"{{"current":"6.21.2","available":true,"latest":"6.22.0","method":"{method}",
                "staged":true,"stagedVersion":"6.22.0","installerPath":{}}}"#,
            serde_json::json!(installer.to_string_lossy())
        ))
    }

    #[test]
    fn a_downloaded_installer_is_offered_only_on_its_own_host() {
        let dir = std::env::temp_dir().join(format!("mstream-upd-view-{}", std::process::id()));
        let ud = dir.join("updates");
        std::fs::create_dir_all(&ud).unwrap();
        let (win, mac, other) = (InstallerHost::Windows, InstallerHost::MacOs, InstallerHost::Other);
        let available = ("Update available (6.22.0)".to_string(), UpdateAction::OpenReleases);
        let download = (
            "Download update 6.22.0".to_string(),
            UpdateAction::DownloadInstaller(pkg_download_url("6.22.0", THIS_PKG_CPU, None).unwrap()),
        );
        // macOS: the downloaded .pkg is one click from Installer.app, for
        // either architecture — and it is no handoff: never applied
        // unasked, never a stopped server.
        for arch in ["arm64", "x64"] {
            let pkg = ud.join(format!("mStream-6.22.0-darwin-{arch}.pkg"));
            std::fs::write(&pkg, "x").unwrap();
            let s = staged_installer("pkg", &pkg);
            let (t, a) = update_item_view(s.as_ref(), &ud, true, mac, None);
            assert_eq!(t, "Install update 6.22.0");
            assert_eq!(a, UpdateAction::OpenInstaller(pkg.clone()));
            assert!(!a.is_handoff());
            // The same file means nothing to a host that cannot open it.
            assert_eq!(update_item_view(s.as_ref(), &ud, true, win, None), available);
            assert_eq!(update_item_view(s.as_ref(), &ud, true, other, None), available);
        }
        // A pkg status whose installer is gone, sits outside the updates
        // dir, or is not a pkg: the release's own .pkg, fetched by the
        // browser, never the file the status names.
        let gone = ud.join("mStream-9.9.9-darwin-arm64.pkg");
        let outside = dir.join("mStream-6.22.0-darwin-arm64.pkg");
        std::fs::write(&outside, "x").unwrap();
        let exe = ud.join("mStream-6.22.0-win-x64-setup.exe");
        std::fs::write(&exe, "x").unwrap();
        for p in [&gone, &outside, &exe] {
            assert_eq!(update_item_view(staged_installer("pkg", p).as_ref(), &ud, true, mac, None), download, "{}", p.display());
        }
        // Windows: the verified setup.exe runs silently — a handoff, as
        // before — and only there, only for an Inno install.
        let s = staged_installer("inno", &exe);
        let (t, a) = update_item_view(s.as_ref(), &ud, true, win, None);
        assert_eq!(t, "Install update 6.22.0");
        assert_eq!(a, UpdateAction::RunInstaller(exe.clone()));
        assert!(a.is_handoff());
        assert_eq!(update_item_view(s.as_ref(), &ud, true, mac, None), available);
        // Method and host must agree: an Inno status naming a .pkg on a
        // Mac, or a pkg status naming the setup.exe on Windows, runs nothing.
        let pkg = ud.join("mStream-6.22.0-darwin-arm64.pkg");
        assert_eq!(update_item_view(staged_installer("inno", &pkg).as_ref(), &ud, true, mac, None), available);
        assert_eq!(update_item_view(staged_installer("pkg", &exe).as_ref(), &ud, true, win, None), available);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn opening_the_installer_is_never_an_apply() {
        // perform_apply refuses whatever is no handoff before it touches
        // the server: an Installer.app click leaves the server serving and
        // this launcher running.
        let shared = Arc::new(Shared {
            proc: Mutex::new(None),
            generation: AtomicU64::new(7),
            quitting: AtomicBool::new(false),
        });
        let log = Logger(std::env::temp_dir().join(format!("mstream-open-installer-test-{}.log", std::process::id())));
        for action in [
            UpdateAction::OpenInstaller(PathBuf::from("/data/updates/mStream-6.22.0-darwin-arm64.pkg")),
            UpdateAction::DownloadInstaller(pkg_download_url("6.22.0", "arm64", None).unwrap()),
            UpdateAction::OpenReleases,
            UpdateAction::None,
        ] {
            assert!(!action.is_handoff(), "{action:?}");
            assert!(perform_apply(&shared, &action, None, &[], &log).is_err(), "{action:?}");
            assert!(!shared.quitting.load(Ordering::SeqCst), "{action:?} started the quit path");
            assert_eq!(shared.generation.load(Ordering::SeqCst), 7, "{action:?} stopped the server");
        }
        assert!(UpdateAction::Relaunch.is_handoff());
        assert!(UpdateAction::RunInstaller(PathBuf::from("setup.exe")).is_handoff());
        let _ = std::fs::remove_file(&log.0);
    }

    #[test]
    fn failure_cap_is_per_version_and_bounded() {
        let mut f: Option<(String, u32)> = None;
        assert!(!auto_apply_capped(&f, Some("6.22.0")));
        let log = Logger(std::env::temp_dir().join(format!("mstream-cap-test-{}.log", std::process::id())));
        record_apply_failure(&mut f, Some("6.22.0"), &log);
        assert!(!auto_apply_capped(&f, Some("6.22.0")), "one failure is not the cap");
        record_apply_failure(&mut f, Some("6.22.0"), &log);
        assert!(auto_apply_capped(&f, Some("6.22.0")), "second failure caps");
        // A DIFFERENT staged version starts fresh — the cap must never leak
        // across releases.
        assert!(!auto_apply_capped(&f, Some("6.23.0")));
        record_apply_failure(&mut f, Some("6.23.0"), &log);
        assert!(!auto_apply_capped(&f, Some("6.23.0")), "counter reset for the new version");
        assert!(!auto_apply_capped(&f, None));
        let _ = std::fs::remove_file(&log.0);
    }

    #[test]
    fn apply_tokens_identify_requests() {
        let s = crate::paths::parse_update_status(
            r#"{"staged": true, "stagedVersion": "6.22.0",
                "applyRequestedAt": "2026-08-20T12:00:00.000Z"}"#,
        )
        .unwrap();
        assert_eq!(auto_apply_token(&s).as_deref(), Some("2026-08-20T12:00:00.000Z"));
        // Older server, no stamp: the staged version stands in — a retry
        // for the SAME version stays consumed, a newer one starts fresh.
        let old = crate::paths::parse_update_status(
            r#"{"staged": true, "stagedVersion": "6.22.0"}"#,
        )
        .unwrap();
        assert_eq!(auto_apply_token(&old).as_deref(), Some("6.22.0"));
        let none = crate::paths::parse_update_status("{}").unwrap();
        assert_eq!(auto_apply_token(&none), None);
    }

    #[test]
    fn installer_paths_are_validated_not_trusted() {
        let dir = std::env::temp_dir().join(format!("mstream-upd-{}", std::process::id()));
        let ud = dir.join("updates");
        std::fs::create_dir_all(&ud).unwrap();
        let (win, mac, other) = (InstallerHost::Windows, InstallerHost::MacOs, InstallerHost::Other);
        let good = ud.join("mStream-6.22.0-win-x64-setup.exe");
        std::fs::write(&good, "x").unwrap();
        assert_eq!(valid_installer(Some(&good), &ud, win), Some(good.clone()));
        // Each host takes its own asset only: the setup.exe is nothing to a
        // Mac or to Linux.
        assert_eq!(valid_installer(Some(&good), &ud, mac), None);
        assert_eq!(valid_installer(Some(&good), &ud, other), None);
        // macOS: either architecture's package, and only on macOS.
        for arch in ["arm64", "x64"] {
            let pkg = ud.join(format!("mStream-6.22.0-darwin-{arch}.pkg"));
            std::fs::write(&pkg, "x").unwrap();
            assert_eq!(valid_installer(Some(&pkg), &ud, mac), Some(pkg.clone()), "{arch}");
            assert_eq!(valid_installer(Some(&pkg), &ud, win), None, "{arch}");
            assert_eq!(valid_installer(Some(&pkg), &ud, other), None, "{arch}");
        }
        // Wrong directory: refused even with a plausible name — beside the
        // updates dir, below it, or reached through a `..` that leads out.
        let outside = dir.join("mStream-6.22.0-win-x64-setup.exe");
        std::fs::write(&outside, "x").unwrap();
        assert_eq!(valid_installer(Some(&outside), &ud, win), None);
        let outside_pkg = dir.join("mStream-6.22.0-darwin-arm64.pkg");
        std::fs::write(&outside_pkg, "x").unwrap();
        assert_eq!(valid_installer(Some(&outside_pkg), &ud, mac), None);
        let nested = ud.join("sub");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("mStream-6.22.0-darwin-x64.pkg"), "x").unwrap();
        assert_eq!(valid_installer(Some(&nested.join("mStream-6.22.0-darwin-x64.pkg")), &ud, mac), None);
        let dotdot = ud.join("..").join("mStream-6.22.0-win-x64-setup.exe");
        assert!(dotdot.exists(), "the escape names a real file");
        assert_eq!(valid_installer(Some(&dotdot), &ud, win), None);
        // Wrong name shape inside the right dir: refused on every host.
        for odd in [
            "evil.exe",
            "evil.pkg",
            "mStream-win-x64-setup.exe",
            "mStream--darwin-x64.pkg",
            "mStream-v6.22.0-darwin-x64.pkg",
            "mStream-6.22.0 x-darwin-arm64.pkg",
            "mStream-6.22.0-darwin-universal.pkg",
            "mStream-6.22.0-darwin-arm64.pkg.command",
            "mStream-6.22.0-linux-x64.pkg",
            "mstream-6.22.0-darwin-arm64.pkg",
        ] {
            let p = ud.join(odd);
            std::fs::write(&p, "x").unwrap();
            for host in [win, mac, other] {
                assert_eq!(valid_installer(Some(&p), &ud, host), None, "{odd} on {host:?}");
            }
        }
        // Missing file: refused.
        assert_eq!(valid_installer(Some(&ud.join("mStream-9.9.9-win-x64-setup.exe")), &ud, win), None);
        assert_eq!(valid_installer(Some(&ud.join("mStream-9.9.9-darwin-arm64.pkg")), &ud, mac), None);
        assert_eq!(valid_installer(None, &ud, win), None);
        assert_eq!(valid_installer(None, &ud, mac), None);
        // A pre-release version's characters pass.
        let rc = ud.join("mStream-6.23.0-rc.1-darwin-arm64.pkg");
        std::fs::write(&rc, "x").unwrap();
        assert_eq!(valid_installer(Some(&rc), &ud, mac), Some(rc.clone()));
        // An inno status pointing outside the updates dir renders inert —
        // and so does a pkg one.
        let (t, a) = update_item_view(staged_installer("inno", &outside).as_ref(), &ud, true, win, None);
        assert_eq!(a, UpdateAction::OpenReleases, "falls back to availability, never runs the file");
        assert_eq!(t, "Update available (6.22.0)");
        let (t, a) = update_item_view(staged_installer("pkg", &outside_pkg).as_ref(), &ud, true, mac, None);
        assert_eq!(
            a,
            UpdateAction::DownloadInstaller(pkg_download_url("6.22.0", THIS_PKG_CPU, None).unwrap()),
            "falls back to the release's own download, never opens the file"
        );
        assert_eq!(t, "Download update 6.22.0");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
