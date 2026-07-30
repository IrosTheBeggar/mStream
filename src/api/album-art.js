/**
 * Album art management API endpoints.
 * Allows users to search for album art across services and set it for tracks/albums.
 */

import Joi from 'joi';
import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import https from 'https';
import http from 'http';
import { spawn } from 'child_process';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as vpath from '../util/vpath.js';
import { joiValidate, sanitizeFilename } from '../util/validation.js';
import WebError from '../util/web-error.js';
import { ffmpegBin } from '../util/ffmpeg-bootstrap.js';
import { isDownloaded as ffmpegIsDownloaded } from './transcode.js';
import { generateThumbnails, tooManyPixels, isSupportedImage } from '../util/image-thumbs.js';

// ── HTTP helpers ────────────────────────────────────────────────────────────

// Bounded GET. `maxBytes` is enforced DURING streaming, so a response that
// lies about (or omits) its length can't balloon memory before the caller's
// size check runs — /album-art/set-from-url fetches an ATTACKER-CHOSEN URL.
// The 15s inactivity timeout is wired to an actual destroy (on its own,
// 'timeout' only fires an event and the request hangs until the peer closes).
// This mirrors the hardened twin in src/db/album-art-lib.js.
export function httpGet(url, { maxBytes = 10 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const follow = (u, redirects = 0) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      const mod = u.startsWith('https') ? https : http;
      const req = mod.get(u, {
        headers: { 'User-Agent': 'mStream/6.0 (https://mstream.io)' },
        timeout: 15000
      }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          // Resolve + protocol-check INSIDE the handler: a relative or
          // malformed Location threw out of this callback (uncaught → the
          // whole process died), and a file:/data: target would have been
          // handed to http.get. Same hardening as the album-art-lib twin.
          let next;
          try { next = new URL(res.headers.location, u); }
          catch (_e) { return reject(new Error('Malformed redirect Location')); }
          if (next.protocol !== 'http:' && next.protocol !== 'https:') {
            return reject(new Error(`Refusing redirect to ${next.protocol} URL`));
          }
          return follow(next.href, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        let received = 0;
        res.on('data', c => {
          received += c.length;
          if (received > maxBytes) {
            res.destroy();
            return reject(new Error(`Response exceeded ${maxBytes} bytes`));
          }
          chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('timeout', function () { this.destroy(new Error('Request timeout')); })
        .on('error', reject);
    };
    follow(url);
  });
}

export async function httpGetJson(url) {
  const buf = await httpGet(url);
  return JSON.parse(buf.toString('utf8'));
}

// ── Service search functions (return URLs, not images) ──────────────────────

async function searchMusicBrainzUrls(artist, album) {
  try {
    const query = encodeURIComponent(`release:"${album}" AND artist:"${artist}"`);
    const url = `https://musicbrainz.org/ws/2/release/?query=${query}&limit=3&fmt=json`;
    const data = await httpGetJson(url);
    if (!data.releases || data.releases.length === 0) return [];

    const results = [];
    for (const release of data.releases.slice(0, 3)) {
      results.push({
        service: 'musicbrainz',
        url: `https://coverartarchive.org/release/${release.id}/front-500`,
        label: `MusicBrainz: ${release.title}${release.date ? ' (' + release.date.substring(0, 4) + ')' : ''}`
      });
    }
    return results;
  } catch (_e) { return []; }
}

async function searchItunesUrls(artist, album) {
  try {
    const term = encodeURIComponent(`${artist} ${album}`);
    const data = await httpGetJson(`https://itunes.apple.com/search?term=${term}&entity=album&limit=3`);
    if (!data.results) return [];

    return data.results.map(r => ({
      service: 'itunes',
      url: r.artworkUrl100 ? r.artworkUrl100.replace('100x100bb', '600x600bb') : null,
      label: `iTunes: ${r.collectionName}${r.releaseDate ? ' (' + r.releaseDate.substring(0, 4) + ')' : ''}`
    })).filter(r => r.url);
  } catch (_e) { return []; }
}

async function searchDeezerUrls(artist, album) {
  try {
    const query = encodeURIComponent(`artist:"${artist}" album:"${album}"`);
    const data = await httpGetJson(`https://api.deezer.com/search/album?q=${query}&limit=3`);
    if (!data.data) return [];

    return data.data.map(r => ({
      service: 'deezer',
      url: r.cover_xl || r.cover_big || r.cover_medium,
      label: `Deezer: ${r.title}${r.nb_tracks ? ' (' + r.nb_tracks + ' tracks)' : ''}`
    })).filter(r => r.url);
  } catch (_e) { return []; }
}

// ── Art serving ─────────────────────────────────────────────────────────────

// Express handler for GET /album-art/:file. The `compress` query param is
// interpolated into the on-disk cache filename (e.g. `zl-abc.jpeg`), so it's
// strictly validated — anything path-like would escape the album-art directory.
// `dotfiles: 'allow'` lets it serve files when the install path contains
// dot-prefixed segments (e.g. `~/.config/mstream/image-cache`).
const SEND_FILE_OPTS = { dotfiles: 'allow' };
export function serveAlbumArtFile(req, res) {
  const filename = sanitizeFilename(req.params.file);
  const dir = config.program.storage.albumArtDirectory;
  // sendFile() with no error callback forwards a missing file to Express's
  // error handler as a 500; handle it so a not-found cover is a clean 404
  // instead. The error from `send` is an http-errors object (err.status===404
  // for ENOENT/ENAMETOOLONG/ENOTDIR). Bail if the response already started
  // (client aborted mid-stream → headers/data flushed); log genuine 5xx causes.
  const send = (p) => res.sendFile(p, SEND_FILE_OPTS, (err) => {
    if (!err || res.headersSent) return;
    const notFound =
      err.status === 404 || err.statusCode === 404 || err.code === 'ENOENT';
    if (!notFound) {
      winston.warn(`[album-art] failed to serve ${p}: ${err.message}`);
    }
    res.status(notFound ? 404 : 500).end();
  });
  const compress = req.query.compress;
  if (compress !== undefined) {
    if (typeof compress !== 'string' || !/^[a-zA-Z0-9]{1,8}$/.test(compress)) {
      return res.status(400).end();
    }
    const compressedPath = path.resolve(path.join(dir, `z${compress}-${filename}`));
    // existsSync stays as the fall-through trigger: a missing compressed variant
    // serves the original rather than 404-ing.
    if (fs.existsSync(compressedPath)) {
      return send(compressedPath);
    }
  }
  send(path.resolve(path.join(dir, filename)));
}

// ── Art save helpers ────────────────────────────────────────────────────────

export async function saveImageToCache(imgBuf, albumArtDir) {
  const hash = crypto.createHash('md5').update(imgBuf).digest('hex');
  const filename = hash + '.jpg';
  const artPath = path.join(albumArtDir, filename);

  if (!fs.existsSync(artPath)) {
    await fsp.writeFile(artPath, imgBuf);
    if (config.program.scanOptions.compressImage) {
      // Off the event loop (bundled ffmpeg child process) + pixel-count
      // guarded; failures are logged inside, never thrown — the full-size
      // cover serves on its own. See src/util/image-thumbs.js for why this
      // is not a Jimp decode here any more.
      await generateThumbnails(imgBuf, artPath, albumArtDir, filename);
    }
  }
  return filename;
}

export async function embedArtInFile(audioFilePath, imgBuf) {
  const ffmpeg = ffmpegBin();
  if (!ffmpeg) { return; }
  // Only verify existence for absolute paths. When ffmpegBin() returns a
  // bare command name (system-PATH fallback), leave the check to spawn().
  if (path.isAbsolute(ffmpeg)) {
    try { await fsp.access(ffmpeg); } catch { return; }
  }

  const ext = path.extname(audioFilePath).toLowerCase();
  const tmpImg = audioFilePath + '.cover.jpg';
  // Keep the real extension on the temp output — ffmpeg infers the output
  // container from it. A bare `.tmp_art` fails with "Unable to choose an
  // output format", which silently broke art-embedding for every format.
  const tmpOut = audioFilePath + '.tmp_art' + ext;

  // Map only the source AUDIO streams (`0:a`) + the new cover (`1:0`). Using
  // `-map 0` would also carry over any existing embedded cover, which then
  // collides with the new one — a hard mux error on M4A ("two mjpeg streams")
  // or stale, unreplaced art on FLAC. `0:a` drops the old cover so the new one
  // cleanly replaces it.
  let args;
  if (ext === '.mp3') {
    args = ['-y', '-i', audioFilePath, '-i', tmpImg, '-map', '0:a', '-map', '1:0',
            '-c', 'copy', '-id3v2_version', '3',
            '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)', tmpOut];
  } else if (ext === '.flac') {
    // `-disposition:v:0 attached_pic` is REQUIRED for FLAC — without it the
    // FLAC muxer drops the mapped image (writes 0 bytes of picture data) and
    // the cover silently never lands.
    args = ['-y', '-i', audioFilePath, '-i', tmpImg, '-map', '0:a', '-map', '1:0',
            '-c', 'copy', '-disposition:v:0', 'attached_pic', '-metadata:s:v', 'comment=Cover (front)', tmpOut];
  } else if (ext === '.m4a' || ext === '.aac' || ext === '.m4b') {
    args = ['-y', '-i', audioFilePath, '-i', tmpImg, '-map', '0:a', '-map', '1:0',
            '-c', 'copy', '-disposition:v:0', 'attached_pic', tmpOut];
  } else {
    return; // unsupported container — nothing to embed
  }

  // NOTE: plain async function, NOT `new Promise(async …)`. With an async
  // executor a throw from writeFile/spawn rejects the executor's inner
  // promise, never the constructed one, so the caller's `await` hangs forever
  // and leaks the temp files. Here every failure rejects normally and the
  // `finally` guarantees cleanup.
  await fsp.writeFile(tmpImg, imgBuf);
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      proc.on('error', () => reject(new Error('ffmpeg spawn failed')));
      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error('ffmpeg embed failed')));
    });
    await fsp.rename(tmpOut, audioFilePath);
  } finally {
    await fsp.unlink(tmpImg).catch(() => {});
    await fsp.unlink(tmpOut).catch(() => {}); // no-op on success (renamed away)
  }
}

