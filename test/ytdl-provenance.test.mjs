/**
 * V36 end-to-end provenance tests.
 *
 * Each test writes a small audio file with ffmpeg, embeds a marker tag
 * via `-metadata`, then runs a scanner against the directory and
 * asserts `tracks.source` was populated correctly.
 *
 * Why ffmpeg-driven: it mirrors what src/api/ytdl.js does at runtime
 * (the handler shells out to ffmpeg to write the MSTREAM_SOURCE tag),
 * so a regression where ffmpeg's per-container encoding diverges from
 * what the scanner reads back would surface here.
 *
 * The test runs against the Rust binary when available (matching the
 * production default code path); if not built, it falls back to the JS
 * scanner. Both must produce the same `tracks.source` value for the
 * parity guarantee to hold.
 *
 * Skipped when the bundled ffmpeg isn't present (CI environments
 * without `bin/`).
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import child from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { parseFile } from 'music-metadata';

import {
  findRustParser, FFMPEG, initEmptyDb, buildScanConfig, runScan,
} from './helpers/scanner-runner.mjs';
import { detectSource } from '../src/db/source-detect.js';

// ── Test fixtures ──────────────────────────────────────────────────────────

let rustBin;
let workDir;
let libRoot;
let dbDir;
let artDir;
let wfDir;

function mkScratch(name) {
  return fsp.mkdtemp(path.join(os.tmpdir(), `mstream-v36-${name}-`));
}

before(async () => {
  rustBin = findRustParser();
  if (!fs.existsSync(FFMPEG)) { return; }

  workDir = await mkScratch('work');
  libRoot = path.join(workDir, 'library');
  dbDir   = path.join(workDir, 'db');
  artDir  = path.join(workDir, 'art');
  wfDir   = path.join(workDir, 'waveforms');
  await fsp.mkdir(libRoot, { recursive: true });
  await fsp.mkdir(dbDir, { recursive: true });
  await fsp.mkdir(artDir, { recursive: true });
  await fsp.mkdir(wfDir, { recursive: true });
});

after(async () => {
  if (workDir) {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────

function ffmpegRun(args) {
  return new Promise((resolve, reject) => {
    const p = child.spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', d => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('exit', code => {
      if (code === 0) { resolve(); }
      else { reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`)); }
    });
  });
}

// Generate a 1-second audio file with the supplied metadata. Codec
// choice drives the per-container tag encoding (TXXX for ID3v2 / Vorbis
// comment / MP4 freeform) — the scanner readback must handle all three.
async function makeAudio(filepath, codecArgs, meta = {}) {
  await fsp.mkdir(path.dirname(filepath), { recursive: true });
  const metaArgs = [];
  for (const [k, v] of Object.entries(meta)) {
    metaArgs.push('-metadata', `${k}=${v}`);
  }
  await ffmpegRun([
    '-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:duration=1',
    ...codecArgs, ...metaArgs,
    filepath,
  ]);
}

const MP3  = ['-c:a', 'libmp3lame', '-b:a', '64k', '-id3v2_version', '3'];
const FLAC = ['-c:a', 'flac'];
const OGG  = ['-c:a', 'libvorbis', '-q:a', '2'];
const M4A  = ['-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart'];

// Scan via the rust binary when available, else the JS scanner. Both
// paths set tracks.source from the embedded tag.
function runScannerAgainst(directory, dbPath, libraryId, vpath) {
  if (rustBin) {
    const cfg = buildScanConfig({
      dbPath, libraryId, vpath, directory,
      albumArtDirectory: artDir,
      waveformCacheDir: wfDir,
      scanId: `v36-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    return runScan(rustBin, cfg);
  }
  // JS scanner fallback. Same JSON config as task-queue.js builds.
  const jsonLoad = {
    dbPath, libraryId, vpath, directory,
    skipImg: false, compressImage: false,
    forceRescan: false, followSymlinks: false,
    scanCommitInterval: 25,
    scanId: `v36-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    albumArtDirectory: artDir,
    supportedFiles: {
      mp3: true, flac: true, wav: true, ogg: true,
      aac: true, m4a: true, m4b: true, opus: true, m3u: false,
    },
  };
  return new Promise((resolve, reject) => {
    const __dirname = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]):\//, '$1:/'));
    const scannerPath = path.resolve(__dirname, '../src/db/scanner.mjs');
    const p = child.fork(scannerPath, [JSON.stringify(jsonLoad)], { silent: true });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', d => { stdout += d.toString(); });
    p.stderr.on('data', d => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('exit', code => {
      if (code !== 0) {
        return reject(new Error(`JS scanner exit ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
      }
      resolve({ stdout, stderr });
    });
  });
}

function querySource(dbPath, filepath) {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare('SELECT source FROM tracks WHERE filepath = ?').get(filepath);
    return row ? row.source : undefined;
  } finally {
    db.close();
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('V36 ytdl provenance — end-to-end', () => {

  test('detectSource(): MSTREAM_SOURCE wins over purl', () => {
    // Direct unit test of the JS detector — independent of any fixture.
    assert.equal(detectSource({
      native: {
        vorbis: [
          { id: 'MSTREAM_SOURCE', value: 'ytdl' },
          { id: 'PURL', value: 'https://www.youtube.com/watch?v=abc' },
        ],
      },
    }), 'ytdl');

    // purl-only fallback for files written by plain `yt-dlp` CLI.
    assert.equal(detectSource({
      native: {
        vorbis: [
          { id: 'PURL', value: 'https://www.youtube.com/watch?v=xyz' },
        ],
      },
    }), 'ytdl');

    // youtu.be short form.
    assert.equal(detectSource({
      native: {
        vorbis: [
          { id: 'PURL', value: 'https://youtu.be/abc123' },
        ],
      },
    }), 'ytdl');

    // Non-YouTube purl: don't infer ytdl.
    assert.equal(detectSource({
      native: {
        vorbis: [
          { id: 'PURL', value: 'https://soundcloud.com/foo/bar' },
        ],
      },
    }), null);

    // No marker at all.
    assert.equal(detectSource({ native: { vorbis: [{ id: 'TITLE', value: 'X' }] } }), null);

    // ID3v2 TXXX-prefixed form.
    assert.equal(detectSource({
      native: {
        'ID3v2.3': [{ id: 'TXXX:MSTREAM_SOURCE', value: 'ytdl' }],
      },
    }), 'ytdl');

    // ID3v2 TXXX object form (older music-metadata).
    assert.equal(detectSource({
      native: {
        'ID3v2.3': [
          { id: 'TXXX', value: { description: 'MSTREAM_SOURCE', text: ['ytdl'] } },
        ],
      },
    }), 'ytdl');

    // MP4 freeform iTunes atom. The detector handles this branch
    // correctly when the atom exists — but note that ffmpeg's MP4
    // muxer silently drops non-standard `-metadata` keys on write,
    // so files produced by the ytdl handler's ffmpeg pass won't carry
    // this atom. Files tagged externally via mutagen / AtomicParsley
    // DO produce a recoverable freeform atom; this assertion covers
    // that read-path. See src/api/ytdl.js for the write-side
    // limitation and src/db/source-detect.js for the asymmetry note.
    assert.equal(detectSource({
      native: {
        iTunes: [
          { id: '----:com.apple.iTunes:MSTREAM_SOURCE', value: 'ytdl' },
        ],
      },
    }), 'ytdl');

    // Case-insensitivity parity with the Rust scanner — files tagged
    // with a lowercase or mixed-case `mstream_source` MUST still match.
    // Without the .toUpperCase() in matchesMstreamSource, Rust and JS
    // would disagree on these inputs and produce different tracks.source
    // values depending on which scanner ran the file.
    assert.equal(detectSource({
      native: { vorbis: [{ id: 'mstream_source', value: 'ytdl' }] },
    }), 'ytdl');
    assert.equal(detectSource({
      native: { vorbis: [{ id: 'Mstream_Source', value: 'ytdl' }] },
    }), 'ytdl');
    assert.equal(detectSource({
      native: { 'ID3v2.3': [{ id: 'txxx:mstream_source', value: 'ytdl' }] },
    }), 'ytdl');
  });

  test('FLAC: MSTREAM_SOURCE tag is read back into tracks.source', async (t) => {
    if (!fs.existsSync(FFMPEG)) { return t.skip('no bundled ffmpeg'); }
    const dir = path.join(libRoot, 't1-flac');
    await fsp.rm(dir, { recursive: true, force: true });
    const file = path.join(dir, 'flac-ytdl.flac');
    await makeAudio(file, FLAC, {
      title: 'YT FLAC', artist: 'Tester', album: 'V36',
      MSTREAM_SOURCE: 'ytdl',
    });

    // Sanity check: music-metadata sees the marker as a Vorbis comment.
    const parsed = await parseFile(file);
    const detected = detectSource(parsed);
    assert.equal(detected, 'ytdl',
      'detectSource() must recognise the FLAC Vorbis MSTREAM_SOURCE marker. ' +
      `Got ${JSON.stringify(detected)}; native keys: ${JSON.stringify(Object.keys(parsed.native || {}))}`);

    const dbPath = path.join(dbDir, 't1-flac.db');
    const { libraryId, vpath } = initEmptyDb(dbPath, dir, 't1');
    await runScannerAgainst(dir, dbPath, libraryId, vpath);
    assert.equal(querySource(dbPath, 'flac-ytdl.flac'), 'ytdl');
  });

  test('MP3: TXXX MSTREAM_SOURCE tag is read back into tracks.source', async (t) => {
    if (!fs.existsSync(FFMPEG)) { return t.skip('no bundled ffmpeg'); }
    const dir = path.join(libRoot, 't2-mp3');
    await fsp.rm(dir, { recursive: true, force: true });
    const file = path.join(dir, 'mp3-ytdl.mp3');
    await makeAudio(file, MP3, {
      title: 'YT MP3', artist: 'Tester', album: 'V36',
      MSTREAM_SOURCE: 'ytdl',
    });

    const parsed = await parseFile(file);
    const detected = detectSource(parsed);
    assert.equal(detected, 'ytdl',
      'detectSource() must recognise the MP3 TXXX MSTREAM_SOURCE marker. ' +
      `Got ${JSON.stringify(detected)}; native keys: ${JSON.stringify(Object.keys(parsed.native || {}))}`);

    const dbPath = path.join(dbDir, 't2-mp3.db');
    const { libraryId, vpath } = initEmptyDb(dbPath, dir, 't2');
    await runScannerAgainst(dir, dbPath, libraryId, vpath);
    assert.equal(querySource(dbPath, 'mp3-ytdl.mp3'), 'ytdl');
  });

  test('OGG (Vorbis): MSTREAM_SOURCE tag is read back', async (t) => {
    if (!fs.existsSync(FFMPEG)) { return t.skip('no bundled ffmpeg'); }
    const dir = path.join(libRoot, 't3-ogg');
    await fsp.rm(dir, { recursive: true, force: true });
    const file = path.join(dir, 'ogg-ytdl.ogg');
    await makeAudio(file, OGG, {
      title: 'YT OGG', artist: 'Tester', album: 'V36',
      MSTREAM_SOURCE: 'ytdl',
    });

    const dbPath = path.join(dbDir, 't3-ogg.db');
    const { libraryId, vpath } = initEmptyDb(dbPath, dir, 't3');
    await runScannerAgainst(dir, dbPath, libraryId, vpath);
    assert.equal(querySource(dbPath, 'ogg-ytdl.ogg'), 'ytdl');
  });

  // M4A note: ffmpeg's MP4 muxer silently drops non-standard `-metadata`
  // keys on write (verified via ffprobe — MSTREAM_SOURCE, purl, and
  // ----:com.apple.iTunes:KEY all vanish). The READ path handles
  // freeform iTunes atoms fine, but we cannot synthesise such a file
  // from ffmpeg alone. So the M4A end-to-end case is the documented
  // gap: tracks.source comes back NULL after a re-extract. The handler
  // still attributes the row via INSERT (source='ytdl'), and the
  // scanner's mtime fast-path preserves that across normal rescans.
  test('M4A (documented gap): ffmpeg-written MSTREAM_SOURCE is silently dropped', async (t) => {
    if (!fs.existsSync(FFMPEG)) { return t.skip('no bundled ffmpeg'); }
    const dir = path.join(libRoot, 't4-m4a');
    await fsp.rm(dir, { recursive: true, force: true });
    const file = path.join(dir, 'm4a-ytdl.m4a');
    await makeAudio(file, M4A, {
      title: 'YT M4A', artist: 'Tester', album: 'V36',
      MSTREAM_SOURCE: 'ytdl',
    });

    const dbPath = path.join(dbDir, 't4-m4a.db');
    const { libraryId, vpath } = initEmptyDb(dbPath, dir, 't4');
    await runScannerAgainst(dir, dbPath, libraryId, vpath);
    // Document the limitation: scanner reads NULL because the tag
    // never landed in the file. If a future ffmpeg release or muxer
    // option starts honouring freeform atoms via `-metadata`, this
    // expectation will need to flip to 'ytdl' — that's a real
    // improvement, not a regression.
    assert.equal(querySource(dbPath, 'm4a-ytdl.m4a'), null);
  });

  test('purl fallback: youtube.com URL with no MSTREAM_SOURCE → ytdl', async (t) => {
    if (!fs.existsSync(FFMPEG)) { return t.skip('no bundled ffmpeg'); }
    const dir = path.join(libRoot, 't5-purl');
    await fsp.rm(dir, { recursive: true, force: true });
    const file = path.join(dir, 'flac-purl.flac');
    await makeAudio(file, FLAC, {
      title: 'YT FLAC purl', artist: 'Tester', album: 'V36',
      purl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    });

    const dbPath = path.join(dbDir, 't5-purl.db');
    const { libraryId, vpath } = initEmptyDb(dbPath, dir, 't5');
    await runScannerAgainst(dir, dbPath, libraryId, vpath);
    assert.equal(querySource(dbPath, 'flac-purl.flac'), 'ytdl',
      'A FLAC with no MSTREAM_SOURCE but a youtube.com purl should be inferred as ytdl');
  });

  test('no marker: tracks.source stays NULL', async (t) => {
    if (!fs.existsSync(FFMPEG)) { return t.skip('no bundled ffmpeg'); }
    const dir = path.join(libRoot, 't6-clean');
    await fsp.rm(dir, { recursive: true, force: true });
    const file = path.join(dir, 'flac-clean.flac');
    await makeAudio(file, FLAC, {
      title: 'No marker', artist: 'Tester', album: 'V36',
    });

    const dbPath = path.join(dbDir, 't6-clean.db');
    const { libraryId, vpath } = initEmptyDb(dbPath, dir, 't6');
    await runScannerAgainst(dir, dbPath, libraryId, vpath);
    assert.equal(querySource(dbPath, 'flac-clean.flac'), null);
  });

  test('scanner round-trip: mtime change forces re-extract — source survives', async (t) => {
    if (!fs.existsSync(FFMPEG)) { return t.skip('no bundled ffmpeg'); }
    // This is the test the user explicitly called out: a file marked
    // 'ytdl' is scanned once, then has its mtime bumped (forcing the
    // scanner off the fast path into full re-extraction via INSERT OR
    // REPLACE), then scanned again. Without the tag-readback wiring,
    // the INSERT OR REPLACE would wipe the source column. With it,
    // the scanner re-reads the marker tag and re-populates source.
    const dir = path.join(libRoot, 't7-roundtrip');
    await fsp.rm(dir, { recursive: true, force: true });
    const file = path.join(dir, 'flac-roundtrip.flac');
    await makeAudio(file, FLAC, {
      title: 'Roundtrip', artist: 'Tester', album: 'V36',
      MSTREAM_SOURCE: 'ytdl',
    });

    const dbPath = path.join(dbDir, 't7-roundtrip.db');
    const { libraryId, vpath } = initEmptyDb(dbPath, dir, 't7');
    await runScannerAgainst(dir, dbPath, libraryId, vpath);
    assert.equal(querySource(dbPath, 'flac-roundtrip.flac'), 'ytdl',
      'first scan should populate source from the embedded tag');

    // Bump mtime so the scanner takes the re-extract branch (vs. the
    // no-write fast path). Future timestamp so it can't tie.
    const future = new Date(Date.now() + 120_000);
    await fsp.utimes(file, future, future);

    await runScannerAgainst(dir, dbPath, libraryId, vpath);
    assert.equal(querySource(dbPath, 'flac-roundtrip.flac'), 'ytdl',
      'after a forced re-extract, source must still be ytdl — proves the scanner re-reads the marker tag rather than depending on prior column state');
  });
});
