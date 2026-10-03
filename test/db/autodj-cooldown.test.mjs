/**
 * Auto-DJ pick cost (src/api/random.js) — the artist cooldown and the
 * candidate query.
 *
 *   - buildArtistFilter's ignoreArtists clause is ONE non-correlated
 *     `t.id NOT IN (...)` set where it used to be three legs, two of them
 *     correlated NOT EXISTS probes run per scanned track. It must keep
 *     EXACTLY the rows the old clause kept: compared id-for-id (not by
 *     count) against a verbatim copy of the old clause, on hand-built
 *     edge cases (each performer role, non-performer credits, album-only
 *     credits, NULL artist_id / album_id, name_key spelling variants) and
 *     on a seeded random library;
 *   - the candidate queries select only id / bpm / musical_key and the
 *     winners are hydrated afterwards — the response must be the same
 *     object the old full-row path rendered;
 *   - minRating keeps its rows, and its `COALESCE(um.rating, 0)` keeps the
 *     plan driven from tracks (the bare form flips the join order into a
 *     per-rated-row library walk: 11.6 s per pick at 25k tracks);
 *   - a caller who sees every library gets no (no-op) library clause, so
 *     the candidate scan is a table scan rather than an idx_tracks_library
 *     walk with a seek per row;
 *   - EXPLAIN QUERY PLAN pins for the shapes runRandomSongs actually
 *     prepares (captured, not mirrored), under node:sqlite and Bun.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BUN_BIN, noBun } from '../helpers/bun.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let testRoot;
let config, manager, random, apiDb, nameKey, roles;
const lib = {};        // name -> library id
let uid;               // the rating user

// The pre-rewrite cooldown clause, verbatim (src/api/random.js before the
// non-correlated rewrite). Same placeholder layout: the keys bind 3 times.
function legacyCooldownClause(n) {
  const ph = Array.from({ length: n }, () => '?').join(',');
  return `
      COALESCE(t.artist_id, -1) NOT IN (SELECT id FROM artists WHERE name_key IN (${ph}))
      AND NOT EXISTS (
        SELECT 1 FROM track_artists ta
         WHERE ta.track_id = t.id
           AND ta.role IN (${roles.PERFORMER_ROLES_SQL})
           AND ta.artist_id IN (SELECT id FROM artists WHERE name_key IN (${ph}))
      )
      AND NOT EXISTS (
        SELECT 1 FROM album_artists aa
         WHERE aa.album_id = t.album_id
           AND aa.artist_id IN (SELECT id FROM artists WHERE name_key IN (${ph}))
      )
    `;
}

const keptBy = (clause, params) => manager.getDB()
  .prepare(`SELECT t.id FROM tracks t WHERE ${clause} ORDER BY t.id`)
  .all(...params).map((r) => r.id);

function keptOld(names) {
  const keys = names.map(nameKey);
  return keptBy(legacyCooldownClause(names.length), [...keys, ...keys, ...keys]);
}
function keptNew(names) {
  const { clauses, params } = random.buildArtistFilter({ ignoreArtists: names });
  assert.equal(clauses.length, 1);
  return keptBy(clauses[0], params);
}

// Deterministic PRNG (mulberry32) so a failure reproduces.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Named edge-case tracks -> id, for the explicit expectations.
const edge = {};

before(async () => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-autodj-cooldown-'));
  fs.mkdirSync(path.join(testRoot, 'db'), { recursive: true });
  const folders = {};
  for (const name of ['main', 'rand', 'solo', 'rated']) {
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
  manager = await import('../../src/db/manager.js');
  manager.initDB();
  random = await import('../../src/api/random.js');
  apiDb = await import('../../src/api/db.js');
  ({ nameKey } = await import('../../src/db/name-key.js'));
  roles = await import('../../src/db/artist-roles.js');

  const d = manager.getDB();
  for (const r of d.prepare('SELECT id, name FROM libraries').all()) { lib[r.name] = r.id; }

  d.exec('BEGIN');
  const insArtist = d.prepare('INSERT INTO artists (name, name_key) VALUES (?, ?)');
  const artist = (name) => Number(insArtist.run(name, nameKey(name)).lastInsertRowid);
  const insAlbum = d.prepare('INSERT INTO albums (name, artist_id) VALUES (?, ?)');
  const album = (name, artistId = null) => Number(insAlbum.run(name, artistId).lastInsertRowid);
  const insTrack = d.prepare(`INSERT INTO tracks
    (filepath, library_id, title, artist_id, album_id, audio_hash, format, bpm, musical_key, duration)
    VALUES (?, ?, ?, ?, ?, ?, 'mp3', ?, ?, 200)`);
  let n = 0;
  const track = (libName, title, artistId, albumId, extra = {}) => Number(insTrack.run(
    `f${n++}.mp3`, lib[libName], title, artistId, albumId,
    extra.hash ?? `h-${n}`, extra.bpm ?? null, extra.key ?? null).lastInsertRowid);
  const insTa = d.prepare('INSERT INTO track_artists (track_id, artist_id, role, position) VALUES (?, ?, ?, ?)');
  const insAa = d.prepare('INSERT INTO album_artists (album_id, artist_id, role, position) VALUES (?, ?, ?, 0)');

  // ── hand-built edge cases (library 'main') ──────────────────────────────
  // Spellings that only meet through name_key: case, whitespace and the
  // typographic apostrophe fold; a diacritic does NOT (Beyoncé ≠ Beyonce).
  const cool = artist('Röyksopp');
  const apos = artist('Guns N’ Roses');
  const acc = artist('Beyoncé');
  const other = artist('Somebody Else');
  const coolAlbum = album('Credited Album');
  insAa.run(coolAlbum, cool, 'main');
  const coolAlbumByOther = album('Split Album', other);
  insAa.run(coolAlbumByOther, other, 'main');
  insAa.run(coolAlbumByOther, cool, 'featured');   // album_artists matches any role
  const plainAlbum = album('Plain Album', other);
  insAa.run(plainAlbum, other, 'main');

  edge.primary = track('main', 'primary', cool, plainAlbum);
  edge.primaryNoAlbum = track('main', 'primary, NULL album', cool, null);
  for (const role of roles.TRACK_ROLES) {
    edge[`credit:${role}`] = track('main', `credit ${role}`, other, plainAlbum);
    insTa.run(edge[`credit:${role}`], other, 'main', 0);
    insTa.run(edge[`credit:${role}`], cool, role, 1);
  }
  edge.featuredNullBoth = track('main', 'featured, NULL artist + album', null, null);
  insTa.run(edge.featuredNullBoth, cool, 'featured', 0);
  edge.albumOnly = track('main', 'album credit only', other, coolAlbum);
  edge.albumOnlyNullArtist = track('main', 'album credit, NULL artist', null, coolAlbum);
  edge.albumFeatured = track('main', 'album featured credit', other, coolAlbumByOther);
  edge.nullBoth = track('main', 'NULL artist + album', null, null);
  edge.nullArtist = track('main', 'NULL artist', null, plainAlbum);
  edge.nullAlbum = track('main', 'NULL album', other, null);
  edge.unrelated = track('main', 'unrelated', other, plainAlbum);
  edge.apos = track('main', 'apostrophe', apos, null);
  edge.acc = track('main', 'accent', acc, null);

  // ── seeded random library (library 'rand') ──────────────────────────────
  const rand = rng(0xA5D1);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const randArtists = Array.from({ length: 30 }, (_, i) => artist(`Rand Artist ${i}`));
  const randAlbums = Array.from({ length: 40 }, (_, i) => album(`Rand Album ${i}`, rand() < 0.5 ? pick(randArtists) : null));
  for (const al of randAlbums) {
    const credited = new Set();
    const k = Math.floor(rand() * 3);              // 0-2 album credits
    for (let i = 0; i < k; i++) {
      const a = pick(randArtists);
      if (credited.has(a)) { continue; }
      credited.add(a);
      insAa.run(al, a, pick(['main', 'featured']));
    }
  }
  for (let i = 0; i < 400; i++) {
    const t = track('rand', `R${i}`,
      rand() < 0.15 ? null : pick(randArtists),
      rand() < 0.15 ? null : pick(randAlbums));
    const seen = new Set();
    const k = Math.floor(rand() * 4);              // 0-3 track credits
    for (let j = 0; j < k; j++) {
      const a = pick(randArtists);
      const role = pick(roles.TRACK_ROLES);
      if (seen.has(`${a}/${role}`)) { continue; }
      seen.add(`${a}/${role}`);
      insTa.run(t, a, role, j);
    }
  }

  // ── one-track library (response shape) ──────────────────────────────────
  d.prepare("INSERT INTO users (username, password, salt) VALUES ('dj', 'x', 'y')").run();
  uid = d.prepare("SELECT id FROM users WHERE username = 'dj'").get().id;
  const soloArtist = artist('Solo Main');
  const soloFeat = artist('Solo Guest');
  const soloComp = artist('Solo Writer');
  const soloAlbum = album('Solo Album', soloArtist);
  edge.solo = track('solo', 'Solo Song', soloArtist, soloAlbum, { hash: 'solo-hash', bpm: 124, key: '8A' });
  insTa.run(edge.solo, soloArtist, 'main', 0);
  insTa.run(edge.solo, soloFeat, 'featured', 1);
  insTa.run(edge.solo, soloComp, 'composer', 2);
  const insGenre = d.prepare('INSERT INTO genres (name) VALUES (?)');
  const insTg = d.prepare('INSERT INTO track_genres (track_id, genre_id) VALUES (?, ?)');
  for (const g of ['Electronic', 'Downtempo']) { insTg.run(edge.solo, Number(insGenre.run(g).lastInsertRowid)); }
  d.prepare(`INSERT INTO user_metadata (user_id, track_hash, rating, play_count, last_played)
             VALUES (?, 'solo-hash', 7, 3, '2026-01-02 03:04:05')`).run(uid);

  // ── minRating library: 8 stars, 4 stars, a NULL-rating row, no row ─────
  const um = d.prepare('INSERT INTO user_metadata (user_id, track_hash, rating, play_count) VALUES (?, ?, ?, 1)');
  edge.r8 = track('rated', 'eight', other, null, { hash: 'r8' });
  um.run(uid, 'r8', 8);
  edge.r4 = track('rated', 'four', other, null, { hash: 'r4' });
  um.run(uid, 'r4', 4);
  edge.rNull = track('rated', 'played, unrated', other, null, { hash: 'rnull' });
  um.run(uid, 'rnull', null);
  edge.rNone = track('rated', 'never touched', other, null, { hash: 'rnone' });
  d.exec('COMMIT');
});

after(() => {
  try { manager.close(); } catch (_e) { /* closed */ }
  try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch (_e) { /* win locks */ }
  setImmediate(() => process.exit(0));
});

