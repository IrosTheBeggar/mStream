/**
 * Tests for GET /api/v1/lastfm/status under default UI mode.
 *
 * The endpoint lives in src/api/scrobbler.js (always loaded). It once
 * lived in a UI-gated module and 404'd for the default webapp, whose
 * Auto-DJ panel needs it to know whether to render the "Similar
 * artists" toggle enabled or disabled — so this file pins that it is
 * mounted in default UI mode, and its response shape.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// 90 s, not 30: the same loaded-CI-runner ceiling test/helpers/server.mjs
// uses for this wait — a starved Windows shard has expired 30 s at boot.
async function waitForReady(baseUrl, timeoutMs = 90_000) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${baseUrl}/api/`);
      if (r.status < 500) return;
    } catch (err) { lastErr = err; }
    await sleep(150);
  }
  throw new Error(`server not ready: ${lastErr?.message || 'unknown'}`);
}

async function bootMstream(tmpDir, musicDir, extraConfig = {}) {
  const port = await findFreePort();
  const config = {
    port, address: '127.0.0.1', ui: 'default',
    dlna:     { mode: 'disabled' },
    folders:  { testlib: { root: musicDir } },
    storage: {
      albumArtDirectory:   path.join(tmpDir, 'image-cache'),
      dbDirectory:         path.join(tmpDir, 'db'),
      logsDirectory:       path.join(tmpDir, 'logs'),
    },
    scanOptions: { bootScanDelay: 9999, scanInterval: 0, autoAlbumArt: false },
    ...extraConfig,
  };
  for (const dir of Object.values(config.storage)) {
    await fs.mkdir(dir, { recursive: true });
  }
  const cfgPath = path.join(tmpDir, 'config.json');
  await fs.writeFile(cfgPath, JSON.stringify(config));
  const proc = spawn(
    process.execPath, ['cli-boot-wrapper.js', '-j', cfgPath],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'test' } },
  );
  proc.stderr.on('data', () => {});
  proc.stdout.on('data', () => {});
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForReady(baseUrl);
  } catch (err) {
    // A ready-timeout must not leak the child: the server can boot late but
    // healthy on a loaded runner, and a live orphan's stdio keeps this file's
    // event loop open — the run then hangs at exit instead of reporting the
    // timeout. test/helpers/server.mjs kills on this path for the same reason.
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    throw err;
  }
  return { proc, baseUrl };
}

async function killProc(proc) {
  if (proc.exitCode != null || proc.signalCode != null) return;
  proc.kill('SIGKILL');
  await new Promise(r => proc.once('exit', r));
}

describe('GET /api/v1/lastfm/status — default UI mode (default config)', () => {
  // Note: the project ships a default `lastFM.apiKey` baked into
  // `src/state/config.js` (Joi `.default('25627de528b6603d6471cd331ac819e0')`),
  // so `serverEnabled` is `true` for any operator who hasn't explicitly
  // emptied the key. That's the realistic happy-path scenario the
  // webapp will encounter on most deployments.
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lastfm-status-'));
    const musicDir = path.join(tmpDir, 'music');
    await fs.mkdir(musicDir, { recursive: true });
    server = await bootMstream(tmpDir, musicDir);
  });

  after(async () => {
    if (server?.proc) await killProc(server.proc);
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test('endpoint is registered (NOT 404) when ui=default', async () => {
    // This once returned 404 because the route lived in a UI-gated
    // module. Lock in that it always loads so a future "gate it again"
    // refactor is a loud test failure — the primary regression guard.
    const r = await fetch(`${server.baseUrl}/api/v1/lastfm/status`);
    assert.notEqual(r.status, 404, 'lastfm/status missing on default UI');
    assert.equal(r.status, 200);
  });

  test('serverEnabled defaults to true (project ships a shared key)', async () => {
    // The webapp's Auto-DJ "Similar artists" toggle uses this flag to
    // decide whether to render enabled. With the project default key
    // present, the toggle is available out-of-the-box.
    const r = await fetch(`${server.baseUrl}/api/v1/lastfm/status`);
    const body = await r.json();
    assert.equal(body.serverEnabled, true);
  });

  test('response shape matches OpenAPI schema (2 fields)', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/lastfm/status`);
    const body = await r.json();
    const keys = Object.keys(body).sort();
    assert.deepEqual(keys, ['linkedUser', 'serverEnabled']);
    // linkedUser is null because public-mode sentinel hasn't linked
    // a Last.fm account.
    assert.equal(body.linkedUser, null);
  });
});

// Note: there's no "explicitly empty apiKey → serverEnabled=false" test
// here because the Joi config schema in src/state/config.js requires
// `lastFM.apiKey` to be a non-empty string (it defaults to the
// project's shared key when omitted). An operator wanting to opt out
// of Last.fm would need to remove the apiKey entirely (which puts the
// default back) or disable Last.fm via a different toggle. The
// serverEnabled=false branch in the route only fires for runtime mutations
// that null the key — not currently a reachable production state.
