// Routes for server-side playback: /api/v1/server-playback/* and the
// /server-remote page. The backend itself — which process is running, how it
// is found, spawned, watched and stopped — lives in src/state/server-audio.js;
// this module only translates paths, gates access and proxies.

import fsPromises from 'fs/promises';
import path from 'path';
import Joi from 'joi';
import winston from 'winston';
import * as config from '../state/config.js';
import * as serverAudio from '../state/server-audio.js';
import * as vpath from '../util/vpath.js';
import * as db from '../db/manager.js';
import { joiValidate } from '../util/validation.js';
import WebError from '../util/web-error.js';

// ── Path translation ────────────────────────────────────────────────────────

// Resolve a virtual path (e.g. "55/song.mp3") to an absolute filesystem path,
// on behalf of THIS user: getVPathInfo enforces the caller's library access
// and rejects with a typed 404. Clients build vpaths from what the server
// handed them, so a rejected one is almost never an honest mistake — it is
// stale client state or someone probing, and gets a line naming who sent what
// before the 404 goes out (the transcode routes' convention).
function resolveFilePath(filePath, user) {
  try {
    return vpath.getVPathInfo(filePath, user).fullPath;
  } catch (err) {
    winston.warn(`[server-audio] vpath rejected for user '${user?.username}': '${filePath}' (${err.message})`);
    throw err;
  }
}

// Is `child` the same path as `root`, or inside it? A plain startsWith isn't
// enough: "C:\Music" is a prefix of "C:\MusicVideos\song.mp3" without
// containing it, which produced vpaths like "music/../MusicVideos/song.mp3".
export function isWithin(child, root) {
  if (child === root) { return true; }
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  return child.startsWith(withSep);
}

// Reverse: convert an absolute path back to a virtual path (e.g. "55/song.mp3")
function absoluteToVpath(absolutePath) {
  const normalized = path.normalize(absolutePath);
  const libraries = db.getAllLibraries();
  for (const lib of libraries) {
    const root = path.normalize(lib.root_path);
    if (isWithin(normalized, root)) {
      const relative = path.relative(root, normalized);
      return lib.name + '/' + relative.replace(/\\/g, '/');
    }
  }
  // If no vpath matches, return the filename as fallback
  return path.basename(absolutePath);
}

// ── Request bodies ──────────────────────────────────────────────────────────

const oneFileSchema = Joi.object({ file: Joi.string().required() });
const manyFilesSchema = Joi.object({ files: Joi.array().items(Joi.string()).required() });

// { file: vpath } → { file: absolute path }. A malformed body is a 400 from
// the schema; a library the caller lacks is resolveFilePath's 404.
function oneFile(req) {
  const { value } = joiValidate(oneFileSchema, req.body || {});
  return { file: resolveFilePath(value.file, req.user) };
}

function manyFiles(req) {
  const { value } = joiValidate(manyFilesSchema, req.body || {});
  return { files: value.files.map((f) => resolveFilePath(f, req.user)) };
}

// ── Response bodies ─────────────────────────────────────────────────────────
//
// Both backends speak absolute paths — that is what they were handed — and no
// absolute path may reach a client: it tells every user with server-audio
// access how the host's disks are laid out. /queue always translated; /status
// handed `file` through untouched until this was caught. Pure and exported so
// the unit tests need no database (`toVpath` is injectable).

// GET /status: the current track as a library path, plus which backend
// answered. Anything that is not a status object passes through untouched.
export function statusForClient(data, active, toVpath = absoluteToVpath) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) { return data; }
  const out = { ...data, backend: active.backend, player: active.player };
  if (typeof data.file === 'string' && data.file !== '') { out.file = toVpath(data.file); }
  return out;
}

// GET /queue: every entry as a library path.
export function queueForClient(data, toVpath = absoluteToVpath) {
  if (!data || !Array.isArray(data.queue)) { return data; }
  return { ...data, queue: data.queue.map(toVpath) };
}

// ── The one proxied-route handler ───────────────────────────────────────────

