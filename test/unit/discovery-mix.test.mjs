/**
 * Instant Mix's pure pieces (src/api/discovery-mix.js): the artist cap, the
 * band and the cap ladder, the quotas of a several-point item, the play
 * order's artist spread, the skip-word matcher, and the staged near-dup
 * test — plus the lock that keeps Auto DJ's song filters on both routes:
 * every SONG_FILTER_KEYS key, with its own schema, in random-songs' schema
 * and in the mix's (Joi describe()), so a filter added there reaches both.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Joi from 'joi';

import {
  mixCap, quotasFor, selectMix, orderMix, skipWordsMatcher, nearDupSet, mixSchema,
} from '../../src/api/discovery-mix.js';
import * as random from '../../src/api/random.js';
import { NEAR_DUP } from '../../src/db/discovery-novelty.js';

// Deterministic PRNG (mulberry32) so a failure reproduces.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const unit = (v) => {
  let n = 0;
  for (const x of v) { n += x * x; }
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
};
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; } return s; };

// An eligible row: what the walk hands selectMix.
let next = 0;
const row = (artistKey, similarity, extra = {}) => ({ id: next++, artistKey, similarity, seedIndex: 0, vec: null, ...extra });
const ids = (picks) => picks.map((p) => p.id);

describe('mixCap', () => {
  test('max(2, ceil(limit / 10))', () => {
    for (const [limit, cap] of [[1, 2], [10, 2], [20, 2], [21, 3], [50, 5], [51, 6], [200, 20]]) {
      assert.equal(mixCap(limit), cap, `limit ${limit}`);
    }
  });
});

describe('selectMix: one point', () => {
  test('the band first, under the cap', () => {
    const e = [row('a', 0.9), row('a', 0.89), row('a', 0.88), row('b', 0.87), row('c', 0.86)];
    const { picks, relaxed } = selectMix(e, { limit: 4 });
    assert.deepEqual(ids(picks), [e[0].id, e[1].id, e[3].id, e[4].id]);
    assert.equal(relaxed, false);
  });

  test('the cap gives inside the band before the list leaves it, and says so', () => {
    // The band: within 0.10 of the 4th song (0.87) — the four a's. b, at
    // 0.5, is no closer than the end of the list would allow.
    const e = [row('a', 0.9), row('a', 0.89), row('a', 0.88), row('a', 0.87), row('b', 0.5)];
    const { picks, relaxed } = selectMix(e, { limit: 4 });
    assert.deepEqual(ids(picks), ids(e.slice(0, 4)));
    assert.equal(relaxed, true);
  });

  test('the band is at most twice the limit', () => {
    // b is within 0.10 of the limit-th song, but seventh: past the band, so
    // the cap gives inside it first.
    const e = [...Array.from({ length: 6 }, (_, i) => row('a', 0.9 - i * 0.001)), row('b', 0.894)];
    const { picks, relaxed } = selectMix(e, { limit: 3 });
    assert.deepEqual(ids(picks), ids(e.slice(0, 3)));
    assert.equal(relaxed, true);
  });

  test('past the band at the first cap when near-duplicates empty it — not `relaxed`', () => {
    const v = unit([1, 0, 0, 0]);
    const twin = unit([1, 0.01, 0, 0]);   // cos 0.99995
    const e = [
      row('a', 0.9, { vec: v }), row('b', 0.89, { vec: twin }), row('c', 0.88, { vec: twin }),
      row('d', 0.5, { vec: unit([0, 1, 0, 0]) }), row('e', 0.49, { vec: unit([0, 0, 1, 0]) }),
    ];
    const { picks, relaxed } = selectMix(e, { limit: 3 });
    assert.deepEqual(ids(picks), [e[0].id, e[3].id, e[4].id]);
    assert.equal(relaxed, false);
  });

  test('every eligible song when there are fewer than the limit; a far one waits behind the band', () => {
    const e = [row('a', 0.9), row('a', 0.8), row('a', 0.7), row('b', 0.2)];
    const { picks, relaxed } = selectMix(e, { limit: 50 });
    assert.equal(picks.length, 4);
    assert.equal(relaxed, false, 'cap 5 holds all three a songs');
    const tight = selectMix(e, { limit: 3 });
    assert.deepEqual(ids(tight.picks), ids(e.slice(0, 3)), 'a third a at 0.7 beats b at 0.2');
    assert.equal(tight.relaxed, true);
  });

  test('the lead is the first pick and counts toward its artist', () => {
    const lead = row('a', 1, { lead: true });
    const e = [row('a', 0.9), row('a', 0.8), row('b', 0.7)];
    const { picks } = selectMix(e, { limit: 3, lead });
    assert.deepEqual(ids(picks), [lead.id, e[0].id, e[2].id]);
  });
});

describe('selectMix: several points', () => {
  test('each point takes its quota from the songs it ranked best for', () => {
    const e = [
      row('a', 0.9), row('b', 0.8), row('c', 0.7),
      row('d', 0.6, { seedIndex: 1 }), row('e', 0.5, { seedIndex: 1 }),
    ];
    const { picks } = selectMix(e, { limit: 3, weights: [2, 1] });
    assert.deepEqual(ids(picks), [e[0].id, e[1].id, e[3].id]);
    assert.deepEqual(ids(selectMix(e, { limit: 3 }).picks), ids(e.slice(0, 3)), 'one ranking alone');
  });

  test('a point short of its quota leaves the rest to the fill, from every song', () => {
    const e = [row('a', 0.9), row('b', 0.8), row('c', 0.7), row('d', 0.65), row('e', 0.6, { seedIndex: 1 })];
    const { picks } = selectMix(e, { limit: 4, weights: [1, 1] });
    assert.deepEqual(ids(picks), [e[0].id, e[1].id, e[4].id, e[2].id]);
  });

  test('the points share the artist counts, and a quota never relaxes the cap', () => {
    // Point 0 takes both a's. Point 1's a waits behind the cap: its quota
    // takes c, and the fill takes b, close enough to be in its band,
    // before it would give a a third song.
    const e = [row('a', 0.9), row('a', 0.89), row('a', 0.88, { seedIndex: 1 }), row('b', 0.85), row('c', 0.6, { seedIndex: 1 })];
    const { picks, relaxed } = selectMix(e, { limit: 4, weights: [1, 1] });
    assert.deepEqual(ids(picks), [e[0].id, e[1].id, e[4].id, e[3].id]);
    assert.equal(relaxed, false);
  });

  test('only the fill relaxes the cap, when nothing else is left', () => {
    const e = [row('a', 0.9), row('a', 0.89), row('a', 0.88, { seedIndex: 1 }), row('c', 0.6, { seedIndex: 1 })];
    const { picks, relaxed } = selectMix(e, { limit: 4, weights: [1, 1] });
    assert.deepEqual(ids(picks), [e[0].id, e[1].id, e[3].id, e[2].id]);
    assert.equal(relaxed, true);
  });

  test("an artist's points keep it inside the cap while other songs can fill", () => {
    // Three album points of one artist, each ranked first by its own two
    // songs: a ladder that relaxed inside each point's band gave the artist
    // all six.
    const e = [];
    for (const p of [0, 1, 2]) {
      e.push(row('me', 0.95 - p * 0.001, { seedIndex: p }), row('me', 0.94 - p * 0.001, { seedIndex: p }));
    }
    for (const p of [0, 1, 2]) {
      e.push(row(`peer${p}a`, 0.7 - p * 0.001, { seedIndex: p }), row(`peer${p}b`, 0.69 - p * 0.001, { seedIndex: p }));
    }
    e.sort((x, y) => y.similarity - x.similarity);
    const { picks, relaxed } = selectMix(e, { limit: 6, weights: [1, 1, 1] });
    assert.equal(picks.filter((x) => x.artistKey === 'me').length, 2, ids(picks).join(','));
    assert.equal(picks.length, 6);
    assert.equal(relaxed, false);
  });
});

describe('quotasFor', () => {
  test('round(limit × weight), settled to add up to the limit', () => {
    for (const [weights, limit, want] of [
      [[4, 2], 9, [6, 3]],
      [[1, 1], 5, [3, 2]],
      [[1, 1], 3, [2, 1]],
      [[1, 1, 1], 10, [4, 3, 3]],
      [[1, 1, 1, 1, 1, 1], 50, [9, 9, 8, 8, 8, 8]],
      [[0.5, 0.3, 0.2], 7, [4, 2, 1]],
      [[3, 2, 2, 2, 1, 1], 50, [14, 9, 9, 9, 5, 4]],
      [[5, 1], 1, [1, 0]],
    ]) {
      const q = quotasFor(weights, limit);
      assert.deepEqual(q, want, `${JSON.stringify(weights)} at ${limit}`);
      assert.equal(q.reduce((s, x) => s + x, 0), limit);
    }
  });
});

describe('orderMix', () => {
  test('the lead, then similarity in bands of ten, no artist twice in a row while the band allows', () => {
    const lead = row('a', 1, { lead: true });
    const p = [row('a', 0.95), row('a', 0.94), row('b', 0.9), row('c', 0.8), row('b', 0.7)];
    const out = orderMix([lead, ...p]);
    assert.deepEqual(ids(out), [lead.id, p[2].id, p[0].id, p[3].id, p[1].id, p[4].id]);
  });

  test('a band of one artist keeps its order, and no row jumps a band', () => {
    const p = [...Array.from({ length: 10 }, (_, i) => row('a', 0.9 - i * 0.01)), row('b', 0.5)];
    assert.deepEqual(ids(orderMix(p)), ids(p));
  });

  test('without a lead the closest song opens; an unknown artist is an artist', () => {
    const p = [row(null, 0.7), row(null, 0.9), row('b', 0.8)];
    assert.deepEqual(ids(orderMix(p)), [p[1].id, p[2].id, p[0].id]);
  });
});

describe('skipWordsMatcher', () => {
  const r = (o) => ({ title: 'Song', artist_name: 'Artist', album_name: 'Album', library_name: 'lib', filepath: 'Artist/Album/01 - Song.mp3', ...o });

  test('no words, or only blank ones, is no matcher', () => {
    assert.equal(skipWordsMatcher(undefined), null);
    assert.equal(skipWordsMatcher([]), null);
    assert.equal(skipWordsMatcher(['  ', '']), null);
  });

  test('repeated letters fold on both sides, case-insensitively', () => {
    const m = skipWordsMatcher(['acappella']);
    assert.equal(m(r({ title: 'Intro (Acapella)' })), true);
    assert.equal(skipWordsMatcher(['ACAPELLA'])(r({ title: 'acappella' })), true);
    assert.equal(skipWordsMatcher(['traxxx'])(r({ title: 'Trax' })), true);
    assert.equal(m(r()), false);
  });

  test('title, artist, album and the wire path all count; a blank word matches nothing', () => {
    const m = skipWordsMatcher(['bonus', '   ']);
    assert.equal(m(r({ filepath: 'Artist/Bonus Disc/01 - Song.mp3' })), true);
    assert.equal(m(r({ artist_name: 'Bonus Crew' })), true);
    assert.equal(m(r({ album_name: 'The Bonus' })), true);
    assert.equal(m(r()), false);
    assert.equal(skipWordsMatcher(['lib/artist'])(r()), true, '<library>/<path>');
    assert.equal(skipWordsMatcher(['x'])(r({ title: null, artist_name: null, album_name: null })), false);
  });
});

describe('nearDupSet', () => {
  test('agrees with a plain dot ≥ NEAR_DUP, at every width', () => {
    for (const [dim, seed] of [[4, 1], [16, 2], [1280, 3]]) {
      const rand = rng(seed);
      const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
      const base = Array.from({ length: 40 }, () => unit(Array.from({ length: dim }, gauss)));
      const set = nearDupSet();
      for (const v of base) { set.add(v); }
      // Probes around the line: copies nudged to land on either side of it.
      let near = 0;
      for (let k = 0; k < 400; k++) {
        const b = base[k % base.length];
        const noise = unit(Array.from({ length: dim }, gauss));
        const t = [0, 0.05, 0.13, 0.15, 0.2, 1][k % 6];
        const v = unit(Array.from(b, (x, i) => x + t * noise[i]));
        const want = base.some((m) => dot(v, m) >= NEAR_DUP);
        assert.equal(set.has(v), want, `dim ${dim}, probe ${k}`);
        if (want) { near++; }
      }
      assert.ok(near > 50 && near < 350, `both sides of the line are probed (${near} near)`);
    }
    assert.equal(nearDupSet().has(unit([1, 0])), false, 'an empty set holds nothing');
  });
});

// ── the lock ────────────────────────────────────────────────────────────────

// random-songs builds its schema inside its handler, per request, so the
// test runs the handler once with Joi.object recording and reads back the
// schema it built. Past validation the handler needs a database, which a
// unit test has none of: that failure is expected and ignored.
async function randomSongsSchema() {
  const built = [];
  const realObject = Joi.object;
  Joi.object = function recording(...args) {
    const s = realObject.apply(this, args);
    built.push(s);
    return s;
  };
  let handler = null;
  try {
    random.setup({ post: (route, fn) => { if (route === '/api/v1/db/random-songs') { handler = fn; } } });
    assert.ok(handler, 'random-songs registered');
    try {
      await handler({ body: {}, user: { id: 1 } }, { json() {} });
    } catch (_e) { /* no database here */ }
  } finally {
    Joi.object = realObject;
  }
  const schema = built.find((s) => 'ignoreList' in (s.describe().keys || {}));
  assert.ok(schema, "random-songs' schema was built");
  return schema;
}

