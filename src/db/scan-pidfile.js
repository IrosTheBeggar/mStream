// Scanner orphan-reaper.
//
// The kill queue (src/state/kill-list.js) covers clean exits and catchable
// signals, but nothing JS-side can run on TerminateProcess (Task Manager
// "End task", `taskkill /F`, the Electron updater replacing the app) or
// SIGKILL. A scanner child that survives its parent keeps writing to the
// DB and lock-fights the next server instance — including its boot
// migrations, which abort the whole boot on failure.
//
// So: task-queue.js records every scanner spawn in a pidfile next to the
// DB and clears it when the scan closes. Boot calls reapOrphanedScanner()
// BEFORE the DB is opened and migrated; if the recorded pid is still
// alive, genuinely ORPHANED (its recorded parent is dead — a live parent
// means a reboot() re-entry or a second server instance whose scan is
// healthy and managed), AND verifiably a scanner (image/command-line
// check — a reused pid must never get an innocent process killed), it is
// terminated.
//
// Everything here is synchronous on purpose: it runs once, at boot,
// before anything else touches the DB.

import fs from 'fs';
import path from 'path';
import child from 'child_process';
import winston from 'winston';

const PIDFILE = '.scanner.pid.json';

function pidfilePath(dbDirectory) {
  return path.join(dbDirectory, PIDFILE);
}

// Called by task-queue.js right after a scanner child is spawned.
// `imagePath` is the executable that owns the pid: the rust-parser binary
// for kind 'rust', process.execPath (node — or electron when forked from
// the desktop app, which is also what the probe will see) for kind 'js'.
// `marker` further pins the identity for generic images: the absolute
// scanner.mjs path the fork was launched with.
export function writeScannerPidfile(dbDirectory, pid, imagePath, kind, marker = null) {
  try {
    fs.writeFileSync(pidfilePath(dbDirectory), JSON.stringify({
      pid,
      // Which server process spawned it. A reaper run must NOT touch a
      // child whose parent is still alive: same-pid means reboot()
      // re-entered serveIt() in this very process mid-scan; a different
      // live pid means a second server instance owns the scan. Killing
      // either would abort a healthy, managed scan.
      ppid: process.pid,
      image: path.basename(imagePath).toLowerCase(),
      kind, // 'rust' | 'js'
      marker,
      startedAt: new Date().toISOString(),
    }));
  } catch (err) {
    // Non-fatal: the reaper just has nothing to act on next boot.
    winston.warn(`Could not write scanner pidfile: ${err.message}`);
  }
}

export function clearScannerPidfile(dbDirectory) {
  try { fs.unlinkSync(pidfilePath(dbDirectory)); } catch (_err) { /* already gone */ }
}

