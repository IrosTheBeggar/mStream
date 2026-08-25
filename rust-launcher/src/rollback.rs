// Boot-failure rollback — the launcher-side safety net for a staged update
// that passes the installers' exec probe (`-V` answers) but cannot actually
// BOOT: a config/db/module-load regression crashes the new server before it
// ever serves. Before this module, that shape was a dead install: `current`,
// the login item, and the ~/Applications copy all point at the broken
// version (the stage-time flip), the launcher shows "Stopped" and never
// restarts a crashed server, and — because the SERVER is the update checker
// — the follow-up fixed release is never even discovered.
//
// The watchdog's contract (tray_app.rs decides WHEN; this module decides
// WHETHER and does the work):
//
//   plan_rollback   — is this a managed layout committed to OUR version,
//                     with a lower same-key version on disk whose server
//                     still execs? Pure-ish and injected, so the decision
//                     matrix is unit-testable.
//   execute_rollback— record the failed version in update-hold.json (the
//                     server reads it and refuses to re-stage that version,
//                     src/util/update-check.js — without the hold, the next
//                     daily check re-flips onto the very release the
//                     watchdog just backed out of), neutralize the stale
//                     status file (its applyRequested was armed by a
//                     now-dead server; the rolled-back launcher must not
//                     act on it), re-point `current`, and on macOS restore
//                     the ~/Applications copy from the target bundle (the
//                     .old.* aside is long swept — the versioned root copy
//                     is the rollback source). Returns the launcher face to
//                     hand off to via platform::relaunch + --takeover.
//
// A hold clears in two ways, both server-side: any boot of a version >= the
// held one deletes the entry (the fix shipped, or the failure was
// environmental and a human re-applied successfully), and the admin panel's
// clearHold override drops them all. So the "bad release, then a working
// release" flow needs no human: bad boots, watchdog rolls back, hold blocks
// re-staging, the fixed release stages and applies normally.
use crate::paths;
use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// One file, two writers who never overlap: the launcher appends here only
/// while no server runs (the rollback moment); the server prunes/clears it
/// while the launcher only reads. Lives beside update-status.json in the
/// shared data home.
pub const HOLD_FILE: &str = "update-hold.json";
const MAX_HELD: usize = 8;
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

pub struct RollbackPlan {
    pub root: PathBuf,
    /// The version this launcher shipped in — the one that failed to boot.
    pub failed_version: String,
    /// The versioned bundle dir to roll back to.
    pub target_bundle: PathBuf,
    pub target_version: String,
    /// macOS: the ~/Applications copy this launcher runs from, whose
    /// contents (refreshed to the failed version at stage time) must be
    /// restored from target_bundle. None when running from a versioned dir.
    /// Only macOS execute code reads it — planning stays one shared,
    /// cross-platform-tested path, so other targets carry the field unread.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub apps_copy: Option<PathBuf>,
}

/// Strict numeric-triple compare (mirrors compareVersions in
/// src/util/update-check.js): None for anything that is not X.Y.Z.
fn compare_triples(a: &str, b: &str) -> Option<Ordering> {
    fn parse(s: &str) -> Option<[u64; 3]> {
        let mut it = s.split('.');
        let out = [
            it.next()?.parse().ok()?,
            it.next()?.parse().ok()?,
            it.next()?.parse().ok()?,
        ];
        it.next().is_none().then_some(out)
    }
    Some(parse(a)?.cmp(&parse(b)?))
}

/// The server binary's path inside a bundle, per platform (install.sh's
/// server_rel / scripts/build-bun.mjs staging).
fn server_rel() -> &'static str {
    if cfg!(windows) {
        "mstream-server.exe"
    } else if cfg!(target_os = "macos") {
        "mStream.app/Contents/MacOS/mstream-server"
    } else {
        "mstream-server"
    }
}

