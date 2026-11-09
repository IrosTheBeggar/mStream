/**
 * ReplayGain track gain ingestion — both-scanner parity.
 *
 * tracks.replaygain_track_db holds the REPLAYGAIN_TRACK_GAIN tag in dB, and
 * the web player turns it into the playback amplitude. A 0 dB gain is a real
 * value — "play this track as is" — distinct from no tag at all, which the
 * player treats as "no ReplayGain info" (a fixed -10 dB). The Rust scanner
 * always stored 0.0; the JS fallback wrote `dB || null`, which turned it into
 * NULL. Both engines must now agree: -6.5 stays -6.5, +0.00 dB is 0, and an
 * untagged track is NULL.
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

const FLAC = ['-c:a', 'flac'];

let rustBin;
let workDir;
let libRoot;

before(async () => {
  rustBin = findRustParser();
  if (!rustBin || !fs.existsSync(FFMPEG)) { return; } // tests skip

  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mstream-replaygain-'));
  libRoot = path.join(workDir, 'library');
  await fsp.mkdir(libRoot, { recursive: true });

  // ffmpeg writes these as Vorbis comments on the FLAC, where both lofty and
  // music-metadata read REPLAYGAIN_TRACK_GAIN.
  const album = path.join(libRoot, 'RG Artist', 'RG Album');
  await makeAudio(path.join(album, '01.flac'), FLAC, {
    title: 'Quieter', artist: 'RG Artist', album: 'RG Album', track: '1/3',
    REPLAYGAIN_TRACK_GAIN: '-6.50 dB',
  });
  await makeAudio(path.join(album, '02.flac'), FLAC, {
    title: 'Unity', artist: 'RG Artist', album: 'RG Album', track: '2/3',
    REPLAYGAIN_TRACK_GAIN: '+0.00 dB',
  });
  await makeAudio(path.join(album, '03.flac'), FLAC, {
    title: 'Untagged', artist: 'RG Artist', album: 'RG Album', track: '3/3',
  });
});

after(async () => {
  if (workDir) { await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {}); }
});

// Run one scan with the given engine into a fresh DB and return its path.
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
    scanId: `replaygain-${engine}`,
  });
  const runner = engine === 'rust' ? (c => runScan(rustBin, c)) : runJsScan;
  await runner(cfg);
  return dbPath;
}

function gainsByTitle(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    return Object.fromEntries(
      db.prepare('SELECT title, replaygain_track_db FROM tracks').all()
        .map(r => [r.title, r.replaygain_track_db]));
  } finally {
    db.close();
  }
}

describe('ReplayGain track gain ingestion', () => {
  for (const engine of ['rust', 'js']) {
    test(`[${engine}] stores the tagged gain, 0 dB included, and NULL when untagged`, async (t) => {
      if (!rustBin)               { return t.skip('no rust-parser binary'); }
      if (!fs.existsSync(FFMPEG)) { return t.skip('no bundled ffmpeg'); }

      const gains = gainsByTitle(await scanWith(engine));
      assert.equal(gains.Quieter, -6.5, `[${engine}] -6.50 dB`);
      assert.equal(gains.Unity, 0, `[${engine}] +0.00 dB is a real gain, not NULL`);
      assert.equal(gains.Untagged, null, `[${engine}] no tag stays NULL`);
    });
  }
});
