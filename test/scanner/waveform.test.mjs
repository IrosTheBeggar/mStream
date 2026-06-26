/**
 * Coverage test for rust-parser's symphonia-based waveform generator.
 *
 * For each audio format mStream supports, this test synthesises a fresh
 * fixture with ffmpeg (a 1-second 440 Hz tone, moderate volume), invokes
 * the hidden `rust-parser --waveform <path>` subcommand, and asserts:
 *
 *   - Output is a fixed-length 800-byte array of u8 peaks (after hex decode).
 *   - Non-silent input produces non-trivial peaks (guards against a regression
 *     where the decoder loop exits before consuming any frames — which would
 *     silently produce an all-zero file).
 *   - Running the same file twice produces byte-identical output (catches a
 *     whole class of "decoder state leaked between runs" bugs).
 *   - `.opus` returns `{ bars: null }` — we deliberately skip Opus in Rust
 *     because symphonia 0.5 has no pure-Rust decoder for it.
 *
 * The Rust side is invoked via the hidden CLI subcommand `rust-parser
 * --waveform <file>` that prints JSON on stdout. If the binary is missing
 * the test is skipped — CI environments without a rust toolchain still
 * see coverage on the JS waveform cache helpers via the existing
 * integration tests.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const FFMPEG =
  process.platform === 'win32' ? path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg.exe')
                               : path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg');

function findRustParser() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const libc = process.platform === 'linux' ? '-musl' : '';
  const candidates = [
    path.join(REPO_ROOT, 'rust-parser', 'target', 'release', `rust-parser${ext}`),
    path.join(REPO_ROOT, 'bin', 'rust-parser',
      `rust-parser-${process.platform}-${process.arch}${libc}${ext}`),
  ].filter(p => fsSync.existsSync(p));

  // Probe each candidate for the `--waveform` subcommand. A stale
  // local build (compiled before --waveform was added) falls through
  // to the main JSON-input path and exits 1 with "Invalid JSON Input"
  // on stderr. Any other response — success, or a different error —
  // means the subcommand is recognised. Distinguish by the stderr
  // signature rather than status code so we work whether the probe
  // path exists or not.
  for (const bin of candidates) {
    try {
      const result = spawnSync(bin, ['--waveform', path.join(REPO_ROOT, 'NONEXISTENT_PROBE_FILE')],
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

function runRustWaveform(rustBin, filepath) {
  return new Promise((resolve, reject) => {
    const p = spawn(rustBin, ['--waveform', filepath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', d => { stdout += d.toString(); });
    p.stderr.on('data', d => { stderr += d.toString(); });
    p.on('error', reject);
    // 'close' (not 'exit') so stdout is fully drained before we JSON.parse it.
    p.on('close', code => {
      if (code !== 0) { return reject(new Error(`rust-parser --waveform exit ${code}: ${stderr}`)); }
      try { resolve(JSON.parse(stdout)); }
      catch (err) { reject(new Error(`bad rust JSON: ${stdout}: ${err.message}`)); }
    });
  });
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// Each format gets the simplest ffmpeg recipe that produces a file shaped
// like the real-world content mStream sees. Source signal is a 440 Hz sine
// wave at moderate volume so the decoded peaks are clearly non-zero across
// every bar.
//
// opus is the odd one out — it's expected to return null because
// symphonia 0.5 lacks an Opus decoder. All other formats must produce
// valid 800-byte outputs.
const FORMATS = [
  { ext: 'mp3',  shouldHaveBars: true,
    ffArgs: ['-c:a', 'libmp3lame', '-b:a', '64k', '-id3v2_version', '3'] },
  { ext: 'flac', shouldHaveBars: true,
    ffArgs: ['-c:a', 'flac'] },
  { ext: 'wav',  shouldHaveBars: true,
    ffArgs: ['-c:a', 'pcm_s16le'] },
  { ext: 'ogg',  shouldHaveBars: true,
    ffArgs: ['-c:a', 'libvorbis'] },
  { ext: 'm4a',  shouldHaveBars: true,
    ffArgs: ['-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart'] },
  { ext: 'aac',  shouldHaveBars: true,
    ffArgs: ['-c:a', 'aac', '-b:a', '64k', '-f', 'adts'] },
  // Opus — symphonia 0.5 can't decode this, so --waveform must return null.
  { ext: 'opus', shouldHaveBars: false,
    ffArgs: ['-c:a', 'libopus', '-b:a', '64k', '-f', 'opus'] },
];

const NUM_BARS = 800;

let tmpDir;
let rustBin;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'waveform-test-'));
  rustBin = findRustParser();
});

after(async () => {
  if (tmpDir) { await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); }
});

describe('rust-parser --waveform across supported formats', () => {
  for (const fmt of FORMATS) {
    test(`${fmt.ext}: produces ${fmt.shouldHaveBars ? `a ${NUM_BARS}-byte waveform` : 'null (skipped)'}`, async (t) => {
      if (!fsSync.existsSync(FFMPEG)) { return t.skip(`no bundled ffmpeg at ${FFMPEG}`); }
      if (!rustBin)                   { return t.skip('no rust-parser binary available'); }

      const fixturePath = path.join(tmpDir, `fixture.${fmt.ext}`);
      await runFfmpeg([
        '-nostdin', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=44100',
        ...fmt.ffArgs,
        fixturePath,
      ]);

      const out = await runRustWaveform(rustBin, fixturePath);

      if (!fmt.shouldHaveBars) {
        assert.equal(out.bars, null,
          `${fmt.ext}: expected null bars (skipped) but got something`);
        return;
      }

      assert.ok(typeof out.bars === 'string',
        `${fmt.ext}: expected bars string, got ${typeof out.bars}`);
      assert.equal(out.bars.length, NUM_BARS * 2,
        `${fmt.ext}: expected ${NUM_BARS * 2} hex chars, got ${out.bars.length}`);

      const bytes = hexToBytes(out.bars);
      assert.equal(bytes.length, NUM_BARS,
        `${fmt.ext}: expected ${NUM_BARS} bytes, got ${bytes.length}`);

      // A 440 Hz tone should register a peak on most bars. Lossy codecs
      // (AAC in particular) pad the front of the stream with "priming"
      // silence that's reported as part of n_frames, so the first few
      // hundred bars can legitimately be zero — hence the modest 25%
      // floor. The primary thing this assertion protects against is the
      // decoder-exits-immediately regression, which would leave ALL bars
      // at zero.
      const nonzero = Array.from(bytes).filter(b => b > 0).length;
      assert.ok(nonzero > NUM_BARS * 0.25,
        `${fmt.ext}: only ${nonzero}/${NUM_BARS} bars non-zero — decoder probably exited early`);
    });
  }

  test('determinism: running --waveform twice on the same file produces identical bytes', async (t) => {
    if (!fsSync.existsSync(FFMPEG)) { return t.skip(`no bundled ffmpeg`); }
    if (!rustBin)                   { return t.skip('no rust-parser binary'); }

    const fixturePath = path.join(tmpDir, 'determinism.mp3');
    await runFfmpeg([
      '-nostdin', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=44100',
      '-c:a', 'libmp3lame', '-b:a', '64k',
      fixturePath,
    ]);

    const a = await runRustWaveform(rustBin, fixturePath);
    const b = await runRustWaveform(rustBin, fixturePath);
    assert.equal(a.bars, b.bars,
      'two runs over the same file produced different waveforms');
  });

  test('corrupt/unknown file: returns null gracefully, does not crash', async (t) => {
    if (!rustBin) { return t.skip('no rust-parser binary'); }

    // Not a real audio file — just noise with an .mp3 extension. Symphonia
    // should fail to probe and waveform_from_symphonia should return None,
    // surfacing as `{ bars: null }`.
    const junkPath = path.join(tmpDir, 'junk.mp3');
    await fs.writeFile(junkPath, 'this is definitely not an MP3 file', 'utf8');

    const out = await runRustWaveform(rustBin, junkPath);
    assert.equal(out.bars, null,
      'corrupt file should return null bars, not throw');
  });
});
