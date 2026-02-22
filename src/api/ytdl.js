import commandExists from "command-exists";
import { spawn } from "child_process";
import winston from "winston";
import Joi from 'joi';
import ffbinaries from 'ffbinaries';
import path from 'path';
import * as config from '../state/config.js';
import * as transcode from './transcode.js';
import { joiValidate } from '../util/validation.js';

const downloadTracker = new Map();
const platform = ffbinaries.detectPlatform();

export function setup(mstream) {
  mstream.post("/api/v1/ytdl/", async (req, res) => {
    if (!config.program.transcode || config.program.transcode.enabled !== true) {
      return res.status(500).json({ error: 'transcoding disabled' });
    }

    if(!transcode.isDownloaded()) {
      return res.status(500).json({ error: 'FFmpeg not downloaded yet' });
    }

    const filesFormats = Object.keys(config.program.supportedAudioFiles).filter((format) => {
      return config.program.supportedAudioFiles[format] === true;
    });

    const schema = Joi.object({
      filepath: Joi.string().required(),
      url: Joi.string().uri({ scheme: ['http', 'https'] }).required().custom((value) => {
        const parsed = new URL(value);
        if (parsed.hostname !== 'youtube.com' && !parsed.hostname.endsWith('.youtube.com') && parsed.hostname !== 'youtu.be') {
          throw new Error('URL must be a YouTube link');
        }
        return value;
      }),
      outputCodec: Joi.string().valid(...filesFormats).default('mp3'),
    });
    const { value } = joiValidate(schema, req.body);

    // Strip all URL parameters except 'v'
    const parsed = new URL(value.url);
    const v = parsed.searchParams.get('v');
    if (!v) {
      return res.status(400).json({ error: 'Invalid YouTube URL - missing video ID' });
    }
    parsed.search = '';
    parsed.searchParams.set('v', v);
    value.url = parsed.toString();

    // Pass in ffmpeg directory
    const ffmpegPath = path.join(config.program.transcode.ffmpegDirectory, ffbinaries.getBinaryFilename("ffmpeg", platform));

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

    const ytdl = spawn('yt-dlp', ['-f', "ba", "-x", value.url, '-o', 'C:\\Users\\paul\\Downloads\\zipped-playlist #5\\#55\\%(title)s.%(ext)s', "--ffmpeg-location", ffmpegPath, "--audio-format", value.outputCodec]);
    downloadTracker.set(ytdl.pid, {
      process: ytdl,
      url: value.url,
      outputCodec: value.outputCodec,
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

    ytdl.on('close', (code) => {
      const entry = downloadTracker.get(ytdl.pid);
      if (entry) {
        entry.status = code === 0 ? 'complete' : 'error';
        setTimeout(() => downloadTracker.delete(ytdl.pid), 30000);
      }
      if (code !== 0) {
        winston.error(`yt-dlp process exited with code ${code}`);
      }
    });

    // TODO: embed album art and metadata

    res.json({ message: 'Download started' });
  });

  mstream.get("/api/v1/ytdl/downloads", (req, res) => {
    const downloads = [];
    for (const [pid, entry] of downloadTracker) {
      downloads.push({
        pid,
        url: entry.url,
        outputCodec: entry.outputCodec,
        status: entry.status,
        startTime: entry.startTime,
      });
    }
    res.json({ downloads });
  });
}