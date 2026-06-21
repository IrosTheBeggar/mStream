/**
 * Parity test: src/db/lyrics-extraction.js (JS) and
 * rust-parser/src/main.rs (Rust) MUST produce byte-identical lyrics
 * column values for the same input. Without this test the two
 * extractors could silently drift — a library scanned by the JS
 * fallback would return different lyrics than the same library
 * scanned by the Rust binary, and users would see lyrics appear and
 * disappear across mStream restarts depending on which scanner
 * picked up the track.
 *
 * Mirrors test/audio-hash-parity.test.mjs: drives the Rust side via
 * a hidden `rust-parser --extract-lyrics <path>` CLI subcommand and
 * compares against the JS `extractLyrics()` return value.
 *
 * Fixtures cover every source mix:
 *   - Embedded Vorbis LYRICS (FLAC)
 *   - Embedded with sibling .lrc (sidecar wins for synced)
 *   - Sidecar .lrc only
 *   - Multi-language sidecar (song.en.lrc)
 *   - Sidecar .txt plain
 *   - No lyrics anywhere
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractLyrics } from '../../src/db/lyrics-extraction.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FFMPEG = process.platform === 'win32'
  ? path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg.exe')
  : path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg');

function findRustParser() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const libc = process.platform === 'linux' ? '-musl' : '';
  const candidates = [
    path.join(REPO_ROOT, 'rust-parser', 'target', 'release', `rust-parser${ext}`),
    path.join(REPO_ROOT, 'bin', 'rust-parser',
      `rust-parser-${process.platform}-${process.arch}${libc}${ext}`),
    path.join(REPO_ROOT, 'bin', 'rust-parser',
      `rust-parser-${process.platform}-${process.arch}${ext}`),
  ].filter(p => fsSync.existsSync(p));

  // Probe each candidate for the `--extract-lyrics` subcommand. A
  // stale local build (from before the subcommand was added) falls
  // through to the main JSON-input path and exits 1 with "Invalid
  // JSON Input" on stderr. Any other response means the subcommand
  // is recognised — distinguish by the stderr signature so this
  // works whether the probe path exists or not.
  for (const bin of candidates) {
    try {
      const result = spawnSync(bin, ['--extract-lyrics', path.join(REPO_ROOT, 'NONEXISTENT_PROBE_FILE')],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
      const stderr = (result.stderr || '').toString();
      if (!/Invalid JSON Input/.test(stderr)) { return bin; }
    } catch (_) { /* try next candidate */ }
  }
  return null;
}
const RUST_BIN = findRustParser();

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', d => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('exit', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`)));
  });
}

// Make a 1-second FLAC with the given artist/title/lyrics.
async function makeFlac(absPath, { artist, title, lyrics }) {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const args = [
    '-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=420:sample_rate=44100:duration=1',
    '-ac', '2', '-c:a', 'flac',
    '-metadata', `artist=${artist}`,
    '-metadata', `title=${title}`,
  ];
  if (lyrics) { args.push('-metadata', `lyrics=${lyrics}`); }
  args.push(absPath);
  await runFfmpeg(args);
}

function runRustExtract(audioPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(RUST_BIN, ['--extract-lyrics', audioPath],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', d => { stderr += d.toString('utf8'); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) { return reject(new Error(`rust-parser exit ${code}: ${stderr.slice(-300)}`)); }
      try { resolve(JSON.parse(stdout.trim())); }
      catch (err) { reject(new Error(`failed to parse rust output: ${err.message}; raw=${stdout.slice(0, 200)}`)); }
    });
  });
}

let libDir;

