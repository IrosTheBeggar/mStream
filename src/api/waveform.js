// On-demand waveform endpoint for the player's progress bar.
// Used by both the default and Velvet UIs. Caches generated waveforms to
// disk (keyed by content hash) and keeps a hot set in memory.

import fs from 'node:fs';
import path from 'node:path';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { ffmpegBin, getResolvedSource } from '../util/ffmpeg-bootstrap.js';
import { getVPathInfo } from '../util/vpath.js';
import {
  generateWaveformBars,
  readCachedWaveform,
  writeCachedWaveform,
  hasFfmpegFailedMarker,
  recordFfmpegFailure,
  clearFailedMarker,
} from '../db/waveform-lib.js';

// In-memory LRU to avoid repeated disk reads
const memCache = new Map();
const MEM_MAX = 200;

// Dedup concurrent generation for the same track. If player A hits this
// endpoint and kicks off ffmpeg, player B asking for the same hash a
// moment later awaits the same promise instead of spawning a second
// ffmpeg and double-writing the cache file.
const inFlight = new Map();

// Concurrency cap for ffmpeg spawns across DIFFERENT tracks — inFlight
// only dedups same-track requests, so one page rendering fifty progress
// bars used to fork fifty decoders at once. Two keeps the box responsive
// while a queue burns down; requests past the cap wait their turn.
const MAX_CONCURRENT_FFMPEG = 2;
let ffmpegActive = 0;
const ffmpegWaiters = [];
function pumpFfmpegQueue() {
  while (ffmpegActive < MAX_CONCURRENT_FFMPEG && ffmpegWaiters.length > 0) {
    ffmpegActive++;
    ffmpegWaiters.shift()();
  }
}
async function withFfmpegSlot(fn) {
  await new Promise((resolve) => { ffmpegWaiters.push(resolve); pumpFfmpegQueue(); });
  try {
    return await fn();
  } finally {
    ffmpegActive--;
    pumpFfmpegQueue();
  }
}

function cacheDir() {
  return config.program.storage.waveformCacheDirectory;
}

function ensureCacheDir() {
  const dir = cacheDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Probe write access. Both the on-demand endpoint and the Rust scanner
  // treat write failures as best-effort (the cache is advisory — a miss
  // just regenerates), so without this a directory the server can't write
  // to stays silently empty across every scan. Most commonly this is a
  // Docker PUID/PGID mismatch on linuxserver/mstream, where the install
  // tree is chowned to the build-time uid and user-supplied PUIDs get
  // EACCES at runtime.
  const probe = path.join(dir, '.mstream-write-probe');
  try {
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
  } catch (err) {
    winston.warn(
      `[waveform] cache dir '${dir}' is not writable (${err.code || err.message}); ` +
      `waveforms will regenerate every request. Point storage.waveformCacheDirectory ` +
      `at a writable path (typically alongside dbDirectory) or fix ownership/perms.`
    );
  }
}

export function setup(mstream) {
  ensureCacheDir();

  mstream.get('/api/v1/db/waveform', async (req, res) => {
    const filepath = req.query.filepath;
    if (!filepath) {
      return res.status(400).json({ error: 'filepath required' });
    }

    // Parse and validate library access via getVPathInfo
    let pathInfo;
    try { pathInfo = getVPathInfo(filepath, req.user); } catch (_) {
      return res.status(403).json({ error: 'access denied' });
    }

    const absolutePath = pathInfo.fullPath;
    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: 'file not found' });
    }

    // Look up the track's content hashes from the database. Prefer audio_hash
    // (tag-stable) so waveforms survive tag edits — the rust-parser writes
    // .bin files keyed on it. Fall back to file_hash for formats where no
    // audio_hash is available.
    const lib = db.getLibraryByName(pathInfo.vpath);
    const track = lib && db.getDB()?.prepare(
      'SELECT file_hash, audio_hash FROM tracks WHERE filepath = ? AND library_id = ?'
    ).get(pathInfo.relativePath, lib.id);

    if (!track || (!track.audio_hash && !track.file_hash)) {
      return res.status(404).json({ error: 'track not in database' });
    }

    const key = track.audio_hash || track.file_hash;

    // Check memory cache
    if (memCache.has(key)) {
      return res.json({ waveform: memCache.get(key) });
    }

    function rememberInMem(waveform) {
      if (memCache.size >= MEM_MAX) {
        const oldest = memCache.keys().next().value;
        memCache.delete(oldest);
      }
      memCache.set(key, waveform);
    }

    // Check disk cache
    const cached = await readCachedWaveform(cacheDir(), key);
    if (cached) {
      rememberInMem(cached);
      return res.json({ waveform: cached });
    }

    if (!getResolvedSource()) {
      return res.status(503).json({ error: 'ffmpeg not ready' });
    }

    const bin = ffmpegBin();
    if (path.isAbsolute(bin) && !fs.existsSync(bin)) {
      return res.status(503).json({ error: 'ffmpeg not available' });
    }

    // A recorded ffmpeg failure means this content is undecodable here
    // (or timed out deterministically) — short-circuit instead of
    // burning a 30s decoder per play click, forever. Clearing the
    // waveform cache dir resets these.
    if (hasFfmpegFailedMarker(cacheDir(), key)) {
      return res.status(500).json({ error: 'waveform generation failed' });
    }

    // Join an already-running generation for the same track if there is
    // one; otherwise start a fresh one and register it in the map.
    let pending = inFlight.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          const waveform = await withFfmpegSlot(
            () => generateWaveformBars(absolutePath, bin));
          // Persist + warm the memory cache as a side effect; subsequent
          // callers who await this promise still get the value back.
          // Success also clears any failure marker the rust pass left
          // (symphonia can't decode Opus; ffmpeg just did).
          writeCachedWaveform(cacheDir(), key, waveform).catch(() => {});
          clearFailedMarker(cacheDir(), key).catch(() => {});
          rememberInMem(waveform);
          return waveform;
        } catch (err) {
          // Remember DETERMINISTIC failures (ffmpeg's own verdict on the
          // content) so the next request doesn't re-spawn a doomed
          // decode. Transient classes — timeout under load, spawn
          // errors — retry naturally on the next request instead of
          // poisoning the marker.
          if (!err.transient) {
            recordFfmpegFailure(cacheDir(), key).catch(() => {});
          }
          throw err;
        } finally {
          inFlight.delete(key);
        }
      })();
      inFlight.set(key, pending);
    }

    try {
      const waveform = await pending;
      res.json({ waveform });
    } catch (err) {
      res.status(500).json({ error: 'waveform generation failed' });
    }
  });
}
