import http from 'http';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import child_process from 'child_process';
import winston from 'winston';
import * as config from '../state/config.js';
import * as vpath from '../util/vpath.js';
import * as db from '../db/manager.js';
import { appRoot } from '../util/esm-helpers.js';
import * as killQueue from '../state/kill-list.js';
import * as cliAudio from './cli-audio/index.js';

let rustPlayerProcess = null;

killQueue.addToKillQueue(() => {
  if (rustPlayerProcess) {
    rustPlayerProcess.kill();
    rustPlayerProcess = null;
  }
  cliAudio.killCliPlayer().catch(() => {});
});

// Snapshot of CLI detection. Refreshed eagerly at boot, on autoBoot toggle,
// and whenever an admin hits /api/v1/admin/server-audio/detect. Exported so
// the admin info endpoint can read it without re-probing on every hit.
let _detectedCliPlayers = [];
export async function refreshDetectedCliPlayers() {
  _detectedCliPlayers = await cliAudio.detectAvailablePlayers();
  return _detectedCliPlayers;
}
export function getDetectedCliPlayers() {
  return _detectedCliPlayers;
}

export function getActiveBackend() {
  if (rustPlayerProcess) { return { backend: 'rust', player: 'rust-server-audio' }; }
  if (cliAudio.isCliActive()) { return { backend: 'cli', player: cliAudio.getActivePlayerName() }; }
  return { backend: null, player: null };
}

function getRustPort() {
  return config.program.rustPlayerPort || 3333;
}

// ── Auto-boot logic ───────────────────────────────────────────────────────

function findRustBinary() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const candidates = [
    path.join(appRoot, `bin/rust-server-audio/rust-server-audio-${process.platform}-${process.arch}${ext}`),
    path.join(appRoot, `rust-server-audio/target/release/rust-server-audio${ext}`),
  ];

  for (const bin of candidates) {
    if (fs.existsSync(bin)) {
      // Docker image builds / tarball extraction / npm pack commonly strip
      // the execute bit from checked-in binaries — without this, spawn
      // fails with EACCES on every boot. No-op on Windows. `chmod` fails
      // silently on read-only volumes; the downstream spawn will surface
      // the real error if exec is truly blocked (noexec mount, SELinux).
      // Matches the rust-parser's fix in src/db/task-queue.js.
      try { fs.chmodSync(bin, 0o755); } catch (_) {}
      return bin;
    }
  }
  return null;
}

// Has the currently-spawned rust process stayed up long enough that we
// consider startup successful? Used by the rust-fallback path: if rust dies
// before this goes true, we treat the spawn as failed and roll over to CLI.
let _rustStartupSettled = false;
const RUST_SETTLE_MS = 2000;

async function bootCliFallback(reason, preferredPlayer = null) {
  if (cliAudio.isCliActive()) { return; }
  if (_detectedCliPlayers.length === 0) {
    winston.warn(`[server-audio] ${reason}; no CLI audio players detected — server audio unavailable`);
    return;
  }
  try {
    const name = await cliAudio.bootCliPlayer(preferredPlayer);
    if (name) {
      winston.info(`[server-audio] ${reason}; using CLI fallback: ${name}`);
    } else {
      winston.warn(`[server-audio] ${reason}; CLI players detected but none would start`);
    }
  } catch (err) {
    winston.error(`[server-audio] CLI fallback failed: ${err.message}`);
  }
}

/**
 * Boot whichever server-audio backend is appropriate.
 *
 *   autoBootServerAudio: true  → prefer the Rust binary; fall back to a CLI
 *                                player if the binary is missing, the spawn
 *                                fails (permission denied, etc.), or the
 *                                process exits during startup.
 *   autoBootServerAudio: false → skip Rust entirely and prefer MPD, since
 *                                that's the CLI option most often used on
 *                                self-hosted / NAS setups where a dedicated
 *                                audio daemon is already running. Falls back
 *                                to other installed CLI players if MPD isn't
 *                                available.
 *
 * Name is kept for backwards-compatibility with existing callers in
 * src/server.js and src/api/admin.js. Returns a Promise; callers that don't
 * need to await may fire-and-forget.
 */
