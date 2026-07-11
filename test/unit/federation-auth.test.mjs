/**
 * Federation-key auth building blocks that don't need a running server:
 *
 *  - the read-route allowlist matrix (exact matches, GET-only prefixes,
 *    everything else refused);
 *  - the feature-off gate: with federation.enabled=false every key is inert
 *    (401 before any DB lookup), even over plain LAN HTTP;
 *  - the getUserLibraryIds explicit-grant override: a synthetic user carrying
 *    libraryIds short-circuits BEFORE the public-mode branch (id null would
 *    otherwise read as public mode = every library).
 *
 * The full path through a real server (wall ordering, vpath scoping on
 * /media and db routes, revocation) lives in
 * test/integration/federation-e2e.test.mjs.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isFederationPathAllowed, authenticateFederationKey } from '../../src/api/federation-auth.js';
import { getUserLibraryIds } from '../../src/db/manager.js';
import * as config from '../../src/state/config.js';

const req = (method, p) => ({ method, path: p, ip: '127.0.0.1' });

describe('federation route allowlist', () => {
  test('allows the read surface', () => {
    for (const [m, p] of [
      ['GET', '/api/v1/db/status'],
      ['POST', '/api/v1/db/metadata'],
      ['POST', '/api/v1/db/metadata/batch'],
      ['GET', '/api/v1/db/artists'],
      ['POST', '/api/v1/db/artists'],
      ['POST', '/api/v1/db/artists-albums'],
      ['GET', '/api/v1/db/albums'],
      ['POST', '/api/v1/db/albums'],
      ['GET', '/api/v1/db/genres'],
      ['POST', '/api/v1/db/genres'],
      ['POST', '/api/v1/db/genre-songs'],
      ['POST', '/api/v1/db/album-songs'],
      ['POST', '/api/v1/db/recent/added'],
      ['POST', '/api/v1/db/search'],
      ['GET', '/api/v1/federation/health'],
      ['GET', '/media/music/album/track.mp3'],
      ['GET', '/album-art/abc123.jpg'],
    ]) {
      assert.equal(isFederationPathAllowed(req(m, p)), true, `${m} ${p} should be allowed`);
    }
  });

  test('refuses writes, admin, per-user reads, and non-GET statics', () => {
    for (const [m, p] of [
      ['POST', '/api/v1/db/rate-song'],
      ['GET', '/api/v1/db/rated'],
      ['POST', '/api/v1/db/stats/recently-played'],
      ['POST', '/api/v1/playlist/save'],
      ['GET', '/api/v1/admin/federation/keys'],
      ['POST', '/api/v1/file-explorer'],
      ['GET', '/api/v1/download/zip'],
      ['POST', '/media/music/album/track.mp3'], // static trees are GET-only
      ['POST', '/album-art/abc123.jpg'],
      ['GET', '/api/v1/auth/login'],
      ['GET', '/'],
    ]) {
      assert.equal(isFederationPathAllowed(req(m, p)), false, `${m} ${p} should be refused`);
    }
  });
});

describe('federation disabled gate', () => {
  let tmpDir;
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-fed-auth-'));
    await config.setup(path.join(tmpDir, 'config.json')); // defaults: federation.enabled=false
  });
  after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } });

  test('rejects any key with 401 while federation.enabled=false', () => {
    assert.throws(
      () => authenticateFederationKey('fedk_anything', req('GET', '/api/v1/federation/health')),
      (err) => err.status === 401 && /Authentication/.test(err.message),
    );
  });
});

describe('getUserLibraryIds explicit-grant override', () => {
  test('libraryIds wins before the public-mode branch (no DB needed)', () => {
    // id:null would read as public mode; the override must short-circuit
    // first — this call touching the libraries cache would throw here since
    // no DB is initialized in this process.
    assert.deepEqual(getUserLibraryIds({ id: null, libraryIds: [5, 7] }), [5, 7]);
    assert.deepEqual(getUserLibraryIds({ id: null, libraryIds: [] }), [], 'empty grants stay empty');
  });
});
