/**
 * Instant Mix's probe (src/api/discovery-mix.js) — the one statement the
 * walk runs per 400 ranked hashes, with every song filter as a hard WHERE.
 *
 *   - EXPLAIN QUERY PLAN pins for the statement the route actually prepares
 *     (captured, not mirrored — the test/db/autodj-cooldown.test.mjs way):
 *     the rowid IN-list drives it; each hash leg runs on its INDEXED BY
 *     index (unpinned, the file_hash leg took idx_tracks_audio_hash at 25k
 *     tracks); moods and the rating are primary-key probes, and nothing
 *     drives from idx_tracks_library or the rating index;
 *   - the parameter order, with minRating and every filter at once: the
 *     rating join's user id first, then the library, the rating floor and
 *     each filter's values, then the hashes twice — pinned by the bound
 *     values and by the songs that come back, exactly the ones that pass,
 *     a file-hash-only song (audio_hash NULL) among them;
 *   - the same drive under Bun, whose bundled SQLite plans on its own;
 *   - three walks the integration fixture is too small to show, each in a
 *     library of its own: a two-corner item whose tight corner has more
 *     neighbours than the walk's target, an album and the song at its
 *     centre, and a list whose one visible non-member is a member's
 *     remaster.
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

// 0-16: the probe's songs (below); 17-23: the walks' own corners.
const DIM = 24;
const HEADS = ['happy', 'sad', 'relaxed', 'aggressive', 'instrumental', 'acoustic', 'party', 'danceable'];

let testRoot;
let config, manager, ddb, sim, mix;
const lib = {};
let uid;
let handler;

const unit = (v) => {
  let n = 0;
  for (const x of v) { n += x * x; }
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
};
// Every candidate sits at cos 0.98 from the seed, on a dimension of its
// own (so no two are the same recording), and the ranking reaches them all.
const near = (k) => {
  const v = new Array(DIM).fill(0);
  v[0] = 1;
  v[k] = 0.2;
  return unit(v);
};

// Title → what it is planted with. Every one is a Jazz-tagged, relaxed,
// 120-ish BPM, 8A, 200 s song in `main`, rated 8 — but for the one thing
// its name says it breaks.
const SONGS = {
  seed: {},
  'pass audio': {},
  'pass file hash': { fileHashOnly: true, genreSource: 'model' },
  'low rating': { rating: 3 },
  'unrated': { rating: null },
  'rock': { genre: 'Rock' },
  'too long': { duration: 900 },
  'no length': { duration: null },
  'aggressive': { moods: [0.1, 0.1, 0.1, 0.9, 0.5, 0.1, 0.5, 0.5] },
  'no moods': { moods: null },
  'too fast': { bpm: 170 },
  'no bpm': { bpm: null },
  'off key': { key: '1A' },
  'no key': { key: null },
  'the interlude': {},
  'playlist file': { format: 'm3u' },
  'elsewhere': { library: 'other' },
};
const PASS = ['seed', 'pass audio', 'pass file hash'];

const BODY = {
  from: { song: 'main/seed.mp3' },
  minRating: 6,
  genres: ['jazz'],
  minDuration: 100,
  maxDuration: 300,
  moods: { energy: 'relaxed' },
  bpmRanges: [{ min: 112, max: 128 }],
  requireBpm: true,
  musicalKeys: ['8A'],
  requireMusicalKey: true,
  skipWords: ['interlude'],
  ignoreVPaths: ['other'],
};

// Run the route's handler with every statement it prepares recorded (sql +
// bound params), so the pins below look at the real SQL.
async function capture(body, libraries = ['main', 'other']) {
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
  let out;
  try {
    await handler({ body, user: { id: uid, username: 'dj', libraryIds: libraries.map((n) => lib[n]), vpaths: libraries } },
      { json: (x) => { out = x; } });
  } finally {
    delete d.prepare;
  }
  return { out, seen };
}
const probes = (seen) => seen.filter((s) => /INDEXED BY idx_tracks_audio_hash/.test(s.sql));
const planOf = ({ sql, params }) => manager.getDB().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);

before(async () => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-discovery-mix-'));
  fs.mkdirSync(path.join(testRoot, 'db'), { recursive: true });
  const folders = {};
  for (const name of ['main', 'other', 'third']) {
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
  config.program.scanOptions.collectDiscoveryData = true;
  config.program.scanOptions.discoveryModel = 'test-fake';
  manager = await import('../../src/db/manager.js');
  manager.initDB();
  ddb = await import('../../src/db/discovery-db.js');
  ddb.initDiscoveryDb(path.join(testRoot, 'db', 'discovery.db'));
  sim = await import('../../src/db/discovery-similarity.js');
  mix = await import('../../src/api/discovery-mix.js');
  mix.setup({ post: (route, fn) => { if (route === '/api/v1/discovery/local/mix') { handler = fn; } } });

  const d = manager.getDB();
  for (const r of d.prepare('SELECT id, name FROM libraries').all()) { lib[r.name] = r.id; }
  d.prepare("INSERT INTO users (username, password, salt) VALUES ('dj', 'x', 'y')").run();
  uid = d.prepare("SELECT id FROM users WHERE username = 'dj'").get().id;

  d.exec('BEGIN');
  const artist = Number(d.prepare("INSERT INTO artists (name, name_key) VALUES ('Combo', 'combo')").run().lastInsertRowid);
  const genre = (name) => Number(d.prepare('INSERT INTO genres (name) VALUES (?)').run(name).lastInsertRowid);
  const genres = { Jazz: genre('Jazz'), Rock: genre('Rock') };
  const insTrack = d.prepare(`INSERT INTO tracks
    (filepath, library_id, title, artist_id, audio_hash, file_hash, format, bpm, musical_key, duration)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const tg = d.prepare('INSERT INTO track_genres (track_id, genre_id, source) VALUES (?, ?, ?)');
  const tm = d.prepare(`INSERT INTO track_moods (track_id, ${HEADS.join(', ')}) VALUES (?, ${HEADS.map(() => '?').join(', ')})`);
  const um = d.prepare('INSERT INTO user_metadata (user_id, track_hash, rating, play_count) VALUES (?, ?, ?, 1)');

  // Ballast in `main`: enough rows that driving from idx_tracks_library is
  // a real alternative, none of them ranked.
  for (let i = 0; i < 400; i++) {
    insTrack.run(`ballast/${i}.mp3`, lib.main, `ballast ${i}`, artist, `ballast-${i}`, `bf-${i}`, 'mp3', 120, '8A', 200);
  }

  const ins = ddb.getDiscoveryDb();
  ins.exec('BEGIN');
  Object.entries(SONGS).forEach(([title, o], k) => {
    const hash = o.fileHashOnly ? `f-${k}` : `h-${k}`;
    const id = Number(insTrack.run(
      `${title}.mp3`, lib[o.library ?? 'main'], title, artist,
      o.fileHashOnly ? null : hash, `f-${k}`, o.format ?? 'mp3',
      'bpm' in o ? o.bpm : 120 + (k % 3), 'key' in o ? o.key : 'A minor', 'duration' in o ? o.duration : 200,
    ).lastInsertRowid);
    tg.run(id, genres[o.genre ?? 'Jazz'], o.genreSource ?? 'tag');
    const moods = 'moods' in o ? o.moods : [0.5, 0.2, 0.8, 0.1, 0.5, 0.3, 0.2, 0.3];
    if (moods) { tm.run(id, ...moods); }
    const rating = 'rating' in o ? o.rating : 8;
    if (rating !== null) { um.run(uid, hash, rating); }
    const v = title === 'seed' ? unit([1, ...new Array(DIM - 1).fill(0)]) : near(k);
    ddb.upsertDiscoveryTrack({
      audioHash: hash, artist: 'Combo', title, duration: 200, modelId: 'test-fake', modelVersion: '1',
      embedding: Buffer.from(v.buffer, v.byteOffset, v.byteLength),
    });
  });
  ins.exec('COMMIT');
  d.exec('COMMIT');
  ddb.publishIndexEpoch();
  sim.invalidate();
});

after(() => {
  try { manager.close(); } catch (_e) { /* closed */ }
  try { ddb.closeDiscoveryDb(); } catch (_e) { /* closed */ }
  try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch (_e) { /* win locks */ }
  setImmediate(() => process.exit(0));
});

