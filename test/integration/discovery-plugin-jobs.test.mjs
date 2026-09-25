/**
 * Discovery plug-in jobs over HTTP (src/api/discovery-plugin-jobs.js) with
 * the test-only noop-acquire plug-in (MSTREAM_TEST_DISCOVERY_NOOP_PLUGIN=1):
 *
 *   POST /api/v1/discovery/plugins/:name/jobs
 *   GET  /api/v1/discovery/plugin-jobs[?state=&all=1]
 *   GET  /api/v1/discovery/plugin-jobs/:id
 *   POST /api/v1/discovery/plugin-jobs/:id/cancel
 *   POST /api/v1/discovery/plugin-jobs/lookup            (a recommendation's jobs)
 *   POST /api/v1/discovery/plugin-jobs/clear             ("Clear finished")
 *   POST /api/v1/admin/config/discovery-jobs            (gate + cap, live)
 *   POST /api/v1/admin/users/discovery-jobs-access      (per-user flag)
 *
 * Three users so ownership and the whitelist gate are real: an admin and two
 * regular users. Jobs run in the server process; the test polls the job.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';

const ADMIN = { username: 'admin', password: 'pw-admin' };
const USER = { username: 'dana', password: 'pw-dana' };
const OTHER = { username: 'eli', password: 'pw-eli' };
let server;
let adminToken;
let userToken;
let otherToken;

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
      users: [{ ...ADMIN, admin: true, vpaths: ['testlib'] }, { ...USER, vpaths: ['testlib'] }, { ...OTHER, vpaths: ['testlib'] }],
    });
    adminToken = await login(ADMIN);
    userToken = await login(USER);
    otherToken = await login(OTHER);
  });
  after(async () => { if (server) { await server.stop(); } });

  test('the test plug-in is listed as runnable and resolve refuses it', async () => {
    const { body } = await get(userToken, '/api/v1/discovery/plugins');
    const p = body.plugins.find((x) => x.name === 'noop-acquire');
    assert.ok(p, 'noop-acquire registered under the env flag');
    assert.deepEqual(p.capabilities, ['acquire']);
    const r = await post(userToken, '/api/v1/discovery/plugins/noop-acquire/resolve', { recommendation: rec('X') });
    assert.equal(r.status, 400, 'acquire plug-ins do not resolve');
    assert.deepEqual(body.jobs, { allowed: true }, 'the gate is open to everyone by default');
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
    assert.deepEqual(done.result, { echoed: 'Opening', steps: 3, scope: 'song' });
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
    assert.ok(cancelled.result && cancelled.result.cancelledAt >= 1, 'what the plug-in handed back on its way out stays with the row');
    const again = await post(userToken, `/api/v1/discovery/plugin-jobs/${a.body.job.id}/cancel`);
    assert.equal(again.status, 409);
  });

  test('lookup: the caller\'s newest job per plug-in for a recommendation', async () => {
    const first = await post(userToken, '/api/v1/discovery/plugin-jobs/lookup', { recommendation: rec('Opening') });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.match(first.body.key, /^text:/);
    assert.equal(first.body.jobs.length, 1);
    assert.equal(first.body.jobs[0].plugin, 'noop-acquire');
    assert.equal(first.body.jobs[0].state, 'done');
    // Asked for again, the newer job is the one a client should draw.
    const again = await post(userToken, '/api/v1/discovery/plugins/noop-acquire/jobs', { recommendation: rec('Opening') });
    assert.equal(again.status, 202);
    await untilState(userToken, again.body.job.id, ['done', 'failed']);
    const second = await post(userToken, '/api/v1/discovery/plugin-jobs/lookup', { recommendation: rec('Opening') });
    assert.deepEqual(second.body.jobs.map((j) => j.id), [again.body.job.id]);
    assert.equal(second.body.key, first.body.key);
    // Nobody else's, nothing unknown, and a recommendation is required.
    assert.deepEqual((await post(otherToken, '/api/v1/discovery/plugin-jobs/lookup', { recommendation: rec('Opening') })).body.jobs, []);
    assert.deepEqual((await post(userToken, '/api/v1/discovery/plugin-jobs/lookup', { recommendation: rec('Never asked for') })).body.jobs, []);
    assert.equal((await post(userToken, '/api/v1/discovery/plugin-jobs/lookup', {})).status, 400);
  });

  test('a live job that is another account\'s answers 409; an admin gets the job', async () => {
    const mine = await post(userToken, '/api/v1/discovery/plugins/noop-acquire/jobs', { recommendation: rec('slow shared') });
    assert.equal(mine.status, 202);
    const theirs = await post(otherToken, '/api/v1/discovery/plugins/noop-acquire/jobs', { recommendation: rec('slow shared') });
    assert.equal(theirs.status, 409, JSON.stringify(theirs.body));
    assert.ok(!JSON.stringify(theirs.body).includes('"userId"'), 'nothing of the other account\'s row leaks');
    const admin = await post(adminToken, '/api/v1/discovery/plugins/noop-acquire/jobs', { recommendation: rec('slow shared') });
    assert.equal(admin.status, 200);
    assert.equal(admin.body.job.id, mine.body.job.id);
    await post(userToken, `/api/v1/discovery/plugin-jobs/${mine.body.job.id}/cancel`);
    await untilState(userToken, mine.body.job.id, ['cancelled', 'done']);
    // Once it is over the other account may ask for itself.
    const after = await post(otherToken, '/api/v1/discovery/plugins/noop-acquire/jobs', { recommendation: rec('slow shared') });
    assert.equal(after.status, 202);
    await post(otherToken, `/api/v1/discovery/plugin-jobs/${after.body.job.id}/cancel`);
    await untilState(otherToken, after.body.job.id, ['cancelled', 'done']);
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
    assert.deepEqual((await get(userToken, '/api/v1/discovery/plugins')).body.jobs, { allowed: false }, 'the listing says so up front');
    const allow =await post(adminToken, '/api/v1/admin/users/discovery-jobs-access', { username: USER.username, allowDiscoveryJobs: true });
    assert.equal(allow.status, 200);
    // The user object on the request comes from the DB; a fresh login picks up the flag.
    userToken = await login(USER);
    assert.deepEqual((await get(userToken, '/api/v1/discovery/plugins')).body.jobs, { allowed: true });
    assert.deepEqual((await get(otherToken, '/api/v1/discovery/plugins')).body.jobs, { allowed: false }, 'per account');
    const allowed =await post(userToken, '/api/v1/discovery/plugins/noop-acquire/jobs', { recommendation: rec('gated') });
    assert.equal(allowed.status, 202, JSON.stringify(allowed.body));
    await untilState(userToken, allowed.body.job.id, ['done', 'failed']);
    const back = await post(adminToken, '/api/v1/admin/config/discovery-jobs', { enabledFor: 'all' });
    assert.equal(back.body.discoveryJobs.enabledFor, 'all');
    assert.equal((await post(adminToken, '/api/v1/admin/config/discovery-jobs', { enabledFor: 'everyone' })).status, 400);
    assert.equal((await post(adminToken, '/api/v1/admin/users/discovery-jobs-access', { username: 'nobody', allowDiscoveryJobs: true })).status, 404);
  });

  test('clear: the caller\'s settled rows go, a live job stays, other accounts are untouched', async () => {
    const live = await post(userToken, '/api/v1/discovery/plugins/noop-acquire/jobs', { recommendation: rec('slow survivor') });
    assert.equal(live.status, 202);
    await untilState(userToken, live.body.job.id, ['running']);
    const before = (await get(userToken, '/api/v1/discovery/plugin-jobs')).body.jobs;
    assert.ok(before.length >= 5, 'done, failed and cancelled history from the tests above');
    const othersBefore = (await get(otherToken, '/api/v1/discovery/plugin-jobs')).body.jobs.length;
    assert.ok(othersBefore >= 1);

    const cleared = await post(userToken, '/api/v1/discovery/plugin-jobs/clear');
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal(cleared.body.removed, before.length - 1);
    const left = (await get(userToken, '/api/v1/discovery/plugin-jobs')).body.jobs;
    assert.deepEqual(left.map((j) => j.id), [live.body.job.id], 'the running job is the only row left');
    assert.equal((await get(otherToken, '/api/v1/discovery/plugin-jobs')).body.jobs.length, othersBefore);
    assert.deepEqual((await post(userToken, '/api/v1/discovery/plugin-jobs/lookup', { recommendation: rec('Opening') })).body.jobs, []);

    await post(userToken, `/api/v1/discovery/plugin-jobs/${live.body.job.id}/cancel`);
    await untilState(userToken, live.body.job.id, ['cancelled', 'done']);
    assert.equal((await post(userToken, '/api/v1/discovery/plugin-jobs/clear')).body.removed, 1);
  });

  test('scopes: an album job beside a song job of one recommendation, its own key and params; refusals', async () => {
    const r = rec('slow scoped');
    const song = await post(userToken, '/api/v1/discovery/plugins/noop-acquire/jobs', { recommendation: r });
    const album = await post(userToken, '/api/v1/discovery/plugins/noop-acquire/jobs', { recommendation: r, scope: 'album' });
    assert.equal(song.status, 202, JSON.stringify(song.body));
    assert.equal(album.status, 202, JSON.stringify(album.body));
    assert.equal(album.body.created, true, 'not deduped against the live song job');
    assert.notEqual(album.body.job.id, song.body.job.id);
    assert.match(album.body.job.key, /^album:/);
    assert.deepEqual(album.body.job.params, { scope: 'album' });
    assert.equal(song.body.job.params, null, 'the song scope is the default and leaves no params');
    // The lookup answers both, under their own keys.
    const look = await post(userToken, '/api/v1/discovery/plugin-jobs/lookup', { recommendation: r });
    assert.equal(look.status, 200, JSON.stringify(look.body));
    assert.equal(look.body.key, song.body.job.key);
    assert.deepEqual(Object.keys(look.body.keys), ['song', 'album', 'artist', 'artist-missing']);
    assert.equal(look.body.keys.album, album.body.job.key);
    assert.deepEqual(look.body.jobs.map((j) => j.id).sort(), [song.body.job.id, album.body.job.id].sort());
    // The same album asked for through another of its songs is the same live job.
    const again = await post(userToken, '/api/v1/discovery/plugins/noop-acquire/jobs', { recommendation: rec('other slow song'), scope: 'album' });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.job.id, album.body.job.id);
    // Refusals: a scope the plug-in did not declare, one the recommendation cannot fill, nonsense.
    const artist = await post(userToken, '/api/v1/discovery/plugins/noop-acquire/jobs', { recommendation: r, scope: 'artist' });
    assert.equal(artist.status, 400);
    assert.match(artist.body.error, /has no "artist" scope/);
    const noAlbum = await post(userToken, '/api/v1/discovery/plugins/noop-acquire/jobs', { recommendation: { artist: 'Compat Artist', title: 'no album' }, scope: 'album' });
    assert.equal(noAlbum.status, 400);
    assert.match(noAlbum.body.error, /needs the recommendation's album/);
    assert.equal((await post(userToken, '/api/v1/discovery/plugins/noop-acquire/jobs', { recommendation: r, scope: 'galaxy' })).status, 400);
    // The album job runs with its scope in hand.
    const done = await untilState(userToken, album.body.job.id, ['done', 'failed']);
    assert.equal(done.result.scope, 'album');
    await untilState(userToken, song.body.job.id, ['done', 'failed']);
  });

  test('unknown plug-in, non-runnable plug-in and bad bodies', async () => {
    assert.equal((await post(userToken, '/api/v1/discovery/plugins/no-such/jobs', { recommendation: rec('x') })).status, 404);
    assert.equal((await post(userToken, '/api/v1/discovery/plugins/links/jobs', { recommendation: rec('x') })).status, 400);
    assert.equal((await post(userToken, '/api/v1/discovery/plugins/noop-acquire/jobs', {})).status, 400);
  });

  test('a jukebox session token reaches none of it: the account with its writes off is not the account', async () => {
    // A remote-control guest holds the owner's account minus every write
    // (auth.js buildJukeboxUser). Every discovery plug-in route acts on the
    // account itself — a job writes a file into its library, a removal
    // deletes one — so the guest is refused at the door.
    const { default: WebSocket } = await import('ws');
    const juke = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${server.baseUrl.replace(/^http/, 'ws')}/?token=${userToken}`);
      ws.on('message', (m) => { const j = JSON.parse(String(m)); if (j.token) { resolve({ ws, token: j.token }); } });
      ws.on('error', reject);
    });
    try {
      const refused = async (method, route, body) => {
        const r = await fetch(`${server.baseUrl}${route}`, { method, headers: hdr(juke.token), body: body === undefined ? undefined : JSON.stringify(body) });
        assert.equal(r.status, 403, `${method} ${route} answered ${r.status}`);
        assert.match((await r.json()).error, /jukebox session/);
      };
      await refused('POST', '/api/v1/discovery/plugins/noop-acquire/jobs', { recommendation: rec('Guest Pick') });
      await refused('GET', '/api/v1/discovery/plugin-jobs');
      await refused('POST', '/api/v1/discovery/plugin-jobs/clear', {});
      await refused('POST', '/api/v1/discovery/plugin-jobs/lookup', { recommendation: rec('Guest Pick') });
      await refused('GET', '/api/v1/discovery/plugins');
      await refused('POST', '/api/v1/discovery/plugins/noop-acquire/resolve', { recommendation: rec('Guest Pick') });
      await refused('GET', '/api/v1/discovery/downloads');
      await refused('DELETE', '/api/v1/discovery/downloads/1');
      await refused('GET', '/api/v1/discovery/collection/destination');
      await refused('PUT', '/api/v1/discovery/collection/destination', { destination: null });
      const jobs = await get(userToken, '/api/v1/discovery/plugin-jobs');
      assert.ok(!jobs.body.jobs.some((j) => j.recommendation && j.recommendation.title === 'Guest Pick'), 'nothing was queued in the owner\'s name');
    } finally {
      juke.ws.close();
    }
  });

  test('per-user plug-in settings: stored per account, checked, secrets never read back', async () => {
    const route = '/api/v1/discovery/plugins/noop-acquire/settings';
    const put = (token, body) => fetch(`${server.baseUrl}${route}`, { method: 'PUT', headers: hdr(token), body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

    const empty = await get(userToken, route);
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.deepEqual(empty.body.keys, ['note', 'token']);
    assert.deepEqual(empty.body.settings, {});
    assert.equal(empty.body.connected, false);
    const listed = (await get(userToken, '/api/v1/discovery/plugins')).body.plugins.find((p) => p.name === 'noop-acquire');
    assert.deepEqual(listed.settings, ['note', 'token']);

    const note = await put(userToken, { key: 'note', value: 'hello' });
    assert.equal(note.status, 200, JSON.stringify(note.body));
    assert.equal(note.body.settings.note.value, 'hello');
    const token = await put(userToken, { key: 'token', value: 'lb-secret-token' });
    assert.equal(token.status, 200);
    assert.deepEqual(Object.keys(token.body.settings.token).sort(), ['secret', 'set', 'updatedAt']);
    assert.equal(token.body.connected, true, 'the plug-in sees its secret server-side');
    assert.ok(!JSON.stringify(token.body).includes('lb-secret-token'), 'the secret never comes back');

    // Shape and meaning are both checked; an unknown key is refused.
    assert.equal((await put(userToken, { key: 'token', value: 'abc' })).status, 400, 'the schema (min length)');
    assert.equal((await put(userToken, { key: 'note', value: 'a forbidden word' })).status, 400, 'the plug-in\'s own check');
    assert.equal((await put(userToken, { key: 'colour', value: 'red' })).status, 400, 'an unknown key');
    assert.equal((await put(userToken, { key: 'note' })).status, 400, 'a value is required (null deletes)');

    // Another account has its own, empty set.
    const other = await get(adminToken, route);
    assert.deepEqual(other.body.settings, {});
    assert.equal(other.body.connected, false);

    const gone = await put(userToken, { key: 'token', value: null });
    assert.equal(gone.status, 200);
    assert.equal(gone.body.settings.token, undefined);
    assert.equal(gone.body.connected, false);

    // A plug-in without settings, and one that is not here.
    assert.equal((await get(userToken, '/api/v1/discovery/plugins/links/settings')).status, 400);
    assert.equal((await get(userToken, '/api/v1/discovery/plugins/no-such/settings')).status, 404);
  });
});
