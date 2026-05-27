import url from 'url';
import path from 'path';
import fs from 'fs/promises';
import Joi from 'joi';
import { nanoid } from 'nanoid';
import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { joiValidate } from '../util/validation.js';

// list of currently connected clients (users)
const clients = {};
// Map code to JWT
const codeTokenMap = {};
// Cache of playlist data pushed from the browser
const playlistCache = {};
// Cache of now-playing state pushed from the browser
const nowPlayingCache = {};

const allowedCommands = [
  'next',
  'previous',
  'playPause',
  'addSong',
  'getPlaylist',
  'getNowPlaying',
  'goToSong',
  'removeSong',
  'setVolume',
];

// Module-level reference so `stop()` can close the server on reboot.
// Leaving it bound keeps the HTTP server alive forever (`server.close()`
// waits for every upgrade/socket to finish) and mStream's UI switcher
// never completes its reboot step — user-visible as "server stopped
// but never came back up".
let wss = null;
let upgradeHandler = null;
let httpServerRef = null;

export function stop() {
  if (!wss) { return; }
  try {
    // Gracefully ask every open connection to close, then terminate
    // any stragglers after a short grace period so reboot isn't
    // blocked by a misbehaving client.
    for (const client of wss.clients) {
      try { client.close(); } catch (_) {}
    }
    wss.close();
  } catch (_) {}
  if (httpServerRef && upgradeHandler) {
    httpServerRef.removeListener('upgrade', upgradeHandler);
  }
  upgradeHandler = null;
  httpServerRef = null;
  wss = null;
}

