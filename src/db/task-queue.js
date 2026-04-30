import child from 'child_process';
import fs from 'fs';
import path from 'path';
import winston from 'winston';
import { nanoid } from 'nanoid';
import * as config from '../state/config.js';
import * as db from './manager.js';
import { addToKillQueue, removeFromKillQueue } from '../state/kill-list.js';
import { getDirname } from '../util/esm-helpers.js';
import * as dlnaApi from '../api/dlna.js';

const __dirname = getDirname(import.meta.url);

// ── Unified task queue ──────────────────────────────────────────────────────
//
// One queue, two task shapes:
//   { task: 'scan',   vpath, id, forceRescan }
//   { task: 'backup', destinationId, triggerReason, id }
//
// A "category mutex" enforces that scans and backups never run concurrently
// on the same host: both classes hammer the music library's I/O bandwidth
// (scan reads metadata + writes db rows; backup reads source + writes dest)
// and would degrade each other badly if run together. Multiple concurrent
// scans are still allowed (up to scanOptions.maxConcurrentTasks); backups
// are sequential among themselves regardless.
//
// Dedup at enqueue time prevents long-running tasks from piling up the
// queue with redundant follow-ups:
//   - Scans: same-vpath drop. Without this, a 30h scan on a >500k-track
//     library would let setInterval(scanAll, 24h) accumulate one fresh
//     scan request per missed cycle, and we'd thrash the disk re-scanning
//     for hours after the original scan finally completes.
//   - Backups: same-destinationId drop. Similar pile-up risk from the
//     5-minute daily-trigger tick during a long backup.
//
// In-flight tracking:
//   - runningTasks: set of child_process handles (mixed scan + backup)
//   - runningCategories: counts active workers by task type (mutex check)
//   - vpathLimiter: prevents two scans of the SAME vpath running simul-
//     taneously (concurrent scans of different vpaths are fine)
//   - activeBackupRun: at most one — task-queue exports getter for the API
const taskQueue = [];
const runningTasks = new Set();
const runningCategories = { scan: 0, backup: 0 };
const vpathLimiter = new Set();
let activeBackupRun = null;  // { destinationId, historyId } | null

// Optional callback invoked from onScanClose with the just-finished scanObj.
// backup/manager.js registers this at init() time so an after-scan trigger
// can enqueue backup tasks without task-queue.js needing a hard import on
// the backup module (avoids a circular dependency: task-queue spawns the
// backup worker, the backup module schedules + reports — both touch the
// queue, and pulling backup-manager into task-queue's load graph would
// create one).
let onScanCompleteCallback = null;
export function setOnScanCompleteCallback(fn) { onScanCompleteCallback = fn; }

let scanIntervalTimer = null;
// True when any scan in the current batch added, changed, or removed tracks.
// Used to decide whether to bump DLNA's SystemUpdateID after the final scan
// in a batch — skipped on fully-unchanged rescans so control points aren't
// poked for nothing.
let anyScansChanged = false;
// True between runAfterBoot noticing a `.rescan-pending` migration marker
// and the resulting rescanAll() draining the queue. The marker is only
// unlinked once this flag is set AND the queue empties — if the process
// crashes partway through the rescan, the marker survives and the next
// boot re-runs the rescan. Without this, an interrupted boot rescan left
// the DB stuck on pre-rescan row shapes (e.g. V18 compilations still
// fragmented) with no surfacing signal.
let bootRescanInFlight = false;
let bootRescanMarkerPath = null;

// ── Rust parser binary detection ────────────────────────────────────────────

const ext = process.platform === 'win32' ? '.exe' : '';
// Detect musl libc (Alpine, Void, distroless musl, etc.) — glibcVersionRuntime is undefined on musl
const isMusl = process.platform === 'linux' && !process.report?.getReport()?.header?.glibcVersionRuntime;
const libcSuffix = isMusl ? '-musl' : '';
const rustParserDir = path.join(__dirname, '../../rust-parser');
const prebuiltBin = path.join(__dirname, `../../bin/rust-parser/rust-parser-${process.platform}-${process.arch}${libcSuffix}${ext}`);
const localBuildBin = path.join(rustParserDir, `target/release/rust-parser${ext}`);
let rustParserBin = null;
let rustBinaryReady = false;
let rustParserDisabled = false;

