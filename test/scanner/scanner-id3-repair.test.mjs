/**
 * Broken ID3v2 tags — both engines read them the same way.
 *
 * lofty fails the WHOLE file (no tags, not even a duration) on four tag
 * defects music-metadata tolerates, so the same MP3 indexed fully under
 * the JS scanner and as a bare row under the rust one. The rust scanner
 * now normalises the tag before lofty sees it (rust-parser/src/main.rs,
 * "ID3v2 pre-read normaliser"). Each fixture is an ffmpeg MP3 whose tag is
 * swapped for a hand-built one carrying exactly one defect; both engines
 * must index it with the values music-metadata produces:
 *
 *   - ID3v2.4 with the tag-level unsynchronisation flag: a lofty 0.22 bug
 *     (whole-tag de-stuffing, then per frame again) — 96% of the
 *     real-library failures in the 2026-09-05 smoke;
 *   - a UTF-16 text frame with an odd byte count (a stray terminator byte);
 *   - a text frame flagged UTF-8 that holds latin1 bytes;
 *   - a frame whose declared size overruns the tag;
 *   - and the mirror image on the JS side: ID3v2.3 with the tag-level
 *     unsynchronisation flag (the WHOLE tag stuffed), which lofty reads
 *     and music-metadata does not de-stuff — the JS scanner now does it
 *     before handing the file over, so the picture and the frames after
 *     it survive there too.
 *
 * Skipped (like scanner-parity.test.mjs) when ffmpeg or the rust binary
 * is unavailable.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  findRustParser, FFMPEG, initEmptyDb, buildScanConfig, runScan, runJsScan,
} from '../helpers/scanner-runner.mjs';
import crypto from 'node:crypto';
import { makeAudio } from '../helpers/scanner-fixture.mjs';
import {
  buildId3v2Tag, id3Frame, id3TextBody, id3ApicBody, syncsafeBytes, unsyncBytes, replaceId3v2Tag,
} from '../helpers/id3.mjs';

const MP3 = ['-c:a', 'libmp3lame', '-b:a', '64k', '-id3v2_version', '3'];
// A JPEG-shaped picture with FF 00 and FF E0 inside: the bytes whole-tag
// unsynchronisation stuffs, so a reader that skips the de-stuff corrupts it.
const PICTURE = Buffer.from('ffd8ffe000104a46494600ff00ff00e0ffd9', 'hex');
const PICTURE_MD5 = crypto.createHash('md5').update(PICTURE).digest('hex');

// One fixture per defect: [directory, tag, what both engines must store].
function fixtures() {
  // 'ÿ' is FF 00 in UTF-16LE, so every UTF-16 frame here really carries a
  // stuffed byte — the case that misaligns a whole-tag de-stuff.
  const pe1 = id3TextBody('Emancipat\u00ffor', 'utf16');
  return [
    ['Unsync', buildId3v2Tag([
      // unsync + data-length-indicator flags, the way TagLib writes it
      id3Frame('TPE1', Buffer.concat([syncsafeBytes(pe1.length), unsyncBytes(pe1)]), { major: 4, flags: 0x0003 }),
      id3Frame('TIT2', id3TextBody('Greenland'), { major: 4 }),
      id3Frame('TALB', unsyncBytes(id3TextBody('Safe \u00ff', 'utf16')), { major: 4, flags: 0x0002 }),
    ], { major: 4, flags: 0x80 }), { title: 'Greenland', artist: 'Emancipat\u00ffor', album: 'Safe \u00ff' }],
    ['Odd', buildId3v2Tag([
      id3Frame('TIT2', Buffer.concat([id3TextBody('Odd', 'utf16'), Buffer.from([0x00])])),
      id3Frame('TPE1', id3TextBody('Odd Artist')),
      id3Frame('TALB', id3TextBody('Odd Album')),
    ]), { title: 'Odd\uFFFD', artist: 'Odd Artist', album: 'Odd Album' }],
    ['Utf8', buildId3v2Tag([
      id3Frame('TIT2', id3TextBody('Lied')),
      id3Frame('TPE1', Buffer.concat([Buffer.from([0x03]), Buffer.from('Bj\u00f6rk', 'latin1')])),
      id3Frame('TALB', id3TextBody('Lied Album')),
    ]), { title: 'Lied', artist: 'Bj\uFFFDrk', album: 'Lied Album' }],
    ['Trunc', buildId3v2Tag([
      id3Frame('TIT2', id3TextBody('Cut')),
      id3Frame('TPE1', id3TextBody('Cut Artist')),
      id3Frame('TALB', id3TextBody('Truncated Al'), { declared: 40 }),
    ], { padding: 0 }), { title: 'Cut', artist: 'Cut Artist', album: 'Truncated Al' }],
    // v2.3, tag-level flag: the frames are laid out, then the whole body is
    // stuffed; the picture comes first so the text frames sit past the
    // stuffed bytes.
    ['Whole', buildId3v2Tag([unsyncBytes(Buffer.concat([
      id3Frame('APIC', id3ApicBody('image/jpeg', PICTURE)),
      id3Frame('TIT2', id3TextBody('Whole Tag')),
      id3Frame('TPE1', id3TextBody('Whole Artist')),
      id3Frame('TALB', id3TextBody('Whole Album')),
    ]))], { flags: 0x80 }), { title: 'Whole Tag', artist: 'Whole Artist', album: 'Whole Album', art: `${PICTURE_MD5}.jpeg` }],
  ];
}

let rustBin, scratch, libRoot, expected;
const available = () => rustBin && fs.existsSync(FFMPEG);

before(async () => {
  rustBin = findRustParser();
  if (!available()) { return; }
  scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'mstream-id3repair-'));
  libRoot = path.join(scratch, 'lib');
  expected = { 'Clean/01.mp3': { title: 'Clean', artist: 'Clean Artist', album: 'Clean Album' } };
  await makeAudio(path.join(libRoot, 'Clean', '01.mp3'), MP3,
    { title: 'Clean', artist: 'Clean Artist', album: 'Clean Album' });
  for (const [dir, tag, want] of fixtures()) {
    const file = path.join(libRoot, dir, '01.mp3');
    await makeAudio(file, MP3, { title: 'placeholder' });
    await replaceId3v2Tag(file, tag);
    expected[`${dir}/01.mp3`] = want;
  }
});

after(async () => {
  if (scratch) { await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {}); }
});

async function scanWith(engine) {
  const root = path.join(scratch, engine);
  await fsp.mkdir(path.join(root, 'art'), { recursive: true });
  const dbPath = path.join(root, 'mstream.db');
  const { libraryId, vpath } = initEmptyDb(dbPath, libRoot);
  const cfg = buildScanConfig({
    dbPath, libraryId, vpath, directory: libRoot, albumArtDirectory: path.join(root, 'art'),
    waveformCacheDir: path.join(root, 'wave'), scanId: `id3repair-${engine}`,
  });
  const result = engine === 'rust' ? await runScan(rustBin, cfg) : await runJsScan(cfg);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare(`
    SELECT t.filepath, t.title, t.duration, t.album_art_file AS art, ar.name AS artist, al.name AS album
      FROM tracks t
      LEFT JOIN artists ar ON ar.id = t.artist_id
      LEFT JOIN albums al ON al.id = t.album_id
     ORDER BY t.filepath`).all();
  db.close();
  return { result, rows: Object.fromEntries(rows.map((r) => [r.filepath.replace(/\\/g, '/'), r])) };
}

describe('broken ID3v2 tags', () => {
  const got = {};
  for (const engine of ['rust', 'js']) {
    test(`${engine}: every fixture is indexed with the values music-metadata reads`,
      { skip: !available() && 'ffmpeg or rust-parser unavailable' }, async () => {
        const { result, rows } = await scanWith(engine);
        got[engine] = rows;
        assert.deepEqual(Object.keys(rows).sort(), Object.keys(expected).sort());
        for (const [file, want] of Object.entries(expected)) {
          const row = rows[file];
          assert.deepEqual({ title: row.title, artist: row.artist, album: row.album, art: row.art ?? undefined },
            { art: undefined, ...want }, file);
          assert.ok(row.duration > 0.5 && row.duration < 2, `${file}: duration ${row.duration}`);
        }
        assert.doesNotMatch(result.stderr, /metadata parse error/);
        if (engine === 'rust') {
          // Rule 1 is lofty's bug, not the file's: only real defects are reported.
          assert.doesNotMatch(result.stderr, /repaired the ID3v2 tag of .*Unsync/);
          for (const dir of ['Odd', 'Utf8', 'Trunc']) {
            assert.match(result.stderr, new RegExp(`repaired the ID3v2 tag of .*${dir}`));
          }
        }
      });
  }

  test('both engines wrote the same rows', { skip: !available() && 'ffmpeg or rust-parser unavailable' }, () => {
    assert.ok(got.rust && got.js, 'both scans ran');
    for (const file of Object.keys(expected)) {
      const [r, j] = [got.rust[file], got.js[file]];
      assert.deepEqual(
        { title: r.title, artist: r.artist, album: r.album, art: r.art, duration: Math.round(r.duration) },
        { title: j.title, artist: j.artist, album: j.album, art: j.art, duration: Math.round(j.duration) },
        file);
    }
  });
});
