/**
 * Integration tests for the task-queue enrichment status registry
 * (getEnrichmentStatus in src/db/task-queue.js) — the live half of
 * GET /api/v1/scan/status.
 *
 * What gets pinned:
 *   - the initial snapshot: all six passes present, config gates mapped
 *     to enabled/disabledReason/state (including the environment reasons
 *     'no-api-key' and 'no-ffmpeg', which are deterministic here because
 *     nothing in this process ever runs ensureFfmpeg);
 *   - queued → running → idle transitions driven through the REAL queue:
 *     a slow backup holds the serial slot so the queued state is
 *     observable, then the real rust waveform pass runs against an empty
 *     DB (no network, no fixtures needed — completes with zero counts);
 *   - a run-time gate bail (toggle flipped off while the task sat
 *     queued) returns the pass to idle WITHOUT overwriting the last real
 *     run's summary;
 *   - defensive copies: mutating a returned snapshot must not poison the
 *     registry.
 *
 * Strategy mirrors test/integration/task-queue.test.mjs: import the
 * production modules, drive the public queue API, assert on queue state.
 */

import { describe, before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

let testRoot;
let config;
let dbManager;
let taskQueue;
let libId;

const KINDS = ['waveform', 'albumart', 'lyrics', 'audioanalysis', 'discovery', 'acoustid'];

function statusOf(kind) {
  const entry = taskQueue.getEnrichmentStatus().find((p) => p.pass === kind);
  assert.ok(entry, `getEnrichmentStatus must report '${kind}'`);
  return entry;
}

async function waitFor(predicate, { timeoutMs = 30_000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) { return true; }
    await sleep(intervalMs);
  }
  return false;
}

async function waitForIdle() {
  const ok = await waitFor(
    () => taskQueue.getActiveBackupRun() === null
       && taskQueue.getQueueLength() === 0
       && !taskQueue.isScanning()
       && taskQueue.getAdminStats().activeTaskKind === null,
    { timeoutMs: 60_000 },
  );
  if (!ok) {
    throw new Error('Queue did not drain within 60s — test likely leaked state');
  }
}

function addSlowBackupHold(label) {
  const dest = dbManager.addBackupDestination({
    libraryId: libId, destPath: path.join(testRoot, label),
    triggerType: 'manual', dailyAtHour: null, retentionDays: 7, enabled: true,
    excludeGlobs: [], interFileDelayMs: 300,
  });
  taskQueue.addBackupTask(dest, 'manual');
  return dest;
}

before(async () => {
  testRoot = path.join(os.tmpdir(), `mstream-enrich-status-${Date.now()}`);
  fs.mkdirSync(path.join(testRoot, 'db'), { recursive: true });
  fs.writeFileSync(path.join(testRoot, 'config.json'), JSON.stringify({
    storage: {
      dbDirectory: path.join(testRoot, 'db'),
      albumArtDirectory: path.join(testRoot, 'art'),
      logsDirectory: path.join(testRoot, 'logs'),
      // Without this the real waveform pass below would write into the
      // REPO's default waveform-cache/ — shared, persistent state.
      waveformCacheDirectory: path.join(testRoot, 'waveforms'),
    },
    port: 0,
  }, null, 2));

  config = await import('../../src/state/config.js');
  await config.setup(path.join(testRoot, 'config.json'));
  dbManager = await import('../../src/db/manager.js');
  dbManager.initDB();
  taskQueue = await import('../../src/db/task-queue.js');

  // A small file tree for the backup worker that holds the queue slot.
  const lib = path.join(testRoot, 'src-lib');
  fs.mkdirSync(lib, { recursive: true });
  for (let i = 0; i < 4; i++) {
    fs.writeFileSync(path.join(lib, `track-${i}.mp3`), Buffer.alloc(1024, i));
  }
  dbManager.getDB().prepare(
    `INSERT INTO libraries (name, root_path, type, follow_symlinks) VALUES ('status-lib', ?, 'music', 0)`
  ).run(lib);
  dbManager.invalidateCache();
  libId = dbManager.getLibraryByName('status-lib').id;
});

after(async () => {
  if (taskQueue) { await waitForIdle(); }
  if (dbManager) { dbManager.close(); }
  try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch (_) { /* cleanup */ }
  setImmediate(() => process.exit(0));
});

beforeEach(async () => {
  await waitForIdle();
});

