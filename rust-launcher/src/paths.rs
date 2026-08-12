// Path resolution — a deliberate MIRROR of src/util/boot-config.js. The
// launcher must find the same config (and therefore the same port and data)
// the server resolves for itself; if you change the ladder there, change it
// here (test/unit/boot-config.test.mjs pins the JS side; the launcher smoke
// in CI pins agreement end-to-end).
use std::env;
use std::path::{Path, PathBuf};

/// Per-OS user data home for the desktop profile — mirrors userDataHome()
/// in src/util/boot-config.js (LOCALAPPDATA, not APPDATA: multi-GB caches
/// don't belong in a roaming profile).
pub fn data_home() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let base = env::var_os("LOCALAPPDATA")
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
        let base = env::var_os("XDG_DATA_HOME")
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

/// The config file the server will end up using for THIS invocation:
/// explicit -j wins, then MSTREAM_CONFIG, then the legacy/portable
/// next-to-binary file, then the desktop-profile data home.
pub fn resolve_config_path(server_args: &[String]) -> PathBuf {
    let mut it = server_args.iter();
    while let Some(a) = it.next() {
        if a == "-j" || a == "--json" {
            if let Some(p) = it.next() {
                return PathBuf::from(p);
            }
        } else if let Some(p) = a.strip_prefix("--json=") {
            return PathBuf::from(p);
        }
    }
    if let Some(p) = env::var_os("MSTREAM_CONFIG") {
        return PathBuf::from(p);
    }
    let legacy = exe_dir().join("save").join("conf").join("default.json");
    if server_args.iter().any(|a| a == "--portable") || legacy.exists() {
        return legacy;
    }
    data_home().join("conf").join("default.json")
}

/// Port the server will listen on: the config's `port`, else the Joi
/// default (3000). The config may not exist yet on a first run — the server
/// generates it — and 3000 is exactly what that generated config yields.
pub fn read_port(config: &Path) -> u16 {
    std::fs::read_to_string(config)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("port").and_then(|p| p.as_u64()))
        .and_then(|p| u16::try_from(p).ok())
        .unwrap_or(3000)
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

/// The tiny launcher state file (first-run marker for the autostart
/// default). Lives in the data home, NOT next to the binary — same
/// reasoning as the server's desktop profile.
pub fn state_file() -> PathBuf {
    data_home().join("launcher.json")
}

pub fn server_url(port: u16) -> String {
    format!("http://localhost:{port}")
}
