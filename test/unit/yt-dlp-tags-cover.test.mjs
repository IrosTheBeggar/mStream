/**
 * Unit tests for writeTagsAndCover in src/util/yt-dlp.js — the tags and the
 * cover of a YouTube download, in the order that keeps both.
 *
 * Origin: an Opus download from the app's Add from YouTube came in with no
 * album art. The cover WAS embedded (a METADATA_BLOCK_PICTURE comment), but
 * the tag pass ran after it, and ffmpeg reads an Ogg cover back as a picture
 * stream that a stream copy into Ogg leaves out, so the file the library
 * scanned had no picture and the track no aaFile.
 *
 * Pinned here with the bundled ffmpeg and music-metadata (what
 * insertDownloadedTrack reads): for Opus, OGG and FLAC the file ends with the
 * given tags, the MSTREAM_SOURCE marker AND the cover; for MP3 and M4A
 * (covers yt-dlp embeds itself) the tag pass keeps the cover that is there.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFile } from 'music-metadata';

import { writeTagsAndCover } from '../../src/util/yt-dlp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const EXE = process.platform === 'win32' ? '.exe' : '';
const FFMPEG = path.join(REPO_ROOT, 'bin', 'ffmpeg', `ffmpeg${EXE}`);

let tmpDir;
let coverPath;
let server;
let thumbnailUrl;

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err}`))));
  });
}

// Three seconds of tone in [codec]'s container; [withCover] embeds the cover
// the way yt-dlp does for MP3 / M4A.
async function makeAudio(name, codecArgs, { withCover = false } = {}) {
  const file = path.join(tmpDir, name);
  const input = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3'];
  if (withCover) {
    await ffmpeg([...input, '-i', coverPath, '-map', '0:a', '-map', '1:0', ...codecArgs,
      '-c:v', 'copy', '-disposition:v', 'attached_pic', file]);
  } else {
    await ffmpeg([...input, ...codecArgs, file]);
  }
  return file;
}

async function read(file) {
  const m = await parseFile(file);
  const source = Object.values(m.native).flat().find((t) => /^(MSTREAM_SOURCE|TXXX:MSTREAM_SOURCE)$/i.test(t.id));
  return {
    title: m.common.title,
    artist: m.common.artist,
    pictures: (m.common.picture || []).length,
    source: source ? source.value : null,
  };
}

before(async () => {
  assert.ok(fs.existsSync(FFMPEG), `ffmpeg missing at ${FFMPEG} — copy it from the main checkout`);
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mstream-ytdl-cover-'));
  coverPath = path.join(tmpDir, 'cover.jpg');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', coverPath]);
  const jpeg = await fsp.readFile(coverPath);
  // The thumbnail URL the lookup would hand over, served locally.
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.end(jpeg);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  thumbnailUrl = `http://127.0.0.1:${server.address().port}/hqdefault.jpg`;
});

after(async () => {
  if (server) { await new Promise((resolve) => server.close(resolve)); }
  if (tmpDir) { await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); }
});

const meta = { title: 'One More Time', artist: 'Daft Punk' };

describe('writeTagsAndCover: the cover yt-dlp could not embed', () => {
  for (const [codec, name, codecArgs] of [
    ['opus', 'song.opus', ['-c:a', 'libopus']],
    ['ogg', 'song.ogg', ['-c:a', 'libvorbis']],
    ['flac', 'song.flac', ['-c:a', 'flac']],
  ]) {
    test(`${codec}: the tags, the marker and the cover all stay`, async () => {
      const file = await makeAudio(name, codecArgs);
      await writeTagsAndCover(file, { codec, meta, source: 'ytdl', thumbnailUrl, ffmpegPath: FFMPEG });
      const r = await read(file);
      assert.equal(r.title, meta.title);
      assert.equal(r.artist, meta.artist);
      assert.equal(r.source, 'ytdl');
      assert.equal(r.pictures, 1, 'the cover survives the tag pass');
    });
  }

  test('no thumbnail: the tags alone, nothing fetched', async () => {
    const file = await makeAudio('bare.opus', ['-c:a', 'libopus']);
    await writeTagsAndCover(file, { codec: 'opus', meta, source: 'ytdl', thumbnailUrl: null, ffmpegPath: FFMPEG });
    const r = await read(file);
    assert.equal(r.title, meta.title);
    assert.equal(r.pictures, 0);
  });
});

describe('writeTagsAndCover: covers yt-dlp embedded itself', () => {
  for (const [codec, name, codecArgs] of [
    ['mp3', 'song.mp3', ['-c:a', 'libmp3lame', '-id3v2_version', '3']],
    ['aac', 'song.m4a', ['-c:a', 'aac']],
  ]) {
    test(`${codec}: the tag pass keeps the cover that is there`, async () => {
      const file = await makeAudio(name, codecArgs, { withCover: true });
      await writeTagsAndCover(file, { codec, meta, source: 'ytdl', thumbnailUrl, ffmpegPath: FFMPEG });
      const r = await read(file);
      assert.equal(r.title, meta.title);
      assert.equal(r.pictures, 1);
    });
  }
});