describe('enrichment status: initial snapshot and gates', () => {
  test('reports all six passes with the full field set', () => {
    const all = taskQueue.getEnrichmentStatus();
    assert.deepEqual(all.map((p) => p.pass), KINDS);
    for (const p of all) {
      for (const key of ['pass', 'enabled', 'disabledReason', 'state', 'progress', 'lastRun']) {
        assert.ok(key in p, `'${p.pass}' entry must carry '${key}'`);
      }
    }
  });

  test('default config gates: waveform + albumart on; the opt-ins off', () => {
    assert.deepEqual(
      Object.fromEntries(taskQueue.getEnrichmentStatus()
        .map((p) => [p.pass, [p.enabled, p.disabledReason, p.state]])),
      {
        waveform:      [true,  null,        'idle'],
        albumart:      [true,  null,        'idle'],
        lyrics:        [false, 'config',    'disabled'],
        audioanalysis: [false, 'config',    'disabled'],
        // collectDiscoveryData defaults ON, but ensureFfmpeg never ran in
        // this process — the environment reason must win over 'idle'.
        discovery:     [false, 'no-ffmpeg', 'disabled'],
        acoustid:      [false, 'config',    'disabled'],
      });
  });

  test('gate flips are reflected live, with reasons ordered config-first', () => {
    const opts = config.program.scanOptions;
    const savedKey = opts.acoustidApiKey;
    try {
      opts.analyzeAcoustid = true;
      assert.equal(statusOf('acoustid').enabled, true,
        'the shipped default API key satisfies the key gate');

      opts.acoustidApiKey = '';
      assert.deepEqual(
        [statusOf('acoustid').enabled, statusOf('acoustid').disabledReason],
        [false, 'no-api-key']);

      config.program.lyrics.backfill = true;
      assert.equal(statusOf('lyrics').enabled, true,
        'default providers list satisfies the lyrics gate');

      opts.generateWaveforms = false;
      assert.deepEqual(
        [statusOf('waveform').state, statusOf('waveform').disabledReason],
        ['disabled', 'config']);
    } finally {
      opts.analyzeAcoustid = false;
      opts.acoustidApiKey = savedKey;
      opts.generateWaveforms = true;
      config.program.lyrics.backfill = false;
    }
  });
});

describe('enrichment status: lifecycle through the real queue', () => {
  test('queued behind a held slot, then a real run lands in lastRun', async () => {
    addSlowBackupHold('hold-queued');
    await sleep(100);
    assert.notEqual(taskQueue.getActiveBackupRun(), null, 'backup should hold the slot');

    taskQueue.addWaveformTask();
    assert.equal(statusOf('waveform').state, 'queued',
      'a waveform task parked behind the backup must read queued');

    await waitForIdle();

    // The rust pass really ran (empty DB → plans zero, exits 0).
    const wf = statusOf('waveform');
    assert.equal(wf.state, 'idle');
    assert.equal(wf.progress, null);
    assert.equal(wf.lastRun?.outcome, 'completed');
    assert.equal(wf.lastRun?.hitCap, false);
    assert.deepEqual(wf.lastRun?.counts, { generated: 0, failed: 0, total: 0 },
      'counts must be the waveformScanComplete payload minus event/hitCap');
    assert.equal(typeof wf.lastRun?.finishedAt, 'number');
  });

  test('a run-time gate bail returns to idle without clobbering lastRun', async () => {
    // Seed a real lastRun first (fast: empty DB).
    taskQueue.addWaveformTask();
    await waitForIdle();
    const seeded = statusOf('waveform').lastRun;
    assert.equal(seeded?.outcome, 'completed', 'precondition: a real run recorded');

    // Queue another pass behind a held slot, then flip the toggle off so
    // dispatch gate-bails instead of running.
    addSlowBackupHold('hold-bail');
    await sleep(100);
    taskQueue.addWaveformTask();
    assert.equal(statusOf('waveform').state, 'queued');
    config.program.scanOptions.generateWaveforms = false;
    try {
      await waitForIdle();
      const wf = statusOf('waveform');
      assert.equal(wf.state, 'disabled', 'bailed + gate off reads disabled');
      assert.deepEqual(wf.lastRun, seeded,
        'a skipped dispatch must not overwrite the last real run');
    } finally {
      config.program.scanOptions.generateWaveforms = true;
    }
    assert.equal(statusOf('waveform').state, 'idle',
      're-enabling restores idle without any event');
  });

  test('snapshots are defensive copies', async () => {
    taskQueue.addWaveformTask();
    await waitForIdle();
    const a = statusOf('waveform');
    assert.ok(a.lastRun?.counts, 'precondition: a completed run with counts');
    a.state = 'poisoned';
    a.lastRun.counts.generated = 999;
    const b = statusOf('waveform');
    assert.equal(b.state, 'idle', 'top-level fields must be insulated');
    assert.equal(b.lastRun.counts.generated, 0, 'nested counts must be insulated');
  });
});
