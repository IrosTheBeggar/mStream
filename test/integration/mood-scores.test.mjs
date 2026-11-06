/**
 * POST /api/v1/db/mood-scores — the mood heads' scores of the files a client
 * asks for (src/api/db.js pullMoodScoresBatch), the read the terminal player
 * copies onto an MP3 player's card.
 *
 * Three servers:
 *   - `server`: users, federation ON, the fixture library plus `lib2` (one
 *     copy of a fixture song) that only the admin can see; discovery OFF, so
 *     no discovery index is loaded. Scores are planted straight into
 *     track_moods after the scan, the way the mood sync would.
 *   - `bare`: defaults, public mode, nothing scored — the flag stays on and
 *     the route answers every path null.
 *   - `off`: analyzeMoods false and the 'test-fake' model, with scores
 *     planted anyway — the route reads none of them.
 *
 * Covers the shape, a key for every path as sent, the stored doubles going
 * out unrounded (0 and 1 included), a NULL head, an all-NULL row and no row,
 * the uniform null (not visible, unknown library, path escape, never there,
 * deleted), the 400s (no JSON body among them), the 2000-path cap, the 413,
 * the card's two-place byte rule agreeing with the SQL filter of
 * /db/recent/added at the three bars clients offer, the flag, `model` and
 * `moodVersion`, and the federation key.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../helpers/server.mjs';
import { ensureFixtures } from '../helpers/fixtures.mjs';

const ROUTE = '/api/v1/db/mood-scores';
const ADMIN = { username: 'admin', password: 'pw-admin' };
const BOB = { username: 'bob', password: 'pw-bob' };   // testlib only

// The wire's head order (track_moods' columns, MOOD_COLUMNS). Clients index
// by name, so this list is the contract.
const HEADS = ['danceable', 'happy', 'sad', 'relaxed', 'aggressive', 'party', 'acoustic', 'instrumental'];

const P = {
  'Be Somebody': 'testlib/Icarus/Be Somebody/01 - Be Somebody.mp3',
  Rise: 'testlib/Icarus/Be Somebody/02 - Rise.mp3',
  Orbit: 'testlib/Icarus/Be Somebody/03 - Orbit.mp3',
  Return: 'testlib/Icarus/Later Works/01 - Return.mp3',
  Descent: 'testlib/Icarus/Later Works/02 - Descent.mp3',
  Highway: 'testlib/Vosto/Night Drive/01 - Highway.mp3',
  Neon: 'testlib/Vosto/Night Drive/02 - Neon.mp3',
  Static: 'testlib/Vosto/Night Drive/03 - Static.mp3',
  'Sketch 1': 'testlib/Vosto/Untitled EP/01 - Sketch 1.mp3',
};
const HIDDEN = 'lib2/Hidden/copy.mp3';   // a copy of Be Somebody, admin only

// Exact doubles, in HEADS order. 0.29, 0.57 and 0.58 are where a plain
// floor of x*100 goes wrong; the 4-place values sit beside the bars.
const EXACT = [0, 1, 0.29, 0.57, 0.58, 0.7, 0.3, 0.5];
const SCORES = {
  [P['Be Somebody']]: EXACT,
  [P.Rise]: [0.81, 0.29, null, 0.7, 0.1234, 1, 0.57, 0.58],   // a NULL head
  [P.Orbit]: [null, null, null, null, null, null, null, null],
  [P.Return]: [0.3, 0.7, 0.7, 0.3, 0.3, 0.29, 0.71, 0.69],    // ties at the bars
  // Descent: no row.
  [P.Highway]: [0.5, 0.49, 0.5, 0.6999, 0.7001, 0.3001, 0.2999, 0.31],
  [P.Neon]: [0.7, 0.3, 0.29, 0.5, 0.5, 0.69, 0.7, 0.3],
  [P.Static]: [0.29, 0.5, 0.4999, 0, 1, 0.5001, 0.5, 0.7],
  [P['Sketch 1']]: [0.57, 0.58, 0.57, 0.58, 0.29, 0.31, 0.69, 0.71],
  [HIDDEN]: [0.9, 0.9, 0.1, 0.9, 0.1, 0.9, 0.9, 0.9],
};
const NULLS = HEADS.map(() => null);

let server;
let bare;
let off;
let lib2Dir;
const tokens = {};

function plantScores(srv, table) {
  const mdb = new DatabaseSync(path.join(srv.tmpDir, 'db', 'mstream.db'));
  try {
    const ins = mdb.prepare(`
      INSERT INTO track_moods (track_id, ${HEADS.join(', ')})
      SELECT t.id, ${HEADS.map(() => '?').join(', ')}
        FROM tracks t JOIN libraries l ON l.id = t.library_id
       WHERE l.name = ? AND t.filepath = ?
    `);
    for (const [fp, scores] of Object.entries(table)) {
      const [lib, ...rest] = fp.split('/');
      assert.equal(Number(ins.run(...scores, lib, rest.join('/')).changes), 1, `scores for '${fp}'`);
    }
  } finally {
    mdb.close();
  }
}

async function post(srv, route, body, { user = 'admin', headers = {}, raw = false } = {}) {
  // A header given as null is left off (no Content-Type at all).
  const h = Object.fromEntries(Object.entries({ 'Content-Type': 'application/json', ...headers })
    .filter(([, v]) => v != null));
  if (user && srv === server) { h['x-access-token'] = tokens[user]; }
  const r = await fetch(`${srv.baseUrl}${route}`, {
    method: 'POST', headers: h, body: raw ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, text, body: json };
}
const scores = (srv, filepaths, opts) => post(srv, ROUTE, { filepaths }, opts);
const get = async (srv, route, headers = {}) => (await fetch(`${srv.baseUrl}${route}`, { headers })).json();

before(async () => {
  const musicDir = await ensureFixtures();
  lib2Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-moodscores-lib2-'));
  fs.mkdirSync(path.join(lib2Dir, 'Hidden'));
  fs.copyFileSync(path.join(musicDir, 'Icarus', 'Be Somebody', '01 - Be Somebody.mp3'), path.join(lib2Dir, 'Hidden', 'copy.mp3'));

  [server, bare, off] = await Promise.all([
    startServer({
      dlnaMode: 'disabled',
      extraConfig: { federation: { enabled: true } },
      extraFolders: { lib2: lib2Dir },
      users: [
        { ...ADMIN, admin: true, vpaths: ['testlib', 'lib2'] },
        { ...BOB, admin: false, vpaths: ['testlib'] },
      ],
    }),
    startServer({ dlnaMode: 'disabled' }),
    startServer({ dlnaMode: 'disabled', extraConfig: { scanOptions: { analyzeMoods: false, discoveryModel: 'test-fake' } } }),
  ]);

  for (const u of [ADMIN, BOB]) {
    const r = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(u),
    });
    assert.equal(r.status, 200, `login ${u.username}`);
    tokens[u.username] = (await r.json()).token;
  }

  plantScores(server, SCORES);
  plantScores(off, { [P['Be Somebody']]: EXACT, [P.Rise]: SCORES[P.Rise] });
});

after(async () => {
  await Promise.all([server?.stop(), bare?.stop(), off?.stop()]);
  if (lib2Dir) { fs.rmSync(lib2Dir, { recursive: true, force: true }); }
});

describe('mood-scores: the answer', () => {
  test('shape: model, moodVersion, heads and a track per path', async () => {
    const r = await scores(server, [P['Be Somebody'], P.Descent]);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(r.body), ['model', 'moodVersion', 'heads', 'tracks']);
    assert.deepEqual(r.body.model, { id: 'effnet-discogs', version: '1' });
    assert.equal(r.body.moodVersion, '1');
    assert.deepEqual(r.body.heads, HEADS);
    assert.deepEqual(r.body.tracks, { [P['Be Somebody']]: EXACT, [P.Descent]: null });
  });

  test('a key for every path, spelled as sent: a leading slash, //, duplicates, __proto__', async () => {
    const asked = [
      `/${P['Be Somebody']}`,
      P['Be Somebody'].replace('Icarus/', 'Icarus//'),
      P.Neon,
      P.Neon,
      '__proto__',
      'testlib/__proto__',
    ];
    const r = await scores(server, asked);
    assert.equal(r.status, 200, r.text);
    const keys = Object.keys(r.body.tracks);
    assert.deepEqual(keys, [...new Set(asked)], 'every distinct path once, in the order sent');
    assert.deepEqual(r.body.tracks[asked[0]], EXACT, 'a leading slash resolves like the bare path');
    assert.deepEqual(r.body.tracks[asked[1]], EXACT, '// resolves like the bare path');
    assert.deepEqual(r.body.tracks[P.Neon], SCORES[P.Neon]);
    assert.ok(Object.hasOwn(r.body.tracks, '__proto__'), '__proto__ is a key of its own');
    assert.equal(r.body.tracks.__proto__, null);
    assert.equal(Object.getPrototypeOf(r.body.tracks), Object.prototype);
    assert.equal(r.body.tracks['testlib/__proto__'], null);
    assert.ok(r.text.includes('"__proto__":null'), 'on the wire too');
  });

  test('the stored doubles, unrounded: 0 and 1 stay numbers, 0.29 stays 0.29', async () => {
    const r = await scores(server, [P['Be Somebody']]);
    const got = r.body.tracks[P['Be Somebody']];
    assert.equal(got.length, EXACT.length);
    for (let i = 0; i < EXACT.length; i++) {
      assert.ok(got[i] === EXACT[i], `${HEADS[i]}: ${got[i]} === ${EXACT[i]}`);
    }
    assert.ok(r.text.includes(`"${P['Be Somebody']}":[0,1,0.29,0.57,0.58,0.7,0.3,0.5]`), r.text);
    const four = await scores(server, [P.Rise]);
    assert.equal(four.body.tracks[P.Rise][HEADS.indexOf('aggressive')], 0.1234, 'four places, as stored');
  });

  test('a NULL head is null at its index; an all-NULL row is an array; no row is null', async () => {
    const r = await scores(server, [P.Rise, P.Orbit, P.Descent]);
    assert.deepEqual(r.body.tracks[P.Rise], SCORES[P.Rise]);
    assert.equal(r.body.tracks[P.Rise][HEADS.indexOf('sad')], null);
    assert.deepEqual(r.body.tracks[P.Orbit], NULLS);
    assert.equal(r.body.tracks[P.Descent], null);
    assert.notDeepEqual(r.body.tracks[P.Orbit], r.body.tracks[P.Descent], 'all-NULL is not no row');
  });

  test('not visible is exactly no row, and the status stays 200', async () => {
    const asked = [
      HIDDEN,                              // a scored song in a library bob lacks
      P.Descent,                           // visible, no row
      'nolib/Icarus/x.mp3',                // an unknown library
      'testlib/../lib2/Hidden/copy.mp3',   // a path into lib2 through testlib
      'testlib/../../etc/passwd',          // escaping every library
      'testlib/Icarus/never-there.mp3',    // never existed
    ];
    const r = await scores(server, asked, { user: 'bob' });
    assert.equal(r.status, 200, r.text);
    for (const fp of asked) {
      assert.deepEqual(r.body.tracks[fp], r.body.tracks[P.Descent], fp);
      assert.equal(r.body.tracks[fp], null, fp);
    }
    const admin = await scores(server, [HIDDEN, 'testlib/../lib2/Hidden/copy.mp3']);
    assert.deepEqual(admin.body.tracks[HIDDEN], SCORES[HIDDEN], 'the admin sees lib2');
    assert.deepEqual(admin.body.tracks['testlib/../lib2/Hidden/copy.mp3'], SCORES[HIDDEN]);
  });
});

describe('mood-scores: validation', () => {
  test('400s: a bare array, an unknown key, no paths, 2001 paths, a non-string', async () => {
    const one = [P.Neon];
    const many = (n) => Array.from({ length: n }, (_, i) => `testlib/none/${i}.mp3`);
    for (const [body, why] of [
      [one, 'a bare array'],
      [{ filepaths: one, moods: {} }, 'an unknown key'],
      [{}, 'no filepaths'],
      [{ filepaths: [] }, 'an empty list'],
      [{ filepaths: many(2001) }, '2001 paths'],
      [{ filepaths: [P.Neon, 7] }, 'a number'],
      [{ filepaths: [null] }, 'a null'],
      [{ filepaths: [['x']] }, 'an array'],
      [{ filepaths: [''] }, 'an empty string'],
      [{ filepaths: P.Neon }, 'a string, not a list'],
    ]) {
      const r = await post(server, ROUTE, body);
      assert.equal(r.status, 400, `${why}: ${r.text}`);
    }
  });

  test('400s: no body, and a body that is not JSON (Express leaves req.body undefined)', async () => {
    // A string body makes fetch add text/plain; bytes go with no type at all.
    const json = JSON.stringify({ filepaths: [P.Neon] });
    for (const srv of [server, bare]) {
      const mode = srv === server ? 'users' : 'public mode';
      for (const [body, headers, why] of [
        [undefined, { 'Content-Type': null }, 'no body, no Content-Type'],
        [undefined, {}, 'no body, Content-Type JSON'],
        [new TextEncoder().encode(json), { 'Content-Type': null }, 'JSON bytes, no Content-Type'],
        [json, { 'Content-Type': 'text/plain' }, 'JSON text sent as text/plain'],
      ]) {
        const r = await post(srv, ROUTE, body, { headers, raw: true });
        assert.equal(r.status, 400, `${mode}, ${why}: ${r.text}`);
        assert.equal(r.body?.error, '"filepaths" is required', `${mode}, ${why}`);
      }
    }
  });

  test('exactly 2000 paths: a key each', async () => {
    const asked = Array.from({ length: 1999 }, (_, i) => `testlib/none/${i}.mp3`);
    asked.push(P.Neon);
    const r = await scores(server, asked);
    assert.equal(r.status, 200, r.text);
    assert.equal(Object.keys(r.body.tracks).length, 2000);
    assert.deepEqual(r.body.tracks[P.Neon], SCORES[P.Neon], 'past the first chunk of 500');
    assert.equal(r.body.tracks['testlib/none/0.mp3'], null);
  });

  test('a body over maxRequestSize is a 413 before the route runs', async () => {
    const r = await scores(server, ['x'.repeat(1_100_000)]);
    assert.equal(r.status, 413, r.text.slice(0, 200));
  });
});

// The card's rule (the player's MOOD-FILTERS plan, 5.3 and 4.1): each value
// is a byte, min(100, max(0, floor(score*100 + 1e-9))), 255 for NULL; the
// two scales keep the larger head and an order bit from the raw doubles;
// a filter compares the bytes against the bar in percent. Ported here so
// the route's doubles, put through it, must pick exactly the songs the
// server's own SQL picks.
const byte = (x) => (x === null ? 255 : Math.min(100, Math.max(0, Math.floor(x * 100 + 1e-9))));

function tail(row) {
  const h = Object.fromEntries(HEADS.map((k, i) => [k, row[i]]));
  const pair = (a, b) => (h[a] === null || h[b] === null ? 255 : byte(Math.max(h[a], h[b])));
  return {
    sadWins: h.happy !== null && h.sad !== null && h.sad > h.happy,
    aggressiveWins: h.relaxed !== null && h.aggressive !== null && h.aggressive > h.relaxed,
    valence: pair('happy', 'sad'),
    energy: pair('relaxed', 'aggressive'),
    instrumental: byte(h.instrumental),
    acoustic: byte(h.acoustic),
    party: byte(h.party),
    danceable: byte(h.danceable),
  };
}

function cardFits(row, moods, threshold) {
  if (!row) { return false; }   // no scores: matches nothing
  const t = tail(row);
  const on = Math.round(threshold * 100);
  const mirror = 100 - on;
  const scale = (value, b, otherWins, [lo]) => {
    if (b === 255) { return false; }
    if (value === 'neutral') { return b < mirror; }
    return b >= on && (value === lo ? !otherWins : otherWins);
  };
  if (moods.valence && !scale(moods.valence, t.valence, t.sadWins, ['happy', 'sad'])) { return false; }
  if (moods.energy && !scale(moods.energy, t.energy, t.aggressiveWins, ['relaxed', 'aggressive'])) { return false; }
  if (moods.voice === 'instrumental' && !(t.instrumental !== 255 && t.instrumental >= on)) { return false; }
  if (moods.voice === 'vocals' && !(t.instrumental !== 255 && t.instrumental < mirror)) { return false; }
  for (const tag of moods.tags || []) {
    if (!(t[tag] !== 255 && t[tag] >= on)) { return false; }
  }
  return true;
}

describe('mood-scores: the card\'s byte rule against the server\'s SQL', () => {
  test('at 0.3, 0.5 and 0.7 every filter picks the same songs from both', async () => {
    const all = [...Object.values(P), HIDDEN];
    const r = await scores(server, all);
    assert.equal(r.status, 200, r.text);
    const filters = [
      { valence: 'happy' }, { valence: 'neutral' }, { valence: 'sad' },
      { energy: 'relaxed' }, { energy: 'neutral' }, { energy: 'aggressive' },
      { voice: 'instrumental' }, { voice: 'vocals' },
      { tags: ['acoustic'] }, { tags: ['party'] }, { tags: ['danceable'] },
      { valence: 'happy', energy: 'aggressive', tags: ['party'] },
      { valence: 'sad', energy: 'relaxed', voice: 'vocals', tags: ['danceable'] },
    ];
    let checks = 0;
    let picked = 0;
    for (const threshold of [0.3, 0.5, 0.7]) {
      for (const f of filters) {
        const moods = { ...f, threshold };
        const sql = await post(server, '/api/v1/db/recent/added', { limit: 1000, moods });
        assert.equal(sql.status, 200, sql.text);
        const want = sql.body.map((s) => s.filepath).sort();
        const got = all.filter((fp) => cardFits(r.body.tracks[fp], f, threshold)).sort();
        assert.deepEqual(got, want, JSON.stringify(moods));
        checks += all.length;
        picked += want.length;
      }
    }
    assert.equal(checks, 3 * filters.length * all.length);
    assert.ok(picked > 0 && picked < checks, 'the filters pick some songs and leave others');
  });
});

describe('mood-scores: no scores to give', () => {
  test('the flag is on with an empty table; the route answers every path null', async () => {
    const api = await get(bare, '/api/');
    assert.equal(api.features.moodScores, 1);
    assert.equal(api.features.moodFilters, false, 'nothing scored');
    const ping = await get(bare, '/api/v1/ping');
    assert.equal(ping.moodScores, 1);
    const r = await scores(bare, [P['Be Somebody'], P.Descent, 'nolib/x.mp3']);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body, {
      model: { id: 'effnet-discogs', version: '1' },
      moodVersion: '1',
      heads: HEADS,
      tracks: { [P['Be Somebody']]: null, [P.Descent]: null, 'nolib/x.mp3': null },
    });
  });

  test('analyzeMoods false: every path null and moodVersion null, though rows are there', async () => {
    const r = await scores(off, [P['Be Somebody'], P.Rise]);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body, {
      model: { id: 'test-fake', version: '1' },
      moodVersion: null,
      heads: HEADS,
      tracks: { [P['Be Somebody']]: null, [P.Rise]: null },
    });
    const mdb = new DatabaseSync(path.join(off.tmpDir, 'db', 'mstream.db'), { readOnly: true });
    try {
      assert.equal(Number(mdb.prepare('SELECT COUNT(*) AS n FROM track_moods').get().n), 2, 'the planted rows are still there');
    } finally {
      mdb.close();
    }
    assert.equal((await get(off, '/api/')).features.moodScores, 1, 'a version fact, on with moods off');
  });

  test('model comes from the configured model, with no discovery index loaded', async () => {
    const api = await get(server, '/api/', { 'x-access-token': tokens.admin });
    assert.equal(api.features.discoveryReady, false, 'no index loaded here');
    assert.equal(api.features.moodFilters, true, 'yet there are scores to give');
    assert.equal(api.features.moodScores, 1);
    const r = await scores(server, [P.Neon]);
    assert.deepEqual(r.body.model, { id: 'effnet-discogs', version: '1' });
    assert.deepEqual(r.body.tracks[P.Neon], SCORES[P.Neon]);
  });
});

describe('mood-scores: federation', () => {
  test('a federation key may call it over HTTP, scoped to its grants', async () => {
    const mint = await fetch(`${server.baseUrl}/api/v1/admin/federation/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': tokens.admin },
      body: JSON.stringify({ name: 'Peer', vpaths: ['testlib'] }),
    });
    assert.equal(mint.status, 200);
    const { key } = await mint.json();
    assert.match(key, /^fedk_/);

    const r = await scores(server, [P['Be Somebody'], P.Descent, HIDDEN], { user: null, headers: { 'x-federation-key': key } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.tracks, { [P['Be Somebody']]: EXACT, [P.Descent]: null, [HIDDEN]: null });
  });
});

describe('mood-scores: a deleted track', () => {
  test('its path answers null, like one that never existed', async () => {
    // What a rescan does when the file is gone: the tracks row goes, and
    // its track_moods row with it (ON DELETE CASCADE).
    const mdb = new DatabaseSync(path.join(server.tmpDir, 'db', 'mstream.db'));
    try {
      const gone = mdb.prepare("DELETE FROM tracks WHERE filepath = 'Vosto/Untitled EP/01 - Sketch 1.mp3'").run();
      assert.equal(Number(gone.changes), 1);
    } finally {
      mdb.close();
    }
    const r = await scores(server, [P['Sketch 1'], 'testlib/Icarus/never-there.mp3']);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.tracks, { [P['Sketch 1']]: null, 'testlib/Icarus/never-there.mp3': null });
  });
});
