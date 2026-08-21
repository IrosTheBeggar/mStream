// Scanner orphan-reaper.
//
// The kill queue (src/state/kill-list.js) covers clean exits and catchable
// signals, but nothing JS-side can run on TerminateProcess (Task Manager
// "End task", `taskkill /F`, the Electron updater replacing the app) or
// SIGKILL. A scanner child that survives its parent keeps writing to the
// DB and lock-fights the next server instance — including its boot
// migrations, which abort the whole boot on failure.
//
// Platform reality (smoke-tested): on Windows, libuv puts non-detached
// children in a kill-on-job-close Job Object, so TerminateProcess on the
// server usually takes the scanner down with it — the Windows artifact is
// a STALE pidfile pointing at a dead pid, which the reap below clears
// silently. Live orphans are primarily a Unix phenomenon (SIGKILL, OOM
// kill), where the scanner is reparented to init and keeps running.
//
// So: task-queue.js records every scanner spawn in a pidfile next to the
// DB and clears it when the scan closes. Boot calls reapOrphanedScanner()
// BEFORE the DB is opened and migrated; if the recorded pid is still
// alive, genuinely ORPHANED (its recorded parent is dead — a live parent
// means a reboot() re-entry or a second server instance whose scan is
// healthy and managed), AND verifiably a scanner (image/command-line
// check — a reused pid must never get an innocent process killed), it is
// terminated. An identity that can't be established either way keeps the
// record for a later boot: never kill blind, never forget a live orphan.
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
      kind, // 'rust' | 'js' | 'waveform'
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
// `needCmdline` gates the command-line lookup: only js-kind records need
// it (rust/waveform verdicts are image-only), and on Windows it is a
// PowerShell CIM query whose cold start can take double-digit seconds on
// a loaded machine — the preferred rust scanner should never pay that.
// `pid` is integer-validated by the caller, so interpolation is safe.
function probeProcess(pid, needCmdline) {
  try {
    if (process.platform === 'win32') {
      const r = child.spawnSync('tasklist',
        ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
        { timeout: 5000 });
      const line = (r.stdout || '').toString().split(/\r?\n/).find(l => l.startsWith('"'));
      if (!line) { return null; } // tasklist prints an INFO line when no match
      const image = line.split('","')[0].replace(/^"/, '').toLowerCase();
      // The command line needs WMI (tasklist doesn't expose it). Only
      // required to vet generic images like node.exe; a failure leaves
      // cmdline null and the caller refuses to kill on it.
      //
      // wmic first: it talks to WMI without PowerShell's cold start and
      // typically answers in well under a second even on a cold machine.
      // It is deprecated — client 24H2+ and Server 2025 ship without it —
      // so ANY failure (absent binary, timeout, no output) falls through
      // to the PowerShell CIM query. That fallback's budget stays
      // deliberately generous: PowerShell's cold start blew an 8s cap on
      // a loaded CI runner (2026-08-04) and the raised 30s cap on another
      // (2026-08-20) — a timeout here demotes a real orphan to
      // "unverifiable", alive until a later boot manages to inspect it,
      // which is exactly why callers must treat 'unknown' as retryable.
      let cmdline = null;
      if (needCmdline) {
        try {
          const w = child.spawnSync('wmic',
            ['process', 'where', `processid=${pid}`, 'get', 'commandline', '/format:list'],
            { timeout: 5000 });
          if (w.status === 0) {
            const m = (w.stdout || '').toString().match(/^CommandLine=(.*)$/m);
            if (m && m[1].trim()) { cmdline = m[1].trim(); }
          }
        } catch (_err) { /* absent binary — fall through to CIM */ }
        if (cmdline === null) {
          const ps = child.spawnSync('powershell',
            ['-NoProfile', '-NonInteractive', '-Command',
              `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],
            { timeout: 30000 });
          if (ps.status === 0) {
            cmdline = (ps.stdout || '').toString().trim() || null;
          }
        }
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
    let cmdline = null;
    if (needCmdline) {
      const args = (child.spawnSync('ps', ['-p', String(pid), '-o', 'args='], { timeout: 5000 })
        .stdout || '').toString().trim();
      cmdline = args || null;
    }
    return { image: path.basename(comm).toLowerCase(), cmdline };
  } catch (_err) {
    return null;
  }
}

// A reused pid must NEVER get an innocent process killed, so the bar is
// "provably a scanner", not "probably". Three verdicts, and the caller
// must compare them EXPLICITLY — they are truthy strings, so a boolean
// test would treat 'stranger' as a kill license:
//  - 'scanner':  provably the recorded scanner — the only kill verdict.
//  - 'stranger': provably NOT a scanner — the pid was recycled by an
//    unrelated process; the record is permanently stale, safe to drop.
//  - 'unknown':  identity could not be established either way (generic
//    image, no readable command line). Neither kill nor forget: the
//    caller keeps the record so a later boot retries.
// Rules:
//  - rust: the image must match what we recorded AND carry the
//    distinctive rust-parser prefix (rust-parser-<platform>-<arch>[.exe]
//    prebuilt, rust-parser[.exe] local build). The image comes from a
//    successful tasklist/ps probe, so a mismatch is definitive.
//  - js: the image (node/electron) is far too generic on its own —
//    require the command line to reference the recorded scanner.mjs path
//    too (falling back to the bare filename for records that predate the
//    marker field). If the platform can't produce a command line, the
//    verdict is 'unknown': a leaked scanner is less dangerous than
//    killing an unrelated node process — but forgetting a live orphan
//    is a real cost too, so the record must survive for a retry.
// Exported for unit tests: the verdict table IS the safety contract.
export function looksLikeScanner(probe, rec) {
  const expectedImage = String(rec.image || '').toLowerCase();
  if (rec.kind === 'rust' || rec.kind === 'waveform') {
    // 'waveform' is the post-scan enrichment pass — same rust-parser
    // binary, same provability rule. (It never holds a DB handle while
    // decoding, so reaping it is about CPU hygiene, not lock safety.)
    return probe.image === expectedImage && probe.image.startsWith('rust-parser')
      ? 'scanner' : 'stranger';
  }
  if (rec.kind === 'js') {
    if (probe.image !== expectedImage) { return 'stranger'; }
    if (typeof probe.cmdline !== 'string') { return 'unknown'; }
    const needle = typeof rec.marker === 'string' && rec.marker ? rec.marker : 'scanner.mjs';
    return probe.cmdline.includes(needle) ? 'scanner' : 'stranger';
  }
  // Unrecognized kind: the record can never be verified — treat it as
  // permanently stale rather than retrying forever.
  return 'stranger';
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
  const needCmdline = rec.kind === 'js';
  const probe = probeProcess(pid, needCmdline);
  if (!probe) {
    // Couldn't inspect the process (constrained PowerShell, exotic
    // platform). Keep the record so a later boot can retry rather than
    // forgetting a live orphan forever — and never kill blind.
    winston.warn(
      `Scanner pidfile points at live pid ${pid} but it could not be ` +
      'inspected — leaving it alone; will retry next boot.');
    return;
  }
  const verdict = looksLikeScanner(probe, rec);
  if (verdict === 'unknown') {
    // Live and wearing the right image, but the command line could not
    // be read, so a recycled pid can't be ruled out — and killing blind
    // is forbidden. Keep the record: it clears itself once the pid dies,
    // and until then a later boot retries the inspection.
    winston.warn(
      `Scanner pidfile points at live pid ${pid} (${probe.image}) whose ` +
      'command line could not be read to confirm it is a scanner — ' +
      'leaving it alone; will retry next boot.');
    return;
  }
  if (verdict === 'stranger') {
    // Live, inspectable, and provably not a scanner: the pid was
    // recycled by an unrelated process. The record is permanently
    // stale — drop it.
    winston.warn(
      `Scanner pidfile pointed at live pid ${pid} (${probe.image}), ` +
      'which is not a scanner — pid was recycled; dropping the stale record.');
    clearScannerPidfile(dbDirectory);
    return;
  }
  // verdict === 'scanner': provably ours. This is the ONLY verdict that
  // may reach the kill below — never use these strings as booleans.

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
    const recheck = probeProcess(pid, needCmdline);
    if (recheck && looksLikeScanner(recheck, rec) === 'scanner') {
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
