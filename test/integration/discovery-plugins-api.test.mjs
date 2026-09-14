/**
 * Discovery plug-ins over HTTP (src/api/discovery-plugins.js + the admin
 * toggle + the feature flag):
 *
 *   GET  /api/v1/discovery/plugins                  enabled plug-ins
 *   POST /api/v1/discovery/plugins/:name/resolve    links for one recommendation
 *   POST /api/v1/admin/config/discovery-plugins     { name, enabled } — live, no reboot
 *   GET  /api/v1/ping → discoveryPlugins            flag, never a probe
 *
 * Public mode (no users): admin endpoints are unauthenticated, which is what
 * lets one server prove the whole loop — list, resolve, disable, vanish,
 * re-enable — without a login dance. The auth gate on /api/v1/admin/* has its
 * own suite.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';

let server;
const json = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });
const post = (route, body) => fetch(`${server.baseUrl}${route}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const REC = {
  artist: 'Compat Artist', title: 'Opening', album: 'First Album', year: 1998,
  isrc: 'GBCMP9800001', releaseGroupMbid: 'rg-first', recordingMbid: null, duration: 36,
  similarity: 0.91, exportId: 'anon:deadbeef', peer: { endpointId: 'a'.repeat(64), name: 'Peer X' },
};

describe('discovery plug-ins API', () => {
  before(async () => {
    server = await startServer({ dlnaMode: 'disabled', waitForScan: false });
  });
  after(async () => { if (server) { await server.stop(); } });

  test('ping advertises the plug-in system (links is on by default)', async () => {
    const { status, body } = await json(await fetch(`${server.baseUrl}/api/v1/ping`));
    assert.equal(status, 200);
    assert.equal(body.discoveryPlugins, true);
    const api = await json(await fetch(`${server.baseUrl}/api/`));
    assert.equal(api.body.features.discoveryPlugins, true);
  });

  test('GET lists the enabled plug-ins with their capabilities', async () => {
    const { status, body } = await json(await fetch(`${server.baseUrl}/api/v1/discovery/plugins`));
    assert.equal(status, 200);
    const links = body.plugins.find((p) => p.name === 'links');
    assert.ok(links, 'links plug-in listed');
    assert.deepEqual(links.capabilities, ['links']);
    assert.equal(links.enabled, true);
    assert.equal(links.scope, 'server');
  });

  test('resolve returns canonical + search links, the persistence key and the normalised recommendation', async () => {
    const { status, body } = await json(await post('/api/v1/discovery/plugins/links/resolve', { recommendation: REC }));
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.plugin, 'links');
    assert.match(body.key, /^text:[0-9a-f]{32}$/);
    assert.equal(body.recommendation.artist, 'Compat Artist');
    assert.ok(!('similarity' in body.recommendation), 'unknown keys stripped');
    const ids = body.result.links.map((l) => l.id);
    assert.ok(ids.includes('musicbrainz-isrc'));
    assert.ok(ids.includes('musicbrainz-release-group'));
    assert.ok(!ids.includes('musicbrainz-recording'));
    assert.ok(ids.includes('youtube-search'));
    assert.equal(body.result.links.find((l) => l.id === 'musicbrainz-isrc').url, 'https://musicbrainz.org/isrc/GBCMP9800001');
  });

  test('malformed bodies are 400s; unknown or malformed plug-in names are 404s', async () => {
    assert.equal((await post('/api/v1/discovery/plugins/links/resolve', {})).status, 400);
    assert.equal((await post('/api/v1/discovery/plugins/links/resolve', { recommendation: { isrc: 'nope' } })).status, 400);
    assert.equal((await post('/api/v1/discovery/plugins/no-such/resolve', { recommendation: REC })).status, 404);
    assert.equal((await post('/api/v1/discovery/plugins/Bad%20Name/resolve', { recommendation: REC })).status, 404);
  });

  test('admin toggle: disabling hides the plug-in everywhere, live, and persists to config.json', async () => {
    const off = await json(await post('/api/v1/admin/config/discovery-plugins', { name: 'links', enabled: false }));
    assert.equal(off.status, 200, JSON.stringify(off.body));

    const list = await json(await fetch(`${server.baseUrl}/api/v1/discovery/plugins`));
    assert.deepEqual(list.body.plugins.filter((p) => p.name === 'links'), [], 'disabled → not listed');
    assert.equal((await post('/api/v1/discovery/plugins/links/resolve', { recommendation: REC })).status, 404, 'disabled → invisible');
    // The flag means "any plug-in on": the other built-ins are still on.
    const ping = await json(await fetch(`${server.baseUrl}/api/v1/ping`));
    assert.equal(ping.body.discoveryPlugins, true, 'other plug-ins are still on → flag stays');

    const cfg = JSON.parse(fs.readFileSync(path.join(server.tmpDir, 'config.json'), 'utf8'));
    assert.equal(cfg.discoveryPlugins.links.enabled, false, 'persisted');

    const admin = await json(await fetch(`${server.baseUrl}/api/v1/admin/config`));
    assert.equal(admin.body.discoveryPlugins.links.enabled, false, 'admin config read reflects it');

    // Switch every remaining plug-in off → the flag finally drops; the
    // listing is empty. Then restore all of them.
    const others = (await json(await fetch(`${server.baseUrl}/api/v1/discovery/plugins`))).body.plugins.map((p) => p.name);
    assert.ok(others.length >= 1);
    for (const name of others) {
      assert.equal((await post('/api/v1/admin/config/discovery-plugins', { name, enabled: false })).status, 200);
    }
    const none = await json(await fetch(`${server.baseUrl}/api/v1/discovery/plugins`));
    assert.deepEqual(none.body.plugins, []);
    const pingOff = await json(await fetch(`${server.baseUrl}/api/v1/ping`));
    assert.equal(pingOff.body.discoveryPlugins, false, 'no plug-in left → flag off');

    for (const name of ['links', ...others]) {
      const on = await json(await post('/api/v1/admin/config/discovery-plugins', { name, enabled: true }));
      assert.equal(on.status, 200, JSON.stringify(on.body));
    }
    const back = await json(await fetch(`${server.baseUrl}/api/v1/discovery/plugins`));
    assert.equal(back.body.plugins.some((p) => p.name === 'links'), true);
    assert.equal(back.body.plugins.length, others.length + 1, 'everything restored');
  });

  test('admin toggle rejects unknown plug-ins and bad bodies', async () => {
    assert.equal((await post('/api/v1/admin/config/discovery-plugins', { name: 'no-such', enabled: true })).status, 400);
    assert.equal((await post('/api/v1/admin/config/discovery-plugins', { name: 'links' })).status, 400);
    assert.equal((await post('/api/v1/admin/config/discovery-plugins', { name: 'links', enabled: 'yes' })).status, 400);
  });
});
