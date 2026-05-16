import commandExists from "command-exists";
import { spawn } from "child_process";
import winston from "winston";
import Joi from 'joi';
import path from 'path';
import * as config from '../state/config.js';
import * as transcode from './transcode.js';
import { joiValidate } from '../util/validation.js';
import * as vpath from '../util/vpath.js';
import * as db from '../db/manager.js';
import { ffmpegBin } from '../util/ffmpeg-bootstrap.js';
import { parseFile } from 'music-metadata';
import { Jimp } from 'jimp';
import mime from 'mime-types';
import crypto from 'crypto';
import fs from 'fs/promises';

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
  if (!v) { throw new Error('Invalid YouTube URL - missing video ID'); }
  parsed.search = '';
  parsed.searchParams.set('v', v);
  return parsed.toString();
}

function lookupMetadata(url) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', ['--dump-json', '--no-download', url]);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data; });
    proc.stderr.on('data', (data) => { stderr += data; });

    proc.on('close', (code) => {
      if (code !== 0) {
        winston.error('yt-dlp metadata lookup failed:', stderr);
        return reject(new Error('Failed to lookup metadata'));
      }

      try {
        const json = JSON.parse(stdout);
        resolve({
          title: json.title || null,
          artist: json.artist || json.creator || json.uploader || null,
          album: json.album || null,
          year: json.release_year || json.release_date?.substring(0, 4) || null,
          thumbnail: json.thumbnail || null,
        });
      } catch (e) {
        reject(new Error('Failed to parse yt-dlp output'));
      }
    });
  });
}

