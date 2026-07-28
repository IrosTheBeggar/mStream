/**
 * Backup admin-API validation hardening (audit batch 3).
 *
 * Drives a REAL server (test/helpers/server.mjs) with two extra
 * libraries and exercises the create/PATCH/check-path validation
 * surface end-to-end:
 *
 *   - checkPathContainment resolves symlinks/junctions before comparing
 *     — a dest path that RESOLVES into a library root is rejected even
 *     though its lexical spelling passes every string check.
 *   - Cross-object overlap validation: a destination may not overlap
 *     any OTHER library's root (backup trees would be scanned as
 *     music), nor any other destination (nested mirror jobs repeatedly
 *     destroy each other's copies). Equality after normalisation also
 *     catches trailing-separator duplicates the byte-exact UNIQUE
 *     constraint misses.
 *   - requireDailyHour surfaces as 400 (was an uncaught plain Error
 *     -> 500 'Server Error' with the message swallowed).
 *   - The history `limit` query param is clamped to [1, 500] integers
 *     (negatives meant UNLIMITED to SQLite; fractionals passed through).
 *   - check-path (the UI's preview) reports the same hard errors that
 *     create/PATCH enforce.
 *
 * Plus the worker-side defense-in-depth guard (direct spawn, no
 * server): a dest that resolves into the source hierarchy at RUN time
 * — e.g. a link swapped after the destination was configured — refuses
 * to run.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startServer } from '../helpers/server.mjs';
import { DEFAULT_BACKUP_EXCLUDE_GLOBS } from '../../src/db/manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKER = path.join(REPO_ROOT, 'src', 'backup', 'worker.mjs');

const ADMIN = { username: 'backup-admin', password: 'pw-backup' };

describe('backup API: validation hardening', () => {
  let server, token, root, libAId, libBId;
  let libARoot, libBRoot, destsDir;
  let destAId;   // canonical pre-existing destination used by overlap tests

  async function api(method, p, body) {
    const r = await fetch(`${server.baseUrl}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-access-token': token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await r.json(); } catch (_) { /* non-JSON error body */ }
    return { status: r.status, json };
  }

  async function waitForIdle(timeoutMs = 60_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const { json } = await api('GET', '/api/v1/admin/backup/status');
      if (json && json.active === null && json.queueLength === 0) { return; }
      await sleep(100);
    }
    throw new Error('backup/scan queue did not drain');
  }

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-bapi-'));
    libARoot = path.join(root, 'libs', 'A');
    libBRoot = path.join(root, 'libs', 'B');
    destsDir = path.join(root, 'dests');
    fs.mkdirSync(path.join(libARoot, 'sub'), { recursive: true });
    fs.mkdirSync(libBRoot, { recursive: true });
    fs.mkdirSync(destsDir, { recursive: true });
    // Tiny fake tracks so manual runs have something to mirror.
    fs.writeFileSync(path.join(libARoot, 'a1.mp3'), 'a1');
    fs.writeFileSync(path.join(libARoot, 'a2.mp3'), 'a2');
    fs.writeFileSync(path.join(libBRoot, 'b1.mp3'), 'b1');

    server = await startServer({
      waitForScan: false,
      users: [{ ...ADMIN, admin: true, vpaths: ['testlib', 'libA', 'libB'] }],
      extraFolders: { libA: libARoot, libB: libBRoot },
    });

    const r = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ADMIN),
    });
    token = (await r.json()).token;
    assert.ok(token, 'admin login must succeed');

    const dirs = await api('GET', '/api/v1/admin/directories');
    libAId = dirs.json.libA.id;
    libBId = dirs.json.libB.id;
    assert.ok(libAId && libBId);
  });

  after(async () => {
    if (server) { await server.stop(); }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* cleanup */ }
  });

  test('control: a clean destination is accepted', async () => {
    const { status, json } = await api('POST', '/api/v1/admin/backup/destinations', {
      libraryId: libAId, destPath: path.join(destsDir, 'backA'), triggerType: 'manual',
    });
    assert.equal(status, 200);
    destAId = json.id;
    assert.ok(destAId);
  });

  test('platform endpoint serves the live default exclude list', async () => {
    // The add form seeds its patterns field from this (and omits
    // excludeGlobs at create when the field is untouched) — a hardcoded
    // client copy had already drifted from the server's list once.
    const { status, json } = await api('GET', '/api/v1/admin/backup/platform');
    assert.equal(status, 200);
    assert.deepEqual(json.defaultExcludes, DEFAULT_BACKUP_EXCLUDE_GLOBS);
  });

  test('dest path that RESOLVES into the library root is rejected (symlink bypass)', async () => {
    const evil = path.join(root, 'evil-link');
    fs.symlinkSync(path.join(libARoot, 'sub'), evil, 'junction');
    const { status, json } = await api('POST', '/api/v1/admin/backup/destinations', {
      libraryId: libAId, destPath: evil, triggerType: 'manual',
    });
    assert.equal(status, 400,
      'lexically-disjoint path resolving inside the library must be rejected');
    assert.match(json.error, /inside the source library/i);
  });

  test('a not-yet-existing dest whose PARENT resolves into the library is rejected', async () => {
    const evil = path.join(root, 'evil-link2');
    fs.symlinkSync(libARoot, evil, 'junction');
    const { status, json } = await api('POST', '/api/v1/admin/backup/destinations', {
      libraryId: libAId, destPath: path.join(evil, 'brand-new-dir'), triggerType: 'manual',
    });
    assert.equal(status, 400, 'walk-up realpath must resolve the existing ancestor');
    assert.match(json.error, /inside the source library/i);
  });

  test('dest inside a DIFFERENT library root is rejected', async () => {
    const { status, json } = await api('POST', '/api/v1/admin/backup/destinations', {
      libraryId: libAId, destPath: path.join(libBRoot, 'backup'), triggerType: 'manual',
    });
    assert.equal(status, 400,
      'pre-batch-3 this was accepted and the backup tree got scanned as music');
    assert.match(json.error, /overlaps library "libB"/i);
  });

  test('same path for another library is rejected as a duplicate', async () => {
    const { status, json } = await api('POST', '/api/v1/admin/backup/destinations', {
      libraryId: libBId, destPath: path.join(destsDir, 'backA'), triggerType: 'manual',
    });
    assert.equal(status, 409, 'UNIQUE only covers the same library — cross-library needs the overlap check');
    assert.match(json.error, /already uses this path/i);
  });

  test('trailing-separator spelling of an existing dest path is rejected', async () => {
    const { status } = await api('POST', '/api/v1/admin/backup/destinations', {
      libraryId: libBId, destPath: path.join(destsDir, 'backA') + path.sep, triggerType: 'manual',
    });
    assert.equal(status, 409, 'normalisation must collapse trailing-separator variants');
  });

  test('dest nested inside another destination is rejected (both directions)', async () => {
    const nested = await api('POST', '/api/v1/admin/backup/destinations', {
      libraryId: libBId, destPath: path.join(destsDir, 'backA', 'nested'), triggerType: 'manual',
    });
    assert.equal(nested.status, 400,
      'pre-batch-3 the outer job swept the inner mirror as orphans every run');
    assert.match(nested.json.error, /overlaps destination/i);

    const parent = await api('POST', '/api/v1/admin/backup/destinations', {
      libraryId: libBId, destPath: destsDir, triggerType: 'manual',
    });
    assert.equal(parent.status, 400);
    assert.match(parent.json.error, /overlaps destination/i);
  });

  test('PATCH destPath gets the same overlap validation, excluding itself', async () => {
    const created = await api('POST', '/api/v1/admin/backup/destinations', {
      libraryId: libBId, destPath: path.join(destsDir, 'backB'), triggerType: 'manual',
    });
    assert.equal(created.status, 200);
    const destBId = created.json.id;

    const bad = await api('PATCH', `/api/v1/admin/backup/destinations/${destBId}`, {
      destPath: path.join(destsDir, 'backA', 'sub'),
    });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /overlaps destination/i);

    // Re-asserting its own current path must NOT self-collide.
    const self = await api('PATCH', `/api/v1/admin/backup/destinations/${destBId}`, {
      destPath: path.join(destsDir, 'backB'),
    });
    assert.equal(self.status, 200, 'a destination must not overlap-collide with itself');
  });

  test('daily without an hour is a 400, not a 500', async () => {
    const create = await api('POST', '/api/v1/admin/backup/destinations', {
      libraryId: libBId, destPath: path.join(destsDir, 'daily'), triggerType: 'daily',
    });
    assert.equal(create.status, 400, 'pre-batch-3 this surfaced as 500 Server Error');
    assert.match(create.json.error, /dailyAtHour is required/i);

    const created = await api('POST', '/api/v1/admin/backup/destinations', {
      libraryId: libBId, destPath: path.join(destsDir, 'daily'), triggerType: 'daily', dailyAtHour: 3,
    });
    assert.equal(created.status, 200);
    const patch = await api('PATCH', `/api/v1/admin/backup/destinations/${created.json.id}`, {
      dailyAtHour: null,
    });
    assert.equal(patch.status, 400, 'clearing the hour while daily must be a client error');
    assert.match(patch.json.error, /dailyAtHour is required/i);
  });

  test('check-path preview reports the same hard errors as create', async () => {
    const { status, json } = await api('POST', '/api/v1/admin/backup/check-path', {
      libraryId: libBId, destPath: path.join(destsDir, 'backA', 'nested'),
    });
    assert.equal(status, 200);
    assert.equal(json.ok, false, 'preview must agree with what create would reject');
    assert.ok(json.errors.some((e) => /overlaps destination/i.test(e)));
  });

  test('check-path self-excludes for the edit flow (own unchanged path is OK)', async () => {
    // The edit dialog previews the destination's OWN current path on
    // open. Without excludeDestId the equality check matches the
    // destination's own row and the Save gate never opens — every
    // existing destination's edit dialog would be bricked.
    const withExclude = await api('POST', '/api/v1/admin/backup/check-path', {
      libraryId: libAId, destPath: path.join(destsDir, 'backA'), excludeDestId: destAId,
    });
    assert.equal(withExclude.status, 200);
    assert.equal(withExclude.json.ok, true,
      'previewing a destination against its own path must not self-collide');

    // The create flow (no excludeDestId) must still catch the duplicate.
    const withoutExclude = await api('POST', '/api/v1/admin/backup/check-path', {
      libraryId: libAId, destPath: path.join(destsDir, 'backA'),
    });
    assert.equal(withoutExclude.json.ok, false);
    assert.ok(withoutExclude.json.errors.some((e) => /already uses this path/i.test(e)));
  });

  test('history limit is clamped to [1, 500] integers', async () => {
    await waitForIdle();   // boot scans may still hold the queue
    for (let i = 0; i < 3; i++) {
      const run = await api('POST', `/api/v1/admin/backup/destinations/${destAId}/run`);
      assert.equal(run.status, 200);
      await waitForIdle();
    }
    const all = await api('GET', `/api/v1/admin/backup/destinations/${destAId}/history`);
    assert.ok(all.json.history.length >= 3, 'three runs must have recorded history');

    const neg = await api('GET', `/api/v1/admin/backup/destinations/${destAId}/history?limit=-1`);
    assert.equal(neg.json.history.length, 1,
      'negative limit must clamp to 1 — SQLite treats LIMIT -1 as UNLIMITED');

    const frac = await api('GET', `/api/v1/admin/backup/destinations/${destAId}/history?limit=1.9`);
    assert.equal(frac.json.history.length, 1, 'fractional limit must truncate');

    const junk = await api('GET', `/api/v1/admin/backup/destinations/${destAId}/history?limit=abc`);
    assert.ok(junk.json.history.length >= 3, 'junk limit falls back to the default');
  });

  test('check-path warns when the destination is an existing FILE, not a dir', async () => {
    const filePath = path.join(destsDir, 'a-file.txt');
    fs.writeFileSync(filePath, 'not a directory');
    const { status, json } = await api('POST', '/api/v1/admin/backup/check-path', {
      libraryId: libAId, destPath: filePath,
    });
    assert.equal(status, 200);
    assert.equal(json.info.parentExists, true,
      'a resolvable file means its parent exists — must not trip the "drive not mounted" path');
    assert.ok(json.warnings.some((w) => /not a directory/i.test(w)),
      'the operator must be told the path is a file');
    assert.equal(json.warnings.some((w) => /not appear to be mounted/i.test(w)), false,
      'no spurious drive-not-mounted warning for an existing file');
  });

  // Start a slow run (many files + heavy throttle → minutes of natural
  // runtime) so cancellation is observable: /api/v1/db/status `locked`
  // reflects the queue's activeTask slot directly, which the backup
  // status endpoint's ghost-guard deliberately hides for deleted
  // destinations. If the cancel is ever removed, `locked` stays true
  // for the run's natural length and these tests time out — verified
  // by mutation (the earlier version of this test passed even with the
  // cancel deleted, because the ghost-guard alone made status idle).
  async function startSlowRun(libraryRoot, libraryId, destPath) {
    for (let i = 0; i < 40; i++) {
      fs.writeFileSync(path.join(libraryRoot, `slow-${String(i).padStart(2, '0')}.mp3`), `slow-${i}`);
    }
    const created = await api('POST', '/api/v1/admin/backup/destinations', {
      libraryId, destPath, triggerType: 'manual', interFileDelayMs: 800,
    });
    assert.equal(created.status, 200);
    const did = created.json.id;
    await api('POST', `/api/v1/admin/backup/destinations/${did}/run`);
    let active = null;
    for (let i = 0; i < 100; i++) {
      const s = await api('GET', '/api/v1/admin/backup/status');
      if (s.json.active && s.json.active.destinationId === did) { active = s.json.active; break; }
      await sleep(50);
    }
    assert.ok(active, 'the backup must be active before cancellation is exercised');
    return did;
  }

  async function assertQueueFreesWithin(ms, what) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      try {
        const r = await fetch(`${server.baseUrl}/api/v1/db/status`, {
          headers: { 'x-access-token': token },
        });
        const j = await r.json();
        if (!j.locked) { return; }
      } catch (_) {
        // The library-DELETE path reboots the HTTP server (recycles the
        // listener) after cancelling backups — a transient connection
        // gap here is that reboot, not a failure. Keep polling; the
        // server returns on the same port and the worker (killed before
        // the reboot) is already gone.
      }
      await sleep(200);
    }
    assert.fail(`${what}: queue slot still held after ${ms}ms — the worker was not cancelled`);
  }

  test('deleting a destination mid-run cancels the worker and frees the queue', async () => {
    await waitForIdle();
    const did = await startSlowRun(libARoot, libAId, path.join(destsDir, 'delete-mid-run'));

    const del = await api('DELETE', `/api/v1/admin/backup/destinations/${did}`);
    assert.equal(del.status, 200);

    // The discriminating assertion: the ~32s natural run must be gone
    // from the queue slot within seconds.
    await assertQueueFreesWithin(10_000, 'destination DELETE');

    // And the status endpoint never rendered a half-null ghost card.
    const s = await api('GET', '/api/v1/admin/backup/status');
    assert.ok(!s.json.active || s.json.active.destPath !== null,
      'status must not expose a null-identity ghost card');
    await waitForIdle();
  });

  test('PATCHing dest_path mid-run cancels the worker (old-path writes stop)', async () => {
    await waitForIdle();
    const did = await startSlowRun(libARoot, libAId, path.join(destsDir, 'patch-mid-run'));

    const patch = await api('PATCH', `/api/v1/admin/backup/destinations/${did}`, {
      destPath: path.join(destsDir, 'patch-mid-run-NEW'),
    });
    assert.equal(patch.status, 200);

    // The in-flight worker was mirroring the OLD path while the row now
    // reports the new one — it must be cancelled, not left writing.
    await assertQueueFreesWithin(10_000, 'destination PATCH');
    await waitForIdle();
  });

  test('deleting a LIBRARY mid-run cancels its backups (cascade path)', async () => {
    await waitForIdle();
    // Use libB — this destroys the library, so it must run last.
    const did = await startSlowRun(libBRoot, libBId, path.join(destsDir, 'lib-delete-mid-run'));

    const del = await api('DELETE', '/api/v1/admin/directory', { vpath: 'libB' });
    assert.equal(del.status, 200);

    // Pre-fix, the cascade orphaned the worker: invisible (ghost-guard
    // reports idle), unkillable (its destination row is gone so the
    // destination-DELETE route 404s), holding the serial queue slot
    // for the run's natural length. This path also reboots the HTTP
    // server, so the poller tolerates the reboot's connection gap.
    await assertQueueFreesWithin(20_000, 'library DELETE');

    const s = await api('GET', '/api/v1/admin/backup/status');
    assert.equal(s.json.active, null, 'no phantom run may survive a library delete');
    void did;
    await waitForIdle();
  });
});

