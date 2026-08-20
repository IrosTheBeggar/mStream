// Release update checker + stager — the server-side brain of auto-update.
//
// The server owns check/verify/download/stage because it is the one component
// present in EVERY install shape (the tray launcher ships only on four of the
// seven bundle targets, and not at all for npm/source/Docker), and because the
// hardened download transport already lives here (ffmpeg-bootstrap). The
// launcher's whole role is the two things only it can do: show a tray item and
// restart into the staged version — it learns both from the status file this
// module writes (update-status.json in userDataHome(), the same directory that
// holds its launcher.lock; NOT esm-helpers' dataRoot, which equals appRoot on
// writable installs — inside the versioned bundle folder, or worse, inside the
// ~/Applications .app where any write breaks the notarization seal).
//
// What "an update" means: the WHOLE bundle folder, never the server binary
// alone. webapp/, rust-parser (hash-generation gated), rust-server-audio, and
// the p2p sidecar all ship inside the zip and must move together — a lone
// binary swap leaves a stale UI and sidecars that can never self-heal (the
// bundle's sidecar sits on the "operator property" rung of discovery-p2p's
// resolution). So managed staging runs the BUNDLE-EMBEDDED installer script —
// exactly the code that installed this copy, contract-tested in CI, fetched
// from nowhere at update time — which downloads the zip, verifies its sha256
// against the release manifest, extracts a versioned folder beside the running
// one, and flips $ROOT/current. The running server keeps serving the old
// version until something restarts it.
//
// Modes (config: updates.mode, live-read so admin toggles need no reboot):
//   notify - check only; every download/install is user-initiated
//   stage  - (default) background-stage for managed installs and
//            background-download the Windows installer; applying still takes
//            a restart / a click
//   auto   - additionally apply when idle: under the launcher, by flagging
//            applyRequested in the status file (the launcher restarts into
//            the staged version); headless, by exiting 0 — documented as
//            "auto expects a process supervisor" (systemd/pm2 restart lands
//            on the new version via the flipped `current` link)
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import winston from 'winston';
import * as config from '../state/config.js';
import { writeJsonAtomic } from './atomic-json.js';
import { downloadToFile, computeFileChecksum } from './ffmpeg-bootstrap.js';
import { appRoot, isBunStandalone, userDataHome, underSystemPrefix } from './esm-helpers.js';
import packageJson from '../../package.json' with { type: 'json' };

const REPO = 'IrosTheBeggar/mStream';
const LATEST_BASE = `https://github.com/${REPO}/releases/latest/download`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
// manifest.json is ~15 lines; anything past this is not our manifest.
const MANIFEST_MAX_BYTES = 64 * 1024;
// setup.exe is ~45 MB, a .pkg ~150 MB. A pinned size is not in the release
// manifest (yet), so cap at "clearly wrong" instead.
const INSTALLER_MAX_BYTES = 500 * 1024 * 1024;
const STAGE_TIMEOUT_MS = 30 * 60 * 1000; // a bundle download on a slow link
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const BOOT_CHECK_DELAY_MS = 30 * 1000;
const AUTO_APPLY_POLL_MS = 15 * 60 * 1000;

// ── Pure helpers (unit-tested with injected fs) ─────────────────────────────

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

// Strict numeric-triple compare. Returns <0, 0, >0 — or null when either
// side is not a plain X.Y.Z (prerelease-shaped strings are refused on
// purpose: releases are always bare triples, so anything else in a manifest
// is not a version to act on).
export function compareVersions(a, b) {
  const ma = VERSION_RE.exec(a);
  const mb = VERSION_RE.exec(b);
  if (!ma || !mb) { return null; }
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) { return d; }
  }
  return 0;
}

// The release manifest contract (scripts/release-manifest.sh). `name` guards
// against a non-mStream release capturing the GitHub "latest" pointer (the
// repo also hosts asset-store releases); apiVersion gates layout changes —
// a manifest from the future downgrades this updater to notify-only rather
// than letting it run an install flow it no longer understands.
export function validateManifest(m) {
  if (!m || typeof m !== 'object') { return { ok: false, reason: 'not an object' }; }
  if (m.name !== 'mstream') { return { ok: false, reason: `manifest name is ${JSON.stringify(m.name)}, not "mstream"` }; }
  if (m.apiVersion !== 1) { return { ok: false, reason: `manifest apiVersion ${m.apiVersion} is newer than this server understands`, apiMismatch: true }; }
  if (typeof m.version !== 'string' || !VERSION_RE.test(m.version)) {
    return { ok: false, reason: `manifest version ${JSON.stringify(m.version)} is not a plain X.Y.Z` };
  }
  if (!Array.isArray(m.assets) || !m.assets.every(a => a && typeof a.file === 'string' && /^[0-9a-f]{64}$/.test(a.sha256 || ''))) {
    return { ok: false, reason: 'manifest assets are malformed' };
  }
  return { ok: true };
}

