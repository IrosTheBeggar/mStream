/**
 * Album-view track ordering — /api/v1/db/album-songs.
 *
 * The webapp's album view renders this endpoint's rows in the order it
 * receives them (webapp/alpha/m.js getAlbumSongs — no client-side sort), so
 * this response IS the order the user sees.
 *
 * The ordering used to be a plain `t.disc_number, t.track_number, t.filepath`,
 * and SQLite sorts NULL FIRST. Any track whose disc or track number was
 * missing therefore jumped ABOVE the properly tagged ones, and an album with
 * no track numbers at all fell through to the filepath tiebreak — i.e. showed
 * up in alphabetical order. ALBUM_TRACK_ORDER (src/db/track-order.js) fixes
 * both: a missing disc number means disc 1, and a missing track number sorts
 * to the end of its disc.
 *
 * The upstream half of the same bug — the Rust scanner dropping track/disc
 * numbers written in the "N/total" form — is covered by
 * test/scanner/scanner-track-disc-numbers.test.mjs.
 *
 * Pattern mirrors test/integration/genre-agg-endpoints.test.mjs: boot a real
 * mStream in public/no-users mode, seed the DB directly, hit the HTTP API.
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

async function bootMstream(tmpDir, musicDir) {
  const port = await findFreePort();
  const config = {
    port, address: '127.0.0.1', ui: 'default',
    dlna:     { mode: 'disabled' },
    subsonic: { mode: 'disabled' },
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
    // Don't leak the child on a ready-timeout — a live orphan's stdio keeps
    // this file's event loop open and the run hangs at exit instead of
    // reporting the timeout.
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

// Four albums, each isolating one ordering rule. Titles and filenames are
// deliberately NOT in track order, so any fallback to alphabetical shows up
// as a wrong result rather than an accidental pass.
function seedDB(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');

  const lib = db.prepare("SELECT id FROM libraries WHERE name = 'testlib'").get().id;
  const artist = Number(db.prepare("INSERT INTO artists (name) VALUES ('Order Artist')").run().lastInsertRowid);
  const insAlbum = db.prepare('INSERT INTO albums (name, artist_id, year) VALUES (?, ?, 2001)');
  const insTrack = db.prepare(`
    INSERT INTO tracks (filepath, library_id, title, artist_id, album_id, track_number,
                        disc_number, year, format, duration, file_hash, audio_hash, modified, scan_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 2001, 'flac', 180, ?, ?, 1700000000000, 'seed')
  `);
  let n = 0;
  const album = (name, tracks) => {
    const id = Number(insAlbum.run(name, artist).lastInsertRowid);
    for (const [title, track, disc] of tracks) {
      n += 1;
      insTrack.run(`${name}/${title}.flac`, lib, title, artist, id, track, disc, `h${n}`, `a${n}`);
    }
  };

  // The plain case: fully tagged, single disc. Alphabetical order would be
  // Apple, Banana, Mango, Zebra — the exact symptom the fix is about.
  album('Tagged Album', [
    ['Zebra', 1, 1], ['Mango', 2, 1], ['Banana', 3, 1], ['Apple', 4, 1],
  ]);

  // Only SOME files carry a disc tag — the common case after a partial
  // re-tag, or (before the scanner fix) a mixed-format album. The untagged
  // ones must interleave with disc 1, not stack on top of it.
  album('Half Disc Tagged', [
    ['Zebra', 1, 1], ['Mango', 2, null], ['Banana', 3, 1], ['Apple', 4, null],
  ]);

  // Genuine two-disc set: disc 2 must follow disc 1 even though its track
  // numbers restart at 1.
  album('Two Disc Set', [
    ['Zebra', 1, 1], ['Mango', 2, 1], ['Apple', 1, 2], ['Banana', 2, 2],
  ]);

  // Tracks with no number at all belong at the BOTTOM of the album, ordered
  // by filepath among themselves — not hoisted above the numbered ones.
  album('Partly Numbered', [
    ['Zebra', 1, 1], ['Mango', 2, 1], ['Apple', null, 1], ['Banana', null, null],
  ]);

  db.close();
}

async function albumSongs(baseUrl, album) {
  const r = await fetch(`${baseUrl}/api/v1/db/album-songs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ album }),
  });
  assert.equal(r.status, 200, `album-songs ${album} returned ${r.status}`);
  return (await r.json()).map(x => x.metadata.title);
}

describe('album view track ordering', () => {
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-albumorder-'));
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

  test('a fully tagged album comes back in track order, not alphabetical', async () => {
    assert.deepEqual(await albumSongs(server.baseUrl, 'Tagged Album'),
      ['Zebra', 'Mango', 'Banana', 'Apple']);
  });

  test('tracks with no disc tag interleave with disc 1 instead of jumping above it', async () => {
    assert.deepEqual(await albumSongs(server.baseUrl, 'Half Disc Tagged'),
      ['Zebra', 'Mango', 'Banana', 'Apple']);
  });

  test('disc 2 follows disc 1 even though its track numbers restart', async () => {
    assert.deepEqual(await albumSongs(server.baseUrl, 'Two Disc Set'),
      ['Zebra', 'Mango', 'Apple', 'Banana']);
  });

  test('tracks with no track number sort to the end, not the start', async () => {
    // Apple and Banana are unnumbered, so they land last and fall back to
    // filepath order between themselves.
    assert.deepEqual(await albumSongs(server.baseUrl, 'Partly Numbered'),
      ['Zebra', 'Mango', 'Apple', 'Banana']);
  });
});