function findRustParser() {
  if (rustParserDisabled) { return false; }
  if (rustBinaryReady) { return true; }

  const markReady = (binPath) => {
    rustParserBin = binPath;
    // Docker / tarball extraction can strip the execute bit — restore it.
    // No-op on Windows; if chmod fails (read-only volume etc.) the later
    // spawn will fail and trigger the JS fallback in runScan().
    try { fs.chmodSync(binPath, 0o755); } catch (_) {}
    rustBinaryReady = true;
    return true;
  };

  // Check local build first (may be newer than prebuilt during
  // development). Probe it with `--waveform <nonexistent>` — the
  // subcommand is a recent addition, so a stale local build that
  // pre-dates it falls through to the main JSON-input path and
  // exits 1 with "Invalid JSON Input". If that happens, skip the
  // stale local build and let the newer prebuilt bin take over.
  // Without this, an old `cargo build --release` output would
  // silently shadow the CI-shipped binary and break scans.
  if (fs.existsSync(localBuildBin)) {
    try {
      const probe = child.spawnSync(localBuildBin, ['--waveform', path.join(rustParserDir, 'NONEXISTENT_PROBE_FILE')],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
      const stderr = (probe.stderr || '').toString();
      if (!/Invalid JSON Input/.test(stderr)) { return markReady(localBuildBin); }
      winston.warn(`Local rust-parser build at ${localBuildBin} pre-dates the --waveform subcommand; ` +
        `falling through to the prebuilt binary. Rebuild with \`npm run build-rust\` to clear this warning.`);
    } catch (_) { /* probe failed — try the prebuilt */ }
  }
  if (fs.existsSync(prebuiltBin)) { return markReady(prebuiltBin); }

  // Try to build from source
  winston.info('Rust parser binary not found — building from source...');
  try {
    child.execSync('cargo build --release', { cwd: rustParserDir, stdio: 'pipe', timeout: 300000 });
    if (fs.existsSync(localBuildBin)) {
      markReady(localBuildBin);
      winston.info('Rust parser built successfully');
      return true;
    }
  } catch (err) {
    winston.warn(`Failed to build Rust parser: ${err.message}. Falling back to JS parser.`);
  }
  return false;
}

// ── Stream helpers ──────────────────────────────────────────────────────────

// Wire `stream` (a child process's stdout or stderr) up to call `onLine`
// with each newline-terminated chunk it emits, plus any trailing line
// the child wrote without a newline before exiting. Used by both the
// scanner and backup-worker handlers, which all want the same "parse
// JSON events / log free text" treatment regardless of how the OS
// chunks the pipe.
//
// Without this helper, four near-identical 12-line buffer loops were
// scattered across the file (scanner stdout, scanner stderr, backup
// stdout, backup stderr) and any tweak to the buffering invariant had
// to be made in all four places.
function bufferLines(stream, onLine) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    // Last entry is whatever's after the final \n — keep it for the
    // next chunk (or the 'end' flush).
    buffer = lines.pop() || '';
    for (const line of lines) { onLine(line.trim()); }
  });
  stream.on('end', () => {
    if (buffer.trim()) { onLine(buffer.trim()); }
    buffer = '';
  });
}

// ── Mutex / dispatch ────────────────────────────────────────────────────────

// A scan can run when no backup is active, no other scan owns its vpath,
// and we're under maxConcurrentTasks. The category mutex (no scan during
// backup, no backup during scan) prevents disk thrash from the two
// classes hammering the library simultaneously.
function canStartScan(task) {
  if (runningCategories.backup > 0) { return false; }
  if (runningCategories.scan >= config.program.scanOptions.maxConcurrentTasks) { return false; }
  if (vpathLimiter.has(task.vpath)) { return false; }
  return true;
}

