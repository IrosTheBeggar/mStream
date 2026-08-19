import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

export function getDirname(importMetaUrl) {
  return dirname(fileURLToPath(importMetaUrl));
}

// Root directory holding the app's shipped assets — webapp/, bin/, and the
// default save/ and *-cache/ locations.
//
// Under Node and Electron (asar:false) this module lives on disk at
// <root>/src/util/esm-helpers.js, so the root is two levels up. Under a Bun
// `bun build --compile` standalone binary the source modules live in a virtual
// filesystem (e.g. B:\~BUN\root) with no on-disk presence, so we anchor to the
// directory containing the executable — that's where webapp/ and bin/ ship
// next to it.
const selfPath = fileURLToPath(import.meta.url);
// Bun `--compile` standalone binaries place every source module under a
// synthetic root — "/$bunfs/…" on posix, "B:\~BUN\…" on Windows — that is not
// the real install dir, and fs.existsSync() returns true for these phantom
// paths, so a "does my file exist on disk" check can't distinguish them. Match
// the synthetic-root marker instead and anchor to the executable's directory,
// where webapp/ and bin/ are shipped alongside it.
export const isBunStandalone = /[\\/](~BUN|\$bunfs)[\\/]/.test(selfPath);
export const appRoot = isBunStandalone
  ? dirname(process.execPath)
  : join(dirname(selfPath), '..', '..');

// Canonical per-user data directory — THE one implementation, shared by
// dataRoot's read-only fallback below and by the desktop install profile
// (src/util/boot-config.js), so every code path that relocates writable
// state agrees on a single destination per OS. LOCALAPPDATA (not roaming
// APPDATA) on Windows: the db and art/waveform caches can reach gigabytes
// and don't belong in a roaming profile. Lowercase `mstream` on Linux per
// XDG convention. Injectable for tests.
export function userDataHome(platform = process.platform, env = process.env, homedir = os.homedir) {
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'mStream');
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'mStream');
  }
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'mstream');
}

// Root for WRITABLE state — config, db, logs, image/waveform caches — as
// opposed to appRoot, which also anchors the SHIPPED read-only assets
// (webapp/, bin/) and must keep doing so.
//
// These are normally the same directory, and stay that way for every install
// that can write next to the app: existing layouts are untouched. They diverge
// only where appRoot cannot be written, and the case that matters is the
// headline #802 flow. A downloaded .app carries the quarantine flag, so
// Gatekeeper runs it from a READ-ONLY AppTranslocation mount; anchoring
// writable state to appRoot then kills the very first boot with EROFS/EACCES
// while creating save/conf, and — because a Finder launch has no console — the
// user sees only a dialog blaming the config file. (An .app in /Applications
// is not user-writable either, and storing state inside a bundle breaks code
// signing and is lost on upgrade, so the fallback is the correct destination
// regardless.) Falling back beats failing: the only installs affected are ones
// that could not have stored anything at appRoot in the first place.
// System install locations are never data homes, even when this process CAN
// write there: W_OK answers yes for root under /opt and /usr (a sudo'd
// `mstream-server -j …` from a deb/rpm install) and for any admin user under
// /Applications (the pkg install) — but parking the db inside a
// package-managed tree pollutes it. dpkg/rpm leave the leftovers behind on
// remove (observed: `apt remove mstream` keeping /opt/mstream alive after
// one root boot), a pkg upgrade replaces the tree out from under the
// library, and on macOS it breaks the bundle's code signature. Ownership,
// not writability, is the question in these prefixes. Windows deliberately
// unlisted: our per-user install dir (LOCALAPPDATA\Programs) is user space,
// and there is no package manager reclaiming it. Exported for tests.
export function underSystemPrefix(dir, platform = process.platform) {
  if (platform === 'win32') { return false; }
  const norm = dir.endsWith('/') ? dir : `${dir}/`;
  return ['/opt/', '/usr/', '/Applications/'].some(
    (prefix) => norm === prefix || norm.startsWith(prefix));
}

// Split from the module-level constant wiring so the decision table is unit
// testable; production behavior is exactly the constant below.
export function resolveDataRoot(root = appRoot, platform = process.platform, access = fs.accessSync) {
  if (underSystemPrefix(root, platform)) {
    return userDataHome();
  }
  try {
    access(root, fs.constants.W_OK);
    return root;
  } catch (_err) {
    return userDataHome();
  }
}

export const dataRoot = resolveDataRoot();
// True when appRoot was unwritable and we fell back — worth a log line at boot,
// since it changes where the user's library config and database live.
export const usingFallbackDataRoot = dataRoot !== appRoot;
