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
import { getDirname, appRoot } from '../util/esm-helpers.js';
import { launchWorker, workerReaperMarker } from '../util/worker-process.js';
import { ffmpegBin, ensureFfmpeg } from '../util/ffmpeg-bootstrap.js';
import * as dlnaApi from '../api/dlna.js';
import * as discoveryDb from './discovery-db.js';

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
// Set in onScanClose after a clean scan; consumed in
// checkQueueDrainedSideEffects to enqueue the album-art download pass once
// the whole scan batch has drained. Module-level because the enqueue point
// (queue drain) is decoupled from where we learn a scan finished (per-scan
// close), and N library scans should collapse to one pass.
let albumArtEnqueuePending = false;
// Parallel flag for the lyrics backfill pass — set on a clean scan, consumed
// (after album-art) once the batch drains. Same collapse-N-scans-to-one-pass
// rationale as albumArtEnqueuePending.
let lyricsEnqueuePending = false;
// Same deferred-enqueue pattern as albumArtEnqueuePending, for the essentia
// BPM/key analysis pass — set on a clean scan, consumed once the batch drains.
let audioAnalysisEnqueuePending = false;
let discoveryEnqueuePending = false;
let acoustidEnqueuePending = false;
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
const rustParserDir = path.join(appRoot, 'rust-parser');
const prebuiltBin = path.join(appRoot, `bin/rust-parser/rust-parser-${process.platform}-${process.arch}${libcSuffix}${ext}`);
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

// One-shot per process: when the SHIPPED glibc rust-parser can't run on this
// host (most often it's simply too new — it needs GLIBC_2.34 — but any exec
// failure counts), retry the committed static-musl build instead of dropping
// straight to the ~16x-slower JS scanner. The -musl binary is fully static and
// runs on ANY linux libc/version, so this salvages native-speed scanning AND
// the post-scan waveform pass on older-glibc distros (RHEL/Rocky 8, Ubuntu
// 20.04, Amazon Linux 2, Debian 11, ...). It swaps rustParserBin to the musl
// build (so every later Rust use — incl. waveforms — picks it up too) and
// re-enters runScan. Returns true if a retry was launched (the caller must then
// return), false to proceed with the JS fallback.
let muslRetryTried = false;
function tryMuslRetry(scanObj, reason) {
  if (muslRetryTried) { return false; }
  // Only on a linux glibc host: musl hosts already select the -musl binary up
  // front (libcSuffix), and non-linux platforms have no musl variant.
  if (process.platform !== 'linux' || libcSuffix === '-musl') { return false; }
  // Only second-guess the shipped prebuilt glibc binary — a failed local dev
  // build (cargo) is a different problem the musl sibling won't fix.
  if (rustParserBin !== prebuiltBin) { return false; }
  const muslBin = path.join(appRoot, `bin/rust-parser/rust-parser-${process.platform}-${process.arch}-musl${ext}`);
  if (!fs.existsSync(muslBin)) { return false; }

  muslRetryTried = true;
  try { fs.chmodSync(muslBin, 0o755); } catch (_) { /* best-effort; spawn will surface a real failure */ }
  rustParserBin = muslBin;
  rustBinaryReady = true;
  rustParserDisabled = false;
  winston.warn(`Rust parser (glibc) ${reason}; retrying with the portable static-musl build before the JS fallback`);
  runScan(scanObj);
  return true;
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
// Forked-worker stderr → log level. Node runtime chatter (the
// "(node:PID) ExperimentalWarning: …" banner and its "(Use `node
// --trace-warnings …" follow-up) is not a worker failure — it was painting
// red error lines over every fresh boot via the node:sqlite experimental
// warning. Real errors stay error-level.
function logWorkerStderr(prefix, line) {
  if (!line) { return; }
  if (/^\(node:\d+\)/.test(line) || line.startsWith('(Use `node ')
      || line.startsWith('[winston]')) {
    winston.debug(`${prefix}: ${line}`);
  } else if (line.startsWith('Warning:')) {
    winston.warn(`${prefix}: ${line}`);
  } else {
    winston.error(`${prefix} error: ${line}`);
  }
}

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
    else if (candidate.task === 'albumart') { runAlbumArtTask(candidate); }
    else if (candidate.task === 'lyrics')   { runLyricsTask(candidate); }
    else if (candidate.task === 'audioanalysis') { runAudioAnalysisTask(candidate); }
    else if (candidate.task === 'discovery') { runDiscoveryTask(candidate); }
    else if (candidate.task === 'acoustid') { runAcoustidTask(candidate); }
  }
}

// The enrichment-pass task kinds. They share semantics everywhere the
// queue makes a decision: they don't count against "drained" (the side
// effects below are about the SCAN batch), they don't surface as `locked`
// (isScanning), and they run strictly serial like everything else.
const ENRICHMENT_KINDS = ['waveform', 'albumart', 'lyrics', 'audioanalysis', 'discovery', 'acoustid'];

