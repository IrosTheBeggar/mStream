import child from 'child_process';
import fs from 'fs';
import path from 'path';
import winston from 'winston';
import { nanoid } from 'nanoid';
import * as config from '../state/config.js';
import * as db from './manager.js';
import { addToKillQueue, removeFromKillQueue } from '../state/kill-list.js';
import { writeScannerPidfile, clearScannerPidfile } from './scan-pidfile.js';
import { SCHEMA_VERSION } from './schema.js';
import { getDirname } from '../util/esm-helpers.js';
import * as dlnaApi from '../api/dlna.js';

const __dirname = getDirname(import.meta.url);

// ── Unified task queue ──────────────────────────────────────────────────────
//
// One queue, three task shapes:
//   { task: 'scan',     vpath, id, forceRescan }
//   { task: 'backup',   destinationId, triggerReason, id }
//   { task: 'waveform', id }   — post-scan enrichment pass (whole-DB)
//
// STRICTLY SERIAL: at most one task — scan or backup, doesn't matter which —
// runs at any time. We tried allowing concurrent scans of different vpaths
// (gated by a per-host scanOptions.maxConcurrentTasks knob) and it was a
// reliable lock-storm generator: the SQLite writer is single-threaded with
// a busy_timeout, multiple scan workers all want the writer at once, and
// the loser stalls until busy_timeout expires (5s) before retrying — and
// often loses again. Result: scans took 5–10× longer than running them in
// sequence and produced spurious "database is locked" errors in the logs.
// Removing the knob entirely (and the supporting category/vpath
// bookkeeping) is simpler, faster on real workloads, and removes a foot-gun
// that no operator was asking us to keep.
//
// Same-class serialisation is also why backups can't run during scans
// (and vice versa): both classes hammer the music library's I/O
// bandwidth (scan reads metadata + writes db rows; backup reads source
// + writes dest) and degrade each other badly if interleaved.
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
// In-flight tracking is one object — `activeTask` — which holds whatever
// scan or backup is currently running, or null when nothing is. Every
// "is X queued or active?" check reads from `activeTask` plus `taskQueue`.
// One owner, one source of truth — no off-by-one counter bugs to chase.
const taskQueue = [];

// The single in-flight task, or null when idle. Shape:
//   { kind: 'scan',   taskObj, child, killFn }
//   { kind: 'backup', taskObj, child, killFn, historyId, observers }
// kind is denormalised from taskObj.task so callers reading just the
// active-task summary don't have to inspect the inner object.
let activeTask = null;

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
// and the resulting rescan draining the queue. The marker is only
// unlinked once this flag is set AND the queue empties — if the process
// is restarted partway through the rescan, the marker survives and the
// next boot RESUMES it. Without this, an interrupted boot rescan left
// the DB stuck on pre-rescan row shapes (e.g. V18 compilations still
// fragmented) with no surfacing signal.
let bootRescanInFlight = false;
let bootRescanMarkerPath = null;
// Stable scan id for the in-flight migration-rescan epoch, read from (or
// assigned into) the .rescan-pending marker. Reusing one id across
// restarts is what makes the rescan RESUMABLE: the scanner skips any row
// already stamped with this id (re-parsed in an earlier pass of the same
// epoch) instead of re-parsing the whole library from file zero every
// boot. See resolveRescanEpochId() and runAfterBoot().
let bootRescanScanId = null;
// Set true when any scan in the current boot-rescan epoch finishes
// unsuccessfully (non-zero exit / never emitted scanComplete). The marker
// is cleared only when the epoch drains WITHOUT a failure — otherwise it
// survives so the next boot resumes (cheaply, skipping already-stamped
// rows) rather than the migration being silently abandoned. Reset
// alongside bootRescanInFlight on drain.
let bootRescanFailed = false;

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
  // Defensive: child-process pipes can emit 'error' (broken pipe, EIO
  // from a force-killed child, etc.). Without a listener Node treats
  // it as an unhandled error and tears the parent process down. The
  // child's 'close' handler will still fire for cleanup; the buffered
  // stdio lines we never got to read were lost either way.
  stream.on('error', (err) => {
    winston.warn(`bufferLines: stream error: ${err.message}`);
  });
}

// ── Dispatch ────────────────────────────────────────────────────────────────

// Pop the next task off the queue and run it, if anything's runnable.
// Single rule: nothing starts while activeTask is non-null. See the
// header comment for why concurrent execution was removed.
//
// Loop only because a task can SYNCHRONOUSLY no-op (e.g. runBackupTask
// returns early when its destination was deleted between enqueue and
// start). Such no-ops don't claim activeTask, so the next queued task
// is now eligible — keep going until either something actually claims
// the slot, or the queue is empty.
function nextTask() {
  while (activeTask === null && taskQueue.length > 0) {
    const candidate = taskQueue.shift();
    if (candidate.task === 'scan')          { runScan(candidate); }
    else if (candidate.task === 'backup')   { runBackupTask(candidate); }
    else if (candidate.task === 'waveform') { runWaveformTask(candidate); }
  }
}