/// Versions held after failed boots, read tolerantly: the file is our own
/// but may be absent, from a newer schema, or hand-mangled — garbage entries
/// drop out rather than wedging the watchdog.
pub fn held_versions(data_home: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(data_home.join(HOLD_FILE)) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    v.get("held")
        .and_then(|h| h.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| e.get("version").and_then(|x| x.as_str()))
                .filter_map(paths::sanitize_version)
                .take(MAX_HELD)
                .collect()
        })
        .unwrap_or_default()
}

/// Append `version` to the hold file (dedup; oldest entries give way past
/// the cap). Written atomically — a torn hold file would read as "nothing
/// held" and re-open the re-stage loop the hold exists to close.
fn record_hold(data_home: &Path, version: &str, reason: &str) -> Result<(), String> {
    let path = data_home.join(HOLD_FILE);
    let mut held: Vec<serde_json::Value> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("held").and_then(|h| h.as_array()).cloned())
        .unwrap_or_default()
        .into_iter()
        .filter(|e| {
            e.get("version")
                .and_then(|x| x.as_str())
                .and_then(paths::sanitize_version)
                .is_some()
        })
        .collect();
    if !held
        .iter()
        .any(|e| e.get("version").and_then(|x| x.as_str()) == Some(version))
    {
        let at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        held.push(serde_json::json!({ "version": version, "at": at, "reason": reason }));
    }
    while held.len() > MAX_HELD {
        held.remove(0);
    }
    let doc = serde_json::json!({ "schema": 1, "held": held });
    let tmp = data_home.join(format!("{HOLD_FILE}.tmp-{}", std::process::id()));
    std::fs::write(&tmp, serde_json::to_string_pretty(&doc).unwrap_or_default())
        .map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename onto {}: {e}", path.display())
    })
}

/// `<bin> -V`, bounded: does the rollback target's server still exec here?
/// Same bar as the installers' probe-before-flip — never hand off into a
/// binary that cannot even start (the watchdog would just fire again).
pub fn probe_server(bin: &Path) -> bool {
    let Ok(mut child) = std::process::Command::new(bin)
        .arg("-V")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        return false;
    };
    let deadline = Instant::now() + PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(st)) => return st.success(),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(_) => return false,
        }
    }
}

