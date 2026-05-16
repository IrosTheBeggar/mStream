/**
 * Reusable test-library generator.
 *
 * Build an mStream-scannable music library on disk from a spec array. Each
 * spec produces one MP3 file with ID3v2 tags via ffmpeg's `lavfi` sine
 * generator — tiny payloads (~5 KB per 1-second clip), atomic via
 * `-y` overwrite, no external audio source required.
 *
 * Differs from test/helpers/fixtures.mjs in that this is generic:
 *   • Specs are passed in by the caller (fixtures.mjs hard-codes a
 *     fixed 9-track set for the existing test suite — never reshape
 *     that one without breaking ~6 test files).
 *   • Supports ANY ID3 frame name via `extraTags` — useful for filters
 *     that key off less-common frames (BPM via `TBPM`, musical key via
 *     `TKEY`, ReplayGain via `TXXX`, etc.).
 *   • Lets callers vary tone frequency + duration so audio_hash
 *     differentiation is under their control.
 *
 * Designed for scripts that build a one-off test library and want to
 * stop worrying about ffmpeg invocation, atomic-write quirks, or
 * idempotent regeneration.
 *
 * Usage:
 *
 *   import { generateLibrary, mkSpec } from './test/helpers/library-gen.mjs';
 *
 *   await generateLibrary({
 *     outputDir: '/tmp/my-test-lib',
 *     specs: [
 *       mkSpec({ filepath: 'a/01.mp3', title: 'Track 1', bpm: 120 }),
 *       mkSpec({ filepath: 'a/02.mp3', title: 'Track 2', bpm: 140, musicalKey: 'A minor' }),
 *     ],
 *   });
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const DEFAULT_FFMPEG =
  process.platform === 'win32' ? path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg.exe')
                               : path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg');

/**
 * Convenience helper — builds a spec object with the common ID3 fields
 * promoted to top-level keys, and an `extraTags` escape hatch for
 * everything else. Callers can also pass `tags` directly to
 * generateLibrary if they want full control.
 *
 * BPM is written via the `TBPM` ID3v2 frame (matches what
 * music-metadata's common.bpm reads — see scanner.mjs:337 and
 * rust-parser main.rs:1167). Musical key uses `TKEY` (ItemKey::InitialKey).
 *
 * @param {object} opts
 * @param {string} opts.filepath          Path relative to library output dir.
 * @param {string} [opts.title]           ID3 TIT2 (TITLE).
 * @param {string|string[]} [opts.artist] ID3 TPE1 (ARTIST). If an array,
 *                                        values are joined with ` / ` so
 *                                        the scanner's artist-extraction
 *                                        splitter resolves them as
 *                                        primary + featured. The Navidrome-
 *                                        default split list is in
 *                                        src/db/artist-extraction.js; we
 *                                        pick ` / ` because it's the
 *                                        first delimiter in that list
 *                                        and unambiguous in track titles.
 * @param {string} [opts.album]           ID3 TALB (ALBUM).
 * @param {string|number} [opts.year]     ID3 TYER / TDRC (DATE).
 * @param {string|number} [opts.track]    ID3 TRCK (TRACK).
 * @param {string|number} [opts.disc]     ID3 TPOS (DISC).
 * @param {string|string[]} [opts.genre]  ID3 TCON (GENRE). If an array,
 *                                        values are joined with `;` so
 *                                        the scanner's setTrackGenres
 *                                        splitter (`/[,;/]/`) resolves
 *                                        each as a separate track_genres
 *                                        row.
 * @param {string} [opts.albumArtist]     ID3 TPE2 (ALBUM_ARTIST).
 * @param {boolean} [opts.compilation]    ID3 TCMP (COMPILATION).
 * @param {number} [opts.bpm]             ID3 TBPM. Integer.
 * @param {string} [opts.musicalKey]      ID3 TKEY. Free-form (e.g. "A minor", "8A", "Am").
 * @param {object} [opts.extraTags]       Arbitrary ID3 frames keyed by ffmpeg
 *                                        metadata name (e.g. `{TXXX: 'foo'}`).
 * @param {number} [opts.toneFreq=220]    Sine-wave frequency in Hz. Vary per
 *                                        track so audio_hash values differ.
 * @param {number} [opts.duration=1]      Audio duration in seconds.
 */
