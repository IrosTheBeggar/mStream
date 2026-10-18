import { spawn } from 'child_process';
import { Readable } from 'stream';
import winston from 'winston';
import * as vpath from '../util/vpath.js';
import * as config from '../state/config.js';
import path from 'node:path';
import fsp from 'node:fs/promises';
import {
  ensureFfmpeg,
  ffmpegBin,
  startAutoUpdate,
  stopAutoUpdate,
  getResolvedSource,
  reset as resetBootstrap
} from '../util/ffmpeg-bootstrap.js';

const codecMap = {
  'mp3':  { codec: 'libmp3lame', format: 'mp3',  contentType: 'audio/mpeg' },
  'opus': { codec: 'libopus',    format: 'ogg',  contentType: 'audio/ogg' },
  'aac':  { codec: 'aac',        format: 'adts', contentType: 'audio/aac' }
};

// The bitrates every codec takes. Also the admin's choice of DEFAULT
// bitrate (config.js, admin.js): the default applies to whatever codec a
// request names, so it has to suit them all.
const bitrateSet = new Set(['64k', '96k', '128k', '192k']);
// Higher rates a codec takes on top. MP3 goes to 320k, MPEG-1 Layer III's
// ceiling — the rates a library copy is wanted at. Opus and AAC stay at the
// shared set: libopus refuses more than 256k per channel, so a 320k request
// would fail on a mono source after the 200's headers were already out.
const extraBitrates = { mp3: ['256k', '320k'] };
const bitratesByCodec = Object.fromEntries(Object.keys(codecMap).map((c) =>
  [c, new Set([...bitrateSet, ...(extraBitrates[c] || [])])]));

// Output sample rates each encoder opens at (ffmpeg's supported rates for
// libmp3lame, libopus and its native aac). Anything else would make ffmpeg
// refuse to open the encoder — again after the 200 — so a request is
// screened against these instead. MP3 below 32 kHz is MPEG-2/2.5, whose
// ceiling is 160k: LAME clamps a higher bitrate there, as it always has
// for low-rate sources.
const sampleRatesByCodec = {
  mp3: [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000],
  opus: [8000, 12000, 16000, 24000, 48000],
  aac: [7350, 8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 64000, 88200, 96000],
};

export function getTransBitrates() { return Array.from(bitrateSet); }
export function getTransCodecs() { return Object.keys(codecMap); }
// What a request may ask of each codec — the bitrates it takes and the
// output sample rates it opens at. /api/ advertises it (server-info.js), so
// a client offers 320k only where the server has it.
export function getTransCodecOptions() {
  return Object.fromEntries(Object.keys(codecMap).map((c) => [c, {
    bitrates: Array.from(bitratesByCodec[c]),
    sampleRates: [...sampleRatesByCodec[c]],
  }]));
}

let lockInit = false;
let ffmpegPath = null;

// Background retry for transient boot-time resolution failures (e.g. a brief
// network blip during the first download). Without this, ffmpeg stays disabled
// until the next reboot or a manual admin trigger. Bounded so a host that
// genuinely has no ffmpeg available doesn't retry (and log) forever.
let retryTimer = null;
let retryCount = 0;
const RETRY_DELAY_MS = 5 * 60 * 1000; // 5 minutes between attempts
const MAX_RETRIES = 6;                // ~30 min, then defer to manual trigger

function scheduleRetry() {
  if (retryTimer || retryCount >= MAX_RETRIES) { return; }
  retryCount++;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    winston.info(`Retrying ffmpeg setup (attempt ${retryCount}/${MAX_RETRIES})...`);
    init().catch(err => winston.error('FFmpeg retry failed', { stack: err }));
  }, RETRY_DELAY_MS);
  if (retryTimer.unref) { retryTimer.unref(); }
}

