/**
 * V59 hash-transition applier — end to end through real servers.
 *
 * The scanner records old→new canonical identities into hash_transitions
 * when a re-key changes them; task-queue drains that ledger when the
 * queue drains, re-keying discovery.db (embeddings are expensive — they
 * must FOLLOW a re-key, not orphan into a full re-embed) and renaming
 * the on-disk waveform cache ({hash}.bin / {hash}.failed).
 *
 * Server A (discovery ON): a real embedding from the dependency-free
 * 'test-fake' model follows a transition CHAIN to its terminal identity
 * with the export_id/updated_at invariants preserved, and the waveform
 * artifacts rename at drain. The chain's terminal is a LIVE track's
 * canonical hash (a sub-30s fixture the discovery worker never embeds)
 * so the worker's post-drain orphan prune and re-embed cannot race the
 * assertions.
 *
 * Server B (discovery collection OFF): the paths a discovery-ON server
 * can't reach —
 *   - the ledger must drain (and waveforms rename) with NO discovery.db
 *     at all, without creating one;
 *   - a DORMANT discovery.db (collection since disabled) still gets its
 *     rows re-keyed: freshest-wins when several sources collapse to one
 *     terminal, and cycles (edit-then-revert ledgers) resolve against
 *     the tracks table instead of stranding rows at dead identities.
 *   With collection off the discovery worker never forks, so forged
 *   rows are never orphan-pruned — fully deterministic.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../helpers/server.mjs';
import { makeAudio } from '../helpers/scanner-fixture.mjs';
import {
  initDiscoveryDb, closeDiscoveryDb, upsertDiscoveryTrack,
} from '../../src/db/discovery-db.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withDb(p, fn) {
  const db = new DatabaseSync(p);
  try { return fn(db); } finally { db.close(); }
}

// Canonical hash of a track row, looked up by filepath suffix.
function canonOfTrack(mstreamDbPath, filepathLike) {
  return withDb(mstreamDbPath, (d) => {
    const r = d.prepare(
      `SELECT COALESCE(audio_hash, file_hash) AS canon FROM tracks
        WHERE filepath LIKE ? LIMIT 1`).get(`%${filepathLike}%`);
    return r?.canon ?? null;
  });
}

function seedTransition(mstreamDbPath, oldHash, newHash) {
  withDb(mstreamDbPath, (d) => {
    d.prepare('INSERT OR REPLACE INTO hash_transitions (old_hash, new_hash) VALUES (?, ?)')
      .run(oldHash, newHash);
  });
}

async function forceRescanAndDrain(server, mstreamDbPath) {
  const r = await fetch(`${server.baseUrl}/api/v1/admin/db/scan/force-rescan`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 200);
  for (let i = 0; i < 240; i++) {
    const n = withDb(mstreamDbPath, (d) =>
      d.prepare('SELECT COUNT(*) AS n FROM hash_transitions').get().n);
    if (n === 0) { return; }
    await sleep(500);
  }
  assert.fail('hash_transitions did not drain');
}

// The anon export id the single-write-path invariant requires after a
// re-key: sha256(install salt + NEW hash), recomputed from the DB's own
// stored salt — proves the applier went through exportIdFor, not a raw
// UPDATE that left the id derived from the dead hash.
function expectedAnonId(discoveryDbPath, audioHash) {
  const salt = withDb(discoveryDbPath, (d) =>
    d.prepare("SELECT value FROM discovery_meta WHERE key = 'export_salt'").get().value);
  return `anon:${crypto.createHash('sha256').update(salt + audioHash).digest('hex').slice(0, 32)}`;
}

describe('hash-transition applier (discovery ON — live worker)', () => {
  let server;
  let longDir;
  let mdb;
  let ddbPath;
  let waveDir;

  before(async () => {
    // The discovery worker's eligibility gate skips tracks under 30s and
    // the shared fixtures are seconds long — bring one eligible track,
    // plus a short (never-embedded, but LIVE) chain terminal.
    longDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mstream-applier-lib-'));
    await makeAudio(path.join(longDir, 'long.mp3'),
      ['-c:a', 'libmp3lame', '-b:a', '64k'], { artist: 'L', title: 'Long' }, 35);
    await makeAudio(path.join(longDir, 'terminal.mp3'),
      ['-c:a', 'libmp3lame', '-b:a', '64k'], { artist: 'T', title: 'Terminal' }, 2);

    server = await startServer({
      dlnaMode: 'disabled',
      extraFolders: { longlib: longDir },
      extraConfig: {
        discoveryModel: 'test-fake',
        // generateWaveforms off: the post-drain waveform pass would
        // regenerate {seedHash}.bin for the still-live track and race
        // the 'old bin gone' assertion.
        scanOptions: {
          collectDiscoveryData: true, autoAlbumArt: false, generateWaveforms: false,
        },
      },
    });
    mdb = path.join(server.tmpDir, 'db', 'mstream.db');
    ddbPath = path.join(server.tmpDir, 'db', 'discovery.db');
    waveDir = path.join(server.tmpDir, 'waveform-cache');
    await fsp.mkdir(waveDir, { recursive: true });
  });

  after(async () => {
    if (server) { await server.stop(); }
    if (longDir) { await fsp.rm(longDir, { recursive: true, force: true }).catch(() => {}); }
  });

  test('a chained re-key lands the embedding at the terminal identity with invariants intact', async () => {
    // Wait for the test-fake worker to embed the eligible track.
    let seed = null;
    for (let i = 0; i < 240 && !seed; i++) {
      try {
        seed = withDb(ddbPath, (d) => {
          const r = d.prepare(
            'SELECT audio_hash, updated_at FROM discovery_tracks LIMIT 1').get();
          return r ? { ...r } : null;
        });
      } catch { /* db not created yet */ }
      if (!seed) { await sleep(500); }
    }
    assert.ok(seed, 'discovery worker embedded the eligible track');

    // Chain seed→mid→fin. The middle hop never exists as a row; the
    // terminal is the LIVE short track's canon, so the worker's orphan
    // prune keeps the moved row and nothing races the assertions.
    const mid = 'a'.repeat(32);
    const fin = canonOfTrack(mdb, 'terminal.mp3');
    assert.ok(fin, 'terminal fixture scanned');
    seedTransition(mdb, seed.audio_hash, mid);
    seedTransition(mdb, mid, fin);

    // Waveform artifacts at the seed identity must follow to `fin`.
    await fsp.writeFile(path.join(waveDir, `${seed.audio_hash}.bin`), 'wavedata');
    await fsp.writeFile(path.join(waveDir, `${seed.audio_hash}.failed`), 'symphonia\n');

    await forceRescanAndDrain(server, mdb);

    const finRow = withDb(ddbPath, (d) => {
      const r = d.prepare(
        `SELECT audio_hash, export_id, updated_at, embedding IS NOT NULL AS has_embedding
           FROM discovery_tracks WHERE audio_hash = ?`).get(fin);
      return r ? { ...r } : null;
    });
    assert.ok(finRow, 'embedding re-keyed to the TERMINAL identity (chain collapsed)');
    assert.equal(finRow.has_embedding, 1, 'the moved row is the real embedding row');
    assert.equal(withDb(ddbPath, (d) =>
      d.prepare('SELECT 1 FROM discovery_tracks WHERE audio_hash = ?').get(mid)), undefined,
    'no straggler at the middle hop');
    // Single-write-path invariants: export_id recomputed against the NEW
    // hash, updated_at bumped past the pre-move rowversion.
    assert.equal(finRow.export_id, expectedAnonId(ddbPath, fin),
      'export_id re-derived from the new identity');
    assert.ok(finRow.updated_at > seed.updated_at,
      'rowversion bumped — incremental consumers and the similarity cache see the re-key');
    // Waveform artifacts renamed at drain.
    assert.ok(fs.existsSync(path.join(waveDir, `${fin}.bin`)), 'waveform bin followed');
    assert.ok(fs.existsSync(path.join(waveDir, `${fin}.failed`)), 'failed marker followed');
    assert.ok(!fs.existsSync(path.join(waveDir, `${seed.audio_hash}.bin`)), 'old bin gone');
  });
});