/**
 * Build the handler for one proxied route: shape the backend's request body,
 * proxy, shape the answer.
 *
 *   mapBody(req)    → the body the backend gets. Default: the request's own
 *                     body for a POST, none for a GET. Runs BEFORE the proxy,
 *                     so a malformed body or a library the caller lacks is
 *                     their error whether or not a backend is up. Its throws
 *                     go to the terminal error handler like any other
 *                     route's (schema → 400, WebError → its own status).
 *   mapResult(data) → the body the client gets, for a backend success.
 *
 * The backend's own status code and body are passed through as they are: a
 * 409 "already at end of queue" is the backend's answer, not a proxy failure.
 *
 * `proxy` is a parameter so the unit tests can drive a handler with no
 * backend at all.
 */
export function proxyRoute(proxy, method, rustPath, { mapBody, mapResult } = {}) {
  return async (req, res) => {
    let body;
    if (mapBody) { body = mapBody(req); }
    else if (method !== 'GET') { body = req.body || {}; }

    let result;
    try {
      result = await proxy(method, rustPath, body);
    } catch (err) {
      // "No backend answered" is a state, not an incident, so it is answered
      // here instead of by the terminal handler: the remote page polls
      // /status twice a second, and every one of those would be an
      // error-level log line for as long as the backend stays down. The
      // cause is not lost — the lifecycle module logs why a backend went
      // away, and the proxy logs the socket error when an engine stops
      // answering, once per outage.
      if (err instanceof WebError && err.status === 503) {
        return res.status(503).json({ error: err.message });
      }
      throw err;
    }

    const data = mapResult && result.status < 400 ? mapResult(result.data) : result.data;
    res.status(result.status).json(data);
  };
}

// ── /server-remote ──────────────────────────────────────────────────────────

// The /server-remote page is index.html with the browser player swapped for
// the server-audio client. Pure and exported so a unit test can pin it against
// the REAL index.html: every step is an exact-string or regex match that
// silently no-ops when the markup drifts (three visualizer-script strips sat
// here as dead code for months for exactly that reason). Hiding the sidebar
// items and buttons that make no sense in this mode is the client's job —
// mstream.server-audio.js injects that CSS at parse time.
export function rewriteIndexForServerAudio(page) {
  return page
    // Swap mstream.player.js for mstream.server-audio.js, which implements the
    // same MSTREAMPLAYER interface but routes every command through the
    // server-playback API. The flag must be set before the client script runs.
    .replace(
      '<script src="assets/js/mstream.player.js"></script>',
      '<script>var serverAudioMode = true;</script>\n  <script src="assets/js/mstream.server-audio.js"></script>'
    )
    // Scripts with no role in server-audio mode: the jukebox remote, the QR
    // pairing code, and the visualizer loader (the client stubs VIZ).
    .replace('<script src="assets/js/mstream.jukebox.js"></script>', '')
    .replace('<script defer src="assets/js/lib/qr.js"></script>', '')
    .replace('<script src="assets/js/t.js"></script>', '')
    // Replace the visualizer button (the equalizer SVG inside div.grow.flex-center)
    // with a "Server Audio" badge so the player bar keeps its layout spacer.
    .replace(
      /(<div class="grow flex-center">)\s*<svg v-on:click="fadeOverlay"[^]*?<\/svg>\s*(<\/div>)/,
      '$1<span style="background:#264679;color:#fff;padding:3px 10px;border-radius:4px;font-size:11px;opacity:0.85;">Server Audio</span>$2'
    );
}

// What /server-remote answers while no backend is up. The advice has to match
// what the lifecycle can actually do: the proxy only ever talks to an engine
// the SERVER spawned, so "start the mstream-player binary yourself" — what
// this page said for months — never worked. autoBootServerAudio brings the
// engine up (fetching it on first use); without it a CLI player is picked at
// boot, which is why installing one needs a restart.
export const UNAVAILABLE_PAGE =
  '<!doctype html><html><head><meta charset="utf-8"><title>Server Audio Unavailable</title>' +
  '<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
  'display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;' +
  'background:#1a1a2e;color:#e4e4e4;text-align:center;}' +
  '.box{max-width:440px;padding:40px;}' +
  'h1{font-size:24px;margin-bottom:12px;color:#7aabdf;}' +
  'p{color:#999;line-height:1.6;margin-bottom:24px;}' +
  'a{color:#7aabdf;text-decoration:none;}a:hover{text-decoration:underline;}' +
  '</style></head><body><div class="box">' +
  '<h1>Server Audio Unavailable</h1>' +
  '<p>No server-audio backend is running. Enable <b>autoBootServerAudio</b> in the ' +
  '<a href="/admin">admin panel</a> to use the built-in mstream-player engine, or install ' +
  'mpv, MPD, VLC or MPlayer and restart mStream.</p>' +
  '<a href="/server-remote">Retry</a> &middot; <a href="/">Normal Mode</a>' +
  '</div></body></html>';

