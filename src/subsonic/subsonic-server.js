/**
 * Subsonic REST API — separate-port server.
 *
 * When `subsonic.mode = 'separate-port'` the REST API is hosted on its own
 * HTTP server so it can be firewalled, reverse-proxied, or log-filtered
 * independently of the main mStream web UI. Authentication is still handled
 * by the Subsonic layer itself (u/p or apiKey), so this server carries no
 * mStream session cookies.
 *
 * The listener is a kept listener (util/kept-listener.js): start() after a
 * soft reboot KEEPS the socket when port/address are unchanged and only
 * recycles it (with same-port EADDRINUSE patience) when they changed — the
 * same rule the main listener follows, for the same Windows/Bun reason.
 */

import express from 'express';
import * as config from '../state/config.js';
import * as subsonicApi from '../api/subsonic/index.js';
import { createKeptListener } from '../util/kept-listener.js';

const listener = createKeptListener('subsonic');

export function start() {
  listener.ensure({
    port: config.program.subsonic.port,
    address: config.program.address,
    build: () => {
      const app = express();
      app.use(express.urlencoded({ extended: true }));
      app.use(express.json());
      subsonicApi.setup(app);
      return app;
    },
  });
}

export function stop() { listener.stop(); }

export function isRunning() { return listener.isRunning(); }