export function setup(mstream) {
  mstream.post("/api/v1/ytdl/", async (req, res) => {
    if (config.program.noUpload === true) { throw new WebError('Uploading Disabled'); }
    if (req.user.allow_upload === false || req.user.allow_upload === 0) { throw new WebError('Uploading Disabled', 403); }

    if (!transcode.isDownloaded()) {
      return res.status(500).json({ error: 'FFmpeg not downloaded yet' });
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
    if (!(await fs.stat(pathInfo.fullPath)).isDirectory()) { throw new Error('Not A Directory'); }

    value.url = sanitizeYoutubeUrl(value.url);

    // Pass in ffmpeg directory
    const ffmpegPath = ffmpegBin();

    try {
      const exists = await commandExists('yt-dlp')
      if (!exists) {
        winston.error('yt-dlp is not installed');
        return res.status(500).json({ error: 'yt-dlp is not installed' });
      }
    } catch (err) {
      winston.error('Error in ytdl API', err);
      res.status(500).json({ error: 'Error - failed to find yt-dlp' });
    }

    const downloadDir = path.join(pathInfo.fullPath, `%(title)s.%(ext)s`);
    const formatMap = { 'ogg': 'vorbis', 'm4b': 'm4a' };
    const ytdlAudioFormat = formatMap[value.outputCodec] || value.outputCodec;
    const ytdlArgs = ['-f', "ba", "-x", value.url, '-o', downloadDir,
      "--ffmpeg-location", ffmpegPath, "--audio-format", ytdlAudioFormat, "--embed-metadata"];
    const noEmbedThumbnail = ['wav', 'opus', 'ogg'];
    if (!noEmbedThumbnail.includes(value.outputCodec)) {
      ytdlArgs.push("--embed-thumbnail", "--convert-thumbnails", "jpg");
    }
    const ytdl = spawn('yt-dlp', ytdlArgs);
    
    downloadTracker.set(ytdl.pid, {
      process: ytdl,
      url: value.url,
      directory: value.directory,
      outputCodec: value.outputCodec,
      metadata: value.metadata,
      status: 'downloading',
      startTime: Date.now(),
    });

    ytdl.stdout.on('data', (data) => {
      winston.info(`yt-dlp output: ${data}`);
    });

    ytdl.stderr.on('data', (data) => {
      winston.error('yt-dlp error: failed to download file - ', value.url);
      winston.error('yt-dlp error:', data.toString());
    });

    ytdl.on('close', async (code) => {
      const entry = downloadTracker.get(ytdl.pid);

      if (code !== 0) {
        winston.warn(`yt-dlp process exited with code ${code}, checking for downloaded file anyway`);
      }

      try {
        // Find the downloaded file by scanning for new files matching the output codec
        // Some formats produce a different file extension than the codec name
        const extMap = { 'aac': 'm4a' };
        const expectedExt = extMap[value.outputCodec] || value.outputCodec;
        const dirFiles = await fs.readdir(pathInfo.fullPath);
        let downloadedFile = null;
        let downloadedStat = null;
        for (const file of dirFiles) {
          if (!file.endsWith('.' + expectedExt)) continue;
          const filePath = path.join(pathInfo.fullPath, file);
          const stat = await fs.stat(filePath);
          if (stat.mtime.getTime() >= entry.startTime) {
            downloadedFile = filePath;
            downloadedStat = stat;
            break;
          }
        }

        if (!downloadedFile) {
          if (entry) {
            entry.status = 'error';
            setTimeout(() => downloadTracker.delete(ytdl.pid), 30000);
          }
          winston.error('yt-dlp: could not find downloaded file in ' + pathInfo.fullPath);
          return;
        }

        // For FLAC/Opus/OGG files, yt-dlp often fails to embed the thumbnail.
        // Download it separately and embed via ffmpeg.
        if (value.outputCodec === 'flac' || value.outputCodec === 'opus' || value.outputCodec === 'ogg') {
          try {
            // Check if the file already has an embedded picture
            const checkMeta = await parseFile(downloadedFile, { skipCovers: false });
            if (!checkMeta.common.picture || checkMeta.common.picture.length === 0) {
              // Fetch thumbnail URL from yt-dlp metadata
              const metaInfo = await lookupMetadata(value.url);
              if (metaInfo.thumbnail) {
                // Download thumbnail to a temp file
                const thumbPath = downloadedFile + '.thumb.jpg';
                const rawThumbPath = thumbPath + '.tmp';
                const thumbResponse = await fetch(metaInfo.thumbnail);
                if (!thumbResponse.ok) throw new Error('thumbnail download failed');
                await fs.writeFile(rawThumbPath, Buffer.from(await thumbResponse.arrayBuffer()));
                await new Promise((resolve, reject) => {
                  const proc = spawn(ffmpegPath, ['-y', '-i', rawThumbPath, thumbPath]);
                  proc.on('close', (c) => c === 0 ? resolve() : reject(new Error('thumbnail conversion failed')));
                  proc.on('error', reject);
                });
                try { await fs.unlink(rawThumbPath); } catch { /* ignore */ }

                try {
                  await fs.access(thumbPath);
                  const tmpEmbed = downloadedFile + '.tmp.' + expectedExt;

                  if (value.outputCodec === 'flac') {
                    // FLAC supports attached_pic via ffmpeg directly
                    await new Promise((resolve, reject) => {
                      const proc = spawn(ffmpegPath, [
                        '-i', downloadedFile, '-i', thumbPath,
                        '-map', '0:a', '-map', '1:0',
                        '-c', 'copy', '-disposition:v', 'attached_pic',
                        '-y', tmpEmbed
                      ]);
                      proc.on('close', (c) => c === 0 ? resolve() : reject(new Error('ffmpeg thumbnail embed failed')));
                      proc.on('error', reject);
                    });
                  } else {
                    // OGG/Opus need METADATA_BLOCK_PICTURE encoded in Vorbis comments
                    const imgData = await fs.readFile(thumbPath);
                    const mimeStr = 'image/jpeg';
                    // Build METADATA_BLOCK_PICTURE binary: type(4) + mime_len(4) + mime + desc_len(4) + desc + width(4) + height(4) + depth(4) + colors(4) + data_len(4) + data
                    const header = Buffer.alloc(32 + mimeStr.length);
                    let offset = 0;
                    header.writeUInt32BE(3, offset); offset += 4;              // picture type: front cover
                    header.writeUInt32BE(mimeStr.length, offset); offset += 4; // MIME length
                    header.write(mimeStr, offset); offset += mimeStr.length;   // MIME string
                    header.writeUInt32BE(0, offset); offset += 4;              // description length
                    header.writeUInt32BE(0, offset); offset += 4;              // width (0 = unknown)
                    header.writeUInt32BE(0, offset); offset += 4;              // height (0 = unknown)
                    header.writeUInt32BE(0, offset); offset += 4;              // color depth
                    header.writeUInt32BE(0, offset); offset += 4;              // indexed colors
                    header.writeUInt32BE(imgData.length, offset);              // data length
                    const pictureBlock = Buffer.concat([header, imgData]);
                    const b64 = pictureBlock.toString('base64');

                    // Write to temp file to avoid OS command-line length limits
                    const metaFilePath = downloadedFile + '.ffmeta';
                    await new Promise((resolve, reject) => {
                      const proc = spawn(ffmpegPath, [
                        '-y', '-i', downloadedFile,
                        '-f', 'ffmetadata', metaFilePath
                      ]);
                      proc.on('close', (c) => c === 0 ? resolve() : reject(new Error('metadata extraction failed')));
                      proc.on('error', reject);
                    });
                    await fs.appendFile(metaFilePath, `METADATA_BLOCK_PICTURE=${b64}\n`);
                    await new Promise((resolve, reject) => {
                      const proc = spawn(ffmpegPath, [
                        '-y', '-i', downloadedFile,
                        '-f', 'ffmetadata', '-i', metaFilePath,
                        '-map', '0:a', '-map_metadata', '1',
                        '-c:a', 'copy', tmpEmbed
                      ]);
                      proc.on('close', (c) => c === 0 ? resolve() : reject(new Error('ffmpeg thumbnail embed failed')));
                      proc.on('error', reject);
                    });
                    try { await fs.unlink(metaFilePath); } catch { /* ignore */ }
                  }

                  await fs.rename(tmpEmbed, downloadedFile);
                  downloadedStat = await fs.stat(downloadedFile);
                  winston.info('yt-dlp: embedded thumbnail into ' + value.outputCodec + ' file');
                } finally {
                  try { await fs.unlink(thumbPath); } catch { /* ignore */ }
                  try { await fs.unlink(thumbPath + '.tmp'); } catch { /* ignore */ }
                  try { await fs.unlink(downloadedFile + '.tmp.' + expectedExt); } catch { /* ignore */ }
                }
              }
            }
          } catch (thumbErr) {
            winston.warn('yt-dlp: failed to embed thumbnail into ' + value.outputCodec, { stack: thumbErr });
          }
        }

        // Write user-submitted metadata + the MSTREAM_SOURCE provenance
        // marker to the file's audio tags via ffmpeg. MSTREAM_SOURCE is
        // written unconditionally so the provenance signal travels with
        // the file (across copies, moves, re-scans on another machine);
        // user metadata is added only when supplied. Per-container ffmpeg
        // emits the metadata key as:
        //   - MP3 / WAV (ID3v2): TXXX frame, description='MSTREAM_SOURCE'
        //   - FLAC / OGG / Opus (Vorbis comments): MSTREAM_SOURCE=ytdl
        //   - M4A / M4B / AAC: ffmpeg's MP4 muxer silently drops
        //     non-standard `-metadata` keys on write. The tag does NOT
        //     land in the file. yt-dlp itself faces the same limitation,
        //     and `purl` is dropped too. The scanners READ freeform
        //     iTunes atoms fine (lofty + music-metadata both handle
        //     them) — files tagged externally via mutagen or
        //     AtomicParsley work. But ytdl-downloaded M4As won't carry
        //     a recoverable marker. The DB-side INSERT below still
        //     attributes the row (source='ytdl'), and the scanner's
        //     mtime fast-path preserves that across normal rescans. The
        //     gap is the re-extract-after-mtime-drift case for M4A
        //     specifically — accepted limitation.
        // The scanner's tag-readback (src/db/scanner.mjs + rust-parser/src/main.rs)
        // recognises all working encodings and translates to tracks.source.
        const userMeta = entry.metadata || {};
        try {
          const tmpFile = downloadedFile + '.tmp.' + expectedExt;
          const ffmpegArgs = ['-i', downloadedFile, '-c', 'copy'];
          if (userMeta.title) { ffmpegArgs.push('-metadata', `title=${userMeta.title}`); }
          if (userMeta.artist) { ffmpegArgs.push('-metadata', `artist=${userMeta.artist}`); }
          if (userMeta.album) { ffmpegArgs.push('-metadata', `album=${userMeta.album}`); }
          if (userMeta.year) { ffmpegArgs.push('-metadata', `date=${userMeta.year}`); }
          ffmpegArgs.push('-metadata', 'MSTREAM_SOURCE=ytdl');
          ffmpegArgs.push('-y', tmpFile);

          await new Promise((resolve, reject) => {
            const proc = spawn(ffmpegPath, ffmpegArgs);
            proc.on('close', (ffCode) => {
              if (ffCode !== 0) { return reject(new Error(`ffmpeg exited with code ${ffCode}`)); }
              resolve();
            });
            proc.on('error', reject);
          });

          await fs.rename(tmpFile, downloadedFile);
          downloadedStat = await fs.stat(downloadedFile);
          winston.info('yt-dlp: wrote metadata tags + MSTREAM_SOURCE marker to file');
        } catch (tagErr) {
          winston.error('yt-dlp: failed to write metadata tags', { stack: tagErr });
          try { await fs.unlink(downloadedFile + '.tmp.' + expectedExt); } catch { /* ignore */ }
        }

        // Parse metadata from the downloaded file (include covers for album art)
        const skipImg = config.program.scanOptions.skipImg === true;
        let metadata;
        try {
          metadata = (await parseFile(downloadedFile, { skipCovers: skipImg })).common;
        } catch (err) {
          winston.error('yt-dlp: metadata parse error', { stack: err });
          metadata = { track: { no: null, of: null }, disk: { no: null, of: null } };
        }

        // Compute both whole-file and audio-region hashes. The scanner uses
        // the same helper so ytdl-inserted rows are identity-compatible with
        // scanned rows.
        const { fileHash: hash, audioHash } = await (await import('../db/audio-hash.js')).computeHashes(downloadedFile);

        // Build DB record matching the scanner schema
        // User-submitted metadata overrides take priority over parsed file metadata
        const relativePath = path.relative(pathInfo.basePath, downloadedFile);
        const data = {
          title: userMeta.title || (metadata.title ? String(metadata.title) : null),
          artist: userMeta.artist || (metadata.artist ? String(metadata.artist) : null),
          year: userMeta.year ? Number(userMeta.year) : (metadata.year || null),
          album: userMeta.album || (metadata.album ? String(metadata.album) : null),
          filepath: relativePath,
          format: expectedExt,
          track: metadata.track?.no || null,
          disk: metadata.disk?.no || null,
          modified: downloadedStat.mtime.getTime(),
          hash: hash,
          audioHash: audioHash,
          aaFile: null,
          vpath: pathInfo.vpath,
          ts: Math.floor(Date.now() / 1000),
          // scan_id is the scanner's sweep marker — leave NULL here so the
          // first scan that touches this file claims the row normally. The
          // 'ytdl' provenance signal lives in tracks.source (V36) instead.
          sID: null,
          replaygainTrackDb: metadata.replaygain_track_gain ? metadata.replaygain_track_gain.dB : null,
        };

        // Extract and save album art from embedded thumbnail
        if (!skipImg && metadata.picture && metadata.picture[0]) {
          try {
            const picData = metadata.picture[0].data;
            const picHashString = crypto.createHash('md5').update(picData.toString('utf-8')).digest('hex');
            const extension = mime.extension(metadata.picture[0].format) || 'jpg';
            data.aaFile = picHashString + '.' + extension;

            const aaDir = config.program.storage.albumArtDirectory;
            const aaFilePath = path.join(aaDir, data.aaFile);

            // Save original if it doesn't already exist in the cache
            let isNewFile = false;
            try {
              await fs.access(aaFilePath);
            } catch {
              await fs.writeFile(aaFilePath, picData);
              isNewFile = true;
            }

            // Create compressed versions for thumbnails
            if (isNewFile && config.program.scanOptions.compressImage) {
              const img = await Jimp.fromBuffer(picData);
              await img.scaleToFit({ w: 256, h: 256 }).write(path.join(aaDir, 'zl-' + data.aaFile));
              await img.scaleToFit({ w: 92, h: 92 }).write(path.join(aaDir, 'zs-' + data.aaFile));
            }
          } catch (err) {
            winston.error('yt-dlp: failed to extract album art', { stack: err });
          }
        }

        // Insert into SQLite. V34 dropped tracks.genre — genre data flows
        // through the track_genres M2M instead (the scanner populates it
        // via setTrackGenres; ytdl downloads commonly have no embedded
        // genre tag from YouTube anyway, so we don't write the M2M here —
        // the next scan picks it up if the file ends up with one).
        // V36: tracks.source = 'ytdl' records provenance.
        const d = db.getDB();
        const lib = db.getLibraryByName(data.vpath);
        if (d && lib) {
          const artistId = db.findOrCreateArtist(data.artist);
          const albumId = db.findOrCreateAlbum(data.album, artistId, data.year);
          d.prepare(
            `INSERT OR REPLACE INTO tracks (filepath, library_id, title, artist_id, album_id, track_number,
             disc_number, year, format, file_hash, audio_hash, album_art_file, replaygain_track_db,
             modified, scan_id, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            data.filepath, lib.id, data.title || null, artistId, albumId,
            data.track, data.disk, data.year, data.format, data.hash, data.audioHash || null,
            data.aaFile, data.replaygainTrackDb, data.modified, data.sID, 'ytdl'
          );
        }
        winston.info(`yt-dlp: added ${relativePath} to database`);

        if (entry) {
          entry.status = 'complete';
          setTimeout(() => downloadTracker.delete(ytdl.pid), 30000);
        }
      } catch (err) {
        winston.error('yt-dlp: failed to add file to database', { stack: err });
        if (entry) {
          entry.status = 'error';
          setTimeout(() => downloadTracker.delete(ytdl.pid), 30000);
        }
      }
    });

    res.json({ message: 'Download started' });
  });

  mstream.get("/api/v1/ytdl/metadata", async (req, res) => {
    const schema = Joi.object({ url: youtubeUrlSchema });
    const { value } = joiValidate(schema, req.query);

    try {
      await commandExists('yt-dlp');
    } catch (err) {
      return res.status(500).json({ error: 'yt-dlp is not installed' });
    }

    const url = sanitizeYoutubeUrl(value.url);
    const metadata = await lookupMetadata(url);
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

  // ══════════════════════════════════════════════════════════════
  // VELVET UI ONLY — adapter endpoints
  // The Velvet frontend calls different paths/formats than our
  // original API. These adapters translate between the two.
  // TODO: standardize with the original endpoints so both UIs
  // use the same routes and response shapes.
  // ══════════════════════════════════════════════════════════════

  // VELVET: GET /api/v1/ytdl/info?url=...
  // Wraps our GET /api/v1/ytdl/metadata but returns { thumb } instead of { thumbnail }
  mstream.get("/api/v1/ytdl/info", async (req, res) => {
    const schema = Joi.object({ url: youtubeUrlSchema });
    const { value } = joiValidate(schema, req.query);

    try {
      await commandExists('yt-dlp');
    } catch (err) {
      return res.status(500).json({ error: 'yt-dlp is not installed' });
    }

    const url = sanitizeYoutubeUrl(value.url);
    const metadata = await lookupMetadata(url);
    res.json({
      title: metadata.title,
      artist: metadata.artist,
      album: metadata.album,
      thumb: metadata.thumbnail,
    });
  });

  // VELVET: POST /api/v1/ytdl/download
  // Accepts { url, title, artist, album, format } and waits for completion,
  // returning { filePath, vpath }. Our original POST /api/v1/ytdl/ starts
  // async and returns immediately. TODO: unify into one endpoint.
  mstream.post("/api/v1/ytdl/download", async (req, res) => {
    if (config.program.noUpload === true) {
      return res.status(403).json({ error: 'Uploading Disabled' });
    }
    if (req.user.allow_upload === false || req.user.allow_upload === 0) {
      return res.status(403).json({ error: 'Uploading Disabled' });
    }
    if (!transcode.isDownloaded()) {
      return res.status(500).json({ error: 'FFmpeg not downloaded yet' });
    }

    try {
      await commandExists('yt-dlp');
    } catch (err) {
      return res.status(500).json({ error: 'yt-dlp is not installed' });
    }

    const { url, title, artist, album, format } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });

    // Map format names: Velvet uses 'opus'/'mp3', our backend uses outputCodec
    const outputCodec = format || 'opus';

    // Find a download directory — use the first vpath the user has access to
    const userVpaths = req.user.vpaths || [];
    if (!userVpaths.length) {
      return res.status(400).json({ error: 'No library folder available' });
    }

    // Use the first vpath as download target
    const targetVpath = userVpaths[0];
    const directory = targetVpath;

    // Verify path exists
    let pathInfo;
    try {
      pathInfo = vpath.getVPathInfo(directory, req.user);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid directory' });
    }

    let sanitizedUrl;
    try {
      sanitizedUrl = sanitizeYoutubeUrl(url);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    const ffmpegPath = ffmpegBin();
    const downloadDir = path.join(pathInfo.fullPath, `%(title)s.%(ext)s`);
    const formatMap = { 'ogg': 'vorbis', 'm4b': 'm4a' };
    const ytdlAudioFormat = formatMap[outputCodec] || outputCodec;
    const ytdlArgs = ['-f', 'ba', '-x', sanitizedUrl, '-o', downloadDir,
      '--ffmpeg-location', ffmpegPath, '--audio-format', ytdlAudioFormat, '--embed-metadata'];
    const noEmbedThumbnail = ['wav', 'opus', 'ogg'];
    if (!noEmbedThumbnail.includes(outputCodec)) {
      ytdlArgs.push('--embed-thumbnail', '--convert-thumbnails', 'jpg');
    }

    const startTime = Date.now();
    const extMap = { 'aac': 'm4a' };
    const expectedExt = extMap[outputCodec] || outputCodec;

    // Run yt-dlp and wait for completion
    try {
      await new Promise((resolve, reject) => {
        const ytdl = spawn('yt-dlp', ytdlArgs);
        let stderr = '';

        ytdl.stderr.on('data', (data) => { stderr += data.toString(); });

        const timer = setTimeout(() => {
          ytdl.kill('SIGTERM');
          reject(new Error('Download timed out'));
        }, 300000);

        ytdl.on('close', (code) => {
          clearTimeout(timer);
          if (code !== 0) {
            winston.warn(`yt-dlp exited with code ${code}`);
          }
          resolve();
        });
        ytdl.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    } catch (e) {
      return res.status(500).json({ error: e.message || 'Download failed' });
    }

    // Find the downloaded file
    let downloadedFile = null;
    try {
      const dirFiles = await fs.readdir(pathInfo.fullPath);
      for (const file of dirFiles) {
        if (!file.endsWith('.' + expectedExt)) continue;
        const filePath = path.join(pathInfo.fullPath, file);
        const stat = await fs.stat(filePath);
        if (stat.mtime.getTime() >= startTime) {
          downloadedFile = filePath;
          break;
        }
      }
    } catch (e) { /* ignore */ }

    if (!downloadedFile) {
      return res.status(500).json({ error: 'Download completed but file not found' });
    }

    // Write user metadata tags + MSTREAM_SOURCE provenance marker. Same
    // mechanism + container mapping as the original POST handler above —
    // see that block for the per-codec encoding details.
    const userMeta = {};
    if (title) userMeta.title = title;
    if (artist) userMeta.artist = artist;
    if (album) userMeta.album = album;

    try {
      const tmpFile = downloadedFile + '.tmp.' + expectedExt;
      const ffmpegArgs = ['-i', downloadedFile, '-c', 'copy'];
      if (userMeta.title) ffmpegArgs.push('-metadata', `title=${userMeta.title}`);
      if (userMeta.artist) ffmpegArgs.push('-metadata', `artist=${userMeta.artist}`);
      if (userMeta.album) ffmpegArgs.push('-metadata', `album=${userMeta.album}`);
      ffmpegArgs.push('-metadata', 'MSTREAM_SOURCE=ytdl');
      ffmpegArgs.push('-y', tmpFile);

      await new Promise((resolve, reject) => {
        const proc = spawn(ffmpegPath, ffmpegArgs);
        proc.on('close', (c) => c === 0 ? resolve() : reject(new Error('ffmpeg metadata failed')));
        proc.on('error', reject);
      });
      await fs.rename(tmpFile, downloadedFile);
    } catch (tagErr) {
      winston.warn('ytdl/download: failed to write metadata tags', { stack: tagErr });
      try { await fs.unlink(downloadedFile + '.tmp.' + expectedExt); } catch { /* ignore */ }
    }

    // Parse metadata and add to DB
    const skipImg = config.program.scanOptions.skipImg === true;
    let metadata;
    try {
      metadata = (await parseFile(downloadedFile, { skipCovers: skipImg })).common;
    } catch (err) {
      metadata = { track: { no: null, of: null }, disk: { no: null, of: null } };
    }

    // Dual-hash: file_hash (whole file) + audio_hash (audio region only,
    // stable across tag edits). See src/db/audio-hash.js.
    const { fileHash: hash, audioHash } = await (await import('../db/audio-hash.js')).computeHashes(downloadedFile);
    const relativePath = path.relative(pathInfo.basePath, downloadedFile).replace(/\\/g, '/');

    // Extract album art
    let aaFile = null;
    if (!skipImg && metadata.picture && metadata.picture[0]) {
      try {
        const picData = metadata.picture[0].data;
        const picHash = crypto.createHash('md5').update(picData.toString('utf-8')).digest('hex');
        const extension = mime.extension(metadata.picture[0].format) || 'jpg';
        aaFile = picHash + '.' + extension;

        const aaDir = config.program.storage.albumArtDirectory;
        const aaFilePath = path.join(aaDir, aaFile);
        try { await fs.access(aaFilePath); } catch {
          await fs.writeFile(aaFilePath, picData);
          if (config.program.scanOptions.compressImage) {
            const img = await Jimp.fromBuffer(picData);
            await img.scaleToFit({ w: 256, h: 256 }).write(path.join(aaDir, 'zl-' + aaFile));
            await img.scaleToFit({ w: 92, h: 92 }).write(path.join(aaDir, 'zs-' + aaFile));
          }
        }
      } catch (err) { /* ignore */ }
    }

    // Insert into DB. Same column / value shape as the original POST
    // handler above — see that block for the rationale on V34 (genre
    // dropped → track_genres M2M), scan_id NULL (let scans claim it),
    // and source='ytdl' (V36 provenance).
    const d = db.getDB();
    const lib = db.getLibraryByName(targetVpath);
    if (d && lib) {
      const artistId = db.findOrCreateArtist(userMeta.artist || metadata.artist || null);
      const albumId = db.findOrCreateAlbum(userMeta.album || metadata.album || null, artistId, metadata.year || null);
      d.prepare(
        `INSERT OR REPLACE INTO tracks (filepath, library_id, title, artist_id, album_id, track_number,
         disc_number, year, format, file_hash, audio_hash, album_art_file, replaygain_track_db,
         modified, scan_id, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        relativePath, lib.id,
        userMeta.title || metadata.title || null, artistId, albumId,
        metadata.track?.no || null, metadata.disk?.no || null,
        metadata.year || null, expectedExt, hash, audioHash || null,
        aaFile, null,
        Date.now(), null, 'ytdl'
      );
    }

    res.json({
      filePath: relativePath,
      vpath: targetVpath,
    });
  });
}