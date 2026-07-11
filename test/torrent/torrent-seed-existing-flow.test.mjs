/**
 * Unit tests for src/torrent/seed-existing-flow.js — the orchestrator
 * that wraps checkFilesExist + the daemon add + the managed_torrents
 * write. Boots a real config + DB (same pattern as
 * torrent-completion-watcher.test.mjs) and stubs the RPC module, so
 * the tests pin the outcome contract without a live daemon.
 *
 * The headline regressions covered here:
 *   - the filesystem check runs even when the vpath has no usable
 *     path mapping (it used to be silently skipped, reporting a flat
 *     `no_match` with every file on disk), surfacing `match_unmapped`
 *   - a BEP 47 hybrid torrent (pad files) seeds end-to-end when all
 *     real files are on disk
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const B = (s) => Buffer.from(s);

// Multi-file torrent builder — same encoding as torrent-seed-existing.test.mjs.
function makeMultiFile(topName, files) {
  let inner = `d4:name${topName.length}:${topName}5:files` + 'l';
  for (const f of files) {
    let pathList = 'l';
    for (const seg of f.path) { pathList += `${seg.length}:${seg}`; }
    pathList += 'e';
    const attr = f.attr ? `4:attr${f.attr.length}:${f.attr}` : '';
    inner += `d${attr}6:lengthi${f.length}e4:path${pathList}e`;
  }
  inner += 'ee';
  return B(`d4:info${inner}e`);
}

let tmpDir, dbManager, cache, flow, SEED_OUTCOMES, userId;
let mappedRoot, unmappedRoot, unconfirmedRoot;

// Stub RPC module. `addCalls` records every addTorrent invocation so
// tests can assert the daemon was (or was not) touched.
const addCalls = [];
const stubModule = {
  listTorrents: () => Promise.resolve([]),
  addTorrent:   (creds, args) => {
    addCalls.push(args);
    return Promise.resolve({ infoHash: null, name: '', isDuplicate: false });
  },
};

async function layOut(root, files) {
  for (const f of files) {
    const full = path.join(root, f.relPath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, Buffer.alloc(f.size, 0));
  }
}

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-seedflow-'));
  fsSync.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
  fsSync.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    storage: {
      dbDirectory:       path.join(tmpDir, 'db'),
      albumArtDirectory: path.join(tmpDir, 'art'),
      logsDirectory:     path.join(tmpDir, 'logs'),
    },
    port: 0,
  }, null, 2));
  const config = await import('../../src/state/config.js');
  await config.setup(path.join(tmpDir, 'config.json'));
  dbManager = await import('../../src/db/manager.js');
  dbManager.initDB();

  // managed_torrents.user_id has an FK to users — seed one row.
  dbManager.getDB().prepare(
    `INSERT INTO users (username, password, salt) VALUES ('seeder', 'x', 'x')`
  ).run();
  userId = dbManager.getDB().prepare(
    `SELECT id FROM users WHERE username = 'seeder'`
  ).get().id;

  // Three libraries: one with a usable mapping, one never probed,
  // one probed-but-unconfirmed.
  mappedRoot      = path.join(tmpDir, 'lib-mapped');
  unmappedRoot    = path.join(tmpDir, 'lib-unmapped');
  unconfirmedRoot = path.join(tmpDir, 'lib-unconfirmed');
  for (const [name, root] of [
    ['mapped', mappedRoot], ['unmapped', unmappedRoot], ['unconfirmed', unconfirmedRoot],
  ]) {
    await fs.mkdir(root, { recursive: true });
    dbManager.getDB().prepare(
      `INSERT INTO libraries (name, root_path, type, follow_symlinks)
       VALUES (?, ?, 'music', 0)`
    ).run(name, root);
  }
  // The manager memoises library rows on first read; anything that
  // touched them before these raw INSERTs would leave the flow's
  // getLibraryByName() blind to the new rows.
  dbManager.invalidateCache();

  cache = await import('../../src/torrent/vpath-access-cache.js');
  // Mirror a usable 'mapped' row for both clients we exercise, so the
  // pad-policy split (Transmission requires pads, qBittorrent doesn't)
  // can be tested with the same library layout.
  for (const clientType of ['transmission', 'qbittorrent']) {
    cache.upsert({
      clientType, vpathName: 'mapped',
      result: {
        confidence: 'verified', method: 'test', verified: true,
        daemonPath: '/downloads/mapped', mstreamWritable: true,
      },
      source: 'auto',
    });
  }
  cache.upsert({
    clientType: 'transmission', vpathName: 'unconfirmed',
    result: {
      confidence: 'unconfirmed', method: 'test', verified: false,
      daemonPath: null, reason: 'probe failed',
    },
    source: 'auto',
  });
  // 'unmapped' deliberately gets no row at all.

  ({ processSeedExistingFlow: flow, SEED_OUTCOMES } =
    await import('../../src/torrent/seed-existing-flow.js'));
});

after(async () => {
  // Same teardown as torrent-completion-watcher.test.mjs: the SQLite
  // handle keeps the event loop alive, so exit explicitly once the
  // temp dir is gone.
  try { await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  catch { /* leave the temp dir */ }
  setImmediate(() => process.exit(0));
});

