/**
 * AcoustID identification worker tests (src/db/acoustid-backfill.mjs).
 *
 * The worker is spawned exactly as task-queue.js forks it, against a fixture
 * library DB whose tracks point at small ffmpeg-synthesized audio files. The
 * fingerprint step uses the REAL rust-parser --fingerprint (capability-gated
 * on old prebuilts, per the protocol-PR CI rule); the AcoustID service is a
 * local HTTP stub keyed on the request's `duration` field, so every network
 * outcome is scripted. Covers:
 *
 *   - matched: recording MBID + AcoustID id fanned out to every track
 *     sharing the canonical hash, mbz_id_source='acoustid', no ledger row,
 *     and the discovery.db identity upgrade (export_id anon: → mbid:,
 *     rowversion bump) without touching the embedding.
 *   - tag-sourced ids are never candidates (mbz_recording_id NULL gate).
 *   - nomatch / lowconf / undecodable ledger outcomes + cooldown gating.
 *   - error outcome retries after cooldown (backdated ledger row — never
 *     cooldown=0, which races the wall clock on fast CI).
 *   - per-run cap + hitCap signalling.
 *   - library schema guard: wrong user_version → exit 3, no writes.
 *
 * Fixture durations are the stub's switchboard: 200s→match, 201s→nomatch,
 * 202s→lowconf, 203s→API error. The .opus fixture never reaches the stub.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { applyAllMigrations } from '../helpers/apply-migrations.mjs';
import { findRustParser, FFMPEG } from '../helpers/scanner-runner.mjs';
import {
  initDiscoveryDb, closeDiscoveryDb, upsertDiscoveryTrack,
} from '../../src/db/discovery-db.js';

const run_ = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKER = path.join(REPO_ROOT, 'src', 'db', 'acoustid-backfill.mjs');

const MBID = 'e3e94892-d414-426f-bca8-002f78905f79';
const ACOUSTID = '3faa22b4-d32b-4a17-b7f4-e88ec229091b';

let scratch;
let rustBin;
let hasFingerprint = false;
let stubServer;
let stubUrl;
let stubHits = [];

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

async function makeAudio(outPath, codecArgs = ['-c:a', 'flac']) {
  await runFfmpeg([
    '-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=5',
    '-ac', '1', ...codecArgs, outPath,
  ]);
}

// Fixture library DB. Track spec: { file, dur, hash, mbid?, source? }.
// The DB duration is the stub's switchboard — files themselves are 5s tones.
function makeDb(tracks) {
  const dir = fs.mkdtempSync(path.join(scratch, 'acoustid-'));
  const libraryDbPath = path.join(dir, 'mstream.db');
  const discoveryDbPath = path.join(dir, 'discovery.db');
  const musicDir = path.join(dir, 'music');
  fs.mkdirSync(musicDir, { recursive: true });

  const db = new DatabaseSync(libraryDbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    applyAllMigrations(db);
    const libId = Number(db.prepare(
      "INSERT INTO libraries (name, root_path, type) VALUES ('lib', ?, 'music')"
    ).run(musicDir).lastInsertRowid);
    let n = 0;
    for (const t of tracks) {
      n++;
      db.prepare(`
        INSERT INTO tracks (filepath, library_id, title, duration, audio_hash, mbz_recording_id, mbz_id_source)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(t.file, libId, `T${n}`, t.dur, t.hash, t.mbid ?? null, t.source ?? null);
    }
  } finally {
    db.close();
  }
  return { dir, libraryDbPath, discoveryDbPath, musicDir };
}

function readTracks(libraryDbPath) {
  const db = new DatabaseSync(libraryDbPath, { readOnly: true });
  try {
    return db.prepare(
      'SELECT filepath, audio_hash, mbz_recording_id, acoustid_id, mbz_id_source FROM tracks ORDER BY id'
    ).all();
  } finally { db.close(); }
}

function readLedger(libraryDbPath) {
  const db = new DatabaseSync(libraryDbPath, { readOnly: true });
  try {
    return db.prepare('SELECT audio_hash, outcome, attempts, last_attempt_at FROM acoustid_lookups ORDER BY audio_hash').all();
  } finally { db.close(); }
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
      const complete = events.find((e) => e.event === 'acoustidComplete') || null;
      resolve({ code, events, complete, stdout, stderr });
    });
    p.on('error', reject);
  });
}

function basePayload(fx, extra = {}) {
  return {
    dbPath: fx.libraryDbPath,
    rustParserPath: rustBin,
    apiKey: 'test-key',
    apiUrl: stubUrl,
    throttleMs: 0, // no politeness needed against our own loopback stub
    ...extra,
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

before(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-acoustid-worker-'));
  rustBin = findRustParser();
  if (!rustBin || !fs.existsSync(FFMPEG)) { return; } // tests skip

  // Capability probe — full-ci tests against master's prebuilt rust-parser,
  // which predates --fingerprint until the post-merge binaries rebuild.
  try {
    const { stdout } = await run_(rustBin, ['--fingerprint', '__probe__']);
    hasFingerprint = 'fingerprint' in JSON.parse(stdout.trim());
  } catch (_e) { hasFingerprint = false; }

  // AcoustID stub: outcome keyed on the request's duration field.
  stubServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const form = new URLSearchParams(body);
      stubHits.push({ duration: form.get('duration'), client: form.get('client'), fp: form.get('fingerprint') });
      const responses = {
        200: { status: 'ok', results: [{ id: ACOUSTID, score: 0.98, recordings: [
          { id: 'ffffffff-0000-4000-8000-00000000000f', sources: 1 },
          { id: MBID, sources: 12 },
        ] }] },
        201: { status: 'ok', results: [] },
        202: { status: 'ok', results: [{ id: ACOUSTID, score: 0.41, recordings: [{ id: MBID, sources: 3 }] }] },
        203: { status: 'error', error: { message: 'stubbed failure' } },
      };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(responses[form.get('duration')] || { status: 'ok', results: [] }));
    });
  });
  await new Promise((r) => stubServer.listen(0, '127.0.0.1', r));
  stubUrl = `http://127.0.0.1:${stubServer.address().port}/v2/lookup`;
});

after(() => {
  if (stubServer) { stubServer.close(); }
  closeDiscoveryDb();
  fs.rmSync(scratch, { recursive: true, force: true });
});

function gate(t) {
  if (!rustBin)               { t.skip('no rust-parser binary'); return false; }
  if (!fs.existsSync(FFMPEG)) { t.skip('no bundled ffmpeg'); return false; }
  if (!hasFingerprint) {
    t.skip('rust-parser binary predates --fingerprint (CI prebuilt until the post-merge rebuild)');
    return false;
  }
  return true;
}

describe('acoustid-backfill worker', () => {
  test('match fans out over the canonical hash and upgrades the discovery export_id', async (t) => {
    if (!gate(t)) { return; }
    const fx = makeDb([
      { file: 'a.flac', dur: 200, hash: 'shared' },
      { file: 'b.flac', dur: 200, hash: 'shared' },   // byte-identical copy
    ]);
    await makeAudio(path.join(fx.musicDir, 'a.flac'));
    await makeAudio(path.join(fx.musicDir, 'b.flac'));

    // Pre-seed a discovery row for the hash: anon export_id + an embedding
    // the identity update must NOT touch.
    closeDiscoveryDb();
    initDiscoveryDb(fx.discoveryDbPath);
    upsertDiscoveryTrack({
      audioHash: 'shared', artist: 'A', title: 'T1', duration: 200,
      modelId: 'test-fake', modelVersion: '1',
      embedding: Buffer.from(new Float32Array([1, 0, 0]).buffer),
    });
    closeDiscoveryDb();

    const r = await runWorker(basePayload(fx, { discoveryDbPath: fx.discoveryDbPath }));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.complete.attempted, 1, 'one attempt per canonical hash');
    assert.equal(r.complete.matched, 1);

    const rows = readTracks(fx.libraryDbPath);
    for (const row of rows) {
      assert.equal(row.mbz_recording_id, MBID, `${row.filepath} gets the most-backed recording`);
      assert.equal(row.acoustid_id, ACOUSTID);
      assert.equal(row.mbz_id_source, 'acoustid');
    }
    assert.equal(readLedger(fx.libraryDbPath).length, 0, 'success writes no ledger row');

    const ddb = new DatabaseSync(fx.discoveryDbPath, { readOnly: true });
    const drow = ddb.prepare('SELECT export_id, recording_mbid, acoustid_id, embedding FROM discovery_tracks WHERE audio_hash = ?').get('shared');
    ddb.close();
    assert.equal(drow.export_id, `mbid:${MBID}`, 'anon: upgraded to mbid:');
    assert.equal(drow.recording_mbid, MBID);
    assert.equal(drow.acoustid_id, ACOUSTID);
    assert.ok(drow.embedding && drow.embedding.length === 12, 'embedding untouched by the identity update');
  });

  test('tag-identified tracks are never candidates', async (t) => {
    if (!gate(t)) { return; }
    const fx = makeDb([
      { file: 'tagged.flac', dur: 200, hash: 'tagged', mbid: MBID, source: 'tag' },
      { file: 'x.flac', dur: 201, hash: 'x' },
    ]);
    await makeAudio(path.join(fx.musicDir, 'tagged.flac'));
    await makeAudio(path.join(fx.musicDir, 'x.flac'));

    const r = await runWorker(basePayload(fx));
    assert.equal(r.complete.attempted, 1, 'only the un-identified track is attempted');
    const rows = readTracks(fx.libraryDbPath);
    assert.equal(rows[0].mbz_id_source, 'tag', 'tag provenance untouched');
  });

  test('nomatch and lowconf land in the ledger and cool down', async (t) => {
    if (!gate(t)) { return; }
    const fx = makeDb([
      { file: 'nm.flac', dur: 201, hash: 'nm' },
      { file: 'lc.flac', dur: 202, hash: 'lc' },
    ]);
    await makeAudio(path.join(fx.musicDir, 'nm.flac'));
    await makeAudio(path.join(fx.musicDir, 'lc.flac'));

    const r1 = await runWorker(basePayload(fx));
    assert.equal(r1.complete.nomatch, 1);
    assert.equal(r1.complete.lowconf, 1);
    const ledger = readLedger(fx.libraryDbPath);
    assert.deepEqual(ledger.map((l) => [l.audio_hash, l.outcome]),
      [['lc', 'lowconf'], ['nm', 'nomatch']]);

    const r2 = await runWorker(basePayload(fx));
    assert.equal(r2.complete.attempted, 0, 'both on cooldown');
  });

  test('opus is recorded as undecodable without an API call', async (t) => {
    if (!gate(t)) { return; }
    const fx = makeDb([{ file: 'o.opus', dur: 204, hash: 'o' }]);
    await makeAudio(path.join(fx.musicDir, 'o.opus'), ['-c:a', 'libopus']);

    stubHits = [];
    const r = await runWorker(basePayload(fx));
    assert.equal(r.complete.undecodable, 1);
    assert.equal(stubHits.length, 0, 'no lookup for an unfingerprintable file');
    assert.equal(readLedger(fx.libraryDbPath)[0].outcome, 'undecodable');
  });

  test('API errors cool down briefly and retry after backdating', async (t) => {
    if (!gate(t)) { return; }
    const fx = makeDb([{ file: 'e.flac', dur: 203, hash: 'e' }]);
    await makeAudio(path.join(fx.musicDir, 'e.flac'));

    const r1 = await runWorker(basePayload(fx));
    assert.equal(r1.complete.errors, 1);
    assert.equal(readLedger(fx.libraryDbPath)[0].outcome, 'error');

    // Still cooling: not retried.
    const r2 = await runWorker(basePayload(fx));
    assert.equal(r2.complete.attempted, 0);

    // Age the row past the error cooldown, flip the track to a matchable
    // duration — the retry should now identify it.
    const db = new DatabaseSync(fx.libraryDbPath);
    db.prepare('UPDATE acoustid_lookups SET last_attempt_at = last_attempt_at - 100000').run();
    db.prepare('UPDATE tracks SET duration = 200').run();
    db.close();
    const r3 = await runWorker(basePayload(fx));
    assert.equal(r3.complete.matched, 1);
    assert.equal(readLedger(fx.libraryDbPath).length, 1, 'stale error row remains (superseded, off the eligible path)');
  });

  test('per-run cap sets hitCap so task-queue re-enqueues', async (t) => {
    if (!gate(t)) { return; }
    const fx = makeDb([
      { file: 'h1.flac', dur: 200, hash: 'h1' },
      { file: 'h2.flac', dur: 200, hash: 'h2' },
    ]);
    await makeAudio(path.join(fx.musicDir, 'h1.flac'));
    await makeAudio(path.join(fx.musicDir, 'h2.flac'));

    const r1 = await runWorker(basePayload(fx, { maxPerRun: 1 }));
    assert.equal(r1.complete.attempted, 1);
    assert.equal(r1.complete.hitCap, true);
    const r2 = await runWorker(basePayload(fx, { maxPerRun: 1 }));
    assert.equal(r2.complete.matched, 1, 'second pass drains the remainder');
  });

  test('library schema guard refuses a mismatched DB with exit 3', async (t) => {
    if (!gate(t)) { return; }
    const fx = makeDb([{ file: 'g.flac', dur: 200, hash: 'g' }]);
    await makeAudio(path.join(fx.musicDir, 'g.flac'));

    const r = await runWorker(basePayload(fx, { expectedSchemaVersion: 9999 }));
    assert.equal(r.code, 3);
    assert.equal(readTracks(fx.libraryDbPath)[0].mbz_recording_id, null, 'no writes');
  });
});