// mStream-<version>-<key>[.zip] -> { version, key }, or null.
export function parseBundleName(name) {
  const m = /^mStream-(\d+\.\d+\.\d+)-((?:darwin|linux|win)-[a-z0-9]+(?:-musl)?)(?:\.zip)?$/.exec(name);
  return m ? { version: m[1], key: m[2] } : null;
}

// Where and how is this server installed? Decides what an update can DO:
// only the script-managed layout ($ROOT/<bundle>/ + $ROOT/current) is staged
// in place; everything else gets told, not touched. Pure and injected so the
// decision table is unit-testable; production wiring is detectInstall()
// below. Detection is by GEOMETRY (walk up from the real executable path
// looking for the `current` link that points back at our own tree), not env:
// the server never inherits the installer's MSTREAM_INSTALL_DIR, and
// geometry follows custom roots for free.
export function detectInstallMethod({
  execPath,
  platform = process.platform,
  env = process.env,
  standalone = isBunStandalone,
  fsx = fs,
  homedir = undefined,
} = {}) {
  const home = userDataHome(platform, env, ...(homedir ? [homedir] : []));
  // Test / escape hatch: trust the operator, skip geometry.
  if (env.MSTREAM_UPDATE_ROOT) { return { method: 'managed', root: env.MSTREAM_UPDATE_ROOT }; }
  if (!standalone) { return { method: 'npm-source' }; }
  if (platform === 'linux') {
    try { fsx.accessSync('/.dockerenv'); return { method: 'docker' }; } catch { /* not docker */ }
  }
  let real = execPath;
  try { real = fsx.realpathSync(execPath); } catch { /* keep the literal path */ }
  const realDir = path.dirname(real);

  // macOS ~/Applications copy: the installer's ditto copy plus its SIBLING
  // ownership marker. The versioned root is the per-OS default (the marker
  // is only ever written by an install into that default layout).
  if (platform === 'darwin') {
    const hd = homedir ? homedir() : path.dirname(path.dirname(path.dirname(home)));
    const appsCopy = path.join(hd, 'Applications', 'mStream.app');
    if ((real.startsWith(appsCopy + path.sep)) && fsx.existsSync(path.join(hd, 'Applications', '.mstream-installer'))) {
      const root = path.join(home, 'app');
      if (fsx.existsSync(path.join(root, 'current'))) { return { method: 'managed', root }; }
    }
  }

  // deb/rpm (/opt, /usr) and the macOS .pkg (/Applications) live in
  // package-manager territory — never staged by us.
  if (underSystemPrefix(realDir + '/', platform)) {
    return { method: platform === 'darwin' ? 'pkg' : 'deb-rpm' };
  }

  // The managed layout: some ancestor holds `current`, and a versioned
  // bundle dir sits on the path between them.
  let dir = realDir;
  for (let i = 0; i < 8; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) { break; }
    if (parseBundleName(path.basename(dir)) && fsx.existsSync(path.join(parent, 'current'))) {
      return { method: 'managed', root: parent };
    }
    dir = parent;
  }

  // Windows Inno install: flat files at %LOCALAPPDATA%\Programs\mStream,
  // same root install.ps1 uses but with no versioned dir and no junction.
  if (platform === 'win32') {
    const innoDir = path.join(env.LOCALAPPDATA || '', 'Programs', 'mStream');
    if (env.LOCALAPPDATA && path.resolve(realDir).toLowerCase() === path.resolve(innoDir).toLowerCase()
        && !fsx.existsSync(path.join(realDir, 'current'))) {
      return { method: 'inno' };
    }
  }

  // A hand-extracted bundle, --portable, or anything else we don't own.
  return { method: 'portable' };
}

// ── Module state ────────────────────────────────────────────────────────────

