import express from 'express';
import * as config from '../state/config.js';
import * as dlnaApi from '../api/dlna.js';
import { serveAlbumArtFile } from '../api/album-art.js';
import { timeSeekMiddleware } from './time-seek.js';
import { resolveLibraryMediaPath } from './media-path.js';
import { createKeptListener } from '../util/kept-listener.js';

// Kept listener (util/kept-listener.js): start() after a soft reboot keeps
// the socket when port/address are unchanged and recycles it (with same-port
// EADDRINUSE patience) when they changed — the main listener's rule.
const listener = createKeptListener('dlna');

function buildApp() {
  const app = express();

  // Time-seek (TimeSeekRange.dlna.org) handler runs first; it calls next()
  // when the client is making a plain byte-range request.
  app.use('/media', timeSeekMiddleware);

  // Serve media files directly from library roots — no auth, no static mount.
  // Reads library list from DB at request time so additions/removals are live.
  app.use('/media', (req, res) => {
    const r = resolveLibraryMediaPath(req.path);
    if (!r.ok) { return res.status(r.status).end(); }
    res.sendFile(r.resolved, { dotfiles: 'allow' }, (err) => {
      // sendFile streams asynchronously, so a stale DB row (file deleted before
      // the scan caught up) or a client abort surfaces here rather than above.
      // Map a missing file to a clean 404 instead of letting it fall through to
      // Express's default error handler (which would leak a stack trace). Once
      // bytes are already flowing the headers are committed — nothing left to do.
      if (!err || res.headersSent) { return; }
      const status = ((err.status || err.statusCode) === 404 || err.code === 'ENOENT') ? 404 : 500;
      res.status(status).end();
    });
  });

  app.get('/album-art/:file', serveAlbumArtFile);

  // All DLNA control/description routes — no mode guard needed on this server
  dlnaApi.setup(app, { checkMode: false });
  return app;
}

export function start() {
  listener.ensure({
    port: config.program.dlna.port,
    address: config.program.address,
    build: buildApp,
  });
}

export function stop() { listener.stop(); }

export function isRunning() { return listener.isRunning(); }
