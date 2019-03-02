const winston = require('winston');
const nanoId = require('nanoid');
const jwt = require('jsonwebtoken');
const loki = require('lokijs');
const path = require('path');

const dbName = 'shared.loki-v1.db'
var shareDB;
var shareCollection;
// TODO: Automatically delete expired shared playlists

exports.setupBeforeSecurity = function (mstream, program) {
  shareDB = new loki(path.join(program.storage.dbDirectory, dbName));
  shareDB.loadDatabase({}, err => {
    shareCollection = shareDB.getCollection('playlists');
    if (shareCollection === null) {
      shareCollection = shareDB.addCollection("playlists");
    }
  });

  mstream.post('/shared/get-token-and-playlist', (req, res) => {
    if (!req.body.tokenid) {
      res.status(500).json({ error: 'Please Supply Token' });
      return;
    }

    const playlistItem = shareCollection.findOne({ 'playlist_id': req.body.tokenid });
    if(!playlistItem) {
      return res.status(404).json({ error: 'Playlist Not Found' })
    }

    jwt.verify(playlistItem.token, program.secret, (err, decoded) => {
      if (err) {
        return res.redirect('/access-denied');
      }

      res.json({
        token: playlistItem.token,
        playlist: decoded.allowedFiles
      });
    });
  });
}

exports.setupAfterSecurity = function (mstream, program) {
  mstream.post('/shared/make-shared', (req, res) => {
    if(!req.body.playlist) {
      return res.status(403).json({ error: 'Missing Input Params' });
    }
    var shareTimeInDays = req.body.time;
    const playlist = req.body.playlist; // TODO: Verify this

    // Verify Share Time
    if (!shareTimeInDays || !Number.isInteger(shareTimeInDays) || shareTimeInDays < 1) {
      shareTimeInDays = 14;
    }

    // Setup Token Data
    const tokenData = {
      allowedFiles: playlist,
      shareToken: true,
      username: req.user.username
    }

    const sharedItem = {
      playlist_id: nanoId(10),
      token: jwt.sign(tokenData, program.secret, { expiresIn: shareTimeInDays + 'd' })
    };

    // Save to DB
    shareCollection.insert(sharedItem);
    shareDB.saveDatabase(err => {
      if (err) {
        winston.error(`DB Save Error : ${err}`);
      }
    });

    // Return Token and ID
    res.json(sharedItem);
  });
}
