/**
 * rust-parser --fingerprint <file> — the AcoustID identity chain, step one.
 *
 * Contract (single-line JSON on stdout, exit 0 either way):
 *   decodable  → {"fingerprint":"<base64 url-safe no-pad>","durationSec":N|null,"fpSeconds":F}
 *   opus/undecodable → {"fingerprint":null}
 *
 * The fingerprint is a chromaprint TEST2 compressed fingerprint — the exact
 * string api.acoustid.org/v2/lookup accepts (validated live in the Phase-2
 * spike: real music matched AcoustID at 98–99.8% with correct recording
 * MBIDs). These tests assert the CLI contract, format header, determinism
 * and failure modes — not acoustic quality, which only the live service can
 * judge.
 *
 * Capability-gated (the protocol-PR CI rule): full-ci runs against master's
 * prebuilt rust-parser, which predates this subcommand until the post-merge
 * binaries rebuild — probe in before(), skip with a reason on old binaries.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findRustParser, FFMPEG } from '../helpers/scanner-runner.mjs';

const run = promisify(execFile);

let rustBin;
let workDir;
let hasFingerprint = false;

// Real tones, not the silence the shared makeAudio fixture emits — chromaprint
// over silence is degenerate and would undermine the differs-by-content test.
async function makeTone(filepath, freqHz, seconds, codecArgs) {
  await fsp.mkdir(path.dirname(filepath), { recursive: true });
  await run(FFMPEG, [
    '-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=${freqHz}:sample_rate=44100:duration=${seconds}`,
    '-ac', '2', ...codecArgs,
    filepath,
  ]);
}

async function fingerprint(file) {
  const { stdout } = await run(rustBin, ['--fingerprint', file]);
  return JSON.parse(stdout.trim());
}

before(async () => {
  rustBin = findRustParser();
  if (!rustBin || !fs.existsSync(FFMPEG)) { return; } // tests skip

  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mstream-fp-'));
  await makeTone(path.join(workDir, 'tone440.flac'), 440, 5, ['-c:a', 'flac']);
  await makeTone(path.join(workDir, 'tone554.flac'), 554, 5, ['-c:a', 'flac']);
  await makeTone(path.join(workDir, 'tone440.mp3'), 440, 5, ['-c:a', 'libmp3lame', '-b:a', '128k']);
  await makeTone(path.join(workDir, 'tone440.opus'), 440, 5, ['-c:a', 'libopus']);
  fs.writeFileSync(path.join(workDir, 'garbage.flac'), 'this is not audio at all\n'.repeat(64));

  // Capability probe: an old binary treats "--fingerprint" as a scan-config
  // path and errors out / prints something that isn't our JSON.
  try {
    const out = await fingerprint(path.join(workDir, 'tone440.flac'));
    hasFingerprint = out !== null && typeof out === 'object' && 'fingerprint' in out;
  } catch (_err) {
    hasFingerprint = false;
  }
});

after(async () => {
  if (workDir) { await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {}); }
});

// Every test needs the subcommand — one shared gate.
function gate(t) {
  if (!rustBin)               { t.skip('no rust-parser binary'); return false; }
  if (!fs.existsSync(FFMPEG)) { t.skip('no bundled ffmpeg'); return false; }
  if (!hasFingerprint) {
    t.skip('rust-parser binary predates --fingerprint '
      + '(CI prebuilt until the post-merge rebuild)');
    return false;
  }
  return true;
}

describe('rust-parser --fingerprint', () => {
  test('emits an AcoustID-ready fingerprint with duration', async (t) => {
    if (!gate(t)) { return; }
    const out = await fingerprint(path.join(workDir, 'tone440.flac'));

    assert.match(out.fingerprint, /^[A-Za-z0-9_-]+$/,
      'base64 url-safe, no padding — the exact lookup param format');
    // The compressed-fingerprint header carries the algorithm id;
    // AcoustID only indexes TEST2 (= 1).
    const header = Buffer.from(out.fingerprint, 'base64url');
    assert.equal(header[0], 1, 'chromaprint algorithm byte must be TEST2');

    assert.equal(out.durationSec, 5, 'full duration from the container (integer seconds)');
    assert.ok(out.fpSeconds > 4.9 && out.fpSeconds <= 5.1,
      'whole (sub-120s) file fingerprinted');
  });

  test('is deterministic across runs', async (t) => {
    if (!gate(t)) { return; }
    const a = await fingerprint(path.join(workDir, 'tone440.flac'));
    const b = await fingerprint(path.join(workDir, 'tone440.flac'));
    assert.equal(a.fingerprint, b.fingerprint);
    assert.equal(a.durationSec, b.durationSec);
  });

  test('different audio yields different fingerprints', async (t) => {
    if (!gate(t)) { return; }
    const a = await fingerprint(path.join(workDir, 'tone440.flac'));
    const b = await fingerprint(path.join(workDir, 'tone554.flac'));
    assert.notEqual(a.fingerprint, b.fingerprint);
  });

  test('mp3 input works (transform-codec path)', async (t) => {
    if (!gate(t)) { return; }
    const out = await fingerprint(path.join(workDir, 'tone440.mp3'));
    assert.match(out.fingerprint, /^[A-Za-z0-9_-]+$/);
    // MP3 containers pad; the duration is approximate but must be sane.
    assert.ok(out.durationSec === null || (out.durationSec >= 4 && out.durationSec <= 6),
      `mp3 durationSec sane, got ${out.durationSec}`);
  });

  test('opus is a clean null (no pure-Rust decoder — worker records a skip)', async (t) => {
    if (!gate(t)) { return; }
    const out = await fingerprint(path.join(workDir, 'tone440.opus'));
    assert.equal(out.fingerprint, null);
  });

  test('garbage input is a clean null, not a crash', async (t) => {
    if (!gate(t)) { return; }
    const out = await fingerprint(path.join(workDir, 'garbage.flac'));
    assert.equal(out.fingerprint, null);
  });
});
