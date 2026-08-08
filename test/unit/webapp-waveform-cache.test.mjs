/**
 * The browser-side waveform cache encoding in webapp/alpha/vp.js.
 *
 * Bars are held in localStorage as base64 rather than a JSON number array.
 * localStorage stores UTF-16 and isn't compressed, so JSON spends ~3.4
 * characters per bar where base64 spends 1.34 — measured 2857 chars vs
 * 1068 for one 800-bar waveform. At the 500-entry cap that is the
 * difference between fitting inside a ~5 MB origin budget and living in
 * the eviction path, dropping entries and re-fetching them forever.
 *
 * This is data the user's browser keeps, with an in-place migration for
 * entries written under the old encoding, so it is worth pinning:
 *   - every byte 0-255 survives a round trip (128-255 is where naive
 *     btoa/UTF-8 handling silently corrupts data)
 *   - pre-existing JSON entries still read, and migrate on read
 *   - corrupt or absent entries degrade to null instead of throwing
 *   - a quota error still falls through to evict-and-retry
 *
 * webapp/ has no browser test harness and is eslint-ignored, so rather
 * than re-typing the implementation (which could drift from what ships)
 * this slices the real function source out of vp.js and runs it against a
 * localStorage stub. If the functions are renamed or restructured the
 * slice fails loudly rather than silently testing nothing.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VP_PATH = path.resolve(__dirname, '..', '..', 'webapp', 'alpha', 'vp.js');

// Pull `_wfB64Encode` through the end of `_wfLsSet` out of vp.js and
// instantiate it with the few globals that block depends on.
function loadCacheFns() {
  const lines = fs.readFileSync(VP_PATH, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.includes('function _wfB64Encode'));
  const setAt = lines.findIndex((l) => l.includes('function _wfLsSet'));
  assert.ok(start >= 0, 'vp.js no longer defines _wfB64Encode — update this test');
  assert.ok(setAt > start, 'vp.js no longer defines _wfLsSet after _wfB64Encode');

  let end = setAt, depth = 0, seen = false;
  for (let i = setAt; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; seen = true; } else if (ch === '}') { depth--; }
    }
    if (seen && depth === 0) { end = i; break; }
  }
  const src = lines.slice(start, end + 1).join('\n');
  for (const fn of ['_wfB64Encode', '_wfB64Decode', '_wfLsGet', '_wfLsSet']) {
    assert.ok(src.includes(`function ${fn}`), `slice is missing ${fn}`);
  }

  const store = new Map();
  const state = { evictions: 0, failNextSet: false };
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      if (state.failNextSet) { state.failNextSet = false; throw new Error('QuotaExceededError'); }
      store.set(k, String(v));
    },
    removeItem: (k) => store.delete(k),
    key: (i) => Array.from(store.keys())[i],
    get length() { return store.size; },
  };
  const build = new Function(
    'localStorage', '_WF_LS_PREFIX', '_wfLsEvict',
    `${src}\nreturn { _wfLsGet, _wfLsSet, _wfB64Encode, _wfB64Decode };`);
  const fns = build(localStorage, 'wf2:', () => { state.evictions++; });
  return { ...fns, store, state };
}

// Spread across the whole byte range, including the 128-255 half.
const BARS = Array.from({ length: 800 }, (_, i) => (i * 7 + (i % 13) * 19) % 256);

describe('webapp waveform localStorage cache', () => {
  test('round-trips every byte value 0-255', () => {
    const { _wfB64Encode, _wfB64Decode } = loadCacheFns();
    const every = Array.from({ length: 256 }, (_, i) => i);
    const back = _wfB64Decode(_wfB64Encode(every));
    assert.equal(back.length, 256);
    for (let i = 0; i < 256; i++) {
      assert.equal(back[i], i, `byte ${i} did not survive the round trip`);
    }
  });

  test('stores bars byte-for-byte and hands back a Uint8Array', () => {
    const { _wfLsGet, _wfLsSet } = loadCacheFns();
    _wfLsSet('/music/a.mp3', BARS);
    const back = _wfLsGet('/music/a.mp3');
    assert.ok(back instanceof Uint8Array, 'renderer expects a typed array');
    assert.equal(back.length, BARS.length);
    for (let i = 0; i < BARS.length; i++) { assert.equal(back[i], BARS[i]); }
  });

  test('is at least 2x smaller than the JSON array it replaced', () => {
    const { _wfLsSet, store } = loadCacheFns();
    _wfLsSet('/music/a.mp3', BARS);
    const stored = store.get('wf2:/music/a.mp3').length;
    const asJson = JSON.stringify(BARS).length;
    assert.ok(asJson / stored >= 2,
      `expected >=2x saving, got ${(asJson / stored).toFixed(2)}x (${asJson} -> ${stored})`);
  });

  test('reads a pre-existing JSON entry and migrates it in place', () => {
    const { _wfLsGet, store } = loadCacheFns();
    store.set('wf2:/music/legacy.mp3', JSON.stringify(BARS));

    const first = _wfLsGet('/music/legacy.mp3');
    assert.ok(first, 'a legacy entry must still be usable, not discarded');
    for (let i = 0; i < BARS.length; i++) { assert.equal(first[i], BARS[i]); }

    assert.notEqual(store.get('wf2:/music/legacy.mp3')[0], '[',
      'reading a legacy entry must rewrite it in the new encoding');
    const second = _wfLsGet('/music/legacy.mp3');
    for (let i = 0; i < BARS.length; i++) { assert.equal(second[i], BARS[i]); }
  });

  test('accepts a Uint8Array as input (what a cache hit returns)', () => {
    const { _wfLsGet, _wfLsSet } = loadCacheFns();
    _wfLsSet('/music/typed.mp3', Uint8Array.from(BARS));
    const back = _wfLsGet('/music/typed.mp3');
    for (let i = 0; i < BARS.length; i++) { assert.equal(back[i], BARS[i]); }
  });

  test('missing, empty and corrupt entries yield null rather than throwing', () => {
    const { _wfLsGet, store } = loadCacheFns();
    assert.equal(_wfLsGet('/music/absent.mp3'), null);

    store.set('wf2:/music/empty.mp3', '[]');
    assert.equal(_wfLsGet('/music/empty.mp3'), null, 'an empty legacy array is not a waveform');

    store.set('wf2:/music/corrupt.mp3', '!!! not base64 !!!');
    let out;
    assert.doesNotThrow(() => { out = _wfLsGet('/music/corrupt.mp3'); });
    assert.ok(!out || out.length === 0, 'corrupt data must not surface as bars');
  });

  test('a quota error still evicts and retries once', () => {
    const { _wfLsGet, _wfLsSet, state } = loadCacheFns();
    state.failNextSet = true;
    _wfLsSet('/music/quota.mp3', BARS);
    assert.equal(state.evictions, 1, 'quota failure must trigger eviction');
    const back = _wfLsGet('/music/quota.mp3');
    assert.ok(back && back.length === BARS.length, 'the retry after eviction must succeed');
  });
});
