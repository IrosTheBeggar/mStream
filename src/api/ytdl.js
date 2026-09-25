// Youtube DL: download a YouTube URL the user pasted into a library folder.
// The yt-dlp mechanics (binary, download, cover, tags) live in
// src/util/yt-dlp.js, shared with the discovery "youtube" plug-in; the row
// insert in src/db/insert-downloaded-track.js, shared with every download.

import winston from "winston";
import Joi from 'joi';
import * as config from '../state/config.js';
import * as transcode from './transcode.js';
import { joiValidate } from '../util/validation.js';
import * as vpath from '../util/vpath.js';
import { insertDownloadedTrack } from '../db/insert-downloaded-track.js';
import * as downloadsDb from '../db/plugin-downloads.js';
import WebError from '../util/web-error.js';
import { ffmpegBin } from '../util/ffmpeg-bootstrap.js';
import * as ytdlp from '../util/yt-dlp.js';
import * as ytDlpBootstrap from '../util/yt-dlp-bootstrap.js';
import * as staging from '../discovery-plugins/staging.js';
import fs from 'fs/promises';
import path from 'node:path';

const downloadTracker = new Map();

const youtubeUrlSchema = Joi.string().uri({ scheme: ['http', 'https'] }).required().custom((value) => {
  const parsed = new URL(value);
  if (parsed.hostname !== 'youtube.com' && !parsed.hostname.endsWith('.youtube.com') && parsed.hostname !== 'youtu.be') {
    throw new Error('URL must be a YouTube link');
  }
  return value;
});

function sanitizeYoutubeUrl(url) {
  const parsed = new URL(url);
  const v = parsed.searchParams.get('v');
  if (!v) { throw new WebError('Invalid YouTube URL - missing video ID', 400); }
  parsed.search = '';
  parsed.searchParams.set('v', v);
  return parsed.toString();
}

// One setting says where yt-dlp is, for the route and the plug-in alike —
// and one resolver decides which copy runs (src/util/yt-dlp-bootstrap.js:
// the server's own while it is current, else mStream's managed copy,
// fetched on first use and kept current). null when there is none.
async function binary() {
  const cfg = config.program.discoveryPlugins && config.program.discoveryPlugins.youtube;
  const found = await ytDlpBootstrap.locate(cfg && cfg.binary);
  if (found.bin) { ytDlpBootstrap.startAutoUpdate(); }
  return found.bin;
}

function forget(pid) {
  setTimeout(() => downloadTracker.delete(pid), 30000);
}