let _install = null;        // { method, root? } — detected once per process
let _hooks = { hasBusySockets: () => false, isScanning: () => false };
let _bootTimer = null;
let _checkTimer = null;
let _applyTimer = null;
let _staging = null;        // single-flight staging promise; never cleared by reboot
let _exiting = false;

const state = {
  schema: 1,
  current: packageJson.version,
  latest: null,
  available: false,
  method: null,
  mode: null,               // mirrored at write time for observability
  staged: false,
  stagedVersion: null,
  downloading: false,
  applyRequested: false,
  installerPath: null,      // inno/pkg: the verified installer the launcher may spawn
  downloadUrl: null,        // non-managed: where a human gets the update
  lastCheckAt: null,
  error: null,
  notifyOnly: false,        // apiVersion from the future: check works, staging refused
};

function updatesConfig() {
  return config.program?.updates || { check: true, mode: 'stage' };
}

function supervisedByLauncher() {
  return process.argv.includes('--supervised');
}

export function statusFilePath() {
  return path.join(userDataHome(), 'update-status.json');
}

export function getStatus() {
  return { ...state, check: updatesConfig().check, mode: updatesConfig().mode };
}

async function writeStatus() {
  const doc = { ...getStatus(), writtenAt: new Date().toISOString() };
  try {
    await fsp.mkdir(userDataHome(), { recursive: true });
    await writeJsonAtomic(statusFilePath(), doc);
  } catch (err) {
    winston.warn(`[update] Could not write ${statusFilePath()}: ${err.message}`);
  }
}

function releaseBase() {
  const rb = process.env.MSTREAM_RELEASE_BASE;
  return rb ? rb.replace(/\/+$/, '') : LATEST_BASE;
}

// Tag-pinned asset URL: after a check said "latest is X", downloads must be
// X's bytes even if the "latest" pointer moves meanwhile. A mirror
// (MSTREAM_RELEASE_BASE) serves one flat version — pinning is impossible
// there by construction, and the sha256 check catches a rotated mirror.
function assetUrl(version, file) {
  const rb = process.env.MSTREAM_RELEASE_BASE;
  if (rb) { return `${rb.replace(/\/+$/, '')}/${file}`; }
  return `https://github.com/${REPO}/releases/download/v${version}/${file}`;
}

function installerAssetName(version) {
  if (process.platform === 'win32') { return `mStream-${version}-win-x64-setup.exe`; }
  if (process.platform === 'darwin') {
    return `mStream-${version}-darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}.pkg`;
  }
  return null;
}

// The installer script that shipped INSIDE this bundle. macOS: Resources
// (a data file; under Contents/MacOS the codesign nested-code scan would
// reject it), which the appRoot (= Contents/MacOS) reaches as a sibling.
function embeddedInstallerPath() {
  if (process.platform === 'win32') { return path.join(appRoot, 'install.ps1'); }
  if (process.platform === 'darwin' && appRoot.includes(`.app${path.sep}`)) {
    return path.join(appRoot, '..', 'Resources', 'install.sh');
  }
  return path.join(appRoot, 'install.sh');
}

function detectInstall() {
  if (!_install) {
    _install = detectInstallMethod({ execPath: process.execPath });
    state.method = _install.method;
  }
  return _install;
}

// ── Checking ────────────────────────────────────────────────────────────────