export async function bootRustPlayer() {
  if (rustPlayerProcess) { return; }

  // Refresh the CLI detection snapshot so the fallback decision (and the
  // admin /info endpoint) have current data.
  await refreshDetectedCliPlayers();

  if (!config.program.autoBootServerAudio) {
    await bootCliFallback('autoBootServerAudio=false', 'mpd');
    return;
  }

  const bin = findRustBinary();
  if (!bin) {
    await bootCliFallback('rust-server-audio binary not found');
    return;
  }

  const port = getRustPort();
  winston.info(`Starting rust-server-audio on port ${port}`);

  _rustStartupSettled = false;
  rustPlayerProcess = child_process.spawn(bin, ['--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const settleTimer = setTimeout(() => {
    _rustStartupSettled = true;
  }, RUST_SETTLE_MS);

  rustPlayerProcess.stdout.on('data', (data) => {
    winston.info(`[rust-audio] ${data.toString().trim()}`);
  });

  rustPlayerProcess.stderr.on('data', (data) => {
    winston.error(`[rust-audio] ${data.toString().trim()}`);
  });

  rustPlayerProcess.on('close', (code) => {
    clearTimeout(settleTimer);
    winston.info(`rust-server-audio exited with code ${code}`);
    const settled = _rustStartupSettled;
    rustPlayerProcess = null;
    if (!settled) {
      // Died during startup → roll over to CLI.
      bootCliFallback(`rust-server-audio exited early (code ${code})`).catch(() => {});
    }
  });

  rustPlayerProcess.on('error', (err) => {
    clearTimeout(settleTimer);
    winston.error(`Failed to start rust-server-audio: ${err.message}`);
    const settled = _rustStartupSettled;
    rustPlayerProcess = null;
    if (!settled) {
      bootCliFallback(`rust-server-audio spawn failed: ${err.message}`).catch(() => {});
    }
  });
}

export function killRustPlayer() {
  if (rustPlayerProcess) {
    rustPlayerProcess.kill();
    rustPlayerProcess = null;
  }
  cliAudio.killCliPlayer().catch(() => {});
}

// Proxy a request to the Rust binary and pipe the response back.
// Exported so the Subsonic jukeboxControl handler can reuse it — it
// shares every primitive with /api/v1/server-playback/*.
export function proxyToRust(method, rustPath, body) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : '';
    const options = {
      hostname: '127.0.0.1',
      port: getRustPort(),
      path: rustPath,
      method: method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (_e) {
          resolve({ status: res.statusCode, data: { raw: data } });
        }
      });
    });

    req.on('error', (_e) => {
      reject(new Error('Server audio player is not running'));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Server audio player timed out'));
    });

    if (postData) { req.write(postData); }
    req.end();
  });
}

// Dispatch to whichever backend is active. Rust is preferred; CLI is used
// when the Rust binary is missing but a CLI fallback has been booted.
function proxyPlayback(method, rustPath, body) {
  if (rustPlayerProcess) {
    return proxyToRust(method, rustPath, body);
  }
  if (cliAudio.isCliActive()) {
    return cliAudio.proxyToCli(method, rustPath, body);
  }
  return Promise.reject(new Error('Server audio player is not running'));
}

// Resolve a virtual path (e.g. "55/song.mp3") to an absolute filesystem path
export function resolveFilePath(filePath, user) {
  const info = vpath.getVPathInfo(filePath, user);
  return info.fullPath;
}

