// yt-dlp as a library: find the binary, look one URL up, search YouTube,
// download the best audio with progress, and the two post-processing
// passes every download gets (a cover for the containers yt-dlp cannot
// embed into, and the tag + provenance pass). Two callers share it: the
// Youtube DL route (src/api/ytdl.js — a URL the user pasted) and the
// discovery "youtube" plug-in (src/discovery-plugins/plugins/youtube.js —
// a recommendation searched for, scored and fetched as a job).
//
// The binary: MSTREAM_YTDLP_BIN (tests point it at a JavaScript stand-in,
// which then runs under this node) beats the configured name, which beats
// `yt-dlp` on PATH. Nothing here decides WHERE a file may land — callers do.

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import commandExists from 'command-exists';
import winston from 'winston';
import { parseFile } from 'music-metadata';

// yt-dlp's --audio-format names differ from our codec names for two.
export const AUDIO_FORMAT_MAP = Object.freeze({ ogg: 'vorbis', m4b: 'm4a' });
// The extension a codec lands with.
export const OUTPUT_EXT_MAP = Object.freeze({ aac: 'm4a' });
// Containers yt-dlp cannot embed a thumbnail into (embedThumbnailIfMissing
// covers the lossless / Vorbis ones afterwards).
export const NO_EMBED_THUMBNAIL = Object.freeze(['wav', 'opus', 'ogg']);
export const FFMPEG_THUMBNAIL_CODECS = Object.freeze(['flac', 'opus', 'ogg']);

export function outputExtension(codec) {
  return OUTPUT_EXT_MAP[codec] || codec;
}

// { cmd, prefix, script? } — how to spawn yt-dlp.
export function resolveBinary(configured) {
  const env = typeof process.env.MSTREAM_YTDLP_BIN === 'string' ? process.env.MSTREAM_YTDLP_BIN.trim() : '';
  if (env) {
    if (/\.(m?js|cjs)$/i.test(env)) { return { cmd: process.execPath, prefix: [env], script: env }; }
    return { cmd: env, prefix: [] };
  }
  const name = typeof configured === 'string' && configured.trim() ? configured.trim() : 'yt-dlp';
  return { cmd: name, prefix: [] };
}

export async function isAvailable(bin) {
  try {
    if (bin.script) { await fs.access(bin.script); return true; }
    if (path.isAbsolute(bin.cmd) || bin.cmd.includes('/') || bin.cmd.includes('\\')) { await fs.access(bin.cmd); return true; }
    await commandExists(bin.cmd);
    return true;
  } catch (_e) {
    return false;
  }
}

// The last line yt-dlp wrote, minus its "ERROR: " prefix — the message a
// user can act on ("Sign in to confirm you're not a bot").
export function lastMeaningfulLine(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines.length ? lines[lines.length - 1] : '';
  return last.replace(/^ERROR:\s*/i, '');
}

function killTree(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) { return; }
  if (process.platform === 'win32') {
    // yt-dlp spawns ffmpeg; /T takes the whole tree.
    try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch (_e) { /* best effort */ }
  } else {
    try { process.kill(-proc.pid, 'SIGTERM'); } catch (_e) { try { proc.kill('SIGTERM'); } catch (_e2) { /* gone */ } }
  }
}

// Spawn yt-dlp. Resolves { code, stdout, stderr }; line callbacks fire as
// output arrives; an AbortSignal kills the process tree.
export function spawnYtDlp(bin, args, { signal, onStdoutLine, onStderrLine } = {}) {
  const proc = spawn(bin.cmd, [...bin.prefix, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group on POSIX, so a cancel reaches ffmpeg too.
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  const done = new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let outBuf = '';
    let errBuf = '';
    const lines = (buf, chunk, cb) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        cb(buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
      }
      return buf;
    };
    proc.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      if (onStdoutLine) { outBuf = lines(outBuf, s, onStdoutLine); }
    });
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (onStderrLine) { errBuf = lines(errBuf, s, onStderrLine); }
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (onStdoutLine && outBuf.trim()) { onStdoutLine(outBuf.replace(/\r$/, '')); }
      if (onStderrLine && errBuf.trim()) { onStderrLine(errBuf.replace(/\r$/, '')); }
      resolve({ code, stdout, stderr });
    });
  });
  if (signal) {
    const onAbort = () => killTree(proc);
    if (signal.aborted) { onAbort(); } else { signal.addEventListener('abort', onAbort, { once: true }); }
    done.finally(() => signal.removeEventListener('abort', onAbort)).catch(() => {});
  }
  return { proc, done };
}

