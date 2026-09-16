/**
 * Artist identity in the similarity index (src/db/discovery-similarity.js):
 * a catalogue row's artist is the LIBRARY track's primary artist when the
 * library still has the file (joined by canonical hash), and the folded
 * catalogue spelling only when it is gone. Pure functions, no databases:
 * artistIdentity() decides per row, groupArtists() builds the centroids, and
 * the rank/lookup helpers resolve any spelling onto the groups.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  artistIdentity, groupArtists, artistCentroid, rankArtists, rankArtistTracks,
} from '../../src/db/discovery-similarity.js';

const unit = (...xs) => {
  const v = new Float32Array(xs);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
};
const row = (hash, artist, owner, vec, genreTags = null) =>
  ({ hash, artist, title: hash, vec, genreTags, ...artistIdentity(artist, owner) });

describe('artistIdentity', () => {
  test('a library-owned row takes the library artist, whatever the catalogue spells', () => {
    const owner = { key: 'atb', name: 'ATB' };
    assert.deepEqual(artistIdentity('Atb Feat. Jansoon', owner), { artistKey: 'atb', libraryArtist: 'ATB' });
    assert.deepEqual(artistIdentity(null, owner), { artistKey: 'atb', libraryArtist: 'ATB' },
      'an untagged catalogue row still belongs to the artist the library knows');
  });

  test('an orphan row folds its catalogue spelling and has no library name', () => {
    assert.deepEqual(artistIdentity('ODESZA', undefined), { artistKey: 'odesza', libraryArtist: null });
    assert.deepEqual(artistIdentity(' Rage Against the Machine ', undefined),
      { artistKey: 'rage against the machine', libraryArtist: null });
    assert.deepEqual(artistIdentity('   ', undefined), { artistKey: null, libraryArtist: null },
      'blank stays out of the artist space');
    assert.deepEqual(artistIdentity(null, undefined), { artistKey: null, libraryArtist: null });
  });
});

describe('groupArtists', () => {
  const atb = { key: 'atb', name: 'ATB' };
  const entries = [
    // the re-split credit: the library says this track is ATB's
    row('h1', 'Atb Feat. Jansoon', atb, unit(1, 0), ['Trance']),
    row('h2', 'ATB', atb, unit(0.9, 0.436), ['Trance', 'Dance']),
    // an orphan spelled like the library artist folds onto the same group
    row('h3', 'atb', undefined, unit(0.8, 0.6), ['Dance']),
    // an orphan-only group: its display spelling is the most frequent one
    row('h4', 'Ghost', undefined, unit(0, 1)),
    row('h5', 'GHOST', undefined, unit(0.1, 0.995)),
    row('h6', 'Ghost', undefined, unit(0.2, 0.98)),
    // an untagged orphan is not an artist
    row('h7', null, undefined, unit(0.5, 0.5)),
    // an untagged row the library still owns IS one
    row('h8', null, { key: 'x', name: 'X' }, unit(0.7, 0.7)),
  ];
  const artists = groupArtists(entries, 2);

  test('one group per identity, keyed by the library key where the library knows the track', () => {
    assert.deepEqual([...artists.keys()].sort(), ['atb', 'ghost', 'x']);
    assert.equal(artists.get('atb').analyzedCount, 3, 'the credit row, the exact row and the folded orphan');
    assert.equal(artists.get('ghost').analyzedCount, 3);
    assert.equal(artists.get('x').analyzedCount, 1);
  });

  test('names: the library\'s where it owns a row, the most frequent catalogue spelling otherwise', () => {
    assert.equal(artists.get('atb').name, 'ATB');
    assert.equal(artists.get('ghost').name, 'Ghost', 'Ghost ×2 beats GHOST ×1');
    assert.equal(artists.get('x').name, 'X');
  });

  test('centroids are unit vectors of the group mean, with the group\'s top tags', () => {
    const a = artists.get('atb');
    const norm = Math.sqrt(a.vec[0] ** 2 + a.vec[1] ** 2);
    assert.ok(Math.abs(norm - 1) < 1e-5, `centroid re-normalized, got |v| = ${norm}`);
    const mean = [(1 + 0.9 + 0.8) / 3, (0 + 0.436 + 0.6) / 3];
    const mn = Math.sqrt(mean[0] ** 2 + mean[1] ** 2);
    assert.ok(Math.abs(a.vec[0] - mean[0] / mn) < 1e-3 && Math.abs(a.vec[1] - mean[1] / mn) < 1e-3);
    assert.deepEqual(a.topTags, ['Trance', 'Dance']);
    assert.equal(artists.get('x').topTags, null, 'no tags → null, not []');
  });

  test('lookups resolve any spelling of a library artist onto its group, and never a credit string', () => {
    const index = { entries, artists };
    assert.equal(artistCentroid(index, ' atb '), artists.get('atb'));
    assert.equal(artistCentroid(index, 'ATB'), artists.get('atb'));
    assert.equal(artistCentroid(index, 'Atb Feat. Jansoon'), undefined,
      'the credit is not an artist — its rows belong to ATB');
    assert.equal(artistCentroid(index, 'Jansoon'), undefined, 'the featured artist gets nothing from the credit');

    const ranked = rankArtists(index, 'atb');
    assert.deepEqual(ranked.map((r) => r.artistKey), ['x', 'ghost'], 'X (0.7,0.7) is nearer ATB than Ghost');
    assert.deepEqual(ranked.map((r) => r.artist), ['X', 'Ghost'], 'library name for X, catalogue spelling for the orphan group');
    assert.equal(rankArtists(index, 'Nobody'), null);

    const doorways = rankArtistTracks(index, 'ATB', unit(1, 0));
    assert.deepEqual(doorways.map((d) => d.entry.hash), ['h1', 'h2', 'h3'],
      "all three of ATB's rows, the credit-spelled one first (it IS the seed vector)");
  });
});
