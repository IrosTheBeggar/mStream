/**
 * Auto-DJ "less like this" — the negative seeds of src/api/random.js's
 * picker (`lessLike` / `lessLikeVectors`), at the runRandomSongs level over
 * a real mstream.db + discovery.db with a hand-built 6-d vector space, so
 * every cosine is known in advance and every ordering is asserted exactly.
 *
 *   - the threshold rule (clamp(minSimilarity + .10, .80, .95), else .80);
 *   - the nearest-negative rule (a union of per-negative sets, never a
 *     centroid: two orthogonal skips do not block the song between them);
 *   - SOFT ordering: like-a-skip rows come last in simple mode and in the
 *     waterfall, under the tier ranking and above the fresh/repeat order
 *     (tier > not just served > not like a skip > fresh > oldest repeat;
 *     the just-served window is the newest max(limit × 5, 8) ignoreList
 *     entries, which rank behind every fresh song, like a skip or not),
 *     and are still served when nothing else is left — never a new 400;
 *   - the candidate SQL: the `ll` column + ORDER BY alias, its json_each
 *     placeholder binding FIRST (ahead of the rating join's user id), the
 *     plan staying a tracks scan with a non-correlated list subquery, and
 *     byte-identity with today's SQL whenever no negative is usable;
 *   - the conflict guard between positive and negative path seeds, and
 *     that it gives way (positives win, negatives ignored) rather than
 *     empty a pool the plain request had — whether the narrower centroid
 *     or a filter on top of it is what empties it;
 *   - ignore counting (unknown / forbidden / un-analysed paths, bad or
 *     foreign-model vectors, discovery off) and the echo's alignment;
 *   - the per-index cache: warmed with yields, LRU-capped, cold after an
 *     index rebuild;
 *   - the route handler: it warms every cold negative (yielding) before the
 *     synchronous pick, after the positive seed's own checks.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let testRoot;
let config, manager, ddb, sim, random;

// ── the vector space (6-d, unit vectors) ────────────────────────────────────
//
// P = e1. N, X1..X3 and F all sit at cosine .85 from P; around P's cone,
// X1..X3 are placed at exact cosines from N (.97, .87, .76) and F opposite
// N (.445). G1 = e5, G2 = e6 are orthogonal to everything, with M half-way
// between them (.7071 from each) — the centroid trap.
const DIM = 6;
const S = Math.sqrt(1 - 0.85 ** 2);
const around = (c) => {
  const k = (c - 0.7225) / 0.2775;
  return [0.85, S * k, S * Math.sqrt(1 - k * k), 0, 0, 0];
};
const f32 = (xs) => {
  const v = Float32Array.from(xs);
  let n = 0;
  for (const x of v) { n += x * x; }
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
};
const blob = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const b64 = (v) => blob(v).toString('base64');
const V = {
  P: f32([1, 0, 0, 0, 0, 0]),
  N: f32([0.85, S, 0, 0, 0, 0]),
  X1: f32(around(0.97)),
  X2: f32(around(0.87)),
  X3: f32(around(0.76)),
  F: f32([0.85, -S, 0, 0, 0, 0]),
  G1: f32([0, 0, 0, 0, 1, 0]),
  G2: f32([0, 0, 0, 0, 0, 1]),
  M: f32([0, 0, 0, 0, 1, 1]),
};
const randomVec = () => f32(Array.from({ length: DIM }, () => Math.random() * 2 - 1));

// Track rows: title -> { lib, vec (or null), bpm }.
const TRACKS = [
  ['P', 'rig', V.P, null],
  ['N', 'rig', V.N, null],
  ['X1', 'rig', V.X1, null],
  ['X2', 'rig', V.X2, null],
  ['X3', 'rig', V.X3, 80],
  ['F', 'rig', V.F, 80],
  ['G1', 'rig', V.G1, null],
  ['G2', 'rig', V.G2, null],
  ['M', 'rig', V.M, null],
  ['U', 'rig', null, null],          // scanned, never analysed
  ['O', 'other', V.M, null],         // M's vector, in a library rigUser cannot see
];
const hashOf = (title) => `ll-${title}`;
const pathOf = (title) => `${title === 'O' ? 'other' : 'rig'}/${title.toLowerCase()}.mp3`;
const ids = {};        // title -> track id
const lib = {};        // name -> library id
let dj;                // the rating user
let rigUser;           // a federation-key-shaped user: rig only, no id

// Plain-mode sets for [N] at T = .8.
const BLOCKED_BY_N = ['N', 'X1', 'X2', 'P'];
const FREE_OF_N = ['X3', 'F', 'G1', 'G2', 'M', 'U'];

const titles = (out) => out.songs.map((s) => s.metadata.title);
const pick = (body, user = rigUser) => random.runRandomSongs({ user }, body);

// Run `fn` with every statement runRandomSongs prepares recorded (sql +
// bound params), the autodj-cooldown.test.mjs helper.
function capture(fn) {
  const d = manager.getDB();
  const seen = [];
  const real = d.prepare;
  d.prepare = (sql) => {
    const st = real.call(d, sql);
    return {
      all: (...p) => { seen.push({ sql, params: p }); return st.all(...p); },
      get: (...p) => { seen.push({ sql, params: p }); return st.get(...p); },
    };
  };
  try { return { out: fn(), seen }; } finally { delete d.prepare; }
}
const candidates = (seen) => seen.filter((s) => /RANDOM\(\)/.test(s.sql));
const planOf = ({ sql, params }) => manager.getDB()
  .prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);

// Asserts the free titles precede the blocked ones and the echo lines up.
function assertSplit(out, blocked, expectAll = null) {
  const got = titles(out);
  if (expectAll) { assert.deepEqual([...got].sort(), [...expectAll].sort()); }
  const firstBlocked = got.findIndex((t) => blocked.includes(t));
  const lastFree = got.reduce((acc, t, i) => (blocked.includes(t) ? acc : i), -1);
  if (firstBlocked !== -1) {
    assert.ok(lastFree < firstBlocked, `free titles come first: ${got.join(' ')}`);
  }
  assert.deepEqual(out.lessLike.avoided, got.map((t) => blocked.includes(t)), `avoided aligns with songs: ${got.join(' ')}`);
}

before(async () => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-lesslike-'));
  fs.mkdirSync(path.join(testRoot, 'db'), { recursive: true });
  const folders = {};
  for (const name of ['rig', 'other']) {
    fs.mkdirSync(path.join(testRoot, name), { recursive: true });
    folders[name] = { root: path.join(testRoot, name) };
  }
  fs.writeFileSync(path.join(testRoot, 'config.json'), JSON.stringify({
    storage: {
      dbDirectory: path.join(testRoot, 'db'),
      albumArtDirectory: path.join(testRoot, 'art'),
      logsDirectory: path.join(testRoot, 'logs'),
    },
    folders,
    port: 0,
  }, null, 2));

  config = await import('../../src/state/config.js');
  await config.setup(path.join(testRoot, 'config.json'));
  config.program.scanOptions.collectDiscoveryData = true;
  config.program.scanOptions.discoveryModel = 'test-fake';

  manager = await import('../../src/db/manager.js');
  manager.initDB();
  ddb = await import('../../src/db/discovery-db.js');
  ddb.initDiscoveryDb(path.join(testRoot, 'db', 'discovery.db'));
  sim = await import('../../src/db/discovery-similarity.js');
  random = await import('../../src/api/random.js');

  const d = manager.getDB();
  for (const r of d.prepare('SELECT id, name FROM libraries').all()) { lib[r.name] = r.id; }
  d.exec('BEGIN');
  const ins = d.prepare(`INSERT INTO tracks (filepath, library_id, title, bpm, audio_hash, format, duration)
                         VALUES (?, ?, ?, ?, ?, 'mp3', 200)`);
  for (const [title, libName, , bpm] of TRACKS) {
    ids[title] = Number(ins.run(`${title.toLowerCase()}.mp3`, lib[libName], title, bpm, hashOf(title)).lastInsertRowid);
  }
  d.prepare("INSERT INTO users (username, password, salt) VALUES ('dj', 'x', 'y')").run();
  const uid = d.prepare("SELECT id FROM users WHERE username = 'dj'").get().id;
  const rate = d.prepare('INSERT INTO user_metadata (user_id, track_hash, rating, play_count) VALUES (?, ?, ?, 1)');
  rate.run(uid, hashOf('X3'), 8);
  rate.run(uid, hashOf('N'), 8);
  rate.run(uid, hashOf('F'), 4);
  d.exec('COMMIT');

  rigUser = { vpaths: ['rig'], libraryIds: [lib.rig] };
  dj = { ...rigUser, id: uid, username: 'dj' };

  for (const [title, , vec] of TRACKS) {
    if (!vec) { continue; }
    ddb.upsertDiscoveryTrack({
      audioHash: hashOf(title), artist: 'A', title, duration: 200,
      modelId: 'test-fake', modelVersion: '1', embedding: blob(vec),
    });
  }
  ddb.publishIndexEpoch();
  sim.invalidate();
});

after(() => {
  try { manager.close(); } catch (_e) { /* closed */ }
  try { ddb.closeDiscoveryDb(); } catch (_e) { /* closed */ }
  try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch (_e) { /* win locks */ }
  setImmediate(() => process.exit(0));
});

