/**
 * Regression test: media libraries whose names contain Express-5
 * path-special characters must not crash the boot.
 *
 * Pre-v6 (LokiJS) installs let users name libraries freely, and those names
 * were migrated into v6 verbatim (src/db/migrate-from-loki.js) — bypassing the
 * character restrictions newer libraries get. v6 used to mount each library by
 * interpolating its name into a route path (`/media/<name>/`), but Express 5's
 * path-to-regexp THROWS at registration for names containing ( ) : * +. That
 * threw synchronously in serveIt's media-mount loop, so the server never
 * reached server.listen — the boot died with nothing useful in the log.
 *
 * server.js now dispatches on a `:vpath` route param, keeping arbitrary names
 * away from the path parser. On the pre-fix code this test fails because the
 * child process crashes during boot and startServer() never sees it go ready.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';

describe('media library names with Express-5 path-special characters', () => {
  test('server boots and serves a library named "Movies (2023): Best of"', async () => {
    const libDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-medlib-'));
    await fs.writeFile(path.join(libDir, 'hello.txt'), 'MEDIA-OK');

    // `(`, `)`, and `:` each individually crash path-to-regexp 8 at the
    // app.use('/media/<name>/') call the old code made for every library.
    const name = 'Movies (2023): Best of';

    let server;
    try {
      // waitForScan:false — we only need the server to finish booting (the
      // thing the bug prevented); serving is via express.static and doesn't
      // depend on the scan. On the pre-fix code startServer() throws here
      // because the process exits during boot instead of going ready.
      server = await startServer({
        dlnaMode: 'disabled',
        waitForScan: false,
        extraFolders: { [name]: libDir },
      });

      // No users were created, so the server is in public-access mode and
      // /media is reachable without a token. The :vpath route URL-decodes the
      // segment back to the stored library name.
      const res = await fetch(`${server.baseUrl}/media/${encodeURIComponent(name)}/hello.txt`);
      assert.equal(res.status, 200, 'media file from the special-named library should be served');
      assert.equal((await res.text()).trim(), 'MEDIA-OK');
    } finally {
      if (server) { await server.stop(); }
      await fs.rm(libDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
