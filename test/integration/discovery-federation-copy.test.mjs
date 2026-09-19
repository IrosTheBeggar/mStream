/**
 * "Add to your collection" end to end over real iroh: the federation-copy
 * plug-in (src/discovery-plugins/plugins/federation-copy.js), the caller's
 * collection destination (src/discovery-plugins/destination.js) through its
 * own routes, and the job that copies a paired peer's file into this library.
 *
 *   Server A (the peer): federation ON, one 'shared' library of three
 *                        ffmpeg-made, tagged mp3s.
 *   Server B (the copier): federation ON, the default fixture library
 *                          'testlib' plus an empty, per-run 'collection'
 *                          library that every copy is pointed at — the
 *                          fixture library is the repo's shared folder and
 *                          must never receive a file. Pairs with A as
 *                          'copier'. Public mode, so the settings belong to
 *                          the shared anonymous account and admin routes
 *                          need no token.
 *
 * Proves: the default destination and its rules, the destination round
 * trip and its refusals, a copy landing at base + rendered layout + the
 * peer's file name with a playable row (source = federation-copy), the
 * owned skip, the never-overwrite skip, the p2p refusal, and the uploads-off
 * refusal. Skips when @number0/iroh has no prebuilt binary here.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../helpers/server.mjs';

let available = true;
try { await import('@number0/iroh'); } catch { available = false; }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FFMPEG = process.platform === 'win32'
  ? path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg.exe')
  : path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg');

const PLUGIN = 'federation-copy';
const DEST = '/api/v1/discovery/collection/destination';
const JOBS = `/api/v1/discovery/plugins/${PLUGIN}/jobs`;

// [file, title, artist, album, year]
const REMOTE = [
  ['Remote_Hit.mp3', 'Remote Hit', 'Nova', 'Night Ferry', '2019'],
  ['Second_Song.mp3', 'Second Song', 'Nova', 'Night Ferry', '2019'],
  ['Third_Song.mp3', 'Third Song', 'Vosto', 'Solo', ''],
];

let srvA, srvB, sharedDir, collectionDir, peerId;

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${stderr.slice(-200)}`)));
  });
}

async function api(srv, method, route, body) {
  const r = await fetch(`${srv.baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

const rec = (file, over = {}) => {
  const row = REMOTE.find((r) => r[0] === file);
  return { source: 'federation', filepath: `shared/${file}`, peer: { id: peerId, name: 'copier' }, title: row[1], artist: row[2], album: row[3], ...over };
};

async function untilFinished(id, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await api(srvB, 'GET', `/api/v1/discovery/plugin-jobs/${id}`);
    const job = body && body.job;
    if (job && ['done', 'failed', 'cancelled'].includes(job.state)) { return job; }
    if (Date.now() > deadline) { throw new Error(`job ${id} never finished (last: ${job && job.state} · ${job && job.statusText})`); }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function bRow(sql, ...args) {
  const mdb = new DatabaseSync(path.join(srvB.tmpDir, 'db', 'mstream.db'), { readOnly: true });
  try { return mdb.prepare(sql).get(...args); } finally { mdb.close(); }
}

describe('discovery federation-copy (B copies from A over iroh)', { skip: available ? false : 'no @number0/iroh binary for this platform' }, () => {
  before(async () => {
    sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-fedcopy-'));
    let freq = 400;
    for (const [file, title, artist, album, year] of REMOTE) {
      const meta = ['-metadata', `artist=${artist}`, '-metadata', `title=${title}`, '-metadata', `album=${album}`];
      if (year) { meta.push('-metadata', `date=${year}`); }
      await runFfmpeg([
        '-nostdin', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `sine=frequency=${freq += 55}:duration=2`,
        ...meta, '-ac', '1', path.join(sharedDir, file),
      ]);
    }

    collectionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-fedcopy-dest-'));
    [srvA, srvB] = await Promise.all([
      startServer({ dlnaMode: 'disabled', extraFolders: { shared: sharedDir }, extraConfig: { federation: { enabled: true } } }),
      startServer({ dlnaMode: 'disabled', extraFolders: { collection: collectionDir }, extraConfig: { federation: { enabled: true } } }),
    ]);

    const mint = await api(srvA, 'POST', '/api/v1/admin/federation/keys', { name: 'copier', vpaths: ['shared'] });
    assert.equal(mint.status, 200);
    assert.ok(mint.body.ticket, 'A must issue a ticket (endpoint up)');
    const added = await api(srvB, 'POST', '/api/v1/admin/federation/peers', { ticket: mint.body.ticket, name: 'copier' });
    assert.equal(added.status, 200);
    peerId = added.body.id;

    // Readiness: the iroh endpoint boots asynchronously; wait until A
    // answers a proxied metadata read (the copy's own first call) so the
    // tests below probe a reachable peer, not the dial.
    const ready = Date.now() + 60_000;
    for (;;) {
      const r = await api(srvB, 'POST', `/api/v1/federation/peers/${peerId}/api/api/v1/db/metadata`, { filepath: 'shared/Remote_Hit.mp3' });
      if (r.status === 200 && r.body && r.body.metadata && r.body.metadata.hash) { break; }
      if (Date.now() > ready) { throw new Error(`peer never became reachable (last ${r.status})`); }
      await new Promise((res) => setTimeout(res, 500));
    }
  });

  after(async () => {
    await Promise.all([srvA && srvA.stop(), srvB && srvB.stop()]);
    for (const dir of [sharedDir, collectionDir]) {
      if (dir) { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  });

  test('the plug-in is listed as an acquire plug-in; the destination is not its setting', async () => {
    const r = await api(srvB, 'GET', '/api/v1/discovery/plugins');
    assert.equal(r.status, 200);
    const p = r.body.plugins.find((x) => x.name === PLUGIN);
    assert.ok(p, 'federation-copy is on by default');
    assert.deepEqual(p.capabilities, ['acquire']);
    assert.deepEqual(p.settings, []);
    assert.equal((await api(srvB, 'GET', `/api/v1/discovery/plugins/${PLUGIN}/settings`)).status, 400, 'no plug-in settings of its own');
  });

  test('the default destination: the first library, {{ARTIST}}/{{ALBUM}} at its root', async () => {
    const r = await api(srvB, 'GET', DEST);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.saved, null);
    assert.deepEqual([...r.body.libraries].sort((a, b) => a.vpath.localeCompare(b.vpath)),
      [{ vpath: 'collection', template: null }, { vpath: 'testlib', template: null }]);
    assert.deepEqual(r.body.destination, { vpath: r.body.libraries[0].vpath, base: '', layout: '{{ARTIST}}/{{ALBUM}}', source: 'default' });
    assert.equal(r.body.defaultLayout, '{{ARTIST}}/{{ALBUM}}');
    assert.ok(r.body.variables.includes('PEER'));
  });

  test('storing a destination: refusals, the round trip, and the reset', async () => {
    const put = (value) => api(srvB, 'PUT', DEST, { destination: value });
    assert.equal((await put({ vpath: 'nope', base: '', layout: '{{ARTIST}}' })).status, 400, 'a library the caller cannot write to');
    assert.equal((await put({ vpath: 'collection', base: '', layout: '{{TRACK}}' })).status, 400, 'an unknown variable');
    assert.equal((await put({ vpath: 'collection', base: '../up', layout: '{{ARTIST}}' })).status, 400, 'a base folder that climbs out');
    assert.equal((await put({ vpath: 'collection' })).status, 400, 'the schema: layout is required');
    assert.equal((await api(srvB, 'PUT', DEST, {})).status, 400, 'a destination (or null) is required');

    const ok = await put({ vpath: 'collection', base: 'From peers/', layout: '{{PEER}}/{{ARTIST}}/{{ALBUM}}' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.destination, { vpath: 'collection', base: 'From peers', layout: '{{PEER}}/{{ARTIST}}/{{ALBUM}}', source: 'user' });
    assert.deepEqual(ok.body.saved, { vpath: 'collection', base: 'From peers/', layout: '{{PEER}}/{{ARTIST}}/{{ALBUM}}' });
    const again = await api(srvB, 'GET', DEST);
    assert.equal(again.body.destination.source, 'user');

    const reset = await put(null);
    assert.equal(reset.status, 200);
    assert.equal(reset.body.destination.source, 'default');
    assert.equal(reset.body.saved, null);

    // The custom destination for the copies below — always the per-run
    // 'collection' library, never the shared fixture folder.
    assert.equal((await put({ vpath: 'collection', base: 'From peers', layout: '{{PEER}}/{{ARTIST}}/{{ALBUM}}' })).status, 200);
  });

  test('a copy lands at base + layout + the peer\'s file name, with a playable row', async () => {
    const started = await api(srvB, 'POST', JOBS, { recommendation: rec('Remote_Hit.mp3') });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const job = await untilFinished(started.body.job.id);
    assert.equal(job.state, 'done', `job error: ${job.error}`);
    const { result } = job;
    assert.equal(result.skipped, undefined, JSON.stringify(result));
    assert.equal(result.copied.filepath, 'collection/From peers/copier/Nova/Night Ferry/Remote_Hit.mp3');
    assert.equal(result.copied.vpath, 'collection');
    assert.ok(result.copied.trackId > 0);
    assert.ok(result.copied.bytes > 1000);
    assert.equal(result.copied.title, 'Remote Hit');
    assert.equal(result.copied.artist, 'Nova');
    assert.equal(result.copied.album, 'Night Ferry');
    assert.deepEqual(result.missingVars, []);
    assert.deepEqual(result.peer, { id: peerId, name: 'copier' });
    assert.equal(result.destination.source, 'user');

    const onDisk = path.join(collectionDir, 'From peers', 'copier', 'Nova', 'Night Ferry', 'Remote_Hit.mp3');
    assert.ok(fs.existsSync(onDisk), `file must exist at ${onDisk}`);
    assert.equal(fs.statSync(onDisk).size, fs.statSync(path.join(sharedDir, 'Remote_Hit.mp3')).size, 'byte for byte');
    assert.ok(!fs.readdirSync(path.join(collectionDir, 'From peers')).some((f) => f.endsWith('.part')), 'no .part left behind');

    const row = bRow('SELECT source, title, file_hash, hash_v FROM tracks WHERE filepath = ?', 'From peers/copier/Nova/Night Ferry/Remote_Hit.mp3');
    assert.ok(row, 'a tracks row exists at the forward-slash path');
    assert.equal(row.source, PLUGIN);
    assert.equal(row.title, 'Remote Hit');
    assert.ok(row.file_hash);

    const meta = await api(srvB, 'POST', '/api/v1/db/metadata', { filepath: result.copied.filepath });
    assert.equal(meta.status, 200);
    assert.equal(meta.body.metadata.title, 'Remote Hit');
    assert.equal(meta.body.metadata.album, 'Night Ferry');
  });

  test('the same song again is skipped as owned — by hash, before any byte moves', async () => {
    const started = await api(srvB, 'POST', JOBS, { recommendation: rec('Remote_Hit.mp3') });
    assert.equal(started.status, 202, 'the earlier job is finished, so this is a new one');
    const job = await untilFinished(started.body.job.id);
    assert.equal(job.state, 'done', `job error: ${job.error}`);
    assert.equal(job.result.skipped, 'owned');
    assert.equal(job.result.existing.by, 'hash');
    assert.equal(job.result.existing.filepath, 'collection/From peers/copier/Nova/Night Ferry/Remote_Hit.mp3');
    // Owned by tags too: a different peer path, the same artist + album + title.
    const byTags = await api(srvB, 'POST', JOBS, { recommendation: rec('Remote_Hit.mp3', { filepath: 'shared/does-not-matter.mp3' }) });
    const job2 = await untilFinished(byTags.body.job.id);
    assert.equal(job2.state, 'done', `job error: ${job2.error}`);
    assert.equal(job2.result.skipped, 'owned');
    assert.equal(job2.result.existing.by, 'tags');
  });

  test('a file already at the target path is never overwritten', async () => {
    const target = path.join(collectionDir, 'From peers', 'copier', 'Nova', 'Night Ferry', 'Second_Song.mp3');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'not audio');
    const started = await api(srvB, 'POST', JOBS, { recommendation: rec('Second_Song.mp3') });
    const job = await untilFinished(started.body.job.id);
    assert.equal(job.state, 'done', `job error: ${job.error}`);
    assert.equal(job.result.skipped, 'exists', JSON.stringify(job.result));
    assert.equal(job.result.filepath, 'collection/From peers/copier/Nova/Night Ferry/Second_Song.mp3');
    assert.equal(fs.readFileSync(target, 'utf8'), 'not audio', 'untouched');
    assert.equal(bRow('SELECT id FROM tracks WHERE filepath = ?', 'From peers/copier/Nova/Night Ferry/Second_Song.mp3'), undefined, 'no row for the placeholder');
  });

  test('a network (p2p) recommendation cannot be copied', async () => {
    const started = await api(srvB, 'POST', JOBS, { recommendation: { source: 'p2p', artist: 'Nova', title: 'Elsewhere' } });
    assert.equal(started.status, 202);
    const job = await untilFinished(started.body.job.id);
    assert.equal(job.state, 'failed');
    assert.match(job.error, /paired peer/);
  });

  test('uploads off for the account: no destination, and a copy refuses', async () => {
    assert.equal((await api(srvB, 'POST', '/api/v1/admin/config/noupload', { noUpload: true })).status, 200);
    try {
      const view = await api(srvB, 'GET', DEST);
      assert.equal(view.status, 200);
      assert.equal(view.body.destination, null);
      assert.deepEqual(view.body.libraries, []);
      const started = await api(srvB, 'POST', JOBS, { recommendation: rec('Third_Song.mp3') });
      assert.equal(started.status, 202);
      const job = await untilFinished(started.body.job.id);
      assert.equal(job.state, 'failed');
      assert.match(job.error, /uploads are disabled/);
    } finally {
      assert.equal((await api(srvB, 'POST', '/api/v1/admin/config/noupload', { noUpload: false })).status, 200);
    }
  });

  test('a copy at the library root with an empty tag reports the dropped variable', async () => {
    assert.equal((await api(srvB, 'PUT', DEST, { destination: { vpath: 'collection', base: '', layout: '{{ARTIST}}/{{ALBUM}} ({{YEAR}})' } })).status, 200);
    const started = await api(srvB, 'POST', JOBS, { recommendation: rec('Third_Song.mp3') });
    const job = await untilFinished(started.body.job.id);
    assert.equal(job.state, 'done', `job error: ${job.error}`);
    assert.equal(job.result.copied.filepath, 'collection/Vosto/Solo ()/Third_Song.mp3', JSON.stringify(job.result));
    assert.deepEqual(job.result.missingVars, ['YEAR']);
    assert.ok(fs.existsSync(path.join(collectionDir, 'Vosto', 'Solo ()', 'Third_Song.mp3')));
  });

  test('the shared fixture library never received a file', () => {
    // 'Vosto' is a real fixture artist; only the folders a stray copy would
    // create are checked.
    const fixtureRoot = bRow("SELECT root_path FROM libraries WHERE name = 'testlib'").root_path;
    assert.ok(!fs.existsSync(path.join(fixtureRoot, 'From peers')), 'no "From peers" in the fixture library');
    assert.ok(!fs.existsSync(path.join(fixtureRoot, 'Vosto', 'Solo ()')), 'no "Solo ()" album in the fixture library');
  });
});
