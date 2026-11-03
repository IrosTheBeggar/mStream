// Youtube DL: download a YouTube URL the user pasted into a library folder.
// The yt-dlp mechanics (binary, download, cover, tags) live in
// src/util/yt-dlp.js, shared with the discovery "youtube" plug-in; the row
// insert in src/db/insert-downloaded-track.js, shared with every download;
// the per-account job list in ./ytdl-jobs.js.
//
//   POST /api/v1/ytdl            check the name, then start: { message, id, fileName }
//                                — or 409 { error, reason: 'exists', fileName } when the
//                                folder already has that name (nothing is started)
//   GET  /api/v1/ytdl/metadata   what the link is (title, artist, … fileStem, isLive)
//   GET  /api/v1/ytdl/downloads  the caller's jobs, newest first; settled ones kept 24 h
//
// The name check reads the file name yt-dlp will give the download before
// downloading (one metadata call, which a lookup a moment earlier has
// usually made already — the probe cache below). The never-replace check at
// the move stays: a file that turns up while the download runs is still
// never overwritten.

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
import * as jobs from './ytdl-jobs.js';
import { refuseJukebox } from './discovery-plugin-jobs.js';
import fs from 'fs/promises';
import path from 'node:path';

// A pasted URL is one song: the size cap and the wall clock the route
// hands yt-dlp (src/util/yt-dlp.js enforces both, whatever yt-dlp fetches).
const MAX_FILESIZE_MB = 500;
const MAX_SECONDS = 60 * 60;

// The probe a POST makes for the name check is bounded tight (a client
// waits on the answer); a metadata lookup gets longer.
const PROBE_TIMEOUT_MS = 15000;
const LOOKUP_TIMEOUT_MS = 60000;

// What a probe found, by sanitised URL, for ten minutes: a client looks a
// link up, then adds it a few seconds later, and the add then costs no
// second yt-dlp call. What YouTube says about a video is the same for
// every account, so the cache is shared. Failures are never kept.
const PROBE_TTL_MS = 10 * 60 * 1000;
const PROBE_CACHE_MAX = 64;
const probeCache = new Map();   // url → { at, value }, oldest first

function cachedProbe(url) {
  const hit = probeCache.get(url);
  if (!hit) { return null; }
  if (Date.now() - hit.at >= PROBE_TTL_MS) { probeCache.delete(url); return null; }
  return hit.value;
}

function rememberProbe(url, value) {
  probeCache.delete(url);
  probeCache.set(url, { at: Date.now(), value });
  while (probeCache.size > PROBE_CACHE_MAX) { probeCache.delete(probeCache.keys().next().value); }
}

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
  // `?v=` and nothing else: no playlist, no start time — not "#t=1m"
  // either, which would make the job, the record and the probe cache name
  // the same video another way.
  parsed.search = '';
  parsed.hash = '';
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

const exists = (p) => fs.stat(p).then(() => true, () => false);

