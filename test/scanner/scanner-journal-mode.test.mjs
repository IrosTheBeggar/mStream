/**
 * The scanners inherit the database's journal mode instead of forcing WAL.
 *
 * The server picks the mode (src/db/journal-mode.js): WAL, or DELETE where
 * file locks can't keep its processes apart — Docker Desktop bind mounts.
 * The mode lives in the database header, so a scanner that ran
 * `PRAGMA journal_mode = WAL` on open would flip such a database straight
 * back into the mode that loses writes there. Both scanners must scan a
 * DELETE database and leave it DELETE, and keep a WAL database WAL.
 *
 * The enrichment workers open the same way (no journal_mode); the source
 * guard below keeps every process but the server from setting one.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  findRustParser, rustParserIsStale, initEmptyDb, buildScanConfig, runScan, runJsScan,
} from '../helpers/scanner-runner.mjs';
import { makeAudio } from '../helpers/scanner-fixture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MP3 = ['-c:a', 'libmp3lame', '-b:a', '64k', '-id3v2_version', '3'];

const rustBin = findRustParser();
const rustSkip = !rustBin ? 'rust-parser binary not found'
  : rustParserIsStale(rustBin) ? 'prebuilt rust-parser predates this source (CI builds it)'
    : false;

let root;
let libDir;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-journal-mode-'));
  libDir = path.join(root, 'music');
  await makeAudio(path.join(libDir, 'one.mp3'), MP3,
    { title: 'One', artist: 'Journal Test', album: 'Modes' });
  await makeAudio(path.join(libDir, 'two.mp3'), MP3,
    { title: 'Two', artist: 'Journal Test', album: 'Modes' });
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function freshDb(name, mode) {
  const dbPath = path.join(root, `${name}.db`);
  const { libraryId, vpath } = initEmptyDb(dbPath, libDir);
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode = ${mode}`);
  db.close();
  return { dbPath, libraryId, vpath };
}

function scanConfig({ dbPath, libraryId, vpath }, name) {
  return buildScanConfig({
    dbPath, libraryId, vpath, directory: libDir,
    albumArtDirectory: path.join(root, `${name}-art`),
    waveformCacheDir: '',
    scanId: `journal-${name}`,
  });
}

function inspect(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    return {
      mode: db.prepare('PRAGMA journal_mode').get().journal_mode,
      tracks: db.prepare('SELECT count(*) AS n FROM tracks').get().n,
    };
  } finally { db.close(); }
}

const engines = [
  ['js', false, (cfg) => runJsScan(cfg)],
  ['rust', rustSkip, (cfg) => runScan(rustBin, cfg)],
];

for (const [engine, skip, scan] of engines) {
  describe(`${engine} scanner`, { skip }, () => {
    for (const mode of ['DELETE', 'WAL']) {
      test(`scans a ${mode} database and leaves it ${mode}`, async () => {
        const name = `${engine}-${mode.toLowerCase()}`;
        const target = freshDb(name, mode);
        await scan(scanConfig(target, name));
        const after = inspect(target.dbPath);
        assert.equal(after.mode, mode.toLowerCase());
        assert.equal(after.tracks, 2);
        if (mode === 'DELETE') { assert.equal(fs.existsSync(`${target.dbPath}-wal`), false); }
      });
    }
  });
}

// Every process but the server inherits the mode; only journal-mode.js may
// set one. A new worker that copies the old `PRAGMA journal_mode = WAL`
// opener would silently re-enable the mode that loses writes on Docker
// Desktop bind mounts.
test('only src/db/journal-mode.js sets a journal mode', () => {
  const offenders = [];
  const setter = /PRAGMA\s+(\w+\.)?journal_mode\s*=/i;
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (!/\.(m?js|rs)$/.test(ent.name)) { continue; }
      if (p === path.join(REPO_ROOT, 'src', 'db', 'journal-mode.js')) { continue; }
      fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        if (setter.test(code)) { offenders.push(`${path.relative(REPO_ROOT, p)}:${i + 1}`); }
      });
    }
  };
  walk(path.join(REPO_ROOT, 'src'));
  walk(path.join(REPO_ROOT, 'rust-parser', 'src'));
  assert.deepEqual(offenders, []);
});