function runFlow(fileBuffer, vpathNames, clientType = 'transmission') {
  return flow({
    fileBuffer,
    vpathNames,
    clientType,
    active:     { creds: { host: 'stub' }, module: stubModule },
    userId,
  });
}

describe('seed-existing flow outcomes', () => {
  // Hybrid torrent with a pad file; the pad is NOT on disk (realistic —
  // a user's library holds only their real files). Verified against
  // real daemons: qBittorrent/Deluge synthesize the pad and seed;
  // Transmission stalls without it.
  const hybridMeta = makeMultiFile('Hybrid', [
    { path: ['01.flac'], length: 100 },
    { path: ['.pad', '412'], length: 412, attr: 'p' },
    { path: ['02.flac'], length: 200 },
  ]);

  test('hybrid torrent on qBittorrent (pads synthesized) → seeded, daemon add fires', async () => {
    await layOut(mappedRoot, [
      { relPath: 'Hybrid/01.flac', size: 100 },
      { relPath: 'Hybrid/02.flac', size: 200 },
    ]);
    addCalls.length = 0;
    const r = await runFlow(hybridMeta, ['mapped'], 'qbittorrent');
    assert.equal(r.outcome, SEED_OUTCOMES.SEEDED);
    assert.equal(r.vpath, 'mapped');
    assert.equal(addCalls.length, 1);
    assert.equal(addCalls[0].downloadDir, '/downloads/mapped');
    assert.equal(addCalls[0].paused, false);
    const row = dbManager.getDB().prepare(
      `SELECT download_path FROM managed_torrents WHERE info_hash = ?`
    ).get(r.infoHash);
    assert.equal(row.download_path, '/downloads/mapped/Hybrid');
  });

  test('hybrid torrent on Transmission with NO pad on disk → pad_files_missing, daemon untouched', async () => {
    // Regression for the smoke-test finding: Transmission 4.1.3 can't
    // reconstruct the boundary piece, so we must NOT claim seeded.
    await layOut(mappedRoot, [
      { relPath: 'Hybrid/01.flac', size: 100 },
      { relPath: 'Hybrid/02.flac', size: 200 },
    ]);
    addCalls.length = 0;
    const r = await runFlow(hybridMeta, ['mapped'], 'transmission');
    assert.equal(r.outcome, SEED_OUTCOMES.PAD_FILES_MISSING);
    assert.equal(r.vpath, 'mapped');
    assert.equal(r.padFilesTotal, 1);
    assert.equal(r.padFilesPresent, 0);
    assert.equal(r.clientType, 'transmission');
    assert.equal(addCalls.length, 0, 'must not hand a stall-prone torrent to Transmission');
  });

  test('hybrid torrent on Transmission WITH pad on disk → seeded', async () => {
    await layOut(mappedRoot, [
      { relPath: 'Hybrid/01.flac', size: 100 },
      { relPath: 'Hybrid/02.flac', size: 200 },
      { relPath: 'Hybrid/.pad/412', size: 412 },   // pad materialised
    ]);
    addCalls.length = 0;
    const r = await runFlow(hybridMeta, ['mapped'], 'transmission');
    assert.equal(r.outcome, SEED_OUTCOMES.SEEDED);
    assert.equal(addCalls.length, 1);
  });

  test('all files on disk, vpath never probed → match_unmapped, daemon untouched', async () => {
    await layOut(unmappedRoot, [
      { relPath: 'Solo/01.flac', size: 100 },
    ]);
    const meta = makeMultiFile('Solo', [
      { path: ['01.flac'], length: 100 },
    ]);
    addCalls.length = 0;
    const r = await runFlow(meta, ['unmapped']);
    assert.equal(r.outcome, SEED_OUTCOMES.MATCH_UNMAPPED);
    assert.equal(r.vpath, 'unmapped');
    assert.equal(r.matchedRoot, path.join(unmappedRoot, 'Solo'));
    assert.equal(r.mappingConfidence, null, 'null = never probed');
    assert.equal(addCalls.length, 0, 'must not hand the torrent to the daemon');
  });

  test('all files on disk, mapping unconfirmed → match_unmapped with the probed confidence', async () => {
    await layOut(unconfirmedRoot, [
      { relPath: 'Duo/01.flac', size: 50 },
    ]);
    const meta = makeMultiFile('Duo', [
      { path: ['01.flac'], length: 50 },
    ]);
    addCalls.length = 0;
    const r = await runFlow(meta, ['unconfirmed']);
    assert.equal(r.outcome, SEED_OUTCOMES.MATCH_UNMAPPED);
    assert.equal(r.mappingConfidence, 'unconfirmed');
    assert.equal(addCalls.length, 0);
  });

  test('match on an unmapped vpath does not shadow a seedable match later in the list', async () => {
    await layOut(unmappedRoot, [
      { relPath: 'Both/01.flac', size: 70 },
    ]);
    await layOut(mappedRoot, [
      { relPath: 'Both/01.flac', size: 70 },
    ]);
    const meta = makeMultiFile('Both', [
      { path: ['01.flac'], length: 70 },
    ]);
    addCalls.length = 0;
    const r = await runFlow(meta, ['unmapped', 'mapped']);
    assert.equal(r.outcome, SEED_OUTCOMES.SEEDED, 'prefer the vpath that can actually seed');
    assert.equal(r.vpath, 'mapped');
    assert.equal(addCalls.length, 1);
  });

  test('partial match on an unmapped vpath is reported (the disk check is ungated)', async () => {
    await layOut(unmappedRoot, [
      { relPath: 'Half/01.flac', size: 10 },
      // 02.flac missing
    ]);
    const meta = makeMultiFile('Half', [
      { path: ['01.flac'], length: 10 },
      { path: ['02.flac'], length: 20 },
    ]);
    const r = await runFlow(meta, ['unmapped']);
    assert.equal(r.outcome, SEED_OUTCOMES.PARTIAL_MATCH);
    assert.equal(r.matched, 1);
    assert.equal(r.total, 2);
  });

  test('nothing on disk anywhere → no_match with the full checked list', async () => {
    const meta = makeMultiFile('Ghost', [
      { path: ['01.flac'], length: 999 },
    ]);
    const r = await runFlow(meta, ['mapped', 'unmapped', 'unconfirmed']);
    assert.equal(r.outcome, SEED_OUTCOMES.NO_MATCH);
    assert.deepEqual(r.checkedVpaths, ['mapped', 'unmapped', 'unconfirmed']);
  });
});
