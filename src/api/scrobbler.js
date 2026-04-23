import crypto from 'crypto';
import Joi from 'joi';
import axios from 'axios';
import * as config from '../state/config.js';
import Scribble from '../state/lastfm.js';
import * as db from '../db/manager.js';
import { joiValidate } from '../util/validation.js';
import { getVPathInfo } from '../util/vpath.js';

const Scrobbler = new Scribble();

// ── Last.fm mobile-session handshake ───────────────────────────────────────
//
// Exchanges (username, password) for a long-lived session key via Last.fm's
// auth.getMobileSession endpoint. The session key is what every subsequent
// scrobble / now-playing / love call signs with; once we have it, the
// password is disposable and should not be persisted.
//
// Pulled out of the /lastfm/test-login handler so both test-login and
// /lastfm/connect can reuse it. Returns the session-key string on success
// and throws a readable error on failure (bad credentials, network issue,
// unexpected response shape).
export async function fetchLastfmSessionKey(username, password) {
  const apiKey = config.program.lastFM?.apiKey;
  const apiSecret = config.program.lastFM?.apiSecret;
  if (!apiKey || !apiSecret) { throw new Error('Last.fm API credentials not configured'); }

  const pwHash = crypto.createHash('md5').update(password, 'utf8').digest('hex');
  const token  = crypto.createHash('md5').update(username + pwHash, 'utf8').digest('hex');
  const sigSrc = `api_key${apiKey}authToken${token}methodauth.getMobileSessionusername${username}${apiSecret}`;
  const apiSig = crypto.createHash('md5').update(sigSrc, 'utf8').digest('hex');

  const url = `https://ws.audioscrobbler.com/2.0/?method=auth.getMobileSession`
    + `&username=${encodeURIComponent(username)}`
    + `&authToken=${token}&api_key=${apiKey}&api_sig=${apiSig}&format=json`;
  const r = await axios.get(url, { validateStatus: () => true });
  if (r.status < 200 || r.status >= 300 || !r.data) {
    throw new Error(`Last.fm auth failed (HTTP ${r.status})`);
  }
  // Last.fm returns { error: <n>, message: "..." } on failure.
  if (r.data.error) {
    throw new Error(r.data.message || `Last.fm error ${r.data.error}`);
  }
  const sk = r.data?.session?.key;
  if (!sk) { throw new Error('Last.fm response missing session key'); }
  return sk;
}

// Called by /api/v1/lastfm/connect after the handshake succeeds: registers
// the user with the in-process scrobbler so later scrobble calls don't need
// to re-exchange. Safe to call multiple times for the same user.
export function registerLastfmUser(username, sessionKey, passwordFallback) {
  if (!username) return;
  Scrobbler.addUser(username, passwordFallback || null, sessionKey || null);
}

export function setup(mstream) {
  Scrobbler.setKeys(config.program.lastFM.apiKey, config.program.lastFM.apiSecret);

  // Initialize Last.fm users from the database on boot. Prefer the V27
  // session-key column; fall back to the legacy password column for rows
  // that predate the refactor. Either path populates the Scribble
  // singleton so the first scrobble doesn't pay the handshake round-trip.
  const users = db.getAllUsers();
  for (const user of users) {
    if (!user.lastfm_user) { continue; }
    if (!user.lastfm_session_key && !user.lastfm_password) { continue; }
    Scrobbler.addUser(
      user.lastfm_user,
      user.lastfm_password || null,
      user.lastfm_session_key || null,
    );
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
      SELECT t.file_hash, t.audio_hash, t.title, a.name AS artist, al.name AS album
      FROM tracks t
      LEFT JOIN artists a ON t.artist_id = a.id
      LEFT JOIN albums al ON t.album_id = al.id
      WHERE t.filepath = ? AND t.library_id = ?
    `).get(pathInfo.relativePath, lib.id);

    if (!track) {
      return res.json({ scrobble: false });
    }

    // Prefer audio_hash (stable across tag edits). Older rows and
    // formats we don't yet parse fall back to file_hash.
    const trackKey = track.audio_hash || track.file_hash;

    // Update play count and last played
    d().prepare(`
      INSERT INTO user_metadata (user_id, track_hash, play_count, last_played)
      VALUES (?, ?, 1, datetime('now'))
      ON CONFLICT(user_id, track_hash) DO UPDATE SET
        play_count = play_count + 1,
        last_played = datetime('now')
    `).run(req.user.id, trackKey);

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

    await axios({
      method: 'GET',
      url: `http://ws.audioscrobbler.com/2.0/?method=auth.getMobileSession&username=${req.body.username}&authToken=${token}&api_key=${config.program.lastFM.apiKey}&api_sig=${hash}`
    });
    res.json({});
  });
}

export function reset() {
  Scrobbler.reset();
}
