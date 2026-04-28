import { newId } from '../util/ids.js';
import jwt from 'jsonwebtoken';
import path from 'path';
import fs from 'fs/promises';
import Joi from 'joi';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { joiValidate } from '../util/validation.js';
import WebError from '../util/web-error.js';

function lookupShared(playlistId) {
  const d = db.getDB();
  const row = d.prepare(
    'SELECT * FROM shared_playlists WHERE share_id = ?'
  ).get(playlistId);

  if (!row) { throw new WebError('Playlist Not Found'); }

  // Verify the token is still valid
  jwt.verify(row.token, config.program.secret);

  return {
    token: row.token,
    playlist: JSON.parse(row.playlist_json)
  };
}

export function lookupPlaylist(playlistId) {
  return lookupShared(playlistId);
}

export function setupBeforeSecurity(mstream) {
  mstream.get('/shared/:playlistId', async (req, res) => {
    if (req.path.endsWith('/')) {
      const matchEnd = req.path.match(/(\/)+$/g);
      const queryString = req.url.match(/(\?.*)/g) === null ? '' : req.url.match(/(\?.*)/g);
      return res.redirect(301, req.path.slice(0, (matchEnd[0].length) * -1) + queryString[0]);
    }

    if (!req.params.playlistId) { throw new WebError('Validation Error', 403); }
    let sharePage = await fs.readFile(path.join(config.program.webAppDirectory, 'shared/index.html'), 'utf-8');
    sharePage = sharePage.replace(
      '<script></script>',
      `<script>const sharedPlaylist = ${JSON.stringify(lookupShared(req.params.playlistId))}</script>`
    );
    res.send(sharePage);
  });

  mstream.get('/api/v1/shared/:playlistId', (req, res) => {
    if (!req.params.playlistId) { throw new WebError('Validation Error', 403); }
    res.json(lookupShared(req.params.playlistId));
  });
}

export function setupAfterSecurity(mstream) {
  const d = () => db.getDB();

  mstream.post('/api/v1/share', (req, res) => {
    const schema = Joi.object({
      playlist: Joi.array().items(Joi.string()).required(),
      time: Joi.number().integer().positive().optional()
    });
    joiValidate(schema, req.body);

    const shareId = newId(10);

    const tokenData = {
      playlistId: shareId,
      shareToken: true,
      username: req.user.username
    };

    const jwtOptions = {};
    if (req.body.time) { jwtOptions.expiresIn = `${req.body.time}d`; }
    const token = jwt.sign(tokenData, config.program.secret, jwtOptions);

    const expires = req.body.time ? jwt.verify(token, config.program.secret).exp : null;

    d().prepare(`
      INSERT INTO shared_playlists (share_id, playlist_json, user_id, expires, token)
      VALUES (?, ?, ?, ?, ?)
    `).run(shareId, JSON.stringify(req.body.playlist), req.user.id, expires, token);

    res.json({
      playlistId: shareId,
      playlist: req.body.playlist,
      user: req.user.username,
      expires: expires,
      token: token
    });
  });
}
