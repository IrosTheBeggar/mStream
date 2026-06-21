/**
 * Multi-artist / compilation support end-to-end (V17).
 *
 * Builds its own ad-hoc library in a tmp dir with a curated set of
 * fixtures — compilation, collab, multi-value-FLAC, solo-artist
 * fallback — then exercises the Subsonic handlers + non-Subsonic
 * /api/v1/db/* endpoints against it. Kept separate from the default
 * fixtures so the numeric counts in the main fixture summary don't
 * drift (DLNA tests assert against those).
 *
 * Covers:
 *   - Scanner produces one album row for a compilation (not N)
 *   - "Various Artists" is the canonical album-artist
 *   - getArtist("Various Artists") returns the compilation
 *   - getArtist("Comp Artist A") ALSO returns the compilation
 *     (M2M appearance, not just track-artist match)
 *   - Collab "A feat. B" → track_artists = [A:main, B:featured]
 *   - songFromRow emits `artists[]` array
 *   - getAlbum emits `artists[]` + `isCompilation`
 *   - search3 finds artists via the M2M union
 *   - /api/v1/db/artists-albums OR-path finds compilation appearances
 *   - Solo-artist albums still dedupe to one row (no regression)
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../helpers/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FFMPEG = process.platform === 'win32'
  ? path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg.exe')
  : path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg');

const ADMIN = { username: 'admin', password: 'pw-admin' };

// Fixture set. Each entry produces one MP3 under tmp/<artistDir>/<file>.mp3
// with the listed ID3 tags. `albumArtist` is written as TPE2 via ffmpeg's
// `album_artist` metadata key; `compilation` becomes TCMP. `extraArtist`
// appears as a SECOND ARTIST frame for multi-value testing (but ffmpeg's
// ID3v2 writer only emits a single TPE1 by default — we use FLAC for
// multi-value cases instead).
// Compilation tracks use FLAC because ffmpeg's MP3 writer emits TCMP
// as a TXXX frame that music-metadata doesn't map to common.compilation.
// Vorbis COMPILATION works correctly.
const COMPILATION_TRACKS = [
  { file: '01.flac', ext: 'flac', artist: 'Comp Artist A', title: 'Comp Track 1',
    albumArtist: 'Various Artists', compilation: '1', album: 'Best of 2024',
    year: '2024', track: '1', freq: 300 },
  { file: '02.flac', ext: 'flac', artist: 'Comp Artist B', title: 'Comp Track 2',
    albumArtist: 'Various Artists', compilation: '1', album: 'Best of 2024',
    year: '2024', track: '2', freq: 360 },
  { file: '03.flac', ext: 'flac', artist: 'Comp Artist C', title: 'Comp Track 3',
    albumArtist: 'Various Artists', compilation: '1', album: 'Best of 2024',
    year: '2024', track: '3', freq: 420 },
];
const COLLAB_TRACK = {
  file: 'together.mp3', artist: 'Collab Host feat. Collab Guest', title: 'Together',
  albumArtist: 'Collab Host', album: 'Collab Single', year: '2023', track: '1', freq: 500,
};
const SOLO_TRACKS = [
  // Two solo-artist tracks on one album — verifies the non-regression
  // case where ALBUMARTIST equals ARTIST (dedups to one album row).
  { file: 'solo-01.mp3', artist: 'Solo Artist', title: 'Song One',
    albumArtist: 'Solo Artist', album: 'Solo LP', year: '2022', track: '1', freq: 600 },
  { file: 'solo-02.mp3', artist: 'Solo Artist', title: 'Song Two',
    albumArtist: 'Solo Artist', album: 'Solo LP', year: '2022', track: '2', freq: 660 },
];

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', d => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('exit', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`)));
  });
}

async function makeTrack(libDir, subdir, t) {
  const full = path.join(libDir, subdir, t.file);
  await fs.mkdir(path.dirname(full), { recursive: true });
  const ext = t.ext || 'mp3';
  const args = [
    '-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=${t.freq}:sample_rate=44100:duration=1`,
    '-ac', '2',
    ...(ext === 'flac' ? ['-c:a', 'flac'] : ['-c:a', 'libmp3lame', '-b:a', '64k']),
    '-metadata', `artist=${t.artist}`,
    '-metadata', `title=${t.title}`,
    '-metadata', `album=${t.album}`,
    '-metadata', `date=${t.year}`,
    '-metadata', `track=${t.track}`,
    ...(ext === 'mp3' ? ['-id3v2_version', '3'] : []),
  ];
  if (t.albumArtist) { args.push('-metadata', `album_artist=${t.albumArtist}`); }
  if (t.compilation) {
    // Vorbis COMPILATION for FLAC; MP3 TCMP isn't well-supported by
    // music-metadata via ffmpeg's writer (uses TXXX fallback).
    args.push('-metadata', `compilation=${t.compilation}`);
  }
  args.push(full);
  await runFfmpeg(args);
}

let server;
let libDir;
let adminKey;

before(async () => {
  if (!fsSync.existsSync(FFMPEG)) {
    throw new Error(`bundled ffmpeg missing at ${FFMPEG}; can't build V17 fixtures`);
  }
  libDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-v17-'));
  // Build tracks.
  for (const t of COMPILATION_TRACKS) { await makeTrack(libDir, 'compilation', t); }
  await makeTrack(libDir, 'collab', COLLAB_TRACK);
  for (const t of SOLO_TRACKS) { await makeTrack(libDir, 'solo', t); }
  // Spin up the server using this tmp lib as the single fixture root.
  // Set `musicDir` via a temporary override by pre-copying fixtures into
  // the test harness's expected location — easier to just mount the tmp
  // dir directly by passing a custom config.
  // The startServer helper uses ensureFixtures(); we need an extra vpath.
  // Simpler: copy to the default music dir under a new vpath folder, or
  // write a separate harness. Simplest: add to config.folders.
  server = await startServer({
    dlnaMode: 'disabled',
    users: [{ ...ADMIN, admin: true }],
    extraFolders: { v17: libDir },  // see helpers/server.mjs patch
  });

  const login = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  const { token } = await login.json();
  // Grant admin access to the new vpath.
  await fetch(`${server.baseUrl}/api/v1/admin/users/vpaths`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-token': token },
    body: JSON.stringify({ username: ADMIN.username, vpaths: ['testlib', 'v17'] }),
  });
  const keyR = await fetch(`${server.baseUrl}/api/v1/user/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-token': token },
    body: JSON.stringify({ name: 'v17-tests' }),
  });
  adminKey = (await keyR.json()).key;
});

after(async () => {
  if (server) { await server.stop(); }
  if (libDir) { await fs.rm(libDir, { recursive: true, force: true }).catch(() => {}); }
});

function url(method, params = {}) {
  const q = new URLSearchParams();
  q.set('f', 'json');
  q.set('apiKey', adminKey);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) { for (const item of v) { q.append(k, item); } }
    else if (v != null)   { q.set(k, v); }
  }
  return `${server.baseUrl}/rest/${method}?${q}`;
}
async function call(method, params = {}) {
  const r = await fetch(url(method, params));
  return (await r.json())['subsonic-response'];
}

// ── Compilation album collapses to ONE row ────────────────────────────────

describe('Compilation album', () => {
  test('appears once in getAlbumList2 (not N times, one per track-artist)', async () => {
    const env = await call('getAlbumList2', { type: 'alphabeticalByName', size: 50 });
    const matches = env.albumList2.album.filter(a => a.name === 'Best of 2024');
    assert.equal(matches.length, 1, `expected 1 compilation album row, got ${matches.length}`);
    assert.equal(matches[0].songCount, 3);
  });

  test('attributed to Various Artists', async () => {
    const list = await call('getAlbumList2', { type: 'alphabeticalByName', size: 50 });
    const comp = list.albumList2.album.find(a => a.name === 'Best of 2024');
    const full = await call('getAlbum', { id: comp.id });
    assert.equal(full.album.artist, 'Various Artists',
      `expected artist=Various Artists, got ${full.album.artist}`);
    assert.equal(full.album.isCompilation, true);
    assert.equal(full.album.song.length, 3);
  });

  test('getArtist(Various Artists) returns the compilation', async () => {
    const artists = await call('getArtists');
    const flat = artists.artists.index.flatMap(i => i.artist);
    const va = flat.find(a => a.name === 'Various Artists');
    assert.ok(va, 'Various Artists should appear in getArtists');
    const full = await call('getArtist', { id: va.id });
    const bestOf = full.artist.album.find(a => a.name === 'Best of 2024');
    assert.ok(bestOf, 'VA getArtist should surface the compilation');
  });

  test('getArtist(Comp Artist A) also surfaces the compilation (M2M appearance)', async () => {
    const artists = await call('getArtists');
    const flat = artists.artists.index.flatMap(i => i.artist);
    const compA = flat.find(a => a.name === 'Comp Artist A');
    assert.ok(compA, 'Comp Artist A should be in getArtists');
    const full = await call('getArtist', { id: compA.id });
    const bestOf = full.artist.album.find(a => a.name === 'Best of 2024');
    assert.ok(bestOf, 'Comp Artist A appears on the compilation via album_artists M2M');
  });
});

// ── Collab track split into track_artists ─────────────────────────────────

describe('Collab track', () => {
  test('songFromRow emits artists[] with [Host, Guest]', async () => {
    const r = await call('search3', { query: 'Together' });
    const song = r.searchResult3.song?.[0];
    assert.ok(song, `expected to find "Together" via search3`);
    assert.ok(Array.isArray(song.artists), 'song.artists should be populated');
    const names = song.artists.map(a => a.name);
    assert.deepEqual(names, ['Collab Host', 'Collab Guest'],
      `expected split artists, got ${JSON.stringify(names)}`);
  });

  test('album-artist is just Collab Host (not the joined string)', async () => {
    const albums = await call('getAlbumList2', { type: 'alphabeticalByName', size: 50 });
    const single = albums.albumList2.album.find(a => a.name === 'Collab Single');
    assert.ok(single);
    const full = await call('getAlbum', { id: single.id });
    assert.equal(full.album.artist, 'Collab Host');
  });
});

// ── Solo-artist non-regression ────────────────────────────────────────────

describe('Solo-artist album', () => {
  test('dedups to one row with two tracks (no fragmentation)', async () => {
    const albums = await call('getAlbumList2', { type: 'alphabeticalByName', size: 50 });
    const solo = albums.albumList2.album.filter(a => a.name === 'Solo LP');
    assert.equal(solo.length, 1);
    assert.equal(solo[0].songCount, 2);
    assert.equal(solo[0].artist, 'Solo Artist');
  });
});

// ── search3 M2M union ─────────────────────────────────────────────────────

describe('search3 finds compilation contributors', () => {
  test('search for Comp Artist B matches the compilation via album_artists', async () => {
    const r = await call('search3', { query: 'Comp Artist B' });
    const artist = r.searchResult3.artist?.find(a => a.name === 'Comp Artist B');
    assert.ok(artist, 'search should find the compilation contributor by name');
  });

  test('search for Various Artists matches', async () => {
    const r = await call('search3', { query: 'Various Artists' });
    const artist = r.searchResult3.artist?.find(a => a.name === 'Various Artists');
    assert.ok(artist);
  });
});

// ── OpenSubsonic extension advertisement ──────────────────────────────────

describe('OpenSubsonic songArtists extension', () => {
  test('advertised in getOpenSubsonicExtensions', async () => {
    const env = await call('getOpenSubsonicExtensions');
    const names = env.openSubsonicExtensions.map(e => e.name);
    assert.ok(names.includes('songArtists'), `missing from ${JSON.stringify(names)}`);
  });
});

// ── /api/v1/db/artists-albums M2M-OR path ────────────────────────────────

describe('non-Subsonic /api/v1/db/artists-albums (M2M-OR path)', () => {
  test('Comp Artist A returns the compilation album (via album_artists)', async () => {
    const loginR = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ADMIN),
    });
    const { token } = await loginR.json();
    const r = await fetch(`${server.baseUrl}/api/v1/db/artists-albums`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': token },
      body: JSON.stringify({ artist: 'Comp Artist A' }),
    });
    const body = await r.json();
    const bestOf = body.albums.find(a => a.name === 'Best of 2024');
    assert.ok(bestOf, `expected Best of 2024 in albums, got ${JSON.stringify(body.albums.map(a => a.name))}`);
  });
});
