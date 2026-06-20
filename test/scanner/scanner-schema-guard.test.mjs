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

import { MIGRATIONS, SCHEMA_VERSION } from '../../src/db/schema.js';
import {
  writeScannerPidfile, clearScannerPidfile, reapOrphanedScanner,
} from '../../src/db/scan-pidfile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCANNER = path.resolve(__dirname, '../../src/db/scanner.mjs');

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

describe('stale sweep verify-absence (deleteStaleTracks)', () => {
  // Candidates as the scanner derives them: the scan-start snapshot minus
  // the seen-set. These tests pass every row (an empty seen-set —
  // simulating a scan that failed to account for any of them).
  const allCandidates = (db) => db.prepare(
    'SELECT id, filepath FROM tracks WHERE library_id = 1 ORDER BY id').all();

  // The sweep must only delete rows whose file is PROVABLY gone — a row
  // missing from the seen-set alone is not proof (swallowed per-file
  // errors leave live tracks unseen). Rows with a living file are kept.
  test('keeps unseen rows whose file still exists; deletes only truly-gone files', async () => {
    const { deleteStaleTracks } = await import('../../src/db/orphan-cleanup.js');
    const tmp = makeTmp('verify-absence');
    const lib = path.join(tmp, 'music');
    fs.mkdirSync(lib, { recursive: true });
    fs.writeFileSync(path.join(lib, 'alive.mp3'), 'x');
    // 'gone.mp3' intentionally not created.
    const { db, dbPath } = makeDb(tmp);
    db.prepare('INSERT INTO libraries (id, name, root_path) VALUES (1, ?, ?)').run('lib', lib);
    const ins = db.prepare(
      'INSERT INTO tracks (filepath, library_id, scan_id, modified) VALUES (?, 1, ?, 1)');
    ins.run('alive.mp3', 'ancient'); // unseen but file exists — a swallowed error victim
    ins.run('gone.mp3', 'ancient');  // unseen and file gone — genuinely stale

    const deleted = deleteStaleTracks(db, allCandidates(db), SCHEMA_VERSION,
      { libraryRoot: lib, followSymlinks: false });
    assert.strictEqual(deleted, 1, 'only the file that is really gone gets deleted');
    // Spread into plain objects: node:sqlite rows have a null prototype,
    // which deepStrictEqual treats as a mismatch against object literals.
    const rows = db.prepare('SELECT filepath, scan_id FROM tracks ORDER BY filepath')
      .all().map(r => ({ ...r }));
    db.close();
    // Kept rows are untouched — no marker write. The candidate list lives
    // in the scanner's memory and dies with the scan; the next scan just
    // re-derives it.
    assert.deepStrictEqual(rows, [{ filepath: 'alive.mp3', scan_id: 'ancient' }],
      'the living file survives with its row untouched');

    // A second sweep re-examines the kept row (still a candidate) but
    // keeps it again and deletes nothing.
    const check = new DatabaseSync(dbPath);
    const again = deleteStaleTracks(check, allCandidates(check), SCHEMA_VERSION,
      { libraryRoot: lib, followSymlinks: false });
    check.close();
    assert.strictEqual(again, 0);
  });

  test('failed-walk prefixes shield rows; unverifiable listings are left untouched', async () => {
    const { deleteStaleTracks } = await import('../../src/db/orphan-cleanup.js');
    const tmp = makeTmp('shield');
    const lib = path.join(tmp, 'music');
    fs.mkdirSync(path.join(lib, 'ok'), { recursive: true });
    // 'broken' dir intentionally NOT created — but its rows are shielded
    // by the walk-error prefix, so they must survive even though a
    // listing would say the directory is gone.
    const { db } = makeDb(tmp);
    db.prepare('INSERT INTO libraries (id, name, root_path) VALUES (1, ?, ?)').run('lib', lib);
    const ins = db.prepare(
      'INSERT INTO tracks (filepath, library_id, scan_id, modified) VALUES (?, 1, ?, 1)');
    ins.run('broken/one.mp3', 'ancient');
    ins.run('broken/two.mp3', 'ancient');
    ins.run('ok/gone.mp3', 'ancient'); // dir exists, file doesn't — genuinely stale

    const deleted = deleteStaleTracks(db, allCandidates(db), SCHEMA_VERSION,
      { libraryRoot: lib, followSymlinks: false, failedWalkPrefixes: ['broken'] });
    assert.strictEqual(deleted, 1, 'only the verifiable-and-gone row is deleted');
    const rows = db.prepare('SELECT filepath, scan_id FROM tracks ORDER BY filepath')
      .all().map(r => ({ ...r }));
    db.close();
    assert.deepStrictEqual(rows, [
      // Shielded rows are untouched.
      { filepath: 'broken/one.mp3', scan_id: 'ancient' },
      { filepath: 'broken/two.mp3', scan_id: 'ancient' },
    ]);
  });

  test('case-only rename converges: old-casing row is deleted (exact-name listing match)', async () => {
    const { deleteStaleTracks } = await import('../../src/db/orphan-cleanup.js');
    const tmp = makeTmp('case');
    const lib = path.join(tmp, 'music');
    fs.mkdirSync(lib, { recursive: true });
    fs.writeFileSync(path.join(lib, 'Track.mp3'), 'x'); // on-disk casing
    const { db } = makeDb(tmp);
    db.prepare('INSERT INTO libraries (id, name, root_path) VALUES (1, ?, ?)').run('lib', lib);
    db.prepare('INSERT INTO tracks (filepath, library_id, scan_id, modified) VALUES (?, 1, ?, 1)')
      .run('TRACK.mp3', 'ancient'); // stale row under the OLD casing
    // A per-file stat would hit case-insensitively on Windows and keep
    // resurrecting this row forever; the listing compares exact names.
    const deleted = deleteStaleTracks(db, allCandidates(db), SCHEMA_VERSION,
      { libraryRoot: lib, followSymlinks: false });
    const n = db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n;
    db.close();
    assert.strictEqual(deleted, 1);
    assert.strictEqual(n, 0);
  });

  test('symlink semantics: under followSymlinks=false a symlinked file counts as absent', async (t) => {
    const { deleteStaleTracks } = await import('../../src/db/orphan-cleanup.js');
    const tmp = makeTmp('symlink-absence');
    const lib = path.join(tmp, 'music');
    fs.mkdirSync(lib, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'target.mp3'), 'x');
    try {
      fs.symlinkSync(path.join(tmp, 'target.mp3'), path.join(lib, 'linked.mp3'), 'file');
    } catch (_err) {
      t.skip('symlink creation not permitted (needs Windows Developer Mode or admin)');
      return;
    }
    const { db } = makeDb(tmp);
    db.prepare('INSERT INTO libraries (id, name, root_path) VALUES (1, ?, ?)').run('lib', lib);
    db.prepare('INSERT INTO tracks (filepath, library_id, scan_id, modified) VALUES (?, 1, ?, 1)')
      .run('linked.mp3', 'ancient');
    // followSymlinks=false: the walk would not index this entry, so the
    // sweep must agree it is "absent" and delete the row...
    const deletedNoFollow = deleteStaleTracks(db, allCandidates(db), SCHEMA_VERSION,
      { libraryRoot: lib, followSymlinks: false });
    assert.strictEqual(deletedNoFollow, 1);
    // ...while followSymlinks=true treats it as present (kept untouched).
    db.prepare('INSERT INTO tracks (filepath, library_id, scan_id, modified) VALUES (?, 1, ?, 1)')
      .run('linked.mp3', 'ancient');
    const deletedFollow = deleteStaleTracks(db, allCandidates(db), SCHEMA_VERSION,
      { libraryRoot: lib, followSymlinks: true });
    assert.strictEqual(deletedFollow, 0);
    const row = db.prepare('SELECT scan_id FROM tracks WHERE filepath = ?').get('linked.mp3');
    db.close();
    assert.strictEqual(row.scan_id, 'ancient');
  });

  test('V46 repairs REAL-poisoned mtime columns exactly, leaves healthy rows alone', () => {
    const tmp = makeTmp('v46');
    const dbPath = path.join(tmp, 't.db');
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    // Build the world as it was BEFORE the repair migration...
    for (const m of MIGRATIONS.filter(m => m.version <= 45)) {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
    }
    db.prepare("INSERT INTO libraries (id, name, root_path) VALUES (1, 'l', 'x')").run();
    // ...poison it the way old JS scanners did (fractional mtimeMs → REAL)...
    db.exec(`INSERT INTO tracks (filepath, library_id, scan_id, modified, lyrics_sidecar_mtime)
             VALUES ('poisoned.mp3', 1, 's', 1781126455012.999, 1781126455012.123)`);
    db.exec(`INSERT INTO tracks (filepath, library_id, scan_id, modified, lyrics_sidecar_mtime)
             VALUES ('healthy.mp3', 1, 's', 1781126455012, NULL)`);
    // ...then apply the rest of the migrations (V46).
    for (const m of MIGRATIONS.filter(m => m.version > 45)) {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
    }
    const rows = db.prepare(
      `SELECT filepath, modified, typeof(modified) AS tm,
              lyrics_sidecar_mtime AS lsm, typeof(lyrics_sidecar_mtime) AS tl
         FROM tracks ORDER BY filepath`).all().map(r => ({ ...r }));
    db.close();
    assert.deepStrictEqual(rows, [
      { filepath: 'healthy.mp3', modified: 1781126455012, tm: 'integer', lsm: null, tl: 'null' },
      { filepath: 'poisoned.mp3', modified: 1781126455012, tm: 'integer', lsm: 1781126455012, tl: 'integer' },
    ]);
  });
});

