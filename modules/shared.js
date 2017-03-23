const uuidV4 = require('uuid/v4');
const jwt = require('jsonwebtoken');

// TODO: Move this to LokiJS
const loki = require('lokijs');
var sharedb = new loki('share.db');

// Add a collection to the database
var items = sharedb.addCollection('playlists');


exports.setupBeforeSecurity = function(mstream, program){

  // Get files
  mstream.post('/shared/get-token-and-playlist', function(req, res){
    if(!req.body.tokenid){
      res.status(500).json({'Error':'Please Supply Token'});
      return;
    }
    // Get uuid
    const tokenID = req.body.tokenid;

    // TODO: Verify token length
      // Then verify by regex


    // TODO: Handle document not found

    // TODO: Handle past experation date

    var playlistItem = items.findOne({'playlist_id': tokenID});

    // verifies secret and checks exp
    jwt.verify(playlistItem.token, program.secret, function(err, decoded) {

      if (err) {
        return res.redirect('/access-denied');
      }

      // var vpath = program.users[decoded.username].vPath;
      var vpath = '';
      if(program.users){
        vpath = program.users[decoded.username].vPath;
      }else{
        vpath = program.vPath;
      }

      // return
      res.json({
        token: playlistItem.token,
        playlist: decoded.allowedFiles,
        vPath: vpath
      });
    });


  });

}



exports.setupAfterSecurity = function(mstream, program){
  // Setup shared
  mstream.post('/shared/make-shared', function(req, res){
    // get files from POST request
    var shareTimeInDays = req.body.time;
    var playlist = req.body.playlist;

    // TODO: Verify Share Time
    if(!shareTimeInDays){
      shareTimeInDays = 14;
    }

    // Setup Token Data
    var tokenData = {
      allowedFiles: playlist,
      shareToken: true,
      username: req.user.username
    }

    // make token
    var token = jwt.sign(
      tokenData ,
      program.secret,
      { expiresIn: shareTimeInDays +'d' }
    );

    // Save to DB
    var uniqueId = uuidV4();
    var doc = {
      "playlist_id": uniqueId,
      "token": token,
      // "playlist": playlist,
      "experiationdate":"TODO:"
    };
    items.insert(doc);

    // Retun Token and ID
    res.json({
      'id':uniqueId,
      'token': token,
      'experiationdate':'TODO'
    });
  });
}
