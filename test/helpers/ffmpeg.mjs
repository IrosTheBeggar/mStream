/**
 * Shared ffmpeg plumbing for the two fixture generators (fixtures.mjs and
 * library-gen.mjs). Keeps the bundled-binary path, the spawn wrapper, the
 * "missing ffmpeg" check, and the race-safe tone encoder in one place so the
 * two generators can't drift apart.
 */

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// mStream's bundled ffmpeg. Gitignored, so a fresh worktree won't have it.
export const BUNDLED_FFMPEG =
  process.platform === 'win32' ? path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg.exe')
                               : path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg');

// Fail with an actionable message rather than a cryptic spawn error deep into a
// run. Cached per-path so repeated calls are free.
const verified = new Set();
export function assertFfmpegAvailable(ffmpegPath = BUNDLED_FFMPEG) {
  if (verified.has(ffmpegPath)) { return; }
  if (!existsSync(ffmpegPath)) {
    throw new Error(
      `ffmpeg not found at ${ffmpegPath}. Test fixtures are generated with ` +
      `mStream's bundled ffmpeg (gitignored). In a fresh git worktree, copy ` +
      `bin/ffmpeg/ from your main checkout before running the suite — see test/README.md.`,
    );
  }
  verified.add(ffmpegPath);
}

// Resolves on exit 0; rejects on non-zero with the tail of stderr. Suppresses
// stdout (we don't need the encode logs).
export function runFfmpeg(ffmpegPath, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', d => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('exit', code => {
      if (code === 0) { resolve(); }
      else { reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`)); }
    });
  });
}

// Monotonic counter so two encodes in one process never collide on a temp path.
let tmpSeq = 0;

/**
 * Encode a stereo sine-tone MP3 (ID3v2.3 tags) to `outPath`, race-safely.
 *
 * Test files run in concurrent child processes, so on a cold checkout several
 * may try to materialise the same file at once; writing ffmpeg's output
 * straight to outPath would let a reader (e.g. the scanner) see a half-written
 * MP3. We encode to a unique temp file and atomically rename into place — the
 * `.mp3` suffix is preserved so ffmpeg still infers the mp3 muxer.
 *
 * @param {object}   o
 * @param {string}   o.outPath          Final destination path.
 * @param {number}   o.freq             Sine frequency in Hz.
 * @param {number}   [o.duration=1]     Duration in seconds.
 * @param {string[]} [o.metaArgs=[]]    Flat array of ffmpeg `-metadata` args.
 * @param {string}   [o.ffmpegPath]     ffmpeg binary (defaults to bundled).
 */
export async function encodeTone({ outPath, freq, duration = 1, metaArgs = [], ffmpegPath = BUNDLED_FFMPEG }) {
  const tmp = path.join(
    path.dirname(outPath),
    `.tmp-${process.pid}-${tmpSeq++}-${path.basename(outPath)}`,
  );
  try {
    await runFfmpeg(ffmpegPath, [
      '-nostdin', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=44100:duration=${duration}`,
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