// Drained-queue side effects shared by onScanClose + onBackupClose.
// Centralised here because the DLNA bump and the migration-rescan marker
// cleanup both depend on "all queued and active work finished," which can
// be triggered by either kind of close after the unified-queue change.
function checkQueueDrainedSideEffects() {
  // The waveform enrichment pass doesn't count against "drained": both
  // side effects below are about the SCAN batch — the pass changes no
  // library content (DLNA caches have nothing new to refresh) and is
  // not part of any migration epoch (the marker must not wait minutes
  // for background decode to finish before clearing).
  const drained =
    (activeTask === null || activeTask.kind === 'waveform') &&
    !taskQueue.some((t) => t.task !== 'waveform');
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
  // including any backup that piled in behind the scans — has finished,
  // AND only if the rescan actually completed. If any boot-rescan scan
  // failed (non-zero exit / no scanComplete), keep the marker so the next
  // boot RESUMES it — cheap, because already-stamped rows are skipped.
  // (Previously the marker cleared on drain regardless of success, so a
  // fatal scanner error silently abandoned the migration with no retry.)
  // A process crash before this point likewise leaves the marker in place.
  if (bootRescanInFlight) {
    const failed = bootRescanFailed;
    bootRescanInFlight = false;
    bootRescanFailed = false;
    if (failed) {
      winston.warn('Migration rescan did not fully complete (a library scan failed or was '
        + 'interrupted) — keeping .rescan-pending; the next boot will resume it.');
    } else if (bootRescanMarkerPath) {
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

// scanId: optional fixed scan id. The boot migration rescan passes the
// stable epoch id from the .rescan-pending marker so a restart REUSES it
// and the scanner can skip rows it already re-parsed this epoch (resume).
// Omitted everywhere else → a fresh per-scan nanoid (every other scan is
// independent and gets its own id).
function addScanTask(vpath, forceRescan = false, scanId = null) {
  // Dedup: drop if a scan for this vpath is already running, and merge
  // forceRescan upgrade into a queued one. Without this, a scan that
  // outlasts scanInterval (24h default) lets the periodic timer pile up
  // a fresh full-library scan request for every missed cycle, and we'd
  // re-walk the library N times for nothing once the original finished.
  if (activeTask?.kind === 'scan' && activeTask.taskObj.vpath === vpath) {
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
  taskQueue.push({ task: 'scan', vpath, id: scanId || nanoid(8), forceRescan });
  nextTask();
}

// Targeted subtree scan. Used by the torrent completion-watcher to
// refresh only the directory where a torrent just finished, avoiding a
// full vpath walk per add. Distinct from addScanTask because it dedups
// on (vpath, subtree) instead of vpath — two completions in different
// subtrees of the same library should NOT be merged into one wider scan.
//
// If a whole-vpath scan is already queued or running for this vpath,
// the subtree request is dropped (the broader scan will cover the
// subtree's files anyway).
function addSubtreeScanTask(vpath, subtree) {
  if (typeof subtree !== 'string' || subtree.trim() === '') {
    winston.warn(`addSubtreeScanTask: empty subtree for vpath '${vpath}', falling back to full vpath scan`);
    return addScanTask(vpath);
  }
  const sub = subtree.replace(/^[/\\]+|[/\\]+$/g, '');
  // If a whole-vpath scan is in flight or queued for this vpath, the
  // subtree's files will be covered by it. Drop the targeted request.
  if (activeTask?.kind === 'scan' && activeTask.taskObj.vpath === vpath && !activeTask.taskObj.subtree) {
    winston.info(`Subtree scan for '${vpath}/${sub}' dropped — full scan already running`);
    return;
  }
  const queuedFull = taskQueue.find((t) => t.task === 'scan' && t.vpath === vpath && !t.subtree);
  if (queuedFull) {
    winston.info(`Subtree scan for '${vpath}/${sub}' dropped — full scan already queued`);
    return;
  }
  const dupSubtree = taskQueue.find((t) => t.task === 'scan' && t.vpath === vpath && t.subtree === sub);
  if (dupSubtree) {
    winston.info(`Subtree scan for '${vpath}/${sub}' dropped — same subtree already queued`);
    return;
  }
  taskQueue.push({ task: 'scan', vpath, subtree: sub, id: nanoid(8), forceRescan: false });
  winston.info(`Queued subtree scan: ${vpath}/${sub}`);
  nextTask();
}

function scanAll() {
  const libraries = db.getAllLibraries();
  for (const lib of libraries) {
    addScanTask(lib.name);
  }
}

// scanId: when set (boot migration rescan), every library shares this
// stable id so an interrupted rescan resumes on the next boot instead of
// restarting from file zero. When omitted (manual admin force-rescan),
// each library gets a fresh id — a one-shot full re-parse, as before.
function rescanAll(scanId = null) {
  const libraries = db.getAllLibraries();
  for (const lib of libraries) {
    addScanTask(lib.name, true, scanId);
  }
}

function handleScannerLine(scanObj, line) {
  if (!line) { return; }
  // Any stdout at all proves the binary launched and ran real code —
  // read by the rust close handler to tell "scanned and failed" from
  // "died on arrival" (dynamic-linker abort, stale arg format, instant
  // panic), which is the case that warrants the JS fallback.
  scanObj.sawOutput = true;
  // Structured events from the scanner are emitted as single-line JSON;
  // see scanner.mjs and rust-parser/src/main.rs for the event shapes.
  if (line[0] === '{') {
    try {
      const evt = JSON.parse(line);
      if (evt?.event === 'scanStart') {
        // Liveness banner — the rust binary's first stdout line, emitted
        // before any environment-dependent work. Its only job is setting
        // sawOutput (above) so died-on-arrival detection can't misfire on
        // pre-walk environment failures. Nothing to log.
        return;
      }
      if (evt?.event === 'scanComplete') {
        // A clean end-of-scan event means the scanner finished its walk
        // (vs. dying mid-way). onScanClose reads this to tell a completed
        // boot-rescan from a failed one before clearing the marker.
        scanObj.completed = true;
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
        if (evt.walkErrors > 0) {
          // Cleanup was partially shielded — deleted files under the
          // affected subtrees stay in the index until a clean scan.
          // Surface it at warn level so a permanently unreadable
          // directory doesn't hide behind healthy-looking summaries.
          winston.warn(
            `Scan saw ${evt.walkErrors} directory enumeration error(s) — ` +
            'rows under the affected subtrees were shielded from cleanup');
        }
        if (evt.filesProcessed > 0 || evt.staleEntriesRemoved > 0) {
          anyScansChanged = true;
          // Per-scan flag, read in onScanClose to decide whether to run
          // the FTS5 segment merge. A scheduled no-op scan (library on
          // disk hasn't changed since last scan) produces no writes, so
          // no new FTS segments accumulate and 'optimize' would be a
          // pure no-op. Skipping it saves the prepare + roundtrip per
          // scheduled tick on quiet libraries.
          scanObj.hadChanges = true;
        }
        return;
      }
    } catch (_) { /* not a structured event — fall through and log as plain text */ }
  }
  winston.info(line);
}

function attachScanHandlers(forkedScan, scanObj) {
  // Ensure scanner is killed on server shutdown; keep a handle so we can
  // drop the entry from the kill queue when the process exits cleanly —
  // otherwise the queue would grow unbounded across scheduled scans.
  const killFn = () => { try { forkedScan.kill(); } catch (_) {} };
  addToKillQueue(killFn);

  // Claim the single in-flight slot. The kill function rides along so
  // the close handler can pull it back off the kill queue without us
  // tagging the child handle directly.
  activeTask = { kind: 'scan', taskObj: scanObj, child: forkedScan, killFn };

  // stdout: structured JSON events + any free-text log lines. handleScannerLine
  // figures out which is which. We close over scanObj so the handler can set
  // per-scan flags (e.g. hadChanges, read by onScanClose).
  bufferLines(forkedScan.stdout, line => handleScannerLine(scanObj, line));

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
  if (code === 0) {
    winston.info(`File scan completed with code ${code}`);
  } else {
    // A non-zero exit is a FAILED scan (schema-version guard, vanished
    // mount, crash) — surface it at error level instead of burying it in
    // INFO logs where a permanently broken scanner looks healthy.
    winston.error(
      `File scan FAILED with exit code ${code} for vpath '${scanObj.vpath}' — ` +
      'see preceding scanner output; the library index may be stale');
  }
  // The child is gone either way — its pidfile record is no longer an
  // orphan candidate for the next boot's reaper.
  clearScannerPidfile(config.program.storage.dbDirectory);
  if (activeTask?.child === forkedScan) {
    removeFromKillQueue(activeTask.killFn);
    activeTask = null;
  }

  // Clean up progress row (scanner should have deleted it, but handle crashes)
  try {
    db.getDB()?.prepare('DELETE FROM scan_progress WHERE scan_id = ?').run(scanObj.id);
  } catch (_) {}

  // Merge FTS5 segments accumulated by this scan's writes. The triggers
  // create a fresh index segment per track-row write — over a long scan
  // these pile up and slow MATCH queries until the next merge runs on
  // its own. 'optimize' merges everything into a single segment;
  // typically <100ms on a 100k-row index.
  //
  // Gate on scanObj.hadChanges (set by handleScannerLine from the
  // scanComplete event): a no-op scan — scheduled rescan against a
  // library whose on-disk state hasn't drifted — writes zero rows, so
  // no new FTS segments accumulate and optimize would be a pure no-op
  // round-trip. Skipping it saves a prepare + SQLite call per
  // scheduled tick on quiet libraries.
  //
  // If hadChanges was never set (e.g. scanner crashed before emitting
  // scanComplete, or a stale prebuilt binary that doesn't emit the
  // field), we err on the side of skipping. The next productive scan
  // will trigger the merge, and FTS5 self-optimizes lazily during MATCH
  // queries anyway — worst case is slightly more segments until then.
  //
  // optimizeFts() handles its own errors; let unexpected failures propagate
  // so they surface in the scan task's error path rather than getting
  // silently logged at warn level.
  if (scanObj.hadChanges) {
    db.optimizeFts();
  }

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

  // A boot-rescan scan is the one sharing the stable epoch id. If it
  // exited non-zero or never emitted scanComplete, the migration rescan
  // didn't finish — flag it so checkQueueDrainedSideEffects keeps the
  // marker for the next boot to resume instead of clearing it.
  if (bootRescanInFlight && scanObj.id === bootRescanScanId && (code !== 0 || !scanObj.completed)) {
    bootRescanFailed = true;
  }

  // Chain the waveform enrichment pass behind successful scans. Queued
  // rather than run inline so it obeys the single-task rule, and dedup'd
  // so a multi-library scanAll yields ONE pass after the last scan, not
  // one per library (the pass sweeps the whole DB when it runs). Enqueued
  // even for no-change scans: on the first boot after waveform generation
  // moved out of the scanner, the library is fully scanned but has no
  // .bins yet — the pass is near-free when there's nothing to do.
  if (code === 0 && scanObj.completed) {
    addWaveformTask();
  }

  nextTask();
  checkQueueDrainedSideEffects();
}

// ── Waveform enrichment task ────────────────────────────────────────────────
//
// Runs the rust binary's `--waveform-scan` pass: a READ-ONLY sweep that
// generates the 800-bar .bin for every track that lacks one (writing a
// `<hash>.failed` marker for undecodable files so they aren't retried
// every pass), then exits. Waveform decode left the scan itself in this
// release — the scan finishes at tag-parse speed and this pass fills in
// the visuals behind it, never touching (or even queueing for) the DB
// writer lock.
//
// There is deliberately NO JS fallback here: without a usable rust
// binary the on-demand GET /api/v1/db/waveform endpoint still generates
// waveforms lazily via ffmpeg on first play, which is exactly the
// pre-rust behaviour.

// Latched when the binary provably pre-dates the --waveform-scan
// subcommand (exits non-zero having printed NOTHING — the current
// binary's first statement is the waveformScanStart banner). A stale
// binary doesn't heal between scans; without the latch every scan batch
// would log the same failure forever. Inline scan-time waveforms keep
// working on such a binary, so nothing is actually lost.
let waveformPassUnsupported = false;

export function addWaveformTask() {
  if (config.program.scanOptions.generateWaveforms === false) { return; }
  if (waveformPassUnsupported) { return; }
  // One queued pass is enough — it sweeps the whole DB when it runs.
  if (taskQueue.some((t) => t.task === 'waveform')) { return; }
  taskQueue.push({ task: 'waveform', id: nanoid(8) });
  nextTask();
}

function runWaveformTask(taskObj) {
  // Re-check at run time: the admin toggle may have flipped while this
  // sat queued, and findRustParser() stays false for the process
  // lifetime once the binary was found dead.
  if (config.program.scanOptions.generateWaveforms === false) { return; }
  if (!findRustParser()) {
    winston.info(
      'Waveform pass skipped — no usable rust-parser binary (the on-demand ' +
      'endpoint will generate waveforms lazily on first play)');
    return;
  }

  const payload = {
    dbPath: path.join(config.program.storage.dbDirectory, 'mstream.db'),
    cacheDir: config.program.storage.waveformCacheDirectory,
    expectedSchemaVersion: SCHEMA_VERSION,
    scanThreads: config.program.scanOptions.scanThreads || 0,
  };

  const wfChild = child.spawn(rustParserBin, ['--waveform-scan', JSON.stringify(payload)],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  winston.info('Waveform pass started');
  // Same boot-reaper contract as scans: record the child so an orphan
  // from a hard server kill gets cleaned up on the next boot.
  if (Number.isInteger(wfChild.pid)) {
    writeScannerPidfile(config.program.storage.dbDirectory, wfChild.pid, rustParserBin, 'waveform');
  }

  const killFn = () => { try { wfChild.kill(); } catch (_) { /* already gone */ } };
  addToKillQueue(killFn);
  activeTask = { kind: 'waveform', taskObj, child: wfChild, killFn };

  // Any stdout proves the binary knows the subcommand — the banner is
  // its first statement, printed before config parsing. Read by
  // closeOnce to tell "ran and failed" from "pre-dates --waveform-scan".
  let sawOutput = false;
  bufferLines(wfChild.stdout, (line) => {
    if (!line) { return; }
    sawOutput = true;
    if (line[0] === '{') {
      try {
        const evt = JSON.parse(line);
        if (evt?.event === 'waveformScanStart') { return; }     // liveness banner
        if (evt?.event === 'waveformScanProgress') { return; }  // too chatty for info
        if (evt?.event === 'waveformScanPlan') {
          if (evt.total > 0) {
            winston.info(`Waveform pass: ${evt.total} track(s) need waveforms`);
          }
          return;
        }
        if (evt?.event === 'waveformScanComplete') {
          winston.info(
            `Waveform pass complete: ${evt.generated} generated, ` +
            `${evt.failed} failed (${evt.total} planned)`);
          return;
        }
      } catch (_) { /* not a structured event — log as plain text */ }
    }
    winston.info(line);
  });
  bufferLines(wfChild.stderr, (line) => {
    if (!line) { return; }
    if (line.startsWith('Warning:')) { winston.warn(`Waveform pass: ${line}`); }
    else { winston.error(`Waveform pass error: ${line}`); }
  });

  let closed = false;
  const closeOnce = (code, signal) => {
    if (closed) { return; }
    closed = true;
    if (signal) {
      // Deliberate kill (server shutdown via the kill queue, operator) —
      // expected lifecycle, not a failure.
      winston.info(`Waveform pass terminated by ${signal}`);
    } else if (code !== 0 && !sawOutput) {
      // Zero stdout means the binary never even printed its banner: it
      // pre-dates the --waveform-scan subcommand (a stale prebuilt in
      // the window before CI rebuilds). Such a binary still generates
      // waveforms INLINE during its scans, so nothing is lost — say so
      // once and stop re-trying every scan batch.
      waveformPassUnsupported = true;
      winston.warn(
        'rust-parser pre-dates the --waveform-scan subcommand — skipping the ' +
        'post-scan waveform pass until the binary updates (scan-time waveform ' +
        'generation remains active on this binary)');
    } else if (code !== 0) {
      // Non-fatal for the server: waveforms stay lazy (on-demand
      // endpoint). Error level so a chronically failing pass is visible.
      winston.error(`Waveform pass FAILED with exit code ${code}`);
    }
    clearScannerPidfile(config.program.storage.dbDirectory);
    if (activeTask?.child === wfChild) {
      removeFromKillQueue(activeTask.killFn);
      activeTask = null;
    }
    nextTask();
    checkQueueDrainedSideEffects();
  };
  wfChild.on('error', (err) => {
    winston.error(`Waveform pass failed to start: ${err.message}`);
    closeOnce(-1, null);
  });
  wfChild.on('close', (code, signal) => closeOnce(code, signal));
}

function launchJsScanner(scanObj, jsonLoad, library, { isFallback = false } = {}) {
  const forkedScan = child.fork(path.join(__dirname, './scanner.mjs'), [JSON.stringify(jsonLoad)], { silent: true });
  winston.info(`File scan started${isFallback ? ' (JS fallback)' : ''} on ${library.root_path}`);
  // Record the child for the boot-time orphan reaper (covers shutdown
  // paths where no JS can run — Task Manager kill, SIGKILL). The forked
  // scanner's image is this node executable — far too generic to kill
  // on alone, so the scanner.mjs path rides along as the marker the
  // reaper must find in the live process's command line.
  if (Number.isInteger(forkedScan.pid)) {
    writeScannerPidfile(config.program.storage.dbDirectory, forkedScan.pid,
      process.execPath, 'js', path.join(__dirname, './scanner.mjs'));
  }
  attachScanHandlers(forkedScan, scanObj);
  // Latched close-or-error: a fork that fails to start (ENOMEM, exec
  // policy) emits 'error', and with no listener that is an unhandled
  // EventEmitter error that tears down the whole server — while the
  // activeTask claim and kill-queue entry leak, wedging the serial task
  // queue forever. Route it through onScanClose exactly once (code -1 →
  // error-level FAILED log + normal queue accounting), mirroring the
  // backup worker's guard.
  let scanClosed = false;
  const closeOnce = (code) => {
    if (scanClosed) { return; }
    scanClosed = true;
    onScanClose(forkedScan, scanObj, code);
  };
  forkedScan.on('error', (err) => {
    winston.error(`JS scanner failed to start: ${err.message}`);
    closeOnce(-1);
  });
  forkedScan.on('close', (code) => closeOnce(code));
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
    // The server's current schema version. Both scanners refuse to run
    // against a DB whose PRAGMA user_version differs (half-migrated DB,
    // a second server instance on the same DB file, or a migration racing
    // an orphaned scanner), and re-check before the stale-track sweep —
    // their one destructive phase. Old scanner builds simply ignore the
    // field (neither Joi nor serde rejects unknown/extra config here).
    expectedSchemaVersion: SCHEMA_VERSION,
    compressImage: config.program.scanOptions.compressImage,
    // Which art source wins when a track has both an embedded picture and a
    // folder image. Both scanners honour it — see scanOptions.albumArtPriority.
    albumArtPriority: config.program.scanOptions.albumArtPriority,
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
    // TRANSITION-ONLY fields: current scanners ignore both — waveform
    // generation moved to the post-scan waveform task (runWaveformTask)
    // and BPM analysis left the scanner entirely (it returns as the
    // essentia enrichment scanner). They're still sent so a STALE
    // prebuilt rust binary (pre-split) keeps its old inline behaviour
    // until CI rebuilds — drop both once the fleet has moved.
    waveformCacheDir: config.program.scanOptions.generateWaveforms === false
      ? ''
      : config.program.storage.waveformCacheDirectory,
    analyzeBpm: config.program.scanOptions.analyzeBpm !== false,
    // Subtree mode (V42-adjacent). When non-empty, the scanner walks
    // {root_path}/{subtree} instead of {root_path} and SKIPS the
    // stale-track + orphan cleanup passes (they'd wipe tracks living
    // outside the subtree). Default empty = legacy whole-vpath scan.
    // Used by the torrent completion-watcher to refresh only the
    // directory a torrent landed in instead of waiting for the next
    // full library scan.
    subtree: scanObj.subtree || '',
  };

  if (!findRustParser()) {
    launchJsScanner(scanObj, jsonLoad, library);
    return;
  }

  const rustScan = child.spawn(rustParserBin, [JSON.stringify(jsonLoad)], { stdio: ['ignore', 'pipe', 'pipe'] });
  winston.info(`File scan started (Rust) on ${library.root_path}`);
  // Record the child for the boot-time orphan reaper (see scan-pidfile.js).
  // If this spawn errors and we fall back to JS, launchJsScanner simply
  // overwrites the record with the fork's pid.
  if (Number.isInteger(rustScan.pid)) {
    writeScannerPidfile(config.program.storage.dbDirectory, rustScan.pid, rustParserBin, 'rust');
  }

  let fellBack = false;
  rustScan.on('error', (err) => {
    if (fellBack) { return; }
    fellBack = true;
    winston.warn(`Rust parser failed to start (${err.code || 'ERR'}), falling back to JS scanner: ${err.message}`);
    // Permission / ABI / exec errors don't resolve themselves — disable Rust
    // for the rest of this process lifetime so we don't retry every scan.
    rustParserDisabled = true;
    // Undo the activeTask claim attachScanHandlers made for the rust
    // child so the JS fallback's attachScanHandlers can claim it cleanly.
    // Without this, the second attachScanHandlers would overwrite the
    // claim — which works in steady state, but the rust handle's killFn
    // would still be in the kill queue, leaking entries across scans.
    if (activeTask?.child === rustScan) {
      removeFromKillQueue(activeTask.killFn);
      activeTask = null;
    }
    launchJsScanner(scanObj, jsonLoad, library, { isFallback: true });
  });

  attachScanHandlers(rustScan, scanObj);
  rustScan.on('close', (code, signal) => {
    if (fellBack) { return; }
    // Died-on-arrival fallback: the spawn 'error' event only fires when
    // the OS can't exec the binary at all (ENOENT/EACCES). The far more
    // common real-world breakage — the dynamic linker aborting ("GLIBC
    // not found", exit 127), a stale binary rejecting the arg format, an
    // instant panic — execs fine, prints NOTHING to stdout, and exits
    // non-zero. That used to log "completed with code N" and re-spawn
    // the same dead binary every scheduled scan, leaving the library
    // unindexed forever. Treat "really exited non-zero + zero stdout +
    // never completed" as a launch failure: disable Rust for this
    // process lifetime (a dead binary doesn't heal between scans) and
    // run the JS fallback for this scan.
    //
    // The signature is precise, not inferential:
    //  - the binary prints a {"event":"scanStart"} banner as its FIRST
    //    statement, before any environment-dependent work — so a downed
    //    mount, a busy DB, or a poisoned row (all transient, all stderr-
    //    only) sets sawOutput and can never be mistaken for a dead
    //    binary;
    //  - signal === null excludes kills (shutdown via the kill queue,
    //    OOM, operator) — close reports (null, 'SIGTERM')-style pairs
    //    for those, and spawning a fallback after a deliberate kill
    //    would orphan a scanner the kill queue no longer tracks;
    //  - exit 3 (schema-version guard) is excluded as belt-and-braces:
    //    a deliberate refusal the JS scanner would simply repeat.
    if (signal === null && code !== null && code !== 0 && code !== 3
        && !scanObj.completed && !scanObj.sawOutput) {
      winston.error(
        `Rust parser died on arrival (exit ${code}, no output) — disabling it ` +
        'for this run and falling back to the JS scanner');
      rustParserDisabled = true;
      if (activeTask?.child === rustScan) {
        removeFromKillQueue(activeTask.killFn);
        activeTask = null;
      }
      clearScannerPidfile(config.program.storage.dbDirectory);
      launchJsScanner(scanObj, jsonLoad, library, { isFallback: true });
      return;
    }
    onScanClose(rustScan, scanObj, code);
  });
}

// ── Backup task management ──────────────────────────────────────────────────
//
// Backup execution lives here (rather than in backup/manager.js) so the
// strict-serial mutex can be enforced by a single queue instead of two
// modules coordinating. The manager keeps the user-facing concerns —
// schedule timer, trash sweep, dedup check, history-row lifecycle — and
// just calls addBackupTask() to actually run.

const BACKUP_WORKER_PATH = path.join(__dirname, '../backup/worker.mjs');

// Enqueue a backup for a destination, deferring to the manager-level
// dedup if one's already queued/active. Returns:
//   true  — queued (or running, if the slot was free and it started immediately)
//   false — dropped because of dedup
// The caller is responsible for any 'skipped' history-row bookkeeping.
export function addBackupTask(destinationId, triggerReason) {
  if (isBackupQueuedOrActive(destinationId)) { return false; }
  taskQueue.push({ task: 'backup', destinationId, triggerReason, id: nanoid(8) });
  nextTask();
  return true;
}

export function isBackupQueuedOrActive(destinationId) {
  if (activeTask?.kind === 'backup'
      && activeTask.taskObj.destinationId === destinationId) {
    return true;
  }
  return taskQueue.some((t) => t.task === 'backup' && t.destinationId === destinationId);
}

export function getActiveBackupRun() {
  if (activeTask?.kind !== 'backup') { return null; }
  return {
    destinationId: activeTask.taskObj.destinationId,
    historyId: activeTask.historyId,
  };
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
    // (No explicit nextTask() — the outer nextTask() iterates through
    // the queue in a while loop, so when this returns the next queued
    // task is evaluated automatically. We never claimed activeTask, so
    // the next backup is still allowed to start.)
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

  const observers = attachBackupHandlers(forked, taskObj, historyId);

  // Guard against the 'close' / 'error' double-fire (or missing-close)
  // edge cases. Node's child_process spec says 'error' fires when the
  // process can't be spawned/killed/messaged, and 'close' MAY fire
  // afterward — but isn't guaranteed across versions. If we relied on
  // 'close' alone, a fork that fails outright (worker path missing,
  // ENOMEM, exec policy denied) would leak the activeTask claim and
  // its kill-queue entry, blocking every future task under the mutex.
  // The latched flag keeps the close path idempotent so we can call it
  // from both events safely.
  let closed = false;
  const close = (code, signal) => {
    if (closed) { return; }
    closed = true;
    onBackupClose(forked, taskObj, historyId, code, signal, observers);
  };
  // Node's 'close' event signature is (code, signal) — when the worker
  // is killed by a signal (SIGSEGV from a real crash, SIGKILL from the
  // OOM killer, SIGTERM from the kill list at shutdown) `code` is null
  // and `signal` carries the name. Forwarding both lets onBackupClose
  // produce a useful error_message instead of "exited with code null".
  forked.on('close', (code, signal) => close(code, signal));
  forked.on('error', (err) => {
    winston.error(`Backup: worker fork error for run #${historyId}: ${err.message}`);
    // Synthesize a non-zero "exit code" so onBackupClose marks the run
    // 'failed' with a clear error_message — same shape as a worker
    // that exited 1 on its own.
    if (!observers.fatalError) { observers.fatalError = `Worker spawn error: ${err.message}`; }
    close(-1, null);
  });
}

// Wire kill-queue + bookkeeping + line buffering for a backup worker.
// Mirrors attachScanHandlers on the scan side — both functions do the
// "claim the in-flight slot and pipe stdio through our log/event
// machinery" job for their respective workers.
//
// Returns an `observers` object the close handler reads to decide the
// final history-row status: { lastEvent, fatalError }. It's mutated in
// place by stdout line handling — Node's event emitter contract gives
// us no other way to thread state from the data handler into the close
// handler short of module-level state, which we already have plenty of.
function attachBackupHandlers(forked, taskObj, historyId) {
  const killFn = () => { try { forked.kill(); } catch (_) {} };
  addToKillQueue(killFn);

  const observers = { lastEvent: null, fatalError: null };

  // Claim the single in-flight slot. observers rides along on activeTask
  // so a future inspection (e.g. an admin "what's actually happening?"
  // endpoint) could read it without touching closure state.
  activeTask = {
    kind: 'backup',
    taskObj,
    child: forked,
    killFn,
    historyId,
    observers,
  };

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

function onBackupClose(forked, taskObj, historyId, code, signal, { lastEvent, fatalError }) {
  if (activeTask?.child === forked) {
    removeFromKillQueue(activeTask.killFn);
    activeTask = null;
  }

  // Decide final status. Three cases:
  //   1. Worker emitted {event:'error'} and exited 1 → 'failed'
  //   2. Worker exited non-zero / killed by signal     → 'failed'
  //      (covers crashes, OOM, killed by signal — including server
  //      shutdown via the kill list).
  //   3. Worker exited 0                               → 'success',
  //      annotated with file-error count if any per-file errors hit.
  //
  // For signal kills `code` is null and `signal` carries the name —
  // we report the signal explicitly so a user looking at the history
  // sees "killed by SIGKILL" (e.g. OOM killer) rather than a
  // confusing "exited with code null".
  let status = 'success';
  let errorMessage = null;
  if (fatalError) {
    status = 'failed';
    errorMessage = fatalError;
  } else if (signal) {
    status = 'failed';
    errorMessage = `Worker killed by ${signal}`;
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

// Targeted subtree scan. Walks {vpath}/{subtree} only and skips the
// stale-cleanup pass. Used by the torrent completion-watcher so each
// completed torrent triggers a narrow scan over its own download dir
// instead of a full library walk.
export function scanSubtree(vPath, subtree) {
  addSubtreeScanTask(vPath, subtree);
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
  // The waveform enrichment pass doesn't count: it never writes the DB
  // (read-only snapshot, decode, .bin files), so the library is fully
  // browsable while it runs — reporting it as "scanning" would keep the
  // UI's scanning state (and anything polling /db/status locked) busy
  // for work that doesn't affect them. That immediacy is the point of
  // running waveforms as a separate pass.
  return activeTask !== null && activeTask.kind !== 'waveform';
}

// Snapshot of the queue + currently-scanning vpath. Returns DEFENSIVE
// COPIES so admin-API consumers can't mutate task-queue's internal
// state (otherwise callers like the admin dashboard could pop tasks out
// of the live queue and silently break the queue order). `vpaths` is
// kept as an array (rather than a plain string) for backwards-compat
// with consumers that loop over it; under strictly-serial dispatch it
// always contains 0 or 1 entries.
export function getAdminStats() {
  const activeScanVpath = activeTask?.kind === 'scan' ? activeTask.taskObj.vpath : null;
  return {
    taskQueue: taskQueue.map((t) => ({ ...t })),
    vpaths: activeScanVpath ? [activeScanVpath] : [],
    // The running task's kind — isScanning() deliberately ignores the
    // waveform pass, so this is the only place a dashboard can see one
    // in flight.
    activeTaskKind: activeTask?.kind || null,
  };
}

// Read the stable scan id for the in-flight migration-rescan epoch from
// the `.rescan-pending` marker, assigning + persisting one the first time
// (older markers were written empty — that's expected). Reusing this id
// across restarts is what lets the boot rescan RESUME: the scanner skips
// any track already stamped with it instead of re-parsing from file zero.
// Exported for the unit test in test/task-queue.test.mjs.
export function resolveRescanEpochId(markerPath) {
  let epochId = '';
  try { epochId = fs.readFileSync(markerPath, 'utf8').trim(); } catch (_) { /* unreadable/missing — assign below */ }
  if (!epochId) {
    epochId = `rescan-${nanoid(8)}`;
    try { fs.writeFileSync(markerPath, epochId + '\n'); } catch (_) { /* best-effort persist */ }
  }
  return epochId;
}

export function runAfterBoot() {
  // Clear any stale scan progress rows left from a previous crash
  try { db.getDB()?.prepare('DELETE FROM scan_progress').run(); } catch (_) {}

  // Check if a migration flagged a force rescan. We DO NOT unlink the
  // marker here — it stays on disk until the queue drains after a
  // COMPLETE rescan (checkQueueDrainedSideEffects). If the process is
  // restarted mid-rescan, the marker survives and the next boot RESUMES.
  //
  // Resume hinges on a stable scan id persisted in the marker: the boot
  // rescan reuses it across restarts, and the scanner skips any row whose
  // scan_id already equals it (re-parsed in an earlier pass of the same
  // epoch). The previous code force-rescanned with a fresh id every boot,
  // so it restarted from file zero each time — on a library too large to
  // finish in one uptime the marker never cleared and it re-scanned from
  // scratch forever (the bug this fixes).
  const markerPath = path.join(config.program.storage.dbDirectory, '.rescan-pending');
  let pendingRescan = false;
  try {
    if (fs.existsSync(markerPath)) {
      pendingRescan = true;
      bootRescanInFlight = true;
      bootRescanMarkerPath = markerPath;
      bootRescanScanId = resolveRescanEpochId(markerPath);
      winston.info(`Force rescan pending from migration — resumable epoch '${bootRescanScanId}'`);
    }
  } catch (_) {}

  setTimeout(() => {
    if (pendingRescan) {
      // Resumable migration rescan: every library shares the stable epoch
      // id so a restart continues from where it left off instead of
      // re-parsing the whole library from file zero.
      rescanAll(bootRescanScanId);
      // If rescanAll enqueued nothing (e.g. zero libraries configured), no
      // scan will ever close to trigger the drain check — so clear the
      // marker now rather than letting it linger across boots. When
      // libraries exist a scan is already active here, so this is a no-op.
      checkQueueDrainedSideEffects();
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
