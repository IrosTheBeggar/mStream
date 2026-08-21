/**
 * Minimal HTTP stub that impersonates the mstream-player binary for
 * tests. Mirrors the subset of endpoints the Subsonic jukeboxControl
 * handler (src/api/subsonic/handlers.js) proxies to — enough to exercise
 * every action code path without actually shipping audio to a sound card.
 *
 * State is in-memory and per-instance; every request is recorded on
 * `calls` so tests can assert the proxy layer forwarded the right things.
 */

import http from 'node:http';
import net from 'node:net';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export async function startFakeRustAudio() {
  const port = await freePort();

  // The mstream-player status shape — kept in sync with the Status struct
  // in IrosTheBeggar/mstream-terminal-player's src/engine/mod.rs.
  const state = {
    playing:      false,
    paused:       false,
    position:     0,
    duration:     0,
    volume:       1.0,
    file:         '',
    queue:        [],
    queue_index:  0,
    queue_length: 0,
    shuffle:      false,
    loop_mode:    'none',
  };
  const calls = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      calls.push({ method: req.method, path: req.url, body });
      let parsed = {};
      if (body) { try { parsed = JSON.parse(body); } catch { /* ignore */ } }

      const ok = (extra = {}) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...extra }));
      };

      switch (`${req.method} ${req.url}`) {
        case 'GET /status':
          state.queue_length = state.queue.length;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(state));
          return;

        case 'GET /queue':
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ queue: state.queue, current_index: state.queue_index }));
          return;

        case 'POST /play':
          state.queue = [parsed.file];
          state.queue_index = 0;
          state.playing = true;
          state.paused = false;
          state.file = parsed.file || '';
          ok(); return;

        case 'POST /pause':
          state.playing = false;
          state.paused = true;
          ok(); return;

        case 'POST /resume':
          state.playing = true;
          state.paused = false;
          ok(); return;

        case 'POST /stop':
          state.playing = false;
          state.paused = false;
          state.queue_index = 0;
          ok(); return;

        case 'POST /queue/clear':
          state.queue = [];
          state.queue_index = 0;
          state.playing = false;
          ok(); return;

        case 'POST /queue/add':
          if (parsed.file) { state.queue.push(parsed.file); }
          ok(); return;

        case 'POST /queue/add-many':
          if (Array.isArray(parsed.files)) {
            state.queue.push(...parsed.files);
          }
          ok(); return;

        case 'POST /queue/play-index':
          if (Number.isInteger(parsed.index)) {
            state.queue_index = parsed.index;
            state.playing = true;
            state.paused = false;
            state.file = state.queue[parsed.index] || '';
          }
          ok(); return;

        case 'POST /queue/remove':
          if (Number.isInteger(parsed.index)) {
            state.queue.splice(parsed.index, 1);
          }
          ok(); return;

        case 'POST /seek':
          state.position = parsed.position || 0;
          ok(); return;

        case 'POST /volume':
          state.volume = parsed.volume ?? state.volume;
          ok(); return;

        case 'POST /shuffle':
          state.shuffle = !state.shuffle;
          ok(); return;

        case 'POST /next':
        case 'POST /previous':
        case 'POST /loop':
          ok(); return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    port,
    state,   // exposed so tests can assert against the stub's view of the world
    calls,   // request log
    reset() { calls.length = 0; },
    async stop() {
      if (!server.listening) { return; }
      await new Promise(r => server.close(r));
    },
  };
}
