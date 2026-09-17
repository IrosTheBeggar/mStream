/**
 * "Get it" from YouTube end to end, against a fake yt-dlp
 * (test/helpers/fake-yt-dlp.mjs, selected by MSTREAM_YTDLP_BIN): the
 * youtube plug-in (src/discovery-plugins/plugins/youtube.js), the Discover
 * downloads scratch library it creates on first use, the availability
 * probe, and the Youtube DL route that now shares the helper.
 *
 * Public mode: the downloads land in the 'shared' subfolder and admin
 * routes need no token. Every folder is per run; the fixture library is
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
const REC = { source: 'p2p', artist: 'Nova', title: 'Remote Hit', album: 'Night Ferry', year: 2019, duration: 2 };
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

let server, workDir, scriptPath, fixturePath, downloadsDir, inboxDir;

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
    fs.mkdirSync(inboxDir, { recursive: true });
    fixturePath = path.join(workDir, 'fixture.mp3');
    scriptPath = path.join(workDir, 'fake-yt-dlp.json');
    await runFfmpeg(['-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-metadata', 'title=Whatever YouTube Said', '-metadata', 'artist=Uploader', '-ac', '1', fixturePath]);
    writeScript();
    server = await startServer({
      dlnaMode: 'disabled',
      extraFolders: { inbox: inboxDir },
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
    assert.ok(result.expiresAt > Date.now() + 29 * 24 * 3600 * 1000);

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

  test('yt-dlp\'s own error reaches the job', async () => {
    writeScript({ download: { fail: 'Sign in to confirm you’re not a bot' } });
    try {
      const started = await api(server, 'POST', JOBS, { recommendation: { ...REC, title: 'Remote Hit', album: 'Night Ferry', year: 2020 } });
      const job = await untilFinished(started.body.job.id);
      assert.equal(job.state, 'failed');
      assert.match(job.error, /Sign in to confirm/);
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
