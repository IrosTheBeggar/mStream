/**
 * The record of what the plug-ins brought into the library, and removing
 * one (src/api/discovery-downloads.js, src/db/plugin-downloads.js, V75):
 *
 *   GET    /api/v1/discovery/downloads        own / ?all=1 / ?removed=1
 *   DELETE /api/v1/discovery/downloads/:id    the requester or an admin
 *
 * Three accounts: an admin, dana who downloads, and eli who may see the
 * same library but never remove what is not his. The youtube plug-in runs
 * against the scripted yt-dlp (test/helpers/fake-yt-dlp.mjs); the Youtube DL
 * route records through the same table. A rescan in the middle proves the
 * record does not depend on the track row. Needs the bundled ffmpeg (the
 * tag pass); skipped without it.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FFMPEG = process.platform === 'win32'
  ? path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg.exe')
  : path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg');
const FAKE = path.join(REPO_ROOT, 'test', 'helpers', 'fake-yt-dlp.mjs');
const hasFfmpeg = fs.existsSync(FFMPEG);

const ADMIN = { username: 'admin', password: 'pw-admin' };
const DANA = { username: 'dana', password: 'pw-dana' };
const ELI = { username: 'eli', password: 'pw-eli' };
const FINN = { username: 'finn', password: 'pw-finn' };
const LIST = '/api/v1/discovery/downloads';
const JOBS = '/api/v1/discovery/plugins/youtube/jobs';
const REC = { source: 'p2p', artist: 'Nova', title: 'Remote Hit', album: 'Night Ferry', year: 2019, duration: 2 };
const yt = (id) => `https://www.youtube.com/watch?v=${id}`;
const SEARCH = {
  'remote hit': [{ id: 'topic', url: yt('topic'), title: 'Remote Hit', duration: 2, channel: 'Nova - Topic', uploader: 'Nova - Topic', artist: 'Nova', album: 'Night Ferry', webpage_url: yt('topic') }],
};
const SONG = 'collection/Nova/Night Ferry/Remote_Hit.mp3';

let server, workDir, collectionDir, inboxDir, adminToken, danaToken, eliToken, finnToken;

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
async function untilFinished(token, id, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await api(token, 'GET', `/api/v1/discovery/plugin-jobs/${id}`);
    if (body && body.job && ['done', 'failed', 'cancelled'].includes(body.job.state)) { return body.job; }
    if (Date.now() > deadline) { throw new Error(`job ${id} never finished`); }
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function download(token, recommendation) {
  const started = await api(token, 'POST', JOBS, { recommendation });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const job = await untilFinished(token, started.body.job.id);
  assert.equal(job.state, 'done', job.error || JSON.stringify(job.result));
  return job;
}
const listOf = async (token, query = '') => (await api(token, 'GET', `${LIST}${query}`)).body.downloads;
function row(sql, ...args) {
  const mdb = new DatabaseSync(path.join(server.tmpDir, 'db', 'mstream.db'), { readOnly: true });
  try { return mdb.prepare(sql).get(...args); } finally { mdb.close(); }
}
// A full rescan: trigger it, watch it start (or accept that a tiny library
// finished between two looks), then wait for the queue to go idle.
async function rescan() {
  assert.equal((await api(adminToken, 'POST', '/api/v1/admin/db/scan/all')).status, 200);
  const pending = (q) => !!q && (q.scanning || q.activeTask === 'scan' || (q.queued || []).includes('scan'));
  const queue = async () => (await api(adminToken, 'GET', '/api/v1/scan/status')).body.queue;
  const startDeadline = Date.now() + 3000;
  while (!pending(await queue()) && Date.now() < startDeadline) { await new Promise((r) => setTimeout(r, 50)); }
  const deadline = Date.now() + 60_000;
  while (pending(await queue())) {
    if (Date.now() > deadline) { throw new Error('the rescan never finished'); }
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('discovery downloads · the record and its removal', { skip: hasFfmpeg ? false : 'bundled ffmpeg missing (bin/ffmpeg)' }, () => {
  before(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-dldl-'));
    collectionDir = path.join(workDir, 'collection');
    inboxDir = path.join(workDir, 'inbox');
    fs.mkdirSync(collectionDir, { recursive: true });
    fs.mkdirSync(inboxDir, { recursive: true });
    const fixturePath = path.join(workDir, 'fixture.mp3');
    const scriptPath = path.join(workDir, 'fake-yt-dlp.json');
    await runFfmpeg(['-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ac', '1', fixturePath]);
    fs.writeFileSync(scriptPath, JSON.stringify({ search: SEARCH, details: {}, download: {} }));
    server = await startServer({
      dlnaMode: 'disabled', waitForScan: false,
      extraFolders: { collection: collectionDir, inbox: inboxDir },
      env: { MSTREAM_YTDLP_BIN: FAKE, MSTREAM_FAKE_YTDLP_SCRIPT: scriptPath, MSTREAM_FAKE_YTDLP_FIXTURE: fixturePath },
      extraConfig: {
        discoveryPlugins: { youtube: { enabled: true } },
        discoveryJobs: { stagingDir: path.join(workDir, 'staging') },
      },
      // dana's only library is the per-run collection, so it is her default
      // destination; eli sees it too but never downloaded anything.
      users: [
        { ...ADMIN, admin: true, vpaths: ['testlib', 'collection', 'inbox'] },
        { ...DANA, vpaths: ['collection'] },
        { ...ELI, vpaths: ['collection'] },
        // finn sees the collection but may not upload — and so may not remove.
        { ...FINN, vpaths: ['collection'], allowUpload: false },
      ],
    });
    adminToken = await login(ADMIN);
    danaToken = await login(DANA);
    eliToken = await login(ELI);
    finnToken = await login(FINN);
  });
  after(async () => {
    if (server) { await server.stop(); }
    if (workDir) { fs.rmSync(workDir, { recursive: true, force: true }); }
  });

  let danaJob;
  let danaId;
  let adminId;

  test('a download is recorded: who, which plug-in, from where, filed where, and that the track is there', async () => {
    danaJob = await download(danaToken, REC);
    assert.equal(danaJob.result.downloaded.filepath, SONG);
    assert.ok(danaJob.result.downloaded.downloadId > 0, 'the job result names its record');

    const mine = await listOf(danaToken);
    assert.equal(mine.length, 1, JSON.stringify(mine));
    const d = mine[0];
    danaId = d.id;
    assert.equal(d.id, danaJob.result.downloaded.downloadId);
    assert.equal(d.plugin, 'youtube');
    assert.equal(d.jobId, danaJob.id);
    assert.equal(d.filepath, SONG);
    assert.deepEqual([d.vpath, d.relativePath], ['collection', 'Nova/Night Ferry/Remote_Hit.mp3']);
    assert.equal(d.origin, yt('topic'));
    assert.deepEqual([d.title, d.artist, d.album], ['Remote Hit', 'Nova', 'Night Ferry']);
    assert.equal(d.bytes, danaJob.result.downloaded.bytes);
    assert.ok(d.fileHash, 'the file hash rides along');
    assert.equal(d.present, true);
    assert.equal(d.trackId, danaJob.result.downloaded.trackId);
    assert.ok(d.downloadedAt > Date.now() - 60_000);
    assert.equal(d.removedAt, null);
    assert.equal(d.username, undefined, 'a user\'s own list carries no names');
  });

  test('visibility: one\'s own; everyone\'s for an admin with ?all=1, named; nothing for an account that never downloaded', async () => {
    assert.deepEqual(await listOf(eliToken), []);
    assert.deepEqual(await listOf(adminToken), [], 'the admin\'s OWN list is empty');
    const all = await listOf(adminToken, '?all=1');
    assert.equal(all.length, 1);
    assert.equal(all[0].username, 'dana');
    assert.equal(all[0].id, danaId);
    const notAdmin = await listOf(danaToken, '?all=1');
    assert.equal(notAdmin.length, 1, '?all=1 is only an admin\'s');
    assert.equal(notAdmin[0].username, undefined);
  });

  test('the Youtube DL route records through the same table, under the account that pasted the URL', async () => {
    const started = await api(adminToken, 'POST', '/api/v1/ytdl/', {
      directory: 'inbox', url: yt('topic'), outputCodec: 'mp3', metadata: { artist: 'Nova', title: 'Remote Hit', album: 'Night Ferry' },
    });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const deadline = Date.now() + 20_000;
    let status;
    for (;;) {
      status = ((await api(adminToken, 'GET', '/api/v1/ytdl/downloads')).body.downloads[0] || {}).status;
      if (status === 'complete' || status === 'error' || Date.now() > deadline) { break; }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(status, 'complete');
    // The record lands right after the row; give it a beat.
    let admins = [];
    for (let i = 0; i < 20 && admins.length === 0; i++) {
      admins = await listOf(adminToken);
      if (admins.length === 0) { await new Promise((r) => setTimeout(r, 100)); }
    }
    assert.equal(admins.length, 1, JSON.stringify(admins));
    adminId = admins[0].id;
    assert.equal(admins[0].plugin, 'ytdl');
    assert.equal(admins[0].jobId, null);
    assert.equal(admins[0].filepath, 'inbox/Remote_Hit.mp3');
    assert.equal(admins[0].origin, yt('topic'));
    assert.equal(admins[0].present, true);
    const all = await listOf(adminToken, '?all=1');
    assert.deepEqual(all.map((d) => [d.id, d.username]), [[adminId, 'admin'], [danaId, 'dana']], 'newest first, across accounts');
  });

  test('a rescan rewrites the track rows and leaves the records untouched', async () => {
    await rescan();
    const all = await listOf(adminToken, '?all=1');
    assert.deepEqual(all.map((d) => [d.id, d.present]), [[adminId, true], [danaId, true]]);
    assert.equal(row('SELECT source FROM tracks WHERE filepath = ?', 'Nova/Night Ferry/Remote_Hit.mp3').source, 'plugin:youtube');
    assert.equal(row('SELECT source FROM tracks WHERE filepath = ?', 'Remote_Hit.mp3').source, 'ytdl');
  });

  test('removing: not another account\'s; the requester takes the file, the row and the playlist entry with it; once', async () => {
    assert.equal((await api(eliToken, 'DELETE', `${LIST}/${danaId}`)).status, 404, 'eli sees the library, not the download');
    assert.equal((await api(danaToken, 'DELETE', `${LIST}/${adminId}`)).status, 404, 'nor dana the admin\'s');
    assert.equal((await api(danaToken, 'DELETE', `${LIST}/999999`)).status, 404);
    assert.equal((await api(danaToken, 'DELETE', `${LIST}/abc`)).status, 404);
    assert.equal((await api(danaToken, 'POST', '/api/v1/playlist/save', { title: 'finds', songs: [SONG] })).status, 200);

    const removed = await api(danaToken, 'DELETE', `${LIST}/${danaId}`);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual([removed.body.fileRemoved, removed.body.rowsRemoved, removed.body.playlistEntries], [true, 1, 1]);
    assert.ok(removed.body.download.removedAt > 0);
    assert.ok(removed.body.download.removedBy > 0, 'by dana');
    assert.equal(removed.body.download.present, false);
    assert.ok(!fs.existsSync(path.join(collectionDir, 'Nova', 'Night Ferry', 'Remote_Hit.mp3')), 'the file is gone');
    assert.equal(row('SELECT id FROM tracks WHERE filepath = ?', 'Nova/Night Ferry/Remote_Hit.mp3'), undefined, 'and its row');
    assert.deepEqual((await api(danaToken, 'POST', '/api/v1/playlist/load', { playlistname: 'finds' })).body, [], 'and the playlist entry');

    assert.deepEqual(await listOf(danaToken), [], 'history is hidden');
    const history = await listOf(danaToken, '?removed=1');
    assert.deepEqual(history.map((d) => [d.id, d.present, d.removedAt > 0]), [[danaId, false, true]]);
    assert.equal((await api(danaToken, 'DELETE', `${LIST}/${danaId}`)).status, 409, 'already removed');
  });

  test('a file that is already gone still settles the record', async () => {
    fs.rmSync(path.join(inboxDir, 'Remote_Hit.mp3'));
    const removed = await api(adminToken, 'DELETE', `${LIST}/${adminId}`);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual([removed.body.fileRemoved, removed.body.rowsRemoved], [false, 1]);
    assert.deepEqual(await listOf(adminToken, '?all=1'), []);
  });

  test('the Youtube DL route never adopts a file that is already in the folder', async () => {
    // yt-dlp under --no-overwrites skips the fetch when "<title>.mp3" exists
    // and prints that path; the route used to re-tag it, re-insert it and
    // record it as the caller's — then Remove would delete somebody else's
    // file. Now the download runs in staging and lands only where nothing is.
    const existing = path.join(inboxDir, 'Remote_Hit.mp3');
    fs.writeFileSync(existing, 'somebody else\'s file, not a download');
    const before = fs.readFileSync(existing);
    const started = await api(adminToken, 'POST', '/api/v1/ytdl/', {
      directory: 'inbox', url: yt('topic'), outputCodec: 'mp3', metadata: { artist: 'Nova', title: 'Remote Hit' },
    });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const deadline = Date.now() + 20_000;
    let status;
    for (;;) {
      // The newest entry is this download's (an earlier one lingers a while).
      const entries = (await api(adminToken, 'GET', '/api/v1/ytdl/downloads')).body.downloads;
      const mine = entries.reduce((a, b) => (!a || b.startTime > a.startTime ? b : a), null) || {};
      status = mine.status;
      if (status === 'complete' || status === 'error' || Date.now() > deadline) { break; }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(status, 'error', 'the download fails rather than adopt the file');
    assert.deepEqual(fs.readFileSync(existing), before, 'the file was not touched');
    assert.deepEqual(await listOf(adminToken, '?all=1'), [], 'and nothing was recorded');
    assert.equal(row('SELECT id FROM tracks WHERE filepath = ?', 'Remote_Hit.mp3'), undefined, 'no row was written for it');
    fs.rmSync(existing);
  });

  test('downloading the song again after removing it makes a fresh record; the old one stays history', async () => {
    const again = await download(danaToken, { ...REC, year: 2018 });
    assert.equal(again.result.downloaded.filepath, SONG, 'not owned any more, so it lands again');
    const live = await listOf(danaToken);
    assert.equal(live.length, 1);
    assert.notEqual(live[0].id, danaId);
    assert.equal(live[0].present, true);
    const history = await listOf(danaToken, '?removed=1');
    assert.deepEqual(history.map((d) => [d.id, d.removedAt > 0]), [[live[0].id, false], [danaId, true]]);
    assert.equal((await api(danaToken, 'DELETE', `${LIST}/${live[0].id}`)).status, 200);
  });

  test('a download filed into a folder that already exists under other casing is recorded as the disk spells it', async () => {
    // The layout renders "Nova/Night Ferry"; the disk already has this.
    const existing = path.join(collectionDir, 'NOVA', 'night ferry');
    fs.mkdirSync(existing, { recursive: true });
    const fresh = await download(danaToken, { ...REC, year: 2016 });
    const stored = fresh.result.downloaded.filepath;
    // The one file in the collection, as the disk spells it.
    const onDisk = fs.readdirSync(collectionDir, { recursive: true })
      .map((p) => String(p).split(path.sep).join('/'))
      .filter((p) => fs.statSync(path.join(collectionDir, p)).isFile());
    assert.deepEqual(onDisk, [stored.replace(/^collection\//, '')], 'the row carries the on-disk spelling, so a scan finds the same row');
    assert.ok(row('SELECT id FROM tracks WHERE filepath = ?', stored.replace(/^collection\//, '')), 'and the row is under that spelling');
    const removed = await api(danaToken, 'DELETE', `${LIST}/${fresh.result.downloaded.downloadId}`);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(removed.body.fileRemoved, true);
    fs.rmSync(path.join(collectionDir, 'NOVA'), { recursive: true, force: true });
    fs.rmSync(path.join(collectionDir, 'Nova'), { recursive: true, force: true });
  });

  test('removing a download whose file was replaced leaves the file alone: the record settles, nothing is deleted', async () => {
    const fresh = await download(danaToken, { ...REC, year: 2017 });
    const id = fresh.result.downloaded.downloadId;
    const file = path.join(collectionDir, 'Nova', 'Night Ferry', 'Remote_Hit.mp3');
    // The user's own rip, copied over it (a rescan reads it under the same
    // path, so the record still says present).
    fs.writeFileSync(file, Buffer.concat([fs.readFileSync(file), Buffer.from('and now a different file')]));
    assert.equal((await api(danaToken, 'POST', '/api/v1/playlist/save', { title: 'keeps', songs: [SONG] })).status, 200);
    const removed = await api(danaToken, 'DELETE', `${LIST}/${id}`);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(removed.body.kept, 'changed');
    assert.deepEqual([removed.body.fileRemoved, removed.body.rowsRemoved, removed.body.playlistEntries], [false, 0, 0]);
    assert.ok(fs.existsSync(file), 'the file stays');
    assert.ok(row('SELECT id FROM tracks WHERE filepath = ?', 'Nova/Night Ferry/Remote_Hit.mp3'), 'and its row');
    assert.equal((await api(danaToken, 'POST', '/api/v1/playlist/load', { playlistname: 'keeps' })).body.length, 1, 'and the playlist entry');
    assert.ok(removed.body.download.removedAt > 0, 'the record is history');
    assert.equal((await api(danaToken, 'DELETE', `${LIST}/${id}`)).status, 409, 'settled');
  });

  test('removing needs the upload right the download needed: an account that may not upload is refused', async () => {
    const mdb = new DatabaseSync(path.join(server.tmpDir, 'db', 'mstream.db'));
    let id;
    try {
      const finn = mdb.prepare('SELECT id FROM users WHERE username = ?').get('finn').id;
      id = Number(mdb.prepare(`INSERT INTO plugin_downloads (plugin, user_id, vpath, filepath, downloaded_at)
        VALUES ('youtube', ?, 'collection', 'Nova/Night Ferry/Remote_Hit.mp3', ?)`).run(finn, Date.now()).lastInsertRowid);
    } finally { mdb.close(); }
    const r = await api(finnToken, 'DELETE', `${LIST}/${id}`);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.match(r.body.error, /Uploading Disabled/);
    assert.ok(fs.existsSync(path.join(collectionDir, 'Nova', 'Night Ferry', 'Remote_Hit.mp3')), 'the file stays');
  });
});
