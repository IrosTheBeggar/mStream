/**
 * Album-art downloader tests (V51 + src/db/album-art-backfill.mjs).
 *
 * The worker is spawned exactly as task-queue.js forks it, with the
 * service base URLs pointed at a LOCAL mock (MSTREAM_*_BASE env — the
 * lrclib testing pattern), so the full loop runs with zero real network:
 *
 *   - found: default + art-less tracks stamped, junctions + art_files
 *     (with V50 content_hash) written, lookup row with fetched_hash.
 *   - notfound/error outcomes + their asymmetric cooldowns.
 *   - per-run cap + hitCap signalling; service-order respect; pacing.
 *   - hash dedupe: same image across albums → one art_files row; an
 *     album that already carries the fetched bytes → 'deduped', no rows.
 *   - mode 'all': gallery-add without touching an existing default.
 *   - writeToFolder: cover.jpg written, existing cover.jpg untouched.
 *   - schema guard: wrong user_version → exit 3, no writes.
 *   - V51 migration shape.
 *
 * Plus one task-queue integration test through a real booted server:
 * scan completes → the downloader chains and records lookups.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { MIGRATIONS } from '../../src/db/schema.js';
import { applyAllMigrations } from '../helpers/apply-migrations.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKER = path.join(REPO_ROOT, 'src', 'db', 'album-art-backfill.mjs');

// ── Mock service server ──────────────────────────────────────────────────────
//
// One HTTP server plays MusicBrainz + Cover Art Archive + iTunes + Deezer.
// Behavior is driven by the mutable `mock` object; every request is
// appended to mock.log as { path, at } for order/pacing assertions.

const mock = {
  server: null,
  base: null,
  log: [],
  // Which services return a candidate for any query.
  mbHasRelease: true,
  itunesHasResult: false,
  deezerHasResult: false,
  // HTTP status for the image download itself.
  imageStatus: 200,
  // The image bytes served (>= 1000 bytes — the worker's sanity floor).
  imageBytes: null,
};

function makeImageBytes(seed) {
  // JPEG magic + deterministic padding — the worker never decodes
  // (compressImage=false in these tests), it just hashes + stores bytes.
  return Buffer.concat([
    Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]),
    Buffer.alloc(2000, seed),
  ]);
}

function startMock() {
  return new Promise((resolve) => {
    mock.server = http.createServer((req, res) => {
      mock.log.push({ path: req.url, at: Date.now() });
      const fail = (code) => { res.statusCode = code; res.end(); };

      if (req.url.startsWith('/ws/2/release/')) {          // MusicBrainz search
        if (!mock.mbHasRelease) { return res.end(JSON.stringify({ releases: [] })); }
        return res.end(JSON.stringify({ releases: [
          { id: 'rel-1', title: 'Mock Release', date: '2001-01-01' },
        ] }));
      }
      if (req.url.startsWith('/release/')) {               // Cover Art Archive image
        // Production-faithful: the real coverartarchive.org ALWAYS 307s
        // to an archive.org URL — a relative Location here additionally
        // exercises httpGet's relative-redirect resolution.
        res.writeHead(307, { Location: '/img/caa.jpg' });
        return res.end();
      }
      if (req.url.startsWith('/search/album')) {           // Deezer search
        if (!mock.deezerHasResult) { return res.end(JSON.stringify({ data: [] })); }
        return res.end(JSON.stringify({ data: [
          { cover_xl: `${mock.base}/img/deezer.jpg`, title: 'Mock DZ', nb_tracks: 10 },
        ] }));
      }
      if (req.url.startsWith('/search')) {                 // iTunes search
        if (!mock.itunesHasResult) { return res.end(JSON.stringify({ results: [] })); }
        return res.end(JSON.stringify({ results: [
          { artworkUrl100: `${mock.base}/img/itunes-100x100bb.jpg`, collectionName: 'Mock IT' },
        ] }));
      }
      if (req.url.startsWith('/img/')) {                   // direct image URLs
        if (mock.imageStatus !== 200) { return fail(mock.imageStatus); }
        return res.end(mock.imageBytes);
      }
      fail(404);
    });
    mock.server.listen(0, '127.0.0.1', () => {
      mock.base = `http://127.0.0.1:${mock.server.address().port}`;
      resolve();
    });
  });
}

function resetMock() {
  mock.log = [];
  mock.mbHasRelease = true;
  mock.itunesHasResult = false;
  mock.deezerHasResult = false;
  mock.imageStatus = 200;
  mock.imageBytes = makeImageBytes(1);
}

// ── Worker harness ───────────────────────────────────────────────────────────

function runWorker(config) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [WORKER, JSON.stringify(config)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MSTREAM_MUSICBRAINZ_BASE: mock.base,
        MSTREAM_COVERARTARCHIVE_BASE: mock.base,
        MSTREAM_ITUNES_BASE: mock.base,
        MSTREAM_DEEZER_BASE: mock.base,
      },
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', d => { stdout += d.toString(); });
    p.stderr.on('data', d => { stderr += d.toString(); });
    const timer = setTimeout(() => { p.kill('SIGKILL'); }, 60_000);
    p.on('exit', (code) => {
      clearTimeout(timer);
      const events = stdout.split('\n').map(l => l.trim()).filter(l => l.startsWith('{'))
        .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(Boolean);
      const complete = events.find(e => e.event === 'albumArtComplete') || null;
      resolve({ code, events, complete, stdout, stderr });
    });
    p.on('error', reject);
  });
}

// Fresh DB with the full chain + a library + albums. Each album spec:
// { name, artist, tracks: n, artFile?: 'existing.jpg' } — artFile also
// seeds an art_files row + album_art link so dedupe probes have targets.
let scratch;
function makeDb(albums) {
  const dir = fs.mkdtempSync(path.join(scratch, 'dl-'));
  const dbPath = path.join(dir, 'mstream.db');
  const artDir = path.join(dir, 'image-cache');
  fs.mkdirSync(artDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    applyAllMigrations(db);
    const libId = Number(db.prepare("INSERT INTO libraries (name, root_path, type) VALUES ('lib', ?, 'music')")
      .run(path.join(dir, 'music')).lastInsertRowid);
    const ids = {};
    for (const a of albums) {
      // OR IGNORE + SELECT, never lastInsertRowid: a no-op'd insert leaves
      // the connection-global rowid pointing at the previous (unrelated)
      // successful insert.
      db.prepare('INSERT OR IGNORE INTO artists (name) VALUES (?)').run(a.artist);
      const artistId = db.prepare('SELECT id FROM artists WHERE name = ?').get(a.artist).id;
      const albumId = Number(db.prepare(
        'INSERT INTO albums (name, artist_id, album_art_file, album_art_source) VALUES (?, ?, ?, ?)')
        .run(a.name, artistId, a.artFile || null, a.artFile ? 'embedded' : null).lastInsertRowid);
      for (let i = 1; i <= (a.tracks ?? 2); i++) {
        db.prepare(`INSERT INTO tracks (filepath, library_id, title, artist_id, album_id, album_art_file)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .run(`${a.name}/${i}.mp3`, libId, `${a.name} ${i}`, artistId, albumId, a.artFile || null);
      }
      if (a.artFile) {
        const hash = a.artFile.split('.')[0];
        db.prepare("INSERT INTO art_files (kind, cache_file, content_hash) VALUES ('cached', ?, ?)")
          .run(a.artFile, hash);
        const artId = db.prepare('SELECT id FROM art_files WHERE cache_file = ?').get(a.artFile).id;
        db.prepare('INSERT INTO album_art (album_id, art_id, source, position) VALUES (?, ?, ?, 0)')
          .run(albumId, artId, 'embedded');
      }
      ids[a.name] = albumId;
    }
    const userVersion = db.prepare('PRAGMA user_version').get().user_version;
    return { dir, dbPath, artDir, libId, ids, userVersion };
  } finally {
    db.close();
  }
}

function baseConfig(env, overrides = {}) {
  return {
    dbPath: env.dbPath,
    albumArtDirectory: env.artDir,
    compressImage: false,
    services: ['musicbrainz', 'itunes', 'deezer'],
    mode: 'missing',
    writeToFolder: false,
    maxPerRun: 100,
    expectedSchemaVersion: env.userVersion,
    interRequestMs: 0,
    ...overrides,
  };
}

before(async () => {
  scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'mstream-artdl-'));
  await startMock();
});

after(async () => {
  if (mock.server) { mock.server.close(); }
  // Windows can hold -shm/-wal locks for a beat after a child exits —
  // best-effort cleanup, never a suite error.
  if (scratch) {
    try { await fsp.rm(scratch, { recursive: true, force: true }); }
    catch (_e) { /* leftover tmp dir, OS will reclaim */ }
  }
});

