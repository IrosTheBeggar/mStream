/**
 * webapp/alpha/peer-recs.js — the Peer Recommendations page's pure helpers,
 * on node (docs/peer-recommendations-plan.md §4.1 W2, §5):
 *
 *   - nameKey is src/db/name-key.js's on fixed and generated inputs, so a
 *     preview's album and artist fold the way the server built the tiles;
 *   - the tile and strip-circle colours from a server-stamped hue;
 *   - the peer strip from answers the server's own buildPeerView builds:
 *     member vs admin, every Add state, a local "Adding…" standing until a
 *     poll sent after it and then yielding, the selected peer leaving the
 *     shelf → All (R5);
 *   - the poll cadence (R6), every Add answer — the 202 / 200 / 404 / 409
 *     ones straight from the server's Add state machine (createPeerAdder
 *     over a hand-steered shelf) — and R4's "landed";
 *   - the preview provider from the plug-in registry's own listing (the
 *     first previewing plug-in, no second), the 429 waits, the earned-art
 *     rule, the lead key, Preview all's next lead, the Copy texts and the
 *     window's peer line, on leads the taste route's own stampNetworkRows
 *     stamped;
 *   - every key the strip emits has an English value with its params (the
 *     other 11 locale files are test/unit/webapp-peer-recs-strings.test.mjs's).
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { nameKey as serverNameKey } from '../../src/db/name-key.js';
import { buildPeerView, leadTile, peerLabels } from '../../src/state/discovery-peer-view.js';
import { createPeerAdder } from '../../src/state/discovery-peer-add.js';
import { stampNetworkRows } from '../../src/api/discovery-taste.js';
import * as plugins from '../../src/discovery-plugins/index.js';

const require = createRequire(import.meta.url);
const P = require('../../webapp/alpha/peer-recs.js');
const D = require('../../webapp/alpha/discovery-page.js');

const NOW = Date.parse('2026-10-27T10:00:00.000Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const MODEL = 'model-x';
// Endpoint ids are 64 hex; the head picks the hue and the label suffix.
const id = (head) => head.padEnd(64, '0');

// ── the stage's peers, in the route's own shapes ────────────────────────

const BASEMENT = id('aa01');
const KITCHEN = id('bb02');
const MSTREAM = id('3f9a');
const LIGHTHOUSE = id('cc03');
const STATIC = id('dd04');
const ROOFTOP = id('ee05');
const ATTIC = id('ff06');

// A shelf (peer-dbs registry) entry.
function held(endpointId, name, over) {
  return { endpointId, hash: `hash-${endpointId.slice(0, 4)}`, modelId: MODEL, rowCount: 100, sizeBytes: 1000, name, pinned: false, ...over };
}
// A catalog entry; silentMs past the 90 s window = offline.
function cat(endpointId, name, over) {
  const { silentMs = 0, ...payload } = over || {};
  return { from: endpointId, updatedAt: iso(silentMs), payload: { name, hash: `hash-${endpointId.slice(0, 4)}`, rowCount: 100, modelId: MODEL, size: 1000, ...payload } };
}

const SHELF = [held(BASEMENT, 'Basement Hi-Fi'), held(KITCHEN, 'Kitchen Radio'), held(MSTREAM, '')];
const CATALOG = [
  cat(BASEMENT, 'Basement Hi-Fi'),
  cat(KITCHEN, 'Kitchen Radio'),
  cat(MSTREAM, '', { silentMs: 10 * 60 * 1000 }),
  cat(LIGHTHOUSE, 'Lighthouse Tapes'),
  cat(STATIC, 'Static Garden'),
  cat(ROOFTOP, 'Rooftop FM'),
];

// GET /api/v1/discovery/p2p/peers as the route builds it.
function peersAnswer({ canAdd = false, shelf = SHELF, catalog = CATALOG, states = {} } = {}) {
  return buildPeerView({
    shelf, catalog, localModel: MODEL, now: NOW, canAdd, running: true,
    addStateOf: (endpointId) => states[endpointId] || null,
  });
}
const failed = (code) => ({ state: 'failed', code, at: NOW });
const ADMIN_STATES = { [STATIC]: { state: 'adding', code: null, at: NOW }, [ROOFTOP]: failed('offline') };

const byId = (strip, endpointId) => strip.items.find((item) => item.id === endpointId);
const view = (strip) => strip.items.map((item) => [item.kind, item.label || item.text.key, item.state, item.act, item.selected]);

// ── leads, stamped by the taste route itself ───────────────────────────

const LABELS = peerLabels({ shelf: SHELF, catalog: CATALOG });
const lead = (exportId, artist, title, album, endpointId) => ({
  seedIndex: 0, artist, title, album, year: null, isrc: null, duration: 200, similarity: 0.8,
  recordingMbid: null, exportId, peer: { endpointId, name: CATALOG.find((c) => c.from === endpointId).payload.name || null },
});
const LEADS = stampNetworkRows([
  lead('x1', 'Paper Lantern', 'Signal Fires', 'Night Ferry', KITCHEN),
  lead('x2', '  PAPER   lantern ', 'Harbor Lights', 'Night  Ferry', BASEMENT),
  lead('x3', 'Marlowe Fields', 'Long Exposure', 'Daylight Savings', KITCHEN),
  lead('x4', 'Juniper Static', 'Arcade Rain', 'Neon Psalms', MSTREAM),
  lead('x5', '', 'Untitled Lead', null, BASEMENT),
  lead('x6', 'Kestrel & Vine', 'Copper Dawn', null, KITCHEN),
], [{ hash: 'seed-1' }], 32, LABELS);
const [SIGNAL, HARBOR, LONG, ARCADE, UNTITLED, COPPER] = LEADS;

// ── nameKey ────────────────────────────────────────────────────────────

// A small deterministic PRNG (mulberry32), so the generated corpus is the
// same on every run.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('nameKey is src/db/name-key.js\'s, byte for byte', () => {
  test('fixed inputs: whitespace, every folded quote and dash, case, scripts, non-strings', () => {
    const inputs = [
      null, undefined, '', ' ', '\t\n', 42, 0, true, false, { toString: () => '  Obj  ' }, ['A', 'B'],
      'Paper Lantern', '  PAPER   lantern ', 'Night  Ferry', 'Night Ferry – Live', 'Guns N’ Roses', '“Weird Al” Yankovic',
      '‘single’ ‚low‛ ′prime', '„double‟ ″dprime', 'a‐b‑c‒d–e—f―g−h', 'Beyoncé', 'Ólafur Arnalds', 're:member',
      '坂本龍一', 'ßtraße', 'İstanbul', 'ΟΔΟΣ', 'Σίσυφος', 'Ǆemal', 'ﬁne', 'élan', ' nbsp ', ' em　ideo',
      '﻿bom', 'zero​width', 'line sep', 'ogham mark', 'R.E.M.', 'AC/DC', '(Sandy) Alex G', '123 Band', '⚡',
      '👩‍👩‍👧 family', 'Ⅻ', 'ＦＵＬＬ', 'KK', 'MIXED case Ünterwelt',
    ];
    for (const raw of inputs) {
      assert.equal(P.nameKey(raw), serverNameKey(raw), JSON.stringify(String(raw)));
    }
  });

  test('2000 generated strings over spaces, folded marks and mixed scripts — and the Discover page agrees', () => {
    const POOL = [
      ' ', '  ', '\t', '\n', '\r', ' ', ' ', '　', '﻿', '​', ' ', ' ',
      '‘', '’', '‚', '‛', '′', '“', '”', '„', '‟', '″', '‐', '‑', '‒', '–', '—', '―', '−', "'", '"', '-',
      'a', 'Z', 'é', 'É', 'ß', 'İ', 'ı', 'Σ', 'ς', 'Ω', 'ǅ', 'ﬁ', 'Ａ', 'K', '坂', 'ア', '한', 'Я', 'ё',
      '́', '1', '٣', '&', '/', ':', '.', '(', ')', '⚡', '👩', '‍',
    ];
    const rnd = prng(0x5eed);
    for (let n = 0; n < 2000; n++) {
      let s = '';
      const len = Math.floor(rnd() * 24);
      for (let k = 0; k < len; k++) { s += POOL[Math.floor(rnd() * POOL.length)]; }
      assert.equal(P.nameKey(s), serverNameKey(s), JSON.stringify(s));
      assert.equal(P.nameKey(s), D.nameKey(s), JSON.stringify(s));
    }
  });
});

// ── colours ────────────────────────────────────────────────────────────

describe('tileColours: the tile and strip colours from a server-stamped hue', () => {
  test('the web field and ink (§5.1), the strip circle and its dimmed and adding forms (the board)', () => {
    assert.deepEqual(P.tileColours(210), {
      hue: 210,
      field: 'hsl(210, 22%, 24%)',
      ink: 'hsl(210, 30%, 72%)',
      circle: 'hsl(210, 55%, 74%)',
      circleDim: 'hsl(210, 18%, 30%)',
      inkDim: 'hsl(210, 25%, 82%)',
      circleAdding: 'hsla(210, 55%, 74%, .35)',
    });
  });

  test('a lead\'s colours come from the hue the server stamped on its tile', () => {
    for (const raw of LEADS) {
      const { hue } = leadTile(raw);
      assert.equal(raw.tile.hue, hue);
      assert.equal(P.tileColours(raw.tile.hue).field, `hsl(${hue}, 22%, 24%)`);
      assert.equal(P.tileColours(raw.tile.hue).ink, `hsl(${hue}, 30%, 72%)`);
    }
  });

  test('a hue is an integer 0–359 before it reaches a style; anything else is 0', () => {
    assert.deepEqual([360, 361, -30, 210.4, 359.6, 0].map(P.hueOf), [0, 1, 330, 210, 0, 0]);
    for (const bad of [NaN, Infinity, '210', null, undefined, {}, '1;background:url(x)']) {
      assert.equal(P.hueOf(bad), 0, JSON.stringify(String(bad)));
      assert.equal(P.tileColours(bad).field, 'hsl(0, 22%, 24%)');
    }
  });
});

// ── the peer strip ─────────────────────────────────────────────────────

describe('stripItems: the peer strip from the peers route\'s answer', () => {
  test('a member: All (selected) and the shelf peers in the server\'s order — labels and monograms verbatim, no "+"', () => {
    const answer = peersAnswer();
    assert.equal(answer.canAdd, false);
    const strip = P.stripItems(answer, {});
    assert.deepEqual(view(strip), [
      ['all', 'peerRecs.all', null, 'tab', true],
      ['peer', 'Basement Hi-Fi', null, 'tab', false],
      ['peer', 'Kitchen Radio', null, 'tab', false],
      ['peer', 'mStream · 3f9a', null, 'tab', false],
    ]);
    assert.deepEqual(strip.items.slice(1).map((item) => [item.id, item.monogram, item.hue, item.online]),
      answer.peers.map((row) => [row.endpointId, row.monogram, row.hue, row.online]));
    assert.deepEqual([byId(strip, MSTREAM).monogram, byId(strip, MSTREAM).online, byId(strip, KITCHEN).online], ['mS', false, true]);
    assert.deepEqual([strip.selected, strip.fallback, strip.local], [null, false, {}]);
    // a member never gets an add item, even from rows the answer carries
    const leaky = { ...answer, peers: [...answer.peers, { ...answer.peers[0], endpointId: LIGHTHOUSE, onShelf: false }] };
    assert.equal(P.stripItems(leaky, {}).items.some((item) => item.kind === 'add'), false);
  });

  test('an admin: the addable peers after the shelf, one item per Add state', () => {
    const answer = peersAnswer({ canAdd: true, states: ADMIN_STATES });
    const strip = P.stripItems(answer, {});
    assert.deepEqual(view(strip), [
      ['all', 'peerRecs.all', null, 'tab', true],
      ['peer', 'Basement Hi-Fi', null, 'tab', false],
      ['peer', 'Kitchen Radio', null, 'tab', false],
      ['peer', 'mStream · 3f9a', null, 'tab', false],
      ...answer.peers.filter((row) => !row.onShelf).map((row) => ['add', row.label,
        { [STATIC]: 'adding', [ROOFTOP]: 'failed' }[row.endpointId] || null,
        row.endpointId === STATIC ? null : 'add', false]),
    ]);
    assert.deepEqual(byId(strip, LIGHTHOUSE), {
      kind: 'add', id: LIGHTHOUSE, label: 'Lighthouse Tapes', monogram: 'LT', hue: answer.peers.find((r) => r.endpointId === LIGHTHOUSE).hue,
      online: true, selected: false, state: null, act: 'add', text: null,
      aria: { key: 'peerRecs.a11y.add', params: { name: 'Lighthouse Tapes' } },
    });
    assert.deepEqual([byId(strip, STATIC).text, byId(strip, STATIC).aria],
      [{ key: 'peerRecs.adding', params: {} }, { key: 'peerRecs.a11y.adding', params: { name: 'Static Garden' } }]);
    assert.deepEqual([byId(strip, ROOFTOP).text, byId(strip, ROOFTOP).aria],
      [{ key: 'peerRecs.tryAgain', params: {} }, { key: 'peerRecs.a11y.failed', params: { name: 'Rooftop FM' } }]);
  });

  test('every Add state an addable row can carry', () => {
    const cases = [
      [null, null, 'add', null],
      [{ state: 'adding', code: null }, 'adding', null, 'peerRecs.adding'],
      // done but not yet a shelf row in this answer: it lands on the next poll
      [{ state: 'done', code: null }, 'adding', null, 'peerRecs.adding'],
      [failed('no-room'), 'noRoom', null, 'peerRecs.noRoom'],
      [failed('offline'), 'failed', 'add', 'peerRecs.tryAgain'],
      [failed('no-disk'), 'failed', 'add', 'peerRecs.tryAgain'],
      [failed('bad-snapshot'), 'failed', 'add', 'peerRecs.tryAgain'],
      [failed('gone'), 'failed', 'add', 'peerRecs.tryAgain'],
      [failed('failed'), 'failed', 'add', 'peerRecs.tryAgain'],
      [{ state: 'mystery' }, null, 'add', null],
    ];
    for (const [add, state, act, text] of cases) {
      const item = byId(P.stripItems(peersAnswer({ canAdd: true, states: add ? { [LIGHTHOUSE]: add } : {} }), {}), LIGHTHOUSE);
      assert.deepEqual([item.state, item.act, item.text && item.text.key], [state, act, text], JSON.stringify(add));
    }
    const noRoom = byId(P.stripItems(peersAnswer({ canAdd: true, states: { [LIGHTHOUSE]: failed('no-room') } }), {}), LIGHTHOUSE);
    assert.deepEqual(noRoom.aria, { key: 'peerRecs.a11y.noRoom', params: { name: 'Lighthouse Tapes' } });
  });

  test('a local "Adding…" stands until a poll sent after the press answers, then yields to the server', () => {
    const local = { [LIGHTHOUSE]: { state: 'adding', poll: 4 } };
    const idle = peersAnswer({ canAdd: true });
    // poll 4 was sent before the press: the press stands over the idle row
    const before = P.stripItems(idle, { local, poll: 4 });
    assert.deepEqual([byId(before, LIGHTHOUSE).state, byId(before, LIGHTHOUSE).act], ['adding', null]);
    assert.deepEqual(before.local, local);
    // without a poll number every local entry stands
    assert.equal(byId(P.stripItems(idle, { local }), LIGHTHOUSE).state, 'adding');
    // it stands over a stale failed state too
    const stale = P.stripItems(peersAnswer({ canAdd: true, states: { [LIGHTHOUSE]: failed('offline') } }), { local, poll: 3 });
    assert.equal(byId(stale, LIGHTHOUSE).state, 'adding');
    // poll 5, sent after it: the server's word, whatever it is, and the entry is dropped
    for (const [states, want] of [
      [{ [LIGHTHOUSE]: { state: 'adding', code: null } }, 'adding'],
      [{ [LIGHTHOUSE]: failed('no-room') }, 'noRoom'],
      [{ [LIGHTHOUSE]: failed('offline') }, 'failed'],
      [{}, null],
    ]) {
      const after = P.stripItems(peersAnswer({ canAdd: true, states }), { local, poll: 5 });
      assert.deepEqual([byId(after, LIGHTHOUSE).state, after.local], [want, {}], JSON.stringify(states));
    }
    // a local "Try again" (a 400 / 5xx / no answer) and a local "No room" stand the same way
    const tryAgain = P.stripItems(idle, { local: { [LIGHTHOUSE]: { state: 'failed', poll: 6 } }, poll: 6 });
    assert.deepEqual([byId(tryAgain, LIGHTHOUSE).state, byId(tryAgain, LIGHTHOUSE).act], ['failed', 'add']);
    const noRoom = P.stripItems(idle, { local: { [LIGHTHOUSE]: { state: 'noRoom', poll: 6 } }, poll: 6 });
    assert.deepEqual([byId(noRoom, LIGHTHOUSE).state, byId(noRoom, LIGHTHOUSE).act], ['noRoom', null]);
  });

  test('a local state is dropped once its peer is on the shelf, gone from the answer, or no longer addable here', () => {
    const local = { [LIGHTHOUSE]: { state: 'adding', poll: 9 }, [STATIC]: { state: 'adding', poll: 9 }, [ATTIC]: { state: 'adding', poll: 9 } };
    const landedShelf = [...SHELF, held(LIGHTHOUSE, 'Lighthouse Tapes')];
    const strip = P.stripItems(peersAnswer({ canAdd: true, shelf: landedShelf }), { local, poll: 2 });
    assert.equal(byId(strip, LIGHTHOUSE).kind, 'peer');
    assert.deepEqual(strip.local, { [STATIC]: local[STATIC] });
    assert.deepEqual(P.stripItems(peersAnswer({ canAdd: false }), { local, poll: 2 }).local, {});
    assert.deepEqual(P.stripItems(peersAnswer({ canAdd: true }), { local: { [LIGHTHOUSE]: { state: 'spinning', poll: 9 } } }).local, {});
  });

  test('the selected peer: kept while on the shelf (offline too); gone from the shelf → All (R5)', () => {
    const kitchen = P.stripItems(peersAnswer(), { selected: KITCHEN });
    assert.deepEqual([kitchen.selected, kitchen.fallback, kitchen.items[0].selected, byId(kitchen, KITCHEN).selected], [KITCHEN, false, false, true]);
    const offline = P.stripItems(peersAnswer(), { selected: MSTREAM });
    assert.deepEqual([offline.selected, offline.fallback, byId(offline, MSTREAM).selected], [MSTREAM, false, true]);
    // rotated out: still announced (an admin sees it as "+"), no longer on the shelf
    const rotated = peersAnswer({ canAdd: true, shelf: SHELF.filter((e) => e.endpointId !== KITCHEN) });
    for (const answer of [rotated, peersAnswer({ shelf: SHELF.filter((e) => e.endpointId !== KITCHEN) })]) {
      const strip = P.stripItems(answer, { selected: KITCHEN });
      assert.deepEqual([strip.selected, strip.fallback, strip.items[0].selected], [null, true, true]);
      assert.equal(strip.items.some((item) => item.selected && item.kind !== 'all'), false);
    }
    assert.equal(byId(P.stripItems(rotated, { selected: KITCHEN }), KITCHEN).kind, 'add');
    // an addable peer is never a selection
    assert.equal(P.stripItems(rotated, { selected: LIGHTHOUSE }).fallback, true);
  });

  test('before the first answer: All alone, the selection and the local states untouched', () => {
    const local = { [LIGHTHOUSE]: { state: 'adding', poll: 1 } };
    assert.deepEqual(P.stripItems(null, { local }), {
      items: [{ kind: 'all', id: null, label: '', monogram: '', hue: 0, online: false, selected: true, state: null, act: 'tab', text: { key: 'peerRecs.all', params: {} }, aria: null }],
      selected: null, fallback: false, local,
    });
    assert.deepEqual([P.stripItems(undefined, { selected: KITCHEN }).selected, P.stripItems(undefined, { selected: KITCHEN }).fallback], [KITCHEN, false]);
    assert.equal(P.stripItems(peersAnswer()).items.length, 4, 'no options at all');
  });

  test('only well-formed endpoint ids are drawn, each once; hues are integers', () => {
    const answer = peersAnswer();
    const good = answer.peers[0];
    const strip = P.stripItems({
      ...answer,
      peers: [
        ...answer.peers,
        { ...good },                                                       // a duplicate
        { ...good, endpointId: good.endpointId.toUpperCase() },            // not the wire's lower case
        { ...good, endpointId: '3f9a' },                                   // short
        { ...good, endpointId: `${'a'.repeat(63)}"` },                     // markup
        { ...good, endpointId: null }, null, 'row',
        { ...good, endpointId: id('ab07'), hue: '1;x', label: 'Odd Hue' },
      ],
    }, {});
    assert.deepEqual(strip.items.map((item) => item.id), [null, BASEMENT, KITCHEN, MSTREAM, id('ab07')]);
    assert.equal(byId(strip, id('ab07')).hue, 0);
    // the page's own check on a clicked item's data-v
    assert.deepEqual([KITCHEN, KITCHEN.toUpperCase(), '3f9a', '', null, 42, `${KITCHEN} `].map(P.isEndpointId),
      [true, false, false, false, false, false, false]);
  });
});

describe('pollDelay: 15 s, or 3 s while a shown row is adding or an own POST is out (R6)', () => {
  test('the cadence', () => {
    assert.deepEqual([P.POLL_MS, P.POLL_FAST_MS], [15000, 3000]);
    const items = (states, local) => P.stripItems(peersAnswer({ canAdd: true, states }), { local }).items;
    assert.equal(P.pollDelay(items({}), 0), 15000);
    assert.equal(P.pollDelay(items({ [STATIC]: { state: 'adding', code: null } }), 0), 3000, 'a server adding');
    assert.equal(P.pollDelay(items({ [STATIC]: { state: 'done', code: null } }), 0), 3000, 'done, not yet on the shelf');
    assert.equal(P.pollDelay(items({}, { [LIGHTHOUSE]: { state: 'adding' } }), 0), 3000, 'a local adding');
    assert.equal(P.pollDelay(items({ [ROOFTOP]: failed('offline'), [STATIC]: failed('no-room') }), 0), 15000, 'failed and No room do not hurry');
    assert.equal(P.pollDelay(items({}), 1), 3000, 'an own POST out');
    assert.equal(P.pollDelay(items({}), true), 3000);
    assert.equal(P.pollDelay(P.stripItems(peersAnswer(), {}).items, false), 15000, 'a member');
    assert.equal(P.pollDelay(null), 15000);
  });
});

// ── Add ────────────────────────────────────────────────────────────────

// The server's Add state machine over a hand-steered shelf and catalog:
// what POST …/peer-dbs/add answers, and the states the peers route reads.
function adderServer() {
  const t = { shelf: new Map(SHELF.map((e) => [e.endpointId, e])), catalog: new Map(CATALOG.map((e) => [e.from, e])), blocked: new Set(), running: true, fits: true, fetches: [] };
  t.adder = createPeerAdder({
    fetchPeer: (endpointId) => new Promise((resolve, reject) => { t.fetches.push({ endpointId, resolve, reject }); }),
    planRoomFor: (endpointId) => (t.catalog.has(endpointId) ? (t.fits ? { fits: true, evictIds: [] } : { fits: false }) : null),
    isBlocked: (endpointId) => t.blocked.has(endpointId),
    heldEntry: (endpointId) => t.shelf.get(endpointId) || null,
    listShelf: () => [...t.shelf.values()],
    catalogEntry: (endpointId) => t.catalog.get(endpointId) || null,
    listCatalog: () => [...t.catalog.values()],
    seederCountOf: () => 0,
    localModel: () => MODEL,
    isRunning: () => t.running,
    onlineWindowMs: () => 90 * 1000,
    onShelfChange: () => {},
    onStop: () => {},
    now: () => NOW,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  t.peers = () => buildPeerView({
    shelf: [...t.shelf.values()], catalog: [...t.catalog.values()], localModel: MODEL, now: NOW, canAdd: true, running: true,
    addStateOf: (endpointId) => t.adder.stateOf(endpointId),
  });
  return t;
}

describe('addOutcome: what an Add\'s answer means for the strip (§5.6)', () => {
  test('the server\'s own answers: 202, 200 done, 200 failed (offline, bad-snapshot, no-room), 404, 409 ×2', () => {
    const t = adderServer();
    const answers = {};
    answers.adding = t.adder.add(LIGHTHOUSE, { by: 'admin' });
    answers.again = t.adder.add(LIGHTHOUSE, { by: 'admin' });
    answers.done = t.adder.add(KITCHEN, { by: 'admin' });
    t.running = false;
    answers.offline = t.adder.add(STATIC, { by: 'admin' });
    t.running = true;
    t.catalog.set(ROOFTOP, cat(ROOFTOP, 'Rooftop FM', { size: 0 }));
    answers.badSnapshot = t.adder.add(ROOFTOP, { by: 'admin' });
    t.fits = false;
    t.catalog.set(ATTIC, cat(ATTIC, 'Attic Tapes'));
    answers.noRoom = t.adder.add(ATTIC, { by: 'admin' });
    answers.unknown = t.adder.add(id('0b0b'), { by: 'admin' });
    t.blocked.add(BASEMENT);
    answers.blocked = t.adder.add(BASEMENT, { by: 'admin' });
    t.catalog.set(id('0c0c'), cat(id('0c0c'), 'Elsewhere', { modelId: 'model-y' }));
    answers.incompatible = t.adder.add(id('0c0c'), { by: 'admin' });

    const statuses = Object.fromEntries(Object.entries(answers).map(([k, a]) => [k, [a.status, a.body.state || a.body.error, a.body.code ?? null]]));
    assert.deepEqual(statuses, {
      adding: [202, 'adding', null], again: [202, 'adding', null], done: [200, 'done', null],
      offline: [200, 'failed', 'offline'], badSnapshot: [200, 'failed', 'bad-snapshot'], noRoom: [200, 'failed', 'no-room'],
      unknown: [404, 'not-in-catalog', null], blocked: [409, 'blocked', null], incompatible: [409, 'incompatible', null],
    });
    const out = (a) => P.addOutcome(a.status, a.body);
    assert.deepEqual(out(answers.adding), { outcome: 'adding', local: 'adding', pollNow: false });
    assert.deepEqual(out(answers.again), { outcome: 'adding', local: 'adding', pollNow: false });
    assert.deepEqual(out(answers.done), { outcome: 'landed', local: 'adding', pollNow: true });
    assert.deepEqual(out(answers.offline), { outcome: 'failed', local: 'failed', pollNow: false });
    assert.deepEqual(out(answers.badSnapshot), { outcome: 'failed', local: 'failed', pollNow: false });
    assert.deepEqual(out(answers.noRoom), { outcome: 'noRoom', local: 'noRoom', pollNow: false });
    for (const k of ['unknown', 'blocked', 'incompatible']) {
      assert.deepEqual(out(answers[k]), { outcome: 'gone', local: null, pollNow: true }, k);
    }

    // the next poll draws what the server stored for each — the same words
    // the local state drew, so nothing flips when it yields
    const strip = P.stripItems(t.peers(), {});
    assert.deepEqual([LIGHTHOUSE, STATIC, ROOFTOP, ATTIC].map((e) => byId(strip, e) && byId(strip, e).state),
      ['adding', 'failed', 'failed', 'noRoom']);
  });

  test('failed codes decided later reach the client the same way: no-room is No room, any other is Try again', () => {
    const body = (code) => ({ endpointId: LIGHTHOUSE, state: 'failed', code, at: iso(0) });
    assert.deepEqual(P.addOutcome(200, body('no-room')), { outcome: 'noRoom', local: 'noRoom', pollNow: false });
    for (const code of ['offline', 'no-disk', 'bad-snapshot', 'gone', 'failed', null, 'something-new']) {
      assert.deepEqual(P.addOutcome(200, body(code)), { outcome: 'failed', local: 'failed', pollNow: false }, String(code));
    }
  });

  test('403 / 405: not allowed (canAdd comes back false); 400 / 5xx / no answer: a local Try again until the next poll', () => {
    for (const status of [403, 405]) {
      assert.deepEqual(P.addOutcome(status, { error: 'nope' }), { outcome: 'notAllowed', local: null, pollNow: true }, String(status));
    }
    for (const [status, body] of [[400, { error: 'bad' }], [500, null], [502, 'Bad Gateway'], [503, {}], [0, null], [401, { error: 'x' }], [200, null], [200, { state: 'odd' }]]) {
      assert.deepEqual(P.addOutcome(status, body), { outcome: 'failed', local: 'failed', pollNow: false }, `${status} ${JSON.stringify(body)}`);
    }
  });
});

describe('landed: when an Add has landed and the current tab is re-asked (R4)', () => {
  test('an own POST lands — through the server\'s Add, then on the poll', async () => {
    const t = adderServer();
    const before = t.peers();
    assert.equal(t.adder.add(LIGHTHOUSE, { by: 'admin' }).status, 202);
    const adding = t.peers();
    assert.deepEqual(P.landed(before, adding, [LIGHTHOUSE], false), { reask: false, ids: [], failed: [] }, 'still adding');
    // the download lands: the shelf holds it, the Add state is done
    t.shelf.set(LIGHTHOUSE, held(LIGHTHOUSE, 'Lighthouse Tapes'));
    t.fetches[0].resolve({ endpointId: LIGHTHOUSE, rowCount: 100, sizeBytes: 1000 });
    await t.adder.whenIdle();
    const after = t.peers();
    assert.equal(after.peers.find((r) => r.endpointId === LIGHTHOUSE).onShelf, true);
    assert.deepEqual(P.landed(adding, after, new Set([LIGHTHOUSE]), false), { reask: true, ids: [LIGHTHOUSE], failed: [] });
    // the next poll: it already landed
    assert.deepEqual(P.landed(after, t.peers(), [LIGHTHOUSE], false), { reask: false, ids: [], failed: [] });
  });

  test('a done state counts before the shelf row shows; posted may be a Set, an array or an object', () => {
    const idle = peersAnswer({ canAdd: true });
    const done = peersAnswer({ canAdd: true, states: { [LIGHTHOUSE]: { state: 'done', code: null, at: NOW } } });
    for (const posted of [[LIGHTHOUSE], new Set([LIGHTHOUSE]), { [LIGHTHOUSE]: true }]) {
      assert.deepEqual(P.landed(idle, done, posted, false).ids, [LIGHTHOUSE]);
    }
  });

  test('an own Add that fails is reported once, so it stops being tracked', () => {
    const adding = peersAnswer({ canAdd: true, states: { [LIGHTHOUSE]: { state: 'adding', code: null, at: NOW } } });
    const down = peersAnswer({ canAdd: true, states: { [LIGHTHOUSE]: failed('offline') } });
    assert.deepEqual(P.landed(adding, down, [LIGHTHOUSE], false), { reask: false, ids: [], failed: [LIGHTHOUSE] });
    assert.deepEqual(P.landed(down, down, [LIGHTHOUSE], false).failed, [], 'a failed state already drawn is not news');
  });

  test('shelf.searchable 0 → more re-asks only while "No peers yet" shows', () => {
    const empty = peersAnswer({ canAdd: true, shelf: [] });
    const one = peersAnswer({ canAdd: true, shelf: [held(BASEMENT, 'Basement Hi-Fi')] });
    assert.deepEqual([empty.shelf.searchable, one.shelf.searchable], [0, 1]);
    assert.equal(P.landed(empty, one, [], true).reask, true);
    assert.equal(P.landed(null, one, [], true).reask, true, 'no earlier answer counts as an empty shelf');
    assert.equal(P.landed(empty, one, [], false).reask, false, 'a page with leads on it is left alone');
    assert.equal(P.landed(one, one, [], true).reask, false, 'no change, no re-ask');
  });

  test('emptied: shelf.searchable more → 0 only (§2 item 18: the page asks again for its "No peers yet")', () => {
    const empty = peersAnswer({ canAdd: true, shelf: [] });
    const one = peersAnswer({ canAdd: true, shelf: [held(BASEMENT, 'Basement Hi-Fi')] });
    const full = peersAnswer({ canAdd: true });
    assert.equal(P.emptied(one, empty), true);
    assert.equal(P.emptied(full, empty), true);
    assert.equal(P.emptied(empty, empty), false, 'already empty: nothing new');
    assert.equal(P.emptied(full, one), false, 'a peer left, one stays: R5 and the strip, no re-ask');
    assert.equal(P.emptied(empty, one), false, 'filling is R4\'s');
    assert.equal(P.emptied(null, empty), false, 'nothing before the first answer');
    assert.equal(P.emptied(one, null), false, 'a failed poll says nothing');
  });

  test('a rotation swap or another admin\'s Add only changes the strip', () => {
    const before = peersAnswer({ canAdd: true });
    // rotation: Attic Tapes in, Kitchen Radio out; another admin's Lighthouse landed
    const swapped = peersAnswer({ canAdd: true, shelf: [...SHELF.filter((e) => e.endpointId !== KITCHEN), held(ATTIC, 'Attic Tapes'), held(LIGHTHOUSE, 'Lighthouse Tapes')],
      catalog: [...CATALOG, cat(ATTIC, 'Attic Tapes')] });
    assert.deepEqual(P.landed(before, swapped, [], false), { reask: false, ids: [], failed: [] });
    assert.deepEqual(P.landed(before, swapped, [STATIC], true), { reask: false, ids: [], failed: [] });
    assert.deepEqual(P.landed(before, null, [LIGHTHOUSE], true), { reask: false, ids: [], failed: [] }, 'a failed poll says nothing');
  });
});

// ── preview ────────────────────────────────────────────────────────────

describe('previewProvider and retryDelayMs (§2 item 12, §5.5)', () => {
  const on = { enabled: true };
  const listing = (names) => plugins.listPlugins({ config: Object.fromEntries(names.map((n) => [n, on])) });

  test('the first previewing plug-in in the listing\'s order, and only it', () => {
    const both = listing(['links', 'deezer', 'itunes', 'federation-copy']);
    assert.deepEqual(both.map((p) => p.name), ['links', 'deezer', 'itunes', 'federation-copy']);
    assert.equal(P.previewProvider(both), both[1], 'the listing entry itself');
    assert.equal(P.previewProvider(listing(['links', 'itunes'])).name, 'itunes');
    assert.equal(P.previewProvider(listing(['links', 'federation-copy'])), null);
    assert.equal(P.previewProvider([]), null);
    // listing order, not a preference: itunes listed first previews alone
    const swapped = [both[2], both[1]];
    assert.equal(P.previewProvider(swapped).name, 'itunes');
    assert.equal(P.previewProvider.length, 1, 'it takes the listing alone: no lead, no "next provider"');
  });

  test('odd listings', () => {
    for (const bad of [null, undefined, {}, 'deezer', [null, 'deezer', { capabilities: ['preview'] }, { name: '  ', capabilities: ['preview'] }, { name: 'x', capabilities: 'preview' }]]) {
      assert.equal(P.previewProvider(bad), null, JSON.stringify(bad));
    }
  });

  test('a 429 waits 5 s (deezer, any other) or 60 s (itunes) before its one retry', () => {
    assert.deepEqual(['deezer', 'itunes', 'links', 'some-new-one', '', null, undefined, '__proto__', 'constructor'].map(P.retryDelayMs),
      [5000, 60000, 5000, 5000, 5000, 5000, 5000, 5000, 5000]);
  });
});

describe('artMatches: when a preview\'s artwork stands in for the lead\'s tile (§2 item 10)', () => {
  const preview = (over) => ({
    provider: 'deezer', url: 'https://cdns-preview.example/x.mp3', seconds: 30, title: 'Signal Fires', artist: 'Paper Lantern', album: 'Night Ferry',
    link: 'https://www.deezer.com/track/1', artwork: 'https://e-cdns-images.example/cover/250x250.jpg', attribution: 'Preview from Deezer', match: 1, ...over,
  });

  test('the lead\'s own album and artist, nameKey-folded — so it spreads to every lead with the same tile key', () => {
    assert.equal(P.artMatches(SIGNAL, preview()), true);
    assert.equal(HARBOR.tile.key, SIGNAL.tile.key, 'the server gave both one tile key');
    assert.equal(P.artMatches(HARBOR, preview()), true, 'and the same preview matches the other spelling');
    assert.equal(P.artMatches(SIGNAL, preview({ artist: '  PAPER  LANTERN', album: 'night ferry' })), true);
    assert.equal(P.artMatches(SIGNAL, preview({ album: 'Night Ferry – Live' })), false, 'another album');
    assert.equal(P.artMatches(SIGNAL, preview({ album: 'Night Ferry (Deluxe)' })), false);
    assert.equal(P.artMatches(SIGNAL, preview({ artist: 'Paper Lanterns' })), false, 'another artist');
    assert.equal(P.artMatches(SIGNAL, preview({ artist: null })), false);
    assert.equal(P.artMatches(LONG, preview()), false, 'another lead');
    // a view row (discovery-page.js networkRows keeps the lead as raw) reads the same
    assert.equal(P.artMatches({ raw: SIGNAL, title: 'x' }, preview()), true);
  });

  test('a lead without an album never earns art, even from an album-less preview', () => {
    assert.equal(COPPER.album, null);
    assert.equal(P.artMatches(COPPER, preview({ artist: 'Kestrel & Vine', album: null })), false);
    assert.equal(P.artMatches(COPPER, preview({ artist: 'Kestrel & Vine', album: '' })), false);
    assert.equal(P.artMatches({ ...SIGNAL, album: '   ' }, preview({ album: '   ' })), false);
  });

  test('https artwork only', () => {
    for (const artwork of [null, '', 'http://e-cdns-images.example/cover.jpg', '//e-cdns-images.example/cover.jpg', 'javascript:alert(1)',
      'data:image/png;base64,AAAA', 'cover.jpg', 'https//nope', 42]) {
      assert.equal(P.artMatches(SIGNAL, preview({ artwork })), false, JSON.stringify(artwork));
    }
    assert.equal(P.artMatches(SIGNAL, preview({ artwork: 'HTTPS://E-CDNS-IMAGES.EXAMPLE/cover.jpg' })), true);
    assert.equal(P.artMatches(SIGNAL, null), false);
    assert.equal(P.artMatches(null, preview()), false);
  });
});

describe('leadKey (§5.3)', () => {
  test('the peer\'s endpointId and the snapshot\'s exportId', () => {
    assert.equal(P.leadKey(SIGNAL), `${KITCHEN}\u0000x1`);
    assert.equal(P.leadKey(HARBOR), `${BASEMENT}\u0000x2`);
    assert.equal(P.leadKey({ raw: SIGNAL }), P.leadKey(SIGNAL), 'a view row reads its raw lead');
    assert.notEqual(P.leadKey(SIGNAL), P.leadKey({ ...SIGNAL, peer: { ...SIGNAL.peer, endpointId: BASEMENT } }), 'the same export on another peer');
  });

  test('without an exportId: the folded artist, title and album', () => {
    const noId = { ...SIGNAL, exportId: null };
    assert.equal(P.leadKey(noId), `${KITCHEN}\u0000paper lantern|signal fires|night ferry`);
    assert.equal(P.leadKey({ ...noId, artist: '  PAPER   Lantern', exportId: '' }), P.leadKey(noId));
    assert.equal(P.leadKey({ ...COPPER, exportId: undefined }), `${KITCHEN}\u0000kestrel & vine|copper dawn|`);
    assert.equal(P.leadKey({ title: 'Loose', exportId: null }), '\u0000|loose|', 'no peer');
    assert.equal(P.leadKey(null), '');
  });
});

describe('nextIndex: Preview all\'s next lead', () => {
  test('the next row whose lead is not in the visit\'s "No preview" set; -1 after the last', () => {
    const rows = LEADS.map((raw) => ({ raw }));
    assert.equal(P.nextIndex(rows, -1, new Set()), 0, 'from the top');
    assert.equal(P.nextIndex(rows, 0, new Set()), 1);
    const none = new Set([P.leadKey(HARBOR), P.leadKey(LONG)]);
    assert.equal(P.nextIndex(rows, 0, none), 3, 'skips the leads with no preview');
    assert.equal(P.nextIndex(rows, -1, new Set([P.leadKey(SIGNAL)])), 1);
    assert.equal(P.nextIndex(rows, 5, none), -1, 'the end');
    assert.equal(P.nextIndex(rows, 3, [P.leadKey(UNTITLED), P.leadKey(COPPER)]), -1, 'an array of keys, every rest skipped');
    assert.equal(P.nextIndex(rows, 3, { [P.leadKey(UNTITLED)]: true }), 5, 'an object of keys');
    assert.equal(P.nextIndex(LEADS, 1, null), 2, 'raw leads, nothing skipped');
    assert.equal(P.nextIndex([], -1, null), -1);
    assert.equal(P.nextIndex([null, 'x', SIGNAL], undefined, null), 2, 'only leads are played');
  });
});

describe('copyText / copyListText (§5.7)', () => {
  test('"Artist - Title", or the title alone when there is no artist', () => {
    assert.equal(P.copyText(SIGNAL), 'Paper Lantern - Signal Fires');
    assert.equal(P.copyText(HARBOR), 'PAPER   lantern - Harbor Lights', 'the artist as sent, trimmed');
    assert.equal(P.copyText(UNTITLED), 'Untitled Lead', 'no leading "- "');
    assert.equal(P.copyText({ artist: '  ', title: 'Only Title' }), 'Only Title');
    assert.equal(P.copyText({ artist: 'Only Artist', title: '' }), 'Only Artist');
    assert.equal(P.copyText({ raw: SIGNAL }), 'Paper Lantern - Signal Fires');
    assert.equal(P.copyText(null), '');
  });

  test('the tab\'s leads in list order, joined by \\n, no trailing newline', () => {
    const text = P.copyListText(LEADS.map((raw) => ({ raw })));
    assert.equal(text, [
      'Paper Lantern - Signal Fires',
      'PAPER   lantern - Harbor Lights',
      'Marlowe Fields - Long Exposure',
      'Juniper Static - Arcade Rain',
      'Untitled Lead',
      'Kestrel & Vine - Copper Dawn',
    ].join('\n'));
    assert.equal(text.endsWith('\n'), false);
    assert.equal(P.copyListText([ARCADE]), 'Juniper Static - Arcade Rain');
    assert.equal(P.copyListText([]), '');
    assert.equal(P.copyListText(null), '');
  });
});

describe('peerLine: the window\'s "● label" line', () => {
  test('the stamped label, verbatim; the dot only when that endpointId is online in the last peers answer', () => {
    const answer = peersAnswer();
    assert.deepEqual(P.peerLine(LONG, answer), { endpointId: KITCHEN, label: 'Kitchen Radio', online: true });
    assert.deepEqual(P.peerLine(ARCADE, answer), { endpointId: MSTREAM, label: 'mStream · 3f9a', online: false }, 'offline: no dot');
    assert.deepEqual(P.peerLine({ raw: LONG }, answer), P.peerLine(LONG, answer), 'a view row');
    assert.deepEqual(P.peerLine(LONG, null), { endpointId: KITCHEN, label: 'Kitchen Radio', online: false }, 'no peers answer yet');
    // the lead's peer left the shelf since: its label stays, the dot goes
    const gone = peersAnswer({ shelf: SHELF.filter((e) => e.endpointId !== KITCHEN) });
    assert.deepEqual(P.peerLine(LONG, gone), { endpointId: KITCHEN, label: 'Kitchen Radio', online: false });
  });

  test('a lead stamped with no label reads the strip\'s, then the peer\'s name; nothing to name → null', () => {
    const answer = peersAnswer();
    assert.deepEqual(P.peerLine({ ...ARCADE, peer: { endpointId: MSTREAM, name: null, label: '' } }, answer),
      { endpointId: MSTREAM, label: 'mStream · 3f9a', online: false });
    assert.deepEqual(P.peerLine({ ...LONG, peer: { endpointId: id('0d0d'), name: ' Far Away ' } }, answer),
      { endpointId: id('0d0d'), label: 'Far Away', online: false });
    assert.equal(P.peerLine({ ...LONG, peer: { endpointId: id('0d0d'), name: null, label: '  ' } }, answer), null);
    assert.equal(P.peerLine({ ...LONG, peer: null }, answer), null);
    assert.equal(P.peerLine(null, answer), null);
  });
});

describe('every key the strip emits has an English value', () => {
  const EN = require('../../webapp/locales/en.json');
  const placeholders = (s) => [...String(s).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);

  test('All, every Add state\'s text and aria-label: present, placeholders filled', () => {
    const states = { [STATIC]: { state: 'adding', code: null, at: NOW }, [ROOFTOP]: failed('offline'), [LIGHTHOUSE]: failed('no-room') };
    const strip = P.stripItems(peersAnswer({ canAdd: true, catalog: [...CATALOG, cat(ATTIC, 'Attic Tapes')], states }), {});
    const labels = strip.items.flatMap((item) => [item.text, item.aria]).filter(Boolean);
    assert.deepEqual([...new Set(labels.map((l) => l.key))].sort(), [
      'peerRecs.a11y.add', 'peerRecs.a11y.adding', 'peerRecs.a11y.failed', 'peerRecs.a11y.noRoom',
      'peerRecs.adding', 'peerRecs.all', 'peerRecs.noRoom', 'peerRecs.tryAgain',
    ]);
    for (const { key, params } of labels) {
      assert.equal(typeof EN[key], 'string', `${key} missing from en.json`);
      for (const name of placeholders(EN[key])) { assert.ok(name in params, `${key}: {{${name}}} has no param`); }
    }
  });
});
