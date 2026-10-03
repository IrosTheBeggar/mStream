// Path resolution — a deliberate MIRROR of src/util/boot-config.js plus the
// bits of the server's CLI/config the launcher must agree with (the -j
// parsing in cli-boot-wrapper.js, the port/address schema in
// src/state/config.js). The launcher must find the same config (and
// therefore the same endpoint and data) the server resolves for itself; if
// you change the ladder there, change it here (test/unit/boot-config.test.mjs
// pins the JS side, the tests below pin this side, and the launcher smoke in
// CI pins agreement end-to-end).
use std::env;
use std::ffi::OsString;
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Env lookup that mirrors how the JS side reads paths from the
/// environment: `env.X || fallback` — an exported-but-EMPTY variable is
/// unset there (and the XDG spec agrees: "empty means unset"). Rust's
/// var_os returns Some("") for those, which must not count.
fn env_dir(name: &str) -> Option<OsString> {
    env::var_os(name).filter(|v| !v.is_empty())
}

/// Per-OS user data home for the desktop profile — mirrors userDataHome()
/// in src/util/boot-config.js (LOCALAPPDATA, not APPDATA: multi-GB caches
/// don't belong in a roaming profile).
pub fn data_home() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let base = env_dir("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join("AppData").join("Local"));
        base.join("mStream")
    }
    #[cfg(target_os = "macos")]
    {
        home_dir().join("Library").join("Application Support").join("mStream")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let base = env_dir("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join(".local").join("share"));
        base.join("mstream")
    }
}

pub(crate) fn home_dir() -> PathBuf {
    #[cfg(windows)]
    let var = "USERPROFILE";
    #[cfg(unix)]
    let var = "HOME";
    env::var_os(var).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

pub fn exe_dir() -> PathBuf {
    env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Make a path absolute against the cwd without touching the filesystem.
/// The server's ladder anchors at dirname(process.execPath), which the
/// runtime always reports absolute — a relative --server-bin must be
/// pinned down before its parent can serve as that anchor.
pub fn absolutize(p: PathBuf) -> PathBuf {
    if p.is_absolute() {
        p
    } else {
        env::current_dir().map(|d| d.join(&p)).unwrap_or(p)
    }
}

/// The config file the server will end up using for THIS invocation:
/// explicit -j wins, then MSTREAM_CONFIG, then the legacy/portable
/// next-to-binary file, then the desktop-profile data home.
///
/// `server_dir` is the directory of the SERVER binary that will actually
/// run — the ladder's legacy/portable rung anchors there (the server uses
/// dirname(process.execPath), src/util/boot-config.js appRoot), NOT at the
/// launcher's own exe_dir. The two only coincide for the shipped sibling
/// layout; --server-bin/MSTREAM_SERVER_BIN break it by design.
pub fn resolve_config_path(server_args: &[String], server_dir: &Path) -> PathBuf {
    // Explicit -j/--json/--json=: the LAST occurrence wins, because the
    // server's parseArgs (cli-boot-wrapper.js) overwrites on repeat. (A
    // trailing -j with no value makes the server exit with a usage error;
    // falling through here is fine — the boot failure gets dialoged.)
    let mut explicit: Option<PathBuf> = None;
    let mut it = server_args.iter();
    while let Some(a) = it.next() {
        if a == "-j" || a == "--json" {
            if let Some(p) = it.next() {
                explicit = Some(PathBuf::from(p));
            }
        } else if let Some(p) = a.strip_prefix("--json=") {
            explicit = Some(PathBuf::from(p));
        }
    }
    if let Some(p) = explicit {
        return p;
    }
    if let Some(p) = env_dir("MSTREAM_CONFIG") {
        return PathBuf::from(p);
    }
    let legacy = server_dir.join("save").join("conf").join("default.json");
    if server_args.iter().any(|a| a == "--portable") || legacy.exists() {
        return legacy;
    }
    data_home().join("conf").join("default.json")
}

/// Where the server will actually answer, per its config.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Endpoint {
    /// Address to PROBE (and to show when it isn't loopback). The config's
    /// pinned `address` when it names a specific interface; loopback for
    /// the wildcard default / absent / anything unparseable.
    pub ip: IpAddr,
    pub port: u16,
}

/// Endpoint the server will listen on: the config's `port`/`address`, else
/// the Joi defaults (3000 on `::`). The config may not exist yet on a first
/// run — the server generates it — and these defaults are exactly what that
/// generated config yields.
pub fn read_endpoint(config: &Path) -> Endpoint {
    // trim_start_matches('\u{feff}'): PowerShell 5.1's `Set-Content -Encoding
    // UTF8` writes a BOM and serde_json refuses it — the server side strips it
    // too (util/atomic-json.js stripBom), and the two sides must read the SAME
    // config the same way, or a BOM'd port lands the server on 8000 while the
    // launcher probes the 3000 fallback forever.
    let v = std::fs::read_to_string(config)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s.trim_start_matches('\u{feff}')).ok());
    let port = v
        .as_ref()
        .and_then(|v| v.get("port"))
        .and_then(joi_port)
        .unwrap_or(3000);
    let ip = v
        .as_ref()
        .and_then(|v| v.get("address"))
        .and_then(|a| a.as_str())
        .map(probe_ip)
        .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST));
    Endpoint { ip, port }
}

/// Port values the server's schema accepts: `port: Joi.number()` with
/// convert on, so 8000, 8000.0 and "8000" all validate and listen on 8000.
/// A bare as_u64 rejects the latter two — the exact hand-edit shapes a JSON
/// file full of quoted scalars invites — and a silent 3000 fallback here
/// splits the two sides. Non-integral or out-of-range values stay None
/// (nothing probeable listens on port 8000.5).
fn joi_port(v: &serde_json::Value) -> Option<u16> {
    let n = v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse::<f64>().ok()))?;
    (n.fract() == 0.0 && (0.0..=65535.0).contains(&n)).then_some(n as u16)
}

/// Map the config's `address` (Joi: string().ip(), default "::") to the
/// address the launcher should probe. The wildcards (`::`, `0.0.0.0`) and
/// anything unparseable keep today's loopback probe; a pinned interface is
/// probed where the server actually listens — `"address": "192.168.1.20"`
/// binds ONLY that interface, and a loopback probe against it reports a
/// healthy server as never up.
fn probe_ip(s: &str) -> IpAddr {
    match s.trim().parse::<IpAddr>() {
        Ok(ip) if !ip.is_unspecified() => ip,
        _ => IpAddr::V4(Ipv4Addr::LOCALHOST),
    }
}

/// The tiny launcher state file (first-run marker for the autostart
/// default). Lives in the data home, NOT next to the binary — same
/// reasoning as the server's desktop profile.
pub fn state_file() -> PathBuf {
    data_home().join("launcher.json")
}

