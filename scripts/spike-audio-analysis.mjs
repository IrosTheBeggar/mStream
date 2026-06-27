// Spike: prove the decode→analyse chain (src/db/audio-analysis-lib.js) works
// on real audio FILES, not just an in-memory signal.
//
// Generates two deterministic fixtures with ffmpeg — rhythmic chord stabs at a
// known tempo + key — encodes them to real formats (MP3 + FLAC), then runs the
// library's ffmpeg-decode + essentia analysis and checks the estimates land in
// the right ballpark.
//
// Usage:
//   node scripts/spike-audio-analysis.mjs
//   node scripts/spike-audio-analysis.mjs /path/to/a/real/song.flac   (analyse only)
//
// Throwaway — delete with scripts/_essentia-probe.mjs once the pass is wired.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzeFile, getEssentia, ANALYSIS_SAMPLE_RATE } from '../src/db/audio-analysis-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FFMPEG = process.platform === 'win32'
  ? path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg.exe')
  : path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg');

// Note-name → frequency (4th octave) for building chord expressions.
const NOTE = { C: 261.63, 'C#': 277.18, D: 293.66, 'D#': 311.13, E: 329.63,
  F: 349.23, 'F#': 369.99, G: 392.0, 'G#': 415.30, A: 440.0, 'A#': 466.16, B: 493.88 };

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${stderr.slice(-400)}`)));
  });
}

// Build an `aevalsrc` expression: a triad whose stabs repeat at `bpm`, each
// beat envelope-decayed for clear onsets. duration in seconds.
function chordStabExpr(notes, bpm) {
  const beat = (60 / bpm).toFixed(6);
  const tones = notes.map((n) => `sin(2*PI*${NOTE[n]}*t)`).join('+');
  // mod(t,beat) resets each beat; exp decay gives a percussive stab.
  return `0.3*exp(-14*mod(t\\,${beat}))*(${tones})`;
}

async function makeFixture({ notes, bpm, duration, outPath, codecArgs }) {
  const expr = chordStabExpr(notes, bpm);
  await runFfmpeg([
    '-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `aevalsrc=${expr}:s=44100:d=${duration}`,
    '-ac', '2',
    ...codecArgs,
    outPath,
  ]);
}

function pass(cond) { return cond ? 'PASS' : 'FAIL'; }

async function analyseAndReport(label, file, expect) {
  const t0 = Date.now();
  const r = await analyzeFile(file, FFMPEG);
  const ms = Date.now() - t0;
  console.log(`\n[${label}] ${path.basename(file)}  (${ms}ms)`);
  console.log(`  bpm=${r.bpm} (conf ${r.bpmConfidence?.toFixed(2)})  ` +
              `key="${r.musicalKey}" (strength ${r.keyStrength?.toFixed(2)})`);
  if (expect) {
    // BPM detectors legitimately lock to half/double tempo — accept the octave.
    const bpmOk = r.bpm != null && [1, 0.5, 2].some((m) => Math.abs(r.bpm - expect.bpm * m) <= 3);
    const keyOk = r.key === expect.key && r.scale === expect.scale;
    console.log(`  expect ~${expect.bpm}bpm ${expect.key} ${expect.scale}  ` +
                `→ bpm ${pass(bpmOk)}, key ${pass(keyOk)}`);
    return bpmOk && keyOk;
  }
  return true;
}

async function main() {
  const arg = process.argv[2];
  console.log(`essentia ${getEssentia().version}, decoding @ ${ANALYSIS_SAMPLE_RATE}Hz via ${path.basename(FFMPEG)}`);

  if (arg) {
    // Analyse-only mode for a real file the user points at.
    await analyseAndReport('real-file', path.resolve(arg), null);
    return;
  }

  if (!fs.existsSync(FFMPEG)) {
    throw new Error(`ffmpeg not found at ${FFMPEG} — copy it from the main checkout's bin/ffmpeg/`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-spike-'));
  console.log(`fixtures: ${dir}`);

  const cMajorMp3 = path.join(dir, 'cmaj-128.mp3');
  const aMinorFlac = path.join(dir, 'amin-90.flac');

  await makeFixture({ notes: ['C', 'E', 'G'], bpm: 128, duration: 15, outPath: cMajorMp3,
    codecArgs: ['-c:a', 'libmp3lame', '-b:a', '128k'] });
  await makeFixture({ notes: ['A', 'C', 'E'], bpm: 90, duration: 15, outPath: aMinorFlac,
    codecArgs: ['-c:a', 'flac'] });

  const r1 = await analyseAndReport('mp3 ', cMajorMp3, { bpm: 128, key: 'C', scale: 'major' });
  const r2 = await analyseAndReport('flac', aMinorFlac, { bpm: 90, key: 'A', scale: 'minor' });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n=== ${(r1 && r2) ? 'ALL PASS' : 'SOME FAIL'} ===`);
  process.exit(r1 && r2 ? 0 : 1);
}

main().catch((e) => { console.error('spike failed:', e); process.exit(1); });
