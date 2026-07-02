/**
 * Discovery-embedding worker tests (src/db/discovery-backfill.mjs +
 * discovery-features-lib.js registry).
 *
 * The worker is spawned exactly as task-queue.js forks it, against a fixture
 * library DB whose tracks point at small ffmpeg-synthesized audio files. All
 * runs use the registry's 'test-fake' model — deterministic, dependency-free,
 * no network — so the full decode→embed→discovery.db-write loop runs for
 * real without the ~700 MB CLAP download. Covers:
 *
 *   - embedded: discovery_tracks row with an L2-normalized vector of the
 *     model's dim, model pin per row + in discovery_meta, artist/title/
 *     duration/bpm/key snapshot copied from the library.
 *   - canonical-hash dedupe: duplicate files embed once.
 *   - idempotence: a second run finds nothing to do.
 *   - MODEL SWAP: rows pinned to a different model are re-embedded in place
 *     (the mechanism that makes `scanOptions.discoveryModel` swappable).
 *   - duration window + genre exclusion.
 *   - error outcome (missing file) + cooldown gating + retry after cooldown.
 *   - per-run cap + hitCap signalling; budget-only runs.
 *   - library schema guard: wrong user_version → exit 3, no writes.
 *   - orphan sweep: dataset rows for deleted tracks are pruned.
 *
 * Cooldown tests backdate ledger rows instead of using cooldown=0 — the
 * eligibility check is strictly `last_attempt_at < cutoff` at second
 * granularity, so a zero cooldown races the wall clock on fast CI.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { applyAllMigrations } from '../helpers/apply-migrations.mjs';
import { DISCOVERY_SCHEMA_VERSION } from '../../src/db/discovery-db.js';
import { EMBEDDING_MODELS } from '../../src/db/discovery-features-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKER = path.join(REPO_ROOT, 'src', 'db', 'discovery-backfill.mjs');
const FFMPEG = process.platform === 'win32'
  ? path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg.exe')
  : path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg');

const FAKE_DIM = EMBEDDING_MODELS['test-fake'].dim;

// ── fixtures ─────────────────────────────────────────────────────────────────

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${stderr.slice(-300)}`)));
  });
}

// A short tone is all the fake embedder needs.
async function makeAudio(outPath, freq = 440, duration = 8) {
  await runFfmpeg([
    '-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=44100:duration=${duration}`,
    '-ac', '1', '-c:a', 'flac', outPath,
  ]);
}

let scratch;

// Fixture library DB + a discovery.db path in the same dir. Track spec:
//   { file?, dur?, hash?, artist?, genre?, bpm?, key? }
function makeDbs(tracks) {
  const dir = fs.mkdtempSync(path.join(scratch, 'disc-'));
  const libraryDbPath = path.join(dir, 'mstream.db');
  const discoveryDbPath = path.join(dir, 'discovery.db');
  const musicDir = path.join(dir, 'music');
  fs.mkdirSync(musicDir, { recursive: true });

  const db = new DatabaseSync(libraryDbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    applyAllMigrations(db);
    const libId = Number(db.prepare(
      "INSERT INTO libraries (name, root_path, type) VALUES ('lib', ?, 'music')"
    ).run(musicDir).lastInsertRowid);

    let n = 0;
    for (const t of tracks) {
      n++;
      let artistId = null;
      if (t.artist) {
        artistId = Number(db.prepare(
          'INSERT OR IGNORE INTO artists (name) VALUES (?)').run(t.artist).lastInsertRowid);
        if (!artistId) {
          artistId = db.prepare('SELECT id FROM artists WHERE name = ?').get(t.artist).id;
        }
      }
      const trackId = Number(db.prepare(`
        INSERT INTO tracks (filepath, library_id, title, duration, audio_hash, artist_id, bpm, musical_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(t.file ?? `missing-${n}.flac`, libId, `T${n}`, t.dur ?? 200,
          t.hash ?? `hash-${n}`, artistId, t.bpm ?? null, t.key ?? null).lastInsertRowid);
      if (t.genre) {
        let genreId = Number(db.prepare('INSERT OR IGNORE INTO genres (name) VALUES (?)').run(t.genre).lastInsertRowid);
        if (!genreId) { genreId = db.prepare('SELECT id FROM genres WHERE name = ?').get(t.genre).id; }
        db.prepare('INSERT INTO track_genres (track_id, genre_id) VALUES (?, ?)').run(trackId, genreId);
      }
    }
  } finally {
    db.close();
  }
  return { dir, libraryDbPath, discoveryDbPath, musicDir };
}

function openDiscovery(discoveryDbPath) {
  return new DatabaseSync(discoveryDbPath);
}

// ── worker harness ───────────────────────────────────────────────────────────

function runWorker(payload) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [WORKER, JSON.stringify(payload)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d.toString(); });
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { p.kill('SIGKILL'); }, 120_000);
    p.on('close', (code) => {
      clearTimeout(timer);
      const events = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'))
        .map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(Boolean);
      const complete = events.find((e) => e.event === 'discoveryComplete') || null;
      resolve({ code, events, complete, stdout, stderr });
    });
    p.on('error', reject);
  });
}

function basePayload(fx, extra = {}) {
  return {
    discoveryDbPath: fx.discoveryDbPath,
    libraryDbPath: fx.libraryDbPath,
    ffmpegPath: FFMPEG,
    model: 'test-fake',
    minDurationSec: 0,       // fixture tones are seconds long
    maxDurationSec: 30 * 60,
    ...extra,
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-discovery-worker-'));
  assert.ok(fs.existsSync(FFMPEG), `ffmpeg binary required at ${FFMPEG}`);
});

after(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('discovery-backfill worker', () => {
  test('embeds eligible tracks with the model pin and library snapshot', async () => {
    const fx = makeDbs([
      { file: 'a.flac', hash: 'hash-a', artist: 'Artist A', bpm: 128, key: 'C major' },
      { file: 'b.flac', hash: 'hash-b' },
    ]);
    await makeAudio(path.join(fx.musicDir, 'a.flac'), 440);
    await makeAudio(path.join(fx.musicDir, 'b.flac'), 660);

    const r = await runWorker(basePayload(fx));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.complete.embedded, 2);
    assert.equal(r.complete.errors, 0);
    assert.equal(r.complete.hitCap, false);

    const ddb = openDiscovery(fx.discoveryDbPath);
    try {
      assert.equal(ddb.prepare('PRAGMA user_version').get().user_version, DISCOVERY_SCHEMA_VERSION,
        'worker bootstraps its own discovery.db');
      const rows = ddb.prepare('SELECT * FROM discovery_tracks ORDER BY audio_hash').all();
      assert.equal(rows.length, 2);

      const a = rows.find((x) => x.audio_hash === 'hash-a');
      assert.equal(a.model_id, 'test-fake');
      assert.equal(a.model_version, EMBEDDING_MODELS['test-fake'].version);
      assert.equal(a.artist, 'Artist A');
      assert.equal(a.title, 'T1');
      assert.equal(a.bpm, 128);
      assert.equal(a.musical_key, 'C major');
      assert.match(a.export_id, /^anon:/);

      // Vector: right length, L2-normalized (unit norm within float error).
      const u8 = Uint8Array.from(a.embedding);
      assert.equal(u8.byteLength, FAKE_DIM * 4);
      const vec = new Float32Array(u8.buffer, 0, FAKE_DIM);
      const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
      assert.ok(Math.abs(norm - 1) < 1e-4, `unit norm, got ${norm}`);

      // Model pin also lands in discovery_meta for the export manifest.
      const meta = Object.fromEntries(
        ddb.prepare('SELECT key, value FROM discovery_meta').all().map((m) => [m.key, m.value]));
      assert.equal(meta.embedding_model_id, 'test-fake');
      assert.equal(meta.embedding_dim, String(FAKE_DIM));

      // Success writes no ledger rows — failures only.
      assert.equal(ddb.prepare('SELECT COUNT(*) AS n FROM discovery_lookups').get().n, 0);
    } finally {
      ddb.close();
    }
  });

  test('canonical-hash dedupe: duplicate files embed once', async () => {
    const fx = makeDbs([
      { file: 'dup1.flac', hash: 'hash-dup' },
      { file: 'dup2.flac', hash: 'hash-dup' },
    ]);
    await makeAudio(path.join(fx.musicDir, 'dup1.flac'));
    await makeAudio(path.join(fx.musicDir, 'dup2.flac'));

    const r = await runWorker(basePayload(fx));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.complete.embedded, 1);

    const ddb = openDiscovery(fx.discoveryDbPath);
    try {
      assert.equal(ddb.prepare('SELECT COUNT(*) AS n FROM discovery_tracks').get().n, 1);
    } finally {
      ddb.close();
    }
  });

  test('idempotent: a second run with the same model finds nothing', async () => {
    const fx = makeDbs([{ file: 'a.flac', hash: 'hash-a' }]);
    await makeAudio(path.join(fx.musicDir, 'a.flac'));

    const r1 = await runWorker(basePayload(fx));
    assert.equal(r1.complete.embedded, 1);
    const r2 = await runWorker(basePayload(fx));
    assert.equal(r2.code, 0, r2.stderr);
    assert.equal(r2.complete.attempted, 0);
  });

  test('model swap re-embeds rows pinned to a different model', async () => {
    const fx = makeDbs([{ file: 'a.flac', hash: 'hash-a' }]);
    await makeAudio(path.join(fx.musicDir, 'a.flac'));

    const r1 = await runWorker(basePayload(fx));
    assert.equal(r1.complete.embedded, 1);

    // Simulate a dataset written by a previous model.
    const ddb = openDiscovery(fx.discoveryDbPath);
    let before;
    try {
      ddb.prepare("UPDATE discovery_tracks SET model_id = 'old-model', model_version = '0'").run();
      before = ddb.prepare('SELECT updated_at FROM discovery_tracks').get().updated_at;
    } finally {
      ddb.close();
    }

    const r2 = await runWorker(basePayload(fx));
    assert.equal(r2.code, 0, r2.stderr);
    assert.equal(r2.complete.embedded, 1, 'stale-model row re-embedded');

    const ddb2 = openDiscovery(fx.discoveryDbPath);
    try {
      const row = ddb2.prepare('SELECT model_id, model_version, updated_at FROM discovery_tracks').get();
      assert.equal(row.model_id, 'test-fake');
      assert.equal(row.model_version, EMBEDDING_MODELS['test-fake'].version);
      assert.ok(row.updated_at > before, 'rowversion bumped so incremental consumers see the change');
    } finally {
      ddb2.close();
    }
  });

  test('duration window and genre exclusion are respected', async () => {
    const fx = makeDbs([
      { file: 'ok.flac', hash: 'hash-ok', dur: 200 },
      { file: 'long.flac', hash: 'hash-long', dur: 10 * 60 * 60 },       // out of window
      { file: 'book.flac', hash: 'hash-book', dur: 200, genre: 'Audiobook' },
    ]);
    await makeAudio(path.join(fx.musicDir, 'ok.flac'));
    await makeAudio(path.join(fx.musicDir, 'long.flac'));
    await makeAudio(path.join(fx.musicDir, 'book.flac'));

    const r = await runWorker(basePayload(fx, { minDurationSec: 30 }));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.complete.embedded, 1);

    const ddb = openDiscovery(fx.discoveryDbPath);
    try {
      const rows = ddb.prepare('SELECT audio_hash FROM discovery_tracks').all().map((x) => x.audio_hash);
      assert.deepEqual(rows, ['hash-ok']);
    } finally {
      ddb.close();
    }
  });

  test('missing file → error ledger row; cooldown gates the retry', async () => {
    const fx = makeDbs([{ hash: 'hash-gone' }]);   // filepath points at nothing

    const r1 = await runWorker(basePayload(fx));
    assert.equal(r1.code, 0, r1.stderr);
    assert.equal(r1.complete.errors, 1);

    const ddb = openDiscovery(fx.discoveryDbPath);
    try {
      const row = ddb.prepare('SELECT outcome, attempts FROM discovery_lookups WHERE audio_hash = ?').get('hash-gone');
      assert.equal(row.outcome, 'error');
      assert.equal(row.attempts, 1);
    } finally {
      ddb.close();
    }

    // Within cooldown: not retried.
    const r2 = await runWorker(basePayload(fx));
    assert.equal(r2.complete.attempted, 0);

    // Age the ledger row past the default cooldown (backdating beats
    // cooldown=0, which races the clock at second granularity on fast CI).
    const ddb2 = openDiscovery(fx.discoveryDbPath);
    try {
      ddb2.prepare('UPDATE discovery_lookups SET last_attempt_at = last_attempt_at - 100000').run();
    } finally {
      ddb2.close();
    }
    const r3 = await runWorker(basePayload(fx));
    assert.equal(r3.complete.attempted, 1, 'off-cooldown error row retried');
    assert.equal(r3.complete.errors, 1);

    const ddb3 = openDiscovery(fx.discoveryDbPath);
    try {
      assert.equal(ddb3.prepare('SELECT attempts FROM discovery_lookups WHERE audio_hash = ?').get('hash-gone').attempts, 2);
    } finally {
      ddb3.close();
    }
  });

  test('success clears a previous error ledger row', async () => {
    const fx = makeDbs([{ file: 'late.flac', hash: 'hash-late' }]);

    const r1 = await runWorker(basePayload(fx));   // file doesn't exist yet
    assert.equal(r1.complete.errors, 1);

    await makeAudio(path.join(fx.musicDir, 'late.flac'));
    const ddb = openDiscovery(fx.discoveryDbPath);
    try {
      ddb.prepare('UPDATE discovery_lookups SET last_attempt_at = last_attempt_at - 100000').run();
    } finally {
      ddb.close();
    }

    const r2 = await runWorker(basePayload(fx));
    assert.equal(r2.complete.embedded, 1);

    const ddb2 = openDiscovery(fx.discoveryDbPath);
    try {
      assert.equal(ddb2.prepare('SELECT COUNT(*) AS n FROM discovery_lookups').get().n, 0,
        'error ledger cleared on success');
    } finally {
      ddb2.close();
    }
  });

  test('per-run cap: partial batch reports hitCap and resumes', async () => {
    const fx = makeDbs([
      { file: 'c1.flac', hash: 'hash-c1' },
      { file: 'c2.flac', hash: 'hash-c2' },
      { file: 'c3.flac', hash: 'hash-c3' },
    ]);
    for (const f of ['c1.flac', 'c2.flac', 'c3.flac']) {
      await makeAudio(path.join(fx.musicDir, f));
    }

    const r1 = await runWorker(basePayload(fx, { maxPerRun: 2 }));
    assert.equal(r1.complete.embedded, 2);
    assert.equal(r1.complete.hitCap, true, 'full batch → probably more work');

    const r2 = await runWorker(basePayload(fx, { maxPerRun: 2 }));
    assert.equal(r2.complete.embedded, 1);
    assert.equal(r2.complete.hitCap, false, 'backlog drained');
  });

  test('library schema guard: wrong user_version → exit 3, no writes', async () => {
    const fx = makeDbs([{ file: 'a.flac', hash: 'hash-a' }]);
    await makeAudio(path.join(fx.musicDir, 'a.flac'));

    const r = await runWorker(basePayload(fx, { expectedSchemaVersion: 99999 }));
    assert.equal(r.code, 3);

    const ddb = openDiscovery(fx.discoveryDbPath);
    try {
      assert.equal(ddb.prepare('SELECT COUNT(*) AS n FROM discovery_tracks').get().n, 0);
    } finally {
      ddb.close();
    }
  });

  test('orphan sweep: dataset rows for deleted tracks are pruned', async () => {
    const fx = makeDbs([
      { file: 'keep.flac', hash: 'hash-keep' },
      { file: 'drop.flac', hash: 'hash-drop' },
    ]);
    await makeAudio(path.join(fx.musicDir, 'keep.flac'));
    await makeAudio(path.join(fx.musicDir, 'drop.flac'));

    const r1 = await runWorker(basePayload(fx));
    assert.equal(r1.complete.embedded, 2);

    const lib = new DatabaseSync(fx.libraryDbPath);
    try {
      lib.prepare("DELETE FROM tracks WHERE audio_hash = 'hash-drop'").run();
    } finally {
      lib.close();
    }

    const r2 = await runWorker(basePayload(fx));
    assert.equal(r2.code, 0, r2.stderr);

    const ddb = openDiscovery(fx.discoveryDbPath);
    try {
      const rows = ddb.prepare('SELECT audio_hash FROM discovery_tracks').all().map((x) => x.audio_hash);
      assert.deepEqual(rows, ['hash-keep'], 'deleted track pruned from the dataset');
    } finally {
      ddb.close();
    }
  });

  test('unknown model key is rejected up front', async () => {
    const fx = makeDbs([{ file: 'a.flac', hash: 'hash-a' }]);
    await makeAudio(path.join(fx.musicDir, 'a.flac'));

    const r = await runWorker(basePayload(fx, { model: 'no-such-model' }));
    assert.equal(r.code, 1, 'invalid payload → fatal exit');
  });
});
