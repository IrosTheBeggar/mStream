const winston = require('winston');
const Joi = require('joi');
const config = require('../state/config');
const db = require('../db/manager');

exports.setup = (mstream) => {
  // TODO: This is a legacy endpoint that should be improved
  mstream.get('/api/v1/ping', (req, res) => {
    let transcode = false;
    if (config.program.transcode && config.program.transcode.enabled) {
      transcode = {
        defaultCodec: config.program.transcode.defaultCodec,
        defaultBitrate: config.program.transcode.defaultBitrate,
      }
    }

    res.json({
      vpaths: req.user.vpaths,
      playlists: getPlaylists(req.user.username),
      federationId: null,
      transcode
    });
  });

  mstream.post('/api/v1/playlist/delete', async (req, res) => {
    try {
      const schema = Joi.object({ playlistname: Joi.string().required() });
      await schema.validateAsync(req.body);
    }catch (err) {
      return res.status(500).json({ error: 'Validation Error' });
    }

    try {
      if (!db.getPlaylistCollection()) { throw 'DB Error'; }

      db.getPlaylistCollection().findAndRemove({
        '$and': [
          { 'user': { '$eq': req.user.username }},
          { 'name': { '$eq': req.body.playlistname }}
        ]
      });

      res.json({});
    } catch (err) {
      winston.error('Db Error', { stack: err });
      res.status(500).json({ error: typeof err === 'string' ? err : 'Unknown Error' });
    }

    userDataDb.saveDatabase(err =>  {
      if (err) { winston.error('Playlist Save Error', { stack: err }); }
    });
  });

  mstream.post('/api/v1/playlist/add-song', async (req, res) => {
    try {
      const schema = Joi.object({
        song: Joi.string().required(),
        playlist: Joi.string().required()
      });
      await schema.validateAsync(req.body);
    }catch (err) {
      return res.status(500).json({ error: 'Validation Error' });
    }
    
    try {
      if (!db.getPlaylistCollection()) { throw 'No DB'; }
      db.getPlaylistCollection().insert({
        name: req.body.playlist,
        filepath: req.body.song,
        user: req.user.username
      });
      res.json({ });

      db.saveUserDB();
    }catch (err) {
      winston.error('Db Error', { stack: err });
      res.status(500).json({ error: typeof err === 'string' ? err : 'Unknown Error' });
    }
  });

  mstream.post('/api/v1/playlist/remove-song', async (req, res) => {
    try {
      const schema = Joi.object({ lokiid: Joi.number().integer().required() });
      await schema.validateAsync(req.body);
    }catch (err) {
      return res.status(500).json({ error: 'Validation Error' });
    }
    
    try {
      if (!db.getPlaylistCollection()) { throw 'No DB'; }
      db.getPlaylistCollection().findAndRemove({ '$loki': req.body.lokiid });
      res.json({});
      db.saveUserDB();
    }catch (err) {
      winston.error('Db Error', { stack: err });
      res.status(500).json({ error: typeof err === 'string' ? err : 'Unknown Error' });
    }
  });

  mstream.post('/api/v1/playlist/save', async (req, res) => {
    try {
      const schema = Joi.object({
        title: Joi.string().required(),
        songs: Joi.array().items(Joi.string())
      });
      await schema.validateAsync(req.body);

    }catch (err) {
      return res.status(500).json({ error: 'Validation Error' });
    }
    
    try {
      // Delete existing playlist
      db.getPlaylistCollection().findAndRemove({
        '$and': [
          { 'user': { '$eq': req.user.username } },
          { 'name': { '$eq': req.body.title } }
        ]
      });

      for (const song of req.body.songs) {
        db.getPlaylistCollection().insert({
          name: req.body.title,
          filepath: song,
          user: req.user.username
        });
      }
  
      res.json({});
      db.saveUserDB();
    }catch (err) {
      winston.error('Db Error', { stack: err });
      res.status(500).json({ error: typeof err === 'string' ? err : 'Unknown Error' });
    }
  });

  mstream.get('/api/v1/playlist/getall', (req, res) => {
    res.json(getPlaylists(req.user.username));
  });

  function getPlaylists(username) {
    const playlists = [];

    const results = db.getPlaylistCollection().find({ 'user': { '$eq': username } });
    const store = {};
    for (let row of results) {
      if (!store[row.name]) {
        playlists.push({ name: row.name });
        store[row.name] = true;
      }
    }
    return playlists;
  }
}