async function init() {
  winston.info('Checking ffmpeg...');
  await ensureFfmpeg();

  // If the resolver found nothing (no bundled binary, no download, no system
  // PATH fallback), leave lockInit false. Downstream consumers (transcode
  // route, album-art embedding, waveforms, ytdl) degrade gracefully. The
  // resolver already logged a detailed error; schedule a retry in case the
  // failure was transient (ensureFfmpeg no longer caches a failed result).
  if (!getResolvedSource()) {
    winston.warn('FFmpeg unavailable — transcoding, album-art embedding, waveforms, and yt-dlp will be disabled');
    scheduleRetry();
    return;
  }

  ffmpegPath = ffmpegBin();

  // Only verify file existence when ffmpegBin() returned an absolute path
  // (i.e. a binary we manage on disk). Bare command names like 'ffmpeg' are
  // resolved by spawn() via PATH at call time, so we skip the access check.
  if (path.isAbsolute(ffmpegPath)) {
    try {
      await fsp.access(ffmpegPath);
    } catch {
      throw new Error(`FFmpeg binary not found at ${ffmpegPath}`);
    }
  }

  // Resolved — cancel any pending retry and reset the attempt counter.
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  retryCount = 0;
  lockInit = true;
  winston.info('FFmpeg OK!');
  startAutoUpdate();
}

export function reset() {
  lockInit = false;
  ffmpegPath = null;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  retryCount = 0;
  stopAutoUpdate();
  resetBootstrap();
}

/**
 * True once ffmpeg has been resolved and is ready to use — from ANY source
 * (a binary we downloaded/manage, OR system ffmpeg on PATH), not strictly
 * "downloaded". Name retained for backwards compatibility with callers.
 */
export function isDownloaded() {
  return lockInit;
}

export async function downloadedFFmpeg() {
  await init();
}

// ── Transcode cache ─────────────────────────────────────────────────────────
// Bounded LRU keyed by `${fullPath}|${bitrate}|${codec}`. Map iteration order
// is insertion order, so the first key is the least-recently-used; get()
// refreshes recency by re-inserting. Capped by BOTH entry count and total
// bytes so a burst of concurrent transcodes can't grow memory without bound.
// (The previous strong-ref-then-WeakRef scheme had no ceiling on how many
// strong entries co-existed, and never pruned its weak-ref keys.)

const CACHE_MAX_ENTRIES = 64;
const CACHE_MAX_BYTES = 256 * 1024 * 1024; // 256 MB total
// Per-entry ceiling. Anything bigger (audiobooks, hour-long mixes) would
// monopolize the cache — and, more importantly, the route stops COLLECTING
// once a stream crosses this line, so a 10-hour m4b doesn't buffer its whole
// transcode in RAM only to be rejected at insert time.
const CACHE_MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const cache = new Map();
let cacheBytes = 0;

// From-start transcodes currently buffering for the cache, keyed by cacheKey.
// Concurrent requests for the same key just stream — only the first buffers —
// so N listeners starting one track at once don't hold N copies in memory.
// Full process-coalescing (one ffmpeg feeding N responses) is deliberately
// NOT done: it would couple slow and fast clients' backpressure, or need an
// unbounded per-client catch-up buffer.
const inFlight = new Set();

function cacheGet(key, { touch = true } = {}) {
  const entry = cache.get(key);
  if (!entry) { return null; }
  if (touch) {
    cache.delete(key);
    cache.set(key, entry); // move to most-recently-used
  }
  return entry;
}

function cacheSet(key, entry) {
  // Don't evict half the cache to hold one oversized item. (The route already
  // stops collecting past this cap mid-stream; this keeps cacheSet
  // self-defending for any future caller.)
  if (entry.contentLength > CACHE_MAX_ENTRY_BYTES) { return; }
  const prev = cache.get(key);
  if (prev) { cacheBytes -= prev.contentLength; cache.delete(key); }
  cache.set(key, entry);
  cacheBytes += entry.contentLength;
  while (cache.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined || oldestKey === key) { break; }
    cacheBytes -= cache.get(oldestKey).contentLength;
    cache.delete(oldestKey);
  }
}