export function setup(mstream) {
  mstream.post("/api/v1/ytdl/", async (req, res) => {
    if (config.program.noUpload === true) { throw new WebError('Uploading Disabled', 403); }
    if (req.user.allow_upload === false || req.user.allow_upload === 0) { throw new WebError('Uploading Disabled', 403); }

    if (!transcode.isDownloaded()) {
      return res.status(500).json({ error: 'FFmpeg is not available yet' });
    }

    const filesFormats = Object.keys(config.program.supportedAudioFiles).filter((format) => {
      return config.program.supportedAudioFiles[format] === true;
    });

    const schema = Joi.object({
      directory: Joi.string().required(),
      url: youtubeUrlSchema,
      outputCodec: Joi.string().valid(...filesFormats).default('mp3'),
      metadata: Joi.object({
        title: Joi.string().allow('').optional(),
        artist: Joi.string().allow('').optional(),
        album: Joi.string().allow('').optional(),
        year: Joi.string().allow('').optional(),
      }).optional().default({}),
    });
    const { value } = joiValidate(schema, req.body);

    // verify path exists
    const pathInfo = vpath.getVPathInfo(value.directory, req.user);
    if (!(await fs.stat(pathInfo.fullPath)).isDirectory()) { throw new WebError('Not A Directory', 400); }

    value.url = sanitizeYoutubeUrl(value.url);

    const ffmpegPath = ffmpegBin();
    const bin = await binary();
    if (!bin) {
      winston.error('yt-dlp is not installed');
      return res.status(500).json({ error: 'yt-dlp is not installed' });
    }

    const codec = value.outputCodec;
    const expectedExt = ytdlp.outputExtension(codec);
    const userMeta = value.metadata || {};
    const requester = req.user ? req.user.id : null;   // the request is gone by the time the file lands
    // Into a staging folder of its own, never straight into the library
    // folder: what yt-dlp writes on the way (a thumbnail, fragments, a
    // .part) would be taken for songs and art, and a "<title>.<ext>" already
    // there would be adopted as this download — under --no-overwrites yt-dlp
    // skips the fetch and prints the existing file's path, which the route
    // then re-tagged, re-inserted and recorded as the caller's. The finished
    // file moves into the folder the caller named, never over an existing one.
    const dir = await staging.scratchStagingDir('ytdl');
    const handle = ytdlp.startDownload({
      bin, url: value.url, dir, codec, ffmpegPath,
      onLog: (line) => winston.info(`yt-dlp output: ${line}`),
    });
    const entry = {
      url: value.url,
      directory: value.directory,
      outputCodec: codec,
      metadata: userMeta,
      status: 'downloading',
      startTime: Date.now(),
    };
    downloadTracker.set(handle.pid, entry);

    handle.done.then(async ({ filePath: staged, warning }) => {
      if (warning) { winston.warn(`yt-dlp exited unhappily but left a file (${warning}) — carrying on with ${staged}`); }
      if (ytdlp.FFMPEG_THUMBNAIL_CODECS.includes(codec)) {
        const info = await ytdlp.lookupMetadata(value.url, { bin }).catch(() => ({}));
        await ytdlp.embedThumbnailIfMissing(staged, { codec, thumbnailUrl: info.thumbnail, ffmpegPath });
      }
      // User-submitted metadata + the MSTREAM_SOURCE provenance marker,
      // then the row the way a scan would write it. V36: source = 'ytdl'.
      await ytdlp.writeTags(staged, { codec, meta: userMeta, source: 'ytdl', ffmpegPath });
      const filePath = path.join(pathInfo.fullPath, path.basename(staged));
      if (await fs.stat(filePath).then(() => true, () => false)) {
        throw new Error(`a file named ${path.basename(staged)} already exists in ${value.directory} — nothing was replaced`);
      }
      await staging.moveIntoPlace(staged, filePath);
      const inserted = await insertDownloadedTrack({
        filePath,
        vpath: pathInfo.vpath,
        basePath: pathInfo.basePath,
        source: 'ytdl',
        format: expectedExt,
        userMeta,
        log: 'yt-dlp',
      });
      // The same record the discovery plug-ins keep of what they bring in
      // (src/db/plugin-downloads.js), so the Downloads view is complete.
      const stat = await fs.stat(filePath).catch(() => null);
      downloadsDb.recordQuietly({
        plugin: 'ytdl', userId: requester, vpath: pathInfo.vpath, relativePath: inserted.relativePath,
        fileHash: inserted.hash, origin: value.url, title: inserted.title, artist: inserted.artist, album: inserted.album,
        bytes: stat ? stat.size : null,
      });
      entry.status = 'complete';
      forget(handle.pid);
    }).catch((err) => {
      winston.error(`yt-dlp: failed to download ${value.url}: ${err && err.message ? err.message : err}`, { stack: err });
      entry.status = 'error';
      forget(handle.pid);
    }).finally(() => staging.discardStaging(dir));

    res.json({ message: 'Download started' });
  });

  mstream.get("/api/v1/ytdl/metadata", async (req, res) => {
    const schema = Joi.object({ url: youtubeUrlSchema });
    const { value } = joiValidate(schema, req.query);

    const bin = await binary();
    if (!bin) {
      return res.status(500).json({ error: 'yt-dlp is not installed' });
    }

    const url = sanitizeYoutubeUrl(value.url);
    const metadata = await ytdlp.lookupMetadata(url, { bin });
    res.json(metadata);
  });

  mstream.get("/api/v1/ytdl/downloads", (req, res) => {
    const downloads = [];
    for (const [pid, entry] of downloadTracker) {
      downloads.push({
        pid,
        url: entry.url,
        directory: entry.directory,
        outputCodec: entry.outputCodec,
        status: entry.status,
        startTime: entry.startTime,
      });
    }
    res.json({ downloads });
  });
}
