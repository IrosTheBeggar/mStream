/**
 * "Get it" from YouTube end to end, against a fake yt-dlp
 * (test/helpers/fake-yt-dlp.mjs, selected by MSTREAM_YTDLP_BIN): the
 * youtube plug-in (src/discovery-plugins/plugins/youtube.js) filing a
 * download in the collection destination the way a peer copy is filed, the
 * owned and existing-file skips, the staging folder that keeps yt-dlp's
 * by-products out of the library, the retention pass, the availability
 * probe, and the Youtube DL route that shares the helper.
 *
 * Public mode: admin routes need no token. Every folder is per run
 * ('collection' is the destination, 'inbox' the Youtube DL route's target);
 * the shared fixture library is never written to — the destination is set
 * before the first download, because the default would be the first
 * library, which is the fixture one. Needs the bundled ffmpeg (the tag
 * pass); skipped without it.
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

const JOBS = '/api/v1/discovery/plugins/youtube/jobs';
const RESOLVE = '/api/v1/discovery/plugins/youtube/resolve';
const DEST = '/api/v1/discovery/collection/destination';
const SWEEP = '/api/v1/admin/discovery-jobs/sweep';
const DAY_MS = 24 * 60 * 60 * 1000;
const REC = { source: 'p2p', artist: 'Nova', title: 'Remote Hit', album: 'Night Ferry', year: 2019, duration: 2 };
const yt = (id) => `https://www.youtube.com/watch?v=${id}`;
const SEARCH = {
  'remote hit': [
    { id: 'lyric', url: yt('lyric'), title: 'Nova - Remote Hit (Lyric Video)', duration: 2, channel: 'LyricsHub', uploader: 'LyricsHub' },
    { id: 'topic', url: yt('topic'), title: 'Remote Hit', duration: 2, channel: 'Nova - Topic', uploader: 'Nova - Topic', artist: 'Nova', album: 'Night Ferry', webpage_url: yt('topic') },
    { id: 'live', url: yt('live'), title: 'Nova - Remote Hit (Live at the Pier)', duration: 4, channel: 'Nova' },
  ],
  'ghost song': [],
  'vanished': [
    { id: 'gone', url: yt('gone'), title: 'Vanished', duration: 2, channel: 'Nova - Topic', uploader: 'Nova - Topic', fail: 'This video is not available' },
    { id: 'still', url: yt('still'), title: 'Nova - Vanished (Lyric Video)', duration: 2, channel: 'LyricsHub', uploader: 'LyricsHub' },
  ],
  '*': [{ id: 'other', url: yt('other'), title: 'Something Else Entirely', duration: 300, channel: 'Rando' }],
};

let server, workDir, scriptPath, fixturePath, stagingDir, inboxDir, collectionDir;

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${stderr.slice(-200)}`)));
  });
}
// The audio a "download" copies into place: a tone, tagged as the upload
// would be, so the plug-in's own tags are what end up on the file.
function makeFixture({ frequency, duration }) {
  return runFfmpeg(['-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${duration}`,
    '-metadata', 'title=Whatever YouTube Said', '-metadata', 'artist=Uploader', '-ac', '1', fixturePath]);
}
async function api(srv, method, route, body) {
  const r = await fetch(`${srv.baseUrl}${route}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
function writeScript(over = {}) {
  fs.writeFileSync(scriptPath, JSON.stringify({ search: SEARCH, details: {}, download: {}, ...over }));
}
async function untilJob(id, states, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await api(server, 'GET', `/api/v1/discovery/plugin-jobs/${id}`);
    const job = body && body.job;
    if (job && states.includes(job.state)) { return job; }
    if (Date.now() > deadline) { throw new Error(`job ${id} never reached ${states.join('|')} (last: ${job && job.state} · ${job && job.statusText})`); }
    await new Promise((r) => setTimeout(r, 100));
  }
}
const untilFinished = (id) => untilJob(id, ['done', 'failed', 'cancelled']);
async function runJob(recommendation) {
  const started = await api(server, 'POST', JOBS, { recommendation });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  return untilFinished(started.body.job.id);
}
function row(sql, ...args) {
  const mdb = new DatabaseSync(path.join(server.tmpDir, 'db', 'mstream.db'), { readOnly: true });
  try { return mdb.prepare(sql).get(...args); } finally { mdb.close(); }
}
const inCollection = (...parts) => path.join(collectionDir, ...parts);
// What is in the collection library and in staging, for "nothing changed".
const collectionFiles = () => fs.readdirSync(collectionDir, { recursive: true })
  .filter((p) => fs.statSync(path.join(collectionDir, p)).isFile()).map((p) => p.split(path.sep).join('/')).sort();
const staged = () => (fs.existsSync(stagingDir) ? fs.readdirSync(stagingDir) : []);

describe('discovery youtube plug-in (fake yt-dlp)', { skip: hasFfmpeg ? false : 'bundled ffmpeg missing (bin/ffmpeg)' }, () => {
  before(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-ytplugin-'));
    stagingDir = path.join(workDir, 'staging');
    inboxDir = path.join(workDir, 'inbox');
    collectionDir = path.join(workDir, 'collection');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.mkdirSync(collectionDir, { recursive: true });
    fixturePath = path.join(workDir, 'fixture.mp3');
    scriptPath = path.join(workDir, 'fake-yt-dlp.json');
    await makeFixture({ frequency: 440, duration: 2 });
    writeScript();
    server = await startServer({
      dlnaMode: 'disabled',
      extraFolders: { inbox: inboxDir, collection: collectionDir },
      env: { MSTREAM_YTDLP_BIN: FAKE, MSTREAM_FAKE_YTDLP_SCRIPT: scriptPath, MSTREAM_FAKE_YTDLP_FIXTURE: fixturePath },
      extraConfig: {
        discoveryPlugins: { youtube: { enabled: true } },
        discoveryJobs: { stagingDir },
      },
    });
  });
  after(async () => {
    if (server) { await server.stop(); }
    if (workDir) { fs.rmSync(workDir, { recursive: true, force: true }); }
  });

  test('the plug-in is listed as available once its probe sees yt-dlp and ffmpeg', async () => {
    const deadline = Date.now() + 10_000;
    let p;
    for (;;) {
      const r = await api(server, 'GET', '/api/v1/discovery/plugins');
      p = r.body.plugins.find((x) => x.name === 'youtube');
      if (p || Date.now() > deadline) { break; }
      await new Promise((res) => setTimeout(res, 200));
    }
    assert.ok(p, 'youtube is listed');
    assert.deepEqual(p.capabilities, ['acquire', 'lookup']);
    assert.equal(p.available, true);
    assert.equal(p.enabled, true);
  });

  test('the lookup answers what a job would fetch — best first, the live take left out — with nothing fetched', async () => {
    const r = await api(server, 'POST', RESOLVE, { recommendation: REC });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.capabilities, ['acquire', 'lookup']);
    const { lookup } = r.body.result;
    assert.equal(lookup.query, 'Nova Remote Hit');
    assert.equal(lookup.minScore, 0.62);
    assert.equal(lookup.owned, null);
    assert.deepEqual(lookup.candidates.map((c) => c.id), ['topic', 'lyric']);
    const best = lookup.candidates[0];
    assert.equal(best.url, yt('topic'));
    assert.equal(best.title, 'Remote Hit');
    assert.equal(best.channel, 'Nova - Topic');
    assert.equal(best.topic, true);
    assert.equal(best.durationSec, 2);
    assert.ok(best.score >= 0.62 && best.score <= 1, `score ${best.score}`);
    assert.ok(lookup.candidates[1].score <= best.score);
    assert.deepEqual(collectionFiles(), [], 'nothing was fetched');
    assert.deepEqual(staged(), []);
    assert.deepEqual((await api(server, 'POST', '/api/v1/discovery/plugin-jobs/lookup', { recommendation: REC })).body.jobs, [], 'and no job exists');
    // Nothing close is an empty answer, not a failure.
    const none = await api(server, 'POST', RESOLVE, { recommendation: { ...REC, title: 'Ghost Song' } });
    assert.equal(none.status, 200, JSON.stringify(none.body));
    assert.deepEqual(none.body.result.lookup.candidates, []);
    assert.equal(none.body.result.lookup.query, 'Nova Ghost Song');
  });

  test('a job searches, picks the Topic upload over the lyric video, downloads, and files the song in the collection destination', async () => {
    const dest = await api(server, 'PUT', DEST, { destination: { vpath: 'collection', base: '', layout: '{{PEER}}/{{ARTIST}}/{{ALBUM}}' } });
    assert.equal(dest.status, 200, JSON.stringify(dest.body));

    const job = await runJob(REC);
    assert.equal(job.state, 'done', `job error: ${job.error}`);
    const { result } = job;
    assert.equal(result.match.url, yt('topic'));
    assert.ok(result.match.score >= 0.62, `score ${result.match.score}`);
    assert.equal(result.match.channel, 'Nova - Topic');
    // Filed like a copy: the destination's layout from the recommendation's
    // tags. {{PEER}} has no value for a download, so it drops out of the path.
    assert.equal(result.downloaded.vpath, 'collection');
    assert.equal(result.downloaded.filepath, 'collection/Nova/Night Ferry/Remote_Hit.mp3');
    assert.deepEqual(result.missingVars, ['PEER']);
    assert.equal(result.destination.vpath, 'collection');
    assert.equal(result.downloaded.format, 'mp3');
    assert.ok(result.downloaded.trackId > 0);
    assert.ok(result.downloaded.bytes > 1000);
    assert.deepEqual([result.downloaded.title, result.downloaded.artist, result.downloaded.album], ['Remote Hit', 'Nova', 'Night Ferry']);
    assert.equal(result.expiresAt, undefined, 'nothing expires: the song is in the collection');
    assert.ok(fs.existsSync(inCollection('Nova', 'Night Ferry', 'Remote_Hit.mp3')), 'the file is in the collection');
    assert.deepEqual(staged(), [], 'the staging folder went with the job');

    // The row carries the plug-in's provenance and the RECOMMENDATION's tags,
    // not the upload's, and its length at once (the fixture is a 2 s tone).
    const track = row('SELECT source, title, duration FROM tracks WHERE filepath = ?', 'Nova/Night Ferry/Remote_Hit.mp3');
    assert.equal(track.source, 'plugin:youtube');
    assert.equal(track.title, 'Remote Hit');
    assert.ok(track.duration > 1.5 && track.duration < 3, `duration ${track.duration}`);
    const meta = await api(server, 'POST', '/api/v1/db/metadata', { filepath: result.downloaded.filepath });
    assert.equal(meta.status, 200);
    assert.equal(meta.body.metadata.artist, 'Nova');
    assert.equal(meta.body.metadata.album, 'Night Ferry');
    const media = await fetch(`${server.baseUrl}/media/${result.downloaded.filepath.split('/').map(encodeURIComponent).join('/')}`);
    assert.equal(media.status, 200, 'served like any library song');
    assert.equal((await media.arrayBuffer()).byteLength, fs.statSync(inCollection('Nova', 'Night Ferry', 'Remote_Hit.mp3')).size);
  });

  test('the lookup answers owned for a song the library has, without asking YouTube', async () => {
    const r = await api(server, 'POST', RESOLVE, { recommendation: REC });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const { lookup } = r.body.result;
    assert.deepEqual(lookup.candidates, []);
    assert.equal(lookup.owned.filepath, 'collection/Nova/Night Ferry/Remote_Hit.mp3');
    assert.equal(lookup.owned.by, 'tags');
  });

  test('a job started with a chosen upload fetches that one: the pick stands even where the scorer would pass it over', async () => {
    const rec = { ...REC, title: 'Harbour Days' };
    const keepFixture = fs.readFileSync(fixturePath);   // other audio for this one: the hash check must not call it owned
    writeScript({ details: { hd: { id: 'hd', url: yt('hd'), title: 'Nova - Harbour Days (Live at the Pier)', duration: 2, channel: 'Nova' } } });
    await makeFixture({ frequency: 660, duration: 2 });
    try {
      // Not a YouTube link: refused before a job exists.
      const bad = await api(server, 'POST', JOBS, { recommendation: rec, choice: { url: 'https://example.com/song.mp3' } });
      assert.equal(bad.status, 400, JSON.stringify(bad.body));
      assert.match(bad.body.error, /YouTube link/);
      assert.deepEqual((await api(server, 'POST', '/api/v1/discovery/plugin-jobs/lookup', { recommendation: rec })).body.jobs, []);

      const started = await api(server, 'POST', JOBS, { recommendation: rec, choice: { url: yt('hd') } });
      assert.equal(started.status, 202, JSON.stringify(started.body));
      assert.deepEqual(started.body.job.params, { choice: { url: yt('hd') } });
      const job = await untilFinished(started.body.job.id);
      assert.equal(job.state, 'done', `job error: ${job.error}`);
      assert.equal(job.result.match.url, yt('hd'));
      assert.equal(job.result.match.chosen, true);
      assert.equal(job.result.match.title, 'Nova - Harbour Days (Live at the Pier)', 'a live take the search would have dropped');
      assert.ok(job.result.downloaded.filepath.startsWith('collection/Nova/Night Ferry/'), job.result.downloaded.filepath);
      assert.deepEqual([job.result.downloaded.title, job.result.downloaded.artist, job.result.downloaded.album], ['Harbour Days', 'Nova', 'Night Ferry'], 'tagged from the recommendation');
      assert.ok(fs.existsSync(inCollection(...job.result.downloaded.filepath.split('/').slice(1))));
      assert.deepEqual(staged(), []);
    } finally {
      fs.writeFileSync(fixturePath, keepFixture);
      writeScript();
    }
  });

  test('an upload YouTube will not serve is not offered, and a job takes the next one', async () => {
    const rec = { ...REC, title: 'Vanished' };
    const r = await api(server, 'POST', RESOLVE, { recommendation: rec });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.result.lookup.candidates.map((c) => c.id), ['still'], 'the Topic upload YouTube refuses to serve is left out');
    const keepFixture = fs.readFileSync(fixturePath);
    await makeFixture({ frequency: 880, duration: 2 });
    try {
      const job = await runJob(rec);
      assert.equal(job.state, 'done', `job error: ${job.error}`);
      assert.equal(job.result.match.url, yt('still'));
      assert.equal(job.result.match.chosen, false);
    } finally {
      fs.writeFileSync(fixturePath, keepFixture);
    }
  });

  test('a song the library has is skipped: by its tags before the search, by its audio after a download under other tags', async () => {
    const same = await runJob({ ...REC, year: 2018 });
    assert.equal(same.state, 'done', `job error: ${same.error}`);
    assert.equal(same.result.skipped, 'owned');
    assert.deepEqual([same.result.existing.by, same.result.existing.filepath], ['tags', 'collection/Nova/Night Ferry/Remote_Hit.mp3']);
    assert.equal(same.result.destination.vpath, 'collection');

    // No album: the tags check cannot say, so the search runs and the fake
    // download lands the same audio under other tags. The audio hash catches
    // it, and the staged file never enters the library.
    const before = collectionFiles();
    const other = await runJob({ ...REC, album: null, year: 2017 });
    assert.equal(other.state, 'done', `job error: ${other.error}`);
    assert.equal(other.result.skipped, 'owned', JSON.stringify(other.result));
    assert.equal(other.result.existing.by, 'audio-hash');
    assert.deepEqual(collectionFiles(), before);
    assert.deepEqual(staged(), []);
  });

  test('a file already at the target path is never overwritten', async () => {
    // Different audio this time, so nothing owns it, and a stranger's file
    // where the layout puts it.
    await makeFixture({ frequency: 880, duration: 3 });
    const target = inCollection('Nova', 'Harbour', 'Remote_Hit.mp3');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'somebody else\'s file');

    const job = await runJob({ ...REC, album: 'Harbour', year: 2016 });
    assert.equal(job.state, 'done', `job error: ${job.error}`);
    assert.equal(job.result.skipped, 'exists', JSON.stringify(job.result));
    assert.equal(job.result.filepath, 'collection/Nova/Harbour/Remote_Hit.mp3');
    assert.equal(fs.readFileSync(target, 'utf8'), 'somebody else\'s file', 'untouched');
    assert.deepEqual(staged(), []);
  });

  test('uploads off for the server: the job is refused at the door, and so is the lookup', async () => {
    assert.equal((await api(server, 'POST', '/api/v1/admin/config/noupload', { noUpload: true })).status, 200);
    try {
      const before = collectionFiles();
      // A download is an upload: the request is refused before a job exists
      // (the run re-checks the account too, for rights that change later).
      const started = await api(server, 'POST', JOBS, { recommendation: { ...REC, album: 'Late Sessions', year: 2015 } });
      assert.equal(started.status, 403, JSON.stringify(started.body));
      assert.match(started.body.error, /Uploading Disabled/);
      assert.deepEqual(collectionFiles(), before);
      assert.deepEqual(staged(), []);
      // The lookup stands behind the same gate: a search on this server's
      // behalf is not for a caller whose download would be refused.
      const lookup = await api(server, 'POST', RESOLVE, { recommendation: REC });
      assert.equal(lookup.status, 403, JSON.stringify(lookup.body));
    } finally {
      assert.equal((await api(server, 'POST', '/api/v1/admin/config/noupload', { noUpload: false })).status, 200);
    }
  });

  test('no results, and results that are not the song, fail with a clear reason', async () => {
    const j1 = await runJob({ ...REC, title: 'Ghost Song' });
    assert.equal(j1.state, 'failed');
    assert.match(j1.error, /no results/);
    const j2 = await runJob({ ...REC, title: 'Unlisted Track' });
    assert.equal(j2.state, 'failed');
    assert.match(j2.error, /Nothing matched closely enough \(best score \d\.\d\d, needs 0\.62\)/);
  });

  test('yt-dlp\'s own error reaches the job, and nothing of the run stays anywhere — not even the thumbnail it fetched first', async () => {
    writeScript({ download: { fail: 'Sign in to confirm you’re not a bot' } });
    try {
      const before = collectionFiles();
      const job = await runJob({ ...REC, album: 'Night Ferry Sessions', year: 2020 });
      assert.equal(job.state, 'failed');
      assert.match(job.error, /Sign in to confirm/);
      // The real yt-dlp writes <title>.jpg before the media; in a library
      // folder that would be taken for folder art at the next scan.
      assert.deepEqual(collectionFiles(), before, 'nothing entered the library');
      assert.deepEqual(staged(), [], 'the staging folder, thumbnail and all, is gone');
    } finally {
      writeScript();
    }
  });

  test('a cancel mid-download stops yt-dlp and leaves nothing behind', async () => {
    writeScript({ download: { slowMs: 700 } });
    try {
      const before = collectionFiles();
      const started = await api(server, 'POST', JOBS, { recommendation: { ...REC, album: 'Cancelled Sessions', year: 2021 } });
      assert.equal(started.status, 202, JSON.stringify(started.body));
      await untilJob(started.body.job.id, ['running']);
      await new Promise((r) => setTimeout(r, 900));   // past the first progress line
      const cancelled = await api(server, 'POST', `/api/v1/discovery/plugin-jobs/${started.body.job.id}/cancel`);
      assert.equal(cancelled.status, 200);
      const job = await untilFinished(started.body.job.id);
      assert.equal(job.state, 'cancelled', `state ${job.state}: ${job.error}`);
      await new Promise((r) => setTimeout(r, 300));
      assert.deepEqual(collectionFiles(), before, 'no new file after a cancel');
      assert.deepEqual(staged(), []);
    } finally {
      writeScript();
    }
  });

  test('the retention pass removes a staging folder a crash left behind once it is a day old, and leaves a live one', async () => {
    const dead = path.join(stagingDir, 'job-999999');
    const live = path.join(stagingDir, 'job-999998');
    fs.mkdirSync(dead, { recursive: true });
    fs.mkdirSync(live, { recursive: true });
    fs.writeFileSync(path.join(dead, 'Song.mp3.part'), 'half a file');
    fs.writeFileSync(path.join(dead, 'Song.jpg'), 'a thumbnail');
    fs.writeFileSync(path.join(live, 'Song.mp3.part'), 'half a file');
    const old = new Date(Date.now() - 2 * DAY_MS);
    for (const p of [path.join(dead, 'Song.mp3.part'), path.join(dead, 'Song.jpg'), dead]) { fs.utimesSync(p, old, old); }

    const swept = await api(server, 'POST', SWEEP);
    assert.equal(swept.status, 200, JSON.stringify(swept.body));
    assert.deepEqual(swept.body, { prunedJobs: 0, removedStaging: 1 });
    assert.ok(!fs.existsSync(dead), 'the stale folder is gone');
    assert.ok(fs.existsSync(path.join(live, 'Song.mp3.part')), 'the live one is untouched');
    fs.rmSync(live, { recursive: true, force: true });
  });

  test('Clear finished drops every finished row: nothing waits on a job once it has run', async () => {
    const before = (await api(server, 'GET', '/api/v1/discovery/plugin-jobs')).body.jobs;
    assert.ok(before.length >= 5, `${before.length} jobs so far`);
    assert.ok(before.every((j) => ['done', 'failed', 'cancelled'].includes(j.state)));
    const cleared = await api(server, 'POST', '/api/v1/discovery/plugin-jobs/clear');
    assert.equal(cleared.body.removed, before.length);
    assert.deepEqual((await api(server, 'GET', '/api/v1/discovery/plugin-jobs')).body.jobs, []);
    assert.deepEqual((await api(server, 'POST', '/api/v1/discovery/plugin-jobs/lookup', { recommendation: REC })).body.jobs, []);
    assert.ok(fs.existsSync(inCollection('Nova', 'Night Ferry', 'Remote_Hit.mp3')), 'the song stays in the collection');
  });

  test('the Youtube DL route downloads a pasted URL through the same helper', async () => {
    const started = await api(server, 'POST', '/api/v1/ytdl/', {
      directory: 'inbox', url: yt('topic'), outputCodec: 'mp3', metadata: { artist: 'Nova', title: 'Remote Hit', album: 'Night Ferry' },
    });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const deadline = Date.now() + 20_000;
    let status;
    for (;;) {
      const r = await api(server, 'GET', '/api/v1/ytdl/downloads');
      status = (r.body.downloads[0] || {}).status;
      if (status === 'complete' || status === 'error' || Date.now() > deadline) { break; }
      await new Promise((res) => setTimeout(res, 150));
    }
    assert.equal(status, 'complete');
    const files = fs.readdirSync(inboxDir).filter((f) => f.endsWith('.mp3'));
    assert.equal(files.length, 1, `one file in the inbox: ${files}`);
    const track = row('SELECT source, title FROM tracks WHERE filepath = ?', files[0]);
    assert.equal(track.source, 'ytdl');
    assert.equal(track.title, 'Remote Hit');
    const lookup = await api(server, 'GET', `/api/v1/ytdl/metadata?url=${encodeURIComponent(yt('topic'))}`);
    assert.equal(lookup.status, 200);
    assert.equal(lookup.body.title, 'Remote Hit');
  });
});

describe('discovery youtube plug-in · without yt-dlp', { skip: hasFfmpeg ? false : 'bundled ffmpeg missing (bin/ffmpeg)' }, () => {
  let bare;
  before(async () => {
    bare = await startServer({
      dlnaMode: 'disabled', waitForScan: false,
      env: { MSTREAM_YTDLP_BIN: path.join(os.tmpdir(), 'definitely-not-yt-dlp.exe') },
      extraConfig: { discoveryPlugins: { youtube: { enabled: true } } },
    });
  });
  after(async () => { if (bare) { await bare.stop(); } });

  test('enabled but absent: not listed for users, named with a reason for admins, 404 for a job', async () => {
    const deadline = Date.now() + 10_000;
    let listed;
    for (;;) {
      listed = (await api(bare, 'GET', '/api/v1/discovery/plugins')).body.plugins.some((p) => p.name === 'youtube');
      if (!listed || Date.now() > deadline) { break; }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(listed, false, 'the probe failed, so the row is absent');
    const admin = await api(bare, 'GET', '/api/v1/admin/discovery-plugins');
    if (admin.status === 200) {
      const p = admin.body.plugins.find((x) => x.name === 'youtube');
      assert.equal(p.available, false);
      assert.match(p.reason, /yt-dlp not found/);
    }
    const started = await api(bare, 'POST', JOBS, { recommendation: REC });
    assert.equal(started.status, 404);
  });
});