// ── D1: the threshold rule and the constants ────────────────────────────────

describe('lessLikeThreshold', () => {
  test('clamp(minSimilarity + .10, .80, .95), else .80, 4 decimals', () => {
    const cases = [
      [undefined, 0.8], [0, 0.8], [0.3, 0.8], [0.55, 0.8], [0.7, 0.8],
      [0.75, 0.85], [0.8, 0.9], [0.85, 0.95], [0.9, 0.95], [1, 0.95],
    ];
    for (const [m, t] of cases) { assert.equal(random.lessLikeThreshold(m), t, `minSimilarity ${m}`); }
    assert.equal(random.LESS_LIKE_MAX, 8);
    assert.equal(random.AUTO_DJ_GENERATION, 1);
  });
});

// ── the pick ────────────────────────────────────────────────────────────────

describe('runRandomSongs with negative seeds', () => {
  test('D2: plain [N] ranks the like-a-skip rows last, serves them all, echoes', () => {
    const all = [...FREE_OF_N, ...BLOCKED_BY_N];
    for (let i = 0; i < 5; i++) {
      const out = pick({ lessLike: [pathOf('N')], limit: 25 });
      assert.equal(out.songs.length, 10);
      assertSplit(out, BLOCKED_BY_N, all);
      const { avoided: _a, ...echo } = out.lessLike;
      assert.deepEqual(echo, { used: 1, ignored: 0, threshold: 0.8 });
    }
  });

  test('D3: the nearest negative, not a centroid — G1 + G2 never block M', () => {
    const asVectors = pick({ lessLikeVectors: [b64(V.G1), b64(V.G2)], lessLikeModelId: 'test-fake', limit: 25 });
    const asPaths = pick({ lessLike: [pathOf('G1'), pathOf('G2')], limit: 25 });
    for (const out of [asVectors, asPaths]) {
      assert.equal(out.lessLike.used, 2);
      const avoidedTitles = titles(out).filter((_t, i) => out.lessLike.avoided[i]);
      assert.deepEqual(avoidedTitles.sort(), ['G1', 'G2']);
    }
  });

  test('D4: simple-mode plan pin — the ll column, its first-bound JSON, a non-correlated list subquery', () => {
    const { seen } = capture(() => pick({ lessLike: [pathOf('N')] }));
    const steps = candidates(seen);
    assert.equal(steps.length, 1);
    const [s] = steps;
    assert.match(s.sql, /^SELECT t\.id, t\.bpm, t\.musical_key, CASE WHEN COALESCE\(t\.audio_hash, t\.file_hash\) IN \(SELECT value FROM json_each\(\?\)\) THEN 1 ELSE 0 END AS ll FROM tracks t /);
    assert.match(s.sql, /ORDER BY ll, RANDOM\(\) LIMIT 50$/);
    assert.deepEqual(new Set(JSON.parse(s.params[0])), new Set(BLOCKED_BY_N.map(hashOf)));
    const plan = planOf(s);
    const details = plan.map((r) => r.detail).join(' | ');
    assert.match(details, /LIST SUBQUERY/, details);
    assert.doesNotMatch(details, /CORRELATED/, details);
    assert.match(plan.find((r) => r.parent === 0).detail, /^(SCAN|SEARCH) t\b/, details);
  });

  test('D5: waterfall plan pin — tier, then ll, then RANDOM(); nothing correlated, no joins', () => {
    const { seen } = capture(() => pick({
      lessLike: [pathOf('N')],
      bpmRanges: [{ min: 110, max: 130 }], musicalKeys: ['8A'], ignoreArtists: ['Nobody At All'],
    }));
    const steps = candidates(seen);
    assert.ok(steps.length > 0, 'the waterfall ran');
    for (const s of steps) {
      assert.match(s.sql, /ORDER BY CASE[\s\S]+END, ll, RANDOM\(\) LIMIT 50$/);
      const details = planOf(s).map((r) => r.detail).join(' | ');
      assert.doesNotMatch(details, /CORRELATED/, details);
      assert.doesNotMatch(details, /SEARCH (a|al|l|um) /, details);
    }
  });

  test('D6: bind order under minRating — the JSON binds ahead of the user id, the plan drives from tracks', () => {
    const { out, seen } = capture(() => pick({ minRating: 6, lessLike: [pathOf('N')], limit: 25 }, dj));
    assert.deepEqual(titles(out), ['X3', 'N']);
    assert.deepEqual(out.lessLike.avoided, [false, true]);
    for (const s of candidates(seen)) {
      const plan = planOf(s);
      const details = plan.map((r) => r.detail).join(' | ');
      assert.match(plan.find((r) => r.parent === 0).detail, /^(SCAN|SEARCH) t\b/, details);
      assert.match(details, /SEARCH um .*LEFT-JOIN/, details);
      assert.doesNotMatch(details, /idx_user_metadata_user_rating/, details);
    }
  });

  test('D7: no usable negative → the candidate SQL and params are byte-identical to today', () => {
    const shape = (body, user = rigUser) => candidates(capture(() => pick(body, user)).seen)
      .map(({ sql, params }) => ({ sql, params }));
    const plain = shape({});
    assert.deepEqual(shape({ lessLike: ['rig/nope.mp3'] }), plain);
    config.program.scanOptions.collectDiscoveryData = false;
    try {
      assert.deepEqual(shape({ lessLike: [pathOf('N')] }), plain);
    } finally {
      config.program.scanOptions.collectDiscoveryData = true;
    }
    const waterfall = { ignoreArtists: ['x'], bpmRanges: [{ min: 110, max: 130 }] };
    assert.deepEqual(shape({ ...waterfall, lessLike: ['rig/nope.mp3'] }), shape(waterfall));
  });

  test('D8: the tier beats ll — like-a-skip in-tier rows outrank off-tier rows', () => {
    // Nothing is in 110-130, so the unrestricted step serves everything:
    // tier 1 (no bpm) before tier 2 (bpm 80), ll last within tier 1.
    const out = pick({ lessLike: [pathOf('N')], bpmRanges: [{ min: 110, max: 130 }], limit: 25 });
    const got = titles(out);
    assert.deepEqual(got.slice(0, 4).sort(), ['G1', 'G2', 'M', 'U']);
    assert.deepEqual(got.slice(4, 8).sort(), ['N', 'P', 'X1', 'X2']);
    assert.deepEqual(got.slice(8).sort(), ['F', 'X3']);
    assert.deepEqual(out.lessLike.avoided, [false, false, false, false, true, true, true, true, false, false]);
  });

  test('D9: not-like-a-skip beats fresh — a cooled F wins over a fresh like-a-skip row', () => {
    // F served nine picks ago, past the just-served window (8 at limit 1);
    // P is the one fresh song, and it is like N.
    const ignoreList = ['F', 'X3', 'G1', 'G2', 'M', 'U', 'N', 'X1', 'X2'].map((t) => ids[t]);
    const withNeg = pick({ lessLike: [pathOf('N')], ignoreList, limit: 1 });
    assert.deepEqual(titles(withNeg), ['F']);
    assert.deepEqual(withNeg.lessLike.avoided, [false]);
    const without = pick({ ignoreList, limit: 1 });
    assert.deepEqual(titles(without), ['P']);
    const waterfall = pick({ lessLike: [pathOf('N')], ignoreList, limit: 1, ignoreArtists: ['Nobody At All'] });
    assert.deepEqual(titles(waterfall), ['F']);
    // With every cooled song inside the window (eight entries, F newest),
    // a fresh song wins even though it is like a skip.
    const recent = pick({ lessLike: [pathOf('N')], ignoreList: [...ignoreList.slice(1, 8), ids.F], limit: 1 });
    assert.ok(['P', 'X2'].includes(titles(recent)[0]), titles(recent).join());
    assert.deepEqual(recent.lessLike.avoided, [true]);
  });

  test('D10: under a sonic seed the threshold follows minSimilarity', () => {
    const tight = pick({ similarTo: [pathOf('P')], minSimilarity: 0.8, lessLike: [pathOf('N')], limit: 25 });
    assert.equal(tight.sonic.poolSize, 5);
    assert.equal(tight.lessLike.threshold, 0.9);
    assertSplit(tight, ['N', 'X1'], ['X2', 'X3', 'F', 'N', 'X1']);
    const loose = pick({ similarTo: [pathOf('P')], minSimilarity: 0.5, lessLike: [pathOf('N')], limit: 25 });
    assert.equal(loose.lessLike.threshold, 0.8);
    assertSplit(loose, ['N', 'X1', 'X2'], ['X3', 'F', 'N', 'X1', 'X2']);
  });

  test('D11: the ceiling — every pool member like a skip still plays, no throw', () => {
    const out = pick({
      similarToVector: b64(V.N), similarToModelId: 'test-fake', minSimilarity: 0.9,
      lessLike: [pathOf('X1')], limit: 25,
    });
    assert.equal(out.songs.length, 2);
    assert.deepEqual(titles(out).sort(), ['N', 'X1']);
    assert.deepEqual(out.lessLike.avoided, [true, true]);
    assert.equal(out.lessLike.threshold, 0.95);
  });

  test('D12: the conflict guard between positive and negative path seeds', () => {
    // (a) P + N positives, N negative: the centroid is P alone, so the pool
    // is P's cone minus both seeds (4, all at .85), and N is used.
    const a = pick({ similarTo: [pathOf('P'), pathOf('N')], minSimilarity: 0.8, lessLike: [pathOf('N')], limit: 25 });
    assert.equal(a.sonic.poolSize, 4);
    assert.deepEqual(titles(a).sort(), ['F', 'X1', 'X2', 'X3']);
    for (const s of a.sonic.similarities) { assert.ok(Math.abs(s - 0.85) < 1e-3, `similarity ${s}`); }
    assert.equal(a.lessLike.used, 1);
    const aPlain = pick({ similarTo: [pathOf('P'), pathOf('N')], minSimilarity: 0.8, limit: 25 });
    assert.equal(aPlain.sonic.poolSize, 3);
    // (b) the only positive is also the negative: the positive wins.
    const b = pick({ similarTo: [pathOf('N')], minSimilarity: 0.8, lessLike: [pathOf('N')], limit: 25 });
    assert.deepEqual({ used: b.lessLike.used, ignored: b.lessLike.ignored }, { used: 0, ignored: 1 });
    const bPlain = pick({ similarTo: [pathOf('N')], minSimilarity: 0.8, limit: 25 });
    assert.equal(bPlain.sonic.poolSize, 3);
    assert.equal(b.sonic.poolSize, bPlain.sonic.poolSize);
    assert.ok(b.lessLike.avoided.every((x) => x === false));
    // (c) every positive is a negative.
    const c = pick({ similarTo: [pathOf('N'), pathOf('X1')], minSimilarity: 0.8, lessLike: [pathOf('N'), pathOf('X1')], limit: 25 });
    assert.deepEqual({ used: c.lessLike.used, ignored: c.lessLike.ignored }, { used: 0, ignored: 2 });
    // (d) one positive survives: both negatives are used.
    const dd = pick({ similarTo: [pathOf('P'), pathOf('N')], minSimilarity: 0.8, lessLike: [pathOf('N'), pathOf('F')], limit: 25 });
    assert.equal(dd.lessLike.used, 2);
  });

  test('D13: unusable negatives are ignored and counted, one bucket for every reason', () => {
    const paths = pick({ lessLike: ['rig/nope.mp3', pathOf('O'), pathOf('U'), pathOf('N')], limit: 25 });
    assert.deepEqual({ used: paths.lessLike.used, ignored: paths.lessLike.ignored }, { used: 1, ignored: 3 });
    assert.equal(paths.lessLike.avoided[titles(paths).indexOf('M')], false, 'O (M\'s vector) is invisible, so M is free');

    const zero = new Float32Array(DIM);
    const short = f32([1, 0, 0, 0]);
    const nan = new Float32Array(DIM); nan[0] = NaN;
    const vectors = pick({ lessLikeVectors: [b64(zero), b64(short), b64(nan), b64(V.G1)], lessLikeModelId: 'test-fake', limit: 25 });
    assert.deepEqual({ used: vectors.lessLike.used, ignored: vectors.lessLike.ignored }, { used: 1, ignored: 3 });

    const foreign = pick({ lessLikeVectors: [b64(V.G1), b64(V.G2)], lessLikeModelId: 'other-model', limit: 25 });
    assert.deepEqual({ used: foreign.lessLike.used, ignored: foreign.lessLike.ignored }, { used: 0, ignored: 2 });

    const before = random.lessLikeCacheSizeForTests(sim.getIndex());
    const twice = pick({ lessLike: [pathOf('N'), pathOf('N')], limit: 25 });
    assert.equal(twice.lessLike.used, 2);
    assert.ok(random.lessLikeCacheSizeForTests(sim.getIndex()) - before <= 1, 'duplicates share one cache entry');

    // The same path for a caller who sees every library: visibility was the
    // only reason it was ignored above.
    const everyone = random.runRandomSongs({ user: undefined }, { lessLike: [pathOf('O')], limit: 25 });
    assert.equal(everyone.lessLike.used, 1);
    assert.equal(everyone.lessLike.avoided[titles(everyone).indexOf('M')], true);
  });

  test('D14: discovery off — negatives are all ignored, the echo still comes back', () => {
    config.program.scanOptions.collectDiscoveryData = false;
    try {
      const out = pick({ lessLike: [pathOf('N')], limit: 25 });
      assert.equal(out.songs.length, 10);
      const { avoided, ...echo } = out.lessLike;
      assert.deepEqual(echo, { used: 0, ignored: 1, threshold: 0.8 });
      assert.ok(avoided.every((x) => x === false));
    } finally {
      config.program.scanOptions.collectDiscoveryData = true;
    }
  });

  test('D15: warmLessLike yields between cold passes and fills the cache the pick then reads', async () => {
    const body = { lessLikeVectors: [randomVec(), randomVec(), randomVec()].map(b64), lessLikeModelId: 'test-fake' };
    const index = sim.getIndex();
    const before = random.lessLikeCacheSizeForTests(index);
    const spin = async (fn) => {
      let ticks = 0;
      let running = true;
      const tick = () => { if (!running) { return; } ticks++; setImmediate(tick); };
      setImmediate(tick);
      try { await fn(); } finally { running = false; }
      return ticks;
    };
    const cold = await spin(() => random.warmLessLike({ user: rigUser }, body));
    assert.ok(cold >= 2, `three cold passes yield at least twice (ticks ${cold})`);
    assert.equal(random.lessLikeCacheSizeForTests(index), before + 3);
    const out = pick({ ...body, limit: 25 });
    assert.equal(out.lessLike.used, 3);
    assert.equal(random.lessLikeCacheSizeForTests(index), before + 3, 'the pick found every set cached');
    const warm = await spin(() => random.warmLessLike({ user: rigUser }, body));
    assert.equal(warm, 0, 'nothing cold, nothing yielded');
  });

  // The route handler itself (setup registers it on a stub app), for the
  // rules only the handler keeps: the warm-up before the pick, and the
  // positive seed's checks before the warm-up.
  const routeHandler = () => {
    let handler;
    random.setup({ post: (route, h) => { if (route === '/api/v1/db/random-songs') { handler = h; } } });
    assert.equal(typeof handler, 'function');
    return handler;
  };

  // D18–D20 sit before D16 (which fills the LRU cache to its cap, so cache
  // growth could no longer be read) and D17 (which rebuilds the index).
  test('D18: the route warms every cold negative, yielding, before the synchronous pick', async () => {
    const handler = routeHandler();
    const index = sim.getIndex();
    const body = { lessLikeVectors: [randomVec(), randomVec(), randomVec()].map(b64), lessLikeModelId: 'test-fake' };
    const cacheBefore = random.lessLikeCacheSizeForTests(index);
    const coldBefore = random.lessLikeColdInPickForTests();
    // The event-loop turns the handler gives up before it answers.
    let ticks = 0;
    let answered = null;
    const tick = () => { if (answered) { return; } ticks++; setImmediate(tick); };
    setImmediate(tick);
    await handler({ body, user: rigUser }, { json: (o) => { answered = o; } });
    assert.ok(ticks >= 2, `three cold passes yield at least twice before the answer (ticks ${ticks})`);
    assert.equal(answered.lessLike.used, 3);
    assert.equal(random.lessLikeCacheSizeForTests(index), cacheBefore + 3, 'the warm-up scored every negative');
    assert.equal(random.lessLikeColdInPickForTests(), coldBefore, 'the pick computed no set itself');
    // A warm request answers without yielding and without scoring.
    answered = null; ticks = 0;
    setImmediate(tick);
    await handler({ body, user: rigUser }, { json: (o) => { answered = o; } });
    assert.equal(ticks, 0, 'nothing cold, nothing yielded');
    assert.equal(random.lessLikeColdInPickForTests(), coldBefore);
    // The counter is live: a pick that bypasses the handler scores for itself.
    pick({ lessLikeVectors: [b64(randomVec())], lessLikeModelId: 'test-fake' });
    assert.equal(random.lessLikeColdInPickForTests(), coldBefore + 1);
  });

  test('D19: a bad positive fails before any negative is scored; a negative the guard ignores is not scored', async () => {
    const handler = routeHandler();
    const index = sim.getIndex();
    const before = random.lessLikeCacheSizeForTests(index);
    const cold = () => ({ lessLikeVectors: [randomVec(), randomVec()].map(b64), lessLikeModelId: 'test-fake' });
    const res = { json: () => assert.fail('a bad positive seed answered') };
    const bad = [
      [{ similarTo: ['rig/nope.mp3'], minSimilarity: 0.5 }, 404],
      [{ similarTo: [pathOf('U')], minSimilarity: 0.5 }, 400],
      [{ similarToVector: b64(V.P), similarToModelId: 'other-model', minSimilarity: 0.5 }, 400],
    ];
    for (const [positive, status] of bad) {
      await assert.rejects(handler({ body: { ...positive, ...cold() }, user: rigUser }, res), { status });
    }
    assert.equal(random.lessLikeCacheSizeForTests(index), before, 'no cosine pass was paid for');

    // The only positive is also the negative: the positives win, so the
    // negative's set is never computed — not by the warm-up, not by the pick.
    let out;
    await handler({ body: { similarTo: [pathOf('N')], minSimilarity: 0.72, lessLike: [pathOf('N')] }, user: rigUser },
      { json: (o) => { out = o; } });
    const { avoided: _a, ...echo } = out.lessLike;
    assert.deepEqual(echo, { used: 0, ignored: 1, threshold: 0.82 });
    assert.equal(random.lessLikeCacheSizeForTests(index), before, 'a negative the guard ignores is not scored');
    // One surviving positive: the dropped negative IS used, and scored.
    await handler({ body: { similarTo: [pathOf('P'), pathOf('N')], minSimilarity: 0.72, lessLike: [pathOf('N')] }, user: rigUser },
      { json: (o) => { out = o; } });
    assert.equal(out.lessLike.used, 1);
    assert.equal(random.lessLikeCacheSizeForTests(index), before + 1);
  });

  test('D20: the conflict guard never turns a pick into the similarity-range 400', () => {
    // (a) The guarded POOL is empty. G1 + G2 at .9: the centroid is M's
    // direction, so the pool is M (and O, M's vector out of scope). Skipping
    // G1 would leave G2 alone as the centroid, within .9 of nothing but
    // itself — the guard gives way: the positives win, the negative is
    // ignored, the pool is the plain one.
    const plain = pick({ similarTo: [pathOf('G1'), pathOf('G2')], minSimilarity: 0.9, limit: 25 });
    assert.deepEqual(titles(plain), ['M']);
    assert.equal(plain.sonic.poolSize, 2);
    const guarded = pick({ similarTo: [pathOf('G1'), pathOf('G2')], minSimilarity: 0.9, lessLike: [pathOf('G1')], limit: 25 });
    assert.deepEqual(titles(guarded), ['M']);
    const { avoided: _a, ...echo } = guarded.lessLike;
    assert.deepEqual(echo, { used: 0, ignored: 1, threshold: 0.95 });
    assert.equal(guarded.sonic.poolSize, plain.sonic.poolSize);
    assert.deepEqual(guarded.lessLike.avoided, [false]);

    // (b) The guarded pool is non-empty but a FILTER empties it. N + X1 at
    // .8 reach X2, P and X3; N alone (X1 skipped) reaches X2 and P only.
    // dj's rating bar (X3 and N rated 8) keeps X3 — which only the full
    // centroid's pool holds.
    const rated = { similarTo: [pathOf('N'), pathOf('X1')], minSimilarity: 0.8, minRating: 6, limit: 25 };
    const ratedPlain = pick(rated, dj);
    assert.deepEqual(titles(ratedPlain), ['X3']);
    assert.equal(ratedPlain.sonic.poolSize, 3);
    const ratedGuarded = pick({ ...rated, lessLike: [pathOf('X1')] }, dj);
    assert.deepEqual(titles(ratedGuarded), ['X3']);
    assert.deepEqual({ used: ratedGuarded.lessLike.used, ignored: ratedGuarded.lessLike.ignored }, { used: 0, ignored: 1 });
    assert.equal(ratedGuarded.sonic.poolSize, 3, 'the re-run uses the full centroid');
    // The same with a bar nothing meets is still the plain 400, with or
    // without the negative: it was never the guard's doing.
    for (const body of [{ ...rated, minRating: 9 }, { ...rated, minRating: 9, lessLike: [pathOf('X1')] }]) {
      assert.throws(() => pick(body, dj), { status: 400, message: /similarity range/ });
    }
    // And a guard that keeps a working pool is left alone: P + N with N
    // skipped (D12 a) still serves the narrower centroid.
    const kept = pick({ similarTo: [pathOf('P'), pathOf('N')], minSimilarity: 0.8, lessLike: [pathOf('N')], limit: 25 });
    assert.equal(kept.sonic.poolSize, 4);
    assert.equal(kept.lessLike.used, 1);
  });

  test('D16: the per-index cache is LRU-capped', () => {
    for (let i = 0; i < 9; i++) {
      pick({ lessLikeVectors: Array.from({ length: 8 }, () => b64(randomVec())), lessLikeModelId: 'test-fake' });
    }
    assert.ok(random.lessLikeCacheSizeForTests(sim.getIndex()) <= random.LESS_LIKE_CACHE_MAX);
  });

  // Last in the file: it rebuilds the index.
  test('D17: cold after an index rebuild, and the new vectors count', () => {
    const a = sim.getIndex();
    pick({ lessLike: [pathOf('N')], limit: 25 });
    assert.ok(random.lessLikeCacheSizeForTests(a) > 0);
    ddb.upsertDiscoveryTrack({
      audioHash: hashOf('X3'), artist: 'A', title: 'X3', duration: 200,
      modelId: 'test-fake', modelVersion: '1', embedding: blob(V.N),
    });
    ddb.publishIndexEpoch();
    const b = sim.getIndex();
    assert.notEqual(b, a, 'a published epoch rebuilds the index');
    assert.equal(random.lessLikeCacheSizeForTests(b), 0);
    const out = pick({ lessLike: [pathOf('N')], limit: 25 });
    assert.equal(out.lessLike.avoided[titles(out).indexOf('X3')], true);
    assert.equal(random.lessLikeCacheSizeForTests(b), 1);
  });
});