/// Decide whether a rollback is possible, and to what. None = not our call
/// (not a managed layout, the layout is not committed to our version, or
/// nothing usable to roll back to) — the caller falls through to today's
/// Stopped-with-dialog behavior.
///
/// `exe_real` is the canonicalized running-launcher path; `our_version` the
/// MSTREAM_BUNDLE_VERSION build stamp (a parameter so tests can fabricate
/// layouts); `probe` injects probe_server.
pub fn plan_rollback(
    exe_real: Option<&Path>,
    our_version: &str,
    home: &Path,
    data_home: &Path,
    probe: &dyn Fn(&Path) -> bool,
) -> Option<RollbackPlan> {
    let exe = exe_real?;

    // Layout (a): running from a versioned bundle dir — root is its parent.
    let mut root: Option<PathBuf> = None;
    let mut apps_copy: Option<PathBuf> = None;
    let mut dir = exe.parent();
    for _ in 0..8 {
        let Some(d) = dir else { break };
        if d.file_name()
            .and_then(|n| n.to_str())
            .and_then(paths::parse_bundle_dir_name)
            .is_some()
        {
            root = d.parent().map(Path::to_path_buf);
            break;
        }
        dir = d.parent();
    }

    // Layout (b): the macOS ~/Applications copy the installer owns (sibling
    // marker). The marker's second line names a custom install root; older
    // version-only markers fall back to the per-OS default root, exactly as
    // detectInstallMethod does server-side.
    if root.is_none() {
        let apps = home.join("Applications").join("mStream.app");
        let marker = home.join("Applications").join(".mstream-installer");
        if exe.starts_with(&apps) && marker.exists() {
            let mut r = data_home.join("app");
            if let Ok(text) = std::fs::read_to_string(&marker) {
                if let Some(line) = text.lines().nth(1) {
                    let line = line.trim();
                    if !line.is_empty() && Path::new(line).is_absolute() {
                        r = PathBuf::from(line);
                    }
                }
            }
            apps_copy = Some(apps);
            root = Some(r);
        }
    }

    let root = root?;
    let link = root.join("current");
    let cur_target = std::fs::read_link(&link).ok()?;
    let (cur_ver, key) = paths::parse_bundle_dir_name(cur_target.file_name()?.to_str()?)?;
    // Only when the layout is committed to US: a `current` already pointing
    // elsewhere (an operator's manual re-point, a takeover raced by a stage)
    // is not ours to fight.
    if cur_ver != our_version {
        return None;
    }

    let held = held_versions(data_home);

    // Candidates: lower same-key versions with a server binary, newest
    // first, minus every held version — never roll back INTO a known-bad
    // (two broken releases in a row must land on the last good one, not
    // ping-pong between the broken pair).
    let mut candidates: Vec<(String, PathBuf)> = Vec::new();
    for entry in std::fs::read_dir(&root).ok()?.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some((ver, k)) = paths::parse_bundle_dir_name(name) else { continue };
        if k != key
            || compare_triples(&ver, our_version) != Some(Ordering::Less)
            || held.contains(&ver)
        {
            continue;
        }
        let bundle = root.join(name);
        if bundle.join(server_rel()).exists() {
            candidates.push((ver, bundle));
        }
    }
    candidates.sort_by(|a, b| compare_triples(&b.0, &a.0).unwrap_or(Ordering::Equal));
    let (target_version, target_bundle) = candidates
        .into_iter()
        .find(|(_, bundle)| probe(&bundle.join(server_rel())))?;

    Some(RollbackPlan {
        root,
        failed_version: our_version.to_string(),
        target_bundle,
        target_version,
        apps_copy,
    })
}

/// Perform the rollback. Returns the launcher face to relaunch via
/// platform::relaunch (+ --takeover). Order matters: the hold is recorded
/// FIRST — even if a later step dies, the record exists and the (rolled-back
/// or manually restarted) server's enforceHold finishes the re-point.
pub fn execute_rollback(
    plan: &RollbackPlan,
    data_home: &Path,
    log: &dyn Fn(&str),
) -> Result<PathBuf, String> {
    if let Err(e) = record_hold(
        data_home,
        &plan.failed_version,
        "server exited before it finished starting after an update",
    ) {
        // Without the record the server re-stages the bad version within a
        // day — a daily crash/rollback cycle instead of a stuck install.
        // Still better than not rolling back; proceed loudly.
        log(&format!("update watchdog: could not record the hold: {e}"));
    }

    // The status file's applyRequested was armed by a now-dead server for
    // the version being backed out. The rolled-back launcher polls that
    // file within a minute; deleting it is what keeps a stale arm from
    // relaunching anything (the next healthy supervised server rewrites it
    // at boot).
    let _ = std::fs::remove_file(data_home.join("update-status.json"));

    repoint_current(&plan.root.join("current"), &plan.target_bundle)?;
    log(&format!(
        "update watchdog: current re-pointed at {}",
        plan.target_bundle.display()
    ));

    #[cfg(not(target_os = "macos"))]
    let face = plan.root.join("current").join(paths::launcher_rel());
    #[cfg(target_os = "macos")]
    let face = match &plan.apps_copy {
        Some(dest) => {
            match restore_apps_copy(dest, &plan.target_bundle, &plan.target_version, &plan.root) {
                Ok(()) => {
                    log("update watchdog: ~/Applications/mStream.app restored from the previous version");
                    dest.join("Contents").join("MacOS").join("mStream")
                }
                Err(e) => {
                    // The versioned launcher still works; the Apps copy heals
                    // on the next install run (or the server-side enforceHold
                    // pass restores it once the rolled-back server runs).
                    log(&format!(
                        "update watchdog: could not restore ~/Applications ({e}) - relaunching the versioned copy"
                    ));
                    plan.root.join("current").join(paths::launcher_rel())
                }
            }
        }
        None => plan.root.join("current").join(paths::launcher_rel()),
    };

    if !face.exists() {
        return Err(format!("no launcher at {} after the re-point", face.display()));
    }
    Ok(face)
}