// ── API setup ───────────────────────────────────────────────────────────────

export function setup(mstream) {
  const d = () => db.getDB();

  // Search for album art across all services
  mstream.post('/api/v1/album-art/search', async (req, res) => {
    const schema = Joi.object({
      artist: Joi.string().allow('').optional().default(''),
      album: Joi.string().allow('').optional().default('')
    });
    joiValidate(schema, req.body);

    if (!req.body.artist && !req.body.album) {
      return res.json({ results: [], ffmpegAvailable: false });
    }

    const services = config.program.scanOptions.albumArtServices || ['musicbrainz', 'itunes', 'deezer'];
    const results = [];

    for (const service of services) {
      try {
        if (service === 'musicbrainz') results.push(...await searchMusicBrainzUrls(req.body.artist, req.body.album));
        else if (service === 'itunes') results.push(...await searchItunesUrls(req.body.artist, req.body.album));
        else if (service === 'deezer') results.push(...await searchDeezerUrls(req.body.artist, req.body.album));
      } catch (_e) {}
    }

    const canModifyFiles = !config.program.noFileModify
      && req.user.allow_file_modify !== false
      && req.user.allow_file_modify !== 0;

    res.json({
      results,
      ffmpegAvailable: ffmpegIsDownloaded() && canModifyFiles
    });
  });

  // Set album art from a URL (selected from search results)
  mstream.post('/api/v1/album-art/set-from-url', async (req, res) => {
    const schema = Joi.object({
      filepath: Joi.string().required(),
      url: Joi.string().uri().required(),
      writeToFolder: Joi.boolean().default(false),
      writeToFile: Joi.boolean().default(false)
    });
    joiValidate(schema, req.body);

    try {
      const imgBuf = await httpGet(req.body.url);
      if (imgBuf.length < 1000) throw new Error('Downloaded image too small');
      if (imgBuf.length > 10 * 1024 * 1024) throw new Error('Downloaded image too large (>10MB)');
      // The URL is attacker-chosen, so validate what came back the same way
      // the upload route validates its body. Format first: an unsupported
      // format (TIFF/BMP/...) has dimensions we cannot read, so it would
      // reach the decoder unbounded.
      if (!isSupportedImage(imgBuf)) {
        throw new Error('Downloaded file is not a supported image (JPEG, PNG, WebP or GIF)');
      }
      // Byte size doesn't bound pixel count: a small file can decode to
      // hundreds of megapixels. Checked from the header, before anything
      // touches the image data.
      const pixelReason = tooManyPixels(imgBuf);
      if (pixelReason) throw new Error(`Downloaded ${pixelReason}`);

      await applyAlbumArt(req.body.filepath, imgBuf, req.body.writeToFolder, req.body.writeToFile, req.user);
      res.json({ ok: true });
    } catch (e) {
      // Honour a WebError's status (e.g. 404 not-found from applyAlbumArt);
      // everything else here is a bad-image / processing failure → 400.
      res.status(e instanceof WebError ? e.status : 400).json({ error: e.message });
    }
  });

  // Set album art from uploaded file
  mstream.post('/api/v1/album-art/upload', async (req, res) => {
    const schema = Joi.object({
      filepath: Joi.string().required(),
      image: Joi.string().required(), // base64 encoded
      writeToFolder: Joi.boolean().default(false),
      writeToFile: Joi.boolean().default(false)
    });
    joiValidate(schema, req.body);

    try {
      const imgBuf = Buffer.from(req.body.image, 'base64');

      // Validate size (max 10MB)
      if (imgBuf.length > 10 * 1024 * 1024) {
        return res.status(400).json({ error: 'Image too large (max 10MB)' });
      }
      if (imgBuf.length < 100) {
        return res.status(400).json({ error: 'Image too small' });
      }

      // Validate format by checking magic bytes (shared with set-from-url so
      // the two entry points cannot drift apart). The old inline WebP check
      // only matched 'RIFF' — any RIFF container passed.
      if (!isSupportedImage(imgBuf)) {
        return res.status(400).json({ error: 'Invalid image format. Use JPEG, PNG, WebP or GIF.' });
      }

      // The 10 MB byte cap above does NOT bound pixel count — a 92 KB
      // 4000×4000 JPEG used to stall the whole server for seconds while it
      // decoded. Header-only check, so rejection costs microseconds.
      const pixelReason = tooManyPixels(imgBuf);
      if (pixelReason) {
        return res.status(400).json({ error: `Image too large: ${pixelReason}` });
      }

      await applyAlbumArt(req.body.filepath, imgBuf, req.body.writeToFolder, req.body.writeToFile, req.user);
      res.json({ ok: true });
    } catch (e) {
      // Honour a WebError's status (e.g. 404 not-found from applyAlbumArt);
      // everything else here is a bad-image / processing failure → 400.
      res.status(e instanceof WebError ? e.status : 400).json({ error: e.message });
    }
  });

  // Check if ffmpeg is available and file modification is allowed
  mstream.get('/api/v1/album-art/ffmpeg-status', (req, res) => {
    const canModify = !config.program.noFileModify
      && req.user.allow_file_modify !== false
      && req.user.allow_file_modify !== 0;
    res.json({ available: ffmpegIsDownloaded() && canModify });
  });

  // Apply album art to a track and optionally its album
  async function applyAlbumArt(filepath, imgBuf, writeToFolder, writeToFile, user) {
    // Enforce file modification permission
    if (writeToFile) {
      const canModify = !config.program.noFileModify
        && user.allow_file_modify !== false
        && user.allow_file_modify !== 0;
      if (!canModify) {
        writeToFile = false; // silently downgrade — don't error
      }
    }
    // Resolve (and thereby authorize) the target BEFORE any image work: a
    // bogus filepath must not buy an attacker a decode/resize. This used to
    // run after saveImageToCache, so every request paid the image cost even
    // when it ended in a 404.
    const pathInfo = vpath.getVPathInfo(filepath, user);
    const lib = db.getLibraryByName(pathInfo.vpath);
    if (!lib) throw new WebError('Library not found', 404);

    const track = d().prepare(
      'SELECT id, album_id FROM tracks WHERE filepath = ? AND library_id = ?'
    ).get(pathInfo.relativePath, lib.id);
    if (!track) throw new WebError('Track not found', 404);

    const albumArtDir = config.program.storage.albumArtDirectory;
    const filename = await saveImageToCache(imgBuf, albumArtDir);

    // Update track art
    d().prepare('UPDATE tracks SET album_art_file = ? WHERE id = ?').run(filename, track.id);

    // Update album art if track has an album
    if (track.album_id) {
      d().prepare('UPDATE albums SET album_art_file = ? WHERE id = ?').run(filename, track.album_id);
      // Update all tracks in the same album that don't have art
      d().prepare('UPDATE tracks SET album_art_file = ? WHERE album_id = ? AND album_art_file IS NULL')
        .run(filename, track.album_id);
    }

    // Write cover.jpg to the track's directory
    if (writeToFolder) {
      const trackDir = path.dirname(path.join(lib.root_path, pathInfo.relativePath));
      const coverPath = path.join(trackDir, 'cover.jpg');
      if (!fs.existsSync(coverPath)) {
        await fsp.writeFile(coverPath, imgBuf);
      }
    }

    // Embed art in the audio file via ffmpeg
    if (writeToFile && ffmpegIsDownloaded()) {
      const fullPath = path.join(lib.root_path, pathInfo.relativePath);
      try {
        await embedArtInFile(fullPath, imgBuf);
      } catch (e) {
        winston.warn(`[album-art] Failed to embed art in ${fullPath}: ${e.message}`);
      }
    }
  }
}