// ── V51 schema ───────────────────────────────────────────────────────────────

describe('V51 schema', () => {
  test('album_art_lookups exists with fetched_hash; not rescanRequired', () => {
    const v51 = MIGRATIONS.find(m => m.version === 51);
    assert.ok(v51, 'missing v51');
    assert.ok(!v51.rescanRequired);
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyAllMigrations(db);
    const cols = db.prepare('PRAGMA table_info(album_art_lookups)').all().map(c => c.name).sort();
    assert.deepEqual(cols, ['album_id', 'attempts', 'fetched_hash', 'last_attempt_at', 'outcome']);
    db.close();
  });
});

// ── Worker behavior ──────────────────────────────────────────────────────────

describe('downloader worker (mock services)', () => {
  test('found: default + art-less tracks stamped, junctions + hash + lookup written', async () => {
    resetMock();
    const env = makeDb([{ name: 'Artless', artist: 'A', tracks: 2 }]);
    const r = await runWorker(baseConfig(env));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      { attempted: r.complete.attempted, updated: r.complete.updated, hitCap: r.complete.hitCap },
      { attempted: 1, updated: 1, hitCap: false });

    const expectedHash = crypto.createHash('md5').update(mock.imageBytes).digest('hex');
    const db = new DatabaseSync(env.dbPath);
    try {
      // .jpeg, not .jpg: cache names use the magic-byte sniff with the
      // scanners' extension spellings, so the same bytes cached by any
      // writer converge on one filename.
      const album = db.prepare('SELECT album_art_file, album_art_source FROM albums WHERE id = ?').get(env.ids['Artless']);
      assert.equal(album.album_art_file, `${expectedHash}.jpeg`);
      assert.equal(album.album_art_source, 'musicbrainz');
      // The cache file landed on disk.
      assert.ok(fs.existsSync(path.join(env.artDir, album.album_art_file)));
      // Both art-less tracks stamped AND linked (default ∈ set).
      assert.equal(db.prepare(
        'SELECT COUNT(*) AS n FROM tracks WHERE album_id = ? AND album_art_file = ?')
        .get(env.ids['Artless'], album.album_art_file).n, 2);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM track_art').get().n, 2);
      // art_files row carries the V50 hash; album gallery linked.
      const art = db.prepare('SELECT content_hash, byte_size FROM art_files').get();
      assert.equal(art.content_hash, expectedHash);
      assert.equal(art.byte_size, mock.imageBytes.length);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM album_art').get().n, 1);
      const lookup = db.prepare('SELECT outcome, attempts, fetched_hash FROM album_art_lookups').get();
      assert.deepEqual({ ...lookup }, { outcome: 'found', attempts: 1, fetched_hash: expectedHash });
    } finally { db.close(); }
  });

  test('notfound: recorded with long cooldown — a rerun attempts nothing and stays off the network', async () => {
    resetMock();
    mock.mbHasRelease = false;
    const env = makeDb([{ name: 'Obscure', artist: 'B' }]);
    const r1 = await runWorker(baseConfig(env));
    assert.equal(r1.complete.notFound, 1);
    const requestsAfterFirst = mock.log.length;

    const r2 = await runWorker(baseConfig(env));
    assert.equal(r2.complete.attempted, 0, 'cooldown must exclude the album');
    assert.equal(mock.log.length, requestsAfterFirst, 'no further service requests');

    // Cooldown 0 → eligible again, attempts increments.
    const r3 = await runWorker(baseConfig(env, { notFoundCooldownSec: 0 }));
    assert.equal(r3.complete.attempted, 1);
    const db = new DatabaseSync(env.dbPath);
    try {
      assert.equal(db.prepare('SELECT attempts FROM album_art_lookups').get().attempts, 2);
    } finally { db.close(); }
  });

  test('trackless ghost albums are not eligible: no requests, no lookup row', async () => {
    // Starred ghosts survive the orphan sweep (star keep-conditions)
    // but are invisible on every list surface — fetching their art
    // would burn external requests forever. The eligibility query
    // requires at least one track.
    resetMock();
    const env = makeDb([
      { name: 'Ghost', artist: 'GA', tracks: 0 },
      { name: 'Live',  artist: 'LA' },
    ]);
    const r = await runWorker(baseConfig(env));
    assert.equal(r.complete.attempted, 1, 'only the live album attempted');
    const db = new DatabaseSync(env.dbPath);
    try {
      assert.equal(db.prepare(
        `SELECT COUNT(*) c FROM album_art_lookups l
           JOIN albums a ON a.id = l.album_id WHERE a.name = 'Ghost'`).get().c, 0,
        'ghost got no lookup row');
      assert.ok(db.prepare(
        `SELECT 1 FROM albums WHERE name = 'Live' AND album_art_file IS NOT NULL`).get(),
        'live album still fetched normally');
    } finally { db.close(); }
  });

  test('error: image download 5xx → short cooldown outcome', async () => {
    resetMock();
    mock.imageStatus = 503;
    const env = makeDb([{ name: 'Flaky', artist: 'C' }]);
    const r = await runWorker(baseConfig(env));
    assert.equal(r.complete.errors, 1);
    const db = new DatabaseSync(env.dbPath);
    try {
      assert.equal(db.prepare('SELECT outcome FROM album_art_lookups').get().outcome, 'error');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM art_files').get().n, 0, 'nothing written');
    } finally { db.close(); }
  });

  test('per-run cap: hitCap signals more work; the next run drains the rest', async () => {
    resetMock();
    const env = makeDb([
      { name: 'One', artist: 'D' }, { name: 'Two', artist: 'D' }, { name: 'Three', artist: 'D' },
    ]);
    const r1 = await runWorker(baseConfig(env, { maxPerRun: 2 }));
    assert.deepEqual({ attempted: r1.complete.attempted, hitCap: r1.complete.hitCap }, { attempted: 2, hitCap: true });
    const r2 = await runWorker(baseConfig(env, { maxPerRun: 2 }));
    assert.deepEqual({ attempted: r2.complete.attempted, hitCap: r2.complete.hitCap }, { attempted: 1, hitCap: false });
  });

  test('service order respected: deezer-first config never touches musicbrainz on a hit', async () => {
    resetMock();
    mock.deezerHasResult = true;
    const env = makeDb([{ name: 'Ordered', artist: 'E' }]);
    const r = await runWorker(baseConfig(env, { services: ['deezer', 'musicbrainz'] }));
    assert.equal(r.complete.updated, 1);
    assert.ok(mock.log[0].path.startsWith('/search/album'), 'deezer queried first');
    assert.ok(!mock.log.some(l => l.path.startsWith('/ws/2/release/')), 'musicbrainz never queried');
    const db = new DatabaseSync(env.dbPath);
    try {
      assert.equal(db.prepare('SELECT album_art_source FROM albums').get().album_art_source, 'deezer');
    } finally { db.close(); }
  });

  test('pacing: interRequestMs spaces album lookups', async () => {
    resetMock();
    mock.mbHasRelease = false; // search-only requests, one per album
    const env = makeDb([
      { name: 'P1', artist: 'F' }, { name: 'P2', artist: 'F' }, { name: 'P3', artist: 'F' },
    ]);
    await runWorker(baseConfig(env, { interRequestMs: 120 }));
    const searches = mock.log.filter(l => l.path.startsWith('/ws/2/release/'));
    assert.equal(searches.length, 3);
    for (let i = 1; i < searches.length; i++) {
      assert.ok(searches[i].at - searches[i - 1].at >= 100,
        `lookups ${i - 1}->${i} spaced ${searches[i].at - searches[i - 1].at}ms (< 100ms)`);
    }
  });

  test('cross-album dedupe: the same image links ONE art_files row to both albums', async () => {
    resetMock();
    const env = makeDb([{ name: 'Std Edition', artist: 'G' }, { name: 'Deluxe Edition', artist: 'G' }]);
    const r = await runWorker(baseConfig(env));
    assert.equal(r.complete.updated, 2);
    const db = new DatabaseSync(env.dbPath);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM art_files').get().n, 1, 'one row for one image');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM album_art').get().n, 2, 'both albums linked');
    } finally { db.close(); }
  });

  test("mode 'all': existing default untouched, gallery gains the new image; identical art dedupes", async () => {
    resetMock();
    // 'Has Different' carries art whose hash ≠ the mock image; 'Has Same'
    // carries EXACTLY the mock image bytes' hash.
    const mockHash = crypto.createHash('md5').update(makeImageBytes(1)).digest('hex');
    const env = makeDb([
      { name: 'Has Different', artist: 'H', artFile: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg' },
      { name: 'Has Same', artist: 'H', artFile: `${mockHash}.jpg` },
    ]);
    const r = await runWorker(baseConfig(env, { mode: 'all' }));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual({ updated: r.complete.updated, deduped: r.complete.deduped },
      { updated: 1, deduped: 1 });

    const db = new DatabaseSync(env.dbPath);
    try {
      // Defaults untouched on BOTH albums (no clobbering, ever).
      const diff = db.prepare('SELECT album_art_file, album_art_source FROM albums WHERE id = ?').get(env.ids['Has Different']);
      assert.equal(diff.album_art_file, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg');
      assert.equal(diff.album_art_source, 'embedded');
      // ...but its gallery gained the fetched image.
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM album_art WHERE album_id = ?').get(env.ids['Has Different']).n, 2);
      // The already-identical album got NOTHING new, just a found lookup.
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM album_art WHERE album_id = ?').get(env.ids['Has Same']).n, 1);
      assert.equal(db.prepare('SELECT outcome FROM album_art_lookups WHERE album_id = ?').get(env.ids['Has Same']).outcome, 'found');
      // No track defaults were touched in 'all' mode (none were NULL).
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM track_art').get().n, 0);
    } finally { db.close(); }
  });

  test('writeToFolder: cover.jpg written into album dirs; existing cover.jpg untouched', async () => {
    resetMock();
    const env = makeDb([{ name: 'Foldered', artist: 'I' }]);
    const albumDir = path.join(env.dir, 'music', 'Foldered');
    fs.mkdirSync(albumDir, { recursive: true });
    const r = await runWorker(baseConfig(env, { writeToFolder: true }));
    assert.equal(r.complete.updated, 1);
    const written = fs.readFileSync(path.join(albumDir, 'cover.jpg'));
    assert.ok(written.equals(mock.imageBytes));

    // Second album whose folder already HAS a cover.jpg — never overwritten.
    const env2 = makeDb([{ name: 'Guarded', artist: 'I' }]);
    const guardedDir = path.join(env2.dir, 'music', 'Guarded');
    fs.mkdirSync(guardedDir, { recursive: true });
    fs.writeFileSync(path.join(guardedDir, 'cover.jpg'), 'user-placed');
    await runWorker(baseConfig(env2, { writeToFolder: true }));
    assert.equal(fs.readFileSync(path.join(guardedDir, 'cover.jpg'), 'utf8'), 'user-placed');
  });

  test('schema guard: wrong expected version → exit 3, zero writes, zero network', async () => {
    resetMock();
    const env = makeDb([{ name: 'Guarded2', artist: 'J' }]);
    const r = await runWorker(baseConfig(env, { expectedSchemaVersion: env.userVersion + 1 }));
    assert.equal(r.code, 3);
    assert.equal(mock.log.length, 0);
    const db = new DatabaseSync(env.dbPath);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM album_art_lookups').get().n, 0);
    } finally { db.close(); }
  });

  test("search-leg outage reads as 'error' (short cooldown), NOT 'notfound'", async () => {
    // The asymmetric-cooldown design hinges on this: point every service
    // base at a closed port — DNS/conn-refused on the SEARCH must not
    // poison the album with the 30-day not-found cooldown.
    resetMock();
    const env = makeDb([{ name: 'Outage', artist: 'K' }]);
    const dead = 'http://127.0.0.1:1';
    const r = await new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [WORKER, JSON.stringify(baseConfig(env))], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env,
          MSTREAM_MUSICBRAINZ_BASE: dead, MSTREAM_COVERARTARCHIVE_BASE: dead,
          MSTREAM_ITUNES_BASE: dead, MSTREAM_DEEZER_BASE: dead },
      });
      let out = '';
      p.stdout.on('data', d => { out += d.toString(); });
      p.on('exit', code => resolve({ code, out }));
      p.on('error', reject);
    });
    assert.equal(r.code, 0);
    const db = new DatabaseSync(env.dbPath);
    try {
      assert.equal(db.prepare('SELECT outcome FROM album_art_lookups').get().outcome, 'error',
        'a transport outage must take the SHORT cooldown');
    } finally { db.close(); }
  });

  test('non-image payload (captive portal HTML with 200) is rejected, never becomes art', async () => {
    resetMock();
    mock.imageBytes = Buffer.from('<!DOCTYPE html><html><body>You must log in to this network</body></html>'.padEnd(2000, ' '));
    const env = makeDb([{ name: 'Portal', artist: 'L' }]);
    const r = await runWorker(baseConfig(env));
    assert.equal(r.complete.updated, 0);
    assert.equal(r.complete.notFound, 1, 'rejected candidates read as notfound');
    const db = new DatabaseSync(env.dbPath);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM art_files').get().n, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM albums WHERE album_art_file IS NOT NULL").get().n, 0);
    } finally { db.close(); }
    assert.equal(fs.readdirSync(env.artDir).length, 0, 'nothing written to the cache dir');
  });

  test('stale cached row (file gone from disk) is re-materialized from the downloaded bytes', async () => {
    resetMock();
    const hash = crypto.createHash('md5').update(mock.imageBytes).digest('hex');
    const env = makeDb([{ name: 'Stale Cache', artist: 'M' }]);
    // Seed the dedupe target: a cached row whose file does NOT exist
    // (operator cleared the image-cache dir after some earlier fetch).
    let db = new DatabaseSync(env.dbPath);
    db.prepare("INSERT INTO art_files (kind, cache_file, content_hash) VALUES ('cached', ?, ?)")
      .run(`${hash}.jpeg`, hash);
    db.close();

    const r = await runWorker(baseConfig(env));
    assert.equal(r.complete.updated, 1);
    db = new DatabaseSync(env.dbPath);
    try {
      // The existing row was reused (no duplicate)…
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM art_files').get().n, 1);
      const album = db.prepare('SELECT album_art_file FROM albums').get();
      assert.equal(album.album_art_file, `${hash}.jpeg`);
      // …and its file is back on disk with the right bytes.
      const bytes = fs.readFileSync(path.join(env.artDir, `${hash}.jpeg`));
      assert.ok(bytes.equals(mock.imageBytes), 'file re-materialized from the fetched bytes');
    } finally { db.close(); }
  });

  test('NULL-default album whose gallery already carries the image still gets STAMPED (no dedupe loop)', async () => {
    resetMock();
    const hash = crypto.createHash('md5').update(mock.imageBytes).digest('hex');
    const env = makeDb([{ name: 'Linked Not Stamped', artist: 'N' }]);
    // Album has the image in its gallery (linked) but album_art_file NULL —
    // the state a failed default election can leave behind.
    let db = new DatabaseSync(env.dbPath);
    fs.writeFileSync(path.join(env.artDir, `${hash}.jpeg`), mock.imageBytes);
    db.prepare("INSERT INTO art_files (kind, cache_file, content_hash) VALUES ('cached', ?, ?)").run(`${hash}.jpeg`, hash);
    const artId = db.prepare('SELECT id FROM art_files').get().id;
    const albumId = db.prepare('SELECT id FROM albums').get().id;
    db.prepare('INSERT INTO album_art (album_id, art_id, source, position) VALUES (?, ?, ?, 0)').run(albumId, artId, 'musicbrainz');
    db.close();

    const r = await runWorker(baseConfig(env));
    assert.equal(r.complete.updated, 1, 'must fall through dedupe and stamp');
    assert.equal(r.complete.deduped, 0);
    db = new DatabaseSync(env.dbPath);
    try {
      assert.equal(db.prepare('SELECT album_art_file FROM albums').get().album_art_file, `${hash}.jpeg`);
      // Idempotent against the existing rows: still one art row, one link.
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM art_files').get().n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM album_art').get().n, 1);
    } finally { db.close(); }
  });
});

