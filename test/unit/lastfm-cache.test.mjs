/**
 * Unit tests for the Last.fm similar-artists cache TTL branching
 * (src/api/scrobbler.js's `fetchLastfmSimilarArtists`).
 *
 * Audit follow-up: distinguish "Last.fm doesn't know this artist"
 * (legit 200 with empty list → 24h TTL) from "Last.fm is having a
 * bad day" (429 / 5xx / network error / parse error → 5min TTL).
 * Without the split, a momentary upstream blip locked similar-
 * artists for that name for a full day.
 *
 * Strategy: monkey-patch globalThis.fetch with a controlled stub,
 * call fetchLastfmSimilarArtists, then peek into the cache to
 * confirm the TTL we stored. Clear the cache between cases so each
 * test starts from a known state.
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchLastfmSimilarArtists,
  _clearLastfmCache,
  _peekLastfmCache,
  _LASTFM_TTLS,
} from '../../src/api/scrobbler.js';

const API_KEY = 'fake-key';

let originalFetch;
beforeEach(() => {
  _clearLastfmCache();
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(impl) {
  globalThis.fetch = async (url, opts) => impl(url, opts);
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe('Last.fm cache TTL branching', () => {
  test('200 with non-empty list → 24h TTL', async () => {
    mockFetch(() => jsonResponse(200, {
      similarartists: { artist: [{ name: 'Foo' }, { name: 'Bar' }] },
    }));
    const out = await fetchLastfmSimilarArtists('TestArtist', API_KEY);
    assert.deepEqual(out, ['Foo', 'Bar']);
    const peek = _peekLastfmCache('TestArtist');
    assert.ok(peek);
    assert.equal(peek.ttl, _LASTFM_TTLS.ok);
    assert.deepEqual(peek.names, ['Foo', 'Bar']);
  });

  test('200 with empty list → 24h TTL (genuinely no similar artists)', async () => {
    mockFetch(() => jsonResponse(200, { similarartists: { artist: [] } }));
    const out = await fetchLastfmSimilarArtists('TestArtist', API_KEY);
    assert.deepEqual(out, []);
    const peek = _peekLastfmCache('TestArtist');
    assert.equal(peek.ttl, _LASTFM_TTLS.ok);
  });

  test('429 (rate limited) → 5min TTL', async () => {
    mockFetch(() => jsonResponse(429, {}));
    const out = await fetchLastfmSimilarArtists('TestArtist', API_KEY);
    assert.deepEqual(out, []);
    const peek = _peekLastfmCache('TestArtist');
    assert.equal(peek.ttl, _LASTFM_TTLS.transient,
      'rate-limited responses must use the short TTL');
  });

  test('500 (server error) → 5min TTL', async () => {
    mockFetch(() => jsonResponse(500, {}));
    await fetchLastfmSimilarArtists('TestArtist', API_KEY);
    const peek = _peekLastfmCache('TestArtist');
    assert.equal(peek.ttl, _LASTFM_TTLS.transient);
  });

  test('503 (service unavailable) → 5min TTL', async () => {
    mockFetch(() => jsonResponse(503, {}));
    await fetchLastfmSimilarArtists('TestArtist', API_KEY);
    const peek = _peekLastfmCache('TestArtist');
    assert.equal(peek.ttl, _LASTFM_TTLS.transient);
  });

  test('400 (bad request — permanent-ish) → 24h TTL', async () => {
    // A 4xx that ISN'T 429 typically means bad API key or malformed
    // request. Re-trying every 5 min would be noisy and pointless;
    // long TTL until cache eviction.
    mockFetch(() => jsonResponse(400, {}));
    await fetchLastfmSimilarArtists('TestArtist', API_KEY);
    const peek = _peekLastfmCache('TestArtist');
    assert.equal(peek.ttl, _LASTFM_TTLS.ok);
  });

  test('network error (fetch throws) → 5min TTL', async () => {
    mockFetch(() => { throw new Error('ECONNREFUSED'); });
    const out = await fetchLastfmSimilarArtists('TestArtist', API_KEY);
    assert.deepEqual(out, []);
    const peek = _peekLastfmCache('TestArtist');
    assert.equal(peek.ttl, _LASTFM_TTLS.transient);
  });

  test('200 with unparseable JSON → 5min TTL', async () => {
    mockFetch(() => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token <'); },
    }));
    const out = await fetchLastfmSimilarArtists('TestArtist', API_KEY);
    assert.deepEqual(out, []);
    const peek = _peekLastfmCache('TestArtist');
    assert.equal(peek.ttl, _LASTFM_TTLS.transient);
  });

  test('cache hit returns a fresh array (defensive clone)', async () => {
    // Two consecutive calls — first populates, second hits cache. The
    // returned array must NOT be the same reference; mutating the first
    // result must not poison the second.
    mockFetch(() => jsonResponse(200, {
      similarartists: { artist: [{ name: 'Foo' }] },
    }));
    const first = await fetchLastfmSimilarArtists('TestArtist', API_KEY);
    first.push('Mutated');
    const second = await fetchLastfmSimilarArtists('TestArtist', API_KEY);
    assert.deepEqual(second, ['Foo'], 'cache poisoned by first caller mutation');
    assert.notStrictEqual(first, second, 'cache hit returned same array reference');
  });

  test('cache key is case-folded', async () => {
    // Same artist with different casing must hit the same cache entry.
    let fetchCount = 0;
    mockFetch(() => {
      fetchCount++;
      return jsonResponse(200, { similarartists: { artist: [{ name: 'X' }] } });
    });
    await fetchLastfmSimilarArtists('TestArtist', API_KEY);
    await fetchLastfmSimilarArtists('testartist', API_KEY);
    await fetchLastfmSimilarArtists('TESTARTIST', API_KEY);
    assert.equal(fetchCount, 1, 'case-insensitive cache key should hit on each variant');
  });
});
