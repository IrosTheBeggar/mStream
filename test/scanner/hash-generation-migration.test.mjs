/**
 * V59 hash-generation migration — both engines.
 *
 * Pre-upgrade rows carry full-scheme hashes stamped hash_v=1; the V59
 * epoch force-rescans, computing threshold-hybrid hashes stamped 2 and
 * re-keying everything hash-keyed per file through the existing
 * canon-migration machinery. These tests simulate v1 rows exactly (scan
 * with a huge threshold ⇒ full hashes, then stamp hash_v=1) and pin:
 *
 *   - the epoch re-key: hash_v=2 everywhere after a forceRescan with the
 *     real (tiny, test-overridden) threshold; above-threshold files get
 *     new canonical identities, below-threshold files keep theirs (no
 *     spurious transitions);
 *   - user state follows: user_metadata rows keyed on the old canonical
 *     hash land on the new one;
 *   - the transition ledger records exactly the re-keyed pairs for the
 *     post-scan discovery applier;
 *   - the waveform cache is NOT renamed scanner-side (that happens in
 *     task-queue's drain applier, post-commit, off the ledger — see
 *     test/integration/hash-transition-applier.test.mjs);
 *   - the pairing generation guard: a v1 candidate never pairs with a
 *     v2 target even when the hash strings match — the transition
 *     window degrades to a dangle, never a mispair.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  findRustParser, FFMPEG, initEmptyDb, buildScanConfig, runScan, runJsScan,
} from '../helpers/scanner-runner.mjs';
import { makeAudio } from '../helpers/scanner-fixture.mjs';

const MP3 = ['-c:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '3'];
const TEST_THRESHOLD = 96 * 1024;
const HUGE = Number.MAX_SAFE_INTEGER;

let rustBin;
let scratch;
let rustHasSampling = null;

before(async () => {
  rustBin = findRustParser();
  scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'mstream-hashmig-'));
  if (rustBin && fs.existsSync(FFMPEG)) {
    // Same feature probe as sampled-hash-vectors: stale binaries ignore
    // the threshold override and keep full hashes.
    const sb = await makeSandbox('probe', 'rust');
    await makeAudio(path.join(sb.libRoot, 'p.mp3'), MP3, { title: 'P' }, 30);
    await sb.scan();
    const v1 = sb.rows()[0].file_hash;
    await sb.scan({ forceRescan: true, hashSampleThreshold: HUGE });
    rustHasSampling = sb.rows()[0].file_hash !== v1;
  }
});

after(async () => {
  if (scratch) { await fsp.rm(scratch, { recursive: true, force: true }); }
});

let seq = 0;
async function makeSandbox(label, engine) {
  const root = path.join(scratch, `${label}-${seq++}-${engine}`);
  const libRoot = path.join(root, 'lib');
  const waveDir = path.join(root, 'wave');
  await fsp.mkdir(libRoot, { recursive: true });
  await fsp.mkdir(waveDir, { recursive: true });
  await fsp.mkdir(path.join(root, 'art'), { recursive: true });
  const dbPath = path.join(root, 'test.db');
  const { libraryId, vpath } = initEmptyDb(dbPath, libRoot);
  let scanSeq = 0;
  const scan = (overrides = {}) => {
    const config = buildScanConfig({
      dbPath, libraryId, vpath, directory: libRoot,
      albumArtDirectory: path.join(root, 'art'), waveformCacheDir: waveDir,
      scanId: `s-${label}-${scanSeq++}`,
      overrides: { hashSampleThreshold: TEST_THRESHOLD, ...overrides },
    });
    return engine === 'js' ? runJsScan(config) : runScan(rustBin, config);
  };
  const withDb = (fn, opts = {}) => {
    const db = new DatabaseSync(dbPath, opts);
    try { return fn(db); } finally { db.close(); }
  };
  const rows = () => withDb(db => db.prepare(
    'SELECT filepath, file_hash, audio_hash, hash_v FROM tracks ORDER BY filepath')
    .all().map(r => ({ ...r })), { readOnly: true });
  return { root, libRoot, waveDir, dbPath, libraryId, vpath, scan, withDb, rows };
}

const canonOf = (r) => r.audio_hash || r.file_hash;

for (const engine of ['rust', 'js']) {
  const available = () =>
    fs.existsSync(FFMPEG) && (engine === 'js' || (!!rustBin && rustHasSampling !== false));

  describe(`hash-generation migration (${engine} scanner)`, () => {
    test('epoch re-keys rows, user state, ledger, and waveform cache', async (t) => {
      if (!available()) { t.skip('ffmpeg/rust binary unavailable or stale'); return; }
      const sb = await makeSandbox('epoch', engine);
      await makeAudio(path.join(sb.libRoot, 'big.mp3'), MP3, { title: 'Big' }, 30);
      await makeAudio(path.join(sb.libRoot, 'small.mp3'), MP3, { title: 'Small' }, 1);

      // Simulate pre-upgrade state: full-scheme hashes + hash_v=1.
      await sb.scan({ hashSampleThreshold: HUGE });
      sb.withDb(db => db.prepare('UPDATE tracks SET hash_v = 1').run());
      const v1 = sb.rows();
      const bigV1 = canonOf(v1.find(r => r.filepath === 'big.mp3'));
      const smallV1 = canonOf(v1.find(r => r.filepath === 'small.mp3'));

      // User state + waveform artifacts keyed on the old canonical hash.
      sb.withDb(db => {
        db.prepare(`INSERT OR IGNORE INTO users (id, username, password, salt)
                    VALUES (1, 'u', 'x', 'x')`).run();
        db.prepare(`INSERT INTO user_metadata (user_id, track_hash, play_count, rating)
                    VALUES (1, ?, 7, 8)`).run(bigV1);
      });
      await fsp.writeFile(path.join(sb.waveDir, `${bigV1}.bin`), 'wavedata');
      await fsp.writeFile(path.join(sb.waveDir, `${bigV1}.failed`), '');

      // The V59 epoch: force-rescan under the real (test) threshold.
      await sb.scan({ forceRescan: true });
      const v2 = sb.rows();
      assert.ok(v2.every(r => r.hash_v === 2), 'every row stamped generation 2');
      const bigV2 = canonOf(v2.find(r => r.filepath === 'big.mp3'));
      const smallV2 = canonOf(v2.find(r => r.filepath === 'small.mp3'));
      assert.notEqual(bigV2, bigV1, 'above-threshold file re-keyed');
      assert.equal(smallV2, smallV1, 'below-threshold file keeps its identity');

      // User state followed the re-key.
      const meta = sb.withDb(db => db.prepare(
        'SELECT track_hash, play_count, rating FROM user_metadata').all().map(r => ({ ...r })),
      { readOnly: true });
      assert.deepEqual(meta, [{ track_hash: bigV2, play_count: 7, rating: 8 }],
        'user_metadata re-keyed to the new canonical hash');

      // Ledger records exactly the re-keyed pair (small file has none).
      const ledger = sb.withDb(db => db.prepare(
        'SELECT old_hash, new_hash FROM hash_transitions').all().map(r => ({ ...r })),
      { readOnly: true });
      assert.deepEqual(ledger, [{ old_hash: bigV1, new_hash: bigV2 }],
        'transition ledger holds only the genuinely re-keyed identity');

      // Waveform artifacts are NOT touched scanner-side: the rename
      // happens in task-queue's drain applier, from the ledger, after
      // every row's transaction has committed (a scanner-side rename
      // could survive a rollback and strand the cache at an identity
      // the DB never adopted). The scan must leave them at the old
      // name; the applier integration test covers the rename itself.
      assert.ok(fs.existsSync(path.join(sb.waveDir, `${bigV1}.bin`)), 'bin untouched by the scan');
      assert.ok(fs.existsSync(path.join(sb.waveDir, `${bigV1}.failed`)), 'failed marker untouched');
      assert.ok(!fs.existsSync(path.join(sb.waveDir, `${bigV2}.bin`)), 'no scanner-side rename');

      // Idempotency: another normal scan changes nothing further.
      await sb.scan();
      assert.deepEqual(sb.rows(), v2, 'stable after the epoch');
    });

    test('hashEpoch mode re-parses ONLY stale-generation rows', async (t) => {
      if (!available()) { t.skip('ffmpeg/rust binary unavailable or stale'); return; }
      const sb = await makeSandbox('hepoch', engine);
      for (const n of ['a', 'b', 'c']) {
        await makeAudio(path.join(sb.libRoot, `${n}.mp3`), MP3, { title: n.toUpperCase() }, 1);
      }
      await sb.scan();
      assert.ok(sb.rows().every(r => r.hash_v === 2), 'baseline: all rows current generation');

      // Forge one row back to the old generation (its file is untouched
      // — exactly the state the convergence epoch exists to fix).
      sb.withDb(db => db.prepare(`UPDATE tracks SET hash_v = 1 WHERE filepath = 'b.mp3'`).run());

      const { event } = await sb.scan({ hashEpoch: true });
      assert.equal(event.filesProcessed, 1,
        'the epoch re-parses the stale-generation row and fast-paths the rest');
      assert.ok(sb.rows().every(r => r.hash_v === 2), 'straggler re-stamped');

      // Converged: another epoch pass is a free no-op.
      const again = await sb.scan({ hashEpoch: true });
      assert.equal(again.event.filesProcessed, 0, 'converged epoch re-parses nothing');
    });

    test('pairing generation guard: a v1 candidate never pairs with a v2 target', async (t) => {
      if (!available()) { t.skip('ffmpeg/rust binary unavailable or stale'); return; }
      const sb = await makeSandbox('guard', engine);
      await makeAudio(path.join(sb.libRoot, 'orig.mp3'), MP3, { title: 'G' }, 2);
      await fsp.copyFile(path.join(sb.libRoot, 'orig.mp3'), path.join(sb.libRoot, 'twin.mp3'));
      await sb.scan();

      // Seed a playlist ref on orig, then FORGE its row back to v1 (the
      // hash strings still match the twin's v2 strings — exactly the
      // cross-generation coincidence the guard must refuse to trust).
      sb.withDb(db => {
        db.prepare(`INSERT OR IGNORE INTO users (id, username, password, salt)
                    VALUES (1, 'u', 'x', 'x')`).run();
        db.prepare(`INSERT OR IGNORE INTO playlists (id, name, user_id) VALUES (1, 'pl', 1)`).run();
        db.prepare(`INSERT INTO playlist_tracks (playlist_id, filepath, position)
                    VALUES (1, ?, 0)`).run(`${sb.vpath}/orig.mp3`);
        db.prepare(`UPDATE tracks SET hash_v = 1 WHERE filepath = 'orig.mp3'`).run();
      });

      await fsp.rm(path.join(sb.libRoot, 'orig.mp3'));
      const { event } = await sb.scan();

      assert.equal(event.staleEntriesRemoved, 1, 'the v1 row swept normally');
      assert.equal(event.movedTracksRehomed, 0,
        'no cross-generation pairing — the guard held');
      const pl = sb.withDb(db => db.prepare(
        'SELECT filepath FROM playlist_tracks').all().map(r => r.filepath), { readOnly: true });
      assert.deepEqual(pl, [`${sb.vpath}/orig.mp3`],
        'reference dangles (pre-feature behaviour) rather than mispairing');
    });
  });
}