describe('the mix probe', () => {
  test('minRating and every filter at once: exactly the songs that pass, a file-hash-only one among them', async () => {
    const { out } = await capture(BODY);
    assert.ok(out, 'the handler answered');
    assert.deepEqual(out.songs.map((s) => s.metadata.title).sort(), [...PASS].sort());
    assert.equal(out.songs[0].metadata.title, 'seed', 'the seed passes, so it leads');
    assert.deepEqual(out.moods, { energy: 'relaxed' });
    assert.equal(out.filteredOut, false);
  });

  test('the parameter order: the rating join first, then the library, the floor, each filter, the hashes twice', async () => {
    const { seen } = await capture(BODY);
    const walk = probes(seen).find((s) => s.params.length > 40);
    assert.ok(walk, 'the walk probed a chunk');
    assert.match(walk.sql, /LEFT JOIN user_metadata um .* um\.user_id = \?/);
    const p = walk.params;
    assert.equal(p[0], uid, "the rating join's user id");
    assert.equal(p[1], lib.main, 'the library clause (other is ignored)');
    assert.equal(p[2], 6, 'the rating floor');
    assert.deepEqual(p.slice(3, 5), ['jazz', 100], 'genre, then the length window');
    assert.equal(p[5], 300);
    assert.deepEqual(p.slice(6, 8), [112, 128], 'the BPM window');
    const n = (p.length - 8 - 4) / 2;   // after 8A's four spellings, the hashes twice
    assert.deepEqual(p.slice(8, 12).sort(), ['8A', 'A minor', 'Am', 'Amin'].sort());
    assert.deepEqual(p.slice(12, 12 + n), p.slice(12 + n), 'the hashes, once per leg');
    assert.ok(p.slice(12).every((h) => typeof h === 'string' && /^[hf]-\d+$/.test(h)));
  });

  test('the plan: driven by the rowid IN-list, both legs on their hash index, PK probes for moods and the rating', async () => {
    const { seen } = await capture(BODY);
    const all = probes(seen);
    assert.ok(all.length >= 2, 'the walk chunk and the seed');
    for (const s of all) {
      const plan = planOf(s);
      const details = plan.map((r) => r.detail).join(' | ');
      const outer = plan.find((r) => r.parent === 0);
      assert.match(outer.detail, /^SEARCH t USING INTEGER PRIMARY KEY \(rowid=\?\)/, `outer loop: ${details}`);
      assert.match(details, /SEARCH tracks USING (COVERING )?INDEX idx_tracks_audio_hash \(audio_hash=\?\)/, details);
      assert.match(details, /SEARCH tracks USING (COVERING )?INDEX idx_tracks_hash \(file_hash=\?\)/, details);
      assert.match(details, /SEARCH tm (EXISTS )?USING INTEGER PRIMARY KEY \(rowid=\?\)/, `moods: ${details}`);
      assert.match(details, /SEARCH um USING INDEX sqlite_autoindex_user_metadata_1 \(user_id=\? AND track_hash=\?\) LEFT-JOIN/, `rating: ${details}`);
      assert.doesNotMatch(details, /SCAN t\b/, `a tracks scan: ${details}`);
      assert.doesNotMatch(details, /idx_tracks_library|idx_user_metadata_user_rating/, details);
    }
  });

  test('the same drive with several libraries in scope', async () => {
    const { out, seen } = await capture(BODY, ['main', 'other', 'third']);
    assert.deepEqual(out.songs.map((s) => s.metadata.title).sort(), [...PASS].sort());
    const walk = probes(seen).find((s) => s.params.length > 40);
    assert.match(walk.sql, /t\.library_id IN \(\?,\?\)/, 'main and third');
    const plan = planOf(walk);
    assert.match(plan.find((r) => r.parent === 0).detail, /^SEARCH t USING INTEGER PRIMARY KEY \(rowid=\?\)/,
      plan.map((r) => r.detail).join(' | '));
  });

  test('an unfiltered probe keeps the same drive', async () => {
    const { out, seen } = await capture({ from: { song: 'main/seed.mp3' } }, ['main', 'other', 'third']);
    assert.ok(out.songs.length > PASS.length);
    for (const s of probes(seen)) {
      const plan = planOf(s);
      assert.match(plan.find((r) => r.parent === 0).detail, /^SEARCH t USING INTEGER PRIMARY KEY/);
      assert.doesNotMatch(s.sql, /library_id IN/, 'every library visible: no library clause');
    }
  });
});

