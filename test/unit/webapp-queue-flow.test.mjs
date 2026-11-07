/**
 * webapp/alpha/queue-flow.js — the pure half of the webapp's flow actions
 * (Add All In Flow Order, Flow the queue): items, server grouping, chunking,
 * the per-server calls joined by `end` → `after`, the tail, and matching an
 * answer back onto a queue that moved meanwhile.
 *
 * Every request body a test captures is checked against the route's own
 * schema and cross-field rules (src/api/flow.js), so a body the client
 * builds is one the server accepts.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const QF = require('../../webapp/alpha/queue-flow.js');
const { flowSchema, checkFlowBody, FLOW_MAX_SONGS } = await import('../../src/api/flow.js');
const I = QF._internals;

function assertValidBody(body) {
  const { error, value } = flowSchema.validate(body);
  assert.ok(!error, `schema: ${error && error.message} — ${JSON.stringify(body).slice(0, 300)}`);
  checkFlowBody(value);
}

// A fake server: records each call (validating its body) and answers with
// `answer(server, body, k)`.
function recorder(answer) {
  const calls = [];
  const call = (server, body, signal) => {
    const copy = JSON.parse(JSON.stringify(body));
    calls.push({ server, body: copy, signal });
    assertValidBody(copy);
    return Promise.resolve().then(() => answer(server, copy, calls.length - 1));
  };
  return { calls, call };
}

const err = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

// The server's layout for a toy solve: [start] + the movable songs reversed,
// then unanalysed, then unplaced (both in input order).
function reversed({ unplaced = [], unanalysed = [], signals = true, end = null } = {}) {
  return (server, body) => {
    const n = body.songs.length;
    const pin = body.start === 0;
    const out = new Set([...unplaced, ...unanalysed]);
    const run = [];
    for (let i = n - 1; i >= 0; i--) { if (!(pin && i === 0) && !out.has(i)) { run.push(i); } }
    const notPin = (i) => !(pin && i === 0);
    const order = [...(pin ? [0] : []), ...run, ...unanalysed.filter(notPin), ...unplaced.filter(notPin)];
    const a = {
      order, songs: order.map((i) => body.songs[i]), unplaced, unanalysed,
      signals: { sound: signals, tempo: false, key: false, energy: false }, solver: 'complete', stats: null,
    };
    if (body.returnEnd) { a.end = typeof end === 'function' ? end(body, order) : end; }
    return a;
  };
}

const it = (server, path, bpm, key) => QF.item(server, path, { bpm, 'musical-key': key });
const locals = (n, prefix = 'L') => Array.from({ length: n }, (_, i) => it(null, `${prefix}/${i}.mp3`));
const isPerm = (order, n) => Array.isArray(order) && order.length === n && new Set(order).size === n
  && order.every((i) => Number.isInteger(i) && i >= 0 && i < n);

describe('item / afterOf', () => {
  test('one leading slash stripped; # % ? kept raw; server null or a number', () => {
    const a = QF.item(null, '/Music/a #1 100% ?.mp3', {});
    assert.equal(a.path, 'Music/a #1 100% ?.mp3');
    assert.equal(a.server, null);
    assert.equal(QF.item('7', '//x.mp3', {}).path, '/x.mp3');
    assert.equal(QF.item('7', 'x.mp3', {}).server, 7);
    assert.equal(QF.item(undefined, 'x.mp3').server, null);
  });

  test('BPM kept within 20–300 (numeric strings too); the key trimmed, 1–32 chars', () => {
    assert.equal(it(null, 'a', 124).bpm, 124);
    assert.equal(it(null, 'a', '128.5').bpm, 128.5);
    for (const bad of [19, 301, NaN, 'fast', null, undefined, '']) { assert.equal(it(null, 'a', bad).bpm, null, String(bad)); }
    assert.equal(it(null, 'a', 20).bpm, 20);
    assert.equal(it(null, 'a', 300).bpm, 300);
    assert.equal(it(null, 'a', null, '  8A ').key, '8A');
    assert.equal(it(null, 'a', null, '   ').key, null);
    assert.equal(it(null, 'a', null, 'x'.repeat(33)).key, null);
    assert.equal(it(null, 'a', null, 'x'.repeat(32)).key, 'x'.repeat(32));
    assert.equal(it(null, 'a', null, 8).key, null);
  });

  test('afterOf: null with neither BPM nor key', () => {
    assert.equal(QF.afterOf(it(null, 'a')), null);
    assert.deepEqual(QF.afterOf(it(null, 'a', 120)), { bpm: 120, key: null });
    assert.deepEqual(QF.afterOf(it(null, 'a', null, 'Am')), { bpm: null, key: 'Am' });
    assert.equal(QF.afterOf(null), null);
  });
});

describe('groupByServer', () => {
  test("the lead's server first, then larger groups, first appearance breaking ties", () => {
    const items = [it(1, 'a'), it(null, 'b'), it(2, 'c'), it(2, 'd'), it(3, 'e'), it(null, 'f'), it(1, 'g')];
    assert.deepEqual(I.groupByServer(items, 3).map((g) => [g.server, g.ids]),
      [[3, [4]], [1, [0, 6]], [null, [1, 5]], [2, [2, 3]]]);
    assert.deepEqual(I.groupByServer(items, undefined).map((g) => g.server), [1, null, 2, 3]);
    assert.deepEqual(I.groupByServer(items, null).map((g) => g.server), [null, 1, 2, 3]);
  });
});

describe('flowRuns: one server', () => {
  test('no lead: one call with songs only; answer order mapped; unflowed at the tail in list order', async () => {
    const items = locals(6);
    const r = recorder(reversed({ unplaced: [1], unanalysed: [3, 0] }));
    const res = await QF.flowRuns(items, { call: r.call });
    assert.equal(r.calls.length, 1);
    assert.deepEqual(Object.keys(r.calls[0].body), ['songs']);
    assert.deepEqual(r.calls[0].body.songs, items.map((x) => x.path));
    assert.equal(r.calls[0].server, null);
    assert.deepEqual(res.order, [5, 4, 2, 0, 1, 3]);
    assert.equal(res.failed, false);
    assert.equal(res.calls, 1);
    assert.equal(res.signals, true);
    assert.deepEqual(res.refused, []);
  });

  test('a lead on the same server: songs[0], start 0, never in the order', async () => {
    const lead = it(null, 'Q/lead.mp3', 120, '8A');
    const items = locals(3);
    const r = recorder(reversed());
    const res = await QF.flowRuns(items, { lead, call: r.call });
    assert.deepEqual(r.calls[0].body, { songs: ['Q/lead.mp3', 'L/0.mp3', 'L/1.mp3', 'L/2.mp3'], start: 0 });
    assert.deepEqual(res.order, [2, 1, 0]);
  });

  test('an answer that moves the pinned song is a failure', async () => {
    const lead = it(null, 'Q/lead.mp3');
    const r = recorder(() => ({ order: [1, 0, 2], signals: { sound: true } }));
    const res = await QF.flowRuns(locals(2), { lead, call: r.call });
    assert.equal(res.failed, true);
    assert.equal(res.order, null);
  });

  test('a lead elsewhere gives after {bpm, key}; one without metadata gives none', async () => {
    const r = recorder(reversed());
    await QF.flowRuns(locals(3), { lead: it(7, 'P/x.mp3', 124, '8A'), call: r.call });
    assert.deepEqual(r.calls[0].body, { songs: ['L/0.mp3', 'L/1.mp3', 'L/2.mp3'], after: { bpm: 124, key: '8A' } });
    await QF.flowRuns(locals(3), { lead: it(7, 'P/x.mp3'), call: r.call });
    assert.deepEqual(r.calls[1].body, { songs: ['L/0.mp3', 'L/1.mp3', 'L/2.mp3'] });
  });

  test("a lead whose path can't be sent becomes after, not a pin", async () => {
    const r = recorder(reversed());
    const lead = it(null, '', 99, null);
    const res = await QF.flowRuns(locals(2), { lead, call: r.call });
    assert.deepEqual(r.calls[0].body, { songs: ['L/0.mp3', 'L/1.mp3'], after: { bpm: 99, key: null } });
    assert.deepEqual(res.order, [1, 0]);
  });
});

describe('flowRuns: chunking', () => {
  test('1500 items: 1000 sent, the rest at the tail in list order', async () => {
    const items = locals(1500);
    const r = recorder(reversed());
    const res = await QF.flowRuns(items, { call: r.call });
    assert.equal(r.calls[0].body.songs.length, 1000);
    assert.ok(isPerm(res.order, 1500));
    assert.deepEqual(res.order.slice(0, 3), [999, 998, 997]);
    assert.deepEqual(res.order.slice(1000), Array.from({ length: 500 }, (_, k) => 1000 + k));
  });

  test('with a pin: 999 plus the lead, never 1001', async () => {
    const r = recorder(reversed());
    const res = await QF.flowRuns(locals(1200), { lead: it(null, 'Q/lead.mp3'), call: r.call });
    assert.equal(r.calls[0].body.songs.length, 1000);
    assert.equal(r.calls[0].body.songs[0], 'Q/lead.mp3');
    assert.equal(res.order[0], 998);
    assert.deepEqual(res.order.slice(999, 1002), [999, 1000, 1001]);
  });

  test('the byte budget cuts long paths before 900 KB', async () => {
    const items = Array.from({ length: 400 }, (_, i) => it(null, `${String(i).padStart(4, '0')}/${'é'.repeat(1998)}`));
    const r = recorder(reversed());
    const res = await QF.flowRuns(items, { call: r.call });
    const bytes = Buffer.byteLength(JSON.stringify(r.calls[0].body));
    assert.ok(bytes <= 900 * 1024, `${bytes} bytes`);
    const sent = r.calls[0].body.songs.length;
    assert.ok(sent > 100 && sent < 400, `${sent} sent`);
    assert.deepEqual(res.order.slice(sent), Array.from({ length: 400 - sent }, (_, k) => sent + k));
  });

  test('a path over 4096 characters is never sent and lands at the tail', async () => {
    const items = [it(null, 'a'), it(null, 'x'.repeat(4097)), it(null, 'b'), it(null, 'c')];
    const r = recorder(reversed());
    const res = await QF.flowRuns(items, { call: r.call });
    assert.deepEqual(r.calls[0].body.songs, ['a', 'b', 'c']);
    assert.deepEqual(res.order, [3, 2, 0, 1]);
  });
});

describe('flowRuns: mixed servers', () => {
  test('groups of one make no call (the lead plus one song too); the song feeds the next after', async () => {
    const lead = it(null, 'Q/lead.mp3', 100, '1A');
    const items = [it(7, 'P/a.mp3'), it(null, 'L/x.mp3', 110, '2A'), it(7, 'P/b.mp3')];
    const r = recorder(reversed());
    const res = await QF.flowRuns(items, { lead, call: r.call });
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].server, 7);
    assert.deepEqual(r.calls[0].body, { songs: ['P/a.mp3', 'P/b.mp3'], after: { bpm: 110, key: '2A' } });
    assert.deepEqual(res.order, [1, 2, 0]);
  });

  test('runs in group order; returnEnd on all but the last; end → after, filtered', async () => {
    const items = [it(null, 'L/a'), it(7, 'P/d'), it(null, 'L/b'), it(9, 'N/f'), it(null, 'L/c'), it(7, 'P/e'), it(9, 'N/g')];
    const ends = [
      { index: 0, bpm: 124, key: '8A', vector: 'AAAAAA==', modelId: 'm1', extra: 'new-server-field' },
      { index: 1, bpm: 400, key: 'Am', vector: 'AAAA' },
    ];
    const r = recorder((server, body, k) => reversed({ end: ends[k] })(server, body));
    const res = await QF.flowRuns(items, { call: r.call });
    assert.deepEqual(r.calls.map((c) => c.server), [null, 7, 9]);
    assert.deepEqual(r.calls[0].body, { songs: ['L/a', 'L/b', 'L/c'], returnEnd: true });
    assert.deepEqual(r.calls[1].body, { songs: ['P/d', 'P/e'], after: { vector: 'AAAAAA==', modelId: 'm1', bpm: 124, key: '8A' }, returnEnd: true });
    assert.deepEqual(r.calls[2].body, { songs: ['N/f', 'N/g'], after: { key: 'Am' } });
    assert.deepEqual(res.order, [4, 2, 0, 5, 1, 6, 3]);
    assert.equal(res.calls, 3);
  });

  test("a null end: after comes from the last placed song's metadata", async () => {
    const items = [it(null, 'L/a', 90, '3B'), it(null, 'L/b', 95, null), it(7, 'P/c'), it(7, 'P/d')];
    const r = recorder(reversed({ end: null }));
    await QF.flowRuns(items, { call: r.call });
    // run 1 reversed → b, a: a is the last placed
    assert.deepEqual(r.calls[1].body.after, { bpm: 90, key: '3B' });
  });

  test('placed runs first, then one tail of every unflowed song in list order', async () => {
    const items = [it(null, 'L/a'), it(null, 'L/b'), it(null, 'L/c'), it(7, 'P/d'), it(7, 'P/e'), it(7, 'P/f')];
    const r = recorder((server, body) => reversed(server === null ? { unplaced: [2] } : { unanalysed: [0] })(server, body));
    const res = await QF.flowRuns(items, { call: r.call });
    assert.deepEqual(res.order, [1, 0, 5, 4, 2, 3]);
  });
});

describe('flowRuns: refusal and canFlow', () => {
  test('a peer 403/404 is refused: its songs to the tail, the join skips it, other runs flow', async () => {
    const items = [it(null, 'L/a'), it(null, 'L/b'), it(null, 'L/c'), it(7, 'P/d'), it(7, 'P/e'), it(9, 'N/f'), it(9, 'N/g')];
    for (const status of [403, 404]) {
      const r = recorder((server, body) => {
        if (server === 7) { throw err(status); }
        return reversed({ end: { bpm: 128, key: '5A' } })(server, body);
      });
      const res = await QF.flowRuns(items, { call: r.call });
      assert.equal(res.failed, false);
      assert.deepEqual(res.refused, [7]);
      assert.deepEqual(r.calls[2].body.after, { bpm: 128, key: '5A' }, 'the join skips the refused group');
      assert.deepEqual(res.order, [2, 1, 0, 6, 5, 3, 4]);
      assert.equal(res.calls, 2);
    }
  });

  test('a 403 from this server is a failure', async () => {
    const r = recorder(() => { throw err(403); });
    const res = await QF.flowRuns(locals(3), { call: r.call });
    assert.equal(res.failed, true);
    assert.deepEqual(res.refused, []);
  });

  test('canFlow false: no call for that server, its songs at the tail', async () => {
    const items = [it(7, 'P/a'), it(null, 'L/b'), it(7, 'P/c'), it(null, 'L/d'), it(7, 'P/e')];
    const r = recorder(reversed());
    const res = await QF.flowRuns(items, { call: r.call, canFlow: (s) => s !== 7 });
    assert.deepEqual(r.calls.map((c) => c.server), [null]);
    assert.deepEqual(res.order, [3, 1, 0, 2, 4]);
  });
});

describe('flowRuns: failures', () => {
  const malformed = [
    { order: [0, 1] },
    { order: [0, 0, 1] },
    { order: [0, 1, 3] },
    { order: [0, 1.5, 2] },
    { order: [0, '1', 2] },
    null,
    'nope',
  ];
  test('429, 500, 502, a statusless rejection and malformed answers all fail; nothing is called after', async () => {
    const throws = [err(429), err(500), err(502), new Error('network')];
    for (const failure of [...throws.map((e) => () => { throw e; }), ...malformed.map((m) => () => m)]) {
      const items = [it(null, 'L/a'), it(null, 'L/b'), it(null, 'L/c'), it(7, 'P/d'), it(7, 'P/e')];
      const r = recorder(() => failure());
      const res = await QF.flowRuns(items, { call: r.call });
      assert.equal(res.failed, true);
      assert.equal(res.order, null);
      assert.ok(res.error);
      assert.equal(r.calls.length, 1, 'no call after the first failure');
    }
  });

  test('timeout: a call that never settles fails, and its signal is aborted', async () => {
    const r = recorder(() => new Promise(() => {}));
    const res = await QF.flowRuns(locals(3), { call: r.call, timeoutMs: 20 });
    assert.equal(res.failed, true);
    assert.equal(res.error.timeout, true);
    assert.equal(r.calls[0].signal.aborted, true);
  });

  test('signals: false when every answer had none, true when any had one', async () => {
    const items = [it(null, 'L/a'), it(null, 'L/b'), it(7, 'P/c'), it(7, 'P/d')];
    const none = await QF.flowRuns(items, { call: recorder(reversed({ signals: false })).call });
    assert.equal(none.signals, false);
    assert.equal(none.calls, 2);
    const one = await QF.flowRuns(items, { call: recorder((s, b) => reversed({ signals: s === 7 })(s, b)).call });
    assert.equal(one.signals, true);
  });

  test('nothing to send: no calls, list order', async () => {
    const res = await QF.flowRuns([it(null, 'a')], { call: () => { throw new Error('called'); } });
    assert.deepEqual(res, { order: [0], failed: false, error: null, calls: 0, signals: false, refused: [] });
    const empty = await QF.flowRuns([], { call: () => { throw new Error('called'); } });
    assert.deepEqual(empty.order, []);
  });
});

describe('queueSubject', () => {
  const q = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  test('remaining, whole, nothing playing, one song', () => {
    const rem = QF.queueSubject(q, 1, 'remaining');
    assert.deepEqual([rem.mode, rem.current, rem.subject], ['remaining', q[1], [q[2], q[3]]]);
    const whole = QF.queueSubject(q, 1, 'whole');
    assert.deepEqual([whole.mode, whole.current, whole.subject], ['whole', q[1], [q[2], q[3], q[0]]], 'upcoming first, then the played');
    for (const pos of [-1, 4, 1.5, undefined]) {
      for (const mode of ['remaining', 'whole']) {
        const p = QF.queueSubject(q, pos, mode);
        assert.deepEqual([p.mode, p.current, p.subject], ['whole', null, q]);
        assert.notEqual(p.subject, q, 'a copy');
      }
    }
    assert.equal(QF.queueSubject([q[0]], 0, 'whole').subject.length, 0);
    assert.equal(QF.queueSubject(q, 3, 'remaining').subject.length, 0);
    assert.equal(QF.currentOf(q, 2), q[2]);
    assert.equal(QF.currentOf(q, 9), null);
  });

  test('whole past the cap: the 999 sent are the upcoming songs; the overflow keeps upcoming, then played', async () => {
    const queue = Array.from({ length: 3000 }, (_, i) => ({ id: i, item: it(null, `L/${i}.mp3`) }));
    const flowWhole = async (pos) => {
      const plan = QF.queueSubject(queue, pos, 'whole');
      const r = recorder(reversed());
      const res = await QF.flowRuns(plan.subject.map((x) => x.item), { lead: queue[pos].item, call: r.call });
      assert.equal(r.calls.length, 1);
      const merged = QF.mergeAnswer(queue, queue[pos], plan, res.order.map((i) => plan.subject[i]));
      assert.equal(merged.length, 3000);
      assert.equal(new Set(merged).size, 3000);
      return { body: r.calls[0].body, ids: merged.map((x) => x.id) };
    };

    // 999 still to come: exactly those are flowed; every played song follows.
    const a = await flowWhole(2000);
    assert.equal(a.body.start, 0);
    assert.equal(a.body.songs.length, 1000);
    assert.deepEqual(a.body.songs.slice(0, 3), ['L/2000.mp3', 'L/2001.mp3', 'L/2002.mp3']);
    assert.equal(a.body.songs[999], 'L/2999.mp3');
    assert.deepEqual([a.ids[0], a.ids[1], a.ids[999]], [2000, 2999, 2001], 'the playing song, then the upcoming flowed (toy solve reversed)');
    assert.deepEqual([a.ids[1000], a.ids[1001], a.ids[2999]], [0, 1, 1999], 'the played songs after, in queue order');

    // 1499 still to come: the first 999 are flowed, the other 500 wait ahead of history.
    const b = await flowWhole(1500);
    assert.deepEqual([b.body.songs[1], b.body.songs[999]], ['L/1501.mp3', 'L/2499.mp3']);
    assert.deepEqual([b.ids[0], b.ids[1], b.ids[999]], [1500, 2499, 1501]);
    assert.deepEqual([b.ids[1000], b.ids[1499], b.ids[1500], b.ids[2999]], [2500, 2999, 0, 1499]);
  });
});

describe('mergeAnswer', () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: i }));
  const ids = (a) => a.map((r) => r.id);

  test('unchanged queue: remaining keeps the prefix; whole leads with the current song', () => {
    const q = rows(5);
    const rem = QF.queueSubject(q, 1, 'remaining');
    assert.deepEqual(ids(QF.mergeAnswer(q, q[1], rem, [q[4], q[2], q[3]])), [0, 1, 4, 2, 3]);
    const whole = QF.queueSubject(q, 2, 'whole');
    assert.deepEqual(ids(QF.mergeAnswer(q, q[2], whole, [q[4], q[0], q[3], q[1]])), [2, 4, 0, 3, 1]);
    const none = QF.queueSubject(q, -1, 'remaining');
    assert.deepEqual(ids(QF.mergeAnswer(q, null, none, [q[3], q[1], q[0], q[4], q[2]])), [3, 1, 0, 4, 2]);
  });

  test('a removed row is skipped; rows added after the current song or at the end follow in live order', () => {
    const q = rows(5);
    const plan = QF.queueSubject(q, 1, 'remaining');
    const x = { id: 'x' };
    const y = { id: 'y' };
    const live = [q[0], q[1], x, q[2], q[4], y];   // q[3] removed, x and y added
    assert.deepEqual(ids(QF.mergeAnswer(live, q[1], plan, [q[4], q[3], q[2]])), [0, 1, 4, 2, 'x', 'y']);
    const whole = QF.queueSubject(q, 1, 'whole');
    assert.deepEqual(ids(QF.mergeAnswer(live, q[1], whole, [q[4], q[3], q[0], q[2]])), [1, 4, 0, 2, 'x', 'y']);
  });

  test('remaining: playback moved forward into the subject', () => {
    const q = rows(6);
    const plan = QF.queueSubject(q, 1, 'remaining');
    // flowed 5,3,2,4; meanwhile playback advanced 1 → 2 → 3
    assert.deepEqual(ids(QF.mergeAnswer(q, q[3], plan, [q[5], q[3], q[2], q[4]])), [0, 1, 2, 3, 5, 4]);
  });

  test('null: whole-mode current changed, remaining jumped back or left, something started playing', () => {
    const q = rows(5);
    const whole = QF.queueSubject(q, 1, 'whole');
    assert.equal(QF.mergeAnswer(q, q[2], whole, [q[0], q[2], q[3], q[4]]), null);
    const rem = QF.queueSubject(q, 2, 'remaining');
    assert.equal(QF.mergeAnswer(q, q[0], rem, [q[4], q[3]]), null, 'backwards');
    assert.equal(QF.mergeAnswer(q, null, rem, [q[4], q[3]]), null, 'stopped');
    assert.equal(QF.mergeAnswer([q[0], q[1], q[3], q[4]], q[3], QF.queueSubject(q, 2, 'whole'), [q[4], q[3], q[1], q[0]]), null, 'left the queue');
    const none = QF.queueSubject(q, -1, 'whole');
    assert.equal(QF.mergeAnswer(q, q[0], none, q.slice().reverse()), null, 'started playing');
  });

  test('randomized: every non-null result is a permutation of live', () => {
    let seed = 7;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    let nonNull = 0;
    for (let round = 0; round < 400; round++) {
      const q = rows(1 + rnd(12));
      const pos = rnd(q.length + 2) - 1;
      const plan = QF.queueSubject(q, pos, rnd(2) ? 'remaining' : 'whole');
      const flowed = plan.subject.slice().sort(() => rnd(3) - 1);
      const live = q.slice();
      for (let m = rnd(4); m > 0; m--) {
        const op = rnd(3);
        if (op === 0 && live.length) { live.splice(rnd(live.length), 1); }
        if (op === 1) { live.splice(rnd(live.length + 1), 0, { id: `n${round}.${m}` }); }
        if (op === 2 && live.length > 1) { const [r] = live.splice(rnd(live.length), 1); live.splice(rnd(live.length + 1), 0, r); }
      }
      const cur = rnd(4) === 0 ? QF.currentOf(live, rnd(live.length + 1) - 1) : (live.indexOf(plan.current) >= 0 ? plan.current : null);
      const out = QF.mergeAnswer(live, cur, plan, flowed);
      if (out === null) { continue; }
      nonNull++;
      assert.equal(out.length, live.length);
      assert.deepEqual(new Set(out), new Set(live));
    }
    assert.ok(nonNull > 100, `${nonNull} merges`);
  });

  test('sameOrder', () => {
    const q = rows(3);
    assert.equal(QF.sameOrder(q, q.slice()), true);
    assert.equal(QF.sameOrder(q, [q[1], q[0], q[2]]), false);
    assert.equal(QF.sameOrder(q, q.slice(0, 2)), false);
    assert.equal(QF.sameOrder([], []), true);
  });
});

describe('contract with the route', () => {
  test('a 1000-song pinned body passes; the runner never builds 1001', async () => {
    const r = recorder(reversed());
    await QF.flowRuns(locals(1000), { lead: it(null, 'Q/lead.mp3'), call: r.call });
    assert.equal(r.calls[0].body.songs.length, 1000);
    assert.equal(QF.MAX_SONGS, FLOW_MAX_SONGS);
    assert.equal(I.MAX_SONGS, FLOW_MAX_SONGS);
  });

  test('afterFromEnd drops what the next schema would refuse', () => {
    assert.equal(I.afterFromEnd(null), null);
    assert.equal(I.afterFromEnd({ index: 3, bpm: null, key: null }), null);
    assert.deepEqual(I.afterFromEnd({ vector: 'not base64!', modelId: 'm', bpm: 120 }), { bpm: 120 });
    assert.deepEqual(I.afterFromEnd({ vector: 'AAAA', modelId: null, key: 'Am' }), { key: 'Am' });
    for (const after of [I.afterFromEnd({ vector: 'AAAA', modelId: 'm', bpm: 20, key: '1A', index: 0, other: 1 })]) {
      assertValidBody({ songs: ['a', 'b'], after });
    }
  });
});
