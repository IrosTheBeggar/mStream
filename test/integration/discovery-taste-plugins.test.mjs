/**
 * Server contract for the Discover page's connected-server rows, end to end
 * over REAL iroh: the rows POST /api/v1/discovery/taste answers under
 * peers.peers[].results[] (src/api/discovery-taste.js peersSection) are sent
 * UNCHANGED — exactly as a client holds them — to the plug-in API:
 *
 *   federation-play  POST /api/v1/discovery/plugins/federation-play/resolve
 *   links            POST /api/v1/discovery/plugins/links/resolve
 *   deezer / itunes  POST /api/v1/discovery/plugins/<name>/resolve (LOCAL mocks)
 *   federation-copy  POST /api/v1/discovery/plugins/federation-copy/jobs
 *                    with scope song, album (an album card's best row),
 *                    artist-missing and artist
 *   job badges       POST /api/v1/discovery/plugin-jobs/lookup[/batch]
 *
 * What it proves: the plug-in system serves Discover's recommended
 * federated songs and albums. Since 2026-10-19 (the user's decisions) also:
 *   - every row carries the album's own credit (`albumArtist`, from the
 *     peer's responder), so an album job from ANY row of a compilation
 *     copies the whole album — every track artist on it — and every row of
 *     it keys that one job (recommendation.js albumCredit);
 *   - an album job with neither an artist nor an album artist is a 400: an
 *     album NAME alone was every same-named album on the peer, across
 *     artists (recommendation.js scopeMissing);
 *   - a row with a malformed optional fact (here an ISRC as the raw tag
 *     spells it, 'US-RC1-76-07839') is kept with that fact nulled, not
 *     dropped (discovery-taste.js sendableRow);
 *   - a kept song is gone from the very next answer: the copy's insert
 *     refreshes the novelty sets (insert-downloaded-track.js).
 * And, pinned as documented server behaviour, what every client (webapp,
 * phone, terminal) must still handle itself:
 *   - album and artist job keys carry no peer: rows of one album on two
 *     peers share keys.album, and one peer's job comes back on the other
 *     peer's rows — so a client filters badges by job.recommendation.peer;
 *   - "done" is not "kept": with copies switched off on the peer, an album
 *     job ends done with result.stopped 'refused' and nothing copied — so a
 *     client reads result.stopped and result.counts, never the state alone.
 * Every call sends a row as the taste route answered it, except the one
 * 400 case, which blanks a row's credits on purpose.
 *
 * It never touches a real library or a running mStream. Every server is a
 * throwaway startServer (temp config, db and caches; a free 127.0.0.1 port);
 * the peers' libraries are generated with ffmpeg into temp folders; copies
 * land only in a per-run temp 'collection' library, and the shared testlib
 * fixture is asserted unchanged at the end; job staging sits in the run's
 * temp dir; Deezer and iTunes are local mocks. All of it is removed after.
 *
 *   Server A (the caller): users, federation + discovery ON ('test-fake'),
 *     the fixture 'testlib' (seeds) plus an empty per-run 'collection'
 *     library — the only place a copy may land (lena's destination is set
 *     to it before any job). 'lena' finished two songs (axes x and y), so
 *     every taste call sends the peers the same centroid.
 *   Server B (the peer): public mode, 'Bee Peer', a 'peerlib' built with
 *     ffmpeg: Nova's "Night Ferry" (3 songs) and "Second Wind" (2 — "Wind
 *     Two" tagged with a hyphenated ISRC), and a compilation "Mixtape Vol 1"
 *     (album artist Various Artists) with one song each by Peer Kim and
 *     Peer Lou.
 *   Server C (a second peer): public mode, 'Cee Peer', a 'ceelib' for the
 *     client-handling cases, kept off B so B's rows stay exactly the ones
 *     the proof ran on: "Greatest Hits" three times (no artist tag, Other
 *     Band, Third Band); Nova's "Wind Three", a song of "Second Wind" that
 *     B lacks; and Cee Solo's "Solo One", which nothing copies.
 *
 * Skips when @number0/iroh has no prebuilt binary here (every side needs it).
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
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

const TASTE = '/api/v1/discovery/taste';
const COPY = 'federation-copy';
const JOBS = `/api/v1/discovery/plugins/${COPY}/jobs`;
const PEER_NAME = 'Bee Peer';
const PEER_C_NAME = 'Cee Peer';
// An ISRC as a raw tag may spell it — the scanner stores it unnormalised;
// the recommendation schema takes only 12 alphanumerics.
const HYPHENATED_ISRC = 'US-RC1-76-07839';

// ── vectors (4-d) ────────────────────────────────────────────────────────────
const unit = (xs) => {
  const n = Math.hypot(...xs) || 1;
  return xs.map((x) => x / n);
};
const blob = (xs) => {
  const v = Float32Array.from(unit(xs));
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
};
const AXES = { x: [1, 0, 0, 0], y: [0, 1, 0, 0], z: [0, 0, 1, 0], w: [0, 0, 0, 1] };

const A_SONGS = {
  'testlib/Icarus/Be Somebody/01 - Be Somebody.mp3': 'x',
  'testlib/Vosto/Night Drive/01 - Highway.mp3': 'y',
  'testlib/Icarus/Later Works/01 - Return.mp3': 'z',
  'testlib/Icarus/Later Works/02 - Descent.mp3': 'w',
};
// lena finished these two: the centroid is (x + y) / √2 on every call.
const PLAYED = ['testlib/Icarus/Be Somebody/01 - Be Somebody.mp3', 'testlib/Vosto/Night Drive/01 - Highway.mp3'];

// B's peerlib: { rel, title, artist, album, year, track, albumArtist?, isrc?, vec }.
// Every cosine against the centroid sits in 0.66–0.91: none is a near
// duplicate (NEAR_DUP 0.99), so all seven reach A's answer.
const B_SONGS = [
  { rel: 'Nova/Night Ferry/01 - Ferry One.mp3', title: 'Ferry One', artist: 'Nova', album: 'Night Ferry', year: 2019, track: 1, vec: [0.9, 0.35, 0.1, 0.1] },
  { rel: 'Nova/Night Ferry/02 - Ferry Two.mp3', title: 'Ferry Two', artist: 'Nova', album: 'Night Ferry', year: 2019, track: 2, vec: [0.85, 0.3, 0.3, 0.1] },
  { rel: 'Nova/Night Ferry/03 - Ferry Three.mp3', title: 'Ferry Three', artist: 'Nova', album: 'Night Ferry', year: 2019, track: 3, vec: [0.7, 0.2, 0.4, 0.3] },
  { rel: 'Nova/Second Wind/01 - Wind One.mp3', title: 'Wind One', artist: 'Nova', album: 'Second Wind', year: 2021, track: 1, vec: [0.3, 0.85, 0.2, 0.2] },
  { rel: 'Nova/Second Wind/02 - Wind Two.mp3', title: 'Wind Two', artist: 'Nova', album: 'Second Wind', year: 2021, track: 2, isrc: HYPHENATED_ISRC, vec: [0.2, 0.75, 0.3, 0.4] },
  { rel: 'Various Artists/Mixtape Vol 1/01 - Kim Song.mp3', title: 'Kim Song', artist: 'Peer Kim', album: 'Mixtape Vol 1', year: 2020, track: 1, albumArtist: 'Various Artists', vec: [0.6, 0.6, 0.4, 0.2] },
  { rel: 'Various Artists/Mixtape Vol 1/02 - Lou Song.mp3', title: 'Lou Song', artist: 'Peer Lou', album: 'Mixtape Vol 1', year: 2020, track: 2, albumArtist: 'Various Artists', vec: [0.5, 0.4, 0.5, 0.5] },
];
const bByTitle = new Map(B_SONGS.map((s) => [s.title, s]));

// C's ceelib (artist null = no artist tag at all). Cosines vs the centroid
// sit in 0.75–0.90, so all five reach A's answer, in C's own group.
const C_SONGS = [
  { rel: 'Unknown/Greatest Hits/01 - Untagged Hit.mp3', title: 'Untagged Hit', artist: null, album: 'Greatest Hits', year: 2000, track: 1, vec: [0.8, 0.45, 0.3, 0.2] },
  { rel: 'Other Band/Greatest Hits/01 - Other Hit.mp3', title: 'Other Hit', artist: 'Other Band', album: 'Greatest Hits', year: 2000, track: 1, vec: [0.45, 0.8, 0.25, 0.3] },
  { rel: 'Third Band/Greatest Hits/01 - Third Hit.mp3', title: 'Third Hit', artist: 'Third Band', album: 'Greatest Hits', year: 2000, track: 1, vec: [0.6, 0.55, 0.3, 0.45] },
  { rel: 'Nova/Second Wind/03 - Wind Three.mp3', title: 'Wind Three', artist: 'Nova', album: 'Second Wind', year: 2021, track: 3, vec: [0.35, 0.7, 0.45, 0.3] },
  { rel: 'Cee Solo/Quiet Room/01 - Solo One.mp3', title: 'Solo One', artist: 'Cee Solo', album: 'Quiet Room', year: 2022, track: 1, vec: [0.55, 0.5, 0.55, 0.35] },
];
const cByTitle = new Map(C_SONGS.map((s) => [s.title, s]));

let srvA, srvB, srvC, peerDir, ceeDir, collectionDir, stagingDir, peerId, cPeerId, cKey, mock, mockBase, fixtureBefore;
const tokens = {};
const mockSeen = [];
// The rows as the page first drew them — what a client holds when it asks
// for badges after the copies (a kept song leaves later answers). B's, and
// C's from the same answer.
let firstRows = null;
let firstCRows = null;
const jobsMade = {};
// When the song test's copy finished (the kept case runs right after it).
let songKeptAt = null;

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${stderr.slice(-200)}`))));
  });
}

async function call(srv, method, route, body, { token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) { headers['x-access-token'] = token; }
  const r = await fetch(`${srv.baseUrl}${route}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const lena = (method, route, body) => call(srvA, method, route, body, { token: tokens.lena });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hand-seed a server's discovery.db: rows = [[library, relative filepath, vector]].
function seedVectors(srv, rows) {
  const mdb = new DatabaseSync(path.join(srv.tmpDir, 'db', 'mstream.db'), { readOnly: true });
  const ddb = new DatabaseSync(path.join(srv.tmpDir, 'db', 'discovery.db'));
  try {
    const byPath = mdb.prepare(`
      SELECT COALESCE(t.audio_hash, t.file_hash) AS hash, a.name AS artist, t.title, t.duration
        FROM tracks t JOIN libraries l ON l.id = t.library_id LEFT JOIN artists a ON a.id = t.artist_id
       WHERE l.name = ? AND REPLACE(t.filepath, '\\', '/') = ?`);
    const ins = ddb.prepare(`
      INSERT INTO discovery_tracks
        (audio_hash, updated_at, export_id, artist, title, duration, model_id, model_version, embedding, genre_tags)
      VALUES (?, ?, ?, ?, ?, ?, 'test-fake', '1', ?, NULL)`);
    let seq = 0;
    for (const [lib, rel, v] of rows) {
      const t = byPath.get(lib, rel);
      assert.ok(t?.hash, `fixture track '${lib}/${rel}' must be scanned with a hash`);
      ins.run(t.hash, ++seq, `anon:${lib}-${seq}`, t.artist, t.title, t.duration ?? 120, blob(v));
    }
    ddb.prepare("UPDATE discovery_meta SET value = ? WHERE key = 'row_seq'").run(String(seq));
    ddb.prepare("INSERT OR REPLACE INTO discovery_meta (key, value) VALUES ('embedding_model_version', '1')").run();
  } finally {
    ddb.close();
    mdb.close();
  }
}

function dbRow(srv, sql, ...args) {
  const mdb = new DatabaseSync(path.join(srv.tmpDir, 'db', 'mstream.db'), { readOnly: true, timeout: 5000 });
  try { return mdb.prepare(sql).get(...args); } finally { mdb.close(); }
}
const aRow = (sql, ...args) => dbRow(srvA, sql, ...args);

// Every file under a folder, relative, sorted — the fixture-untouched check.
function tree(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); } else { out.push(path.relative(dir, p)); }
    }
  };
  walk(dir);
  return out.sort();
}

// The peers section of one taste call: one group per use_discovery peer.
async function peerGroups() {
  const r = await lena('POST', TASTE, { sources: ['peers'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.peers.peers.map((g) => g.id).sort((a, b) => a - b), [peerId, cPeerId].sort((a, b) => a - b),
    'two use_discovery peers → two groups');
  return r.body.peers.peers;
}
const rowsOf = (groups, id) => groups.find((g) => g.id === id).results;
// One peer's rows of one taste call (B's unless told), as the taste route
// answered them.
async function peerRows(id = peerId) {
  return rowsOf(await peerGroups(), id);
}

// What a client's album strip makes of the rows (webapp discovery-page.js
// peerAlbums): grouped by peer + album + artist, best match first.
function albumCards(rows) {
  const fold = (v) => String(v || '').trim().toLowerCase();
  const byKey = new Map();
  for (const r of [...rows].sort((a, b) => b.similarity - a.similarity)) {
    if (!r.album) { continue; }
    const key = JSON.stringify([r.peer.id, fold(r.album), fold(r.artist)]);
    if (!byKey.has(key)) { byKey.set(key, { album: r.album, artist: r.artist, raws: [] }); }
    byKey.get(key).raws.push(r);
  }
  return [...byKey.values()];
}

async function untilFinished(id, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await lena('GET', `/api/v1/discovery/plugin-jobs/${id}`);
    const job = body && body.job;
    if (job && ['done', 'failed', 'cancelled'].includes(job.state)) { return job; }
    if (Date.now() > deadline) { throw new Error(`job ${id} never finished (last: ${job && job.state} · ${job && job.statusText})`); }
    await sleep(150);
  }
}

// Start a copy job for `recommendation` and wait for it.
async function copyJob(recommendation, scope) {
  const t0 = Date.now();
  const body = { recommendation };
  if (scope) { body.scope = scope; }
  const started = await lena('POST', JOBS, body);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const job = await untilFinished(started.body.job.id);
  return { job, ms: Date.now() - t0 };
}

// A copied file as A serves it (the /media route the player uses).
async function mediaBytes(vpathPath) {
  const r = await fetch(`${srvA.baseUrl}/media/${vpathPath.split('/').map(encodeURIComponent).join('/')}`,
    { headers: { 'x-access-token': tokens.lena } });
  return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) };
}

// A local stand-in for Deezer's /search and the iTunes Search API: it knows
// B's songs and answers a search that names one with that song alone.
function startCatalogueMock() {
  return new Promise((resolve) => {
    mock = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://mock');
      mockSeen.push(url.pathname + url.search);
      const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      const slug = (s) => s.title.toLowerCase().replace(/\s+/g, '-');
      if (url.pathname === '/search' && url.searchParams.has('q')) {
        const q = url.searchParams.get('q');
        const hit = B_SONGS.find((s) => q.includes(s.title) && q.includes(s.artist));
        return json(200, { data: hit ? [{
          id: 900 + B_SONGS.indexOf(hit), title: hit.title, duration: 2,
          preview: `https://cdn.deezer.example/${slug(hit)}.mp3`, link: `https://www.deezer.com/track/${900 + B_SONGS.indexOf(hit)}`,
          artist: { name: hit.artist }, album: { title: hit.album },
        }] : [] });
      }
      if (url.pathname === '/search' && url.searchParams.has('term')) {
        const term = url.searchParams.get('term');
        const hit = B_SONGS.find((s) => term === `${s.artist} ${s.title}`);
        return json(200, hit ? { resultCount: 1, results: [{
          wrapperType: 'track', kind: 'song', trackId: 700 + B_SONGS.indexOf(hit), trackName: hit.title, artistName: hit.artist,
          collectionName: hit.album, trackTimeMillis: 2000, previewUrl: `https://audio-ssl.itunes.example/${slug(hit)}.m4a`,
          trackViewUrl: `https://music.apple.com/us/song/${700 + B_SONGS.indexOf(hit)}`,
        }] } : { resultCount: 0, results: [] });
      }
      json(404, {});
    });
    mock.listen(0, '127.0.0.1', () => {
      mockBase = `http://127.0.0.1:${mock.address().port}`;
      resolve();
    });
  });
}

describe('Discover\'s connected-server rows through the discovery plug-ins, unchanged', { skip: available ? false : 'no @number0/iroh binary for this platform' }, () => {
  before(async () => {
    peerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-taste-plug-peer-'));
    ceeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-taste-plug-peer-c-'));
    collectionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-taste-plug-dest-'));
    stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-taste-plug-staging-'));
    // One tone per song across both peers: no two files share audio.
    let freq = 300;
    for (const [dir, songs] of [[peerDir, B_SONGS], [ceeDir, C_SONGS]]) {
      for (const s of songs) {
        const file = path.join(dir, s.rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const meta = ['-metadata', `title=${s.title}`, '-metadata', `album=${s.album}`,
          '-metadata', `date=${s.year}`, '-metadata', `track=${s.track}`];
        if (s.artist) { meta.unshift('-metadata', `artist=${s.artist}`); }
        if (s.albumArtist) { meta.push('-metadata', `album_artist=${s.albumArtist}`); }
        // ID3v2's ISRC frame, written verbatim.
        if (s.isrc) { meta.push('-metadata', `TSRC=${s.isrc}`); }
        await runFfmpeg(['-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${freq += 45}:duration=2`,
          ...meta, '-ac', '1', file]);
      }
    }
    await startCatalogueMock();

    const discoveryOn = { collectDiscoveryData: true, discoveryModel: 'test-fake' };
    [srvA, srvB, srvC] = await Promise.all([
      startServer({
        dlnaMode: 'disabled',
        extraFolders: { collection: collectionDir },
        extraConfig: {
          federation: { enabled: true },
          scanOptions: discoveryOn,
          // Staging under this run's temp dir, not the checkout's save/.
          discoveryJobs: { stagingDir },
        },
        env: { MSTREAM_DEEZER_BASE: mockBase, MSTREAM_ITUNES_BASE: mockBase },
        users: [
          { username: 'boss', password: 'pw-boss', admin: true, vpaths: ['testlib', 'collection'] },
          { username: 'lena', password: 'pw-lena', admin: false, vpaths: ['testlib', 'collection'] },
        ],
      }),
      startServer({
        dlnaMode: 'disabled',
        extraFolders: { peerlib: peerDir },
        extraConfig: { federation: { enabled: true, serverName: PEER_NAME }, scanOptions: discoveryOn },
      }),
      startServer({
        dlnaMode: 'disabled',
        extraFolders: { ceelib: ceeDir },
        extraConfig: { federation: { enabled: true, serverName: PEER_C_NAME }, scanOptions: discoveryOn },
      }),
    ]);
    fixtureBefore = tree(srvA.musicDir);

    for (const u of ['boss', 'lena']) {
      const r = await call(srvA, 'POST', '/api/v1/auth/login', { username: u, password: `pw-${u}` });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      tokens[u] = r.body.token;
    }

    // lena's copies go to the per-run 'collection' library — set before
    // any job; the default (the first library) could be the fixture one.
    const dest = await lena('PUT', '/api/v1/discovery/collection/destination',
      { destination: { vpath: 'collection', base: 'From peers', layout: '{{ARTIST}}/{{ALBUM}}' } });
    assert.equal(dest.status, 200, JSON.stringify(dest.body));
    assert.deepEqual(dest.body.destination, { vpath: 'collection', base: 'From peers', layout: '{{ARTIST}}/{{ALBUM}}', source: 'user' });

    seedVectors(srvA, Object.entries(A_SONGS).map(([p, axis]) => ['testlib', p.slice('testlib/'.length), AXES[axis]]));
    seedVectors(srvB, B_SONGS.map((s) => ['peerlib', s.rel, s.vec]));
    seedVectors(srvC, C_SONGS.map((s) => ['ceelib', s.rel, s.vec]));

    const mint = await call(srvB, 'POST', '/api/v1/admin/federation/keys', { name: 'for-a', vpaths: ['peerlib'] });
    assert.equal(mint.status, 200, JSON.stringify(mint.body));
    assert.ok(mint.body.ticket, 'B must issue a ticket (endpoint up)');
    const added = await call(srvA, 'POST', '/api/v1/admin/federation/peers', { ticket: mint.body.ticket }, { token: tokens.boss });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.equal(added.body.name, PEER_NAME);
    peerId = added.body.id;
    // C's key (its id and limits) is kept: the copies-off case edits it.
    const mintC = await call(srvC, 'POST', '/api/v1/admin/federation/keys', { name: 'for-a', vpaths: ['ceelib'] });
    assert.equal(mintC.status, 200, JSON.stringify(mintC.body));
    assert.ok(mintC.body.ticket, 'C must issue a ticket (endpoint up)');
    assert.equal(mintC.body.allowCopies, true, 'copies are on unless said');
    cKey = mintC.body;
    const addedC = await call(srvA, 'POST', '/api/v1/admin/federation/peers', { ticket: mintC.body.ticket }, { token: tokens.boss });
    assert.equal(addedC.status, 200, JSON.stringify(addedC.body));
    assert.equal(addedC.body.name, PEER_C_NAME);
    cPeerId = addedC.body.id;

    const DAY = 24 * 60 * 60 * 1000;
    const plays = PLAYED.map((filePath, i) => ({
      id: `taste-plug-${i}`, filePath, startedAt: new Date(Date.now() - (i + 1) * DAY).toISOString(),
      playedMs: 200000, durationMs: 200000, outcome: 'completed',
    }));
    const posted = await lena('POST', '/api/v1/stats/plays', { client: { name: 'taste-plugins-test' }, plays });
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    assert.equal(posted.body.accepted.length, plays.length, JSON.stringify(posted.body));

    // Readiness: a peer's endpoint boots after its HTTP; ask until both answer.
    const ready = Date.now() + 60_000;
    for (;;) {
      const r = await lena('POST', TASTE, { sources: ['peers'] });
      if (r.status === 200 && r.body?.peers?.searched?.peers === 2 && r.body.peers.searched.unreachable === 0) { break; }
      assert.ok(Date.now() < ready, `B and C never both became reachable: last ${r.status} ${JSON.stringify(r.body?.peers?.searched)}`);
      await sleep(500);
    }
  });

  after(async () => {
    await Promise.all([srvA?.stop(), srvB?.stop(), srvC?.stop()]);
    if (mock) { await new Promise((r) => mock.close(r)); }
    for (const dir of [peerDir, ceeDir, collectionDir, stagingDir]) {
      if (dir) { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  });

  test('the taste rows: every B song, stamped federation, and each one a valid recommendation as it stands', async () => {
    const plugins = await lena('GET', '/api/v1/discovery/plugins');
    assert.equal(plugins.status, 200);
    assert.equal(plugins.body.jobs.allowed, true, 'lena may start jobs');
    const byName = new Map(plugins.body.plugins.map((p) => [p.name, p]));
    for (const n of ['links', 'deezer', 'itunes', 'federation-play', COPY]) { assert.ok(byName.has(n), `${n} is on by default`); }
    assert.deepEqual(byName.get(COPY).scopes, ['song', 'album', 'artist', 'artist-missing', 'folder']);

    const groups = await peerGroups();
    const rows = rowsOf(groups, peerId);
    firstRows = rows;
    firstCRows = rowsOf(groups, cPeerId);
    assert.deepEqual(rows.map((r) => r.title).sort(), B_SONGS.map((s) => s.title).sort(), 'all seven B songs');
    assert.deepEqual(firstCRows.map((r) => r.title).sort(), C_SONGS.map((s) => s.title).sort(), 'all five C songs, in C\'s own group');
    for (const r of firstCRows) {
      const s = cByTitle.get(r.title);
      assert.equal(r.source, 'federation');
      assert.equal(r.peer.id, cPeerId);
      assert.equal(r.filepath, `ceelib/${s.rel}`);
      assert.equal(r.artist, s.artist, 'the track artist; null for the untagged file');
      assert.equal(r.albumArtist, s.artist, 'no ALBUMARTIST tag on C: the album\'s credit is its primary artist; none for the untagged file');
    }
    for (const r of rows) {
      const s = bByTitle.get(r.title);
      assert.equal(r.source, 'federation');
      assert.deepEqual(r.peer, { id: peerId, name: PEER_NAME });
      assert.equal(r.filepath, `peerlib/${s.rel}`);
      assert.equal(r.artist, s.artist, 'the TRACK artist');
      assert.equal(r.album, s.album);
      assert.equal(r.year, s.year);
      assert.equal(r.albumArtist, s.albumArtist || s.artist, 'the ALBUM\'s own credit: Various Artists on the compilation, Nova on Nova\'s albums');
      assert.equal(r.isrc, null, `${r.title}: no valid ISRC`);
    }
    // The hyphenated ISRC: stored on B as the tag spells it, sent by B's
    // responder as is, and nulled on A — the song still shows (it is among
    // the seven above), with every other fact it has.
    assert.equal(dbRow(srvB, 'SELECT isrc FROM tracks WHERE title = ?', 'Wind Two').isrc, HYPHENATED_ISRC, 'the fixture tag landed');
    const windTwo = rows.find((r) => r.title === 'Wind Two');
    assert.equal(windTwo.isrc, null, 'nulled, not dropped');
    assert.deepEqual([windTwo.album, windTwo.year, windTwo.albumArtist], ['Second Wind', 2021, 'Nova']);
    // The single lookup validates each row on its own: 200 for all, no jobs yet.
    for (const r of rows) {
      const look = await lena('POST', '/api/v1/discovery/plugin-jobs/lookup', { recommendation: r });
      assert.equal(look.status, 200, `${r.title}: ${JSON.stringify(look.body)}`);
      assert.deepEqual(look.body.jobs, []);
      assert.deepEqual(Object.keys(look.body.keys).sort(), ['album', 'artist', 'artist-missing', 'folder', 'song']);
    }
  });

  test('federation-play resolves every row to the stream proxy URL, and that URL plays the file on B byte for byte', async (t) => {
    const rows = await peerRows();
    const t0 = Date.now();
    for (const r of rows) {
      const res = await lena('POST', '/api/v1/discovery/plugins/federation-play/resolve', { recommendation: r });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const play = res.body.result.play;
      assert.ok(play, `${r.title}: a play answer`);
      assert.equal(play.kind, 'stream');
      assert.equal(play.url, `/api/v1/federation/peers/${peerId}/stream/${r.filepath.split('/').map(encodeURIComponent).join('/')}`);
      assert.deepEqual(play.peer, { id: peerId, name: PEER_NAME });
      const s = await fetch(`${srvA.baseUrl}${play.url}`, { headers: { 'x-access-token': tokens.lena } });
      assert.equal(s.status, 200, `${r.title}: the stream answers`);
      const bytes = Buffer.from(await s.arrayBuffer());
      assert.ok(bytes.equals(fs.readFileSync(path.join(peerDir, bByTitle.get(r.title).rel))), `${r.title}: the bytes are B's file`);
    }
    t.diagnostic(`resolve + full stream of ${rows.length} rows: ${Date.now() - t0} ms`);
  });

  test('links resolves every row from its artist + title', async () => {
    for (const r of await peerRows()) {
      const res = await lena('POST', '/api/v1/discovery/plugins/links/resolve', { recommendation: r });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const deezer = res.body.result.links.find((l) => l.id === 'deezer-search');
      assert.ok(deezer, `${r.title}: a Deezer search link`);
      assert.equal(deezer.url, `https://www.deezer.com/search/${encodeURIComponent(`${r.artist} ${r.title}`)}`);
    }
  });

  test('deezer and itunes previews resolve every row (local catalogue mocks)', async () => {
    const rows = await peerRows();
    for (const r of rows) {
      for (const name of ['deezer', 'itunes']) {
        const res = await lena('POST', `/api/v1/discovery/plugins/${name}/resolve`, { recommendation: r });
        assert.equal(res.status, 200, `${name} ${r.title}: ${JSON.stringify(res.body)}`);
        const p = res.body.result.preview;
        assert.ok(p, `${name} ${r.title}: a preview`);
        assert.equal(p.provider, name);
        assert.equal(p.title, r.title);
        assert.equal(p.artist, r.artist);
      }
    }
    assert.ok(mockSeen.some((u) => u.startsWith('/search?q=')), 'Deezer was asked');
    assert.ok(mockSeen.some((u) => u.startsWith('/search?term=')), 'iTunes was asked');
  });

  test('song copy: a row as-is lands in A\'s collection, plays from A, and badges', async (t) => {
    const row = (await peerRows()).find((r) => r.title === 'Ferry One');
    const { job, ms } = await copyJob(row);
    jobsMade.song = job;
    songKeptAt = Date.now();
    assert.equal(job.state, 'done', `job error: ${job.error}`);
    assert.deepEqual(job.params, { destination: { vpath: 'collection', base: 'From peers', layout: '{{ARTIST}}/{{ALBUM}}', source: 'user' } }, 'a song job, pinned to lena\'s destination');
    const c = job.result.copied;
    assert.ok(c, JSON.stringify(job.result));
    assert.equal(c.filepath, 'collection/From peers/Nova/Night Ferry/01 - Ferry One.mp3');
    const onDisk = path.join(collectionDir, 'From peers', 'Nova', 'Night Ferry', '01 - Ferry One.mp3');
    const original = fs.readFileSync(path.join(peerDir, bByTitle.get('Ferry One').rel));
    assert.ok(fs.readFileSync(onDisk).equals(original), 'byte for byte on disk');
    const dbRow = aRow(`SELECT t.source, t.title FROM tracks t JOIN libraries l ON l.id = t.library_id
      WHERE l.name = 'collection' AND REPLACE(t.filepath, '\\', '/') = ?`, 'From peers/Nova/Night Ferry/01 - Ferry One.mp3');
    assert.deepEqual({ ...dbRow }, { source: COPY, title: 'Ferry One' }, 'a row in A\'s db');
    const media = await mediaBytes(c.filepath);
    assert.equal(media.status, 200);
    assert.ok(media.bytes.equals(original), 'A serves the copy');

    // The badge: the row as-is finds the job under its song key.
    const batch = await lena('POST', '/api/v1/discovery/plugin-jobs/lookup/batch', { recommendations: firstRows });
    assert.equal(batch.status, 200, JSON.stringify(batch.body));
    const i = firstRows.findIndex((r) => r.title === 'Ferry One');
    const found = batch.body.results[i];
    assert.equal(found.key, job.key);
    assert.ok(found.jobs.some((j) => j.id === job.id && j.state === 'done'), JSON.stringify(found));
    for (const [k, r] of batch.body.results.entries()) {
      if (k !== i) { assert.ok(!r.jobs.some((j) => j.id === job.id), `${firstRows[k].title} does not carry the song job`); }
    }
    t.diagnostic(`song job: ${ms} ms`);
  });

  test('kept: the very next answer no longer recommends the copied song — no wait for the novelty TTL', async (t) => {
    assert.ok(songKeptAt, 'the song test kept Ferry One');
    // The copy's row is written on the server's own connection, which
    // PRAGMA data_version ignores; the insert itself refreshes the novelty
    // sets (insert-downloaded-track.js → invalidateIdentityCache), so the
    // 60 s TTL (db/discovery-novelty.js) is not what lets it go. The earlier
    // cases asked for answers moments ago, so the sets were warm.
    const now = await peerRows();
    assert.ok(!now.some((r) => r.title === 'Ferry One'), 'the kept song is gone at once');
    assert.ok(now.some((r) => r.title === 'Ferry Two') && now.some((r) => r.title === 'Ferry Three'), 'the rest of its album is still recommended');
    t.diagnostic(`the kept song left the peers section ${Date.now() - songKeptAt} ms after its copy, on the first answer asked`);
  });

  test('album copy: an album card\'s best row as-is copies the peer\'s album, skipping the song already kept', async (t) => {
    const cards = albumCards(await peerRows());
    const card = cards.find((c) => c.album === 'Night Ferry');
    assert.ok(card, 'a Night Ferry card');
    // Ferry One, kept by the song test, has left the answer.
    assert.deepEqual(card.raws.map((r) => r.title), ['Ferry Two', 'Ferry Three'], 'the card\'s rows, best first');
    const { job, ms } = await copyJob(card.raws[0], 'album');
    jobsMade.album = job;
    assert.equal(job.state, 'done', `job error: ${job.error}`);
    assert.deepEqual(job.params, { scope: 'album', destination: { vpath: 'collection', base: 'From peers', layout: '{{ARTIST}}/{{ALBUM}}', source: 'user' } });
    const res = job.result;
    assert.equal(res.scope, 'album');
    assert.deepEqual(res.album, { name: 'Night Ferry', artist: 'Nova', albumArtist: 'Nova', year: 2019 },
      'listed by the album\'s credit (Nova\'s own album: the same songs the track artist would list)');
    assert.deepEqual(res.counts, { total: 3, copied: 2, skipped: 1, failed: 0 }, JSON.stringify(res.songs));
    assert.equal(res.songs.skipped[0].why, 'owned');
    for (const s of res.songs.copied) {
      const rel = s.filepath.slice('collection/'.length);
      assert.ok(fs.existsSync(path.join(collectionDir, rel)), `${rel} on disk`);
      assert.equal((await mediaBytes(s.filepath)).status, 200, `${s.filepath} plays from A`);
    }
    // Every row of the card shares the album key (the kept song's row too —
    // its credit is the same album's, and the key is the one Nova's album
    // had before rows carried a credit: the badges test asks with the rows
    // as first drawn).
    const look = await lena('POST', '/api/v1/discovery/plugin-jobs/lookup/batch', { recommendations: card.raws });
    for (const [k, r] of look.body.results.entries()) {
      assert.equal(r.keys.album, job.key, `${card.raws[k].title}: the album key`);
      assert.ok(r.jobs.some((j) => j.id === job.id), `${card.raws[k].title}: carries the album job`);
    }
    t.diagnostic(`album job: ${ms} ms`);
  });

  test('artist-missing: a row as-is copies the artist\'s albums A lacks, leaving out the one it has', async (t) => {
    const row = (await peerRows()).find((r) => r.title === 'Wind One');
    assert.ok(row, 'Wind One is still recommended');
    const { job, ms } = await copyJob(row, 'artist-missing');
    jobsMade.artistMissing = job;
    assert.equal(job.state, 'done', `job error: ${job.error}`);
    const res = job.result;
    assert.equal(res.scope, 'artist-missing');
    assert.deepEqual(res.skippedAlbums.map((a) => [a.name, a.why]), [['Night Ferry', 'owned']]);
    assert.deepEqual(res.albums.map((a) => a.name), ['Second Wind']);
    assert.deepEqual(res.counts, { total: 2, copied: 2, skipped: 0, failed: 0 }, JSON.stringify(res.songs));
    for (const s of res.songs.copied) { assert.equal((await mediaBytes(s.filepath)).status, 200, `${s.filepath} plays from A`); }
    t.diagnostic(`artist-missing job: ${ms} ms`);
  });

  test('artist: a row as-is (as the page first drew it) walks every album of the artist; all of it is kept by now', async (t) => {
    const row = firstRows.find((r) => r.title === 'Ferry Two');
    const { job, ms } = await copyJob(row, 'artist');
    jobsMade.artist = job;
    assert.equal(job.state, 'done', `job error: ${job.error}`);
    const res = job.result;
    assert.equal(res.scope, 'artist');
    assert.deepEqual(res.albums.map((a) => a.name).sort(), ['Night Ferry', 'Second Wind']);
    assert.deepEqual(res.skippedAlbums, [], 'Nova is on no compilation here');
    assert.deepEqual(res.counts, { total: 5, copied: 0, skipped: 5, failed: 0 }, JSON.stringify(res.songs));
    assert.ok(res.songs.skipped.every((s) => s.why === 'owned'));
    t.diagnostic(`artist job: ${ms} ms`);
  });

  test('compilation: an album job from ONE row copies the whole album, both track artists, and every row of it finds that one job', async (t) => {
    const rows = await peerRows();
    const cards = albumCards(rows);
    const kim = cards.find((c) => c.album === 'Mixtape Vol 1' && c.artist === 'Peer Kim');
    const lou = cards.find((c) => c.album === 'Mixtape Vol 1' && c.artist === 'Peer Lou');
    assert.ok(kim && lou, 'a client grouping by peer + album + TRACK artist draws one card per track artist');
    const [kimRow, louRow] = [kim.raws[0], lou.raws[0]];
    assert.equal(kimRow.albumArtist, 'Various Artists');
    assert.equal(louRow.albumArtist, 'Various Artists');

    // Either card asks for ONE album job: the key is the album's credit's.
    const before = await lena('POST', '/api/v1/discovery/plugin-jobs/lookup/batch', { recommendations: [kimRow, louRow] });
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.equal(before.body.results[0].keys.album, before.body.results[1].keys.album, 'one album key for both rows');
    assert.notEqual(before.body.results[0].keys.artist, before.body.results[1].keys.artist, 'each keeps its own artist key');

    // A row as-is: the peer lists the album by its credit, not by the
    // track artist — the whole compilation comes.
    const { job, ms } = await copyJob(kimRow, 'album');
    jobsMade.comp = job;
    assert.equal(job.state, 'done', `job error: ${job.error}`);
    assert.equal(job.key, before.body.results[0].keys.album);
    assert.deepEqual(job.result.album, { name: 'Mixtape Vol 1', artist: 'Peer Kim', albumArtist: 'Various Artists', year: 2020 });
    assert.deepEqual(job.result.counts, { total: 2, copied: 2, skipped: 0, failed: 0 }, JSON.stringify(job.result.songs));
    assert.deepEqual(job.result.songs.copied.map((x) => x.from), [
      'peerlib/Various Artists/Mixtape Vol 1/01 - Kim Song.mp3',
      'peerlib/Various Artists/Mixtape Vol 1/02 - Lou Song.mp3',
    ], 'both artists\' songs, in track order, from one row');
    for (const x of job.result.songs.copied) {
      assert.equal((await mediaBytes(x.filepath)).status, 200, `${x.filepath} plays from A`);
      assert.ok(fs.readFileSync(path.join(collectionDir, x.filepath.slice('collection/'.length)))
        .equals(fs.readFileSync(path.join(peerDir, x.from.slice('peerlib/'.length)))), `${x.from} byte for byte`);
    }

    // Both rows' badges find it, under their (shared) album key.
    const look = await lena('POST', '/api/v1/discovery/plugin-jobs/lookup/batch', { recommendations: [kimRow, louRow] });
    assert.equal(look.status, 200, JSON.stringify(look.body));
    for (const [k, r] of look.body.results.entries()) {
      const j = r.jobs.find((x) => x.id === job.id);
      assert.ok(j, `${[kimRow, louRow][k].title}: carries the album job`);
      assert.equal(j.key, r.keys.album);
    }
    // And both songs are kept: the next answer recommends neither.
    const after = await peerRows();
    assert.ok(!after.some((r) => r.album === 'Mixtape Vol 1'), 'the whole compilation left the answer at once');

    // An album job with no credit at all — neither the track's artist nor
    // the album's — is refused: an album NAME alone was every same-named
    // album on the peer, whoever made it.
    const blank = await lena('POST', JOBS, { recommendation: { ...louRow, artist: null, albumArtist: null }, scope: 'album' });
    assert.equal(blank.status, 400, JSON.stringify(blank.body));
    assert.match(blank.body.error, /album job needs the recommendation's artist/);
    t.diagnostic(`compilation album job: ${ms} ms`);
  });

  test('badges for the page as first drawn: one batch lookup over the original rows finds every job by its scope', async () => {
    const batch = await lena('POST', '/api/v1/discovery/plugin-jobs/lookup/batch', { recommendations: firstRows });
    assert.equal(batch.status, 200, JSON.stringify(batch.body));
    const has = (title, job) => batch.body.results[firstRows.findIndex((r) => r.title === title)].jobs.some((j) => j.id === job.id);
    assert.ok(has('Ferry One', jobsMade.song), 'song job on its row');
    for (const title of ['Ferry One', 'Ferry Two', 'Ferry Three']) { assert.ok(has(title, jobsMade.album), `album job on ${title}`); }
    // The artist scopes key on the artist: every Nova row carries both.
    for (const title of ['Ferry One', 'Ferry Two', 'Ferry Three', 'Wind One', 'Wind Two']) {
      assert.ok(has(title, jobsMade.artistMissing), `artist-missing job on ${title}`);
      assert.ok(has(title, jobsMade.artist), `artist job on ${title}`);
    }
    assert.ok(!has('Kim Song', jobsMade.artist) && !has('Lou Song', jobsMade.artist), 'not on another artist\'s rows');
    assert.ok(has('Kim Song', jobsMade.comp) && has('Lou Song', jobsMade.comp), 'the compilation\'s one album job on both its rows');
    assert.ok(!has('Ferry One', jobsMade.comp), 'and on no other album\'s row');
  });

  // ── What a client must handle itself (server behaviour, on C's rows) ──

  test('an artist-less row: no artist or album keys, and every artist and album job on it is refused; a tagged row of a same-named album copies only its own credit\'s album', async (t) => {
    const [untagged, other, third] = ['Untagged Hit', 'Other Hit', 'Third Hit'].map((title) => firstCRows.find((r) => r.title === title));
    assert.ok(untagged && other && third, 'the three "Greatest Hits" rows');
    assert.equal(untagged.artist, null, 'the responder sends no artist for an untagged file');
    assert.equal(untagged.albumArtist, null, '…and no album credit: its album has none');
    assert.equal(untagged.album, 'Greatest Hits');
    const look = await lena('POST', '/api/v1/discovery/plugin-jobs/lookup', { recommendation: untagged });
    assert.equal(look.status, 200, JSON.stringify(look.body));
    assert.deepEqual(Object.keys(look.body.keys).sort(), ['folder', 'song'], 'no credit, no artist or album keys');
    // An album NAME alone was every album of that name on the peer, across
    // artists (until 2026-10-19 this row's album job copied all three):
    // refused, like the artist scopes.
    for (const scope of ['album', 'artist', 'artist-missing']) {
      const r = await lena('POST', JOBS, { recommendation: untagged, scope });
      assert.equal(r.status, 400, `${scope}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /needs the recommendation's artist/);
    }

    // A tagged row of a same-named album: the peer lists the album by that
    // row's credit, so the other two artists' "Greatest Hits" stay put.
    assert.equal(other.albumArtist, 'Other Band');
    const { job, ms } = await copyJob(other, 'album');
    jobsMade.otherAlbum = job;
    assert.equal(job.state, 'done', `job error: ${job.error}`);
    assert.deepEqual(job.result.album, { name: 'Greatest Hits', artist: 'Other Band', albumArtist: 'Other Band', year: 2000 });
    assert.deepEqual(job.result.counts, { total: 1, copied: 1, skipped: 0, failed: 0 }, JSON.stringify(job.result.songs));
    assert.deepEqual(job.result.songs.copied.map((x) => x.from), ['ceelib/Other Band/Greatest Hits/01 - Other Hit.mp3']);

    // Its key is Other Band's album: it badges that row, and neither the
    // artist-less row (no album key at all) nor Third Band's.
    const batch = await lena('POST', '/api/v1/discovery/plugin-jobs/lookup/batch', { recommendations: [untagged, other, third] });
    assert.equal(batch.status, 200, JSON.stringify(batch.body));
    const [u, o, th] = batch.body.results;
    assert.equal(u.keys.album, undefined);
    assert.ok(!u.jobs.some((j) => j.id === job.id), 'the artist-less row does not carry it');
    assert.equal(o.keys.album, job.key);
    assert.ok(o.jobs.some((j) => j.id === job.id), 'Other Hit\'s row carries it');
    assert.notEqual(th.keys.album, job.key, 'Third Band\'s album has a key of its own');
    assert.ok(!th.jobs.some((j) => j.id === job.id));
    t.diagnostic(`same-named album job: ${ms} ms`);
  });

  test('two peers, one album: B\'s and C\'s "Second Wind" rows share keys.album and the artist keys, so one peer\'s job comes back on the other peer\'s rows — why a client filters badges by peer', async (t) => {
    const bWind = ['Wind One', 'Wind Two'].map((title) => firstRows.find((r) => r.title === title));
    const cWind = firstCRows.find((r) => r.title === 'Wind Three');
    assert.ok(cWind, 'C\'s Wind Three row');
    // A client draws two cards: its album strip groups by peer + album + artist.
    const cards = albumCards([...firstRows, ...firstCRows]).filter((c) => c.album === 'Second Wind');
    assert.deepEqual(cards.map((c) => c.raws[0].peer.id).sort((a, b) => a - b), [peerId, cPeerId].sort((a, b) => a - b), 'one card per peer');

    // …whose rows ask for ONE album key and one key per artist scope.
    const look = await lena('POST', '/api/v1/discovery/plugin-jobs/lookup/batch', { recommendations: [...bWind, cWind] });
    assert.equal(look.status, 200, JSON.stringify(look.body));
    const [b1, b2, c] = look.body.results;
    for (const k of ['album', 'artist', 'artist-missing']) {
      assert.equal(b1.keys[k], c.keys[k], `keys.${k} carries no peer`);
      assert.equal(b2.keys[k], c.keys[k], `keys.${k} carries no peer`);
    }
    assert.notEqual(b1.keys.folder, c.keys.folder, 'only the folder key names the peer');
    // B's artist jobs (the proof's, started from B's rows) already come back
    // on C's row.
    for (const [label, made] of [['artist-missing', jobsMade.artistMissing], ['artist', jobsMade.artist]]) {
      const j = c.jobs.find((x) => x.id === made.id);
      assert.ok(j, `B's ${label} job on C's row`);
      assert.equal(j.recommendation.peer.id, peerId, `the ${label} job names B`);
    }

    // An album copy from C's card copies C's one song…
    const { job, ms } = await copyJob(cWind, 'album');
    jobsMade.cAlbum = job;
    assert.equal(job.state, 'done', `job error: ${job.error}`);
    assert.deepEqual(job.result.counts, { total: 1, copied: 1, skipped: 0, failed: 0 }, JSON.stringify(job.result.songs));
    assert.deepEqual(job.result.songs.copied.map((s) => s.from), ['ceelib/Nova/Second Wind/03 - Wind Three.mp3']);
    // …and is from now on the album job of B's rows too. A client that drew
    // whatever job the lookup returns would badge B's card with C's copy (on
    // the stage, a false "in your collection" while B still held songs A
    // lacked). Only the job's own recommendation names its peer.
    const later = await lena('POST', '/api/v1/discovery/plugin-jobs/lookup/batch', { recommendations: bWind });
    assert.equal(later.status, 200, JSON.stringify(later.body));
    for (const [k, r] of later.body.results.entries()) {
      const j = r.jobs.find((x) => x.id === job.id);
      assert.ok(j, `${bWind[k].title}: carries C's album job`);
      assert.equal(j.key, r.keys.album, `${bWind[k].title}: under its album key`);
      assert.equal(j.recommendation.peer.id, cPeerId, 'the job names C');
      assert.notEqual(j.recommendation.peer.id, bWind[k].peer.id, 'not the row\'s peer');
    }
    t.diagnostic(`C album job: ${ms} ms`);
  });

  test('copies switched off on C for A\'s key: a song job and an album job end "done" with stopped \'refused\' and nothing copied — done is not kept, and no failure to retry; the row still plays', async (t) => {
    const row = firstCRows.find((r) => r.title === 'Solo One');
    assert.ok(row, 'C\'s Solo One row');
    // The live per-key edit (V77 allow_copies), every other limit as minted.
    const setCopies = (allowCopies) => call(srvC, 'POST', `/api/v1/admin/federation/keys/${cKey.id}/limits`,
      { streamKbps: cKey.streamKbps, dailyMb: cKey.dailyMb, maxStreams: cKey.maxStreams, allowCopies });
    const off = await setCopies(false);
    assert.equal(off.status, 200, JSON.stringify(off.body));
    try {
      const song = await copyJob(row);
      jobsMade.refusedSong = song.job;
      assert.equal(song.job.state, 'done', `job error: ${song.job.error}`);
      assert.deepEqual([song.job.result.stopped, song.job.result.peer.id, song.job.result.copied], ['refused', cPeerId, undefined], JSON.stringify(song.job.result));

      const album = await copyJob(row, 'album');
      jobsMade.refusedAlbum = album.job;
      assert.equal(album.job.state, 'done', `job error: ${album.job.error}`);
      assert.equal(album.job.result.stopped, 'refused');
      assert.deepEqual(album.job.result.counts, { total: 1, copied: 0, skipped: 0, failed: 1 }, JSON.stringify(album.job.result.songs));
      assert.match(album.job.result.songs.failed[0].error, /does not allow copies/);

      // What a badge lookup hands a client: a DONE song job and a DONE
      // album job, both refused, that kept nothing.
      const look = await lena('POST', '/api/v1/discovery/plugin-jobs/lookup', { recommendation: row });
      assert.equal(look.status, 200, JSON.stringify(look.body));
      const a = look.body.jobs.find((j) => j.id === album.job.id);
      assert.ok(a, JSON.stringify(look.body.jobs));
      assert.equal(a.state, 'done');
      assert.equal(a.result.stopped, 'refused');
      assert.equal(a.result.counts.copied, 0);
      assert.ok(look.body.jobs.some((j) => j.id === song.job.id && j.state === 'done' && j.result.stopped === 'refused'), 'the song job, refused');

      // Only copies are refused: the stream proxy still plays the row.
      const t0 = Date.now();
      const play = await lena('POST', '/api/v1/discovery/plugins/federation-play/resolve', { recommendation: row });
      assert.equal(play.status, 200, JSON.stringify(play.body));
      const s = await fetch(`${srvA.baseUrl}${play.body.result.play.url}`, { headers: { 'x-access-token': tokens.lena } });
      assert.equal(s.status, 200);
      assert.ok(Buffer.from(await s.arrayBuffer()).equals(fs.readFileSync(path.join(ceeDir, cByTitle.get('Solo One').rel))), 'C\'s bytes');
      t.diagnostic(`refused song job: ${song.ms} ms; refused album job: ${album.ms} ms; play: ${Date.now() - t0} ms`);
    } finally {
      const on = await setCopies(true);
      assert.equal(on.status, 200, JSON.stringify(on.body));
    }
    assert.ok(!fs.existsSync(path.join(collectionDir, 'From peers', 'Cee Solo')), 'nothing landed');
  });

  test('every file landed in the per-run collection library; the fixture library is untouched', () => {
    assert.deepEqual(tree(srvA.musicDir), fixtureBefore, 'no file added to testlib');
    const landed = tree(collectionDir).map((p) => p.split(path.sep).join('/'));
    assert.deepEqual(landed, [
      'From peers/Nova/Night Ferry/01 - Ferry One.mp3',
      'From peers/Nova/Night Ferry/02 - Ferry Two.mp3',
      'From peers/Nova/Night Ferry/03 - Ferry Three.mp3',
      'From peers/Nova/Second Wind/01 - Wind One.mp3',
      'From peers/Nova/Second Wind/02 - Wind Two.mp3',
      'From peers/Nova/Second Wind/03 - Wind Three.mp3',
      'From peers/Other Band/Greatest Hits/01 - Other Hit.mp3',
      'From peers/Peer Kim/Mixtape Vol 1/01 - Kim Song.mp3',
      'From peers/Peer Lou/Mixtape Vol 1/02 - Lou Song.mp3',
    ], 'neither the artist-less song nor Third Band\'s same-named album came along');
  });
});