/// Browser-facing URL for the endpoint: `localhost` for loopback (friendly,
/// and exactly what this launcher always rendered), the pinned host
/// otherwise (bracketed for IPv6).
pub fn server_url(ep: &Endpoint) -> String {
    match ep.ip {
        ip if ip.is_loopback() => format!("http://localhost:{}", ep.port),
        IpAddr::V4(v4) => format!("http://{v4}:{}", ep.port),
        IpAddr::V6(v6) => format!("http://[{v6}]:{}", ep.port),
    }
}

/// Whether this install has been through first-run setup, per the config's
/// one-time `setupComplete` marker — written by the SERVER the moment the
/// first library or first user lands (util/admin.js markSetupComplete), and
/// backfilled at boot for installs that predate it. The legacy `folders`
/// check rides along as a belt: an older server never writes the flag, but
/// old-style configs still carry their folders, so a new launcher over an
/// old configured install doesn't re-run first-run behavior. Unreadable or
/// absent config counts as not-set-up — on a true first run the file
/// appears mid-boot, and the right answer is the same either way.
pub fn setup_complete(config: &Path) -> bool {
    let Some(v) = std::fs::read_to_string(config)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s.trim_start_matches('\u{feff}')).ok())
    else {
        return false;
    };
    if v.get("setupComplete").and_then(|b| b.as_bool()) == Some(true) {
        return true;
    }
    v.get("folders").and_then(|f| f.as_object().map(|o| !o.is_empty())).unwrap_or(false)
}

/// Where a launcher-initiated browser open should land (the announce after
/// boot, a second instance yielding, a macOS reopen, the tray's player
/// item and left click when no desktop player opens): the player once
/// setup has happened, the ADMIN PANEL before it — a fresh install's
/// player is a dead end. (The post-boot announce goes further and opens
/// the setup wizard itself on fresh installs; this is its browser fallback
/// and every other gesture's routing.)
pub fn browse_target(config: &Path, ep: &Endpoint) -> String {
    if setup_complete(config) {
        server_url(ep)
    } else {
        format!("{}/admin", server_url(ep))
    }
}

/// The platform key of the terminal player binary — mirrors playerKey() in
/// src/util/mstream-player-bootstrap.js (the manifest and the bundle are
/// keyed by the full filename). No musl arm: launcher builds are glibc-only,
/// and musl bundles are headless.
pub fn player_key() -> String {
    let plat = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "win32"
    } else {
        "linux"
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    let ext = if cfg!(windows) { ".exe" } else { "" };
    format!("mstream-player-{plat}-{arch}{ext}")
}

/// The bundled player behind the setup wizard, Quick Connect and "Open
/// mStream Player": the copy build-bun stages next to the server binary in
/// every desktop bundle, else one the server's runtime fetch installed in
/// the shared data home. None sends each of them to its browser fallback
/// (the admin panel, the webapp's Quick Connect modal, the web player).
pub fn find_player_bin(server_bin: &Path, data_home: &Path) -> Option<PathBuf> {
    let key = player_key();
    let bundled = server_bin.parent()?.join("bin").join("mstream-player").join(&key);
    if bundled.exists() {
        return Some(bundled);
    }
    let managed = data_home.join("bin").join("mstream-player").join(&key);
    managed.exists().then_some(managed)
}

/// The first player release whose binary has the `gui` subcommand — the
/// desktop player (player PR #18, unreleased at v0.7.0). Below it the
/// tray's player item opens the web player instead. A bundle always ships
/// the pinned player, so this gate only ever refuses a mismatched layout:
/// --server-bin against an older tree, or a stale managed copy the
/// server's fetch installed in the data home.
pub const GUI_MIN_PLAYER_VERSION: [u64; 3] = [0, 8, 0];

/// What one `--version` run says about a player binary: its version (the
/// gates above and below read it) and its FLAVOUR. The player crate builds
/// two products (the player repo's PLAN.md Phase 14): the terminal build,
/// and the desktop build, whose `gui --window` draws in a window of its
/// own. The bundles stage the desktop build under the terminal build's file
/// name, so the name says nothing — the probe is the only way to tell.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PlayerProbe {
    pub version: [u64; 3],
    /// A desktop build (`features: window` on the probe's second line):
    /// "Open mStream Player" may start it straight into its own window.
    pub desktop: bool,
}

