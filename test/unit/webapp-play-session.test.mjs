/**
 * webapp/assets/js/mstream.play-session.js — the web player's play
 * sessions and outbox, on node. The module is UMD; storage and the request
 * are injected, so nothing here touches a DOM.
 *
 * Also the wire contract: every play the fold produces, and every batch
 * the outbox sends, validates against the server's own request schema
 * (src/api/stats.js playsBodySchema) — the webapp and the server cannot
 * drift apart without this file going red.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { playsBodySchema } from '../../src/api/stats.js';

const require = createRequire(import.meta.url);
const PS = require('../../webapp/assets/js/mstream.play-session.js');

const T0 = Date.parse('2026-09-10T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    map: m,
  };
}
const local = { filePath: 'testlib/Let Down.flac', durationMs: 299000, source: 'manual', sessionId: 'tab-1' };
function schemaError(plays) {
  const { error } = playsBodySchema.validate({ client: { name: PS.CLIENT_NAME, instanceId: 'inst' }, plays });
  return error ? error.message : null;
}
const play = (id, over = {}) => ({
  id, filePath: 'testlib/a.flac', startedAt: iso(T0), endedAt: iso(T0 + 60000), playedMs: 60000,
  outcome: 'completed', source: 'manual', pauseCount: 0, ...over,
});

describe('the fold', () => {
  test('forward ticks add listened time; a seek or a backwards jump adds nothing', () => {
    const s = PS.createSession(local, T0);
    PS.tick(s, 0); PS.tick(s, 0.25); PS.tick(s, 0.5); PS.tick(s, 1.0);    // +1000
    PS.tick(s, 60);                                                       // a seek: +0
    PS.tick(s, 60.5);                                                     // +500
    PS.tick(s, 10);                                                       // back: +0
    PS.tick(s, 10.5);                                                     // +500
    PS.tick(s, NaN); PS.tick(s, -1);                                      // ignored
    assert.equal(s.playedMs, 2000);
    assert.equal(s.maxPos, 60.5);
  });

  test('nothing accrues while paused or not playing; a pause counts once however often it is pressed', () => {
    const s = PS.createSession(local, T0);
    PS.tick(s, 0); PS.tick(s, 1);
    PS.pause(s); PS.pause(s);
    PS.tick(s, 2); PS.tick(s, 3);
    PS.resume(s); PS.tick(s, 3.5);
    PS.tick(s, 4, false);
    assert.equal(s.pauseCount, 1);
    assert.equal(s.playedMs, 1500);
  });

  test('too short is never posted', () => {
    const s = PS.createSession(local, T0);
    PS.tick(s, 0); PS.tick(s, 0.9);
    assert.equal(PS.finish(s, 'completed', T0 + 1000), null);
    assert.equal(PS.finish(null, 'completed'), null);
  });

  test('the wire play: ISO instants, the outcome, the source, the pause count, the length', () => {
    const s = PS.createSession({ ...local, id: 'p-1' }, T0);
    PS.tick(s, 0); PS.tick(s, 2); PS.tick(s, 4);
    const p = PS.finish(s, 'skipped', T0 + 4000);
    assert.deepEqual(p, {
      id: 'p-1', filePath: 'testlib/Let Down.flac',
      startedAt: '2026-09-10T12:00:00.000Z', endedAt: '2026-09-10T12:00:04.000Z',
      playedMs: 4000, outcome: 'skipped', source: 'manual', pauseCount: 0, durationMs: 299000, sessionId: 'tab-1',
    });
    assert.equal(schemaError([p]), null);
    assert.equal(PS.finish(s, 'skipped', T0 - 5000).endedAt, iso(T0), 'an end before the start is clamped');
  });

  test("reaching the end of a known length is a completion whatever the player says; 'completed' stands; an unknown word is 'stopped'", () => {
    const s = PS.createSession(local, T0);
    PS.tick(s, 0); PS.tick(s, 297.5); PS.tick(s, 298.5); PS.tick(s, 299);
    assert.equal(PS.finish(s, 'skipped', T0 + 5000).outcome, 'completed');
    const u = PS.createSession({ ...local, durationMs: null }, T0);
    PS.tick(u, 0); PS.tick(u, 2);
    assert.equal(PS.finish(u, 'skipped').outcome, 'skipped');
    assert.equal(PS.finish(u, 'stopped').outcome, 'stopped');
    assert.equal(PS.finish(u, 'bogus').outcome, 'stopped');
    assert.equal(PS.finish(u, 'completed').outcome, 'completed');
  });

  test('a peer play carries its id and a snapshot of the metadata', () => {
    const snap = PS.snapshotOf({
      title: ' Remote ', artist: 'Peer', album: '', duration: 200.4, hash: 'fh', 'audio-hash': 'ah', 'album-art': 'x.jpg', bpm: 120,
    });
    assert.deepEqual(snap, { title: 'Remote', artist: 'Peer', durationMs: 200400, hash: 'ah', artFile: 'x.jpg' });
    assert.equal(PS.snapshotOf({ hash: 'fh' }).hash, 'fh', 'the file hash when there is no audio hash');
    assert.deepEqual(PS.snapshotOf(null), {});
    const s = PS.createSession({ ...local, filePath: 'remote/x.mp3', peerId: 3, track: snap, durationMs: snap.durationMs }, T0);
    PS.tick(s, 0); PS.tick(s, 2);
    const p = PS.finish(s, 'skipped', T0 + 2000);
    assert.equal(p.peerId, 3);
    assert.deepEqual(p.track, snap);
    assert.equal(schemaError([p]), null);
  });

  test('a late duration is taken once, and only while unknown', () => {
    const s = PS.createSession({ ...local, durationMs: null }, T0);
    PS.withDuration(s, 100000);
    PS.withDuration(s, 5);
    assert.equal(s.durationMs, 100000);
    PS.withDuration(PS.createSession(local, T0), 1);
  });

  test('createSession refuses a missing path and normalises the rest', () => {
    assert.throws(() => PS.createSession({}), TypeError);
    const s = PS.createSession({ filePath: 'a', peerId: 0, durationMs: -1, source: '', startedAt: 'x', sessionId: '' }, T0);
    assert.equal(s.peerId, null);
    assert.equal(s.durationMs, null);
    assert.equal(s.source, 'manual');
    assert.equal(s.sessionId, null);
    assert.equal(s.startedAt, T0);
    assert.match(s.id, /^[0-9a-f-]{36}$/);
  });

  test('uuid: v4 shape, unique', () => {
    const a = PS.uuid();
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(a, PS.uuid());
  });

  test('one session id per tab, kept in sessionStorage', () => {
    const st = memStorage();
    const a = PS.tabSessionId(st);
    assert.match(a, /^[0-9a-f-]{36}$/);
    assert.equal(PS.tabSessionId(st), a);
    assert.equal(st.getItem(PS.KEYS.session), a);
  });
});

describe('the outbox', () => {
  test('posts what is queued with the client block, and settles every id the server names', async () => {
    const st = memStorage();
    const sent = [];
    const post = (body) => { sent.push(body); return Promise.resolve({ accepted: ['a'], duplicates: ['b'], rejected: [{ id: 'c', reason: 'unknown-track' }] }); };
    const box = PS.createOutbox({ storage: st, post });
    for (const id of ['a', 'b', 'c', 'd']) { box.enqueue(play(id)); }
    assert.equal(box.size(), 4);
    assert.equal(await box.flush(), false, 'd is still waiting');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].client.name, 'mstream-webapp');
    assert.match(sent[0].client.instanceId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(sent[0].plays.map((p) => p.id), ['a', 'b', 'c', 'd']);
    assert.equal(schemaError(sent[0].plays), null, 'what leaves the outbox passes the server schema');
    assert.equal(box.size(), 1);
    assert.equal(st.getItem(PS.KEYS.instance), sent[0].client.instanceId, 'the instance id persists');
    assert.equal(await box.flush(), false, 'and is retried next time');
    assert.equal(sent[1].client.instanceId, sent[0].client.instanceId);
  });

  test('no network keeps everything; a 400 drops the batch; a 401 keeps it', async () => {
    const st = memStorage();
    const warns = [];
    let fail = () => { throw new Error('net'); };
    const box = PS.createOutbox({ storage: st, post: () => Promise.resolve().then(() => fail()), log: { warn: (m) => warns.push(m) } });
    box.enqueue(play('a')); box.enqueue(play('b'));
    assert.equal(await box.flush(), false);
    assert.equal(box.size(), 2);
    fail = () => { const e = new Error('unauthorized'); e.status = 401; throw e; };
    assert.equal(await box.flush(), false);
    assert.equal(box.size(), 2);
    fail = () => { const e = new Error('bad'); e.status = 400; throw e; };
    assert.equal(await box.flush(), true);
    assert.equal(box.size(), 0);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /refused a batch of 2/);
  });

  test('a flush in progress is shared; an empty box is done; a batch is at most BATCH_MAX', async () => {
    const st = memStorage();
    let release;
    const gate = new Promise((r) => { release = r; });
    const sizes = [];
    const box = PS.createOutbox({ storage: st, post: async (body) => { sizes.push(body.plays.length); await gate; return { accepted: body.plays.map((p) => p.id) }; } });
    assert.equal(await box.flush(), true, 'nothing queued → done, no request');
    assert.equal(sizes.length, 0);
    for (let i = 0; i < PS.BATCH_MAX + 5; i++) { box.enqueue(play(`p${i}`)); }
    const p1 = box.flush();
    const p2 = box.flush();
    assert.equal(p1, p2);
    release();
    assert.equal(await p1, false, 'five left for the next batch');
    assert.deepEqual(sizes, [PS.BATCH_MAX]);
    assert.equal(box.size(), 5);
  });

  test('the cap drops the oldest; enqueue replaces a play with the same id; junk is ignored', () => {
    const st = memStorage();
    const box = PS.createOutbox({ storage: st, post: () => Promise.resolve({}) });
    for (let i = 0; i < PS.OUTBOX_CAP + 2; i++) { box.enqueue(play(`p${i}`)); }
    assert.equal(box.size(), PS.OUTBOX_CAP);
    const ids = JSON.parse(st.getItem(PS.KEYS.outbox)).map((p) => p.id);
    assert.equal(ids[0], 'p2');
    box.enqueue(play('p2', { playedMs: 1 }));
    assert.equal(box.size(), PS.OUTBOX_CAP);
    assert.equal(JSON.parse(st.getItem(PS.KEYS.outbox)).at(-1).playedMs, 1, 'moved to the back, replaced');
    assert.equal(box.enqueue(null), 0);
    st.setItem(PS.KEYS.outbox, '{not json');
    assert.equal(box.size(), 0, 'a corrupt outbox reads as empty');
  });

  test('checkpoint + recover: the session a closed tab left becomes a stopped play at its checkpoint time', () => {
    const st = memStorage();
    let t = T0;
    const box = PS.createOutbox({ storage: st, post: () => Promise.resolve({}), now: () => t });
    const s = PS.createSession({ ...local, id: 'left' }, T0);
    PS.tick(s, 0); PS.tick(s, 1); PS.tick(s, 2); PS.tick(s, 3);
    t = T0 + 30000;
    box.checkpoint(s);
    assert.ok(st.getItem(PS.KEYS.inflight));

    const later = PS.createOutbox({ storage: st, post: () => Promise.resolve({}), now: () => T0 + 999999 });
    const p = later.recover();
    assert.equal(p.id, 'left');
    assert.equal(p.outcome, 'stopped');
    assert.equal(p.playedMs, 3000);
    assert.equal(p.endedAt, iso(T0 + 30000), 'ended when it was last seen, not when it was found');
    assert.equal(schemaError([p]), null);
    assert.equal(later.size(), 1);
    assert.equal(later.recover(), null, 'consumed');
    assert.equal(st.getItem(PS.KEYS.inflight), null);
  });

  test('recover ignores a too-short or corrupt checkpoint, and clearCheckpoint forgets one', () => {
    const st = memStorage();
    const box = PS.createOutbox({ storage: st, post: () => Promise.resolve({}) });
    const short = PS.createSession(local, T0);
    PS.tick(short, 0); PS.tick(short, 0.5);
    box.checkpoint(short);
    assert.equal(box.recover(), null);
    assert.equal(box.size(), 0);
    st.setItem(PS.KEYS.inflight, '{nope');
    assert.equal(box.recover(), null);
    box.checkpoint(PS.createSession(local, T0));
    box.clearCheckpoint();
    assert.equal(st.getItem(PS.KEYS.inflight), null);
    assert.equal(box.recover(), null);
  });
});