// ── row equivalence ─────────────────────────────────────────────────────────

describe('ignoreArtists clause: same rows as the correlated original', () => {
  test('edge cases: every credit path drops the row, NULLs and non-performer credits stay', () => {
    const kept = new Set(keptNew(['Röyksopp']));
    assert.deepEqual(keptNew(['Röyksopp']), keptOld(['Röyksopp']));

    const dropped = ['primary', 'primaryNoAlbum', 'featuredNullBoth', 'albumOnly',
      'albumOnlyNullArtist', 'albumFeatured',
      ...roles.PERFORMER_ROLES.map((r) => `credit:${r}`)];
    for (const k of dropped) { assert.ok(!kept.has(edge[k]), `${k} must be cooled`); }
    const stays = ['nullBoth', 'nullArtist', 'nullAlbum', 'unrelated', 'apos', 'acc',
      ...roles.CREDIT_ROLES.map((r) => `credit:${r}`)];
    for (const k of stays) { assert.ok(kept.has(edge[k]), `${k} must survive the cooldown`); }
  });

  test('name_key spellings: case / whitespace / apostrophe fold, diacritics do not', () => {
    for (const names of [
      ['RÖYKSOPP'], ['  röyksopp '], ["Guns N' Roses"], ['GUNS  N’ ROSES'],
      ['Beyonce'], ['Beyoncé'], ['beyoncé', 'röyksopp'],
    ]) {
      assert.deepEqual(keptNew(names), keptOld(names), `cooldown ${JSON.stringify(names)}`);
    }
    assert.ok(!keptNew(["Guns N' Roses"]).includes(edge.apos), 'apostrophe variant matches');
    assert.ok(keptNew(['Beyonce']).includes(edge.acc), 'a dropped accent is a different artist');
    assert.ok(!keptNew(['BEYONCÉ']).includes(edge.acc), 'case still folds with the accent kept');
  });

  test('names no artist carries are a no-op in both forms', () => {
    const all = keptBy('1', []);
    assert.deepEqual(keptNew(['nobody at all']), all);
    assert.deepEqual(keptOld(['nobody at all']), all);
  });

  test('seeded random library: id-for-id over 80 cooldown sets', () => {
    const rand = rng(0xC001);
    const names = Array.from({ length: 30 }, (_, i) => `Rand Artist ${i}`);
    for (let s = 0; s < 80; s++) {
      const size = 1 + Math.floor(rand() * 15);
      const set = Array.from({ length: size }, () => names[Math.floor(rand() * names.length)]);
      // Spelling noise the resolver can hand over, plus an unknown name.
      if (s % 4 === 0) { set.push(set[0].toUpperCase()); }
      if (s % 5 === 0) { set.push('Not In This Library'); }
      const oldIds = keptOld(set);
      assert.deepEqual(keptNew(set), oldIds, `cooldown set #${s}: ${JSON.stringify(set)}`);
      assert.ok(oldIds.length > 0, 'the fixture keeps something to compare');
    }
  });
});

