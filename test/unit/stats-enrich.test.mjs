/**
 * src/stats/enrich.js — completing federated plays from the peer's metadata,
 * on a real-schema database with a fake peer: the completed snapshot, the
 * re-key onto the audio hash (counters follow), "unknown to the peer"
 * settling a row, an unanswered peer leaving it for the backfill, and what
 * enqueue ignores.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initEmptyDb } from '../helpers/scanner-runner.mjs';
import { recordPlayEvent, thinPeerEvents, logSummary } from '../../src/stats/store.js';
import { createEnricher, mergeSnapshot, toRow, PATHS_PER_CALL } from '../../src/stats/enrich.js';

const quiet = { debug() {}, info() {}, warn() {} };
const T0 = new Date('2026-09-10T10:00:00Z');

let tmp, d, peer;
function peerEvent(id, filepath, snapshot, over = {}) {
  return {
    eventId: id, userId: 1, trackHash: snapshot.hash ?? null, filepath, libraryId: null, peerId: peer.id, snapshot,
    client: 'test/1', sessionId: null, source: 'manual', outcome: 'completed', counted: true,
    playedMs: 200_000, durationMs: snapshot.durationMs ?? null, pauseCount: 0,
    startedAt: new Date(T0.getTime() + Object.keys(over).length), endedAt: new Date(T0.getTime() + 200_000), ...over,
  };
}
const row = (id) => d.prepare('SELECT event_id, user_id, track_hash, filepath, peer_id, snapshot FROM play_events WHERE event_id = ?').get(id);
const snap = (id) => JSON.parse(row(id).snapshot);
const counters = (hash) => d.prepare('SELECT play_count FROM user_metadata WHERE user_id = 1 AND track_hash = ?').get(hash)?.play_count ?? null;
const PEER_META = {
  title: 'Peer Song', artist: 'Peer Artist', album: 'Peer Album', duration: 240.4, hash: 'pfh1', 'audio-hash': 'pah1', 'album-art': 'art.jpg',
};

describe('stats enrichment', () => {
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-enrich-'));
    initEmptyDb(path.join(tmp, 'mstream.db'), tmp);
    d = new DatabaseSync(path.join(tmp, 'mstream.db'));
    // node:sqlite enforces foreign keys by default: the plays need their account
    d.prepare("INSERT INTO users (username, password, salt, is_admin) VALUES ('one', 'pw', 'salt', 1)").run();
    const id = Number(d.prepare("INSERT INTO federation_peers (name, endpoint_ticket, api_key) VALUES ('Bob', 't', 'fedk_bob')").run().lastInsertRowid);
    peer = { id, name: 'Bob', endpoint_ticket: 't', api_key: 'fedk_bob' };
  });
  after(() => { d.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  test('mergeSnapshot: the peer wins, the app fills gaps, the key turns canonical', () => {
    const s = mergeSnapshot({ title: 'peer.flac', album: 'App Album', hash: 'pfh1' }, PEER_META, 1234);
    assert.deepEqual(s, { title: 'Peer Song', artist: 'Peer Artist', album: 'Peer Album', hash: 'pah1', durationMs: 240400, artFile: 'art.jpg', enrichedAt: 1234 });
    const kept = mergeSnapshot('{"title":"App Title","hash":"x"}', { title: '', duration: 0 }, 5);
    assert.deepEqual(kept, { title: 'App Title', hash: 'x', enrichedAt: 5 });
    assert.deepEqual(mergeSnapshot(null, null, 7), { enrichedAt: 7 });
    assert.equal(mergeSnapshot({}, { hash: 'onlyfile' }, 1).hash, 'onlyfile');
  });

  test('toRow: ingest events and log rows both become the row shape', () => {
    assert.deepEqual(toRow({ eventId: 'e', userId: 2, trackHash: 'h', filepath: 'p', peerId: 3, snapshot: { title: 't' } }),
      { event_id: 'e', user_id: 2, track_hash: 'h', filepath: 'p', peer_id: 3, snapshot: { title: 't' } });
    assert.deepEqual(toRow({ event_id: 'e', user_id: 2, track_hash: null, filepath: 'p', peer_id: null, snapshot: '{}' }),
      { event_id: 'e', user_id: 2, track_hash: null, filepath: 'p', peer_id: null, snapshot: '{}' });
  });

  test('a thin snapshot is completed and the play re-keyed onto the audio hash, counters following', async () => {
    const thin = { title: 'peer.flac', hash: 'pfh1' };
    recordPlayEvent(d, peerEvent('e1', 'music/peer.flac', thin));
    assert.equal(counters('pfh1'), 1, 'ingest keyed the counters on the file hash');
    const calls = [];
    const enricher = createEnricher({
      fetchPeer: (p, paths) => { calls.push({ peer: p.id, paths }); return Promise.resolve({ 'music/peer.flac': { filepath: 'music/peer.flac', metadata: PEER_META } }); },
      getPeers: () => [peer], getDb: () => d, logger: quiet, now: () => 4242,
    });
    assert.equal(enricher.enqueue([peerEvent('e1', 'music/peer.flac', thin)]), 1);
    await enricher.flush();
    assert.deepEqual(calls, [{ peer: peer.id, paths: ['music/peer.flac'] }]);
    assert.deepEqual(snap('e1'), { title: 'Peer Song', artist: 'Peer Artist', album: 'Peer Album', hash: 'pah1', durationMs: 240400, artFile: 'art.jpg', enrichedAt: 4242 });
    assert.equal(row('e1').track_hash, 'pah1');
    assert.equal(counters('pah1'), 1);
    assert.equal(counters('pfh1'), null, 'the old key is gone');
    assert.deepEqual(enricher.stats(), { enriched: 1, rekeyed: 1, unknown: 0, failed: 0, lastRunAt: new Date(4242).toISOString(), lastError: null, pending: 0 });

    // A later play of the same track still arrives under the file hash; its
    // enrichment merges the counters onto the canonical key.
    recordPlayEvent(d, peerEvent('e2', 'music/peer.flac', thin, { startedAt: new Date(T0.getTime() + 3_600_000) }));
    assert.equal(counters('pfh1'), 1);
    enricher.enqueue([peerEvent('e2', 'music/peer.flac', thin)]);
    await enricher.flush();
    assert.equal(row('e2').track_hash, 'pah1');
    assert.equal(counters('pah1'), 2);
    assert.equal(counters('pfh1'), null);
    assert.equal(thinPeerEvents(d).length, 0);
  });

  test('a track the peer does not know settles the row as it came', async () => {
    recordPlayEvent(d, peerEvent('e3', 'music/gone.flac', { title: 'gone.flac', hash: 'pfh3' }));
    const enricher = createEnricher({
      fetchPeer: () => Promise.resolve({ 'music/gone.flac': { filepath: 'music/gone.flac', metadata: null } }),
      getPeers: () => [peer], getDb: () => d, logger: quiet, now: () => 99,
    });
    enricher.enqueue([row('e3')]);
    await enricher.flush();
    assert.deepEqual(snap('e3'), { title: 'gone.flac', hash: 'pfh3', enrichedAt: 99 });
    assert.equal(row('e3').track_hash, 'pfh3');
    assert.equal(enricher.stats().unknown, 1);
    assert.equal(thinPeerEvents(d).length, 0, 'settled rows are not asked about again');
  });

  test('an unanswered peer leaves the row thin; the backfill completes it later', async () => {
    recordPlayEvent(d, peerEvent('e4', 'music/late.flac', { title: 'late.flac', hash: 'pfh4' }));
    let up = false;
    const enricher = createEnricher({
      fetchPeer: (p, paths) => {
        if (!up) { return Promise.reject(new Error('no answer within 4000ms')); }
        return Promise.resolve(Object.fromEntries(paths.map((fp) => [fp, { filepath: fp, metadata: { title: 'Late Song', artist: 'A', duration: 100, hash: 'pfh4', 'audio-hash': 'pah4' } }])));
      },
      getPeers: () => [peer], getDb: () => d, logger: quiet,
    });
    enricher.enqueue([row('e4')]);
    await enricher.flush();
    assert.equal(snap('e4').enrichedAt, undefined);
    assert.equal(row('e4').track_hash, 'pfh4');
    assert.equal(enricher.stats().failed, 1);
    assert.match(enricher.stats().lastError, /Bob: no answer/);
    assert.deepEqual(thinPeerEvents(d).map((r) => r.event_id), ['e4']);
    assert.equal(logSummary(d).thinPeerEvents, 1);

    up = true;
    assert.equal(await enricher.backfill(), 1);
    assert.equal(snap('e4').title, 'Late Song');
    assert.equal(row('e4').track_hash, 'pah4');
    assert.equal(logSummary(d).thinPeerEvents, 0);
  });

  test('enqueue ignores local plays, settled rows, duplicates, and a peer that is gone', async () => {
    const calls = [];
    const enricher = createEnricher({ fetchPeer: (p, paths) => { calls.push(paths); return Promise.resolve({}); }, getPeers: () => [], getDb: () => d, logger: quiet });
    assert.equal(enricher.enqueue([
      { eventId: 'local', userId: 1, trackHash: 'ahA', filepath: 'testlib/a.mp3', peerId: null, snapshot: null },
      row('e1'),                                   // enriched already
      { eventId: 'e5', userId: 1, trackHash: 'x', filepath: 'music/x.flac', peerId: peer.id, snapshot: { title: 'x' } },
      { eventId: 'e5', userId: 1, trackHash: 'x', filepath: 'music/x.flac', peerId: peer.id, snapshot: { title: 'x' } },
    ]), 1);
    await enricher.flush();
    assert.deepEqual(calls, [], 'the peer list no longer has the peer: nothing to ask');
    assert.equal(enricher.stats().failed, 1);
  });

  test('paths are asked in chunks and deduplicated', async () => {
    const calls = [];
    const enricher = createEnricher({
      fetchPeer: (p, paths) => { calls.push(paths.length); return Promise.resolve(Object.fromEntries(paths.map((fp) => [fp, { filepath: fp, metadata: null }]))); },
      getPeers: () => [peer], getDb: () => d, logger: quiet,
    });
    const items = [];
    for (let i = 0; i < PATHS_PER_CALL + 5; i++) {
      recordPlayEvent(d, peerEvent('bulk' + i, 'music/bulk' + (i % (PATHS_PER_CALL + 2)) + '.flac', { title: 'b', hash: 'bh' + i }, { startedAt: new Date(T0.getTime() + 10_000 + i) }));
      items.push(row('bulk' + i));
    }
    enricher.enqueue(items);
    await enricher.flush();
    assert.deepEqual(calls, [PATHS_PER_CALL, 2]);
    assert.equal(enricher.stats().unknown, PATHS_PER_CALL + 5);
  });
});
