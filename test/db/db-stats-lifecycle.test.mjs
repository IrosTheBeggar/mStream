/**
 * src/stats/store.js — the lifecycle half: removal, reset, rebuild, sweep.
 *
 *  - deleting an event subtracts exactly what recording it added (hour row,
 *    dropped at zero; track counters), and recomputes a track's first/last
 *    played from what remains — left as they are when only legacy plays
 *    remain, cleared when nothing does;
 *  - deletion by id list and by range; an unknown id is a no-op;
 *  - reset scopes: counts zeroes counters and leaves the log, history drops
 *    the log and rollup and leaves counters, all does both;
 *  - rebuild rewrites every hour that has events and never erases an hour
 *    that has none (it may be older than retention);
 *  - the retention sweep prunes raw events before the floor only, leaving
 *    the rollup and counters — and does nothing when retention is off.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applyAllMigrations } from '../helpers/apply-migrations.mjs';
import {
  recordPlayEvents, deletePlayEvents, resetStats, rebuildHourStats, sweepRetention,
} from '../../src/stats/store.js';

function fresh() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA recursive_triggers = ON');
  applyAllMigrations(db);
  db.prepare("INSERT INTO users (username, password, salt) VALUES ('alice', 'h', 's')").run();
  db.prepare("INSERT INTO users (username, password, salt) VALUES ('bob', 'h', 's')").run();
  return db;
}

const ev = (id, startedAt, over = {}) => ({
  eventId: id, userId: 1, trackHash: 'ahA', filepath: 'a.flac', outcome: 'completed', counted: true,
  playedMs: 200000, startedAt, ...over,
});

function seedPlays(db) {
  recordPlayEvents(db, [
    ev('e1', '2026-09-01 10:00:00'),
    ev('e2', '2026-09-01 10:30:00'),
    ev('e3', '2026-09-02 12:00:00'),
    ev('skip', '2026-09-02 12:10:00', { outcome: 'skipped', counted: false, playedMs: 8000 }),
  ]);
}

const counters = (db, hash = 'ahA', uid = 1) => {
  const r = db.prepare('SELECT play_count, skip_count, listened_ms, first_played, last_played FROM user_metadata WHERE user_id = ? AND track_hash = ?').get(uid, hash);
  return r ? { ...r } : null;
};
const hours = (db) => db.prepare('SELECT hour, events, plays, skips, listened_ms FROM user_hour_stats ORDER BY hour').all().map((r) => ({ ...r }));

describe('deletePlayEvents', () => {
  test('one play: hour row and counters step down, first/last recomputed', () => {
    const db = fresh(); seedPlays(db);
    assert.deepEqual(deletePlayEvents(db, 1, { eventIds: ['e2'] }), { deleted: 1 });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM play_events').get().n, 3);
    assert.deepEqual(hours(db), [
      { hour: '2026-09-01T10', events: 1, plays: 1, skips: 0, listened_ms: 200000 },
      { hour: '2026-09-02T12', events: 2, plays: 1, skips: 1, listened_ms: 208000 },
    ]);
    const c = counters(db);
    assert.deepEqual([c.play_count, c.skip_count, c.listened_ms], [2, 1, 408000]);
    assert.equal(c.first_played, '2026-09-01 10:00:00.000');
    assert.equal(c.last_played, '2026-09-02 12:00:00.000');
    db.close();
  });

  test('an hour that empties loses its row; the skip counts down too', () => {
    const db = fresh(); seedPlays(db);
    deletePlayEvents(db, 1, { eventIds: ['e3', 'skip'] });
    assert.deepEqual(hours(db), [{ hour: '2026-09-01T10', events: 2, plays: 2, skips: 0, listened_ms: 400000 }]);
    const c = counters(db);
    assert.deepEqual([c.play_count, c.skip_count, c.listened_ms], [2, 0, 400000]);
    assert.equal(c.last_played, '2026-09-01 10:30:00.000');
    db.close();
  });

  test('by range, an unknown id, and the other user untouched', () => {
    const db = fresh(); seedPlays(db);
    recordPlayEvents(db, [ev('bob1', '2026-09-02 12:20:00', { userId: 2 })]);
    assert.deepEqual(deletePlayEvents(db, 1, { eventIds: ['nope'] }), { deleted: 0 });
    assert.deepEqual(deletePlayEvents(db, 2, { eventIds: ['e1'] }), { deleted: 0 }); // not bob's
    assert.deepEqual(deletePlayEvents(db, 1, { from: '2026-09-02 00:00:00.000', to: '2026-09-03 00:00:00.000' }), { deleted: 2 });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM play_events WHERE user_id = 1').get().n, 2);
    assert.equal(counters(db, 'ahA', 2).play_count, 1);
    assert.throws(() => deletePlayEvents(db, 1, {}), TypeError);
    db.close();
  });

  test('legacy plays keep their dates; a track with nothing left is cleared', () => {
    const db = fresh();
    db.prepare(`INSERT INTO user_metadata (user_id, track_hash, play_count, last_played, first_played)
                VALUES (1, 'legacy', 5, '2026-05-01 00:00:00', '2026-01-01 00:00:00')`).run();
    recordPlayEvents(db, [ev('l1', '2026-09-01 10:00:00', { trackHash: 'legacy' }), ev('only', '2026-09-01 11:00:00', { trackHash: 'lone' })]);
    assert.equal(counters(db, 'legacy').play_count, 6);
    deletePlayEvents(db, 1, { eventIds: ['l1', 'only'] });
    const legacy = counters(db, 'legacy');
    assert.equal(legacy.play_count, 5);
    // Recording moved last_played to the event; deleting it cannot restore a
    // date the log never held, so the dates stay as they are rather than
    // being cleared under a count that is still five.
    assert.equal(legacy.last_played, '2026-09-01 10:00:00.000');
    assert.equal(legacy.first_played, '2026-01-01 00:00:00');
    const lone = counters(db, 'lone');
    assert.deepEqual([lone.play_count, lone.first_played, lone.last_played], [0, null, null]);
    db.close();
  });
});

describe('resetStats', () => {
  test('counts / history / all', () => {
    const db = fresh(); seedPlays(db);
    assert.deepEqual(resetStats(db, 1, 'counts'), { tracks: 1, events: 0 });
    assert.deepEqual([counters(db).play_count, counters(db).listened_ms, counters(db).last_played], [0, 0, null]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM play_events').get().n, 4);
    assert.deepEqual(resetStats(db, 1, 'history'), { tracks: 0, events: 4 });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_hour_stats').get().n, 0);
    assert.ok(counters(db)); // the counter row stays (zeroed earlier)
    seedPlays(db);
    assert.deepEqual(resetStats(db, 1, 'all'), { tracks: 1, events: 4 });
    assert.throws(() => resetStats(db, 1, 'everything'), TypeError);
    db.close();
  });

  test('scoped to the user', () => {
    const db = fresh(); seedPlays(db);
    recordPlayEvents(db, [ev('bob1', '2026-09-02 12:20:00', { userId: 2 })]);
    resetStats(db, 2, 'all');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM play_events WHERE user_id = 1').get().n, 4);
    assert.equal(counters(db, 'ahA', 1).play_count, 3);
    db.close();
  });
});

describe('rebuildHourStats', () => {
  test('rewrites hours that have events, keeps hours that do not', () => {
    const db = fresh(); seedPlays(db);
    db.prepare("UPDATE user_hour_stats SET plays = 99, listened_ms = 1 WHERE hour = '2026-09-01T10'").run();
    db.prepare("INSERT INTO user_hour_stats (user_id, hour, events, plays, skips, listened_ms) VALUES (1, '2024-01-01T09', 7, 7, 0, 700000)").run();
    assert.deepEqual(rebuildHourStats(db), { hours: 2 });
    assert.deepEqual(hours(db), [
      { hour: '2024-01-01T09', events: 7, plays: 7, skips: 0, listened_ms: 700000 },
      { hour: '2026-09-01T10', events: 2, plays: 2, skips: 0, listened_ms: 400000 },
      { hour: '2026-09-02T12', events: 2, plays: 1, skips: 1, listened_ms: 208000 },
    ]);
    recordPlayEvents(db, [ev('bob1', '2026-09-02 12:20:00', { userId: 2 })]);
    db.prepare('DELETE FROM user_hour_stats WHERE user_id = 2').run();
    assert.deepEqual(rebuildHourStats(db, { userId: 2 }), { hours: 1 });
    db.close();
  });
});

describe('sweepRetention', () => {
  test('prunes raw events before the floor; rollup and counters survive; off = no-op', () => {
    const db = fresh();
    recordPlayEvents(db, [ev('old', '2026-07-01 10:00:00'), ev('new', '2026-09-01 10:00:00')]);
    const now = new Date('2026-09-09T12:00:00Z');
    assert.deepEqual(sweepRetention(db, { retentionMonths: 0, now }), { deleted: 0, cutoff: null });
    const r = sweepRetention(db, { retentionMonths: 1, now });
    assert.deepEqual(r, { deleted: 1, cutoff: '2026-08-09 12:00:00.000' });
    assert.deepEqual(db.prepare('SELECT event_id FROM play_events').all().map((x) => x.event_id), ['new']);
    assert.equal(hours(db).length, 2);          // the July hour keeps its row
    assert.equal(counters(db).play_count, 2);   // and the count is still two
    db.close();
  });
});
