/**
 * Generates a minimal music library used by the integration tests. Each fixture
 * is a 1-second silent MP3 with embedded ID3 tags so the mStream scanner picks
 * it up as a real track with artist/album/title/year metadata.
 *
 * Fixtures are materialised lazily and cached on disk — the first test run
 * uses ffmpeg to produce them, subsequent runs are instant. The generated
 * files are under `test/fixtures/music/` (gitignored).
 */

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MUSIC_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'music');

// Small, deliberately-varied set: multiple artists, an album by two artists
// (exercises compilation/album-artist divergence), multi-disc, unknown genre.
// Keep the list short — the DLNA tests assert counts against it.
const FIXTURES = [
  { artist: 'Icarus', album: 'Be Somebody',       year: 2019, genre: 'Electronic', disc: 1, track: 1, title: 'Be Somebody' },
  { artist: 'Icarus', album: 'Be Somebody',       year: 2019, genre: 'Electronic', disc: 1, track: 2, title: 'Rise' },
  { artist: 'Icarus', album: 'Be Somebody',       year: 2019, genre: 'Electronic', disc: 1, track: 3, title: 'Orbit' },
  { artist: 'Icarus', album: 'Later Works',       year: 2021, genre: 'Electronic', disc: 1, track: 1, title: 'Return' },
  { artist: 'Icarus', album: 'Later Works',       year: 2021, genre: 'Electronic', disc: 1, track: 2, title: 'Descent' },
  { artist: 'Vosto',  album: 'Night Drive',       year: 2018, genre: 'Ambient',    disc: 1, track: 1, title: 'Highway' },
  { artist: 'Vosto',  album: 'Night Drive',       year: 2018, genre: 'Ambient',    disc: 1, track: 2, title: 'Neon' },
  { artist: 'Vosto',  album: 'Night Drive',       year: 2018, genre: 'Ambient',    disc: 1, track: 3, title: 'Static' },
  { artist: 'Vosto',  album: 'Untitled EP',       year: null, genre: null,         disc: 1, track: 1, title: 'Sketch 1' },
];

const BUNDLED_FFMPEG =
  process.platform === 'win32' ? path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg.exe')
                               : path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg');

// Fixtures are encoded with mStream's bundled ffmpeg, which is gitignored.
// A fresh git worktree won't have it, so fail with an actionable message the
// first time we actually need to encode (rather than a cryptic spawn error
// deep into a run). Checked once — if every fixture is already cached the
// suite runs fine without ffmpeg present.
let ffmpegChecked = false;
function assertFfmpegAvailable() {
  if (ffmpegChecked) { return; }
  if (!existsSync(BUNDLED_FFMPEG)) {
    throw new Error(
      `ffmpeg not found at ${BUNDLED_FFMPEG}. Test fixtures are generated with ` +
      `mStream's bundled ffmpeg (gitignored). In a fresh git worktree, copy ` +
      `bin/ffmpeg/ from your main checkout before running the suite — see test/README.md.`,
    );
  }
  ffmpegChecked = true;
}

// Monotonic counter for temp-file names so two encodes in one process never
// collide on the same temp path (see encode() for why we rename).
let tmpSeq = 0;

function relPathFor(f) {
  const trackNum = String(f.track).padStart(2, '0');
  const safe = s => s.replace(/[/\\:*?"<>|]/g, '_');
  return path.join(safe(f.artist), safe(f.album), `${trackNum} - ${safe(f.title)}.mp3`);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(BUNDLED_FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', d => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('exit', code => {
      if (code === 0) { resolve(); }
      else { reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`)); }
    });
  });
}

async function encode(outPath, f, fixtureIndex) {
  const meta = ['title', 'artist', 'album', 'date', 'track', 'disc', 'genre', 'album_artist', 'compilation'];
  const metaArgs = [];
  const pairs = {
    title:  f.title,
    artist: f.artist,
    album:  f.album,
    date:   f.year ? String(f.year) : null,
    track:  String(f.track),
    disc:   String(f.disc),
    genre:  f.genre,
    // V17: album_artist → ID3v2 TPE2; compilation → TCMP.
    album_artist: f.albumArtist || null,
    compilation:  f.compilation ? '1' : null,
  };
  for (const key of meta) {
    if (pairs[key] != null) {
      metaArgs.push('-metadata', `${key}=${pairs[key]}`);
    }
  }
  // Each fixture gets a distinct tone frequency so the resulting audio
  // payload (and therefore audio_hash) differs per-file. Tests that rely
  // on bookmarks / play queue / scrobbles being track-specific break when
  // fixtures are all identical silence — two tracks with the same audio
  // content correctly share one audio_hash, but we want distinct content
  // here so per-track state stays per-track.
  const freq = 220 + fixtureIndex * 40;  // 220, 260, 300, … Hz
  // Encode to a unique temp file, then atomically rename into place. Test
  // files run in concurrent child processes, so on a cold checkout several
  // may try to materialise the same fixture at once; writing ffmpeg's output
  // straight to outPath would let a scanner read a half-written MP3. Rename is
  // atomic within the directory, so readers only ever see a complete file. The
  // `.mp3` suffix is preserved so ffmpeg still infers the mp3 muxer.
  const tmp = path.join(
    path.dirname(outPath),
    `.tmp-${process.pid}-${tmpSeq++}-${path.basename(outPath)}`,
  );
  try {
    await runFfmpeg([
      '-nostdin', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=44100:duration=1`,
      '-ac', '2',
      '-c:a', 'libmp3lame', '-b:a', '64k',
      ...metaArgs,
      '-id3v2_version', '3',
      tmp,
    ]);
    await fs.rename(tmp, outPath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// Summary of what the test suite will see. Derived from FIXTURES so assertions
// can reference this instead of hard-coding numbers that drift when the list
// changes.
export const FIXTURE_SUMMARY = {
  trackCount: FIXTURES.length,
  artists:    new Set(FIXTURES.map(f => f.artist)).size,
  albums:     new Set(FIXTURES.map(f => `${f.artist}//${f.album}`)).size,
  // Distinct genres including NULL → 'Unknown Genre'.
  genres:     new Set(FIXTURES.map(f => f.genre ?? '')).size,
  years:      new Set(FIXTURES.map(f => f.year).filter(Boolean)).size,
};

/**
 * Ensures the fixture directory exists and contains every track. Returns the
 * absolute path to the library root.
 *
 * Idempotent — files already on disk are left alone.
 */
export async function ensureFixtures() {
  await fs.mkdir(MUSIC_DIR, { recursive: true });
  for (let i = 0; i < FIXTURES.length; i++) {
    const f = FIXTURES[i];
    const full = path.join(MUSIC_DIR, relPathFor(f));
    try { await fs.access(full); continue; } catch { /* need to generate */ }
    assertFfmpegAvailable();
    await fs.mkdir(path.dirname(full), { recursive: true });
    await encode(full, f, i);
  }
  return MUSIC_DIR;
}
