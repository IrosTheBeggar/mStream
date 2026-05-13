/**
 * Unit tests for webapp/alpha/auto-dj.js — the client-side helpers
 * + state model that drive the upcoming alpha-UI Auto-DJ panel and
 * player integration.
 *
 * The module is UMD-shaped so we can `require()` it from Node and
 * exercise the pure helpers without booting a browser. For the
 * localStorage-backed state tests we install a Map-backed shim on
 * globalThis and re-hydrate the module between scenarios.
 *
 * What this file covers:
 *   • CAMELOT map shape + frozen invariant
 *   • toCamelot — raw key + already-Camelot passthrough + bad input
 *   • camelotNeighbours — wheel maths (relative + adjacent ± wrap)
 *   • bpmAvg — empty / partial-numeric / negative-value handling
 *   • buildBpmRanges — three-range fan-out + clamping + bad inputs
 *   • songBlocked — BPM continuity (in-range / out / no-anchor / no-data)
 *                  + harmonic mixing (neighbours set / kebab-case wire)
 *   • State persistence — setState round-trip, defaults on missing
 *                        keys, malformed JSON pass-through, reset()
 *   • BPM history — ring buffer cap, anchor derivation, clear
 *   • Camelot anchor — set + neighbours from raw key + clear
 *   • Artist cooldown — dedup with normalisation, ring buffer cap
 *   • ignoreList passthrough
 *   • resetAnchors() clears both BPM history and Camelot anchor
 *     (but NOT artist history — that's a separate session concept)
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ── Map-backed localStorage shim ────────────────────────────────────
//
// The module reads `localStorage` from the global at module-load
// time, so we install the shim BEFORE the first require(). Each test
// resets the underlying Map and re-hydrates the module.
const _store = new Map();
globalThis.localStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _store.set(k, String(v)); },
  removeItem: (k) => { _store.delete(k); },
  clear: () => { _store.clear(); },
  get length() { return _store.size; },
  key: (i) => Array.from(_store.keys())[i] ?? null,
};

const AUTODJ = require('../webapp/alpha/auto-dj.js');

beforeEach(() => {
  _store.clear();
  AUTODJ._internals.rehydrate();
});

// ─────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────

describe('CAMELOT map', () => {
  test('covers every standard major + minor key', () => {
    // 12 majors + 12 minors = 24 codes, but some appear twice via
    // enharmonic spelling so the value-set should still be exactly 24.
    const codes = new Set(Object.values(AUTODJ._internals.CAMELOT));
    assert.equal(codes.size, 24, `expected 24 distinct codes, got ${codes.size}`);
  });

  test('enharmonic spellings map to the same code', () => {
    assert.equal(AUTODJ._internals.CAMELOT['Ab minor'], AUTODJ._internals.CAMELOT['G# minor']);
    assert.equal(AUTODJ._internals.CAMELOT['F# major'], AUTODJ._internals.CAMELOT['Gb major']);
    assert.equal(AUTODJ._internals.CAMELOT['Db major'], AUTODJ._internals.CAMELOT['C# major']);
  });

  test('object is frozen — accidental mutation throws in strict mode', () => {
    assert.ok(Object.isFrozen(AUTODJ._internals.CAMELOT));
    assert.throws(() => { AUTODJ._internals.CAMELOT['A minor'] = 'mutated'; });
  });
});

describe('toCamelot', () => {
  test('maps known raw keys to Camelot codes', () => {
    assert.equal(AUTODJ.toCamelot('A minor'), '8A');
    assert.equal(AUTODJ.toCamelot('C major'), '8B');
    assert.equal(AUTODJ.toCamelot('Sigur Rós'), null); // not a key name
  });

  test('passes through already-Camelot codes verbatim', () => {
    // Libraries tagged directly with Camelot ('8A', '12B') should
    // round-trip without lookup.
    assert.equal(AUTODJ.toCamelot('8A'), '8A');
    assert.equal(AUTODJ.toCamelot('12B'), '12B');
    assert.equal(AUTODJ.toCamelot('1A'), '1A');
  });

  test('rejects out-of-range Camelot-shaped strings', () => {
    assert.equal(AUTODJ.toCamelot('13A'), null);
    assert.equal(AUTODJ.toCamelot('0B'), null);
    assert.equal(AUTODJ.toCamelot('8C'), null);
  });

  test('trims whitespace before lookup', () => {
    assert.equal(AUTODJ.toCamelot('  A minor  '), '8A');
    assert.equal(AUTODJ.toCamelot('  8A '), '8A');
  });

  test('returns null for non-string / empty input', () => {
    assert.equal(AUTODJ.toCamelot(null), null);
    assert.equal(AUTODJ.toCamelot(undefined), null);
    assert.equal(AUTODJ.toCamelot(''), null);
    assert.equal(AUTODJ.toCamelot(123), null);
    assert.equal(AUTODJ.toCamelot({}), null);
  });
});

describe('camelotNeighbours', () => {
  test('8A returns relative-major + same letter neighbours (6 total)', () => {
    // 8A is "A minor". Neighbours per the standard wheel:
    //   8A (self), 8B (C major, relative major),
    //   7A (D minor), 7B (F major) — counter-clockwise
    //   9A (E minor), 9B (G major) — clockwise
    const n = AUTODJ.camelotNeighbours('8A');
    assert.deepEqual([...n].sort(), ['7A', '7B', '8A', '8B', '9A', '9B']);
  });

  test('wraps around at 12 → 1', () => {
    // 12B's next-clockwise is 1B, 1A.
    const n = AUTODJ.camelotNeighbours('12B');
    assert.ok(n.has('1A'));
    assert.ok(n.has('1B'));
    assert.ok(n.has('12A'));
    assert.ok(n.has('12B'));
    assert.ok(n.has('11A'));
    assert.ok(n.has('11B'));
  });

  test('wraps around at 1 → 12', () => {
    // 1A's prev-counter-clockwise is 12A, 12B.
    const n = AUTODJ.camelotNeighbours('1A');
    assert.ok(n.has('12A'));
    assert.ok(n.has('12B'));
    assert.ok(n.has('1A'));
    assert.ok(n.has('1B'));
    assert.ok(n.has('2A'));
    assert.ok(n.has('2B'));
  });

  test('always returns exactly 6 neighbours (incl self)', () => {
    for (let i = 1; i <= 12; i++) {
      for (const letter of ['A', 'B']) {
        const n = AUTODJ.camelotNeighbours(`${i}${letter}`);
        assert.equal(n.size, 6, `${i}${letter} returned ${n.size} neighbours`);
      }
    }
  });

  test('null / malformed input → null', () => {
    assert.equal(AUTODJ.camelotNeighbours(null), null);
    assert.equal(AUTODJ.camelotNeighbours(''), null);
    assert.equal(AUTODJ.camelotNeighbours('13A'), null);
    assert.equal(AUTODJ.camelotNeighbours('not a code'), null);
    assert.equal(AUTODJ.camelotNeighbours('8C'), null);
  });
});

describe('bpmAvg', () => {
  test('empty input → null', () => {
    assert.equal(AUTODJ.bpmAvg([]), null);
    assert.equal(AUTODJ.bpmAvg(null), null);
    assert.equal(AUTODJ.bpmAvg(undefined), null);
  });

  test('simple average rounded to nearest integer', () => {
    assert.equal(AUTODJ.bpmAvg([124, 126, 128]), 126);
    assert.equal(AUTODJ.bpmAvg([124, 125]), 125); // 124.5 → 125 (round-half-to-even varies; Math.round rounds half-up)
  });

  test('skips non-finite entries', () => {
    assert.equal(AUTODJ.bpmAvg([124, NaN, 126]), 125);
    assert.equal(AUTODJ.bpmAvg([124, null, 126]), 125);
    assert.equal(AUTODJ.bpmAvg([NaN]), null);
  });
});

describe('buildBpmRanges', () => {
  test('three ranges for normal mid-tempo anchor', () => {
    const r = AUTODJ.buildBpmRanges(128, 8);
    assert.equal(r.length, 3);
    assert.deepEqual(r[0], { min: 120, max: 136 });   // ±8
    assert.deepEqual(r[1], { min: 60,  max: 68  });   // half
    assert.deepEqual(r[2], { min: 240, max: 272 });   // double
  });

  test('clamps when range straddles the 300-BPM upper bound', () => {
    // Anchor 145 → double = 290 ± 16 = [274, 306]. min ≤ 300 so the
    // range is kept (not dropped), then max is clamped to 300.
    const r = AUTODJ.buildBpmRanges(145, 8);
    const dbl = r[r.length - 1];
    // Last range is the double-tempo window. Max clamped to 300.
    assert.equal(dbl.max, 300);
    assert.equal(dbl.min, 274);
  });

  test('drops double-tempo entirely when it falls fully above 300', () => {
    // Anchor 160 → double = 320 ± 16 = [304, 336]. min > 300 → the
    // entire range is dropped; we keep only normal + half. This
    // matches "no impossible windows" — a range whose min is already
    // out of the legal space can't have any candidates anyway.
    const r = AUTODJ.buildBpmRanges(160, 8);
    assert.equal(r.length, 2, `expected only normal + half, got ${r.length} ranges`);
    for (const range of r) {
      assert.ok(range.min <= 300, `range.min ${range.min} > 300`);
      assert.ok(range.max >= 20, `range.max ${range.max} < 20`);
    }
  });

  test('uses default tolerance when omitted', () => {
    const r = AUTODJ.buildBpmRanges(128);
    assert.deepEqual(r[0], { min: 120, max: 136 });
  });

  test('returns null for out-of-range anchor', () => {
    assert.equal(AUTODJ.buildBpmRanges(10, 8), null);   // below 20
    assert.equal(AUTODJ.buildBpmRanges(400, 8), null);  // above 300
    assert.equal(AUTODJ.buildBpmRanges(NaN, 8), null);
    assert.equal(AUTODJ.buildBpmRanges(null, 8), null);
  });
});

describe('songBlocked', () => {
  test('no constraints active → never blocked', () => {
    assert.equal(AUTODJ.songBlocked({ bpm: 200, musical_key: 'A minor' }, {}), false);
  });

  test('BPM in normal range → not blocked', () => {
    const result = AUTODJ.songBlocked(
      { bpm: 128 },
      { bpmContinuity: true, refBpm: 128, bpmTolerance: 8 },
    );
    assert.equal(result, false);
  });

  test('BPM in half-tempo range → not blocked (octave equivalence)', () => {
    // Anchor 128, candidate 64 → half-tempo match within ±4.
    const result = AUTODJ.songBlocked(
      { bpm: 64 },
      { bpmContinuity: true, refBpm: 128, bpmTolerance: 8 },
    );
    assert.equal(result, false);
  });

  test('BPM out of range → blocked', () => {
    const result = AUTODJ.songBlocked(
      { bpm: 200 },
      { bpmContinuity: true, refBpm: 128, bpmTolerance: 8 },
    );
    assert.equal(result, true);
  });

  test('null BPM on candidate → passes through (server filtered already)', () => {
    const result = AUTODJ.songBlocked(
      { bpm: null },
      { bpmContinuity: true, refBpm: 128, bpmTolerance: 8 },
    );
    assert.equal(result, false);
  });

  test('null refBpm (no session anchor yet) → passes through', () => {
    const result = AUTODJ.songBlocked(
      { bpm: 200 },
      { bpmContinuity: true, refBpm: null, bpmTolerance: 8 },
    );
    assert.equal(result, false);
  });

  test('harmonic mixing — candidate in neighbour set passes', () => {
    const refNeighbours = AUTODJ.camelotNeighbours('8A'); // 7A/7B/8A/8B/9A/9B
    const result = AUTODJ.songBlocked(
      { musical_key: 'C major' }, // 8B
      { harmonicMixing: true, refNeighbours },
    );
    assert.equal(result, false);
  });

  test('harmonic mixing — out-of-wheel candidate blocked', () => {
    const refNeighbours = AUTODJ.camelotNeighbours('8A');
    const result = AUTODJ.songBlocked(
      { musical_key: 'F# major' }, // 2B — far from 8A
      { harmonicMixing: true, refNeighbours },
    );
    assert.equal(result, true);
  });

  test('harmonic mixing — reads kebab-case wire field', () => {
    // PR-E0 renamed the wire field to `musical-key`. The helper must
    // accept both shapes so callers can pass the metadata sub-object
    // directly from a /random-songs response without re-keying.
    const refNeighbours = AUTODJ.camelotNeighbours('8A');
    const result = AUTODJ.songBlocked(
      { 'musical-key': 'F# major' },
      { harmonicMixing: true, refNeighbours },
    );
    assert.equal(result, true);
  });

  test('harmonic mixing — null key on candidate passes through', () => {
    const refNeighbours = AUTODJ.camelotNeighbours('8A');
    const result = AUTODJ.songBlocked(
      { musical_key: null },
      { harmonicMixing: true, refNeighbours },
    );
    assert.equal(result, false);
  });

  test('combined BPM + harmonic — both must pass', () => {
    const refNeighbours = AUTODJ.camelotNeighbours('8A');
    // In-range BPM but wrong key → blocked.
    assert.equal(
      AUTODJ.songBlocked(
        { bpm: 128, musical_key: 'F# major' },
        { bpmContinuity: true, refBpm: 128, harmonicMixing: true, refNeighbours },
      ),
      true,
    );
    // Both compatible → passes.
    assert.equal(
      AUTODJ.songBlocked(
        { bpm: 128, musical_key: 'C major' },
        { bpmContinuity: true, refBpm: 128, harmonicMixing: true, refNeighbours },
      ),
      false,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// State + persistence
// ─────────────────────────────────────────────────────────────────────

describe('state defaults on fresh boot', () => {
  test('every toggle defaults to off', () => {
    // Note: no `enabled` field — the actual Auto-DJ on/off truth
    // lives in MSTREAMPLAYER.playerStats.autoDJ; mirroring it here
    // would create two sources of truth with no sync path.
    assert.equal(AUTODJ.state.enabled, undefined);
    assert.equal(AUTODJ.state.similar, false);
    assert.equal(AUTODJ.state.bpmContinuity, false);
    assert.equal(AUTODJ.state.harmonicMixing, false);
  });

  test('BPM tolerance defaults to 8', () => {
    assert.equal(AUTODJ.state.bpmTolerance, AUTODJ._internals.DEFAULT_BPM_TOLERANCE);
    assert.equal(AUTODJ.state.bpmTolerance, 8);
  });

  test('djMinRating defaults to 0 (matches alpha UI "Disabled" option)', () => {
    assert.equal(AUTODJ.state.djMinRating, 0);
  });

  test('array fields default to empty arrays (not undefined)', () => {
    assert.deepEqual(AUTODJ.state.djVpaths, []);
    assert.deepEqual(AUTODJ.state.djIgnoreList, []);
    assert.deepEqual(AUTODJ.state.djArtistHistory, []);
    assert.deepEqual(AUTODJ.state.bpmHistory, []);
  });

  test('camelotAnchor defaults to null', () => {
    assert.equal(AUTODJ.state.camelotAnchor, null);
  });
});

describe('setState round-trip', () => {
  test('writes to in-memory state AND localStorage', () => {
    AUTODJ.setState({ bpmContinuity: true, bpmTolerance: 12 });
    assert.equal(AUTODJ.state.bpmContinuity, true);
    assert.equal(AUTODJ.state.bpmTolerance, 12);
    // Persisted with the `mstream-dj-` prefix.
    assert.equal(localStorage.getItem('mstream-dj-bpmContinuity'), 'true');
    assert.equal(localStorage.getItem('mstream-dj-bpmTolerance'), '12');
  });

  test('rehydrates from localStorage on cold boot', () => {
    localStorage.setItem('mstream-dj-bpmContinuity', 'true');
    localStorage.setItem('mstream-dj-bpmTolerance', '15');
    localStorage.setItem('mstream-dj-djVpaths', '["lib1","lib2"]');
    AUTODJ._internals.rehydrate();
    assert.equal(AUTODJ.state.bpmContinuity, true);
    assert.equal(AUTODJ.state.bpmTolerance, 15);
    assert.deepEqual(AUTODJ.state.djVpaths, ['lib1', 'lib2']);
  });

  test('ignores keys not in the state schema', () => {
    AUTODJ.setState({ totallyMadeUp: 'value' });
    assert.equal(AUTODJ.state.totallyMadeUp, undefined);
    assert.equal(localStorage.getItem('mstream-dj-totallyMadeUp'), null);
  });

  test('null value removes the localStorage entry', () => {
    AUTODJ.setState({ camelotAnchor: '8A' });
    assert.equal(localStorage.getItem('mstream-dj-camelotAnchor'), '"8A"');
    AUTODJ.setState({ camelotAnchor: null });
    assert.equal(localStorage.getItem('mstream-dj-camelotAnchor'), null);
  });

  test('malformed JSON in localStorage falls back to default', () => {
    localStorage.setItem('mstream-dj-djVpaths', 'not valid json{{{');
    AUTODJ._internals.rehydrate();
    assert.deepEqual(AUTODJ.state.djVpaths, []);
  });

  test('bpmTolerance clamps to 1..20 on rehydrate', () => {
    localStorage.setItem('mstream-dj-bpmTolerance', '99');
    AUTODJ._internals.rehydrate();
    assert.equal(AUTODJ.state.bpmTolerance, 20);

    localStorage.setItem('mstream-dj-bpmTolerance', '0');
    AUTODJ._internals.rehydrate();
    assert.equal(AUTODJ.state.bpmTolerance, 1);
  });

  test('djMinRating clamps to 0..10', () => {
    localStorage.setItem('mstream-dj-djMinRating', '15');
    AUTODJ._internals.rehydrate();
    assert.equal(AUTODJ.state.djMinRating, 10);
  });
});

describe('reset()', () => {
  test('clears every session-scoped key', () => {
    AUTODJ.setState({
      djIgnoreList: [1, 2, 3],
      djArtistHistory: ['Foo'],
      bpmHistory: [120, 125],
      camelotAnchor: '8A',
    });
    AUTODJ.reset();
    assert.deepEqual(AUTODJ.state.djIgnoreList, []);
    assert.deepEqual(AUTODJ.state.djArtistHistory, []);
    assert.deepEqual(AUTODJ.state.bpmHistory, []);
    assert.equal(AUTODJ.state.camelotAnchor, null);
  });

  test('preserves user toggles (similar, bpmContinuity, etc.)', () => {
    // Resetting a session shouldn't forget the user's preferences.
    AUTODJ.setState({
      similar: true,
      bpmContinuity: true,
      bpmTolerance: 12,
    });
    AUTODJ.reset();
    assert.equal(AUTODJ.state.similar, true);
    assert.equal(AUTODJ.state.bpmContinuity, true);
    assert.equal(AUTODJ.state.bpmTolerance, 12);
  });
});

describe('BPM history + anchor', () => {
  test('pushBpmHistory appends and persists', () => {
    AUTODJ.pushBpmHistory(124);
    AUTODJ.pushBpmHistory(126);
    assert.deepEqual(AUTODJ.state.bpmHistory, [124, 126]);
  });

  test('ring buffer caps at BPM_HISTORY_LIMIT', () => {
    for (let i = 1; i <= AUTODJ._internals.BPM_HISTORY_LIMIT + 3; i++) {
      AUTODJ.pushBpmHistory(100 + i);
    }
    assert.equal(AUTODJ.state.bpmHistory.length, AUTODJ._internals.BPM_HISTORY_LIMIT);
    // Last value pushed is at the end; oldest are evicted.
    assert.equal(
      AUTODJ.state.bpmHistory[AUTODJ.state.bpmHistory.length - 1],
      100 + AUTODJ._internals.BPM_HISTORY_LIMIT + 3,
    );
  });

  test('pushBpmHistory ignores non-finite values', () => {
    AUTODJ.pushBpmHistory(124);
    AUTODJ.pushBpmHistory(null);
    AUTODJ.pushBpmHistory(NaN);
    AUTODJ.pushBpmHistory(126);
    assert.deepEqual(AUTODJ.state.bpmHistory, [124, 126]);
  });

  test('getBpmAnchor returns rounded average', () => {
    AUTODJ.pushBpmHistory(124);
    AUTODJ.pushBpmHistory(126);
    AUTODJ.pushBpmHistory(128);
    assert.equal(AUTODJ.getBpmAnchor(), 126);
  });

  test('getBpmAnchor returns null when history is empty', () => {
    assert.equal(AUTODJ.getBpmAnchor(), null);
  });

  test('clearBpmHistory empties the buffer', () => {
    AUTODJ.pushBpmHistory(124);
    AUTODJ.clearBpmHistory();
    assert.deepEqual(AUTODJ.state.bpmHistory, []);
    assert.equal(AUTODJ.getBpmAnchor(), null);
  });
});

describe('Camelot anchor', () => {
  test('setCamelotAnchor stores the normalised code', () => {
    AUTODJ.setCamelotAnchor('A minor');
    assert.equal(AUTODJ.getCamelotAnchor(), '8A');
  });

  test('setCamelotAnchor with already-Camelot code passes through', () => {
    AUTODJ.setCamelotAnchor('8A');
    assert.equal(AUTODJ.getCamelotAnchor(), '8A');
  });

  test('setCamelotAnchor with unparseable input is a no-op (preserves prior anchor)', () => {
    // Audit follow-up: this used to silently CLEAR a perfectly good
    // anchor on bad input. The footgun was: callers thought they
    // were setting a new anchor and instead lost the existing one.
    // Now it's a console.warn no-op; the prior anchor survives. To
    // explicitly clear, use clearCamelotAnchor().
    AUTODJ.setCamelotAnchor('A minor');
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...a) => warnings.push(a.join(' '));
    try {
      AUTODJ.setCamelotAnchor('not a key');
    } finally {
      console.warn = origWarn;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /unparseable key/);
    assert.equal(AUTODJ.getCamelotAnchor(), '8A', 'anchor should be preserved');
  });

  test('getCamelotNeighbours returns Array derived from current anchor', () => {
    // Audit follow-up: was returning a Set, but every consumer
    // immediately spread it into an array. Returning an array
    // directly avoids the spread tax. The pure `camelotNeighbours()`
    // helper still returns a Set — its set-ness matters for songBlocked.
    AUTODJ.setCamelotAnchor('8A');
    const n = AUTODJ.getCamelotNeighbours();
    assert.ok(Array.isArray(n), 'should be array');
    assert.equal(n.length, 6);
    assert.ok(n.includes('8A'));
    assert.ok(n.includes('8B'));
  });

  test('getCamelotNeighbours returns null when no anchor set', () => {
    assert.equal(AUTODJ.getCamelotNeighbours(), null);
  });

  test('clearCamelotAnchor wipes both anchor and neighbours', () => {
    AUTODJ.setCamelotAnchor('8A');
    AUTODJ.clearCamelotAnchor();
    assert.equal(AUTODJ.getCamelotAnchor(), null);
    assert.equal(AUTODJ.getCamelotNeighbours(), null);
  });
});

describe('resetAnchors()', () => {
  test('clears BPM history AND Camelot anchor', () => {
    AUTODJ.pushBpmHistory(124);
    AUTODJ.setCamelotAnchor('8A');
    AUTODJ.resetAnchors();
    assert.deepEqual(AUTODJ.state.bpmHistory, []);
    assert.equal(AUTODJ.state.camelotAnchor, null);
  });

  test('does NOT clear artist history (separate concept)', () => {
    AUTODJ.pushArtistHistory('Foo');
    AUTODJ.pushBpmHistory(124);
    AUTODJ.resetAnchors();
    assert.deepEqual(AUTODJ.state.djArtistHistory, ['Foo']);
  });
});

describe('artist cooldown', () => {
  test('pushArtistHistory appends with trim', () => {
    AUTODJ.pushArtistHistory('  Foo  ');
    AUTODJ.pushArtistHistory('Bar');
    assert.deepEqual(AUTODJ.state.djArtistHistory, ['Foo', 'Bar']);
  });

  test('ignores empty / whitespace-only entries', () => {
    AUTODJ.pushArtistHistory('');
    AUTODJ.pushArtistHistory('   ');
    AUTODJ.pushArtistHistory(null);
    AUTODJ.pushArtistHistory('Foo');
    assert.deepEqual(AUTODJ.state.djArtistHistory, ['Foo']);
  });

  test('dedup: case-insensitive + dot-stripped', () => {
    AUTODJ.pushArtistHistory('M.I.A.');
    AUTODJ.pushArtistHistory('Foo');
    AUTODJ.pushArtistHistory('mia');  // same normalised form
    // Latest spelling wins, prior entry removed.
    assert.deepEqual(AUTODJ.state.djArtistHistory, ['Foo', 'mia']);
  });

  // Audit follow-up: the client cooldown normaliser now mirrors
  // src/util/artist-normalize.js verbatim. These cases would have
  // produced redundant entries under the old looser normaliser.
  test('dedup: diacritic-folded ("Beyoncé" == "Beyonce")', () => {
    AUTODJ.pushArtistHistory('Beyoncé');
    AUTODJ.pushArtistHistory('Beyonce');
    assert.equal(AUTODJ.state.djArtistHistory.length, 1);
  });

  test('dedup: slashes stripped ("AC/DC" == "ACDC")', () => {
    AUTODJ.pushArtistHistory('AC/DC');
    AUTODJ.pushArtistHistory('ACDC');
    assert.equal(AUTODJ.state.djArtistHistory.length, 1);
  });

  test('dedup: ampersand-fold ("Foo & Bar" == "Foo and Bar")', () => {
    AUTODJ.pushArtistHistory('Foo & Bar');
    AUTODJ.pushArtistHistory('Foo and Bar');
    assert.equal(AUTODJ.state.djArtistHistory.length, 1);
  });

  test('dedup: whitespace collapse ("Foo  Bar" == "Foo Bar")', () => {
    AUTODJ.pushArtistHistory('Foo  Bar');     // two spaces
    AUTODJ.pushArtistHistory('Foo Bar');
    assert.equal(AUTODJ.state.djArtistHistory.length, 1);
  });

  test('ring buffer caps at ARTIST_COOLDOWN_LIMIT', () => {
    for (let i = 0; i < AUTODJ._internals.ARTIST_COOLDOWN_LIMIT + 3; i++) {
      AUTODJ.pushArtistHistory(`Artist${i}`);
    }
    assert.equal(AUTODJ.state.djArtistHistory.length, AUTODJ._internals.ARTIST_COOLDOWN_LIMIT);
  });

  test('clearArtistHistory empties the buffer', () => {
    AUTODJ.pushArtistHistory('Foo');
    AUTODJ.clearArtistHistory();
    assert.deepEqual(AUTODJ.state.djArtistHistory, []);
  });

  test('getArtistHistory returns a copy (not the live reference)', () => {
    AUTODJ.pushArtistHistory('Foo');
    const snap = AUTODJ.getArtistHistory();
    snap.push('Mutated');
    // The mutation on the returned array MUST NOT leak into state.
    assert.deepEqual(AUTODJ.state.djArtistHistory, ['Foo']);
  });
});

describe('counted-filepath tracking (audit follow-up #10)', () => {
  // Replaces the previous _djCounted-flag-on-metadata pattern.
  // First-time play of a DJ pick marks the filepath as counted;
  // back-navigation to the same filepath finds it already counted
  // and skips the duplicate BPM history push.

  test('isFilepathCounted is false before markFilepathCounted', () => {
    assert.equal(AUTODJ.isFilepathCounted('foo.flac'), false);
  });

  test('markFilepathCounted persists; isFilepathCounted reads back true', () => {
    AUTODJ.markFilepathCounted('foo.flac');
    assert.equal(AUTODJ.isFilepathCounted('foo.flac'), true);
    assert.ok(AUTODJ.state.djCountedFilepaths.includes('foo.flac'));
  });

  test('markFilepathCounted is idempotent', () => {
    AUTODJ.markFilepathCounted('foo.flac');
    AUTODJ.markFilepathCounted('foo.flac');
    AUTODJ.markFilepathCounted('foo.flac');
    assert.equal(AUTODJ.state.djCountedFilepaths.length, 1);
  });

  test('ring buffer caps at COUNTED_FILEPATHS_LIMIT, oldest evicts first', () => {
    const cap = AUTODJ._internals.COUNTED_FILEPATHS_LIMIT;
    for (let i = 0; i < cap + 5; i++) {
      AUTODJ.markFilepathCounted(`song${i}.flac`);
    }
    assert.equal(AUTODJ.state.djCountedFilepaths.length, cap);
    // The earliest 5 should have aged out.
    assert.equal(AUTODJ.isFilepathCounted('song0.flac'), false);
    assert.equal(AUTODJ.isFilepathCounted('song4.flac'), false);
    assert.equal(AUTODJ.isFilepathCounted(`song${cap + 4}.flac`), true);
  });

  test('empty / null filepath silently no-ops', () => {
    AUTODJ.markFilepathCounted('');
    AUTODJ.markFilepathCounted(null);
    AUTODJ.markFilepathCounted(undefined);
    assert.deepEqual(AUTODJ.state.djCountedFilepaths, []);
  });

  test('resetAnchors clears the counted-filepath ring too', () => {
    AUTODJ.markFilepathCounted('foo.flac');
    AUTODJ.markFilepathCounted('bar.flac');
    AUTODJ.resetAnchors();
    assert.deepEqual(AUTODJ.state.djCountedFilepaths, []);
  });

  test('reset() clears the counted-filepath ring', () => {
    AUTODJ.markFilepathCounted('foo.flac');
    AUTODJ.reset();
    assert.deepEqual(AUTODJ.state.djCountedFilepaths, []);
  });
});

describe('setCamelotAnchor (audit follow-up #2)', () => {
  test('valid raw key sets the anchor', () => {
    AUTODJ.setCamelotAnchor('A minor');
    assert.equal(AUTODJ.getCamelotAnchor(), '8A');
  });

  test('unparseable input warns AND preserves the existing anchor', () => {
    AUTODJ.setCamelotAnchor('A minor');
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...a) => warnings.push(a.join(' '));
    try {
      AUTODJ.setCamelotAnchor('garbage');
    } finally {
      console.warn = origWarn;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /unparseable key/);
    // Critical: prior anchor preserved.
    assert.equal(AUTODJ.getCamelotAnchor(), '8A');
  });
});

describe('setState unknown-key warning (audit follow-up #3)', () => {
  test('unknown key logs a console.warn AND is dropped', () => {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...a) => warnings.push(a.join(' '));
    try {
      AUTODJ.setState({ harmoniMixing: true });  // typo
    } finally {
      console.warn = origWarn;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /unknown key: harmoniMixing/);
    // harmonicMixing (the real key) is untouched.
    assert.equal(AUTODJ.state.harmonicMixing, false);
  });

  test('partial patch — valid keys persist, unknown keys warn-and-drop', () => {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...a) => warnings.push(a.join(' '));
    try {
      AUTODJ.setState({ bpmTolerance: 12, foo: 'bar' });
    } finally {
      console.warn = origWarn;
    }
    assert.equal(warnings.length, 1);
    assert.equal(AUTODJ.state.bpmTolerance, 12);
  });
});

describe('ignoreList passthrough (symmetric getter — audit follow-up #9)', () => {
  test('getIgnoreList returns a copy of the persisted list', () => {
    AUTODJ.setIgnoreList([5, 2, 9]);
    const out = AUTODJ.getIgnoreList();
    assert.deepEqual(out, [5, 2, 9]);
    // Returned value must not be the live reference.
    out.push(99);
    assert.deepEqual(AUTODJ.state.djIgnoreList, [5, 2, 9]);
  });
});

describe('state Proxy guards against direct mutation', () => {
  // Audit follow-up: state was exported mutable, so a caller doing
  // `AUTODJ.state.foo = bar` would bypass setState() AND localStorage.
  // The Proxy now warns AND self-heals by routing the assignment
  // through setState — never silently corrupts persistence.

  test('direct write logs a console.warn and still persists via setState', () => {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    try {
      AUTODJ.state.bpmContinuity = true;
    } finally {
      console.warn = origWarn;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /direct mutation of state\.bpmContinuity/);
    // Self-heal: the assignment still went through, AND persisted.
    assert.equal(AUTODJ.state.bpmContinuity, true);
    assert.equal(localStorage.getItem('mstream-dj-bpmContinuity'), 'true');
  });

  test('setState itself does NOT trigger the Proxy warning', () => {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    try {
      AUTODJ.setState({ bpmTolerance: 14 });
    } finally {
      console.warn = origWarn;
    }
    assert.equal(warnings.length, 0, `setState should not warn (got: ${warnings.join(', ')})`);
    assert.equal(AUTODJ.state.bpmTolerance, 14);
  });

  test('_rehydrate does NOT trigger the Proxy warning', () => {
    localStorage.setItem('mstream-dj-bpmTolerance', '11');
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    try {
      AUTODJ._internals.rehydrate();
    } finally {
      console.warn = origWarn;
    }
    assert.equal(warnings.length, 0);
    assert.equal(AUTODJ.state.bpmTolerance, 11);
  });
});

describe('ignoreList passthrough', () => {
  test('setIgnoreList stores the array verbatim', () => {
    AUTODJ.setIgnoreList([5, 2, 9]);
    assert.deepEqual(AUTODJ.state.djIgnoreList, [5, 2, 9]);
  });

  test('non-array input falls back to []', () => {
    AUTODJ.setIgnoreList('not an array');
    assert.deepEqual(AUTODJ.state.djIgnoreList, []);
    AUTODJ.setIgnoreList(null);
    assert.deepEqual(AUTODJ.state.djIgnoreList, []);
  });
});
