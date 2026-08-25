// The headless boot watchdog's decision pieces (src/util/boot-watchdog.js),
// exercised against real scratch layouts — the same matrix the launcher's
// rollback.rs pins in Rust, so the two watchdogs cannot drift apart
// unnoticed. The full three-boots-then-rollback flow is covered end to end
// in test/integration/boot-watchdog.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  attemptsFilePath,
  bumpAttempts,
  clearAttempts,
  markBootOk,
  findManagedContext,
  planRollback,
  executeRollback,
  serverRel,
} from '../../src/util/boot-watchdog.js';
import { readHoldEntries, appendHold, HOLD_FILE } from '../../src/util/update-shared.js';

const posixOnly = process.platform === 'win32';

function tmpdir(tag) {
  // realpath'd: the geometry walk canonicalizes the executable path (macOS
  // /var -> /private/var), and the assertions compare against these.
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `mstream-bwd-${tag}-`)));
}

function hostKey() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'darwin') { return `darwin-${arch}`; }
  if (process.platform === 'win32') { return 'win-x64'; }
  return `linux-${arch}`;
}

function mkBundle(root, version, key, { withServer = true } = {}) {
  const bundle = path.join(root, `mStream-${version}-${key}`);
  const server = path.join(bundle, serverRel());
  fs.mkdirSync(path.dirname(server), { recursive: true });
  if (withServer) { fs.writeFileSync(server, 'stub'); }
  return bundle;
}