/// Ask the player binary its version. `--version` is clap's one-shot —
/// prints "mstream-player X.Y.Z" (and, from a desktop build, a second line
/// "features: window") and exits, no audio device, no sockets, no config —
/// the same probe the server's fetch path runs before it installs a build.
/// None when the binary cannot run here at all (the linux build dies at
/// load without libasound) or answers something else; the caller treats
/// that as "no GUI player".
pub fn player_probe(bin: &Path) -> Option<PlayerProbe> {
    let mut cmd = Command::new(bin);
    cmd.arg("--version").stdin(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // A console-subsystem child of this GUI launcher would otherwise
        // flash a console window for the probe (same as server::spawn).
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let version = parse_player_version(&stdout)?;
    Some(PlayerProbe { version, desktop: parse_player_desktop(&stdout) })
}

/// "mstream-player 0.8.0" → [0, 8, 0]. Only the first line counts, only
/// the leading dotted triple is read (a pre-release or build tag after it
/// is ignored — "0.8.0-beta.1" is a build that has the GUI), and anything
/// else is None.
pub(crate) fn parse_player_version(stdout: &str) -> Option<[u64; 3]> {
    let line = stdout.lines().next()?.trim();
    let rest = line.strip_prefix("mstream-player ")?;
    let core = rest.split(|c: char| c == '-' || c == '+' || c.is_whitespace()).next()?;
    let mut parts = core.split('.');
    let mut v = [0u64; 3];
    for slot in &mut v {
        *slot = parts.next()?.parse().ok()?;
    }
    if parts.next().is_some() {
        return None;
    }
    Some(v)
}

/// Whether the probe's output names a desktop build: its SECOND line is
/// `features: <list>` and the list holds the word `window` (comma- or
/// space-separated, so a later build may name more features). The first
/// line stays parse_player_version's alone; a missing, blank or foreign
/// second line — every terminal build, every release before Phase 14 — is
/// a terminal build. Nothing past the second line is read.
pub(crate) fn parse_player_desktop(stdout: &str) -> bool {
    stdout
        .lines()
        .nth(1)
        .and_then(|line| line.trim().strip_prefix("features:"))
        .is_some_and(|list| list.split(|c: char| c == ',' || c.is_whitespace()).any(|word| word == "window"))
}

/// Whether a player of this version has the `gui` face.
pub fn player_has_gui(version: [u64; 3]) -> bool {
    version >= GUI_MIN_PLAYER_VERSION
}

/// "0.8.0" — for log lines.
pub fn version_label(v: [u64; 3]) -> String {
    format!("{}.{}.{}", v[0], v[1], v[2])
}

/// The first player release whose `gui` and `tui` faces take
/// `--instance-lock` (the player repo's instance module). Planned for the
/// same release as the GUI; if the flag ships later, only this constant
/// moves. Below it the launcher opens the player without a lock — and
/// cannot tell an open player from a closed one.
pub const INSTANCE_LOCK_MIN_PLAYER_VERSION: [u64; 3] = [0, 8, 0];

/// Whether a player of this version takes `--instance-lock`.
pub fn player_has_instance_lock(version: [u64; 3]) -> bool {
    version >= INSTANCE_LOCK_MIN_PLAYER_VERSION
}

/// The first player release whose `gui` face hosts the control API
/// (`gui --serve-port <port>`, the player repo's gui/control module): the
/// face mStream's server adopts as its server-audio engine while the
/// desktop player is open (src/state/server-audio.js), so the machine has
/// one player. Planned as the release after 0.8.1; if it ships under
/// another number, only this constant moves — with the pin bump that
/// adopts that release. Below it the launcher passes no port: the flag
/// would be an unknown argument to an older player, and the GUI would not
/// open at all.
pub const CONTROL_FACE_MIN_PLAYER_VERSION: [u64; 3] = [0, 9, 0];

/// Whether a player of this version hosts the control face under `gui`.
pub fn player_has_control_face(version: [u64; 3]) -> bool {
    version >= CONTROL_FACE_MIN_PLAYER_VERSION
}

/// The server-audio engine's port when the config does not say
/// (src/state/config.js: `rustPlayerPort`, default 3333).
pub const DEFAULT_PLAYER_PORT: u16 = 3333;

/// The port the desktop player hosts its control face on: the server's
/// configured player port, `rustPlayerPort`. Always — whether or not
/// autoBootServerAudio is on. That port is mStream's player port by
/// configuration whichever engine holds it, so the GUI needs no port of its
/// own, and the switch decides only whether the server takes the desktop
/// player up on its offer. Read the way read_endpoint reads `port` (the
/// same file, BOM and all); a value the server's schema would refuse — it
/// wants an integer 1..=65535 — falls back to the default the server itself
/// falls back to. Read once at boot with the rest of the player's facts; an
/// admin's port change reaches the next launcher session, and the server
/// adopts by the port the player's sidecar names regardless.
pub fn rust_player_port(config: &Path) -> u16 {
    std::fs::read_to_string(config)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s.trim_start_matches('\u{feff}')).ok())
        .as_ref()
        .and_then(|v| v.get("rustPlayerPort"))
        .and_then(joi_port)
        // joi_port admits 0 (the listen port's schema does); this one's
        // schema starts at 1.
        .filter(|port| *port >= 1)
        .unwrap_or(DEFAULT_PLAYER_PORT)
}

/// The desktop player's instance lock: one per data home — one per server
/// install — next to launcher.lock. The launcher hands the path to the
/// player, which holds an exclusive lock on it for its lifetime, and tries
/// the same lock before every open (tray_app::desktop_player_running).
pub fn desktop_player_lock(data_home: &Path) -> PathBuf {
    data_home.join("desktop-player.lock")
}

/// What the player writes beside its lock while it holds it (the player
/// repo's instance.rs: the lock path with a .json extension). Read only
/// behind a lock check — a crash leaves the file behind with the lock
/// released — and only for what the focus step needs. DATA from another
/// process: the pid is a number, the host a bounded token, and nothing
/// else in the file is trusted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlayerSidecar {
    pub pid: u32,
    /// `ghostty`, `apple-terminal`, `windows-terminal`, `conhost`, … — or
    /// `unknown` for anything unreadable.
    pub host: String,
}

pub fn read_player_sidecar(lock: &Path) -> Option<PlayerSidecar> {
    let doc = std::fs::read_to_string(lock.with_extension("json")).ok()?;
    parse_player_sidecar(&doc)
}

/// The parsing half, split out so tests can feed it documents directly.
pub(crate) fn parse_player_sidecar(doc: &str) -> Option<PlayerSidecar> {
    let v = serde_json::from_str::<serde_json::Value>(doc).ok()?;
    let pid = v.get("pid")?.as_u64().and_then(|n| u32::try_from(n).ok())?;
    let host = v
        .get("host")
        .and_then(|h| h.as_str())
        .filter(|h| {
            !h.is_empty()
                && h.len() <= 32
                && h.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '.' | '_'))
        })
        .unwrap_or("unknown")
        .to_string();
    Some(PlayerSidecar { pid, host })
}

/// What the macOS "Set up mStream" launch needs to prefer the bundled
/// Ghostty console over Terminal.app. Constructed on every platform (the
/// resolver just never finds one off-mac), read only by the macOS spawn.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Clone)]
pub struct ConsoleLaunch {
    /// console/Ghostty.app (the whole bundle; the launch execs its inner
    /// binary directly — no LaunchServices, no Gatekeeper prompt).
    pub ghostty_app: PathBuf,
    /// mStream.icns inside mStream.app — becomes the console's Dock icon
    /// (`macos-icon = custom`). None just keeps Ghostty's own icon.
    pub icon_icns: Option<PathBuf>,
}

/// The bundled Ghostty console — macOS bundles stage it at
/// console/Ghostty.app BESIDE mStream.app (never inside: both notarization
/// seals stay independent; scripts/build-bun.mjs). Three layouts can hold
/// one, checked most-specific first: running out of the versioned bundle dir
/// itself (an ancestor of the server binary); the ~/Applications copy of
/// mStream.app, whose versioned dir is wherever the install root's `current`
/// link points; and the .pkg install, whose io.mstream.console component
/// lands at the fixed system path (/Applications/mStream.app has no
/// versioned dir or current link at all). None on the other platforms and
/// on consoleless installs — the caller falls back to the Terminal.app path.
pub fn find_console_app(server_bin: &Path) -> Option<PathBuf> {
    find_console_app_in(
        server_bin,
        &data_home().join("app"),
        Path::new("/Library/Application Support/mStream"),
    )
}

fn find_console_app_in(server_bin: &Path, install_root: &Path, system_root: &Path) -> Option<PathBuf> {
    let ghostty = |app: &Path| app.join("Contents").join("MacOS").join("ghostty");
    let mut dir = server_bin.parent();
    for _ in 0..6 {
        let Some(d) = dir else { break };
        let candidate = d.join("console").join("Ghostty.app");
        if ghostty(&candidate).exists() {
            return Some(candidate);
        }
        dir = d.parent();
    }
    let current = install_root.join("current").join("console").join("Ghostty.app");
    if ghostty(&current).exists() {
        return Some(current);
    }
    let system = system_root.join("console").join("Ghostty.app");
    ghostty(&system).exists().then_some(system)
}

