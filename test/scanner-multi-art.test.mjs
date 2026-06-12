/**
 * V48/V49 multi-art scanner tests.
 *
 * Both scanners now capture the FULL per-track image set: every embedded
 * picture is cached (content-addressed into the album-art dir) and every
 * folder jpg/png is referenced in place, with one image elected the
 * denormalized default per albumArtPriority. This file covers:
 *
 *   - rust e2e: art_files / track_art / album_art rows for a fixture with
 *     MULTIPLE embedded pictures, six folder images (priority-named,
 *     case-straddling, and plain), an art-less track, and a library-root
 *     track.
 *   - rust ↔ JS parity: both scanners over the same fixture produce
 *     identical art snapshots — including the case-straddling sort
 *     (Zebra.jpg vs apple.jpg), the front.png priority entry, and an
 *     artist-typed APIC picture (hand-built ID3v2.3, type 0x08).
 *   - albumArtPriority='folder' flips the elected default.
 *   - album_art_pinned survives a force-rescan (the UPSERT pin guard).
 *   - skipImg re-parse PRESERVES the existing default instead of nulling
 *     it (the V49 forced rescan must not wipe skipImg users' art).
 *   - a deleted folder image drops its links AND its art_files row on the
 *     next scan (clear-then-relink + verify-absence reaping) — on BOTH
 *     scanners — while unlinked-but-on-disk art is KEPT (disk is truth).
 *   - a REPLACED embedded cover's old album_art link is reconciled away
 *     even though its cache file rightly stays on disk.
 *   - V49 is rescanRequired (the upgrade backfill trigger).
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
} from './helpers/scanner-runner.mjs';
import { ffmpeg, makeAudio, makeAudioWithArt } from './helpers/scanner-fixture.mjs';
import { MIGRATIONS } from '../src/db/schema.js';

const MP3 = ['-c:a', 'libmp3lame', '-b:a', '64k', '-id3v2_version', '3'];

let rustBin;
let scratch;
let libRoot;
let fixtureReady = false;

function available() { return !!rustBin && fs.existsSync(FFMPEG) && fixtureReady; }

// Solid-color square via lavfi — distinct colors → distinct bytes/hashes.
function makeImage(dest, color) {
  return ffmpeg([
    '-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=color=${color}:size=64x64:duration=0.1`,
    '-frames:v', '1', dest,
  ]);
}

// Hand-built ID3v2.3 tag with text frames + an APIC of a CHOSEN picture
// type — ffmpeg can't set APIC types, and the artist-type mapping (APIC
// 0x08 → 'artist') is exactly the kind of parity detail that needs a real
// fixture: lofty reads the type enum, music-metadata reads the label
// string, and the two scanners normalise through different code.
function id3TextFrame(id, text) {
  const body = Buffer.concat([Buffer.from([0x00]), Buffer.from(text, 'latin1')]);
  const head = Buffer.alloc(10);
  head.write(id, 0, 'latin1');
  head.writeUInt32BE(body.length, 4); // v2.3 frame sizes are plain BE
  return Buffer.concat([head, body]);
}
function id3ApicFrame(picType, jpgBytes) {
  const body = Buffer.concat([
    Buffer.from([0x00]),                    // text encoding: latin1
    Buffer.from('image/jpeg\0', 'latin1'),  // MIME
    Buffer.from([picType]),                 // picture type
    Buffer.from('\0', 'latin1'),            // empty description
    jpgBytes,
  ]);
  const head = Buffer.alloc(10);
  head.write('APIC', 0, 'latin1');
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}
async function makeMp3WithTypedApic(filepath, picType, jpgBytes, meta) {
  await fsp.mkdir(path.dirname(filepath), { recursive: true });
  // Bare tone with NO ffmpeg-written metadata (bitexact suppresses the
  // TSSE encoder frame, so no ID3v2 header is emitted) — our hand-built
  // tag is then the file's only ID3v2 tag.
  const bare = filepath + '.bare.mp3';
  await ffmpeg([
    '-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:duration=1',
    '-c:a', 'libmp3lame', '-b:a', '64k',
    '-map_metadata', '-1', '-fflags', '+bitexact',
    bare,
  ]);
  const frames = Buffer.concat([
    id3TextFrame('TIT2', meta.title),
    id3TextFrame('TPE1', meta.artist),
    id3TextFrame('TALB', meta.album),
    id3ApicFrame(picType, jpgBytes),
  ]);
  const header = Buffer.alloc(10);
  header.write('ID3', 0, 'latin1');
  header[3] = 0x03; // v2.3.0
  const size = frames.length;
  header[6] = (size >> 21) & 0x7f;
  header[7] = (size >> 14) & 0x7f;
  header[8] = (size >> 7) & 0x7f;
  header[9] = size & 0x7f;
  const audio = await fsp.readFile(bare);
  await fsp.writeFile(filepath, Buffer.concat([header, frames, audio]));
  await fsp.unlink(bare);
}

// Fixture:
//   Art Band/Gallery/01.mp3      — TWO embedded pictures (red, magenta)
//   Art Band/Gallery/02.mp3      — no embedded art
//   Art Band/Gallery/folder.jpg  — white  (priority rank 0)
//   Art Band/Gallery/front.png   — gray   (priority rank 7, type 'front')
//   Art Band/Gallery/Zebra.jpg   — yellow (case-straddling name)
//   Art Band/Gallery/apple.jpg   — cyan
//   Art Band/Gallery/back.jpg    — blue   (type 'back')
//   Art Band/Gallery/bonus-photo.jpg — green
//   Art Band/Plain/03.mp3        — no art anywhere
//   root.mp3                     — at the library ROOT (relDir '.')
//   Art Band/Typed/04.mp3        — hand-built APIC type 0x08 ('artist')
async function buildArtFixture(rootDir) {
  const gallery = path.join(rootDir, 'Art Band', 'Gallery');
  const plain = path.join(rootDir, 'Art Band', 'Plain');
  await makeAudioWithArt(path.join(gallery, '01.mp3'), ['red', 'magenta'],
    { title: 'With Art', artist: 'Art Band', album: 'Gallery', track: '1/2' });
  await makeAudio(path.join(gallery, '02.mp3'), MP3,
    { title: 'No Art', artist: 'Art Band', album: 'Gallery', track: '2/2' });
  await makeImage(path.join(gallery, 'folder.jpg'), 'white');
  await makeImage(path.join(gallery, 'front.png'), 'gray');
  await makeImage(path.join(gallery, 'Zebra.jpg'), 'yellow');
  await makeImage(path.join(gallery, 'apple.jpg'), 'cyan');
  await makeImage(path.join(gallery, 'back.jpg'), 'blue');
  await makeImage(path.join(gallery, 'bonus-photo.jpg'), 'green');
  await makeAudio(path.join(plain, '03.mp3'), MP3,
    { title: 'Plain', artist: 'Art Band', album: 'Plain' });
  await makeAudio(path.join(rootDir, 'root.mp3'), MP3,
    { title: 'Root', artist: 'Art Band', album: 'Rooted' });
  const typedJpg = path.join(rootDir, '..', `typed-apic-${path.basename(rootDir)}.jpg`);
  await makeImage(typedJpg, 'purple');
  await makeMp3WithTypedApic(path.join(rootDir, 'Art Band', 'Typed', '04.mp3'),
    0x08, await fsp.readFile(typedJpg),
    { title: 'Typed Pic', artist: 'Art Band', album: 'Typed' });
}

// Non-priority folder images sort by lowercased name (codepoint order),
// so the full reference order within Gallery is fixed:
const GALLERY_REFS = [
  'Art Band/Gallery/folder.jpg',      // priority rank 0 (elected for t2)
  'Art Band/Gallery/front.png',       // priority rank 7
  'Art Band/Gallery/apple.jpg',
  'Art Band/Gallery/back.jpg',
  'Art Band/Gallery/bonus-photo.jpg',
  'Art Band/Gallery/Zebra.jpg',
];

// Fresh DB + art dir + one scan; returns handles for assertions.
async function scanFresh(runner, { root = libRoot, overrides = {} } = {}) {
  const dir = await fsp.mkdtemp(path.join(scratch, 'run-'));
  const dbPath = path.join(dir, 'mstream.db');
  const artDir = path.join(dir, 'image-cache');
  await fsp.mkdir(artDir, { recursive: true });
  const { libraryId, vpath } = initEmptyDb(dbPath, root);
  const config = buildScanConfig({
    dbPath, libraryId, vpath, directory: root,
    albumArtDirectory: artDir, waveformCacheDir: '', scanId: 'art-test-1',
    overrides,
  });
  await runner(config);
  return { dbPath, artDir, config, libraryId };
}

function trackArtRows(db, title) {
  return db.prepare(`
    SELECT af.kind, af.cache_file, af.rel_path, ta.source, ta.picture_type, ta.position
      FROM track_art ta
      JOIN tracks t ON t.id = ta.track_id
      JOIN art_files af ON af.id = ta.art_id
     WHERE t.title = ?
     ORDER BY ta.position
  `).all(title).map(r => ({ ...r }));
}

function artSnapshot(db) {
  const all = (sql) => db.prepare(sql).all().map(r => ({ ...r }));
  return {
    artFiles: all(`SELECT kind, cache_file, rel_path FROM art_files
                   ORDER BY kind, cache_file, rel_path`),
    trackArt: all(`SELECT t.filepath, af.kind, af.cache_file, af.rel_path,
                          ta.source, ta.picture_type, ta.position
                     FROM track_art ta
                     JOIN tracks t ON t.id = ta.track_id
                     JOIN art_files af ON af.id = ta.art_id
                    ORDER BY t.filepath, ta.position`),
    albumArt: all(`SELECT al.name, af.kind, af.cache_file, af.rel_path
                     FROM album_art aa
                     JOIN albums al ON al.id = aa.album_id
                     JOIN art_files af ON af.id = aa.art_id
                    ORDER BY al.name, af.kind, af.cache_file, af.rel_path`),
    trackDefaults: all(`SELECT title, album_art_file, album_art_source, album_art_pinned
                          FROM tracks ORDER BY title`),
  };
}

before(async () => {
  rustBin = findRustParser();
  if (!rustBin || !fs.existsSync(FFMPEG)) { return; }
  scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'mstream-multiart-'));
  libRoot = path.join(scratch, 'library');
  await buildArtFixture(libRoot);
  fixtureReady = true;
});

after(async () => {
  if (scratch) { await fsp.rm(scratch, { recursive: true, force: true }); }
});

describe('multi-art capture (rust e2e)', () => {
  test('full image set: every embedded pic cached, folder images referenced, default elected', { timeout: 120_000 }, async (t) => {
    if (!available()) { return t.skip('ffmpeg or rust-parser unavailable'); }
    const { dbPath } = await scanFresh(c => runScan(rustBin, c));
    const db = new DatabaseSync(dbPath);
    try {
      // Defaults: embedded wins for t1 (priority=metadata), the folder
      // cover wins for art-less t2, nothing for Plain/Root, the typed
      // APIC for the Typed track.
      const byTitle = Object.fromEntries(db.prepare(
        'SELECT title, album_art_file, album_art_source FROM tracks').all()
        .map(r => [r.title, { ...r }]));
      assert.ok(byTitle['With Art'].album_art_file, 'embedded default cached');
      assert.equal(byTitle['With Art'].album_art_source, 'embedded');
      assert.ok(byTitle['No Art'].album_art_file, 'folder default cached');
      assert.equal(byTitle['No Art'].album_art_source, 'folder');
      assert.equal(byTitle['Plain'].album_art_file, null);
      assert.equal(byTitle['Root'].album_art_file, null);
      assert.equal(byTitle['Typed Pic'].album_art_source, 'embedded');

      // art_files: 4 cached (two embedded pics + the folder.jpg default
      // copy + the typed APIC) + 6 references (every Gallery folder image).
      const kinds = db.prepare(
        'SELECT kind, COUNT(*) AS n FROM art_files GROUP BY kind ORDER BY kind').all().map(r => ({ ...r }));
      assert.deepEqual(kinds, [
        { kind: 'cached', n: 4 },
        { kind: 'reference', n: 6 },
      ]);
      const refs = db.prepare(
        "SELECT rel_path FROM art_files WHERE kind = 'reference' ORDER BY rel_path").all().map(r => r.rel_path);
      assert.deepEqual(refs, [...GALLERY_REFS].sort());

      // t1's set: BOTH embedded pictures cached in tag order, then the
      // folder images in priority-then-lowercase order — the
      // case-straddling pair must land apple < ... < Zebra, NOT byte
      // order (Zebra first) or locale whim.
      const t1 = trackArtRows(db, 'With Art');
      assert.deepEqual(
        t1.map(r => ({ kind: r.kind, ref: r.rel_path, source: r.source, position: r.position })),
        [
          { kind: 'cached', ref: null, source: 'embedded', position: 0 },
          { kind: 'cached', ref: null, source: 'embedded', position: 1 },
          ...GALLERY_REFS.map((ref, i) => ({ kind: 'reference', ref, source: 'folder', position: 2 + i })),
        ]);
      // The two embedded cache files are distinct images.
      assert.notEqual(t1[0].cache_file, t1[1].cache_file);

      // t2's set: the elected folder.jpg default is a CACHED copy; the
      // other five folder images stay references.
      const t2 = trackArtRows(db, 'No Art');
      assert.deepEqual(
        t2.map(r => ({ kind: r.kind, ref: r.rel_path, source: r.source, position: r.position })),
        [
          { kind: 'cached', ref: null, source: 'folder', position: 0 },
          ...GALLERY_REFS.slice(1).map((ref, i) => ({ kind: 'reference', ref, source: 'folder', position: 1 + i })),
        ]);
      assert.equal(trackArtRows(db, 'Plain').length, 0);
      assert.equal(trackArtRows(db, 'Root').length, 0);

      // Picture types: folder-name mapping + the hand-built artist APIC.
      const typeOf = (rel) => db.prepare(`
        SELECT ta.picture_type FROM track_art ta
          JOIN art_files af ON af.id = ta.art_id
         WHERE af.rel_path = ? LIMIT 1`).get(rel).picture_type;
      assert.equal(typeOf('Art Band/Gallery/back.jpg'), 'back');
      assert.equal(typeOf('Art Band/Gallery/front.png'), 'front');
      assert.equal(typeOf('Art Band/Gallery/Zebra.jpg'), null);
      assert.equal(db.prepare(`
        SELECT ta.picture_type FROM track_art ta
          JOIN tracks t ON t.id = ta.track_id WHERE t.title = 'Typed Pic'`).get().picture_type,
      'artist', 'APIC type 0x08 must normalise to artist');

      // Album set: union of its tracks' images — 2 emb + 1 cached folder
      // copy + 6 references.
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS n FROM album_art aa
          JOIN albums al ON al.id = aa.album_id WHERE al.name = 'Gallery'
      `).get().n, 9);

      // V50: every art row carries its content hash. Cached rows' hash IS
      // the filename stem (the cache is content-addressed by the same MD5);
      // reference rows' hash matches the actual file bytes.
      assert.equal(db.prepare(
        'SELECT COUNT(*) AS n FROM art_files WHERE content_hash IS NULL').get().n, 0,
      'every art row must be hashed');
      const badStem = db.prepare(`
        SELECT COUNT(*) AS n FROM art_files
         WHERE kind = 'cached'
           AND content_hash != substr(cache_file, 1, instr(cache_file, '.') - 1)`).get().n;
      assert.equal(badStem, 0, 'cached hash == cache filename stem');
      const folderJpg = db.prepare(
        "SELECT content_hash, byte_size FROM art_files WHERE rel_path = 'Art Band/Gallery/folder.jpg'").get();
      const bytes = fs.readFileSync(path.join(libRoot, 'Art Band', 'Gallery', 'folder.jpg'));
      const expected = (await import('node:crypto')).createHash('md5').update(bytes).digest('hex');
      assert.equal(folderJpg.content_hash, expected, 'reference hash == md5 of the file on disk');
      assert.equal(folderJpg.byte_size, bytes.length);
      // The duplicate-identity pair (folder.jpg as t2's cached default AND
      // as a reference in t1's set) is now joinable by hash — the gallery
      // dedupe contract.
      assert.equal(db.prepare(
        'SELECT COUNT(*) AS n FROM art_files WHERE content_hash = ?').get(expected).n, 2);
    } finally { db.close(); }
  });

  test('pre-V50 NULL reference hashes heal on the next force-rescan', { timeout: 120_000 }, async (t) => {
    if (!available()) { return t.skip('ffmpeg or rust-parser unavailable'); }
    const { dbPath, config } = await scanFresh(c => runScan(rustBin, c));
    let db = new DatabaseSync(dbPath);
    db.prepare("UPDATE art_files SET content_hash = NULL, byte_size = NULL WHERE kind = 'reference'").run();
    db.close();

    // The upgrade scenario: V50's forced rescan re-lists each directory,
    // finds the rel_paths un-hashed in the snapshot, reads each image
    // once, and heals the rows in place.
    await runScan(rustBin, { ...config, forceRescan: true, scanId: 'heal-1' });

    db = new DatabaseSync(dbPath);
    try {
      assert.equal(db.prepare(
        "SELECT COUNT(*) AS n FROM art_files WHERE kind = 'reference' AND content_hash IS NULL").get().n, 0,
      'every reference row healed');
    } finally { db.close(); }
  });

  test('albumArtPriority=folder elects the folder cover over embedded art', { timeout: 120_000 }, async (t) => {
    if (!available()) { return t.skip('ffmpeg or rust-parser unavailable'); }
    const { dbPath } = await scanFresh(c => runScan(rustBin, c),
      { overrides: { albumArtPriority: 'folder' } });
    const db = new DatabaseSync(dbPath);
    try {
      const t1 = db.prepare(
        "SELECT album_art_file, album_art_source FROM tracks WHERE title = 'With Art'").get();
      assert.equal(t1.album_art_source, 'folder');
      // The default folder image is cached — its filename matches t2's
      // (same white folder.jpg bytes → same content-addressed name).
      const t2 = db.prepare(
        "SELECT album_art_file FROM tracks WHERE title = 'No Art'").get();
      assert.equal(t1.album_art_file, t2.album_art_file);
    } finally { db.close(); }
  });

  test('album_art_pinned survives a force-rescan; unpinned rows re-elect', { timeout: 120_000 }, async (t) => {
    if (!available()) { return t.skip('ffmpeg or rust-parser unavailable'); }
    const { dbPath, config } = await scanFresh(c => runScan(rustBin, c));
    let db = new DatabaseSync(dbPath);
    db.prepare(`UPDATE tracks SET album_art_file = 'user-pick.jpg',
      album_art_source = 'upload', album_art_pinned = 1 WHERE title = 'With Art'`).run();
    db.prepare(`UPDATE tracks SET album_art_file = 'stale-unpinned.jpg',
      album_art_source = 'url' WHERE title = 'No Art'`).run();
    db.close();

    await runScan(rustBin, { ...config, forceRescan: true, scanId: 'art-test-2' });

    db = new DatabaseSync(dbPath);
    try {
      const pinned = db.prepare(
        "SELECT album_art_file, album_art_source, album_art_pinned FROM tracks WHERE title = 'With Art'").get();
      assert.equal(pinned.album_art_file, 'user-pick.jpg', 'pinned default must not be re-elected');
      assert.equal(pinned.album_art_source, 'upload');
      assert.equal(pinned.album_art_pinned, 1);
      const unpinned = db.prepare(
        "SELECT album_art_source FROM tracks WHERE title = 'No Art'").get();
      assert.equal(unpinned.album_art_source, 'folder', 'unpinned default re-elected normally');
    } finally { db.close(); }
  });

  test('skipImg force-rescan PRESERVES defaults and junction rows', { timeout: 120_000 }, async (t) => {
    if (!available()) { return t.skip('ffmpeg or rust-parser unavailable'); }
    const { dbPath, config } = await scanFresh(c => runScan(rustBin, c));
    let db = new DatabaseSync(dbPath);
    const beforeDefaults = db.prepare(
      'SELECT title, album_art_file, album_art_source FROM tracks ORDER BY title').all().map(r => ({ ...r }));
    const beforeLinks = db.prepare('SELECT COUNT(*) AS n FROM track_art').get().n;
    db.close();

    // The V49 upgrade scenario for a skipImg user: a forced re-parse that
    // collects no art must not wipe what previous scans captured.
    await runScan(rustBin, { ...config, skipImg: true, forceRescan: true, scanId: 'art-skip' });

    db = new DatabaseSync(dbPath);
    try {
      const afterDefaults = db.prepare(
        'SELECT title, album_art_file, album_art_source FROM tracks ORDER BY title').all().map(r => ({ ...r }));
      assert.deepEqual(afterDefaults, beforeDefaults, 'skipImg must preserve every default');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM track_art').get().n, beforeLinks,
        'skipImg must leave junction rows untouched');
    } finally { db.close(); }
  });
});

describe('multi-art parity (rust vs JS scanner)', () => {
  test('both scanners produce identical art rows', { timeout: 240_000 }, async (t) => {
    if (!available()) { return t.skip('ffmpeg or rust-parser unavailable'); }
    const rust = await scanFresh(c => runScan(rustBin, c));
    const js = await scanFresh(c => runJsScan(c));
    const dbR = new DatabaseSync(rust.dbPath);
    const dbJ = new DatabaseSync(js.dbPath);
    try {
      assert.deepEqual(artSnapshot(dbJ), artSnapshot(dbR));
    } finally { dbR.close(); dbJ.close(); }
  });

  test('JS scanner honours the pin guard too', { timeout: 240_000 }, async (t) => {
    if (!available()) { return t.skip('ffmpeg or rust-parser unavailable'); }
    const { dbPath, config } = await scanFresh(c => runJsScan(c));
    let db = new DatabaseSync(dbPath);
    db.prepare(`UPDATE tracks SET album_art_file = 'user-pick.jpg',
      album_art_source = 'upload', album_art_pinned = 1 WHERE title = 'With Art'`).run();
    db.close();
    await runJsScan({ ...config, forceRescan: true, scanId: 'art-test-3' });
    db = new DatabaseSync(dbPath);
    try {
      const pinned = db.prepare(
        "SELECT album_art_file, album_art_source FROM tracks WHERE title = 'With Art'").get();
      assert.equal(pinned.album_art_file, 'user-pick.jpg');
      assert.equal(pinned.album_art_source, 'upload');
    } finally { db.close(); }
  });
});

describe('stale-art reaping (disk is truth)', () => {
  // Per-runner fixture copies — these tests delete and replace images.
  async function reapScenario(t, label, runner) {
    const root = path.join(scratch, `reap-${label}`);
    await buildArtFixture(root);
    const dir = await fsp.mkdtemp(path.join(scratch, `reap-run-${label}-`));
    const dbPath = path.join(dir, 'mstream.db');
    const artDir = path.join(dir, 'image-cache');
    await fsp.mkdir(artDir, { recursive: true });
    const { libraryId, vpath } = initEmptyDb(dbPath, root);
    const config = buildScanConfig({
      dbPath, libraryId, vpath, directory: root,
      albumArtDirectory: artDir, waveformCacheDir: '', scanId: `reap-${label}-1`,
    });
    await runner(config);

    let db = new DatabaseSync(dbPath);
    // Plant the two reap-policy probes before the second scan: an
    // UNLINKED cached row whose file EXISTS (must be KEPT), and a cached
    // row whose file is GONE (must be reaped — cached rows are verified
    // on force-rescans, which the second scan is).
    fs.writeFileSync(path.join(artDir, 'unlinked-but-real.jpg'), 'x');
    db.prepare("INSERT INTO art_files (kind, cache_file) VALUES ('cached', 'unlinked-but-real.jpg')").run();
    db.prepare("INSERT INTO art_files (kind, cache_file) VALUES ('cached', 'vanished-from-cache.jpg')").run();
    db.close();

    // Delete a folder image from the library, then force-rescan.
    await fsp.unlink(path.join(root, 'Art Band', 'Gallery', 'back.jpg'));
    await runner({ ...config, forceRescan: true, scanId: `reap-${label}-2` });

    db = new DatabaseSync(dbPath);
    try {
      // The reference row for the deleted image is gone (and its junction
      // links with it, via CASCADE).
      assert.equal(db.prepare(
        "SELECT COUNT(*) AS n FROM art_files WHERE rel_path LIKE '%back.jpg'").get().n, 0);
      const t1 = db.prepare(`
        SELECT af.rel_path FROM track_art ta
          JOIN tracks t ON t.id = ta.track_id
          JOIN art_files af ON af.id = ta.art_id
         WHERE t.title = 'With Art' AND af.kind = 'reference'
         ORDER BY ta.position`).all().map(r => r.rel_path);
      assert.deepEqual(t1, GALLERY_REFS.filter(r => !r.endsWith('back.jpg')));

      // Reap policy: unlinked-but-on-disk KEPT; gone-from-disk reaped.
      assert.equal(db.prepare(
        "SELECT COUNT(*) AS n FROM art_files WHERE cache_file = 'unlinked-but-real.jpg'").get().n, 1,
      'an image on disk is never reaped, linked or not');
      assert.equal(db.prepare(
        "SELECT COUNT(*) AS n FROM art_files WHERE cache_file = 'vanished-from-cache.jpg'").get().n, 0,
      'a cached row whose file is gone is reaped');
    } finally { db.close(); }
  }

  test('rust: deleted folder image reaped; on-disk art kept', { timeout: 120_000 }, async (t) => {
    if (!available()) { return t.skip('ffmpeg or rust-parser unavailable'); }
    await reapScenario(t, 'rust', c => runScan(rustBin, c));
  });

  test('JS: deleted folder image reaped; on-disk art kept', { timeout: 240_000 }, async (t) => {
    if (!available()) { return t.skip('ffmpeg or rust-parser unavailable'); }
    await reapScenario(t, 'js', c => runJsScan(c));
  });

  test('replaced embedded cover: stale album_art link reconciled away (cache file stays)', { timeout: 120_000 }, async (t) => {
    if (!available()) { return t.skip('ffmpeg or rust-parser unavailable'); }
    const root = path.join(scratch, 'replace-cover');
    await buildArtFixture(root);
    const { dbPath, config } = await (async () => {
      const dir = await fsp.mkdtemp(path.join(scratch, 'replace-run-'));
      const dbPath = path.join(dir, 'mstream.db');
      const artDir = path.join(dir, 'image-cache');
      await fsp.mkdir(artDir, { recursive: true });
      const { libraryId, vpath } = initEmptyDb(dbPath, root);
      const config = buildScanConfig({
        dbPath, libraryId, vpath, directory: root,
        albumArtDirectory: artDir, waveformCacheDir: '', scanId: 'replace-1',
      });
      await runScan(rustBin, config);
      return { dbPath, config };
    })();

    let db = new DatabaseSync(dbPath);
    const galleryCount = db.prepare(`
      SELECT COUNT(*) AS n FROM album_art aa
        JOIN albums al ON al.id = aa.album_id WHERE al.name = 'Gallery'`).get().n;
    db.close();

    // Re-write 01.mp3 with DIFFERENT embedded pictures, then rescan
    // (fresh mtime → re-parse without forceRescan).
    await makeAudioWithArt(path.join(root, 'Art Band', 'Gallery', '01.mp3'),
      ['navy', 'olive'],
      { title: 'With Art', artist: 'Art Band', album: 'Gallery', track: '1/2' });
    await runScan(rustBin, { ...config, scanId: 'replace-2' });

    db = new DatabaseSync(dbPath);
    try {
      // track_art holds only the NEW embedded pair (clear-then-relink)…
      const t1Cached = db.prepare(`
        SELECT COUNT(*) AS n FROM track_art ta
          JOIN tracks t ON t.id = ta.track_id
          JOIN art_files af ON af.id = ta.art_id
         WHERE t.title = 'With Art' AND af.kind = 'cached'`).get().n;
      assert.equal(t1Cached, 2);
      // …and album_art converged back to the same size: the old covers'
      // links were reconciled away even though their cache files rightly
      // remain on disk (disk-truth reaping must NOT delete them).
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS n FROM album_art aa
          JOIN albums al ON al.id = aa.album_id WHERE al.name = 'Gallery'`).get().n,
      galleryCount);
      // The replaced covers' art_files rows still exist (files on disk).
      assert.ok(db.prepare(
        "SELECT COUNT(*) AS n FROM art_files WHERE kind = 'cached'").get().n >= 6,
      'old cached covers must survive as unlinked art_files rows');
    } finally { db.close(); }
  });
});

describe('V49 rescan marker', () => {
  test('V49 exists, is SQL-trivial, and is rescanRequired', () => {
    const v49 = MIGRATIONS.find(m => m.version === 49);
    assert.ok(v49, 'missing v49 migration');
    // The whole point of V49: force the resumable boot rescan that
    // populates existing libraries' art sets after upgrade.
    assert.equal(v49.rescanRequired, true);
  });
});
