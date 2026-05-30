/**
 * Unit tests for the backup-destination / backup-history DB helpers in
 * src/db/manager.js. These cover two regressions found in the backup-code
 * audit:
 *
 *   1. getBackupDestination* never selected libraries.follow_symlinks, so
 *      runBackupTask read `dest.follow_symlinks === 1` off an undefined
 *      column → backups always ran with followSymlinks=false regardless of
 *      the library's flag. The destination queries now JOIN the column in.
 *
 *   2. createBackupRunRow stamped finished_at for already-finished rows
 *      (skipped / disabled-before-start) with new Date().toISOString(),
 *      producing a different timestamp format than started_at and
 *      finishBackupRunRow (both datetime('now')). Consumers normalise these
 *      with `s.replace(' ','T') + 'Z'`, which turns the ISO form into an
 *      Invalid Date. All timestamps must share the SQLite datetime format.
 *
 * Strategy: import db/manager directly against a throwaway temp DB — no
 * server, no worker. Mirrors the setup used by test/task-queue.test.mjs.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 'YYYY-MM-DD HH:MM:SS' — what SQLite's datetime('now') emits. No 'T'
// separator, no 'Z', no fractional seconds.
const SQLITE_DT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

let testRoot;

function makeTestEnv() {
  const root = path.join(os.tmpdir(), 'mstream-backup-db-test-' + Date.now() + '-' + Math.floor(Math.random() * 1e6));
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'db'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    storage: {
      dbDirectory: path.join(root, 'db'),
      albumArtDirectory: path.join(root, 'art'),
      logsDirectory: path.join(root, 'logs'),
    },
    port: 0,
  }, null, 2));
  return root;
}

describe('backup db helpers', () => {
  let dbManager, libFollow, libNoFollow;

  before(async () => {
    testRoot = makeTestEnv();
    const config = await import('../src/state/config.js');
    await config.setup(path.join(testRoot, 'config.json'));
    dbManager = await import('../src/db/manager.js');
    dbManager.initDB();

    const sqlite = dbManager.getDB();
    sqlite.prepare(`INSERT INTO libraries (name, root_path, type, follow_symlinks) VALUES (?, ?, ?, 1)`)
      .run('lib-follow', path.join(testRoot, 'follow'), 'music');
    sqlite.prepare(`INSERT INTO libraries (name, root_path, type, follow_symlinks) VALUES (?, ?, ?, 0)`)
      .run('lib-nofollow', path.join(testRoot, 'nofollow'), 'music');
    dbManager.invalidateCache();
    libFollow = dbManager.getLibraryByName('lib-follow').id;
    libNoFollow = dbManager.getLibraryByName('lib-nofollow').id;
  });

  after(() => {
    if (dbManager) { dbManager.close(); }
    try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // ── Fix 1: follow_symlinks propagation ────────────────────────────────────

  test('getBackupDestinationById surfaces the library follow_symlinks flag (=1)', () => {
    const id = dbManager.addBackupDestination({
      libraryId: libFollow, destPath: path.join(testRoot, 'd-follow'),
      triggerType: 'manual', dailyAtHour: null, retentionDays: 7, enabled: true,
      excludeGlobs: [], interFileDelayMs: 0,
    });
    const dest = dbManager.getBackupDestinationById(id);
    assert.equal(dest.follow_symlinks, 1,
      'follow_symlinks must be JOINed in so runBackupTask can mirror the library flag');
  });

  test('a follow_symlinks=0 library yields 0 on every destination query', () => {
    const id = dbManager.addBackupDestination({
      libraryId: libNoFollow, destPath: path.join(testRoot, 'd-nofollow'),
      triggerType: 'manual', dailyAtHour: null, retentionDays: 7, enabled: true,
      excludeGlobs: [], interFileDelayMs: 0,
    });
    assert.equal(dbManager.getBackupDestinationById(id).follow_symlinks, 0);

    // The list / by-library / by-trigger variants share the SELECT and must
    // expose the column too (all four were fixed).
    const listed = dbManager.getBackupDestinations().find((d) => d.id === id);
    assert.equal(listed.follow_symlinks, 0, 'getBackupDestinations must expose follow_symlinks');

    const byLib = dbManager.getBackupDestinationsByLibrary(libNoFollow).find((d) => d.id === id);
    assert.equal(byLib.follow_symlinks, 0, 'getBackupDestinationsByLibrary must expose follow_symlinks');
  });

  test('follow_symlinks is never undefined on a destination row', () => {
    // The original bug surfaced as `undefined === 1` → false. Guard against a
    // regression where the column silently drops out of the SELECT again.
    const id = dbManager.addBackupDestination({
      libraryId: libFollow, destPath: path.join(testRoot, 'd-defined'),
      triggerType: 'after-scan', dailyAtHour: null, retentionDays: 30, enabled: true,
      excludeGlobs: null, interFileDelayMs: 0,
    });
    const dest = dbManager.getBackupDestinationById(id);
    assert.notEqual(dest.follow_symlinks, undefined,
      'follow_symlinks must be a real value (0/1), not undefined');
  });

  // ── Fix 4: single canonical timestamp format ──────────────────────────────

  test('createBackupRunRow: running row has datetime started_at and NULL finished_at', () => {
    const id = dbManager.addBackupDestination({
      libraryId: libFollow, destPath: path.join(testRoot, 'd-ts-running'),
      triggerType: 'manual', dailyAtHour: null, retentionDays: 7, enabled: true,
      excludeGlobs: [], interFileDelayMs: 0,
    });
    const runId = dbManager.createBackupRunRow({ destinationId: id, triggerReason: 'manual', status: 'running' });
    const row = dbManager.getBackupHistoryRowById(runId);
    assert.match(row.started_at, SQLITE_DT, 'started_at must use datetime() format');
    assert.equal(row.finished_at, null, 'a running row must have a NULL finished_at');
  });

  test('createBackupRunRow: a pre-finished (skipped) row stamps finished_at in the SAME format', () => {
    const id = dbManager.addBackupDestination({
      libraryId: libFollow, destPath: path.join(testRoot, 'd-ts-skipped'),
      triggerType: 'manual', dailyAtHour: null, retentionDays: 7, enabled: true,
      excludeGlobs: [], interFileDelayMs: 0,
    });
    const skipId = dbManager.createBackupRunRow({
      destinationId: id, triggerReason: 'manual', status: 'skipped', errorMessage: 'previous run still in progress',
    });
    const row = dbManager.getBackupHistoryRowById(skipId);
    assert.match(row.started_at, SQLITE_DT);
    assert.match(row.finished_at, SQLITE_DT,
      'pre-finished finished_at must match the datetime() format used by started_at / finishBackupRunRow');
    assert.doesNotMatch(row.finished_at, /[TZ]/,
      'finished_at must not carry ISO-8601 T/Z markers (would break the `replace(" ","T")+"Z"` parse convention)');
  });
});