export function mkSpec(opts) {
  if (!opts || typeof opts.filepath !== 'string' || !opts.filepath) {
    throw new Error('mkSpec: filepath is required');
  }
  const tags = {};
  // Array values for artist/genre get joined into a single TPE1/TCON
  // frame using the delimiter the scanner splits on. This keeps the
  // generator's API ergonomic (`artist: ['A', 'B']`) while writing
  // tags in the canonical shape music-metadata + extractArtists +
  // setTrackGenres expect.
  const artistTag = Array.isArray(opts.artist) ? opts.artist.join(' / ') : opts.artist;
  const genreTag  = Array.isArray(opts.genre)  ? opts.genre.join(';')    : opts.genre;
  const map = {
    title:        opts.title,
    artist:       artistTag,
    album:        opts.album,
    date:         opts.year != null ? String(opts.year) : null,
    track:        opts.track != null ? String(opts.track) : null,
    disc:         opts.disc  != null ? String(opts.disc)  : null,
    genre:        genreTag,
    album_artist: opts.albumArtist,
    compilation:  opts.compilation ? '1' : null,
    TBPM:         opts.bpm != null ? String(opts.bpm) : null,
    TKEY:         opts.musicalKey || null,
  };
  for (const [k, v] of Object.entries(map)) {
    if (v != null) { tags[k] = v; }
  }
  if (opts.extraTags && typeof opts.extraTags === 'object') {
    Object.assign(tags, opts.extraTags);
  }
  return {
    filepath: opts.filepath,
    tags,
    toneFreq: opts.toneFreq ?? 220,
    duration: opts.duration ?? 1,
  };
}

/**
 * Run ffmpeg with the given args. Resolves on exit 0; rejects on non-zero
 * with the tail of stderr. Suppresses stdout (we don't need the encode logs).
 */
function runFfmpeg(ffmpegPath, args) {
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

/**
 * Encode a single spec to disk.
 *
 * ID3v2 version 3 is hard-coded — matches what fixtures.mjs uses and what
 * the scanner's music-metadata reads cleanly. v2.4 has UTF-8 support but
 * weaker compatibility across the long tail of consumer tools, so the
 * fixture path stays on v3 for parity with what real-world libraries
 * predominantly look like.
 */
async function encodeSpec(spec, outPath, ffmpegPath) {
  const metaArgs = [];
  for (const [key, value] of Object.entries(spec.tags || {})) {
    metaArgs.push('-metadata', `${key}=${value}`);
  }
  await runFfmpeg(ffmpegPath, [
    '-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=${spec.toneFreq}:sample_rate=44100:duration=${spec.duration}`,
    '-ac', '2',
    '-c:a', 'libmp3lame', '-b:a', '64k',
    ...metaArgs,
    '-id3v2_version', '3',
    outPath,
  ]);
}

/**
 * Materialise a library on disk from a spec array.
 *
 * @param {object} options
 * @param {string} options.outputDir            Library root. Created if needed.
 * @param {Array<object>} options.specs         Array of {filepath, tags, toneFreq, duration}.
 *                                              Use mkSpec() to build entries.
 * @param {string} [options.ffmpegPath]         Custom ffmpeg path. Defaults to the
 *                                              bundled binary at bin/ffmpeg/.
 * @param {boolean} [options.skipExisting=true] When true, skip files that already
 *                                              exist on disk. Idempotent re-runs
 *                                              are typical for test scripts that
 *                                              get invoked many times.
 * @param {boolean} [options.cleanFirst=false]  When true, wipe outputDir before
 *                                              regenerating. Skips the skipExisting
 *                                              optimisation for a guaranteed
 *                                              fresh library.
 * @returns {Promise<{outputDir: string, generated: number, skipped: number}>}
 */
export async function generateLibrary({
  outputDir,
  specs,
  ffmpegPath = DEFAULT_FFMPEG,
  skipExisting = true,
  cleanFirst = false,
} = {}) {
  if (!outputDir) { throw new Error('generateLibrary: outputDir is required'); }
  if (!Array.isArray(specs) || specs.length === 0) {
    throw new Error('generateLibrary: specs must be a non-empty array');
  }

  // Sanity check the ffmpeg binary upfront — clearer error than a per-file
  // spawn failure 30 files into the loop.
  try { await fs.access(ffmpegPath); } catch {
    throw new Error(`ffmpeg not found at ${ffmpegPath}. Set ffmpegPath or run mStream once so the bootstrap downloads it.`);
  }

  if (cleanFirst) {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
  await fs.mkdir(outputDir, { recursive: true });

  let generated = 0;
  let skipped = 0;
  for (const spec of specs) {
    const outPath = path.join(outputDir, spec.filepath);
    if (skipExisting && !cleanFirst) {
      try { await fs.access(outPath); skipped++; continue; } catch { /* needs generation */ }
    }
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await encodeSpec(spec, outPath, ffmpegPath);
    generated++;
  }
  return { outputDir, generated, skipped };
}

export const DEFAULT_FFMPEG_PATH = DEFAULT_FFMPEG;
