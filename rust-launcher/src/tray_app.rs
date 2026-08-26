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
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

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
/// URL the launcher would open.
const RELEASES_URL: &str = "https://github.com/IrosTheBeggar/mStream/releases/latest";

#[derive(Debug)]
enum AppEvent {
    Menu(String),
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
    // The bundled Ghostty console (macOS bundles stage it at console/ beside
    // mStream.app; other platforms simply never find one). Its Dock icon is
    // mStream's own icns out of the .app — cosmetic, so absence is fine.
    let console = paths::find_console_app(&bin).map(|ghostty_app| {
        let icns = server_dir.join("..").join("Resources").join("mStream.icns");
        paths::ConsoleLaunch { ghostty_app, icon_icns: icns.exists().then_some(icns) }
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
        if !args.autostarted && !args.no_open && !args.takeover {
            let _ = open::that_detached(paths::browse_target(&config, &ep));
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
                let (utext, uaction) =
                    update_item_view(upd.as_ref(), &updates_dir(), relaunch_target_exists(exe_real.as_deref()));
                let update = MenuItem::with_id("update", utext.clone(), uaction != UpdateAction::None, None);
                upd_text = utext;
                let open_item = MenuItem::with_id("open", "Open Admin Panel", true, None);
                let qc_item = MenuItem::with_id("quick-connect", "Quick Connect", true, None);
                let auto_item =
                    CheckMenuItem::with_id("autostart", "Start at login", true, autostart::is_enabled(), None);
                let logs_item = MenuItem::with_id("logs", "View logs", true, None);
                let restart_item = MenuItem::with_id("restart", "Restart server", true, None);
                let quit_item = MenuItem::with_id("quit", "Quit mStream", true, None);
                let _ = menu.append(&status);
                let _ = menu.append(&update);
                let _ = menu.append(&PredefinedMenuItem::separator());
                let _ = menu.append(&open_item);
                let _ = menu.append(&qc_item);
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
                    TrayIconBuilder::new()
                        .with_tooltip("mStream Server")
                        .with_menu(Box::new(menu))
                        .with_icon(load_icon())
                        .build()
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
                        && !matches!(action, UpdateAction::None | UpdateAction::OpenReleases)
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
                AppEvent::Menu(id) => match id.as_str() {
                    "open" => {
                        // The admin panel, explicitly — the tray is the
                        // operator's surface, and listening happens in the
                        // apps/players. (The post-boot browser announce keeps
                        // its own routing: paths::browse_target.)
                        let _ = open::that_detached(format!("{url}/admin"));
                    }
                    "quick-connect" => {
                        // The wizard's Quick Connect page (pixel pairing QR)
                        // in a real terminal on the desktop platforms; the
                        // webapp's modal hash stays the linux behavior
                        // (webapp/assets/js/quick-connect.js) and the
                        // fallback when this install has no player binary or
                        // the terminal launch itself fails.
                        log.line("menu: quick connect");
                        let mut opened = false;
                        if cfg!(any(target_os = "macos", windows)) {
                            if let Some(player) = player_bin.as_deref() {
                                match platform::open_wizard_terminal(player, &url, &data_home, console.as_ref(), platform::WizardPage::QuickConnect) {
                                    Ok(via) => {
                                        log.line(&format!("quick connect opened via {via}"));
                                        opened = true;
                                    }
                                    Err(e) => log.line(&format!("quick connect terminal failed: {e} - falling back to the webapp")),
                                }
                            }
                        }
                        if !opened {
                            let _ = open::that_detached(format!("{url}/#quick-connect"));
                        }
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
                            UpdateAction::None => {}
                            _ => {
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
                        if announce && !opened {
                            opened = true;
                            // First install (no music folders yet): open the
                            // guided terminal wizard itself — the same
                            // surface as the tray's "Set up mStream" — on
                            // the platforms with a terminal story. The
                            // browser admin panel stays the fallback (no
                            // player binary, or the terminal launch failed)
                            // and the linux behavior; configured installs
                            // keep opening the player as always. The
                            // announce gates (--takeover, --autostarted,
                            // --no-open) suppress this exactly like the
                            // browser pop — an update relaunch must never
                            // pop a terminal.
                            let mut wizard_opened = false;
                            if target.ends_with("/admin") && cfg!(any(target_os = "macos", windows)) {
                                if let Some(player) = player_bin.as_deref() {
                                    match platform::open_wizard_terminal(player, &url, &data_home, console.as_ref(), platform::WizardPage::Setup) {
                                        Ok(via) => {
                                            log.line(&format!("first-run announce: setup wizard opened via {via}"));
                                            wizard_opened = true;
                                        }
                                        Err(e) => log.line(&format!("first-run announce: wizard failed ({e}) - opening the admin panel")),
                                    }
                                }
                            }
                            if !wizard_opened {
                                let _ = open::that_detached(target);
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
            // mStream". (Other platforms never emit this event.)
            Event::Reopen { .. } => {
                log.line("reopen event - opening browser");
                if !args.no_open {
                    let _ = open::that_detached(paths::browse_target(&config_loop, &ep));
                }
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
    /// Windows Inno install with a verified downloaded installer.
    RunInstaller(PathBuf),
}

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

/// The installer path the launcher will actually run: must live in OUR
/// updates dir with the expected asset name and exist. Everything else in
/// the status file's installerPath is ignored — the file is another
/// process's data, not an instruction stream.
fn valid_installer(p: Option<&Path>, updates_dir: &Path) -> Option<PathBuf> {
    let p = p?;
    if !p.starts_with(updates_dir) {
        return None;
    }
    let name = p.file_name()?.to_str()?;
    (name.starts_with("mStream-") && name.ends_with("-win-x64-setup.exe") && p.exists())
        .then(|| p.to_path_buf())
}

/// The update line's text + action for a given status-file state. Pure so
/// the matrix is unit-testable; `relaunch_ok` is whether
/// derive_relaunch_target currently resolves (a staged update on a layout
/// we can't relaunch from renders informational, not clickable).
fn update_item_view(
    s: Option<&paths::UpdateStatus>,
    updates_dir: &Path,
    relaunch_ok: bool,
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
                    Some("inno") => {
                        if let Some(p) = valid_installer(s.installer_path.as_deref(), updates_dir) {
                            return (format!("Install update {v}"), UpdateAction::RunInstaller(p));
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    if s.available {
        if let Some(v) = &s.latest {
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
    let (text, action) = update_item_view(s, updates_dir, relaunch_ok);
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
/// and the caller must recover — the server is already stopped.
fn perform_apply(
    shared: &Arc<Shared>,
    action: &UpdateAction,
    exe_real: Option<&Path>,
    server_args: &[String],
    log: &Logger,
) -> Result<(), String> {
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
        let mut buf = vec![0u8; reader.output_buffer_size()];
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

    fn status(json: &str) -> Option<crate::paths::UpdateStatus> {
        crate::paths::parse_update_status(json)
    }

    #[test]
    fn update_view_matrix() {
        let ud = std::path::Path::new("/data/updates");
        // No file at all: bundle-version fallback, inert.
        let (t, a) = update_item_view(None, ud, true);
        assert_eq!(t, format!("Up to date ({})", env!("MSTREAM_BUNDLE_VERSION")));
        assert_eq!(a, UpdateAction::None);
        // Up to date per the server.
        let s = status(r#"{"current":"6.21.2","available":false}"#);
        let (t, a) = update_item_view(s.as_ref(), ud, true);
        assert_eq!(t, "Up to date (6.21.2)");
        assert_eq!(a, UpdateAction::None);
        // Downloading.
        let s = status(r#"{"current":"6.21.2","available":true,"latest":"6.22.0","downloading":true}"#);
        let (t, a) = update_item_view(s.as_ref(), ud, true);
        assert_eq!(t, "Downloading update…");
        assert_eq!(a, UpdateAction::None);
        // Staged on a managed layout with a resolvable relaunch target.
        let s = status(
            r#"{"current":"6.21.2","available":true,"latest":"6.22.0","method":"managed",
                "staged":true,"stagedVersion":"6.22.0"}"#,
        );
        let (t, a) = update_item_view(s.as_ref(), ud, true);
        assert_eq!(t, "Restart to update to 6.22.0");
        assert_eq!(a, UpdateAction::Relaunch);
        // Same, but the layout can't be relaunched from: informational only.
        let (t, a) = update_item_view(s.as_ref(), ud, false);
        assert_eq!(t, "Update 6.22.0 staged - restart mStream to finish");
        assert_eq!(a, UpdateAction::None);
        // Staged version already running (post-apply file lag): up to date.
        let s = status(
            r#"{"current":"6.22.0","available":false,"method":"managed",
                "staged":true,"stagedVersion":"6.22.0"}"#,
        );
        let (t, a) = update_item_view(s.as_ref(), ud, true);
        assert_eq!(t, "Up to date (6.22.0)");
        assert_eq!(a, UpdateAction::None);
        // Non-managed with an update: availability + the releases page.
        let s = status(r#"{"current":"6.21.2","available":true,"latest":"6.22.0","method":"docker"}"#);
        let (t, a) = update_item_view(s.as_ref(), ud, true);
        assert_eq!(t, "Update available (6.22.0)");
        assert_eq!(a, UpdateAction::OpenReleases);
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
        let good = ud.join("mStream-6.22.0-win-x64-setup.exe");
        std::fs::write(&good, "x").unwrap();
        assert_eq!(valid_installer(Some(&good), &ud), Some(good.clone()));
        // Wrong directory: refused even with a plausible name.
        let outside = dir.join("mStream-6.22.0-win-x64-setup.exe");
        std::fs::write(&outside, "x").unwrap();
        assert_eq!(valid_installer(Some(&outside), &ud), None);
        // Wrong name shape inside the right dir: refused.
        let odd = ud.join("evil.exe");
        std::fs::write(&odd, "x").unwrap();
        assert_eq!(valid_installer(Some(&odd), &ud), None);
        // Missing file: refused.
        assert_eq!(valid_installer(Some(&ud.join("mStream-9.9.9-win-x64-setup.exe")), &ud), None);
        assert_eq!(valid_installer(None, &ud), None);
        // An inno status pointing outside the updates dir renders inert.
        let s = status(&format!(
            r#"{{"current":"6.21.2","available":true,"latest":"6.22.0","method":"inno",
                "staged":true,"stagedVersion":"6.22.0","installerPath":{}}}"#,
            serde_json::json!(outside.to_string_lossy())
        ));
        let (t, a) = update_item_view(s.as_ref(), &ud, true);
        assert_eq!(a, UpdateAction::OpenReleases, "falls back to availability, never runs the file");
        assert_eq!(t, "Update available (6.22.0)");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
