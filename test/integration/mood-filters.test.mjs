/**
 * Mood filters on the browse lists (src/api/mood-filter.js): /db/albums and
 * /db/artists take an optional `moods` filter and keep the albums / artists
 * MORE than half of whose analysed songs match it; every answer carries
 * `moods` — the filter applied, {} when none — while the server has mood
 * scores, and leaves the key out (filtering nothing) when it has none. The
 * song lists, /db/rated and /db/recent/added, take the same filter per
 * song; their answers are bare arrays, so they carry no echo (clients go by
 * server-info's `moodFilters`). Auto DJ's /db/random-songs takes it as an
 * always-on condition — never relaxed, so a filter nothing meets is a 400 —
 * and echoes it like the browse lists. Every route takes a `threshold`
 * (each group holds at it; what must not hold stays under 1 − it), and a
 * filtered song list's songs carry their `moodMatch`.
 *
 * The fixture library's songs get scores written straight into track_moods
 * after the scan, the way the mood sync would. 'Descent' gets none (not
 * analysed yet): it counts toward nothing.
 *
 *   Icarus · Be Somebody   Be Somebody  happy · aggressive · vocals · party, danceable
 *                          Rise         happy · aggressive · vocals · party, danceable
 *                          Orbit        neutral · relaxed · instrumental · danceable
 *   Icarus · Later Works   Return       sad · relaxed · instrumental · acoustic
 *                          Descent      (no scores)
 *   Vosto · Night Drive    Highway      neutral (not strongly) · relaxed · instrumental
 *                          Neon         happy (a tie) · relaxed · instrumental · danceable
 *                          Static       sad · aggressive · vocals (not strongly) · acoustic
 *   Vosto · Untitled EP    Sketch 1     happy · relaxed · instrumental · party (all on 0.5)
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../helpers/server.mjs';

const HEADS = ['happy', 'sad', 'relaxed', 'aggressive', 'instrumental', 'acoustic', 'party', 'danceable'];
const SCORES = {
  'Be Somebody': [0.8, 0.1, 0.2, 0.7, 0.1, 0.0, 0.9, 0.9],
  Rise: [0.7, 0.2, 0.1, 0.8, 0.2, 0.0, 0.8, 0.8],
  Orbit: [0.2, 0.1, 0.8, 0.1, 0.9, 0.0, 0.1, 0.6],
  Return: [0.3, 0.6, 0.7, 0.1, 0.8, 0.7, 0.0, 0.1],
  Highway: [0.4, 0.2, 0.9, 0.0, 0.9, 0.0, 0.0, 0.2],
  Neon: [0.6, 0.6, 0.6, 0.3, 0.7, 0.0, 0.0, 0.7],
  Static: [0.2, 0.7, 0.3, 0.6, 0.4, 0.6, 0.0, 0.1],
  'Sketch 1': [0.5, 0.5, 0.5, 0.5, 0.5, 0.0, 0.5, 0.1],
};

let server;
let dbPath;

async function call(method, route, body) {
  const r = await fetch(`${server.baseUrl}${route}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: r.status === 200 ? await r.json() : await r.text() };
}
const albums = (moods) => call('POST', '/api/v1/db/albums', moods === undefined ? {} : { moods });
const artists = (body) => call('POST', '/api/v1/db/artists', body);
const names = (r) => r.body.albums.map((a) => a.name);
const rated = (moods) => call('POST', '/api/v1/db/rated', moods === undefined ? {} : { moods });
const recent = (limit, moods) => call('POST', '/api/v1/db/recent/added', { limit, ...(moods !== undefined && { moods }) });
const titles = (r) => r.body.map((s) => s.metadata.title);
const dj = (body) => call('POST', '/api/v1/db/random-songs', body);
const picked = (r) => r.body.songs.map((s) => s.metadata.title);

// Which songs each value holds for, by the scores above ('Descent' has none).
const RELAXED = new Set(['Orbit', 'Return', 'Highway', 'Neon', 'Sketch 1']);
// ...and strongly (0.7 or more): Neon is at 0.6, Sketch 1 at 0.5.
const STRONGLY_RELAXED = new Set(['Orbit', 'Return', 'Highway']);
const matches = (r) => r.body.map((s) => [s.metadata.title, s.moodMatch]);
const relaxedScore = (title) => SCORES[title][HEADS.indexOf('relaxed')];

before(async () => {
  server = await startServer();
  dbPath = path.join(server.tmpDir, 'db', 'mstream.db');
  const db = new DatabaseSync(dbPath);
  try {
    const ins = db.prepare(`INSERT INTO track_moods (track_id, ${HEADS.join(', ')})
      SELECT id, ${HEADS.map(() => '?').join(', ')} FROM tracks WHERE title = ?`);
    for (const [title, scores] of Object.entries(SCORES)) {
      assert.equal(ins.run(...scores, title).changes, 1, title);
    }
  } finally {
    db.close();
  }
});

after(async () => {
  await server?.stop();
});

describe('/db/albums mood filter', () => {
  test('no filter: every album, and the answer says it can filter', async () => {
    const r = await albums();
    assert.equal(r.status, 200);
    assert.deepEqual(names(r), ['Be Somebody', 'Later Works', 'Night Drive', 'Untitled EP']);
    assert.deepEqual(r.body.moods, {});
  });

  test('an album needs MORE than half of its analysed songs to match', async () => {
    const r = await albums({ energy: 'relaxed' });
    // Be Somebody: only Orbit (1 of 3). Later Works: Return (1 of 1 —
    // Descent has no scores). Night Drive: Highway + Neon (2 of 3).
    assert.deepEqual(names(r), ['Later Works', 'Night Drive', 'Untitled EP']);
    assert.deepEqual(r.body.moods, { energy: 'relaxed' }, 'the filter it applied comes back');
    assert.deepEqual(names(await albums({ energy: 'aggressive' })), ['Be Somebody']);
  });

  test('groups and tags combine per song; tags come back in a fixed order', async () => {
    assert.deepEqual(names(await albums({ energy: 'relaxed', voice: 'instrumental' })),
      ['Later Works', 'Night Drive', 'Untitled EP']);
    assert.deepEqual(names(await albums({ tags: ['acoustic'] })), ['Later Works'], 'Night Drive has 1 of 3');
    const r = await albums({ tags: ['danceable', 'party'] });
    assert.deepEqual(names(r), ['Be Somebody']);
    assert.deepEqual(r.body.moods, { tags: ['party', 'danceable'] });
  });

  test('neutral is a value of its own, not "any"', async () => {
    // Orbit and Highway are the neutral songs: 1 of 3 on each album.
    assert.deepEqual(names(await albums({ valence: 'neutral' })), []);
    assert.deepEqual(names(await albums({ valence: 'happy' })), ['Be Somebody', 'Untitled EP']);
  });

  test('threshold 0.7: most of an album must fit that surely, and the echo says so', async () => {
    // Later Works: Return at 0.7. Night Drive: Highway alone (Neon 0.6) —
    // 1 of 3. Untitled EP: Sketch 1 at 0.5.
    const r = await albums({ energy: 'relaxed', threshold: 0.7 });
    assert.deepEqual(names(r), ['Later Works']);
    assert.deepEqual(r.body.moods, { energy: 'relaxed', threshold: 0.7 });
    assert.deepEqual((await albums({ energy: 'relaxed', threshold: 0.5 })).body.moods, { energy: 'relaxed' },
      'the default is left out of the echo');
    const alone = await albums({ threshold: 0.7 });
    assert.equal(alone.body.albums.length, 4, 'on its own, a threshold filters nothing');
    assert.deepEqual(alone.body.moods, {});
    for (const threshold of ['high', 0.95, 0.05, true]) {
      assert.equal((await albums({ energy: 'relaxed', threshold })).status, 400, String(threshold));
    }
    assert.equal((await albums({ energy: 'relaxed', strict: true })).status, 400, 'no `strict` any more');
  });

  test('GET answers carry the key too', async () => {
    const r = await call('GET', '/api/v1/db/albums');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.moods, {});
  });

  test('a filter it cannot read is a 400', async () => {
    for (const moods of [{ valence: 'angry' }, { tempo: 'fast' }, 'relaxed', { tags: ['sad'] }]) {
      const r = await albums(moods);
      assert.equal(r.status, 400, JSON.stringify(moods));
    }
  });
});

describe('/db/artists mood filter', () => {
  test('an artist needs more than half of their analysed songs to match', async () => {
    const all = await artists({});
    assert.deepEqual(all.body, { artists: ['Icarus', 'Vosto'], moods: {} });
    // Vosto: 3 of 4 relaxed. Icarus: Orbit + Return, 2 of 4 — half is not most.
    assert.deepEqual((await artists({ moods: { energy: 'relaxed' } })).body, { artists: ['Vosto'], moods: { energy: 'relaxed' } });
    assert.deepEqual((await artists({ moods: { tags: ['danceable'] } })).body.artists, ['Icarus']);
    assert.deepEqual((await artists({ moods: { valence: 'happy' } })).body.artists, [], 'both have 2 of 4');
  });

  test('threshold 0.7: the same rule', async () => {
    // Vosto: Highway alone fits that surely (1 of 4).
    assert.deepEqual((await artists({ moods: { energy: 'relaxed', threshold: 0.7 } })).body,
      { artists: [], moods: { energy: 'relaxed', threshold: 0.7 } });
  });

  test('the widened list (include) is filtered the same way', async () => {
    const r = await artists({ include: ['albumArtists'], moods: { energy: 'relaxed' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.artists, ['Vosto']);
  });

  test('a bad filter is a 400', async () => {
    assert.equal((await artists({ moods: { voice: 'choir' } })).status, 400);
  });
});

describe('/db/rated mood filter', () => {
  before(async () => {
    // Rated through the route, highest first: Be Somebody, Orbit, Return,
    // Static, Descent.
    const paths = new Map((await recent(100)).body.map((s) => [s.metadata.title, s.filepath]));
    for (const [title, rating] of [['Be Somebody', 9], ['Orbit', 8], ['Return', 6], ['Static', 4], ['Descent', 2]]) {
      const r = await call('POST', '/api/v1/db/rate-song', { filepath: paths.get(title), rating });
      assert.equal(r.status, 200, title);
    }
  });

  test('no filter: every rated song, highest first', async () => {
    const r = await rated();
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body), 'still a bare array');
    assert.deepEqual(titles(r), ['Be Somebody', 'Orbit', 'Return', 'Static', 'Descent']);
  });

  test('a filter keeps the rated songs that match, in rating order', async () => {
    assert.deepEqual(titles(await rated({ energy: 'relaxed' })), ['Orbit', 'Return']);
    assert.deepEqual(titles(await rated({ voice: 'vocals' })), ['Be Somebody', 'Static'], 'Descent has no scores');
    assert.deepEqual(titles(await rated({ energy: 'relaxed', tags: ['acoustic'] })), ['Return']);
    assert.deepEqual(titles(await rated({ valence: 'happy', energy: 'relaxed' })), []);
  });

  test('each song carries its match; the list stays in rating order', async () => {
    // Return is sad at 0.6 and rated above Static, sad at 0.7.
    assert.deepEqual(matches(await rated({ valence: 'sad' })), [['Return', 0.6], ['Static', 0.7]]);
    assert.deepEqual(matches(await rated({ valence: 'sad', threshold: 0.7 })), [['Static', 0.7]]);
    assert.ok((await rated()).body.every((s) => !('moodMatch' in s)), 'unfiltered: no matches');
  });

  test('GET is the unfiltered list; a bad filter is a 400', async () => {
    assert.deepEqual(titles(await call('GET', '/api/v1/db/rated')),
      ['Be Somebody', 'Orbit', 'Return', 'Static', 'Descent']);
    assert.equal((await rated({ energy: 'sleepy' })).status, 400);
    assert.equal((await rated('relaxed')).status, 400);
  });
});

describe('/db/recent/added mood filter', () => {
  test('the limit counts matching songs: the newest `limit` that match', async () => {
    const newest = titles(await recent(100));
    assert.equal(newest.length, 9);
    const r = await recent(3, { energy: 'relaxed' });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body), 'still a bare array');
    assert.deepEqual(titles(r), newest.filter((t) => RELAXED.has(t)).slice(0, 3));
    assert.deepEqual(titles(await recent(100, { energy: 'relaxed' })), newest.filter((t) => RELAXED.has(t)));
  });

  test('groups and tags combine per song', async () => {
    assert.deepEqual(titles(await recent(100, { energy: 'aggressive', voice: 'vocals' })).sort(),
      ['Be Somebody', 'Rise', 'Static']);
    assert.deepEqual(titles(await recent(100, { tags: ['party', 'danceable'] })).sort(), ['Be Somebody', 'Rise']);
    assert.deepEqual(titles(await recent(100, { valence: 'neutral' })).sort(), ['Highway', 'Orbit']);
  });

  test('each song carries its match; threshold 0.7 keeps the surer fits', async () => {
    const newest = titles(await recent(100));
    const r = await recent(100, { energy: 'relaxed' });
    assert.deepEqual(matches(r), titles(r).map((t) => [t, relaxedScore(t)]));
    const sure = await recent(2, { energy: 'relaxed', threshold: 0.7 });
    assert.deepEqual(titles(sure), newest.filter((t) => STRONGLY_RELAXED.has(t)).slice(0, 2));
    assert.ok(sure.body.every((s) => s.moodMatch >= 0.7));
  });

  test('threshold 0.7: what must not hold stays under 0.3', async () => {
    // Highway's happy is 0.4, Static's instrumental 0.4.
    assert.deepEqual(titles(await recent(100, { valence: 'neutral', threshold: 0.7 })), ['Orbit']);
    assert.deepEqual(titles(await recent(100, { voice: 'vocals', threshold: 0.7 })).sort(), ['Be Somebody', 'Rise']);
  });

  test('threshold 0.3 widens: Static\'s instrumental 0.4 holds', async () => {
    const standard = titles(await recent(100, { voice: 'instrumental' })).sort();
    assert.deepEqual(standard, ['Highway', 'Neon', 'Orbit', 'Return', 'Sketch 1']);
    assert.deepEqual(titles(await recent(100, { voice: 'instrumental', threshold: 0.3 })).sort(),
      [...standard, 'Static'].sort());
  });

  test('an empty filter filters nothing; a bad one is a 400', async () => {
    assert.equal(titles(await recent(100, {})).length, 9, 'Descent included');
    assert.ok((await recent(100, { threshold: 0.7 })).body.every((s) => !('moodMatch' in s)), 'nothing filters: no matches');
    assert.equal((await recent(5, { voice: 'choir' })).status, 400);
    assert.equal((await recent(5, { tempo: 'fast' })).status, 400);
  });
});

describe('Auto DJ (/db/random-songs) mood filter', () => {
  test('every pick matches, and the answer echoes the filter', async () => {
    const r = await dj({ limit: 25, moods: { energy: 'relaxed' } });
    assert.equal(r.status, 200);
    assert.deepEqual(picked(r).sort(), [...RELAXED].sort(), 'all five relaxed songs, nothing else');
    assert.deepEqual(r.body.moods, { energy: 'relaxed' });
    const narrow = await dj({ limit: 25, moods: { voice: 'vocals', tags: ['acoustic'] } });
    assert.deepEqual(picked(narrow), ['Static']);
  });

  test('threshold 0.7: only the surer fits, and the echo says so', async () => {
    const r = await dj({ limit: 25, moods: { energy: 'relaxed', threshold: 0.7 } });
    assert.deepEqual(picked(r).sort(), [...STRONGLY_RELAXED].sort());
    assert.deepEqual(r.body.moods, { energy: 'relaxed', threshold: 0.7 });
  });

  test('without a filter: every song can come, and the echo is {}', async () => {
    const r = await dj({ limit: 25 });
    assert.equal(r.body.songs.length, 9);
    assert.deepEqual(r.body.moods, {});
  });

  test('the waterfall never relaxes it: a mood nothing meets is a 400', async () => {
    // Happy and relaxed: Neon and Sketch 1, neither acoustic.
    const r = await dj({ moods: { valence: 'happy', energy: 'relaxed', tags: ['acoustic'] }, requireBpm: true });
    assert.equal(r.status, 400);
    assert.match(r.body, /No songs that match criteria/);
    assert.equal((await dj({ moods: { energy: 'sleepy' } })).status, 400);
  });

  test('it holds alongside the other always-on conditions', async () => {
    const r = await dj({ limit: 25, moods: { energy: 'relaxed' }, minDuration: 1 });
    assert.equal(r.status, 200);
    assert.ok(picked(r).every((t) => RELAXED.has(t)));
  });
});

describe('mood filters without scores', () => {
  test('the capability flag follows the scores', async () => {
    const api = await call('GET', '/api/');
    assert.equal(api.body.features.moodFilters, true);
    const ping = await call('GET', '/api/v1/ping');
    assert.equal(ping.body.moodFilters, true);
  });

  test('no scores: nothing is filtered, and no answer carries the key', async () => {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('DELETE FROM track_moods');
    } finally {
      db.close();
    }
    const r = await albums({ energy: 'aggressive' });
    assert.equal(r.status, 200);
    assert.deepEqual(names(r), ['Be Somebody', 'Later Works', 'Night Drive', 'Untitled EP']);
    assert.equal('moods' in r.body, false);
    assert.deepEqual((await artists({ moods: { energy: 'relaxed' } })).body, { artists: ['Icarus', 'Vosto'] });
    assert.deepEqual(titles(await rated({ energy: 'relaxed' })), ['Be Somebody', 'Orbit', 'Return', 'Static', 'Descent']);
    assert.ok((await rated({ energy: 'relaxed', threshold: 0.7 })).body.every((s) => !('moodMatch' in s)), 'no matches either');
    assert.equal(titles(await recent(100, { energy: 'aggressive' })).length, 9);
    const pick = await dj({ limit: 25, moods: { energy: 'aggressive' } });
    assert.equal(pick.body.songs.length, 9, 'Auto DJ unfiltered too');
    assert.equal('moods' in pick.body, false);
    assert.equal((await call('GET', '/api/v1/ping')).body.moodFilters, false);
    // Still validated: a bad filter is refused either way.
    assert.equal((await albums({ valence: 'angry' })).status, 400);
  });
});
