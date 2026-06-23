/**
 * Lyrics backfill worker — hermetic integration tests.
 *
 * Spins a local mock LRCLib server, builds a fresh V53 DB via the real
 * migration set, seeds tracks, and runs the actual worker child against it —
 * asserting the track write + lyrics_source + FTS population + the lyrics_cache
 * cooldown ledger, plus cooldown and cross-duplicate dedup behaviour.
 *
 * The worker is spawned ASYNCHRONOUSLY (not execFileSync) so this process's
 * event loop stays free to serve the in-process mock server while the worker
 * child fetches from it — a sync spawn would deadlock the two.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { applyAllMigrations } from './helpers/apply-migrations.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.resolve(__dirname, '..', 'src/db/lyrics-backfill.mjs');
const DEAD = 'http://127.0.0.1:59999';

let server, base;
before(async () => {
  // Returns synced lyrics for track_name=Yellow, 404 for anything else.
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('Content-Type', 'application/json');
    if (u.searchParams.get('track_name') === 'Yellow') {
      res.end(JSON.stringify({ syncedLyrics: '[00:35.66]Look at the stars\n[00:38.46]Look how they shine', plainLyrics: 'Look at the stars' }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

function makeDb(seed) {
  const dbPath = path.join(os.tmpdir(), `lyrics-bf-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA recursive_triggers = ON');
  applyAllMigrations(db);
  const libId = Number(db.prepare("INSERT INTO libraries (name, root_path) VALUES ('m', '/m')").run().lastInsertRowid);
  const arId = Number(db.prepare("INSERT INTO artists (name) VALUES ('Coldplay')").run().lastInsertRowid);
  const ins = db.prepare('INSERT INTO tracks (filepath, library_id, title, artist_id, duration, audio_hash) VALUES (?, ?, ?, ?, ?, ?)');
  const ids = {};
  for (const t of seed) { ids[t.key] = Number(ins.run(t.filepath, libId, t.title, arId, t.duration ?? 0, t.hash).lastInsertRowid); }
  db.close();
  return { dbPath, ids };
}

async function runWorker(dbPath, extra = {}) {
  const payload = JSON.stringify({ dbPath, providers: ['lrclib'], expectedSchemaVersion: 53, maxPerRun: 100, interRequestMs: 0, ...extra });
  const { stdout } = await execFileAsync(process.execPath, [WORKER, payload], {
    env: { ...process.env, MSTREAM_LRCLIB_BASE: base, MSTREAM_NETEASE_BASE: DEAD, MSTREAM_KUGOU_SEARCH_BASE: DEAD, MSTREAM_KUGOU_LYRICS_BASE: DEAD },
  });
  return JSON.parse(stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop());
}

const cleanup = (dbPath) => { for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) { fs.rmSync(f, { force: true }); } };

test('writes fetched lyrics + source + FTS + cache hit; records a miss for a no-match', async () => {
  const { dbPath, ids } = makeDb([
    { key: 'hit', title: 'Yellow', filepath: 'a.flac', hash: 'h_hit', duration: 267 },
    { key: 'miss', title: 'Nonexistent Song XYZ', filepath: 'b.flac', hash: 'h_miss', duration: 100 },
  ]);
  const evt = await runWorker(dbPath);
  assert.equal(evt.event, 'lyricsComplete');
  assert.equal(evt.updated, 1);
  assert.equal(evt.notFound, 1);

  const db = new DatabaseSync(dbPath);
  const hit = db.prepare('SELECT lyrics_synced_lrc AS lrc, lyrics_source AS src FROM tracks WHERE id = ?').get(ids.hit);
  assert.match(hit.lrc, /stars/);
  assert.equal(hit.src, 'lrclib');
  assert.equal(db.prepare('SELECT lyrics_synced_lrc AS lrc FROM tracks WHERE id = ?').get(ids.miss).lrc, null);
  assert.ok(db.prepare('SELECT length(lyrics) AS n FROM fts_tracks WHERE rowid = ?').get(ids.hit).n > 0);
  assert.equal(db.prepare("SELECT status FROM lyrics_cache WHERE audio_hash = 'h_hit'").get().status, 'hit');
  assert.equal(db.prepare("SELECT status FROM lyrics_cache WHERE audio_hash = 'h_miss'").get().status, 'miss');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fts_tracks WHERE fts_tracks MATCH 'stars'").get().n, 1);
  db.close();
  cleanup(dbPath);
});

test('cooldown: a second pass re-attempts nothing (hit has lyrics, miss is within cooldown)', async () => {
  const { dbPath } = makeDb([
    { key: 'hit', title: 'Yellow', filepath: 'a.flac', hash: 'h1', duration: 1 },
    { key: 'miss', title: 'No Match', filepath: 'b.flac', hash: 'h2', duration: 1 },
  ]);
  await runWorker(dbPath);
  assert.equal((await runWorker(dbPath)).attempted, 0);
  cleanup(dbPath);
});

test('cooldown override: an aged-out miss is retried', async () => {
  const { dbPath } = makeDb([{ key: 'miss', title: 'No Match', filepath: 'a.flac', hash: 'hm', duration: 1 }]);
  await runWorker(dbPath); // writes a 'miss' row (default 30d cooldown)
  assert.equal((await runWorker(dbPath, { notFoundCooldownSec: 0 })).attempted, 1); // off cooldown → retried
  cleanup(dbPath);
});

test('cross-duplicate dedup: two tracks sharing an audio_hash both get the cached lyrics', async () => {
  const { dbPath, ids } = makeDb([
    { key: 'a', title: 'Yellow', filepath: 'a.flac', hash: 'dup', duration: 1 },
    { key: 'b', title: 'Yellow', filepath: 'b.flac', hash: 'dup', duration: 1 },
  ]);
  assert.equal((await runWorker(dbPath)).updated, 2);
  const db = new DatabaseSync(dbPath);
  for (const id of [ids.a, ids.b]) {
    assert.match(db.prepare('SELECT lyrics_synced_lrc AS l FROM tracks WHERE id = ?').get(id).l, /stars/);
  }
  db.close();
  cleanup(dbPath);
});
