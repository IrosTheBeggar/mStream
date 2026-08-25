// Headless boot watchdog — the pre-boot half of the bad-release recovery
// story. The desktop half lives in rust-launcher/src/rollback.rs; the
// hold-file contract they share is src/util/update-shared.js.
//
// A staged update flips $ROOT/current at STAGE time, so a release that
// passes the installers' exec probe (`-V` answers) but crashes during a
// real boot takes every later start down with it. Under the tray launcher
// the launcher's watchdog rolls back; headless there is no launcher — just
// a supervisor (or a human) restarting a binary that can never finish
// booting, and no running server means no update checker, so even a FIXED
// release can never arrive on its own.
//
// This guard runs from cli-boot-wrapper.js right after argv parsing —
// before the config parse, db open, and module loads where boot crashes
// actually happen — and:
//
//   1. counts boot attempts per version in the data home
//      (boot-attempts.json; cleared by server.js the moment a listen
//      succeeds, so only boots that never got that far accumulate);
//   2. on the third unacknowledged attempt of a managed install whose
//      `current` is committed to THIS version, appends the version to
//      update-hold.json (so the checker never re-stages it), re-points
//      `current` at the newest lower same-key version that still execs,
//      and hands THIS invocation over to that binary — spawn with
//      inherited stdio + mirrored exit, not exit-and-pray: a supervisor
//      with Restart=no (systemd's default), or no supervisor at all,
//      still ends up running the working version right now.
//
// Never engaged: under the launcher (--supervised — its watchdog owns the
// recovery, with better signals), for `-V`/`-h` (the installers' exec
// probe must stay pure — the wrapper fast-exits those before calling us),
// for workers, or on any layout that is not a managed install committed to
// this binary's own version. MSTREAM_BOOT_WATCHDOG=0 disables it outright.
//
// Deliberately dependency-light: node builtins, esm-helpers, and
// update-shared.js. Importing anything heavier would move the guard BEHIND
// the crash classes it exists to guard.
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { userDataHome, isBunStandalone } from './esm-helpers.js';
import { compareVersions, parseBundleName, readHoldEntries, appendHold } from './update-shared.js';
import packageJson from '../../package.json' with { type: 'json' };

// The third invocation acts: two real crashes first — one more than the
// launcher's in-session retry, because a supervisor's restart pacing is
// unknown and the counter spans invocations.
const MAX_BOOT_ATTEMPTS = 3;
const ATTEMPTS_FILE = 'boot-attempts.json';
const PROBE_TIMEOUT_MS = 10_000;

export function attemptsFilePath(dataHome = userDataHome()) {
  return path.join(dataHome, ATTEMPTS_FILE);
}

// The server binary's path inside a bundle (install.sh's server_rel /
// scripts/build-bun.mjs staging), per platform. Exported for the tests
// that fabricate bundles.
export function serverRel(platform = process.platform) {
  if (platform === 'win32') { return 'mstream-server.exe'; }
  if (platform === 'darwin') { return path.join('mStream.app', 'Contents', 'MacOS', 'mstream-server'); }
  return 'mstream-server';
}

function readAttempts(file) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (doc && typeof doc.version === 'string' && Number.isInteger(doc.attempts) && doc.attempts > 0) {
      return doc;
    }
  } catch { /* absent or mangled = no attempts */ }
  return null;
}

// Record this boot attempt for `version` BEFORE the crash-prone phase runs;
// returns the running count. A different recorded version resets the count
// — attempts never carry across versions. Sync + tmp-rename: this precedes
// the event loop mattering, and a torn file must read as "no attempts",
// never as a crash of its own.
export function bumpAttempts(version, dataHome = userDataHome()) {
  const file = attemptsFilePath(dataHome);
  const prev = readAttempts(file);
  const attempts = prev && prev.version === version ? prev.attempts + 1 : 1;
  const doc = { schema: 1, version, attempts, firstAt: prev && prev.version === version ? prev.firstAt : new Date().toISOString() };
  fs.mkdirSync(dataHome, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(doc));
  fs.renameSync(tmp, file);
  return attempts;
}

