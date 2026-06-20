/**
 * Canonical-hash endpoint behavior (V52 companion).
 *
 * Pins the writer/reader contract on a real booted server:
 *   - scrobble-by-filepath keys plays on the CANONICAL hash (audio_hash
 *     when present) and the play is visible to recently/most-played —
 *     the pre-V52 bug SELECTed no audio_hash, keyed every play on
 *     file_hash, and every COALESCE-join reader missed it forever.
 *   - legacy file_hash-keyed bookmarks (pre-audio_hash rows) are
 *     deletable and never duplicate: deleteBookmark removes EVERY
 *     identity hash, createBookmark supersedes the legacy row.
 *   - un-starring a never-starred song mints no all-null dead row.
 *   - rating a hashless track (failed parse) is a clean client error,
 *     not a NOT NULL constraint 500.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../helpers/server.mjs';

const ADMIN = { username: 'admin', password: 'pw-admin-1' };

let server;
let jwt;
let apiKey;
let dbPath;
let vpath;

function withDb(fn) {
  const db = new DatabaseSync(dbPath);
  try { return fn(db); } finally { db.close(); }
}

before(async () => {
  server = await startServer({
    dlnaMode: 'disabled',
    users: [{ ...ADMIN, admin: true }],
  });

  const loginR = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  jwt = (await loginR.json()).token;
  const keyR = await fetch(`${server.baseUrl}/api/v1/user/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-token': jwt },
    body: JSON.stringify({ name: 'canonical-hash-tests' }),
  });
  apiKey = (await keyR.json()).key;

  // Locate the instance's SQLite file + library vpath for DB assertions.
  const found = fs.readdirSync(server.tmpDir, { recursive: true })
    .find(f => String(f).endsWith('.db') && !String(f).includes('-wal'));
  assert.ok(found, 'server db file located');
  dbPath = path.join(server.tmpDir, String(found));
  vpath = withDb(db => db.prepare('SELECT name FROM libraries LIMIT 1').get().name);
});

after(async () => { if (server) { await server.stop(); } });

function post(p, body) {
  return fetch(`${server.baseUrl}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-token': jwt },
    body: JSON.stringify(body),
  });
}

async function sub(method, params = {}) {
  const q = new URLSearchParams({ f: 'json', apiKey });
  for (const [k, v] of Object.entries(params)) { q.set(k, v); }
  const r = await fetch(`${server.baseUrl}/rest/${method}?${q}`);
  return (await r.json())['subsonic-response'];
}

// A scanned track that carries an audio_hash, plus its subsonic song id.
async function pickTrack() {
  const t = withDb(db => db.prepare(`
    SELECT id, filepath, file_hash, audio_hash FROM tracks
     WHERE audio_hash IS NOT NULL AND file_hash IS NOT NULL
       AND audio_hash != file_hash LIMIT 1`).get());
  assert.ok(t, 'fixture library has a dual-hash track');
  const r = await sub('getRandomSongs', { size: 500 });
  const song = r.randomSongs.song.find(s => s.path === t.filepath || s.path?.endsWith(t.filepath));
  assert.ok(song, 'subsonic id resolved for the chosen track');
  return { ...t, songId: song.id };
}

describe('canonical-hash endpoint contract', () => {
  test('scrobble-by-filepath keys on audio_hash and shows in recently/most-played', async () => {
    const t = await pickTrack();

    const r = await post('/api/v1/lastfm/scrobble-by-filepath',
      { filePath: `${vpath}/${t.filepath}` });
    assert.equal(r.status, 200);

    withDb(db => {
      assert.ok(db.prepare('SELECT 1 FROM user_metadata WHERE track_hash = ?').get(t.audio_hash),
        'play keyed on the canonical (audio) hash');
      assert.equal(db.prepare('SELECT COUNT(*) c FROM user_metadata WHERE track_hash = ?')
        .get(t.file_hash).c, 0, 'nothing keyed on file_hash');
    });

    for (const ep of ['recently-played', 'most-played']) {
      const list = await (await post(`/api/v1/db/stats/${ep}`, { limit: 10 })).json();
      const items = Array.isArray(list) ? list : (list.songs || list.rows || []);
      assert.ok(JSON.stringify(items).includes(t.filepath),
        `${ep} sees the scrobbled track`);
    }
  });

  test('legacy file_hash-keyed bookmark: listed, deletable, superseded by re-create', async () => {
    const t = await pickTrack();
    const userId = withDb(db =>
      db.prepare('SELECT id FROM users WHERE username = ?').get(ADMIN.username).id);

    // Plant a legacy-keyed bookmark (pre-audio_hash era row).
    withDb(db => db.prepare(`INSERT INTO user_bookmarks (user_id, track_hash, position_ms)
      VALUES (?, ?, 1234)`).run(userId, t.file_hash));

    let r = await sub('getBookmarks');
    assert.equal(r.bookmarks.bookmark.length, 1, 'legacy bookmark listed');

    // createBookmark over it: exactly one row, keyed canonical.
    await sub('createBookmark', { id: t.songId, position: 9999 });
    withDb(db => {
      const rows = db.prepare('SELECT track_hash, position_ms FROM user_bookmarks WHERE user_id = ?')
        .all(userId);
      assert.equal(rows.length, 1, 'legacy row superseded, no duplicate');
      assert.equal(rows[0].track_hash, t.audio_hash, 'keyed on the canonical hash');
      assert.equal(rows[0].position_ms, 9999);
    });

    // Plant the legacy row again next to the canonical one; delete must
    // remove BOTH identities (pre-fix, the legacy row was undeletable).
    withDb(db => db.prepare(`INSERT INTO user_bookmarks (user_id, track_hash, position_ms)
      VALUES (?, ?, 1234)`).run(userId, t.file_hash));
    await sub('deleteBookmark', { id: t.songId });
    withDb(db => {
      assert.equal(db.prepare('SELECT COUNT(*) c FROM user_bookmarks WHERE user_id = ?')
        .get(userId).c, 0, 'delete removed every identity-keyed row');
    });
    r = await sub('getBookmarks');
    assert.equal(r.bookmarks.bookmark.length, 0);
  });

  test('un-starring a never-starred song mints no dead row', async () => {
    const t = await pickTrack();
    const beforeCount = withDb(db =>
      db.prepare('SELECT COUNT(*) c FROM user_metadata').get().c);
    const r = await sub('unstar', { id: t.songId });
    assert.equal(r.status, 'ok');
    const afterCount = withDb(db =>
      db.prepare('SELECT COUNT(*) c FROM user_metadata').get().c);
    assert.equal(afterCount, beforeCount, 'no row created by the no-op unstar');
  });

  test('rating a hashless track is a clean error, not a constraint 500', async () => {
    // Different track from the others so the hash surgery can't bleed.
    const victim = withDb(db => {
      const row = db.prepare(`SELECT id, filepath, file_hash, audio_hash FROM tracks
        WHERE audio_hash IS NOT NULL ORDER BY id DESC LIMIT 1`).get();
      db.prepare('UPDATE tracks SET file_hash = NULL, audio_hash = NULL WHERE id = ?').run(row.id);
      return row;
    });
    try {
      const r = await post('/api/v1/db/rate-song',
        { filePath: `${vpath}/${victim.filepath}`, rating: 8 });
      assert.notEqual(r.status, 500, 'constraint throw must not surface as 500');
      assert.ok(r.status >= 400, 'hashless track is a client-visible error');
    } finally {
      withDb(db => db.prepare('UPDATE tracks SET file_hash = ?, audio_hash = ? WHERE id = ?')
        .run(victim.file_hash, victim.audio_hash, victim.id));
    }
  });
});