// ── worker defense-in-depth ─────────────────────────────────────────────────

describe('backup worker: run-time containment guard', () => {
  test('dest resolving into the source hierarchy refuses to run, before any mkdir', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-bwguard-'));
    try {
      const src = path.join(root, 'src');
      fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(src, 'track.mp3'), 'data');
      // The config-time check passed when this destination was saved;
      // the link was swapped afterwards. The NOT-YET-EXISTING tail
      // ('mirror') forces the guard's walk-up resolution AND pins the
      // guard-before-ensureDir ordering: mkdir'ing first would create a
      // real directory inside the library through the link.
      const link = path.join(root, 'dest-link');
      fs.symlinkSync(path.join(src, 'sub'), link, 'junction');
      const dest = path.join(link, 'mirror');

      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath,
          [WORKER, JSON.stringify({ sourcePath: src, destPath: dest, retentionDays: 30 })],
          { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        // Watchdog: if the guard ever regresses, the worker would start
        // a real (potentially unbounded, self-recursive) mirror run —
        // kill it instead of hanging the suite while it floods the disk.
        const killer = setTimeout(() => child.kill('SIGKILL'), 30_000);
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.on('error', (err) => { clearTimeout(killer); reject(err); });
        child.on('close', (code) => { clearTimeout(killer); resolve({ code, out }); });
      });

      assert.equal(result.code, 1, 'worker must refuse instead of mirroring the library into itself');
      assert.match(result.out, /resolves into the source library/i);
      assert.deepEqual(fs.readdirSync(path.join(src, 'sub')), [],
        'the linked-into subdir must be untouched — the guard must fire before ensureDir');
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* cleanup */ }
    }
  });
});
