#!/usr/bin/env node
/**
 * The Peer Recommendations stage: one mStream with a hand-staged discovery
 * network and a Deezer mock, for the clients' live walks — the webapp, the
 * phone (PH9) and the terminal (T9) all point at it
 * (docs/peer-recommendations-plan.md §3.9). Not a test: npm test never runs
 * it (no .test.mjs), and nothing here asserts.
 *
 *   node test/stage/peer-recs-stage.mjs [port=3995] [stateDir]
 *
 * It serves http://127.0.0.1:<port> and, once the accounts exist, the LAN
 * URL too, with the Deezer mock on <port>+1. It prints both URLs and the
 * PIDs it owns (its own, which hosts the mock, and the server's), then
 * reads controls on stdin. Ctrl-C, `quit` or a SIGTERM to the stage PID
 * stops the server and the mock; kill only those PIDs.
 *
 * Accounts (passwords in <stateDir>/stage-<port>/CREDENTIALS.txt, never
 * printed; kept across runs):
 *   stage-admin   admin, finished two Vosto songs
 *   stage-member  member, finished three Icarus songs
 *   stage-new     member, no plays (its leads come off the random seed)
 *
 * The network (no sidecar: the catalog and the shelf are files written
 * before boot, and a download copies a local blob). Hues are the ids' first
 * 6 hex mod 360, picked to land on the design's.
 *   Basement Hi-Fi    shelf, pinned, online      hue 210   5 leads
 *   Kitchen Radio     shelf, pinned, online      hue  25   5 leads (with ISRCs)
 *   mStream           shelf, pinned, offline     hue 140   2 leads; id 3f9a…, so 'mStream · 3f9a'
 *   Attic Tapes       shelf, UNPINNED, offline the longest: the one an Add swaps out
 *   Lighthouse Tapes  catalog, online   Add lands after swapping Attic Tapes out
 *   Static Garden     catalog, online   Add stays 'adding' for 120 s
 *   Rooftop FM        catalog, online   Add fails 'offline'
 * The shelf cap is 10 MB with 8 MB held, so Lighthouse (3 MB) needs one
 * swap and, after it, Static (3 MB) fits. The leads are DECISIONS §3's twelve
 * and nothing else: Attic, Lighthouse and Static hold only songs this
 * library owns, which the walk drops. Every lead shares one direction in
 * the library's plane, so any seed ranks them in DECISIONS order.
 *
 * Mocks: Deezer on <port>+1 answers /track/isrc:<isrc> and /search with one
 * track per lead: a 30 s sine preview and, for Night Ferry, a two-tone cover
 * (earned art). Arcade Rain finds no match; Quiet Engine answers 429 once
 * (again after `reset`). iTunes is off, links is on, and the test-only
 * noop-acquire plug-in gives Get it… something to run; every account's
 * collection destination is the scratch `copies` library.
 *
 * Controls (stdin, one per line; any unique prefix of a peer name works):
 *   offline <name> / online <name>   rewrite the catalog's updatedAt, restart
 *   restart                          same state dir and port (Add states go)
 *   pin-all / unpin <name>           the shelf's pins, live
 *   empty-shelf                      remove every shelf snapshot, live
 *   p2p-off                          the admin route's disable, live; a
 *                                    restart keeps it (the route persisted it)
 *   p2p-on                           discoveryP2p.enabled true in the config,
 *                                    and restart
 *   reset                            the network as staged, p2p on, and restart
 *   quit                             stop the server and the mock
 *
 * p2p-on stands in for a successful enable: the real one (the Peer
 * Recommendations page's Turn on, POST /api/v1/admin/discovery/p2p/enabled
 * {enabled:true}) answers 500 "failed to start the discovery network:
 * p2p-sidecar switched off for this run (MSTREAM_TEST_P2P_NO_SIDECAR)" here,
 * which is the live check's error path.
 *
 * Safety:
 *   - MSTREAM_TEST_P2P_NO_SIDECAR=1, and it refuses to start if
 *     resolveSidecarBinary() still finds a binary, so it runs from any
 *     checkout (the main one holds bin/p2p-sidecar/…);
 *   - dead MSTREAM_SIDECAR_BASE / PLAYER / MUSICBRAINZ / COVERARTARCHIVE /
 *     ITUNES / RELEASE / YTDLP and lyrics bases; MSTREAM_TEST_BAKED_SEEDS='[]',
 *     useCommunitySeeds false, bootstrapPeers [], a dead seedListUrl;
 *     autoAlbumArt false (the Deezer base is shared with the album-art
 *     downloader), no update check, no mDNS, federation and iroh off;
 *   - the libraries are test/fixtures/music and a scratch `copies` folder,
 *     never ~/code/mstream-demo-music;
 *   - the server listens on loopback until the accounts exist, then on
 *     0.0.0.0 (login required from then on);
 *   - state lives in stateDir (default <os tmpdir>/mstream-peer-recs-stage),
 *     never in the repo. stage-<port>/ is wiped at every start but for its
 *     CREDENTIALS.txt; assets/ (previews, cover) is kept.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ensureFixtures } from '../helpers/fixtures.mjs';
import { BUNDLED_FFMPEG, assertFfmpegAvailable } from '../helpers/ffmpeg.mjs';
import { stagePeers, catalogPath } from '../helpers/p2p-shelf.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEMO = path.join(os.homedir(), 'code', 'mstream-demo-music');
const PORT = Number(process.argv[2] || 3995);
const MOCK_PORT = PORT + 1;
const ROOT = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'mstream-peer-recs-stage'));
const STAGE = path.join(ROOT, `stage-${PORT}`);
const ASSETS = path.join(ROOT, 'assets');
const DB_DIR = path.join(STAGE, 'db');
const FAKE_DIR = path.join(STAGE, 'fake-fetch');
const COPIES = path.join(STAGE, 'copies');
const CONFIG_PATH = path.join(STAGE, 'config.json');
const CREDENTIALS = path.join(STAGE, 'CREDENTIALS.txt');
const CONSOLE_LOG = path.join(STAGE, 'server-console.log');
const BASE = `http://127.0.0.1:${PORT}`;
const DEAD = 'http://127.0.0.1:9';

const MB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const YEAR = 365 * DAY;
// Online = heard within a year, so a catalog written at start stays as
// staged for the whole run (the stack never starts, so nothing re-hears or
// prunes a peer).
const ONLINE_WINDOW_MS = YEAR;
const STATIC_DELAY_MS = 120000;

const log = (...a) => console.log('[stage]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The network ──────────────────────────────────────────────────────────

// 64 hex: `prefix` (which sets the hue) and a stable tail.
const endpointId = (prefix, name) =>
  prefix + crypto.createHash('sha256').update(`peer-recs-stage:${name}`).digest('hex').slice(prefix.length);

// The fixture library's vectors (4-d, in the x-y plane; the taste suite's).
const LIBRARY_VECTORS = {
  'Be Somebody': [1, 0, 0, 0],
  'Rise': [0.95, 0.312, 0, 0],
  'Orbit': [0.9, 0.436, 0, 0],
  'Return': [0.7, 0.714, 0, 0],
  'Descent': [0.6, 0.8, 0, 0],
  'Highway': [0, 1, 0, 0],
  'Static': [0.2, 0.98, 0, 0],
  'Neon': [0.5, 0.866, 0, 0],
  'Sketch 1': [0.3, 0.954, 0, 0],
};
const owned = (artist, title) => ({ artist, title, vec: LIBRARY_VECTORS[title] });

// DECISIONS §3, in its order: [peer, artist, title, album, length].
const LEAD_ROWS = [
  ['Basement Hi-Fi', 'Hollow Coast', 'Salt Road', 'Low Tide Hymns', '3:42'],
  ['Basement Hi-Fi', 'Hollow Coast', 'Breakwater', 'Low Tide Hymns', '4:05'],
  ['Kitchen Radio', 'Paper Lantern', 'Signal Fires', 'Night Ferry', '3:18'],
  ['Kitchen Radio', 'Paper Lantern', 'Harbor Lights', 'Night Ferry', '2:57'],
  ['Basement Hi-Fi', 'Tidewater', 'Glass Season', 'Undertow', '4:21'],
  ['mStream', 'Tidewater', 'Quiet Engine', 'Undertow', '3:33'],
  ['Kitchen Radio', 'Marlowe Fields', 'Long Exposure', 'Daylight Savings', '3:50'],
  ['Basement Hi-Fi', 'Juniper Static', 'Arcade Rain', 'Neon Psalms', '2:44'],
  ['mStream', 'The Vesper Lines', 'Paper Moons', 'Small Hours', '3:12'],
  ['Kitchen Radio', 'Okra Bloom', 'Sunday Wire', 'Porchlight', '4:08'],
  ['Basement Hi-Fi', 'Kestrel & Vine', 'Copper Dawn', null, '3:01'],
  ['Kitchen Radio', 'Ada Merrow', 'Field Notes', 'Cartography', '3:27'],
];

// A lead's vector: the in-plane direction (1, 1)/√2 at length m, the rest
// off the plane. Every library vector (and so every seed and centroid) is
// in the plane's positive quadrant, so a lead scores m × (the same factor
// for all) against any query: the rank order is m's, and m < 0.99 keeps
// every lead under the near-duplicate cut.
function leadVector(rank) {
  const m = 0.975 - 0.01 * rank;
  const off = Math.sqrt(1 - m * m);
  const turn = 0.5 + 0.45 * rank;
  return [m / Math.SQRT2, m / Math.SQRT2, off * Math.cos(turn), off * Math.sin(turn)];
}

const seconds = (mmss) => { const [m, s] = mmss.split(':').map(Number); return m * 60 + s; };
const LEADS = LEAD_ROWS.map(([peer, artist, title, album, length], rank) => ({
  peer, artist, title, album, duration: seconds(length), rank,
  // Kitchen Radio's leads carry ISRCs (the mock's /track/isrc path); the
  // rest go through its search.
  isrc: peer === 'Kitchen Radio' ? `QZPRS26${String(rank + 1).padStart(5, '0')}` : null,
  vec: leadVector(rank),
}));
const leadsOf = (peer) => LEADS.filter((l) => l.peer === peer);

const PEERS = [
  { name: 'Basement Hi-Fi', prefix: 'ba5eaa', held: { pinned: true, sizeBytes: 2 * MB, tracks: leadsOf('Basement Hi-Fi') } },
  { name: 'Kitchen Radio', prefix: 'cafea9', held: { pinned: true, sizeBytes: 2 * MB, tracks: leadsOf('Kitchen Radio') } },
  { name: 'mStream', prefix: '3f9a1c', heardAgoMs: 2 * YEAR, held: { pinned: true, sizeBytes: MB, tracks: leadsOf('mStream') } },
  {
    name: 'Attic Tapes', prefix: 'a771c0', heardAgoMs: 3 * YEAR,
    held: { pinned: false, sizeBytes: 3 * MB, heldForMs: 90 * DAY, tracks: [owned('Icarus', 'Rise'), owned('Vosto', 'Highway')] },
  },
  { name: 'Lighthouse Tapes', prefix: '11fe90', size: 3 * MB, rowCount: 9400, blob: { tracks: [owned('Icarus', 'Orbit'), owned('Vosto', 'Neon')] } },
  {
    name: 'Static Garden', prefix: '57a76a', size: 3 * MB, rowCount: 7000,
    blob: { tracks: [owned('Icarus', 'Return'), owned('Vosto', 'Static')], delayMs: STATIC_DELAY_MS },
  },
  { name: 'Rooftop FM', prefix: 'f00f70', size: MB, rowCount: 3100, blob: { fail: true } },
].map((p) => ({ ...p, id: endpointId(p.prefix, p.name) }));

const SHELF_CAP_MB = 10;

// The whole network back to what the header describes: shelf files and
// registry, the catalog, the fake-fetch blobs. Server stopped (it holds the
// registry and the catalog in memory once read).
function stageNetwork() {
  for (const dir of ['discovery-peers', 'discovery-p2p']) {
    fs.rmSync(path.join(DB_DIR, dir), { recursive: true, force: true });
  }
  fs.rmSync(FAKE_DIR, { recursive: true, force: true });
  const strip = ({ artist, title, album = null, duration, isrc = null, vec }) => ({ artist, title, album, duration, isrc, vec });
  stagePeers({
    dbDir: DB_DIR,
    fakeDir: FAKE_DIR,
    peers: PEERS.map((p) => ({
      id: p.id,
      name: p.name,
      heardAgoMs: p.heardAgoMs ?? 0,
      size: p.held ? p.held.sizeBytes : p.size,
      rowCount: p.rowCount,
      shelf: p.held && { ...p.held, tracks: p.held.tracks.map(strip) },
      blob: p.blob && { ...p.blob, tracks: p.blob.tracks?.map(strip) },
    })),
  });
  // So a client walk or a script can name a peer by id without asking.
  fs.writeFileSync(path.join(STAGE, 'peers.json'),
    JSON.stringify(PEERS.map((p) => ({ name: p.name, endpointId: p.id })), null, 2));
}

// ── Pre-flight ───────────────────────────────────────────────────────────

function refuse(why) {
  console.error(`[stage] refusing to start: ${why}`);
  process.exit(1);
}

const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
// Symlinks resolved (/tmp is /private/tmp here) on the part that exists, so
// the checks run before anything is created.
function real(p) {
  const rest = [];
  let at = path.resolve(p);
  for (;;) {
    try { return path.join(fs.realpathSync(at), ...rest); } catch { /* not there yet */ }
    const up = path.dirname(at);
    if (up === at) { return path.resolve(p); }
    rest.unshift(path.basename(at));
    at = up;
  }
}

