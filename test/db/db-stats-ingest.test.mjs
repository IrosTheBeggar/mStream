/**
 * src/stats/ingest.js against a real V70 database (in-memory node:sqlite).
 *
 * Seeds two users, one library with three tracks (audio-hashed, file-hash
 * only, hashless) and one federation peer, then drives ingestPlays with a
 * resolver that mirrors getVPathInfo over the seeded library. Locks in:
 *  - accepted plays land as events, hourly rollups and per-track counters,
 *    with the verdict of the threshold rule stored on the row;
 *  - the library's duration fills in when the client sent none;
 *  - duplicates within a batch and across calls are acknowledged and inert;
 *    an id another user owns is `invalid`;
 *  - unknown paths, unknown peers, missing snapshots and out-of-window times
 *    reject only their own play — the rest of the batch commits;
 *  - a peer play stores its snapshot and keys counters on the reported hash;
 *  - a hashless track keeps the event but moves no counter.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applyAllMigrations } from '../helpers/apply-migrations.mjs';
import { ingestPlays, lookupTrack, REASONS } from '../../src/stats/ingest.js';

const NOW = new Date('2026-09-09T12:00:00Z');

function seed() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA recursive_triggers = ON');
  applyAllMigrations(db);
  const alice = Number(db.prepare("INSERT INTO users (username, password, salt) VALUES ('alice', 'h', 's')").run().lastInsertRowid);
  const bob = Number(db.prepare("INSERT INTO users (username, password, salt) VALUES ('bob', 'h', 's')").run().lastInsertRowid);
  const lib = Number(db.prepare("INSERT INTO libraries (name, root_path) VALUES ('music', '/srv/music')").run().lastInsertRowid);
  const ins = db.prepare(`INSERT INTO tracks (filepath, library_id, title, file_hash, audio_hash, duration, modified, scan_id)
                          VALUES (?, ?, ?, ?, ?, ?, 1, 'seed')`);
  ins.run('Radiohead/Let Down.flac', lib, 'Let Down', 'fhA', 'ahA', 299.4);
  ins.run('Portishead/Glory Box.mp3', lib, 'Glory Box', 'fhC', null, 302);
  ins.run('broken.mp3', lib, 'Broken', '', null, null);
  const peer = Number(db.prepare("INSERT INTO federation_peers (name, endpoint_ticket, api_key) VALUES ('Bob', 't', 'fedk_bob')").run().lastInsertRowid);
  return { db, alice: { id: alice, vpaths: ['music'] }, bob: { id: bob, vpaths: ['music'] }, lib, peer };
}

// getVPathInfo's split over the seeded library, without the live manager.
function resolver(d, filePath, user) {
  const p = filePath.startsWith('/') ? filePath.slice(1) : filePath;
  const [vpath, ...rest] = p.split('/');
  if (user.vpaths && !user.vpaths.includes(vpath)) { return null; }
  const lib = d.prepare('SELECT id FROM libraries WHERE name = ?').get(vpath);
  return lib ? lookupTrack(d, lib.id, rest.join('/')) : null;
}

const play = (over = {}) => ({
  id: 'p1', filePath: 'music/Radiohead/Let Down.flac', startedAt: '2026-09-09T11:00:00Z',
  playedMs: 240000, outcome: 'completed', source: 'manual', pauseCount: 1, ...over,
});

function ingest(ctx, user, plays, extra = {}) {
  return ingestPlays(ctx.db, user, { plays }, {
    now: NOW, peers: [{ id: ctx.peer }], client: 'test/1', resolveLocal: resolver, ...extra,
  });
}

describe('ingestPlays', () => {
  test('a counted play: event, rollup, counters, verdict', () => {
    const c = seed();
    const r = ingest(c, c.alice, [play()]);
    assert.deepEqual(r, { accepted: ['p1'], duplicates: [], rejected: [] });
    const ev = c.db.prepare('SELECT * FROM play_events').get();
    assert.equal(ev.track_hash, 'ahA');
    assert.equal(ev.library_id, c.lib);
    assert.equal(ev.filepath, 'Radiohead/Let Down.flac');
    assert.equal(ev.counted, 1);
    assert.equal(ev.duration_ms, 299400);          // the library's duration, client sent none
    assert.equal(ev.started_at, '2026-09-09 11:00:00.000');
    assert.equal(ev.ended_at, '2026-09-09 11:04:00.000'); // start + playedMs when the client sent none
    assert.equal(ev.client, 'test/1');
    assert.equal(ev.pause_count, 1);
    const um = c.db.prepare('SELECT play_count, listened_ms, skip_count, first_played, last_played FROM user_metadata WHERE user_id = ? AND track_hash = ?').get(c.alice.id, 'ahA');
    assert.deepEqual([um.play_count, um.listened_ms, um.skip_count], [1, 240000, 0]);
    assert.equal(um.last_played, '2026-09-09 11:00:00.000');
    const hour = c.db.prepare('SELECT * FROM user_hour_stats').get();
    assert.deepEqual([hour.hour, hour.events, hour.plays], ['2026-09-09T11', 1, 1]);
  });

  test('the verdict follows the rule and the config; a short skip is kept but not counted', () => {
    const c = seed();
    const r = ingest(c, c.alice, [
      play({ id: 'skip', outcome: 'skipped', playedMs: 8000 }),
      play({ id: 'half', filePath: 'music/Portishead/Glory Box.mp3', playedMs: 151000 }), // half of 302 s
      play({ id: 'low', playedMs: 12000 }),
    ], { config: { playThresholdMs: 10000, playThresholdFraction: 0.5, retentionMonths: 24 } });
    assert.deepEqual(r.accepted, ['skip', 'half', 'low']);
    const counted = Object.fromEntries(c.db.prepare('SELECT event_id, counted FROM play_events').all().map((e) => [e.event_id, e.counted]));
    assert.deepEqual(counted, { skip: 0, half: 1, low: 1 });
    const um = c.db.prepare('SELECT play_count, skip_count, listened_ms FROM user_metadata WHERE track_hash = ?').get('ahA');
    assert.deepEqual([um.play_count, um.skip_count, um.listened_ms], [1, 1, 20000]);
    assert.equal(c.db.prepare('SELECT play_count FROM user_metadata WHERE track_hash = ?').get('fhC').play_count, 1);
  });

  test('duplicates: within the batch, across calls, and never for another user', () => {
    const c = seed();
    const first = ingest(c, c.alice, [play(), play({ playedMs: 1 })]);
    assert.deepEqual(first, { accepted: ['p1'], duplicates: ['p1'], rejected: [] });
    const again = ingest(c, c.alice, [play({ playedMs: 999 }), play({ id: 'p2' })]);
    assert.deepEqual(again, { accepted: ['p2'], duplicates: ['p1'], rejected: [] });
    const other = ingest(c, c.bob, [play()]);
    assert.deepEqual(other, { accepted: [], duplicates: [], rejected: [{ id: 'p1', reason: REASONS.invalid }] });
    assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM play_events').get().n, 2);
    assert.equal(c.db.prepare('SELECT play_count FROM user_metadata WHERE user_id = ? AND track_hash = ?').get(c.alice.id, 'ahA').play_count, 2);
  });

  test('rejections are per play; the rest of the batch commits', () => {
    const c = seed();
    const r = ingest(c, c.alice, [
      play({ id: 'ok' }),
      play({ id: 'nope', filePath: 'music/Nobody/Nothing.mp3' }),
      play({ id: 'elsewhere', filePath: 'other/Let Down.flac' }),
      play({ id: 'future', startedAt: '2026-09-09T12:06:00Z' }),
      play({ id: 'ancient', startedAt: '2020-01-01T00:00:00Z' }),
      play({ id: 'garbled', startedAt: 'yesterday' }),
      play({ id: 'badend', endedAt: 'later' }),
      play({ id: 'ghost', peerId: 999, track: { title: 'x' } }),
      play({ id: 'blind', peerId: c.peer }),
    ]);
    assert.deepEqual(r.accepted, ['ok']);
    assert.deepEqual(r.rejected, [
      { id: 'nope', reason: REASONS.unknownTrack },
      { id: 'elsewhere', reason: REASONS.unknownTrack },
      { id: 'future', reason: REASONS.badTime },
      { id: 'ancient', reason: REASONS.badTime },
      { id: 'garbled', reason: REASONS.badTime },
      { id: 'badend', reason: REASONS.badTime },
      { id: 'ghost', reason: REASONS.unknownPeer },
      { id: 'blind', reason: REASONS.invalid },
    ]);
    assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM play_events').get().n, 1);
  });

  test("a peer's track: snapshot kept, counters keyed on the reported hash, no library", () => {
    const c = seed();
    const r = ingest(c, c.alice, [play({
      id: 'peer1', filePath: '/music/Portishead/Glory Box.mp3', peerId: c.peer, playedMs: 200000,
      track: { title: 'Glory Box', artist: 'Portishead', album: 'Dummy', durationMs: 302000, hash: 'peerhash', artFile: 'a.jpg', extra: 'dropped' },
    })]);
    assert.deepEqual(r.accepted, ['peer1']);
    const ev = c.db.prepare('SELECT * FROM play_events').get();
    assert.equal(ev.peer_id, c.peer);
    assert.equal(ev.library_id, null);
    assert.equal(ev.track_hash, 'peerhash');
    assert.equal(ev.filepath, 'music/Portishead/Glory Box.mp3');
    assert.equal(ev.duration_ms, 302000);
    assert.deepEqual(JSON.parse(ev.snapshot), { title: 'Glory Box', artist: 'Portishead', album: 'Dummy', durationMs: 302000, hash: 'peerhash', artFile: 'a.jpg' });
    assert.equal(c.db.prepare('SELECT play_count FROM user_metadata WHERE track_hash = ?').get('peerhash').play_count, 1);
  });

  test('a hashless track keeps the event and moves no counter', () => {
    const c = seed();
    const r = ingest(c, c.alice, [play({ id: 'h', filePath: 'music/broken.mp3' })]);
    assert.deepEqual(r.accepted, ['h']);
    const ev = c.db.prepare('SELECT track_hash, counted, duration_ms FROM play_events').get();
    assert.equal(ev.track_hash, null);
    assert.equal(ev.counted, 1);          // 240 s listened is a play, whatever the file is
    assert.equal(ev.duration_ms, null);
    assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM user_metadata').get().n, 0);
    assert.equal(c.db.prepare('SELECT plays FROM user_hour_stats').get().plays, 1);
  });

  test('an empty or missing batch is a no-op', () => {
    const c = seed();
    assert.deepEqual(ingest(c, c.alice, []), { accepted: [], duplicates: [], rejected: [] });
    assert.deepEqual(ingestPlays(c.db, c.alice, {}, { now: NOW }), { accepted: [], duplicates: [], rejected: [] });
  });
});