/// Escape a literal string for use inside a POSIX ERE (the pgrep -f
/// patterns built from filesystem paths): a HOME containing '+', '?',
/// '(' or brackets must match itself — a metacharacter that COMPILES but
/// narrows the pattern silently under-matches, and for a busy-check that
/// under-match is a deleted live tree. Both callers (the aside sweep and
/// the open-handoff liveness probe) are macOS-only; `test` keeps the
/// matrix test compiling on every host.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn escape_ere(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        if "\\^$.|?*+()[]{}".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// The status file the server's update checker writes
/// (src/util/update-check.js) — same data home that holds launcher.lock, by
/// the same byte-identical derivation on both sides.
pub fn update_status_file() -> PathBuf {
    data_home().join("update-status.json")
}

/// What the tray needs from update-status.json. Everything here is DATA from
/// a file another process writes: versions are shape-checked before display,
/// paths are validated against expectations before use, and nothing else is
/// trusted at all (no URLs, no commands).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UpdateStatus {
    /// The running server's own version, as it reported it at boot.
    pub current: Option<String>,
    pub latest: Option<String>,
    pub available: bool,
    pub method: Option<String>,
    pub staged: bool,
    pub staged_version: Option<String>,
    pub downloading: bool,
    /// auto mode / a webapp "restart to update" click: the server asks the
    /// launcher to apply on its next tick.
    pub apply_requested: bool,
    /// Fresh per arm (an ISO timestamp; treated as an opaque token): a
    /// failed apply is retried only when a NEW request arrives — comparing
    /// this rules out both same-version retry loops and stale replays.
    pub apply_requested_at: Option<String>,
    /// inno/pkg: the verified installer the server downloaded. Validated
    /// (location + name shape) before the launcher will touch it.
    pub installer_path: Option<PathBuf>,
    /// `latest` is the version the operator skipped (updates.skipVersion).
    pub skipped: bool,
    /// `latest` failed to boot after an earlier update and the boot
    /// watchdog holds it back (update-hold.json).
    pub held: bool,
    /// The release feed speaks an update format newer than this server's:
    /// `latest` is announced, and the way to it is re-running the install.
    pub notify_only: bool,
}

impl UpdateStatus {
    /// Whether the server has ruled `latest` out of everything but a
    /// mention: update-check.js neither downloads nor applies a skipped,
    /// held or notify-only release (backgroundStageWanted, stageNow), and
    /// the admin panel offers no button for one, so the tray must not hand
    /// the same release over by another road.
    pub fn latest_withheld(&self) -> bool {
        self.skipped || self.held || self.notify_only
    }
}

/// A display-safe version: bare digits-and-dots triple, bounded length —
/// anything else in the file renders as if absent, so a corrupted or
/// malicious status file can't put arbitrary text in the menu.
pub fn sanitize_version(s: &str) -> Option<String> {
    if s.len() > 24 || s.is_empty() {
        return None;
    }
    let mut dots = 0;
    for c in s.chars() {
        match c {
            '0'..='9' => {}
            '.' => dots += 1,
            _ => return None,
        }
    }
    (dots == 2 && !s.starts_with('.') && !s.ends_with('.')).then(|| s.to_string())
}

/// Tolerant read of the status file: absent, unreadable, or garbage all come
/// back as None; unknown fields are ignored (the server may write a newer
/// schema than this launcher knows).
pub fn read_update_status() -> Option<UpdateStatus> {
    parse_update_status(&std::fs::read_to_string(update_status_file()).ok()?)
}

/// The parsing half, split out so tests can feed it documents directly.
pub fn parse_update_status(doc: &str) -> Option<UpdateStatus> {
    let v = serde_json::from_str::<serde_json::Value>(doc).ok()?;
    let ver = |key: &str| v.get(key).and_then(|x| x.as_str()).and_then(sanitize_version);
    let flag = |key: &str| v.get(key).and_then(|x| x.as_bool()).unwrap_or(false);
    Some(UpdateStatus {
        current: ver("current"),
        latest: ver("latest"),
        available: flag("available"),
        method: v
            .get("method")
            .and_then(|x| x.as_str())
            .filter(|s| s.len() <= 16 && s.chars().all(|c| c.is_ascii_lowercase() || c == '-'))
            .map(str::to_string),
        staged: flag("staged"),
        staged_version: ver("stagedVersion"),
        downloading: flag("downloading"),
        apply_requested: flag("applyRequested"),
        apply_requested_at: v
            .get("applyRequestedAt")
            .and_then(|x| x.as_str())
            .filter(|t| t.len() <= 40 && t.chars().all(|c| c.is_ascii_graphic()))
            .map(str::to_string),
        installer_path: v.get("installerPath").and_then(|x| x.as_str()).map(PathBuf::from),
        skipped: flag("skipped"),
        held: flag("held"),
        notify_only: flag("notifyOnly"),
    })
}

/// The bundle-dir naming the installers create: mStream-<X.Y.Z>-<key> ->
/// (version, key). Mirrors parseBundleName in src/util/update-check.js
/// closely enough for target derivation (the final existence check is the
/// real gate).
pub(crate) fn parse_bundle_dir_name(name: &str) -> Option<(String, String)> {
    let rest = name.strip_prefix("mStream-")?;
    let dash = rest.find(|c: char| !(c.is_ascii_digit() || c == '.'))?;
    if dash == 0 || !rest[dash..].starts_with('-') {
        return None;
    }
    let version = sanitize_version(&rest[..dash])?;
    let key = &rest[dash + 1..];
    let ok = ["darwin-", "linux-", "win-"].iter().any(|p| key.starts_with(p))
        && key.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !key.ends_with('-');
    ok.then(|| (version, key.to_string()))
}

pub fn is_bundle_dir_name(name: &str) -> bool {
    parse_bundle_dir_name(name).is_some()
}

/// The launcher face's path inside a bundle, per platform.
pub(crate) fn launcher_rel() -> &'static str {
    if cfg!(windows) {
        "mStream.exe"
    } else if cfg!(target_os = "macos") {
        "mStream.app/Contents/MacOS/mStream"
    } else {
        "mstream-desktop"
    }
}

/// Where "restart into the staged update" should exec from — derived from
/// OUR OWN location, never from the status file:
///
///   - running from the ~/Applications copy (macOS): our own exe path — the
///     path is stable across upgrades and the installer refreshed its
///     CONTENTS when it staged;
///   - running from a managed versioned dir: `<root>/current/<face>`, which
///     the flip already points at the new version;
///   - anything else (portable, dev): None — the menu item stays inert.
///
/// `exe` is the REAL path of the running launcher (caller passes
/// current_exe(); tests pass fabricated layouts).
pub fn derive_relaunch_target(exe: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let apps_copy = home_dir().join("Applications").join("mStream.app");
        if exe.starts_with(&apps_copy) && exe.exists() {
            return Some(exe.to_path_buf());
        }
    }
    let mut dir = exe.parent()?;
    for _ in 0..8 {
        let parent = dir.parent()?;
        if dir
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(is_bundle_dir_name)
        {
            let target = parent.join("current").join(launcher_rel());
            if target.exists() {
                return Some(target);
            }
            return None;
        }
        dir = parent;
    }
    None
}

