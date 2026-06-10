// Schema-version guard + orphan reaper.
//
// Guard: task-queue.js passes expectedSchemaVersion (the server's
// SCHEMA_VERSION) in the scanner payload; scanner.mjs refuses to touch a
// DB whose PRAGMA user_version differs, BEFORE preparing any statements
// or writing anything. Protects against half-migrated DBs, two server
// instances sharing a DB file, and migrations racing an orphaned scanner.
//
// Reaper: scan-pidfile.js records scanner children; boot kills a
// still-running orphan before opening the DB — but only when the pid is
// provably a scanner (a reused pid must never get an innocent process
// killed).

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import child from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MIGRATIONS, SCHEMA_VERSION } from '../src/db/schema.js';
import {
  writeScannerPidfile, clearScannerPidfile, reapOrphanedScanner,
} from '../src/db/scan-pidfile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCANNER = path.resolve(__dirname, '../src/db/scanner.mjs');

function makeTmp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `schema-guard-${label}-`));
}

// Fresh DB with every migration applied — the same bootstrap manager.js
// performs, minus winston/config wiring.
function makeDb(tmp) {
  const dbPath = path.join(tmp, 'test.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  for (const m of MIGRATIONS) {
    db.exec(m.sql);
    db.exec(`PRAGMA user_version = ${m.version}`);
  }
  return { db, dbPath };
}

// task-queue.js-shaped payload (see runScan's jsonLoad).
function scanPayload(tmp, dbPath, overrides = {}) {
  const musicDir = path.join(tmp, 'music');
  const artDir = path.join(tmp, 'art');
  fs.mkdirSync(musicDir, { recursive: true });
  fs.mkdirSync(artDir, { recursive: true });
  return {
    dbPath,
    libraryId: 1,
    vpath: 'testlib',
    directory: musicDir,
    skipImg: false,
    albumArtDirectory: artDir,
    scanId: 'guard-test-scan',
    compressImage: false,
    supportedFiles: { mp3: true, flac: true },
    scanCommitInterval: 25,
    forceRescan: false,
    followSymlinks: false,
    subtree: '',
    waveformCacheDir: '',
    expectedSchemaVersion: SCHEMA_VERSION,
    ...overrides,
  };
}

function runScanner(jsonLoad) {
  return new Promise((resolve) => {
    const p = child.fork(SCANNER, [JSON.stringify(jsonLoad)], { silent: true });
    let out = '';
    let errOut = '';
    p.stdout.on('data', d => { out += d.toString(); });
    p.stderr.on('data', d => { errOut += d.toString(); });
    p.on('close', code => resolve({ code, out, errOut }));
  });
}

async function waitFor(predicate, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) { return true; }
    await new Promise(r => setTimeout(r, 100));
  }
  return predicate();
}

describe('scanner schema-version guard', () => {
  test('refuses to scan when user_version differs — and writes nothing', async () => {
    const tmp = makeTmp('mismatch');
    const { db, dbPath } = makeDb(tmp);
    // Seed a library + a track with an old scan_id: exactly what the
    // stale sweep would delete if the guard failed to stop the scan.
    db.prepare('INSERT INTO libraries (id, name, root_path) VALUES (1, ?, ?)')
      .run('testlib', path.join(tmp, 'music'));
    db.prepare('INSERT INTO tracks (filepath, library_id, scan_id) VALUES (?, 1, ?)')
      .run('gone.mp3', 'previous-scan');
    db.close();

    const r = await runScanner(scanPayload(tmp, dbPath, {
      expectedSchemaVersion: SCHEMA_VERSION + 1,
    }));
    assert.strictEqual(r.code, 3, `expected guard exit 3, got ${r.code}\n${r.out}${r.errOut}`);
    assert.match(r.errOut, /refusing to scan/);
    assert.doesNotMatch(r.out, /scanComplete/);

    const check = new DatabaseSync(dbPath);
    const row = check.prepare('SELECT COUNT(*) AS n FROM tracks').get();
    check.close();
    assert.strictEqual(row.n, 1, 'guard exit must leave existing tracks untouched');
  });

  test('scans normally when the versions match', async () => {
    const tmp = makeTmp('match');
    const { db, dbPath } = makeDb(tmp);
    db.close();
    const r = await runScanner(scanPayload(tmp, dbPath));
    assert.strictEqual(r.code, 0, `expected clean exit, got ${r.code}\n${r.out}${r.errOut}`);
    assert.match(r.out, /scanComplete/);
  });

  test('payload from an older server (no expectedSchemaVersion) still scans', async () => {
    const tmp = makeTmp('legacy');
    const { db, dbPath } = makeDb(tmp);
    db.close();
    const payload = scanPayload(tmp, dbPath);
    delete payload.expectedSchemaVersion;
    const r = await runScanner(payload);
    assert.strictEqual(r.code, 0, `expected clean exit, got ${r.code}\n${r.out}${r.errOut}`);
    assert.match(r.out, /scanComplete/);
  });
});