async function fetchManifest() {
  const dir = userDataHome();
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.update-manifest-${process.pid}.json`);
  try {
    await downloadToFile(`${releaseBase()}/manifest.json`, tmp, { maxBytes: MANIFEST_MAX_BYTES });
    return JSON.parse(await fsp.readFile(tmp, 'utf8'));
  } finally {
    fsp.unlink(tmp).catch(() => { /* scratch file */ });
  }
}

// Check the release feed. `force` is a human clicking "Check now" — it works
// even with the periodic check switched off. Never throws; failures land in
// state.error and the previous knowledge stays put.
export async function checkNow(force = false) {
  const cfg = updatesConfig();
  if (!cfg.check && !force) { return getStatus(); }
  detectInstall();
  try {
    const manifest = await fetchManifest();
    const v = validateManifest(manifest);
    state.lastCheckAt = new Date().toISOString();
    if (!v.ok) {
      state.notifyOnly = !!v.apiMismatch;
      state.error = v.apiMismatch
        ? 'A newer release changed the update format - update by re-running the install command'
        : `Release feed rejected: ${v.reason}`;
      if (v.apiMismatch) {
        // The version itself is still trustworthy enough to announce.
        if (typeof manifest.version === 'string' && VERSION_RE.test(manifest.version)) {
          state.latest = manifest.version;
          state.available = compareVersions(manifest.version, state.current) > 0;
          state.downloadUrl = RELEASES_PAGE;
        }
        await writeStatus();
      }
      winston.warn(`[update] ${state.error}`);
      return getStatus();
    }
    state.error = null;
    state.notifyOnly = false;
    state.latest = manifest.version;
    state.available = compareVersions(manifest.version, state.current) > 0;
    if (!state.available) {
      state.downloadUrl = null;
    } else {
      const m = detectInstall();
      state.downloadUrl = downloadUrlFor(m.method, manifest);
      winston.info(`[update] mStream ${manifest.version} is available (running ${state.current}, install: ${m.method})`);
      const mode = updatesConfig().mode;
      if (mode !== 'notify' && !state.notifyOnly
          && (m.method === 'managed' || m.method === 'inno')
          && (!state.staged || state.stagedVersion !== manifest.version)) {
        stageNow(manifest); // async, single-flight; errors land in state
      }
    }
    await writeStatus();
    maybeAutoApply();
  } catch (err) {
    state.error = `Update check failed: ${err.message}`;
    winston.warn(`[update] ${state.error}`);
  }
  return getStatus();
}

function downloadUrlFor(method, manifest) {
  const name = installerAssetName(manifest.version);
  if ((method === 'inno' || method === 'pkg') && name
      && manifest.assets.some(a => a.file === name)) {
    return assetUrl(manifest.version, name);
  }
  return RELEASES_PAGE;
}

// ── Staging ─────────────────────────────────────────────────────────────────

// Managed installs: run the embedded installer script against the checked
// version. Returns immediately with {started:true} (the admin card polls
// GET status); the download itself is minutes on a slow link. Single-flight:
// a second call while one runs joins it.
export function stageNow(manifest = null) {
  const m = detectInstall();
  if (state.notifyOnly) { return { error: 'update format changed - re-run the install command' }; }
  if (m.method === 'inno' || m.method === 'pkg') {
    if (!state.latest || !state.available) { return { error: 'no update available' }; }
    if (!_staging) {
      _staging = stageInstaller(manifest).finally(() => { _staging = null; });
    }
    return { started: true };
  }
  if (m.method !== 'managed') { return { error: `this install (${m.method}) updates through its own channel` }; }
  if (!state.latest || !state.available) { return { error: 'no update available' }; }
  if (_staging) { return { started: true }; }
  const target = state.latest;
  _staging = runInstallerScript(target, m.root)
    .then(async () => {
      const landed = await stagedVersionFromRoot(m.root);
      if (!landed) {
        throw new Error('installer finished but $ROOT/current does not name a bundle');
      }
      if (compareVersions(landed, state.current) <= 0) {
        // A mirror can only serve what it serves (MSTREAM_VERSION is
        // decorative when MSTREAM_RELEASE_BASE is set) — report what
        // actually landed rather than pretending.
        throw new Error(`installer staged ${landed}, which is not newer than ${state.current}`);
      }
      state.staged = true;
      state.stagedVersion = landed;
      state.error = null;
      winston.info(`[update] mStream ${landed} is staged - it takes over on the next restart`);
      await pruneOldVersions(m.root);
      await writeStatus();
      maybeAutoApply();
    })
    .catch(async (err) => {
      state.error = `Staging failed: ${err.message}`;
      winston.warn(`[update] ${state.error}`);
      await writeStatus();
    })
    .finally(() => { _staging = null; });
  return { started: true };
}

function runInstallerScript(targetVersion, root) {
  return new Promise((resolve, reject) => {
    const script = embeddedInstallerPath();
    if (!fs.existsSync(script)) {
      return reject(new Error(`no embedded installer at ${script}`));
    }
    const env = {
      ...process.env,
      MSTREAM_VERSION: `v${targetVersion}`,
      MSTREAM_INSTALL_DIR: root,
    };
    const [cmd, args] = process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]]
      : ['/bin/sh', [script]];
    winston.info(`[update] Staging mStream ${targetVersion} via ${path.basename(script)}...`);
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const tail = [];
    const keep = (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        const t = line.trimEnd();
        if (!t) { continue; }
        winston.info(`[update] installer: ${t}`);
        tail.push(t);
        if (tail.length > 40) { tail.shift(); }
      }
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('installer timed out'));
    }, STAGE_TIMEOUT_MS);
    if (timer.unref) { timer.unref(); }
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) { resolve(); }
      else { reject(new Error(`installer exited ${code}: ${tail.slice(-6).join(' | ')}`)); }
    });
  });
}

async function stagedVersionFromRoot(root) {
  try {
    const target = await fsp.readlink(path.join(root, 'current'));
    return parseBundleName(path.basename(target))?.version || null;
  } catch {
    return null;
  }
}

// Windows installer / macOS .pkg: download + verify into our own updates/
// dir. The launcher (or the user) runs it from there; verification is the
// manifest's sha256, same trust chain as the bundles.
async function stageInstaller(manifest) {
  try {
    if (!manifest) { manifest = await fetchManifest(); }
    const v = validateManifest(manifest);
    if (!v.ok) { throw new Error(v.reason); }
    const name = installerAssetName(manifest.version);
    const entry = name && manifest.assets.find(a => a.file === name);
    if (!entry) { throw new Error(`this release has no ${name || 'installer'} (releases before the updater carry none)`); }
    const dir = path.join(userDataHome(), 'updates');
    await fsp.mkdir(dir, { recursive: true });
    const dest = path.join(dir, name);
    const already = fs.existsSync(dest) && (await computeFileChecksum(dest)) === entry.sha256;
    if (!already) {
      state.downloading = true;
      await writeStatus();
      await downloadToFile(assetUrl(manifest.version, name), dest, { maxBytes: INSTALLER_MAX_BYTES });
      const sum = await computeFileChecksum(dest);
      if (sum !== entry.sha256) {
        await fsp.unlink(dest).catch(() => {});
        throw new Error(`sha256 mismatch for ${name}`);
      }
    }
    // One installer at a time: sweep siblings from older checks.
    for (const f of await fsp.readdir(dir)) {
      if (f !== name) { await fsp.rm(path.join(dir, f), { force: true }).catch(() => {}); }
    }
    state.staged = true;
    state.stagedVersion = manifest.version;
    state.installerPath = dest;
    state.error = null;
    winston.info(`[update] ${name} is downloaded and verified`);
  } catch (err) {
    state.error = `Installer download failed: ${err.message}`;
    winston.warn(`[update] ${state.error}`);
  } finally {
    state.downloading = false;
    await writeStatus();
    maybeAutoApply();
  }
}

// Old versioned folders accumulate under daily staging (install.sh never
// prunes by design — a human runs it rarely; we run it on a schedule). Keep
// the current target, the tree the running server lives in, and the single
// newest other version (the manual-rollback candidate); delete the rest.
async function pruneOldVersions(root) {
  try {
    const protect = new Set();
    try { protect.add(await fsp.realpath(path.join(root, 'current'))); } catch { /* no current */ }
    try {
      let dir = path.dirname(await fsp.realpath(process.execPath));
      for (let i = 0; i < 8 && dir !== path.dirname(dir); i++) {
        if (parseBundleName(path.basename(dir))) { protect.add(dir); break; }
        dir = path.dirname(dir);
      }
    } catch { /* keep going */ }
    const candidates = [];
    for (const entry of await fsp.readdir(root)) {
      if (!parseBundleName(entry)) { continue; }
      const full = path.join(root, entry);
      let real = full;
      try { real = await fsp.realpath(full); } catch { continue; }
      if (protect.has(real)) { continue; }
      const st = await fsp.stat(full).catch(() => null);
      if (st && st.isDirectory()) { candidates.push({ full, mtime: st.mtimeMs }); }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    for (const c of candidates.slice(1)) {
      winston.info(`[update] Pruning old version ${path.basename(c.full)}`);
      await fsp.rm(c.full, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    winston.warn(`[update] Prune skipped: ${err.message}`);
  }
}

// ── Applying ────────────────────────────────────────────────────────────────

function idle() {
  try { return !_hooks.hasBusySockets() && !_hooks.isScanning(); }
  catch { return false; }
}

// The human clicked "restart to update" in the webapp. Managed under the
// launcher / inno: raise applyRequested — the launcher reads the status file
// every minute and performs the restart (the <=1 min lag is in the UI copy).
// pkg: open the verified installer now (Installer.app takes it from there).
// Managed headless: exit once the response has gone out; the supervisor
// restart lands on the flipped `current`.
export async function requestApply() {
  const m = detectInstall();
  if (!state.staged) { return { error: 'nothing is staged yet' }; }
  if (m.method === 'pkg') {
    if (!state.installerPath || !fs.existsSync(state.installerPath)) { return { error: 'installer not downloaded yet' }; }
    spawn('open', [state.installerPath], { detached: true, stdio: 'ignore' }).unref();
    return { opened: true };
  }
  state.applyRequested = true;
  await writeStatus();
  if (m.method === 'managed' && !supervisedByLauncher()) {
    scheduleHeadlessExit('an admin requested the update');
    return { exiting: true };
  }
  return { requested: true };
}

function scheduleHeadlessExit(why) {
  if (_exiting) { return; }
  _exiting = true;
  winston.info(`[update] Restarting into mStream ${state.stagedVersion}: ${why}. `
    + 'Exiting 0 - the process supervisor is expected to start mStream again.');
  // Give the HTTP response and log writes a beat to flush.
  const t = setTimeout(() => { process.exit(0); }, 1500);
  if (t.unref) { t.unref(); }
}

// auto mode: apply on our own once nothing is streaming and no scan runs.
function maybeAutoApply() {
  if (updatesConfig().mode !== 'auto' || !state.staged || state.applyRequested) { return; }
  const m = detectInstall();
  if (m.method !== 'managed' && m.method !== 'inno') { return; }
  if (!idle()) { return; }
  if (m.method === 'managed' && !supervisedByLauncher()) {
    scheduleHeadlessExit('auto mode, server idle');
    return;
  }
  // Launcher-supervised (managed restart, or inno silent install): flag it;
  // the launcher acts within a minute.
  state.applyRequested = true;
  writeStatus().catch(() => {});
}

// Admin toggles (mode/check) changed: re-evaluate posture and re-publish.
export function onSettingsChanged() {
  writeStatus().catch(() => {});
  maybeAutoApply();
  const cfg = updatesConfig();
  if (cfg.check && cfg.mode !== 'notify' && state.available && !state.staged) {
    // e.g. notify -> stage: start the download the old mode withheld.
    checkNow(true).catch(() => {});
  }
}

// ── Wiring ──────────────────────────────────────────────────────────────────

// Called from serveIt() on every (re)boot. Idempotent across soft reboots —
// the timers survive reboot() untouched (it is not in any reset list), and
// the boot-time status write is what lets the launcher's "restart to update"
// item self-correct the moment the staged version actually boots.
export function setup(mstream, hooks = {}) {
  _hooks = { ..._hooks, ...hooks };
  detectInstall();
  // A staged flag from a PREVIOUS process run: if we ARE that version now,
  // clear it; if not (the restart didn't land on it), re-checking will
  // re-discover it within a day, or instantly via the boot check.
  if (state.stagedVersion && compareVersions(state.stagedVersion, state.current) <= 0) {
    state.staged = false;
    state.stagedVersion = null;
    state.applyRequested = false;
  }
  writeStatus().catch(() => {});
  if (_bootTimer || _checkTimer) { return; }
  _bootTimer = setTimeout(() => {
    _bootTimer = null;
    checkNow().catch(() => {});
  }, BOOT_CHECK_DELAY_MS);
  if (_bootTimer.unref) { _bootTimer.unref(); }
  _checkTimer = setInterval(() => { checkNow().catch(() => {}); }, CHECK_INTERVAL_MS);
  if (_checkTimer.unref) { _checkTimer.unref(); }
  _applyTimer = setInterval(() => { maybeAutoApply(); }, AUTO_APPLY_POLL_MS);
  if (_applyTimer.unref) { _applyTimer.unref(); }
}

// Test hook: stop timers and forget detection.
export function stopForTests() {
  for (const t of [_bootTimer, _checkTimer, _applyTimer]) { if (t) { clearTimeout(t); clearInterval(t); } }
  _bootTimer = _checkTimer = _applyTimer = null;
  _install = null;
  _exiting = false;
  state.latest = null; state.available = false; state.staged = false;
  state.stagedVersion = null; state.applyRequested = false; state.error = null;
  state.installerPath = null; state.downloadUrl = null; state.notifyOnly = false;
  state.downloading = false; state.method = null; state.lastCheckAt = null;
}
