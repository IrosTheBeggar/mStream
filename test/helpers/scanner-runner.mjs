/**
 * Direct-invocation scanner harness for parity testing.
 *
 * The full server harness (test/helpers/server.mjs) drags in auth, HTTP
 * routes, the playlist cleanup timer, etc. — overkill when we just want
 * to ask "did the scanner produce the same DB twice in a row?". This
 * helper wraps the rust-parser binary in the same JSON-config contract
 * that task-queue.js uses, but skipping every other moving part.
 *
 * Each `runScan` call:
 *   1. Wipes any prior tracks/scan_progress state (callers can reuse a
 *      DB across runs to compare incremental rescans).
 *   2. Spawns rust-parser with a JSON config pointed at the supplied
 *      library directory.
 *   3. Resolves once the binary prints its `scanComplete` event on
 *      stdout (same contract task-queue.js parses).
 *
 * Schema initialisation lives in `initEmptyDb` — it walks the same
 * MIGRATIONS array the production initDB uses, so the test DB is byte-
 * compatible with what the scanner expects on a real install.
 */

import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../../src/db/schema.js';
import { applyAllMigrations } from './apply-migrations.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Same lookup order as audio-hash-parity.test.mjs — prefer a freshly
// built dev binary, fall back to the prebuilt one shipped under
// bin/rust-parser/. Tests skip cleanly when neither exists.
export function findRustParser() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const libc = process.platform === 'linux' ? '-musl' : '';
  const candidates = [
    path.join(REPO_ROOT, 'rust-parser', 'target', 'release', `rust-parser${ext}`),
    path.join(REPO_ROOT, 'bin', 'rust-parser',
      `rust-parser-${process.platform}-${process.arch}${libc}${ext}`),
  ].filter(p => fs.existsSync(p));

  for (const bin of candidates) {
    try {
      // Probe with a known-good subcommand whose absence indicates a
      // stale binary that predates this change. Same trick as
      // audio-hash-parity.test.mjs.
      const r = spawnSync(bin, ['--audio-hash', path.join(REPO_ROOT, 'NONEXISTENT_PROBE_FILE')],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
      const stderr = (r.stderr || '').toString();
      if (!/Invalid JSON Input/.test(stderr)) { return bin; }
    } catch (_) { /* try next */ }
  }
  return null;
}

export const FFMPEG = process.platform === 'win32'
  ? path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg.exe')
  : path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg');

// Apply every schema migration to a fresh DB, then seed a single
// library row whose vpath/root_path the scanner will use.
export function initEmptyDb(dbPath, libraryRoot, vpath = 'testlib') {
  // Remove any existing file (and its WAL siblings) so each test
  // starts from a known-empty state.
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch (_) { /* ok */ }
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  // V34 introduced procedural migrations — see apply-migrations.mjs.
  applyAllMigrations(db);

  db.prepare('INSERT INTO libraries (name, root_path, type) VALUES (?, ?, ?)')
    .run(vpath, libraryRoot, 'music');

  const lib = db.prepare('SELECT id FROM libraries WHERE name = ?').get(vpath);
  db.close();
  return { libraryId: lib.id, vpath };
}

// Default config matches what task-queue.js builds for a real scan,
// minus the bits the scanner doesn't need for a parity test (lastfm,
// etc.). Override any field via the `overrides` argument.
export function buildScanConfig({
  dbPath, libraryId, vpath, directory,
  albumArtDirectory, waveformCacheDir, scanId,
  overrides = {},
}) {
  return {
    dbPath, libraryId, vpath, directory,
    albumArtDirectory, waveformCacheDir, scanId,
    skipImg: false,
    compressImage: false,                  // skip image resize — flaky timing
    forceRescan: false,
    followSymlinks: false,
    scanCommitInterval: 25,
    supportedFiles: {
      mp3: true, flac: true, wav: true, ogg: true,
      aac: true, m4a: true, m4b: true, opus: true, m3u: false,
    },
    ...overrides,
  };
}

// Spawn the binary, collect stdout, resolve when scanComplete arrives.
// Rejects on non-zero exit OR on a 60s timeout (a real scan of a
// 50-file fixture should take well under 5s).
export function runScan(rustBin, config) {
  return runScanProcess(rustBin, [JSON.stringify(config)]);
}

// Same contract, driving the JS fallback scanner instead — it speaks the
// identical JSON-argv + scanComplete-on-stdout protocol (task-queue.js
// parses both the same way), so the art parity tests can run BOTH
// scanners over one fixture and diff the snapshots.
export function runJsScan(config) {
  return runScanProcess(process.execPath,
    [path.join(REPO_ROOT, 'src', 'db', 'scanner.mjs'), JSON.stringify(config)]);
}

function runScanProcess(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args,
      { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let done = false;

    const finish = (err, value) => {
      if (done) { return; }
      done = true;
      clearTimeout(timer);
      if (err) { reject(err); } else { resolve(value); }
    };

    const timer = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch (_) { /* already dead */ }
      finish(new Error(`scan timed out after 60s\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
    }, 60_000);

    p.stdout.on('data', d => { stdout += d.toString(); });
    p.stderr.on('data', d => { stderr += d.toString(); });
    p.on('error', err => finish(err));
    p.on('exit', code => {
      if (code !== 0) {
        return finish(new Error(`scanner exit ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
      }
      // Find the scanComplete event line — task-queue.js does the
      // same parse. The final line of stdout is the most reliable
      // place to look (other lines are progress prints).
      const evt = stdout.split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .reverse()
        .find(l => l.startsWith('{') && l.includes('"scanComplete"'));
      if (!evt) {
        return finish(new Error(`no scanComplete event in stdout:\n${stdout}\nSTDERR:\n${stderr}`));
      }
      try {
        finish(null, { event: JSON.parse(evt), stdout, stderr });
      } catch (err) {
        finish(new Error(`bad scanComplete JSON: ${evt}: ${err.message}`));
      }
    });
  });
}

// List of `.bin` filenames in the waveform cache dir (sorted).
// Equivalent of "snapshot" for waveform output — file contents are
// covered by waveform.test.mjs, so we only verify the *set* matches.
export async function waveformFilenames(waveformCacheDir) {
  try {
    const names = await fsp.readdir(waveformCacheDir);
    return names.filter(n => n.endsWith('.bin')).sort();
  } catch (err) {
    if (err.code === 'ENOENT') { return []; }
    throw err;
  }
}