// A backup can run when nothing scan-side is active and no other backup
// is running. Backups are intentionally sequential among themselves —
// concurrent backups across destinations would still contend for the
// SAME source library's I/O bandwidth, and "one at a time" was the
// product call (see PR #578 design discussion).
function canStartBackup() {
  if (runningCategories.scan > 0) { return false; }
  if (runningCategories.backup > 0) { return false; }
  return true;
}

function canStart(task) {
  if (task.task === 'scan')   { return canStartScan(task); }
  if (task.task === 'backup') { return canStartBackup(); }
  return false;
}

// Greedy queue drain: in one call, start every task that's currently
// runnable under the mutex. Single pass — starting a task can only ADD
// constraints (e.g. a started backup blocks all scans + other backups),
// never relax them, so a candidate we already skipped at position < i
// stays un-runnable and there's no reason to revisit it. After splice()
// removes the launched task we leave `i` alone because everything after
// the removed slot just shifted down by one.
function nextTask() {
  for (let i = 0; i < taskQueue.length; ) {
    if (!canStart(taskQueue[i])) { i++; continue; }
    const candidate = taskQueue.splice(i, 1)[0];
    if (candidate.task === 'scan')        { runScan(candidate); }
    else if (candidate.task === 'backup') { runBackupTask(candidate); }
  }
}

// Drained-queue side effects shared by onScanClose + onBackupClose.
// Centralised here because the DLNA bump and the migration-rescan marker
// cleanup both depend on "all queued and active work finished," which can
// be triggered by either kind of close after the unified-queue change.
function checkQueueDrainedSideEffects() {
  const drained = runningTasks.size === 0 && taskQueue.length === 0;
  if (!drained) { return; }

  // Bump DLNA's SystemUpdateID so control points refresh their caches —
  // but only if some scan in the just-drained batch actually changed the
  // DB. Backups don't change library content, so they don't set the flag.
  // Safe to call whether or not DLNA is enabled.
  if (anyScansChanged) {
    anyScansChanged = false;
    dlnaApi.bumpSystemUpdateID();
  }

  // Clear the migration rescan marker only after every queued task —
  // including any backup that piled in behind the scans — has finished.
  // If the process dies before this point, the marker survives on disk
  // and the next boot re-triggers rescanAll().
  if (bootRescanInFlight) {
    bootRescanInFlight = false;
    if (bootRescanMarkerPath) {
      try {
        fs.unlinkSync(bootRescanMarkerPath);
        winston.info('Migration rescan complete — cleared .rescan-pending marker');
      } catch (err) {
        if (err.code !== 'ENOENT') {
          winston.warn(`Could not clear .rescan-pending marker at ${bootRescanMarkerPath}: ${err.message}`);
        }
      }
      bootRescanMarkerPath = null;
    }
  }
}

// ── Scan task management ────────────────────────────────────────────────────

function addScanTask(vpath, forceRescan = false) {
  // Dedup: drop if a scan for this vpath is already running, and merge
  // forceRescan upgrade into a queued one. Without this, a scan that
  // outlasts scanInterval (24h default) lets the periodic timer pile up
  // a fresh full-library scan request for every missed cycle, and we'd
  // re-walk the library N times for nothing once the original finished.
  if (vpathLimiter.has(vpath)) {
    winston.info(`Scan request for vpath '${vpath}' dropped — already running`);
    return;
  }
  const queued = taskQueue.find((t) => t.task === 'scan' && t.vpath === vpath);
  if (queued) {
    if (forceRescan && !queued.forceRescan) {
      // A user-initiated force-rescan overtaking a regular queued scan
      // shouldn't be silently lost — upgrade the queued entry's flag so
      // when it eventually runs, it's the heavy version the user asked for.
      queued.forceRescan = true;
      winston.info(`Scan request for vpath '${vpath}' merged — queued scan upgraded to force-rescan`);
    } else {
      winston.info(`Scan request for vpath '${vpath}' dropped — already queued`);
    }
    return;
  }
  taskQueue.push({ task: 'scan', vpath, id: nanoid(8), forceRescan });
  nextTask();
}