/// Replace `link` with a symlink to `target` as atomically as the platform
/// allows — the same contract as replaceLink in src/util/update-check.js.
#[cfg(unix)]
fn repoint_current(link: &Path, target: &Path) -> Result<(), String> {
    let tmp = link.with_file_name(format!("current.tmp-{}", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    std::os::unix::fs::symlink(target, &tmp)
        .map_err(|e| format!("symlink {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, link).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename onto {}: {e}", link.display())
    })
}

/// Windows `current` is a junction (symlinks need privilege; junctions do
/// not). No atomic replace exists for junctions — delete + recreate, the
/// same brief exposure install.ps1 already has. mklink is a cmd builtin.
#[cfg(windows)]
fn repoint_current(link: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    if std::fs::symlink_metadata(link).is_ok() {
        // remove_dir on a junction removes the link only, never the target.
        std::fs::remove_dir(link).map_err(|e| format!("remove {}: {e}", link.display()))?;
    }
    let out = std::process::Command::new("cmd")
        .arg("/C")
        .arg("mklink")
        .arg("/J")
        .arg(link)
        .arg(target)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("spawn cmd mklink: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "mklink /J failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    // Verify through canonicalize (read_link on a junction may carry the
    // \\?\ prefix; canonicalizing both sides compares them in one form).
    match (std::fs::canonicalize(link), std::fs::canonicalize(target)) {
        (Ok(a), Ok(b)) if a == b => Ok(()),
        _ => Err(format!("{} does not resolve to {}", link.display(), target.display())),
    }
}

/// Restore ~/Applications/mStream.app from the rollback target's bundle.
/// ditto (not a plain copy) preserves the bundle's internal symlink, xattrs,
/// and the notarization staple — and nothing is ever written INSIDE the
/// bundle (the sibling marker carries ownership), so the seal survives.
/// We may be RUNNING from `dest`: a rename keeps our mapped binary valid,
/// and the aside joins the .old.* family the next launcher's sweep reclaims.
#[cfg(target_os = "macos")]
fn restore_apps_copy(
    dest: &Path,
    bundle: &Path,
    version: &str,
    root: &Path,
) -> Result<(), String> {
    let src = bundle.join("mStream.app");
    if !src.exists() {
        return Err(format!("{} has no mStream.app", bundle.display()));
    }
    let installing = dest.with_file_name("mStream.app.installing-rollback");
    let _ = std::fs::remove_dir_all(&installing);
    let st = std::process::Command::new("/usr/bin/ditto")
        .arg(&src)
        .arg(&installing)
        .status()
        .map_err(|e| format!("ditto: {e}"))?;
    if !st.success() {
        return Err(format!("ditto exited {st}"));
    }
    if dest.exists() {
        let at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let aside = dest.with_file_name(format!("mStream.app.old.{at}.rolledback"));
        std::fs::rename(dest, &aside).map_err(|e| format!("move aside: {e}"))?;
    }
    std::fs::rename(&installing, dest).map_err(|e| format!("move into place: {e}"))?;
    // Same two lines install.sh writes: version, then the install root.
    let marker = dest.with_file_name(".mstream-installer");
    let _ = std::fs::write(&marker, format!("{version}\n{}\n", root.display()));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mstream-rollback-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn mk_bundle(root: &Path, ver: &str, key: &str, with_server: bool) -> PathBuf {
        let b = root.join(format!("mStream-{ver}-{key}"));
        let srv = b.join(server_rel());
        std::fs::create_dir_all(srv.parent().unwrap()).unwrap();
        if with_server {
            std::fs::write(&srv, "stub").unwrap();
        }
        b
    }

    fn link_current(root: &Path, target: &Path) {
        let link = root.join("current");
        let _ = std::fs::remove_file(&link);
        #[cfg(windows)]
        let _ = std::fs::remove_dir(&link); // a dir symlink deletes as a dir
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, &link).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(target, &link).unwrap();
    }

    fn host_key() -> &'static str {
        if cfg!(windows) {
            "win-x64"
        } else if cfg!(target_os = "macos") {
            "darwin-arm64"
        } else {
            "linux-x64"
        }
    }

    const YES: fn(&Path) -> bool = |_| true;

    #[test]
    fn triples_compare_numerically_or_not_at_all() {
        assert_eq!(compare_triples("6.21.2", "6.9.9"), Some(Ordering::Greater));
        assert_eq!(compare_triples("6.9.0", "6.21.0"), Some(Ordering::Less));
        assert_eq!(compare_triples("6.21.2", "6.21.2"), Some(Ordering::Equal));
        assert_eq!(compare_triples("6.21", "6.21.2"), None);
        assert_eq!(compare_triples("6.21.2-beta.1", "6.21.2"), None);
    }

    #[test]
    fn plan_picks_the_newest_lower_same_key_version() {
        let root = tmpdir("plan");
        let key = host_key();
        let ours = mk_bundle(&root, "6.22.0", key, true);
        mk_bundle(&root, "6.20.0", key, true);
        let want = mk_bundle(&root, "6.21.0", key, true);
        mk_bundle(&root, "6.21.5", "linux-arm64-musl", true); // other family: never
        link_current(&root, &ours);
        let exe = ours.join(paths::launcher_rel());
        let plan = plan_rollback(Some(&exe), "6.22.0", &root.join("nohome"), &root, &YES).unwrap();
        assert_eq!(plan.target_version, "6.21.0");
        assert_eq!(plan.target_bundle, want);
        assert_eq!(plan.failed_version, "6.22.0");
        assert_eq!(plan.root, root);
        assert!(plan.apps_copy.is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn plan_refuses_when_current_is_not_ours_or_nothing_qualifies() {
        let root = tmpdir("refuse");
        let key = host_key();
        let ours = mk_bundle(&root, "6.22.0", key, true);
        let other = mk_bundle(&root, "6.23.0", key, true);
        let exe = ours.join(paths::launcher_rel());

        // current committed to a DIFFERENT version: not ours to fight.
        link_current(&root, &other);
        assert!(plan_rollback(Some(&exe), "6.22.0", &root.join("nohome"), &root, &YES).is_none());

        // current is ours, but the only lower version has no server binary.
        link_current(&root, &ours);
        mk_bundle(&root, "6.21.0", key, false);
        assert!(plan_rollback(Some(&exe), "6.22.0", &root.join("nohome"), &root, &YES).is_none());

        // A candidate appears — but the probe refuses it.
        mk_bundle(&root, "6.21.1", key, true);
        let no: fn(&Path) -> bool = |_| false;
        assert!(plan_rollback(Some(&exe), "6.22.0", &root.join("nohome"), &root, &no).is_none());

        // No exe at all.
        assert!(plan_rollback(None, "6.22.0", &root.join("nohome"), &root, &YES).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn plan_skips_held_versions() {
        let root = tmpdir("held");
        let key = host_key();
        let ours = mk_bundle(&root, "6.23.0", key, true);
        mk_bundle(&root, "6.22.0", key, true); // known-bad: held below
        let want = mk_bundle(&root, "6.21.0", key, true);
        link_current(&root, &ours);
        std::fs::write(
            root.join(HOLD_FILE),
            r#"{"schema":1,"held":[{"version":"6.22.0","at":0,"reason":"t"},{"version":"garbage"}]}"#,
        )
        .unwrap();
        assert_eq!(held_versions(&root), vec!["6.22.0".to_string()]);
        let exe = ours.join(paths::launcher_rel());
        let plan = plan_rollback(Some(&exe), "6.23.0", &root.join("nohome"), &root, &YES).unwrap();
        assert_eq!(plan.target_bundle, want, "the held middle version is skipped");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn apps_copy_shape_follows_the_marker_root() {
        let home = tmpdir("home");
        let data_home = home.join("data");
        let root = home.join("custom-root");
        std::fs::create_dir_all(&root).unwrap();
        let key = host_key();
        let ours = mk_bundle(&root, "6.22.0", key, true);
        let want = mk_bundle(&root, "6.21.0", key, true);
        link_current(&root, &ours);
        let apps = home.join("Applications");
        let exe = apps.join("mStream.app").join("Contents").join("MacOS").join("mStream");
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, "stub").unwrap();
        // No marker: user-owned copy, never ours to roll back.
        assert!(plan_rollback(Some(&exe), "6.22.0", &home, &data_home, &YES).is_none());
        std::fs::write(
            apps.join(".mstream-installer"),
            format!("6.22.0\n{}\n", root.display()),
        )
        .unwrap();
        let plan = plan_rollback(Some(&exe), "6.22.0", &home, &data_home, &YES).unwrap();
        assert_eq!(plan.root, root, "marker line 2 names the custom root");
        assert_eq!(plan.target_bundle, want);
        assert_eq!(plan.apps_copy, Some(apps.join("mStream.app")));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn holds_record_dedupes_and_caps() {
        let dh = tmpdir("record");
        record_hold(&dh, "6.22.0", "t").unwrap();
        record_hold(&dh, "6.22.0", "t").unwrap();
        assert_eq!(held_versions(&dh), vec!["6.22.0".to_string()]);
        for i in 0..12 {
            record_hold(&dh, &format!("7.0.{i}"), "t").unwrap();
        }
        let held = held_versions(&dh);
        assert_eq!(held.len(), MAX_HELD, "capped");
        assert!(held.contains(&"7.0.11".to_string()), "newest kept");
        assert!(!held.contains(&"6.22.0".to_string()), "oldest dropped");
        // Absent / garbage files read as nothing held.
        assert!(held_versions(&dh.join("nope")).is_empty());
        std::fs::write(dh.join(HOLD_FILE), "not json").unwrap();
        assert!(held_versions(&dh).is_empty());
        let _ = std::fs::remove_dir_all(&dh);
    }

    #[test]
    fn execute_repoints_current_and_clears_the_stale_status_file() {
        let root = tmpdir("exec");
        let data_home = root.join("data");
        std::fs::create_dir_all(&data_home).unwrap();
        std::fs::write(
            data_home.join("update-status.json"),
            r#"{"applyRequested":true,"stagedVersion":"6.22.0"}"#,
        )
        .unwrap();
        let key = host_key();
        let ours = mk_bundle(&root, "6.22.0", key, true);
        let prev = mk_bundle(&root, "6.21.0", key, true);
        // The face the handoff needs must exist in the rollback target.
        let face = prev.join(paths::launcher_rel());
        std::fs::create_dir_all(face.parent().unwrap()).unwrap();
        std::fs::write(&face, "stub").unwrap();
        link_current(&root, &ours);
        let plan = RollbackPlan {
            root: root.clone(),
            failed_version: "6.22.0".to_string(),
            target_bundle: prev.clone(),
            target_version: "6.21.0".to_string(),
            apps_copy: None,
        };
        let got = execute_rollback(&plan, &data_home, &|_| {}).unwrap();
        assert_eq!(got, root.join("current").join(paths::launcher_rel()));
        assert_eq!(
            std::fs::canonicalize(root.join("current")).unwrap(),
            std::fs::canonicalize(&prev).unwrap()
        );
        assert_eq!(held_versions(&data_home), vec!["6.22.0".to_string()]);
        assert!(
            !data_home.join("update-status.json").exists(),
            "stale armed status file must not survive a rollback"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
