/**
 * The admin surface of server audio, end to end through a real server:
 *
 *   GET  /api/v1/admin/server-audio/info      the backend snapshot
 *   POST /api/v1/admin/server-audio/detect    re-probe the CLI players
 *   POST /api/v1/admin/config/auto-boot-server-audio
 *                                             persist the preference and
 *                                             RESTART server audio to match
 *
 * The toggle is the one admin path that drives the lifecycle module
 * (src/state/server-audio.js restart()), so this pins its wiring: the
 * request must come back 200 with the preference persisted and the info
 * endpoint still answering afterwards.
 *
 * Runs on any host, players or not: with autoBoot kept OFF nothing is ever
 * downloaded, and a box without mpv/MPD/VLC/MPlayer simply reports no
 * backend. The test asserts shapes and the persisted flag, never that a
 * player started. (Toggling autoBoot ON is deliberately not exercised —
 * on a host whose platform the manifest pins, that would fetch the engine
 * from GitHub inside the test.)
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
  return { status: r.status, body: await r.json() };
}

describe('server-audio admin surface', () => {
  before(async () => {
    srv = await startServer({ waitForScan: false });
  });

  after(async () => { await srv?.stop(); });

  test('info reports the backend snapshot in the documented shape', async () => {
    const { status, body } = await getJson('/api/v1/admin/server-audio/info');
    assert.equal(status, 200);
    assert.ok(['rust', 'cli', null].includes(body.backend), `backend: ${body.backend}`);
    assert.ok(body.player === null || typeof body.player === 'string');
    assert.ok(Array.isArray(body.detectedCliPlayers));
    assert.equal(typeof body.binaryFetchable, 'boolean');
    // A CLI backend can only be active when a CLI player was detected.
    if (body.backend === 'cli') { assert.ok(body.detectedCliPlayers.includes(body.player)); }
  });

  test('detect re-probes and feeds the snapshot the info endpoint reports', async () => {
    const detect = await postJson('/api/v1/admin/server-audio/detect');
    assert.equal(detect.status, 200);
    assert.ok(Array.isArray(detect.body.detectedCliPlayers));
    for (const name of detect.body.detectedCliPlayers) {
      assert.ok(['mpv', 'mpd', 'vlc', 'mplayer'].includes(name), `unknown player name ${name}`);
    }

    const info = await getJson('/api/v1/admin/server-audio/info');
    assert.deepEqual(info.body.detectedCliPlayers, detect.body.detectedCliPlayers,
      'info reads the snapshot the last detect wrote');
  });

  test('the autoBoot toggle persists the preference and restarts server audio', async () => {
    const before = await getJson('/api/v1/admin/config');
    assert.equal(before.body.autoBootServerAudio, false, 'the default preference is CLI-only');

    // Same value as before: still a full restart on the server side, and
    // the request must survive it (an engine-less host makes this the
    // "stop nothing, boot nothing, come back 200" path).
    const toggled = await postJson('/api/v1/admin/config/auto-boot-server-audio', { autoBootServerAudio: false });
    assert.equal(toggled.status, 200, JSON.stringify(toggled.body));

    const after = await getJson('/api/v1/admin/config');
    assert.equal(after.body.autoBootServerAudio, false);

    const info = await getJson('/api/v1/admin/server-audio/info');
    assert.equal(info.status, 200, 'the lifecycle module answers after a restart');
    assert.ok(['rust', 'cli', null].includes(info.body.backend));
  });

  test('the toggle validates its body', async () => {
    const bad = await postJson('/api/v1/admin/config/auto-boot-server-audio', { autoBootServerAudio: 'yes' });
    assert.equal(bad.status, 400);
  });
});