// What `--version` prints (yt-dlp's are dates: "2026.02.04"). Running it is
// the only honest availability check: a path can exist and still not be
// something the OS will execute (a script without its interpreter, a file
// without the execute bit). Rejects with a message an admin can act on.
export async function version(bin, { timeoutMs = 8000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const { done } = spawnYtDlp(bin, ['--version'], { signal: ac.signal });
    const { code, stdout, stderr } = await done;
    if (ac.signal.aborted) { throw new Error(`did not answer within ${Math.round(timeoutMs / 1000)} s`); }
    const line = String(stdout || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
    if (code !== 0 || !line) { throw new Error(lastMeaningfulLine(stderr) || `exited with code ${code}`); }
    return line.slice(0, 64);
  } catch (err) {
    const code = err && err.code;
    if (code === 'ENOENT') { throw new Error('not found', { cause: err }); }
    // UNKNOWN is what Windows answers for a file that is named like a
    // program and is not one.
    if (code === 'EACCES' || code === 'EFTYPE' || code === 'EPERM' || code === 'ENOEXEC' || code === 'UNKNOWN') {
      throw new Error(`is not something this system can run (${code})`, { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// One video's record, from either a flat search entry or a full dump.
export function entryToRecord(json) {
  const j = json || {};
  const year = j.release_year
    || (typeof j.release_date === 'string' ? j.release_date.slice(0, 4) : null)
    || (typeof j.upload_date === 'string' ? j.upload_date.slice(0, 4) : null)
    || null;
  const duration = Number(j.duration);
  return {
    id: j.id || null,
    url: j.webpage_url || j.url || (j.id ? `https://www.youtube.com/watch?v=${j.id}` : null),
    title: j.title || null,
    durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
    channel: j.channel || j.uploader || null,
    uploader: j.uploader || null,
    artist: j.artist || j.creator || null,
    album: j.album || null,
    track: j.track || null,
    year: year ? Number(year) || null : null,
    // A full dump names one; a flat search entry lists them (small to large).
    thumbnail: j.thumbnail || (Array.isArray(j.thumbnails) && j.thumbnails.length ? (j.thumbnails[j.thumbnails.length - 1].url || null) : null),
    viewCount: j.view_count == null ? null : Number(j.view_count),
  };
}

// The Youtube DL route's metadata lookup, unchanged in shape.
export async function lookupMetadata(url, { bin } = {}) {
  const { code, stdout, stderr } = await spawnYtDlp(bin, ['--dump-json', '--no-download', '--no-playlist', url]).done;
  if (code !== 0) {
    winston.error(`yt-dlp metadata lookup failed: ${stderr}`);
    throw new Error('Failed to lookup metadata');
  }
  let json;
  try { json = JSON.parse(stdout.trim().split(/\r?\n/).pop()); } catch (err) { throw new Error('Failed to parse yt-dlp output', { cause: err }); }
  return {
    title: json.title || null,
    artist: json.artist || json.creator || json.uploader || null,
    album: json.album || null,
    year: json.release_year || json.release_date?.substring(0, 4) || null,
    thumbnail: json.thumbnail || null,
  };
}

// YouTube search: N flat entries (id, title, duration, channel), one JSON
// line each. Flat entries are cheap but thin; confirm the top ones with
// details() before trusting duration or channel.
export async function search(query, { bin, results = 8, signal } = {}) {
  const n = Math.max(1, Math.min(50, Number(results) || 8));
  const { code, stdout, stderr } = await spawnYtDlp(bin,
    ['--dump-json', '--flat-playlist', '--no-warnings', '--skip-download', `ytsearch${n}:${query}`], { signal }).done;
  if (code !== 0) { throw new Error(lastMeaningfulLine(stderr) || `yt-dlp search exited with code ${code}`); }
  return stdout.split(/\r?\n/).filter((l) => l.trim()).map((line) => {
    try { return entryToRecord(JSON.parse(line)); } catch (_e) { return null; }
  }).filter(Boolean);
}

export async function details(url, { bin, signal } = {}) {
  const { code, stdout, stderr } = await spawnYtDlp(bin,
    ['--dump-json', '--no-download', '--no-playlist', '--no-warnings', url], { signal }).done;
  if (code !== 0) { throw new Error(lastMeaningfulLine(stderr) || `yt-dlp exited with code ${code}`); }
  const last = stdout.trim().split(/\r?\n/).pop();
  return entryToRecord(JSON.parse(last));
}

// The download argument set both callers use. `--restrict-filenames` keeps
// the file name ASCII-only; `--no-overwrites` blocks a hostile title from
// clobbering an existing file if it collides post-restriction; `--print
// after_move:filepath` tells us the final path instead of guessing it.
//
// `-f ba/b`, never a bare `ba`: a yt-dlp with no JavaScript runtime beside it
// (the common install) is often offered ONE format by YouTube, a 360p mp4
// with sound and no audio-only stream, and `ba` alone then fails with
// "Requested format is not available". `/b` takes that file; -x keeps its
// audio. `--max-filesize` bounds either choice.
export function downloadArgs({ url, dir, codec = 'mp3', ffmpegPath = null, maxFilesizeMb = null }) {
  const args = [
    '-f', 'ba/b', '-x', '--no-playlist', url,
    '-o', path.join(dir, '%(title)s.%(ext)s'),
    '--restrict-filenames', '--no-overwrites',
    '--audio-format', AUDIO_FORMAT_MAP[codec] || codec,
    '--embed-metadata', '--newline', '--progress',
    '--print', 'after_move:filepath',
  ];
  // --ffmpeg-location takes a filesystem path, NOT a PATH-resolved command
  // name: only pass it for the on-disk binary we manage.
  if (ffmpegPath && path.isAbsolute(ffmpegPath)) { args.push('--ffmpeg-location', ffmpegPath); }
  if (Number.isFinite(maxFilesizeMb) && maxFilesizeMb > 0) { args.push('--max-filesize', `${Math.round(maxFilesizeMb)}M`); }
  if (!NO_EMBED_THUMBNAIL.includes(codec)) { args.push('--embed-thumbnail', '--convert-thumbnails', 'jpg'); }
  return args;
}

// "[download]  43.2% of 5.10MiB at 1.20MiB/s ETA 00:03" → 0.432
export function parseProgressLine(line) {
  const m = /\[download\]\s+([\d.]+)%/.exec(String(line || ''));
  if (!m) { return null; }
  const p = Number(m[1]);
  return Number.isFinite(p) ? Math.max(0, Math.min(1, Math.round(p * 10) / 1000)) : null;
}

// What the output folder held before a download started: name → mtime.
async function snapshotDir(dir) {
  const seen = new Map();
  let names;
  try { names = await fs.readdir(dir); } catch (_e) { return seen; }
  for (const name of names) {
    try { seen.set(name, (await fs.stat(path.join(dir, name))).mtimeMs); } catch (_e) { /* vanished */ }
  }
  return seen;
}

// The fallback when yt-dlp printed no path: a file with the expected
// extension that is new since the snapshot, or modified since. Never a file
// that was already there untouched — a failed download must not adopt an
// earlier one.
async function newOutput(dir, ext, before) {
  let names;
  try { names = await fs.readdir(dir); } catch (_e) { return null; }
  let best = null;
  for (const name of names) {
    if (!name.endsWith('.' + ext)) { continue; }
    const full = path.join(dir, name);
    let stat;
    try { stat = await fs.stat(full); } catch (_e) { continue; }
    const earlier = before.get(name);
    if (earlier !== undefined && stat.mtimeMs <= earlier) { continue; }
    if (!best || stat.mtimeMs > best.mtimeMs) { best = { full, mtimeMs: stat.mtimeMs }; }
  }
  return best ? best.full : null;
}

// Start a download. { pid, done: Promise<{ filePath, stdout, stderr,
// warning? }>, abort() }. Progress fractions arrive through onProgress; the
// rest of yt-dlp's chatter through onLog. Abort kills the tree and rejects
// with { cancelled: true }.
export function startDownload({ bin, url, dir, codec = 'mp3', ffmpegPath, maxFilesizeMb, onProgress, onLog } = {}) {
  const before = snapshotDir(dir);
  const abort = new AbortController();
  let printed = null;
  const { proc, done } = spawnYtDlp(bin, downloadArgs({ url, dir, codec, ffmpegPath, maxFilesizeMb }), {
    signal: abort.signal,
    onStdoutLine: (line) => {
      const frac = parseProgressLine(line);
      if (frac != null) { if (onProgress) { onProgress(frac); } return; }
      if (onLog) { onLog(line); }
      const t = line.trim();
      // The --print output is a bare path; everything else yt-dlp says on
      // stdout starts with a [tag].
      if (t && !t.startsWith('[')) { printed = t; }
    },
    onStderrLine: (line) => { if (onLog) { onLog(line); } },
  });
  const result = done.then(async ({ code, stdout, stderr }) => {
    if (abort.signal.aborted) { throw Object.assign(new Error('cancelled'), { cancelled: true }); }
    let filePath = printed ? await fs.stat(printed).then((s) => (s.isFile() ? printed : null), () => null) : null;
    if (!filePath) { filePath = await newOutput(dir, outputExtension(codec), await before); }
    if (code !== 0) {
      // A non-zero exit after the file landed is a post-processing grumble
      // (the old route carried on the same way); without a file it is the
      // failure it says it is.
      if (!filePath) { throw new Error(lastMeaningfulLine(stderr) || `yt-dlp exited with code ${code}`); }
      return { filePath, stdout, stderr, warning: lastMeaningfulLine(stderr) || `yt-dlp exited with code ${code}` };
    }
    if (!filePath) { throw new Error('yt-dlp finished but no output file was found'); }
    return { filePath, stdout, stderr };
  });
  return { pid: proc.pid, done: result, abort: () => abort.abort() };
}

function runFfmpeg(ffmpegPath, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath || 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-300)}`))));
  });
}

// For FLAC / Opus / OGG, yt-dlp often fails to embed the thumbnail. Fetch
// it and embed it through ffmpeg when the file has no picture. Returns true
// when a cover was embedded; never throws (logs instead).
export async function embedThumbnailIfMissing(filePath, { codec, thumbnailUrl, ffmpegPath, log = 'yt-dlp' } = {}) {
  if (!FFMPEG_THUMBNAIL_CODECS.includes(codec) || !thumbnailUrl) { return false; }
  const expectedExt = outputExtension(codec);
  const thumbPath = filePath + '.thumb.jpg';
  const rawThumbPath = thumbPath + '.tmp';
  const tmpEmbed = filePath + '.tmp.' + expectedExt;
  try {
    const checkMeta = await parseFile(filePath, { skipCovers: false });
    if (checkMeta.common.picture && checkMeta.common.picture.length > 0) { return false; }
    const thumbResponse = await fetch(thumbnailUrl);
    if (!thumbResponse.ok) { throw new Error('thumbnail download failed'); }
    await fs.writeFile(rawThumbPath, Buffer.from(await thumbResponse.arrayBuffer()));
    await runFfmpeg(ffmpegPath, ['-y', '-i', rawThumbPath, thumbPath]);
    await fs.access(thumbPath);

    if (codec === 'flac') {
      // FLAC supports attached_pic via ffmpeg directly
      await runFfmpeg(ffmpegPath, ['-i', filePath, '-i', thumbPath, '-map', '0:a', '-map', '1:0',
        '-c', 'copy', '-disposition:v', 'attached_pic', '-y', tmpEmbed]);
    } else {
      // OGG/Opus need METADATA_BLOCK_PICTURE encoded in Vorbis comments:
      // type(4) + mime_len(4) + mime + desc_len(4) + desc + width(4) +
      // height(4) + depth(4) + colors(4) + data_len(4) + data
      const imgData = await fs.readFile(thumbPath);
      const mimeStr = 'image/jpeg';
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
      const b64 = Buffer.concat([header, imgData]).toString('base64');
      // Through a metadata file, so the base64 never hits the command line.
      const metaFilePath = filePath + '.ffmeta';
      await runFfmpeg(ffmpegPath, ['-y', '-i', filePath, '-f', 'ffmetadata', metaFilePath]);
      await fs.appendFile(metaFilePath, `METADATA_BLOCK_PICTURE=${b64}\n`);
      try {
        await runFfmpeg(ffmpegPath, ['-y', '-i', filePath, '-f', 'ffmetadata', '-i', metaFilePath,
          '-map', '0:a', '-map_metadata', '1', '-c:a', 'copy', tmpEmbed]);
      } finally {
        await fs.unlink(metaFilePath).catch(() => {});
      }
    }
    await fs.rename(tmpEmbed, filePath);
    winston.info(`${log}: embedded thumbnail into ${codec} file`);
    return true;
  } catch (thumbErr) {
    winston.warn(`${log}: failed to embed thumbnail into ${codec}`, { stack: thumbErr });
    return false;
  } finally {
    await fs.unlink(thumbPath).catch(() => {});
    await fs.unlink(rawThumbPath).catch(() => {});
    await fs.unlink(tmpEmbed).catch(() => {});
  }
}

// Write title / artist / album / date from `meta` (only the ones given) and
// the MSTREAM_SOURCE provenance marker into the file's tags with ffmpeg.
// Per container ffmpeg emits the marker as an ID3v2 TXXX frame (MP3 / WAV)
// or a Vorbis comment (FLAC / OGG / Opus); the MP4 muxer drops
// non-standard keys, so M4A carries none (the tracks.source column still
// records provenance, and the scanner's mtime fast-path keeps it). Never
// throws — a failed tag pass leaves the file as downloaded.
export async function writeTags(filePath, { codec, meta = {}, source = 'ytdl', ffmpegPath, log = 'yt-dlp' } = {}) {
  const tmpFile = filePath + '.tmp.' + outputExtension(codec);
  try {
    const args = ['-i', filePath, '-c', 'copy'];
    if (meta.title) { args.push('-metadata', `title=${meta.title}`); }
    if (meta.artist) { args.push('-metadata', `artist=${meta.artist}`); }
    if (meta.album) { args.push('-metadata', `album=${meta.album}`); }
    if (meta.year) { args.push('-metadata', `date=${meta.year}`); }
    args.push('-metadata', `MSTREAM_SOURCE=${source}`);
    args.push('-y', tmpFile);
    await runFfmpeg(ffmpegPath, args);
    await fs.rename(tmpFile, filePath);
    winston.info(`${log}: wrote metadata tags + MSTREAM_SOURCE marker to file`);
    return true;
  } catch (tagErr) {
    winston.error(`${log}: failed to write metadata tags`, { stack: tagErr });
    await fs.unlink(tmpFile).catch(() => {});
    return false;
  }
}
