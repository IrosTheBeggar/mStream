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
    const schema = Joi.object({
      url: Joi.string().required(),
    });
    const { value } = joiValidate(schema, req.body);

    if (!config.program.transcode || config.program.transcode.enabled !== true) {
      return res.status(500).json({ error: 'transcoding disabled' });
    }

    if(!transcode.isDownloaded()) {
      return res.status(500).json({ error: 'FFmpeg not downloaded yet' });
    }

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

    const ytdl = spawn('yt-dlp', ['-f', "ba", "-x", value.url, '-o', 'C:\\Users\\paul\\Downloads\\zipped-playlist #5\\#55\\%(title)s.%(ext)s', "--ffmpeg-location", ffmpegPath, "--audio-format", "mp3"]);
    downloadTracker.set(ytdl.pid, { process: ytdl, metadata: {} });

    ytdl.stdout.on('data', (data) => {
      winston.info(`yt-dlp output: ${data}`);
    });

    ytdl.stderr.on('data', (data) => {
      winston.error('yt-dlp error: failed to download file - ', value.url);
      winston.error('yt-dlp error:', data.toString());
    });

    ytdl.on('close', (code) => {
      downloadTracker.delete(ytdl.pid);
      if (code !== 0) {
        winston.error(`yt-dlp process exited with code ${code}`);
      }
    });

    // TODO: embed album art and metadata

    res.json({ message: 'Download started' });
  });
}