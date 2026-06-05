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
import { Jimp } from 'jimp';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as vpath from '../util/vpath.js';
import { joiValidate, sanitizeFilename } from '../util/validation.js';
import { ffmpegBin } from '../util/ffmpeg-bootstrap.js';
import { isDownloaded as ffmpegIsDownloaded } from './transcode.js';

// ── HTTP helpers ────────────────────────────────────────────────────────────

export function httpGet(url) {
  return new Promise((resolve, reject) => {
    const follow = (u, redirects = 0) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      const mod = u.startsWith('https') ? https : http;
      mod.get(u, {
        headers: { 'User-Agent': 'mStream/6.0 (https://mstream.io)' },
        timeout: 15000
      }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return follow(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
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
  const compress = req.query.compress;
  if (compress !== undefined) {
    if (typeof compress !== 'string' || !/^[a-zA-Z0-9]{1,8}$/.test(compress)) {
      return res.status(400).end();
    }
    const compressedPath = path.resolve(path.join(dir, `z${compress}-${filename}`));
    if (fs.existsSync(compressedPath)) {
      return res.sendFile(compressedPath, SEND_FILE_OPTS);
    }
  }
  res.sendFile(path.resolve(path.join(dir, filename)), SEND_FILE_OPTS);
}

// ── Art save helpers ────────────────────────────────────────────────────────

export async function saveImageToCache(imgBuf, albumArtDir) {
  const hash = crypto.createHash('md5').update(imgBuf).digest('hex');
  const filename = hash + '.jpg';
  const artPath = path.join(albumArtDir, filename);

  if (!fs.existsSync(artPath)) {
    await fsp.writeFile(artPath, imgBuf);
    if (config.program.scanOptions.compressImage) {
      try {
        const img = await Jimp.fromBuffer(imgBuf);
        await img.scaleToFit({ w: 256, h: 256 }).write(path.join(albumArtDir, 'zl-' + filename));
        await img.scaleToFit({ w: 92, h: 92 }).write(path.join(albumArtDir, 'zs-' + filename));
      } catch (_e) {}
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
  const tmpOut = audioFilePath + '.tmp_art';

  // Map only the source AUDIO streams (`0:a`) + the new cover (`1:0`) — never
  // `-map 0`, which also copies any existing embedded cover and stacks a
  // duplicate art stream on every re-tag.
  let args;
  if (ext === '.mp3') {
    args = ['-y', '-i', audioFilePath, '-i', tmpImg, '-map', '0:a', '-map', '1:0',
            '-c', 'copy', '-id3v2_version', '3',
            '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)', tmpOut];
  } else if (ext === '.flac') {
    args = ['-y', '-i', audioFilePath, '-i', tmpImg, '-map', '0:a', '-map', '1:0',
            '-c', 'copy', '-metadata:s:v', 'comment=Cover (front)', tmpOut];
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

      await applyAlbumArt(req.body.filepath, imgBuf, req.body.writeToFolder, req.body.writeToFile, req.user);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
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

      // Validate format by checking magic bytes
      const isJpeg = imgBuf[0] === 0xFF && imgBuf[1] === 0xD8;
      const isPng = imgBuf[0] === 0x89 && imgBuf[1] === 0x50 && imgBuf[2] === 0x4E && imgBuf[3] === 0x47;
      const isWebp = imgBuf[0] === 0x52 && imgBuf[1] === 0x49 && imgBuf[2] === 0x46 && imgBuf[3] === 0x46;

      if (!isJpeg && !isPng && !isWebp) {
        return res.status(400).json({ error: 'Invalid image format. Use JPEG, PNG, or WebP.' });
      }

      await applyAlbumArt(req.body.filepath, imgBuf, req.body.writeToFolder, req.body.writeToFile, req.user);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
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
    const albumArtDir = config.program.storage.albumArtDirectory;
    const filename = await saveImageToCache(imgBuf, albumArtDir);

    // Find the track in DB
    const pathInfo = vpath.getVPathInfo(filepath, user);
    const lib = db.getLibraryByName(pathInfo.vpath);
    if (!lib) throw new Error('Library not found');

    const track = d().prepare(
      'SELECT id, album_id FROM tracks WHERE filepath = ? AND library_id = ?'
    ).get(pathInfo.relativePath, lib.id);
    if (!track) throw new Error('Track not found');

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
