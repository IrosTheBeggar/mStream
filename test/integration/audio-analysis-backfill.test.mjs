/**
 * Essentia BPM/key analyser tests (V54 + src/db/audio-analysis-backfill.mjs).
 *
 * The worker is spawned exactly as task-queue.js forks it, against a fixture DB
 * whose tracks point at small ffmpeg-synthesized audio files (rhythmic chord
 * stabs at a known tempo/key) — so the full decode→essentia→DB-write loop runs
 * for real, no mocking. Covers:
 *
 *   - analysed: bpm/musical_key filled, bpm_source='essentia', lookup row.
 *   - fill-NULL only: a tag-sourced bpm is never overwritten.
 *   - canonical-hash dedupe: duplicate files analysed once, result fans out.
 *   - duration window + genre exclusion: ineligible tracks skipped.
 *   - error outcome (undecodable / missing file) + short-cooldown retry.
 *   - per-run cap + hitCap signalling.
 *   - schema guard: wrong user_version → exit 3, no writes.
 *   - V54 migration shape.
 *
 * Real-analysis runs are kept to a handful of short fixtures; gating/error
 * tests use missing files or DB-only filters so they never decode.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { MIGRATIONS } from '../../src/db/schema.js';
import { applyAllMigrations } from '../helpers/apply-migrations.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKER = path.join(REPO_ROOT, 'src', 'db', 'audio-analysis-backfill.mjs');
const FFMPEG = process.platform === 'win32'
  ? path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg.exe')
  : path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg');

const NOTE = { C: 261.63, D: 293.66, E: 329.63, F: 349.23, G: 392.0, A: 440.0, B: 493.88 };

// ── ffmpeg fixture synthesis ──────────────────────────────────────────────────

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${stderr.slice(-300)}`)));
  });
}

// Triad chord stabs at `bpm` for `duration`s — clear onsets for the rhythm
// extractor, a definite key for the key extractor.
async function makeAudio({ notes, bpm, duration, outPath }) {
  const beat = (60 / bpm).toFixed(6);
  const tones = notes.map((n) => `sin(2*PI*${NOTE[n]}*t)`).join('+');
  const expr = `0.3*exp(-14*mod(t\\,${beat}))*(${tones})`;
  await runFfmpeg([
    '-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `aevalsrc=${expr}:s=44100:d=${duration}`,
    '-ac', '2', '-c:a', 'flac', outPath,
  ]);
}

// ── Worker harness ─────────────────────────────────────────────────────────────

function runWorker(config) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [WORKER, JSON.stringify(config)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d.toString(); });
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { p.kill('SIGKILL'); }, 120_000);
    p.on('exit', (code) => {
      clearTimeout(timer);
      const events = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'))
        .map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(Boolean);
      const complete = events.find((e) => e.event === 'audioAnalysisComplete') || null;
      resolve({ code, events, complete, stdout, stderr });
    });
    p.on('error', reject);
  });
}

// Fixture DB with a library + tracks. Each track spec:
//   { file?, bpm?, key?, source?, dur?, hash?, genre? }
//   file  — basename of a fixture under <root>/music to point filepath at
//           (omit for the "missing file" error path)
//   bpm/key/source — seed tracks.bpm / musical_key / bpm_source
//   dur   — tracks.duration (selection gate; default 200)
//   hash  — tracks.audio_hash (default unique per row); share to test dedupe
//   genre — a track_genres entry (for the exclusion test)
let scratch;
function makeDb(tracks) {
  const dir = fs.mkdtempSync(path.join(scratch, 'aa-'));
  const dbPath = path.join(dir, 'mstream.db');
  const musicDir = path.join(dir, 'music');
  fs.mkdirSync(musicDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    applyAllMigrations(db);
    const libId = Number(db.prepare("INSERT INTO libraries (name, root_path, type) VALUES ('lib', ?, 'music')")
      .run(musicDir).lastInsertRowid);
    const ids = [];
    let n = 0;
    for (const t of tracks) {
      n++;
      const filepath = t.file ? t.file : `missing-${n}.flac`;
      const trackId = Number(db.prepare(`
        INSERT INTO tracks (filepath, library_id, title, duration, audio_hash, bpm, musical_key, bpm_source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(filepath, libId, `T${n}`, t.dur ?? 200, t.hash ?? `hash-${n}`,
          t.bpm ?? null, t.key ?? null, t.source ?? null).lastInsertRowid);
      if (t.genre) {
        db.prepare('INSERT OR IGNORE INTO genres (name) VALUES (?)').run(t.genre);
        const gId = db.prepare('SELECT id FROM genres WHERE name = ?').get(t.genre).id;
        db.prepare('INSERT INTO track_genres (track_id, genre_id) VALUES (?, ?)').run(trackId, gId);
      }
      ids.push(trackId);
    }
    const userVersion = db.prepare('PRAGMA user_version').get().user_version;
    return { dir, dbPath, musicDir, libId, ids, userVersion };
  } finally {
    db.close();
  }
}

function baseConfig(env, overrides = {}) {
  return {
    dbPath: env.dbPath,
    ffmpegPath: FFMPEG,
    maxPerRun: 100,
    expectedSchemaVersion: env.userVersion,
    runBudgetSec: 100,
    ...overrides,
  };
}

// Shared real fixtures (synthesized once).
let fxCmajor;   // basename, C major @ 128
let fxAminor;   // basename, A minor @ 90

before(async () => {
  assert.ok(fs.existsSync(FFMPEG), `ffmpeg missing at ${FFMPEG} — copy it from the main checkout`);
  scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'mstream-aa-'));
  // One shared fixture dir; tests copy basenames into their own library dirs.
  fxCmajor = path.join(scratch, 'cmaj-128.flac');
  fxAminor = path.join(scratch, 'amin-90.flac');
  await makeAudio({ notes: ['C', 'E', 'G'], bpm: 128, duration: 9, outPath: fxCmajor });
  await makeAudio({ notes: ['A', 'C', 'E'], bpm: 90, duration: 9, outPath: fxAminor });
});

after(async () => {
  if (scratch) {
    try { await fsp.rm(scratch, { recursive: true, force: true }); }
    catch (_e) { /* OS reclaims tmp */ }
  }
});

