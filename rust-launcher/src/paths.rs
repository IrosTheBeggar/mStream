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
    let v = std::fs::read_to_string(config)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
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
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
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
}
