/**
 * Subsonic search3/search2/search integration tests for PR3.
 *
 * Covers the FTS5 path introduced in PR3:
 *   - search3 populated query returns results in the searchResult3
 *     envelope, BM25-ranked (verified via a deliberately-ordered
 *     fixture where alphabetical vs rank ordering differ).
 *   - search3 empty query returns the OpenSubsonic listing payload
 *     (paginated). search2 empty query preserves the pre-PR3 empty
 *     envelope.
 *   - V18 M2M-aware artist widening: a featured collaborator listed
 *     only in track_artists (not as the primary tracks.artist_id) still
 *     surfaces in search3 results when their name matches. FTS5 path
 *     must preserve this — regression risk is high because the SQL
 *     restructure inverted the driving table (fts_artists outside,
 *     M2M-IN clauses inside).
 *   - Subsonic-uses-combo regression: a query whose FTS expression
 *     refuses to build (single sub-2-char token) must still return
 *     rows via the LIKE fallback. Proves the route is wired to combo,
 *     not strict fts5.
 *
 * Setup is the public-mode bootstrap pattern (avoids ffmpeg fixtures):
 * boot mStream with no users, PUT an admin user, stop, seed the DB,
 * restart, run authed Subsonic calls. Sidesteps the broader test
 * helper's fixture requirement.
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
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const USER = { username: 'searchtester', password: 'p4ssw0rd!' };

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

async function bootMstream(tmpDir, musicDir, port) {
  port = port || await findFreePort();
  const config = {
    port,
    address: '127.0.0.1',
    ui: 'default',
    dlna:     { mode: 'disabled' },
    // Subsonic on same port so our test fetch hits /rest/* on the
    // main port. (separate-port also works but adds complexity.)
    subsonic: { mode: 'same-port' },
    folders:  { testlib: { root: musicDir } },
    storage: {
      albumArtDirectory:   path.join(tmpDir, 'image-cache'),
      dbDirectory:         path.join(tmpDir, 'db'),
      logsDirectory:       path.join(tmpDir, 'logs'),
    },
    scanOptions: { bootScanDelay: 9999, scanInterval: 0, autoAlbumArt: false },
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

// Seed: arrange names so rank ordering by FTS5 BM25 differs from
// alphabetical. "Aardvark Pink" is alphabetically first; "Zebra
// Floyd Pink Pink" has more 'pink' hits so BM25 ranks it higher.
function seedDB(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA recursive_triggers = ON');

  const libId = db.prepare("SELECT id FROM libraries WHERE name = 'testlib'").get().id;

  const aPink   = Number(db.prepare("INSERT INTO artists (name) VALUES ('Pink Floyd')").run().lastInsertRowid);
  const aSecond = Number(db.prepare("INSERT INTO artists (name) VALUES ('Pink Pink Pink Band')").run().lastInsertRowid);
  const aAardv  = Number(db.prepare("INSERT INTO artists (name) VALUES ('Aardvark Pink')").run().lastInsertRowid);
  const aFeatured = Number(db.prepare("INSERT INTO artists (name) VALUES ('SecretFeatured')").run().lastInsertRowid);
  const aFor     = Number(db.prepare("INSERT INTO artists (name) VALUES ('FooArtist')").run().lastInsertRowid);

  const albWall = Number(db.prepare("INSERT INTO albums (name, artist_id, year) VALUES ('The Wall', ?, 1979)").run(aPink).lastInsertRowid);
  const albSecond = Number(db.prepare("INSERT INTO albums (name, artist_id, year) VALUES ('Many Pinks', ?, 2010)").run(aSecond).lastInsertRowid);
  const albFor   = Number(db.prepare("INSERT INTO albums (name, artist_id, year) VALUES ('FooAlbum', ?, 2020)").run(aFor).lastInsertRowid);

  const insT = db.prepare(`
    INSERT INTO tracks (filepath, library_id, title, artist_id, album_id, year, format,
                        file_hash, audio_hash, modified, scan_id)
    VALUES (?, ?, ?, ?, ?, ?, 'flac', ?, ?, ?, 'seed')
  `);
  const insTA = db.prepare(
    `INSERT INTO track_artists (track_id, artist_id, role, position) VALUES (?, ?, ?, ?)`,
  );
  // V17/V18 widening on the artist search assumes track_artists is
  // populated by the scanner. Direct DB seeding has to mirror that
  // invariant — without these rows, the artist won't surface in
  // search3 even though it's set as tracks.artist_id. This is the
  // upstream design (see V18 comments in src/db/schema.js).
  function insertTrackWithMainArtist(filepath, title, artistId, albumId, year, hash, ahash) {
    const tid = Number(insT.run(filepath, libId, title, artistId, albumId, year, hash, ahash, ts++).lastInsertRowid);
    insTA.run(tid, artistId, 'main', 0);
    return tid;
  }

  let ts = 1700000000000;
  insertTrackWithMainArtist('pf/wall/01.flac', 'Comfortably Numb', aPink, albWall, 1979, 'h1', 'a1');
  insertTrackWithMainArtist('pp/many/01.flac', 'Pink Pink Pink',  aSecond, albSecond, 2010, 'h2', 'a2');
  insertTrackWithMainArtist('ap/01.flac', 'Some Track', aAardv, null, 2000, 'h3', 'a3');
  // Track 4 has a featured collaborator NOT in the primary artist FK:
  // tracks.artist_id = aFor (FooArtist), with two track_artists rows —
  // one 'main' for FooArtist, one 'featured' for SecretFeatured. This
  // exercises the V18 widening: searching for "SecretFeatured" must
  // find them via track_artists even though no track has them as
  // primary artist_id.
  const tid4 = insertTrackWithMainArtist('fa/01.flac', 'A Foo Track', aFor, albFor, 2020, 'h4', 'a4');
  insTA.run(tid4, aFeatured, 'featured', 1);

  // ── Parity fixture (PR3 audit follow-up) ──────────────────────────
  // OrphanArtist is set as tracks.artist_id on one track but has NO
  // track_artists row and NO album_artists row. Both the populated
  // search3 widening and the empty-listing widening should refuse to
  // surface them — the parity pinned in handlers.js. A test below
  // asserts both surfaces are silent.
  const aOrphan = Number(db.prepare("INSERT INTO artists (name) VALUES ('OrphanArtist')").run().lastInsertRowid);
  // Deliberately bypass insertTrackWithMainArtist so no track_artists row is written.
  insT.run('orphan/01.flac', libId, 'Orphan Track', aOrphan, null, 2020, 'h5', 'a5', ts++);

  db.close();
}

function subsonicUrl(baseUrl, method, params = {}) {
  const q = new URLSearchParams();
  q.set('f', 'json');
  q.set('u', USER.username);
  q.set('p', USER.password);
  q.set('v', '1.16.1');
  q.set('c', 'mstream-search-test');
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) { for (const item of v) q.append(k, item); }
    else if (v != null)   { q.set(k, v); }
  }
  return `${baseUrl}/rest/${method}?${q}`;
}

async function call(baseUrl, method, params = {}) {
  const r = await fetch(subsonicUrl(baseUrl, method, params));
  const body = await r.json();
  return body['subsonic-response'];
}

// ─────────────────────────────────────────────────────────────────────

describe('Subsonic search3/search2 with FTS5 (PR3)', () => {
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-sub-search-'));
    const musicDir = path.join(tmpDir, 'music');
    await fs.mkdir(musicDir, { recursive: true });

    // First boot: public mode, no users. Create the admin user via the
    // public-permissive admin endpoint, then stop.
    server = await bootMstream(tmpDir, musicDir);
    const userResp = await fetch(`${server.baseUrl}/api/v1/admin/users`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: USER.username,
        password: USER.password,
        admin: true,
        vpaths: ['testlib'],
      }),
    });
    if (!userResp.ok) {
      throw new Error(`failed to create user: ${userResp.status} ${await userResp.text()}`);
    }
    await killProc(server.proc);
    await sleep(200);

    // Seed the DB now that mStream's first-boot migrations have laid
    // out the schema and created the testlib library row.
    seedDB(path.join(tmpDir, 'db', 'mstream.db'));

    // Restart so all caches and the FTS5 capability probe pick up the
    // current DB state.
    server = await bootMstream(tmpDir, musicDir, server.port);
  });

  after(async () => {
    if (server?.proc) await killProc(server.proc);
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  // ── search3 populated query ───────────────────────────────────────

  test("search3 'pink' returns artist + album + song rows in searchResult3 envelope", async () => {
    const env = await call(server.baseUrl, 'search3', { query: 'pink' });
    assert.equal(env.status, 'ok');
    const r = env.searchResult3;
    assert.ok(r.artist?.length > 0, 'expected at least one artist');
    assert.ok(r.album?.length > 0, 'expected at least one album');
    // Pink Floyd artist must be in the results.
    assert.ok(r.artist.some(a => a.name === 'Pink Floyd'));
  });

  test('search3 BM25 ranks artist with more "pink" occurrences higher than alphabetical', async () => {
    // Fixture has three artists: Aardvark Pink, Pink Floyd, Pink Pink
    // Pink Band. Alphabetical order would put Aardvark first.
    // BM25 weights term frequency — "Pink Pink Pink Band" has the
    // most occurrences and should rank #1; "Pink Floyd" #2;
    // "Aardvark Pink" #3.
    const env = await call(server.baseUrl, 'search3', { query: 'pink', artistCount: 10 });
    const names = env.searchResult3.artist.map(a => a.name);
    assert.notEqual(names[0], 'Aardvark Pink',
      'BM25 should not put Aardvark Pink first — alphabetical ordering leaked through');
    // The repeat-heavy name should rank #1.
    assert.equal(names[0], 'Pink Pink Pink Band',
      'highest term-frequency match should be ranked first under BM25');
  });

  // ── V18 widening preserved via FTS5 path ──────────────────────────

  test('V18 widening: featured artist in track_artists surfaces in search3', async () => {
    // SecretFeatured is NOT the primary tracks.artist_id for any track.
    // The artist surfaces only because the V18 widening checks the
    // track_artists / album_artists M2M tables in addition to tracks.
    // Regression risk: PR3 restructured the SQL with fts_artists as the
    // driving table; if the IN-clause widening got dropped or scoped
    // wrong, this artist becomes invisible.
    const env = await call(server.baseUrl, 'search3', { query: 'SecretFeatured' });
    assert.equal(env.status, 'ok');
    assert.ok(env.searchResult3.artist?.some(a => a.name === 'SecretFeatured'),
      'featured artist must surface via track_artists widening');
  });

  test('parity: artist with only tracks.artist_id (no M2M rows) is invisible on BOTH search3 named-query and empty-listing', async () => {
    // OrphanArtist is set as a track's primary artist_id but has no
    // row in track_artists or album_artists. Pre-audit, the empty-
    // listing's third OR-clause would have surfaced them; the
    // populated path's widening (track_artists + album_artists only)
    // would not. PR3 audit follow-up tightened the empty-listing
    // SQL to match the populated path, so both surfaces now agree:
    // OrphanArtist is invisible. A future maintainer who restores
    // the dropped OR-clause would re-introduce the asymmetry; this
    // test fails loudly in that case.

    const named = await call(server.baseUrl, 'search3', { query: 'OrphanArtist' });
    assert.equal(named.status, 'ok');
    assert.equal(named.searchResult3.artist?.some(a => a.name === 'OrphanArtist') ?? false, false,
      'named search3 should not surface OrphanArtist (no track_artists / album_artists row)');

    // Empty-query listing — pull a wide enough page that we'd see
    // OrphanArtist if the widening let them through. Library has well
    // under 50 surfaceable artists.
    const listing = await call(server.baseUrl, 'search3', { query: '', artistCount: 50 });
    assert.equal(listing.status, 'ok');
    assert.equal(listing.searchResult3.artist?.some(a => a.name === 'OrphanArtist') ?? false, false,
      'empty-listing search3 should also not surface OrphanArtist — parity with named search');
  });

  // ── Cross-field song search (divergences: search3/no-cross-entity-fields, song half) ──
  //
  // Songs match on title OR (denormalised) artist_name OR album_name.
  // Pre-fix, song search was title-only, so an artist/album query
  // returned 0 songs — the gap vs Navidrome. These pin the new
  // behaviour; the album *category* stays name-only (see last test).

  test('cross-field: searching an artist name surfaces that artist\'s songs', async () => {
    // "Floyd" appears in artist "Pink Floyd" but in no song title.
    // Title-only search would return 0 songs; cross-field returns the
    // artist's track "Comfortably Numb".
    const env = await call(server.baseUrl, 'search3', { query: 'Floyd' });
    assert.equal(env.status, 'ok');
    const titles = (env.searchResult3.song || []).map(s => s.title);
    assert.ok(titles.includes('Comfortably Numb'),
      `expected song "Comfortably Numb" via artist-name match, got ${JSON.stringify(titles)}`);
  });

  test('cross-field: searching an album name surfaces that album\'s songs', async () => {
    // "Wall" appears in album "The Wall" but in no song title.
    const env = await call(server.baseUrl, 'search3', { query: 'Wall' });
    assert.equal(env.status, 'ok');
    const titles = (env.searchResult3.song || []).map(s => s.title);
    assert.ok(titles.includes('Comfortably Numb'),
      `expected song "Comfortably Numb" via album-name match, got ${JSON.stringify(titles)}`);
  });

  test('cross-field: plain title search still works (regression)', async () => {
    // "Numb" is a title token — must still match after the column set widened.
    const env = await call(server.baseUrl, 'search3', { query: 'Numb' });
    assert.equal(env.status, 'ok');
    const titles = (env.searchResult3.song || []).map(s => s.title);
    assert.ok(titles.includes('Comfortably Numb'),
      `title search regressed: got ${JSON.stringify(titles)}`);
  });

  test('album category stays name-only (open half of the divergence)', async () => {
    // The song side is cross-field now, but the ALBUM category is still
    // matched by album name only. "Floyd" (artist) must NOT pull in
    // "The Wall" as an album result — that's the still-deferred half.
    const env = await call(server.baseUrl, 'search3', { query: 'Floyd' });
    assert.equal(env.status, 'ok');
    const albums = (env.searchResult3.album || []).map(a => a.name);
    assert.equal(albums.includes('The Wall'), false,
      `album category should still be name-only; got ${JSON.stringify(albums)}`);
    // Sanity: the artist itself still surfaces in the artist category.
    assert.ok((env.searchResult3.artist || []).some(a => a.name === 'Pink Floyd'),
      'artist "Pink Floyd" should still surface in the artist category');
  });

  // ── Empty-query semantics: search3 vs search2 ─────────────────────

  test("search3 empty query returns paginated listing (OpenSubsonic 'A blank query will return everything')", async () => {
    const env = await call(server.baseUrl, 'search3', { query: '', artistCount: 2, songCount: 2 });
    assert.equal(env.status, 'ok');
    const r = env.searchResult3;
    // Listing must populate at least one of the categories.
    const total = (r.artist?.length || 0) + (r.album?.length || 0) + (r.song?.length || 0);
    assert.ok(total > 0,
      'search3 empty query should return the OpenSubsonic listing payload, not the empty envelope');
    // Pagination respected — artistCount: 2 caps artists at 2.
    assert.ok((r.artist?.length || 0) <= 2);
    assert.ok((r.song?.length   || 0) <= 2);
  });

  test('search2 empty query preserves pre-PR3 behaviour (empty envelope)', async () => {
    const env = await call(server.baseUrl, 'search2', { query: '' });
    assert.equal(env.status, 'ok');
    const r = env.searchResult2;
    // Empty envelope: search2 doesn't carry the OpenSubsonic listing
    // semantics; older clients hitting search2 expect an empty result,
    // not a 200-row listing.
    const total = (r?.artist?.length || 0) + (r?.album?.length || 0) + (r?.song?.length || 0);
    assert.equal(total, 0, 'search2 empty query must return the empty envelope');
  });

  // ── Subsonic-uses-combo regression ────────────────────────────────

  test('Subsonic search3 falls back to LIKE on parse failure (combo, not strict fts5)', async () => {
    // Single-char query — buildFtsExpression returns null. If Subsonic
    // were wired to strict fts5, every category would be []. Combo
    // falls back to LIKE per category, which still matches our seeded
    // names (Pink Floyd contains 'p', Foo Track, etc.).
    const env = await call(server.baseUrl, 'search3', { query: 'p' });
    assert.equal(env.status, 'ok');
    const r = env.searchResult3;
    const total = (r.artist?.length || 0) + (r.album?.length || 0) + (r.song?.length || 0);
    assert.ok(total > 0,
      'Subsonic must fall back to LIKE when FTS expression cannot be built — proves combo wiring');
  });

  // ── musicFolderId scope ───────────────────────────────────────────

  test('search3 truncates an over-length query instead of erroring', async () => {
    // normalizeQueryFragment caps at 512 chars (mirror of the
    // /api/v1/db/search Joi cap). Subsonic clients expect lenient
    // handling, so a huge query degrades to its first 512 chars and the
    // request still succeeds. The pad is the SAME token repeated ~1200
    // times: every token surviving the cut (including a clipped 'pi' /
    // 'pin' tail) still prefix-matches Pink Floyd, so the all-words AND
    // stays satisfiable and the truncation itself is what's under test.
    const env = await call(server.baseUrl, 'search3', { query: 'pink '.repeat(1200) });
    assert.equal(env.status, 'ok', 'over-length query must not error');
    assert.ok(env.searchResult3.artist?.some(a => a.name === 'Pink Floyd'),
      'the in-cap prefix still searches');
  });

  test('search3 with unknown musicFolderId returns empty envelope (no crash)', async () => {
    // Encoded folder id that doesn't match any library the user can see.
    const env = await call(server.baseUrl, 'search3', { query: 'pink', musicFolderId: 'mf-99999' });
    assert.equal(env.status, 'ok');
    const r = env.searchResult3;
    // Should be an empty envelope (no artist/album/song keys, or all empty).
    const total = (r?.artist?.length || 0) + (r?.album?.length || 0) + (r?.song?.length || 0);
    assert.equal(total, 0);
  });
});
