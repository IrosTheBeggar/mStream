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
//   1. Extensions whose content symphonia may be unable to decode
//      (CANDIDATE_EXTS: .opus always; .ogg when it carries Opus). The
//      rust pass leaves those out of its results — extension skip for
//      .opus, a probed NoDecoder skip for Opus-in-Ogg — with no marker
//      and no inflated failure count, so they arrive here uncached.
//   2. Hashes carrying a `symphonia`-only failure marker. ffmpeg decodes
//      plenty that symphonia won't; a success here deletes the marker.
//
// Deliberately in-process rather than a forked worker: the CPU cost is
// ffmpeg's, in its own process, and this side is bookkeeping. Concurrency
// matches the on-demand endpoint so a pass and a burst of playback
// requests can't together fork a decoder per core.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
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

// Extensions whose content symphonia may be unable to decode: .opus always
// (no decoder at all), .ogg when the container carries Opus rather than
// Vorbis — symphonia-format-ogg ships an Opus mapper but no decoder, so
// the rust pass probes those and skips them silently (its NoDecoder arm).
// The rust pass has already cached everything under these extensions it
// COULD decode by the time this runs, so whatever is still uncached here
// is exactly the residue this pass exists for. Kept in step with
// waveform_codec_unsupported() + the NoDecoder skip in main.rs.
const CANDIDATE_EXTS = ['.opus', '.ogg'];

const MAX_CONCURRENT = 2;

// A library where ffmpeg fails on everything would otherwise hold the
// queue for hours on its first pass. The cap only decides how much of the
// backlog one pass takes; whether another pass is worth chaining is the
// caller's call, via shouldChain() below.
const MAX_PER_RUN = 500;

/**
 * Should the task queue chain another pass after this result?
 *
 * Only DURABLE progress justifies chaining: a generate counts once its
 * atomic rename landed, a failure only once its marker file did. Counting
 * mere attempts looked equivalent — "every failure writes a marker" — but
 * recordFfmpegFailure swallows its own write error by design, so on an
 * unwritable cache dir every attempt failed, nothing landed, planWork
 * rebuilt the identical list, and the pass chained itself forever, each
 * round re-forking the full rust pass ahead of it. The backlog comparison
 * is the backstop for any future non-shrinking work source: if the
 * eligible set didn't actually get smaller since the last chained round,
 * stop, and the backlog degrades to once-per-scan instead of a hot loop.
 *
 * @param {{capped: boolean, generated: number, markersRecorded: number, backlog: number}} res
 * @param {number|null} lastBacklog  backlog of the previous CHAINED round, or null
 */
export function shouldChain(res, lastBacklog) {
  if (!res.capped) { return false; }
  if (res.generated + res.markersRecorded === 0) { return false; }
  if (lastBacklog !== null && res.backlog >= lastBacklog) { return false; }
  return true;
}

/**
 * @param {object} opts
 * @param {import('node:sqlite').DatabaseSync} opts.db
 * @param {string} opts.cacheDir
 * @param {string} opts.ffmpegBin
 * @param {{stopped: boolean}} opts.abort   flipped by the kill queue on shutdown
 * @param {(done: number, total: number) => void} [opts.onProgress]
 * @returns {Promise<{generated: number, failed: number, markersRecorded: number,
 *                    total: number, backlog: number, capped: boolean}>}
 *   `failed` counts decode verdicts (for honest reporting);
 *   `markersRecorded` counts the subset whose marker actually landed —
 *   the only failures that shrink the next plan.
 */
export async function run({ db, cacheDir, ffmpegBin, abort, onProgress }) {
  const work = await planWork({ db, cacheDir });
  const capped = work.length > MAX_PER_RUN;
  const batch = capped ? work.slice(0, MAX_PER_RUN) : work;

  const result = {
    generated: 0, failed: 0, markersRecorded: 0,
    total: batch.length, backlog: work.length, capped,
  };
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
  // Walk EVERY copy of this content until one decodes. A copy can exist
  // and still be unreadable — permissions changed after the scan, a stale
  // network mount, bytes rotted outside the sampled hash windows — and
  // that is not a verdict on the content while another copy is fine. The
  // rust pass has the same discipline (open failure → next path); bailing
  // on the first bad copy wrote a terminal marker with a good copy still
  // sitting on disk.
  let decodeFailures = 0;
  for (const absPath of paths) {
    if (!fs.existsSync(absPath)) { continue; }
    let bars;
    try {
      bars = await generateWaveformBars(absPath, ffmpegBin);
      if (bars.length !== NUM_BARS) {
        throw new Error(`expected ${NUM_BARS} bars, got ${bars.length}`);
      }
    } catch (err) {
      // Transient classes (timeout under load, spawn failure) say nothing
      // about the content or the other copies — bail out entirely and let
      // the next pass retry from scratch.
      if (err.transient) {
        winston.warn(
          `[waveform] ffmpeg fallback deferred for ${absPath}: ${err.message}`);
        return;
      }
      winston.warn(`[waveform] ffmpeg fallback failed for ${absPath}: ${err.message}`);
      decodeFailures++;
      continue;
    }
    // Persisting is deliberately OUTSIDE the decode try: a full disk or a
    // permissions error is not ffmpeg's opinion of the audio, and folding
    // the two into one catch turned every cache-write hiccup into a
    // permanent `ffmpeg` marker for a file ffmpeg had just decoded
    // perfectly — with no path in the system that ever clears it. A
    // failed write counts NOTHING (not generated, not failed): nothing
    // durable landed, so the next pass simply retries. Same discipline as
    // the endpoint, which persists fire-and-forget for the same reason.
    try {
      await writeCachedWaveform(cacheDir, key, bars);
    } catch (err) {
      winston.warn(`[waveform] cache write failed for ${key}: ${err.message}`);
      return;
    }
    result.generated++;
    // ffmpeg succeeded where symphonia didn't — the marker is now a lie.
    await clearFailedMarker(cacheDir, key);
    return;
  }
  // Every copy that exists failed to DECODE — that is a verdict on the
  // content. The marker only counts as progress if it actually landed:
  // the re-enqueue gate needs durable facts, not attempts.
  if (decodeFailures > 0) {
    result.failed++;
    if (await recordFfmpegFailure(cacheDir, key)) {
      result.markersRecorded++;
    }
  }
  // No copy on disk at all: silent skip, no marker. The sweep owns
  // vanished files.
}

