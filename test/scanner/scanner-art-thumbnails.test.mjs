/**
 * Album-art thumbnails under compressImage — both engines.
 *
 * The JS scanner handed music-metadata's Uint8Array picture straight to
 * Jimp, whose PNG decoder needs a Buffer: "data.readUInt32BE is not a
 * function" bubbled out of parseMyFile and the track was never indexed —
 * every file with embedded PNG art, whenever compressImage was on (the
 * default). Any picture Jimp cannot decode failed the same way. Thumbnails
 * are best-effort in both engines: the track and the full-size cache file
 * always land, the zl-/zs- variants when the bytes decode. And an APIC
 * with no bytes at all is not a picture in either engine — lofty used to
 * hand it over and the rust scanner cached a 0-byte cover.
 *
 * Skipped (like scanner-parity.test.mjs) when ffmpeg or the rust binary
 * is unavailable.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  findRustParser, FFMPEG, initEmptyDb, buildScanConfig, runScan, runJsScan,
} from '../helpers/scanner-runner.mjs';
import { makeAudio, makeAudioWithArt } from '../helpers/scanner-fixture.mjs';
import { buildId3v2Tag, id3Frame, id3TextBody, id3ApicBody, replaceId3v2Tag } from '../helpers/id3.mjs';

const MP3 = ['-c:a', 'libmp3lame', '-b:a', '64k', '-id3v2_version', '3'];
// Bytes that claim to be a PNG and aren't.
const NOT_AN_IMAGE = Buffer.from('89504e470d0a1a0a00000000deadbeef', 'hex');
const NOT_AN_IMAGE_MD5 = crypto.createHash('md5').update(NOT_AN_IMAGE).digest('hex');

let rustBin, scratch, libRoot;
const available = () => rustBin && fs.existsSync(FFMPEG);

before(async () => {
  rustBin = findRustParser();
  if (!available()) { return; }
  scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'mstream-thumbs-'));
  libRoot = path.join(scratch, 'lib');
  await makeAudioWithArt(path.join(libRoot, 'Png', '01.mp3'), 'blue',
    { title: 'Png Art', artist: 'Thumbs', album: 'Png' }, { codec: 'png' });
  const bad = path.join(libRoot, 'Bad', '01.mp3');
  await makeAudio(bad, MP3, { title: 'placeholder' });
  await replaceId3v2Tag(bad, buildId3v2Tag([
    id3Frame('TIT2', id3TextBody('Bad Art')),
    id3Frame('TPE1', id3TextBody('Thumbs')),
    id3Frame('TALB', id3TextBody('Bad')),
    id3Frame('APIC', id3ApicBody('image/png', NOT_AN_IMAGE)),
  ]));
  const empty = path.join(libRoot, 'Empty', '01.mp3');
  await makeAudio(empty, MP3, { title: 'placeholder' });
  await replaceId3v2Tag(empty, buildId3v2Tag([
    id3Frame('TIT2', id3TextBody('Empty Art')),
    id3Frame('TPE1', id3TextBody('Thumbs')),
    id3Frame('TALB', id3TextBody('Empty')),
    id3Frame('APIC', id3ApicBody('image/jpeg', Buffer.alloc(0))),
  ]));
});

after(async () => {
  if (scratch) { await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {}); }
});

async function scanWith(engine) {
  const root = path.join(scratch, engine);
  const artDir = path.join(root, 'art');
  await fsp.mkdir(artDir, { recursive: true });
  const dbPath = path.join(root, 'mstream.db');
  const { libraryId, vpath } = initEmptyDb(dbPath, libRoot);
  const cfg = buildScanConfig({
    dbPath, libraryId, vpath, directory: libRoot, albumArtDirectory: artDir,
    waveformCacheDir: path.join(root, 'wave'), scanId: `thumbs-${engine}`,
    overrides: { compressImage: true },
  });
  const result = engine === 'rust' ? await runScan(rustBin, cfg) : await runJsScan(cfg);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const tracks = db.prepare('SELECT filepath, title, album_art_file FROM tracks ORDER BY filepath').all();
  const art = db.prepare('SELECT cache_file FROM art_files ORDER BY cache_file').all().map((r) => r.cache_file);
  const emptyArt = db.prepare('SELECT COUNT(*) AS n FROM art_files WHERE byte_size = 0').get().n;
  db.close();
  return { result, tracks, art, emptyArt, artDir };
}

describe('album-art thumbnails with compressImage on', () => {
  for (const engine of ['rust', 'js']) {
    test(`${engine}: PNG art is thumbnailed, undecodable art is skipped, both tracks land`,
      { skip: !available() && 'ffmpeg or rust-parser unavailable' }, async () => {
        const { result, tracks, art, emptyArt, artDir } = await scanWith(engine);
        assert.deepEqual(tracks.map((t) => t.title), ['Bad Art', 'Empty Art', 'Png Art']);
        // An APIC with no bytes is no picture: no art row, no default, no
        // 0-byte cache file.
        assert.equal(tracks[1].album_art_file, null);
        assert.equal(emptyArt, 0);
        assert.ok(!fs.existsSync(path.join(artDir, 'd41d8cd98f00b204e9800998ecf8427e.jpeg')), 'no empty cache file');
        // Every embedded picture with bytes is cached full-size, decodable or not…
        const png = tracks[2].album_art_file;
        assert.ok(png && png.endsWith('.png'), `png default elected: ${png}`);
        assert.ok(fs.existsSync(path.join(artDir, png)), 'png cached');
        assert.equal(tracks[0].album_art_file, `${NOT_AN_IMAGE_MD5}.png`);
        assert.ok(art.includes(`${NOT_AN_IMAGE_MD5}.png`), `undecodable art cached: ${art}`);
        // …thumbnails only when the bytes decode.
        assert.ok(fs.existsSync(path.join(artDir, `zl-${png}`)), 'large thumbnail');
        assert.ok(fs.existsSync(path.join(artDir, `zs-${png}`)), 'small thumbnail');
        assert.ok(!fs.existsSync(path.join(artDir, `zl-${NOT_AN_IMAGE_MD5}.png`)), 'no thumbnail for bytes that are not an image');
        assert.doesNotMatch(result.stderr, /failed to process/);
        if (engine === 'js') {
          assert.match(result.stderr, /thumbnails skipped for .*: /);
        }
      });
  }
});
