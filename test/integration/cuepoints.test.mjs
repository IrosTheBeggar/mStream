/**
 * Cue points API — promoted from the velvet-only block to core, so these
 * routes must exist on a default-UI server (that's the headline assertion:
 * this suite boots ui='default').
 *
 * Covers the CRUD round-trip and the two isolation properties:
 *  - per-user isolation: users only see/edit/delete their OWN cue points
 *    (plus shared user_id-IS-NULL rows, which nothing creates yet);
 *  - vpath access control: a filepath under a library outside the caller's
 *    vpaths is denied (403 on create, empty list on read).
 *
 * The API keys on (filepath, library_id) directly — the file does NOT have
 * to exist in the scan DB — so paths here are synthetic.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';

const FP = 'testlib/album/track01.mp3';

describe('cue points API (core, default UI)', () => {
  let server, privDir, aliceJwt, bobJwt;

  const login = async (username, password) => {
    const r = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    return (await r.json()).token;
  };

  const api = (token, method, url, body) => fetch(`${server.baseUrl}${url}`, {
    method,
    headers: {
      'x-access-token': token,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const list = async (token, fp = FP) => {
    const r = await api(token, 'GET', `/api/v1/db/cuepoints?fp=${encodeURIComponent(fp)}`);
    assert.equal(r.status, 200);
    return (await r.json()).cuepoints;
  };

  before(async () => {
    // alice sees both libraries; bob sees only testlib.
    privDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mstream-privlib-'));
    server = await startServer({
      dlnaMode: 'disabled',
      extraFolders: { privlib: privDir },
      users: [
        { username: 'alice', password: 'pw-alice', admin: true,  vpaths: ['testlib', 'privlib'] },
        { username: 'bob',   password: 'pw-bob',   admin: false, vpaths: ['testlib'] },
      ],
    });
    aliceJwt = await login('alice', 'pw-alice');
    bobJwt   = await login('bob',   'pw-bob');
  });

  after(async () => {
    if (server) { await server.stop(); }
    if (privDir) { await fs.promises.rm(privDir, { recursive: true, force: true }).catch(() => {}); }
  });

  test('routes are mounted without ui=velvet; empty track lists cleanly', async () => {
    assert.deepEqual(await list(aliceJwt), []);
  });

  test('unauthenticated request is rejected by the auth wall', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/db/cuepoints?fp=${encodeURIComponent(FP)}`);
    assert.equal(r.status, 401);
  });

  test('create → list round-trip; ordered by position with 1-based renumbering', async () => {
    const r1 = await api(aliceJwt, 'POST', '/api/v1/db/cuepoints',
      { filepath: FP, position: 125.5, label: 'Drop' });
    assert.equal(r1.status, 200);
    const { id: idLate } = await r1.json();
    assert.ok(Number.isInteger(idLate) && idLate > 0);

    // A second cue EARLIER in the track must come back first and take no=1.
    const r2 = await api(aliceJwt, 'POST', '/api/v1/db/cuepoints',
      { filepath: FP, position: 30 });
    assert.equal(r2.status, 200);

    const cues = await list(aliceJwt);
    assert.equal(cues.length, 2);
    assert.deepEqual(cues.map(c => c.t), [30, 125.5]);
    assert.deepEqual(cues.map(c => c.no), [1, 2]);
    assert.equal(cues[0].title, null);       // label omitted → null title
    assert.equal(cues[1].title, 'Drop');
    assert.equal(cues[1].id, idLate);
  });

  test('missing position is a 400', async () => {
    const r = await api(aliceJwt, 'POST', '/api/v1/db/cuepoints', { filepath: FP });
    assert.equal(r.status, 400);
  });

  test('junk-typed inputs are 400s, never 500s or silent TEXT rows', async () => {
    // Non-numeric string position — pre-validation this landed as TEXT
    // in the REAL column (SQLite affinity keeps non-numeric strings).
    const s1 = await api(aliceJwt, 'POST', '/api/v1/db/cuepoints', { filepath: FP, position: 'abc' });
    assert.equal(s1.status, 400);

    // Object position — pre-validation node:sqlite threw on bind → 500.
    const s2 = await api(aliceJwt, 'POST', '/api/v1/db/cuepoints', { filepath: FP, position: {} });
    assert.equal(s2.status, 400);

    // JSON.parse('1e999') === Infinity — finite() must reject it.
    const s3 = await fetch(`${server.baseUrl}/api/v1/db/cuepoints`, {
      method: 'POST',
      headers: { 'x-access-token': aliceJwt, 'Content-Type': 'application/json' },
      body: `{"filepath":${JSON.stringify(FP)},"position":1e999}`,
    });
    assert.equal(s3.status, 400);

    const s4 = await api(aliceJwt, 'POST', '/api/v1/db/cuepoints', { filepath: FP, position: -1 });
    assert.equal(s4.status, 400);

    const s5 = await api(aliceJwt, 'POST', '/api/v1/db/cuepoints',
      { filepath: FP, position: 5, label: 'x'.repeat(201) });
    assert.equal(s5.status, 400);

    // PUT shares the schemas: junk position and non-integer id both 400.
    const cues = await list(aliceJwt);
    const p1 = await api(aliceJwt, 'PUT', `/api/v1/db/cuepoints/${cues[0].id}`, { position: 'abc' });
    assert.equal(p1.status, 400);
    const p2 = await api(aliceJwt, 'PUT', '/api/v1/db/cuepoints/abc', { label: 'x' });
    assert.equal(p2.status, 400);
    const d1 = await api(aliceJwt, 'DELETE', '/api/v1/db/cuepoints/abc');
    assert.equal(d1.status, 400);

    // Numeric-string position coerces (Joi default) rather than erroring.
    const ok = await api(aliceJwt, 'POST', '/api/v1/db/cuepoints', { filepath: FP, position: '42.5' });
    assert.equal(ok.status, 200);
    const { id } = await ok.json();
    const stored = (await list(aliceJwt)).find(c => c.id === id);
    assert.equal(stored.t, 42.5);
    await api(aliceJwt, 'DELETE', `/api/v1/db/cuepoints/${id}`);
  });

  test('update own cue point (label + position)', async () => {
    const before_ = await list(aliceJwt);
    const target = before_.find(c => c.title === 'Drop');
    const r = await api(aliceJwt, 'PUT', `/api/v1/db/cuepoints/${target.id}`,
      { label: 'The Drop', position: 126 });
    assert.equal(r.status, 200);
    const after_ = await list(aliceJwt);
    const updated = after_.find(c => c.id === target.id);
    assert.equal(updated.title, 'The Drop');
    assert.equal(updated.t, 126);
  });

  test('PUT label:null clears the label; absent fields stay untouched', async () => {
    const cues = await list(aliceJwt);
    const target = cues.find(c => c.title === 'The Drop');
    const r = await api(aliceJwt, 'PUT', `/api/v1/db/cuepoints/${target.id}`, { label: null });
    assert.equal(r.status, 200);
    const after_ = await list(aliceJwt);
    const cleared = after_.find(c => c.id === target.id);
    assert.equal(cleared.title, null);
    assert.equal(cleared.t, 126);  // position untouched
    // restore the label so later tests can keep asserting against it
    await api(aliceJwt, 'PUT', `/api/v1/db/cuepoints/${target.id}`, { label: 'The Drop' });
  });

  test('per-user isolation: bob sees none of alice\'s cues', async () => {
    assert.deepEqual(await list(bobJwt), []);
  });

  test('per-user isolation: bob cannot update or delete alice\'s cue', async () => {
    const cues = await list(aliceJwt);
    const target = cues[0];

    const put = await api(bobJwt, 'PUT', `/api/v1/db/cuepoints/${target.id}`, { label: 'hijack' });
    assert.equal(put.status, 404);

    // DELETE is an idempotent own-rows-only no-op — it reports ok but must
    // not touch the foreign row.
    const del = await api(bobJwt, 'DELETE', `/api/v1/db/cuepoints/${target.id}`);
    assert.equal(del.status, 200);

    const still = await list(aliceJwt);
    assert.ok(still.some(c => c.id === target.id && c.title !== 'hijack'));
  });

  test('vpath access control: no-access library denies create, hides list', async () => {
    const privFp = 'privlib/secret/mix.flac';

    const denied = await api(bobJwt, 'POST', '/api/v1/db/cuepoints',
      { filepath: privFp, position: 10 });
    assert.equal(denied.status, 403);

    const allowed = await api(aliceJwt, 'POST', '/api/v1/db/cuepoints',
      { filepath: privFp, position: 10, label: 'intro' });
    assert.equal(allowed.status, 200);

    assert.equal((await list(aliceJwt, privFp)).length, 1);
    // bob's read of the same path resolves no library he can access →
    // clean empty list, not an error (and no existence leak).
    assert.deepEqual(await list(bobJwt, privFp), []);
  });

  test('unknown library resolves to an empty list, not an error', async () => {
    assert.deepEqual(await list(aliceJwt, 'nolib/x.mp3'), []);
  });

  test('delete own cue point removes it', async () => {
    const cues = await list(aliceJwt);
    const victim = cues[0];
    const r = await api(aliceJwt, 'DELETE', `/api/v1/db/cuepoints/${victim.id}`);
    assert.equal(r.status, 200);
    const remaining = await list(aliceJwt);
    assert.ok(!remaining.some(c => c.id === victim.id));
    // renumbering: the survivor is no=1 again
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].no, 1);
  });
});