function scanAll() {
  const libraries = db.getAllLibraries();
  for (const lib of libraries) {
    addScanTask(lib.name);
  }
}

function rescanAll() {
  const libraries = db.getAllLibraries();
  for (const lib of libraries) {
    addScanTask(lib.name, true);
  }
}

function handleScannerLine(line) {
  if (!line) { return; }
  // Structured events from the scanner are emitted as single-line JSON;
  // see scanner.mjs and rust-parser/src/main.rs for the event shapes.
  if (line[0] === '{') {
    try {
      const evt = JSON.parse(line);
      if (evt?.event === 'scanComplete') {
        // filesUnchanged / filesScanned were added to the contract later — emit
        // them only when the scanner actually reported them, so a stale
        // prebuilt rust-parser binary still produces a clean log line instead
        // of "undefined unchanged" / "(undefined scanned)".
        const parts = [`${evt.filesProcessed} files processed`];
        if (evt.filesUnchanged != null) {
          parts.push(`${evt.filesUnchanged} unchanged`);
        }
        parts.push(`${evt.staleEntriesRemoved} stale entries removed`);
        const tail = evt.filesScanned != null ? ` (${evt.filesScanned} scanned)` : '';
        winston.info(`Scan complete: ${parts.join(', ')}${tail}`);
        if (evt.filesProcessed > 0 || evt.staleEntriesRemoved > 0) {
          anyScansChanged = true;
        }
        return;
      }
    } catch (_) { /* not a structured event — fall through and log as plain text */ }
  }
  winston.info(line);
}

function attachScanHandlers(forkedScan, scanObj) {
  runningTasks.add(forkedScan);
  runningCategories.scan++;
  vpathLimiter.add(scanObj.vpath);

  // Ensure scanner is killed on server shutdown; keep a handle so we can
  // drop the entry from the kill queue when the process exits cleanly —
  // otherwise the queue would grow unbounded across scheduled scans.
  const killFn = () => { try { forkedScan.kill(); } catch (_) {} };
  forkedScan._killFn = killFn;
  addToKillQueue(killFn);

  // stdout: structured JSON events + any free-text log lines. handleScannerLine
  // figures out which is which.
  bufferLines(forkedScan.stdout, handleScannerLine);

  // stderr: scanner lines prefixed with "Warning:" are recoverable
  // (metadata parse failures fall back to null tags; the track still gets
  // indexed) and are logged at warn level so a library with malformed ID3
  // tags doesn't flood error-level log streams. Anything else is a real error.
  bufferLines(forkedScan.stderr, (line) => {
    if (!line) { return; }
    if (line.startsWith('Warning:')) { winston.warn(`File scan: ${line}`); }
    else { winston.error(`File scan error: ${line}`); }
  });
}

function onScanClose(forkedScan, scanObj, code) {
  winston.info(`File scan completed with code ${code}`);
  runningTasks.delete(forkedScan);
  runningCategories.scan = Math.max(0, runningCategories.scan - 1);
  vpathLimiter.delete(scanObj.vpath);
  if (forkedScan._killFn) { removeFromKillQueue(forkedScan._killFn); }

  // Clean up progress row (scanner should have deleted it, but handle crashes)
  try {
    db.getDB()?.prepare('DELETE FROM scan_progress WHERE scan_id = ?').run(scanObj.id);
  } catch (_) {}

  // Notify the backup module so it can enqueue any 'after-scan'
  // destinations for this library. Routed through a callback rather
  // than a direct import to keep task-queue.js free of a backup-module
  // dependency (otherwise we'd have a load-time cycle: backup-manager
  // imports task-queue to call addBackupTask). Wrapped because we're
  // inside a child-process close handler — don't let a backup-config
  // glitch break scan-task accounting.
  if (onScanCompleteCallback) {
    try { onScanCompleteCallback(scanObj); }
    catch (err) { winston.error(`onScanCompleteCallback failed for vpath ${scanObj.vpath}`, { stack: err }); }
  }

  nextTask();
  checkQueueDrainedSideEffects();
}

