/**
 * Integration tests for POST /api/v1/db/search and its three-value
 * `algorithm` request param introduced in PR3.
 *
 * Strategy: boot mStream in public/no-users mode against an empty
 * music dir (so we don't depend on ffmpeg fixtures), then seed
 * tracks/artists/albums directly into the SQLite DB. The route
 * runs against the real Express handler chain — Joi validation,
 * libraryFilter, the runLikeSearch / runFtsSearch dispatch, the
 * shared shape* callbacks — so envelope shape parity and per-
 * algorithm semantics are exercised end-to-end.
 *
 * Public mode pins req.user.id to the V25 anonymous sentinel, which
 * libraryFilter treats as "see every library" — sidesteps the user-
 * provisioning dance that would otherwise need ffmpeg-built fixtures.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForReady(baseUrl, timeoutMs = 30_000) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${baseUrl}/api/`);
      if (r.status < 500) return;
    } catch (err) { lastErr = err; }
    await sleep(150);
  }
  throw new Error(`server not ready: ${lastErr?.message || 'unknown'}`, { cause: lastErr });
}

async function bootMstream(tmpDir, musicDir, extraLibraries = {}) {
  const port = await findFreePort();
  const config = {
    port,
    address: '127.0.0.1',
    ui: 'default',
    dlna:     { mode: 'disabled' },
    subsonic: { mode: 'disabled' },
    folders:  { testlib: { root: musicDir }, ...extraLibraries },
    storage: {
      albumArtDirectory:   path.join(tmpDir, 'image-cache'),
      dbDirectory:         path.join(tmpDir, 'db'),
      logsDirectory:       path.join(tmpDir, 'logs'),
      syncConfigDirectory: path.join(tmpDir, 'sync'),
    },
    // No boot scan — we seed the DB directly, the empty music dir
    // would otherwise trigger an "orphan tracks" purge.
    scanOptions: { bootScanDelay: 9999, scanInterval: 0 },
  };
  for (const dir of Object.values(config.storage)) {
    await fs.mkdir(dir, { recursive: true });
  }
  const configPath = path.join(tmpDir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const proc = spawn(
    process.execPath,
    ['cli-boot-wrapper.js', '-j', configPath],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'test' } },
  );
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForReady(baseUrl);
  return { proc, baseUrl, port };
}

async function killProc(proc) {
  if (proc.exitCode != null || proc.signalCode != null) return;
  proc.kill('SIGKILL');
  await new Promise(r => proc.once('exit', r));
}

// Seed the DB with a deterministic fixture: two libraries, several
// artists, and one track engineered specifically to exercise the
// `basic` vs FTS5 infix divergence ("Funny" → matches LIKE `%unny%`
// but not FTS5 prefix `unny*`).
function seedDB(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA recursive_triggers = ON');

  const lib1 = db.prepare("SELECT id FROM libraries WHERE name = 'testlib'").get().id;
  // A second library will be created after our second boot; for now
  // we'll only seed the first. Cross-library scoping is exercised in
  // a separate describe block below that uses a multi-library config.

  const aPink = Number(db.prepare("INSERT INTO artists (name) VALUES ('Pink Floyd')").run().lastInsertRowid);
  const aRadio = Number(db.prepare("INSERT INTO artists (name) VALUES ('Radiohead')").run().lastInsertRowid);
  const aSigur = Number(db.prepare("INSERT INTO artists (name) VALUES ('Sigur Rós')").run().lastInsertRowid);
  const aFunOnly = Number(db.prepare("INSERT INTO artists (name) VALUES ('FunArtist')").run().lastInsertRowid);

  const albWall = Number(db.prepare("INSERT INTO albums (name, artist_id, year) VALUES ('The Wall', ?, 1979)").run(aPink).lastInsertRowid);
  const albOK   = Number(db.prepare("INSERT INTO albums (name, artist_id, year) VALUES ('OK Computer', ?, 1997)").run(aRadio).lastInsertRowid);
  const albAge  = Number(db.prepare("INSERT INTO albums (name, artist_id, year) VALUES ('Ágætis byrjun', ?, 1999)").run(aSigur).lastInsertRowid);
  const albFun  = Number(db.prepare("INSERT INTO albums (name, artist_id, year) VALUES ('FunAlbum', ?, 2020)").run(aFunOnly).lastInsertRowid);

  const insT = db.prepare(`
    INSERT INTO tracks (filepath, library_id, title, artist_id, album_id, year, format,
                        file_hash, audio_hash, modified, scan_id)
    VALUES (?, ?, ?, ?, ?, ?, 'flac', ?, ?, ?, 'seed')
  `);
  let ts = 1700000000000;
  insT.run('pf/wall/01.flac', lib1, 'Comfortably Numb', aPink, albWall, 1979, 'h1', 'a1', ts++);
  insT.run('pf/wall/02.flac', lib1, 'Another Brick',    aPink, albWall, 1979, 'h2', 'a2', ts++);
  insT.run('rh/ok/01.flac',   lib1, 'Karma Police',     aRadio, albOK, 1997, 'h3', 'a3', ts++);
  insT.run('sg/age/01.flac',  lib1, 'Svefn-g-englar',   aSigur, albAge, 1999, 'h4', 'a4', ts++);
  // The "Funny" track is the deliberate infix-vs-prefix probe: an FTS5
  // prefix query `unny*` won't match, but LIKE `%unny%` will.
  insT.run('fun/01.flac',     lib1, 'Funny',            aFunOnly, albFun, 2020, 'h5', 'a5', ts);

  db.close();
}

async function searchReq(baseUrl, body) {
  const r = await fetch(`${baseUrl}/api/v1/db/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: r.status === 200 ? await r.json() : await r.text() };
}

// ─────────────────────────────────────────────────────────────────────

describe('/api/v1/db/search algorithm dispatch', () => {
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-search-'));
    const musicDir = path.join(tmpDir, 'music');
    await fs.mkdir(musicDir, { recursive: true });
    server = await bootMstream(tmpDir, musicDir);
    await killProc(server.proc);
    await sleep(200);
    seedDB(path.join(tmpDir, 'db', 'mstream.db'));
    server = await bootMstream(tmpDir, musicDir);
  });

  after(async () => {
    if (server?.proc) await killProc(server.proc);
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  // ── Joi validation ────────────────────────────────────────────────

  test('algorithm=basic is accepted', async () => {
    const r = await searchReq(server.baseUrl, { search: 'pink', algorithm: 'basic' });
    assert.equal(r.status, 200);
  });

  test('algorithm=fts5 is accepted', async () => {
    const r = await searchReq(server.baseUrl, { search: 'pink', algorithm: 'fts5' });
    assert.equal(r.status, 200);
  });

  test('algorithm=combo is accepted', async () => {
    const r = await searchReq(server.baseUrl, { search: 'pink', algorithm: 'combo' });
    assert.equal(r.status, 200);
  });

  test('algorithm omitted defaults to combo', async () => {
    const r = await searchReq(server.baseUrl, { search: 'pink' });
    assert.equal(r.status, 200);
    // Combo must find Pink Floyd via FTS5 prefix on artist name.
    assert.ok(r.body.artists.some(a => a.name === 'Pink Floyd'));
  });

  test('algorithm=foo (unknown value) → 403 from Joi error middleware', async () => {
    const r = await searchReq(server.baseUrl, { search: 'pink', algorithm: 'foo' });
    // mStream's error middleware maps Joi.ValidationError to 403, not
    // 400 — the existing convention in src/server.js since long before
    // PR3. Locking that in here means a future shift to 400 is a
    // visible test diff rather than a silent client compatibility break.
    assert.equal(r.status, 403);
  });

  test('algorithm="" (empty string) → 403 from Joi error middleware', async () => {
    const r = await searchReq(server.baseUrl, { search: 'pink', algorithm: '' });
    // mStream's error middleware maps Joi.ValidationError to 403, not
    // 400 — the existing convention in src/server.js since long before
    // PR3. Locking that in here means a future shift to 400 is a
    // visible test diff rather than a silent client compatibility break.
    assert.equal(r.status, 403);
  });

  // ── Default-is-combo + combo vs fts5 divergence on parse failure ──

  test("no-alnum query '&' — combo falls back to LIKE per category and returns rows", async () => {
    // parseSearchQuery returns empty positives → buildFtsExpression
    // returns null → combo falls back to LIKE on every category. LIKE
    // pattern is `%&%` which won't match any of our seeded names — so
    // every category SHOULD be empty under combo too. Pick a different
    // probe character that LIKE will actually hit.
    //
    // We use 'f' which is in 'Funny', 'FunArtist', 'FunAlbum', and
    // 'Floyd'. parseSearchQuery('f') → positive=['f'] → single sub-2-char
    // → buildFtsExpression returns null → combo falls back to LIKE
    // `%f%` which matches plenty. fts5 strict returns [] across the board.
    const combo = await searchReq(server.baseUrl, { search: 'f', algorithm: 'combo' });
    const fts5  = await searchReq(server.baseUrl, { search: 'f', algorithm: 'fts5' });
    assert.equal(combo.status, 200);
    assert.equal(fts5.status, 200);
    // Combo finds at least one entry across the four categories via LIKE.
    const comboTotal = combo.body.artists.length + combo.body.albums.length + combo.body.title.length + combo.body.files.length;
    const fts5Total  = fts5.body.artists.length  + fts5.body.albums.length  + fts5.body.title.length  + fts5.body.files.length;
    assert.ok(comboTotal > 0, `combo should return rows via LIKE fallback; got ${comboTotal}`);
    assert.equal(fts5Total, 0, `strict fts5 should return zero rows on parse failure; got ${fts5Total}`);
  });

  test('omitted algorithm matches combo on parse-failure (default really is combo)', async () => {
    const def   = await searchReq(server.baseUrl, { search: 'f' });
    const combo = await searchReq(server.baseUrl, { search: 'f', algorithm: 'combo' });
    assert.deepEqual(def.body, combo.body);
  });

  // ── basic vs combo divergence on infix matching ──────────────────

  // shapeTitleRow decorates title rows with the artist prefix
  // ("FunArtist - Funny"). To assert "the Funny track was returned"
  // we use the filepath sentinel which carries the raw filepath.
  const FUNNY_FILEPATH = 'testlib/fun/01.flac';

  test("'unny' → basic finds 'Funny' (infix LIKE); combo does NOT (FTS5 is prefix-only, no SQLITE_ERROR → no fallback)", async () => {
    // This is the key semantic difference between the algorithms.
    // FTS5 prefix `unny*` is a clean MATCH that returns zero rows;
    // there's no SQLITE_ERROR, so combo does not fall back to LIKE for
    // that category. basic always runs LIKE so the infix match hits.
    // Test name spells this out so a reader doesn't mistake "combo
    // returns empty" for a bug.
    const basic = await searchReq(server.baseUrl, { search: 'unny', algorithm: 'basic' });
    const combo = await searchReq(server.baseUrl, { search: 'unny', algorithm: 'combo' });
    const fts5  = await searchReq(server.baseUrl, { search: 'unny', algorithm: 'fts5' });
    assert.equal(basic.status, 200);
    assert.equal(combo.status, 200);
    assert.equal(fts5.status, 200);
    assert.ok(basic.body.title.some(t => t.filepath === FUNNY_FILEPATH),
      'basic must find Funny via infix LIKE');
    assert.equal(combo.body.title.length, 0,
      'combo must return zero title hits — FTS5 prefix matched cleanly with no error to trigger fallback');
    assert.equal(fts5.body.title.length, 0,
      'fts5 strict must also return zero hits');
  });

  test("'fun' → basic, combo, fts5 all find 'Funny' (prefix match is enough)", async () => {
    // Sanity: when the prefix actually matches, all three algorithms
    // agree on the per-category contents (modulo order/distinct).
    const algos = ['basic', 'fts5', 'combo'];
    for (const algorithm of algos) {
      const r = await searchReq(server.baseUrl, { search: 'fun', algorithm });
      assert.equal(r.status, 200);
      assert.ok(r.body.title.some(t => t.filepath === FUNNY_FILEPATH),
        `algorithm=${algorithm} must find the Funny track via prefix match`);
    }
  });

  // ── Envelope shape parity across algorithms ──────────────────────

  test('envelope keys + per-item keys are identical across basic, fts5, combo', async () => {
    // Use a query that returns at least one row in every category under
    // every algorithm. 'pink' hits: artists Pink Floyd; albums via
    // The Wall has tracks-joined-to-artist Pink; title 'Comfortably Numb'
    // doesn't match 'pink' (no infix on title — basic might though).
    // Easier to assert key shapes without needing all four categories
    // populated: just assert what's present has the right keys.
    const algorithms = ['basic', 'fts5', 'combo'];
    const results = await Promise.all(algorithms.map(a =>
      searchReq(server.baseUrl, { search: 'pink', algorithm: a })
    ));
    const TOP = ['albums', 'artists', 'files', 'title'];
    const ITEM = ['album_art_file', 'filepath', 'name'];

    for (const { body } of results) {
      assert.deepEqual(Object.keys(body).sort(), TOP);
      for (const cat of TOP) {
        for (const item of body[cat]) {
          assert.deepEqual(Object.keys(item).sort(), ITEM,
            `per-item keys mismatch in ${cat} category`);
        }
      }
    }
  });

  test('filepath sentinel: false on artist/album rows, string on title/file rows', async () => {
    // Pick a query that returns rows in all four categories under combo.
    // 'pink' matches the artist (FTS5 prefix on name) and via the
    // artist→tracks join the album+title+file rows leak into the
    // category-specific queries too. The basic algorithm runs straight
    // LIKE %pink% which matches the artist name across all four
    // joined-table queries.
    const r = await searchReq(server.baseUrl, { search: 'pink', algorithm: 'basic' });
    for (const item of r.body.artists) assert.equal(item.filepath, false);
    for (const item of r.body.albums)  assert.equal(item.filepath, false);
    for (const item of r.body.title)   assert.equal(typeof item.filepath, 'string');
    for (const item of r.body.files)   assert.equal(typeof item.filepath, 'string');
  });

  // ── Diacritic folding (FTS5-only behaviour) ──────────────────────

  test("diacritic folding: combo finds 'Sigur Rós' from MATCH 'ros' (FTS5 unicode61); basic does not", async () => {
    // basic LIKE %ros% does case-insensitive substring match on the raw
    // string. 'Sigur Rós' contains 'ós' but not 'os' as a substring of
    // the raw bytes — LIKE on Latin-1 does not fold. FTS5 unicode61
    // with remove_diacritics=1 indexes 'ros' for 'Rós', so combo finds it.
    const basic = await searchReq(server.baseUrl, { search: 'ros', algorithm: 'basic' });
    const combo = await searchReq(server.baseUrl, { search: 'ros', algorithm: 'combo' });
    assert.equal(basic.body.artists.some(a => a.name === 'Sigur Rós'), false,
      'basic LIKE should NOT find Sigur Rós from "ros"');
    assert.ok(combo.body.artists.some(a => a.name === 'Sigur Rós'),
      'combo FTS5 should find Sigur Rós via diacritic folding');
  });
});