// ── Symlink-cycle termination ───────────────────────────────────────────────
// With followSymlinks on, a directory symlink pointing at an ancestor is an
// infinite walk without protection. The JS scanner breaks cycles via a
// visited-realpath set (collectFiles); the Rust scanner gets ancestor-loop
// detection from walkdir. Neither had a regression test — a removed guard
// would only show up as a stack overflow in production.
describe('symlink cycle termination (followSymlinks=true)', () => {
  function buildCycleLib(tmp) {
    const lib = path.join(tmp, 'music');
    fs.mkdirSync(path.join(lib, 'a'), { recursive: true });
    fs.mkdirSync(path.join(lib, 'b'), { recursive: true });
    // Corrupt-but-walkable "mp3"s: the walk visits and indexes them with
    // null tags, which is all a termination + exactly-once test needs.
    fs.writeFileSync(path.join(lib, 'a', 'one.mp3'), Buffer.alloc(64, 1));
    fs.writeFileSync(path.join(lib, 'a', 'two.mp3'), Buffer.alloc(64, 2));
    fs.writeFileSync(path.join(lib, 'b', 'three.mp3'), Buffer.alloc(64, 3));
    // The cycle: lib/a/loop -> lib (an ANCESTOR). Directory symlinks need
    // Developer Mode on Windows; junctions don't — Node and walkdir both
    // treat junctions as symlinks, so fall back to one.
    const loop = path.join(lib, 'a', 'loop');
    try {
      fs.symlinkSync(lib, loop, 'dir');
    } catch (_err) {
      try { fs.symlinkSync(lib, loop, 'junction'); }
      catch (_err2) { return null; }
    }
    return lib;
  }

  test('JS scanner terminates and indexes each file exactly once', { timeout: 60000 }, async (t) => {
    const tmp = makeTmp('cycle-js');
    const lib = buildCycleLib(tmp);
    if (lib === null) { t.skip('symlink/junction creation not permitted'); return; }
    const { db, dbPath } = makeDb(tmp);
    db.prepare('INSERT INTO libraries (id, name, root_path) VALUES (1, ?, ?)').run('lib', lib);
    db.close();
    const r = await runScanner(scanPayload(tmp, dbPath, {
      directory: lib,
      followSymlinks: true,
    }));
    // The real assertion is that we get here at all: a regressed cycle
    // guard recurses until stack exhaustion (non-zero exit) or hangs
    // (test timeout).
    assert.strictEqual(r.code, 0, `expected termination with exit 0, got ${r.code}\n${r.errOut}`);
    const check = new DatabaseSync(dbPath);
    const rows = check.prepare('SELECT filepath FROM tracks ORDER BY filepath').all().map(x => x.filepath);
    check.close();
    assert.strictEqual(rows.length, 3,
      `each file indexed exactly once (no loop-path duplicates); got ${JSON.stringify(rows)}`);
    assert.strictEqual(new Set(rows).size, 3);
  });

  test('Rust scanner terminates and indexes each file exactly once', { timeout: 60000 }, async (t) => {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const rustBin = [
      path.resolve(__dirname, `../../rust-parser/target/release/rust-parser${ext}`),
      path.resolve(__dirname, `../../bin/rust-parser/rust-parser-${process.platform}-${process.arch}${ext}`),
    ].find(p => fs.existsSync(p));
    if (!rustBin) { t.skip('no rust-parser binary available'); return; }
    const tmp = makeTmp('cycle-rust');
    const lib = buildCycleLib(tmp);
    if (lib === null) { t.skip('symlink/junction creation not permitted'); return; }
    const { db, dbPath } = makeDb(tmp);
    db.prepare('INSERT INTO libraries (id, name, root_path) VALUES (1, ?, ?)').run('lib', lib);
    db.close();
    const payload = scanPayload(tmp, dbPath, {
      directory: lib,
      followSymlinks: true,
      scanThreads: 1,
      analyzeBpm: false,
    });
    const r = await new Promise((resolve) => {
      const p = child.spawn(rustBin, [JSON.stringify(payload)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; let errOut = '';
      p.stdout.on('data', d => { out += d.toString(); });
      p.stderr.on('data', d => { errOut += d.toString(); });
      p.on('close', code => resolve({ code, out, errOut }));
    });
    assert.strictEqual(r.code, 0, `expected termination with exit 0, got ${r.code}\n${r.errOut}`);
    const check = new DatabaseSync(dbPath);
    const rows = check.prepare('SELECT filepath FROM tracks').all();
    check.close();
    assert.strictEqual(rows.length, 3,
      `each file indexed exactly once; got ${JSON.stringify(rows.map(x => x.filepath))}`);
  });
});

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
  // Two accepted refresh forms: the plain `col=excluded.col`, and the V48
  // preserve-guard CASE (`col=CASE WHEN <pin/preserve condition> THEN
  // tracks.col ELSE excluded.col END`) — the guard's intent holds for
  // both, since the CASE still refreshes from excluded on the ordinary
  // path and preserving the SAME column on the guarded path is the point.
  // The condition is matched lazily (it contains no THEN/ELSE), so pin-
  // only and pin-or-service-preserve conditions both parse.
  const setColumns = [
    ...[...m[3].matchAll(/(\w+)=excluded\.\1/g)].map(x => x[1]),
    ...[...m[3].matchAll(/(\w+)=CASE WHEN [\s\S]*? THEN tracks\.\1 ELSE excluded\.\1 END/g)].map(x => x[1]),
  ];
  return { columns, placeholders, setColumns };
}

describe('tracks UPSERT column parity (JS + Rust)', () => {
  const js = parseUpsert(
    fs.readFileSync(path.resolve(__dirname, '../../src/db/scanner.mjs'), 'utf8'), 'scanner.mjs');
  const rust = parseUpsert(
    fs.readFileSync(path.resolve(__dirname, '../../rust-parser/src/main.rs'), 'utf8'), 'main.rs');

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