function launchJsScanner(scanObj, jsonLoad, library, { isFallback = false } = {}) {
  const forkedScan = child.fork(path.join(__dirname, './scanner.mjs'), [JSON.stringify(jsonLoad)], { silent: true });
  winston.info(`File scan started${isFallback ? ' (JS fallback)' : ''} on ${library.root_path}`);
  attachScanHandlers(forkedScan, scanObj);
  forkedScan.on('close', (code) => onScanClose(forkedScan, scanObj, code));
  return forkedScan;
}

function runScan(scanObj) {
  const library = db.getLibraryByName(scanObj.vpath);
  if (!library) {
    winston.warn(`Library '${scanObj.vpath}' not found in database, skipping scan`);
    return;
  }

  const dbPath = path.join(config.program.storage.dbDirectory, 'mstream.db');

  const jsonLoad = {
    dbPath: dbPath,
    libraryId: library.id,
    vpath: scanObj.vpath,
    directory: library.root_path,
    skipImg: config.program.scanOptions.skipImg,
    albumArtDirectory: config.program.storage.albumArtDirectory,
    scanId: scanObj.id,
    compressImage: config.program.scanOptions.compressImage,
    supportedFiles: config.program.supportedAudioFiles,
    scanCommitInterval: config.program.scanOptions.scanCommitInterval || 25,
    // Pass through unconditionally — Rust binary treats 0 as "auto"
    // and resolves to half the available CPU cores. The JS fallback
    // scanner ignores this field. See scanThreads in src/state/config.js
    // for the rationale on the half-cores default.
    scanThreads: config.program.scanOptions.scanThreads || 0,
    forceRescan: scanObj.forceRescan || false,
    // Per-library followSymlinks flag (V21). Pulled straight from
    // the libraries row — toggling it in the admin panel takes
    // effect on the next scan of this vpath without the scanner
    // needing to know anything about the admin UI.
    followSymlinks: library.follow_symlinks === 1,
    // The Rust scanner generates waveform .bin files inline via symphonia
    // and writes them here (keyed by audio_hash, falling back to file_hash).
    // The JS fallback scanner doesn't generate waveforms — for those users,
    // the on-demand GET /api/v1/db/waveform endpoint produces them lazily
    // via ffmpeg on first playback.
    //
    // generateWaveforms=false → send an empty cache dir; the Rust scanner
    // treats that as "skip waveform decode entirely". The on-demand
    // endpoint still works — it'll regenerate via ffmpeg on first
    // playback — but you save the ~90% of scan wall-time symphonia
    // would otherwise burn here.
    waveformCacheDir: config.program.scanOptions.generateWaveforms === false
      ? ''
      : config.program.storage.waveformCacheDirectory,
  };

  if (!findRustParser()) {
    launchJsScanner(scanObj, jsonLoad, library);
    return;
  }

  const rustScan = child.spawn(rustParserBin, [JSON.stringify(jsonLoad)], { stdio: ['ignore', 'pipe', 'pipe'] });
  winston.info(`File scan started (Rust) on ${library.root_path}`);

  let fellBack = false;
  rustScan.on('error', (err) => {
    if (fellBack) { return; }
    fellBack = true;
    winston.warn(`Rust parser failed to start (${err.code || 'ERR'}), falling back to JS scanner: ${err.message}`);
    // Permission / ABI / exec errors don't resolve themselves — disable Rust
    // for the rest of this process lifetime so we don't retry every scan.
    rustParserDisabled = true;
    // Undo the bookkeeping attachScanHandlers did when we (synchronously)
    // wired up the rust child below. Without the decrement here, the JS
    // fallback's attachScanHandlers increments the counter a SECOND time,
    // and only one of the two ever decrements (the rust 'close' handler
    // is gated by fellBack), leaving runningCategories.scan permanently
    // off-by-one — which then blocks every future backup.
    runningTasks.delete(rustScan);
    runningCategories.scan = Math.max(0, runningCategories.scan - 1);
    if (rustScan._killFn) { removeFromKillQueue(rustScan._killFn); }
    launchJsScanner(scanObj, jsonLoad, library, { isFallback: true });
  });

  attachScanHandlers(rustScan, scanObj);
  rustScan.on('close', (code) => {
    if (fellBack) { return; }
    onScanClose(rustScan, scanObj, code);
  });
}

