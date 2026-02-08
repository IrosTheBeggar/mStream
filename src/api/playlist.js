import Joi from 'joi';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { joiValidate } from '../util/validation.js';

export function setup(mstream) {
  // TODO: This is a legacy endpoint that should be improved
  mstream.get('/api/v1/ping', (req, res) => {
    let transcode = false;
    if (config.program.transcode && config.program.transcode.enabled) {
      transcode = {
        defaultCodec: config.program.transcode.defaultCodec,
        defaultBitrate: config.program.transcode.defaultBitrate,
        defaultAlgorithm: config.program.transcode.algorithm
      }
    }

    const returnThis = {
      vpaths: req.user.vpaths,
      playlists: db.getUserPlaylists(req.user.username),
      transcode,
      vpathMetaData: {}
    };

    req.user.vpaths.forEach(p => {
      if (config.program.folders[p]) {
        returnThis.vpathMetaData[p] = {
          type: config.program.folders[p].type
        };
      }
    });

    res.json(returnThis);
  });

  mstream.post('/api/v1/playlist/delete', (req, res) => {
    const schema = Joi.object({ playlistname: Joi.string().required() });
    joiValidate(schema, req.body);

    db.deletePlaylist(req.user.username, req.body.playlistname);
    db.saveUserDB();
    res.json({});
  });

  mstream.post('/api/v1/playlist/add-song', (req, res) => {
    const schema = Joi.object({
      song: Joi.string().required(),
      playlist: Joi.string().required()
    });
    joiValidate(schema, req.body);

    db.createPlaylistEntry({
      name: req.body.playlist,
      filepath: req.body.song,
      user: req.user.username
    });

    db.saveUserDB();
    res.json({});
  });

  mstream.post('/api/v1/playlist/remove-song', (req, res) => {
    const schema = Joi.object({ id: Joi.number().integer().required() });
    joiValidate(schema, req.body);

    const result = db.getPlaylistEntryById(req.body.id);
    if (!result || result.user !== req.user.username) {
      throw new Error(`User ${req.user.username} tried accessing a resource they don't have access to. Playlist ID: ${req.body.id}`);
    }

    db.removePlaylistEntryById(req.body.id);
    db.saveUserDB();
    res.json({});
  });

  mstream.post('/api/v1/playlist/new', (req, res) => {
    const schema = Joi.object({ title: Joi.string().required() });
    joiValidate(schema, req.body);

    const results = db.findPlaylist(req.user.username, req.body.title);
    if (results !== null) {
      return res.status(400).json({ error: 'Playlist Already Exists' });
    }

    // insert null entry
    db.createPlaylistEntry({
      name: req.body.title,
      filepath: null,
      user: req.user.username,
      live: false
    });

    db.saveUserDB();
    res.json({});
  });

  mstream.post('/api/v1/playlist/save', (req, res) => {
    const schema = Joi.object({
      title: Joi.string().required(),
      songs: Joi.array().items(Joi.string()),
      live: Joi.boolean().optional()
    });
    joiValidate(schema, req.body);

    // Delete existing playlist
    db.deletePlaylist(req.user.username, req.body.title);

    for (const song of req.body.songs) {
      db.createPlaylistEntry({
        name: req.body.title,
        filepath: song,
        user: req.user.username
      });
    }

    // insert null entry
    db.createPlaylistEntry({
      name: req.body.title,
      filepath: null,
      user: req.user.username,
      live: typeof req.body.live === 'boolean' ? req.body.live : false
    });

    db.saveUserDB();
    res.json({});
  });

  mstream.get('/api/v1/playlist/getall', (req, res) => {
    res.json(db.getUserPlaylists(req.user.username));
  });
}
