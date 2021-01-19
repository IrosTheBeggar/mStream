const winston = require('winston');
const nanoId = require('nanoid');
const jwt = require('jsonwebtoken');
const loki = require('lokijs');
const path = require('path');
const fs = require('fs').promises;
const Joi = require('joi');
const config = require('../state/config');

const dbName = 'shared.loki-v1.db';

let shareDB;
let shareCollection;
let sharedPage;

// TODO: Automatically delete expired shared playlists

exports.setupBeforeSecurity = async (mstream) => {
  sharedPage = await fs.readFile(path.join(__dirname, '../html/shared.html'), 'utf-8')
  shareDB = new loki(path.join(config.program.storage.dbDirectory, dbName));
  shareDB.loadDatabase({}, err => {
    shareCollection = shareDB.getCollection('playlists');
    if (shareCollection === null) {
      shareCollection = shareDB.addCollection("playlists");
    }
  });

  function lookupShared(playlistId) {
    const playlistItem = shareCollection.findOne({ 'playlist_id': playlistId });
    if (!playlistItem) { throw 'Playlist Not Found' }

    const decoded = jwt.verify(playlistItem.token, config.program.secret);
    return {
      token: playlistItem.token,
      playlist: decoded.allowedFiles
    };
  }

  mstream.get('/shared/:playlistId', (req, res) => {
    try {
      if (!req.params.playlistId) { throw 'Validation Error' }
      res.send(sharedPage.replace(
        '<script></script>', `<script>const sharedPlaylist = ${JSON.stringify(lookupShared(req.params.playlistId))}</script>`
      ));
    } catch (err) {
      winston.error('share error', { stack: err })
      return res.status(403).json({ error: 'Access Denied' });
    }
  });

  mstream.get('/api/v1/shared/:playlistId', (req, res) => {
    try {
      if (!req.params.playlistId) { throw 'Validation Error' }
      res.json(lookupShared(req.params.playlistId));
    } catch (err) {
      winston.error('share error', { stack: err })
      return res.status(403).json({ error: 'Access Denied' });
    }
  });
}

exports.setupAfterSecurity = async (mstream) => {
  mstream.post('/api/v1/shared', async (req, res) => {
    try {
      const schema = Joi.object({
        playlist: Joi.array().items(Joi.string()).required(),
        time: Joi.number().integer().positive().optional()
      });
      await schema.validateAsync(req.body);
    }catch (err) {
      return res.status(500).json({ error: 'Validation Error' });
    }

    try {
      // Setup Token Data
      const tokenData = {
        allowedFiles: req.body.playlist,
        shareToken: true,
        username: req.user.username
      };

      const jwtOptions = {};
      if (req.body.time) { jwtOptions.expiresIn = `${req.body.time}d`; }

      const sharedItem = {
        playlist_id: nanoId.nanoid(10),
        token: jwt.sign(tokenData, config.program.secret, jwtOptions)
      };

      shareCollection.insert(sharedItem);
      shareDB.saveDatabase(err => {
        if (err) { winston.error('Share DB Save Error', { stack: err }); }
      });

      res.json(sharedItem);
    }catch (err) {
      winston.error('Make shared error', {stack: err})
      res.status(500).json({ error: 'Error' });
    }
  });
}