// ── Bulk jobs ───────────────────────────────────────────────────────────────
// A request flagged ?bulk=1 is one file of a long job — a library converted
// onto a portable player's card, an export — not a listener. Two things
// differ for it:
//  - it never enters the cache above: a job converting a thousand files
//    would push every listener's entry out of the 64-entry LRU for copies
//    nobody plays twice. A cache hit is still served, without counting as
//    recent use;
//  - it waits for one of a few server-wide slots (transcode.bulkConcurrency,
//    default 2): bulk work runs ffmpeg as fast as the client can take it,
//    while a listener's transcode is paced by playback. A request over the
//    cap queues, first come first served, for up to BULK_WAIT_MS and then
//    gets a 503 with Retry-After; a full queue answers 503 at once; a client
//    that hangs up while queued just leaves the queue.
// Listeners — no flag, which is every client that predates it — are never
// queued, capped or refused. The cap keeps bulk work from taking the CPU
// and the cache from them; it does not ration playback, and a client doing
// bulk work without the flag is served exactly as before.
// Test overrides, same pattern as MSTREAM_TEST_FED_FLUSH_MS: production
// installs should never set them.
const BULK_WAIT_MS = Number(process.env.MSTREAM_TEST_TRANSCODE_BULK_WAIT_MS) || 60 * 1000;
const BULK_QUEUE_MAX = Number(process.env.MSTREAM_TEST_TRANSCODE_BULK_QUEUE_MAX) || 32;
const BULK_RETRY_AFTER_S = 10;
let bulkActive = 0;
const bulkQueue = []; // waiters, oldest first: { grant, timer }

export function bulkConcurrency() {
  const n = Number(config.program.transcode?.bulkConcurrency);
  return Number.isInteger(n) && n >= 1 ? n : 2;
}

function grantBulkSlots() {
  while (bulkActive < bulkConcurrency() && bulkQueue.length > 0) {
    const waiter = bulkQueue.shift();
    bulkActive++;
    waiter.grant();
  }
}

// A release that frees its slot once, however many exit paths call it.
function bulkRelease() {
  let held = true;
  return () => {
    if (!held) { return; }
    held = false;
    bulkActive--;
    grantBulkSlots();
  };
}

// Resolves to a release function once the caller holds a slot, or to
// { refused: 'full' | 'timeout' | 'gone' } when it never will.
function acquireBulkSlot(res) {
  // A client that hung up earlier (during the stat, say) has had its
  // 'close' already: queued, it would hold a place — one of the queue's
  // BULK_QUEUE_MAX, turning live requests away — until its wait ran out.
  if (res.destroyed) { return Promise.resolve({ refused: 'gone' }); }
  if (bulkActive < bulkConcurrency() && bulkQueue.length === 0) {
    bulkActive++;
    return Promise.resolve(bulkRelease());
  }
  if (bulkQueue.length >= BULK_QUEUE_MAX) { return Promise.resolve({ refused: 'full' }); }
  return new Promise((resolve) => {
    const waiter = {};
    const leave = (why) => {
      const i = bulkQueue.indexOf(waiter);
      if (i !== -1) { bulkQueue.splice(i, 1); }
      clearTimeout(waiter.timer);
      res.off('close', onClose);
      resolve({ refused: why });
    };
    const onClose = () => leave('gone');
    // Called by grantBulkSlots with the slot already counted as taken.
    waiter.grant = () => {
      clearTimeout(waiter.timer);
      res.off('close', onClose);
      resolve(bulkRelease());
    };
    waiter.timer = setTimeout(() => leave('timeout'), BULK_WAIT_MS);
    res.once('close', onClose);
    bulkQueue.push(waiter);
  });
}

// ── Spawn ffmpeg ────────────────────────────────────────────────────────────

