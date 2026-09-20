/**
 * The admin surface of server audio, end to end through a real server:
 *
 *   GET  /api/v1/admin/server-audio/info      is the engine running?
 *   POST /api/v1/admin/config/auto-boot-server-audio
 *                                             persist the on/off switch and
 *                                             RESTART server audio to match
 *
 * The toggle is the one admin path that drives the lifecycle module
 * (src/state/server-audio.js restart()), so this pins its wiring: the
 * request must come back 200 with the switch persisted and the info endpoint
 * still answering afterwards.
 *
 * It also pins the engine-only cut: autoBootServerAudio=false starts NOTHING,
 * on any host. It used to mean "use an installed mpv / VLC / MPlayer or a
 * reachable MPD", so a backend could be up with the feature "off" — which is
 * why this test once had to tolerate any backend value. The detection
 * snapshot and its endpoint are gone with the players.
 *
 * Turning the switch ON is deliberately not exercised here: on a developer
 * machine that already has the engine installed it would spawn a real audio
 * process on the default port. That path is the unit suite's (fake spawner)
 * and the real-engine smoke's.
 *
 * Public-access mode (no users) makes the admin routes token-free.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';

let srv;

async function getJson(pathname) {
  const r = await fetch(`${srv.baseUrl}${pathname}`);
  return { status: r.status, body: await r.json() };
}

async function postJson(pathname, body) {
  const r = await fetch(`${srv.baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

describe('server-audio admin surface', () => {
  before(async () => {
    srv = await startServer({ waitForScan: false });
  });

  after(async () => { await srv?.stop(); });

  test('off by default, and off means nothing is running — whatever the host has installed', async () => {
    const config = await getJson('/api/v1/admin/config');
    assert.equal(config.body.autoBootServerAudio, false);

    const { status, body } = await getJson('/api/v1/admin/server-audio/info');
    assert.equal(status, 200);
    assert.equal(body.backend, null);
    assert.equal(body.player, null);
    assert.equal(typeof body.binaryFetchable, 'boolean');
  });

  test('info has no detected-players list, and the detect endpoint is gone with the CLI backends', async () => {
    const { body } = await getJson('/api/v1/admin/server-audio/info');
    assert.deepEqual(Object.keys(body).sort(), ['backend', 'binaryFetchable', 'player']);

    const detect = await postJson('/api/v1/admin/server-audio/detect');
    assert.equal(detect.status, 404);
  });

  test('the toggle persists the switch and restarts server audio', async () => {
    // Off → off is still a full stop-then-boot on the server side, and the
    // request must survive it.
    const toggled = await postJson('/api/v1/admin/config/auto-boot-server-audio', { autoBootServerAudio: false });
    assert.equal(toggled.status, 200, JSON.stringify(toggled.body));

    const after = await getJson('/api/v1/admin/config');
    assert.equal(after.body.autoBootServerAudio, false);

    const info = await getJson('/api/v1/admin/server-audio/info');
    assert.equal(info.status, 200, 'the lifecycle module answers after a restart');
    assert.equal(info.body.backend, null);
  });

  test('the toggle validates its body', async () => {
    const bad = await postJson('/api/v1/admin/config/auto-boot-server-audio', { autoBootServerAudio: 'yes' });
    assert.equal(bad.status, 400);
  });
});