function linkCurrent(root, target) {
  const link = path.join(root, 'current');
  try { fs.unlinkSync(link); } catch { /* fresh */ }
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

// ── attempts lifecycle ───────────────────────────────────────────────────────

test('attempts bump per version, reset on version change, clear on boot-ok', () => {
  const dh = tmpdir('attempts');
  assert.equal(bumpAttempts('6.22.0', dh), 1);
  assert.equal(bumpAttempts('6.22.0', dh), 2);
  assert.equal(bumpAttempts('6.22.0', dh), 3);
  // A different version starts over — counts never carry across versions.
  assert.equal(bumpAttempts('6.23.0', dh), 1);
  clearAttempts(dh);
  assert.equal(fs.existsSync(attemptsFilePath(dh)), false);
  assert.equal(bumpAttempts('6.23.0', dh), 1, 'cleared means starting over');
  // A mangled file reads as no attempts, never as a crash.
  fs.writeFileSync(attemptsFilePath(dh), 'not json');
  assert.equal(bumpAttempts('6.23.0', dh), 1);
  fs.rmSync(dh, { recursive: true, force: true });
});

// ── findManagedContext ───────────────────────────────────────────────────────

test('MSTREAM_UPDATE_ROOT forces the managed context, standalone or not', () => {
  const root = tmpdir('ctx-env');
  const bundle = mkBundle(root, '6.22.0', hostKey());
  linkCurrent(root, bundle);
  const ctx = findManagedContext({
    execPath: '/anything/node',
    env: { MSTREAM_UPDATE_ROOT: root },
    standalone: false,
  });
  assert.equal(ctx.root, root);
  assert.equal(ctx.currentVersion, '6.22.0');
  assert.equal(ctx.key, hostKey());
  fs.rmSync(root, { recursive: true, force: true });
});

test('geometry: a standalone binary inside a versioned dir beside current', () => {
  const root = tmpdir('ctx-geo');
  const bundle = mkBundle(root, '6.22.0', hostKey());
  linkCurrent(root, bundle);
  const ctx = findManagedContext({
    execPath: path.join(bundle, serverRel()),
    env: {},
    standalone: true,
  });
  assert.equal(ctx.root, root);
  assert.equal(ctx.currentVersion, '6.22.0');
  // Same layout, but a source run (not standalone): never managed.
  assert.equal(findManagedContext({
    execPath: path.join(bundle, serverRel()), env: {}, standalone: false,
  }), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('no current link, or a current that is not a bundle, is not managed', () => {
  const root = tmpdir('ctx-none');
  assert.equal(findManagedContext({ execPath: '/x', env: { MSTREAM_UPDATE_ROOT: root }, standalone: true }), null);
  const oddDir = path.join(root, 'not-a-bundle');
  fs.mkdirSync(oddDir);
  linkCurrent(root, oddDir);
  assert.equal(findManagedContext({ execPath: '/x', env: { MSTREAM_UPDATE_ROOT: root }, standalone: true }), null);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── planRollback ─────────────────────────────────────────────────────────────

test('plan picks the newest lower same-key version whose server probes', () => {
  const root = tmpdir('plan');
  const key = hostKey();
  mkBundle(root, '6.22.0', key);                       // the failing one
  mkBundle(root, '6.20.0', key);
  const want = mkBundle(root, '6.21.0', key);
  mkBundle(root, '6.21.5', 'linux-arm64-musl');        // other family: never
  mkBundle(root, '6.21.9', key, { withServer: false }); // no server binary
  const plan = planRollback({
    root, key, failedVersion: '6.22.0', dataHome: root, probe: () => true,
  });
  assert.equal(plan.targetVersion, '6.21.0');
  assert.equal(plan.targetBundle, want);
  // The probe is the last gate: a candidate that cannot exec is skipped
  // (and with every candidate refused, there is no plan).
  assert.equal(planRollback({
    root, key, failedVersion: '6.22.0', dataHome: root, probe: () => false,
  }), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('plan skips held versions - two bad releases in a row land on the last good one', async () => {
  const root = tmpdir('plan-held');
  const key = hostKey();
  mkBundle(root, '6.23.0', key);
  mkBundle(root, '6.22.0', key);                       // known-bad: held below
  const want = mkBundle(root, '6.21.0', key);
  await appendHold(root, '6.22.0', 'test');
  const plan = planRollback({
    root, key, failedVersion: '6.23.0', dataHome: root, probe: () => true,
  });
  assert.equal(plan.targetBundle, want);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── executeRollback ──────────────────────────────────────────────────────────

// win32: node's junction targets read back with the \\?\ prefix, so the
// strict readlink equality below belongs to the posix legs (the windows
// junction mechanics are covered by the launcher's rust tests in CI).
test('execute appends the hold and re-points current', { skip: posixOnly }, async () => {
  const root = tmpdir('exec');
  const key = hostKey();
  const bad = mkBundle(root, '6.22.0', key);
  const prev = mkBundle(root, '6.21.0', key);
  linkCurrent(root, bad);
  await executeRollback({ root, failedVersion: '6.22.0', targetBundle: prev, dataHome: root });
  assert.equal(await fsp.readlink(path.join(root, 'current')), prev);
  const held = readHoldEntries(root);
  assert.equal(held.length, 1);
  assert.equal(held[0].version, '6.22.0');
  // Idempotent on a re-fire (a half-finished rollback retried).
  await executeRollback({ root, failedVersion: '6.22.0', targetBundle: prev, dataHome: root });
  assert.equal(readHoldEntries(root).length, 1, 'no duplicate hold entries');
  fs.rmSync(root, { recursive: true, force: true });
});

// ── the shared hold helpers (contract also consumed by update-check.js) ─────

test('hold file: append dedupes and caps, read tolerates garbage', async () => {
  const dh = tmpdir('holds');
  await appendHold(dh, '6.22.0', 't');
  await appendHold(dh, '6.22.0', 't');
  assert.deepEqual(readHoldEntries(dh).map((h) => h.version), ['6.22.0']);
  for (let i = 0; i < 12; i++) { await appendHold(dh, `7.0.${i}`, 't'); }
  const held = readHoldEntries(dh).map((h) => h.version);
  assert.equal(held.length, 8, 'capped');
  assert.ok(held.includes('7.0.11'), 'newest kept');
  assert.ok(!held.includes('6.22.0'), 'oldest dropped');
  fs.writeFileSync(path.join(dh, HOLD_FILE), 'not json');
  assert.deepEqual(readHoldEntries(dh), []);
  fs.rmSync(dh, { recursive: true, force: true });
});

test('clearAttempts is a safe no-op when nothing was ever counted', () => {
  const dh = tmpdir('noop');
  clearAttempts(dh);           // absent file: no throw
  clearAttempts(dh);           // twice: still nothing
  assert.equal(typeof markBootOk, 'function'); // the onListening hook exists
  fs.rmSync(dh, { recursive: true, force: true });
});
