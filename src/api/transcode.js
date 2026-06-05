import { spawn } from 'child_process';
import { Readable } from 'stream';
import winston from 'winston';
import * as vpath from '../util/vpath.js';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import path from 'node:path';
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

async function init() {
  winston.info('Checking ffmpeg...');
  await ensureFfmpeg();

  // If the resolver found nothing (no bundled binary, no download, no system
  // PATH fallback), leave lockInit false and return. Downstream consumers
  // (transcode route, album-art embedding, waveforms, ytdl) will degrade
  // gracefully. The resolver already logged a detailed error.
  if (!getResolvedSource()) {
    winston.warn('FFmpeg unavailable — transcoding, album-art embedding, waveforms, and yt-dlp will be disabled');
    return;
  }

  ffmpegPath = ffmpegBin();

  // Only verify file existence when ffmpegBin() returned an absolute path
  // (i.e. a binary we manage on disk). Bare command names like 'ffmpeg' are
  // resolved by spawn() via PATH at call time, so we skip the access check.
  if (path.isAbsolute(ffmpegPath)) {
    const { access } = await import('node:fs/promises');
    try {
      await access(ffmpegPath);
    } catch {
      throw new Error(`FFmpeg binary not found at ${ffmpegPath}`);
    }
  }

  lockInit = true;
  winston.info('FFmpeg OK!');
  startAutoUpdate();
}

export function reset() {
  lockInit = false;
  ffmpegPath = null;
  stopAutoUpdate();
  resetBootstrap();
}

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
const cache = new Map();
let cacheBytes = 0;

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) { return null; }
  cache.delete(key);
  cache.set(key, entry); // move to most-recently-used
  return entry;
}

function cacheSet(key, entry) {
  // Don't evict the whole cache to hold one oversized item.
  if (entry.contentLength > CACHE_MAX_BYTES) { return; }
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

function spawnTranscode(inputPath, codec, bitrate) {
  const entry = codecMap[codec];
  const args = [
    '-i', inputPath,
    '-vn',                          // no video
    '-f', entry.format,             // output container format
    '-acodec', entry.codec,         // audio codec
    '-ab', bitrate,                 // audio bitrate
    'pipe:1'                        // output to stdout
  ];

  const proc = spawn(ffmpegPath, args, {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  proc.stderr.on('data', () => {}); // suppress ffmpeg stderr

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

  mstream.get("/transcode/{*filepath}", (req, res) => {
    if (lockInit !== true) {
      return res.status(500).json({ error: 'transcoding disabled' });
    }

    const codec = codecMap[req.query.codec] ? req.query.codec : config.program.transcode.defaultCodec;
    const bitrate = bitrateSet.has(req.query.bitrate) ? req.query.bitrate : config.program.transcode.defaultBitrate;

    // Express 5 {*filepath} returns an array — join back to a path string
    const filepath = Array.isArray(req.params.filepath)
      ? req.params.filepath.join('/')
      : req.params.filepath;
    const pathInfo = vpath.getVPathInfo(filepath, req.user);

    const cacheKey = `${pathInfo.fullPath}|${bitrate}|${codec}`;

    // ── Cache hit ────────────────────────────────────────────
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.header({
        'Accept-Ranges': 'bytes',
        'Content-Type': codecMap[codec].contentType,
        'Content-Length': cached.contentLength
      });
      Readable.from(cached.bufs).pipe(res);
      return;
    }

    // ── Look up duration for Content-Length estimate ──────────
    const lib = db.getLibraryByName(pathInfo.vpath);
    let duration = 0;
    if (lib) {
      const track = db.getDB()?.prepare(
        'SELECT duration FROM tracks WHERE filepath = ? AND library_id = ?'
      ).get(pathInfo.relativePath, lib.id);
      duration = track?.duration || 0;
    }

    const bitrateNum = parseInt(bitrate) * 1000; // '96k' → 96000
    const estimatedBytes = duration > 0
      ? Math.ceil(duration * bitrateNum / 8 * 1.05) // 5% container overhead
      : 0;

    // ── Set headers ──────────────────────────────────────────
    const headers = { 'Content-Type': codecMap[codec].contentType };
    if (estimatedBytes > 0) {
      headers['Content-Length'] = estimatedBytes;
      headers['Accept-Ranges'] = 'bytes';
    }
    res.header(headers);

    // ── Stream + collect for cache ───────────────────────────
    const proc = spawnTranscode(pathInfo.fullPath, codec, bitrate);
    const bufs = [];
    let contentLength = 0;
    // Set when the client disconnects (and we SIGTERM ffmpeg as a result). The
    // collected buffer is then a TRUNCATED prefix of the song and must never be
    // cached — otherwise the next listener requesting the same track is served
    // the short version. Skipping a track mid-play is the common trigger.
    let aborted = false;

    proc.stdout.on('data', chunk => {
      bufs.push(chunk);
      contentLength += chunk.length;
    });

    // Stream to client immediately
    proc.stdout.pipe(res);

    proc.on('close', code => {
      // Cache ONLY a clean, complete transcode. A SIGTERM kill reports
      // code === null and an ffmpeg failure reports a non-zero code; both mean
      // the output is partial, so cache nothing.
      if (aborted || code !== 0) {
        if (code !== 0 && code !== null) {
          winston.error(`FFmpeg exited with code ${code} for ${pathInfo.fullPath}`);
        }
        return;
      }
      if (contentLength > 0) {
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