function spawnTranscode(inputPath, codec, bitrate, offsetSec = 0, sampleRate = null) {
  const entry = codecMap[codec];
  const args = [];
  // Input seek (`-ss` before `-i`): fast, keyframe-aligned — good enough for
  // lossy transcode targets where sample-accurate seek doesn't matter. Mirrors
  // the DLNA time-seek path.
  if (offsetSec > 0) { args.push('-ss', offsetSec.toFixed(3)); }
  args.push(
    '-i', inputPath,
    '-vn',                          // no video
    '-f', entry.format,             // output container format
    '-acodec', entry.codec,         // audio codec
    '-ab', bitrate,                 // audio bitrate
  );
  // Output sample rate, when asked (ffmpeg resamples to it); otherwise the
  // encoder negotiates one from the source, as it always has.
  if (sampleRate) { args.push('-ar', String(sampleRate)); }
  args.push('pipe:1');              // output to stdout

  const proc = spawn(ffmpegPath, args, {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // Surface ffmpeg diagnostics at debug level rather than black-holing them —
  // a fully-suppressed stderr makes transcode failures impossible to debug.
  proc.stderr.on('data', d => winston.debug(`[transcode] ${d.toString().trim()}`));

  proc.on('error', err => {
    winston.error('Transcoding spawn error', { stack: err });
  });

  return proc;
}

// ── Start a live transcode ──────────────────────────────────────────────────
// Everything between a cache miss and a running ffmpeg: a bulk request's
// slot, the in-flight mark that lets one from-start stream buffer for the
// cache, and the spawn. Resolves to { proc, release, wantsCache } — release
// frees the slot and the mark, once, and is the caller's to call when
// ffmpeg ends — or to null when it has answered the request itself.
//
// Transcoding can be gone by the time the request gets here: a soft
// reboot's reset() (server.js reboot) can land while it waited — for its
// stat, or up to BULK_WAIT_MS for a bulk slot — and leaves no ffmpeg until
// init() resolves one again. Spawned anyway, spawn(null) throws before any
// exit handler is wired, and the slot and the mark were held for the life
// of the process: two such and every bulk request was a 503.
async function startTranscode(req, res, { fullPath, filepath, codec, bitrate, sampleRate, offsetSec, cacheKey, bulk }) {
  // Nothing is sent while queued, so a refusal is still an honest status.
  let releaseBulk = () => {};
  if (bulk) {
    const slot = await acquireBulkSlot(res);
    if (typeof slot !== 'function') {
      if (slot.refused === 'gone') { return null; } // hung up before or while queued
      winston.info(`[transcode] bulk request refused (${slot.refused}) for '${filepath}': ${bulkActive} running, ${bulkQueue.length} queued`);
      res.set('Retry-After', String(BULK_RETRY_AFTER_S));
      res.status(503).json({
        error: slot.refused === 'full'
          ? 'too many bulk transcodes queued — retry later'
          : 'no bulk transcode slot came free in time — retry later',
      });
      return null;
    }
    releaseBulk = slot;
    if (req.socket?.destroyed) { releaseBulk(); return null; }
  }

  if (lockInit !== true) {
    releaseBulk();
    res.status(500).json({ error: 'transcoding disabled' });
    return null;
  }

  // A seeked stream is a one-off and isn't cached, nor is a bulk one; a
  // from-start stream only buffers when no other request is already
  // buffering the same key.
  const wantsCache = offsetSec === 0 && !bulk && !inFlight.has(cacheKey);
  if (wantsCache) { inFlight.add(cacheKey); }
  // Once: 'error' and 'close' can both fire, and a second delete could
  // take the mark of a later request for the same key.
  let held = true;
  const release = () => {
    if (!held) { return; }
    held = false;
    if (wantsCache) { inFlight.delete(cacheKey); }
    releaseBulk();
  };

  try {
    return { proc: spawnTranscode(fullPath, codec, bitrate, offsetSec, sampleRate), release, wantsCache };
  } catch (err) {
    release();
    winston.error('Transcoding spawn error', { stack: err });
    res.status(500).json({ error: 'transcode failed' });
    return null;
  }
}

// For the unit tests (test/unit/transcode-bulk.test.mjs): the bulk gate and
// the start of a live transcode, without a library or an ffmpeg.
export const _internal = {
  acquireBulkSlot,
  startTranscode,
  bulkState: () => ({ active: bulkActive, queued: bulkQueue.length }),
};

// ── Route ───────────────────────────────────────────────────────────────────

export function setup(mstream) {
  // Always try to bootstrap ffmpeg — album-art embedding, waveform generation,
  // and yt-dlp ingestion all use it independently of the old transcode toggle.
  init().catch(err => {
    winston.error('Failed to initialize FFmpeg', { stack: err });
  });

  mstream.get("/transcode/{*filepath}", async (req, res) => {
    if (lockInit !== true) {
      return res.status(500).json({ error: 'transcoding disabled' });
    }

    // An unknown codec or bitrate quietly becomes the server default — the
    // route's contract since long before the options below existed.
    const codec = codecMap[req.query.codec] ? req.query.codec : config.program.transcode.defaultCodec;
    const bitrate = bitratesByCodec[codec].has(req.query.bitrate) ? req.query.bitrate : config.program.transcode.defaultBitrate;

    // ?sampleRate= (Hz) is newer and strict: a rate the codec's encoder
    // cannot open is a 400 now, not a broken stream after the 200.
    let sampleRate = null;
    if (req.query.sampleRate !== undefined) {
      const rate = Number(req.query.sampleRate);
      if (!sampleRatesByCodec[codec].includes(rate)) {
        return res.status(400).json({
          error: `sampleRate must be one of ${sampleRatesByCodec[codec].join(', ')} for ${codec}`,
        });
      }
      sampleRate = rate;
    }

    // ?bulk=1: one file of a long job, not a listener — kept out of the
    // cache and queued behind the server-wide cap ("Bulk jobs" above).
    const bulk = req.query.bulk === '1' || req.query.bulk === 'true';

    // Express 5 {*filepath} returns an array — join back to a path string
    const filepath = Array.isArray(req.params.filepath)
      ? req.params.filepath.join('/')
      : req.params.filepath;

    // getVPathInfo throws on unknown library, missing access, or traversal.
    // Surface them all as a JSON 404 rather than letting the throw fall
    // through to Express' HTML 500 — and don't confirm to unauthorized
    // callers which libraries exist. Log the details though: vpaths are
    // app-managed, so a malformed or unauthorized one almost never comes
    // from our own UIs — it's stale client state at best and someone
    // probing at worst.
    let pathInfo;
    try {
      pathInfo = vpath.getVPathInfo(filepath, req.user);
    } catch (err) {
      winston.warn(`[transcode] vpath rejected for user '${req.user?.username}': '${filepath}' (${err.message})`);
      return res.status(404).json({ error: 'file not found' });
    }

    // Stat up front: a missing file 404s here instead of streaming an empty
    // 200 after ffmpeg fails to open the input (the DLNA time-seek path
    // documents the same hazard). The mtime/size also feed the cache key so a
    // re-tagged or replaced file (tag editors rewrite files in place) can't
    // keep serving a stale cached transcode. ENOENT in the log
    // means stale client/DB state; EACCES/EPERM/EIO mean a server-side
    // problem worth chasing.
    let st;
    try {
      st = await fsp.stat(pathInfo.fullPath);
      if (!st.isFile()) { throw new Error('not a regular file'); }
    } catch (err) {
      winston.warn(`[transcode] stat failed for '${pathInfo.fullPath}': ${err.message}`);
      return res.status(404).json({ error: 'file not found' });
    }

    // HEAD is a probe — Express routes it through GET handlers, and without
    // this short-circuit a HEAD would run (and cache) an entire transcode
    // whose body Node then discards.
    if (req.method === 'HEAD') {
      return res.status(200).header({ 'Content-Type': codecMap[codec].contentType }).end();
    }

    // Seek offset in seconds (?offset=). A seek re-transcodes from `-ss`, so it
    // bypasses the cache entirely — caching every scrub position would thrash
    // it, and only the from-start stream is worth reusing across plays.
    const offset = parseFloat(req.query.offset);
    const offsetSec = Number.isFinite(offset) && offset > 0 ? offset : 0;

    const cacheKey = `${pathInfo.fullPath}|${st.mtimeMs}|${st.size}|${bitrate}|${codec}${sampleRate ? `|${sampleRate}` : ''}`;

    // ── Cache hit (from-start streams only) ──────────────────
    // A bulk request may read a listener's entry but never keeps it warm.
    const cached = offsetSec === 0 ? cacheGet(cacheKey, { touch: !bulk }) : null;
    if (cached) {
      // No Accept-Ranges: this route doesn't honor Range requests, so don't
      // advertise byte-range seeking we can't actually serve.
      res.header({
        'Content-Type': codecMap[codec].contentType,
        'Content-Length': cached.contentLength
      });
      Readable.from(cached.bufs).pipe(res);
      return;
    }

    // ── Start ffmpeg (a bulk request waits for its slot first) ──
    const started = await startTranscode(req, res, {
      fullPath: pathInfo.fullPath, filepath, codec, bitrate, sampleRate, offsetSec, cacheKey, bulk,
    });
    if (!started) { return; } // answered already: refused, gone, or failed
    const { proc, release, wantsCache } = started;

    // ── Set headers ──────────────────────────────────────────
    // No Content-Length and no Accept-Ranges on the live path: the true size
    // isn't known until the transcode finishes, and a *guessed* length is
    // actively harmful — an over-estimate makes strict HTTP clients (undici/
    // fetch, some mobile players) abort with "closed before N bytes" when the
    // real, shorter stream ends. Stream chunked instead; the cache-hit path
    // above serves the exact length once known, and players show progress from
    // their own track-duration metadata.
    res.header({ 'Content-Type': codecMap[codec].contentType });

    // ── Stream (+ collect for cache on from-start streams) ────
    let cacheable = wantsCache; // flips false if the output outgrows the per-entry cap
    let bufs = [];
    let contentLength = 0;
    // Set when the client disconnects (and we SIGTERM ffmpeg as a result). The
    // collected buffer is then a TRUNCATED prefix of the song and must never be
    // cached — otherwise the next listener requesting the same track is served
    // the short version. Skipping a track mid-play is the common trigger.
    let aborted = false;

    // Headers are only staged until the first body write, so a spawn-level
    // failure (binary vanished, EPERM) can still produce an honest 500 here
    // instead of an empty 200. spawnTranscode's own handler logs the details.
    proc.once('error', () => {
      release();
      if (!res.headersSent) {
        res.status(500).json({ error: 'transcode failed' });
      } else {
        try { res.end(); } catch { /* already closed */ }
      }
    });

    proc.stdout.on('data', chunk => {
      if (!cacheable) { return; }
      contentLength += chunk.length;
      if (contentLength > CACHE_MAX_ENTRY_BYTES) {
        // Outgrew the cache's per-entry cap (audiobooks, hour-long mixes):
        // stop collecting and free what we held instead of buffering the
        // entire stream only for cacheSet to reject it at the end.
        cacheable = false;
        bufs = [];
        return;
      }
      bufs.push(chunk);
    });

    // Stream to client immediately
    proc.stdout.pipe(res);

    proc.on('close', code => {
      // The in-flight mark, and a bulk slot — held for as long as its ffmpeg
      // runs, the work the cap is there to bound — freed however it ended.
      release();
      // Cache ONLY a clean, complete from-start transcode. A SIGTERM kill
      // reports code === null and an ffmpeg failure reports a non-zero code;
      // both mean the output is partial, so cache nothing.
      if (aborted || code !== 0) {
        if (code !== 0 && code !== null) {
          winston.error(`FFmpeg exited with code ${code} for ${pathInfo.fullPath}`);
        }
        return;
      }
      if (cacheable && contentLength > 0) {
        cacheSet(cacheKey, { contentLength, bufs });
      }
    });

    // Kill ffmpeg if client disconnects mid-stream
    res.on('close', () => {
      // writableFinished is true only when the full response flushed normally;
      // if not, the client bailed early and the transcode is incomplete.
      if (!res.writableFinished) { aborted = true; }
      if (!proc.killed) {
        proc.kill('SIGTERM');
      }
    });
  });
}