// ── Backup task management ──────────────────────────────────────────────────
//
// Backup execution lives here (rather than in backup/manager.js) so the
// scan/backup mutex can be enforced by a single queue instead of two
// modules coordinating. The manager keeps the user-facing concerns —
// schedule timer, trash sweep, dedup check, history-row lifecycle — and
// just calls addBackupTask() to actually run.

const BACKUP_WORKER_PATH = path.join(__dirname, '../backup/worker.mjs');

// Enqueue a backup for a destination, deferring to the manager-level
// dedup if one's already queued/active. Returns:
//   true  — queued (or running, if mutex allowed it to start immediately)
//   false — dropped because of dedup
// The caller is responsible for any 'skipped' history-row bookkeeping.
export function addBackupTask(destinationId, triggerReason) {
  if (isBackupQueuedOrActive(destinationId)) { return false; }
  taskQueue.push({ task: 'backup', destinationId, triggerReason, id: nanoid(8) });
  nextTask();
  return true;
}

export function isBackupQueuedOrActive(destinationId) {
  if (activeBackupRun && activeBackupRun.destinationId === destinationId) { return true; }
  return taskQueue.some((t) => t.task === 'backup' && t.destinationId === destinationId);
}

export function getActiveBackupRun() {
  if (!activeBackupRun) { return null; }
  return { ...activeBackupRun };
}

export function getQueueLength() {
  return taskQueue.length;
}

function runBackupTask(taskObj) {
  const dest = db.getBackupDestinationById(taskObj.destinationId);
  if (!dest) {
    // Race: destination was deleted between enqueue and start. Drop the
    // task; cascades from DELETE backup_destinations already removed any
    // history rows we'd otherwise want to update.
    // (No explicit nextTask() — the outer nextTask() that called us
    // recurses immediately after this returns and will pick up the
    // next runnable task.)
    winston.warn(`Backup task for missing destination id=${taskObj.destinationId} skipped`);
    return;
  }
  if (!dest.enabled) {
    // Destination was disabled after this task was queued (e.g. user
    // toggled the switch during a long-running scan). Honour the toggle
    // — record a 'failed' row with a descriptive message so the user
    // sees that the trigger fired but produced no work, then drop.
    db.createBackupRunRow({
      destinationId: taskObj.destinationId,
      triggerReason: taskObj.triggerReason,
      status: 'failed',
      errorMessage: 'destination disabled before run could start',
    });
    winston.info(`Backup: dest #${taskObj.destinationId} disabled before run could start; skipping`);
    return;
  }

  const historyId = db.createBackupRunRow({
    destinationId: taskObj.destinationId,
    triggerReason: taskObj.triggerReason,
    status: 'running',
  });

  const jsonLoad = {
    sourcePath: dest.library_root_path,
    destPath: dest.dest_path,
    retentionDays: dest.retention_days,
    followSymlinks: dest.follow_symlinks === 1,
    // Resolve NULL → DEFAULT_BACKUP_EXCLUDE_GLOBS here so the worker
    // doesn't need to know about defaults. The worker just gets a
    // concrete array of glob strings and applies them as filters.
    excludeGlobs: db.getEffectiveExcludeGlobs(dest),
    // Inter-file throttle (ms). 0 = no throttle. Worker sleeps this
    // long after each file with bytes actually written.
    interFileDelayMs: dest.inter_file_delay_ms || 0,
  };

  const forked = child.fork(BACKUP_WORKER_PATH, [JSON.stringify(jsonLoad)], { silent: true });
  winston.info(`Backup: started run #${historyId} for ${dest.dest_path} (trigger=${taskObj.triggerReason})`);

  const observers = attachBackupHandlers(forked, historyId);
  // Single-active-backup state for getActiveBackupRun() (the API status
  // endpoint and the dedup check both read this). Cleared in onBackupClose.
  activeBackupRun = { destinationId: taskObj.destinationId, historyId };

  // Guard against the 'close' / 'error' double-fire (or missing-close)
  // edge cases. Node's child_process spec says 'error' fires when the
  // process can't be spawned/killed/messaged, and 'close' MAY fire
  // afterward — but isn't guaranteed across versions. If we relied on
  // 'close' alone, a fork that fails outright (worker path missing,
  // ENOMEM, exec policy denied) would leak runningCategories.backup,
  // runningTasks membership, and activeBackupRun, blocking all future
  // backups under the mutex. The latched flag keeps the close path
  // idempotent so we can call it from both events safely.
  let closed = false;
  const close = (code) => {
    if (closed) { return; }
    closed = true;
    onBackupClose(forked, taskObj, historyId, code, observers);
  };
  forked.on('close', close);
  forked.on('error', (err) => {
    winston.error(`Backup: worker fork error for run #${historyId}: ${err.message}`);
    // Synthesize a non-zero "exit code" so onBackupClose marks the run
    // 'failed' with a clear error_message — same shape as a worker
    // that exited 1 on its own.
    if (!observers.fatalError) { observers.fatalError = `Worker spawn error: ${err.message}`; }
    close(-1);
  });
}

