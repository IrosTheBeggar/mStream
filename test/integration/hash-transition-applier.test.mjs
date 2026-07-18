/**
 * V59 hash-transition applier — end to end through a real server.
 *
 * The scanner records old→new canonical identities into hash_transitions
 * when a re-key changes them; task-queue drains that ledger into
 * discovery.db when the task queue drains (embeddings are expensive —
 * they must FOLLOW a re-key, not orphan into a full re-embed). This
 * boots a real server with the dependency-free 'test-fake' embedding
 * model, lets the discovery worker embed the fixture library for real,
 * seeds a transition CHAIN (a→b, b→c — the applier must collapse it so
 * the row lands at the terminal identity), triggers a scan, and asserts
 * the drain hook applied and emptied the ledger.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../helpers/server.mjs';
import { makeAudio } from '../helpers/scanner-fixture.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let longDir;
let mstreamDbPath;
let discoveryDbPath;

function withDb(p, fn) {
  const db = new DatabaseSync(p);
  try { return fn(db); } finally { db.close(); }
}

before(async () => {
  // The discovery worker's eligibility gate skips tracks under 30s and
  // the shared fixtures are seconds long — bring one eligible track.
  longDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mstream-applier-lib-'));
  await makeAudio(path.join(longDir, 'long.mp3'),
    ['-c:a', 'libmp3lame', '-b:a', '64k'], { artist: 'L', title: 'Long' }, 35);

  server = await startServer({
    dlnaMode: 'disabled',
    extraFolders: { longlib: longDir },
    extraConfig: {
      discoveryModel: 'test-fake',
      scanOptions: { collectDiscoveryData: true, autoAlbumArt: false },
    },
  });
  mstreamDbPath = path.join(server.tmpDir, 'db', 'mstream.db');
  discoveryDbPath = path.join(server.tmpDir, 'db', 'discovery.db');
});

after(async () => {
  if (server) { await server.stop(); }
  if (longDir) { await fsp.rm(longDir, { recursive: true, force: true }).catch(() => {}); }
});

describe('hash-transition applier', () => {
  test('chain-collapsed transitions re-key discovery.db and drain the ledger', async () => {
    // Wait for the test-fake worker to embed at least one fixture track.
    let seedHash = null;
    for (let i = 0; i < 240 && !seedHash; i++) {
      try {
        seedHash = withDb(discoveryDbPath, (d) =>
          d.prepare('SELECT audio_hash FROM discovery_tracks LIMIT 1').get()?.audio_hash) ?? null;
      } catch { /* db not created yet */ }
      if (!seedHash) { await sleep(500); }
    }
    assert.ok(seedHash, 'discovery worker embedded the fixture library');

    // Seed a transition CHAIN for that embedding's identity. The middle
    // hop never exists as a row — the applier must land the row at the
    // terminal identity in one pass.
    const mid = 'a'.repeat(32);
    const fin = 'b'.repeat(32);
    withDb(mstreamDbPath, (d) => {
      d.prepare('INSERT OR REPLACE INTO hash_transitions (old_hash, new_hash) VALUES (?, ?)')
        .run(seedHash, mid);
      d.prepare('INSERT OR REPLACE INTO hash_transitions (old_hash, new_hash) VALUES (?, ?)')
        .run(mid, fin);
    });

    // Any drained scan batch fires the applier.
    const r = await fetch(`${server.baseUrl}/api/v1/admin/db/scan/force-rescan`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 200);

    let applied = false;
    for (let i = 0; i < 240 && !applied; i++) {
      const ledger = withDb(mstreamDbPath, (d) =>
        d.prepare('SELECT COUNT(*) AS n FROM hash_transitions').get().n);
      if (ledger === 0) { applied = true; break; }
      await sleep(500);
    }
    assert.ok(applied, 'ledger drained after the scan batch');

    const rows = withDb(discoveryDbPath, (d) =>
      d.prepare('SELECT audio_hash FROM discovery_tracks WHERE audio_hash IN (?, ?, ?)')
        .all(seedHash, mid, fin).map((x) => x.audio_hash));
    assert.deepEqual(rows, [fin],
      'embedding re-keyed to the TERMINAL identity (chain collapsed, no stragglers)');
  });
});
