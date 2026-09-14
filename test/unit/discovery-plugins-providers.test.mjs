/**
 * Catalogue plug-ins, pure parts:
 *   - match.js: the scoring that keeps a remaster/live/karaoke result from
 *     becoming "the" preview, ISRC as a hard verdict, length as a gate;
 *   - deezer / itunes: row mapping from each API's shape and choose() over
 *     fetched candidates (the HTTP layer is covered by the integration suite
 *     against local mocks);
 *   - federation-play: the URL join, and every reason it answers null;
 *   - http.js: the token bucket and the TTL cache.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { tokens, textSimilarity, scoreCandidate, pickBestMatch, MIN_SCORE } from '../../src/discovery-plugins/match.js';
import { normalizeRecommendation } from '../../src/discovery-plugins/recommendation.js';
import * as deezer from '../../src/discovery-plugins/plugins/deezer.js';
import * as itunes from '../../src/discovery-plugins/plugins/itunes.js';
import { playFor, streamPath } from '../../src/discovery-plugins/plugins/federation-play.js';
import { RateLimiter, TtlCache, providerError } from '../../src/discovery-plugins/http.js';

const REC = normalizeRecommendation({ artist: 'Compat Artist', title: 'Opening', album: 'First Album', duration: 216 });

describe('match', () => {
  test('tokens strip remaster/live noise and punctuation', () => {
    assert.deepEqual(tokens('Opening (2019 Remaster)'), ['opening']);
    assert.deepEqual(tokens('Help! - Live at the BBC'), ['help', 'live', 'at', 'the', 'bbc']);
    assert.deepEqual(tokens(null), []);
  });

  test('textSimilarity: equal after normalisation → 1, containment → 0.85, disjoint → 0', () => {
    assert.equal(textSimilarity('The Beatles', 'the beatles!'), 1);
    assert.equal(textSimilarity('Opening', 'Opening (2019 Remaster)'), 1, 'noise is stripped before comparing');
    assert.equal(textSimilarity('Opening', 'Opening Night'), 0.85);
    assert.equal(textSimilarity('Opening', 'Closing'), 0);
  });

  test('the right song scores high, a cover by another artist low, a different recording length is rejected', () => {
    const right = { title: 'Opening', artist: 'Compat Artist', album: 'First Album', durationSec: 217 };
    const cover = { title: 'Opening', artist: 'Karaoke Kings', album: 'Sing Along Vol. 3', durationSec: 216 };
    const longer = { title: 'Opening', artist: 'Compat Artist', album: 'Live', durationSec: 260 };
    assert.ok(scoreCandidate(REC, right) > 0.95, `right=${scoreCandidate(REC, right)}`);
    assert.equal(scoreCandidate(REC, cover), 0, 'no artist overlap → 0');
    assert.equal(scoreCandidate(REC, longer), null, 'far outside the length window → hard reject');
  });

  test('ISRC agreement is a hard verdict either way', () => {
    const rec = normalizeRecommendation({ artist: 'X', title: 'Y', isrc: 'GBCMP9800001' });
    assert.equal(scoreCandidate(rec, { title: 'Other', artist: 'Someone', isrc: 'gbcmp9800001' }), 1);
    assert.equal(scoreCandidate(rec, { title: 'Y', artist: 'X', isrc: 'GBCMP9800002' }), null);
  });

  test('pickBestMatch returns null under MIN_SCORE and keeps catalogue order on ties', () => {
    assert.equal(pickBestMatch(REC, [{ title: 'Closing', artist: 'Compat Artist' }]), null);
    const a = { title: 'Opening', artist: 'Compat Artist', id: 'first' };
    const b = { title: 'Opening', artist: 'Compat Artist', id: 'second' };
    assert.equal(pickBestMatch(REC, [a, b]).candidate.id, 'first');
    assert.ok(MIN_SCORE > 0.5 && MIN_SCORE < 1);
  });
});

describe('deezer plug-in', () => {
  const row = (over = {}) => ({
    id: 1, title: 'Opening', duration: 216, preview: 'https://cdn.deezer.example/p.mp3', link: 'https://www.deezer.com/track/1',
    artist: { name: 'Compat Artist' }, album: { title: 'First Album', cover_medium: 'https://cdn.deezer.example/c.jpg' }, ...over,
  });

  test('maps a Deezer track row and refuses non-http preview URLs', () => {
    const c = deezer.toCandidate(row());
    assert.equal(c.durationSec, 216);
    assert.equal(c.artist, 'Compat Artist');
    assert.equal(c.artwork, 'https://cdn.deezer.example/c.jpg');
    assert.equal(deezer.toCandidate(row({ preview: 'javascript:alert(1)' })).preview, null);
    assert.equal(deezer.toCandidate(null), null);
  });

  test('choose picks the matching track and yields the preview shape', () => {
    const chosen = deezer.choose(REC, [
      deezer.toCandidate(row({ id: 9, title: 'Opening (Karaoke Version)', artist: { name: 'Karaoke Kings' } })),
      deezer.toCandidate(row({ id: 2 })),
    ]);
    assert.equal(chosen.provider, 'deezer');
    assert.equal(chosen.url, 'https://cdn.deezer.example/p.mp3');
    assert.equal(chosen.seconds, 30);
    assert.equal(chosen.link, 'https://www.deezer.com/track/1');
    assert.ok(chosen.match > 0.9);
    assert.equal(deezer.choose(REC, [deezer.toCandidate(row({ preview: '' }))]), null, 'a match without a preview is no preview');
  });
});

describe('itunes plug-in', () => {
  const row = (over = {}) => ({
    wrapperType: 'track', kind: 'song', trackId: 5, trackName: 'Opening', artistName: 'Compat Artist', collectionName: 'First Album',
    trackTimeMillis: 216000, previewUrl: 'https://audio-ssl.itunes.example/p.m4a', trackViewUrl: 'https://music.apple.com/us/album/opening/1?i=5',
    artworkUrl100: 'https://is1.example/100x100bb.jpg', ...over,
  });

  test('maps a song result, drops non-song results and converts millis', () => {
    const c = itunes.toCandidate(row());
    assert.equal(c.durationSec, 216);
    assert.equal(c.link, 'https://music.apple.com/us/album/opening/1?i=5');
    assert.equal(itunes.toCandidate(row({ wrapperType: 'collection' })), null);
    assert.equal(itunes.toCandidate(row({ kind: 'music-video' })), null);
  });

  test('choose: search results are matched, ISRC lookups are taken as-is, attribution travels', () => {
    const matched = itunes.choose(REC, [itunes.toCandidate(row({ trackName: 'Opening (Live)', artistName: 'Someone Else' })), itunes.toCandidate(row())]);
    assert.equal(matched.provider, 'itunes');
    assert.equal(matched.attribution, 'Provided courtesy of iTunes');
    assert.equal(matched.url, 'https://audio-ssl.itunes.example/p.m4a');
    const exact = itunes.choose(REC, [itunes.toCandidate(row({ trackName: 'Completely Different Name' }))], { exact: true });
    assert.equal(exact.match, 1, 'an ISRC hit is authoritative regardless of the name');
    assert.equal(itunes.choose(REC, [], { exact: true }), null);
  });
});

describe('federation-play plug-in', () => {
  const ctx = { federationEnabled: true, getPeer: (id) => (id === 7 ? { id: 7, name: 'Peer F' } : null) };
  const rec = (over = {}) => normalizeRecommendation({
    artist: 'Ana', title: 'Alpha Song', source: 'federation', filepath: 'shared/Ana/Alpha Song #1.mp3', peer: { id: 7, name: 'Peer F' }, ...over,
  });

  test('joins peer id and the peer-side path into the stream proxy URL, per-segment encoded', () => {
    const play = playFor(rec(), ctx);
    assert.equal(play.kind, 'stream');
    assert.equal(play.url, '/api/v1/federation/peers/7/stream/shared/Ana/Alpha%20Song%20%231.mp3');
    assert.deepEqual(play.peer, { id: 7, name: 'Peer F' });
    assert.equal(streamPath(7, 'a/../b/./c'), '/api/v1/federation/peers/7/stream/a/b/c', 'dot segments dropped');
  });

  test('answers null for a network row, an unknown peer, a missing path, or federation off', () => {
    assert.equal(playFor(rec({ source: 'p2p' }), ctx), null);
    assert.equal(playFor(rec({ peer: { id: 8, name: 'Nope' } }), ctx), null);
    assert.equal(playFor(rec({ filepath: null }), ctx), null);
    assert.equal(playFor(rec({ peer: { id: 'x' } }), ctx), null);
    assert.equal(playFor(rec(), { ...ctx, federationEnabled: false }), null);
  });
});

describe('http helpers', () => {
  test('RateLimiter refills continuously and never blocks', () => {
    let now = 0;
    const l = new RateLimiter({ tokens: 2, perMs: 1000, now: () => now });
    assert.equal(l.take(), true);
    assert.equal(l.take(), true);
    assert.equal(l.take(), false, 'bucket empty');
    now = 500;
    assert.equal(l.take(), true, 'half the window → one token back');
    assert.equal(l.take(), false);
    now = 5000;
    assert.equal(l.take(2), true, 'refill caps at capacity');
    assert.equal(l.take(), false);
  });

  test('TtlCache distinguishes "not cached" from a cached null, expires, and evicts LRU', () => {
    let now = 0;
    const c = new TtlCache({ ttlMs: 100, max: 2, now: () => now });
    assert.equal(c.get('a'), undefined);
    c.set('a', null);
    assert.equal(c.get('a'), null, 'a cached "nothing found" is still a hit');
    c.set('b', 1);
    c.get('a');            // touch a → b is now least recently used
    c.set('c', 2);
    assert.equal(c.get('b'), undefined, 'evicted');
    assert.equal(c.get('a'), null);
    now = 200;
    assert.equal(c.get('a'), undefined, 'expired');
  });

  test('providerError carries the status the route passes through', () => {
    assert.equal(providerError('x', 429).status, 429);
    assert.equal(providerError('x').status, 502);
  });
});
