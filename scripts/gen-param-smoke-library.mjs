#!/usr/bin/env node
/**
 * Generates a 2-vpath test library at save/library-param-smoke/{main,vault}
 * designed to exercise every remaining Auto-DJ filter parameter that the
 * BPM smoke library (scripts/gen-bpm-smoke-library.mjs) couldn't:
 *
 *   • ignoreVPaths           — needs 2+ libraries
 *   • minRating              — needs user_metadata seeded (handled in the
 *                              probe script, not the generator)
 *   • bpmMin / bpmMax legacy — separate from bpmRanges; same library shape
 *   • requireBpm             — needs a mix of bpm-tagged + untagged
 *   • ignoreArtists V18      — needs tracks with FEATURED artists so the
 *     widening                  primary→track_artists→album_artists chain
 *                              the artist-filter walks can be probed
 *   • Multi-genre tracks     — needs TCON with `;`-separated values so
 *                              setTrackGenres splits into multiple
 *                              track_genres rows
 *
 * Library shape
 * ─────────────
 * 30 tracks total split 20:10 across two vpaths.
 *
 *   ── main (20 tracks) ──────────────────────────────────────────────
 *   Artist A  ×5  album "A Solo"   — BPM 80-100, single genre "Rock",   no key
 *   Artist B  ×5  album "B Solo"   — BPM 120-140, single genre "Pop",   key=A minor on track 1
 *   Artist C  ×5  album "C Solo"   — no BPM,    single genre "Jazz",  no key
 *   Various   ×5  album "Collabs"  — primary X, featured = A or B,
 *                                    BPM 130-150, multi-genre "Electronic;Pop"
 *
 *   ── vault (10 tracks) ─────────────────────────────────────────────
 *   Artist D  ×5  album "D Solo"   — no BPM, multi-genre "Rock;Jazz",  no key
 *   Artist E  ×5  album "E Solo"   — no BPM, single genre "Folk",      no key
 *
 * Idempotent on re-run. `--clean` wipes both vpath roots.
 *
 * Usage:
 *   node scripts/gen-param-smoke-library.mjs
 *   node scripts/gen-param-smoke-library.mjs --clean
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateLibrary, mkSpec } from '../test/helpers/library-gen.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ROOT_DIR  = path.join(REPO_ROOT, 'save', 'library-param-smoke');
const MAIN_DIR  = path.join(ROOT_DIR, 'main');
const VAULT_DIR = path.join(ROOT_DIR, 'vault');

function buildMainSpecs() {
  const out = [];
  // Artist A — Rock, BPM 80-100.
  for (let i = 1; i <= 5; i++) {
    out.push(mkSpec({
      filepath: `Artist A/A Solo/${String(i).padStart(2,'0')} - A Track ${i}.mp3`,
      title: `A Track ${i}`, artist: 'Artist A', album: 'A Solo', year: 2020,
      track: i, genre: 'Rock', bpm: 80 + (i - 1) * 5, toneFreq: 220 + i * 10,
    }));
  }
  // Artist B — Pop, BPM 120-140. First track gets a key for harmonic-mixing
  // composition probes.
  for (let i = 1; i <= 5; i++) {
    out.push(mkSpec({
      filepath: `Artist B/B Solo/${String(i).padStart(2,'0')} - B Track ${i}.mp3`,
      title: `B Track ${i}`, artist: 'Artist B', album: 'B Solo', year: 2021,
      track: i, genre: 'Pop', bpm: 120 + (i - 1) * 5,
      musicalKey: i === 1 ? 'A minor' : null,
      toneFreq: 300 + i * 10,
    }));
  }
  // Artist C — Jazz, no BPM.
  for (let i = 1; i <= 5; i++) {
    out.push(mkSpec({
      filepath: `Artist C/C Solo/${String(i).padStart(2,'0')} - C Track ${i}.mp3`,
      title: `C Track ${i}`, artist: 'Artist C', album: 'C Solo', year: 2019,
      track: i, genre: 'Jazz',
      toneFreq: 400 + i * 10,
    }));
  }
  // Various — primary "Artist X" with FEATURED collab. The artist tag
  // is array-joined with ' / ' so the scanner's extractArtists splits
  // it into two artist rows (primary + collaborator), which exercises
  // the V18 widening path in buildArtistFilter — `ignoreArtists=['A']`
  // should drop tracks where A is FEATURED, not just primary.
  //
  // Multi-genre TCON: 'Electronic;Pop' becomes two track_genres rows.
  const features = ['Artist A', 'Artist B', 'Artist A', 'Artist C', 'Artist B'];
  for (let i = 1; i <= 5; i++) {
    out.push(mkSpec({
      filepath: `Various/Collabs/${String(i).padStart(2,'0')} - Collab ${i}.mp3`,
      title: `Collab ${i}`, album: 'Collabs', year: 2022, track: i,
      artist: ['Artist X', features[i - 1]],   // ['X', 'A'] → 'X / A' in TPE1
      genre: ['Electronic', 'Pop'],            // 'Electronic;Pop' in TCON
      bpm: 130 + (i - 1) * 5,
      albumArtist: 'Various Artists',
      compilation: true,
      toneFreq: 500 + i * 10,
    }));
  }
  return out;
}

function buildVaultSpecs() {
  const out = [];
  // Artist D — multi-genre Rock;Jazz, no BPM.
  for (let i = 1; i <= 5; i++) {
    out.push(mkSpec({
      filepath: `Artist D/D Solo/${String(i).padStart(2,'0')} - D Track ${i}.mp3`,
      title: `D Track ${i}`, artist: 'Artist D', album: 'D Solo', year: 2023,
      track: i, genre: ['Rock', 'Jazz'], toneFreq: 600 + i * 10,
    }));
  }
  // Artist E — Folk single genre, no BPM.
  for (let i = 1; i <= 5; i++) {
    out.push(mkSpec({
      filepath: `Artist E/E Solo/${String(i).padStart(2,'0')} - E Track ${i}.mp3`,
      title: `E Track ${i}`, artist: 'Artist E', album: 'E Solo', year: 2023,
      track: i, genre: 'Folk', toneFreq: 700 + i * 10,
    }));
  }
  return out;
}

(async () => {
  const clean = process.argv.includes('--clean');
  console.log(`Building param smoke library at: ${ROOT_DIR}`);
  console.log('  main vpath: 20 tracks (A/B/C/Various)');
  console.log('  vault vpath: 10 tracks (D/E)');
  if (clean) { console.log('  --clean: wiping both vpath roots'); }

  const mainSpecs  = buildMainSpecs();
  const vaultSpecs = buildVaultSpecs();

  const t0 = Date.now();
  const m = await generateLibrary({ outputDir: MAIN_DIR,  specs: mainSpecs,  cleanFirst: clean });
  const v = await generateLibrary({ outputDir: VAULT_DIR, specs: vaultSpecs, cleanFirst: clean });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\nDone in ${elapsed}s — ${m.generated + v.generated} generated, ${m.skipped + v.skipped} skipped.`);

  console.log('\nMain sample:');
  for (const s of [...mainSpecs.slice(0, 3), null, ...mainSpecs.slice(15)]) {
    if (!s) { console.log('  ...'); continue; }
    console.log(`  ${s.filepath.padEnd(60)} bpm=${(s.tags.TBPM||'-').toString().padEnd(4)} genre=${s.tags.genre} artist=${s.tags.artist}`);
  }
  console.log('\nVault sample:');
  for (const s of [...vaultSpecs.slice(0, 3), null, ...vaultSpecs.slice(-3)]) {
    if (!s) { console.log('  ...'); continue; }
    console.log(`  ${s.filepath.padEnd(60)} genre=${s.tags.genre} artist=${s.tags.artist}`);
  }
})().catch(err => {
  console.error('Generation failed:', err.message);
  process.exit(1);
});