// Wire kill-queue + bookkeeping + line buffering for a backup worker.
// Mirrors attachScanHandlers on the scan side — both functions do the
// "make this child process trackable and pipe its output through our
// log/event machinery" job for their respective workers.
//
// Returns an `observers` object the close handler reads to decide the
// final history-row status: { lastEvent, fatalError }. It's mutated in
// place by stdout line handling — Node's event emitter contract gives
// us no other way to thread state from the data handler into the close
// handler short of module-level state, which we already have plenty of.
function attachBackupHandlers(forked, historyId) {
  runningTasks.add(forked);
  runningCategories.backup++;

  const killFn = () => { try { forked.kill(); } catch (_) {} };
  forked._killFn = killFn;
  addToKillQueue(killFn);

  const observers = { lastEvent: null, fatalError: null };

  // stdout: JSON events from the worker (progress, done, error). The
  // 'progress'/'done' events incrementally update the live history row;
  // 'error' captures a fatal-error message we hand to the close handler.
  bufferLines(forked.stdout, (line) => {
    handleBackupLine(historyId, line, (evt) => {
      observers.lastEvent = evt;
      if (evt.event === 'error') { observers.fatalError = evt.message; }
    });
  });

  // stderr: per-file warnings (recordFileError on the worker side writes
  // "Warning: ..." here). Logged at warn level so a permission glitch on
  // one track doesn't drown legitimate errors at error level.
  bufferLines(forked.stderr, (line) => {
    if (!line) { return; }
    winston.warn(`Backup #${historyId}: ${line}`);
  });

  return observers;
}

function handleBackupLine(historyId, line, observe) {
  if (!line) { return; }
  if (line[0] !== '{') {
    winston.warn(`Backup #${historyId}: unexpected stdout: ${line}`);
    return;
  }
  let evt;
  try { evt = JSON.parse(line); } catch (_) {
    winston.warn(`Backup #${historyId}: malformed event line: ${line}`);
    return;
  }
  observe(evt);
  if (evt.event === 'progress' || evt.event === 'done') {
    try { db.updateBackupRunProgress(historyId, evt); }
    catch (err) { winston.warn(`Backup #${historyId}: failed to update progress`, { stack: err }); }
  }
}

