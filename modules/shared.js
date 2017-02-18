const uuidV4 = require('uuid/v4');
const jwt = require('jsonwebtoken');
// Using PouchDB here as an experiment
const pouchDB = require('pouchdb');
const sharedDB = new pouchDB('shared');



exports.setupBeforeSecurity = function(mstream, program){

  // Get files
  mstream.post('/get-token-and-playlist', function(req, res){
    // Get uuid
    const tokenID = req.body.tokenid;

    // TODO: Verify length
      // Then verify by regex

    //
    sharedDB.get(tokenID).then(function (doc) {
      console.log(doc);
      // TODO: Handle document not found

      // TODO: Handle past experation date



      // verifies secret and checks exp
      jwt.verify(doc.token, program.secret, function(err, decoded) {
        console.log(decoded);

        if (err) {
          return res.redirect('/access-denied');
        }
        console.log(decoded.username);
        console.log( program.users[decoded.username] );
        var vpath = program.users[decoded.username].vPath;

        // return
        res.send(JSON.stringify({
          token: doc.token,
          playlist: decoded.allowedFiles,
          vPath: vpath
        }));
      });


    });
  });

}



exports.setupAfterSecurity = function(mstream, program){
  // Setup shared
  mstream.post('/make-shared', function(req, res){
    // get files from POST request
    var shareTimeInDays = req.body.time;
    var playlist = req.body.playlist;

    console.log(shareTimeInDays);
    console.log(playlist);



    // TODO: Parse Playlist
    // TODO: Verify Share Time

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
      "_id": uniqueId,
      "token": token,
      "playlist": playlist,
      "experiationdate":"TODO:"
    };
    sharedDB.put(doc);

    // return token and link
    const returnThis = {
      'id':uniqueId,
      'token': token,
      'experiationdate':'TODO'
    }

    res.send(JSON.stringify(returnThis));
  });
}