export function clearAttempts(dataHome = userDataHome()) {
  try { fs.unlinkSync(attemptsFilePath(dataHome)); } catch { /* absent is clear */ }
}

// Called from server.js the moment a listen succeeds: this boot is
// acknowledged, the counter starts over. Unconditional and cheap — the
// file only ever exists for unsupervised managed boots.
export function markBootOk() {
  clearAttempts();
}

// `<bin> -V`, bounded — the same bar as the installers' probe-before-flip
// and the desktop watchdog: never roll back INTO a binary that cannot exec.
function probeServer(bin) {
  const r = spawnSync(bin, ['-V'], { timeout: PROBE_TIMEOUT_MS, stdio: 'ignore' });
  return r.status === 0;
}

// The managed root this binary runs from, plus what `current` is committed
// to. Geometry from the real executable path (mirroring detectInstallMethod
// in update-check.js), or the MSTREAM_UPDATE_ROOT escape hatch — which also
// waives the standalone requirement, exactly as it does there, so tests and
// operators can exercise the guard from a source run. null = not managed.
export function findManagedContext({
  execPath = process.execPath,
  env = process.env,
  standalone = isBunStandalone,
  platform = process.platform,
  fsx = fs,
} = {}) {
  let root = null;
  if (env.MSTREAM_UPDATE_ROOT) {
    root = env.MSTREAM_UPDATE_ROOT;
  } else if (standalone) {
    let real = execPath;
    try { real = fsx.realpathSync(execPath); } catch { /* keep the literal path */ }
    let dir = path.dirname(real);
    for (let i = 0; i < 8; i++) {
      const parent = path.dirname(dir);
      if (parent === dir) { break; }
      if (parseBundleName(path.basename(dir)) && fsx.existsSync(path.join(parent, 'current'))) {
        root = parent;
        break;
      }
      dir = parent;
    }
  }
  if (!root) { return null; }
  let target;
  try { target = fsx.readlinkSync(path.join(root, 'current')); } catch { return null; }
  const parsed = parseBundleName(path.basename(target));
  if (!parsed) { return null; }
  return { root, currentVersion: parsed.version, key: parsed.key, platform };
}

// The newest lower same-key version on disk that is not held and still
// execs — the same candidate rules as the launcher's plan_rollback.
export function planRollback({ root, key, failedVersion, dataHome, platform = process.platform, fsx = fs, probe = probeServer }) {
  const held = readHoldEntries(dataHome).map((h) => h.version);
  const candidates = [];
  for (const entry of fsx.readdirSync(root)) {
    const parsed = parseBundleName(entry);
    if (!parsed || parsed.key !== key) { continue; }
    const cmp = compareVersions(parsed.version, failedVersion);
    if (cmp === null || cmp >= 0 || held.includes(parsed.version)) { continue; }
    const bundle = path.join(root, entry);
    if (fsx.existsSync(path.join(bundle, serverRel(platform)))) {
      candidates.push({ version: parsed.version, bundle });
    }
  }
  candidates.sort((a, b) => compareVersions(b.version, a.version) || 0);
  const pick = candidates.find((c) => probe(path.join(c.bundle, serverRel(platform))));
  return pick ? { targetVersion: pick.version, targetBundle: pick.bundle } : null;
}

// Replace `link` with a symlink/junction to `target` — same contract as
// replaceLink in update-check.js (tmp + rename where the platform allows;
// Windows may refuse a rename onto a junction, keeping the pre-existing
// unlink+create exposure). Duplicated so this module stays light.
async function replaceLink(target, link) {
  const tmp = `${link}.tmp-${process.pid}`;
  const kind = process.platform === 'win32' ? 'junction' : 'dir';
  await fsp.rm(tmp, { force: true }).catch(() => {});
  await fsp.symlink(target, tmp, kind);
  try {
    await fsp.rename(tmp, link);
  } catch {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    await fsp.unlink(link).catch(() => {});
    await fsp.symlink(target, link, kind);
  }
}

