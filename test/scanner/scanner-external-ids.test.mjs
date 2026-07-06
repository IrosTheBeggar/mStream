/**
 * V55 external-service ID ingestion — both-scanner parity.
 *
 * The scanners read MusicBrainz / ISRC identifiers out of embedded tags (the
 * frames Picard / beets write) into tracks.mbz_recording_id /
 * mbz_release_track_id / isrc / mbz_id_source and albums.mbz_album_id /
 * mbz_release_group_id. This test builds a tiny tagged library and asserts
 * that BOTH the Rust scanner and the JS fallback populate those columns with
 * the SAME expected values — the historical Vorbis naming quirk
 * (MUSICBRAINZ_TRACKID actually carries the RECORDING MBID) included.
 *
 * Skipped when the bundled ffmpeg or a usable rust-parser binary is absent
 * (same gate as the other scanner-parity tests).
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
import { makeAudio } from '../helpers/scanner-fixture.mjs';

// Fixed identifiers so assertions are exact. Real UUID / ISRC shapes.
const REC1 = 'b1a9c0de-0000-4000-8000-000000000001'; // recording MBID, track 1
const REC2 = 'b1a9c0de-0000-4000-8000-000000000002'; // recording MBID, track 2
const RT1  = 'cc000000-0000-4000-8000-0000000000a1'; // release-track MBID
const ALB1 = 'aa000000-0000-4000-8000-0000000000b1'; // release (album) MBID
const RG1  = 'a9000000-0000-4000-8000-0000000000c1'; // release-group MBID
const ISRC1 = 'GBAYE0601498';

const FLAC = ['-c:a', 'flac'];

let rustBin;
let workDir;
let libRoot;
// Capability probe (the protocol-PR CI rule): full-ci tests against MASTER's
// prebuilt rust-parser, which predates the external-ID ingestion until the
// post-merge binaries rebuild — the rust leg must skip on an old binary, not
// fail. The probe scan doubles as the rust leg's actual scan (no double
// work); the JS leg always covers the schema + ingestion logic, and the
// rebuilt binary un-skips the rust leg from the next PR onward.
let rustDbPath = null;
let rustSupportsExtIds = false;

before(async () => {
  rustBin = findRustParser();
  if (!rustBin || !fs.existsSync(FFMPEG)) { return; } // tests skip

  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mstream-extids-'));
  libRoot = path.join(workDir, 'library');
  await fsp.mkdir(libRoot, { recursive: true });

  // Track 1: the full MusicBrainz set + ISRC. ffmpeg writes these as Vorbis
  // comments on the FLAC; both lofty and music-metadata map MUSICBRAINZ_TRACKID
  // → recording id, MUSICBRAINZ_RELEASETRACKID → (release) track id.
  await makeAudio(path.join(libRoot, 'Tagged Artist', 'Tagged Album', '01.flac'), FLAC, {
    title: 'Tagged One', artist: 'Tagged Artist', album: 'Tagged Album', track: '1/2',
    MUSICBRAINZ_TRACKID: REC1,
    MUSICBRAINZ_RELEASETRACKID: RT1,
    MUSICBRAINZ_ALBUMID: ALB1,
    MUSICBRAINZ_RELEASEGROUPID: RG1,
    ISRC: ISRC1,
  });

  // Track 2: same album, a different recording, carrying ONLY a recording id
  // (no album-level ids). Exercises mbz_id_source='tag' from the recording id
  // alone and confirms the album row keeps track 1's release / release-group
  // ids (fill-NULL convergence, first writer wins).
  await makeAudio(path.join(libRoot, 'Tagged Artist', 'Tagged Album', '02.flac'), FLAC, {
    title: 'Tagged Two', artist: 'Tagged Artist', album: 'Tagged Album', track: '2/2',
    MUSICBRAINZ_TRACKID: REC2,
  });

  // Untagged track on its own album: every external-id column must stay NULL,
  // mbz_id_source included.
  await makeAudio(path.join(libRoot, 'Plain Artist', 'Plain Album', '01.flac'), FLAC, {
    title: 'Plain One', artist: 'Plain Artist', album: 'Plain Album', track: '1/1',
  });

  rustDbPath = await scanWith('rust');
  rustSupportsExtIds = trackByTitle(rustDbPath, 'Tagged One')?.mbz_recording_id === REC1;
});

after(async () => {
  if (workDir) { await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {}); }
});

// Run one scan with the given engine into a fresh DB and return a reader.
async function scanWith(engine) {
  const dbPath = path.join(workDir, `db-${engine}.db`);
  const artDir = path.join(workDir, `art-${engine}`);
  const wfDir  = path.join(workDir, `wf-${engine}`);
  await fsp.mkdir(artDir, { recursive: true });
  await fsp.mkdir(wfDir, { recursive: true });
  const { libraryId, vpath } = initEmptyDb(dbPath, libRoot, 'testlib');
  const cfg = buildScanConfig({
    dbPath, libraryId, vpath, directory: libRoot,
    albumArtDirectory: artDir, waveformCacheDir: wfDir,
    scanId: `extids-${engine}`,
  });
  const runner = engine === 'rust' ? (c => runScan(rustBin, c)) : runJsScan;
  await runner(cfg);
  return dbPath;
}

function trackByTitle(dbPath, title) {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(`
      SELECT t.title, t.mbz_recording_id, t.mbz_release_track_id, t.isrc, t.mbz_id_source,
             al.name AS album_name, al.mbz_album_id, al.mbz_release_group_id
        FROM tracks t LEFT JOIN albums al ON al.id = t.album_id
       WHERE t.title = ?
    `).get(title);
  } finally {
    db.close();
  }
}

describe('V55 external-service ID ingestion', () => {
  for (const engine of ['rust', 'js']) {
    test(`[${engine}] reads MusicBrainz / ISRC ids from tags`, async (t) => {
      if (!rustBin)               { return t.skip('no rust-parser binary'); }
      if (!fs.existsSync(FFMPEG)) { return t.skip('no bundled ffmpeg'); }
      if (engine === 'rust' && !rustSupportsExtIds) {
        return t.skip('rust-parser binary predates external-ID ingestion '
          + '(CI prebuilt until the post-merge rebuild) — the JS leg still covers the logic');
      }

      const dbPath = engine === 'rust' ? rustDbPath : await scanWith(engine);

      const one = trackByTitle(dbPath, 'Tagged One');
      assert.equal(one.mbz_recording_id, REC1, `[${engine}] recording MBID from MUSICBRAINZ_TRACKID`);
      assert.equal(one.mbz_release_track_id, RT1, `[${engine}] release-track MBID from MUSICBRAINZ_RELEASETRACKID`);
      assert.equal(one.isrc, ISRC1, `[${engine}] ISRC`);
      assert.equal(one.mbz_id_source, 'tag', `[${engine}] provenance is 'tag'`);
      // Album-level ids land on the album row, not the track row.
      assert.equal(one.mbz_album_id, ALB1, `[${engine}] album release MBID`);
      assert.equal(one.mbz_release_group_id, RG1, `[${engine}] album release-group MBID`);

      const two = trackByTitle(dbPath, 'Tagged Two');
      assert.equal(two.mbz_recording_id, REC2, `[${engine}] track 2 recording MBID`);
      assert.equal(two.mbz_id_source, 'tag', `[${engine}] recording id alone sets provenance`);
      assert.equal(two.mbz_release_track_id, null, `[${engine}] track 2 has no release-track id`);
      assert.equal(two.isrc, null, `[${engine}] track 2 has no ISRC`);
      // Same album row as track 1 — its release / release-group ids persist
      // even though track 2 carried none (fill-NULL, first writer wins).
      assert.equal(two.album_name, 'Tagged Album');
      assert.equal(two.mbz_album_id, ALB1, `[${engine}] shared album keeps track 1's release MBID`);
      assert.equal(two.mbz_release_group_id, RG1, `[${engine}] shared album keeps track 1's release-group MBID`);

      const plain = trackByTitle(dbPath, 'Plain One');
      assert.equal(plain.mbz_recording_id, null, `[${engine}] untagged track has no recording id`);
      assert.equal(plain.mbz_release_track_id, null);
      assert.equal(plain.isrc, null);
      assert.equal(plain.mbz_id_source, null, `[${engine}] untagged track has NULL provenance`);
      assert.equal(plain.mbz_album_id, null, `[${engine}] untagged album has no release MBID`);
      assert.equal(plain.mbz_release_group_id, null);
    });
  }
});
