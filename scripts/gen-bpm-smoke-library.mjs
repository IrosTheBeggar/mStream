#!/usr/bin/env node
/**
 * Generates a 30-track test library at save/library-bpm-smoke/ where
 * every track has a TBPM tag and half also have TKEY. Exercises the
 * BPM continuity + harmonic mixing filters end-to-end against a real
 * library — the production smoke fixture (`save/library-smoke/`) has
 * zero BPM/key-tagged tracks so those filter paths can't be verified
 * there.
 *
 * Layout
 * ──────
 * 30 tracks split across 3 artists × 2 albums-each = 6 albums.
 * BPM values are distributed linearly from 60 to 200 (5 BPM apart);
 * musical keys cycle through the 12 standard Camelot codes on the
 * EVEN-indexed tracks so the harmonic-mixing filter has neighbours
 * to land in.
 *
 *   Track 1  120 BPM  Am   (8A)   Artist A — Album 1 — Track 1
 *   Track 2  125 BPM  ---         Artist A — Album 1 — Track 2
 *   Track 3  130 BPM  Cmaj (8B)   Artist A — Album 1 — Track 3
 *   ...
 *
 * Audio is 1-second sine waves with per-track frequency variation so
 * audio_hash values differ. Total payload ~150 KB.
 *
 * Idempotent: re-running skips files already on disk. Pass `--clean`
 * to wipe + regenerate.
 *
 * Usage:
 *   node scripts/gen-bpm-smoke-library.mjs           # idempotent
 *   node scripts/gen-bpm-smoke-library.mjs --clean   # fresh
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateLibrary, mkSpec } from '../test/helpers/library-gen.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(REPO_ROOT, 'save', 'library-bpm-smoke');

const TRACK_COUNT = 30;
const BPM_MIN = 60;
const BPM_MAX = 200;
const BPM_STEP = (BPM_MAX - BPM_MIN) / (TRACK_COUNT - 1);  // ≈ 4.83

// All 24 raw key names corresponding to the standard Camelot wheel.
// Even-indexed tracks get a key; odd-indexed ones leave musical_key
// NULL so we can exercise the "untagged passes through" branch of
// the harmonic filter.
//
// The key index advances by `Math.floor(i / 2)` so that the keys
// CYCLE through the array sequentially as tracks 0,2,4,...28 get
// keys[0],[1],[2],...[14] — all 12 Camelot positions get visited
// at least once across the 30-track library, with the first 3 keys
// (Am, Cmaj, Emin) hit twice (key cycle wraps at index 12).
//
// Order is interleaved minor/major so consecutive tagged tracks
// fall on relative-major/minor pairs (8A → 8B → 9A → 9B → ...)
// which is the natural Camelot "down the wheel" walk.
const CAMELOT_KEYS = [
  'A minor', 'C major', 'E minor', 'G major', 'B minor', 'D major',
  'F# minor', 'A major', 'C# minor', 'E major', 'G# minor', 'B major',
];

const ARTISTS = ['Test Artist A', 'Test Artist B', 'Test Artist C'];
const ALBUMS_PER_ARTIST = 2;  // 6 albums total
const TRACKS_PER_ALBUM = TRACK_COUNT / (ARTISTS.length * ALBUMS_PER_ARTIST);  // 5

if (!Number.isInteger(TRACKS_PER_ALBUM)) {
  throw new Error('TRACK_COUNT must divide evenly by (artists × albums-per-artist)');
}

function buildSpecs() {
  const specs = [];
  for (let i = 0; i < TRACK_COUNT; i++) {
    const artistIdx = Math.floor(i / (ALBUMS_PER_ARTIST * TRACKS_PER_ALBUM));
    const albumIdx  = Math.floor((i / TRACKS_PER_ALBUM)) % ALBUMS_PER_ARTIST;
    const trackInAlbum = (i % TRACKS_PER_ALBUM) + 1;
    const artist = ARTISTS[artistIdx];
    const album  = `Test Album ${albumIdx + 1}`;
    const bpm    = Math.round(BPM_MIN + i * BPM_STEP);
    // i/2 cycles 0..14 across the 15 tagged tracks; modulo 12 wraps
    // back to A minor for the last three (i=24,26,28) so every key
    // visits at least once.
    const musicalKey = (i % 2 === 0) ? CAMELOT_KEYS[Math.floor(i / 2) % CAMELOT_KEYS.length] : null;
    const title  = `Track ${String(i + 1).padStart(2, '0')}`;
    const trackNumPadded = String(trackInAlbum).padStart(2, '0');
    specs.push(mkSpec({
      filepath: `${artist}/${album}/${trackNumPadded} - ${title}.mp3`,
      title,
      artist,
      album,
      year: 2024,
      track: trackInAlbum,
      genre: 'Test',
      bpm,
      musicalKey,
      // Tone varies by index — 220 Hz to 220 + 29*8 = 452 Hz. Distinct
      // enough across tracks that audio_hash differentiation is clean.
      toneFreq: 220 + i * 8,
    }));
  }
  return specs;
}

(async () => {
  const clean = process.argv.includes('--clean');
  console.log(`Building BPM smoke library at: ${OUTPUT_DIR}`);
  console.log(`  ${TRACK_COUNT} tracks across ${ARTISTS.length} artists × ${ALBUMS_PER_ARTIST} albums`);
  console.log(`  BPM range: ${BPM_MIN}-${BPM_MAX} in ~${BPM_STEP.toFixed(1)} steps`);
  console.log(`  Musical key: every other track (${Math.ceil(TRACK_COUNT/2)} of ${TRACK_COUNT})`);
  if (clean) { console.log('  --clean: wiping existing directory'); }

  const specs = buildSpecs();
  const t0 = Date.now();
  const { generated, skipped } = await generateLibrary({
    outputDir: OUTPUT_DIR,
    specs,
    cleanFirst: clean,
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s — ${generated} generated, ${skipped} skipped.`);

  // Print a small sample so the operator can sanity-check the manifest.
  console.log('\nSample (first 5 + last 5):');
  const sample = [...specs.slice(0, 5), null, ...specs.slice(-5)];
  for (const s of sample) {
    if (!s) { console.log('  ...'); continue; }
    console.log(`  ${s.filepath.padEnd(60)} bpm=${(s.tags.TBPM || '-').toString().padEnd(4)} key=${s.tags.TKEY || '-'}`);
  }
})().catch(err => {
  console.error('Generation failed:', err.message);
  process.exit(1);
});