if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65534) { refuse(`bad port ${process.argv[2]}`); }
if (inside(real(ROOT), real(REPO))) { refuse(`the state dir ${ROOT} is inside the repo`); }
if (inside(real(ROOT), real(DEMO))) { refuse(`the state dir ${ROOT} is inside ${DEMO}`); }
fs.mkdirSync(ROOT, { recursive: true });

process.env.MSTREAM_TEST_P2P_NO_SIDECAR = '1';
{
  const p2p = await import(pathToFileURL(path.join(REPO, 'src', 'state', 'discovery-p2p.js')).href);
  const binary = p2p.resolveSidecarBinary();
  if (binary) { refuse(`resolveSidecarBinary() still finds ${binary} under MSTREAM_TEST_P2P_NO_SIDECAR=1`); }
}

// macOS lets a wildcard bind succeed beside a loopback listener, so a port
// is free only when both binds work and nothing answers on loopback.
function canListen(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}
function answers(port) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
  });
}
for (const port of [PORT, MOCK_PORT]) {
  if (await answers(port) || !(await canListen(port, '127.0.0.1')) || !(await canListen(port, '0.0.0.0'))) {
    refuse(`port ${port} is in use`);
  }
}

const FIXTURES = await ensureFixtures();
assertFfmpegAvailable();

