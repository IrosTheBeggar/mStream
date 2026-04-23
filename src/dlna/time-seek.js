/**
 * DLNA time-based seek support.
 *
 * When a renderer sends `TimeSeekRange.dlna.org: npt=START-` on a `/media/...`
 * request, we transcode the file to MP3 starting from `START` seconds using
 * ffmpeg, and respond with the `TimeSeekRange.dlna.org` response header. This
 * lets DLNA clients like Sony receivers and some TVs seek by time even when
 * the underlying codec doesn't support efficient byte-range time lookup.
 *
 * No TimeSeekRange header → the middleware calls `next()` and the static
 * file handler serves byte-ranges normally.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import winston from 'winston';
import * as db from '../db/manager.js';
import { ffmpegBin, getResolvedSource } from '../util/ffmpeg-bootstrap.js';

// Parse an NPT time spec per UPnP AV: either decimal seconds (`123.456`) or
// `H:MM:SS.sss` / `MM:SS.sss`. Returns null on malformed input.
function parseNptStart(header) {
  const m = /npt\s*=\s*([^-\s]+)/i.exec(header || '');
  if (!m) return null;
  const raw = m[1];
  if (raw.includes(':')) {
    const segs = raw.split(':').map(Number);
    if (segs.some(n => !Number.isFinite(n))) return null;
    if (segs.length === 3) return segs[0] * 3600 + segs[1] * 60 + segs[2];
    if (segs.length === 2) return segs[0] * 60 + segs[1];
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function formatNpt(secs) {
  if (!Number.isFinite(secs) || secs < 0) return '0:00:00.000';
  const totalMs = Math.round(secs * 1000);
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = (totalMs % 60000) / 1000;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

export function timeSeekMiddleware(req, res, next) {
  const header = req.headers['timeseekrange.dlna.org'];
  if (!header) { return next(); }

  // Only GET and HEAD are meaningful here — reject anything else before we
  // bother parsing the rest of the request.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).end();
  }

  const start = parseNptStart(header);
  if (start === null || start < 0) { return res.status(400).end(); }

  // Resolve library + file path from the URL.
  const parts = req.path.split('/').filter(Boolean);
  if (parts.length < 2) { return res.status(404).end(); }
  let libname, fileParts;
  try {
    libname = decodeURIComponent(parts[0]);
    fileParts = parts.slice(1).map(p => decodeURIComponent(p));
  } catch (_) {
    return res.status(400).end();
  }

  const lib = db.getAllLibraries().find(l => l.name === libname);
  if (!lib) { return res.status(404).end(); }

  const resolved = path.resolve(path.join(lib.root_path, ...fileParts));
  const rootResolved = path.resolve(lib.root_path);
  if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
    return res.status(403).end();
  }

  // Verify the file is actually there before promising a 200. Without this,
  // a stale DB row (file deleted but scan hasn't caught up) would produce a
  // 200 OK followed by an empty body once ffmpeg fails to open the input.
  if (!fs.existsSync(resolved)) { return res.status(404).end(); }

  // Look up duration so we can emit the TimeSeekRange response header.
  const relPath = fileParts.join('/');
  const row = db.getDB().prepare(
    'SELECT duration FROM tracks WHERE library_id = ? AND filepath = ?'
  ).get(lib.id, relPath);
  const duration = row?.duration;
  if (duration && start >= duration) { return res.status(416).end(); }

  // Pick the output profile.
  //
  // MP3 inputs use `-c:a copy` — every MP3 frame is independently
  // decodable and the MP3 "muxer" is a passthrough, so `-ss` before
  // `-i` delivers a frame-aligned seek that preserves the original
  // bitstream byte-for-byte. Significant CPU + quality win for the
  // common case.
  //
  // FLAC intentionally stays on the transcode-to-MP3 path even though
  // FLAC frames are also independently decodable. Empirical test
  // (ffprobe on `-ss 10 -i 30s.flac -c:a copy -f flac -`): the FLAC
  // muxer writes STREAMINFO with the *original* file's
  // duration_ts/total_samples (30 s), but the actual content is only
  // 20 s post-seek. Strict FLAC decoders that trust STREAMINFO will
  // report wrong durations and some may pre-allocate buffers based
  // on the stale total_samples. No ffmpeg flag observed
  // (`-map_metadata -1`, `-fflags +bitexact`, `-ss` after `-i`) fixes
  // this — the muxer derives the header from the demuxer's reported
  // duration before seek-copied packets arrive. Re-encoding to FLAC
  // would solve it but defeats the point of codec-copy, so we just
  // stay on the MP3 transcode path for FLAC.
  //
  // Everything else (OGG/Opus/AAC/M4A/WAV) transcodes to MP3 at
  // 192k the way the original path did: MP3 is the DLNA lowest
  // common denominator every client speaks.
  const ext = path.extname(resolved).toLowerCase();
  let ffArgs;
  let contentType;
  if (ext === '.mp3') {
    contentType = 'audio/mpeg';
    ffArgs = [
      '-nostdin',
      '-ss', String(start),
      '-i', resolved,
      '-vn',
      '-c:a', 'copy',
      '-f', 'mp3',
      '-loglevel', 'error',
      '-',
    ];
  } else {
    contentType = 'audio/mpeg';
    ffArgs = [
      '-nostdin',
      '-ss', String(start),
      '-i', resolved,
      '-vn',
      '-c:a', 'libmp3lame',
      '-b:a', '192k',
      '-f', 'mp3',
      '-loglevel', 'error',
      '-',
    ];
  }

  // HEAD: clients probe duration via HEAD + TimeSeekRange. Respond with
  // headers only, no body — ffmpeg would be wasted work. Content-Type
  // must match what the GET path will emit so picky clients (Sony,
  // Marantz) accept the subsequent GET.
  if (req.method === 'HEAD') {
    const end = duration ? formatNpt(duration) : '';
    const durStr = duration ? formatNpt(duration) : '';
    res.status(200).set({
      'Content-Type': contentType,
      'TimeSeekRange.dlna.org': `npt=${formatNpt(start)}-${end}/${durStr}`,
      'X-Seek-By-Time-Range': 'true',
      'transferMode.dlna.org': 'Streaming',
      'Connection': 'close',
    }).end();
    return;
  }

  if (!getResolvedSource()) {
    winston.warn('[dlna time-seek] ffmpeg unavailable, refusing seek request');
    return res.status(503).end();
  }

  let ff;
  try {
    ff = spawn(ffmpegBin(), ffArgs);
  } catch (err) {
    winston.error(`[dlna time-seek] ffmpeg spawn failed: ${err.message}`);
    return res.status(500).end();
  }

  const end = duration ? formatNpt(duration) : '';
  const durStr = duration ? formatNpt(duration) : '';

  // ENOENT from spawn surfaces on the 'error' event, not synchronously.
  // Attach the error handler before writing headers so a missing binary
  // yields a 500 the caller can act on, rather than a silent 0-byte 200.
  let headersSent = false;
  ff.once('error', err => {
    winston.error(`[dlna time-seek] ffmpeg error: ${err.message}`);
    if (!headersSent && !res.headersSent) {
      try { res.status(500).end(); } catch (_) { /* already closed */ }
    } else {
      try { res.end(); } catch (_) { /* already closed */ }
    }
  });

  res.status(200).set({
    'Content-Type': contentType,
    'TimeSeekRange.dlna.org': `npt=${formatNpt(start)}-${end}/${durStr}`,
    'X-Seek-By-Time-Range': 'true',
    'transferMode.dlna.org': 'Streaming',
    'Connection': 'close',
  });
  headersSent = true;

  ff.stdout.pipe(res);
  ff.stderr.on('data', d => winston.debug(`[dlna time-seek] ${d.toString().trim()}`));

  // Kill ffmpeg if the client disconnects mid-stream — otherwise it keeps
  // encoding to a dead pipe until the input file is exhausted.
  const cleanup = () => { try { ff.kill('SIGKILL'); } catch (_) { /* already exited */ } };
  req.on('close', cleanup);
  res.on('close', cleanup);
}
