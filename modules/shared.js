const uuidV4 = require('uuid/v4');
const jwt = require('jsonwebtoken');
// Using PouchDB here as an experiment
const pouchDB = require('pouchdb');
const sharedDB = new pouchDB('shared');



exports.setupBeforeSecurity = function(mstream, program){

  // Get files
  mstream.post('/get-token-and-playlist', function(req, res){
    if(!req.parsedJSON.tokenid){
      res.status(500).send(JSON.stringify({'Error':'Please Supply Token'}));
      return;
    }
    // Get uuid
    const tokenID = req.parsedJSON.tokenid;

    // TODO: Verify length
      // Then verify by regex

    //
    sharedDB.get(tokenID).then(function (doc) {
      // TODO: Handle document not found

      // TODO: Handle past experation date


      // verifies secret and checks exp
      jwt.verify(doc.token, program.secret, function(err, decoded) {

        if (err) {
          return res.redirect('/access-denied');
        }

        // var vpath = program.users[decoded.username].vPath;
        var vpath = '';
        if(program.users){
          vpath = program.users[decoded.username].vPath;
        }else{
          vPath = program.vPath;
        }

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
    var shareTimeInDays = req.parsedJSON.time;
    var playlist = req.parsedJSON.playlist;

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
