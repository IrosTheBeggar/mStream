/**
 * The admin side of the discovery plug-ins — what the admin panel's
 * "Discovery Plugins" view stands on (src/api/admin.js):
 *
 *   GET  /api/v1/admin/discovery-plugins/status     plug-ins + jobs, one answer
 *   POST /api/v1/admin/config/discovery-plugins     { name, enabled? , settings? }
 *   POST /api/v1/admin/discovery-plugins/probe      { name, settings? }  check again / Test
 *   POST /api/v1/admin/config/discovery-jobs        the gate, the cap, the jobs clock
 *   GET  /api/v1/admin/users                        + allowDiscoveryJobs
 *   GET  /api/v1/discovery/plugin-jobs?all=1        + username
 *
 * yt-dlp is the scripted stand-in (test/helpers/fake-yt-dlp.mjs), so the
 * youtube plug-in's probe has something to run, and a download can land in a
 * per-run collection library.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../helpers/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FFMPEG = process.platform === 'win32'
  ? path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg.exe')
  : path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg');
const FAKE = path.join(REPO_ROOT, 'test', 'helpers', 'fake-yt-dlp.mjs');
const hasFfmpeg = fs.existsSync(FFMPEG);

const ADMIN = { username: 'admin', password: 'pw-admin' };
const USER = { username: 'dana', password: 'pw-dana' };
const STATUS = '/api/v1/admin/discovery-plugins/status';
const PLUGINS = '/api/v1/admin/config/discovery-plugins';
const PROBE = '/api/v1/admin/discovery-plugins/probe';
const JOBS_CFG = '/api/v1/admin/config/discovery-jobs';
const REC = { source: 'p2p', artist: 'Nova', title: 'Remote Hit', album: 'Night Ferry', year: 2019, duration: 2 };
const yt = (id) => `https://www.youtube.com/watch?v=${id}`;
const SEARCH = {
  'remote hit': [{ id: 'topic', url: yt('topic'), title: 'Remote Hit', duration: 2, channel: 'Nova - Topic', uploader: 'Nova - Topic', artist: 'Nova', album: 'Night Ferry', webpage_url: yt('topic') }],
};

let server, workDir, collectionDir, adminToken, userToken;

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${stderr.slice(-200)}`)));
  });
}
async function login(u) {
  const r = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(u),
  });
  return (await r.json()).token;
}
async function api(token, method, route, body) {
  const r = await fetch(`${server.baseUrl}${route}`, {
    method, headers: { 'Content-Type': 'application/json', 'x-access-token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const pluginOf = (body, name) => body.plugins.find((p) => p.name === name);
async function untilFinished(token, id, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await api(token, 'GET', `/api/v1/discovery/plugin-jobs/${id}`);
    if (body && body.job && ['done', 'failed', 'cancelled'].includes(body.job.state)) { return body.job; }
    if (Date.now() > deadline) { throw new Error(`job ${id} never finished`); }
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('discovery plug-ins · admin API', { skip: hasFfmpeg ? false : 'bundled ffmpeg missing (bin/ffmpeg)' }, () => {
  before(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-dpadmin-'));
    collectionDir = path.join(workDir, 'collection');
    fs.mkdirSync(collectionDir, { recursive: true });
    const fixturePath = path.join(workDir, 'fixture.mp3');
    const scriptPath = path.join(workDir, 'fake-yt-dlp.json');
    await runFfmpeg(['-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ac', '1', fixturePath]);
    fs.writeFileSync(scriptPath, JSON.stringify({ search: SEARCH, details: {}, download: {}, version: '2026.02.04' }));
    server = await startServer({
      dlnaMode: 'disabled', waitForScan: false,
      extraFolders: { collection: collectionDir },
      env: { MSTREAM_YTDLP_BIN: FAKE, MSTREAM_FAKE_YTDLP_SCRIPT: scriptPath, MSTREAM_FAKE_YTDLP_FIXTURE: fixturePath, MSTREAM_TEST_DISCOVERY_NOOP_PLUGIN: '1' },
      extraConfig: {
        discoveryPlugins: { youtube: { enabled: true }, 'noop-acquire': { enabled: true } },
        discoveryJobs: { stagingDir: path.join(workDir, 'staging') },
      },
      // dana's only library is the per-run collection, so her download's
      // default destination is that and never the shared fixture library.
      users: [{ ...ADMIN, admin: true, vpaths: ['testlib', 'collection'] }, { ...USER, vpaths: ['collection'] }],
    });
    adminToken = await login(ADMIN);
    userToken = await login(USER);
  });
  after(async () => {
    if (server) { await server.stop(); }
    if (workDir) { fs.rmSync(workDir, { recursive: true, force: true }); }
  });

  test('status: every plug-in with its editable config and probe detail; the job gate', async () => {
    const r = await api(adminToken, 'GET', STATUS);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const names = r.body.plugins.map((p) => p.name);
    for (const n of ['links', 'deezer', 'itunes', 'federation-play', 'federation-copy', 'youtube']) { assert.ok(names.includes(n), `${n} is listed`); }
    const youtube = pluginOf(r.body, 'youtube');
    assert.deepEqual([youtube.enabled, youtube.available, youtube.reason], [true, true, null]);
    assert.deepEqual(youtube.adminSettings, ['binary', 'codec', 'maxFilesizeMb', 'searchResults']);
    assert.deepEqual(youtube.config, { binary: 'yt-dlp', codec: 'mp3', maxFilesizeMb: 100, searchResults: 8 });
    assert.deepEqual(youtube.detail, { ytdlp: '2026.02.04', ffmpeg: true }, 'the probe says what it found');
    assert.deepEqual(pluginOf(r.body, 'itunes').config, { country: 'US' });
    assert.deepEqual(pluginOf(r.body, 'links').config, {});
    assert.deepEqual(pluginOf(r.body, 'links').adminSettings, []);
    // A plug-in that keeps a per-user secret reports how many accounts hold one — never which, never the value.
    assert.equal(pluginOf(r.body, 'noop-acquire').connectedUsers, 0);
    assert.equal(pluginOf(r.body, 'links').connectedUsers, undefined);

    assert.deepEqual(r.body.jobs, { enabledFor: 'all', maxConcurrent: 2, retentionDays: 30, running: 0, queued: 0 });
    assert.equal(r.body.downloads, undefined, 'no scratch folder to report on');

    assert.equal((await api(userToken, 'GET', STATUS)).status, 403, 'admins only');
  });

  test('connected users: a secret one account stores is counted, not shown', async () => {
    const put = await fetch(`${server.baseUrl}/api/v1/discovery/plugins/noop-acquire/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-access-token': userToken },
      body: JSON.stringify({ key: 'token', value: 'lb-secret-token' }),
    });
    assert.equal(put.status, 200);
    const r = await api(adminToken, 'GET', STATUS);
    assert.equal(pluginOf(r.body, 'noop-acquire').connectedUsers, 1);
    assert.ok(!JSON.stringify(r.body).includes('lb-secret-token'));
  });

  test('settings: saved through the switch route, checked by the config schema, applied live, never the switch itself', async () => {
    const saved = await api(adminToken, 'POST', PLUGINS, { name: 'youtube', settings: { codec: 'opus', maxFilesizeMb: 250 } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const y = pluginOf(saved.body, 'youtube');
    assert.deepEqual(y.config, { binary: 'yt-dlp', codec: 'opus', maxFilesizeMb: 250, searchResults: 8 });
    assert.equal(y.enabled, true, 'settings do not touch the switch');
    const onDisk = JSON.parse(fs.readFileSync(path.join(server.tmpDir, 'config.json'), 'utf8'));
    assert.deepEqual([onDisk.discoveryPlugins.youtube.codec, onDisk.discoveryPlugins.youtube.maxFilesizeMb], ['opus', 250], 'persisted');

    const badValue = await api(adminToken, 'POST', PLUGINS, { name: 'youtube', settings: { maxFilesizeMb: 0 } });
    assert.equal(badValue.status, 400);
    assert.match(badValue.body.error, /^maxFilesizeMb: /, 'the refusal leads with the field');
    const badCodec = await api(adminToken, 'POST', PLUGINS, { name: 'youtube', settings: { codec: 'mp5' } });
    assert.match(badCodec.body.error, /^codec: /);
    assert.equal((await api(adminToken, 'POST', PLUGINS, { name: 'youtube', settings: { enabled: false } })).status, 400, '`enabled` is not a setting');
    assert.equal((await api(adminToken, 'POST', PLUGINS, { name: 'youtube', settings: { nope: 1 } })).status, 400);
    assert.equal((await api(adminToken, 'POST', PLUGINS, { name: 'links', settings: { anything: 1 } })).status, 400, 'a plug-in without settings');
    assert.equal((await api(adminToken, 'POST', PLUGINS, { name: 'youtube' })).status, 400, 'enabled or settings is required');
    assert.deepEqual(pluginOf((await api(adminToken, 'GET', STATUS)).body, 'youtube').config.codec, 'opus', 'a refused save changed nothing');

    // Both at once, and the iTunes storefront.
    const both = await api(adminToken, 'POST', PLUGINS, { name: 'itunes', enabled: false, settings: { country: 'GB' } });
    assert.equal(both.status, 200, JSON.stringify(both.body));
    assert.deepEqual([pluginOf(both.body, 'itunes').enabled, pluginOf(both.body, 'itunes').config.country], [false, 'GB']);
    await api(adminToken, 'POST', PLUGINS, { name: 'youtube', settings: { codec: 'mp3', maxFilesizeMb: 100 } });
  });

  test('probe: Test is a dry run that saves nothing; check again replaces the cached answer', async () => {
    // (This suite's MSTREAM_YTDLP_BIN hook outranks the configured binary, so
    // a dry run still finds the stand-in; the suite below has no hook.)
    const dry = await api(adminToken, 'POST', PROBE, { name: 'youtube', settings: { binary: path.join(workDir, 'no-such-yt-dlp'), codec: 'flac' } });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.equal(dry.body.dryRun, true);
    const after = await api(adminToken, 'GET', STATUS);
    assert.deepEqual(pluginOf(after.body, 'youtube').config, { binary: 'yt-dlp', codec: 'mp3', maxFilesizeMb: 100, searchResults: 8 }, 'nothing was saved');

    const again = await api(adminToken, 'POST', PROBE, { name: 'youtube' });
    assert.deepEqual([again.body.available, again.body.reason, again.body.dryRun], [true, null, false]);
    assert.deepEqual(again.body.detail, { ytdlp: '2026.02.04', ffmpeg: true });

    // A plug-in without a probe is simply available; unknown names and bad settings are refused.
    assert.deepEqual((await api(adminToken, 'POST', PROBE, { name: 'links' })).body.available, true);
    assert.equal((await api(adminToken, 'POST', PROBE, { name: 'no-such' })).status, 400);
    assert.equal((await api(adminToken, 'POST', PROBE, { name: 'youtube', settings: { codec: 'mp5' } })).status, 400);
    assert.equal((await api(userToken, 'POST', PROBE, { name: 'youtube' })).status, 403);
  });

  test('a user\'s download lands in their collection destination; the jobs clock is the one setting left on the jobs route', async () => {
    const started = await api(userToken, 'POST', '/api/v1/discovery/plugins/youtube/jobs', { recommendation: REC });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const job = await untilFinished(userToken, started.body.job.id);
    assert.equal(job.state, 'done', job.error || '');
    assert.equal(job.result.downloaded.filepath, 'collection/Nova/Night Ferry/Remote_Hit.mp3');
    assert.ok(fs.existsSync(path.join(collectionDir, 'Nova', 'Night Ferry', 'Remote_Hit.mp3')));
    assert.deepEqual(fs.readdirSync(path.join(workDir, 'staging')), [], 'nothing is left in staging');

    const set = await api(adminToken, 'POST', JOBS_CFG, { retentionDays: 14 });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.discoveryJobs.retentionDays, 14);
    assert.equal((await api(adminToken, 'GET', STATUS)).body.jobs.retentionDays, 14);
    assert.equal((await api(adminToken, 'POST', JOBS_CFG, { retentionDays: 0 })).status, 400);
    assert.equal((await api(adminToken, 'POST', JOBS_CFG, { downloadsMaxSizeMb: 1 })).status, 400, 'the scratch cap is gone');
    assert.equal((await api(adminToken, 'POST', JOBS_CFG, { downloadsRetentionDays: 1 })).status, 400, 'and so is its clock');
    await api(adminToken, 'POST', JOBS_CFG, { retentionDays: 30 });

    // Sweep now: nothing is old enough.
    const sweep = await api(adminToken, 'POST', '/api/v1/admin/discovery-jobs/sweep');
    assert.equal(sweep.status, 200, JSON.stringify(sweep.body));
    assert.deepEqual(sweep.body, { prunedJobs: 0, removedStaging: 0 });
  });

  test('the users listing carries the whitelist flag; the all-accounts jobs list names each owner', async () => {
    const before = await api(adminToken, 'GET', '/api/v1/admin/users');
    assert.equal(before.body.dana.allowDiscoveryJobs, false);
    assert.equal((await api(adminToken, 'POST', '/api/v1/admin/users/discovery-jobs-access', { username: 'dana', allowDiscoveryJobs: true })).status, 200);
    assert.equal((await api(adminToken, 'GET', '/api/v1/admin/users')).body.dana.allowDiscoveryJobs, true);

    const all = await api(adminToken, 'GET', '/api/v1/discovery/plugin-jobs?all=1');
    assert.ok(all.body.jobs.length >= 1);
    assert.ok(all.body.jobs.every((j) => j.username === 'dana'), 'every job so far is dana\'s');
    const own = await api(userToken, 'GET', '/api/v1/discovery/plugin-jobs');
    assert.ok(own.body.jobs.every((j) => j.username === undefined), 'a user\'s own list has no names to add');
    const header = (await api(adminToken, 'GET', STATUS)).body.jobs;
    assert.deepEqual([header.running, header.queued], [0, 0]);
  });
});

// No yt-dlp hook here: the configured binary decides, which is how a real
// server runs. Public mode (no users) — the admin API needs no token.
describe('discovery plug-ins · admin API · the configured binary', () => {
  let plain;
  let dir;
  const open = (method, route, body) => fetch(`${plain.baseUrl}${route}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-dpadmin2-'));
    plain = await startServer({
      dlnaMode: 'disabled', waitForScan: false,
      env: { MSTREAM_TEST_DISCOVERY_NOOP_PLUGIN: '1' },
      extraConfig: {
        discoveryPlugins: { youtube: { enabled: true, binary: path.join(dir, 'no-such-yt-dlp') }, 'noop-acquire': { enabled: true } },
        discoveryJobs: { stagingDir: path.join(dir, 'staging') },
      },
    });
  });
  after(async () => {
    if (plain) { await plain.stop(); }
    if (dir) { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a binary that is not there: the admin row says why, users have no row, a job is a 404', async () => {
    const r = await open('GET', STATUS);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const y = pluginOf(r.body, 'youtube');
    assert.deepEqual([y.enabled, y.available], [true, false]);
    assert.match(y.reason, /yt-dlp not found/);
    const listed = await open('GET', '/api/v1/discovery/plugins');
    assert.ok(!listed.body.plugins.some((p) => p.name === 'youtube'), 'never shown to users');
    assert.equal((await open('POST', '/api/v1/discovery/plugins/youtube/jobs', { recommendation: REC })).status, 404);
  });

  test('Test tries unsaved values: a missing path, and a file that exists but cannot be run', async () => {
    const missing = await open('POST', PROBE, { name: 'youtube', settings: { binary: path.join(dir, 'still-not-here') } });
    assert.deepEqual([missing.body.available, missing.body.dryRun], [false, true]);
    assert.match(missing.body.reason, /yt-dlp not found \(.*still-not-here\)/);

    // The stand-in script EXISTS, but without the env hook nothing runs it
    // under node — the case that used to pass the probe and then fail every
    // job with "spawn EFTYPE".
    const notRunnable = await open('POST', PROBE, { name: 'youtube', settings: { binary: FAKE } });
    assert.equal(notRunnable.body.available, false, JSON.stringify(notRunnable.body));
    assert.match(notRunnable.body.reason, /^yt-dlp \(.*fake-yt-dlp\.mjs\) /);
    assert.doesNotMatch(notRunnable.body.reason, /not found/, 'it exists; the reason says it cannot be run');

    // A file named like a program that is not one: a sentence on every
    // platform (Windows answers this with the bare code UNKNOWN).
    const impostor = path.join(dir, 'yt-dlp-impostor.exe');
    fs.writeFileSync(impostor, 'not a program', { mode: 0o644 });
    const notAProgram = await open('POST', PROBE, { name: 'youtube', settings: { binary: impostor } });
    assert.equal(notAProgram.body.available, false, JSON.stringify(notAProgram.body));
    assert.match(notAProgram.body.reason, /impostor\.exe\) is not something this system can run \(\w+\)$/);

    // Neither try was saved.
    assert.match(pluginOf((await open('GET', STATUS)).body, 'youtube').config.binary, /no-such-yt-dlp$/);
  });

  test('a server with no users: the jobs list names nobody, never the shared account\'s internal name', async () => {
    const started = await open('POST', '/api/v1/discovery/plugins/noop-acquire/jobs', { recommendation: { artist: 'Nova', title: 'Anyone' } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const all = await open('GET', '/api/v1/discovery/plugin-jobs?all=1');
    assert.ok(all.body.jobs.length >= 1);
    assert.ok(all.body.jobs.every((j) => j.username === null), JSON.stringify(all.body.jobs.map((j) => j.username)));
  });

  test('saving a new binary re-probes at once: the row redraws from the answer', async () => {
    const saved = await open('POST', PLUGINS, { name: 'youtube', settings: { binary: path.join(dir, 'another-missing-one') } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const y = pluginOf(saved.body, 'youtube');
    assert.match(y.config.binary, /another-missing-one$/);
    assert.equal(y.available, false);
    assert.match(y.reason, /another-missing-one/, 'the reason is about the NEW path, not the cached old one');
  });
});