// Single source of truth for "may this user touch server audio?" — shared
// between the /api/v1/server-playback/* middleware and the /server-remote
// page handler so the two can't drift apart.
function userCanUseServerAudio(user) {
  if (!user) { return false; }
  if (user.admin === true) { return true; }
  return user.allow_server_audio === 1 || user.allow_server_audio === true;
}

export function setup(mstream) {

  // ── Per-user permission gate ────────────────────────────────────────────
  // Any route under /api/v1/server-playback requires allow_server_audio.
  // Admins always pass; everyone else must have the flag set.
  mstream.all('/api/v1/server-playback/{*path}', (req, res, next) => {
    if (!userCanUseServerAudio(req.user)) {
      return res.status(403).json({ error: 'Server audio access disabled for this user' });
    }
    next();
  });

  // ── Proxied routes ──────────────────────────────────────────────────────
  // Every route is the backend's own path under one prefix, so a single name
  // serves both sides. Most need nothing else; the rest say what they map.
  const routes = [
    ['post', '/pause'],
    ['post', '/resume'],
    ['post', '/stop'],
    ['post', '/next'],
    ['post', '/previous'],
    ['post', '/loop'],
    ['post', '/seek'],             // { position: seconds }
    ['post', '/volume'],           // { volume: 0..1 }
    ['post', '/shuffle'],          // { value: boolean }
    ['get',  '/status',           { mapResult: (data) => statusForClient(data, serverAudio.getActiveBackend()) }],
    ['get',  '/queue',            { mapResult: (data) => queueForClient(data) }],
    ['post', '/play',             { mapBody: oneFile }],     // clear queue, add file, play
    ['post', '/queue/add',        { mapBody: oneFile }],
    ['post', '/queue/add-many',   { mapBody: manyFiles }],
    ['post', '/queue/play-index'], // { index }
    ['post', '/queue/remove'],     // { index }
    ['post', '/queue/clear',      { mapBody: () => ({}) }],  // stop and empty the queue
  ];

  for (const [verb, rustPath, opts] of routes) {
    mstream[verb](`/api/v1/server-playback${rustPath}`, proxyRoute(serverAudio.proxy, verb.toUpperCase(), rustPath, opts));
  }

  // ── /server-remote page (serves the webapp with serverAudioMode flag) ──
  //
  // Previously registered ahead of the auth wall so anyone could hit the
  // page, but that let unauthenticated users probe whether server audio was
  // running. The page only makes sense for users who can actually control
  // playback, so it sits behind the same auth + permission checks as the APIs.
  mstream.get('/server-remote', async (req, res) => {
    if (!userCanUseServerAudio(req.user)) {
      return res.status(403).json({ error: 'Server audio access disabled for this user' });
    }

    // Is any backend (engine or CLI fallback) answering? Not an error worth a
    // log line when it isn't — see proxyRoute — just a different page.
    try {
      await serverAudio.proxy('GET', '/status');
    } catch (_err) {
      return res.status(503).send(UNAVAILABLE_PAGE);
    }

    try {
      const page = await fsPromises.readFile(path.join(config.program.webAppDirectory, 'index.html'), 'utf-8');
      res.send(rewriteIndexForServerAudio(page));
    } catch (err) {
      winston.warn(`[server-audio] failed to serve /server-remote: ${err.message}`);
      res.status(500).json({ error: 'Failed to serve server-remote page' });
    }
  });
}