before(async () => {
  if (!fsSync.existsSync(FFMPEG)) {
    throw new Error(`bundled ffmpeg missing at ${FFMPEG}`);
  }
  libDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-lyrics-parity-'));

  // Build all fixtures up front so each test just reads them.
  await makeFlac(path.join(libDir, 'embedded.flac'), {
    artist: 'Embed A', title: 'Embed T',
    lyrics: 'Embedded line one\nEmbedded line two',
  });
  // Embedded USLT + a sibling .lrc — sidecar .lrc should NOT override
  // the embedded synced source (we only fall through to sidecar when
  // synced is empty). Here embedded is PLAIN, so sidecar .lrc fills
  // the synced slot.
  await makeFlac(path.join(libDir, 'both.flac'), {
    artist: 'Both A', title: 'Both T',
    lyrics: 'Plain from tag',
  });
  await fs.writeFile(path.join(libDir, 'both.lrc'),
    '[00:01.00]From sidecar\n[00:03.50]Second line', 'utf8');

  await makeFlac(path.join(libDir, 'lrc-only.flac'), {
    artist: 'Lrc A', title: 'Lrc T',
  });
  await fs.writeFile(path.join(libDir, 'lrc-only.lrc'),
    '[00:02.00]Only in sidecar', 'utf8');

  // Multi-language suffix.
  await makeFlac(path.join(libDir, 'multilang.flac'), {
    artist: 'Ml A', title: 'Ml T',
  });
  await fs.writeFile(path.join(libDir, 'multilang.en.lrc'),
    '[00:01.00]English synced\n[00:02.00]Line two', 'utf8');

  await makeFlac(path.join(libDir, 'txt-only.flac'), {
    artist: 'Txt A', title: 'Txt T',
  });
  await fs.writeFile(path.join(libDir, 'txt-only.txt'),
    'Plain sidecar line one\nline two', 'utf8');

  await makeFlac(path.join(libDir, 'nothing.flac'), {
    artist: 'None A', title: 'None T',
  });
});

after(async () => {
  if (libDir) { await fs.rm(libDir, { recursive: true, force: true }).catch(() => {}); }
});

// Helper: run both extractors, compare every field. Exists so each
// fixture case is a one-liner.
async function assertParity(fixtureName) {
  if (!RUST_BIN) {
    // No rust binary available — skip rather than fail. CI
    // environments without the toolchain still get JS-only coverage.
    return;
  }
  const audioPath = path.join(libDir, fixtureName);

  // JS side: we need music-metadata `common` to pass in. Since the
  // production caller gets this from parseFile(), we do the same
  // here — parity includes "both see the same parsed tag".
  const { parseFile } = await import('music-metadata');
  const parsed = await parseFile(audioPath);
  const jsResult = extractLyrics(parsed.common, audioPath);

  const rustResult = await runRustExtract(audioPath);

  // sidecar_mtime is platform-dependent (FS tick granularity, writes
  // during test setup), so we compare present/absent, not value.
  const jsHasMtime   = jsResult.lyricsSidecarMtime   != null;
  const rustHasMtime = rustResult.lyricsSidecarMtime != null;
  assert.equal(jsHasMtime, rustHasMtime,
    `sidecarMtime presence drift for ${fixtureName}: js=${jsHasMtime} rust=${rustHasMtime}`);

  assert.equal(jsResult.lyricsEmbedded,  rustResult.lyricsEmbedded,
    `lyricsEmbedded drift for ${fixtureName}`);
  assert.equal(jsResult.lyricsSyncedLrc, rustResult.lyricsSyncedLrc,
    `lyricsSyncedLrc drift for ${fixtureName}`);
  assert.equal(jsResult.lyricsLang,      rustResult.lyricsLang,
    `lyricsLang drift for ${fixtureName}`);
}

describe('JS ↔ Rust lyrics extractor parity', () => {
  test('FLAC with embedded unsynced lyrics (Vorbis LYRICS)', async () => {
    await assertParity('embedded.flac');
  });

  test('Embedded plain + sibling .lrc (sidecar fills synced slot)', async () => {
    await assertParity('both.flac');
  });

  test('.lrc sidecar only', async () => {
    await assertParity('lrc-only.flac');
  });

  test('Multi-language sidecar (song.en.lrc)', async () => {
    await assertParity('multilang.flac');
  });

  test('.txt sidecar only', async () => {
    await assertParity('txt-only.flac');
  });

  test('No lyrics anywhere', async () => {
    await assertParity('nothing.flac');
  });
});
