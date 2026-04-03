import http from 'http';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import child_process from 'child_process';
import winston from 'winston';
import * as config from '../state/config.js';
import * as vpath from '../util/vpath.js';
import { getDirname } from '../util/esm-helpers.js';
import * as killQueue from '../state/kill-list.js';

const __dirname = getDirname(import.meta.url);

let rustPlayerProcess = null;

killQueue.addToKillQueue(() => {
  if (rustPlayerProcess) {
    rustPlayerProcess.kill();
    rustPlayerProcess = null;
  }
});

function getRustPort() {
  return config.program.rustPlayerPort || 3333;
}

// ── Auto-boot logic ───────────────────────────────────────────────────────

function findRustBinary() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const candidates = [
    path.join(__dirname, `../../bin/rust-server-audio/rust-server-audio-${process.platform}-${process.arch}${ext}`),
    path.join(__dirname, `../../rust-server-audio/target/release/rust-server-audio${ext}`),
  ];

  for (const bin of candidates) {
    if (fs.existsSync(bin)) { return bin; }
  }
  return null;
}

export function bootRustPlayer() {
  if (!config.program.autoBootServerAudio) { return; }
  if (rustPlayerProcess) { return; }

  const bin = findRustBinary();
  if (!bin) {
    winston.warn('autoBootServerAudio is enabled but rust-server-audio binary not found');
    return;
  }

  const port = getRustPort();
  winston.info(`Starting rust-server-audio on port ${port}`);

  rustPlayerProcess = child_process.spawn(bin, ['--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  rustPlayerProcess.stdout.on('data', (data) => {
    winston.info(`[rust-audio] ${data.toString().trim()}`);
  });

  rustPlayerProcess.stderr.on('data', (data) => {
    winston.error(`[rust-audio] ${data.toString().trim()}`);
  });

  rustPlayerProcess.on('close', (code) => {
    winston.info(`rust-server-audio exited with code ${code}`);
    rustPlayerProcess = null;
  });

  rustPlayerProcess.on('error', (err) => {
    winston.error(`Failed to start rust-server-audio: ${err.message}`);
    rustPlayerProcess = null;
  });
}

export function killRustPlayer() {
  if (rustPlayerProcess) {
    rustPlayerProcess.kill();
    rustPlayerProcess = null;
  }
}

// Proxy a request to the Rust binary and pipe the response back
function proxyToRust(method, rustPath, body) {
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

// Resolve a virtual path (e.g. "55/song.mp3") to an absolute filesystem path
function resolveFilePath(filePath, user) {
  const info = vpath.getVPathInfo(filePath, user);
  return info.fullPath;
}

// Reverse: convert an absolute path back to a virtual path (e.g. "55/song.mp3")
function absoluteToVpath(absolutePath) {
  const normalized = path.normalize(absolutePath);
  for (const [vpathName, folder] of Object.entries(config.program.folders)) {
    const root = path.normalize(folder.root);
    if (normalized.startsWith(root)) {
      const relative = path.relative(root, normalized);
      return vpathName + '/' + relative.replace(/\\/g, '/');
    }
  }
  // If no vpath matches, return the filename as fallback
  return path.basename(absolutePath);
}

export function setup(mstream) {

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
        const result = await proxyToRust('POST', rustPath, req.body || {});
        res.status(result.status).json(result.data);
      } catch (e) {
        res.status(503).json({ error: e.message });
      }
    });
  }

  // ── POST routes with body passthrough ───────────────────────────────────

  mstream.post('/api/v1/server-playback/seek', async (req, res) => {
    try {
      const result = await proxyToRust('POST', '/seek', req.body);
      res.status(result.status).json(result.data);
    } catch (e) {
      res.status(503).json({ error: e.message });
    }
  });

  mstream.post('/api/v1/server-playback/volume', async (req, res) => {
    try {
      const result = await proxyToRust('POST', '/volume', req.body);
      res.status(result.status).json(result.data);
    } catch (e) {
      res.status(503).json({ error: e.message });
    }
  });

  mstream.post('/api/v1/server-playback/shuffle', async (req, res) => {
    try {
      const result = await proxyToRust('POST', '/shuffle', req.body);
      res.status(result.status).json(result.data);
    } catch (e) {
      res.status(503).json({ error: e.message });
    }
  });

  // ── GET routes ──────────────────────────────────────────────────────────

  mstream.get('/api/v1/server-playback/status', async (req, res) => {
    try {
      const result = await proxyToRust('GET', '/status');
      res.status(result.status).json(result.data);
    } catch (e) {
      res.status(503).json({ error: e.message });
    }
  });

  mstream.get('/api/v1/server-playback/queue', async (req, res) => {
    try {
      const result = await proxyToRust('GET', '/queue');
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
      const result = await proxyToRust('POST', '/play', { file: absolutePath });
      res.status(result.status).json(result.data);
    } catch (e) {
      res.status(e.message.includes('not running') ? 503 : 400).json({ error: e.message });
    }
  });

  // POST /queue/add — append one file
  mstream.post('/api/v1/server-playback/queue/add', async (req, res) => {
    try {
      const absolutePath = resolveFilePath(req.body.file, req.user);
      const result = await proxyToRust('POST', '/queue/add', { file: absolutePath });
      res.status(result.status).json(result.data);
    } catch (e) {
      res.status(e.message.includes('not running') ? 503 : 400).json({ error: e.message });
    }
  });

  // POST /queue/add-many — append multiple files
  mstream.post('/api/v1/server-playback/queue/add-many', async (req, res) => {
    try {
      const files = req.body.files.map((f) => resolveFilePath(f, req.user));
      const result = await proxyToRust('POST', '/queue/add-many', { files });
      res.status(result.status).json(result.data);
    } catch (e) {
      res.status(e.message.includes('not running') ? 503 : 400).json({ error: e.message });
    }
  });

  // POST /queue/play-index — jump to index
  mstream.post('/api/v1/server-playback/queue/play-index', async (req, res) => {
    try {
      const result = await proxyToRust('POST', '/queue/play-index', req.body);
      res.status(result.status).json(result.data);
    } catch (e) {
      res.status(503).json({ error: e.message });
    }
  });

  // POST /queue/remove — remove by index
  mstream.post('/api/v1/server-playback/queue/remove', async (req, res) => {
    try {
      const result = await proxyToRust('POST', '/queue/remove', req.body);
      res.status(result.status).json(result.data);
    } catch (e) {
      res.status(503).json({ error: e.message });
    }
  });

  // POST /queue/clear — stop and empty queue
  mstream.post('/api/v1/server-playback/queue/clear', async (req, res) => {
    try {
      const result = await proxyToRust('POST', '/queue/clear', {});
      res.status(result.status).json(result.data);
    } catch (e) {
      res.status(503).json({ error: e.message });
    }
  });
}

// ── Server-Remote route (serves the webapp with serverAudioMode flag) ─────

export function setupBeforeAuth(mstream) {
  mstream.get('/server-remote', async (req, res) => {
    // Check if the Rust audio service is reachable before serving the page
    try {
      await proxyToRust('GET', '/status');
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
    } catch (e) {
      res.status(500).json({ error: 'Failed to serve server-remote page' });
    }
  });
}