/// Locate the server binary: explicit override (--server-bin /
/// MSTREAM_SERVER_BIN), else the `mstream-server` sibling the bundles stage
/// next to the launcher (phase 1c renames the shipped binaries to this).
pub fn find_server_bin(explicit: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(p) = explicit {
        if p.exists() {
            return Ok(p.to_path_buf());
        }
        return Err(format!("server binary not found at {}", p.display()));
    }
    let name = if cfg!(windows) { "mstream-server.exe" } else { "mstream-server" };
    let sibling = exe_dir().join(name);
    if sibling.exists() {
        return Ok(sibling);
    }
    Err(format!(
        "no server binary: expected {} next to the launcher (or set MSTREAM_SERVER_BIN)",
        sibling.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ep(v: serde_json::Value) -> Endpoint {
        // read_endpoint wants a file; route through a scratch one.
        let p = env::temp_dir().join(format!(
            "mstream-launcher-test-{}-{:p}.json",
            std::process::id(),
            &v
        ));
        std::fs::write(&p, v.to_string()).unwrap();
        let out = read_endpoint(&p);
        let _ = std::fs::remove_file(&p);
        out
    }

    #[test]
    fn player_key_matches_node_bootstrap_shape() {
        // The manifest and the bundle are keyed by the full filename; this
        // must stay in lockstep with playerKey() in
        // src/util/mstream-player-bootstrap.js.
        let key = player_key();
        #[cfg(target_os = "macos")]
        assert!(key.starts_with("mstream-player-darwin-"), "{key}");
        #[cfg(windows)]
        {
            assert!(key.starts_with("mstream-player-win32-"), "{key}");
            assert!(key.ends_with(".exe"), "{key}");
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        assert!(key.starts_with("mstream-player-linux-"), "{key}");
        assert!(!key.contains("x86_64") && !key.contains("aarch64"), "node arch names, not Rust's: {key}");
    }

    #[test]
    fn find_player_bin_prefers_bundled_then_managed() {
        let root = env::temp_dir().join(format!("mstream-launcher-player-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let bundle = root.join("bundle");
        let home = root.join("home");
        let key = player_key();
        let server = bundle.join("mstream-server");
        std::fs::create_dir_all(bundle.join("bin/mstream-player")).unwrap();
        std::fs::create_dir_all(home.join("bin/mstream-player")).unwrap();

        assert_eq!(find_player_bin(&server, &home), None, "neither copy exists yet");

        let managed = home.join("bin/mstream-player").join(&key);
        std::fs::write(&managed, b"x").unwrap();
        assert_eq!(find_player_bin(&server, &home), Some(managed), "managed fallback");

        let bundled = bundle.join("bin/mstream-player").join(&key);
        std::fs::write(&bundled, b"x").unwrap();
        assert_eq!(find_player_bin(&server, &home), Some(bundled), "bundled copy wins");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn player_versions_parse_and_gate_the_gui() {
        // clap's --version line, exactly as the pinned builds print it.
        assert_eq!(parse_player_version("mstream-player 0.7.0\n"), Some([0, 7, 0]));
        assert_eq!(parse_player_version("mstream-player 0.8.0"), Some([0, 8, 0]));
        assert_eq!(parse_player_version("mstream-player 10.20.30\ntrailing noise"), Some([10, 20, 30]));
        // A pre-release or build tag is a build of that version.
        assert_eq!(parse_player_version("mstream-player 0.8.0-beta.1"), Some([0, 8, 0]));
        assert_eq!(parse_player_version("mstream-player 1.0.0+abc123"), Some([1, 0, 0]));
        // Anything else — a foreign binary, a loader error, a truncated
        // number — is not a version, never a guess.
        for junk in ["", "0.8.0", "mstream-server 6.30.0", "mstream-player 0.8", "mstream-player 0.8.0.1", "mstream-player x.y.z", "mstream-player"] {
            assert_eq!(parse_player_version(junk), None, "{junk:?}");
        }
        // The gate: the release that grew `gui` and everything after it.
        assert!(!player_has_gui([0, 7, 0]));
        assert!(!player_has_gui([0, 7, 99]), "a 0.7.x patch release has no GUI");
        assert!(player_has_gui(GUI_MIN_PLAYER_VERSION));
        assert!(player_has_gui([0, 9, 0]));
        assert!(player_has_gui([1, 0, 0]));
        assert_eq!(version_label(GUI_MIN_PLAYER_VERSION), "0.8.0");
    }

    #[test]
    fn the_probes_second_line_names_the_flavour() {
        // One line: every terminal build, and every release before the
        // desktop flavour existed.
        assert!(!parse_player_desktop("mstream-player 0.9.0"));
        assert!(!parse_player_desktop("mstream-player 0.9.0\n"));
        // Two lines, exactly as the desktop build prints them — with and
        // without the trailing newline, and with Windows line ends.
        assert!(parse_player_desktop("mstream-player 0.9.0\nfeatures: window"));
        assert!(parse_player_desktop("mstream-player 0.9.0\nfeatures: window\n"));
        assert!(parse_player_desktop("mstream-player 0.9.0\r\nfeatures: window\r\n"));
        // A later build may list more; the word is what counts.
        assert!(parse_player_desktop("mstream-player 1.0.0\nfeatures: gpu, window\n"));
        assert!(parse_player_desktop("mstream-player 1.0.0\nfeatures: window tray\n"));
        // Garbage after the second line is never read.
        assert!(parse_player_desktop("mstream-player 0.9.0\nfeatures: window\nfeatures: nothing\n\u{0}junk"));
        assert!(!parse_player_desktop("mstream-player 0.9.0\nnot features\nfeatures: window\n"), "only the second line counts");
        // Near misses are terminal builds, never a guess.
        for line in ["features: windows", "features: no-window", "features:", "features window", "Features: window", "window", ""] {
            assert!(!parse_player_desktop(&format!("mstream-player 0.9.0\n{line}\n")), "{line:?}");
        }
        // The first line is the version parser's alone: a desktop build's
        // probe still reads as its version.
        assert_eq!(parse_player_version("mstream-player 0.9.0\nfeatures: window\n"), Some([0, 9, 0]));
    }

    #[test]
    fn player_version_probe_reads_a_real_process() {
        // A stand-in binary that answers --version the way the player does;
        // the probe runs it for real (spawn, capture, parse). Unix only for
        // the shell-script stand-in; the parse itself is pinned above.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let dir = env::temp_dir().join(format!("mstream-launcher-pver-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let stub = dir.join("mstream-player");
            std::fs::write(&stub, "#!/bin/sh\n[ \"$1\" = --version ] && echo 'mstream-player 0.8.0' && exit 0\nexit 2\n").unwrap();
            std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(player_probe(&stub), Some(PlayerProbe { version: [0, 8, 0], desktop: false }));
            // A desktop build answers a second line; the same run reads it.
            let desk = dir.join("desktop-player");
            std::fs::write(&desk, "#!/bin/sh\n[ \"$1\" = --version ] && printf 'mstream-player 0.9.0\\nfeatures: window\\n' && exit 0\nexit 2\n").unwrap();
            std::fs::set_permissions(&desk, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(player_probe(&desk), Some(PlayerProbe { version: [0, 9, 0], desktop: true }));
            // A binary that cannot run (the linux loader failure shape: a
            // non-zero exit and nothing useful on stdout) is None.
            let dead = dir.join("dead-player");
            std::fs::write(&dead, "#!/bin/sh\necho 'error while loading shared libraries' >&2\nexit 127\n").unwrap();
            std::fs::set_permissions(&dead, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(player_probe(&dead), None);
            assert_eq!(player_probe(&dir.join("no-such-binary")), None);
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn the_instance_lock_lives_in_the_data_home_and_gates_on_the_player() {
        assert_eq!(desktop_player_lock(Path::new("/data/home")), PathBuf::from("/data/home/desktop-player.lock"));
        assert!(!player_has_instance_lock([0, 7, 0]));
        assert!(player_has_instance_lock(INSTANCE_LOCK_MIN_PLAYER_VERSION));
        assert!(player_has_instance_lock([1, 0, 0]));
    }

    #[test]
    fn the_control_face_gates_on_the_player_and_its_port_is_the_servers() {
        assert!(!player_has_control_face([0, 8, 1]), "0.8.1 has the GUI and the lock, not the face");
        assert!(player_has_control_face(CONTROL_FACE_MIN_PLAYER_VERSION));
        assert!(player_has_control_face([1, 0, 0]));

        let dir = std::env::temp_dir().join(format!("mstream-launcher-player-port-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("default.json");
        // No file, no key, and values the server's schema refuses all mean
        // the default — the port the server itself would then use.
        assert_eq!(rust_player_port(&p), DEFAULT_PLAYER_PORT, "no config yet");
        for text in ["{}", r#"{"rustPlayerPort": 0}"#, r#"{"rustPlayerPort": 70000}"#, r#"{"rustPlayerPort": "lots"}"#, "not json"] {
            std::fs::write(&p, text).unwrap();
            assert_eq!(rust_player_port(&p), DEFAULT_PLAYER_PORT, "{text}");
        }
        std::fs::write(&p, "\u{feff}{ \"rustPlayerPort\": 4444, \"port\": 3000 }").unwrap();
        assert_eq!(rust_player_port(&p), 4444, "read like the server reads it, BOM and all");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn player_sidecars_are_read_tolerantly_and_untrusted() {
        let ok = parse_player_sidecar(r#"{"schema":1,"pid":4242,"face":"gui","host":"ghostty","startedAt":1727500000}"#).unwrap();
        assert_eq!(ok, PlayerSidecar { pid: 4242, host: "ghostty".into() });
        // A later schema's extra fields are ignored; the pid is the one thing
        // the file must carry.
        assert_eq!(
            parse_player_sidecar(r#"{"schema":9,"pid":7,"host":"apple-terminal","port":3333}"#).unwrap().host,
            "apple-terminal"
        );
        assert_eq!(parse_player_sidecar(r#"{"host":"ghostty"}"#), None, "no pid, no sidecar");
        assert_eq!(parse_player_sidecar("not json"), None);
        // A host that is not a plain token reads as unknown — never as text
        // the log would repeat.
        let long = format!(r#"{{"pid":1,"host":"{}"}}"#, "x".repeat(40));
        for odd in [r#"{"pid":1,"host":"Ghostty; rm -rf /"}"#, r#"{"pid":1,"host":""}"#, r#"{"pid":1}"#, long.as_str()] {
            assert_eq!(parse_player_sidecar(odd).unwrap().host, "unknown", "{odd}");
        }
        // The file beside a lock: written by the player, read by us.
        let dir = env::temp_dir().join(format!("mstream-launcher-sidecar-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let lock = dir.join("desktop-player.lock");
        assert_eq!(read_player_sidecar(&lock), None);
        std::fs::write(dir.join("desktop-player.json"), r#"{"schema":1,"pid":99,"host":"windows-terminal"}"#).unwrap();
        assert_eq!(read_player_sidecar(&lock), Some(PlayerSidecar { pid: 99, host: "windows-terminal".into() }));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn setup_complete_reads_the_flag_with_a_legacy_folders_belt() {
        let p = env::temp_dir().join(format!("mstream-launcher-setup-{}.json", std::process::id()));
        // Absent config = a true first run (the server writes it mid-boot).
        let _ = std::fs::remove_file(&p);
        assert!(!setup_complete(&p));
        // Fresh modern config: no flag, no folders.
        std::fs::write(&p, "{ \"port\": 3000 }").unwrap();
        assert!(!setup_complete(&p));
        // The server wrote the one-time marker.
        std::fs::write(&p, "{ \"setupComplete\": true }").unwrap();
        assert!(setup_complete(&p));
        // An explicit false stays false (never written by us, but honest).
        std::fs::write(&p, "{ \"setupComplete\": false }").unwrap();
        assert!(!setup_complete(&p));
        // Legacy belt: an OLD server never writes the flag, but old-style
        // configs still carry their folders.
        std::fs::write(&p, "{ \"folders\": { \"m\": { \"root\": \"/x\" } } }").unwrap();
        assert!(setup_complete(&p));
        std::fs::write(&p, "{ \"folders\": {} }").unwrap();
        assert!(!setup_complete(&p));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn find_console_app_walks_bundle_then_install_root() {
        let root = env::temp_dir().join(format!("mstream-launcher-console-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let bundle = root.join("mStream-9.9.9-darwin-arm64");
        let server = bundle.join("mStream.app/Contents/MacOS/mstream-server");
        let install_root = root.join("approot");
        let system_root = root.join("syslib");
        std::fs::create_dir_all(server.parent().unwrap()).unwrap();
        assert_eq!(find_console_app_in(&server, &install_root, &system_root), None, "nothing staged yet");

        let ghostty_bin_dir = bundle.join("console/Ghostty.app/Contents/MacOS");
        std::fs::create_dir_all(&ghostty_bin_dir).unwrap();
        std::fs::write(ghostty_bin_dir.join("ghostty"), b"x").unwrap();
        assert_eq!(
            find_console_app_in(&server, &install_root, &system_root),
            Some(bundle.join("console/Ghostty.app")),
            "ancestor walk finds the bundle's console"
        );

        // The .pkg layout: the server binary is inside /Applications'
        // mStream.app, with NO versioned dir and NO current link — the
        // io.mstream.console component's fixed system path is the answer.
        let apps_copy = root.join("Applications/mStream.app/Contents/MacOS/mstream-server");
        std::fs::create_dir_all(apps_copy.parent().unwrap()).unwrap();
        assert_eq!(
            find_console_app_in(&apps_copy, &install_root, &system_root),
            None,
            "no current link and no system console yet"
        );
        let sys_bin_dir = system_root.join("console/Ghostty.app/Contents/MacOS");
        std::fs::create_dir_all(&sys_bin_dir).unwrap();
        std::fs::write(sys_bin_dir.join("ghostty"), b"x").unwrap();
        assert_eq!(
            find_console_app_in(&apps_copy, &install_root, &system_root),
            Some(system_root.join("console/Ghostty.app")),
            "the pkg install resolves through the system path"
        );

        // The ~/Applications copy of a SCRIPT install: resolution goes
        // through the install root's `current` link, which outranks the
        // system path when both exist (unix-only mechanics, like the
        // install).
        #[cfg(unix)]
        {
            std::fs::create_dir_all(&install_root).unwrap();
            std::os::unix::fs::symlink(&bundle, install_root.join("current")).unwrap();
            assert_eq!(
                find_console_app_in(&apps_copy, &install_root, &system_root),
                Some(install_root.join("current/console/Ghostty.app")),
                "the current link outranks the pkg system path"
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn bom_from_powershell_utf8_is_tolerated() {
        // PowerShell 5.1's `Set-Content -Encoding UTF8` prepends a BOM; the
        // server strips it before parsing, so this side must too — a BOM'd
        // port must not send the launcher probing the 3000 fallback.
        let p = env::temp_dir().join(format!("mstream-launcher-bom-{}.json", std::process::id()));
        std::fs::write(&p, "\u{feff}{ \"port\": 8123, \"setupComplete\": true }").unwrap();
        assert_eq!(read_endpoint(&p).port, 8123);
        assert!(setup_complete(&p));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn port_shapes_joi_accepts() {
        assert_eq!(ep(json!({"port": 8000})).port, 8000);
        assert_eq!(ep(json!({"port": "8000"})).port, 8000, "quoted port must match Joi's coercion");
        assert_eq!(ep(json!({"port": 8000.0})).port, 8000, "float-integral port must match Joi");
        assert_eq!(ep(json!({"port": " 8000 "})).port, 8000);
        assert_eq!(ep(json!({"port": "8000.5"})).port, 3000, "non-integral falls back");
        assert_eq!(ep(json!({"port": 70000})).port, 3000, "out of range falls back");
        assert_eq!(ep(json!({"port": "nope"})).port, 3000);
        assert_eq!(ep(json!({})).port, 3000);
    }

    #[test]
    fn address_maps_to_probe_target() {
        let lo = IpAddr::V4(Ipv4Addr::LOCALHOST);
        assert_eq!(ep(json!({})).ip, lo, "absent address probes loopback");
        assert_eq!(ep(json!({"address": "::"})).ip, lo, "wildcard probes loopback");
        assert_eq!(ep(json!({"address": "0.0.0.0"})).ip, lo);
        assert_eq!(ep(json!({"address": "192.168.1.20"})).ip, "192.168.1.20".parse::<IpAddr>().unwrap());
        assert_eq!(ep(json!({"address": "::1"})).ip, "::1".parse::<IpAddr>().unwrap());
        assert_eq!(ep(json!({"address": "not-an-ip"})).ip, lo, "garbage keeps today's behavior");
    }

    #[test]
    fn url_renders_pinned_hosts() {
        let mk = |ip: &str, port| Endpoint { ip: ip.parse().unwrap(), port };
        assert_eq!(server_url(&mk("127.0.0.1", 3000)), "http://localhost:3000");
        assert_eq!(server_url(&mk("::1", 3000)), "http://localhost:3000");
        assert_eq!(server_url(&mk("192.168.1.20", 8000)), "http://192.168.1.20:8000");
        assert_eq!(server_url(&mk("fd00::5", 8000)), "http://[fd00::5]:8000");
    }

    #[test]
    fn duplicate_j_takes_last_like_the_server() {
        let args: Vec<String> =
            ["-j", "a.json", "-j", "b.json"].iter().map(|s| s.to_string()).collect();
        assert_eq!(resolve_config_path(&args, Path::new("/nowhere")), PathBuf::from("b.json"));
        let args: Vec<String> =
            ["-j", "a.json", "--json=c.json"].iter().map(|s| s.to_string()).collect();
        assert_eq!(resolve_config_path(&args, Path::new("/nowhere")), PathBuf::from("c.json"));
    }

    #[test]
    fn trailing_j_without_value_falls_through() {
        let dir = env::temp_dir().join(format!("mstream-launcher-anchor-{}", std::process::id()));
        let args: Vec<String> = ["--portable", "-j"].iter().map(|s| s.to_string()).collect();
        assert_eq!(
            resolve_config_path(&args, &dir),
            dir.join("save").join("conf").join("default.json")
        );
    }

    #[test]
    fn ladder_anchors_at_the_server_dir() {
        let dir = env::temp_dir().join(format!("mstream-launcher-legacy-{}", std::process::id()));
        let conf = dir.join("save").join("conf");
        std::fs::create_dir_all(&conf).unwrap();
        std::fs::write(conf.join("default.json"), "{}").unwrap();
        let got = resolve_config_path(&[], &dir);
        assert_eq!(got, conf.join("default.json"), "existing save/ next to the SERVER wins");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn library_configured_detection() {
        // Garbage shapes must read as not-set-up, never panic.
        let dir = env::temp_dir();
        let f = |name: &str, body: &str| {
            let p = dir.join(format!("mstream-lib-{}-{}.json", std::process::id(), name));
            std::fs::write(&p, body).unwrap();
            p
        };
        let garbage = f("garbage", r#"{"folders":"nope"}"#);
        assert!(!setup_complete(&garbage), "non-object folders = not set up");
        let flag_garbage = f("flaggarbage", r#"{"setupComplete":"yes"}"#);
        assert!(!setup_complete(&flag_garbage), "non-bool flag = not set up");
        for p in [garbage, flag_garbage] { let _ = std::fs::remove_file(p); }
    }

    #[test]
    fn browse_target_lands_on_admin_until_setup_completes() {
        let ep = Endpoint { ip: IpAddr::V4(Ipv4Addr::LOCALHOST), port: 3000 };
        assert_eq!(browse_target(Path::new("/nope.json"), &ep), "http://localhost:3000/admin");
        let p = env::temp_dir().join(format!("mstream-bt-{}.json", std::process::id()));
        std::fs::write(&p, r#"{"folders":{"music":{"root":"/m"}}}"#).unwrap();
        assert_eq!(browse_target(&p, &ep), "http://localhost:3000");
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn empty_env_counts_as_unset() {
        let var = format!("MSTREAM_TEST_EMPTY_{}", std::process::id());
        env::set_var(&var, "");
        assert_eq!(env_dir(&var), None, "exported-but-empty must read as unset (JS + XDG)");
        env::set_var(&var, "x");
        assert_eq!(env_dir(&var), Some(OsString::from("x")));
        env::remove_var(&var);
    }

    #[test]
    fn ere_escaping_neutralizes_path_metacharacters() {
        assert_eq!(escape_ere("/Users/plain/Applications"), "/Users/plain/Applications");
        assert_eq!(escape_ere("a+b"), "a\\+b");
        assert_eq!(escape_ere("q?"), "q\\?");
        assert_eq!(escape_ere("x{1}"), "x\\{1\\}");
        assert_eq!(escape_ere("(par)[br]"), "\\(par\\)\\[br\\]");
        assert_eq!(escape_ere("dot.dir"), "dot\\.dir");
        assert_eq!(escape_ere("back\\slash"), "back\\\\slash");
    }

    #[test]
    fn versions_are_display_safe_or_absent() {
        assert_eq!(sanitize_version("6.21.2"), Some("6.21.2".to_string()));
        assert_eq!(sanitize_version("10.0.999"), Some("10.0.999".to_string()));
        assert_eq!(sanitize_version("v6.21.2"), None);
        assert_eq!(sanitize_version("6.21"), None);
        assert_eq!(sanitize_version("6.21.2-beta.1"), None);
        assert_eq!(sanitize_version("6.21.2\n<script>"), None);
        assert_eq!(sanitize_version(""), None);
        assert_eq!(sanitize_version(&"9".repeat(30)), None, "length-capped");
        assert_eq!(sanitize_version(".1.2"), None);
        assert_eq!(sanitize_version("1.2."), None);
    }

    #[test]
    fn bundle_dir_names() {
        assert!(is_bundle_dir_name("mStream-6.21.2-darwin-arm64"));
        assert!(is_bundle_dir_name("mStream-6.21.2-linux-x64-musl"));
        assert!(is_bundle_dir_name("mStream-6.21.2-win-x64"));
        assert!(!is_bundle_dir_name("mStream-6.21.2-darwin-arm64.partial"));
        assert!(!is_bundle_dir_name("current"));
        assert!(!is_bundle_dir_name("mStream-latest-linux-x64"));
        assert!(!is_bundle_dir_name("mStream.app"));
        // The parsed halves, for the rollback module's candidate scan.
        assert_eq!(
            parse_bundle_dir_name("mStream-6.21.2-linux-arm64-musl"),
            Some(("6.21.2".to_string(), "linux-arm64-musl".to_string()))
        );
        assert_eq!(parse_bundle_dir_name("mStream-6.21.2-linux-x64.replaced-2026"), None);
    }

    #[test]
    fn status_parsing_is_tolerant_and_untrusting() {
        assert_eq!(parse_update_status("not json"), None);
        assert_eq!(parse_update_status(""), None);
        // Unknown fields ignored; knowns picked out; junk versions dropped.
        let s = parse_update_status(
            r#"{"schema": 9, "surprise": [1], "current": "6.21.2", "latest": "not a version",
                "available": true, "method": "managed", "staged": true,
                "stagedVersion": "6.22.0", "applyRequested": "yes-as-string"}"#,
        )
        .unwrap();
        assert_eq!(s.current.as_deref(), Some("6.21.2"));
        assert_eq!(s.latest, None, "garbage version renders as absent");
        assert!(s.available && s.staged);
        assert_eq!(s.staged_version.as_deref(), Some("6.22.0"));
        assert!(!s.apply_requested, "non-bool flag reads as false, never truthy");
        assert_eq!(s.apply_requested_at, None);
        let armed = parse_update_status(
            r#"{"applyRequested": true, "applyRequestedAt": "2026-08-20T12:00:00.000Z"}"#,
        )
        .unwrap();
        assert!(armed.apply_requested);
        assert_eq!(armed.apply_requested_at.as_deref(), Some("2026-08-20T12:00:00.000Z"));
        // Oversized or non-printable tokens are dropped, not displayed/compared.
        let junk = parse_update_status(&format!(
            r#"{{"applyRequestedAt": "{}"}}"#, "x".repeat(60)
        ))
        .unwrap();
        assert_eq!(junk.apply_requested_at, None);
        assert_eq!(s.method.as_deref(), Some("managed"));
        // A method with unexpected characters is dropped, not displayed.
        let odd = parse_update_status(r#"{"method": "Managed; rm -rf /"}"#).unwrap();
        assert_eq!(odd.method, None);
        // The server's reasons to leave `latest` alone, each on its own and
        // read as booleans only.
        assert!(!s.skipped && !s.held && !s.notify_only && !s.latest_withheld());
        for (key, pick) in [
            ("skipped", (|s: &UpdateStatus| s.skipped) as fn(&UpdateStatus) -> bool),
            ("held", |s| s.held),
            ("notifyOnly", |s| s.notify_only),
        ] {
            let on = parse_update_status(&format!(r#"{{"{key}": true}}"#)).unwrap();
            assert!(pick(&on) && on.latest_withheld(), "{key}");
            let off = parse_update_status(&format!(r#"{{"{key}": "true"}}"#)).unwrap();
            assert!(!pick(&off) && !off.latest_withheld(), "{key}: a non-bool is false");
        }
    }

    #[test]
    fn relaunch_target_resolves_through_current() {
        let root = env::temp_dir().join(format!("mstream-relaunch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let bundle = root.join("mStream-6.21.2-linux-x64");
        // The launcher "runs" from the versioned dir; current points at a
        // NEWER bundle whose face exists.
        let newer = root.join("mStream-6.22.0-linux-x64");
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::create_dir_all(&newer).unwrap();
        let face = newer.join(launcher_rel());
        if let Some(p) = face.parent() { std::fs::create_dir_all(p).unwrap(); }
        std::fs::write(&face, "x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&newer, root.join("current")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&newer, root.join("current")).unwrap();

        let exe = bundle.join(launcher_rel());
        let got = derive_relaunch_target(&exe);
        assert_eq!(got, Some(root.join("current").join(launcher_rel())));

        // Not under a managed layout: no target, item stays inert.
        assert_eq!(derive_relaunch_target(Path::new("/tmp/loose/mstream-desktop")), None);
        let _ = std::fs::remove_dir_all(&root);
    }
}
