import crypto from 'crypto';
import Joi from 'joi';
import * as config from '../state/config.js';
import Scribble from '../state/lastfm.js';
import * as db from '../db/manager.js';
import { joiValidate } from '../util/validation.js';
import { getVPathInfo } from '../util/vpath.js';

const Scrobbler = new Scribble();

export function setup(mstream) {
  Scrobbler.setKeys(config.program.lastFM.apiKey, config.program.lastFM.apiSecret);

  // Initialize lastfm users from database
  const users = db.getAllUsers();
  for (const user of users) {
    if (!user.lastfm_user || !user.lastfm_password) { continue; }
    Scrobbler.addUser(user.lastfm_user, user.lastfm_password);
  }

  const d = () => db.getDB();

  mstream.post('/api/v1/lastfm/scrobble-by-metadata', (req, res) => {
    const schema = Joi.object({
      artist: Joi.string().optional().allow(''),
      album: Joi.string().optional().allow(''),
      track: Joi.string().required(),
    });
    joiValidate(schema, req.body);

    if (!req.user.lastfm_user || !req.user.lastfm_password) {
      return res.json({ scrobble: false });
    }

    Scrobbler.Scrobble(
      req.body,
      req.user.lastfm_user,
      (_post_return_data) => { res.json({}); }
    );
  });

  mstream.post('/api/v1/lastfm/scrobble-by-filepath', (req, res) => {
    const schema = Joi.object({
      filePath: Joi.string().required(),
    });
    joiValidate(schema, req.body);

    const pathInfo = getVPathInfo(req.body.filePath, req.user);
    const lib = db.getLibraryByName(pathInfo.vpath);
    if (!lib) { return res.json({ scrobble: false }); }

    const track = d().prepare(`
      SELECT t.file_hash, t.title, a.name AS artist, al.name AS album
      FROM tracks t
      LEFT JOIN artists a ON t.artist_id = a.id
      LEFT JOIN albums al ON t.album_id = al.id
      WHERE t.filepath = ? AND t.library_id = ?
    `).get(pathInfo.relativePath, lib.id);

    if (!track) {
      return res.json({ scrobble: false });
    }

    // Update play count and last played
    d().prepare(`
      INSERT INTO user_metadata (user_id, track_hash, play_count, last_played)
      VALUES (?, ?, 1, datetime('now'))
      ON CONFLICT(user_id, track_hash) DO UPDATE SET
        play_count = play_count + 1,
        last_played = datetime('now')
    `).run(req.user.id, track.file_hash);

    res.json({});

    // Scrobble to last.fm if configured
    if (req.user.lastfm_user && req.user.lastfm_password) {
      Scrobbler.Scrobble(
        { artist: track.artist, album: track.album, track: track.title },
        req.user.lastfm_user,
        (_post_return_data) => {}
      );
    }
  });

  mstream.post('/api/v1/lastfm/test-login', async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required(),
      password: Joi.string().required()
    });
    joiValidate(schema, req.body);

    const token = crypto.createHash('md5').update(req.body.username + crypto.createHash('md5').update(req.body.password, 'utf8').digest('hex'), 'utf8').digest('hex');
    const cryptoString = `api_key${config.program.lastFM.apiKey}authToken${token}methodauth.getMobileSessionusername${req.body.username}${config.program.lastFM.apiSecret}`;
    const hash = crypto.createHash('md5').update(cryptoString, 'utf8').digest('hex');

    const lastfmRes = await fetch(
      `http://ws.audioscrobbler.com/2.0/?method=auth.getMobileSession&username=${req.body.username}&authToken=${token}&api_key=${config.program.lastFM.apiKey}&api_sig=${hash}`
    );
    if (!lastfmRes.ok) {
      throw new Error(`last.fm test-login returned ${lastfmRes.status}`);
    }
    res.json({});
  });
}

export function reset() {
  Scrobbler.reset();
}