// ── The walk, at sizes the integration fixture cannot reach ─────────────────
//
// Corners of their own (dims 17-23, which no song above touches): in
// `third`, a two-corner list and the Trio album; in `other`, a remaster of
// 'elsewhere'. Each mix is asked for a caller who sees that library alone.

describe('the walk', () => {
  // Every song its own three of dims 1-16, so no two are one recording.
  const triples = [];
  for (let a = 1; a <= 16; a++) {
    for (let b = a + 1; b <= 16; b++) {
      for (let c = b + 1; c <= 16; c++) { triples.push([a, b, c]); }
    }
  }
  const vec = (parts) => {
    const v = new Array(DIM).fill(0);
    for (const [k, x] of parts) { v[k] += x; }
    return unit(v);
  };
  const nudged = (corner, w, n) => vec([[corner, 1], ...triples[n].map((k) => [k, w / Math.sqrt(3)])]);
  const titles = (out) => out.songs.map((s) => s.metadata.title);

  before(() => {
    const d = manager.getDB();
    const artistIds = new Map();
    const artistOf = (name) => {
      if (!artistIds.has(name)) {
        const row = d.prepare('SELECT id FROM artists WHERE name_key = ?').get(name.toLowerCase());
        artistIds.set(name, row ? row.id
          : Number(d.prepare('INSERT INTO artists (name, name_key) VALUES (?, ?)').run(name, name.toLowerCase()).lastInsertRowid));
      }
      return artistIds.get(name);
    };
    const trio = Number(d.prepare("INSERT INTO albums (name, artist_id) VALUES ('Trio', ?)").run(artistOf('Band')).lastInsertRowid);
    const ins = d.prepare(`INSERT INTO tracks (filepath, library_id, title, artist_id, album_id, audio_hash, file_hash, format, duration)
                           VALUES (?, ?, ?, ?, ?, ?, ?, 'mp3', 200)`);
    let n = 0;
    const add = (library, title, artist, v, album = null) => {
      n++;
      ins.run(`${title}.mp3`, lib[library], title, artistOf(artist), album, `w-${n}`, `wf-${n}`);
      ddb.upsertDiscoveryTrack({
        audioHash: `w-${n}`, artist, title, duration: 200, modelId: 'test-fake', modelVersion: '1',
        embedding: Buffer.from(v.buffer, v.byteOffset, v.byteLength),
      });
    };
    d.exec('BEGIN');
    // The list: two songs of a tight corner (17) and two of a loose one
    // (18). 150 neighbours of the tight corner at cos 0.89, past the walk's
    // target at 10 songs (84); 20 of the loose one at 0.71.
    add('third', 'T1', 'Tight', vec([[17, 1], [19, 0.1]]));
    add('third', 'T2', 'Tight', vec([[17, 1], [19, -0.1]]));
    add('third', 'L1', 'Loose', vec([[18, 1], [19, 0.1]]));
    add('third', 'L2', 'Loose', vec([[18, 1], [19, -0.1]]));
    for (let i = 0; i < 150; i++) { add('third', `tight ${i}`, `Tight Neighbour ${i}`, nudged(17, 0.5, i)); }
    for (let i = 0; i < 20; i++) { add('third', `loose ${i}`, `Loose Neighbour ${i}`, nudged(18, 1, 150 + i)); }
    // Trio, three songs at cos 0.86 to each other, and Central: cos 0.9999
    // to their centroid, 0.95 to each — the album's sound, no member's
    // recording.
    for (const k of [1, 2, 3]) { add('third', `A${k}`, 'Band', vec([[20, 1], [20 + k, 0.4]]), trio); }
    add('third', 'Central', 'Elsewhere Band', vec([[20, 1], [21, 0.13], [22, 0.13], [23, 0.13]]));
    // Beside 'elsewhere' (near(16)), another Combo song and a remaster of
    // 'elsewhere' (cos 0.9998), 0.96 from the two songs' centroid.
    add('other', 'another', 'Combo', vec([[0, 1], [17, 0.6]]));
    add('other', 'elsewhere (Remaster)', 'Combo', vec([[0, 1], [16, 0.2], [19, 0.02]]));
    d.exec('COMMIT');
    ddb.publishIndexEpoch();
    sim.invalidate();
  });

  test('every point of a several-point item fills its quota, however far its neighbours rank', async () => {
    const { out } = await capture({ from: { songs: ['third/T1.mp3', 'third/T2.mp3', 'third/L1.mp3', 'third/L2.mp3'] }, limit: 10 }, ['third']);
    assert.deepEqual(out.seed, { kind: 'songs', members: 4, analyzed: 4 });
    const t = titles(out);
    assert.equal(t.length, 10);
    assert.equal(t.filter((x) => x.startsWith('loose ')).length, 5, `the loose corner's half: ${t}`);
    assert.equal(t.filter((x) => x.startsWith('tight ')).length, 5, t.join(', '));
  });

  test("an album's most album-like song leads its mix: a member's recording is judged by the members", async () => {
    for (const from of [{ album: { album: 'Trio' } }, { songs: ['third/A1.mp3', 'third/A2.mp3', 'third/A3.mp3'] }]) {
      const { out } = await capture({ from }, ['third']);
      assert.equal(out.seed.members, 3, JSON.stringify(from));
      assert.equal(titles(out)[0], 'Central', `${JSON.stringify(from)}: ${titles(out).slice(0, 5)}`);
      assert.ok(!titles(out).some((x) => /^A\d$/.test(x)), 'its own songs stay out');
    }
  });

  test("a member's remaster is the only song in reach: nothing similar, not filtered out", async () => {
    const { out } = await capture({ from: { songs: ['other/elsewhere.mp3', 'other/another.mp3'] } }, ['other']);
    assert.deepEqual(out.seed, { kind: 'songs', members: 2, analyzed: 2 });
    assert.deepEqual(out.songs, [], 'the remaster is a member’s recording');
    assert.equal(out.filteredOut, false, 'no filter was set');
    // A filter on the same list does not change what the filters did.
    const { out: rated } = await capture({ from: { songs: ['other/elsewhere.mp3', 'other/another.mp3'] }, minRating: 6 }, ['other']);
    assert.deepEqual(rated.songs, []);
    assert.equal(rated.filteredOut, false, 'the remaster would be left out without it too');
  });
});