// Drained-queue side effects shared by onScanClose + onBackupClose.
// Centralised here because the DLNA bump and the migration-rescan marker
// cleanup both depend on "all queued and active work finished," which can
// be triggered by either kind of close after the unified-queue change.
function checkQueueDrainedSideEffects() {
  // Enrichment passes (waveform decode, art download) don't count against
  // "drained": the side effects below are about the SCAN batch — the
  // passes change no library content the DLNA caches care about, and they
  // are not part of any migration epoch (the marker must not wait minutes
  // for background decode / throttled downloads before clearing).
  const drained =
    (activeTask === null || ENRICHMENT_KINDS.includes(activeTask.kind)) &&
    !taskQueue.some((t) => !ENRICHMENT_KINDS.includes(t.task));
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

  // Hand the now-idle stretch to the album-art download pass if a scan in
  // this drained batch asked for it. Done HERE — after the DLNA bump and
  // the rescan-marker cleanup — so it runs once per batch and only after
  // any .rescan-pending marker is gone (a restart during the potentially
  // long download must not re-trigger a full migration rescan).
  // maybeEnqueueAlbumArt re-checks config + that anything is eligible
  // before forking.
  if (albumArtEnqueuePending) {
    albumArtEnqueuePending = false;
    maybeEnqueueAlbumArt();
  }

  // Then the lyrics backfill pass — after album-art, so the two enrichment
  // passes run strictly one-then-the-other (never two children on the SQLite
  // writer at once). maybeEnqueueLyrics re-checks config + eligibility.
  if (lyricsEnqueuePending) {
    lyricsEnqueuePending = false;
    maybeEnqueueLyrics();
  }

  // Likewise hand off to the essentia BPM/key analysis pass. Separate flag +
  // enqueue so it runs once per batch alongside (and serialised behind) the
  // art pass; maybeEnqueueAudioAnalysis re-checks config + eligibility + ffmpeg
  // before forking.
  if (audioAnalysisEnqueuePending) {
    audioAnalysisEnqueuePending = false;
    maybeEnqueueAudioAnalysis();
  }

  // And finally the discovery-embedding pass (separate discovery.db) —
  // last in the chain: it's the most CPU-expensive per track, so every
  // cheaper pass gets its results in first. maybeEnqueueDiscovery re-checks
  // config + ffmpeg + whether anything actually lacks a current-model
  // embedding before forking.
  if (discoveryEnqueuePending) {
    discoveryEnqueuePending = false;
    maybeEnqueueDiscovery();
  }

  // AcoustID identification (network-bound, cheap CPU): fingerprints
  // un-identified tracks and fills MusicBrainz recording MBIDs.
  // maybeEnqueueAcoustid re-checks config + key + binary + eligibility.
  if (acoustidEnqueuePending) {
    acoustidEnqueuePending = false;
    maybeEnqueueAcoustid();
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
  bufferLines(forkedScan.stderr, (line) => logWorkerStderr('File scan', line));
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
    // Flag the album-art download pass to enqueue once the whole batch
    // drains (consumed in checkQueueDrainedSideEffects — N library scans
    // collapse to one pass, and it starts only after any .rescan-pending
    // marker is cleared so a restart mid-download never re-triggers a
    // migration rescan). Only after a CLEAN scan: a crashed or
    // shutdown-killed scan shouldn't spawn follow-up network work.
    albumArtEnqueuePending = true;
    // Same clean-scan gate: queue a lyrics backfill pass for once the batch
    // drains (after album-art).
    lyricsEnqueuePending = true;
    // Same for the essentia BPM/key pass — fill analysed bpm/musical_key for
    // tag-less tracks once the batch drains.
    audioAnalysisEnqueuePending = true;
    // Same for the discovery-embedding pass (new/changed files need vectors).
    discoveryEnqueuePending = true;
    // And the AcoustID identification pass (new files may lack MBIDs).
    acoustidEnqueuePending = true;
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
  bufferLines(wfChild.stderr, (line) => logWorkerStderr('Waveform pass', line));

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

// ── Album-art download task ─────────────────────────────────────────────────
//
// The third enrichment pass: a forked child (src/db/album-art-backfill.mjs)
// that fills cover-art gaps from external services (MusicBrainz / iTunes /
// Deezer), throttled to ~1 album/sec for rate-limit etiquette and capped
// per run so a queued scan/backup never waits long behind it. Enqueued
// once per scan BATCH from checkQueueDrainedSideEffects (N library scans
// collapse to one pass), re-enqueued by its own close handler while it
// keeps hitting the per-run cap. See album-art-backfill.mjs for the
// cooldown/dedupe design.

const ALBUM_ART_SCRIPT_PATH = path.join(__dirname, './album-art-backfill.mjs');
const SCANNER_SCRIPT_PATH = path.join(__dirname, './scanner.mjs');

// Enqueue unless the feature is off or nothing is eligible. The coarse
// art-presence pre-check on the main connection avoids forking a no-op
// child after every quiet scan (and keeps the stub libraries in tests
// from spawning network work). The worker re-checks with the full
// per-album cooldown logic — an album still in cooldown can pass this
// gate; that just costs one fast no-op run.
// Exported: the admin auto-album-art toggle routes through here so EVERY
// entry point honours the same gates (autoAlbumArt, skipImg, a non-empty
// service list, something eligible).
export function maybeEnqueueAlbumArt() {
  const opts = config.program.scanOptions;
  if (opts.autoAlbumArt === false) { return; }
  if (opts.skipImg === true) { return; }
  // An emptied service list is "feature off", not a worker crash: the
  // worker's own Joi requires >= 1 service, so forking with [] would just
  // log a failed pass after every scan forever.
  if (Array.isArray(opts.albumArtServices) && opts.albumArtServices.length === 0) { return; }

  try {
    const database = db.getDB();
    if (!database) { return; }
    const artFilter = opts.autoAlbumArtMode === 'all' ? '' : 'AND album_art_file IS NULL';
    // EXISTS-tracks mirrors the worker's eligibility query: trackless
    // ghost albums must keep neither the enqueue nor the worker alive.
    const row = database.prepare(
      `SELECT 1 FROM albums WHERE name IS NOT NULL AND TRIM(name) != ''
        AND EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = albums.id) ${artFilter} LIMIT 1`
    ).get();
    if (!row) { return; }
  } catch (err) {
    // Fail safe: a pre-check hiccup must never wedge the task queue.
    winston.warn('Album-art download pre-check failed; skipping enqueue', { stack: err });
    return;
  }

  addAlbumArtTask();
}

function addAlbumArtTask() {
  // One pass at a time — it's a global sweep over eligible albums, so a
  // second concurrent or queued run would only duplicate work.
  if (activeTask?.kind === 'albumart') { return; }
  if (taskQueue.some((t) => t.task === 'albumart')) { return; }
  taskQueue.push({ task: 'albumart', id: nanoid(8) });
  nextTask();
}

function runAlbumArtTask(taskObj) {
  const opts = config.program.scanOptions;
  // Re-check ALL the gates at run time: config may have flipped while
  // this sat queued, and run-time gating is what keeps every enqueue
  // path (scan-drain, admin toggle, hitCap re-enqueue) consistent.
  if (opts.autoAlbumArt === false || opts.skipImg === true) { return; }
  if (Array.isArray(opts.albumArtServices) && opts.albumArtServices.length === 0) { return; }

  const jsonLoad = {
    dbPath: path.join(config.program.storage.dbDirectory, 'mstream.db'),
    albumArtDirectory: config.program.storage.albumArtDirectory,
    compressImage: opts.compressImage,
    services: opts.albumArtServices || ['musicbrainz', 'itunes', 'deezer'],
    mode: opts.autoAlbumArtMode || 'missing',
    writeToFolder: opts.autoAlbumArtWriteToFolder === true,
    maxPerRun: opts.autoAlbumArtPerRun || 100,
    expectedSchemaVersion: SCHEMA_VERSION,
    // Cooldowns + inter-request throttle use the worker's own defaults.
  };

  const forked = launchWorker('albumart', ALBUM_ART_SCRIPT_PATH, JSON.stringify(jsonLoad));
  winston.info('Album-art download pass started');
  // Boot-reaper contract, same as the scanners: this child WRITES the DB
  // (per-album lookup rows + found-commits), so an orphan surviving a
  // hard server kill must be reapable on the next boot — the script path
  // is the command-line marker the reaper matches.
  if (Number.isInteger(forked.pid)) {
    writeScannerPidfile(config.program.storage.dbDirectory, forked.pid,
      process.execPath, 'js', workerReaperMarker('albumart', ALBUM_ART_SCRIPT_PATH));
  }

  const killFn = () => { try { forked.kill(); } catch (_) { /* already gone */ } };
  addToKillQueue(killFn);
  // `observers.hitCap` is set by the stdout 'albumArtComplete' event so
  // the close handler can decide whether to queue another batch.
  const observers = { hitCap: false };
  activeTask = { kind: 'albumart', taskObj, child: forked, killFn, observers };

  bufferLines(forked.stdout, (line) => {
    if (!line) { return; }
    if (line[0] === '{') {
      try {
        const evt = JSON.parse(line);
        if (evt.event === 'albumArtComplete') {
          observers.hitCap = !!evt.hitCap;
          if (evt.attempted > 0) {
            winston.info(`Album-art download pass complete: ${evt.updated} fetched, `
              + `${evt.deduped} already-had, ${evt.notFound} not found, `
              + `${evt.errors} error(s) (${evt.attempted} attempted)`);
          }
          return;
        }
        if (evt.event === 'albumArtProgress') {
          winston.info(`Album-art download: ${evt.attempted}/${evt.total} albums attempted`);
          return;
        }
        if (evt.event === 'error') {
          winston.error(`Album-art download: ${evt.message}`);
          return;
        }
      } catch (_) { /* not a structured event — log as plain text */ }
    }
    winston.info(line);
  });
  bufferLines(forked.stderr, (line) => logWorkerStderr('Album-art download', line));

  // Same close/error double-fire latch as the backup + waveform workers.
  let closed = false;
  const closeOnce = (code, signal) => {
    if (closed) { return; }
    closed = true;
    if (signal) {
      winston.info(`Album-art download pass terminated by ${signal}`);
    } else if (code === 3) {
      winston.warn('Album-art download pass aborted: DB schema changed under it (another instance migrating?)');
    } else if (code !== 0 && code !== null) {
      winston.warn(`Album-art download pass exited with code ${code}`);
    }
    clearScannerPidfile(config.program.storage.dbDirectory);
    if (activeTask?.child === forked) {
      removeFromKillQueue(activeTask.killFn);
      activeTask = null;
    }
    // hitCap: the worker stopped at maxPerRun with (probably) more to do —
    // queue another batch so a large first-run backlog drains in this idle
    // stretch, while still yielding the slot to any scan/backup queued
    // meanwhile. Terminates: every attempted album gets a cooldown row, so
    // a later run that finds only cooled-down albums clears hitCap.
    if (code === 0 && !signal && observers.hitCap) {
      maybeEnqueueAlbumArt();
    }
    nextTask();
    checkQueueDrainedSideEffects();
  };
  forked.on('error', (err) => {
    winston.error(`Album-art download pass failed to start: ${err.message}`);
    closeOnce(-1, null);
  });
  forked.on('close', (code, signal) => closeOnce(code, signal));
}

// ── Lyrics backfill enrichment pass ─────────────────────────────────────────
//
// The fourth enrichment pass (scan → waveforms → album-art → this). Fills
// lyrics for tracks that have none (no embedded tag, no sidecar) from the
// configured providers. Mirrors the album-art downloader's lifecycle exactly;
// the differences are: config gates (lyrics.backfill + a non-empty providers
// list), eligibility (lyric-less tracks with title+artist), event names, and
// an optimizeFts() after a pass that added lyrics (lyrics writes touch the
// fts_tracks.lyrics column — album-art never touches an FTS-indexed column).

const LYRICS_SCRIPT_PATH = path.join(__dirname, './lyrics-backfill.mjs');

// Enqueue the lyrics backfill pass unless the feature is off or nothing is
// eligible. The coarse pre-check avoids forking a no-op child after every
// quiet scan; the worker re-checks with the full per-track cooldown logic.
// Exported: the admin /lyrics/backfill toggle routes through here so every
// entry point honours the same gates.
export function maybeEnqueueLyrics() {
  const opts = config.program.lyrics || {};
  if (opts.backfill !== true) { return; }
  // An empty provider list is "feature off", not a worker crash.
  if (!Array.isArray(opts.providers) || opts.providers.length === 0) { return; }

  try {
    const database = db.getDB();
    if (!database) { return; }
    // Mirrors the worker's eligibility query: a lyric-less track with the
    // artist + title a provider needs. Tracks missing either can't be looked
    // up, so they don't keep the pass alive.
    const row = database.prepare(
      `SELECT 1 FROM tracks
        WHERE lyrics_embedded IS NULL AND lyrics_synced_lrc IS NULL
          AND title IS NOT NULL AND TRIM(title) != ''
          AND artist_id IS NOT NULL
        LIMIT 1`
    ).get();
    if (!row) { return; }
  } catch (err) {
    // Fail safe: a pre-check hiccup must never wedge the task queue.
    winston.warn('Lyrics backfill pre-check failed; skipping enqueue', { stack: err });
    return;
  }

  addLyricsTask();
}

function addLyricsTask() {
  // One pass at a time — a global sweep over eligible tracks.
  if (activeTask?.kind === 'lyrics') { return; }
  if (taskQueue.some((t) => t.task === 'lyrics')) { return; }
  taskQueue.push({ task: 'lyrics', id: nanoid(8) });
  nextTask();
}

function runLyricsTask(taskObj) {
  const opts = config.program.lyrics || {};
  // Re-check the gates at run time: config may have flipped while queued.
  if (opts.backfill !== true) { return; }
  if (!Array.isArray(opts.providers) || opts.providers.length === 0) { return; }

  const jsonLoad = {
    dbPath: path.join(config.program.storage.dbDirectory, 'mstream.db'),
    providers: opts.providers,
    writeSidecar: opts.writeSidecar === true,
    maxPerRun: opts.backfillMaxPerRun || 100,
    expectedSchemaVersion: SCHEMA_VERSION,
    // Cooldowns + inter-request throttle use the worker's own defaults.
  };

  const forked = launchWorker('lyrics', LYRICS_SCRIPT_PATH, JSON.stringify(jsonLoad));
  winston.info('Lyrics backfill pass started');
  // Boot-reaper contract, same as album-art: this child WRITES the DB, so an
  // orphan surviving a hard kill must be reapable on the next boot — the
  // command-line marker the reaper matches (the role flag under Bun
  // self-dispatch, the script path under Node).
  if (Number.isInteger(forked.pid)) {
    writeScannerPidfile(config.program.storage.dbDirectory, forked.pid,
      process.execPath, 'js', workerReaperMarker('lyrics', LYRICS_SCRIPT_PATH));
  }

  const killFn = () => { try { forked.kill(); } catch (_) { /* already gone */ } };
  addToKillQueue(killFn);
  // hitCap → re-enqueue another batch; updated → whether to optimise FTS.
  const observers = { hitCap: false, updated: 0 };
  activeTask = { kind: 'lyrics', taskObj, child: forked, killFn, observers };

  bufferLines(forked.stdout, (line) => {
    if (!line) { return; }
    if (line[0] === '{') {
      try {
        const evt = JSON.parse(line);
        if (evt.event === 'lyricsComplete') {
          observers.hitCap = !!evt.hitCap;
          observers.updated = evt.updated || 0;
          if (evt.attempted > 0) {
            winston.info(`Lyrics backfill pass complete: ${evt.updated} added, `
              + `${evt.notFound} not found, ${evt.errors} error(s) (${evt.attempted} attempted)`);
          }
          return;
        }
        if (evt.event === 'lyricsProgress') {
          winston.info(`Lyrics backfill: ${evt.attempted}/${evt.total} tracks attempted`);
          return;
        }
        if (evt.event === 'error') {
          winston.error(`Lyrics backfill: ${evt.message}`);
          return;
        }
      } catch (_) { /* not a structured event — log as plain text */ }
    }
    winston.info(line);
  });
  bufferLines(forked.stderr, (line) => logWorkerStderr('Lyrics backfill', line));

  // Same close/error double-fire latch as the album-art + waveform workers.
  let closed = false;
  const closeOnce = (code, signal) => {
    if (closed) { return; }
    closed = true;
    if (signal) {
      winston.info(`Lyrics backfill pass terminated by ${signal}`);
    } else if (code === 3) {
      winston.warn('Lyrics backfill pass aborted: DB schema changed under it (another instance migrating?)');
    } else if (code !== 0 && code !== null) {
      winston.warn(`Lyrics backfill pass exited with code ${code}`);
    }
    clearScannerPidfile(config.program.storage.dbDirectory);
    if (activeTask?.child === forked) {
      removeFromKillQueue(activeTask.killFn);
      activeTask = null;
    }
    // Merge the FTS5 segments the lyrics writes accumulated (album-art never
    // touches an FTS-indexed column, so it skips this). Only on a successful
    // pass that actually added lyrics.
    if (code === 0 && !signal && observers.updated > 0) {
      try { db.optimizeFts(); }
      catch (err) { winston.warn('Lyrics backfill: FTS optimize failed', { stack: err }); }
    }
    // hitCap re-enqueue: terminates because every attempted track gets a
    // cooldown row in lyrics_cache, so a later run finding only cooled-down
    // tracks clears hitCap.
    if (code === 0 && !signal && observers.hitCap) {
      maybeEnqueueLyrics();
    }
    nextTask();
    checkQueueDrainedSideEffects();
  };
  forked.on('error', (err) => {
    winston.error(`Lyrics backfill pass failed to start: ${err.message}`);
    closeOnce(-1, null);
  });
  forked.on('close', (code, signal) => closeOnce(code, signal));
}

// ── Essentia BPM/key analysis task ──────────────────────────────────────────
//
// The last enrichment pass (scan → waveforms → album-art → lyrics → this). A
// forked child (src/db/audio-analysis-backfill.mjs) decodes each track that has no
// analysed bpm/musical_key via the bundled ffmpeg and estimates tempo + key
// with essentia.js. CPU-bound, so the worker self-bounds with a per-run cap AND
// a wall-clock budget and re-enqueues while hitCap persists — same slot-yield
// etiquette as the album-art pass so queued scans/backups interleave. See
// audio-analysis-backfill.mjs for the cooldown/dedupe design.
//
// AGPL: essentia.js is AGPL-3.0 — the pass is forked only when
// scanOptions.analyzeBpm is on, and never auto-on by default.

const AUDIO_ANALYSIS_SCRIPT_PATH = path.join(__dirname, './audio-analysis-backfill.mjs');

// Coarse eligibility window for the enqueue pre-check (mirrors the worker's
// duration defaults). Kept loose on purpose — the worker re-checks with the
// full genre/cooldown logic; this just avoids forking a no-op child after
// every quiet scan.
const ANALYSIS_MIN_DURATION_SEC = 30;
const ANALYSIS_MAX_DURATION_SEC = 30 * 60;

// First-boot race: a small scan can drain BEFORE ffmpeg-bootstrap has
// resolved a binary (its download/probe takes seconds; six files scan in
// two). The old behavior silently postponed the enrichment pass to the
// NEXT scan — a day away at the default scanInterval. Instead, piggyback
// on the (already in-flight, promise-cached) ensureFfmpeg() and re-run the
// enqueue when it settles. Set-dedup so a burst of scan-drains registers
// one retry per gate.
const ffmpegRetryWaiters = new Set();
function retryWhenFfmpegResolves(retryFn) {
  if (ffmpegRetryWaiters.has(retryFn)) { return; }
  ffmpegRetryWaiters.add(retryFn);
  ensureFfmpeg().catch(() => null).then(() => {
    ffmpegRetryWaiters.delete(retryFn);
    if (ffmpegBin()) { retryFn(); }
    else { winston.warn('Enrichment pass skipped — no working ffmpeg could be resolved'); }
  });
}

// Enqueue unless the feature is off, ffmpeg isn't resolved, or nothing is
// eligible. Exported so the admin analyze-bpm toggle routes through the same
// gates as the scan-drain trigger.
export function maybeEnqueueAudioAnalysis() {
  if (config.program.scanOptions.analyzeBpm !== true) { return; }
  if (!ffmpegBin()) {
    winston.info('Audio-analysis pass deferred — waiting for ffmpeg to resolve');
    retryWhenFfmpegResolves(maybeEnqueueAudioAnalysis);
    return;
  }

  try {
    const database = db.getDB();
    if (!database) { return; }
    const row = database.prepare(
      `SELECT 1 FROM tracks
        WHERE (bpm IS NULL OR musical_key IS NULL)
          AND duration IS NOT NULL AND duration >= ? AND duration <= ?
          AND COALESCE(audio_hash, file_hash) IS NOT NULL
        LIMIT 1`
    ).get(ANALYSIS_MIN_DURATION_SEC, ANALYSIS_MAX_DURATION_SEC);
    if (!row) { return; }
  } catch (err) {
    // Fail safe: a pre-check hiccup must never wedge the task queue.
    winston.warn('Audio-analysis pre-check failed; skipping enqueue', { stack: err });
    return;
  }

  addAudioAnalysisTask();
}

function addAudioAnalysisTask() {
  // One pass at a time — it's a global sweep, so a second concurrent or queued
  // run would only duplicate work.
  if (activeTask?.kind === 'audioanalysis') { return; }
  if (taskQueue.some((t) => t.task === 'audioanalysis')) { return; }
  taskQueue.push({ task: 'audioanalysis', id: nanoid(8) });
  nextTask();
}

function runAudioAnalysisTask(taskObj) {
  // Re-check the gate at run time: config may have flipped while this sat
  // queued (admin toggle), and ffmpeg may have gone away.
  if (config.program.scanOptions.analyzeBpm !== true) { return; }
  const ffPath = ffmpegBin();
  if (!ffPath) {
    winston.info('Audio-analysis pass skipped — no resolved ffmpeg binary');
    return;
  }

  const jsonLoad = {
    dbPath: path.join(config.program.storage.dbDirectory, 'mstream.db'),
    ffmpegPath: ffPath,
    maxPerRun: config.program.scanOptions.analyzeBpmPerRun || 200,
    expectedSchemaVersion: SCHEMA_VERSION,
    // Duration window / confidence floors / cooldowns use the worker defaults.
  };

  // launchWorker (not raw child.fork) so the pass also works under the Bun
  // --compile self-dispatch path, exactly like the album-art / lyrics / scanner
  // workers — a raw fork re-runs the embedded server entrypoint there.
  const forked = launchWorker('audioanalysis', AUDIO_ANALYSIS_SCRIPT_PATH, JSON.stringify(jsonLoad));
  winston.info('Audio-analysis (BPM/key) pass started');
  // Boot-reaper contract: this child WRITES the DB (bpm/key + lookup rows), so
  // an orphan surviving a hard kill must be reapable. workerReaperMarker yields
  // the right command-line marker for whichever runtime launched it.
  if (Number.isInteger(forked.pid)) {
    writeScannerPidfile(config.program.storage.dbDirectory, forked.pid,
      process.execPath, 'js', workerReaperMarker('audioanalysis', AUDIO_ANALYSIS_SCRIPT_PATH));
  }

  const killFn = () => { try { forked.kill(); } catch (_) { /* already gone */ } };
  addToKillQueue(killFn);
  const observers = { hitCap: false };
  activeTask = { kind: 'audioanalysis', taskObj, child: forked, killFn, observers };

  bufferLines(forked.stdout, (line) => {
    if (!line) { return; }
    if (line[0] === '{') {
      try {
        const evt = JSON.parse(line);
        if (evt.event === 'audioAnalysisComplete') {
          observers.hitCap = !!evt.hitCap;
          if (evt.attempted > 0) {
            winston.info(`Audio-analysis pass complete: ${evt.analyzed} analysed, `
              + `${evt.lowconf} low-confidence, ${evt.errors} error(s) (${evt.attempted} attempted)`);
          }
          return;
        }
        if (evt.event === 'audioAnalysisProgress') {
          winston.info(`Audio-analysis: ${evt.attempted}/${evt.total} tracks attempted`);
          return;
        }
        if (evt.event === 'error') {
          winston.error(`Audio-analysis: ${evt.message}`);
          return;
        }
      } catch (_) { /* not a structured event — log as plain text */ }
    }
    winston.info(line);
  });
  bufferLines(forked.stderr, (line) => logWorkerStderr('Audio-analysis', line));

  let closed = false;
  const closeOnce = (code, signal) => {
    if (closed) { return; }
    closed = true;
    if (signal) {
      winston.info(`Audio-analysis pass terminated by ${signal}`);
    } else if (code === 3) {
      winston.warn('Audio-analysis pass aborted: DB schema changed under it (another instance migrating?)');
    } else if (code !== 0 && code !== null) {
      winston.warn(`Audio-analysis pass exited with code ${code}`);
    }
    clearScannerPidfile(config.program.storage.dbDirectory);
    if (activeTask?.child === forked) {
      removeFromKillQueue(activeTask.killFn);
      activeTask = null;
    }
    // hitCap: the worker stopped at the per-run cap or wall-clock budget with
    // (probably) more to do — queue another batch so a large backlog drains in
    // this idle stretch while still yielding to any scan/backup queued
    // meanwhile. Terminates: every attempted track gets a cooldown row, so a
    // later run finding only cooled-down tracks clears hitCap.
    if (code === 0 && !signal && observers.hitCap) {
      maybeEnqueueAudioAnalysis();
    }
    nextTask();
    checkQueueDrainedSideEffects();
  };
  forked.on('error', (err) => {
    winston.error(`Audio-analysis pass failed to start: ${err.message}`);
    closeOnce(-1, null);
  });
  forked.on('close', (code, signal) => closeOnce(code, signal));
}

// ── Discovery-embedding enrichment task ─────────────────────────────────────
//
// The 5th enrichment pass: populates the SEPARATE discovery.db with one
// audio embedding per canonical track (src/db/discovery-backfill.mjs). The
// model is pluggable (scanOptions.discoveryModel → the registry in
// discovery-features-lib.js); the worker re-embeds rows pinned to a
// different model, so a model swap migrates the dataset in place across
// passes. Gated by scanOptions.collectDiscoveryData (default OFF).

const DISCOVERY_SCRIPT_PATH = path.join(__dirname, './discovery-backfill.mjs');

// Coarse duration window for the enqueue pre-check (mirrors the worker's
// defaults; the worker re-checks with full genre/cooldown logic).
const DISCOVERY_MIN_DURATION_SEC = 30;
const DISCOVERY_MAX_DURATION_SEC = 30 * 60;

// Enqueue unless the feature is off, ffmpeg isn't resolved, or every
// eligible track already has a current-model embedding. Exported so the
// admin collect-discovery-data toggle routes through the same gates as the
// scan-drain trigger.
// Latched true when the embedding worker reports the environment can't
// load onnxruntime-node at all (exit code 4 — e.g. musl/Alpine images,
// where onnxruntime's glibc-only binaries can never load). A structural
// failure, identical on every retry, so the pass stays off until restart
// instead of failing (and error-logging) on every scan drain.
let discoveryRuntimeUnavailable = false;

export function maybeEnqueueDiscovery() {
  if (config.program.scanOptions.collectDiscoveryData !== true) { return; }
  if (discoveryRuntimeUnavailable) { return; }
  if (!ffmpegBin()) {
    winston.info('Discovery-embedding pass deferred — waiting for ffmpeg to resolve');
    retryWhenFfmpegResolves(maybeEnqueueDiscovery);
    return;
  }

  try {
    // The pre-check needs both DBs: a track is work iff its canonical hash
    // has no current-model embedding row. The main process's discovery
    // handle ATTACHes the library DB briefly — same pattern as the export
    // builder's snapshot ATTACH, and single-threaded like it, so the two
    // can't interleave mid-statement.
    const ddb = discoveryDb.openDiscoveryDbIfExists();
    if (!ddb) { return; }   // toggle/boot creates it when the flag is on
    const libPath = path.join(config.program.storage.dbDirectory, 'mstream.db').replace(/'/g, "''");
    ddb.exec(`ATTACH DATABASE '${libPath}' AS precheck_lib`);
    let row;
    try {
      row = ddb.prepare(`
        SELECT 1 FROM precheck_lib.tracks t
         WHERE COALESCE(t.audio_hash, t.file_hash) IS NOT NULL
           AND t.duration IS NOT NULL AND t.duration >= ? AND t.duration <= ?
           AND NOT EXISTS (
                 SELECT 1 FROM main.discovery_tracks dt
                  WHERE dt.audio_hash = COALESCE(t.audio_hash, t.file_hash)
                    AND dt.embedding IS NOT NULL
                    AND dt.model_id = ?
               )
         LIMIT 1
      `).get(DISCOVERY_MIN_DURATION_SEC, DISCOVERY_MAX_DURATION_SEC,
        config.program.scanOptions.discoveryModel);
    } finally {
      ddb.exec('DETACH DATABASE precheck_lib');
    }
    if (!row) { return; }
  } catch (err) {
    // Fail safe: a pre-check hiccup must never wedge the task queue.
    winston.warn('Discovery pre-check failed; skipping enqueue', { stack: err });
    return;
  }

  addDiscoveryTask();
}

function addDiscoveryTask() {
  // One pass at a time — it's a global sweep, so a second concurrent or
  // queued run would only duplicate work.
  if (activeTask?.kind === 'discovery') { return; }
  if (taskQueue.some((t) => t.task === 'discovery')) { return; }
  taskQueue.push({ task: 'discovery', id: nanoid(8) });
  nextTask();
}

function runDiscoveryTask(taskObj) {
  // Re-check the gate at run time: config may have flipped while this sat
  // queued (admin toggle), and ffmpeg may have gone away.
  if (config.program.scanOptions.collectDiscoveryData !== true) { return; }
  const ffPath = ffmpegBin();
  if (!ffPath) {
    winston.info('Discovery-embedding pass skipped — no resolved ffmpeg binary');
    return;
  }

  const jsonLoad = {
    discoveryDbPath: discoveryDb.discoveryDbPath(),
    libraryDbPath: path.join(config.program.storage.dbDirectory, 'mstream.db'),
    ffmpegPath: ffPath,
    model: config.program.scanOptions.discoveryModel,
    // Weights cache lives under an operator-configurable dir — NOT inside
    // node_modules (transformers.js's default), which updates would wipe.
    modelCacheDir: config.program.storage.modelCacheDirectory,
    maxPerRun: config.program.scanOptions.discoveryPerRun || 50,
    expectedSchemaVersion: SCHEMA_VERSION,
    // Duration window / cooldowns / budget use the worker defaults.
  };

  const forked = launchWorker('discovery', DISCOVERY_SCRIPT_PATH, JSON.stringify(jsonLoad));
  winston.info(`Discovery-embedding pass started (model: ${jsonLoad.model})`);
  // Boot-reaper contract: this child WRITES a DB (discovery.db), so an
  // orphan surviving a hard kill must be reapable.
  if (Number.isInteger(forked.pid)) {
    writeScannerPidfile(config.program.storage.dbDirectory, forked.pid,
      process.execPath, 'js', workerReaperMarker('discovery', DISCOVERY_SCRIPT_PATH));
  }

  const killFn = () => { try { forked.kill(); } catch (_) { /* already gone */ } };
  addToKillQueue(killFn);
  const observers = { hitCap: false };
  activeTask = { kind: 'discovery', taskObj, child: forked, killFn, observers };

  bufferLines(forked.stdout, (line) => {
    if (!line) { return; }
    if (line[0] === '{') {
      try {
        const evt = JSON.parse(line);
        if (evt.event === 'discoveryComplete') {
          observers.hitCap = !!evt.hitCap;
          if (evt.attempted > 0) {
            winston.info(`Discovery-embedding pass complete: ${evt.embedded} embedded, `
              + `${evt.errors} error(s) (${evt.attempted} attempted)`);
          }
          return;
        }
        if (evt.event === 'discoveryProgress') {
          winston.info(`Discovery-embedding: ${evt.attempted}/${evt.total} tracks attempted`);
          return;
        }
        if (evt.event === 'error') {
          winston.error(`Discovery-embedding: ${evt.message}`);
          return;
        }
      } catch (_) { /* not a structured event — log as plain text */ }
    }
    winston.info(line);
  });
  bufferLines(forked.stderr, (line) => logWorkerStderr('Discovery-embedding', line));

  let closed = false;
  const closeOnce = (code, signal) => {
    if (closed) { return; }
    closed = true;
    if (signal) {
      winston.info(`Discovery-embedding pass terminated by ${signal}`);
    } else if (code === 3) {
      winston.warn('Discovery-embedding pass aborted: library schema changed under it (another instance migrating?)');
    } else if (code === 4) {
      // The environment can't load onnxruntime-node at all (worker exit
      // contract: RUNTIME_UNAVAILABLE_EXIT). Retrying every batch would
      // fail identically and spam the log — latch it off until restart.
      // Seen in the wild on Alpine/musl containers: onnxruntime ships
      // glibc-only binaries, and gcompat doesn't cover its fortified
      // symbols, so a glibc-based image is the only fix.
      discoveryRuntimeUnavailable = true;
      winston.error(
        'Discovery-embedding pass halted: this environment cannot load onnxruntime-node, '
        + 'so the embedding model cannot run (musl/Alpine containers lack the required glibc). '
        + 'Recommendations will not build here — use a glibc-based image (e.g. Debian/Ubuntu). '
        + 'The pass is disabled until the server restarts.');
    } else if (code !== 0 && code !== null) {
      winston.warn(`Discovery-embedding pass exited with code ${code}`);
    }
    clearScannerPidfile(config.program.storage.dbDirectory);
    if (activeTask?.child === forked) {
      removeFromKillQueue(activeTask.killFn);
      activeTask = null;
    }
    // hitCap: stopped at the per-run cap or wall-clock budget with more to
    // do — queue another batch. Terminates: every attempt either writes an
    // embedding (drops out of the eligible set) or an error-cooldown row.
    if (code === 0 && !signal && observers.hitCap) {
      maybeEnqueueDiscovery();
    }
    // Backlog drained (no follow-up batch got queued — covers both the
    // terminal pass and the backlog-size-divisible-by-cap edge where the
    // re-enqueue pre-check finds nothing left): publish the results to the
    // discovery network. No-ops unless p2p is enabled and the dataset
    // actually advanced past the last announced snapshot.
    if (code === 0 && !signal && !taskQueue.some((t) => t.task === 'discovery')) {
      import('../state/discovery-p2p.js')
        .then((p2p) => p2p.maybeAutoPublishSnapshot())
        .catch((err) => winston.warn(`discovery auto-publish after embedding pass failed: ${err.message}`));
    }
    nextTask();
    checkQueueDrainedSideEffects();
  };
  forked.on('error', (err) => {
    winston.error(`Discovery-embedding pass failed to start: ${err.message}`);
    closeOnce(-1, null);
  });
  forked.on('close', (code, signal) => closeOnce(code, signal));
}

// ── AcoustID identification task ─────────────────────────────────────────────
//
// External-ID Phase 2: fingerprint un-identified tracks (rust-parser
// --fingerprint) and resolve them against AcoustID into MusicBrainz
// recording MBIDs (src/db/acoustid-backfill.mjs). Fills
// tracks.mbz_recording_id / acoustid_id with mbz_id_source='acoustid' and
// upgrades discovery.db export_ids from anon: to mbid:. Gated by
// scanOptions.analyzeAcoustid (default OFF — it sends acoustic fingerprints
// to an external service).

const ACOUSTID_SCRIPT_PATH = path.join(__dirname, './acoustid-backfill.mjs');

const ACOUSTID_MIN_DURATION_SEC = 10;
const ACOUSTID_MAX_DURATION_SEC = 2 * 60 * 60;
// Enqueue pre-check retry horizon: the worker applies real per-outcome
// cooldowns; this only has to avoid pointless no-op forks, so it uses the
// SHORTEST cooldown (error, 24h) as "could anything be retryable".
const ACOUSTID_PRECHECK_RETRY_SEC = 24 * 60 * 60;

// Enqueue unless the feature is off, there's no API key or rust-parser, or
// nothing could possibly be eligible. Exported so the admin toggle routes
// through the same gates as the scan-drain trigger.
export function maybeEnqueueAcoustid() {
  if (config.program.scanOptions.analyzeAcoustid !== true) { return; }
  if (!config.program.scanOptions.acoustidApiKey) { return; }
  if (!findRustParser()) {
    winston.info('AcoustID pass skipped — no usable rust-parser binary');
    return;
  }

  try {
    const database = db.getDB();
    if (!database) { return; }
    const row = database.prepare(`
      SELECT 1 FROM tracks t
       WHERE t.mbz_recording_id IS NULL
         AND COALESCE(t.audio_hash, t.file_hash) IS NOT NULL
         AND t.duration IS NOT NULL AND t.duration >= ? AND t.duration <= ?
         AND NOT EXISTS (
               SELECT 1 FROM acoustid_lookups la
                WHERE la.audio_hash = COALESCE(t.audio_hash, t.file_hash)
                  AND la.last_attempt_at >= ?
             )
       LIMIT 1
    `).get(ACOUSTID_MIN_DURATION_SEC, ACOUSTID_MAX_DURATION_SEC,
      Math.floor(Date.now() / 1000) - ACOUSTID_PRECHECK_RETRY_SEC);
    if (!row) { return; }
  } catch (err) {
    winston.warn('AcoustID pre-check failed; skipping enqueue', { stack: err });
    return;
  }

  addAcoustidTask();
}

function addAcoustidTask() {
  if (activeTask?.kind === 'acoustid') { return; }
  if (taskQueue.some((t) => t.task === 'acoustid')) { return; }
  taskQueue.push({ task: 'acoustid', id: nanoid(8) });
  nextTask();
}

function runAcoustidTask(taskObj) {
  // Re-check gates at run time — config may have flipped while queued.
  if (config.program.scanOptions.analyzeAcoustid !== true) { return; }
  if (!config.program.scanOptions.acoustidApiKey) { return; }
  if (!findRustParser()) {
    winston.info('AcoustID pass skipped — no usable rust-parser binary');
    return;
  }

  const jsonLoad = {
    dbPath: path.join(config.program.storage.dbDirectory, 'mstream.db'),
    rustParserPath: rustParserBin,
    apiKey: config.program.scanOptions.acoustidApiKey,
    apiUrl: config.program.scanOptions.acoustidApiUrl,
    maxPerRun: config.program.scanOptions.acoustidPerRun || 200,
    expectedSchemaVersion: SCHEMA_VERSION,
  };
  // Matched ids propagate into discovery.db (export_id anon:→mbid:) when
  // collection has ever created one.
  const ddbPath = discoveryDb.discoveryDbPath();
  if (fs.existsSync(ddbPath)) { jsonLoad.discoveryDbPath = ddbPath; }

  const forked = launchWorker('acoustid', ACOUSTID_SCRIPT_PATH, JSON.stringify(jsonLoad));
  winston.info('AcoustID identification pass started');
  if (Number.isInteger(forked.pid)) {
    writeScannerPidfile(config.program.storage.dbDirectory, forked.pid,
      process.execPath, 'js', workerReaperMarker('acoustid', ACOUSTID_SCRIPT_PATH));
  }

  const killFn = () => { try { forked.kill(); } catch (_) { /* already gone */ } };
  addToKillQueue(killFn);
  const observers = { hitCap: false, matched: 0 };
  activeTask = { kind: 'acoustid', taskObj, child: forked, killFn, observers };

  bufferLines(forked.stdout, (line) => {
    if (!line) { return; }
    if (line[0] === '{') {
      try {
        const evt = JSON.parse(line);
        if (evt.event === 'acoustidComplete') {
          observers.hitCap = !!evt.hitCap;
          observers.matched = evt.matched || 0;
          if (evt.attempted > 0) {
            winston.info(`AcoustID pass complete: ${evt.matched} identified, `
              + `${evt.nomatch} unknown to AcoustID, ${evt.lowconf} low-confidence, `
              + `${evt.undecodable} undecodable, ${evt.errors} error(s) (${evt.attempted} attempted)`);
          }
          return;
        }
        if (evt.event === 'acoustidProgress') {
          winston.info(`AcoustID: ${evt.attempted}/${evt.total} tracks attempted`);
          return;
        }
        if (evt.event === 'error') {
          winston.error(`AcoustID pass: ${evt.message}`);
          return;
        }
      } catch (_) { /* not a structured event — log as plain text */ }
    }
    winston.info(line);
  });
  bufferLines(forked.stderr, (line) => logWorkerStderr('AcoustID pass', line));

  let closed = false;
  const closeOnce = (code, signal) => {
    if (closed) { return; }
    closed = true;
    if (signal) {
      winston.info(`AcoustID pass terminated by ${signal}`);
    } else if (code === 3) {
      winston.warn('AcoustID pass aborted: library schema changed under it (another instance migrating?)');
    } else if (code !== 0 && code !== null) {
      winston.warn(`AcoustID pass exited with code ${code}`);
    }
    clearScannerPidfile(config.program.storage.dbDirectory);
    if (activeTask?.child === forked) {
      removeFromKillQueue(activeTask.killFn);
      activeTask = null;
    }
    if (code === 0 && !signal && observers.hitCap) {
      maybeEnqueueAcoustid();
    }
    // Identity upgrades bump discovery.db's row_seq — publish them to the
    // network once the backlog drains (no-ops when p2p is off or nothing
    // moved; same hook as the embedding pass).
    if (code === 0 && !signal && observers.matched > 0
        && !taskQueue.some((t) => t.task === 'acoustid')) {
      import('../state/discovery-p2p.js')
        .then((p2p) => p2p.maybeAutoPublishSnapshot())
        .catch((err) => winston.warn(`discovery auto-publish after AcoustID pass failed: ${err.message}`));
    }
    nextTask();
    checkQueueDrainedSideEffects();
  };
  forked.on('error', (err) => {
    winston.error(`AcoustID pass failed to start: ${err.message}`);
    closeOnce(-1, null);
  });
  forked.on('close', (code, signal) => closeOnce(code, signal));
}

function launchJsScanner(scanObj, jsonLoad, library, { isFallback = false } = {}) {
  const forkedScan = launchWorker('scanner', SCANNER_SCRIPT_PATH, JSON.stringify(jsonLoad));
  winston.info(`File scan started${isFallback ? ' (JS fallback)' : ''} on ${library.root_path}`);
  // Record the child for the boot-time orphan reaper (covers shutdown
  // paths where no JS can run — Task Manager kill, SIGKILL). The forked
  // scanner's image is this node executable — far too generic to kill
  // on alone, so the scanner.mjs path rides along as the marker the
  // reaper must find in the live process's command line.
  if (Number.isInteger(forkedScan.pid)) {
    writeScannerPidfile(config.program.storage.dbDirectory, forkedScan.pid,
      process.execPath, 'js', workerReaperMarker('scanner', SCANNER_SCRIPT_PATH));
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
    // Undo the activeTask claim attachScanHandlers made for the rust
    // child so the retry/JS-fallback's attachScanHandlers can claim it
    // cleanly. Without this, the second attachScanHandlers would overwrite
    // the claim — which works in steady state, but the rust handle's killFn
    // would still be in the kill queue, leaking entries across scans.
    if (activeTask?.child === rustScan) {
      removeFromKillQueue(activeTask.killFn);
      activeTask = null;
    }
    // An unexecutable/incompatible shipped glibc binary can fail here too —
    // try the portable static-musl sibling before giving up on Rust.
    if (tryMuslRetry(scanObj, `failed to start (${err.code || 'ERR'}): ${err.message}`)) { return; }
    winston.warn(`Rust parser failed to start (${err.code || 'ERR'}), falling back to JS scanner: ${err.message}`);
    // Permission / ABI / exec errors don't resolve themselves — disable Rust
    // for the rest of this process lifetime so we don't retry every scan.
    rustParserDisabled = true;
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
      if (activeTask?.child === rustScan) {
        removeFromKillQueue(activeTask.killFn);
        activeTask = null;
      }
      clearScannerPidfile(config.program.storage.dbDirectory);
      // Most often the shipped glibc binary is simply too new for an older
      // host glibc (needs GLIBC_2.34); the static-musl build runs on any
      // libc, so try it before dropping to the ~16x-slower JS scanner.
      if (tryMuslRetry(scanObj, `died on arrival (exit ${code}, no output)`)) { return; }
      winston.error(
        `Rust parser died on arrival (exit ${code}, no output) — disabling it ` +
        'for this run and falling back to the JS scanner');
      rustParserDisabled = true;
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

  const forked = launchWorker('backup', BACKUP_WORKER_PATH, JSON.stringify(jsonLoad));
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
  // Enrichment passes don't count: the waveform pass never writes the DB
  // at all, and the art download pass writes one tiny transaction per
  // throttled lookup (~1/sec) — the library is fully browsable while
  // either runs, and a pass can legitimately take minutes. Reporting
  // them as "scanning" would keep the UI's scanning state (and anything
  // polling /db/status locked) busy for work that doesn't affect it.
  return activeTask !== null && !ENRICHMENT_KINDS.includes(activeTask.kind);
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
    // enrichment passes (waveform, albumart), so this is the only place
    // a dashboard can see one in flight.
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
