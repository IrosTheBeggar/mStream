import express from 'express';
import http from 'node:http';
import winston from 'winston';
import * as config from '../state/config.js';
import * as dlnaApi from '../api/dlna.js';
import { serveAlbumArtFile } from '../api/album-art.js';
import { timeSeekMiddleware } from './time-seek.js';
import { resolveLibraryMediaPath } from './media-path.js';

let dlnaServer = null;

export function start() {
  if (dlnaServer) { return; }

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

  const s = http.createServer(app);
  dlnaServer = s;

  s.listen(config.program.dlna.port, config.program.address, () => {
    winston.info(`[dlna] Separate server listening on port ${config.program.dlna.port}`);
  });

  s.on('error', (err) => {
    winston.error(`[dlna] Separate server error: ${err.message}`);
    // Only clear the module-level reference if it still points at THIS server.
    // A late error on an already-replaced server must not nullify the new one.
    if (dlnaServer === s) { dlnaServer = null; }
  });
}

export function stop() {
  if (!dlnaServer) { return; }
  const s = dlnaServer;
  dlnaServer = null;
  s.close(() => { winston.info('[dlna] Separate server stopped'); });
}

export function isRunning() {
  return dlnaServer !== null;
}
