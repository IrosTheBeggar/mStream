/**
 * Instant Mix — POST /api/v1/discovery/local/mix (src/api/discovery-mix.js):
 * the songs of the caller's library that sound like a song, an album, an
 * artist, a playlist or a list of songs, under Auto DJ's song filters —
 * every one of them hard.
 *
 * The random-sonic.test.mjs strategy: a real server (discovery on, model
 * 'test-fake') over a generated library, with HANDCRAFTED vectors planted
 * in discovery.db after the scan, so every cosine is known in advance, and
 * lengths, BPM, keys, moods, model genres and ratings planted straight into
 * the main database, the way the scanner and the syncs would.
 *
 * The space (40-d): a song is cos θ·e0 + sin θ·e1 plus 0.2 on a dimension
 * of its own, so two songs of one artist meet at 0.96 and two artists at
 * cos(Δθ)/1.04 — never at 0.99, the same-recording line, but for the one
 * near-duplicate pair planted on purpose.
 *
 *   mix      Alba 0° (5, Folk) · Brio 10° (3, Jazz) · Cielo 20° (3, Jazz)
 *            · Duna 25° (3, Ambient) · Eco 40° (3, Electronic) · Faro 90°
 *            (Faro Days, 2015–2016, ×2, and the one-song Faro Single;
 *            Ambient) · Gale 130° (2, Electronic)
 *   messy    Mona 200°: a seed, one recording in two files ('Twin'), two
 *            recordings of one song ('Mirror') and a near-duplicate pair
 *            ('Haze' / 'Haze (Remaster)')
 *   vault    Vera 2°, right beside Alba — admin and `solo` only
 *   testlib  the shared fixture, never analysed (the notAnalyzed answers)
 *
 * Covers the gate, validation, every seed kind, notAnalyzed, the walk
 * (determinism, the three dedupe layers, cap / spread / relaxed, quotas,
 * short, capped), each hard filter with the property "every returned row
 * satisfies every filter" over all seeds, filteredOut, the parity lock with
 * random-songs, the rank cache, access, and federation.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../helpers/server.mjs';
import { generateLibrary, mkSpec } from '../helpers/library-gen.mjs';
import { CAMELOT_TO_KEYS } from '../../src/db/camelot.js';

const ROUTE = '/api/v1/discovery/local/mix';
const ADMIN = { username: 'admin', password: 'pw-admin' };   // every library
const BOB = { username: 'bob', password: 'pw-bob' };         // testlib, mix, messy
const SOLO = { username: 'solo', password: 'pw-solo' };      // vault

const HEADS = ['happy', 'sad', 'relaxed', 'aggressive', 'instrumental', 'acoustic', 'party', 'danceable'];
const DIM = 40;
const REMASTER_DIM = 38;
const GHOST_DIM = 39;

const song = (lib, artist, album, year, genre, title, theta, o = {}) => ({ lib, artist, album, year, genre, title, theta, ...o });
// Moods: [happy, sad, relaxed, aggressive, instrumental, acoustic, party, danceable].
const SONGS = [
  song('mix', 'Alba', 'Alba LP', 2019, 'Folk', 'Amber', 0, { dur: 200, bpm: 120, key: 'A minor', moods: [0.8, 0.1, 0.7, 0.1, 0.9, 0.8, 0.2, 0.3], rating: 8 }),
  song('mix', 'Alba', 'Alba LP', 2019, 'Folk', 'Ash', 0, { dur: 95, bpm: 122, key: '8A', moods: [0.2, 0.7, 0.8, 0.1, 0.2, 0.9, 0, 0.1] }),
  song('mix', 'Alba', 'Alba LP', 2019, 'Folk', 'Aster', 0, { dur: 240, bpm: 60, key: 'C major', moods: [0.6, 0.2, 0.4, 0.6, 0.8, 0.1, 0.7, 0.8] }),
  song('mix', 'Alba', 'Alba LP', 2019, 'Folk', 'Aura', 0, {}),   // no length, BPM, key or moods
  song('mix', 'Alba', 'Alba LP', 2019, 'Folk', 'Azure', 0, { dur: 300, bpm: 90, key: 'E minor', moods: [0.4, 0.4, 0.6, 0.2, 0.5, 0.5, 0.4, 0.5] }),
  song('mix', 'Brio', 'Brio Nights', 2020, 'Jazz', 'Bay', 10, { dur: 180, bpm: 118, key: 'Dm', moods: [0.9, 0, 0.3, 0.7, 0.1, 0.2, 0.9, 0.9], model: 'Swing', rating: 6 }),
  song('mix', 'Brio', 'Brio Nights', 2020, 'Jazz', 'Bloom', 10, { dur: 260, bpm: 126, key: 'G major', moods: [0.3, 0.6, 0.9, 0, 0.9, 0.7, 0.1, 0.2], rating: 10 }),
  // Its file name, not its tags, carries the word 'bonus'.
  song('mix', 'Brio', 'Brio Nights', 2020, 'Jazz', 'Breeze', 10, { file: '03 - bonus take', dur: 150, bpm: 240, key: '8A', moods: [0.7, 0.2, 0.6, 0.3, 0.6, 0.3, 0.5, 0.6] }),
  song('mix', 'Cielo', 'Cielo', 2021, 'Jazz', 'Canyon', 20, { dur: 210, bpm: 100, key: '5A', moods: [0.1, 0.8, 0.5, 0.4, 0.3, 0.2, 0.1, 0.2] }),
  song('mix', 'Cielo', 'Cielo', 2021, 'Jazz', 'Coral', 20, { dur: 130, bpm: 121, key: 'Am', moods: [0.6, 0.3, 0.7, 0.2, 0.7, 0.6, 0.3, 0.4] }),
  song('mix', 'Cielo', 'Cielo', 2021, 'Jazz', 'Crest', 20, { dur: 330, key: '8B', moods: [0.5, 0.5, 0.2, 0.8, 0.2, 0.1, 0.8, 0.9] }),
  song('mix', 'Duna', 'Duna Tapes', 2018, 'Ambient', 'Delta', 25, { dur: 400, bpm: 70, key: '1A', moods: [0.2, 0.3, 0.9, 0, 1, 0.4, 0, 0.1] }),
  song('mix', 'Duna', 'Duna Tapes', 2018, 'Ambient', 'Dune', 25, { dur: 125, bpm: 124, key: 'F major', moods: [0.7, 0.1, 0.6, 0.2, 0.8, 0.2, 0.3, 0.5] }),
  song('mix', 'Duna', 'Duna Tapes', 2018, 'Ambient', 'Dusk', 25, { dur: 90, bpm: 119, key: '9A', moods: [0.3, 0.6, 0.8, 0.1, 0.9, 0.3, 0.1, 0.2], model: 'Folk' }),
  song('mix', 'Eco', 'Eco EP', 2022, 'Electronic', 'Echo', 40, { dur: 220, bpm: 128, key: '8A', moods: [0.6, 0.2, 0.2, 0.7, 0.4, 0, 0.9, 0.9], model: 'Jazz', rating: 4 }),
  song('mix', 'Eco', 'Eco EP', 2022, 'Electronic', 'Ember', 40, { dur: 175, bpm: 140, key: '10A', moods: [0.4, 0.5, 0.3, 0.6, 0.6, 0.1, 0.6, 0.7] }),
  song('mix', 'Eco', 'Eco EP', 2022, 'Electronic', 'Eon (Acapella)', 40, { dur: 110, bpm: 115, key: '8B', moods: [0.5, 0.3, 0.5, 0.3, 0.1, 0.6, 0.4, 0.5] }),
  song('mix', 'Faro', 'Faro Days', 2015, 'Ambient', 'Fern', 90, { dur: 230, bpm: 80, key: '1A', moods: [0.2, 0.5, 0.8, 0.1, 0.9, 0.6, 0.1, 0.2], rating: 8 }),
  song('mix', 'Faro', 'Faro Days', 2016, 'Ambient', 'Fjord', 90, { dur: 280, bpm: 82, key: '1B', moods: [0.3, 0.4, 0.9, 0, 0.95, 0.5, 0, 0.1] }),
  song('mix', 'Faro', 'Faro Single', 2023, 'Ambient', 'Lone', 90, { dur: 190, bpm: 85, key: '12A', moods: [0.1, 0.7, 0.7, 0.1, 0.8, 0.8, 0, 0.1] }),
  song('mix', 'Gale', 'Gale Side', 2017, 'Electronic', 'Gust', 130, { dur: 205, bpm: 160, key: '4A', moods: [0.5, 0.2, 0.3, 0.6, 0.7, 0, 0.6, 0.8] }),
  song('mix', 'Gale', 'Gale Side', 2017, 'Electronic', 'Glow', 130, { dur: 145, bpm: 120, key: '8A', moods: [0.8, 0.1, 0.4, 0.4, 0.6, 0.1, 0.7, 0.8] }),
  song('messy', 'Mona', 'Loose Ends', 2010, null, 'Messy Seed', 200, { file: '00 - Messy Seed', dur: 200 }),
  song('messy', 'Mona', 'Loose Ends', 2010, null, 'Twin', 200, { file: '01 - Twin', dur: 200 }),
  song('messy', 'Mona', 'Loose Ends', 2010, null, 'Mirror', 200, { file: '02 - Mirror', dur: 200 }),
  song('messy', 'Mona', 'Loose Ends', 2010, null, 'Mirror', 200, { file: '03 - Mirror', dur: 200 }),
  song('messy', 'Mona', 'Loose Ends', 2010, null, 'Haze', 200, { file: '04 - Haze', dur: 200 }),
  song('messy', 'Mona', 'Loose Ends', 2010, null, 'Haze (Remaster)', 200, { file: '05 - Haze (Remaster)', dur: 200, remasterOf: 'Haze' }),
  // One song in two recordings, only the second analysed yet.
  song('messy', 'Mona', 'Loose Ends', 2010, null, 'Lantern', 200, { file: '06 - Lantern', dur: 200, noVec: true }),
  song('messy', 'Mona', 'Loose Ends', 2010, null, 'Lantern', 200, { file: '07 - Lantern', dur: 200 }),
  song('vault', 'Vera', 'Vault', 2000, 'Folk', 'Vault Song', 2, { dur: 200, bpm: 120, key: 'A minor', moods: [0.8, 0.1, 0.7, 0.1, 0.9, 0.8, 0.2, 0.3] }),
];
// A byte copy of Twin: the same recording in a second file.
const TWIN_COPY_REL = 'Mona/Loose Ends Copy/01 - Twin.mp3';
const TWIN_COPY = `messy/${TWIN_COPY_REL}`;

let root;
let server;
let offServer;
const tokens = {};
const TRUTH = new Map();   // wire path -> what the filters read

const unit = (v) => {
  let n = 0;
  for (const x of v) { n += x * x; }
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
};
const blob = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
function songVec(deg, own, extra = null) {
  const v = new Float32Array(DIM);
  v[0] = Math.cos((deg * Math.PI) / 180);
  v[1] = Math.sin((deg * Math.PI) / 180);
  v[own] = 0.2;
  if (extra) { v[extra[0]] = extra[1]; }
  return unit(v);
}

const of = (title) => SONGS.find((s) => s.title === title);
const P = (title) => of(title).path;

async function mix(body, { user = 'admin', srv = server, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (user && tokens[user] && srv === server) { h['x-access-token'] = tokens[user]; }
  const r = await fetch(`${srv.baseUrl}${ROUTE}`, { method: 'POST', headers: h, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const titles = (r) => r.body.songs.map((s) => s.metadata.title);
const paths = (r) => r.body.songs.map((s) => s.filepath);
const artistOf = (s) => s.metadata.artist;

// ── the filters, read back from the planted truth ───────────────────────────

const fold = (s) => String(s || '').toLowerCase().replace(/(.)\1+/g, '$1');
function moodHolds(m, f) {
  if (!m) { return false; }   // not analysed: matches no mood filter
  const t = f.threshold ?? 0.5;
  const on = (x) => x >= t;
  const off = (x) => x < Math.round((1 - t) * 100) / 100;
  const scale = (value, lo, hi) => (value === 'neutral'
    ? off(m[lo]) && off(m[hi])
    : value === lo ? on(m[lo]) && m[lo] >= m[hi] : on(m[hi]) && m[hi] > m[lo]);
  if (f.valence && !scale(f.valence, 'happy', 'sad')) { return false; }
  if (f.energy && !scale(f.energy, 'relaxed', 'aggressive')) { return false; }
  if (f.voice === 'instrumental' && !on(m.instrumental)) { return false; }
  if (f.voice === 'vocals' && !off(m.instrumental)) { return false; }
  return (f.tags || []).every((tag) => on(m[tag]));
}

// Why `wirePath` breaks `body` for `user` — null when it keeps every promise.
function breaks(wirePath, body, user) {
  const t = TRUTH.get(wirePath);
  if (!t) { return 'unknown path'; }
  const visible = { admin: ['testlib', 'mix', 'messy', 'vault'], bob: ['testlib', 'mix', 'messy'], solo: ['vault'] }[user];
  if (visible && !visible.includes(t.lib)) { return `library ${t.lib}`; }
  if (body.ignoreVPaths?.includes(t.lib)) { return 'ignoreVPaths'; }
  if (body.minRating > 0 && user === 'admin' && (t.rating ?? 0) < body.minRating) { return 'minRating'; }
  if (body.genres?.length) {
    const hit = t.genres.some((g) => body.genres.some((n) => n.toLowerCase() === g.name.toLowerCase())
      && (!body.genreSource || g.source === body.genreSource));
    if ((body.genreMode === 'blacklist') === hit) { return 'genres'; }
  }
  const lo = body.minDuration > 0 ? body.minDuration : null;
  const hi = body.maxDuration > 0 ? body.maxDuration : null;
  if (lo !== null || hi !== null) {
    if (t.dur == null) {
      if (body.allowUnknownDuration !== true) { return 'unknown length'; }
    } else if ((lo !== null && t.dur < lo) || (hi !== null && t.dur > hi)) { return 'length'; }
  }
  if (body.moods && !moodHolds(t.moods, body.moods)) { return 'moods'; }
  if (body.bpmRanges?.length && !(t.bpm != null && body.bpmRanges.some((r) => t.bpm >= r.min && t.bpm <= r.max))) { return 'bpmRanges'; }
  if (body.requireBpm && t.bpm == null) { return 'requireBpm'; }
  if (body.musicalKeys?.length) {
    const names = new Set(body.musicalKeys.flatMap((c) => CAMELOT_TO_KEYS[c.toUpperCase()] || []));
    if (t.key == null || !names.has(t.key)) { return 'musicalKeys'; }
  }
  if (body.requireMusicalKey && t.key == null) { return 'requireMusicalKey'; }
  if (body.skipWords?.length) {
    const hay = fold([t.title, t.artist, t.album, wirePath].join(' '));
    if (body.skipWords.some((w) => hay.includes(fold(w)))) { return 'skipWords'; }
  }
  return null;
}

function assertKeepsFilters(r, body, user, label) {
  assert.equal(r.status, 200, `${label}: ${JSON.stringify(r.body)}`);
  for (const s of r.body.songs) {
    const why = breaks(s.filepath, body, user);
    assert.equal(why, null, `${label}: ${s.filepath} breaks ${why}`);
  }
}

// ── the library ─────────────────────────────────────────────────────────────

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-mix-'));
  const specs = { mix: [], messy: [], vault: [] };
  const inAlbum = new Map();
  SONGS.forEach((s, i) => {
    const n = (inAlbum.get(`${s.lib}/${s.album}`) ?? 0) + 1;
    inAlbum.set(`${s.lib}/${s.album}`, n);
    s.rel = `${s.artist}/${s.album}/${s.file ?? `${String(n).padStart(2, '0')} - ${s.title}`}.mp3`;
    s.path = `${s.lib}/${s.rel}`;
    s.own = 2 + i;
    // Tones above the shared fixture's 220–540 Hz: the same tone is the
    // same audio hash, i.e. one recording.
    specs[s.lib].push(mkSpec({
      filepath: s.rel, title: s.title, artist: s.artist, album: s.album, year: s.year, genre: s.genre, track: n,
      toneFreq: 1000 + i * 23,
    }));
  });
  for (const s of SONGS) {
    s.vec = s.remasterOf
      ? songVec(s.theta, of(s.remasterOf).own, [REMASTER_DIM, 0.02])
      : songVec(s.theta, s.own);
  }
  for (const [lib, list] of Object.entries(specs)) {
    await generateLibrary({ outputDir: path.join(root, lib), specs: list });
  }
  fs.mkdirSync(path.join(root, 'messy', path.dirname(TWIN_COPY_REL)), { recursive: true });
  fs.copyFileSync(path.join(root, 'messy', of('Twin').rel), path.join(root, 'messy', TWIN_COPY_REL));

  [server, offServer] = await Promise.all([
    startServer({
      dlnaMode: 'disabled',
      extraConfig: {
        federation: { enabled: true },
        scanOptions: { collectDiscoveryData: true, discoveryModel: 'test-fake' },
      },
      extraFolders: { mix: path.join(root, 'mix'), messy: path.join(root, 'messy'), vault: path.join(root, 'vault') },
      users: [
        { ...ADMIN, admin: true, vpaths: ['testlib', 'mix', 'messy', 'vault'] },
        { ...BOB, admin: false, vpaths: ['testlib', 'mix', 'messy'] },
        { ...SOLO, admin: false, vpaths: ['vault'] },
      ],
    }),
    startServer({ dlnaMode: 'disabled', waitForScan: false }),
  ]);
  for (const u of [ADMIN, BOB, SOLO]) {
    const r = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(u),
    });
    tokens[u.username] = (await r.json()).token;
  }

  const mdb = new DatabaseSync(path.join(server.tmpDir, 'db', 'mstream.db'));
  const ddb = new DatabaseSync(path.join(server.tmpDir, 'db', 'discovery.db'));
  try {
    const rowOf = mdb.prepare(`
      SELECT t.id, COALESCE(t.audio_hash, t.file_hash) AS hash
        FROM tracks t JOIN libraries l ON l.id = t.library_id
       WHERE l.name = ? AND t.filepath = ?`);
    const plant = mdb.prepare('UPDATE tracks SET duration = ?, bpm = ?, musical_key = ? WHERE id = ?');
    const mood = mdb.prepare(`INSERT INTO track_moods (track_id, ${HEADS.join(', ')}) VALUES (?, ${HEADS.map(() => '?').join(', ')})`);
    const genreId = (name) => {
      mdb.prepare('INSERT OR IGNORE INTO genres (name) VALUES (?)').run(name);
      return mdb.prepare('SELECT id FROM genres WHERE name = ?').get(name).id;
    };
    const modelLink = mdb.prepare("INSERT INTO track_genres (track_id, genre_id, source) VALUES (?, ?, 'model')");
    const adminId = mdb.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
    const rate = mdb.prepare('INSERT INTO user_metadata (user_id, track_hash, rating, play_count) VALUES (?, ?, ?, 0)');
    const embed = ddb.prepare(`
      INSERT OR IGNORE INTO discovery_tracks
        (audio_hash, updated_at, export_id, artist, title, duration, model_id, model_version, embedding, genre_tags)
      VALUES (?, ?, ?, ?, ?, ?, 'test-fake', '1', ?, ?)`);
    let seq = 0;
    for (const s of SONGS) {
      const t = rowOf.get(s.lib, s.rel);
      assert.ok(t?.hash, `scanned: ${s.path}`);
      Object.assign(s, { id: t.id, hash: t.hash });
      plant.run(s.dur ?? null, s.bpm ?? null, s.key ?? null, t.id);
      if (s.moods) { mood.run(t.id, ...s.moods); }
      if (s.model) { modelLink.run(t.id, genreId(s.model)); }
      if (s.rating) { rate.run(adminId, t.hash, s.rating); }
      if (s.noVec) { continue; }
      seq++;
      embed.run(t.hash, seq, `anon:${seq}`, s.artist, s.title, s.dur ?? 1, blob(s.vec),
        s.title === 'Amber' ? JSON.stringify(['Folk---Indie Folk']) : null);
    }
    const copy = rowOf.get('messy', TWIN_COPY_REL);
    assert.equal(copy?.hash, of('Twin').hash, 'the copy is the same recording');
    plant.run(200, null, null, copy.id);
    // Raw INSERTs don't bump the rowversion; the index would cache an empty view.
    ddb.prepare("UPDATE discovery_meta SET value = ? WHERE key = 'row_seq'").run(String(seq));
    ddb.prepare("INSERT OR REPLACE INTO discovery_meta (key, value) VALUES ('embedding_model_version', '1')").run();

    // What every filter reads, per file, back from the database.
    const genres = new Map();
    for (const g of mdb.prepare(`SELECT tg.track_id, g.name, tg.source FROM track_genres tg JOIN genres g ON g.id = tg.genre_id`).all()) {
      if (!genres.has(g.track_id)) { genres.set(g.track_id, []); }
      genres.get(g.track_id).push({ name: g.name, source: g.source });
    }
    const moods = new Map(mdb.prepare('SELECT * FROM track_moods').all().map((m) => [m.track_id, m]));
    const ratings = new Map(mdb.prepare('SELECT track_hash, rating FROM user_metadata WHERE user_id = ?').all(adminId)
      .map((r) => [r.track_hash, r.rating]));
    for (const t of mdb.prepare(`
      SELECT t.id, l.name AS lib, t.filepath, t.title, a.name AS artist, al.name AS album, t.duration AS dur,
             t.bpm, t.musical_key AS key, COALESCE(t.audio_hash, t.file_hash) AS hash
        FROM tracks t JOIN libraries l ON l.id = t.library_id
        LEFT JOIN artists a ON a.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id`).all()) {
      TRUTH.set(`${t.lib}/${t.filepath}`, {
        ...t, genres: genres.get(t.id) ?? [], moods: moods.get(t.id) ?? null, rating: ratings.get(t.hash) ?? null,
      });
    }
  } finally {
    mdb.close();
    ddb.close();
  }

  // Playlists: admin's three-artist "Road trip", bob's two-corner "Eclectic".
  for (const [user, title, songs] of [
    ['admin', 'Road trip', [P('Bloom'), P('Canyon'), P('Delta')]],
    ['bob', 'Eclectic', [P('Amber'), P('Ash'), P('Aster'), P('Aura'), P('Lone'), P('Fern')]],
  ]) {
    const r = await fetch(`${server.baseUrl}/api/v1/playlist/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': tokens[user] },
      body: JSON.stringify({ title, songs }),
    });
    assert.equal(r.status, 200, `${user}'s ${title}`);
  }
});

after(async () => {
  await Promise.all([server?.stop(), offServer?.stop()]);
  if (root) { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── gate + validation ───────────────────────────────────────────────────────

describe('mix: gate and validation', () => {
  test('403 while discovery is off', async () => {
    const r = await mix({ from: { song: 'testlib/Icarus/Be Somebody/01 - Be Somebody.mp3' } }, { srv: offServer });
    assert.equal(r.status, 403);
  });

  test('`from`: required, exactly one kind, each kind bounded', async () => {
    for (const [label, from] of [
      ['missing', undefined],
      ['empty', {}],
      ['doubled', { song: P('Amber'), artist: 'Alba' }],
      ['an unknown kind', { vectors: ['AAAA'] }],
      ['the singles bucket', { album: null }],
      ['a null album name', { album: { album: null } }],
      ['an album key album-songs never had', { album: { album: 'Alba LP', compilation: true } }],
      ['no songs', { songs: [] }],
      ['501 songs', { songs: Array(501).fill(P('Amber')) }],
      ['a blank artist', { artist: '' }],
    ]) {
      const r = await mix(from === undefined ? {} : { from });
      assert.equal(r.status, 400, `${label}: ${JSON.stringify(r.body)}`);
    }
  });

  test("Auto DJ's session keys and every key outside the contract are refused by name", async () => {
    for (const key of ['ignoreList', 'ignoreArtists', 'artists', 'bpmRangesWide', 'similarTo', 'similarToVector',
      'similarToModelId', 'minSimilarity', 'lessLike', 'lessLikeVectors', 'lessLikeModelId', 'includeSeed',
      'offset', 'variety', 'maxPerArtist', 'vectors']) {
      const r = await mix({ from: { song: P('Amber') }, [key]: ['x'] });
      assert.equal(r.status, 400, key);
      assert.match(r.body.error, new RegExp(`"${key}" is not allowed`));
    }
  });

  test('bounds, BPM order, Camelot codes, the length window, moods and skipWords', async () => {
    const from = { song: P('Amber') };
    for (const [label, extra] of [
      ['limit 0', { limit: 0 }],
      ['limit 201', { limit: 201 }],
      ['minRating 11', { minRating: 11 }],
      ['a backwards BPM range', { bpmRanges: [{ min: 200, max: 100 }] }],
      ['BPM out of bounds', { bpmRanges: [{ min: 0, max: 1001 }] }],
      ['17 BPM ranges', { bpmRanges: Array(17).fill({ min: 100, max: 120 }) }],
      ['no recognised Camelot code', { musicalKeys: ['ZZ', '13A'] }],
      ['a backwards length window', { minDuration: 300, maxDuration: 100 }],
      ['a length past a day', { maxDuration: 86401 }],
      ['an unknown mood group', { moods: { tempo: 'fast' } }],
      ['an unknown mood value', { moods: { energy: 'sleepy' } }],
      ['a mood threshold out of range', { moods: { energy: 'relaxed', threshold: 0.95 } }],
      ['a genre mode', { genreMode: 'greylist' }],
      ['a genre source', { genreSource: 'both' }],
      ['51 skip words', { skipWords: Array.from({ length: 51 }, (_, i) => `w${i}`) }],
      ['a skip word of 101 characters', { skipWords: ['x'.repeat(101)] }],
      ['a blank skip word', { skipWords: ['   '] }],
    ]) {
      const r = await mix({ from, ...extra });
      assert.equal(r.status, 400, `${label}: ${JSON.stringify(r.body)}`);
    }
    // At the edges: accepted.
    const ok = await mix({ from, limit: 200, minRating: 0, skipWords: [' x '.repeat(1)], minDuration: 0, maxDuration: 86400 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });
});

// ── seeds ───────────────────────────────────────────────────────────────────

describe('mix: seeds', () => {
  test('a song leads its own mix, with the response envelope', async () => {
    const r = await mix({ from: { song: P('Amber') } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.model, { id: 'test-fake', version: '1' });
    assert.deepEqual(r.body.seed, { kind: 'song', members: 1, analyzed: 1 });
    assert.equal(r.body.notAnalyzed, false);
    const [first] = r.body.songs;
    assert.equal(first.filepath, P('Amber'));
    assert.equal(first.similarity, 1);
    assert.deepEqual(first.genreTags, ['Folk---Indie Folk'], "the index entry's model tags");
    assert.equal(first.metadata.title, 'Amber');
    assert.equal(first.metadata.bpm, 120);
    assert.equal(first.metadata['musical-key'], 'A minor');
    assert.equal(first.metadata.duration, 200);
    for (const key of ['short', 'capped', 'relaxed', 'floor', 'filteredOut']) { assert.ok(key in r.body, key); }
    assert.deepEqual(r.body.moods, {}, 'the echo: this server has mood scores');
    const second = r.body.songs[1];
    assert.equal(typeof second.similarity, 'number');
    assert.ok(second.similarity < 1);
    assert.equal(titles(r).filter((t) => t === 'Amber').length, 1, 'the seed once');
  });

  test('a song a filter excludes drops out of its own mix', async () => {
    const body = { from: { song: P('Amber') }, minDuration: 210 };   // Amber is 200 s
    const r = await mix(body);
    assertKeepsFilters(r, body, 'admin', 'minDuration 210');
    assert.ok(!titles(r).includes('Amber'));
    assert.ok(r.body.songs.length > 0);
    // The skip words count too: its own title.
    const skipped = await mix({ from: { song: P('Amber') }, skipWords: ['AMBER'] });
    assert.ok(!titles(skipped).includes('Amber'));
  });

  test('an album leaves its own songs out and matches its year range', async () => {
    const r = await mix({ from: { album: { album: 'Alba LP', artist: 'Alba', album_artist: null, year: 2019 } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.seed, { kind: 'album', members: 5, analyzed: 5 });
    const alba = SONGS.filter((s) => s.album === 'Alba LP').map((s) => s.path);
    assert.ok(r.body.songs.length > 0);
    for (const p of paths(r)) { assert.ok(!alba.includes(p), `member ${p} came back`); }

    // Faro Days spans 2015–2016: either year finds it, 2017 does not.
    for (const year of [2015, 2016]) {
      const y = await mix({ from: { album: { album: 'Faro Days', year } } });
      assert.equal(y.status, 200, `year ${year}`);
      assert.equal(y.body.seed.members, 2);
      assert.ok(!titles(y).includes('Fern') && !titles(y).includes('Fjord'));
    }
    const off = await mix({ from: { album: { album: 'Faro Days', year: 2017 } } });
    assert.equal(off.status, 404);
    assert.equal(off.body.error, 'Album not found');
    const credited = await mix({ from: { album: { album: 'Faro Days', album_artist: 'Faro' } } });
    assert.equal(credited.status, 200);
    assert.equal((await mix({ from: { album: { album: 'Faro Days', album_artist: 'Gale' } } })).status, 404);
  });

  test("an artist's mix keeps its own songs, inside the cap", async () => {
    // One point (Alba LP's centroid); at 8 songs the cap is 2, and the band
    // holds four artists, so it never has to give.
    const r = await mix({ from: { artist: 'alba' }, limit: 8 }, { user: 'bob' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.seed.kind, 'artist');
    assert.equal(r.body.seed.members, 5);
    assert.deepEqual(r.body.relaxed, []);
    const alba = r.body.songs.filter((s) => artistOf(s) === 'Alba').length;
    assert.ok(alba >= 1, 'its own songs stay in');
    assert.ok(alba <= 2, `capped at 2, got ${alba}`);
    assert.equal(r.body.songs.length, 8);
  });

  test("a one-song album's song survives its artist's mix", async () => {
    // Faro Single's only song IS its album's point (cos 1): a near-dup
    // guard on the ranking would drop it.
    const r = await mix({ from: { artist: 'Faro' } }, { user: 'bob' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.seed, { kind: 'artist', members: 3, analyzed: 3 });
    for (const t of ['Lone', 'Fern', 'Fjord']) { assert.ok(titles(r).includes(t), t); }
  });

  test("playlists: the caller's own, by name; anyone else's is a 404", async () => {
    const r = await mix({ from: { playlist: 'Road trip' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.seed, { kind: 'playlist', members: 3, analyzed: 3 });
    for (const t of ['Bloom', 'Canyon', 'Delta']) { assert.ok(!titles(r).includes(t), `member ${t}`); }
    assert.ok(r.body.songs.length > 0);
    for (const [user, name] of [['bob', 'Road trip'], ['admin', 'Eclectic'], ['admin', 'No such list']]) {
      const other = await mix({ from: { playlist: name } }, { user });
      assert.equal(other.status, 404, `${user} / ${name}`);
      assert.equal(other.body.error, 'Playlist not found');
    }
  });

  test('songs: what resolves seeds the mix; nothing resolvable is a 404', async () => {
    const r = await mix({ from: { songs: [P('Amber'), 'mix/nope.mp3', P('Vault Song'), '../../etc/passwd'] } }, { user: 'bob' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.seed, { kind: 'songs', members: 1, analyzed: 1 });
    assert.ok(!titles(r).includes('Amber'), 'a member never comes back');
    const none = await mix({ from: { songs: ['mix/nope.mp3', P('Vault Song')] } }, { user: 'bob' });
    assert.equal(none.status, 404);
    assert.equal(none.body.error, 'Track not found');
  });

  test('unknown and forbidden items get the same 404', async () => {
    for (const [from, error] of [
      [{ song: 'mix/nope.mp3' }, 'Track not found'],
      [{ song: P('Vault Song') }, 'Track not found'],
      [{ song: 'nolib/x.mp3' }, 'Track not found'],
      [{ album: { album: 'No Such Album' } }, 'Album not found'],
      [{ album: { album: 'Vault' } }, 'Album not found'],
      [{ artist: 'Nobody' }, 'Artist not found'],
      [{ artist: 'Vera' }, 'Artist not found'],
    ]) {
      const r = await mix({ from }, { user: 'bob' });
      assert.equal(r.status, 404, JSON.stringify(from));
      assert.deepEqual(r.body, { error }, JSON.stringify(from));
    }
  });

  test('notAnalyzed: a song with no vector yet, and items none of whose songs has one', async () => {
    const one = await mix({ from: { song: 'testlib/Vosto/Night Drive/03 - Static.mp3' } });
    assert.equal(one.status, 200);
    assert.equal(one.body.notAnalyzed, true);
    assert.deepEqual(one.body.songs, []);
    assert.deepEqual(one.body.seed, { kind: 'song', members: 1, analyzed: 0 });
    for (const from of [{ album: { album: 'Night Drive', artist: 'Vosto' } }, { artist: 'Vosto' }]) {
      const r = await mix({ from });
      assert.equal(r.status, 200, JSON.stringify(from));
      assert.equal(r.body.notAnalyzed, true, JSON.stringify(from));
      assert.deepEqual(r.body.songs, []);
      assert.equal(r.body.seed.analyzed, 0);
      assert.ok(r.body.seed.members > 1);
    }
  });
});

// ── the walk ────────────────────────────────────────────────────────────────

describe('mix: the walk', () => {
  test('the same body gives the same list', async () => {
    for (const body of [{ from: { song: P('Coral') } }, { from: { artist: 'Brio' }, limit: 12 }, { from: { playlist: 'Eclectic' }, limit: 9 }]) {
      const user = body.from.playlist ? 'bob' : 'admin';
      const a = await mix(body, { user });
      const b = await mix(body, { user });
      assert.equal(a.status, 200);
      assert.deepEqual(b.body, a.body, JSON.stringify(body));
    }
  });

  test('three dedupe layers: one file per recording, one recording per song, one take of a near-duplicate', async () => {
    const r = await mix({ from: { song: P('Messy Seed') } }, { user: 'bob' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const count = (t) => titles(r).filter((x) => x === t).length;
    assert.equal(count('Twin'), 1, 'Twin is one recording in two files');
    assert.equal(count('Mirror'), 1, 'Mirror is one song in two recordings');
    assert.equal(count('Haze') + count('Haze (Remaster)'), 1, 'the remaster sits at cos 0.9998');
    assert.ok([of('Twin').path, TWIN_COPY].includes(r.body.songs.find((s) => s.metadata.title === 'Twin').filepath));
  });

  test("an item's own recordings stay out: another file of a member, and a member's near-duplicate", async () => {
    // Three members, so their centroid sits at cos 0.987 from Haze — under
    // the ranking's own near-dup guard. Only the walk's check against each
    // member keeps 'Haze (Remaster)' (cos 0.9998 to Haze) out.
    const members = [P('Haze'), P('Messy Seed'), SONGS.find((s) => s.file === '02 - Mirror').path];
    const r = await mix({ from: { songs: members } }, { user: 'bob' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.seed, { kind: 'songs', members: 3, analyzed: 3 });
    for (const t of ['Haze', 'Haze (Remaster)', 'Messy Seed', 'Mirror']) { assert.ok(!titles(r).includes(t), t); }
    assert.ok(titles(r).includes('Twin'), 'the rest of the corner comes');

    // A member with no vector yet still keeps its song out: the analysed
    // file of 'Lantern' is the same song, by the library row's name key.
    const lantern = SONGS.filter((s) => s.title === 'Lantern');
    const l = await mix({ from: { songs: [lantern[0].path, P('Haze'), P('Messy Seed')] } }, { user: 'bob' });
    assert.deepEqual(l.body.seed, { kind: 'songs', members: 3, analyzed: 2 });
    assert.ok(!titles(l).includes('Lantern'));
    assert.ok(titles(await mix({ from: { songs: [P('Haze'), P('Messy Seed')] } }, { user: 'bob' })).includes('Lantern'));
  });

  test("a song's other recordings stay out of its mix", async () => {
    const [a, b] = SONGS.filter((s) => s.title === 'Mirror');
    const r = await mix({ from: { song: a.path } }, { user: 'bob' });
    assert.equal(r.body.songs[0].filepath, a.path);
    assert.ok(!paths(r).includes(b.path), 'one song, two recordings');
  });

  test('the artist cap and the spread, and `relaxed` when the band cannot fill', async () => {
    // Amber's band at 8 songs holds Alba, Brio, Cielo and Duna: two each.
    const r = await mix({ from: { song: P('Amber') }, limit: 8 }, { user: 'bob' });
    assert.equal(r.status, 200);
    assert.equal(r.body.songs.length, 8);
    assert.deepEqual(r.body.relaxed, []);
    const per = new Map();
    for (const s of r.body.songs) { per.set(artistOf(s), (per.get(artistOf(s)) || 0) + 1); }
    assert.deepEqual([...per.values()].sort(), [2, 2, 2, 2], JSON.stringify([...per]));
    for (let i = 1; i < r.body.songs.length; i++) {
      assert.notEqual(artistOf(r.body.songs[i]), artistOf(r.body.songs[i - 1]), `rows ${i - 1}/${i} share an artist`);
    }
    // At 10 the band runs out of artists under the cap, so it gives.
    const ten = await mix({ from: { song: P('Amber') }, limit: 10 }, { user: 'bob' });
    assert.equal(ten.body.songs.length, 10);
    assert.deepEqual(ten.body.relaxed, ['artistCap']);
    assert.equal(ten.body.songs.filter((s) => artistOf(s) === 'Alba').length, 4);
    // Play order: the seed, then bands by similarity.
    assert.equal(ten.body.songs[0].metadata.title, 'Amber');
  });

  test('quotas keep every corner of an eclectic playlist', async () => {
    // Bob's "Eclectic": four Alba songs and two Faro songs. Ranked by best
    // point alone, the nine closest songs are eight from the Alba side
    // plus Fjord; the Faro point's third of the quota brings in Gale.
    const r = await mix({ from: { playlist: 'Eclectic' }, limit: 9 }, { user: 'bob' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.seed, { kind: 'playlist', members: 6, analyzed: 6 });
    assert.equal(r.body.songs.length, 9);
    for (const t of ['Fjord', 'Gust', 'Glow', 'Azure']) { assert.ok(titles(r).includes(t), `${t} in ${titles(r)}`); }
    for (const t of ['Amber', 'Ash', 'Aster', 'Aura', 'Lone', 'Fern']) { assert.ok(!titles(r).includes(t), `member ${t}`); }
  });

  test('`short` when fewer songs pass than asked; not `capped` while the walk saw everything', async () => {
    const body = { from: { song: P('Amber') }, genres: ['Folk'] };
    const r = await mix(body, { user: 'bob' });
    assertKeepsFilters(r, body, 'bob', 'Folk');
    assert.deepEqual(titles(r).sort(), ['Amber', 'Ash', 'Aster', 'Aura', 'Azure', 'Dusk'].sort(), 'tag Folk, and Dusk by the model');
    assert.equal(r.body.short, true);
    assert.equal(r.body.capped, false);
    assert.deepEqual(r.body.relaxed, []);
    assert.equal(typeof r.body.floor, 'number');
    const full = await mix({ from: { song: P('Amber') }, limit: 5 }, { user: 'bob' });
    assert.equal(full.body.short, false);
  });
});

// ── every filter, hard ──────────────────────────────────────────────────────

const AMBER_BPM = [{ min: 112, max: 128 }, { min: 56, max: 64 }, { min: 224, max: 256 }];
const AMBER_KEYS = ['8A', '8B', '7A', '7B', '9A', '9B'];
const FILTERS = [
  { ignoreVPaths: ['messy'] },
  { minRating: 6 },
  { genres: ['Jazz'] },
  { genres: ['jazz'], genreSource: 'tag' },
  { genres: ['Jazz'], genreSource: 'model' },
  { genres: ['Ambient'], genreMode: 'blacklist' },
  { genres: ['Folk'], genreMode: 'blacklist', genreSource: 'model' },
  { minDuration: 120, maxDuration: 240 },
  { minDuration: 120, allowUnknownDuration: true },
  { maxDuration: 150 },
  { moods: { valence: 'happy' } },
  { moods: { valence: 'neutral' } },
  { moods: { energy: 'relaxed' } },
  { moods: { energy: 'aggressive', threshold: 0.7 } },
  { moods: { voice: 'vocals' } },
  { moods: { voice: 'instrumental', threshold: 0.3 } },
  { moods: { tags: ['acoustic'] } },
  { bpmRanges: AMBER_BPM },
  { requireBpm: true },
  { musicalKeys: AMBER_KEYS, requireMusicalKey: true },
  { skipWords: ['acappella'] },
  { skipWords: ['bonus', 'loose'] },
];
const COMBOS = [
  { genres: ['Ambient'], genreMode: 'blacklist', minDuration: 100, moods: { energy: 'relaxed' }, ignoreVPaths: ['vault'] },
  { bpmRanges: AMBER_BPM, musicalKeys: AMBER_KEYS, requireMusicalKey: true, skipWords: ['bonus'], minRating: 1, genres: ['Folk', 'Jazz'] },
];

const SEEDS = [
  ...SONGS.filter((s) => s.title !== 'Haze (Remaster)').map((s) => ({ song: s.path })),
  ...[...new Set(SONGS.map((s) => `${s.album}\u0000${s.artist}`))].map((k) => {
    const [album, artist] = k.split('\u0000');
    return { album: { album, artist } };
  }),
  ...[...new Set(SONGS.map((s) => s.artist))].map((artist) => ({ artist })),
  { playlist: 'Road trip' },
  { songs: [P('Amber'), P('Lone'), P('Haze')] },
];

describe('mix: every filter is hard', () => {
  test('every returned row satisfies every filter — all seeds × each filter alone and two combinations', async () => {
    let rows = 0;
    for (const from of SEEDS) {
      for (const f of [...FILTERS, ...COMBOS]) {
        const body = { from, ...f };
        const r = await mix(body);
        assertKeepsFilters(r, body, 'admin', JSON.stringify(body));
        rows += r.body.songs.length;
      }
    }
    assert.ok(rows > 1000, `the property saw ${rows} rows`);
  });

  test('each filter keeps exactly the songs that pass it (Amber, everything in reach)', async () => {
    const reach = [...TRUTH.entries()].filter(([, t]) => t.lib === 'mix').map(([p]) => p);
    for (const f of FILTERS.filter((x) => !x.ignoreVPaths)) {
      const body = { from: { song: P('Amber') }, ignoreVPaths: ['messy', 'vault', 'testlib'], ...f };
      const r = await mix(body);
      assertKeepsFilters(r, body, 'admin', JSON.stringify(f));
      const want = reach.filter((p) => breaks(p, body, 'admin') === null).sort();
      assert.deepEqual([...paths(r)].sort(), want, JSON.stringify(f));
    }
  });

  test('skip words fold repeated letters, on the title and on the path', async () => {
    const r = await mix({ from: { song: P('Echo') }, skipWords: ['ACCAPELLA'] });
    assert.ok(!titles(r).includes('Eon (Acapella)'));
    const path = await mix({ from: { song: P('Bay') }, skipWords: ['bonus'] });
    assert.ok(!titles(path).includes('Breeze'), "Breeze's file is 'bonus take'");
    assert.ok(titles(await mix({ from: { song: P('Bay') } })).includes('Breeze'));
  });

  test('minRating is per user: admin rated five songs; bob rated none', async () => {
    const r = await mix({ from: { song: P('Bay') }, minRating: 6 });
    assert.deepEqual(titles(r).sort(), ['Amber', 'Bay', 'Bloom', 'Fern']);
    const bob = await mix({ from: { song: P('Bay') }, minRating: 6 }, { user: 'bob' });
    assert.deepEqual(bob.body.songs, []);
    assert.equal(bob.body.filteredOut, true);
  });

  test('the mood echo: the filter applied, {} with none — and no key, no filter, without scores', async () => {
    const r = await mix({ from: { song: P('Amber') }, moods: { energy: 'relaxed', threshold: 0.5, tags: ['acoustic'] } });
    assert.deepEqual(r.body.moods, { energy: 'relaxed', tags: ['acoustic'] });
    const strict = await mix({ from: { song: P('Amber') }, moods: { energy: 'relaxed', threshold: 0.7 } });
    assert.deepEqual(strict.body.moods, { energy: 'relaxed', threshold: 0.7 });

    const dbFile = new DatabaseSync(path.join(server.tmpDir, 'db', 'mstream.db'));
    try {
      dbFile.exec('CREATE TEMP TABLE kept AS SELECT * FROM track_moods; DELETE FROM track_moods;');
      const none = await mix({ from: { song: P('Amber') }, moods: { energy: 'aggressive' } });
      assert.equal(none.status, 200);
      assert.ok(!('moods' in none.body), 'no scores: the key is left out');
      assert.ok(titles(none).includes('Bloom'), 'and nothing was filtered');
    } finally {
      dbFile.exec('INSERT INTO track_moods SELECT * FROM kept;');
      dbFile.close();
    }
    const back = await mix({ from: { song: P('Amber') }, moods: { energy: 'aggressive' } });
    assert.deepEqual(back.body.moods, { energy: 'aggressive' });
    assert.ok(!titles(back).includes('Bloom'));
  });
});

// ── filteredOut, parity, the cache, access ──────────────────────────────────

describe('mix: empty answers', () => {
  test('filteredOut when the filters left nothing; not when nothing is similar', async () => {
    const r = await mix({ from: { song: P('Amber') }, skipWords: ['mp3'] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.songs, []);
    assert.equal(r.body.filteredOut, true);
    assert.equal(r.body.notAnalyzed, false);

    // solo sees one analysed song: there is nothing else to be similar.
    const alone = await mix({ from: { song: P('Vault Song') } }, { user: 'solo' });
    assert.equal(alone.status, 200, JSON.stringify(alone.body));
    assert.deepEqual(titles(alone), ['Vault Song']);
    assert.equal(alone.body.filteredOut, false);
    const out = await mix({ from: { song: P('Vault Song') }, minDuration: 600 }, { user: 'solo' });
    assert.deepEqual(out.body.songs, []);
    assert.equal(out.body.filteredOut, false);
  });

  test('a seed that fills a one-song mix alone is a full list, not filteredOut', async () => {
    const r = await mix({ from: { song: P('Amber') }, limit: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(titles(r), ['Amber']);
    assert.equal(r.body.short, false);
    assert.equal(r.body.filteredOut, false);
  });
});

describe('mix: parity with random-songs', () => {
  // The mix library alone: fully analysed, no two files of one song, 22
  // songs — so random-songs at 25 returns its whole pool, and the mix at
  // 200 every song that passes. A base filter applied differently by the
  // two routes fails here.
  const SCOPE = { ignoreVPaths: ['testlib', 'messy', 'vault'] };
  const BASE = [
    {},
    { genres: ['Jazz'] },
    { genres: ['Jazz'], genreSource: 'tag' },
    { genres: ['Jazz', 'Folk'], genreSource: 'model' },
    { genres: ['Ambient'], genreMode: 'blacklist' },
    { minRating: 6 },
    { minDuration: 120, maxDuration: 240 },
    { minDuration: 120, allowUnknownDuration: true },
    { moods: { energy: 'relaxed' } },
    { moods: { valence: 'happy', voice: 'instrumental', threshold: 0.7 } },
    { genres: ['Ambient'], genreMode: 'blacklist', minDuration: 100, moods: { energy: 'relaxed' }, minRating: 1 },
  ];

  test('the same songs pass both routes', async () => {
    for (const f of BASE) {
      const rr = await fetch(`${server.baseUrl}/api/v1/db/random-songs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-access-token': tokens.admin },
        body: JSON.stringify({ ...SCOPE, ...f, limit: 25 }),
      });
      const random = rr.status === 200 ? (await rr.json()).songs.map((s) => s.filepath).sort() : [];
      assert.ok(random.length <= 25);
      const m = await mix({ from: { song: P('Amber') }, limit: 200, ...SCOPE, ...f });
      assert.equal(m.status, 200);
      assert.deepEqual(paths(m).sort(), random, JSON.stringify(f));
    }
  });
});

describe('mix: the rank cache', () => {
  test('a second ask for the same seed with other filters gets its own filtered list', async () => {
    const plain = await mix({ from: { song: P('Canyon') } });
    const jazz = { from: { song: P('Canyon') }, genres: ['Jazz'] };
    const j = await mix(jazz);
    assertKeepsFilters(j, jazz, 'admin', 'Jazz');
    assert.deepEqual(titles(j).sort(), ['Bay', 'Bloom', 'Breeze', 'Canyon', 'Coral', 'Crest', 'Echo']);
    const again = await mix({ from: { song: P('Canyon') } });
    assert.deepEqual(again.body, plain.body, 'the unfiltered ask is unchanged');
    assert.ok(plain.body.songs.length > j.body.songs.length);

    // An item whose walk checks its members: the verdicts cached with its
    // ranking are filter-independent too.
    const album = { from: { album: { album: 'Loose Ends' } } };
    const a1 = await mix(album, { user: 'bob' });
    const short = { ...album, maxDuration: 150 };
    const a2 = await mix(short, { user: 'bob' });
    assertKeepsFilters(a2, short, 'bob', 'maxDuration 150');
    assert.ok(a2.body.songs.length > 0 && a2.body.songs.length < a1.body.songs.length);
    assert.deepEqual((await mix(album, { user: 'bob' })).body, a1.body);
  });
});

describe('mix: access', () => {
  test('a restricted user never receives another library’s songs', async () => {
    const admin = await mix({ from: { song: P('Amber') } });
    assert.ok(titles(admin).includes('Vault Song'), 'the fixture would leak it');
    for (const from of SEEDS.filter((s) => !s.song?.startsWith('vault/') && s.album?.album !== 'Vault' && s.artist !== 'Vera' && !s.playlist)) {
      const r = await mix({ from }, { user: 'bob' });
      assert.equal(r.status, 200, JSON.stringify(from));
      for (const p of paths(r)) { assert.ok(!p.startsWith('vault/'), `${JSON.stringify(from)} → ${p}`); }
    }
  });
});

// ── federation ──────────────────────────────────────────────────────────────

describe('mix: federation', () => {
  test('a key may call it, scoped to its grants; no playlist, no rating filter; the proxy forwards it', async () => {
    const mint = await fetch(`${server.baseUrl}/api/v1/admin/federation/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': tokens.admin },
      body: JSON.stringify({ name: 'Peer', vpaths: ['mix'] }),
    });
    assert.equal(mint.status, 200);
    const { key } = await mint.json();
    const asKey = { user: null, headers: { 'x-federation-key': key } };

    const r = await mix({ from: { song: P('Amber') } }, asKey);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.songs.length > 1);
    for (const p of paths(r)) { assert.ok(p.startsWith('mix/'), p); }
    const rated = await mix({ from: { song: P('Amber') }, minRating: 10 }, asKey);
    assert.deepEqual(rated.body.songs, r.body.songs, 'minRating is skipped for a key');
    assert.equal((await mix({ from: { playlist: 'Road trip' } }, asKey)).status, 404);
    assert.equal((await mix({ from: { song: P('Messy Seed') } }, asKey)).status, 404, 'outside its grant');

    const proxied = await fetch(`${server.baseUrl}/api/v1/federation/peers/424242/api${ROUTE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': tokens.admin },
      body: JSON.stringify({ from: { song: P('Amber') } }),
    });
    assert.equal(proxied.status, 404, 'past the screen; the peer is unknown');
  });
});

// ── capped: last, because it floods the index ───────────────────────────────

describe('mix: capped', () => {
  before(() => {
    // 2,100 catalogue rows whose files are gone — closer to Amber than any
    // song (cos 0.986) and visible to nobody. The walk's whole budget
    // (2,000 at these limits) is spent on them.
    const ghost = new Float32Array(DIM);
    ghost[0] = 1;
    ghost[of('Amber').own] = 0.08;
    ghost[GHOST_DIM] = 0.12;
    const g = unit(ghost);
    const ddb = new DatabaseSync(path.join(server.tmpDir, 'db', 'discovery.db'));
    try {
      const seq = Number(ddb.prepare("SELECT value FROM discovery_meta WHERE key = 'row_seq'").get().value);
      const ins = ddb.prepare(`INSERT INTO discovery_tracks (audio_hash, updated_at, export_id, model_id, model_version, embedding)
                               VALUES (?, ?, ?, 'test-fake', '1', ?)`);
      ddb.exec('BEGIN');
      for (let i = 0; i < 2100; i++) { ins.run(`ghost-${i}`, seq + 1 + i, `anon:ghost-${i}`, blob(g)); }
      ddb.exec('COMMIT');
      ddb.prepare("UPDATE discovery_meta SET value = ? WHERE key = 'row_seq'").run(String(seq + 2100));
    } finally {
      ddb.close();
    }
  });

  test('`capped` when the walk spent its budget short of the limit', async () => {
    const r = await mix({ from: { song: P('Amber') }, limit: 5 }, { user: 'bob' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(titles(r), ['Amber']);
    assert.equal(r.body.short, true);
    assert.equal(r.body.capped, true);
    assert.equal(r.body.filteredOut, false, 'nothing visible in the budget is not the filters');
  });
});
