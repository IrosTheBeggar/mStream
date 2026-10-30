/**
 * The mood filter's one definition (src/api/mood-filter.js): what each
 * group value means over track_moods scores — run as SQL against an
 * in-memory table, the way every route splices the predicate — the request
 * forms it accepts, and how the Discover fan-out treats a connected server
 * that answers without the filter's echo (discovery-federation.js
 * mergePeerAnswers).
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  MOOD_THRESHOLD, moodFits, moodPredicate, normalizeMoods, parseMoods, parseMoodsQuery, trackMoodClause,
} from '../../src/api/mood-filter.js';
import { EMBEDDING_MODELS } from '../../src/db/discovery-features-lib.js';
import { mergePeerAnswers } from '../../src/api/discovery-federation.js';

const HEADS = ['happy', 'sad', 'relaxed', 'aggressive', 'instrumental', 'acoustic', 'party', 'danceable'];
// Scores in HEADS order.
const SONGS = {
  bright: [0.8, 0.1, 0.2, 0.7, 0.1, 0.0, 0.9, 0.9],    // happy · aggressive · vocals · party, danceable
  calm: [0.2, 0.1, 0.8, 0.1, 0.9, 0.0, 0.1, 0.6],      // neutral · relaxed · instrumental · danceable
  blue: [0.3, 0.6, 0.7, 0.1, 0.8, 0.7, 0.0, 0.1],      // sad · relaxed · instrumental · acoustic
  tie: [0.5, 0.5, 0.5, 0.5, 0.5, 0.0, 0.5, 0.1],       // a tie goes to happy / relaxed; 0.5 holds
  torn: [0.6, 0.7, 0.3, 0.6, 0.2, 0.6, 0.0, 0.1],      // both over: the stronger wins — sad · aggressive
  flat: [0.1, 0.1, 0.2, 0.2, 0.4, 0.0, 0.0, 0.0],      // neutral · neutral · vocals
  gap: [0.9, null, 0.8, 0.1, 0.9, 0.0, 0.0, 0.0],      // no sad score: no valence value holds
};

function songsDb(songs = SONGS) {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE track_moods (track_id INTEGER PRIMARY KEY, danceable REAL, happy REAL, sad REAL,
    relaxed REAL, aggressive REAL, party REAL, acoustic REAL, instrumental REAL)`);
  const ins = d.prepare(`INSERT INTO track_moods (track_id, ${HEADS.join(', ')}) VALUES (?, ${HEADS.map(() => '?').join(', ')})`);
  const names = Object.keys(songs);
  names.forEach((name, i) => ins.run(i + 1, ...songs[name]));
  const match = (moods) => d.prepare(`SELECT track_id FROM track_moods tm WHERE ${moodPredicate(moods)}`).all()
    .map((r) => names[r.track_id - 1]).sort();
  const id = (name) => names.indexOf(name) + 1;
  return { d, match, id };
}

describe('mood filter: what a song matches', () => {
  const { match } = songsDb();

  test('happy / neutral / sad: one value per scored song, ties to happy', () => {
    assert.deepEqual(match({ valence: 'happy' }), ['bright', 'tie']);
    assert.deepEqual(match({ valence: 'sad' }), ['blue', 'torn']);
    assert.deepEqual(match({ valence: 'neutral' }), ['calm', 'flat']);
  });

  test('relaxed / neutral / aggressive: the same rule on the other pair', () => {
    assert.deepEqual(match({ energy: 'relaxed' }), ['blue', 'calm', 'gap', 'tie']);
    assert.deepEqual(match({ energy: 'aggressive' }), ['bright', 'torn']);
    assert.deepEqual(match({ energy: 'neutral' }), ['flat']);
  });

  test('instrumental / vocals split at the threshold', () => {
    assert.deepEqual(match({ voice: 'instrumental' }), ['blue', 'calm', 'gap', 'tie']);
    assert.deepEqual(match({ voice: 'vocals' }), ['bright', 'flat', 'torn']);
  });

  test('tags: every picked tag must hold', () => {
    assert.deepEqual(match({ tags: ['acoustic'] }), ['blue', 'torn']);
    assert.deepEqual(match({ tags: ['party', 'danceable'] }), ['bright']);
  });

  test('groups combine: a song meets every one', () => {
    assert.deepEqual(match({ valence: 'neutral', energy: 'relaxed', voice: 'instrumental' }), ['calm']);
    assert.deepEqual(match({ energy: 'relaxed', voice: 'instrumental', tags: ['danceable'] }), ['calm']);
  });

  test('a missing score fails its scale, never the others', () => {
    for (const valence of ['happy', 'neutral', 'sad']) {
      assert.ok(!match({ valence }).includes('gap'), valence);
    }
    assert.ok(match({ voice: 'instrumental' }).includes('gap'));
  });

  test('no group: the predicate holds for every row', () => {
    assert.deepEqual(match({}), Object.keys(SONGS).sort());
  });

  describe('strict', () => {
    // mild is neutral, neutral and vocals — none of them strongly.
    const { match: strict } = songsDb({ ...SONGS, mild: [0.4, 0.2, 0.4, 0.2, 0.4, 0.0, 0.0, 0.0] });
    const both = (moods) => [strict(moods), strict({ ...moods, strict: true })];

    test('a head that must hold holds at 0.7', () => {
      assert.deepEqual(both({ energy: 'relaxed' }), [['blue', 'calm', 'gap', 'tie'], ['blue', 'calm', 'gap']]);
      assert.deepEqual(both({ valence: 'happy' }), [['bright', 'tie'], ['bright']]);
      assert.deepEqual(both({ voice: 'instrumental' }), [['blue', 'calm', 'gap', 'tie'], ['blue', 'calm', 'gap']]);
      assert.deepEqual(both({ tags: ['acoustic'] }), [['blue', 'torn'], ['blue']]);
    });

    test('one that must not hold, at 0.3 or less', () => {
      assert.deepEqual(both({ valence: 'neutral' }), [['calm', 'flat', 'mild'], ['calm', 'flat']]);
      assert.deepEqual(both({ energy: 'neutral' }), [['flat', 'mild'], ['flat']]);
      assert.deepEqual(both({ voice: 'vocals' }), [['bright', 'flat', 'mild', 'torn'], ['bright', 'torn']]);
    });

    test('the stronger head still wins a scale', () => {
      assert.deepEqual(both({ valence: 'sad' }), [['blue', 'torn'], ['torn']]);
      // Both over 0.7: strongly sad, never happy.
      const { match: rival } = songsDb({ rival: [0.8, 0.9, 0.1, 0.1, 0.1, 0.0, 0.0, 0.0] });
      assert.deepEqual(rival({ valence: 'sad', strict: true }), ['rival']);
      assert.deepEqual(rival({ valence: 'happy', strict: true }), []);
    });
  });

  test("a song list's fits: strong when the strict filter keeps the song too", () => {
    const { d, id } = songsDb();
    const relaxed = ['blue', 'calm', 'gap', 'tie'];
    const fit = moodFits(d, { energy: 'relaxed' }, relaxed.map(id));
    assert.deepEqual(relaxed.map((n) => fit(id(n))), ['strong', 'strong', 'strong', 'close']);
    const tied = moodFits(d, { energy: 'relaxed', strict: true }, [id('blue')]);
    assert.equal(tied(id('blue')), 'strong', 'every song of a strict list');
  });

  test('the song lists\' clause: a song by id, never one without scores', () => {
    const d = new DatabaseSync(':memory:');
    d.exec(`CREATE TABLE track_moods (track_id INTEGER PRIMARY KEY, danceable REAL, happy REAL, sad REAL,
      relaxed REAL, aggressive REAL, party REAL, acoustic REAL, instrumental REAL);
      CREATE TABLE songs (id INTEGER PRIMARY KEY, name TEXT)`);
    const ins = d.prepare(`INSERT INTO track_moods (track_id, ${HEADS.join(', ')}) VALUES (?, ${HEADS.map(() => '?').join(', ')})`);
    ins.run(1, ...SONGS.calm);
    ins.run(2, ...SONGS.bright);
    d.exec("INSERT INTO songs VALUES (1, 'calm'), (2, 'bright'), (3, 'unscored')");
    const names = (moods) => d.prepare(`SELECT s.name FROM songs s WHERE ${trackMoodClause(moods, 's')} ORDER BY s.id`)
      .all().map((r) => r.name);
    assert.deepEqual(names({ energy: 'relaxed' }), ['calm']);
    assert.deepEqual(names({ voice: 'vocals' }), ['bright']);
    assert.deepEqual(names({}), ['calm', 'bright'], 'no group still needs scores');
  });

  test("the threshold is every mood model's tag threshold", () => {
    const withMoods = Object.values(EMBEDDING_MODELS).filter((m) => m.moods);
    assert.ok(withMoods.length > 0);
    for (const m of withMoods) { assert.equal(m.moods.tagThreshold, MOOD_THRESHOLD); }
  });
});

describe('mood filter: request forms', () => {
  test('normalized: only the groups that filter, tags in a fixed order', () => {
    assert.deepEqual(normalizeMoods({ tags: ['danceable', 'acoustic'] }), { tags: ['acoustic', 'danceable'] });
    assert.deepEqual(normalizeMoods({ valence: 'happy', tags: [] }), { valence: 'happy' });
    assert.deepEqual(normalizeMoods({ strict: true, energy: 'relaxed' }), { energy: 'relaxed', strict: true });
    assert.deepEqual(normalizeMoods({ energy: 'relaxed', strict: false }), { energy: 'relaxed' });
    assert.equal(normalizeMoods({ strict: true }), null, 'strict alone filters nothing');
    assert.equal(normalizeMoods({ tags: [] }), null);
    assert.equal(normalizeMoods({}), null);
    assert.equal(normalizeMoods(null), null);
  });

  test('parseMoods: a strict schema — unknown groups and values are refused', () => {
    assert.equal(parseMoods(undefined), null);
    assert.equal(parseMoods(null), null);
    assert.deepEqual(parseMoods({ energy: 'relaxed', voice: 'vocals', tags: ['party'] }),
      { energy: 'relaxed', voice: 'vocals', tags: ['party'] });
    assert.deepEqual(parseMoods({ voice: 'vocals', strict: true }), { voice: 'vocals', strict: true });
    for (const bad of [{ valence: 'angry' }, { mood: 'happy' }, { tags: ['party', 'party'] }, { tags: ['sad'] }, 'relaxed', [],
      { energy: 'relaxed', strict: 'yes' }]) {
      assert.throws(() => parseMoods(bad), { name: 'ValidationError' }, JSON.stringify(bad));
    }
  });

  test('parseMoodsQuery: one JSON object in a string, else a 400', () => {
    assert.equal(parseMoodsQuery(undefined), null);
    assert.deepEqual(parseMoodsQuery('{"energy":"relaxed"}'), { energy: 'relaxed' });
    assert.deepEqual(parseMoodsQuery('{"energy":"relaxed","strict":true}'), { energy: 'relaxed', strict: true });
    for (const bad of ['nope', ['{}'], 'x'.repeat(600)]) {
      assert.throws(() => parseMoodsQuery(bad), (err) => err.status === 400, String(bad).slice(0, 20));
    }
    assert.throws(() => parseMoodsQuery('{"energy":"sleepy"}'), { name: 'ValidationError' });
  });
});

describe('mood filter: connected servers on a filtered Discover call', () => {
  const none = () => ({ mbids: new Set(), artistTitles: new Set(), artists: new Set() });
  const peerRow = (id) => ({ id, name: `P${id}`, last_seen: null, use_discovery: 1 });
  const answer = (title, extra = {}) => ({
    status: 'fulfilled',
    value: { body: { results: [{ artist: `By ${title}`, title, similarity: 0.5, filepath: `m/${title}.mp3` }], ...extra }, at: 1 },
  });
  const peers = [peerRow(1), peerRow(2)];
  const outcomes = [answer('Kept', { moods: { energy: 'relaxed' } }), answer('Unfiltered')];

  test('a peer without the echo answered unfiltered: its rows are dropped, its entry says so', () => {
    const merged = mergePeerAnswers(peers, outcomes, { excludeSets: none(), limit: 10, moods: { energy: 'relaxed' } });
    assert.deepEqual(merged.searched, { peers: 1, unreachable: 0, mismatched: 0, moodsUnsupported: 1 });
    assert.deepEqual(merged.results.map((r) => r.title), ['Kept']);
    assert.equal(merged.peers[1].moodsUnsupported, true);
    assert.equal(merged.peers[1].reachable, true);
    assert.deepEqual(merged.peers[1].results, []);
    assert.equal('moodsUnsupported' in merged.peers[0], false);
  });

  test('an unfiltered call keeps both, and its shapes carry no mood keys', () => {
    const merged = mergePeerAnswers(peers, outcomes, { excludeSets: none(), limit: 10 });
    assert.deepEqual(merged.searched, { peers: 2, unreachable: 0, mismatched: 0 });
    assert.deepEqual(merged.results.map((r) => r.title), ['Kept', 'Unfiltered']);
    assert.equal('moodsUnsupported' in merged.peers[1], false);
  });
});