// ── Bun ─────────────────────────────────────────────────────────────────────
//
// Bun ships its own SQLite (behind the bun:sqlite adapter), and the drive is
// a query-planner fact, so the probe runs there too: a fresh library of six
// filter-passing songs (one file-hash-only) across a two-library scope, the
// handler run with every filter, its probe plans returned as JSON. Skips
// where no bun is installed (CI always has one).
const BUN_PROBE = `
const repo = process.env.MIX_REPO;
const dir = process.env.MIX_DIR;
const fs = await import('node:fs');
const path = await import('node:path');
fs.mkdirSync(path.join(dir, 'db'), { recursive: true });
const folders = {};
for (const n of ['main', 'other', 'third']) {
  fs.mkdirSync(path.join(dir, n), { recursive: true });
  folders[n] = { root: path.join(dir, n) };
}
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
  storage: { dbDirectory: path.join(dir, 'db'), albumArtDirectory: path.join(dir, 'art'), logsDirectory: path.join(dir, 'logs') },
  folders, port: 0,
}));
const config = await import(repo + '/src/state/config.js');
await config.setup(path.join(dir, 'config.json'));
config.program.scanOptions.collectDiscoveryData = true;
config.program.scanOptions.discoveryModel = 'test-fake';
const manager = await import(repo + '/src/db/manager.js');
manager.initDB();
const ddb = await import(repo + '/src/db/discovery-db.js');
ddb.initDiscoveryDb(path.join(dir, 'db', 'discovery.db'));
const sim = await import(repo + '/src/db/discovery-similarity.js');
const mix = await import(repo + '/src/api/discovery-mix.js');
let handler;
mix.setup({ post: (r, fn) => { handler = fn; } });
const d = manager.getDB();
const lib = Object.fromEntries(d.prepare('SELECT id, name FROM libraries').all().map((r) => [r.name, r.id]));
d.prepare("INSERT INTO users (username, password, salt) VALUES ('dj', 'x', 'y')").run();
const uid = d.prepare("SELECT id FROM users WHERE username = 'dj'").get().id;
const artist = Number(d.prepare("INSERT INTO artists (name, name_key) VALUES ('Combo', 'combo')").run().lastInsertRowid);
const jazz = Number(d.prepare("INSERT INTO genres (name) VALUES ('Jazz')").run().lastInsertRowid);
for (let k = 0; k < 6; k++) {
  const hash = k === 2 ? 'f-2' : 'h-' + k;
  const id = Number(d.prepare("INSERT INTO tracks (filepath, library_id, title, artist_id, audio_hash, file_hash, format, bpm, musical_key, duration) VALUES (?, ?, ?, ?, ?, ?, 'mp3', 120, 'A minor', 200)")
    .run(k === 0 ? 'seed.mp3' : 's' + k + '.mp3', k === 5 ? lib.other : lib.main, 's' + k, artist, k === 2 ? null : hash, 'f-' + k).lastInsertRowid);
  d.prepare("INSERT INTO track_genres (track_id, genre_id, source) VALUES (?, ?, 'tag')").run(id, jazz);
  d.prepare('INSERT INTO track_moods (track_id, happy, sad, relaxed, aggressive, instrumental, acoustic, party, danceable) VALUES (?, 0.5, 0.2, 0.8, 0.1, 0.5, 0.3, 0.2, 0.3)').run(id);
  d.prepare('INSERT INTO user_metadata (user_id, track_hash, rating, play_count) VALUES (?, ?, 8, 1)').run(uid, hash);
  const v = new Float32Array(12);
  v[0] = 1;
  if (k) { v[k] = 0.2; }
  const n = Math.hypot(...v);
  for (let i = 0; i < v.length; i++) { v[i] /= n; }
  ddb.upsertDiscoveryTrack({ audioHash: hash, artist: 'Combo', title: 's' + k, duration: 200, modelId: 'test-fake', modelVersion: '1', embedding: Buffer.from(v.buffer) });
}
ddb.publishIndexEpoch();
sim.invalidate();
const real = d.prepare.bind(d);
const seen = [];
d.prepare = (sql) => {
  const st = real(sql);
  return {
    all: (...p) => { seen.push({ sql, p }); return st.all(...p); },
    get: (...p) => { seen.push({ sql, p }); return st.get(...p); },
  };
};
let out;
await handler({
  body: { from: { song: 'main/seed.mp3' }, minRating: 6, genres: ['jazz'], minDuration: 100, maxDuration: 300,
    moods: { energy: 'relaxed' }, bpmRanges: [{ min: 112, max: 128 }], musicalKeys: ['8A'], requireMusicalKey: true,
    skipWords: ['nope'], ignoreVPaths: ['third'] },
  user: { id: uid, username: 'dj', libraryIds: [lib.main, lib.other, lib.third], vpaths: ['main', 'other', 'third'] },
}, { json: (x) => { out = x; } });
d.prepare = real;
const plans = seen.filter((s) => /INDEXED BY idx_tracks_audio_hash/.test(s.sql))
  .map((s) => real('EXPLAIN QUERY PLAN ' + s.sql).all(...s.p).map((r) => ({ parent: r.parent, detail: r.detail })));
console.log(JSON.stringify({ titles: out.songs.map((s) => s.metadata.title), plans }));
process.exit(0);
`;