// signal 0 probes existence without sending anything. EPERM means "alive
// but not ours" — still alive.
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Synchronous sleep without spinning — Atomics.wait is permitted on the
// Node main thread (unlike in browsers).
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Best-effort identity probe for a live pid. Returns
// { image: <lowercased executable basename>, cmdline: <string|null> }
// or null when the process can't be inspected (caller keeps the record
// and retries on a later boot rather than killing blind).
// `pid` is integer-validated by the caller, so interpolation is safe.
function probeProcess(pid) {
  try {
    if (process.platform === 'win32') {
      const r = child.spawnSync('tasklist',
        ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
        { timeout: 5000 });
      const line = (r.stdout || '').toString().split(/\r?\n/).find(l => l.startsWith('"'));
      if (!line) { return null; } // tasklist prints an INFO line when no match
      const image = line.split('","')[0].replace(/^"/, '').toLowerCase();
      // The command line needs a CIM query (tasklist doesn't expose it).
      // Only required to vet generic images like node.exe; a failure
      // leaves cmdline null and the caller refuses to kill on it.
      let cmdline = null;
      const ps = child.spawnSync('powershell',
        ['-NoProfile', '-NonInteractive', '-Command',
          `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],
        { timeout: 8000 });
      if (ps.status === 0) {
        cmdline = (ps.stdout || '').toString().trim() || null;
      }
      return { image, cmdline };
    }
    if (process.platform === 'linux') {
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      const argv = raw.split('\0').filter(Boolean);
      if (!argv.length) { return null; }
      return { image: path.basename(argv[0]).toLowerCase(), cmdline: argv.join(' ') };
    }
    // macOS and the rest. comm= is the executable path alone (no
    // arguments) so it survives paths with spaces — splitting args= on
    // whitespace would misparse "/Applications/mStream.app/Contents/…".
    const comm = (child.spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { timeout: 5000 })
      .stdout || '').toString().trim();
    if (!comm) { return null; }
    const args = (child.spawnSync('ps', ['-p', String(pid), '-o', 'args='], { timeout: 5000 })
      .stdout || '').toString().trim();
    return { image: path.basename(comm).toLowerCase(), cmdline: args || null };
  } catch (_err) {
    return null;
  }
}

// A reused pid must NEVER get an innocent process killed, so the bar is
// "provably a scanner", not "probably":
//  - rust: the image must match what we recorded AND carry the
//    distinctive rust-parser prefix (rust-parser-<platform>-<arch>[.exe]
//    prebuilt, rust-parser[.exe] local build).
//  - js: the image (node/electron) is far too generic on its own —
//    require the command line to reference the recorded scanner.mjs path
//    too (falling back to the bare filename for records that predate the
//    marker field). If the platform can't produce a command line,
//    refuse: a leaked scanner is less dangerous than killing an
//    unrelated node process.
function looksLikeScanner(probe, rec) {
  const expectedImage = String(rec.image || '').toLowerCase();
  if (rec.kind === 'rust') {
    return probe.image === expectedImage && probe.image.startsWith('rust-parser');
  }
  if (rec.kind === 'js') {
    if (probe.image !== expectedImage) { return false; }
    if (typeof probe.cmdline !== 'string') { return false; }
    const needle = typeof rec.marker === 'string' && rec.marker ? rec.marker : 'scanner.mjs';
    return probe.cmdline.includes(needle);
  }
  return false;
}

// Boot-time reap. Call BEFORE dbManager.initDB() — the entire point is
// that an orphan must be gone before this boot's migrations take the
// write lock.
export function reapOrphanedScanner(dbDirectory) {
  const file = pidfilePath(dbDirectory);
  let rec;
  try {
    if (!fs.existsSync(file)) { return; }
    rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_err) {
    clearScannerPidfile(dbDirectory);
    return;
  }

  const pid = Number(rec?.pid);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    clearScannerPidfile(dbDirectory);
    return;
  }
  if (!isAlive(pid)) {
    // Normal case: previous run shut down cleanly after the pidfile's
    // scan, or the orphan already exited on its own.
    clearScannerPidfile(dbDirectory);
    return;
  }
  if (Number(rec.ppid) === process.pid) {
    // A live child of THIS process — reboot() re-entered serveIt() while
    // a scan is still running. It's managed by task-queue, not orphaned:
    // leave the record in place so onScanClose can clear it.
    return;
  }
  const ppid = Number(rec.ppid);
  if (Number.isInteger(ppid) && ppid > 0 && isAlive(ppid)) {
    // The recorded parent is still alive: a second server instance is
    // sharing this dbDirectory and its scan is healthy and managed — its
    // own onScanClose will clear the record. Not ours to kill. (If the
    // ppid was merely recycled by an unrelated process, we skip a real
    // orphan this boot; a later boot reaps it once that pid frees up —
    // the schema guard and busy_timeout bound the interim damage.)
    winston.warn(
      `Scanner pidfile records a scan owned by live process ${ppid} ` +
      '(another mStream instance on this DB?) — leaving it alone.');
    return;
  }
  const probe = probeProcess(pid);
  if (!probe) {
    // Couldn't inspect the process (constrained PowerShell, exotic
    // platform). Keep the record so a later boot can retry rather than
    // forgetting a live orphan forever — and never kill blind.
    winston.warn(
      `Scanner pidfile points at live pid ${pid} but it could not be ` +
      'inspected — leaving it alone; will retry next boot.');
    return;
  }
  if (!looksLikeScanner(probe, rec)) {
    // Live, inspectable, but not a scanner: the pid was recycled by an
    // unrelated process. The record is permanently stale — drop it.
    winston.warn(
      `Scanner pidfile pointed at live pid ${pid} (${probe.image}), ` +
      'which is not a scanner — pid was recycled; dropping the stale record.');
    clearScannerPidfile(dbDirectory);
    return;
  }

  winston.warn(
    `Found orphaned ${rec.kind} scanner from a previous run ` +
    `(pid ${pid}, started ${rec.startedAt || 'unknown'}) — terminating it before opening the DB.`);
  clearScannerPidfile(dbDirectory);
  try { process.kill(pid); } catch (_err) { /* lost a race with its exit */ }
  // On Windows kill() is already TerminateProcess; on Unix give SIGTERM a
  // couple of seconds, then escalate — but re-verify identity first: the
  // pid could in principle be recycled inside the wait window, and
  // SIGKILL must never hit a stranger.
  for (let i = 0; i < 20 && isAlive(pid); i++) { sleepSync(100); }
  if (isAlive(pid)) {
    const recheck = probeProcess(pid);
    if (recheck && looksLikeScanner(recheck, rec)) {
      try { process.kill(pid, 'SIGKILL'); } catch (_err) { /* gone */ }
      for (let i = 0; i < 10 && isAlive(pid); i++) { sleepSync(100); }
    }
  }
  if (isAlive(pid)) {
    winston.error(`Orphaned scanner pid ${pid} could not be terminated — boot continuing, but migrations may hit lock contention.`);
  } else {
    winston.info('Orphaned scanner terminated.');
  }
}
