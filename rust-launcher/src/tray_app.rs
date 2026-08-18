// The desktop face: single-instance guard, autostart default, server spawn,
// tray icon + menu, and the event loop that ties them together.
//
// Threading model: tao's event loop owns the main thread (a hard requirement
// on macOS and for gtk). Two helper threads exist per server generation — a
// health prober and an exit watcher — and both talk to the loop only through
// the EventLoopProxy. The server child lives in an Arc<Mutex<...>> shared
// with the watcher; a generation counter keeps a stale watcher (from before
// a restart) from reporting the new child's state.
use crate::{autostart, paths, platform, server, LauncherArgs};
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

#[derive(Debug)]
enum AppEvent {
    Menu(String),
    ServerUp(u64),
    ServerExited(u64),
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
    if !lock.try_lock().unwrap_or(false) {
        log.line("another launcher instance holds the lock - focusing it and exiting");
        if !args.autostarted && !args.no_open {
            let _ = open::that_detached(paths::browse_target(&config, &ep));
        }
        std::process::exit(0);
    }

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

    match spawn_generation(&shared, &bin, &args.server_args, &server_log, ep, &proxy, &log) {
        Ok(()) => {}
        Err(e) => {
            log.line(&format!("server failed to spawn: {e}"));
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
    // Last time the timer path re-rendered the status. The status can only
    // change on a minute boundary, so timer wakes are throttled to 1 Hz:
    // any other timer that shares this loop's ControlFlow (a fast poll
    // while a popup is open, say) would otherwise re-set the same tooltip
    // text at that timer's rate. Phase changes render unconditionally.
    let mut status_rendered_at: Option<Instant> = None;
    let mut ever_up = false;
    let mut opened = false;
    let url = paths::server_url(&ep);
    let announce = !args.autostarted && !args.no_open;
    let shared_loop = shared.clone();
    let server_log_loop = server_log.clone();
    // For launcher-initiated opens inside the loop (announce, macOS reopen):
    // re-read the config each time so the destination tracks the library —
    // admin panel while no folders exist (a fresh install's player is a dead
    // end), the player once music is configured.
    let config_loop = config.clone();

    event_loop.run(move |event, _target, control_flow| {
        // Idle, except that a RUNNING server's status line has a minute
        // boundary to cross — wake exactly there and nowhere else (one
        // wake a minute; the exit watcher already polls twice a second).
        // Re-evaluated on every pass, so a phase change made below is
        // armed by the MainEventsCleared that follows it. Exit is sticky
        // in tao, so Quit's ControlFlow::Exit survives this assignment.
        *control_flow = match phase.next_tick() {
            Some(at) => ControlFlow::WaitUntil(at),
            None => ControlFlow::Wait,
        };
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
                let status = MenuItem::with_id("status", phase.menu_text(), false, None);
                let open_item = MenuItem::with_id("open", "Open mStream", true, None);
                let qc_item = MenuItem::with_id("quick-connect", "Quick Connect", true, None);
                let auto_item =
                    CheckMenuItem::with_id("autostart", "Start at login", true, autostart::is_enabled(), None);
                let logs_item = MenuItem::with_id("logs", "View logs", true, None);
                let restart_item = MenuItem::with_id("restart", "Restart server", true, None);
                let quit_item = MenuItem::with_id("quit", "Quit mStream", true, None);
                let _ = menu.append(&status);
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
                show_status(status_item.as_ref(), tray.as_ref(), &phase, &url);
            }
            // The minute tick armed at the top of the closure: re-render the
            // uptime. Only here and on phase changes — never on unrelated
            // events, so the tooltip isn't re-set under a hovering cursor.
            // Throttled to once per second: this arm fires for EVERY timer
            // wake the loop is asked for, not just ours.
            Event::NewEvents(StartCause::ResumeTimeReached { .. }) => {
                let now = Instant::now();
                if status_rendered_at.is_none_or(|t| now.duration_since(t) >= Duration::from_secs(1)) {
                    status_rendered_at = Some(now);
                    show_status(status_item.as_ref(), tray.as_ref(), &phase, &url);
                }
            }
            Event::UserEvent(app_event) => match app_event {
                AppEvent::Menu(id) => match id.as_str() {
                    "open" => {
                        let _ = open::that_detached(url.clone());
                    }
                    "quick-connect" => {
                        // The web UI opens its Quick Connect modal on this
                        // hash (webapp/assets/js/quick-connect.js).
                        let _ = open::that_detached(format!("{url}/#quick-connect"));
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
                        show_status(status_item.as_ref(), tray.as_ref(), &phase, &url);
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
                        log.line("server is up");
                        // Uptime counts from here — "up" means serving, not
                        // spawned. A restart or crash lands back in
                        // Starting/Stopped, so the count resets with it.
                        phase = Phase::Running { since: Instant::now() };
                        show_status(status_item.as_ref(), tray.as_ref(), &phase, &url);
                        // Logged unconditionally (even under --no-open) so
                        // smokes and support can see the routing decision.
                        let target = paths::browse_target(&config_loop, &ep);
                        if target.ends_with("/admin") {
                            log.line("no music folders configured yet - browser target is the admin panel");
                        }
                        if announce && !opened {
                            opened = true;
                            let _ = open::that_detached(target);
                        }
                    }
                }
                AppEvent::ServerExited(generation) => {
                    let current = shared_loop.generation.load(Ordering::SeqCst);
                    if generation == current && !shared_loop.quitting.load(Ordering::SeqCst) {
                        log.line("server exited unexpectedly");
                        phase = Phase::Stopped;
                        show_status(status_item.as_ref(), tray.as_ref(), &phase, &url);
                        if !ever_up {
                            // Died before ever serving = a boot failure the
                            // user would otherwise never see (no console).
                            platform::fatal_alert(&format!(
                                "The mStream server stopped before it finished starting.\n\nSee {}",
                                server_log_loop.display()
                            ));
                        }
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
    // probe, not a bare connect — see wait_serving), then report up.
    {
        let proxy = proxy.clone();
        std::thread::spawn(move || {
            if server::wait_serving(ep, BOOT_TIMEOUT) {
                let _ = proxy.send_event(AppEvent::ServerUp(generation));
            }
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

/// The server's lifecycle as the tray reports it. Running carries the
/// instant the identity probe first answered (ServerUp), which is what the
/// uptime counts from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Starting,
    Running { since: Instant },
    Stopped,
}

impl Phase {
    /// The disabled first menu line.
    fn menu_text(&self) -> String {
        match self {
            Phase::Starting => "Starting…".to_string(),
            Phase::Running { since } => format!("Running · up {}", format_uptime(since.elapsed())),
            Phase::Stopped => "Stopped · use Restart server".to_string(),
        }
    }

    /// The icon tooltip (Windows/macOS; tray-icon's Linux tooltip is a
    /// no-op, so the menu line is the cross-platform carrier).
    fn tooltip(&self, url: &str) -> String {
        match self {
            Phase::Starting => "mStream Server - starting".to_string(),
            Phase::Running { since } => format!("mStream Server - {url} (up {})", format_uptime(since.elapsed())),
            Phase::Stopped => "mStream Server - stopped (use Restart server)".to_string(),
        }
    }

    /// When the status line next changes: the running server's next minute
    /// boundary, or never. Aligned to the boundary rather than "60 s from
    /// now" so the shown minutes are exact, not up to a minute stale.
    fn next_tick(&self) -> Option<Instant> {
        match self {
            Phase::Running { since } => Some(next_minute_boundary(*since, Instant::now())),
            _ => None,
        }
    }
}

/// Push the phase into the status line and tooltip. Both handles are
/// Options because the tray can be degraded away (no StatusNotifier host)
/// while the loop, and the server, carry on.
fn show_status(item: Option<&MenuItem>, tray: Option<&TrayIcon>, phase: &Phase, url: &str) {
    if let Some(i) = item {
        i.set_text(phase.menu_text());
    }
    if let Some(t) = tray {
        let _ = t.set_tooltip(Some(phase.tooltip(url)));
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
            png::ColorType::Rgb => buf.chunks_exact(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
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
        assert_eq!(Phase::Starting.menu_text(), "Starting…");
        assert_eq!(Phase::Stopped.menu_text(), "Stopped · use Restart server");
        assert_eq!(Phase::Starting.tooltip("http://localhost:3000"), "mStream Server - starting");
        assert_eq!(
            Phase::Stopped.tooltip("http://localhost:3000"),
            "mStream Server - stopped (use Restart server)"
        );
        // A just-started server (Instant can't be rewound on a freshly
        // booted CI box; the big-number formatting is pinned above).
        let running = Phase::Running { since: Instant::now() };
        assert_eq!(running.menu_text(), "Running · up <1m");
        assert_eq!(running.tooltip("http://localhost:3000"), "mStream Server - http://localhost:3000 (up <1m)");
        assert!(running.next_tick().is_some());
        assert_eq!(Phase::Starting.next_tick(), None, "no ticks unless running");
        assert_eq!(Phase::Stopped.next_tick(), None);
    }
}
