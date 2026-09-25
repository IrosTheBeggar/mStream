/**
 * The shared caller-side novelty chain (src/db/discovery-novelty.js) —
 * pure logic, no DB. localIdentitySets() (which reads the DBs) is covered
 * end-to-end by the p2p and federation integration suites; here we pin the
 * chain's decisions against handcrafted identity sets.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { norm, isNovel, NEAR_DUP } from '../../src/db/discovery-novelty.js';

describe('norm', () => {
  test('case, punctuation, and whitespace collide; null-ish → empty', () => {
    assert.equal(norm('The  Beatles!'), 'thebeatles');
    assert.equal(norm('the beatles'), 'thebeatles');
    assert.equal(norm('Röyksopp'), 'royksopp', 'accents fold, consistently for both sides');
    assert.equal(norm('Royksopp'), 'royksopp');
    assert.equal(norm(null), '');
    assert.equal(norm(undefined), '');
  });

  test('every script keeps its letters: two non-Latin names are two identities, not one empty one', () => {
    assert.equal(norm('Кино'), 'кино');
    assert.equal(norm('Группа крови'), 'группакрови');
    assert.notEqual(norm('Кино'), norm('Сплин'));
    assert.equal(norm('宇多田ヒカル'), '宇多田ヒカル');
    assert.notEqual(norm('宇多田ヒカル'), norm('BTS 봄날'));
    assert.equal(norm('ＡＢＣ　１２３'), 'abc123', 'compatibility forms fold to their plain letters');
    assert.equal(norm('!!! ... ???'), '', 'symbols alone are still nothing');
  });
});

describe('isNovel', () => {
  const sets = {
    mbids: new Set(['mbid-owned']),
    artistTitles: new Set([`${norm('Icarus')} ${norm('Be Somebody')}`]),
    artists: new Set([norm('Icarus')]),
  };
  const candidate = (over = {}) => ({
    artist: 'Nova', title: 'Fresh Track', recordingMbid: null, similarityVsSeed: 0.9, ...over,
  });

  test('a genuinely new track passes', () => {
    assert.equal(isNovel(sets, candidate()), true);
  });

  test('near-duplicate of the seed is dropped, boundary inclusive', () => {
    assert.equal(isNovel(sets, candidate({ similarityVsSeed: NEAR_DUP })), false);
    assert.equal(isNovel(sets, candidate({ similarityVsSeed: 0.9899 })), true);
  });

  test('owned recording MBID is dropped', () => {
    assert.equal(isNovel(sets, candidate({ recordingMbid: 'mbid-owned' })), false);
    assert.equal(isNovel(sets, candidate({ recordingMbid: 'mbid-unknown' })), true);
  });

  test('owned artist+title is dropped, however it is spelled', () => {
    assert.equal(isNovel(sets, candidate({ artist: 'ICARUS!', title: 'be somebody' })), false);
    assert.equal(isNovel(sets, candidate({ artist: 'Icarus', title: 'Different Song' })), true,
      'same artist alone is fine without newArtistsOnly');
  });

  test('newArtistsOnly drops every known artist but keeps unknown-artist rows', () => {
    assert.equal(isNovel(sets, candidate({ artist: 'Icarus', title: 'Different Song' }), { newArtistsOnly: true }), false);
    assert.equal(isNovel(sets, candidate(), { newArtistsOnly: true }), true);
    assert.equal(isNovel(sets, candidate({ artist: null, title: 'Anon Track' }), { newArtistsOnly: true }), true,
      'empty artist never matches the known-artist set');
  });
});