// Build the work list: content hashes with no cached waveform that either
// use a codec the rust pass skips (or probes and skips: CANDIDATE_EXTS),
// or carry a symphonia-only failure. Keyed by hash with every path along,
// so duplicate content decodes once and a missing copy can fall through
// to another.
//
// Runs in the SERVER process (this pass is not a forked worker), so the
// filesystem side is async with bounded batches and a yield between DB
// chunks — a large cache dir was measurably blocking the event loop for
// hundreds of ms, the same bug class as the enrichment-status incident.
// The DB calls stay sync because node:sqlite's DatabaseSync has no async
// form; they are bounded (one LIKE per candidate ext, 400-key IN chunks).
async function planWork({ db, cacheDir }) {
  let names;
  try { names = await fsp.readdir(cacheDir); }
  catch (_err) { names = []; }   // no dir yet — everything is candidate work

  const cached = new Set();
  const markerNames = [];
  for (const name of names) {
    if (name.endsWith(CACHE_EXT)) {
      cached.add(name.slice(0, -CACHE_EXT.length));
    } else if (name.endsWith(FAILED_EXT)) {
      markerNames.push(name);
    }
  }

  // Keys ffmpeg itself has already rejected. This has to gate BOTH work
  // sources, not just the marker one: an undecodable .opus arrives through
  // the extension query, so checking it only on the marker path would
  // re-spawn a doomed 30-second decode on every pass, forever.
  const ffmpegFailed = new Set();
  const symphoniaFailed = [];
  const BATCH = 32;
  for (let i = 0; i < markerNames.length; i += BATCH) {
    await Promise.all(markerNames.slice(i, i + BATCH).map(async (name) => {
      const key = name.slice(0, -FAILED_EXT.length);
      const body = await readMarker(path.join(cacheDir, name));
      if (body.includes('ffmpeg')) { ffmpegFailed.add(key); }
      else if (body.includes('symphonia')) { symphoniaFailed.push(key); }
    }));
  }

  const byKey = new Map();
  const add = (row) => {
    const key = row.audio_hash || row.file_hash;
    if (!key || cached.has(key) || ffmpegFailed.has(key)) { return; }
    const abs = path.join(row.root_path, row.filepath);
    const paths = byKey.get(key);
    if (paths) { paths.push(abs); } else { byKey.set(key, [abs]); }
  };
  const breathe = () => new Promise((resolve) => setImmediate(resolve));

  // (1) Extensions that may hold codecs symphonia can't decode. Matched on
  // the stored path so no per-row JS filtering of the whole table is
  // needed; NULLIF because the scanners record "no hash" as either NULL or
  // '' and bare COALESCE would elect the empty string as a key.
  for (const ext of CANDIDATE_EXTS) {
    const rows = db.prepare(`
      SELECT t.filepath, t.audio_hash, t.file_hash, l.root_path
        FROM tracks t JOIN libraries l ON l.id = t.library_id
       WHERE t.filepath LIKE ?
         AND COALESCE(NULLIF(t.audio_hash, ''), NULLIF(t.file_hash, '')) IS NOT NULL
    `).all('%' + ext);
    for (const row of rows) { add(row); }
    await breathe();
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
       WHERE COALESCE(NULLIF(t.audio_hash, ''), NULLIF(t.file_hash, '')) IN (${placeholders})
    `).all(...chunk);
    for (const row of rows) { add(row); }
    await breathe();
  }

  return Array.from(byKey, ([key, paths]) => ({ key, paths }));
}

async function readMarker(file) {
  try { return await fsp.readFile(file, 'utf8'); }
  catch (_err) { return 'symphonia'; }  // unreadable — assume the pass wrote it
}