describe('bun', { skip: noBun }, () => {
  test('every filter at once: the same songs, the same drive', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-discovery-mix-bun-'));
    try {
      const r = spawnSync(BUN_BIN, ['-e', BUN_PROBE], {
        encoding: 'utf8', timeout: 60_000, windowsHide: true,
        env: { ...process.env, MIX_REPO: REPO_ROOT, MIX_DIR: dir },
      });
      assert.equal(r.status, 0, `bun probe exited ${r.status} (${r.error?.message ?? r.signal ?? ''}):\n${r.stderr}`);
      const { titles, plans } = JSON.parse(r.stdout.trim().split('\n').pop());
      assert.deepEqual([...titles].sort(), ['s0', 's1', 's2', 's3', 's4', 's5']);
      assert.equal(titles[0], 's0', 'the seed leads');
      assert.ok(plans.length >= 2, 'the walk chunk and the seed');
      for (const plan of plans) {
        const details = plan.map((x) => x.detail).join(' | ');
        assert.match(plan.find((x) => x.parent === 0).detail, /^SEARCH t USING INTEGER PRIMARY KEY \(rowid=\?\)/, `outer loop: ${details}`);
        assert.match(details, /SEARCH tracks USING (COVERING )?INDEX idx_tracks_audio_hash \(audio_hash=\?\)/, details);
        assert.match(details, /SEARCH tracks USING (COVERING )?INDEX idx_tracks_hash \(file_hash=\?\)/, details);
        assert.match(details, /SEARCH tm (EXISTS )?USING INTEGER PRIMARY KEY \(rowid=\?\)/, details);
        assert.doesNotMatch(details, /SCAN t\b|idx_tracks_library|idx_user_metadata_user_rating/, details);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