export function setup(mstream) {
  // A jukebox session holds the owner's account id (auth.js
  // buildJukeboxUser): the job list would show a remote-control guest the
  // owner's links and folders. The POST is refused for it anyway (no
  // upload right); the guest is refused at the door, as on the discovery
  // plug-in routes.
  mstream.use('/api/v1/ytdl', refuseJukebox);

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

    // The folder: the caller's library (404 for one they lack, before any
    // yt-dlp call), and a folder that is there.
    const pathInfo = vpath.getVPathInfo(value.directory, req.user);
    const folderStat = await fs.stat(pathInfo.fullPath).catch(() => null);
    if (!folderStat) { throw new WebError('Folder not found', 404); }
    if (!folderStat.isDirectory()) { throw new WebError('Not A Directory', 400); }
    // The folder as the caller may see it named (never its place on disk).
    const folder = pathInfo.relativePath ? `${pathInfo.vpath}/${pathInfo.relativePath}` : pathInfo.vpath;

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

    // The name check, before anything is fetched. A probe that fails never
    // refuses the add: the download speaks for itself, and its failure
    // lands on the job — only a name the folder already has is refused here.
    let probed = cachedProbe(value.url);
    if (!probed) {
      try {
        probed = await ytdlp.probe(value.url, { bin, timeoutMs: PROBE_TIMEOUT_MS });
        rememberProbe(value.url, probed);
      } catch (err) {
        winston.warn(`yt-dlp: could not read ${value.url} before downloading (${err.message}) — downloading without the name check`);
      }
    }
    const fileName = probed ? ytdlp.fileNameFor(probed.fileStem, codec) : null;
    if (fileName && await exists(path.join(pathInfo.fullPath, fileName))) {
      winston.info(`yt-dlp: ${value.url} would land as ${fileName}, which ${folder} already has — not started`);
      return res.status(409).json({ error: `“${fileName}” is already in this folder, so nothing was added.`, reason: 'exists', fileName });
    }

    // Into a staging folder of its own, never straight into the library
    // folder: what yt-dlp writes on the way (a thumbnail, fragments, a
    // .part) would be taken for songs and art, and a "<title>.<ext>" already
    // there would be adopted as this download — under --no-overwrites yt-dlp
    // skips the fetch and prints the existing file's path, which the route
    // then re-tagged, re-inserted and recorded as the caller's. The finished
    // file moves into the folder the caller named, never over an existing one.
    const dir = await staging.scratchStagingDir('ytdl');
    const handle = ytdlp.startDownload({
      bin, url: value.url, dir, codec, ffmpegPath, maxFilesizeMb: MAX_FILESIZE_MB, maxSeconds: MAX_SECONDS,
      onLog: (line) => winston.info(`yt-dlp output: ${line}`),
    });
    const job = jobs.create({
      userId: requester, pid: handle.pid, url: value.url, directory: value.directory, outputCodec: codec, fileName,
    });

    handle.done.then(async ({ filePath: staged, warning }) => {
      if (warning) { winston.warn(`yt-dlp exited unhappily but left a file (${warning}) — carrying on with ${staged}`); }
      // User-submitted metadata + the MSTREAM_SOURCE provenance marker, then
      // the cover yt-dlp could not embed (writeTagsAndCover says why in that
      // order), then the row the way a scan would write it. V36: source = 'ytdl'.
      // The probe already named the cover; without it, one more lookup for
      // the codecs whose cover is ours to embed.
      let thumbnailUrl = probed ? probed.thumbnail : null;
      if (!probed && ytdlp.FFMPEG_THUMBNAIL_CODECS.includes(codec)) {
        thumbnailUrl = (await ytdlp.lookupMetadata(value.url, { bin }).catch(() => ({}))).thumbnail;
      }
      await ytdlp.writeTagsAndCover(staged, { codec, meta: userMeta, source: 'ytdl', thumbnailUrl, ffmpegPath });
      const base = path.basename(staged);
      const filePath = path.join(pathInfo.fullPath, base);
      if (await exists(filePath)) {
        throw Object.assign(new Error(`a file named ${base} already exists in ${folder} — nothing was replaced`), { reason: 'exists' });
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
      // (src/db/plugin-downloads.js), so the Downloads view is complete —
      // and the job names it, so a client links the two without matching.
      const stat = await fs.stat(filePath).catch(() => null);
      const recorded = downloadsDb.recordQuietly({
        plugin: 'ytdl', userId: requester, vpath: pathInfo.vpath, relativePath: inserted.relativePath,
        fileHash: inserted.hash, origin: value.url, title: inserted.title, artist: inserted.artist, album: inserted.album,
        bytes: stat ? stat.size : null,
      });
      jobs.complete(job, {
        filePath: `${pathInfo.vpath}/${inserted.relativePath}`,
        fileName: base,
        downloadId: recorded ? recorded.id : null,
      });
    }).catch((err) => {
      const raw = err && err.message ? err.message : String(err);
      // A failure with a reason is an answer (a name taken, a stream, a
      // cap, a video YouTube refused), not a fault. startDownload reads
      // the reason from yt-dlp's own words; the rest of the messages that
      // land here (a move, the row insert) can carry the video's title,
      // which is never read for one.
      const reason = (err && err.reason)
        || (probed && probed.isLive && /no output file/.test(raw) ? 'live' : null);
      if (reason) {
        winston.warn(`yt-dlp: did not download ${value.url} (${reason}): ${raw}`);
      } else {
        winston.error(`yt-dlp: failed to download ${value.url}: ${raw}`, { stack: err });
      }
      // The words go to the caller, so the server's own folders come out.
      const error = jobs.publicMessage(err, [
        [dir, ''],
        [pathInfo.fullPath, folder],
        [pathInfo.basePath, pathInfo.vpath],
        [ffmpegPath && path.isAbsolute(ffmpegPath) ? ffmpegPath : null, 'ffmpeg'],
        [bin.script || null, 'yt-dlp'],
        [bin.cmd && path.isAbsolute(bin.cmd) ? bin.cmd : null, 'yt-dlp'],
      ]);
      jobs.fail(job, { error, reason });
    }).finally(() => staging.discardStaging(dir));

    // `message` for the clients that read only that; `id` follows the job.
    res.json({ message: 'Download started', id: job.id, fileName });
  });

  mstream.get("/api/v1/ytdl/metadata", async (req, res) => {
    const schema = Joi.object({ url: youtubeUrlSchema });
    const { value } = joiValidate(schema, req.query);

    const bin = await binary();
    if (!bin) {
      return res.status(500).json({ error: 'yt-dlp is not installed' });
    }

    const url = sanitizeYoutubeUrl(value.url);
    let probed = cachedProbe(url);
    if (!probed) {
      try {
        probed = await ytdlp.probe(url, { bin, timeoutMs: LOOKUP_TIMEOUT_MS });
      } catch (err) {
        // A plain error, so the answer stays the bare 500 clients read as
        // "could not look it up".
        winston.error(`yt-dlp metadata lookup failed: ${err.message}`);
        throw new Error('Failed to lookup metadata', { cause: err });
      }
      rememberProbe(url, probed);
    }
    res.json(ytdlp.metadataOf(probed));
  });

  mstream.get("/api/v1/ytdl/downloads", (req, res) => {
    res.json({ downloads: jobs.listFor(req.user ? req.user.id : null) });
  });
}