// ── Task-queue chaining (real booted server) ─────────────────────────────────

describe('scan → downloader chaining (booted server)', () => {
  test('a completed scan chains the download pass; lookups + art land', { timeout: 180_000 }, async () => {
    resetMock();
    const { startServer } = await import('../helpers/server.mjs');
    const srv = await startServer({
      extraConfig: { scanOptions: { autoAlbumArt: true } },
      env: {
        MSTREAM_MUSICBRAINZ_BASE: mock.base,
        MSTREAM_COVERARTARCHIVE_BASE: mock.base,
        MSTREAM_ITUNES_BASE: mock.base,
        MSTREAM_DEEZER_BASE: mock.base,
      },
    });
    try {
      // The boot scan runs, drains, and chains the downloader. Poll the
      // DB for its evidence: lookup rows + stamped albums.
      const dbPath = path.join(srv.tmpDir, 'db', 'mstream.db');
      const deadline = Date.now() + 120_000;
      let lookups = 0;
      let stamped = 0;
      while (Date.now() < deadline) {
        try {
          const db = new DatabaseSync(dbPath, { readOnly: true });
          lookups = db.prepare('SELECT COUNT(*) AS n FROM album_art_lookups').get().n;
          stamped = db.prepare('SELECT COUNT(*) AS n FROM albums WHERE album_art_file IS NOT NULL').get().n;
          db.close();
          if (lookups > 0 && stamped > 0) { break; }
        } catch (_e) { /* DB mid-migration — retry */ }
        await new Promise(r => setTimeout(r, 500));
      }
      assert.ok(lookups > 0, 'the chained pass must record lookups');
      assert.ok(stamped > 0, 'fixture albums must get stamped with mock art');
    } finally {
      await srv.stop();
    }
  });
});
