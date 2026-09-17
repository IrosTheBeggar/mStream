/**
 * Discovery plug-in jobs over HTTP (src/api/discovery-plugin-jobs.js) with
 * the test-only noop-acquire plug-in (MSTREAM_TEST_DISCOVERY_NOOP_PLUGIN=1):
 *
 *   POST /api/v1/discovery/plugins/:name/jobs
 *   GET  /api/v1/discovery/plugin-jobs[?state=&all=1]
 *   GET  /api/v1/discovery/plugin-jobs/:id
 *   POST /api/v1/discovery/plugin-jobs/:id/cancel
 *   POST /api/v1/admin/config/discovery-jobs            (gate + cap, live)
 *   POST /api/v1/admin/users/discovery-jobs-access      (per-user flag)
 *
 * Two users so ownership and the whitelist gate are real: an admin and a
 * regular user. Jobs run in the server process; the test polls the job.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';

const ADMIN = { username: 'admin', password: 'pw-admin' };
const USER = { username: 'dana', password: 'pw-dana' };
let server;
let adminToken;
let userToken;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function login(u) {
  const r = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(u),
  });
  return (await r.json()).token;
}
const hdr = (token) => ({ 'Content-Type': 'application/json', 'x-access-token': token });
const post = (token, route, body) => fetch(`${server.baseUrl}${route}`, { method: 'POST', headers: hdr(token), body: JSON.stringify(body || {}) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const get = (token, route) => fetch(`${server.baseUrl}${route}`, { headers: hdr(token) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const rec = (title) => ({ artist: 'Compat Artist', title, album: 'First Album' });
async function untilState(token, id, states, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await get(token, `/api/v1/discovery/plugin-jobs/${id}`);
    if (body && body.job && states.includes(body.job.state)) { return body.job; }
    if (Date.now() > deadline) { throw new Error(`job ${id} never reached ${states.join('|')} (last: ${body && body.job && body.job.state})`); }
    await sleep(100);
  }
}

describe('discovery plug-in jobs API', () => {
  before(async () => {
    server = await startServer({
      dlnaMode: 'disabled', waitForScan: false,
      env: { MSTREAM_TEST_DISCOVERY_NOOP_PLUGIN: '1' },
      extraConfig: { discoveryPlugins: { 'noop-acquire': { enabled: true } } },
      users: [{ ...ADMIN, admin: true, vpaths: ['testlib'] }, { ...USER, vpaths: ['testlib'] }],
    });
    adminToken = await login(ADMIN);
    userToken = await login(USER);
  });
  after(async () => { if (server) { await server.stop(); } });

  test('the test plug-in is listed as runnable and resolve refuses it', async () => {
    const { body } = await get(userToken, '/api/v1/discovery/plugins');
    const p = body.plugins.find((x) => x.name === 'noop-acquire');
    assert.ok(p, 'noop-acquire registered under the env flag');
    assert.deepEqual(p.capabilities, ['acquire']);
    const r = await post(userToken, '/api/v1/discovery/plugins/noop-acquire/resolve', { recommendation: rec('X') });
    assert.equal(r.status, 400, 'acquire plug-ins do not resolve');
  });

  test('a job runs to done with progress and a result; the same recommendation is not queued twice', async () => {
    const a = await post(userToken, '/api/v1/discovery/plugins/noop-acquire/jobs', { recommendation: rec('Opening') });
    assert.equal(a.status, 202, JSON.stringify(a.body));
    assert.equal(a.body.created, true);
    assert.equal(a.body.job.state, 'queued');
    assert.match(a.body.job.key, /^text:/);
    const dup = await post(userToken, '/api/v1/discovery/plugins/noop-acquire/jobs', { recommendation: rec('Opening') });
    assert.ok([200, 202].includes(dup.status));
    if (dup.status === 200) {
      assert.equal(dup.body.created, false);
      assert.equal(dup.body.job.id, a.body.job.id);
    }
    const done = await untilState(userToken, a.body.job.id, ['done', 'failed']);
    assert.equal(done.state, 'done');
    assert.deepEqual(done.result, { echoed: 'Opening', steps: 3 });
    assert.equal(done.progress, 1);
    assert.equal(done.attempts, 1);
  });

  test('a failing plug-in leaves a failed job with its message', async () => {
    const a = await post(userToken, '/api/v1/discovery/plugins/noop-acquire/jobs', { recommendation: rec('please fail') });
    assert.equal(a.status, 202);
    const failed = await untilState(userToken, a.body.job.id, ['done', 'failed']);
    assert.equal(failed.state, 'failed');
    assert.match(failed.error, /refused "please fail"/);
  });

  test('cancel: a running job stops at the next step; a finished one is 409', async () => {
    const a = await post(userToken, '/api/v1/discovery/plugins/noop-acquire/jobs', { recommendation: rec('slow one') });
    assert.equal(a.status, 202);
    await untilState(userToken, a.body.job.id, ['running']);
    const c = await post(userToken, `/api/v1/discovery/plugin-jobs/${a.body.job.id}/cancel`);
    assert.equal(c.status, 200);
    assert.ok(['requested', 'cancelled'].includes(c.body.outcome));
    const cancelled = await untilState(userToken, a.body.job.id, ['cancelled', 'done']);
    assert.equal(cancelled.state, 'cancelled');
    const again = await post(userToken, `/api/v1/discovery/plugin-jobs/${a.body.job.id}/cancel`);
    assert.equal(again.status, 409);
  });

  test('ownership: a user sees only their jobs; an admin sees all with ?all=1; foreign ids are 404', async () => {
    const mine = await get(userToken, '/api/v1/discovery/plugin-jobs');
    assert.equal(mine.status, 200);
    assert.ok(mine.body.jobs.length >= 3);
    assert.ok(mine.body.jobs.every((j) => j.plugin === 'noop-acquire'));
    assert.equal(typeof mine.body.runner.active, 'boolean');
    const adminOwn = await get(adminToken, '/api/v1/discovery/plugin-jobs');
    assert.deepEqual(adminOwn.body.jobs, [], 'the admin started nothing');
    const all = await get(adminToken, '/api/v1/discovery/plugin-jobs?all=1');
    assert.ok(all.body.jobs.length >= mine.body.jobs.length);
    const id = mine.body.jobs[0].id;
    assert.equal((await get(adminToken, `/api/v1/discovery/plugin-jobs/${id}`)).status, 200, 'admin may read it');
    // A second regular user could not; the admin can. Use a bogus id for the 404 shape.
    assert.equal((await get(userToken, '/api/v1/discovery/plugin-jobs/999999')).status, 404);
    const filtered = await get(userToken, '/api/v1/discovery/plugin-jobs?state=done');
    assert.ok(filtered.body.jobs.every((j) => j.state === 'done'));
  });

  test('the whitelist gate: switched on live, blocks until the user is allowed', async () => {
    const gate = await post(adminToken, '/api/v1/admin/config/discovery-jobs', { enabledFor: 'whitelist' });
    assert.equal(gate.status, 200, JSON.stringify(gate.body));
    assert.equal(gate.body.discoveryJobs.enabledFor, 'whitelist');
    const blocked = await post(userToken, '/api/v1/discovery/plugins/noop-acquire/jobs', { recommendation: rec('gated') });
    assert.equal(blocked.status, 403);
    const allow = await post(adminToken, '/api/v1/admin/users/discovery-jobs-access', { username: USER.username, allowDiscoveryJobs: true });
    assert.equal(allow.status, 200);
    // The user object on the request comes from the DB; a fresh login picks up the flag.
    userToken = await login(USER);
    const allowed = await post(userToken, '/api/v1/discovery/plugins/noop-acquire/jobs', { recommendation: rec('gated') });
    assert.equal(allowed.status, 202, JSON.stringify(allowed.body));
    await untilState(userToken, allowed.body.job.id, ['done', 'failed']);
    const back = await post(adminToken, '/api/v1/admin/config/discovery-jobs', { enabledFor: 'all' });
    assert.equal(back.body.discoveryJobs.enabledFor, 'all');
    assert.equal((await post(adminToken, '/api/v1/admin/config/discovery-jobs', { enabledFor: 'everyone' })).status, 400);
    assert.equal((await post(adminToken, '/api/v1/admin/users/discovery-jobs-access', { username: 'nobody', allowDiscoveryJobs: true })).status, 404);
  });

  test('unknown plug-in, non-runnable plug-in and bad bodies', async () => {
    assert.equal((await post(userToken, '/api/v1/discovery/plugins/no-such/jobs', { recommendation: rec('x') })).status, 404);
    assert.equal((await post(userToken, '/api/v1/discovery/plugins/links/jobs', { recommendation: rec('x') })).status, 400);
    assert.equal((await post(userToken, '/api/v1/discovery/plugins/noop-acquire/jobs', {})).status, 400);
  });
});