describe('orphan reaper (scan-pidfile.js)', () => {
  test('pidfile round-trip: write then clear', () => {
    const tmp = makeTmp('roundtrip');
    writeScannerPidfile(tmp, 12345, 'rust-parser-test.exe', 'rust');
    assert.ok(fs.existsSync(path.join(tmp, '.scanner.pid.json')));
    clearScannerPidfile(tmp);
    assert.ok(!fs.existsSync(path.join(tmp, '.scanner.pid.json')));
  });

  test('dead pid: reap clears the file and touches nothing', async () => {
    const tmp = makeTmp('dead');
    // A pid guaranteed dead: spawn a no-op node and wait for it to exit.
    const p = child.spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise(r => p.on('exit', r));
    writeScannerPidfile(tmp, p.pid, process.execPath, 'js');
    reapOrphanedScanner(tmp);
    assert.ok(!fs.existsSync(path.join(tmp, '.scanner.pid.json')));
  });

  test('live pid that is NOT a scanner is left alone (pid-reuse safety)', async () => {
    const tmp = makeTmp('innocent');
    // A live node process whose image can't match the recorded rust
    // binary name — the reaper must refuse to kill it.
    const p = child.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      fs.writeFileSync(path.join(tmp, '.scanner.pid.json'), JSON.stringify({
        pid: p.pid, image: 'rust-parser-test.exe', kind: 'rust', startedAt: 'x',
      }));
      reapOrphanedScanner(tmp);
      assert.ok(!fs.existsSync(path.join(tmp, '.scanner.pid.json')), 'stale record is removed');
      // Give any wrongful kill a moment to land, then confirm survival.
      await new Promise(r => setTimeout(r, 300));
      assert.strictEqual(p.exitCode, null, 'innocent process must survive the reaper');
    } finally {
      try { p.kill(); } catch (_) { /* already dead */ }
    }
  });

  test('live child of THIS process is left alone, record kept (reboot path)', async () => {
    const tmp = makeTmp('reboot');
    // reboot() re-runs serveIt() — and so the reaper — in the same
    // process while a scan may still be running. writeScannerPidfile
    // records ppid = process.pid, so the reaper must treat the child as
    // managed (task-queue's onScanClose owns the record) and not kill it.
    const fakeScanner = path.join(tmp, 'scanner.mjs');
    fs.writeFileSync(fakeScanner, 'setInterval(() => {}, 1000);\n');
    const p = child.spawn(process.execPath, [fakeScanner], { stdio: 'ignore' });
    try {
      writeScannerPidfile(tmp, p.pid, process.execPath, 'js');
      reapOrphanedScanner(tmp);
      await new Promise(r => setTimeout(r, 300));
      assert.strictEqual(p.exitCode, null, 'own child must survive a same-process reap');
      assert.ok(fs.existsSync(path.join(tmp, '.scanner.pid.json')),
        'record must survive so onScanClose can clear it');
    } finally {
      try { p.kill(); } catch (_) { /* already dead */ }
    }
  });

  test('scan owned by ANOTHER live server instance is left alone', async () => {
    const tmp = makeTmp('sibling');
    // Two server instances sharing one dbDirectory: instance A is alive
    // and mid-scan when instance B boots and reaps. The recorded parent
    // (A) is alive, so B must not touch the scan OR the record — A's own
    // onScanClose owns the cleanup.
    const parentStandIn = child.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const fakeScanner = path.join(tmp, 'scanner.mjs');
    fs.writeFileSync(fakeScanner, 'setInterval(() => {}, 1000);\n');
    const scan = child.spawn(process.execPath, [fakeScanner], { stdio: 'ignore' });
    try {
      fs.writeFileSync(path.join(tmp, '.scanner.pid.json'), JSON.stringify({
        pid: scan.pid,
        ppid: parentStandIn.pid, // a live foreign "server"
        image: path.basename(process.execPath).toLowerCase(),
        kind: 'js',
        marker: fakeScanner,
        startedAt: 'x',
      }));
      reapOrphanedScanner(tmp);
      await new Promise(r => setTimeout(r, 300));
      assert.strictEqual(scan.exitCode, null, 'sibling instance\'s scan must survive');
      assert.ok(fs.existsSync(path.join(tmp, '.scanner.pid.json')),
        'record belongs to the living owner — must be kept');
    } finally {
      try { scan.kill(); } catch (_) { /* already dead */ }
      try { parentStandIn.kill(); } catch (_) { /* already dead */ }
    }
  });

  test('live orphaned JS scanner is killed', { timeout: 60000 }, async () => {
    const tmp = makeTmp('orphan');
    // A real "orphan": a node process running a file named scanner.mjs,
    // which is what the identity check requires before killing a
    // node-image pid. The recording server process is dead, so the file
    // is written by hand with a foreign ppid. (The command-line probe
    // shells out — on Windows via PowerShell CIM — hence the generous
    // timeout.)
    const fakeScanner = path.join(tmp, 'scanner.mjs');
    fs.writeFileSync(fakeScanner, 'setInterval(() => {}, 1000);\n');
    const p = child.spawn(process.execPath, [fakeScanner], { stdio: 'ignore' });
    try {
      fs.writeFileSync(path.join(tmp, '.scanner.pid.json'), JSON.stringify({
        pid: p.pid,
        ppid: 999999999, // the server that spawned it is long gone
        image: path.basename(process.execPath).toLowerCase(),
        kind: 'js',
        marker: fakeScanner,
        startedAt: 'x',
      }));
      reapOrphanedScanner(tmp);
      const died = await waitFor(() => p.exitCode !== null || p.signalCode !== null, 10000);
      assert.ok(died, 'orphaned scanner should be terminated by the reaper');
      assert.ok(!fs.existsSync(path.join(tmp, '.scanner.pid.json')));
    } finally {
      try { p.kill(); } catch (_) { /* already dead */ }
    }
  });
});