// ── Assets: the previews and the Night Ferry cover ───────────────────────

const ASSET_STAMP = JSON.stringify({ v: 1, leads: LEADS.length, cover: ['F29E4C', '2E3A59', 'FCE38A', 'FFFFFF'] });
const previewFile = (lead) => path.join(ASSETS, `preview-${lead.rank + 1}.mp3`);
const COVER_FILE = path.join(ASSETS, 'night-ferry.png');

function ffmpeg(args, what) {
  const r = spawnSync(BUNDLED_FFMPEG, ['-nostdin', '-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.status !== 0) { throw new Error(`ffmpeg failed on ${what}: ${r.stderr}`); }
}

function ensureAssets() {
  const stampFile = path.join(ASSETS, 'stamp.json');
  if (fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8') === ASSET_STAMP) { return; }
  fs.rmSync(ASSETS, { recursive: true, force: true });
  fs.mkdirSync(ASSETS, { recursive: true });
  for (const lead of LEADS) {
    // A pentatonic step per lead, so two previews never sound alike.
    const freq = Math.round(220 * 2 ** ([0, 2, 4, 7, 9][lead.rank % 5] / 12 + Math.floor(lead.rank / 5)));
    ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=30`, '-ac', '2', '-b:a', '96k',
      '-metadata', `title=${lead.title}`, '-metadata', `artist=${lead.artist}`, previewFile(lead)], lead.title);
  }
  // Two-tone ground, two squares (the design's earned-art cover).
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=0xF29E4C:s=250x250:d=0.1', '-vf',
    'drawbox=x=0:y=125:w=250:h=125:color=0x2E3A59:t=fill,drawbox=x=36:y=36:w=72:h=72:color=0xFCE38A:t=fill,'
    + 'drawbox=x=150:y=150:w=56:h=56:color=0xFFFFFF:t=fill', '-frames:v', '1', COVER_FILE], 'the cover');
  fs.writeFileSync(stampFile, ASSET_STAMP);
  log(`assets: ${LEADS.length} previews and a cover in ${ASSETS}`);
}
ensureAssets();

// ── The Deezer mock ──────────────────────────────────────────────────────

// Where a client fetches a preview or a cover: the LAN address when there
// is one (a phone on the LAN plays it too), else loopback. Read per answer,
// so a new address after a network change reaches the next lookup.
function lanAddress() {
  const ifaces = os.networkInterfaces();
  const names = Object.keys(ifaces).sort((a, b) => (a === 'en0' ? -1 : b === 'en0' ? 1 : 0));
  for (const name of names) {
    for (const a of ifaces[name] || []) {
      if (a.family === 'IPv4' && !a.internal) { return a.address; }
    }
  }
  return null;
}
const mediaBase = () => `http://${lanAddress() || '127.0.0.1'}:${MOCK_PORT}`;

let quietEngine429 = true;   // armed: the first Quiet Engine lookup gets a 429

function deezerTrack(lead) {
  const media = mediaBase();
  const id = 3995000 + lead.rank + 1;
  return {
    id, readable: true, type: 'track',
    title: lead.title, title_short: lead.title, duration: lead.duration, isrc: lead.isrc ?? undefined,
    link: `${media}/track/${id}`,
    preview: `${media}/preview/${lead.rank + 1}.mp3`,
    artist: { id: id + 1000, name: lead.artist },
    album: {
      id: id + 2000, title: lead.album ?? lead.title,
      ...(lead.album === 'Night Ferry' ? { cover_medium: `${media}/cover/night-ferry.png` } : {}),
    },
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

// A file with byte ranges (iOS's player asks for them before it plays).
function sendFile(req, res, file, type) {
  const size = fs.statSync(file).size;
  const head = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0;
  let end = size - 1;
  if (m && (m[1] !== '' || m[2] !== '')) {
    if (m[1] === '') { start = Math.max(0, size - Number(m[2])); } else {
      start = Number(m[1]);
      if (m[2] !== '') { end = Math.min(end, Number(m[2])); }
    }
    if (start > end) {
      res.writeHead(416, { ...head, 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...head, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}` });
  } else {
    res.writeHead(200, { ...head, 'Content-Length': size });
  }
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(file, { start, end }).pipe(res);
}

function mockRoute(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${MOCK_PORT}`);
  const p = decodeURIComponent(url.pathname);
  let m;
  if ((m = /^\/track\/isrc:(.+)$/.exec(p))) {
    const lead = LEADS.find((l) => l.isrc && l.isrc === m[1].toUpperCase());
    // Deezer answers "no data" as a 200 carrying an error.
    if (!lead) { sendJson(res, 200, { error: { type: 'DataException', message: 'no data', code: 800 } }); return; }
    sendJson(res, 200, deezerTrack(lead));
    return;
  }
  if (p === '/search') {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const lead = LEADS.find((l) => q.includes(l.title.toLowerCase()));
    if (lead && lead.title === 'Quiet Engine' && quietEngine429) {
      quietEngine429 = false;
      sendJson(res, 429, { error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 } });
      return;
    }
    const data = lead && lead.title !== 'Arcade Rain' ? [deezerTrack(lead)] : [];
    sendJson(res, 200, { data, total: data.length });
    return;
  }
  if ((m = /^\/preview\/(\d+)\.mp3$/.exec(p)) && LEADS[Number(m[1]) - 1]) {
    sendFile(req, res, previewFile(LEADS[Number(m[1]) - 1]), 'audio/mpeg');
    return;
  }
  if (p === '/cover/night-ferry.png') { sendFile(req, res, COVER_FILE, 'image/png'); return; }
  if ((m = /^\/track\/(\d+)$/.exec(p)) && LEADS[Number(m[1]) - 3995001]) {
    const lead = LEADS[Number(m[1]) - 3995001];
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>Deezer mock</title><p>Deezer mock: ${lead.artist} — ${lead.title}</p>`);
    return;
  }
  sendJson(res, 404, { error: { type: 'DataException', message: 'no data', code: 800 } });
}

const mock = http.createServer((req, res) => {
  try { mockRoute(req, res); } catch (err) { sendJson(res, 500, { error: { message: err.message } }); }
});
await new Promise((resolve, reject) => {
  mock.once('error', reject);
  mock.listen(MOCK_PORT, '0.0.0.0', resolve);
});

// ── The server ───────────────────────────────────────────────────────────

const USERS = [
  { username: 'stage-admin', admin: true, plays: ['Highway', 'Neon'] },
  { username: 'stage-member', admin: false, plays: ['Be Somebody', 'Rise', 'Orbit'] },
  { username: 'stage-new', admin: false, plays: [] },
];

function serverEnv() {
  const dead = ['MSTREAM_SIDECAR_BASE', 'MSTREAM_PLAYER_BASE', 'MSTREAM_MUSICBRAINZ_BASE', 'MSTREAM_COVERARTARCHIVE_BASE',
    'MSTREAM_ITUNES_BASE', 'MSTREAM_RELEASE_BASE', 'MSTREAM_YTDLP_BASE', 'MSTREAM_LRCLIB_BASE', 'MSTREAM_KUGOU_LYRICS_BASE',
    'MSTREAM_KUGOU_SEARCH_BASE', 'MSTREAM_NETEASE_BASE'];
  return {
    ...process.env,
    ...Object.fromEntries(dead.map((k) => [k, DEAD])),
    MSTREAM_DEEZER_BASE: `http://127.0.0.1:${MOCK_PORT}`,
    MSTREAM_TEST_BAKED_SEEDS: '[]',
    MSTREAM_TEST_P2P_NO_SIDECAR: '1',
    MSTREAM_TEST_P2P_FAKE_FETCH_DIR: FAKE_DIR,
    MSTREAM_TEST_DISCOVERY_ONLINE_WINDOW_MS: String(ONLINE_WINDOW_MS),
    MSTREAM_TEST_DISCOVERY_NOOP_PLUGIN: '1',
  };
}

function writeConfig() {
  const storage = {
    albumArtDirectory: path.join(STAGE, 'image-cache'),
    dbDirectory: DB_DIR,
    logsDirectory: path.join(STAGE, 'logs'),
    waveformCacheDirectory: path.join(STAGE, 'waveform-cache'),
  };
  for (const dir of Object.values(storage)) { fs.mkdirSync(dir, { recursive: true }); }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    port: PORT,
    address: '127.0.0.1',
    dlna: { mode: 'disabled' },
    discovery: { mdns: { enabled: false } },
    updates: { check: false },
    transcode: { autoUpdate: false },
    federation: { enabled: false },
    iroh: { enabled: false },
    folders: { testlib: { root: FIXTURES }, copies: { root: COPIES } },
    storage,
    scanOptions: {
      autoAlbumArt: false, collectDiscoveryData: true, discoveryModel: 'test-fake',
      analyzeBpm: false, analyzeAcoustid: false, generateWaveforms: false,
    },
    discoveryP2p: {
      enabled: true, autoFetch: false, maxPeerDbStorageMb: SHELF_CAP_MB, bootstrapPeers: [],
      seedListUrl: `${DEAD}/discovery-seeds.json`, useCommunitySeeds: false,
    },
    // A plug-in with no entry is off, the test-only one included.
    discoveryPlugins: {
      links: { enabled: true }, deezer: { enabled: true }, itunes: { enabled: false }, youtube: { enabled: false },
      'noop-acquire': { enabled: true },
    },
  }, null, 2));
}

// The server rewrites config.json (its JWT secret, the p2p switch), so a
// later change edits the file as it stands, with the server down.
function editConfig(edit) {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  edit(cfg);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
const setAddress = (address) => editConfig((cfg) => { cfg.address = address; });
// What a successful enable persists (the route forces collection on too;
// the stage already has it on).
const setP2pOn = () => editConfig((cfg) => { cfg.discoveryP2p.enabled = true; });

let server = null;          // the running server's ChildProcess
let adminToken = null;

function exitedWithin(proc, ms) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) { resolve(true); return; }
    const t = setTimeout(() => resolve(false), ms);
    proc.once('exit', () => { clearTimeout(t); resolve(true); });
  });
}

function consoleTail() {
  try { return fs.readFileSync(CONSOLE_LOG, 'utf8').split('\n').slice(-15).join('\n'); } catch { return ''; }
}

async function startServer() {
  const out = fs.openSync(CONSOLE_LOG, 'a');
  const proc = spawn(process.execPath, ['cli-boot-wrapper.js', '-j', CONFIG_PATH], {
    cwd: REPO, stdio: ['ignore', out, out], env: serverEnv(),
  });
  fs.closeSync(out);
  server = proc;
  proc.once('exit', (code, sig) => {
    if (server === proc) {
      server = null;
      log(`server ${proc.pid} exited (${code ?? sig}); "restart" boots it again`);
    }
  });
  for (let i = 0; ; i++) {
    if (server !== proc) { throw new Error(`the server exited during boot:\n${consoleTail()}`); }
    try { const r = await fetch(`${BASE}/api/`); if (r.status < 500) { break; } } catch { /* not up yet */ }
    if (i > 1800) { throw new Error('the server never answered'); }
    await sleep(100);
  }
  return proc;
}

async function stopServer() {
  const proc = server;
  if (!proc) { return; }
  server = null;
  proc.kill('SIGTERM');
  if (!(await exitedWithin(proc, 15000))) {
    proc.kill('SIGKILL');
    await exitedWithin(proc, 5000);
  }
}

async function api(method, route, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) { headers['x-access-token'] = token; }
  const r = await fetch(`${BASE}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function login(username) {
  const r = await api('POST', '/api/v1/auth/login', { body: { username, password: passwords[username] } });
  if (r.status !== 200 || !r.body?.token) { throw new Error(`login as ${username} failed: ${r.status}`); }
  return r.body.token;
}

// The boot scan's whole queue done (test/helpers/server.mjs's rule: count
// first, then the queue).
async function waitScan(token) {
  for (let i = 0; i < 1800; i++) {
    const status = await api('GET', '/api/v1/db/status', { token }).catch(() => null);
    if (status?.body?.totalFileCount > 0) {
      const q = (await api('GET', '/api/v1/scan/status', { token }).catch(() => null))?.body?.queue;
      if (q && !q.scanning && q.activeTask !== 'scan' && !q.queued.includes('scan')) { return status.body.totalFileCount; }
    }
    await sleep(100);
  }
  throw new Error('the boot scan never finished');
}

// Boot on the state as it stands; with accounts, log the admin in.
async function boot() {
  const proc = await startServer();
  adminToken = await login('stage-admin');
  await waitScan(adminToken);
  return proc;
}

// ── First run: accounts, vectors, plays ──────────────────────────────────

function loadPasswords() {
  const out = {};
  try {
    for (const line of fs.readFileSync(CREDENTIALS, 'utf8').split('\n')) {
      const [user, password] = line.trim().split(/\s+/);
      if (user && !user.startsWith('#') && password) { out[user] = password; }
    }
  } catch { /* first run */ }
  for (const u of USERS) { out[u.username] ??= crypto.randomBytes(12).toString('base64url'); }
  return out;
}

function writeCredentials() {
  const roles = { 'stage-admin': 'admin, plays', 'stage-member': 'member, plays', 'stage-new': 'member, no plays' };
  const lines = [`# Peer Recommendations stage on :${PORT}. Test accounts; the stage never prints them.`,
    ...USERS.map((u) => `${u.username.padEnd(14)} ${passwords[u.username]}   ${roles[u.username]}`)];
  fs.writeFileSync(CREDENTIALS, `${lines.join('\n')}\n`, { mode: 0o600 });
}

async function createUsers() {
  for (const [i, u] of USERS.entries()) {
    // The first account is made in public mode; the rest need it.
    const r = await api('PUT', '/api/v1/admin/users', {
      token: i === 0 ? null : adminToken,
      body: {
        username: u.username, password: passwords[u.username], admin: u.admin,
        vpaths: ['testlib', 'copies'], allowMkdir: true, allowUpload: true,
      },
    });
    if (r.status !== 200) { throw new Error(`creating ${u.username} failed: ${r.status} ${JSON.stringify(r.body)}`); }
    if (i === 0) { adminToken = await login(u.username); }
  }
}

// The fixture songs are too short for the embedding worker, so the vectors
// are written here, with the model facts the worker would record (the peers
// route and the Add read the local model from embedding_model_id).
async function seedVectors() {
  const dpath = path.join(DB_DIR, 'discovery.db');
  for (let i = 0; !fs.existsSync(dpath); i++) {
    if (i > 300) { throw new Error('discovery.db never appeared'); }
    await sleep(100);
  }
  const mdb = new DatabaseSync(path.join(DB_DIR, 'mstream.db'), { readOnly: true });
  const ddb = new DatabaseSync(dpath);
  try {
    const rows = mdb.prepare(`
      SELECT COALESCE(t.audio_hash, t.file_hash) AS hash, t.title, t.duration, a.name AS artist
        FROM tracks t LEFT JOIN artists a ON a.id = t.artist_id`).all();
    const ins = ddb.prepare(`
      INSERT OR REPLACE INTO discovery_tracks
        (audio_hash, updated_at, export_id, artist, title, duration, model_id, model_version, embedding)
      VALUES (?, ?, ?, ?, ?, ?, 'test-fake', '1', ?)`);
    let seq = Number(ddb.prepare("SELECT value FROM discovery_meta WHERE key = 'row_seq'").get()?.value || 0);
    let n = 0;
    for (const row of rows) {
      const v = LIBRARY_VECTORS[row.title];
      if (!v || !row.hash) { continue; }
      const len = Math.hypot(...v);
      const f = new Float32Array(v.map((x) => x / len));
      ins.run(row.hash, ++seq, `anon:${row.hash.slice(0, 16)}`, row.artist, row.title, row.duration ?? 1,
        Buffer.from(f.buffer, f.byteOffset, f.byteLength));
      n++;
    }
    const meta = ddb.prepare('INSERT OR REPLACE INTO discovery_meta (key, value) VALUES (?, ?)');
    meta.run('row_seq', String(seq));
    meta.run('index_epoch', String(seq));
    meta.run('embedding_model_id', 'test-fake');
    meta.run('embedding_model_version', '1');
    log(`vectors: ${n} library songs (test-fake, 4-d)`);
  } finally {
    ddb.close();
    mdb.close();
  }
}

async function postPlays() {
  const mdb = new DatabaseSync(path.join(DB_DIR, 'mstream.db'), { readOnly: true });
  const pathOf = new Map(mdb.prepare(`
    SELECT t.title, l.name || '/' || t.filepath AS p FROM tracks t JOIN libraries l ON l.id = t.library_id`).all()
    .map((r) => [r.title, r.p]));
  mdb.close();
  const now = Date.now();
  for (const u of USERS) {
    if (u.plays.length === 0) { continue; }
    const plays = u.plays.map((title, i) => ({
      id: `stage-${u.username}-${i + 1}`, filePath: pathOf.get(title), startedAt: new Date(now - (i + 1) * DAY).toISOString(),
      playedMs: 200000, durationMs: 200000, outcome: 'completed',
    }));
    const token = await login(u.username);
    const r = await api('POST', '/api/v1/stats/plays', { token, body: { client: { name: 'peer-recs-stage' }, plays } });
    if (r.status !== 200 || r.body?.accepted?.length !== plays.length) {
      throw new Error(`plays for ${u.username}: ${r.status} ${JSON.stringify(r.body)}`);
    }
  }
}

// Every copy lands in the scratch library, whoever asks.
async function setDestinations() {
  for (const u of USERS) {
    const r = await api('PUT', '/api/v1/discovery/collection/destination', {
      token: await login(u.username),
      body: { destination: { vpath: 'copies', base: '', layout: '{{ALBUMARTIST}}/{{ALBUM}}' } },
    });
    if (r.status !== 200) { throw new Error(`destination for ${u.username}: ${r.status} ${JSON.stringify(r.body)}`); }
  }
}

// ── What a client sees ───────────────────────────────────────────────────

// The page's own request (plan §3.5 R1).
const pageBody = (extra = {}) => ({
  sources: ['network'], window: 30, newArtistsOnly: false, limit: { seeds: 12, network: 32 }, networkOnRandomSeed: true, ...extra,
});

async function report() {
  const peers = await api('GET', '/api/v1/discovery/p2p/peers', { token: adminToken });
  if (peers.status !== 200) { log(`  peers: ${peers.status} ${peers.body?.error ?? ''}`); }
  for (const p of peers.body?.peers || []) {
    const where = p.onShelf ? `shelf${p.pinned ? ', pinned' : ''}` : 'catalog';
    const add = p.add ? `  add ${p.add.state}${p.add.code ? ` (${p.add.code})` : ''}` : '';
    log(`  ${p.label.padEnd(18)} ${p.endpointId.slice(0, 12)}…  hue ${String(p.hue).padStart(3)}  ${p.online ? 'online ' : 'offline'}  ${where}${add}`);
  }
  for (const username of ['stage-member', 'stage-new']) {
    const r = await api('POST', '/api/v1/discovery/taste', { token: await login(username), body: pageBody() });
    log(`  ${username}: ${r.status} ${r.body?.seedSource} seed, ${r.body?.network?.results?.length ?? 0} leads`
      + `${r.body?.network?.reason ? ` (${r.body.network.reason})` : ''}`);
  }
}

async function ready(what) {
  const lan = lanAddress();
  log(`${what}  ${BASE}${lan ? `   LAN http://${lan}:${PORT}` : ''}`);
  log(`pids: stage ${process.pid} (Deezer mock on :${MOCK_PORT}), server ${server?.pid}`);
  await report().catch((err) => log(`  (report failed: ${err.message})`));
}

// ── Controls ─────────────────────────────────────────────────────────────

function peerNamed(arg) {
  const want = String(arg || '').trim().toLowerCase();
  if (!want) { throw new Error('which peer?'); }
  const exact = PEERS.find((p) => p.name.toLowerCase() === want);
  const hits = exact ? [exact] : PEERS.filter((p) => p.name.toLowerCase().startsWith(want));
  if (hits.length !== 1) { throw new Error(`"${arg}" names ${hits.length ? 'several peers' : 'no peer'}: ${PEERS.map((p) => p.name).join(', ')}`); }
  return hits[0];
}

async function restart(what = 'restarted') {
  await stopServer();
  await boot();
  await ready(what);
}

// online: heard now; offline: heard two years ago. Written with the server
// down, which reads the catalog once.
async function setHeard(arg, online) {
  const peer = peerNamed(arg);
  await stopServer();
  const file = catalogPath(DB_DIR);
  const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entry = catalog.find((e) => e.from === peer.id);
  if (entry) {
    entry.updatedAt = new Date(Date.now() - (online ? 0 : 2 * YEAR)).toISOString();
    fs.writeFileSync(file, JSON.stringify(catalog, null, 2));
    log(`${peer.name} is ${online ? 'online' : 'offline'} in the catalog`);
  } else {
    log(`${peer.name} is not in the catalog (removed?); nothing to change`);
  }
  await boot();
  await ready('restarted');
}

async function shelf() {
  const r = await api('GET', '/api/v1/discovery/p2p/peer-dbs', { token: adminToken });
  if (r.status !== 200) { throw new Error(`the shelf: ${r.status} ${JSON.stringify(r.body)}`); }
  return r.body.peerDbs;
}
const nameOf = (endpointId) => PEERS.find((p) => p.id === endpointId)?.name ?? `${endpointId.slice(0, 12)}…`;

async function setPin(endpointId, pinned) {
  const r = await api('POST', '/api/v1/admin/discovery/p2p/peer-dbs/pin', { token: adminToken, body: { endpointId, pinned } });
  if (r.status === 404) { throw new Error(`${nameOf(endpointId)} is not on the shelf`); }
  if (r.status !== 200) { throw new Error(`pin ${nameOf(endpointId)}: ${r.status} ${JSON.stringify(r.body)}`); }
}

const CONTROLS = {
  offline: (arg) => setHeard(arg, false),
  online: (arg) => setHeard(arg, true),
  restart: () => restart(),
  'pin-all': async () => {
    const held = await shelf();
    for (const e of held) { await setPin(e.endpointId, true); }
    log(`pinned ${held.map((e) => nameOf(e.endpointId)).join(', ') || 'nothing (the shelf is empty)'}`);
  },
  unpin: async (arg) => {
    const peer = peerNamed(arg);
    await setPin(peer.id, false);
    log(`unpinned ${peer.name}`);
  },
  'empty-shelf': async () => {
    const held = await shelf();
    for (const e of held) {
      const r = await api('POST', '/api/v1/admin/discovery/p2p/peer-dbs/remove', { token: adminToken, body: { endpointId: e.endpointId } });
      if (r.status !== 200) { throw new Error(`remove ${nameOf(e.endpointId)}: ${r.status} ${JSON.stringify(r.body)}`); }
    }
    log(`removed ${held.map((e) => nameOf(e.endpointId)).join(', ') || 'nothing (the shelf was empty)'}`);
  },
  'p2p-off': async () => {
    const r = await api('POST', '/api/v1/admin/discovery/p2p/enabled', { token: adminToken, body: { enabled: false } });
    log(`p2p off: ${r.status} ${JSON.stringify(r.body)}`);
  },
  'p2p-on': async () => {
    await stopServer();
    setP2pOn();
    log('p2p on in the config');
    await boot();
    await ready('restarted');
  },
  reset: async () => {
    await stopServer();
    stageNetwork();
    setP2pOn();
    quietEngine429 = true;
    log('the network is back as staged, p2p on (Quiet Engine answers 429 once again)');
    await boot();
    await ready('reset');
  },
  quit: () => shutdown(0),
  help: () => log('controls: offline <name> | online <name> | restart | pin-all | unpin <name> | empty-shelf | p2p-off | p2p-on | reset | quit'),
};

let shuttingDown = false;
async function shutdown(code) {
  if (shuttingDown) { return; }
  shuttingDown = true;
  log('stopping');
  await stopServer();
  mock.closeAllConnections?.();
  mock.close();
  process.exit(code);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) { process.on(sig, () => shutdown(0)); }
// A throw anywhere (a failed boot, a seeding error) ends this script: the
// server goes with it, never left behind on the port.
process.on('exit', () => { if (server) { try { server.kill('SIGTERM'); } catch { /* gone */ } } });

// ── Go ───────────────────────────────────────────────────────────────────

const passwords = loadPasswords();
try {
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(COPIES, { recursive: true });
  writeCredentials();
  writeConfig();
  stageNetwork();

  // Loopback while the server has no account (public mode: anyone could
  // make one), then everything a walk needs.
  await startServer();
  log(`server ${server.pid} up on loopback, scanning ${FIXTURES}`);
  await waitScan(null);
  await createUsers();
  await seedVectors();
  await postPlays();
  await setDestinations();
  log(`accounts: stage-admin, stage-member, stage-new (passwords in ${CREDENTIALS})`);

  await stopServer();
  setAddress('0.0.0.0');
  await boot();
  await ready('READY');
  CONTROLS.help();
  log(`server console: ${CONSOLE_LOG}`);
} catch (err) {
  console.error(`[stage] ${err.stack || err.message}`);
  await shutdown(1);
}

let queue = Promise.resolve();
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  if (!cmd) { return; }
  const run = CONTROLS[cmd.toLowerCase()];
  queue = queue
    .then(() => (run ? run(rest.join(' ')) : log(`unknown control "${cmd}"; try help`)))
    .catch((err) => log(`${cmd}: ${err.message}`));
});
rl.on('close', () => log('stdin closed: no more controls (Ctrl-C or SIGTERM stops the stage)'));
