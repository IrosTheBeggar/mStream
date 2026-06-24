/**
 * Lyrics support end-to-end (V19).
 *
 * Builds a tmp library with four variants so every lookup path is
 * exercised at least once:
 *
 *   1. Embedded unsynced (USLT) — MP3 with -metadata lyrics="..."
 *   2. Sidecar `.lrc` (line-timed karaoke) next to a plain MP3
 *   3. Sidecar `.txt` (plain) next to a plain MP3
 *   4. No lyrics anywhere — negative control
 *
 * Exercises:
 *   - /rest/getLyricsBySongId returns the correct structuredLyrics
 *     shape per variant (synced vs plain entries)
 *   - /rest/getLyrics flattens synced to plain text when that's all
 *     the track has
 *   - /api/v1/lyrics (default mStream API) returns the forward-looking
 *     { lyrics:{default,lyrics:[]}, syncedLyrics:{default,lyrics:[]} }
 *     shape keyed off the filepath, with 404 when a track has no lyrics
 *   - Sidecar-mtime drift triggers a re-read on the NEXT scan (the
 *     fast-path must pick up edits to .lrc without the audio file
 *     changing).
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
import { parseLrc, plainTextToLines } from '../../src/api/subsonic/lrc-parser.js';
import { extractLyrics } from '../../src/db/lyrics-extraction.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FFMPEG = process.platform === 'win32'
  ? path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg.exe')
  : path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg');

const ADMIN = { username: 'lyricsadmin', password: 'pw-lyrics' };

// Fixture definitions. Each entry produces <libDir>/<subdir>/<file>
// plus optional sidecar files.
const TRACKS = [
  // 1. Embedded unsynced lyrics. Uses FLAC (Vorbis LYRICS tag) — ffmpeg's
  //    MP3 writer stuffs the value into a TXXX frame rather than a
  //    proper USLT, and music-metadata doesn't surface TXXX:lyrics as
  //    common.lyrics. FLAC's native Vorbis LYRICS field round-trips
  //    cleanly. This is the same workaround used for COMPILATION in
  //    the V17 multi-artist fixtures.
  { file: 'embedded.flac', ext: 'flac', artist: 'Embed Artist', title: 'Embed Song',
    album: 'Embed Album', year: '2023', track: '1', freq: 420,
    lyrics: 'Line one of the song\nLine two of the song\nChorus here' },

  // 2. LRC sidecar (synced). No embedded lyrics.
  { file: 'synced.mp3', artist: 'Lrc Artist', title: 'Synced Song',
    album: 'Lrc Album', year: '2023', track: '1', freq: 480,
    sidecarLrc: [
      '[ti:Synced Song]',
      '[ar:Lrc Artist]',
      '[offset:+100]',
      '[00:01.00]First synced line',
      '[00:03.50]Second synced line',
      '[00:07.00][00:15.00]Repeated chorus text',
      '[00:20.5]After the bridge',
    ].join('\n') },

  // 3. Plain .txt sidecar. No embedded, no .lrc.
  { file: 'txt.mp3', artist: 'Txt Artist', title: 'Txt Song',
    album: 'Txt Album', year: '2023', track: '1', freq: 540,
    sidecarTxt: 'Plain text line one\nPlain text line two\n\nLine four' },

  // 4. No lyrics anywhere — negative control.
  { file: 'empty.mp3', artist: 'None Artist', title: 'Nothing Here',
    album: 'Empty Album', year: '2023', track: '1', freq: 600 },
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

async function makeTrack(libDir, t) {
  const full = path.join(libDir, t.file);
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
  if (t.lyrics) {
    args.push('-metadata', `lyrics=${t.lyrics}`);
  }
  args.push(full);
  await runFfmpeg(args);

  const base = full.replace(/\.(mp3|flac)$/, '');
  if (t.sidecarLrc) {
    await fs.writeFile(`${base}.lrc`, t.sidecarLrc, 'utf8');
  }
  if (t.sidecarTxt) {
    await fs.writeFile(`${base}.txt`, t.sidecarTxt, 'utf8');
  }
}

let server;
let libDir;
let adminKey;
let adminToken;

before(async () => {
  if (!fsSync.existsSync(FFMPEG)) {
    throw new Error(`bundled ffmpeg missing at ${FFMPEG}`);
  }
  libDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-lyrics-'));
  for (const t of TRACKS) { await makeTrack(libDir, t); }

  server = await startServer({
    dlnaMode: 'disabled',
    users: [{ ...ADMIN, admin: true }],
    extraFolders: { lyrics: libDir },
  });

  const login = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  adminToken = (await login.json()).token;

  await fetch(`${server.baseUrl}/api/v1/admin/users/vpaths`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-token': adminToken },
    body: JSON.stringify({ username: ADMIN.username, vpaths: ['testlib', 'lyrics'] }),
  });

  const keyR = await fetch(`${server.baseUrl}/api/v1/user/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-token': adminToken },
    body: JSON.stringify({ name: 'lyrics-tests' }),
  });
  adminKey = (await keyR.json()).key;
});

after(async () => {
  if (server) { await server.stop(); }
  if (libDir) { await fs.rm(libDir, { recursive: true, force: true }).catch(() => {}); }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function subsonicUrl(method, params = {}) {
  const q = new URLSearchParams();
  q.set('f', 'json'); q.set('apiKey', adminKey); q.set('v', '1.16.1'); q.set('c', 'lyrics-test');
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) { for (const i of v) { q.append(k, i); } }
    else if (v != null)   { q.set(k, v); }
  }
  return `${server.baseUrl}/rest/${method}?${q}`;
}

async function subCall(method, params = {}) {
  const r = await fetch(subsonicUrl(method, params));
  return (await r.json())['subsonic-response'];
}

async function findTrackIdByTitle(title) {
  const env = await subCall('search3', { query: title, songCount: 5 });
  const song = env.searchResult3.song?.find(s => s.title === title);
  return song?.id;
}

async function lyricsCall(filepath) {
  const q = new URLSearchParams();
  if (filepath != null) { q.set('path', filepath); }
  const r = await fetch(`${server.baseUrl}/api/v1/lyrics?${q}`, {
    headers: { 'x-access-token': adminToken },
  });
  return { status: r.status, body: await r.json() };
}

// ── LRC parser unit tests ──────────────────────────────────────────────────
//
// Fast tests that don't need the server. Pin corner-cases that
// real-world LRC files exercise.

describe('parseLrc (unit)', () => {
  test('basic [mm:ss.xx] timestamps', () => {
    const p = parseLrc('[00:12.34]Hello world\n[01:30.00]Second line');
    assert.equal(p.synced, true);
    assert.equal(p.lines.length, 2);
    assert.equal(p.lines[0].time_ms, 12340);
    assert.equal(p.lines[0].text, 'Hello world');
    assert.equal(p.lines[1].time_ms, 90000);
  });

  test('millisecond precision (.xxx) parses correctly', () => {
    const p = parseLrc('[00:01.250]precise');
    assert.equal(p.lines[0].time_ms, 1250);
  });

  test('single-digit fractional (.5) becomes 500ms, not 5ms', () => {
    // Some LRC writers emit fewer than 3 fractional digits. "5" means
    // 5/10 of a second, not 5/1000. We pad on the RIGHT.
    const p = parseLrc('[00:01.5]half-second');
    assert.equal(p.lines[0].time_ms, 1500);
  });

  test('multi-timestamp line yields one entry per stamp', () => {
    const p = parseLrc('[00:01.00][00:05.00][00:09.00]Chorus');
    assert.equal(p.lines.length, 3);
    assert.equal(p.lines.map(l => l.text).join('|'), 'Chorus|Chorus|Chorus');
    assert.deepEqual(p.lines.map(l => l.time_ms), [1000, 5000, 9000]);
  });

  test('[offset:+500] shifts every timestamp', () => {
    const p = parseLrc('[offset:+500]\n[00:01.00]one\n[00:03.00]three');
    assert.equal(p.offsetMs, 500);
    assert.equal(p.lines[0].time_ms, 1500);
    assert.equal(p.lines[1].time_ms, 3500);
  });

  test('negative offset shifts backward and clamps at 0', () => {
    const p = parseLrc('[offset:-2000]\n[00:00.50]clamped\n[00:05.00]shifted');
    assert.equal(p.offsetMs, -2000);
    assert.equal(p.lines[0].time_ms, 0);    // 500ms - 2000ms → clamped
    assert.equal(p.lines[1].time_ms, 3000);
  });

  test('metadata lines [ar:] [ti:] [al:] are skipped', () => {
    const p = parseLrc('[ar:Artist]\n[ti:Title]\n[al:Album]\n[00:01.00]actual line');
    assert.equal(p.lines.length, 1);
    assert.equal(p.lines[0].text, 'actual line');
  });

  test('BOM at start of file does not break first-line parse', () => {
    const p = parseLrc('\uFEFF[00:01.00]first');
    assert.equal(p.lines.length, 1);
    assert.equal(p.lines[0].time_ms, 1000);
  });

  test('empty bracket body after timestamp = instrumental break', () => {
    const p = parseLrc('[00:10.00]lyric\n[00:15.00]\n[00:20.00]resume');
    assert.equal(p.lines.length, 3);
    assert.equal(p.lines[1].text, '');
    assert.equal(p.lines[1].time_ms, 15000);
  });

  test('plain-text input → synced=false', () => {
    const p = parseLrc('just text\nno timestamps');
    assert.equal(p.synced, false);
    assert.equal(p.lines.length, 2);
    assert.equal(p.lines[0].time_ms, 0);
  });
});

// ── Subsonic getLyricsBySongId (structuredLyrics) ───────────────────────────

describe('Subsonic getLyricsBySongId', () => {
  test('track with embedded USLT emits a plain-variant structuredLyrics entry', async () => {
    const id = await findTrackIdByTitle('Embed Song');
    assert.ok(id, 'fixture "Embed Song" should have been scanned');
    const env = await subCall('getLyricsBySongId', { id });
    assert.equal(env.status, 'ok');
    const entries = env.lyricsList.structuredLyrics;
    assert.ok(Array.isArray(entries) && entries.length >= 1);
    const plain = entries.find(e => e.synced === false);
    assert.ok(plain, 'expected a plain structuredLyrics entry');
    // Lines must not carry `start` (it's a synced-only field).
    assert.equal(plain.line[0].start, undefined);
    assert.match(plain.line[0].value, /Line one of the song/);
  });

  test('track with .lrc sidecar emits synced entry with ms offsets', async () => {
    const id = await findTrackIdByTitle('Synced Song');
    const env = await subCall('getLyricsBySongId', { id });
    const entries = env.lyricsList.structuredLyrics;
    const synced = entries.find(e => e.synced === true);
    assert.ok(synced, 'expected a synced structuredLyrics entry');
    // [offset:+100] is applied to every line. [00:01.00] → 1000 + 100.
    assert.equal(synced.line[0].start, 1100);
    assert.equal(synced.line[0].value, 'First synced line');
    // Multi-timestamp line [00:07][00:15]Repeated chorus text →
    // TWO separate entries at those times with the same text.
    const choruses = synced.line.filter(l => l.value === 'Repeated chorus text');
    assert.equal(choruses.length, 2, 'multi-timestamp line should yield 2 entries');
    assert.deepEqual(choruses.map(c => c.start).sort((a, b) => a - b), [7100, 15100]);
  });

  test('track with .txt sidecar emits plain entry (promoted to unsynced)', async () => {
    const id = await findTrackIdByTitle('Txt Song');
    const env = await subCall('getLyricsBySongId', { id });
    const entries = env.lyricsList.structuredLyrics;
    const plain = entries.find(e => e.synced === false);
    assert.ok(plain, 'expected a plain structuredLyrics entry from .txt');
    const texts = plain.line.map(l => l.value);
    assert.ok(texts.includes('Plain text line one'));
    assert.ok(texts.includes('Line four'));
  });

  test('track with NO lyrics returns empty structuredLyrics array', async () => {
    const id = await findTrackIdByTitle('Nothing Here');
    const env = await subCall('getLyricsBySongId', { id });
    assert.equal(env.status, 'ok');
    assert.ok(env.lyricsList);
    const entries = env.lyricsList.structuredLyrics || [];
    assert.equal(entries.length, 0);
  });

  test('missing id → error 10', async () => {
    const env = await subCall('getLyricsBySongId', {});
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 10);
  });
});

// ── Subsonic getLyrics (v1 plain-text envelope) ─────────────────────────────

describe('Subsonic getLyrics (v1)', () => {
  test('returns embedded text verbatim for a track with USLT', async () => {
    const env = await subCall('getLyrics', { artist: 'Embed Artist', title: 'Embed Song' });
    assert.equal(env.status, 'ok');
    assert.ok(env.lyrics);
    assert.match(env.lyrics.value, /Line one of the song/);
    assert.equal(env.lyrics.artist, 'Embed Artist');
  });

  test('flattens synced LRC to plain text when that is all the track has', async () => {
    const env = await subCall('getLyrics', { artist: 'Lrc Artist', title: 'Synced Song' });
    assert.equal(env.status, 'ok');
    // Timestamps stripped; just the text remains.
    assert.match(env.lyrics.value, /First synced line/);
    assert.doesNotMatch(env.lyrics.value, /\[\d/);
  });

  test('case-insensitive substring match', async () => {
    // DSub / Jamstash don't normalise case and sometimes send
    // partial names (e.g. track title with suffix stripped).
    const env = await subCall('getLyrics', { artist: 'embed artist', title: 'embed song' });
    assert.equal(env.status, 'ok');
    assert.match(env.lyrics.value, /Line one/);
  });

  test('no match → empty lyrics envelope (not an error)', async () => {
    const env = await subCall('getLyrics', { artist: 'Nobody', title: 'Nothing matches' });
    assert.equal(env.status, 'ok');
    assert.equal(env.lyrics.value, '');
  });

  test('missing title → error 10', async () => {
    const env = await subCall('getLyrics', { artist: 'anyone' });
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 10);
  });
});

// ── /api/v1/lyrics (default mStream API, keyed off filepath) ─────────────────

describe('/api/v1/lyrics (default mStream API)', () => {
  test('embedded plain lyrics → plain container populated, synced empty', async () => {
    const { status, body } = await lyricsCall('lyrics/embedded.flac');
    assert.equal(status, 200);
    assert.equal(body.lyrics.default, 0);
    assert.equal(body.lyrics.lyrics.length, 1);
    assert.match(body.lyrics.lyrics[0].data, /Line one/);
    assert.equal(body.lyrics.lyrics[0].source, 'embedded'); // tag, no sidecar
    assert.equal(body.syncedLyrics.lyrics.length, 0);
  });

  test('LRC sidecar → synced container holds raw LRC verbatim, plain empty', async () => {
    const { status, body } = await lyricsCall('lyrics/synced.mp3');
    assert.equal(status, 200);
    assert.equal(body.syncedLyrics.lyrics.length, 1);
    const entry = body.syncedLyrics.lyrics[0];
    // Raw LRC is returned unparsed — the client parses it. Text + bracketed
    // timestamps must both survive (i.e. it was NOT flattened to plain).
    assert.match(entry.data, /First synced line/);
    assert.ok(/\[\d\d:\d\d/.test(entry.data), 'synced data should retain LRC timestamps');
    assert.equal(entry.source, 'sidecar');
    assert.equal(body.lyrics.lyrics.length, 0);
  });

  test('.txt sidecar → plain container populated', async () => {
    const { status, body } = await lyricsCall('lyrics/txt.mp3');
    assert.equal(status, 200);
    assert.equal(body.lyrics.lyrics.length, 1);
    assert.match(body.lyrics.lyrics[0].data, /Plain text line one/);
    assert.equal(typeof body.lyrics.lyrics[0].source, 'string');
    assert.equal(body.syncedLyrics.lyrics.length, 0);
  });

  test('track with no lyrics → 404', async () => {
    const { status, body } = await lyricsCall('lyrics/empty.mp3');
    assert.equal(status, 404);
    assert.match(body.error, /no lyrics/i);
  });

  test('unknown path → 404', async () => {
    const { status } = await lyricsCall('lyrics/does-not-exist.flac');
    assert.equal(status, 404);
  });

  test('missing path param → 400', async () => {
    const { status, body } = await lyricsCall(null);
    assert.equal(status, 400);
    assert.match(body.error, /path/i);
  });
});

// ── plainTextToLines (unit) ─────────────────────────────────────────────────

// ── Round-2 regression: extractLyrics reads sidecars even when the
// tag-parse path gave us nothing. scanner.mjs' catch block used to
// populate `songInfo.lyricsInfo` with all-null defaults, which made
// the "run extractLyrics as a fallback" branch unreachable — a FLAC
// with corrupt tag frames + a sibling .lrc would silently have no
// lyrics. The extractor itself has always tolerated a null/empty
// common; the unit test here pins that so a future refactor can't
// quietly break the tag-parse-error fallback path.
describe('extractLyrics (unit) — null-common sidecar fallback', () => {
  test('null common + on-disk .lrc sibling → lyrics come from sidecar', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-lyrics-fallback-'));
    try {
      const audioPath = path.join(tmp, 'song.flac');
      const lrcPath   = path.join(tmp, 'song.lrc');
      // We don't need a real audio file — extractLyrics only looks
      // at `absPath` to compute the sibling directory.
      await fs.writeFile(audioPath, '');
      await fs.writeFile(lrcPath, '[00:01.00]Recovered from tag-parse error', 'utf8');

      // Mimic what parseMyFile passes when music-metadata threw —
      // a barebones object with no `.lyrics` array.
      const nothing = extractLyrics(null, audioPath);
      assert.match(nothing.lyricsSyncedLrc, /Recovered from tag-parse error/);

      // Same result passing an empty `common` (matches the shape
      // scanner.mjs synthesises on its error path).
      const empty = extractLyrics({ lyrics: undefined }, audioPath);
      assert.match(empty.lyricsSyncedLrc, /Recovered from tag-parse error/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe('plainTextToLines (unit)', () => {
  test('trims leading/trailing empty lines but keeps internal blanks', () => {
    const r = plainTextToLines('\n\nfirst\nsecond\n\nthird\n\n');
    const texts = r.lines.map(l => l.text);
    assert.deepEqual(texts, ['first', 'second', '', 'third']);
  });
});
