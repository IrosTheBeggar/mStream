/**
 * GOLDEN-PARITY test for the pure-JS EffNet mel front-end
 * (src/db/effnet-mel.js) against essentia.js's TensorflowInputMusiCNN —
 * the exact pipeline Discogs-EffNet was trained on.
 *
 * This is the contract that makes the JS reimplementation safe: a mismatch
 * here (a drifted constant, a changed essentia reference, a subtly wrong
 * filterbank) would otherwise degrade embedding quality SILENTLY — wrong
 * mels still produce plausible-looking vectors. The golden output is
 * re-derived from essentia.js on every run, on ffmpeg-synthesized audio
 * spanning tonal, noisy, and frequency-sweeping content.
 *
 * Measured parity at authoring time: max abs diff 1.7e-5 (float32 noise
 * floor). The assertion allows 1e-3 — three orders of magnitude of margin,
 * still far below anything that could affect the model (mel values span
 * ~0–4 after log compression).
 *
 * Also covers the seek-decode addition to decodePcmF32 (opts.seekSec),
 * which the discovery worker uses to decode only its analysis windows.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createMelExtractor, MEL_FRAME_SIZE, MEL_HOP_SIZE, MEL_BANDS, MEL_SAMPLE_RATE } from '../../src/db/effnet-mel.js';
import { decodePcmF32, getEssentia } from '../../src/db/audio-analysis-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FFMPEG = process.platform === 'win32'
  ? path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg.exe')
  : path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg');

let scratch;
let essentia;
const { melFrames } = createMelExtractor();

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${stderr.slice(-300)}`)));
  });
}

async function makeAudio(name, filter, duration = 5) {
  const out = path.join(scratch, name);
  await runFfmpeg([
    '-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `${filter}:duration=${duration}`,
    '-ac', '1', '-ar', String(MEL_SAMPLE_RATE), '-c:a', 'flac', out,
  ]);
  return out;
}

// Golden reference: essentia's TensorflowInputMusiCNN, frame-by-frame.
function goldenMel(signal) {
  const rows = [];
  const buf = new Float32Array(MEL_FRAME_SIZE);
  for (let s = 0; s + MEL_FRAME_SIZE <= signal.length; s += MEL_HOP_SIZE) {
    buf.set(signal.subarray(s, s + MEL_FRAME_SIZE));
    const vec = essentia.arrayToVector(buf);
    const res = essentia.TensorflowInputMusiCNN(vec);
    rows.push(essentia.vectorToArray(res.bands));
    res.bands.delete();
    vec.delete();
  }
  return rows;
}

function maxAbsDiff(a, b) {
  assert.equal(a.length, b.length, 'frame counts must match');
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].length, MEL_BANDS);
    for (let j = 0; j < MEL_BANDS; j++) {
      max = Math.max(max, Math.abs(a[i][j] - b[i][j]));
    }
  }
  return max;
}

before(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-mel-parity-'));
  assert.ok(fs.existsSync(FFMPEG), `ffmpeg required at ${FFMPEG}`);
  essentia = await getEssentia();
});

after(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('effnet-mel golden parity vs essentia TensorflowInputMusiCNN', () => {
  const FIXTURES = [
    ['tone.flac', 'sine=frequency=440'],
    ['chord.flac', 'aevalsrc=0.3*(sin(2*PI*261.63*t)+sin(2*PI*329.63*t)+sin(2*PI*392*t)):s=16000'],
    ['noise.flac', 'anoisesrc=colour=pink:seed=42'],
    ['sweep.flac', 'sine=frequency=100:beep_factor=0'],
  ];

  for (const [name, filter] of FIXTURES) {
    test(`parity on ${name}`, async () => {
      const file = await makeAudio(name, filter);
      const signal = await decodePcmF32(file, FFMPEG, { sampleRate: MEL_SAMPLE_RATE });
      const ours = melFrames(signal);
      const gold = goldenMel(signal);
      assert.ok(ours.length > 100, `expected real frame count, got ${ours.length}`);
      const diff = maxAbsDiff(ours, gold);
      assert.ok(diff < 1e-3, `max abs diff ${diff} exceeds parity tolerance`);
    });
  }

  test('deterministic across calls', async () => {
    const file = await makeAudio('det.flac', 'anoisesrc=colour=white:seed=7', 2);
    const signal = await decodePcmF32(file, FFMPEG, { sampleRate: MEL_SAMPLE_RATE });
    const a = melFrames(signal);
    const b = melFrames(signal);
    assert.equal(maxAbsDiff(a, b), 0);
  });

  test('sub-frame signal yields no rows (matches previous behavior)', () => {
    assert.deepEqual(melFrames(new Float32Array(MEL_FRAME_SIZE - 1)), []);
  });
});

describe('decodePcmF32 seekSec (analysis-window decode)', () => {
  test('decodes a window of the requested length from mid-file', async () => {
    const file = await makeAudio('seek.flac', 'sine=frequency=440', 8);
    const win = await decodePcmF32(file, FFMPEG, {
      sampleRate: MEL_SAMPLE_RATE, seekSec: 3, maxSeconds: 2,
    });
    // ~2s at 16kHz; ffmpeg may trim a frame either side of the seek point.
    assert.ok(Math.abs(win.length - 2 * MEL_SAMPLE_RATE) < MEL_SAMPLE_RATE * 0.1,
      `expected ~${2 * MEL_SAMPLE_RATE} samples, got ${win.length}`);
    // Content sanity: a mid-tone window is not silence (ffmpeg's sine
    // filter synthesizes at ~1/8 amplitude → RMS ≈ 0.09).
    const rms = Math.sqrt(win.reduce((s, x) => s + x * x, 0) / win.length);
    assert.ok(rms > 0.05, `expected tonal content, rms=${rms}`);
  });

  test('seek past EOF fails cleanly (no audio decoded)', async () => {
    const file = await makeAudio('seek2.flac', 'sine=frequency=440', 3);
    await assert.rejects(
      decodePcmF32(file, FFMPEG, { sampleRate: MEL_SAMPLE_RATE, seekSec: 60, maxSeconds: 2 }),
      /no audio|exited/);
  });
});