export function setupAfterAuth(mstream, server) {
  // `noServer: true` keeps the WebSocketServer from auto-binding to
  // every upgrade event on the HTTP server. We register a manual
  // upgrade router (below) that filters by path so Socket.IO's own
  // upgrade listener for /socket.io can handle its requests
  // uncontested. The jukebox/remote feature has historically used
  // root-path upgrades (`ws://host?token=…`) so without this guard
  // the remote WS server steals all upgrade requests, including the
  // Audiobookshelf adapter's /socket.io handshakes.
  wss = new WebSocketServer({ noServer: true });
  httpServerRef = server;

  function verifyClient(info, cb) {
    try {
      let decoded;
      const allUsers = db.getAllUsers ? db.getAllUsers() : [];
      if (allUsers.length !== 0) {
        const token = url.parse(info.req.url, true).query.token;
        if (!token) { throw new Error('Token Not Found'); }
        decoded = jwt.verify(token, config.program.secret);
      }

      info.req.code = url.parse(info.req.url, true).query.code;
      if (info.req.code in clients) { throw new Error('Code In Use'); }

      info.req.jwt = jwt.sign({
        username: decoded !== undefined ? decoded.username : 'mstream-user',
        jukebox: true
      }, config.program.secret);
      cb(true);
    } catch (err) {
      winston.error('WS Connection Failed', { stack: err });
      cb(false, 401, 'Unauthorized');
    }
  }

  upgradeHandler = (req, socket, head) => {
    // Skip /socket.io/* upgrades — those belong to the Audiobookshelf
    // adapter's Socket.IO server (also attached to this same http.Server
    // in the post-listen hook). Returning early lets socket.io's own
    // upgrade listener handle them.
    const path = (req.url || '').split('?')[0];
    if (path.startsWith('/socket.io')) { return; }

    verifyClient({ req }, (ok, code, message) => {
      if (!ok) {
        socket.write(`HTTP/1.1 ${code || 401} ${message || 'Unauthorized'}\r\n\r\n`);
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });
  };
  server.on('upgrade', upgradeHandler);

  wss.on('connection', (connection, req) => {
    const code = nanoid(8);
    winston.info(`Websocket Connection Accepted With Code: ${code}`);
    clients[code] = connection;

    if (req.jwt) { codeTokenMap[code] = req.jwt; }

    connection.send(JSON.stringify({ code: code, token: req.jwt ? req.jwt : false }));

    // user sent message
    connection.on('message', (_message) => {
      connection.send(JSON.stringify({ code: code }));
    });

    connection.on('close', (_connection) => {
      delete clients[code];
      if (codeTokenMap[code]) { delete codeTokenMap[code]; }
      if (playlistCache[code]) { delete playlistCache[code]; }
      if (nowPlayingCache[code]) { delete nowPlayingCache[code]; }
    });
  });

  mstream.post('/api/v1/jukebox/push-to-client', (req, res) => {
    const schema = Joi.object({
      code: Joi.string().required(),
      command: Joi.string().required(),
      file: Joi.string().optional().allow('')
    });
    joiValidate(schema, req.body);

    if (!(req.body.code in clients)) {
      throw new Error('Code Not Found');
    }

    if (allowedCommands.indexOf(req.body.command) === -1) {
      throw new Error('Command Not Recognized');
    }

    // Push commands to client
    const msg = { command: req.body.command };
    if (req.body.file !== undefined && req.body.file !== '') {
      msg.file = req.body.file;
    }
    clients[req.body.code].send(JSON.stringify(msg));

    // Send confirmation back to user
    res.json({ });
  });

  // Browser posts its current playlist here so remotes can fetch it
  mstream.post('/api/v1/jukebox/update-playlist', (req, res) => {
    const schema = Joi.object({
      code: Joi.string().required(),
      playlist: Joi.array().required()
    });
    joiValidate(schema, req.body);

    if (!(req.body.code in clients)) {
      throw new Error('Code Not Found');
    }

    playlistCache[req.body.code] = req.body.playlist;
    res.json({});
  });

  // Browser posts its current now-playing state here so remotes can fetch it
  mstream.post('/api/v1/jukebox/update-now-playing', (req, res) => {
    const schema = Joi.object({
      code: Joi.string().required(),
      nowPlaying: Joi.object({
        title: Joi.string().allow('').optional(),
        artist: Joi.string().allow('').optional(),
        album: Joi.string().allow('').optional(),
        albumArt: Joi.string().allow('').optional(),
        filepath: Joi.string().allow('').optional(),
        playing: Joi.boolean().optional(),
        index: Joi.number().integer().optional(),
        currentTime: Joi.number().optional(),
        duration: Joi.number().optional()
      }).required()
    });
    joiValidate(schema, req.body);

    if (!(req.body.code in clients)) {
      throw new Error('Code Not Found');
    }

    nowPlayingCache[req.body.code] = req.body.nowPlaying;
    res.json({});
  });
}

// This part is run before the login code
export function setupBeforeAuth(mstream) {
  mstream.post('/api/v1/jukebox/does-code-exist', (req, res) => {
    const clientCode = req.body.code;

    // Check that code exists
    if (!(clientCode in clients) || !(clientCode in codeTokenMap)) {
      return res.json({ status: false });
    }

    res.json({ status: true, token: codeTokenMap[clientCode] });
  });

  // Remote fetches the playlist that the browser last pushed
  mstream.get('/api/v1/jukebox/get-playlist', (req, res) => {
    const code = req.query.code;
    if (!code || !(code in clients)) {
      return res.json({ playlist: [] });
    }
    res.json({ playlist: playlistCache[code] || [] });
  });

  // Remote fetches the now-playing state that the browser last pushed
  mstream.get('/api/v1/jukebox/get-now-playing', (req, res) => {
    const code = req.query.code;
    if (!code || !(code in clients)) {
      return res.json({ nowPlaying: null });
    }
    res.json({ nowPlaying: nowPlayingCache[code] || null });
  });

  mstream.get('/remote/:remoteId', async (req, res) => {
    const clientCode = req.params.remoteId;
    if (!(clientCode in clients) || !(clientCode in codeTokenMap)) {
      throw new Error('Token Not Found');
    }

    let sharePage = await fs.readFile(path.join(config.program.webAppDirectory, 'remote/index.html'), 'utf-8');
    sharePage = sharePage.replace(/\.\.\//g, '../../');
    sharePage = sharePage.replace(
      '<script></script>',
      `<script>var remoteProperties = ${JSON.stringify({ code: clientCode, error: false, token: codeTokenMap[clientCode] })}</script>`
    );
    res.send(sharePage);
  });
}

// Check if a jukebox JWT token belongs to an active session
export function isActiveJukeboxToken(token) {
  return Object.values(codeTokenMap).includes(token);
}
