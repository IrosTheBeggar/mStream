import child from 'child_process';
import fs from 'fs';
import path from 'path';
import winston from 'winston';
import { newId } from '../util/ids.js';
import * as config from '../state/config.js';
import * as db from './manager.js';
import { addToKillQueue, removeFromKillQueue } from '../state/kill-list.js';
import { getDirname } from '../util/esm-helpers.js';
import * as dlnaApi from '../api/dlna.js';

const __dirname = getDirname(import.meta.url);

const taskQueue = [];
const runningTasks = new Set();
const vpathLimiter = new Set();
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

// ── Scan task management ────────────────────────────────────────────────────

function addScanTask(vpath, forceRescan = false) {
  const scanObj = { task: 'scan', vpath: vpath, id: newId(8), forceRescan };
  if (runningTasks.size < config.program.scanOptions.maxConcurrentTasks) {
    runScan(scanObj);
  } else {
    taskQueue.push(scanObj);
  }
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

function nextTask() {
  if (
    taskQueue.length > 0
    && runningTasks.size < config.program.scanOptions.maxConcurrentTasks
    && !vpathLimiter.has(taskQueue[taskQueue.length - 1].vpath)
  ) {
    runScan(taskQueue.pop());
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
  vpathLimiter.add(scanObj.vpath);

  // Ensure scanner is killed on server shutdown; keep a handle so we can
  // drop the entry from the kill queue when the process exits cleanly —
  // otherwise the queue would grow unbounded across scheduled scans.
  const killFn = () => { try { forkedScan.kill(); } catch (_) {} };
  forkedScan._killFn = killFn;
  addToKillQueue(killFn);

  // Line-buffer stdout so structured JSON events parse cleanly regardless
  // of how the OS chunks the pipe data.
  let stdoutBuffer = '';
  forkedScan.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      handleScannerLine(line.trim());
    }
  });
  forkedScan.stdout.on('end', () => {
    if (stdoutBuffer.trim()) { handleScannerLine(stdoutBuffer.trim()); }
    stdoutBuffer = '';
  });

  // Line-buffer stderr the same way as stdout. Scanner lines prefixed with
  // "Warning:" are recoverable (metadata parse failures fall back to null
  // tags; the track still gets indexed) and are logged at warn level so a
  // library with malformed ID3 tags doesn't flood error-level log streams.
  // Anything else on stderr is treated as a real error.
  let stderrBuffer = '';
  const handleStderrLine = (line) => {
    if (!line) { return; }
    if (line.startsWith('Warning:')) {
      winston.warn(`File scan: ${line}`);
    } else {
      winston.error(`File scan error: ${line}`);
    }
  };
  forkedScan.stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString();
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop() || '';
    for (const line of lines) {
      handleStderrLine(line.trim());
    }
  });
  forkedScan.stderr.on('end', () => {
    if (stderrBuffer.trim()) { handleStderrLine(stderrBuffer.trim()); }
    stderrBuffer = '';
  });
}

function onScanClose(forkedScan, scanObj, code) {
  winston.info(`File scan completed with code ${code}`);
  runningTasks.delete(forkedScan);
  vpathLimiter.delete(scanObj.vpath);
  if (forkedScan._killFn) { removeFromKillQueue(forkedScan._killFn); }

  // Clean up progress row (scanner should have deleted it, but handle crashes)
  try {
    db.getDB()?.prepare('DELETE FROM scan_progress WHERE scan_id = ?').run(scanObj.id);
  } catch (_) {}

  nextTask();

  const queueDrained = runningTasks.size === 0 && taskQueue.length === 0;

  // When all scans are done, bump DLNA's SystemUpdateID so control points
  // refresh their caches — but only if some scan actually changed the DB.
  // Safe to call whether or not DLNA is enabled.
  if (queueDrained && anyScansChanged) {
    anyScansChanged = false;
    dlnaApi.bumpSystemUpdateID();
  }

  // Clear the migration rescan marker only after every queued library
  // has finished. If the process dies before this point, the marker
  // survives on disk and the next boot re-triggers rescanAll() — the
  // alternative (unlinking up-front at boot) silently strands the DB
  // on pre-rescan row shapes when the scan crashes partway through.
  if (queueDrained && bootRescanInFlight) {
    bootRescanInFlight = false;
    if (bootRescanMarkerPath) {
      try {
        fs.unlinkSync(bootRescanMarkerPath);
        winston.info('Migration rescan complete — cleared .rescan-pending marker');
      } catch (err) {
        // ENOENT is fine (another code path cleared it, or marker already absent);
        // anything else means the marker might live on and re-trigger next boot.
        // Logging at warn so operators can notice a stuck marker.
        if (err.code !== 'ENOENT') {
          winston.warn(`Could not clear .rescan-pending marker at ${bootRescanMarkerPath}: ${err.message}`);
        }
      }
      bootRescanMarkerPath = null;
    }
  }
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
    waveformCacheDir: config.program.storage.waveformCacheDirectory,
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
    runningTasks.delete(rustScan);
    if (rustScan._killFn) { removeFromKillQueue(rustScan._killFn); }
    launchJsScanner(scanObj, jsonLoad, library, { isFallback: true });
  });

  attachScanHandlers(rustScan, scanObj);
  rustScan.on('close', (code) => {
    if (fellBack) { return; }
    onScanClose(rustScan, scanObj, code);
  });
}

// ── Public API ──────────────────────────────────────────────────────────────

export function scanVPath(vPath) {
  addScanTask(vPath);
}

export { scanAll, rescanAll };

export function isScanning() {
  return runningTasks.size > 0;
}

export function getAdminStats() {
  return {
    taskQueue,
    vpaths: [...vpathLimiter]
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
