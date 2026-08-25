/**
 * Boot-start retry, end to end against a real binary: a TRANSIENT failure
 * during the boot-time stack start must not disable discovery for the whole
 * session.
 *
 * Before this, the recovery ladder armed only after a start had SUCCEEDED —
 * so a flaky first-install sidecar download or a briefly wedged data dir
 * left the feature off with the config saying enabled, until a restart or a
 * manual admin re-enable: the last remaining path to the #880 silent-outage
 * shape. Now server.js's boot catch arms the same ladder a crash gets
 * (config-gated per #881, surfaced as "reconnecting" per #886).
 *
 * The transient fault here is a data directory the sidecar cannot write
 * (mode 000): the spawned child dies on the identity file, the boot start
 * rejects, the ladder arms — and the moment the directory heals, the next
 * rung brings the stack up joined. Deterministic, hermetic, no download
 * games. Needs a real sidecar binary and POSIX permissions; skips in CI and
 * on Windows like its sibling suites.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';
import { resolveSidecarBinary } from '../../src/state/discovery-p2p.js';

const SIDECAR_BIN = resolveSidecarBinary();
const SKIP = process.platform === 'win32'
  ? 'needs POSIX directory permissions to fake the wedged data dir'
  : (SIDECAR_BIN ? false : 'no p2p-sidecar binary on this machine');

async function pollUntil(fn, { timeoutMs = 60000, everyMs = 250, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) { return value; }
    if (Date.now() > deadline) { throw new Error(`timed out waiting for ${what}`); }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

describe('discovery p2p: a failed boot start retries on the ladder', { skip: SKIP }, () => {
  let server;
  let dir;
  let wedgedDir;
  let statusOf;

  before(async () => {
    // Pre-seeded storage (the rotation suite's technique) so the sidecar
    // data dir exists BEFORE boot — wedged shut. mkdirSync(recursive) on an
    // existing dir succeeds, so the server's own setup sails past it; the
    // spawned sidecar then dies on the unwritable identity file.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-boot-retry-'));
    const stateDir = path.join(dir, 'state');
    const dbDir = path.join(stateDir, 'db');
    wedgedDir = path.join(dbDir, 'discovery-p2p');
    fs.mkdirSync(wedgedDir, { recursive: true });
    fs.chmodSync(wedgedDir, 0o000);

    server = await startServer({
      dlnaMode: 'disabled',
      waitForScan: false,
      extraConfig: {
        storage: {
          albumArtDirectory: path.join(stateDir, 'image-cache'),
          dbDirectory: dbDir,
          logsDirectory: path.join(stateDir, 'logs'),
          syncConfigDirectory: path.join(stateDir, 'sync'),
          waveformCacheDirectory: path.join(stateDir, 'waveform-cache'),
        },
        discoveryP2p: { enabled: true, useCommunitySeeds: false },
      },
    });
    statusOf = async () =>
      (await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/status`)).json();
  });

  after(async () => {
    if (wedgedDir) { try { fs.chmodSync(wedgedDir, 0o755); } catch { /* healed in-test */ } }
    if (server) { await server.stop(); }
    if (dir) { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('the failure is armed, visible, and heals the moment the fault clears', async () => {
    // Phase 1 — the boot start failed and the ladder owns it. The status
    // route must SAY so (the #886 field the panel renders as
    // "reconnecting, attempt N"), not the ambiguous nothing of old.
    const armed = await pollUntil(async () => {
      const s = await statusOf();
      return !s.running && s.recovery
        && (s.recovery.attempts >= 1 || s.recovery.retryPending) ? s : null;
    }, { timeoutMs: 30000, what: 'the boot failure to arm the recovery ladder' });
    assert.equal(armed.running, false, 'nothing is running yet — the data dir is wedged');

    // Phase 2 — the transient clears; the next rung must bring the whole
    // stack up: spawn AND join, identity persisted into the healed dir.
    fs.chmodSync(wedgedDir, 0o755);
    const up = await pollUntil(async () => {
      const s = await statusOf();
      return s.running && s.joined ? s : null;
    }, { timeoutMs: 60000, what: 'the ladder to bring the stack up after the dir healed' });
    assert.ok(up.endpointId, 'a live endpoint identity');
    assert.ok(fs.existsSync(path.join(wedgedDir, 'identity.key')),
      'the identity landed in the healed data dir');
  });
});
