// ffmpeg fallback for the waveform enrichment pass.
//
// The rust `--waveform-scan` pass is symphonia-powered, and symphonia has
// no pure-Rust Opus decoder. Everything .opus therefore came out of that
// pass with no waveform, and — until this module existed — with a
// `symphonia` failure marker that made the admin panel report a permanent
// failure count for files that are perfectly fine. Playback still worked,
// because GET /api/v1/db/waveform generates lazily via ffmpeg, but every
// first play of an Opus track paid a cold decode while the progress bar
// sat empty.
//
// This runs straight after the rust pass and closes that gap with the same
// ffmpeg generator the endpoint uses. Two kinds of work:
//
//   1. Extensions symphonia structurally cannot decode (Opus). The rust
//      pass now leaves these out of its plan entirely — no marker, no
//      inflated failure count — so they arrive here uncached.
//   2. Hashes carrying a `symphonia`-only failure marker. ffmpeg decodes
//      plenty that symphonia won't; a success here deletes the marker.
//
// Deliberately in-process rather than a forked worker: the CPU cost is
// ffmpeg's, in its own process, and this side is bookkeeping. Concurrency
// matches the on-demand endpoint so a pass and a burst of playback
// requests can't together fork a decoder per core.

import fs from 'node:fs';
import path from 'node:path';
import winston from 'winston';
import {
  NUM_BARS,
  FAILED_EXT,
  CACHE_EXT,
  generateWaveformBars,
  writeCachedWaveform,
  recordFfmpegFailure,
  clearFailedMarker,
} from './waveform-lib.js';

// Extensions the rust pass skips. Kept in step with
// waveform_codec_unsupported() in rust-parser/src/main.rs.
const RUST_UNSUPPORTED_EXT = new Set(['.opus']);

const MAX_CONCURRENT = 2;

// A library where ffmpeg fails on everything would otherwise hold the
// queue for hours on its first pass. Failures write markers, so each run
// permanently shrinks the work list — the cap only decides how much of it
// one pass takes. Capped runs are logged, never silently truncated.
const MAX_PER_RUN = 500;

/**
 * @param {object} opts
 * @param {import('node:sqlite').DatabaseSync} opts.db
 * @param {string} opts.cacheDir
 * @param {string} opts.ffmpegBin
 * @param {{stopped: boolean}} opts.abort   flipped by the kill queue on shutdown
 * @param {(done: number, total: number) => void} [opts.onProgress]
 * @returns {Promise<{generated: number, failed: number, total: number, capped: boolean}>}
 */
export async function run({ db, cacheDir, ffmpegBin, abort, onProgress }) {
  const work = planWork({ db, cacheDir });
  const capped = work.length > MAX_PER_RUN;
  const batch = capped ? work.slice(0, MAX_PER_RUN) : work;

  const result = { generated: 0, failed: 0, total: batch.length, capped };
  if (batch.length === 0) { return result; }

  let next = 0;
  let done = 0;
  const worker = async () => {
    while (!abort.stopped) {
      const i = next++;
      if (i >= batch.length) { return; }
      const { key, paths } = batch[i];
      await generateOne({ key, paths, cacheDir, ffmpegBin, result });
      done++;
      if (onProgress && (done % 5 === 0 || done === batch.length)) {
        onProgress(done, batch.length);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT, batch.length) }, worker));

  return result;
}

async function generateOne({ key, paths, cacheDir, ffmpegBin, result }) {
  // Walk this content's paths until one decodes. A vanished copy is not a
  // verdict on the content — the same reasoning (and the same silence: no
  // marker) as the rust pass's open loop.
  for (const absPath of paths) {
    if (!fs.existsSync(absPath)) { continue; }
    try {
      const bars = await generateWaveformBars(absPath, ffmpegBin);
      if (bars.length !== NUM_BARS) {
        throw new Error(`expected ${NUM_BARS} bars, got ${bars.length}`);
      }
      await writeCachedWaveform(cacheDir, key, bars);
      // ffmpeg succeeded where symphonia didn't — the marker is now a lie.
      await clearFailedMarker(cacheDir, key);
      result.generated++;
      return;
    } catch (err) {
      // Same discipline as the endpoint: only ffmpeg's own verdict on the
      // content is remembered. A timeout under load or a spawn failure
      // retries on the next pass instead of poisoning the marker.
      if (err.transient) {
        winston.warn(
          `[waveform] ffmpeg fallback deferred for ${absPath}: ${err.message}`);
        return;
      }
      winston.warn(`[waveform] ffmpeg fallback failed for ${absPath}: ${err.message}`);
      await recordFfmpegFailure(cacheDir, key);
      result.failed++;
      return;
    }
  }
  // No copy on disk: silent skip, no marker. The sweep owns vanished files.
}

// Build the work list: content hashes with no cached waveform that either
// use a codec the rust pass skips, or carry a symphonia-only failure.
// Keyed by hash with every path along, so duplicate content decodes once
// and a missing copy can fall through to another.
function planWork({ db, cacheDir }) {
  let names;
  try { names = fs.readdirSync(cacheDir); }
  catch (_err) { names = []; }   // no dir yet — everything is candidate work

  const cached = new Set();
  // Keys ffmpeg itself has already rejected. This has to gate BOTH work
  // sources, not just the marker one: an undecodable .opus arrives through
  // the extension query, so checking it only on the marker path would
  // re-spawn a doomed 30-second decode on every pass, forever.
  const ffmpegFailed = new Set();
  const symphoniaFailed = [];
  for (const name of names) {
    if (name.endsWith(CACHE_EXT)) {
      cached.add(name.slice(0, -CACHE_EXT.length));
    } else if (name.endsWith(FAILED_EXT)) {
      const key = name.slice(0, -FAILED_EXT.length);
      const body = readMarker(path.join(cacheDir, name));
      if (body.includes('ffmpeg')) { ffmpegFailed.add(key); continue; }
      if (body.includes('symphonia')) { symphoniaFailed.push(key); }
    }
  }

  const byKey = new Map();
  const add = (row) => {
    const key = row.audio_hash || row.file_hash;
    if (!key || cached.has(key) || ffmpegFailed.has(key)) { return; }
    const abs = path.join(row.root_path, row.filepath);
    const paths = byKey.get(key);
    if (paths) { paths.push(abs); } else { byKey.set(key, [abs]); }
  };

  // (1) Codecs the rust pass skips. Matched on the stored path so no
  // per-row JS filtering of the whole table is needed.
  for (const ext of RUST_UNSUPPORTED_EXT) {
    const rows = db.prepare(`
      SELECT t.filepath, t.audio_hash, t.file_hash, l.root_path
        FROM tracks t JOIN libraries l ON l.id = t.library_id
       WHERE t.filepath LIKE ?
         AND COALESCE(t.audio_hash, t.file_hash) IS NOT NULL
    `).all('%' + ext);
    for (const row of rows) { add(row); }
  }

  // (2) Hashes symphonia gave up on. Chunked so a library with thousands
  // of markers doesn't build one enormous IN list.
  const CHUNK = 400;
  for (let i = 0; i < symphoniaFailed.length; i += CHUNK) {
    const chunk = symphoniaFailed.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT t.filepath, t.audio_hash, t.file_hash, l.root_path
        FROM tracks t JOIN libraries l ON l.id = t.library_id
       WHERE COALESCE(t.audio_hash, t.file_hash) IN (${placeholders})
    `).all(...chunk);
    for (const row of rows) { add(row); }
  }

  return Array.from(byKey, ([key, paths]) => ({ key, paths }));
}

function readMarker(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (_err) { return 'symphonia'; }  // unreadable — assume the pass wrote it
}
