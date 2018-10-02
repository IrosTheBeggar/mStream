const uuidV4 = require('uuid/v4');
const jwt = require('jsonwebtoken');
const loki = require('lokijs');
const shareDB = new loki('sdhare.db');
var shareCollection;
shareDB.loadDatabase({}, function (err) {
  shareCollection = shareDB.getCollection('playlists');
  if (shareCollection === null) {
    shareCollection = shareDB.addCollection("playlists");
  }
});

// TODO: Automatically delete expired shared playlists

exports.setupBeforeSecurity = function (mstream, program) {
  mstream.post('/shared/get-token-and-playlist', (req, res) => {
    if (!req.body.tokenid) {
      res.status(500).json({ 'Error': 'Please Supply Token' });
      return;
    }

    const playlistItem = shareCollection.findOne({ 'playlist_id': req.body.tokenid });
    if(!playlistItem) {
      return res.status(404).json({error: 'PNot Found'})
    }

    jwt.verify(playlistItem.token, program.secret, function (err, decoded) {
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
      playlist_id: uuidV4(),
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
