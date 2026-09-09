/**
 * V70: the Stats API v2 tables, and the store primitive that writes them.
 *
 *  - a fresh database ends with the new play_events shape (V69 dropped the
 *    velvet-era one), user_hour_stats, and the three user_metadata columns;
 *  - recordPlayEvents inserts the event and bumps the hourly rollup and the
 *    per-track counters in lock-step; last/first played move only on a
 *    counted play; listened time and skips accumulate on every event;
 *  - a replayed event id is a no-op end to end (the outbox contract);
 *  - a federated play keeps its snapshot and survives the peer's deletion
 *    (peer_id → NULL); a user's plays die with the user.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { SCHEMA_VERSION, MIGRATIONS } from '../../src/db/schema.js';
import { applyAllMigrations } from '../helpers/apply-migrations.mjs';
import { recordPlayEvents, recordPlayEvent, normalizeEvent } from '../../src/stats/store.js';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA recursive_triggers = ON');
  applyAllMigrations(db);
  return db;
}
const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

function seedUser(db, name = 'alice') {
  return Number(db.prepare("INSERT INTO users (username, password, salt) VALUES (?, 'h', 's')").run(name).lastInsertRowid);
}
function seedPeer(db) {
  return Number(db.prepare("INSERT INTO federation_peers (name, endpoint_ticket, api_key) VALUES ('Bob', 't', 'fedk_bob')").run().lastInsertRowid);
}

const base = (over = {}) => ({
  eventId: 'e1', userId: 1, trackHash: 'ah1', filepath: 'Artist/song.flac', libraryId: null,
  outcome: 'completed', counted: true, playedMs: 200_000, durationMs: 210_000,
  startedAt: new Date('2026-09-04T19:04:00.500Z'), endedAt: new Date('2026-09-04T19:07:20.500Z'),
  source: 'manual', client: 'mstream-music/0.36', sessionId: 's1', ...over,
});

describe('V70 stats tables', () => {
  test('registered, no rescan, covered by SCHEMA_VERSION', () => {
    const v70 = MIGRATIONS.find((m) => m.version === 70);
    assert.ok(v70, 'missing v70 migration');
    assert.match(v70.sql, /CREATE TABLE IF NOT EXISTS play_events/);
    assert.match(v70.sql, /CREATE TABLE IF NOT EXISTS user_hour_stats/);
    assert.ok(!v70.rescanRequired);
    assert.ok(SCHEMA_VERSION >= 70);
  });

  test('a fresh database has the v2 shape', () => {
    const db = freshDb();
    const pe = columns(db, 'play_events');
    for (const c of ['event_id', 'track_hash', 'peer_id', 'snapshot', 'client', 'counted', 'played_ms', 'duration_ms', 'started_at']) {
      assert.ok(pe.includes(c), `play_events.${c}`);
    }
    assert.deepEqual(columns(db, 'user_hour_stats'), ['user_id', 'hour', 'events', 'plays', 'skips', 'listened_ms']);
    const um = columns(db, 'user_metadata');
    for (const c of ['skip_count', 'listened_ms', 'first_played']) { assert.ok(um.includes(c), `user_metadata.${c}`); }
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'play_events'").all().map((r) => r.name);
    for (const i of ['idx_play_events_user_time', 'idx_play_events_user_hash', 'idx_play_events_library', 'idx_play_events_peer']) {
      assert.ok(idx.includes(i), i);
    }
    db.close();
  });
});

describe('recordPlayEvents', () => {
  test('one counted play: event + rollup + counters, times stored as SQLite text', () => {
    const db = freshDb();
    const uid = seedUser(db);
    const r = recordPlayEvents(db, [base({ userId: uid })]);
    assert.deepEqual(r, { inserted: 1, duplicates: 0 });

    const ev = db.prepare('SELECT * FROM play_events').get();
    assert.equal(ev.started_at, '2026-09-04 19:04:00.500');
    assert.equal(ev.ended_at, '2026-09-04 19:07:20.500');
    assert.equal(ev.counted, 1);
    assert.equal(ev.client, 'mstream-music/0.36');

    const hour = db.prepare('SELECT * FROM user_hour_stats').get();
    assert.equal(hour.hour, '2026-09-04T19');
    assert.deepEqual([hour.events, hour.plays, hour.skips, hour.listened_ms], [1, 1, 0, 200_000]);

    const um = db.prepare('SELECT * FROM user_metadata WHERE user_id = ? AND track_hash = ?').get(uid, 'ah1');
    assert.deepEqual([um.play_count, um.skip_count, um.listened_ms], [1, 0, 200_000]);
    assert.equal(um.first_played, '2026-09-04 19:04:00.500');
    assert.equal(um.last_played, '2026-09-04 19:04:00.500');
    db.close();
  });

  test('a skip that is not counted moves skips and listened time, never play_count or last_played', () => {
    const db = freshDb();
    const uid = seedUser(db);
    recordPlayEvents(db, [
      base({ userId: uid, eventId: 'e1', startedAt: '2026-09-01 10:00:00' }),
      base({ userId: uid, eventId: 'e2', outcome: 'skipped', counted: false, playedMs: 8_000,
        startedAt: '2026-09-02 10:00:00', endedAt: null }),
    ]);
    const um = db.prepare('SELECT * FROM user_metadata WHERE track_hash = ?').get('ah1');
    assert.deepEqual([um.play_count, um.skip_count, um.listened_ms], [1, 1, 208_000]);
    assert.equal(um.last_played, '2026-09-01 10:00:00.000');
    assert.equal(um.first_played, '2026-09-01 10:00:00.000');
    // node:sqlite rows are null-prototype objects; spread them for deepEqual.
    const hours = db.prepare('SELECT hour, plays, skips FROM user_hour_stats ORDER BY hour').all().map((r) => ({ ...r }));
    assert.deepEqual(hours, [
      { hour: '2026-09-01T10', plays: 1, skips: 0 },
      { hour: '2026-09-02T10', plays: 0, skips: 1 },
    ]);
    db.close();
  });

  test('first_played keeps the earliest, last_played the latest, whatever order plays arrive', () => {
    const db = freshDb();
    const uid = seedUser(db);
    recordPlayEvents(db, [
      base({ userId: uid, eventId: 'later', startedAt: '2026-09-03 10:00:00' }),
      base({ userId: uid, eventId: 'earlier', startedAt: '2026-08-01 10:00:00' }),
    ]);
    const um = db.prepare('SELECT * FROM user_metadata WHERE track_hash = ?').get('ah1');
    assert.equal(um.first_played, '2026-08-01 10:00:00.000');
    assert.equal(um.last_played, '2026-09-03 10:00:00.000');
    assert.equal(um.play_count, 2);
    db.close();
  });

  test('a replayed event id is a complete no-op', () => {
    const db = freshDb();
    const uid = seedUser(db);
    assert.equal(recordPlayEvent(db, base({ userId: uid })), true);
    assert.equal(recordPlayEvent(db, base({ userId: uid, playedMs: 999 })), false);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM play_events').get().n, 1);
    assert.equal(db.prepare('SELECT plays FROM user_hour_stats').get().plays, 1);
    assert.equal(db.prepare('SELECT play_count FROM user_metadata').get().play_count, 1);
    const again = recordPlayEvents(db, [base({ userId: uid }), base({ userId: uid, eventId: 'e2' })]);
    assert.deepEqual(again, { inserted: 1, duplicates: 1 });
    db.close();
  });

  test('a bad event in a batch rolls the whole batch back', () => {
    const db = freshDb();
    const uid = seedUser(db);
    assert.throws(() => recordPlayEvents(db, [base({ userId: uid }), base({ userId: uid, eventId: 'e2', outcome: 'vanished' })]), TypeError);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM play_events').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_hour_stats').get().n, 0);
    db.close();
  });

  test('a federated play keeps its snapshot and outlives the peer row', () => {
    const db = freshDb();
    const uid = seedUser(db);
    const peer = seedPeer(db);
    recordPlayEvents(db, [base({
      userId: uid, eventId: 'p1', peerId: peer, trackHash: 'peerhash', filepath: 'music/x.flac',
      snapshot: { title: 'Peer Song', artist: 'Peer Artist', album: 'Peer Album', hash: 'peerhash', secret: 'dropped' },
    })]);
    const ev = db.prepare('SELECT peer_id, snapshot FROM play_events').get();
    assert.equal(ev.peer_id, peer);
    assert.deepEqual(JSON.parse(ev.snapshot), { title: 'Peer Song', artist: 'Peer Artist', album: 'Peer Album', hash: 'peerhash' });
    db.prepare('DELETE FROM federation_peers WHERE id = ?').run(peer);
    assert.equal(db.prepare('SELECT peer_id FROM play_events').get().peer_id, null);
    db.close();
  });

  test("a user's plays and rollups die with the user", () => {
    const db = freshDb();
    const uid = seedUser(db);
    recordPlayEvents(db, [base({ userId: uid })]);
    db.prepare('DELETE FROM users WHERE id = ?').run(uid);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM play_events').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_hour_stats').get().n, 0);
    db.close();
  });

  test('normalizeEvent rejects contract violations', () => {
    assert.throws(() => normalizeEvent(base({ eventId: '' })), TypeError);
    assert.throws(() => normalizeEvent(base({ playedMs: -1 })), TypeError);
    assert.throws(() => normalizeEvent(base({ source: 'radio' })), TypeError);
    assert.throws(() => normalizeEvent(base({ startedAt: 'not a time' })), TypeError);
    assert.equal(normalizeEvent(base({ startedAt: Date.UTC(2026, 8, 4, 19, 4) })).started_at, '2026-09-04 19:04:00.000');
  });
});
