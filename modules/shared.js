const uuidV4 = require('uuid/v4');
const jwt = require('jsonwebtoken');

// Loki DB
// TODO: Make this persistant. Right now the DB is lost every time the server reboots
const loki = require('lokijs');
const sharedb = new loki('share.db').addCollection('playlists');



exports.setupBeforeSecurity = function (mstream, program) {

  // Get files
  mstream.post('/shared/get-token-and-playlist', function (req, res) {
    if (!req.body.tokenid) {
      res.status(500).json({ 'Error': 'Please Supply Token' });
      return;
    }
    // Get uuid
    const tokenID = req.body.tokenid;

    // TODO: Handle document not found
    // TODO: Handle past experation date

    var playlistItem = sharedb.findOne({ 'playlist_id': tokenID });

    // verifies secret and checks exp
    jwt.verify(playlistItem.token, program.secret, function (err, decoded) {
      if (err) {
        return res.redirect('/access-denied');
      }

      // return
      res.json({
        token: playlistItem.token,
        playlist: decoded.allowedFiles
      });
    });
  });
}


exports.setupAfterSecurity = function (mstream, program) {
  // Setup shared
  mstream.post('/shared/make-shared', function (req, res) {
    // get files from POST request
    var shareTimeInDays = req.body.time;
    var playlist = req.body.playlist;

    // TODO: Verify Share Time
    if (!shareTimeInDays) {
      shareTimeInDays = 14;
    }

    // Setup Token Data
    var tokenData = {
      allowedFiles: playlist,
      shareToken: true,
      username: req.user.username
    }

    //
    var sharedItem = {
      "playlist_id": uuidV4(),
      "token": jwt.sign(tokenData, program.secret, { expiresIn: shareTimeInDays + 'd' }),
      "experiationdate": "TODO:"
    };

    // Save to DB
    sharedb.insert(sharedItem);
    // Retun Token and ID
    res.json(sharedItem);
  });
}
