/**
 * The album's credit on every song (metadata 'album-artist', 2026-10-23):
 * trackQuery's album_credit — the album's ALBUMARTIST consensus
 * (albums.album_artist), else its primary artist (albums.artist_id) — on
 * every route that renders song metadata, full or lite:
 *
 *   POST /api/v1/file-explorer { pullMetadata: true }   (pullMetaDataBatch)
 *   POST /api/v1/db/album-songs                          (and narrowed by album_artist)
 *   POST /api/v1/db/search                               (lite, renderMetadataByIds)
 *   POST /api/v1/db/genre-songs
 *   POST /api/v1/db/recent/added
 *   POST /api/v1/db/metadata, /api/v1/db/metadata/batch
 *
 * for an album credited to its artist, a compilation credited to Various
 * Artists (each song by its own artist), and a song with no album (null).
 * It is the credit Discover rows carry as `albumArtist`, so a client keeps
 * an album whole from any of its songs. A peer's answers reach a browsing
 * server verbatim through the federation proxy.
 *
 * Pattern mirrors file-explorer-metadata.test.mjs: boot a real mStream in
 * public mode, put dummy files on disk (the explorer only stats them), seed
 * the DB directly, boot again, hit the HTTP API. No ffmpeg.
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

async function waitForReady(baseUrl, timeoutMs = 90_000) {
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

async function bootMstream(tmpDir, musicDir) {
  const port = await findFreePort();
  const config = {
    port, address: '127.0.0.1',
    dlna:     { mode: 'disabled' },
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
  try {
    await waitForReady(baseUrl);
  } catch (err) {
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    throw err;
  }
  return { proc, baseUrl, port };
}

async function killProc(proc) {
  if (proc.exitCode != null || proc.signalCode != null) return;
  proc.kill('SIGKILL');
  await new Promise(r => proc.once('exit', r));
}

// [library-relative path, title, artist, album, created_at]
const SONGS = [
  ['Boukmanflow/Borrowed Tapes/01 - Rooftop Cypher.mp3', 'Rooftop Cypher', 'Boukmanflow', 'Borrowed Tapes', '2026-01-01 00:00:01'],
  ['Boukmanflow/Borrowed Tapes/02 - Late Train Verse.mp3', 'Late Train Verse', 'Boukmanflow', 'Borrowed Tapes', '2026-01-01 00:00:02'],
  ['Various Artists/Night Market Sampler/01 - Lantern Street.mp3', 'Lantern Street', 'Color Out', 'Night Market Sampler', '2026-01-01 00:00:03'],
  ['Various Artists/Night Market Sampler/02 - Night Market Cypher.mp3', 'Night Market Cypher', 'Boukmanflow', 'Night Market Sampler', '2026-01-01 00:00:04'],
  ['Color Out/Joint Session/01 - Side By Side.mp3', 'Side By Side', 'Color Out', 'Joint Session', '2026-01-01 00:00:05'],
  ['Loose/Stray Cypher.mp3', 'Stray Cypher', 'Lantern Choir', null, '2026-01-01 00:00:06'],
];
// What each song's 'album-artist' must be: the album credited to its artist
// through albums.artist_id (no ALBUMARTIST tag), the compilation through
// its ALBUMARTIST consensus (no primary artist at all), an album whose
// ALBUMARTIST tag is more than its primary artist (a joined "A & B": the
// tag as written wins), the loose song none.
const CREDIT = {
  'Rooftop Cypher': 'Boukmanflow', 'Late Train Verse': 'Boukmanflow',
  'Lantern Street': 'Various Artists', 'Night Market Cypher': 'Various Artists',
  'Side By Side': 'Color Out & ALM',
  'Stray Cypher': null,
};

function seedDB(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  const lib = db.prepare("SELECT id FROM libraries WHERE name = 'testlib'").get().id;
  const artist = {};
  for (const name of ['Boukmanflow', 'Color Out', 'Lantern Choir']) {
    artist[name] = Number(db.prepare('INSERT INTO artists (name) VALUES (?)').run(name).lastInsertRowid);
  }
  const album = {
    'Borrowed Tapes': Number(db.prepare("INSERT INTO albums (name, artist_id, year) VALUES ('Borrowed Tapes', ?, 2019)").run(artist.Boukmanflow).lastInsertRowid),
    'Night Market Sampler': Number(db.prepare("INSERT INTO albums (name, artist_id, year, album_artist, compilation) VALUES ('Night Market Sampler', NULL, 2024, 'Various Artists', 1)").run().lastInsertRowid),
    'Joint Session': Number(db.prepare("INSERT INTO albums (name, artist_id, year, album_artist) VALUES ('Joint Session', ?, 2025, 'Color Out & ALM')").run(artist['Color Out']).lastInsertRowid),
  };
  const genre = Number(db.prepare("INSERT INTO genres (name) VALUES ('Hip-Hop')").run().lastInsertRowid);
  const insT = db.prepare(`
    INSERT INTO tracks (filepath, library_id, title, artist_id, album_id, year, format, duration,
                        file_hash, audio_hash, modified, created_at, tag_album_artist, scan_id)
    VALUES (?, ?, ?, ?, ?, ?, 'mp3', 9, ?, ?, 1700000000000, ?, ?, 'seed')
  `);
  SONGS.forEach(([rel, title, by, al, created], i) => {
    const tagged = { 'Night Market Sampler': 'Various Artists', 'Joint Session': 'Color Out & ALM' }[al] || null;
    const id = Number(insT.run(rel, lib, title, artist[by], al ? album[al] : null, al ? 2019 : null,
      `h${i}`, `a${i}`, created, tagged).lastInsertRowid);
    db.prepare('INSERT INTO track_genres (track_id, genre_id) VALUES (?, ?)').run(id, genre);
  });
  db.close();
}

async function post(baseUrl, route, body) {
  const r = await fetch(`${baseUrl}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal(r.status, 200, `${route} answered ${r.status}`);
  return r.json();
}

// title → 'album-artist' for every song a route rendered.
function credits(rows) {
  const out = {};
  for (const row of rows) {
    assert.ok('album-artist' in row.metadata, `${row.metadata.title}: the key is always there`);
    out[row.metadata.title] = row.metadata['album-artist'];
  }
  return out;
}
const expected = (...titles) => Object.fromEntries(titles.map((t) => [t, CREDIT[t]]));

describe("song metadata names the album's credit ('album-artist')", () => {
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-albumartist-'));
    for (const [rel] of SONGS) {
      await fs.mkdir(path.dirname(path.join(tmpDir, 'music', rel)), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'music', rel), 'x');
    }
    server = await bootMstream(tmpDir, path.join(tmpDir, 'music'));
    await killProc(server.proc);
    await sleep(200);
    seedDB(path.join(tmpDir, 'db', 'mstream.db'));
    server = await bootMstream(tmpDir, path.join(tmpDir, 'music'));
  });

  after(async () => {
    if (server?.proc) await killProc(server.proc);
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test('the file explorer (pullMetadata): the album, the compilation, the loose song', async () => {
    const seen = {};
    for (const dir of ['/testlib/Boukmanflow/Borrowed Tapes', '/testlib/Various Artists/Night Market Sampler', '/testlib/Color Out/Joint Session', '/testlib/Loose']) {
      const body = await post(server.baseUrl, '/api/v1/file-explorer', { directory: dir, pullMetadata: true });
      Object.assign(seen, credits(body.files.map((f) => f.metadata)));
    }
    assert.deepEqual(seen, CREDIT);
  });

  test('album songs: the album and the compilation, by name and narrowed by the credit; the singles bucket has none', async () => {
    const tapes = await post(server.baseUrl, '/api/v1/db/album-songs', { album: 'Borrowed Tapes' });
    assert.deepEqual(credits(tapes), expected('Rooftop Cypher', 'Late Train Verse'));
    const sampler = await post(server.baseUrl, '/api/v1/db/album-songs', { album: 'Night Market Sampler' });
    assert.deepEqual(credits(sampler), expected('Lantern Street', 'Night Market Cypher'), 'every song of it, each by its own artist');
    // album_artist narrows through trackQuery's own join of the primary artist.
    const narrowed = await post(server.baseUrl, '/api/v1/db/album-songs', { album: 'Night Market Sampler', album_artist: 'Various Artists' });
    assert.deepEqual(narrowed.map((s) => s.metadata.title), ['Lantern Street', 'Night Market Cypher'], 'the credit narrows by the ALBUMARTIST consensus');
    const byPrimary = await post(server.baseUrl, '/api/v1/db/album-songs', { album: 'Borrowed Tapes', album_artist: 'boukmanflow' });
    assert.deepEqual(byPrimary.map((s) => s.metadata.title), ['Rooftop Cypher', 'Late Train Verse'], 'and by the primary artist\'s key');
    const joint = await post(server.baseUrl, '/api/v1/db/album-songs', { album: 'Joint Session', album_artist: CREDIT['Side By Side'] });
    assert.deepEqual(credits(joint), expected('Side By Side'), 'the credit a song names finds its album again');
    assert.deepEqual(await post(server.baseUrl, '/api/v1/db/album-songs', { album: 'Borrowed Tapes', album_artist: 'Various Artists' }), [], 'another credit is another album');
    const singles = await post(server.baseUrl, '/api/v1/db/album-songs', { album: null, artist: 'Lantern Choir' });
    assert.deepEqual(credits(singles), expected('Stray Cypher'));
  });

  test('search: the lite metadata of a song hit carries it', async () => {
    const body = await post(server.baseUrl, '/api/v1/db/search', { search: 'cypher' });
    assert.deepEqual(credits(body.title), expected('Rooftop Cypher', 'Night Market Cypher', 'Stray Cypher'));
  });

  test('genre songs and recently added', async () => {
    assert.deepEqual(credits(await post(server.baseUrl, '/api/v1/db/genre-songs', { genre: 'Hip-Hop' })), CREDIT);
    const recent = await post(server.baseUrl, '/api/v1/db/recent/added', { limit: 10 });
    assert.deepEqual(recent.map((s) => s.metadata.title), SONGS.map((s) => s[1]).reverse(), 'newest first, as before');
    assert.deepEqual(credits(recent), CREDIT);
  });

  test('metadata and metadata batch', async () => {
    const paths = SONGS.map(([rel]) => `testlib/${rel}`);
    const batch = await post(server.baseUrl, '/api/v1/db/metadata/batch', paths);
    assert.deepEqual(credits(paths.map((p) => batch[p])), CREDIT);
    for (const [i, p] of paths.entries()) {
      const one = await post(server.baseUrl, '/api/v1/db/metadata', { filepath: p });
      assert.equal(one.metadata['album-artist'], CREDIT[SONGS[i][1]], p);
    }
  });
});
