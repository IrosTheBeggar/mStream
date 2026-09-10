/**
 * src/stats/forward.js — which stored plays become Last.fm scrobbles, and
 * the queue that sends them.
 *
 * Pure: `send` is injected, so no Last.fm client is involved; the client
 * itself is pinned by lastfm-client.test.mjs and the whole path by
 * test/integration/stats-forwarding.test.mjs.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scrobbleFor, planScrobbles, createForwarder, LASTFM_WINDOW_MS, LASTFM_MIN_TRACK_MS,
} from '../../src/stats/forward.js';

const NOW = new Date('2026-09-10T12:00:00Z');
const STARTED = new Date('2026-09-10T11:00:00Z');
const STARTED_S = Math.floor(STARTED.getTime() / 1000);
const ev = (over = {}) => ({
  eventId: 'e', counted: true, startedAt: STARTED, durationMs: 299400, peerId: null, snapshot: null, ...over,
});
const local = { title: 'Let Down', artist: 'Radiohead', album: 'OK Computer' };
const quiet = { debug() {}, warn() {} };
const account = { id: 1, lastfm_user: 'u', lastfm_password: 'p' };

describe('scrobbleFor', () => {
  test('a counted local play: the library strings, the start in epoch seconds, the length in seconds', () => {
    assert.deepEqual(scrobbleFor(ev(), local, NOW),
      { artist: 'Radiohead', track: 'Let Down', album: 'OK Computer', timestamp: STARTED_S, duration: 299 });
  });

  test('an uncounted play is never scrobbled', () => {
    assert.equal(scrobbleFor(ev({ counted: false }), local, NOW), null);
  });

  test("Last.fm's window: older than 14 days or ahead of now → nothing", () => {
    assert.equal(scrobbleFor(ev({ startedAt: new Date(NOW.getTime() - LASTFM_WINDOW_MS - 1000) }), local, NOW), null);
    assert.equal(scrobbleFor(ev({ startedAt: new Date(NOW.getTime() + 60_000) }), local, NOW), null);
    assert.ok(scrobbleFor(ev({ startedAt: new Date(NOW.getTime() - LASTFM_WINDOW_MS + 60_000) }), local, NOW), 'just inside');
    assert.ok(scrobbleFor(ev({ startedAt: NOW }), local, NOW), 'starting right now is fine');
  });

  test('artist and title are required; blanks count as missing; album is optional', () => {
    assert.equal(scrobbleFor(ev(), { ...local, artist: null }, NOW), null);
    assert.equal(scrobbleFor(ev(), { ...local, title: '   ' }, NOW), null);
    assert.equal(scrobbleFor(ev(), null, NOW), null);
    assert.equal(scrobbleFor(ev(), { title: 'T', artist: ' A ' }, NOW).album, undefined);
    assert.equal(scrobbleFor(ev(), { title: 'T', artist: ' A ' }, NOW).artist, 'A', 'trimmed');
  });

  test('a track shorter than 30 s is never scrobbled; an unknown length is sent without one', () => {
    assert.equal(scrobbleFor(ev({ durationMs: LASTFM_MIN_TRACK_MS - 1 }), local, NOW), null);
    assert.equal(scrobbleFor(ev({ durationMs: LASTFM_MIN_TRACK_MS }), local, NOW).duration, 30);
    assert.equal(scrobbleFor(ev({ durationMs: null }), local, NOW).duration, undefined);
    assert.equal(scrobbleFor(ev({ durationMs: 0 }), local, NOW).duration, undefined);
  });

  test("a peer play takes its strings from the snapshot — there is no library row to read", () => {
    const e = ev({ peerId: 3, snapshot: { title: 'Remote', artist: 'Peer', album: 'Far', hash: 'h' }, durationMs: 200000 });
    assert.deepEqual(scrobbleFor(e, null, NOW),
      { artist: 'Peer', track: 'Remote', album: 'Far', timestamp: STARTED_S, duration: 200 });
    assert.equal(scrobbleFor(ev({ peerId: 3, snapshot: { title: 'Remote' } }), local, NOW), null,
      'a snapshot without an artist is not filled in from anywhere else');
  });

  test('a stored-text start time is read too', () => {
    assert.equal(scrobbleFor(ev({ startedAt: '2026-09-10T11:00:00.000Z' }), local, NOW).timestamp, STARTED_S);
    assert.equal(scrobbleFor(ev({ startedAt: 'garbage' }), local, NOW), null);
  });
});

describe('planScrobbles', () => {
  test('keeps the batch order and drops what Last.fm would not take', () => {
    const stored = [
      { event: ev({ eventId: 'a' }), track: local },
      { event: ev({ eventId: 'b', counted: false }), track: local },
      { event: ev({ eventId: 'c', peerId: 2, snapshot: { title: 'R', artist: 'P' } }), track: null },
    ];
    assert.deepEqual(planScrobbles(stored, NOW).map((s) => s.track), ['Let Down', 'R']);
    assert.deepEqual(planScrobbles([], NOW), []);
    assert.deepEqual(planScrobbles(undefined, NOW), []);
  });
});

describe('createForwarder', () => {
  test('drains one at a time with a gap between sends; a failure or a throw costs only its own scrobble', async () => {
    const sent = [];
    const gaps = [];
    const send = (user, song) => {
      sent.push(`${user.lastfm_user}:${song.track}`);
      if (song.track === 'boom') { return Promise.reject(new Error('boom')); }
      return Promise.resolve(song.track === 'nope' ? { ok: false, error: 'lastfm-9' } : { ok: true });
    };
    const f = createForwarder({ send, spacingMs: 7, sleep: (ms) => { gaps.push(ms); return Promise.resolve(); }, log: quiet });
    const songs = ['a', 'boom', 'nope', 'd'].map((t, i) => ({ artist: 'x', track: t, timestamp: i }));
    assert.equal(f.enqueue(account, songs), 4);
    await f.idle();
    assert.deepEqual(sent, ['u:a', 'u:boom', 'u:nope', 'u:d']);
    assert.deepEqual(gaps, [7, 7, 7], 'a gap between sends, none after the last');
    assert.deepEqual(f.stats, { sent: 2, failed: 2, dropped: 0 });
    assert.equal(f.pending, 0);
  });

  test('only the account is kept on the queue, never the whole request user', async () => {
    const seen = [];
    const f = createForwarder({ send: (user) => { seen.push(user); return Promise.resolve({ ok: true }); }, spacingMs: 0, log: quiet });
    f.enqueue({ ...account, username: 'alice', password: 'hash', vpaths: ['music'] }, [{ artist: 'x', track: 't', timestamp: 1 }]);
    await f.idle();
    assert.deepEqual(seen, [account]);
  });

  test('no linked account, or nothing to send → nothing queued', async () => {
    let sends = 0;
    const f = createForwarder({ send: () => { sends++; return Promise.resolve({ ok: true }); }, spacingMs: 0, log: quiet });
    assert.equal(f.enqueue({ id: 1 }, [{ artist: 'x', track: 't', timestamp: 1 }]), 0);
    assert.equal(f.enqueue({ id: 1, lastfm_user: 'u' }, [{ artist: 'x', track: 't', timestamp: 1 }]), 0, 'a user without a password');
    assert.equal(f.enqueue(account, []), 0);
    await f.idle();
    assert.equal(sends, 0);
  });

  test('the queue is capped: the oldest waiting scrobbles go, with one warning', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const sent = [];
    const warns = [];
    const send = async (_u, song) => { sent.push(song.track); await gate; return { ok: true }; };
    const f = createForwarder({ send, spacingMs: 0, maxQueue: 2, log: { debug() {}, warn: (m) => warns.push(m) } });
    const song = (t) => ({ artist: 'x', track: t, timestamp: 1 });
    f.enqueue(account, [song('first')]);                       // taken by the drain at once, parked on the gate
    f.enqueue(account, [song('a'), song('b'), song('c')]);      // cap 2 → 'a' is dropped
    assert.equal(f.pending, 2);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /dropped the 1 oldest/);
    assert.equal(f.stats.dropped, 1);
    release();
    await f.idle();
    assert.deepEqual(sent, ['first', 'b', 'c']);
  });

  test('a second batch during a drain joins the same drain', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const sent = [];
    const send = async (_u, song) => { sent.push(song.track); if (song.track === 'first') { await gate; } return { ok: true }; };
    const f = createForwarder({ send, spacingMs: 0, log: quiet });
    const song = (t) => ({ artist: 'x', track: t, timestamp: 1 });
    f.enqueue(account, [song('first')]);
    f.enqueue(account, [song('second')]);
    release();
    await f.idle();
    assert.deepEqual(sent, ['first', 'second']);
    assert.equal(f.stats.sent, 2);
  });
});
