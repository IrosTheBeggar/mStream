/**
 * Track / disc number ingestion — both-scanner parity.
 *
 * Taggers write these two numbers either bare (`3`) or in the combined
 * "N of total" form (`3/9`). lofty's typed accessors split the combined form
 * for ID3v2 (TRCK/TPOS) and MP4 (trkn/disk), and for Vorbis TRACKNUMBER — but
 * NOT for Vorbis DISCNUMBER or RIFF INFO's ITRK, where `Accessor::disk()` /
 * `Accessor::track()` return None outright. That silently cost the Rust
 * scanner (the default) the numbers music-metadata reads fine:
 *
 *   • a multi-disc FLAC/OGG/Opus set tagged `DISCNUMBER=1/2` landed with
 *     disc_number NULL on every track, so the album view interleaved the
 *     discs (disc 1 track 1, disc 2 track 1, disc 1 track 2, …);
 *   • a WAV album tagged `track=1/4` landed with track_number NULL on every
 *     track, so the album view fell through to its filepath tiebreak and
 *     showed the album in alphabetical order.
 *
 * rust-parser now re-reads the raw tag string and splits it itself
 * (parse_num_of). This test locks that in for BOTH engines, so the two can't
 * drift apart again.
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

const MP3  = ['-c:a', 'libmp3lame', '-b:a', '64k', '-id3v2_version', '3'];
const FLAC = ['-c:a', 'flac'];
const OGG  = ['-c:a', 'libvorbis', '-q:a', '2'];
const WAV  = ['-c:a', 'pcm_s16le'];

// One row per fixture: [title, codec, tags, expected track/disc/totals].
// `track` / `disc` are written verbatim as ffmpeg -metadata values, so they
// carry the exact tag shape (bare vs "N/total") each case is about.
const CASES = [
  { title: 'Flac Combined', codec: FLAC, ext: 'flac', tags: { track: '1/9', disc: '1/2' },
    want: { track_number: 1, disc_number: 1, track_total: 9, disc_total: 2 },
    why: 'Vorbis DISCNUMBER=1/2 — the form lofty\'s disk() cannot split' },
  { title: 'Flac Bare', codec: FLAC, ext: 'flac', tags: { track: '2', disc: '2' },
    want: { track_number: 2, disc_number: 2, track_total: null, disc_total: null },
    why: 'bare Vorbis values — the control that always worked' },
  { title: 'Ogg Combined', codec: OGG, ext: 'ogg', tags: { track: '3/9', disc: '2/2' },
    want: { track_number: 3, disc_number: 2, track_total: 9, disc_total: 2 },
    why: 'Vorbis comments again, different container' },
  { title: 'Wav Combined', codec: WAV, ext: 'wav', tags: { track: '4/9' },
    want: { track_number: 4, disc_number: null, track_total: 9, disc_total: null },
    why: 'RIFF INFO ITRK=4/9 — the form lofty\'s track() cannot split' },
  { title: 'Mp3 Combined', codec: MP3, ext: 'mp3', tags: { track: '5/9', disc: '1/2' },
    want: { track_number: 5, disc_number: 1, track_total: 9, disc_total: 2 },
    why: 'ID3v2 TRCK/TPOS — lofty splits these natively' },
  { title: 'Vinyl Side', codec: FLAC, ext: 'flac', tags: { track: 'A1' },
    want: { track_number: null, disc_number: null, track_total: null, disc_total: null },
    why: 'non-numeric side numbering stays NULL rather than becoming a bogus number' },
  { title: 'No Numbers', codec: FLAC, ext: 'flac', tags: {},
    want: { track_number: null, disc_number: null, track_total: null, disc_total: null },
    why: 'no tag at all' },
];

let rustBin;
let workDir;
let libRoot;
// Capability probe (the protocol-PR CI rule): a full-ci run tests against
// MASTER's prebuilt rust-parser, which predates parse_num_of until the
// post-merge binaries rebuild — the rust leg must skip on an old binary, not
// fail. The probe scan doubles as the rust leg's actual scan (no double work);
// the JS leg always covers the ingestion logic either way.
let rustDbPath = null;
let rustSplitsCombined = false;

before(async () => {
  rustBin = findRustParser();
  if (!rustBin || !fs.existsSync(FFMPEG)) { return; } // tests skip

  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mstream-tracknums-'));
  libRoot = path.join(workDir, 'library');
  await fsp.mkdir(libRoot, { recursive: true });

  for (const c of CASES) {
    await makeAudio(
      path.join(libRoot, 'Numbered Artist', 'Numbered Album', `${c.title}.${c.ext}`),
      c.codec,
      { title: c.title, artist: 'Numbered Artist', album: 'Numbered Album', ...c.tags },
    );
  }

  rustDbPath = await scanWith('rust');
  rustSplitsCombined = trackByTitle(rustDbPath, 'Flac Combined')?.disc_number === 1;
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
    scanId: `tracknums-${engine}`,
  });
  const runner = engine === 'rust' ? (c => runScan(rustBin, c)) : runJsScan;
  await runner(cfg);
  return dbPath;
}

function trackByTitle(dbPath, title) {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(
      'SELECT track_number, disc_number, track_total, disc_total FROM tracks WHERE title = ?',
    ).get(title);
  } finally {
    db.close();
  }
}

describe('track / disc number ingestion', () => {
  for (const engine of ['rust', 'js']) {
    test(`[${engine}] reads bare and "N/total" track + disc tags`, async (t) => {
      if (!rustBin)               { return t.skip('no rust-parser binary'); }
      if (!fs.existsSync(FFMPEG)) { return t.skip('no bundled ffmpeg'); }
      if (engine === 'rust' && !rustSplitsCombined) {
        return t.skip('rust-parser binary predates the "N/total" tag split '
          + '(CI prebuilt until the post-merge rebuild) — the JS leg still covers the logic');
      }

      const dbPath = engine === 'rust' ? rustDbPath : await scanWith(engine);

      for (const c of CASES) {
        const row = trackByTitle(dbPath, c.title);
        assert.ok(row, `[${engine}] ${c.title} was scanned`);
        assert.deepEqual(
          {
            track_number: row.track_number, disc_number: row.disc_number,
            track_total: row.track_total, disc_total: row.disc_total,
          },
          c.want,
          `[${engine}] ${c.title}: ${c.why}`,
        );
      }
    });
  }
});