// Reverse: convert an absolute path back to a virtual path (e.g. "55/song.mp3")
export function absoluteToVpath(absolutePath) {
  const normalized = path.normalize(absolutePath);
  const libraries = db.getAllLibraries();
  for (const lib of libraries) {
    const root = path.normalize(lib.root_path);
    if (normalized.startsWith(root)) {
      const relative = path.relative(root, normalized);
      return lib.name + '/' + relative.replace(/\\/g, '/');
    }
  }
  // If no vpath matches, return the filename as fallback
  return path.basename(absolutePath);
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
        const result = await proxyPlayback('POST', rustPath, req.body || {});
        res.status(result.status).json(result.data);
      } catch (e) {
        res.status(503).json({ error: e.message });
      }
    });
  }

  // ── POST routes with body passthrough ───────────────────────────────────

  mstream.post('/api/v1/server-playback/seek', async (req, res) => {
    try {
      const result = await proxyPlayback('POST', '/seek', req.body);
      res.status(result.status).json(result.data);
    } catch (e) {
      res.status(503).json({ error: e.message });
    }
  });

  mstream.post('/api/v1/server-playback/volume', async (req, res) => {
    try {
      const result = await proxyPlayback('POST', '/volume', req.body);
      res.status(result.status).json(result.data);
    } catch (e) {
      res.status(503).json({ error: e.message });
    }
  });

  mstream.post('/api/v1/server-playback/shuffle', async (req, res) => {
    try {
      const result = await proxyPlayback('POST', '/shuffle', req.body);
      res.status(result.status).json(result.data);
    } catch (e) {
      res.status(503).json({ error: e.message });
    }
  });

  // ── GET routes ──────────────────────────────────────────────────────────

  mstream.get('/api/v1/server-playback/status', async (req, res) => {
    try {
      const result = await proxyPlayback('GET', '/status');
      if (result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
        const active = getActiveBackend();
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
      const result = await proxyPlayback('GET', '/queue');
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
      const result = await proxyPlayback('POST', '/play', { file: absolutePath });
      res.status(result.status).json(result.data);
    } catch (e) {
      res.status(e.message.includes('not running') ? 503 : 400).json({ error: e.message });
    }
  });

  // POST /queue/add — append one file
  mstream.post('/api/v1/server-playback/queue/add', async (req, res) => {
    try {
      const absolutePath = resolveFilePath(req.body.file, req.user);
      const result = await proxyPlayback('POST', '/queue/add', { file: absolutePath });
      res.status(result.status).json(result.data);
    } catch (e) {
      res.status(e.message.includes('not running') ? 503 : 400).json({ error: e.message });
    }
  });

  // POST /queue/add-many — append multiple files
  mstream.post('/api/v1/server-playback/queue/add-many', async (req, res) => {
    try {
      const files = req.body.files.map((f) => resolveFilePath(f, req.user));
      const result = await proxyPlayback('POST', '/queue/add-many', { files });
      res.status(result.status).json(result.data);
    } catch (e) {
      res.status(e.message.includes('not running') ? 503 : 400).json({ error: e.message });
    }
  });

  // POST /queue/play-index — jump to index
  mstream.post('/api/v1/server-playback/queue/play-index', async (req, res) => {
    try {
      const result = await proxyPlayback('POST', '/queue/play-index', req.body);
      res.status(result.status).json(result.data);
    } catch (e) {
      res.status(503).json({ error: e.message });
    }
  });

  // POST /queue/remove — remove by index
  mstream.post('/api/v1/server-playback/queue/remove', async (req, res) => {
    try {
      const result = await proxyPlayback('POST', '/queue/remove', req.body);
      res.status(result.status).json(result.data);
    } catch (e) {
      res.status(503).json({ error: e.message });
    }
  });

  // POST /queue/clear — stop and empty queue
  mstream.post('/api/v1/server-playback/queue/clear', async (req, res) => {
    try {
      const result = await proxyPlayback('POST', '/queue/clear', {});
      res.status(result.status).json(result.data);
    } catch (e) {
      res.status(503).json({ error: e.message });
    }
  });

  // ── /server-remote page (serves the webapp with serverAudioMode flag) ──
  //
  // Previously lived in setupBeforeAuth() so anyone could hit the page, but
  // that let unauthenticated users probe whether server audio was running.
  // The page only makes sense for users who can actually control playback,
  // so it now sits behind the same auth + permission checks as the APIs.
  mstream.get('/server-remote', async (req, res) => {
    if (!userCanUseServerAudio(req.user)) {
      return res.status(403).json({ error: 'Server audio access disabled for this user' });
    }

    // Check if any audio backend (rust or CLI fallback) is reachable
    try {
      await proxyPlayback('GET', '/status');
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
        '<p>The server audio player is not running. Start the rust-server-audio binary or enable ' +
        '<b>autoBootServerAudio</b> in the <a href="/admin">admin panel</a>.</p>' +
        '<a href="/server-remote">Retry</a> &middot; <a href="/">Normal Mode</a>' +
        '</div></body></html>'
      );
      return;
    }

    try {
      let page = await fsPromises.readFile(path.join(config.program.webAppDirectory, 'index.html'), 'utf-8');
      // Replace the browser audio player with the server audio player.
      // This swaps mstream.player.js for mstream.server-audio.js which
      // implements the same MSTREAMPLAYER interface but routes all commands
      // to the Rust audio binary via the server-playback API.
      // Swap browser audio player for server audio player
      page = page.replace(
        '<script src="assets/js/mstream.player.js"></script>',
        '<script>var serverAudioMode = true;</script>\n  <script src="assets/js/mstream.server-audio.js"></script>'
      );

      // Strip out scripts not needed in server audio mode
      page = page.replace('<script src="assets/js/mstream.jukebox.js"></script>', '');
      page = page.replace('<script defer src="assets/js/lib/qr.js"></script>', '');
      page = page.replace('<script src="assets/js/t.js"></script>', '');
      page = page.replace('<script async src="assets/js/lib/butterchurn.min.js"></script>', '');
      page = page.replace('<script async src="assets/js/lib/butterchurn-presets.min.js"></script>', '');
      page = page.replace('<script async src="assets/js/lib/butterchurn-presets-extra.js"></script>', '');

      // Remove sidebar items not relevant to server audio mode (Auto DJ, Transcode, Jukebox)
      page = page.replace(/\s*<div[^>]*onclick="changeView\(autoDjPanel[^]*?<\/span>\s*<\/div>/i, '');
      page = page.replace(/\s*<div[^>]*onclick="changeView\(setupTranscodePanel[^]*?<\/span>\s*<\/div>/i, '');
      page = page.replace(/\s*<div[^>]*onclick="changeView\(setupJukeboxPanel[^]*?<\/span>\s*<\/div>/i, '');

      // Replace the visualizer button (div.grow.flex-center with the equalizer SVG)
      // with a "Server Audio" badge to preserve the layout spacer
      page = page.replace(
        /(<div class="grow flex-center">)\s*<svg v-on:click="fadeOverlay"[^]*?<\/svg>\s*(<\/div>)/,
        '$1<span style="background:#264679;color:#fff;padding:3px 10px;border-radius:4px;font-size:11px;opacity:0.85;">Server Audio</span>$2'
      );

      res.send(page);
    } catch (_e) {
      res.status(500).json({ error: 'Failed to serve server-remote page' });
    }
  });
}

// Retained so existing call sites in src/server.js keep compiling — /server-
// remote was moved into setup() so it sits behind auth now.
export function setupBeforeAuth() {}
