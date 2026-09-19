/**
 * "Get it" from YouTube end to end, against a fake yt-dlp
 * (test/helpers/fake-yt-dlp.mjs, selected by MSTREAM_YTDLP_BIN): the
 * youtube plug-in (src/discovery-plugins/plugins/youtube.js), the Discover
 * downloads scratch library it creates on first use, Keep… (the download
 * moves into the collection destination), the retention sweep, the
 * availability probe, and the Youtube DL route that now shares the helper.
 *
 * Public mode: the downloads land in the 'shared' subfolder and admin
 * routes need no token. Every folder is per run ('collection' receives what
 * is kept, 'inbox' the Youtube DL route's file); the fixture library is
 * never written to. Needs the bundled ffmpeg (the tag pass); skipped
 * without it.
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
const DEST = '/api/v1/discovery/collection/destination';
const SWEEP = '/api/v1/admin/discovery-jobs/sweep';
const DAY_MS = 24 * 60 * 60 * 1000;
const REC ={ source: 'p2p', artist: 'Nova', title: 'Remote Hit', album: 'Night Ferry', year: 2019, duration: 2 };
const yt = (id) => `https://www.youtube.com/watch?v=${id}`;
const SEARCH = {
  'remote hit': [
    { id: 'lyric', url: yt('lyric'), title: 'Nova - Remote Hit (Lyric Video)', duration: 2, channel: 'LyricsHub', uploader: 'LyricsHub' },
    { id: 'topic', url: yt('topic'), title: 'Remote Hit', duration: 2, channel: 'Nova - Topic', uploader: 'Nova - Topic', artist: 'Nova', album: 'Night Ferry', webpage_url: yt('topic') },
    { id: 'live', url: yt('live'), title: 'Nova - Remote Hit (Live at the Pier)', duration: 4, channel: 'Nova' },
  ],
  'ghost song': [],
  '*': [{ id: 'other', url: yt('other'), title: 'Something Else Entirely', duration: 300, channel: 'Rando' }],
};

let server, workDir, scriptPath, fixturePath, downloadsDir, inboxDir, collectionDir;
// The first finished download, handed from the download test to Keep….
let firstJobId = null;
let scratchPath = null;

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
function row(sql, ...args) {
  const mdb = new DatabaseSync(path.join(server.tmpDir, 'db', 'mstream.db'), { readOnly: true });
  try { return mdb.prepare(sql).get(...args); } finally { mdb.close(); }
}

describe('discovery youtube plug-in (fake yt-dlp)', { skip: hasFfmpeg ? false : 'bundled ffmpeg missing (bin/ffmpeg)' }, () => {
  before(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-ytplugin-'));
    downloadsDir = path.join(workDir, 'discover-downloads');
    inboxDir = path.join(workDir, 'inbox');
    collectionDir = path.join(workDir, 'collection');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.mkdirSync(collectionDir, { recursive: true });
    fixturePath = path.join(workDir, 'fixture.mp3');
    scriptPath = path.join(workDir, 'fake-yt-dlp.json');
    await runFfmpeg(['-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-metadata', 'title=Whatever YouTube Said', '-metadata', 'artist=Uploader', '-ac', '1', fixturePath]);
    writeScript();
    server = await startServer({
      dlnaMode: 'disabled',
      extraFolders: { inbox: inboxDir, collection: collectionDir },
      env: { MSTREAM_YTDLP_BIN: FAKE, MSTREAM_FAKE_YTDLP_SCRIPT: scriptPath, MSTREAM_FAKE_YTDLP_FIXTURE: fixturePath },
      extraConfig: {
        discoveryPlugins: { youtube: { enabled: true } },
        discoveryJobs: { downloads: { dir: downloadsDir, retentionDays: 30 } },
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
    assert.deepEqual(p.capabilities, ['acquire']);
    assert.equal(p.available, true);
    assert.equal(p.enabled, true);
  });

  test('a job searches, picks the Topic upload over the lyric video, downloads and lands a playable row', async () => {
    const started = await api(server, 'POST', JOBS, { recommendation: REC });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const job = await untilFinished(started.body.job.id);
    assert.equal(job.state, 'done', `job error: ${job.error}`);
    const { result } = job;
    assert.equal(result.match.url, yt('topic'));
    assert.ok(result.match.score >= 0.62, `score ${result.match.score}`);
    assert.equal(result.match.channel, 'Nova - Topic');
    assert.equal(result.downloaded.vpath, 'discover-downloads');
    assert.match(result.downloaded.filepath, /^discover-downloads\/shared\/.+\.mp3$/);
    assert.equal(result.downloaded.format, 'mp3');
    assert.ok(result.downloaded.trackId > 0);
    assert.ok(result.downloaded.bytes > 1000);
    // Computed on read from the retention setting (30 days here), never stored.
    assert.ok(result.expiresAt > Date.now() + 29 * DAY_MS && result.expiresAt < Date.now() + 31 * DAY_MS);
    firstJobId = job.id;
    scratchPath = result.downloaded.filepath;

    const rel = result.downloaded.filepath.replace(/^discover-downloads\//, '');
    const onDisk = path.join(downloadsDir, ...rel.split('/'));
    assert.ok(fs.existsSync(onDisk), `file must exist at ${onDisk}`);

    // The library exists, is served, and the row carries the plug-in's provenance
    // and the RECOMMENDATION's tags, not the upload's.
    assert.ok(row("SELECT id FROM libraries WHERE name = 'discover-downloads'"));
    const track = row('SELECT source, title FROM tracks WHERE filepath = ?', rel);
    assert.equal(track.source, 'plugin:youtube');
    assert.equal(track.title, 'Remote Hit');
    const meta = await api(server, 'POST', '/api/v1/db/metadata', { filepath: result.downloaded.filepath });
    assert.equal(meta.status, 200);
    assert.equal(meta.body.metadata.artist, 'Nova');
    assert.equal(meta.body.metadata.album, 'Night Ferry');
    const media = await fetch(`${server.baseUrl}/media/${result.downloaded.filepath.split('/').map(encodeURIComponent).join('/')}`);
    assert.equal(media.status, 200, 'served through /media without a reboot');
    assert.equal((await media.arrayBuffer()).byteLength, fs.statSync(onDisk).size);
  });

  test('Keep… moves the download into the collection; its rating and playlist entry follow', async () => {
    assert.ok(firstJobId && scratchPath, 'needs the download above');
    // What the user did with the song while it sat in Discover downloads.
    assert.equal((await api(server, 'POST', '/api/v1/db/rate-song', { filepath: scratchPath, rating: 8 })).status, 200);
    assert.equal((await api(server, 'POST', '/api/v1/playlist/save', { title: 'finds', songs: [scratchPath] })).status, 200);
    const dest = await api(server, 'PUT', DEST, { destination: { vpath: 'collection', base: '', layout: '{{PEER}}/{{ARTIST}}/{{ALBUM}}' } });
    assert.equal(dest.status, 200, JSON.stringify(dest.body));

    // "Clear finished" never drops a download that is still waiting to be
    // kept: the row is the only handle on it, and the lookup still finds it.
    assert.equal((await api(server, 'POST', '/api/v1/discovery/plugin-jobs/clear')).body.removed, 0);
    const waiting = await api(server, 'POST', '/api/v1/discovery/plugin-jobs/lookup', { recommendation: REC });
    assert.deepEqual(waiting.body.jobs.map((j) => j.id), [firstJobId]);
    assert.ok(waiting.body.jobs[0].result.expiresAt > Date.now(), 'a looked-up download carries its expiry');

    const kept = await api(server, 'POST', `/api/v1/discovery/plugin-jobs/${firstJobId}/keep`);
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    const result = kept.body.job.result;
    // {{PEER}} has no value for a download, so it drops out of the path.
    assert.equal(result.kept.filepath, 'collection/Nova/Night Ferry/Remote_Hit.mp3');
    assert.equal(result.kept.vpath, 'collection');
    assert.ok(result.kept.trackId > 0);
    assert.equal(result.kept.playlistEntries, 1);
    assert.deepEqual(result.kept.missingVars, ['PEER']);
    assert.equal(result.expiresAt, undefined, 'a kept download no longer expires');

    const scratchAbs = path.join(downloadsDir, ...scratchPath.replace(/^discover-downloads\//, '').split('/'));
    assert.ok(!fs.existsSync(scratchAbs), 'gone from Discover downloads');
    assert.ok(fs.existsSync(path.join(collectionDir, 'Nova', 'Night Ferry', 'Remote_Hit.mp3')), 'in the collection');
    assert.equal(row('SELECT id FROM tracks WHERE filepath = ?', scratchPath.replace(/^discover-downloads\//, '')), undefined, 'the scratch row went with it');
    const moved = row('SELECT source, title FROM tracks WHERE filepath = ?', 'Nova/Night Ferry/Remote_Hit.mp3');
    assert.equal(moved.source, 'plugin:youtube', 'provenance survives the move');
    assert.equal(moved.title, 'Remote Hit');

    // Ratings key on the track hash, so the rating followed by itself; the
    // playlist keys on the path, so Keep… rewrote it.
    const meta = await api(server, 'POST', '/api/v1/db/metadata', { filepath: result.kept.filepath });
    assert.equal(meta.body.metadata.rating, 8);
    const playlist = await api(server, 'POST', '/api/v1/playlist/load', { playlistname: 'finds' });
    assert.deepEqual(playlist.body.map((t) => t.filepath), [result.kept.filepath]);

    // The job remembers, and a second Keep… is refused.
    const again = await api(server, 'GET', `/api/v1/discovery/plugin-jobs/${firstJobId}`);
    assert.equal(again.body.job.result.kept.filepath, result.kept.filepath);
    assert.equal((await api(server, 'POST', `/api/v1/discovery/plugin-jobs/${firstJobId}/keep`)).status, 409);

    // Kept is settled: now the row may be cleared, and the file stays put.
    assert.equal((await api(server, 'POST', '/api/v1/discovery/plugin-jobs/clear')).body.removed, 1);
    assert.equal((await api(server, 'GET', `/api/v1/discovery/plugin-jobs/${firstJobId}`)).status, 404);
    assert.ok(fs.existsSync(path.join(collectionDir, 'Nova', 'Night Ferry', 'Remote_Hit.mp3')));
  });

  test('Keep… refusals: nothing to keep, uploads off, a bad destination, a file already there', async () => {
    assert.equal((await api(server, 'POST', '/api/v1/discovery/plugin-jobs/999999/keep')).status, 404);
    const failed = await api(server, 'POST', JOBS, { recommendation: { ...REC, title: 'Ghost Song' } });
    const failedJob = await untilFinished(failed.body.job.id);
    assert.equal(failedJob.state, 'failed');
    assert.equal((await api(server, 'POST', `/api/v1/discovery/plugin-jobs/${failedJob.id}/keep`)).status, 400, 'a failed job has no download');

    // The same song again: the earlier job is finished, so this is a new one,
    // and its file lands where the kept one used to sit.
    const second = await api(server, 'POST', JOBS, { recommendation: { ...REC, year: 2018 } });
    const job = await untilFinished(second.body.job.id);
    assert.equal(job.state, 'done', `job error: ${job.error}`);
    const keep = (body) => api(server, 'POST', `/api/v1/discovery/plugin-jobs/${job.id}/keep`, body);

    assert.equal((await api(server, 'POST', '/api/v1/admin/config/noupload', { noUpload: true })).status, 200);
    try {
      assert.equal((await keep()).status, 403, 'keeping is an upload by another road');
    } finally {
      assert.equal((await api(server, 'POST', '/api/v1/admin/config/noupload', { noUpload: false })).status, 200);
    }
    assert.equal((await keep({ destination: { vpath: 'nope', base: '', layout: '{{ARTIST}}' } })).status, 400, 'a one-off destination is checked like a saved one');
    assert.equal((await keep({ destination: { vpath: 'collection', base: '', layout: '{{TRACK}}' } })).status, 400);

    const clash = await keep();
    assert.equal(clash.status, 409, JSON.stringify(clash.body));
    assert.match(clash.body.error, /already exists at collection\/Nova\/Night Ferry\/Remote_Hit\.mp3/);
    const abs = path.join(downloadsDir, ...job.result.downloaded.filepath.replace(/^discover-downloads\//, '').split('/'));
    assert.ok(fs.existsSync(abs), 'a refused Keep… leaves the download where it was');

    // A one-off destination that is free works, without touching the saved one.
    const elsewhere = await keep({ destination: { vpath: 'collection', base: 'Second copy', layout: '{{ARTIST}}' } });
    assert.equal(elsewhere.status, 200, JSON.stringify(elsewhere.body));
    assert.equal(elsewhere.body.job.result.kept.filepath, 'collection/Second copy/Nova/Remote_Hit.mp3');
    assert.equal((await api(server, 'GET', DEST)).body.destination.layout, '{{PEER}}/{{ARTIST}}/{{ALBUM}}');
  });

  test('the sweep removes a download past its retention, tells the job, and leaves a fresh one alone', async () => {
    const old = await api(server, 'POST', JOBS, { recommendation: { ...REC, year: 2017 } });
    const oldJob = await untilFinished(old.body.job.id);
    assert.equal(oldJob.state, 'done', `job error: ${oldJob.error}`);
    const rel = oldJob.result.downloaded.filepath.replace(/^discover-downloads\//, '');
    const abs = path.join(downloadsDir, ...rel.split('/'));
    // A stale partial from a killed download, and the download itself, both past their time.
    const partial = path.join(path.dirname(abs), 'Some_Song.mp3.part');
    fs.writeFileSync(partial, 'half a file');
    const longAgo = new Date(Date.now() - 31 * DAY_MS);
    fs.utimesSync(abs, longAgo, longAgo);
    fs.utimesSync(partial, longAgo, longAgo);

    const swept = await api(server, 'POST', SWEEP);
    assert.equal(swept.status, 200, JSON.stringify(swept.body));
    assert.equal(swept.body.removedFiles, 1);
    assert.equal(swept.body.removedPartials, 1);
    assert.ok(!fs.existsSync(abs) && !fs.existsSync(partial));
    assert.equal(row('SELECT id FROM tracks WHERE filepath = ?', rel), undefined, 'the library row went with the file');
    const after = (await api(server, 'GET', `/api/v1/discovery/plugin-jobs/${oldJob.id}`)).body.job;
    assert.ok(after.result.removed.at > 0, 'the job says the download expired');
    assert.equal(after.result.expiresAt, undefined);
    assert.equal((await api(server, 'POST', `/api/v1/discovery/plugin-jobs/${oldJob.id}/keep`)).status, 409, 'nothing left to keep');

    // A fresh download is not touched by the next pass.
    const fresh = await api(server, 'POST', JOBS, { recommendation: { ...REC, year: 2016 } });
    const freshJob = await untilFinished(fresh.body.job.id);
    assert.equal(freshJob.state, 'done', `job error: ${freshJob.error}`);
    const again = await api(server, 'POST', SWEEP);
    assert.equal(again.body.removedFiles, 0);
    const freshAbs = path.join(downloadsDir, ...freshJob.result.downloaded.filepath.replace(/^discover-downloads\//, '').split('/'));
    assert.ok(fs.existsSync(freshAbs));
  });

  test('a song fetched twice is one file: keeping it through either job settles both', async () => {
    // The download above is still waiting; a second job for the same song
    // lands on the same path.
    const waiting = (await api(server, 'GET', '/api/v1/discovery/plugin-jobs?state=done')).body.jobs
      .filter((j) => j.result && j.result.downloaded && !j.result.kept && !j.result.removed);
    assert.equal(waiting.length, 1, JSON.stringify(waiting.map((j) => j.result)));
    const again = await api(server, 'POST', JOBS, { recommendation: { ...REC, year: 2015 } });
    const twin = await untilFinished(again.body.job.id);
    assert.equal(twin.state, 'done', `job error: ${twin.error}`);
    assert.equal(twin.result.downloaded.filepath, waiting[0].result.downloaded.filepath);

    const kept = await api(server, 'POST', `/api/v1/discovery/plugin-jobs/${twin.id}/keep`, { destination: { vpath: 'collection', base: 'Twins', layout: '{{ARTIST}}' } });
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    const other = (await api(server, 'GET', `/api/v1/discovery/plugin-jobs/${waiting[0].id}`)).body.job;
    assert.equal(other.result.kept.filepath, 'collection/Twins/Nova/Remote_Hit.mp3', 'the first job no longer offers a file that moved');
    assert.equal(other.result.expiresAt, undefined);
    assert.equal((await api(server, 'POST', `/api/v1/discovery/plugin-jobs/${waiting[0].id}/keep`)).status, 409);
  });

  test('no results, and results that are not the song, fail with a clear reason', async () => {
    const none = await api(server, 'POST', JOBS, { recommendation: { ...REC, title: 'Ghost Song' } });
    const j1 = await untilFinished(none.body.job.id);
    assert.equal(j1.state, 'failed');
    assert.match(j1.error, /no results/);
    const wrong = await api(server, 'POST', JOBS, { recommendation: { ...REC, title: 'Unlisted Track' } });
    const j2 = await untilFinished(wrong.body.job.id);
    assert.equal(j2.state, 'failed');
    assert.match(j2.error, /Nothing matched closely enough \(best score \d\.\d\d, needs 0\.62\)/);
  });

  test('yt-dlp\'s own error reaches the job, and the thumbnail it fetched first does not stay behind', async () => {
    writeScript({ download: { fail: 'Sign in to confirm you’re not a bot' } });
    try {
      const shared = path.join(downloadsDir, 'shared');
      const before = fs.existsSync(shared) ? fs.readdirSync(shared).sort() : [];
      const started = await api(server, 'POST', JOBS, { recommendation: { ...REC, title: 'Remote Hit', album: 'Night Ferry', year: 2020 } });
      const job = await untilFinished(started.body.job.id);
      assert.equal(job.state, 'failed');
      assert.match(job.error, /Sign in to confirm/);
      // The real yt-dlp writes <title>.jpg before the media; a refused
      // download used to leave it in the folder, counted as a download.
      assert.deepEqual((fs.existsSync(shared) ? fs.readdirSync(shared) : []).sort(), before, 'a failed download leaves no file');
    } finally {
      writeScript();
    }
  });

  test('a cancel mid-download stops yt-dlp and leaves nothing behind', async () => {
    writeScript({ download: { slowMs: 700 } });
    try {
      const shared = path.join(downloadsDir, 'shared');
      const before = fs.existsSync(shared) ? fs.readdirSync(shared) : [];
      const started = await api(server, 'POST', JOBS, { recommendation: { ...REC, year: 2021 } });
      await untilJob(started.body.job.id, ['running']);
      await new Promise((r) => setTimeout(r, 900));   // past the first progress line
      const cancelled = await api(server, 'POST', `/api/v1/discovery/plugin-jobs/${started.body.job.id}/cancel`);
      assert.equal(cancelled.status, 200);
      const job = await untilFinished(started.body.job.id);
      assert.equal(job.state, 'cancelled', `state ${job.state}: ${job.error}`);
      await new Promise((r) => setTimeout(r, 300));
      assert.deepEqual((fs.existsSync(shared) ? fs.readdirSync(shared) : []).sort(), before.sort(), 'no new file after a cancel');
    } finally {
      writeScript();
    }
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
