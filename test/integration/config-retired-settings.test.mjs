/**
 * Upgrade path for config files carrying retired settings.
 *
 * `ui` selected the web UI when there were three; the bundled Subsonic
 * client left with the Subsonic API and the velvet UI was removed (schema
 * V69), so the setting is gone. `discogs` configured the velvet-only Discogs
 * art lookup. A real upgrade brings both keys along in config.json —
 * `"ui": "default"` in particular is what the admin panel wrote for years.
 * config.setup() strips them and rewrites the file. This pins the whole
 * boot: the server comes up, serves the default UI, and the file is clean.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';

describe('config: retired settings are stripped on boot', () => {
  let srv;

  before(async () => {
    srv = await startServer({
      extraConfig: {
        ui: 'velvet',
        discogs: { enabled: true, allowArtUpdate: false, apiKey: 'k', apiSecret: 's' },
      },
    });
  });

  after(async () => {
    if (srv) { await srv.stop(); }
  });

  test('server boots and serves the default UI shell', async () => {
    const r = await fetch(`${srv.baseUrl}/`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes('alpha/m.js'), 'default UI index.html is served');
    const js = await fetch(`${srv.baseUrl}/alpha/m.js`);
    assert.equal(js.status, 200, 'default UI assets resolve from webapp/');
  });

  test('config.json is rewritten without the retired keys', async () => {
    const cfg = JSON.parse(await fs.readFile(path.join(srv.tmpDir, 'config.json'), 'utf8'));
    assert.ok(!('ui' in cfg), 'ui removed');
    assert.ok(!('discogs' in cfg), 'discogs removed');
    assert.ok('storage' in cfg, 'the rest of the file is intact');
  });
});