describe('hash-transition applier (discovery collection OFF)', () => {
  let server;
  let mdb;
  let ddbPath;
  let waveDir;
  let liveCanons;

  before(async () => {
    server = await startServer({
      dlnaMode: 'disabled',
      extraConfig: {
        scanOptions: { autoAlbumArt: false, generateWaveforms: false },
      },
    });
    mdb = path.join(server.tmpDir, 'db', 'mstream.db');
    ddbPath = path.join(server.tmpDir, 'db', 'discovery.db');
    waveDir = path.join(server.tmpDir, 'waveform-cache');
    await fsp.mkdir(waveDir, { recursive: true });
    liveCanons = withDb(mdb, (d) =>
      d.prepare(`SELECT COALESCE(audio_hash, file_hash) AS canon FROM tracks LIMIT 3`)
        .all().map((r) => r.canon));
    assert.equal(liveCanons.length, 3, 'fixture library scanned');
  });

  after(async () => {
    if (server) { await server.stop(); }
  });

  test('the ledger drains (and waveforms rename) with no discovery.db, without creating one', async () => {
    const p = 'b'.repeat(32);
    const q = 'c'.repeat(32);
    seedTransition(mdb, p, q);
    await fsp.writeFile(path.join(waveDir, `${p}.bin`), 'wavedata');

    await forceRescanAndDrain(server, mdb);

    assert.ok(!fs.existsSync(ddbPath),
      'draining must not silently create discovery.db');
    assert.ok(fs.existsSync(path.join(waveDir, `${q}.bin`)),
      'waveform renamed even with discovery off');
    assert.ok(!fs.existsSync(path.join(waveDir, `${p}.bin`)), 'old bin gone');
  });

  test('a dormant discovery.db is still re-keyed, freshest source winning per terminal', async () => {
    // Create + seed the dormant DB from the test process (the server has
    // collection off and will only open it lazily at drain time).
    const a = 'd'.repeat(32);
    const b = 'e'.repeat(32);
    const c = liveCanons[0];
    initDiscoveryDb(ddbPath);
    try {
      upsertDiscoveryTrack({ audioHash: a, artist: 'stale' });   // older rowversion
      upsertDiscoveryTrack({ audioHash: b, artist: 'fresh' });   // newer rowversion
    } finally { closeDiscoveryDb(); }
    seedTransition(mdb, a, b);
    seedTransition(mdb, b, c);

    await forceRescanAndDrain(server, mdb);

    const rows = withDb(ddbPath, (d) =>
      d.prepare('SELECT audio_hash, artist, export_id FROM discovery_tracks').all()
        .map((r) => ({ ...r })));
    assert.equal(rows.length, 1, 'both sources collapsed to one row');
    assert.equal(rows[0].audio_hash, c, 'row landed at the terminal identity');
    assert.equal(rows[0].artist, 'fresh',
      'the FRESHEST source won — not insertion-order roulette');
    assert.equal(rows[0].export_id, expectedAnonId(ddbPath, c),
      'export_id re-derived from the terminal identity');
  });

  test('a transition cycle resolves to the identity the tracks table holds', async () => {
    // Edit-then-revert: X→Y then Y→X recorded before a drain. X is a real
    // track's canonical hash; the ledger alone can't say which end is
    // current — the tracks table can.
    const x = liveCanons[1];
    const y = 'f'.repeat(32);
    initDiscoveryDb(ddbPath);
    try { upsertDiscoveryTrack({ audioHash: y, artist: 'cyc' }); }
    finally { closeDiscoveryDb(); }
    seedTransition(mdb, x, y);
    seedTransition(mdb, y, x);

    await forceRescanAndDrain(server, mdb);

    const atX = withDb(ddbPath, (d) => {
      const r = d.prepare(
        'SELECT artist FROM discovery_tracks WHERE audio_hash = ?').get(x);
      return r ? { ...r } : null;
    });
    assert.ok(atX && atX.artist === 'cyc',
      'the mid-cycle row moved to the LIVE identity instead of stranding');
    assert.equal(withDb(ddbPath, (d) =>
      d.prepare('SELECT 1 FROM discovery_tracks WHERE audio_hash = ?').get(y)), undefined,
    'nothing left at the dead identity');
  });
});