// ── what runRandomSongs prepares ────────────────────────────────────────────

// Run `fn` with every statement runRandomSongs prepares recorded (sql +
// bound params), so the plan pins below look at the real SQL rather than a
// mirror of it.
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

describe('runRandomSongs candidate queries', () => {
  const user = () => ({ id: uid, username: 'dj', libraryIds: [lib.main, lib.rand] });

  test('cooldown steps: no correlated subquery, no joins, ids/bpm/key only', () => {
    const { seen } = capture(() => random.runRandomSongs({ user: user() }, {
      ignoreArtists: ['Rand Artist 1', 'Rand Artist 2', 'Röyksopp'],
      bpmRanges: [{ min: 100, max: 140 }], musicalKeys: ['8A'],
    }));
    const steps = candidates(seen);
    assert.ok(steps.length > 0, 'the waterfall ran');
    for (const s of steps) {
      assert.match(s.sql, /^SELECT t\.id, t\.bpm, t\.musical_key FROM tracks t WHERE /);
      const plan = planOf(s).map((r) => r.detail).join(' | ');
      assert.doesNotMatch(plan, /CORRELATED/, `a correlated subquery is back: ${plan}`);
      assert.doesNotMatch(plan, /SEARCH (a|al|l|um) /, `the candidate query joins again: ${plan}`);
    }
  });

  test('a caller who sees every library scans tracks instead of walking idx_tracks_library', () => {
    const everyLib = Object.values(lib);
    const { seen } = capture(() => random.runRandomSongs(
      { user: { id: uid, username: 'dj', libraryIds: everyLib } },
      { ignoreArtists: ['Rand Artist 1'], limit: 3 }));
    const steps = candidates(seen);
    assert.ok(steps.length > 0, 'the waterfall ran');
    for (const s of steps) {
      assert.doesNotMatch(s.sql, /library_id/, 'the no-op library clause is dropped');
      const plan = planOf(s).map((r) => r.detail).join(' | ');
      assert.doesNotMatch(plan, /idx_tracks_library/, `library index in the plan: ${plan}`);
    }
    // A partial scope keeps its clause.
    const partial = capture(() => random.runRandomSongs(
      { user: { id: uid, username: 'dj', libraryIds: [lib.rand] } }, { ignoreArtists: ['Rand Artist 1'] }));
    for (const s of candidates(partial.seen)) { assert.match(s.sql, /t\.library_id IN \(\?\)/); }
  });

  test('minRating: the plan drives from tracks, never from the rating index', () => {
    const { out, seen } = capture(() => random.runRandomSongs(
      { user: { id: uid, username: 'dj', libraryIds: [lib.rated] } },
      { minRating: 6, ignoreArtists: ['Röyksopp'] }));
    assert.equal(out.songs[0].metadata.title, 'eight');
    for (const s of candidates(seen)) {
      const plan = planOf(s);
      const details = plan.map((r) => r.detail).join(' | ');
      // The first top-level loop is the outer one.
      const outer = plan.find((r) => r.parent === 0);
      assert.match(outer.detail, /^(SCAN|SEARCH) t\b/, `outer loop is not tracks: ${details}`);
      assert.match(details, /SEARCH um .*LEFT-JOIN/, `user_metadata is not the inner LEFT JOIN: ${details}`);
      assert.doesNotMatch(details, /idx_user_metadata_user_rating/, `rating index drives the join: ${details}`);
    }
  });
});

