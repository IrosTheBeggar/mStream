// Routes for server-side playback: /api/v1/server-playback/* and the
// /server-remote page. The backend itself — which process is running, how it
// is found, spawned, watched and stopped — lives in src/state/server-audio.js;
// this module only translates paths, gates access and proxies.

import fsPromises from 'fs/promises';
import path from 'path';
import winston from 'winston';
import * as config from '../state/config.js';
import * as serverAudio from '../state/server-audio.js';
import * as vpath from '../util/vpath.js';
import * as db from '../db/manager.js';

// Resolve a virtual path (e.g. "55/song.mp3") to an absolute filesystem path
function resolveFilePath(filePath, user) {
  const info = vpath.getVPathInfo(filePath, user);
  return info.fullPath;
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

  // ── Simple proxy routes (no path translation needed) ────────────────────

  const simplePostRoutes = {
    '/api/v1/server-playback/pause': '/pause',
    '/api/v1/server-playback/resume': '/resume',
    '/api/v1/server-playback/stop': '/stop',
    '/api/v1/server-playback/next': '/next',
    '/api/v1/server-playback/previous': '/previous',
    '/api/v1/server-playback/loop': '/loop',
  };

  for (const [mstreamPath, rustPath] of Object.entries(simplePostRoutes)) {
    mstream.post(mstreamPath, async (req, res) => {
      try {
        const result = await serverAudio.proxy('POST', rustPath, req.body || {});
        res.status(result.status).json(result.data);
      } catch (e) {
        res.status(503).json({ error: e.message });
      }
    });
  }

  // ── POST routes with body passthrough ───────────────────────────────────

  mstream.post('/api/v1/server-playback/seek', async (req, res) => {
    try {
      const result = await serverAudio.proxy('POST', '/seek', req.body);
      res.status(result.status).json(result.data);
    } catch (e) {
      res.status(503).json({ error: e.message });
    }
  });

  mstream.post('/api/v1/server-playback/volume', async (req, res) => {
    try {
      const result = await serverAudio.proxy('POST', '/volume', req.body);
      res.status(result.status).json(result.data);
    } catch (e) {
      res.status(503).json({ error: e.message });
    }
  });

  mstream.post('/api/v1/server-playback/shuffle', async (req, res) => {
    try {
      const result = await serverAudio.proxy('POST', '/shuffle', req.body);
      res.status(result.status).json(result.data);
    } catch (e) {
      res.status(503).json({ error: e.message });
    }
  });

  // ── GET routes ──────────────────────────────────────────────────────────

  mstream.get('/api/v1/server-playback/status', async (req, res) => {
    try {
      const result = await serverAudio.proxy('GET', '/status');
      if (result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
        const active = serverAudio.getActiveBackend();
        result.data.backend = active.backend;
        result.data.player = active.player;
      }
      res.status(result.status).json(result.data);
    } catch (e) {
      res.status(503).json({ error: e.message });
    }
  });

  mstream.get('/api/v1/server-playback/queue', async (req, res) => {
    try {
      const result = await serverAudio.proxy('GET', '/queue');
      // Convert absolute paths back to virtual paths for the frontend
      if (result.data && result.data.queue) {
        result.data.queue = result.data.queue.map(absoluteToVpath);
      }
      res.status(result.status).json(result.data);
    } catch (e) {
      res.status(503).json({ error: e.message });
    }
  });

  // ── Routes that need file path translation ──────────────────────────────

  // POST /play — clear queue, add file, play
  mstream.post('/api/v1/server-playback/play', async (req, res) => {
    try {
      const absolutePath = resolveFilePath(req.body.file, req.user);
      const result = await serverAudio.proxy('POST', '/play', { file: absolutePath });
      res.status(result.status).json(result.data);
    } catch (e) {
      res.status(e.message.includes('not running') ? 503 : 400).json({ error: e.message });
    }
  });

  // POST /queue/add — append one file
  mstream.post('/api/v1/server-playback/queue/add', async (req, res) => {
    try {
      const absolutePath = resolveFilePath(req.body.file, req.user);
      const result = await serverAudio.proxy('POST', '/queue/add', { file: absolutePath });
      res.status(result.status).json(result.data);
    } catch (e) {
      res.status(e.message.includes('not running') ? 503 : 400).json({ error: e.message });
    }
  });

  // POST /queue/add-many — append multiple files
  mstream.post('/api/v1/server-playback/queue/add-many', async (req, res) => {
    try {
      const files = req.body.files.map((f) => resolveFilePath(f, req.user));
      const result = await serverAudio.proxy('POST', '/queue/add-many', { files });
      res.status(result.status).json(result.data);
    } catch (e) {
      res.status(e.message.includes('not running') ? 503 : 400).json({ error: e.message });
    }
  });

  // POST /queue/play-index — jump to index
  mstream.post('/api/v1/server-playback/queue/play-index', async (req, res) => {
    try {
      const result = await serverAudio.proxy('POST', '/queue/play-index', req.body);
      res.status(result.status).json(result.data);
    } catch (e) {
      res.status(503).json({ error: e.message });
    }
  });

  // POST /queue/remove — remove by index
  mstream.post('/api/v1/server-playback/queue/remove', async (req, res) => {
    try {
      const result = await serverAudio.proxy('POST', '/queue/remove', req.body);
      res.status(result.status).json(result.data);
    } catch (e) {
      res.status(503).json({ error: e.message });
    }
  });

  // POST /queue/clear — stop and empty queue
  mstream.post('/api/v1/server-playback/queue/clear', async (req, res) => {
    try {
      const result = await serverAudio.proxy('POST', '/queue/clear', {});
      res.status(result.status).json(result.data);
    } catch (e) {
      res.status(503).json({ error: e.message });
    }
  });

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

    // Check if any audio backend (engine or CLI fallback) is reachable
    try {
      await serverAudio.proxy('GET', '/status');
    } catch (_e) {
      res.status(503).send(
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
        '<p>The server audio player is not running. Start the mstream-player binary or enable ' +
        '<b>autoBootServerAudio</b> in the <a href="/admin">admin panel</a>.</p>' +
        '<a href="/server-remote">Retry</a> &middot; <a href="/">Normal Mode</a>' +
        '</div></body></html>'
      );
      return;
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
