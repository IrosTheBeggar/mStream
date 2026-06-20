/**
 * Parity test: src/db/audio-hash.js (JS) and rust-parser/src/main.rs (Rust)
 * MUST produce byte-identical hashes for the same input file. If they ever
 * drift — even by one byte in the audio-region selection — users lose
 * their user_metadata / user_bookmarks / user_play_queue state whenever the
 * scanner path changes (bin/rust-parser missing → falls back to JS, etc.),
 * which is catastrophic silent data loss.
 *
 * This test generates a fixture in every supported format, runs both
 * implementations over each, and asserts:
 *
 *   - file_hash equal (always — both just MD5 the whole file)
 *   - audio_hash equal (for MP3 + FLAC the extractor covers; for others
 *     both must agree on null — audio_hash isn't supported)
 *
 * The Rust side is invoked via a hidden CLI subcommand `rust-parser
 * --audio-hash <file>` that prints the dual-hash result as JSON. If the
 * binary is missing the test is skipped (CI environments without rust
 * toolchain still see JS-only coverage via hash-migration.test.mjs).
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { computeHashes } from '../../src/db/audio-hash.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const FFMPEG =
  process.platform === 'win32' ? path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg.exe')
                               : path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg');

// Prefer the freshly-built dev binary if present; fall back to the prebuilt
// shipped under bin/rust-parser/. Either must be the version that has the
// `--audio-hash` subcommand (added in this same commit), so the dev binary
// is the source of truth during development.
function findRustParser() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const libc = process.platform === 'linux' ? '-musl' : '';
  const candidates = [
    path.join(REPO_ROOT, 'rust-parser', 'target', 'release', `rust-parser${ext}`),
    path.join(REPO_ROOT, 'bin', 'rust-parser',
      `rust-parser-${process.platform}-${process.arch}${libc}${ext}`),
  ].filter(p => fsSync.existsSync(p));

  // Probe each candidate for the `--audio-hash` subcommand. A stale
  // local build (compiled before the subcommand was added) falls
  // through to the main JSON-input path and exits 1 with "Invalid
  // JSON Input" on stderr. Any other response means the subcommand
  // is recognised — distinguish by the stderr signature so this
  // works whether the probe path exists or not (the current binary
  // returns exit 2 + "compute_hashes failed" for a missing file,
  // which is still fine for our purposes).
  for (const bin of candidates) {
    try {
      const result = spawnSync(bin, ['--audio-hash', path.join(REPO_ROOT, 'NONEXISTENT_PROBE_FILE')],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
      const stderr = (result.stderr || '').toString();
      if (!/Invalid JSON Input/.test(stderr)) { return bin; }
    } catch (_) { /* try next candidate */ }
  }
  return null;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', d => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('exit', code => {
      if (code === 0) { resolve(); }
      else { reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`)); }
    });
  });
}

function runRustHash(rustBin, filepath) {
  return new Promise((resolve, reject) => {
    const p = spawn(rustBin, ['--audio-hash', filepath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', d => { stdout += d.toString(); });
    p.stderr.on('data', d => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('exit', code => {
      if (code !== 0) { return reject(new Error(`rust-parser --audio-hash exit ${code}: ${stderr}`)); }
      try { resolve(JSON.parse(stdout)); }
      catch (err) { reject(new Error(`bad rust JSON: ${stdout}: ${err.message}`)); }
    });
  });
}

// Each format gets the simplest ffmpeg recipe that produces a valid file
// with plausible metadata — matches what the scanner will see in the real
// world. audioHashSupported=true means the extractor must emit a non-null
// audio_hash AND that hash must differ from file_hash (otherwise the
// extractor didn't actually strip any metadata region).
const FORMATS = [
  { ext: 'mp3',  audioHashSupported: true,
    ffArgs: ['-c:a', 'libmp3lame', '-b:a', '64k', '-id3v2_version', '3',
             '-metadata', 'title=MP3 Fixture', '-metadata', 'artist=Tester'] },
  { ext: 'flac', audioHashSupported: true,
    ffArgs: ['-c:a', 'flac',
             '-metadata', 'title=FLAC Fixture', '-metadata', 'artist=Tester'] },
  { ext: 'wav',  audioHashSupported: true,
    // Raw PCM wav; data-chunk-only hash will differ from whole-file hash
    // because of the 12-byte RIFF/WAVE header + fmt chunk.
    ffArgs: ['-c:a', 'pcm_s16le'] },
  { ext: 'ogg',  audioHashSupported: true,
    ffArgs: ['-c:a', 'libvorbis', '-metadata', 'title=OGG Fixture',
             '-metadata', 'artist=Tester'] },
  { ext: 'opus', audioHashSupported: true,
    ffArgs: ['-c:a', 'libopus', '-b:a', '64k', '-f', 'opus',
             '-metadata', 'title=Opus Fixture'] },
  { ext: 'm4a',  audioHashSupported: true,
    ffArgs: ['-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart',
             '-metadata', 'title=M4A Fixture', '-metadata', 'artist=Tester'] },
  // .aac as raw ADTS — no container tags by default from ffmpeg, so the
  // stripped region is empty and audio_hash equals file_hash. That is
  // expected and correct; no assertion that they differ.
  { ext: 'aac',  audioHashSupported: true, allowEqualToFileHash: true,
    ffArgs: ['-c:a', 'aac', '-b:a', '64k', '-f', 'adts'] },
];

let tmpDir;
let rustBin;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-hash-parity-'));
  rustBin = findRustParser();
});

after(async () => {
  if (tmpDir) { await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); }
});

describe('JS ↔ Rust audio-hash parity across all supported formats', () => {
  for (const fmt of FORMATS) {
    test(`${fmt.ext}: file_hash and audio_hash match between JS and Rust`, async (t) => {
      if (!fsSync.existsSync(FFMPEG)) { return t.skip(`no bundled ffmpeg at ${FFMPEG}`); }
      if (!rustBin)                   { return t.skip('no rust-parser binary available'); }

      // Build a fresh fixture in tmpDir for this format.
      const fixturePath = path.join(tmpDir, `fixture.${fmt.ext}`);
      await runFfmpeg([
        '-nostdin', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
        '-t', '1',
        ...fmt.ffArgs,
        fixturePath,
      ]);

      const js   = await computeHashes(fixturePath);
      const rust = await runRustHash(rustBin, fixturePath);

      assert.equal(js.fileHash, rust.fileHash,
        `${fmt.ext}: file_hash diverged between JS and Rust (js=${js.fileHash}, rust=${rust.fileHash})`);

      if (fmt.audioHashSupported) {
        assert.ok(js.audioHash,   `${fmt.ext}: JS audio_hash should be set`);
        assert.ok(rust.audioHash, `${fmt.ext}: Rust audio_hash should be set`);
        assert.equal(js.audioHash, rust.audioHash,
          `${fmt.ext}: audio_hash diverged (js=${js.audioHash}, rust=${rust.audioHash})`);
        // audio_hash must differ from file_hash so we know the extractor
        // actually stripped a region — unless the format carries no tags
        // by default (raw ADTS, which ffmpeg emits without any ID3 wrapper).
        if (!fmt.allowEqualToFileHash) {
          assert.notEqual(js.audioHash, js.fileHash,
            `${fmt.ext}: audio_hash equals file_hash — extractor didn't strip any region`);
        }
      } else {
        assert.equal(js.audioHash, null,
          `${fmt.ext}: JS audio_hash should be null (extractor not implemented)`);
        assert.equal(rust.audioHash, null,
          `${fmt.ext}: Rust audio_hash should be null (extractor not implemented)`);
      }
    });
  }

  test('MP3 audio_hash survives a tag rewrite (same audio bytes → same audio_hash)', async (t) => {
    if (!fsSync.existsSync(FFMPEG)) { return t.skip(); }
    if (!rustBin)                   { return t.skip(); }

    // Generate two MP3s from the same audio source but with different ID3
    // tags. file_hash must differ; audio_hash must be identical.
    const a = path.join(tmpDir, 'tagA.mp3');
    const b = path.join(tmpDir, 'tagB.mp3');
    const common = ['-nostdin', '-y', '-loglevel', 'error',
                    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '1',
                    '-c:a', 'libmp3lame', '-b:a', '64k', '-id3v2_version', '3'];
    await runFfmpeg([...common,
      '-metadata', 'title=Original', '-metadata', 'artist=Artist A',
      '-metadata', 'album=Album A', a]);
    await runFfmpeg([...common,
      '-metadata', 'title=Edited Title', '-metadata', 'artist=Artist B',
      '-metadata', 'album=Album B Long Name That Makes The Tag Bigger',
      b]);

    const jsA = await computeHashes(a);
    const jsB = await computeHashes(b);
    const rustA = await runRustHash(rustBin, a);
    const rustB = await runRustHash(rustBin, b);

    assert.notEqual(jsA.fileHash, jsB.fileHash, 'file_hash should differ — tag bytes differ');
    assert.equal(jsA.audioHash, jsB.audioHash, 'audio_hash should match — audio payload is identical');
    assert.equal(rustA.audioHash, rustB.audioHash, 'Rust also sees identical audio_hash');
    assert.equal(jsA.audioHash, rustA.audioHash, 'JS and Rust agree');
  });

  test('FLAC audio_hash survives a metadata-block rewrite', async (t) => {
    if (!fsSync.existsSync(FFMPEG)) { return t.skip(); }
    if (!rustBin)                   { return t.skip(); }

    const a = path.join(tmpDir, 'flacA.flac');
    const b = path.join(tmpDir, 'flacB.flac');
    const common = ['-nostdin', '-y', '-loglevel', 'error',
                    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '1',
                    '-c:a', 'flac'];
    await runFfmpeg([...common, '-metadata', 'title=First',  a]);
    await runFfmpeg([...common, '-metadata', 'title=Second — with a much longer Vorbis comment', b]);

    const jsA = await computeHashes(a);
    const jsB = await computeHashes(b);
    const rustA = await runRustHash(rustBin, a);
    const rustB = await runRustHash(rustBin, b);

    assert.notEqual(jsA.fileHash, jsB.fileHash);
    assert.equal(jsA.audioHash, jsB.audioHash);
    assert.equal(rustA.audioHash, rustB.audioHash);
    assert.equal(jsA.audioHash, rustA.audioHash);
  });

  // ── Tag-rewrite stability for every supported format ─────────────────
  // Parametrised so each format's exercise uses the same assertions:
  // same audio input + different tags → file_hash diverges, audio_hash
  // stays stable between the two files AND between JS and Rust.
  //
  // Each entry gives:
  //   ext:         file extension / scanner format key
  //   baseArgs:    ffmpeg codec/container args that DON'T depend on tags
  //   tagsA:       tag metadata flags for the "before" file
  //   tagsB:       tag metadata flags for the "after" (edited) file;
  //                also deliberately longer/different text so the tag
  //                region grows, to stress the "payload position drifts"
  //                edge case (matters for Ogg and MP4).
  const TAG_REWRITE_CASES = [
    { ext: 'wav',
      baseArgs: ['-c:a', 'pcm_s16le'],
      // WAV + ffmpeg writes metadata into an INFO LIST chunk.
      tagsA: ['-metadata', 'title=First', '-metadata', 'artist=A'],
      tagsB: ['-metadata', 'title=Second longer title', '-metadata', 'artist=B with description',
              '-metadata', 'comment=Added a long trailing comment to grow the LIST chunk'] },
    { ext: 'ogg',
      baseArgs: ['-c:a', 'libvorbis'],
      tagsA: ['-metadata', 'title=A', '-metadata', 'artist=One'],
      tagsB: ['-metadata', 'title=Second with a much longer title that will push the comment packet across more bytes',
              '-metadata', 'artist=Two', '-metadata', 'album=Adding an album tag too'] },
    { ext: 'opus',
      baseArgs: ['-c:a', 'libopus', '-b:a', '64k', '-f', 'opus'],
      tagsA: ['-metadata', 'title=A'],
      tagsB: ['-metadata', 'title=Second longer title', '-metadata', 'artist=B'] },
    { ext: 'm4a',
      baseArgs: ['-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart'],
      tagsA: ['-metadata', 'title=First', '-metadata', 'artist=A'],
      tagsB: ['-metadata', 'title=Second with more text', '-metadata', 'artist=B',
              '-metadata', 'album=Yet another album tag'] },
  ];

  for (const c of TAG_REWRITE_CASES) {
    test(`${c.ext} audio_hash survives a tag rewrite`, async (t) => {
      if (!fsSync.existsSync(FFMPEG)) { return t.skip(); }
      if (!rustBin)                   { return t.skip(); }

      const a = path.join(tmpDir, `tagA.${c.ext}`);
      const b = path.join(tmpDir, `tagB.${c.ext}`);
      const common = ['-nostdin', '-y', '-loglevel', 'error',
                      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '1',
                      ...c.baseArgs];
      await runFfmpeg([...common, ...c.tagsA, a]);
      await runFfmpeg([...common, ...c.tagsB, b]);

      const jsA = await computeHashes(a);
      const jsB = await computeHashes(b);
      const rustA = await runRustHash(rustBin, a);
      const rustB = await runRustHash(rustBin, b);

      assert.notEqual(jsA.fileHash, jsB.fileHash,
        `${c.ext}: file_hash should differ when tags differ`);
      assert.equal(jsA.audioHash, jsB.audioHash,
        `${c.ext}: JS audio_hash should be stable across a tag rewrite (A=${jsA.audioHash}, B=${jsB.audioHash})`);
      assert.equal(rustA.audioHash, rustB.audioHash,
        `${c.ext}: Rust audio_hash should be stable across a tag rewrite`);
      assert.equal(jsA.audioHash, rustA.audioHash,
        `${c.ext}: JS and Rust should agree on audio_hash`);
    });
  }
});