// ── behaviour + wire shape ──────────────────────────────────────────────────

describe('runRandomSongs results', () => {
  const pickRated = (body, user = { id: uid, username: 'dj' }) => {
    const titles = new Set();
    for (let i = 0; i < 20; i++) {
      const out = random.runRandomSongs({ user: { ...user, libraryIds: [lib.rated] } }, { ...body, limit: 4 });
      for (const s of out.songs) { titles.add(s.metadata.title); }
    }
    return [...titles].sort();
  };

  test('minRating keeps rated-at-or-above rows only (unrated = 0 stars)', () => {
    assert.deepEqual(pickRated({ minRating: 6 }), ['eight']);
    assert.deepEqual(pickRated({ minRating: 4 }), ['eight', 'four']);
    assert.deepEqual(pickRated({ minRating: 4, ignoreArtists: ['Nobody'] }), ['eight', 'four']);
  });

  test('a caller with no user id ignores minRating (federation key)', () => {
    assert.deepEqual(pickRated({ minRating: 6 }, { id: undefined }),
      ['eight', 'four', 'never touched', 'played, unrated']);
  });

  test('hydrated winners render exactly what the full-row path rendered', () => {
    // The old path: the candidate row WAS the trackQuery row, enriched per
    // pick with genres + credits, then renderMetadataObj.
    const d = manager.getDB();
    const legacy = (userId) => {
      const row = d.prepare(`${apiDb.trackQuery(userId, { includeGenres: false })} WHERE t.id = ?`)
        .get(...(userId ? [userId] : []), edge.solo);
      row.genres_concat = apiDb.fetchGenresForTrack(d, row.id).genres_concat;
      Object.assign(row, apiDb.fetchCreditsForTrack(d, row.id));
      return JSON.stringify(apiDb.renderMetadataObj(row));
    };
    const soloUser = (id) => ({ id, username: 'dj', libraryIds: [lib.solo] });
    const bodies = [
      {},                                                      // simple mode
      { ignoreArtists: ['Somebody Else'] },                    // waterfall
      { bpmRanges: [{ min: 120, max: 128 }], musicalKeys: ['8A'], limit: 3 },
      { minRating: 5 },
    ];
    for (const body of bodies) {
      const out = random.runRandomSongs({ user: soloUser(uid) }, body);
      assert.equal(out.songs.length, 1);
      assert.equal(JSON.stringify(out.songs[0]), legacy(uid), `body ${JSON.stringify(body)}`);
      assert.deepEqual(out.ignoreList, [edge.solo]);
    }
    const anon = random.runRandomSongs({ user: soloUser(undefined) }, { ignoreArtists: ['x'] });
    assert.equal(JSON.stringify(anon.songs[0]), legacy(undefined));
    // Spot-check the enrichment actually ran (so the byte compare is not
    // comparing two empty shapes).
    const m = random.runRandomSongs({ user: soloUser(uid) }, {}).songs[0].metadata;
    assert.deepEqual(m.genres, ['Electronic', 'Downtempo']);
    assert.deepEqual(m.artists, ['Solo Main', 'Solo Guest']);
    assert.equal(m.composer, 'Solo Writer');
    assert.equal(m.rating, 7);
    assert.equal(m.bpm, 124);
  });

  test('a batch keeps pick order through hydration', () => {
    const user = { id: uid, username: 'dj', libraryIds: [lib.rand] };
    for (let i = 0; i < 5; i++) {
      const out = random.runRandomSongs({ user }, { limit: 25, ignoreArtists: ['Rand Artist 3'] });
      // The ignoreList's tail is the picked ids in pick order; songs must
      // line up with it one-for-one.
      const tail = out.ignoreList.slice(-out.songs.length);
      const byPath = new Map(manager.getDB().prepare(
        `SELECT id, filepath FROM tracks WHERE id IN (${tail.map(() => '?').join(',')})`,
      ).all(...tail).map((r) => [r.id, r.filepath]));
      assert.deepEqual(out.songs.map((s) => s.filepath), tail.map((id) => `rand/${byPath.get(id)}`));
    }
  });
});

