/**
 * V60 hash-generation migration — both engines.
 *
 * Pre-upgrade rows carry full-scheme hashes stamped hash_v=1; the V60
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
  findRustParser, rustParserHashGeneration, FFMPEG,
  initEmptyDb, buildScanConfig, runScan, runJsScan,
} from '../helpers/scanner-runner.mjs';
import { makeAudio } from '../helpers/scanner-fixture.mjs';
import { canonicalHash, HASH_GENERATION } from '../../src/db/audio-hash.js';

const MP3 = ['-c:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '3'];
const TEST_THRESHOLD = 96 * 1024;
const HUGE = Number.MAX_SAFE_INTEGER;

let rustBin;
let scratch;
let rustHasSampling = null;

before(async () => {
  rustBin = findRustParser();
  scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'mstream-hashmig-'));
  // Same capability probe as sampled-hash-vectors: one spawnSync
  // instead of the old two-full-scans feature detection.
  rustHasSampling = rustParserHashGeneration(rustBin) === HASH_GENERATION;
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

const canonOf = canonicalHash;  // the production key-preference rule, not a re-derivation

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

      // The V60 epoch: force-rescan under the real (test) threshold.
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

    test('cross-generation pairing: equal hashes pair regardless of generation stamp', async (t) => {
      if (!available()) { t.skip('ffmpeg/rust binary unavailable or stale'); return; }
      const sb = await makeSandbox('xgen', engine);
      await makeAudio(path.join(sb.libRoot, 'orig.mp3'), MP3, { title: 'G' }, 2);
      await fsp.copyFile(path.join(sb.libRoot, 'orig.mp3'), path.join(sb.libRoot, 'twin.mp3'));
      await sb.scan();

      // Seed a playlist ref on orig, then set its row to v1 — exactly
      // the upgrade-window state of a sub-threshold file (v1 and v2
      // full-MD5 schemes are byte-identical below the threshold, so
      // equal strings across generations mean equal bytes and the
      // pairing is CORRECT; the old guard wrongly refused it).
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
      assert.equal(event.movedTracksRehomed, 1,
        'equal hashes re-home across the generation stamp');
      const pl = sb.withDb(db => db.prepare(
        'SELECT filepath FROM playlist_tracks').all().map(r => r.filepath), { readOnly: true });
      assert.deepEqual(pl, [`${sb.vpath}/twin.mp3`],
        'the playlist follows the surviving twin instead of dangling');
    });

    test('epoch move-bridge: a moved above-threshold file keeps its hash-keyed user state', async (t) => {
      if (!available()) { t.skip('ffmpeg/rust binary unavailable or stale'); return; }
      const sb = await makeSandbox('bridge', engine);
      await makeAudio(path.join(sb.libRoot, 'big.mp3'), MP3, { title: 'Big' }, 30);

      // Pre-upgrade state: v1 full hashes + user state keyed on them.
      await sb.scan({ hashSampleThreshold: HUGE });
      sb.withDb(db => db.prepare('UPDATE tracks SET hash_v = 1').run());
      const h1 = canonOf(sb.rows()[0]);
      sb.withDb(db => {
        db.prepare(`INSERT OR IGNORE INTO users (id, username, password, salt)
                    VALUES (1, 'u', 'x', 'x')`).run();
        db.prepare(`INSERT INTO user_metadata (user_id, track_hash, play_count, rating)
                    VALUES (1, ?, 7, 8)`).run(h1);
        db.prepare(`INSERT OR IGNORE INTO playlists (id, name, user_id) VALUES (1, 'pl', 1)`).run();
        db.prepare(`INSERT INTO playlist_tracks (playlist_id, filepath, position)
                    VALUES (1, ?, 0)`).run(`${sb.vpath}/big.mp3`);
        db.prepare(`INSERT INTO acoustid_lookups (audio_hash, last_attempt_at, outcome)
                    VALUES (?, 100, 'nomatch')`).run(h1);
      });

      // Move the file while "the server is off", then run the epoch.
      await fsp.mkdir(path.join(sb.libRoot, 'moved'), { recursive: true });
      await fsp.rename(path.join(sb.libRoot, 'big.mp3'),
        path.join(sb.libRoot, 'moved', 'big2.mp3'));
      const { event } = await sb.scan({ hashEpoch: true });

      const rows = sb.rows();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].filepath, 'moved/big2.mp3');
      assert.equal(rows[0].hash_v, 2);
      const h2 = canonOf(rows[0]);
      assert.notEqual(h2, h1, 'above-threshold move re-keys (full → sampled)');
      assert.equal(event.staleEntriesRemoved, 1, 'old-path row swept');
      assert.equal(event.movedTracksRehomed, 1,
        'the ledger tier bridged v1 → v2 identities');

      const meta = sb.withDb(db => db.prepare(
        'SELECT track_hash, play_count, rating FROM user_metadata').all().map(r => ({ ...r })),
      { readOnly: true });
      assert.deepEqual(meta, [{ track_hash: h2, play_count: 7, rating: 8 }],
        'stars/plays keyed on the v1 hash landed on the sampled identity');
      assert.equal(sb.withDb(db => db.prepare(
        'SELECT audio_hash FROM acoustid_lookups').get().audio_hash, { readOnly: true }), h2,
      'content-derived cooldown followed (a scheme re-key, not a content change)');
      const pl = sb.withDb(db => db.prepare(
        'SELECT filepath FROM playlist_tracks').all().map(r => r.filepath), { readOnly: true });
      assert.deepEqual(pl, [`${sb.vpath}/moved/big2.mp3`], 'playlist followed the move');
      const ledger = sb.withDb(db => db.prepare(
        'SELECT old_hash, new_hash FROM hash_transitions').all().map(r => ({ ...r })),
      { readOnly: true });
      assert.deepEqual(ledger, [{ old_hash: h1, new_hash: h2 }],
        'the move-bridge ledger entry remains for the drain applier');
    });

    test('rust: refuses a pre-V60 database with a versioned schema-guard message', async (t) => {
      // Rust-only: the binary reads AND writes tracks.hash_v, so
      // against a pre-V60 DB it must refuse up front (exit 3, the
      // schema-guard code) with a message naming the needed version —
      // not die mid-scan on a raw 'no such column'. The config's
      // expectedSchemaVersion is pinned to the DB's own version to
      // simulate the dangerous combo: an OLDER server (whose
      // expectation matches its own DB) driving this newer binary.
      if (engine !== 'rust') { t.skip('rust-binary guard'); return; }
      if (!available()) { t.skip('ffmpeg/rust binary unavailable or stale'); return; }
      const { spawnSync } = await import('node:child_process');
      const { DatabaseSync } = await import('node:sqlite');
      const { applyAllMigrations } = await import('../helpers/apply-migrations.mjs');

      const root = path.join(scratch, `oldguard-${seq++}`);
      await fsp.mkdir(path.join(root, 'lib'), { recursive: true });
      await fsp.mkdir(path.join(root, 'art'), { recursive: true });
      const dbPath = path.join(root, 'old.db');
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('PRAGMA recursive_triggers = ON');
      applyAllMigrations(db, { upToVersion: 59 });
      db.prepare("INSERT INTO libraries (name, root_path) VALUES ('m', ?)").run(
        path.join(root, 'lib'));
      db.close();

      const config = buildScanConfig({
        dbPath, libraryId: 1, vpath: 'm', directory: path.join(root, 'lib'),
        albumArtDirectory: path.join(root, 'art'),
        waveformCacheDir: path.join(root, 'wave'),
        scanId: 'oldguard',
        overrides: { expectedSchemaVersion: 59 },
      });
      const r = spawnSync(rustBin, [JSON.stringify(config)],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
      assert.equal(r.status, 3, `schema-guard exit code, stderr: ${r.stderr}`);
      assert.match((r.stderr || '').toString(), /tracks\.hash_v.*V60/s,
        'the refusal names the missing column and the needed version');
    });

    test('content replacement: derived cooldowns stay behind, no transition recorded', async (t) => {
      if (!available()) { t.skip('ffmpeg/rust binary unavailable or stale'); return; }
      const sb = await makeSandbox('content', engine);
      await makeAudio(path.join(sb.libRoot, 'song.mp3'), MP3, { title: 'One' }, 2);
      await sb.scan();
      const c1 = canonOf(sb.rows()[0]);
      sb.withDb(db => {
        db.prepare(`INSERT OR IGNORE INTO users (id, username, password, salt)
                    VALUES (1, 'u', 'x', 'x')`).run();
        db.prepare(`INSERT INTO user_metadata (user_id, track_hash, play_count)
                    VALUES (1, ?, 5)`).run(c1);
        db.prepare(`INSERT INTO acoustid_lookups (audio_hash, last_attempt_at, outcome)
                    VALUES (?, 100, 'error')`).run(c1);
        db.prepare(`INSERT INTO audio_analysis_lookups (audio_hash, last_attempt_at, outcome)
                    VALUES (?, 100, 'lowconf')`).run(c1);
      });

      // Replace the audio at the same path (different recording), with a
      // guaranteed-different mtime so the fast-path can't mask it.
      await makeAudio(path.join(sb.libRoot, 'song.mp3'), MP3, { title: 'Two' }, 3);
      const future = new Date(Date.now() + 5000);
      await fsp.utimes(path.join(sb.libRoot, 'song.mp3'), future, future);
      await sb.scan();

      const c2 = canonOf(sb.rows()[0]);
      assert.notEqual(c2, c1, 'content change re-keyed the row');
      assert.equal(sb.rows()[0].hash_v, 2, 'still current generation');

      assert.equal(sb.withDb(db => db.prepare(
        'SELECT COUNT(*) AS n FROM hash_transitions').get().n, { readOnly: true }), 0,
      'NO transition recorded — the old audio\'s waveform/embedding must orphan ' +
      'and regenerate, not follow bytes they don\'t describe');
      const meta = sb.withDb(db => db.prepare(
        'SELECT track_hash, play_count FROM user_metadata').all().map(r => ({ ...r })),
      { readOnly: true });
      assert.deepEqual(meta, [{ track_hash: c2, play_count: 5 }],
        'user state follows the content change (path is identity for user intent)');
      for (const table of ['acoustid_lookups', 'audio_analysis_lookups']) {
        assert.equal(sb.withDb(db => db.prepare(
          `SELECT audio_hash FROM ${table}`).get().audio_hash, { readOnly: true }), c1,
        `${table}: cooldown left behind for the orphan sweep — new audio must not ` +
        'inherit a failure for attempts that never ran against it');
      }
    });
  });
}
