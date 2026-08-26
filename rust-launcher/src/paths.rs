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

/// Whether the config declares any music folders. Unreadable or absent
/// config counts as unconfigured — on a true first run the file appears
/// mid-boot, and the right answer is the same either way.
pub fn library_is_configured(config: &Path) -> bool {
    std::fs::read_to_string(config)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s.trim_start_matches('\u{feff}')).ok())
        .and_then(|v| v.get("folders").and_then(|f| f.as_object().map(|o| !o.is_empty())))
        .unwrap_or(false)
}

/// Where a launcher-initiated browser open should land (the announce after
/// boot, a second instance yielding, a macOS reopen): the player when there
/// is music, the ADMIN PANEL when the library has no folders yet — a fresh
/// install's player is a dead end, and the admin panel is where folders get
/// added. The tray's explicit "Open mStream" item stays literal (always the
/// player) so the menu does what it says.
pub fn browse_target(config: &Path, ep: &Endpoint) -> String {
    if library_is_configured(config) {
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

/// The terminal player for the "Set up mStream" item: the copy build-bun
/// stages next to the server binary in every desktop bundle, else one the
/// server's runtime fetch installed in the shared data home. None disables
/// the item — a greyed entry beats a terminal window that dies instantly.
pub fn find_player_bin(server_bin: &Path, data_home: &Path) -> Option<PathBuf> {
    let key = player_key();
    let bundled = server_bin.parent()?.join("bin").join("mstream-player").join(&key);
    if bundled.exists() {
        return Some(bundled);
    }
    let managed = data_home.join("bin").join("mstream-player").join(&key);
    managed.exists().then_some(managed)
}

/// What the macOS "Set up mStream" launch needs to prefer the bundled
/// Ghostty console over Terminal.app. Constructed on every platform (the
/// resolver just never finds one off-mac), read only by the macOS spawn.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
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
        std::fs::write(&p, "\u{feff}{ \"port\": 8123, \"folders\": { \"m\": { \"root\": \"/x\" } } }").unwrap();
        assert_eq!(read_endpoint(&p).port, 8123);
        assert!(library_is_configured(&p));
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
        let dir = env::temp_dir();
        let f = |name: &str, body: &str| {
            let p = dir.join(format!("mstream-lib-{}-{}.json", std::process::id(), name));
            std::fs::write(&p, body).unwrap();
            p
        };
        assert!(!library_is_configured(Path::new("/definitely/not/there.json")), "absent config = unconfigured");
        let empty = f("empty", "{}");
        assert!(!library_is_configured(&empty), "no folders key = unconfigured");
        let bare = f("bare", r#"{"folders":{}}"#);
        assert!(!library_is_configured(&bare), "empty folders object = unconfigured");
        let garbage = f("garbage", r#"{"folders":"nope"}"#);
        assert!(!library_is_configured(&garbage), "non-object folders = unconfigured");
        let real = f("real", r#"{"folders":{"music":{"root":"/m"}}}"#);
        assert!(library_is_configured(&real));
        for p in [empty, bare, garbage, real] { let _ = std::fs::remove_file(p); }
    }

    #[test]
    fn browse_target_lands_on_admin_until_folders_exist() {
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