// Copy a shared fixture into an env's music dir under `name`, return the basename.
function placeFixture(env, srcAbs, name) {
  fs.copyFileSync(srcAbs, path.join(env.musicDir, name));
  return name;
}

// ── V54 schema ──────────────────────────────────────────────────────────────

describe('V54 schema', () => {
  test('audio_analysis_lookups exists with the right columns; not rescanRequired', () => {
    const v54 = MIGRATIONS.find((m) => m.version === 54);
    assert.ok(v54, 'missing v54');
    assert.ok(!v54.rescanRequired);
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyAllMigrations(db);
    const cols = db.prepare('PRAGMA table_info(audio_analysis_lookups)').all().map((c) => c.name).sort();
    assert.deepEqual(cols, ['attempts', 'audio_hash', 'last_attempt_at', 'outcome']);
    db.close();
  });
});

// ── Worker behavior ───────────────────────────────────────────────────────────

describe('analysis worker (real ffmpeg + essentia)', () => {
  test('analysed: bpm/key filled, bpm_source=essentia, lookup recorded', async () => {
    const env = makeDb([{}]);   // one track, file set below
    const file = placeFixture(env, fxCmajor, 'song.flac');
    // Point the track at the fixture.
    let db = new DatabaseSync(env.dbPath);
    db.prepare('UPDATE tracks SET filepath = ? WHERE id = ?').run(file, env.ids[0]);
    db.close();

    const r = await runWorker(baseConfig(env));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.complete.attempted, 1);
    assert.equal(r.complete.analyzed, 1, r.stderr);

    db = new DatabaseSync(env.dbPath);
    try {
      const row = db.prepare('SELECT bpm, musical_key, bpm_source FROM tracks WHERE id = ?').get(env.ids[0]);
      // Don't over-assert essentia's exact estimate; require it populated +
      // plausible. (The C-major/128 fixture lands ~128bpm C major in practice.)
      assert.ok(row.bpm == null || (row.bpm >= 20 && row.bpm <= 300), `implausible bpm ${row.bpm}`);
      assert.ok(row.bpm != null || row.musical_key != null, 'at least one of bpm/key must be filled');
      assert.equal(row.bpm_source, 'essentia');
      const lookup = db.prepare('SELECT outcome, attempts FROM audio_analysis_lookups').get();
      assert.deepEqual({ ...lookup }, { outcome: 'analyzed', attempts: 1 });
    } finally { db.close(); }
  });

  test('fill-NULL only: a tag-sourced bpm is preserved, key gets added', async () => {
    const env = makeDb([{ bpm: 123, source: 'tag' }]);  // tag bpm, NULL key
    const file = placeFixture(env, fxCmajor, 'tagged.flac');
    let db = new DatabaseSync(env.dbPath);
    db.prepare('UPDATE tracks SET filepath = ? WHERE id = ?').run(file, env.ids[0]);
    db.close();

    const r = await runWorker(baseConfig(env));
    assert.equal(r.code, 0, r.stderr);

    db = new DatabaseSync(env.dbPath);
    try {
      const row = db.prepare('SELECT bpm, musical_key, bpm_source FROM tracks WHERE id = ?').get(env.ids[0]);
      assert.equal(row.bpm, 123, 'tag bpm must NOT be overwritten');
      assert.equal(row.bpm_source, 'tag', 'tag provenance preserved');
      assert.ok(row.musical_key != null, 'NULL key should have been filled');
    } finally { db.close(); }
  });

  test('dedupe: duplicate files (same audio_hash) analysed once, result fans out', async () => {
    // Duplicate files: distinct paths, identical bytes → one canonical hash.
    const env = makeDb([
      { hash: 'dup', file: 'copy-a.flac' },
      { hash: 'dup', file: 'copy-b.flac' },
    ]);
    placeFixture(env, fxAminor, 'copy-a.flac');
    placeFixture(env, fxAminor, 'copy-b.flac');

    const r = await runWorker(baseConfig(env));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.complete.attempted, 1, 'one canonical hash → one decode');

    const db = new DatabaseSync(env.dbPath);
    try {
      const filled = db.prepare('SELECT COUNT(*) AS n FROM tracks WHERE musical_key IS NOT NULL OR bpm IS NOT NULL').get().n;
      assert.equal(filled, 2, 'both copies stamped from the single analysis');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audio_analysis_lookups').get().n, 1);
    } finally { db.close(); }
  });

  test('duration window: too-short tracks are skipped (no decode, no lookup)', async () => {
    const env = makeDb([{ file: 'x.flac', dur: 5 }]);   // below 30s default
    placeFixture(env, fxCmajor, 'x.flac');
    const r = await runWorker(baseConfig(env));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.complete.attempted, 0, 'short track must be ineligible');
    const db = new DatabaseSync(env.dbPath);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audio_analysis_lookups').get().n, 0);
    } finally { db.close(); }
  });

  test('genre exclusion: audiobook-tagged tracks are skipped', async () => {
    const env = makeDb([{ file: 'ab.flac', genre: 'Audiobook' }]);
    placeFixture(env, fxCmajor, 'ab.flac');
    const r = await runWorker(baseConfig(env));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.complete.attempted, 0, 'audiobook genre excluded (case-insensitive)');
  });

  test('error: undecodable / missing file → error outcome, short-cooldown retry', async () => {
    const env = makeDb([{}]);   // no file → filepath points at a missing path
    const r1 = await runWorker(baseConfig(env));
    assert.equal(r1.code, 0, r1.stderr);
    assert.equal(r1.complete.errors, 1);

    const db1 = new DatabaseSync(env.dbPath);
    assert.equal(db1.prepare('SELECT outcome FROM audio_analysis_lookups').get().outcome, 'error');
    assert.equal(db1.prepare('SELECT bpm FROM tracks').get().bpm, null, 'nothing written');
    db1.close();

    // Within the error cooldown → excluded; with cooldown 0 → retried (attempts++).
    const r2 = await runWorker(baseConfig(env));
    assert.equal(r2.complete.attempted, 0, 'error cooldown excludes it');
    const r3 = await runWorker(baseConfig(env, { errorCooldownSec: 0 }));
    assert.equal(r3.complete.attempted, 1);
    const db3 = new DatabaseSync(env.dbPath);
    assert.equal(db3.prepare('SELECT attempts FROM audio_analysis_lookups').get().attempts, 2);
    db3.close();
  });

  test('per-run cap: hitCap signals more work; the next run drains the rest', async () => {
    // 3 missing-file tracks → fast error outcomes; persisted>0 so hitCap holds.
    const env = makeDb([{}, {}, {}]);
    const r1 = await runWorker(baseConfig(env, { maxPerRun: 2 }));
    assert.deepEqual({ attempted: r1.complete.attempted, hitCap: r1.complete.hitCap },
      { attempted: 2, hitCap: true });
    const r2 = await runWorker(baseConfig(env, { maxPerRun: 2 }));
    assert.deepEqual({ attempted: r2.complete.attempted, hitCap: r2.complete.hitCap },
      { attempted: 1, hitCap: false });
  });

  test('schema guard: wrong expected version → exit 3, zero writes', async () => {
    const env = makeDb([{}]);
    const r = await runWorker(baseConfig(env, { expectedSchemaVersion: env.userVersion + 1 }));
    assert.equal(r.code, 3);
    const db = new DatabaseSync(env.dbPath);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audio_analysis_lookups').get().n, 0);
    } finally { db.close(); }
  });

  test('lowconf: below the confidence floor → lowconf, columns stay NULL, cooldown excludes re-run', async () => {
    const env = makeDb([{ file: 'song.flac' }]);
    placeFixture(env, fxCmajor, 'song.flac');
    // Impossible floors → neither bpm nor key is usable → lowconf (deterministic).
    const r = await runWorker(baseConfig(env, { minBpmConfidence: 999, minKeyStrength: 0.999 }));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      { analyzed: r.complete.analyzed, lowconf: r.complete.lowconf, errors: r.complete.errors },
      { analyzed: 0, lowconf: 1, errors: 0 });
    const db = new DatabaseSync(env.dbPath);
    try {
      const row = db.prepare('SELECT bpm, musical_key, bpm_source FROM tracks WHERE filepath = ?').get('song.flac');
      assert.equal(row.bpm, null);
      assert.equal(row.musical_key, null);
      assert.equal(row.bpm_source, null, 'no provenance stamp when nothing was written');
      assert.equal(db.prepare('SELECT outcome FROM audio_analysis_lookups').get().outcome, 'lowconf');
    } finally { db.close(); }
    // Re-run within the (long) lowconf cooldown → the track is excluded.
    const r2 = await runWorker(baseConfig(env, { minBpmConfidence: 999, minKeyStrength: 0.999 }));
    assert.equal(r2.complete.attempted, 0, 'lowconf cooldown excludes the track');
  });

  test('idempotent: a fully-analysed track is not re-decoded on the next run', async () => {
    const env = makeDb([{ file: 'song.flac' }]);
    placeFixture(env, fxCmajor, 'song.flac');   // fills BOTH bpm + key
    const r1 = await runWorker(baseConfig(env));
    assert.equal(r1.complete.analyzed, 1, r1.stderr);
    const r2 = await runWorker(baseConfig(env));
    assert.equal(r2.complete.attempted, 0, 'both columns filled → not re-selected');
    const db = new DatabaseSync(env.dbPath);
    try {
      assert.equal(db.prepare('SELECT attempts FROM audio_analysis_lookups').get().attempts, 1, 'no second attempt');
    } finally { db.close(); }
  });
});
