/**
 * The Youtube DL route's jobs (src/api/ytdl.js, src/api/ytdl-jobs.js),
 * against the scripted yt-dlp (test/helpers/fake-yt-dlp.mjs):
 *
 *   POST /api/v1/ytdl            { message, id, fileName } — or 409 { error, reason, fileName }
 *   GET  /api/v1/ytdl/downloads  the caller's jobs only, newest first
 *   GET  /api/v1/ytdl/metadata   the five old fields plus fileStem, isLive, liveStatus,
 *                                durationSec, channel; the probe it makes is cached
 *
 * What each failure says (reason exists | too-big | too-long | live |
 * unavailable | null) and that the words never carry a server path; the
 * folder checks; a jukebox session refused at the door. Three accounts: an
 * admin, dana and eli, all on the per-run inbox. Needs the bundled ffmpeg
 * (the tag pass); skipped without it.
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
const DANA = { username: 'dana', password: 'pw-dana' };
const ELI = { username: 'eli', password: 'pw-eli' };
const YTDL = '/api/v1/ytdl/';
const JOBS = '/api/v1/ytdl/downloads';
const yt = (id) => `https://www.youtube.com/watch?v=${id}`;
const song = (id, title, extra = {}) => ({ id, title, duration: 2, channel: 'Nova - Topic', uploader: 'Nova - Topic', webpage_url: yt(id), ...extra });
const DETAILS = {
  one: song('one', 'One Song'),
  two: song('two', 'Two Song'),
  three: song('three', 'Three Song'),
  four: song('four', 'Four Song'),
  stream: song('stream', 'Radio Nova 24/7', { is_live: true, live_status: 'is_live' }),
  gone: song('gone', 'Gone Song', { fail: 'Video unavailable. This video has been removed by the uploader' }),
  big: song('big', 'Big Song'),
  broken: song('broken', 'Broken Song'),
  bot: song('bot', 'Bot Song'),
  geo: song('geo', 'Geo Song'),
  nocopy: song('nocopy', 'No Copyright Music'),
  cached: song('cached', 'Cached Song', { album: 'Night Ferry', artist: 'Nova', release_year: 2019 }),
  flaky: song('flaky', 'Flaky Song', { fail: 'Unable to download API page: HTTP Error 503: Service Unavailable' }),
};

let server, workDir, inboxDir, scriptPath, adminToken, danaToken, eliToken;

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${stderr.slice(-200)}`)));
  });
}
function writeScript({ details = {}, download = {}, probe = {} } = {}) {
  fs.writeFileSync(scriptPath, JSON.stringify({ details: { ...DETAILS, ...details }, download, probe }));
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
const add = (token, id, extra = {}) => api(token, 'POST', YTDL, { directory: 'inbox', url: yt(id), outputCodec: 'mp3', ...extra });
const jobsOf = async (token) => (await api(token, 'GET', JOBS)).body.downloads;
async function settled(token, jobId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entry = (await jobsOf(token)).find((j) => j.id === jobId);
    if (entry && entry.status !== 'downloading') { return entry; }
    if (Date.now() > deadline) { throw new Error(`job ${jobId} never settled: ${JSON.stringify(entry)}`); }
    await new Promise((r) => setTimeout(r, 100));
  }
}
// Add, expect it accepted, wait for it to settle.
async function addAndSettle(token, id, extra) {
  const started = await add(token, id, extra);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  return { started: started.body, entry: await settled(token, started.body.id) };
}

describe('ytdl jobs · per account, with ids, reasons and the name check', { skip: hasFfmpeg ? false : 'bundled ffmpeg missing (bin/ffmpeg)' }, () => {
  before(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-ytdljobs-'));
    inboxDir = path.join(workDir, 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });
    const fixturePath = path.join(workDir, 'fixture.mp3');
    scriptPath = path.join(workDir, 'fake-yt-dlp.json');
    await runFfmpeg(['-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ac', '1', fixturePath]);
    writeScript();
    server = await startServer({
      dlnaMode: 'disabled', waitForScan: false,
      extraFolders: { inbox: inboxDir },
      env: { MSTREAM_YTDLP_BIN: FAKE, MSTREAM_FAKE_YTDLP_SCRIPT: scriptPath, MSTREAM_FAKE_YTDLP_FIXTURE: fixturePath },
      extraConfig: {
        discoveryPlugins: { youtube: { enabled: true } },
        discoveryJobs: { stagingDir: path.join(workDir, 'staging') },
      },
      users: [
        { ...ADMIN, admin: true, vpaths: ['testlib', 'inbox'] },
        { ...DANA, vpaths: ['inbox'] },
        { ...ELI, vpaths: ['inbox'] },
      ],
    });
    adminToken = await login(ADMIN);
    danaToken = await login(DANA);
    eliToken = await login(ELI);
    // ffmpeg resolves after boot; until then the route answers 500 "FFmpeg
    // is not available yet". An empty body is a 400 once it is ready.
    const deadline = Date.now() + 30_000;
    while ((await api(danaToken, 'POST', YTDL, {})).status !== 400) {
      if (Date.now() > deadline) { throw new Error('ffmpeg never became ready'); }
      await new Promise((r) => setTimeout(r, 100));
    }
  });
  after(async () => {
    if (server) { await server.stop(); }
    if (workDir) { fs.rmSync(workDir, { recursive: true, force: true }); }
  });

  test('a POST answers with its job id and the name it will land as; the entry follows it from running to complete', async () => {
    writeScript({ download: { slowMs: 300 } });
    // The link as pasted, with a playlist and a start time (both ways): the
    // job keeps the cleaned one, the same the record keeps as its origin.
    const started = await api(danaToken, 'POST', YTDL, { directory: 'inbox', url: `${yt('one')}&list=PL123&t=42#t=1m`, outputCodec: 'mp3' });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.message, 'Download started', 'kept for the clients that read only that');
    assert.equal(typeof started.body.id, 'string');
    assert.equal(started.body.fileName, 'One_Song.mp3');

    const running = (await jobsOf(danaToken)).find((j) => j.id === started.body.id);
    assert.ok(running, 'the job is listed as soon as the POST has answered');
    assert.ok(Number.isInteger(running.pid) && running.pid > 0, 'a pid, as the shipped phones need');
    assert.deepEqual({ ...running, pid: 0, startTime: 0 }, {
      id: started.body.id, pid: 0, url: yt('one'), directory: 'inbox', outputCodec: 'mp3',
      status: 'downloading', startTime: 0, endTime: null, fileName: 'One_Song.mp3', filePath: null,
      downloadId: null, error: null, reason: null,
    });
    assert.ok(running.startTime > Date.now() - 60_000);

    const done = await settled(danaToken, started.body.id);
    assert.equal(done.status, 'complete', JSON.stringify(done));
    assert.equal(done.filePath, 'inbox/One_Song.mp3');
    assert.equal(done.fileName, 'One_Song.mp3');
    assert.ok(done.endTime >= done.startTime);
    assert.deepEqual([done.error, done.reason], [null, null]);
    const records = (await api(danaToken, 'GET', '/api/v1/discovery/downloads?plugin=ytdl')).body.downloads;
    assert.equal(records.length, 1);
    assert.equal(done.downloadId, records[0].id, 'the job names its record');
    assert.equal(records[0].filepath, done.filePath);
    assert.equal(records[0].origin, yt('one'));
    assert.ok(fs.existsSync(path.join(inboxDir, 'One_Song.mp3')));
    writeScript();
  });

  test('each account sees its own jobs only — an admin included — newest first', async () => {
    const a = await addAndSettle(danaToken, 'two');
    assert.equal(a.entry.status, 'complete', JSON.stringify(a.entry));
    const b = await addAndSettle(adminToken, 'three');
    assert.equal(b.entry.status, 'complete', JSON.stringify(b.entry));

    const dana = await jobsOf(danaToken);
    assert.deepEqual(dana.map((j) => j.fileName), ['Two_Song.mp3', 'One_Song.mp3'], 'newest first');
    assert.ok(dana.every((j, i) => i === 0 || dana[i - 1].startTime >= j.startTime));
    assert.ok(dana.every((j) => !('userId' in j)), 'the account is never sent');
    assert.deepEqual(await jobsOf(eliToken), [], 'eli sees the library, not dana\'s links');
    assert.deepEqual((await jobsOf(adminToken)).map((j) => j.id), [b.started.id], 'the admin sees only their own');
  });

  test('a name the folder already has is refused before downloading — with the extension the codec lands with', async () => {
    const jobsBefore = (await jobsOf(danaToken)).length;
    const mp3 = await add(danaToken, 'two');
    assert.equal(mp3.status, 409, JSON.stringify(mp3.body));
    assert.deepEqual(mp3.body, { error: '“Two_Song.mp3” is already in this folder, so nothing was added.', reason: 'exists', fileName: 'Two_Song.mp3' });

    // aac and m4b both land as .m4a.
    fs.writeFileSync(path.join(inboxDir, 'Four_Song.m4a'), 'somebody\'s m4a');
    for (const outputCodec of ['aac', 'm4a', 'm4b']) {
      const r = await add(danaToken, 'four', { outputCodec });
      assert.equal(r.status, 409, `${outputCodec}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.fileName, 'Four_Song.m4a', outputCodec);
    }
    assert.equal((await jobsOf(danaToken)).length, jobsBefore, 'nothing was started');
    assert.equal(fs.readFileSync(path.join(inboxDir, 'Four_Song.m4a'), 'utf8'), 'somebody\'s m4a', 'nor touched');
    fs.rmSync(path.join(inboxDir, 'Four_Song.m4a'));
  });

  test('a live stream: accepted, then refused by yt-dlp, and the job says live', async () => {
    const { started, entry } = await addAndSettle(danaToken, 'stream');
    assert.equal(started.fileName, 'Radio_Nova_24_7.mp3');
    assert.equal(entry.status, 'error');
    assert.equal(entry.reason, 'live');
    assert.match(entry.error, /live stream/);
    assert.deepEqual([entry.filePath, entry.downloadId], [null, null]);
    assert.ok(entry.endTime >= entry.startTime);
  });

  test('a video YouTube will not serve: the probe fails, the add is not refused, the job says unavailable', async () => {
    const { started, entry } = await addAndSettle(danaToken, 'gone');
    assert.equal(started.fileName, null, 'no name to check without the probe');
    assert.equal(entry.status, 'error');
    assert.equal(entry.reason, 'unavailable');
    assert.match(entry.error, /Video unavailable/);
  });

  test('a file past the size cap: too-big', async () => {
    writeScript({ download: { tooBig: true } });
    try {
      const { entry } = await addAndSettle(danaToken, 'big');
      assert.equal(entry.status, 'error');
      assert.equal(entry.reason, 'too-big');
      assert.match(entry.error, /500 MB size cap/);
    } finally { writeScript(); }
  });

  test('the bot check is the server\'s problem: no reason, the server\'s words', async () => {
    writeScript({ download: { fail: '[youtube] bot: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.' } });
    try {
      const { entry } = await addAndSettle(danaToken, 'bot');
      assert.equal(entry.status, 'error');
      assert.equal(entry.reason, null);
      assert.match(entry.error, /Sign in to confirm you’re not a bot/);
    } finally { writeScript(); }
  });

  test('a geo block: unavailable, in YouTube\'s words — not the VPN hint yt-dlp ends the error on', async () => {
    writeScript({ download: { fail: '[youtube] geo: The uploader has not made this video available in your country\n'
      + 'You might want to use a VPN or a proxy server (with --proxy) to workaround.' } });
    try {
      const { entry } = await addAndSettle(danaToken, 'geo');
      assert.equal(entry.status, 'error');
      assert.equal(entry.reason, 'unavailable');
      assert.equal(entry.error, 'The uploader has not made this video available in your country');
    } finally { writeScript(); }
  });

  test('words that carry the title are never read for a reason: "No Copyright Music" on a full disk is no video YouTube refused', async () => {
    writeScript({ download: { fail: 'unable to write data: [Errno 28] No space left on device: \'%(out)s.part\'' } });
    try {
      const { entry } = await addAndSettle(danaToken, 'nocopy');
      assert.equal(entry.status, 'error');
      assert.equal(entry.reason, null, 'the server\'s problem: the words are the answer');
      assert.equal(entry.error, 'unable to write data: [Errno 28] No space left on device: \'No_Copyright_Music.mp3.part\'');
    } finally { writeScript(); }
  });

  test('the words a failure shows carry no server path', async () => {
    writeScript({ download: { fail: 'Postprocessing: Conversion failed! %(out)s: Invalid data found when processing input' } });
    try {
      const { entry } = await addAndSettle(danaToken, 'broken');
      assert.equal(entry.status, 'error');
      assert.equal(entry.error, 'Postprocessing: Conversion failed! Broken_Song.mp3: Invalid data found when processing input');
      assert.ok(!entry.error.includes(workDir) && !entry.error.includes('job-ytdl'), entry.error);
      assert.equal(entry.reason, null);
    } finally { writeScript(); }
  });

  test('the folder: one that is not there is a 404, a file is a 400, a library not granted a 404 — all before any yt-dlp call', async () => {
    fs.writeFileSync(path.join(inboxDir, 'not-a-folder.txt'), 'x');
    // A link nobody looked up, and a lookup that would hang: an answer
    // that waited on yt-dlp would take the POST's whole 15 s probe bound.
    writeScript({ probe: { slowMs: 30_000 } });
    try {
      for (const [directory, status, error] of [
        ['inbox/no/such/folder', 404, 'Folder not found'],
        ['inbox/not-a-folder.txt', 400, 'Not A Directory'],
        ['testlib', 404, 'User does not have access to path testlib'],
      ]) {
        const t0 = Date.now();
        const r = await add(danaToken, 'unprobed', { directory });
        assert.deepEqual([r.status, r.body.error], [status, error], directory);
        assert.ok(Date.now() - t0 < 5000, `${directory}: answered without asking yt-dlp (${Date.now() - t0} ms)`);
      }
    } finally {
      writeScript();
      fs.rmSync(path.join(inboxDir, 'not-a-folder.txt'));
    }
  });

  test('metadata: the old fields plus fileStem, isLive, liveStatus, durationSec and channel — and the add reads the same probe', async () => {
    const url = encodeURIComponent(yt('cached'));
    const lookup = await api(danaToken, 'GET', `/api/v1/ytdl/metadata?url=${url}`);
    assert.equal(lookup.status, 200, JSON.stringify(lookup.body));
    assert.deepEqual(lookup.body, {
      title: 'Cached Song', artist: 'Nova', album: 'Night Ferry', year: 2019, thumbnail: null,
      fileStem: 'Cached_Song', isLive: false, liveStatus: null, durationSec: 2, channel: 'Nova - Topic',
    });
    const live = await api(danaToken, 'GET', `/api/v1/ytdl/metadata?url=${encodeURIComponent(yt('stream'))}`);
    assert.deepEqual([live.body.isLive, live.body.liveStatus], [true, 'is_live']);

    // YouTube renames the video after the lookup: the add a moment later
    // answers with the name the lookup saw — it made no second probe.
    writeScript({ details: { cached: { ...DETAILS.cached, title: 'Renamed Song' } } });
    try {
      const { started, entry } = await addAndSettle(danaToken, 'cached');
      assert.equal(started.fileName, 'Cached_Song.mp3', 'from the cached probe');
      assert.equal(entry.status, 'complete', JSON.stringify(entry));
      assert.equal(entry.fileName, 'Renamed_Song.mp3', 'the entry ends with the name the file landed as');
      assert.equal(entry.filePath, 'inbox/Renamed_Song.mp3');
    } finally { writeScript(); }

    const bad = await api(danaToken, 'GET', `/api/v1/ytdl/metadata?url=${encodeURIComponent(yt('gone'))}`);
    assert.equal(bad.status, 500, 'a failed lookup stays the bare 500 clients map to "couldn\'t look it up"');
    assert.equal(bad.body.error, 'Server Error');

    // A failure is never kept: once YouTube answers, so does the lookup.
    const flaky = `/api/v1/ytdl/metadata?url=${encodeURIComponent(yt('flaky'))}`;
    assert.equal((await api(danaToken, 'GET', flaky)).status, 500);
    writeScript({ details: { flaky: song('flaky', 'Flaky Song') } });
    try {
      const again = await api(danaToken, 'GET', flaky);
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.equal(again.body.fileStem, 'Flaky_Song');
    } finally { writeScript(); }
  });

  test('settled entries stay listed after they settle', async () => {
    const dana = await jobsOf(danaToken);
    assert.ok(dana.length >= 8, `${dana.length} jobs`);
    assert.ok(dana.every((j) => j.status !== 'downloading'));
    assert.ok(dana.some((j) => j.status === 'complete') && dana.some((j) => j.status === 'error'));
  });

  test('a jukebox session token reaches none of it: the owner\'s jobs are not a remote-control guest\'s', async () => {
    const { default: WebSocket } = await import('ws');
    const juke = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${server.baseUrl.replace(/^http/, 'ws')}/?token=${danaToken}`);
      ws.on('message', (m) => { const j = JSON.parse(String(m)); if (j.token) { resolve({ ws, token: j.token }); } });
      ws.on('error', reject);
    });
    try {
      for (const [method, route, body] of [
        ['GET', JOBS],
        ['GET', `/api/v1/ytdl/metadata?url=${encodeURIComponent(yt('one'))}`],
        ['POST', YTDL, { directory: 'inbox', url: yt('one') }],
      ]) {
        const r = await api(juke.token, method, route, body);
        assert.equal(r.status, 403, `${method} ${route} answered ${r.status}`);
        assert.match(r.body.error, /jukebox session/);
      }
    } finally {
      juke.ws.terminate();
    }
  });
});
