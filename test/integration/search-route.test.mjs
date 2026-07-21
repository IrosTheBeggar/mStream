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
import { lrcToSearchText } from '../../src/api/subsonic/lrc-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

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
    },
    // No boot scan — we seed the DB directly, the empty music dir
    // would otherwise trigger an "orphan tracks" purge.
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

  // Give one track embedded lyrics so the lyrics search category — and its
  // metadata enrichment + snippet handling — is exercised. The `basic`
  // algorithm matches via LIKE on the lyrics column directly, so this works
  // regardless of whether the FTS lyrics index was populated.
  db.prepare("UPDATE tracks SET lyrics_embedded = ? WHERE filepath = 'pf/wall/01.flac'")
    .run('Hello? Is there anybody in there? Just nod if you can hear me.');

  // V59: a synced-only track, seeded the way the real writers write —
  // raw LRC into lyrics_synced_lrc AND the stripped rendition into
  // lyrics_search_text (derived with the production helper, so the seed
  // can't drift from the writer contract). The stamps carry the digit
  // pairs 22/37/48 that must NOT be matchable; 'crazyseventy' is a token
  // unique to these lyrics.
  const KARMA_LRC = [
    '[ar:Header Person]',
    '[00:22.10]for a minute there I lost myself',
    '[00:37.48]crazyseventy phew',
  ].join('\n');
  db.prepare("UPDATE tracks SET lyrics_synced_lrc = ?, lyrics_search_text = ? WHERE filepath = 'rh/ok/01.flac'")
    .run(KARMA_LRC, lrcToSearchText(KARMA_LRC));

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

  test('algorithm=foo (unknown value) → 400 from Joi error middleware', async () => {
    const r = await searchReq(server.baseUrl, { search: 'pink', algorithm: 'foo' });
    // mStream's error middleware maps Joi.ValidationError to 400 Bad
    // Request (src/server.js): a malformed `algorithm` value is a bad
    // request, not an authorization failure.
    assert.equal(r.status, 400);
  });

  test('algorithm="" (empty string) → 400 from Joi error middleware', async () => {
    const r = await searchReq(server.baseUrl, { search: 'pink', algorithm: '' });
    // mStream's error middleware maps Joi.ValidationError to 400 Bad
    // Request (src/server.js): a malformed `algorithm` value is a bad
    // request, not an authorization failure.
    assert.equal(r.status, 400);
  });

  test('algorithm=null (explicit null) → 400 from Joi error middleware', async () => {
    // PR3 audit follow-up. Joi.string().valid(...) rejects an explicit
    // null payload — `.optional().default('combo')` only fills in for
    // the MISSING case, not for the EXPLICITLY-NULL case. Pinned here
    // so a future schema change that adds `.allow(null)` (and would
    // accidentally route a null through to the dispatch as `undefined`
    // and silently land on the combo default) is a loud diff.
    const r = await searchReq(server.baseUrl, { search: 'pink', algorithm: null });
    assert.equal(r.status, 400);
  });

  // ── Search length cap (hardening audit follow-up) ────────────────

  test('search longer than 512 chars → 400 from the Joi cap', async () => {
    // Without the cap, a request-body-sized search (1MB express default)
    // becomes a giant AND-of-prefixes MATCH expression or a megabyte
    // LIKE pattern scanned against every lyrics blob.
    const r = await searchReq(server.baseUrl, { search: 'a'.repeat(513) });
    assert.equal(r.status, 400);
  });

  test('search at exactly 512 chars is accepted (cap is inclusive)', async () => {
    for (const algorithm of ['basic', 'fts5', 'combo']) {
      const r = await searchReq(server.baseUrl, { search: 'a'.repeat(512), algorithm });
      assert.equal(r.status, 200, `algorithm=${algorithm} must accept a boundary-length search`);
      assert.deepEqual(Object.keys(r.body).sort(), ['albums', 'artists', 'files', 'lyrics', 'title'],
        'boundary-length search returns the normal envelope');
    }
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
    const TOP = ['albums', 'artists', 'files', 'lyrics', 'title'];
    // artists/albums are name aggregations — no per-track metadata object.
    const ITEM_GROUP = ['album_art_file', 'filepath', 'name'];
    // title/files are track-level and carry the full canonical metadata object
    // alongside the legacy fields (additive, non-breaking).
    const ITEM_TRACK = ['album_art_file', 'filepath', 'metadata', 'name'];
    // lyrics = track-level + the matching excerpt.
    const ITEM_LYRICS = ['album_art_file', 'filepath', 'metadata', 'name', 'snippet'];

    const expectedKeys = (cat) =>
      cat === 'lyrics' ? ITEM_LYRICS :
      (cat === 'title' || cat === 'files') ? ITEM_TRACK :
      ITEM_GROUP;

    for (const { body } of results) {
      assert.deepEqual(Object.keys(body).sort(), TOP);
      for (const cat of TOP) {
        for (const item of body[cat]) {
          assert.deepEqual(Object.keys(item).sort(), expectedKeys(cat),
            `per-item keys mismatch in ${cat} category`);
        }
      }
    }
  });

  test('track hits carry the LITE metadata object; group hits do not', async () => {
    // 'comfortably' matches the title 'Comfortably Numb' via LIKE %...% under
    // the basic algorithm — no FTS5 dependency, so this asserts the enrichment
    // path independent of how SQLite was compiled.
    const r = await searchReq(server.baseUrl, { search: 'comfortably', algorithm: 'basic' });
    assert.equal(r.status, 200);
    const hit = r.body.title.find(t => t.filepath === 'testlib/pf/wall/01.flac');
    assert.ok(hit, 'Comfortably Numb track present in the title results');

    // metadata is the LITE subset — exactly these keys, no more. Hardcoded
    // here (rather than imported from src) as the wire contract; the unit test
    // (render-metadata-by-ids) locks this list against LITE_METADATA_FIELDS.
    const EXPECTED_LITE_KEYS = ['album', 'album-art', 'artist', 'bpm', 'disk',
      'duration', 'genres', 'has-lyrics', 'has-synced-lyrics', 'musical-key',
      'rating', 'replaygain-track', 'title', 'track', 'year'];
    assert.ok(hit.metadata && typeof hit.metadata === 'object', 'title hit has a metadata object');
    assert.deepEqual(Object.keys(hit.metadata).sort(), EXPECTED_LITE_KEYS,
      'metadata carries exactly the lite field set');

    // Kept (display/playback/Auto-DJ) fields carry real values.
    assert.equal(hit.metadata.title, 'Comfortably Numb');
    assert.equal(hit.metadata.artist, 'Pink Floyd');
    assert.equal(hit.metadata.album, 'The Wall');
    assert.equal(hit.metadata.year, 1979);
    assert.ok('album-art' in hit.metadata, 'kebab-case lite fields are present');
    assert.ok(Array.isArray(hit.metadata.genres), 'genres is always an array');

    // Heavy / detail-only fields are NOT in the lite object — fetch
    // /api/v1/db/metadata for those.
    for (const dropped of ['hash', 'audio-hash', 'format', 'bitrate', 'sample-rate',
      'channels', 'bit-depth', 'file-size', 'play-count', 'last-played', 'created-at',
      'modified', 'source', 'bpm-source', 'track-total', 'disc-total']) {
      assert.ok(!(dropped in hit.metadata), `lite metadata must not include ${dropped}`);
    }

    // Legacy fields are preserved alongside metadata (additive change).
    assert.equal(typeof hit.name, 'string');
    assert.equal(hit.filepath, 'testlib/pf/wall/01.flac');

    // Group categories never gain a metadata key.
    const grp = await searchReq(server.baseUrl, { search: 'pink', algorithm: 'basic' });
    for (const item of grp.body.artists) assert.ok(!('metadata' in item), 'artist items stay minimal');
    for (const item of grp.body.albums)  assert.ok(!('metadata' in item), 'album items stay minimal');
  });

  test('lyrics hits carry metadata + snippet (basic LIKE on the lyrics column)', async () => {
    // 'anybody' lives only in the seeded embedded lyrics of Comfortably Numb.
    const r = await searchReq(server.baseUrl, { search: 'anybody', algorithm: 'basic' });
    assert.equal(r.status, 200);
    const hit = r.body.lyrics.find(t => t.filepath === 'testlib/pf/wall/01.flac');
    assert.ok(hit, 'lyrics match present');
    assert.ok(hit.metadata && hit.metadata.title === 'Comfortably Numb',
      'lyrics hit carries the full metadata object');
    // basic LIKE has no FTS snippet — the key is present but null.
    assert.ok('snippet' in hit, 'snippet key present on lyrics items');
    assert.equal(hit.snippet, null, 'basic algorithm yields a null snippet');
  });

  test('noLyrics suppresses the lyrics category', async () => {
    const r = await searchReq(server.baseUrl, { search: 'anybody', algorithm: 'basic', noLyrics: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.lyrics.length, 0, 'noLyrics returns an empty lyrics array');
  });

  // ── V59: FTS lyrics path over synced LRC (stripped index) ────────

  const KARMA_FILEPATH = 'testlib/rh/ok/01.flac';

  test('FTS lyrics hit on a synced-LRC track carries a non-null, stamp-free snippet', async () => {
    // 'crazyseventy' lives only in the seeded synced lyrics of Karma
    // Police — and only in its WORDS, so this exercises fts_tracks.lyrics
    // end to end (MATCH + snippet()), not the LIKE fallback.
    for (const algorithm of ['fts5', 'combo']) {
      const r = await searchReq(server.baseUrl, { search: 'crazyseventy', algorithm });
      assert.equal(r.status, 200);
      const hit = r.body.lyrics.find(t => t.filepath === KARMA_FILEPATH);
      assert.ok(hit, `algorithm=${algorithm} must find the synced-LRC track by a lyric word`);
      assert.equal(typeof hit.snippet, 'string', `algorithm=${algorithm} FTS path must yield a snippet`);
      assert.match(hit.snippet, /crazyseventy/, 'snippet shows the matching line');
      assert.doesNotMatch(hit.snippet, /[[\]]/, 'snippet carries no LRC stamp brackets');
      assert.doesNotMatch(hit.snippet, /\d/, 'snippet carries no stamp digits');
      // Scoped: a lyric-only word must not leak into the other categories.
      assert.equal(r.body.title.length, 0);
      assert.equal(r.body.artists.length, 0);
    }
  });

  test('numeric queries do not match LRC timestamps in any algorithm (V59)', async () => {
    // '22', '37' and '48' appear in the seeded track ONLY inside
    // [mm:ss.xx] stamps. Pre-V59 these were FTS tokens and this returned
    // the track; now the index and the LIKE path both read the stripped
    // lyrics_search_text, so every algorithm must come back empty.
    for (const digits of ['22', '37', '48']) {
      for (const algorithm of ['basic', 'fts5', 'combo']) {
        const r = await searchReq(server.baseUrl, { search: digits, algorithm });
        assert.equal(r.status, 200);
        assert.equal(r.body.lyrics.length, 0,
          `search '${digits}' (${algorithm}) must not match timestamp digits`);
      }
    }
  });

  test('LRC header-tag words are not lyrics (V59)', async () => {
    // '[ar:Header Person]' is metadata, not a lyric line — lrcToSearchText
    // drops it before indexing.
    const r = await searchReq(server.baseUrl, { search: 'header', algorithm: 'fts5' });
    assert.equal(r.status, 200);
    assert.equal(r.body.lyrics.length, 0, 'header-tag words must not match as lyrics');
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