describe('SONG_FILTER_KEYS lock', () => {
  test('every song-filter key, with its own schema, is on both routes', async () => {
    const keys = Object.keys(random.SONG_FILTER_KEYS);
    assert.deepEqual(keys.sort(), [
      'allowUnknownDuration', 'bpmRanges', 'genreMode', 'genreSource', 'genres', 'ignoreVPaths', 'maxDuration',
      'minDuration', 'minRating', 'moods', 'musicalKeys', 'requireBpm', 'requireMusicalKey',
    ], 'a key added here ships as a new instantMix generation');
    const routes = { 'random-songs': (await randomSongsSchema()).describe().keys, mix: mixSchema.describe().keys };
    for (const [name, described] of Object.entries(routes)) {
      for (const k of keys) {
        assert.ok(k in described, `${name} lacks ${k}`);
        assert.deepEqual(described[k], random.SONG_FILTER_KEYS[k].describe(), `${name}.${k} is not the shared schema`);
      }
    }
  });

  test("the waterfall's and the session's keys stay random-songs' own", () => {
    const mix = mixSchema.describe().keys;
    for (const k of ['ignoreList', 'ignoreArtists', 'artists', 'bpmRangesWide', 'similarTo', 'minSimilarity']) {
      assert.ok(!(k in mix), k);
    }
    assert.deepEqual(Object.keys(mix).sort(), ['from', 'limit', 'skipWords', ...Object.keys(random.SONG_FILTER_KEYS)].sort());
  });
});
