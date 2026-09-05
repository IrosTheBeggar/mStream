/**
 * Upgrade path for configs still carrying ui='velvet'.
 *
 * The velvet UI was removed — webapp/velvet/, the API modules mounted only
 * under it, and their tables (schema V69). `ui` now accepts only 'default',
 * so a persisted `"ui": "velvet"` would fail Joi and crash the server at
 * boot. config.setup() coerces it to 'default', warns, and rewrites
 * config.json so the fix sticks. This pins all three: the server boots, it
 * serves the default UI, and the file is rewritten.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';

describe("config: ui='velvet' is coerced to 'default' on boot", () => {
  let srv;

  before(async () => {
    srv = await startServer({ ui: 'velvet' });
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

  test('config.json is rewritten with the coerced value', async () => {
    const cfg = JSON.parse(await fs.readFile(path.join(srv.tmpDir, 'config.json'), 'utf8'));
    assert.equal(cfg.ui, 'default');
  });
});
