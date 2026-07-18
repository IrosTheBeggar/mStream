/**
 * Folder-art drift — both engines.
 *
 * Art capture normally runs only while a track is (re)parsed, and
 * unchanged tracks ride the mtime fast-path — so a NEW cover.jpg
 * dropped beside unchanged audio was never picked up by ordinary scans
 * (only a force-rescan linked it; the watcher made that gap
 * user-visible). The drift pass reconciles exactly those directories:
 *
 *   - a new image beside fully fast-pathed tracks links on the next
 *     scan with filesProcessed staying 0 (the chip's core assertion):
 *     art_files row + track_art/album_art junctions, and — when the
 *     tracks had NO default at all — the parse-parity promotion to a
 *     CACHED default (defaults are always cache files) with
 *     album_art_file/source filled under the same NULL-only guards;
 *   - tracks that already have an embedded default keep it: the new
 *     image joins the set as a plain 'reference' row, defaults
 *     untouched;
 *   - the pass is idempotent (a third scan links nothing new);
 *   - skipImg suppresses it, exactly like parse-time capture.
 *
 * Skipped (like scanner-parity.test.mjs) when ffmpeg or the rust
 * binary is unavailable; a prebuilt binary predating the drift pass is
 * feature-detected and skipped for the rust engine.
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

const MP3 = ['-c:a', 'libmp3lame', '-b:a', '64k', '-id3v2_version', '3'];
// Minimal JPEG (SOI + APP0 + EOI): the scanners content-address and copy
// bytes, they never decode (compressImage is off in the test config).
const TINY_JPG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const TINY_JPG_MD5 = crypto.createHash('md5').update(TINY_JPG).digest('hex');
// A second, distinct image for the reference-only scenario.
const TINY_JPG2 = Buffer.concat([TINY_JPG.subarray(0, 4), Buffer.from([0x01]), TINY_JPG.subarray(4)]);

let rustBin;
let scratch;
// null = probe not run; false = binary predates the drift pass.
let rustHasDrift = null;

before(async () => {
  rustBin = findRustParser();
  scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'mstream-artdrift-'));

  // Feature-detect a stale prebuilt binary: scan, drop an image, rescan —
  // a pre-drift build reports no folderArtLinked field (or links nothing).
  if (rustBin && fs.existsSync(FFMPEG)) {
    const root = path.join(scratch, 'probe');
    const libRoot = path.join(root, 'lib');
    await makeAudio(path.join(libRoot, 'A', 'p.mp3'), MP3, { title: 'P' }, 1);
    const dbPath = path.join(root, 'probe.db');
    const { libraryId, vpath } = initEmptyDb(dbPath, libRoot);
    const cfg = (scanId) => buildScanConfig({
      dbPath, libraryId, vpath, directory: libRoot,
      albumArtDirectory: path.join(root, 'art'),
      waveformCacheDir: path.join(root, 'wave'), scanId,
    });
    await fsp.mkdir(path.join(root, 'art'), { recursive: true });
    await runScan(rustBin, cfg('probe-1'));
    await fsp.writeFile(path.join(libRoot, 'A', 'cover.jpg'), TINY_JPG);
    const { event } = await runScan(rustBin, cfg('probe-2'));
    rustHasDrift = event.folderArtLinked === 1;
  }
});

after(async () => {
  if (scratch) { await fsp.rm(scratch, { recursive: true, force: true }); }
});

let sandboxSeq = 0;
async function makeSandbox(engine) {
  const root = path.join(scratch, `sb${sandboxSeq++}-${engine}`);
  const libRoot = path.join(root, 'lib');
  const artDir = path.join(root, 'art');
  await fsp.mkdir(libRoot, { recursive: true });
  await fsp.mkdir(artDir, { recursive: true });
  const dbPath = path.join(root, 'test.db');
  const { libraryId, vpath } = initEmptyDb(dbPath, libRoot);
  let scanSeq = 0;
  const scan = (overrides = {}) => {
    const config = buildScanConfig({
      dbPath, libraryId, vpath, directory: libRoot,
      albumArtDirectory: artDir, waveformCacheDir: path.join(root, 'wave'),
      scanId: `scan-${scanSeq++}`, overrides,
    });
    return engine === 'js' ? runJsScan(config) : runScan(rustBin, config);
  };
  return { root, libRoot, artDir, dbPath, libraryId, scan };
}

function withDb(dbPath, fn) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}
const trackArtState = (dbPath) => withDb(dbPath, db =>
  db.prepare('SELECT filepath, album_art_file, album_art_source FROM tracks ORDER BY filepath')
    .all().map(r => ({ ...r })));
const artRows = (dbPath) => withDb(dbPath, db =>
  db.prepare('SELECT kind, cache_file, rel_path FROM art_files ORDER BY id').all().map(r => ({ ...r })));
const junctionCounts = (dbPath) => withDb(dbPath, db => ({
  trackArt: db.prepare("SELECT COUNT(*) AS n FROM track_art WHERE source = 'folder'").get().n,
  albumArt: db.prepare("SELECT COUNT(*) AS n FROM album_art WHERE source = 'folder'").get().n,
}));

for (const engine of ['rust', 'js']) {
  const engineAvailable = () =>
    fs.existsSync(FFMPEG) && (engine === 'js' || (!!rustBin && rustHasDrift !== false));

  describe(`folder-art drift (${engine} scanner)`, () => {
    test('new cover beside fast-pathed tracks links with filesProcessed 0, promotes the NULL default', async (t) => {
      if (!engineAvailable()) { t.skip('ffmpeg/rust binary unavailable or stale'); return; }
      const sb = await makeSandbox(engine);
      await makeAudio(path.join(sb.libRoot, 'Artist', 'Album', 'one.mp3'), MP3,
        { artist: 'Artist', album: 'Album', title: 'One' }, 1);
      await makeAudio(path.join(sb.libRoot, 'Artist', 'Album', 'two.mp3'), MP3,
        { artist: 'Artist', album: 'Album', title: 'Two' }, 2);
      await sb.scan();
      assert.ok(trackArtState(sb.dbPath).every(r => r.album_art_file === null),
        'baseline: no art anywhere');

      await fsp.writeFile(path.join(sb.libRoot, 'Artist', 'Album', 'cover.jpg'), TINY_JPG);
      const { event } = await sb.scan();

      assert.strictEqual(event.filesProcessed, 0, 'no audio was re-parsed');
      assert.strictEqual(event.folderArtLinked, 1);
      const expectCache = `${TINY_JPG_MD5}.jpg`;
      assert.deepStrictEqual(trackArtState(sb.dbPath), [
        { filepath: 'Artist/Album/one.mp3', album_art_file: expectCache, album_art_source: 'folder' },
        { filepath: 'Artist/Album/two.mp3', album_art_file: expectCache, album_art_source: 'folder' },
      ], 'both fast-pathed tracks gained the promoted default');
      assert.deepStrictEqual(artRows(sb.dbPath),
        [{ kind: 'cached', cache_file: expectCache, rel_path: null }],
        'the promoted default is a CACHED art row (parse parity)');
      assert.deepStrictEqual(junctionCounts(sb.dbPath), { trackArt: 2, albumArt: 1 });
      assert.ok(fs.existsSync(path.join(sb.artDir, expectCache)),
        'the cache copy exists on disk');
      const album = withDb(sb.dbPath, db =>
        db.prepare('SELECT album_art_file, album_art_source FROM albums').get());
      assert.deepStrictEqual({ ...album },
        { album_art_file: expectCache, album_art_source: 'folder' },
        'the album default filled under the NULL-only guard');

      // Idempotency: a third scan links nothing and changes nothing.
      const { event: idle } = await sb.scan();
      assert.strictEqual(idle.folderArtLinked, 0);
      assert.strictEqual(idle.filesProcessed, 0);
      assert.deepStrictEqual(junctionCounts(sb.dbPath), { trackArt: 2, albumArt: 1 });
    });

    test('tracks with an embedded default keep it; the new image joins as a reference', async (t) => {
      if (!engineAvailable()) { t.skip('ffmpeg/rust binary unavailable or stale'); return; }
      const sb = await makeSandbox(engine);
      await makeAudioWithArt(path.join(sb.libRoot, 'Band', 'Disc', 'song.mp3'), 'red',
        { artist: 'Band', album: 'Disc', title: 'Song' });
      await sb.scan();
      const before = trackArtState(sb.dbPath);
      assert.strictEqual(before[0].album_art_source, 'embedded', 'baseline: embedded default');

      await fsp.writeFile(path.join(sb.libRoot, 'Band', 'Disc', 'extra.jpg'), TINY_JPG2);
      const { event } = await sb.scan();

      assert.strictEqual(event.filesProcessed, 0);
      assert.strictEqual(event.folderArtLinked, 1);
      assert.deepStrictEqual(trackArtState(sb.dbPath), before,
        'the embedded default is untouched');
      const refs = artRows(sb.dbPath).filter(r => r.kind === 'reference');
      assert.deepStrictEqual(refs.map(r => r.rel_path), ['Band/Disc/extra.jpg'],
        'the new image joined the set as a plain reference');
    });

    test('skipImg suppresses the drift pass; the next normal scan heals', async (t) => {
      if (!engineAvailable()) { t.skip('ffmpeg/rust binary unavailable or stale'); return; }
      const sb = await makeSandbox(engine);
      await makeAudio(path.join(sb.libRoot, 'Q', 'q.mp3'), MP3, { title: 'Q' }, 3);
      await sb.scan();

      await fsp.writeFile(path.join(sb.libRoot, 'Q', 'cover.jpg'), TINY_JPG);
      const { event: skipped } = await sb.scan({ skipImg: true });
      assert.strictEqual(skipped.folderArtLinked, 0);
      assert.ok(trackArtState(sb.dbPath).every(r => r.album_art_file === null),
        'skipImg linked nothing');

      const { event: healed } = await sb.scan();
      assert.strictEqual(healed.folderArtLinked, 1);
      assert.ok(trackArtState(sb.dbPath).every(r => r.album_art_file !== null),
        'the next normal scan linked it');
    });
  });
}