function onBackupClose(forked, taskObj, historyId, code, { lastEvent, fatalError }) {
  runningTasks.delete(forked);
  runningCategories.backup = Math.max(0, runningCategories.backup - 1);
  activeBackupRun = null;
  if (forked._killFn) { removeFromKillQueue(forked._killFn); }

  // Decide final status. Three cases:
  //   1. Worker emitted {event:'error'} and exited 1 → 'failed'
  //   2. Worker exited non-zero without an error event   → 'failed'
  //      (covers crashes, OOM, killed by signal — including server
  //      shutdown via the kill list)
  //   3. Worker exited 0                                 → 'success',
  //      annotated with file-error count if any per-file errors hit
  let status = 'success';
  let errorMessage = null;
  if (fatalError) {
    status = 'failed';
    errorMessage = fatalError;
  } else if (code !== 0) {
    status = 'failed';
    errorMessage = `Worker exited with code ${code}`;
  } else if (lastEvent?.event === 'done' && lastEvent.fileErrors > 0) {
    const sample = lastEvent.sampleErrorMessage ? `; example: ${lastEvent.sampleErrorMessage}` : '';
    errorMessage = `${lastEvent.fileErrors} file error(s)${sample}`;
  }

  try { db.finishBackupRunRow(historyId, { status, errorMessage }); }
  catch (err) { winston.error(`Backup: failed to finalise history row ${historyId}`, { stack: err }); }

  const dest = db.getBackupDestinationById(taskObj.destinationId);
  const destLabel = dest ? dest.dest_path : `dest #${taskObj.destinationId}`;
  winston.info(`Backup: run #${historyId} finished (${status}) for ${destLabel}`);

  nextTask();
  checkQueueDrainedSideEffects();
}

// ── Public API ──────────────────────────────────────────────────────────────

export function scanVPath(vPath) {
  addScanTask(vPath);
}

export { scanAll, rescanAll };

// "Is the system currently doing heavy disk work?" Used by API endpoints
// (api/db.js, api/subsonic/handlers.js) to mark themselves "locked" so
// long-running write paths don't conflict with an in-flight scan or
// backup. Post-mutex this returns true for EITHER kind of task — the
// callers care about the broader "busy" semantic, not strictly scans,
// and the function name is preserved for back-compat with existing
// JSON response shapes that key off it.
export function isScanning() {
  return runningTasks.size > 0;
}

// Snapshot of the queue + vpath limiter. Returns DEFENSIVE COPIES so
// admin-API consumers can't mutate task-queue's internal state
// (otherwise callers like the admin dashboard could pop tasks out of
// the live queue or splice into vpathLimiter and silently break
// concurrency).
export function getAdminStats() {
  return {
    taskQueue: taskQueue.map((t) => ({ ...t })),
    vpaths: [...vpathLimiter],
  };
}

export function runAfterBoot() {
  // Clear any stale scan progress rows left from a previous crash
  try { db.getDB()?.prepare('DELETE FROM scan_progress').run(); } catch (_) {}

  // Check if a migration flagged a force rescan. We DO NOT unlink the
  // marker here — it stays on disk until onScanClose sees the queue
  // drain. If the process crashes during the rescan, the marker
  // survives and the next boot re-triggers the rescan automatically.
  const markerPath = path.join(config.program.storage.dbDirectory, '.rescan-pending');
  let pendingRescan = false;
  try {
    if (fs.existsSync(markerPath)) {
      pendingRescan = true;
      bootRescanInFlight = true;
      bootRescanMarkerPath = markerPath;
      winston.info('Force rescan pending from migration — will rescan all libraries');
    }
  } catch (_) {}

  setTimeout(() => {
    if (pendingRescan) {
      // Migration requires full rescan — force re-parse all files
      rescanAll();
    } else if (config.program.scanOptions.scanInterval > 0 && scanIntervalTimer === null) {
      scanAll();
    }
    if (config.program.scanOptions.scanInterval > 0 && scanIntervalTimer === null) {
      scanIntervalTimer = setInterval(() => scanAll(), config.program.scanOptions.scanInterval * 60 * 60 * 1000);
    }
  }, config.program.scanOptions.bootScanDelay * 1000);
}

export function resetScanInterval() {
  if (scanIntervalTimer) { clearInterval(scanIntervalTimer); }
  if (config.program.scanOptions.scanInterval > 0) {
    scanIntervalTimer = setInterval(() => scanAll(), config.program.scanOptions.scanInterval * 60 * 60 * 1000);
  }
}
