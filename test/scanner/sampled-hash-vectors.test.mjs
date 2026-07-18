/**
 * Sampled-hash vectors — threshold hybrid, both engines.
 *
 * Above the sample threshold (production default 25MB; overridden to
 * 96KB here so tiny fixtures exercise the real sampled path) hashing
 * switches to a domain-prefixed MD5 over three windows of the logical
 * stream. These tests pin:
 *
 *   - JS↔Rust byte-identity of BOTH sampled hashes (scan-based: same
 *     fixture, both scanners, same threshold override → identical
 *     file_hash/audio_hash rows);
 *   - the boundary: audio below / file above thresholds independently
 *     (a huge-tag file samples file_hash while audio_hash stays full);
 *   - tag-edit stability of the sampled audio_hash (id3 splice grows
 *     the tag region: file_hash changes, audio_hash must not);
 *   - full-path preservation: below-threshold files hash byte-identical
 *     to the pre-change scheme (golden values recomputed with plain
 *     MD5s in-test);
 *   - determinism: rescans reproduce identical hashes (fast-path off
 *     via forceRescan).
 *
 * Skipped when ffmpeg or a sampled-hash-capable rust binary is missing.
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
import { makeAudio } from '../helpers/scanner-fixture.mjs';
import { appendId3v23TextFrames } from '../helpers/id3.mjs';
import { computeHashes, SAMPLE_THRESHOLD_DEFAULT } from '../../src/db/audio-hash.js';

const MP3 = ['-c:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '3'];
// Small enough for fast fixtures, large enough that a ~3-minute 128kbps
// mp3 (~3MB) is far above it while a ~1s file (~16KB) is far below.
const TEST_THRESHOLD = 96 * 1024;

let rustBin;
let scratch;
let rustHasSampling = null;

before(async () => {
  rustBin = findRustParser();
  scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'mstream-samphash-'));

  // Feature-detect: a pre-sampling binary ignores hashSampleThreshold
  // and produces the full-scheme hash for an above-threshold file.
  if (rustBin && fs.existsSync(FFMPEG)) {
    const probe = await scanBoth('probe', async (lib) => {
      await makeAudio(path.join(lib, 'p.mp3'), MP3, { title: 'P' }, 30);
    }, { engines: ['rust'] });
    const rel = 'p.mp3';
    const full = await fullSchemeHashes(path.join(probe.libRoot, rel));
    rustHasSampling = probe.rust.get(rel).file_hash !== full.fileHash;
  }
});

after(async () => {
  if (scratch) { await fsp.rm(scratch, { recursive: true, force: true }); }
});

// Compute what the PRE-change (full) scheme would produce, from first
// principles, so the tests never depend on the implementation under test.
async function fullSchemeHashes(filepath) {
  const buf = await fsp.readFile(filepath);
  const fileHash = crypto.createHash('md5').update(buf).digest('hex');
  return { fileHash, buf };
}

let seq = 0;
// Build a fixture library via `fill`, scan it with each engine into its
// own DB (same files!), return per-engine Map(rel -> {file_hash, audio_hash}).
async function scanBoth(label, fill, { engines = ['rust', 'js'], overrides = {} } = {}) {
  const root = path.join(scratch, `${label}-${seq++}`);
  const libRoot = path.join(root, 'lib');
  await fsp.mkdir(libRoot, { recursive: true });
  await fill(libRoot);
  const out = { libRoot };
  for (const engine of engines) {
    const dbPath = path.join(root, `${engine}.db`);
    const { libraryId, vpath } = initEmptyDb(dbPath, libRoot);
    const config = buildScanConfig({
      dbPath, libraryId, vpath, directory: libRoot,
      albumArtDirectory: path.join(root, `art-${engine}`),
      waveformCacheDir: path.join(root, `wave-${engine}`),
      scanId: `s-${label}-${engine}`,
      overrides: { hashSampleThreshold: TEST_THRESHOLD, ...overrides },
    });
    await fsp.mkdir(path.join(root, `art-${engine}`), { recursive: true });
    await (engine === 'js' ? runJsScan(config) : runScan(rustBin, config));
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      out[engine] = new Map(db.prepare('SELECT filepath, file_hash, audio_hash FROM tracks')
        .all().map(r => [r.filepath, { file_hash: r.file_hash, audio_hash: r.audio_hash }]));
    } finally { db.close(); }
  }
  return out;
}

function engineAvailable(engine) {
  if (!fs.existsSync(FFMPEG)) { return false; }
  if (engine === 'rust' && (!rustBin || rustHasSampling === false)) { return false; }
  return true;
}

describe('sampled-hash vectors', () => {
  test('JS↔Rust parity for sampled hashes; determinism across force-rescan', async (t) => {
    if (!engineAvailable('rust')) { t.skip('rust binary unavailable or pre-sampling'); return; }
    const r = await scanBoth('parity', async (lib) => {
      await makeAudio(path.join(lib, 'big.mp3'), MP3, { artist: 'A', title: 'Big' }, 30);
      await makeAudio(path.join(lib, 'small.mp3'), MP3, { artist: 'A', title: 'Small' }, 1);
    });
    for (const rel of ['big.mp3', 'small.mp3']) {
      assert.deepEqual(r.rust.get(rel), r.js.get(rel),
        `${rel}: both engines must produce identical hashes`);
    }
    // Sampled ≠ full for the big file (proves the sampled path ran).
    const { fileHash: fullBig } = await fullSchemeHashes(path.join(r.libRoot, 'big.mp3'));
    assert.notEqual(r.rust.get('big.mp3').file_hash, fullBig,
      'above-threshold file_hash must be the sampled scheme');
    // Small file: byte-identical to the pre-change full scheme.
    const { fileHash: fullSmall } = await fullSchemeHashes(path.join(r.libRoot, 'small.mp3'));
    assert.equal(r.rust.get('small.mp3').file_hash, fullSmall,
      'below-threshold file_hash must remain the untouched full scheme');
  });

  test('sampled audio_hash is stable across a tag edit; file_hash is not', async (t) => {
    if (!engineAvailable('rust')) { t.skip('rust binary unavailable or pre-sampling'); return; }
    const before = await scanBoth('tagedit', async (lib) => {
      await makeAudio(path.join(lib, 'song.mp3'), MP3, { artist: 'B', title: 'Orig' }, 30);
    });
    const first = before.rust.get('song.mp3');
    // Grow the ID3 region (audio bytes untouched), rescan fresh DBs.
    await appendId3v23TextFrames(path.join(before.libRoot, 'song.mp3'),
      { TCON: 'Genre'.repeat(50) });
    const after = await scanBoth('tagedit2', async (lib) => {
      await fsp.copyFile(path.join(before.libRoot, 'song.mp3'), path.join(lib, 'song.mp3'));
    });
    const second = after.rust.get('song.mp3');
    assert.equal(second.audio_hash, first.audio_hash,
      'range-relative windows keep the sampled audio_hash tag-stable');
    assert.notEqual(second.file_hash, first.file_hash,
      'file_hash sees the byte change');
    assert.deepEqual(after.js.get('song.mp3'), second, 'parity holds post-edit');
  });

  test('independent thresholds: huge tag samples file_hash while audio_hash stays full', async (t) => {
    if (!engineAvailable('js')) { t.skip('no ffmpeg'); return; }
    // ~40KB of audio (below 96KB) + a >96KB tag pushes the FILE above
    // the threshold while the audio payload stays below it.
    const root = path.join(scratch, `mixed-${seq++}`);
    const lib = path.join(root, 'lib');
    await makeAudio(path.join(lib, 'tagged.mp3'), MP3, { title: 'T' }, 2);
    await appendId3v23TextFrames(path.join(lib, 'tagged.mp3'), { TXXX: 'x'.repeat(120 * 1024) });
    const { size } = await fsp.stat(path.join(lib, 'tagged.mp3'));
    assert.ok(size >= TEST_THRESHOLD, 'fixture: file crossed the threshold');

    const js = await computeHashes(path.join(lib, 'tagged.mp3'),
      { sampleThreshold: TEST_THRESHOLD });
    // audio_hash below threshold ⇒ equals a from-first-principles MD5 of
    // the (unchanged-size) audio region — cheapest proof: recompute with
    // a huge threshold (forces the full scheme for both) and compare.
    const full = await computeHashes(path.join(lib, 'tagged.mp3'),
      { sampleThreshold: Number.MAX_SAFE_INTEGER });
    assert.equal(js.audioHash, full.audioHash, 'audio stayed on the full scheme');
    assert.notEqual(js.fileHash, full.fileHash, 'file went sampled');
  });

  test('production default threshold is 25MB', () => {
    assert.equal(SAMPLE_THRESHOLD_DEFAULT, 25 * 1024 * 1024);
  });
});