// ── Bun ─────────────────────────────────────────────────────────────────────
//
// Bun ships its own SQLite (behind the bun:sqlite adapter), and the minRating
// plan guard is a query-planner fact, so the pick runs there too: one
// cooldown + minRating pick in a fresh library, its candidate plans returned
// as JSON. Skips where no bun is installed (CI always has one).
const BUN_PROBE = `
const repo = process.env.AUTODJ_REPO;
const dir = process.env.AUTODJ_DIR;
const fs = await import('node:fs');
const path = await import('node:path');
fs.mkdirSync(path.join(dir, 'db'), { recursive: true });
fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
  storage: { dbDirectory: path.join(dir, 'db'), albumArtDirectory: path.join(dir, 'art'), logsDirectory: path.join(dir, 'logs') },
  folders: { rated: { root: path.join(dir, 'lib') } },
  port: 0,
}));
const config = await import(repo + '/src/state/config.js');
await config.setup(path.join(dir, 'config.json'));
const manager = await import(repo + '/src/db/manager.js');
manager.initDB();
const random = await import(repo + '/src/api/random.js');
const d = manager.getDB();
const libId = d.prepare("SELECT id FROM libraries WHERE name = 'rated'").get().id;
d.prepare("INSERT INTO users (username, password, salt) VALUES ('dj', 'x', 'y')").run();
const uid = d.prepare("SELECT id FROM users WHERE username = 'dj'").get().id;
const artist = (n) => Number(d.prepare('INSERT INTO artists (name, name_key) VALUES (?, ?)').run(n, n.toLowerCase()).lastInsertRowid);
const kept = artist('Kept');
const cooled = artist('Cooled');
const rows = [['eight', kept, 'r8', 8], ['four', kept, 'r4', 4], ['cooled nine', cooled, 'r9', 9], ['unrated', kept, 'r0', null]];
for (const [title, a, hash, rating] of rows) {
  d.prepare("INSERT INTO tracks (filepath, library_id, title, artist_id, audio_hash, format) VALUES (?, ?, ?, ?, ?, 'mp3')")
    .run(title + '.mp3', libId, title, a, hash);
  if (rating !== null) {
    d.prepare('INSERT INTO user_metadata (user_id, track_hash, rating, play_count) VALUES (?, ?, ?, 1)').run(uid, hash, rating);
  }
}
const real = d.prepare.bind(d);
const seen = [];
d.prepare = (sql) => {
  const st = real(sql);
  return {
    all: (...p) => { seen.push({ sql, p }); return st.all(...p); },
    get: (...p) => st.get(...p),
  };
};
const out = random.runRandomSongs({ user: { id: uid, username: 'dj', libraryIds: [libId] } },
  { minRating: 6, ignoreArtists: ['Cooled'], limit: 4 });
d.prepare = real;
const plans = seen.filter((s) => /RANDOM\\(\\)/.test(s.sql))
  .map((s) => real('EXPLAIN QUERY PLAN ' + s.sql).all(...s.p).map((r) => ({ parent: r.parent, detail: r.detail })));
console.log(JSON.stringify({ titles: out.songs.map((s) => s.metadata.title), plans }));
process.exit(0);
`;

describe('bun', { skip: noBun }, () => {
  test('cooldown + minRating pick: same rows, plan driven from tracks, nothing correlated', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-autodj-bun-'));
    try {
      const r = spawnSync(BUN_BIN, ['-e', BUN_PROBE], {
        encoding: 'utf8', timeout: 60_000, windowsHide: true,
        env: { ...process.env, AUTODJ_REPO: REPO_ROOT, AUTODJ_DIR: dir },
      });
      assert.equal(r.status, 0, `bun probe exited ${r.status} (${r.error?.message ?? r.signal ?? ''}):\n${r.stderr}`);
      const { titles, plans } = JSON.parse(r.stdout.trim().split('\n').pop());
      assert.deepEqual(titles, ['eight']);
      assert.ok(plans.length > 0, 'the candidate query ran');
      for (const plan of plans) {
        const details = plan.map((x) => x.detail).join(' | ');
        assert.match(plan.find((x) => x.parent === 0).detail, /^(SCAN|SEARCH) t\b/, `outer loop is not tracks: ${details}`);
        assert.doesNotMatch(details, /idx_user_metadata_user_rating/, `rating index drives the join: ${details}`);
        assert.doesNotMatch(details, /CORRELATED/, `a correlated subquery is back: ${details}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
