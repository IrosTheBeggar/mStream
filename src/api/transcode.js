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

const bitrateSet = new Set(['64k', '96k', '128k', '192k']);

export function getTransBitrates() { return Array.from(bitrateSet); }
export function getTransCodecs() { return Object.keys(codecMap); }

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

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) { return null; }
  cache.delete(key);
  cache.set(key, entry); // move to most-recently-used
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

// ── Spawn ffmpeg ────────────────────────────────────────────────────────────

function spawnTranscode(inputPath, codec, bitrate, offsetSec = 0) {
  const entry = codecMap[codec];
  const args = [];
  // Input seek (`-ss` before `-i`): fast, keyframe-aligned — good enough for
  // lossy transcode targets where sample-accurate seek doesn't matter. Mirrors
  // the DLNA time-seek and Subsonic stream paths.
  if (offsetSec > 0) { args.push('-ss', offsetSec.toFixed(3)); }
  args.push(
    '-i', inputPath,
    '-vn',                          // no video
    '-f', entry.format,             // output container format
    '-acodec', entry.codec,         // audio codec
    '-ab', bitrate,                 // audio bitrate
    'pipe:1'                        // output to stdout
  );

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

    const codec = codecMap[req.query.codec] ? req.query.codec : config.program.transcode.defaultCodec;
    const bitrate = bitrateSet.has(req.query.bitrate) ? req.query.bitrate : config.program.transcode.defaultBitrate;

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
    // re-tagged or replaced file — the velvet tag editor rewrites files in
    // place — can't keep serving a stale cached transcode. ENOENT in the log
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

    const cacheKey = `${pathInfo.fullPath}|${st.mtimeMs}|${st.size}|${bitrate}|${codec}`;

    // ── Cache hit (from-start streams only) ──────────────────
    const cached = offsetSec === 0 ? cacheGet(cacheKey) : null;
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
    // A seeked stream is a one-off and isn't cached; a from-start stream only
    // buffers when no other request is already buffering the same key.
    const wantsCache = offsetSec === 0 && !inFlight.has(cacheKey);
    if (wantsCache) { inFlight.add(cacheKey); }
    const releaseInFlight = () => { if (wantsCache) { inFlight.delete(cacheKey); } };

    let cacheable = wantsCache; // flips false if the output outgrows the per-entry cap
    let bufs = [];
    let contentLength = 0;
    // Set when the client disconnects (and we SIGTERM ffmpeg as a result). The
    // collected buffer is then a TRUNCATED prefix of the song and must never be
    // cached — otherwise the next listener requesting the same track is served
    // the short version. Skipping a track mid-play is the common trigger.
    let aborted = false;

    const proc = spawnTranscode(pathInfo.fullPath, codec, bitrate, offsetSec);

    // Headers are only staged until the first body write, so a spawn-level
    // failure (binary vanished, EPERM) can still produce an honest 500 here
    // instead of an empty 200. spawnTranscode's own handler logs the details.
    proc.once('error', () => {
      releaseInFlight();
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
      releaseInFlight();
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
