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
use std::time::Duration;
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
            let _ = open::that_detached(paths::server_url(&ep));
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
    let mut ever_up = false;
    let mut opened = false;
    let url = paths::server_url(&ep);
    let announce = !args.autostarted && !args.no_open;
    let shared_loop = shared.clone();
    let server_log_loop = server_log.clone();

    event_loop.run(move |event, _target, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            // Tray creation belongs HERE, not before run(): on Linux the
            // tray needs the gtk main context tao initializes, and on macOS
            // it must follow NSApplication activation. Windows tolerates
            // either; one code path keeps all three honest.
            Event::NewEvents(StartCause::Init) => {
                let menu = Menu::new();
                let open_item = MenuItem::with_id("open", "Open mStream", true, None);
                let qc_item = MenuItem::with_id("quick-connect", "Quick Connect", true, None);
                let auto_item =
                    CheckMenuItem::with_id("autostart", "Start at login", true, autostart::is_enabled(), None);
                let restart_item = MenuItem::with_id("restart", "Restart server", true, None);
                let quit_item = MenuItem::with_id("quit", "Quit mStream", true, None);
                let _ = menu.append(&open_item);
                let _ = menu.append(&qc_item);
                let _ = menu.append(&PredefinedMenuItem::separator());
                let _ = menu.append(&auto_item);
                let _ = menu.append(&PredefinedMenuItem::separator());
                let _ = menu.append(&restart_item);
                let _ = menu.append(&quit_item);
                autostart_item = Some(auto_item);

                match TrayIconBuilder::new()
                    .with_tooltip("mStream Server")
                    .with_menu(Box::new(menu))
                    .with_icon(load_icon())
                    .build()
                {
                    Ok(t) => tray = Some(t),
                    Err(e) => {
                        // No tray host (minimal desktops, headless-ish
                        // sessions). The server is still running and
                        // reachable; say so once and keep serving.
                        log.line(&format!("tray unavailable ({e}) - server continues without it"));
                    }
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
                    "restart" => {
                        log.line("menu: restart server");
                        stop_current(&shared_loop);
                        if let Err(e) = spawn_generation(
                            &shared_loop,
                            &bin,
                            &args.server_args,
                            &server_log_loop,
                            ep,
                            &proxy,
                            &log,
                        ) {
                            log.line(&format!("restart failed: {e}"));
                            platform::fatal_alert(&format!("mStream could not restart its server:\n{e}"));
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
                        log.line("server is up");
                        if let Some(t) = &tray {
                            let _ = t.set_tooltip(Some(format!("mStream Server - {url}")));
                        }
                        if announce && !opened {
                            opened = true;
                            let _ = open::that_detached(url.clone());
                        }
                    }
                }
                AppEvent::ServerExited(generation) => {
                    let current = shared_loop.generation.load(Ordering::SeqCst);
                    if generation == current && !shared_loop.quitting.load(Ordering::SeqCst) {
                        log.line("server exited unexpectedly");
                        if let Some(t) = &tray {
                            let _ = t.set_tooltip(Some("mStream Server - stopped (use Restart server)"));
                        }
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
                    let _ = open::that_detached(url.clone());
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
