/**
 * Unit tests for the pure Peer Recommendations views
 * (src/state/discovery-peer-view.js). No server, no sidecar, no config
 * singleton — the shelf, the catalog and every lookup are handcrafted:
 *
 *   - leadTile and peerMonogram against every vector in
 *     test/fixtures/peer-recs-tiles.json (plan §5.1-5.2), the vectors the
 *     three clients are held to
 *   - peerHue straight from the endpoint id
 *   - the label rule: the default name, no name, case and NFKC twins
 *     across the whole universe (catalog ∪ shelf, minus blocked), and
 *     widening to 6 hex when a suffixed label still collides
 *   - buildPeerView: member vs admin rows, blocked and incompatible peers
 *     hidden, the online window, the Add state's wire shape, the order, the
 *     cap of 24, and an Add state never reordering a row
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPeerView,
  fnv1a32,
  leadTile,
  MAX_ADDABLE_ROWS,
  peerHue,
  peerLabels,
  peerMonogram,
} from '../../src/state/discovery-peer-view.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const vectors = JSON.parse(fs.readFileSync(
  path.join(repoRoot, 'test', 'fixtures', 'peer-recs-tiles.json'), 'utf8'));

const NOW = Date.parse('2026-10-27T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
// Endpoint ids are 64 hex; the head picks the label suffix and the hue.
const id = (head) => head.padEnd(64, '0');
const MODEL = 'model-x';

// A shelf (peer-dbs registry) entry.
function held(head, { name = '', modelId = MODEL, rowCount = 100, pinned = false } = {}) {
  return {
    endpointId: id(head),
    hash: `hash-${head}`,
    modelId,
    rowCount,
    sizeBytes: 1000,
    name,
    pinned,
    fetchedAt: iso(DAY),
    firstFetchedAt: iso(10 * DAY),
  };
}

// A catalog entry. `silentMs` controls online-ness (the window is 90 s).
function cat(head, { name, silentMs = 0, rowCount = 100, modelId = MODEL } = {}) {
  return {
    from: id(head),
    updatedAt: iso(silentMs),
    payload: { name, hash: `hash-${head}`, rowCount, modelId, size: 1000 },
  };
}

// Server A of the integration suite in miniature. Held: Kitchen Radio
// (online), mStream (offline), Quartz (another model), Old Tapes (offline
// the longest) and a blocked one. Unheld: Kitchen Radio's twin (online),
// Lighthouse Tapes (online), Rooftop FM (offline), Elsewhere (another
// model), and the blocked one again.
const K = id('aaaa01');
const M = id('3f9a00');
const Q = id('cccc01');
const OLD = id('dddd01');
const K2 = id('abab01');
const LIGHTHOUSE = id('eeee01');
const ROOFTOP = id('ffff01');
const ELSEWHERE = id('9999aa');
const BLOCKED = id('bad000');

function world(overrides = {}) {
  return {
    shelf: [
      held('aaaa01', { name: 'Kitchen Radio', rowCount: 500 }),
      held('3f9a00', { name: 'mStream', rowCount: 300 }),
      held('cccc01', { name: 'Quartz', modelId: 'model-y' }),
      held('dddd01', { name: 'Old Tapes', pinned: true }),
      held('bad000', { name: 'Spam' }),
    ],
    catalog: [
      cat('aaaa01', { name: 'Kitchen Radio' }),
      cat('3f9a00', { name: 'mStream', silentMs: 2 * DAY }),
      cat('cccc01', { name: 'Quartz', modelId: 'model-y' }),
      cat('dddd01', { name: 'Old Tapes', silentMs: 30 * DAY }),
      cat('abab01', { name: 'Kitchen Radio' }),
      cat('eeee01', { name: 'Lighthouse Tapes', rowCount: 900 }),
      cat('ffff01', { name: 'Rooftop FM', silentMs: 2 * DAY }),
      cat('9999aa', { name: 'Elsewhere', modelId: 'model-y' }),
      cat('bad000', { name: 'Spam' }),
    ],
    localModel: MODEL,
    now: NOW,
    isBlocked: (endpointId) => endpointId === BLOCKED,
    ...overrides,
  };
}

const ids = (view) => view.peers.map((row) => row.endpointId);

describe('leadTile — the §5.1 vectors', () => {
  test('every fixture tile vector', () => {
    assert.equal(vectors.tiles.length, 23);
    for (const v of vectors.tiles) {
      const label = JSON.stringify([v.artist, v.album, v.title]);
      assert.deepEqual(leadTile({ artist: v.artist, album: v.album, title: v.title }),
        { key: v.key, hue: v.hue, letter: v.letter }, label);
      assert.equal(fnv1a32(v.key).toString(16).padStart(8, '0'), v.fnv1a32, label);
      assert.equal(parseInt(v.fnv1a32, 16) % 360, v.hue, `${label}: the fixture's own hue`);
    }
  });

  test('the fixture keeps an absent field and an empty one apart', () => {
    assert.ok(vectors.tiles.some((v) => v.album === null));
    assert.ok(vectors.tiles.some((v) => v.album === ''));
    assert.ok(vectors.tiles.some((v) => v.letter === ''));
  });

  test('absent fields read as empty', () => {
    assert.deepEqual(leadTile({ title: 'Untitled Lead' }), { key: 'untitled lead', hue: 318, letter: 'U' });
    assert.deepEqual(leadTile({}), { key: '', hue: 61, letter: '' });
    assert.deepEqual(leadTile(), { key: '', hue: 61, letter: '' });
  });

  test('every lead of one album shares the key, whatever its title', () => {
    const a = leadTile({ artist: 'Paper Lantern', album: 'Night Ferry', title: 'Signal Fires' });
    const b = leadTile({ artist: 'paper lantern', album: 'Night Ferry', title: 'Harbor Lights' });
    assert.equal(a.key, b.key);
    assert.equal(a.hue, b.hue);
  });

  test('an artist with no letter or number keeps its key; the letter comes from the title', () => {
    assert.deepEqual(leadTile({ artist: '⚡', album: 'Storm', title: 'night drive' }),
      { key: '⚡|storm', hue: fnv1a32('⚡|storm') % 360, letter: 'N' });
  });
});

describe('peerMonogram — the §5.2 vectors', () => {
  test('every fixture monogram vector', () => {
    assert.equal(vectors.monograms.length, 16);
    for (const v of vectors.monograms) {
      assert.equal(peerMonogram(v.label), v.monogram, JSON.stringify(v.label));
    }
  });

  test('only a hex id suffix is stripped', () => {
    assert.equal(peerMonogram('mStream · 3f9a2c'), 'mS');
    // Not an id: '·' is punctuation (dropped), 'zzzz' a second word.
    assert.equal(peerMonogram('Radio · zzzz'), 'RZ');
  });

  test('a label with nothing left is the default name', () => {
    assert.equal(peerMonogram(''), 'mS');
    assert.equal(peerMonogram(' · 3f9a'), 'mS');
    assert.equal(peerMonogram(undefined), 'mS');
  });
});

describe('peerHue', () => {
  test('the first 6 hex of the id, mod 360', () => {
    assert.equal(peerHue(id('000000')), 0);
    assert.equal(peerHue(id('000167')), 359);
    assert.equal(peerHue(id('000168')), 0);
    assert.equal(peerHue(id('3f9a2c')), 0x3f9a2c % 360);
    assert.equal(peerHue('f'.repeat(64)), 135);
  });

  test('upper-case hex gives the same hue', () => {
    assert.equal(peerHue(id('3F9A2C')), peerHue(id('3f9a2c')));
  });
});

describe('peerLabels — the §3.2 label rule', () => {
  const labelsOf = (catalog, extra = {}) => peerLabels({ catalog, ...extra });

  test('a unique name is its own label, trimmed', () => {
    const labels = labelsOf([cat('aaaa01', { name: '  Basement Hi-Fi ' }), cat('bbbb01', { name: 'Static Garden' })]);
    assert.equal(labels.get(id('aaaa01')), 'Basement Hi-Fi');
    assert.equal(labels.get(id('bbbb01')), 'Static Garden');
  });

  test('the default name always carries 4 hex, in any case', () => {
    assert.equal(labelsOf([cat('3f9a00', { name: 'mStream' })]).get(id('3f9a00')), 'mStream · 3f9a');
    assert.equal(labelsOf([cat('3f9a00', { name: 'MSTREAM ' })]).get(id('3f9a00')), 'MSTREAM · 3f9a');
  });

  test('a peer with no name is mStream plus its id', () => {
    const labels = peerLabels({
      catalog: [cat('aaaa01', { name: '' }), cat('bbbb01', {})],
      shelf: [held('cccc01', { name: '   ' })],
    });
    assert.equal(labels.get(id('aaaa01')), 'mStream · aaaa');
    assert.equal(labels.get(id('bbbb01')), 'mStream · bbbb');
    assert.equal(labels.get(id('cccc01')), 'mStream · cccc');
  });

  test('twins differing only in case are both suffixed, each keeping its spelling', () => {
    const labels = labelsOf([cat('aaaa01', { name: 'Kitchen Radio' }), cat('bbbb01', { name: 'kitchen radio' })]);
    assert.equal(labels.get(id('aaaa01')), 'Kitchen Radio · aaaa');
    assert.equal(labels.get(id('bbbb01')), 'kitchen radio · bbbb');
  });

  test('NFKC twins are both suffixed (fullwidth forms, decomposed accents)', () => {
    const wide = labelsOf([cat('aaaa01', { name: 'Kitchen Radio' }), cat('bbbb01', { name: 'Ｋｉｔｃｈｅｎ Radio' })]);
    assert.equal(wide.get(id('aaaa01')), 'Kitchen Radio · aaaa');
    assert.equal(wide.get(id('bbbb01')), 'Ｋｉｔｃｈｅｎ Radio · bbbb');
    const accent = labelsOf([cat('aaaa01', { name: 'Café' }), cat('bbbb01', { name: 'Café' })]);
    assert.equal(accent.get(id('aaaa01')), 'Café · aaaa');
    assert.equal(accent.get(id('bbbb01')), 'Café · bbbb');
  });

  test('a diacritic is not a case or NFKC difference: no twins', () => {
    const labels = labelsOf([cat('aaaa01', { name: 'Cafe' }), cat('bbbb01', { name: 'Café' })]);
    assert.equal(labels.get(id('aaaa01')), 'Cafe');
    assert.equal(labels.get(id('bbbb01')), 'Café');
  });

  test('suffixed labels that still collide widen to 6 hex; the rest stay at 4', () => {
    const labels = labelsOf([
      cat('3f9a2c', { name: 'mStream' }),
      cat('3f9a77', { name: 'mStream' }),
      cat('1a2b00', { name: 'mStream' }),
    ]);
    assert.equal(labels.get(id('3f9a2c')), 'mStream · 3f9a2c');
    assert.equal(labels.get(id('3f9a77')), 'mStream · 3f9a77');
    assert.equal(labels.get(id('1a2b00')), 'mStream · 1a2b');
  });

  test('a name spelled like a suffixed label widens the suffixed one', () => {
    const labels = labelsOf([
      cat('1a2b00', { name: 'Kitchen Radio' }),
      cat('9999aa', { name: 'Kitchen Radio' }),
      cat('5555aa', { name: 'Kitchen Radio · 1a2b' }),
    ]);
    assert.equal(labels.get(id('1a2b00')), 'Kitchen Radio · 1a2b00');
    assert.equal(labels.get(id('9999aa')), 'Kitchen Radio · 9999');
    assert.equal(labels.get(id('5555aa')), 'Kitchen Radio · 1a2b');
  });

  test('the universe is catalog ∪ shelf: an unheld twin suffixes a shelf peer', () => {
    const labels = peerLabels({
      shelf: [held('aaaa01', { name: 'Kitchen Radio' })],
      catalog: [cat('abab01', { name: 'Kitchen Radio' })],
    });
    assert.equal(labels.get(id('aaaa01')), 'Kitchen Radio · aaaa');
    assert.equal(labels.get(id('abab01')), 'Kitchen Radio · abab');
  });

  test('blocked peers get no label and make no twins', () => {
    const labels = peerLabels({
      shelf: [held('aaaa01', { name: 'Kitchen Radio' }), held('bad000', { name: 'Kitchen Radio' })],
      catalog: [cat('bad001', { name: 'Kitchen Radio' })],
      isBlocked: (endpointId) => endpointId.startsWith('bad'),
    });
    assert.equal(labels.get(id('aaaa01')), 'Kitchen Radio');
    assert.equal(labels.has(id('bad000')), false);
    assert.equal(labels.has(id('bad001')), false);
  });

  test('the latest announced name wins; the fetched name fills in', () => {
    const labels = peerLabels({
      shelf: [
        held('aaaa01', { name: 'Old Name' }),
        held('bbbb01', { name: 'Fetched Only' }),
        held('cccc01', { name: 'Fetched Name' }),
      ],
      catalog: [cat('aaaa01', { name: 'New Name' }), cat('cccc01', { name: '' })],
    });
    assert.equal(labels.get(id('aaaa01')), 'New Name');
    assert.equal(labels.get(id('bbbb01')), 'Fetched Only');
    assert.equal(labels.get(id('cccc01')), 'Fetched Name');
  });
});

describe('buildPeerView — rows', () => {
  test('a member sees the searchable shelf and nothing else', () => {
    const view = buildPeerView(world({
      canAdd: false,
      addStateOf: () => ({ state: 'adding', code: null, at: iso(0) }),
    }));
    assert.equal(view.canAdd, false);
    assert.deepEqual(view.shelf, { held: 4, searchable: 3, running: false });
    assert.deepEqual(ids(view), [K, M, OLD]);
    assert.ok(view.peers.every((row) => row.onShelf === true && row.add === null));
  });

  test('an admin also gets the addable peers', () => {
    const view = buildPeerView(world({ canAdd: true, running: true }));
    assert.equal(view.canAdd, true);
    assert.deepEqual(view.shelf, { held: 4, searchable: 3, running: true });
    // Rooftop is offline with no Add state; Elsewhere is another model.
    assert.deepEqual(ids(view), [K, M, OLD, LIGHTHOUSE, K2]);
    assert.deepEqual(view.peers.slice(3).map((row) => row.onShelf), [false, false]);
  });

  test('the row shape', () => {
    const view = buildPeerView(world({ canAdd: true }));
    const row = view.peers[0];
    assert.deepEqual(Object.keys(row), [
      'endpointId', 'name', 'label', 'monogram', 'hue', 'online', 'onShelf', 'pinned', 'rowCount', 'add',
    ]);
    assert.deepEqual(row, {
      endpointId: K,
      name: 'Kitchen Radio',
      label: 'Kitchen Radio · aaaa',
      monogram: 'KR',
      hue: peerHue(K),
      online: true,
      onShelf: true,
      pinned: false,
      rowCount: 500,
      add: null,
    });
    const m = view.peers.find((r) => r.endpointId === M);
    assert.equal(m.label, 'mStream · 3f9a');
    assert.equal(m.monogram, 'mS');
    assert.equal(m.online, false);
    assert.equal(view.peers.find((r) => r.endpointId === OLD).pinned, true);
  });

  test('blocked and incompatible peers are hidden from everyone; held still counts the incompatible one', () => {
    for (const canAdd of [false, true]) {
      const view = buildPeerView(world({ canAdd }));
      for (const hidden of [Q, ELSEWHERE, BLOCKED]) {
        assert.equal(ids(view).includes(hidden), false, `${hidden.slice(0, 6)} (canAdd ${canAdd})`);
      }
      assert.equal(view.shelf.held, 4);
    }
  });

  test('no local model is no compatibility signal: every model passes', () => {
    const view = buildPeerView(world({ canAdd: true, localModel: null }));
    assert.ok(ids(view).includes(Q));
    assert.ok(ids(view).includes(ELSEWHERE));
    assert.deepEqual(view.shelf, { held: 4, searchable: 4, running: false });
  });

  test('a held peer is one shelf row, never also addable', () => {
    const view = buildPeerView(world({ canAdd: true }));
    assert.equal(new Set(ids(view)).size, view.peers.length);
  });

  test('labels are peerLabels over the same universe, so strip and leads agree', () => {
    const inputs = world();
    const labels = peerLabels(inputs);
    for (const canAdd of [false, true]) {
      for (const row of buildPeerView({ ...inputs, canAdd }).peers) {
        assert.equal(row.label, labels.get(row.endpointId));
      }
    }
    // A member is never shown K2, yet its twin still suffixes K's label.
    assert.equal(buildPeerView(inputs).peers[0].label, 'Kitchen Radio · aaaa');
  });

  test('names: latest announced, else fetched; rowCount: registry on the shelf, announcement otherwise', () => {
    const view = buildPeerView({
      shelf: [held('aaaa01', { name: 'Fetched', rowCount: 10 }), held('bbbb01', { name: 'Shelf Only', rowCount: 20 })],
      catalog: [cat('aaaa01', { name: 'Announced', rowCount: 99 }), cat('cccc01', { rowCount: 30 })],
      localModel: MODEL,
      now: NOW,
      canAdd: true,
    });
    const byId = new Map(view.peers.map((row) => [row.endpointId, row]));
    assert.equal(byId.get(id('aaaa01')).name, 'Announced');
    assert.equal(byId.get(id('aaaa01')).rowCount, 10);
    assert.equal(byId.get(id('bbbb01')).name, 'Shelf Only');
    assert.equal(byId.get(id('bbbb01')).online, false, 'not in the catalog = not heard');
    assert.equal(byId.get(id('cccc01')).name, '');
    assert.equal(byId.get(id('cccc01')).label, 'mStream · cccc');
    assert.equal(byId.get(id('cccc01')).rowCount, 30);
  });
});

describe('buildPeerView — online', () => {
  test('online = heard within the window, which the caller sets', () => {
    const narrow = buildPeerView(world());
    assert.equal(narrow.peers.find((row) => row.endpointId === M).online, false);
    const wide = buildPeerView(world({ onlineWindowMs: 3 * DAY }));
    assert.equal(wide.peers.find((row) => row.endpointId === M).online, true);
    assert.equal(wide.peers.find((row) => row.endpointId === OLD).online, false);
  });

  test('the edge of the window is offline', () => {
    const view = buildPeerView({
      shelf: [held('aaaa01')],
      catalog: [cat('aaaa01', { silentMs: 90 * 1000 })],
      now: NOW,
    });
    assert.equal(view.peers[0].online, false);
  });

  test('an unparseable announcement time is offline', () => {
    const entry = cat('aaaa01');
    entry.updatedAt = 'garbage';
    const view = buildPeerView({ shelf: [held('aaaa01')], catalog: [entry], now: NOW });
    assert.equal(view.peers[0].online, false);
  });

  test('an admin sees an online addable peer; offline ones only with an Add state', () => {
    const plain = buildPeerView(world({ canAdd: true }));
    assert.equal(ids(plain).includes(ROOFTOP), false);
    const failed = buildPeerView(world({
      canAdd: true,
      addStateOf: (endpointId) => (endpointId === ROOFTOP ? { state: 'failed', code: 'offline', at: iso(0) } : null),
    }));
    const row = failed.peers.find((r) => r.endpointId === ROOFTOP);
    assert.equal(row.online, false);
    assert.deepEqual(row.add, { state: 'failed', code: 'offline', at: iso(0) });
  });
});

describe('buildPeerView — Add states', () => {
  test('the wire shape: no bookkeeping, `at` always ISO, code null when absent', () => {
    const view = buildPeerView(world({
      canAdd: true,
      addStateOf: (endpointId) => {
        if (endpointId === LIGHTHOUSE) { return { state: 'adding', at: NOW, by: 'admin' }; }
        if (endpointId === K) { return { state: 'done', code: null, at: iso(1000), by: 'admin' }; }
        return null;
      },
    }));
    const byId = new Map(view.peers.map((row) => [row.endpointId, row]));
    assert.deepEqual(byId.get(LIGHTHOUSE).add, { state: 'adding', code: null, at: iso(0) });
    assert.deepEqual(byId.get(K).add, { state: 'done', code: null, at: iso(1000) });
    assert.equal(byId.get(K2).add, null);
  });

  test('a member never sees an Add state, and the lookup is never asked', () => {
    let asked = 0;
    const view = buildPeerView(world({
      canAdd: false,
      addStateOf: () => { asked++; return { state: 'failed', code: 'no-room', at: iso(0) }; },
    }));
    assert.ok(view.peers.every((row) => row.add === null));
    assert.equal(asked, 0);
  });

  test('each peer\'s state is read once per build', () => {
    const asked = new Map();
    buildPeerView(world({
      canAdd: true,
      addStateOf: (endpointId) => { asked.set(endpointId, (asked.get(endpointId) || 0) + 1); return null; },
    }));
    assert.ok([...asked.values()].every((n) => n === 1));
  });
});

describe('buildPeerView — order', () => {
  test('shelf rows: online first, then label by base letters, then id', () => {
    const view = buildPeerView({
      shelf: [
        held('aaaa01', { name: 'beta' }),
        held('bbbb01', { name: 'Zed' }),
        held('cccc02', { name: 'Café' }),
        held('cccc01', { name: 'Cafe' }),
        held('dddd01', { name: 'Alpha' }),
      ],
      catalog: [cat('bbbb01', { name: 'Zed' })],
      now: NOW,
    });
    // 'Cafe' and 'Café' are not twins, but compare equal at base strength.
    assert.deepEqual(view.peers.map((row) => row.label), ['Zed', 'Alpha', 'beta', 'Cafe', 'Café']);
    assert.deepEqual(ids(view).slice(3), [id('cccc01'), id('cccc02')]);
  });

  test('addable rows: seeders, then library size, then id', () => {
    const seeders = { 'hash-aaaa01': 1, 'hash-bbbb01': 3, 'hash-cccc01': 1, 'hash-dddd01': 1 };
    const view = buildPeerView({
      catalog: [
        cat('aaaa01', { name: 'A', rowCount: 50 }),
        cat('bbbb01', { name: 'B', rowCount: 10 }),
        cat('cccc01', { name: 'C', rowCount: 50 }),
        cat('dddd01', { name: 'D', rowCount: 80 }),
      ],
      now: NOW,
      canAdd: true,
      seederCountOf: (hash) => seeders[hash] || 0,
    });
    assert.deepEqual(ids(view), [id('bbbb01'), id('dddd01'), id('aaaa01'), id('cccc01')]);
  });

  test('shelf rows always come before addable rows', () => {
    const view = buildPeerView(world({ canAdd: true, seederCountOf: () => 9 }));
    assert.deepEqual(view.peers.map((row) => row.onShelf), [true, true, true, false, false]);
  });
});

describe('buildPeerView — the cap of 24', () => {
  // 30 online unheld peers; peer i has a library of i rows, so the order is
  // peer 29 first, peer 0 last.
  const heads = Array.from({ length: 30 }, (_, i) => `c${String(i).padStart(3, '0')}`);
  const crowd = (overrides = {}) => ({
    catalog: heads.map((head, i) => cat(head, { name: `Peer ${i}`, rowCount: i })),
    now: NOW,
    canAdd: true,
    ...overrides,
  });
  const byOrder = heads.map((head) => id(head)).reverse();

  test('at most 24 addable rows, the most useful ones', () => {
    assert.equal(MAX_ADDABLE_ROWS, 24);
    const view = buildPeerView(crowd());
    assert.deepEqual(ids(view), byOrder.slice(0, 24));
  });

  test('shelf rows do not count against the cap', () => {
    const view = buildPeerView(crowd({ shelf: [held('aaaa01'), held('bbbb01')] }));
    assert.equal(view.peers.filter((row) => row.onShelf).length, 2);
    assert.equal(view.peers.filter((row) => !row.onShelf).length, 24);
  });

  test('an Add state never reorders a row', () => {
    const before = ids(buildPeerView(crowd()));
    const states = new Map([
      [byOrder[0], { state: 'adding', code: null, at: iso(0) }],
      [byOrder[7], { state: 'failed', code: 'no-room', at: iso(0) }],
      [byOrder[23], { state: 'failed', code: 'offline', at: iso(0) }],
    ]);
    const after = buildPeerView(crowd({ addStateOf: (endpointId) => states.get(endpointId) || null }));
    assert.deepEqual(ids(after), before);
    const everyRow = buildPeerView(crowd({ addStateOf: () => ({ state: 'adding', code: null, at: iso(0) }) }));
    assert.deepEqual(ids(everyRow), before);
  });

  test('a row carrying an Add state is kept when the cap bites, in its own place', () => {
    const late = byOrder[27];
    const view = buildPeerView(crowd({
      addStateOf: (endpointId) => (endpointId === late ? { state: 'adding', code: null, at: iso(0) } : null),
    }));
    assert.equal(view.peers.length, 24);
    assert.deepEqual(ids(view), [...byOrder.slice(0, 23), late]);
  });
});