export async function executeRollback({ root, failedVersion, targetBundle, dataHome }) {
  // Hold FIRST: even if the re-point dies, the record exists — the next
  // server to run (any path: a manual start of the previous version, the
  // fixed release) refuses to re-stage the bad one, and its enforceHold
  // pass finishes the re-point.
  await appendHold(dataHome, failedVersion, 'server crashed during boot (headless watchdog)');
  await replaceLink(targetBundle, path.join(root, 'current'));
  // The stale status file is left alone on purpose: it belongs to the
  // LAUNCHER conversation, and an unsupervised boot means no launcher is
  // polling it — while a tray session elsewhere on this data home would be
  // exactly the reader we must not clobber.
}

// Hand the rest of THIS invocation to the previous version's server:
// inherited stdio (the --supervised stdin pipe, if any, flows through to
// the child), forwarded signals, mirrored exit code.
function handoff(bin, argv) {
  const child = spawn(bin, argv, { stdio: 'inherit' });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    try {
      process.on(sig, () => { try { child.kill(sig); } catch { /* already gone */ } });
    } catch { /* SIGHUP on windows */ }
  }
  child.on('error', (err) => {
    console.error(`[boot-watchdog] could not start ${bin}: ${err.message}`);
    process.exit(1);
  });
  child.on('close', (code) => { process.exit(code === null ? 1 : code); });
}

// The guard cli-boot-wrapper.js calls right after argv parsing. Resolves
// (falsy) to continue booting normally; on a rollback it hands this
// invocation to the previous version's binary and NEVER resolves — exec
// semantics: the child owns our stdio, its exit exits us via handoff().
// Every failure inside deliberately degrades to "continue booting": the
// guard must never be the reason a healthy install won't start.
export async function guardHeadlessBoot(argv, { env = process.env } = {}) {
  if (env.MSTREAM_BOOT_WATCHDOG === '0') { return false; }
  let ctx = null;
  try { ctx = findManagedContext({ env }); } catch { /* not our call */ }
  if (!ctx) { return false; }
  const ourVersion = packageJson.version;
  // Only when the layout is committed to US — a `current` already pointing
  // elsewhere (an operator's re-point, a finished rollback with the
  // supervisor still pinned to the old path) is not ours to count against.
  if (ctx.currentVersion !== ourVersion) { return false; }
  const dataHome = userDataHome();
  let attempts;
  try { attempts = bumpAttempts(ourVersion, dataHome); } catch { return false; }
  if (attempts < MAX_BOOT_ATTEMPTS) { return false; }
  let plan = null;
  try {
    plan = planRollback({ root: ctx.root, key: ctx.key, failedVersion: ourVersion, dataHome });
  } catch { /* fall through to the no-plan path */ }
  if (!plan) {
    console.error(`[boot-watchdog] mStream ${ourVersion} has not finished booting in ${attempts - 1} attempts `
      + 'and there is nothing usable on disk to roll back to - continuing anyway');
    return false;
  }
  console.error(`[boot-watchdog] mStream ${ourVersion} crashed during boot ${attempts - 1} times - `
    + `rolling back to ${plan.targetVersion} and holding ${ourVersion} (update-hold.json)`);
  try {
    await executeRollback({ root: ctx.root, failedVersion: ourVersion, targetBundle: plan.targetBundle, dataHome });
  } catch (err) {
    console.error(`[boot-watchdog] rollback failed: ${err.message} - continuing with this version`);
    return false;
  }
  handoff(path.join(plan.targetBundle, serverRel()), argv);
  // Never resolves: the spawned child (and its exit-mirroring handlers)
  // keep the process alive; nothing after this await may run.
  return new Promise(() => {});
}
