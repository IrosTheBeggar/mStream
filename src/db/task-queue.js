import child from 'child_process';
import fs from 'fs';
import path from 'path';
import winston from 'winston';
import { nanoid } from 'nanoid';
import * as config from '../state/config.js';
import * as db from './manager.js';
import { addToKillQueue } from '../state/kill-list.js';
import { getDirname } from '../util/esm-helpers.js';

const __dirname = getDirname(import.meta.url);

const taskQueue = [];
const runningTasks = new Set();
const vpathLimiter = new Set();
let scanIntervalTimer = null;

// ── Rust parser binary detection ────────────────────────────────────────────

const ext = process.platform === 'win32' ? '.exe' : '';
const rustParserDir = path.join(__dirname, '../../rust-parser');
const prebuiltBin = path.join(__dirname, `../../bin/rust-parser/rust-parser-${process.platform}-${process.arch}${ext}`);
const localBuildBin = path.join(rustParserDir, `target/release/rust-parser${ext}`);
let rustParserBin = null;
let rustBinaryReady = false;

function findRustParser() {
  if (rustBinaryReady) { return true; }
  // Check local build first (may be newer than prebuilt during development)
  if (fs.existsSync(localBuildBin)) { rustParserBin = localBuildBin; rustBinaryReady = true; return true; }
  if (fs.existsSync(prebuiltBin)) { rustParserBin = prebuiltBin; rustBinaryReady = true; return true; }

  // Try to build from source
  winston.info('Rust parser binary not found — building from source...');
  try {
    child.execSync('cargo build --release', { cwd: rustParserDir, stdio: 'pipe', timeout: 300000 });
    if (fs.existsSync(localBuildBin)) {
      rustParserBin = localBuildBin;
      rustBinaryReady = true;
      winston.info('Rust parser built successfully');
      return true;
    }
  } catch (err) {
    winston.warn(`Failed to build Rust parser: ${err.message}. Falling back to JS parser.`);
  }
  return false;
}

// ── Subdirectory filtering ──────────────────────────────────────────────────

function filterSubdirectoryVpaths(libraries) {
  const normalized = libraries.map(lib => ({
    ...lib,
    _normalRoot: path.resolve(lib.root_path) + path.sep
  }));

  return normalized.filter((lib, _i, all) => {
    return !all.some(other =>
      other.name !== lib.name
      && lib._normalRoot.startsWith(other._normalRoot)
      && lib._normalRoot !== other._normalRoot
    );
  });
}

function isSubdirectoryOfExistingVpath(directory) {
  const normalDir = path.resolve(directory) + path.sep;
  const libraries = db.getAllLibraries();
  for (const lib of libraries) {
    const normalRoot = path.resolve(lib.root_path) + path.sep;
    if (normalDir.startsWith(normalRoot) && normalDir !== normalRoot) {
      return true;
    }
  }
  return false;
}

// ── Scan task management ────────────────────────────────────────────────────

function addScanTask(vpath, forceRescan = false) {
  const scanObj = { task: 'scan', vpath: vpath, id: nanoid(8), forceRescan };
  if (runningTasks.size < config.program.scanOptions.maxConcurrentTasks) {
    runScan(scanObj);
  } else {
    taskQueue.push(scanObj);
  }
}

function scanAll() {
  const libraries = filterSubdirectoryVpaths(db.getAllLibraries());
  for (const lib of libraries) {
    addScanTask(lib.name);
  }
}

function rescanAll() {
  const libraries = filterSubdirectoryVpaths(db.getAllLibraries());
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
    scanBatchSize: config.program.scanOptions.scanBatchSize || 100,
    forceRescan: scanObj.forceRescan || false
  };

  let forkedScan;
  const useRust = findRustParser();
  if (useRust) {
    forkedScan = child.spawn(rustParserBin, [JSON.stringify(jsonLoad)], { stdio: ['ignore', 'pipe', 'pipe'] });
    winston.info(`File scan started (Rust) on ${library.root_path}`);
    forkedScan.on('error', (err) => {
      winston.error(`Rust parser failed to start: ${err.message}`);
      runningTasks.delete(forkedScan);
      vpathLimiter.delete(scanObj.vpath);
      nextTask();
    });
  } else {
    forkedScan = child.fork(path.join(__dirname, './scanner.mjs'), [JSON.stringify(jsonLoad)], { silent: true });
    winston.info(`File scan started on ${library.root_path}`);
  }

  runningTasks.add(forkedScan);
  vpathLimiter.add(scanObj.vpath);

  // Ensure scanner is killed on server shutdown
  addToKillQueue(() => { try { forkedScan.kill(); } catch (_) {} });

  forkedScan.stdout.on('data', (data) => {
    winston.info(data.toString().trim());
  });

  forkedScan.stderr.on('data', (data) => {
    winston.error(`File scan error: ${data}`);
  });

  forkedScan.on('close', (code) => {
    winston.info(`File scan completed with code ${code}`);
    runningTasks.delete(forkedScan);
    vpathLimiter.delete(scanObj.vpath);

    // Clean up progress row (scanner should have deleted it, but handle crashes)
    try {
      db.getDB()?.prepare('DELETE FROM scan_progress WHERE scan_id = ?').run(scanObj.id);
    } catch (_) {}

    nextTask();
  });
}

// ── Public API ──────────────────────────────────────────────────────────────

export function scanVPath(vPath) {
  addScanTask(vPath);
}

export { scanAll, rescanAll, isSubdirectoryOfExistingVpath };

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

  // Check if a migration flagged a force rescan
  const markerPath = path.join(config.program.storage.dbDirectory, '.rescan-pending');
  let pendingRescan = false;
  try {
    if (fs.existsSync(markerPath)) {
      pendingRescan = true;
      fs.unlinkSync(markerPath);
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
