// A secondary HTTP listener (the DLNA separate-port server)
// that survives a soft reboot when its bind is unchanged, and recycles with
// the main listener's same-port patience when it isn't.
//
// Why: server.js's reboot keeps the MAIN listening socket across a same-bind
// reboot precisely because, on Windows under Bun <= 1.3.14, every spawned
// child (scanner, transcode, ffmpeg download, enrichment worker) inherits a
// handle to every listen socket in the process, and close() in the parent
// releases nothing until that child exits (oven-sh/bun#36938; fix first
// released in Bun 1.4.0). The separate-port servers were still doing
// close()+listen() on every reboot: their
// re-listen hit EADDRINUSE mid-scan, their 'error' handler nulled the module
// reference, and the secondary API (at the time the Subsonic API — every
// mobile client) stayed silently dead until the next restart while the tray
// said Running. Keeping the server
// object across a same-bind reboot sidesteps that on every runtime; a bind
// change (port/address edit) recycles, retrying EADDRINUSE with backoff when
// it is re-taking the port it just held (a release delay or a held handle,
// not a conflict — same reasoning as serveIt's samePortRelisten).
//
// The Express app inside is rebuilt on every recycle and REUSED across a keep:
// both apps read config/db at request time (route setup captures nothing
// per-boot), so the kept app serves the rebooted config correctly.
import http from 'node:http';
import winston from 'winston';

export function createKeptListener(name) {
  let server = null;   // the live http.Server, or null
  let bound = null;    // { port, address } it was told to serve

  // Serve `build()` on { port, address }. Keeps the current server when the
  // bind is unchanged; otherwise closes it and listens afresh.
  function ensure({ port, address, build }) {
    const want = { port, address: address ?? null };
    if (server && bound && bound.port === want.port && bound.address === want.address) {
      winston.info(`[${name}] Separate server kept across reboot on port ${port}`);
      return;
    }
    // Re-taking the port we just held (address change): EADDRINUSE there is a
    // release delay / a child's inherited handle, not a conflict — wait it out.
    const samePortRelisten = !!(server && bound && bound.port === want.port);
    if (server) {
      const old = server;
      server = null; bound = null;
      old.close(() => { winston.info(`[${name}] Separate server on port ${old._keptPort} recycled`); });
    }

    const s = http.createServer(build());
    s._keptPort = want.port;
    server = s; bound = want;
    const startedAt = Date.now();
    let attempts = 0;
    let lastLoggedAt = 0;
    let diagnosed = false;

    s.on('error', (err) => {
      if (server !== s) { return; }   // superseded by a later ensure()/stop()
      if (err.code === 'EADDRINUSE' && samePortRelisten) {
        attempts++;
        const waitedMs = Date.now() - startedAt;
        const delay = waitedMs < 2000 ? 250 : waitedMs < 30000 ? 1000 : 5000;
        if (attempts === 1) {
          winston.warn(`[${name}] Port ${port} not released yet after reboot — retrying listen`);
          lastLoggedAt = Date.now();
        } else if (waitedMs >= 5000 && Date.now() - lastLoggedAt >= (diagnosed ? 30000 : 0)) {
          winston.warn(
            `[${name}] Port ${port} still held ${Math.round(waitedMs / 1000)}s after reboot — retrying until it frees ` +
            '(the separate server is unreachable meanwhile). A child process alive during the reboot can hold the ' +
            'old listening socket until it exits (Bun <= 1.3.14 on Windows: oven-sh/bun#36938, ' +
            'fixed in Bun 1.4.0).');
          diagnosed = true;
          lastLoggedAt = Date.now();
        }
        setTimeout(() => { if (server === s) { s.listen(want.port, want.address ?? undefined); } }, delay);
        return;
      }
      winston.error(`[${name}] Separate server error: ${err.message}`);
      // Only clear the module ref if it still points at THIS server: a late
      // error on an already-replaced instance must not nullify the new one.
      if (server === s) { server = null; bound = null; }
    });
    s.once('listening', () => {
      if (attempts > 0) {
        winston.info(`[${name}] Port ${port} released after ${Math.round((Date.now() - startedAt) / 1000)}s (${attempts} retries)`);
      }
      winston.info(`[${name}] Separate server listening on port ${port}`);
    });
    s.listen(want.port, want.address ?? undefined);
  }

  function stop() {
    if (!server) { return; }
    const s = server;
    server = null; bound = null;
    s.close(() => { winston.info(`[${name}] Separate server stopped`); });
  }

  function isRunning() { return server !== null; }

  return { ensure, stop, isRunning };
}