// ── UPSERT completeness parity ──────────────────────────────────────────────
// The track UPSERT only refreshes columns named in its DO UPDATE SET list —
// a column added to the INSERT list but forgotten in the SET list prepares
// and runs fine, but silently never updates on rescans of changed files
// (the old INSERT OR REPLACE rewrote everything). These tests parse both
// scanners' statements straight out of the source so that omission fails CI.

function parseUpsert(source, label) {
  const m = source.match(
    /INSERT INTO tracks \(([\s\S]*?)\)\s*\n\s*VALUES \(([\s\S]*?)\)\s*\n\s*ON CONFLICT\(filepath, library_id\) DO UPDATE SET([\s\S]*?)RETURNING id/,
  );
  assert.ok(m, `${label}: could not locate the tracks UPSERT statement`);
  const columns = m[1].split(',').map(s => s.trim()).filter(Boolean);
  const placeholders = m[2].split(',').map(s => s.trim()).filter(Boolean);
  const setColumns = [...m[3].matchAll(/(\w+)=excluded\.\1/g)].map(x => x[1]);
  return { columns, placeholders, setColumns };
}

describe('tracks UPSERT column parity (JS + Rust)', () => {
  const js = parseUpsert(
    fs.readFileSync(path.resolve(__dirname, '../src/db/scanner.mjs'), 'utf8'), 'scanner.mjs');
  const rust = parseUpsert(
    fs.readFileSync(path.resolve(__dirname, '../rust-parser/src/main.rs'), 'utf8'), 'main.rs');

  for (const [label, u] of [['scanner.mjs', js], ['main.rs', rust]]) {
    test(`${label}: every inserted column except the conflict target is in DO UPDATE SET`, () => {
      // filepath + library_id are the conflict target (never reassigned);
      // created_at is intentionally absent from BOTH lists (preserved).
      const missing = u.columns.filter(
        c => !['filepath', 'library_id'].includes(c) && !u.setColumns.includes(c));
      assert.deepEqual(missing, [],
        `${label}: columns inserted but never refreshed on conflict: ${missing.join(', ')}`);
      const stray = u.setColumns.filter(c => !u.columns.includes(c));
      assert.deepEqual(stray, [], `${label}: SET columns not in the insert list`);
      assert.equal(u.placeholders.length, u.columns.length,
        `${label}: ${u.columns.length} columns but ${u.placeholders.length} placeholders`);
      assert.ok(!u.columns.includes('created_at'),
        `${label}: created_at must not be written by the scanner (DB default preserves it)`);
    });
  }

  test('scanner.mjs and main.rs insert the same columns in the same order', () => {
    assert.deepEqual(js.columns, rust.columns);
    assert.deepEqual(js.setColumns, rust.setColumns);
  });
});
