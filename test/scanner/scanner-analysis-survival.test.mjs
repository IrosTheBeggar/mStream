/**
 * Analysed BPM/key and AcoustID-derived MBIDs survive real re-parses, on
 * BOTH scanners.
 *
 * The post-scan passes write values the file's tags do not carry (essentia's
 * bpm / musical_key, AcoustID's recording MBID). A re-parse — a tag edit, a
 * touch, a forced rescan, every rescanRequired epoch — used to write the
 * file's (absent) tags over them, and the 'analyzed' ledger row then kept the
 * track off the analysis work list for 90 days. Now:
 *
 *   - a row whose values are all the enricher's keeps them through the scan
 *     itself (the UPSERT preserve CASE), forced rescans included;
 *   - a value the file does supply wins; a malformed one (TBPM=0, a blank
 *     key) does not count as supplied;
 *   - what the CASE cannot tell apart (a mixed tag+analysis row, a removed
 *     tag, a moved file's new row) is NULL after the scan and comes back
 *     from the ledger through the analysis worker's refill statement.
 *
 * The enrichment writes use the analysis worker's own statements
 * (src/db/audio-analysis-lib.js) with fixed "measurements", so no essentia
 * run is needed. The final DBs of the two engines must match.
 *
 * Skipped when ffmpeg or the rust binary is unavailable, or when the only
 * rust binary is a prebuilt that predates this rust-parser source.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  findRustParser, rustParserIsStale, FFMPEG, initEmptyDb, buildScanConfig, runScan, runJsScan,
} from '../helpers/scanner-runner.mjs';
import { ffmpeg } from '../helpers/scanner-fixture.mjs';
import { snapshotDb } from '../helpers/db-snapshot.mjs';
import { appendFlacVorbisComments } from '../helpers/vorbis.mjs';
import { buildId3v2Tag, id3Frame, id3TextBody, replaceId3v2Tag } from '../helpers/id3.mjs';
import { FILL_ANALYSIS_SQL, RECORD_ANALYZED_SQL, REFILL_FROM_LEDGER_SQL } from '../../src/db/audio-analysis-lib.js';

let rustBin;
let scratch;
const snapshots = {};

const ffmpegOk = () => fs.existsSync(FFMPEG);
function skipReason(engine) {
  if (!ffmpegOk()) { return 'ffmpeg unavailable'; }
  if (engine !== 'rust') { return null; }
  if (!rustBin) { return 'rust-parser unavailable'; }
  if (rustParserIsStale(rustBin)) {
    return 'the prebuilt rust-parser predates this source (build rust-parser to run this leg)';
  }
  return null;
}

before(async () => {
  rustBin = findRustParser();
  scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'mstream-analysis-survival-'));
});
after(async () => {
  if (scratch) { await fsp.rm(scratch, { recursive: true, force: true }); }
});

// Fixed mtimes, so the two engines' DBs (which store mtime) compare equal.
const T_CREATED = new Date('2029-01-01T00:00:00Z');
const T_EDITED = new Date('2030-01-01T00:00:00Z');

const MP3 = ['-c:a', 'libmp3lame', '-b:a', '32k', '-id3v2_version', '3'];
const FLAC = ['-c:a', 'flac'];
// A distinct tone per file → a distinct audio hash per file (the passes fan
// their results out by canonical hash).
async function tone(file, freq, codec, meta) {
  const args = ['-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=3`, '-ac', '1', '-ar', '22050', ...codec];
  for (const [k, v] of Object.entries(meta)) { args.push('-metadata', `${k}=${v}`); }
  await ffmpeg([...args, file]);
  await fsp.utimes(file, T_CREATED, T_CREATED);
}

// name → tone, codec, tags, what essentia "measured", AcoustID MBID.
const FILES = {
  'a_untagged.mp3':  { freq: 220, codec: MP3, meta: {}, bpm: 93, key: 'E major', mbid: 'mbid-a' },
  'b_bpm_tag.mp3':   { freq: 260, codec: MP3, meta: { TBPM: '128' }, bpm: 126, key: 'C minor' },
  'c_key_tag.flac':  { freq: 300, codec: FLAC, meta: { KEY: 'Am' }, bpm: 97, key: 'A minor' },
  'd_bpm_gone.mp3':  { freq: 340, codec: MP3, meta: { TBPM: '128' }, bpm: 126, key: 'F minor' },
  'e_tbpm_zero.mp3': { freq: 380, codec: MP3, meta: { TBPM: '0' }, bpm: 88, key: 'D major' },
  'f_blank_key.flac': { freq: 420, codec: FLAC, meta: {}, blankKey: true, bpm: 99, key: 'B minor' },
  'g_moved.mp3':     { freq: 460, codec: MP3, meta: {}, bpm: 92, key: 'D minor' },
  'h_isrc.mp3':      { freq: 500, codec: MP3, meta: { TSRC: 'USRC17607839' }, bpm: 95, key: 'A major', mbid: 'mbid-h' },
  'i_untouched.flac': { freq: 540, codec: FLAC, meta: {}, bpm: 98, key: 'Bb minor', mbid: 'mbid-i' },
};

async function makeSandbox(engine) {
  const root = path.join(scratch, engine);
  const libRoot = path.join(root, 'lib');
  await fsp.mkdir(libRoot, { recursive: true });
  for (const [name, f] of Object.entries(FILES)) {
    const file = path.join(libRoot, name);
    await tone(file, f.freq, f.codec, { title: name, artist: 'Survival', ...f.meta });
    if (f.blankKey) {
      await appendFlacVorbisComments(file, [['KEY', '   ']]);
      await fsp.utimes(file, T_CREATED, T_CREATED);
    }
  }
  const dbPath = path.join(root, 'test.db');
  const { libraryId, vpath } = initEmptyDb(dbPath, libRoot);
  let seq = 0;
  const scan = (overrides = {}) => {
    const config = buildScanConfig({
      dbPath, libraryId, vpath, directory: libRoot,
      albumArtDirectory: path.join(root, 'art'), waveformCacheDir: path.join(root, 'wave'),
      scanId: `scan-${seq++}`, overrides,
    });
    return engine === 'js' ? runJsScan(config) : runScan(rustBin, config);
  };
  const withDb = (fn) => {
    const db = new DatabaseSync(dbPath);
    try { return fn(db); } finally { db.close(); }
  };
  return { libRoot, dbPath, scan, withDb };
}

const rows = (db) => Object.fromEntries(db.prepare(`
  SELECT filepath, bpm, musical_key, bpm_source, mbz_recording_id, mbz_id_source, isrc
    FROM tracks ORDER BY filepath`).all()
  .map((r) => [r.filepath, [r.bpm, r.musical_key, r.bpm_source, r.mbz_recording_id, r.mbz_id_source, r.isrc]]));

// The passes' writes, as the workers commit them.
function enrich(db) {
  const tracks = db.prepare('SELECT filepath, COALESCE(audio_hash, file_hash) AS canon FROM tracks').all();
  const fill = db.prepare(FILL_ANALYSIS_SQL);
  const record = db.prepare(RECORD_ANALYZED_SQL);
  // Mirrors acoustid-backfill.mjs fillIdentity.
  const identify = db.prepare(`UPDATE tracks SET mbz_recording_id = COALESCE(mbz_recording_id, ?),
    acoustid_id = COALESCE(acoustid_id, ?), mbz_id_source = 'acoustid'
    WHERE COALESCE(audio_hash, file_hash) = ? AND mbz_recording_id IS NULL`);
  for (const t of tracks) {
    const f = FILES[t.filepath];
    db.exec('BEGIN IMMEDIATE');
    fill.run(f.bpm, f.key, t.canon);
    record.run(t.canon, Math.floor(Date.now() / 1000), f.bpm, f.key);
    db.exec('COMMIT');
    if (f.mbid) { identify.run(f.mbid, `aid-${f.mbid}`, t.canon); }
  }
}

const E = 'essentia';
const ISRC = 'USRC17607839';
// Straight after the re-parse (before any refill).
const AFTER_SCAN = {
  'a_untagged.mp3':  [93, 'E major', E, 'mbid-a', 'acoustid', null],
  'b_bpm_tag.mp3':   [128, null, 'tag', null, null, null],         // mixed: the analysed key is NULL…
  'c_key_tag.flac':  [null, 'Am', 'tag', null, null, null],        // …and here the analysed BPM
  'd_bpm_gone.mp3':  [null, null, null, null, null, null],         // the BPM tag was removed
  'e_tbpm_zero.mp3': [88, 'D major', E, null, null, null],         // TBPM=0 is no tag
  'f_blank_key.flac': [99, 'B minor', E, null, null, null],        // nor is a blank key
  'g_moved_renamed.mp3': [null, null, null, null, null, null],     // a moved file is a new row
  'h_isrc.mp3':      [95, 'A major', E, 'mbid-h', 'acoustid', ISRC],
  'i_untouched.flac': [98, 'Bb minor', E, 'mbid-i', 'acoustid', null],
};
// After the analysis worker's refill.
const AFTER_REFILL = {
  ...AFTER_SCAN,
  'b_bpm_tag.mp3':   [128, 'C minor', 'tag', null, null, null],
  'c_key_tag.flac':  [97, 'Am', 'tag', null, null, null],
  'd_bpm_gone.mp3':  [126, 'F minor', E, null, null, null],
  'g_moved_renamed.mp3': [92, 'D minor', E, null, null, null],
};

for (const engine of ['rust', 'js']) {
  describe(`analysis + AcoustID values survive re-parses [${engine}]`, () => {
    test('touch, tag edit, tag removal, move, forced rescan, then the refill', async (t) => {
      const why = skipReason(engine);
      if (why) { t.skip(why); return; }
      const sb = await makeSandbox(engine);
      await sb.scan();
      sb.withDb(enrich);
      sb.withDb((db) => {
        const before = rows(db);
        assert.deepEqual(before['a_untagged.mp3'], [93, 'E major', E, 'mbid-a', 'acoustid', null]);
        assert.deepEqual(before['b_bpm_tag.mp3'], [128, 'C minor', 'tag', null, null, null]);
        assert.deepEqual(before['e_tbpm_zero.mp3'], [88, 'D major', E, null, null, null],
          'TBPM=0 was read as no tag, so the row is analysis-sourced');
        assert.deepEqual(before['f_blank_key.flac'], [99, 'B minor', E, null, null, null]);
      });

      // Re-parse triggers.
      const at = (name) => path.join(sb.libRoot, name);
      for (const name of ['a_untagged.mp3', 'b_bpm_tag.mp3', 'e_tbpm_zero.mp3', 'f_blank_key.flac', 'h_isrc.mp3']) {
        await fsp.utimes(at(name), T_EDITED, T_EDITED);                     // touch
      }
      await appendFlacVorbisComments(at('c_key_tag.flac'), [['COMMENT', 'edited']]);   // tag edit
      await fsp.utimes(at('c_key_tag.flac'), T_EDITED, T_EDITED);
      await replaceId3v2Tag(at('d_bpm_gone.mp3'), buildId3v2Tag([                      // BPM tag removed
        id3Frame('TIT2', id3TextBody('d_bpm_gone.mp3')), id3Frame('TPE1', id3TextBody('Survival')),
      ]));
      await fsp.utimes(at('d_bpm_gone.mp3'), T_EDITED, T_EDITED);
      await fsp.rename(at('g_moved.mp3'), at('g_moved_renamed.mp3'));                  // move

      const hashesBefore = sb.withDb((db) => db.prepare(
        'SELECT audio_hash FROM tracks ORDER BY audio_hash').all().map((r) => r.audio_hash));
      const r2 = await sb.scan();
      assert.equal(r2.event.filesUnchanged, 1, 'only i_untouched.flac skipped the re-parse');
      sb.withDb((db) => {
        assert.deepEqual(db.prepare('SELECT audio_hash FROM tracks ORDER BY audio_hash').all()
          .map((r) => r.audio_hash), hashesBefore, 'tag edits never changed the audio hash');
        assert.deepEqual(rows(db), AFTER_SCAN);
      });

      await sb.scan({ forceRescan: true });
      sb.withDb((db) => assert.deepEqual(rows(db), AFTER_SCAN, 'a forced rescan keeps them too'));

      const refilled = sb.withDb((db) => Number(db.prepare(REFILL_FROM_LEDGER_SQL).run().changes));
      assert.equal(refilled, 4);
      sb.withDb((db) => assert.deepEqual(rows(db), AFTER_REFILL));
      snapshots[engine] = snapshotDb(sb.dbPath);
    });
  });
}

describe('analysis survival: engine parity', () => {
  test('both scanners leave the same database', (t) => {
    if (!snapshots.rust || !snapshots.js) { t.skip('needs both engine legs'); return; }
    // MP3 duration precision differs between the engines' decoders (3.056 vs
    // 3.0563…) — a pre-existing difference this suite is not about.
    const norm = (snap) => ({
      ...snap,
      tracks: snap.tracks.map((t) => ({ ...t, duration: t.duration == null ? null : Math.round(t.duration * 100) / 100 })),
    });
    assert.deepEqual(norm(snapshots.rust), norm(snapshots.js));
  });
});
