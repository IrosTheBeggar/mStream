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
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CACHE_EXT, probeWaveformGeneration } from '../../src/db/waveform-lib.js';

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

  // Generation probe, the same one the server runs before its pass: a
  // binary from before the current cache generation (or before the
  // `frames` field these tests assert on) answers wrong or not at all,
  // and skipping it is the truthful result — CI in the window before
  // bin/ rebuilds must skip, not fail.
  return candidates.find(p => probeWaveformGeneration(p) === CACHE_EXT) || null;
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

  // The decoder used to bin bars against `codec_params.n_frames`, which is
  // an ESTIMATE for an MPEG stream with no Xing/Info header — and worse,
  // symphonia's reader ENDS the packet stream at that estimate. A VBR file
  // that opens denser than its average therefore lost its tail and had
  // every bar shifted off its true timestamp.
  //
  // Both encodes below hold the same 60 s of audio and differ only in
  // section order, so the estimate lands short for one and long for the
  // other. Both must decode the whole thing.
  describe('full-length decode regardless of container length hints', () => {
    const VARIANTS = [
      { name: 'VBR, no Xing, dense opening', order: ['noise', 'sine'],
        args: ['-c:a', 'libmp3lame', '-q:a', '0', '-write_xing', '0'] },
      { name: 'VBR, no Xing, sparse opening', order: ['sine', 'noise'],
        args: ['-c:a', 'libmp3lame', '-q:a', '0', '-write_xing', '0'] },
      { name: 'VBR with Xing', order: ['noise', 'sine'],
        args: ['-c:a', 'libmp3lame', '-q:a', '0'] },
      { name: 'CBR', order: ['noise', 'sine'],
        args: ['-c:a', 'libmp3lame', '-b:a', '192k'] },
    ];

    for (const v of VARIANTS) {
      test(`${v.name}: decodes all 60 s`, { timeout: 120_000 }, async (t) => {
        if (!fsSync.existsSync(FFMPEG)) { return t.skip('no bundled ffmpeg'); }
        if (!rustBin)                   { return t.skip('no rust-parser binary'); }

        const src = { noise: 'anoisesrc=d=30:c=white:a=0.8:r=44100',
          sine: 'sine=frequency=100:duration=30:sample_rate=44100' };
        const out = path.join(tmpDir, `len-${v.name.replace(/\W+/g, '')}.mp3`);
        await runFfmpeg([
          '-nostdin', '-y', '-loglevel', 'error',
          '-f', 'lavfi', '-i', src[v.order[0]],
          '-f', 'lavfi', '-i', src[v.order[1]],
          '-filter_complex', '[0][1]concat=n=2:v=0:a=1',
          '-ac', '2', ...v.args, out,
        ]);

        const res = await runRustWaveform(rustBin, out);
        assert.ok(typeof res.frames === 'number', 'frames must be reported');
        const seconds = res.frames / 44100;
        // Encoder padding moves this by a few ms, never by seconds.
        assert.ok(Math.abs(seconds - 60) < 0.5,
          `decoded ${seconds.toFixed(2)} s of a 60 s file — the stream was cut short`);
      });
    }
  });

  // The mono reduction used to average |channel| across channels, which
  // reads low on anything the channels disagree about. max|ch| never
  // cancels and matches what the ffmpeg fallback now does.
  test('anti-phase stereo keeps its full level', { timeout: 60_000 }, async (t) => {
    if (!fsSync.existsSync(FFMPEG)) { return t.skip('no bundled ffmpeg'); }
    if (!rustBin)                   { return t.skip('no rust-parser binary'); }

    // Both fixtures go through the SAME amerge, differing only in the sign
    // of the right channel — `-ac 2` would have applied ffmpeg's -3 dB
    // mono→stereo gain to one of them and not the other, making the two
    // peaks incomparable for reasons that have nothing to do with phase.
    const mono = path.join(tmpDir, 'phase-mono.flac');
    const anti = path.join(tmpDir, 'phase-anti.flac');
    const tone = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=44100'];
    await runFfmpeg(['-nostdin', '-y', '-loglevel', 'error', ...tone,
      '-filter_complex', '[0:a]asplit[l][r];[r]volume=1[ri];[l][ri]amerge=inputs=2[out]',
      '-map', '[out]', '-c:a', 'flac', mono]);
    await runFfmpeg(['-nostdin', '-y', '-loglevel', 'error', ...tone,
      '-filter_complex', '[0:a]asplit[l][r];[r]volume=-1[ri];[l][ri]amerge=inputs=2[out]',
      '-map', '[out]', '-c:a', 'flac', anti]);

    const inPhase = hexToBytes((await runRustWaveform(rustBin, mono)).bars);
    const outPhase = hexToBytes((await runRustWaveform(rustBin, anti)).bars);
    const peak = (b) => Math.max(...Array.from(b));
    assert.ok(peak(outPhase) > 0, 'anti-phase stereo must not read as silence');
    assert.equal(peak(outPhase), peak(inPhase),
      'inverting one channel must not change the peak the waveform reports');
  });

  test('opus hidden in a .ogg container returns null, same as bare .opus', async (t) => {
    if (!fsSync.existsSync(FFMPEG)) { return t.skip('no bundled ffmpeg'); }
    if (!rustBin)                   { return t.skip('no rust-parser binary'); }
    // The extension gate can't classify this one — the ogg reader maps the
    // Opus stream and only decoder creation fails (NoDecoder, not Failed).
    const fixture = path.join(tmpDir, 'hidden-opus.ogg');
    await runFfmpeg(['-nostdin', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=48000',
      '-c:a', 'libopus', '-b:a', '64k', fixture]);
    const out = await runRustWaveform(rustBin, fixture);
    assert.equal(out.bars, null, 'no decoder for the codec — same posture as .opus');
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
