exports.setup = function(mstream, program, express){
  // Use bcrypt for password storage
  const bcrypt = require('bcrypt');
  const jwt = require('jsonwebtoken'); // used to create, sign, and verify tokens
  const uuidV4 = require('uuid/v4');




  // TODO: Add New user functionality
    // Check for root user and password
    // Add credentials to user array

  // TODO: Need a way to store and use already hashed passwords


  // TODO: password change function
  mstream.post('/change-password-request', function (req, res) {
    // Get email address from request
      // validate email against user array
    // Generate change password token
    // Invalidate all other change password tokens
    // Email the user the token

    res.sendFile( 'COMING SOON!' );
  });

  mstream.post('/change-password', function (req, res){
    // Check token
    // Get new password
    // Hash password and update user array

    res.sendFile( 'COMING SOON!' );
  });

  mstream.post('/sunset-user', function(req,res){
    // Removes all user info
  });

  mstream.post('/add-user', function(req,res){
    // Add a user
  });


  // Create the user array
  var Users = program.users;
  var permissionsMap = {};

  for (let username in Users) {
    // Setup user password
    generateSaltedPassword(username, Users[username]["password"]);

    // If this is a guest user, continue
    if(Users[username].guestTo){
      continue;
    }

    // If dir has not been added yet
    if ( !(Users[username].musicDir  in permissionsMap) ){
      // Generate unique vPath if necessary
      // The best way is to store the vPath in the JSON file
      if(!Users[username].vPath){
        Users[username].vPath = uuidV4();
      }

      // Add to permissionsMap
      permissionsMap[Users[username].musicDir] = Users[username].vPath;
    }else{
      Users[username].vPath = permissionsMap[Users[username].musicDir];
    }

  }


  function generateSaltedPassword(username, password){
    bcrypt.genSalt(10, function(err, salt) {
      bcrypt.hash(password, salt, function(err, hash) {
        // Store hash in your password DB.
        Users[username]['password'] = hash;
      });
    });
  }

  // Failed Login Attempt
  mstream.get('/login-failed', function (req, res) {
    // Wait before sending the response
    setTimeout((function() {
      res.status(599).send(JSON.stringify({'Error':'Try Again'}))
    }), 800);
  });

  mstream.get('/access-denied', function (req, res) {
    res.status(598).send(JSON.stringify({'Error':'Access Denied'}));
  });

  mstream.get('/guest-access-denied', function (req, res) {
    res.status(597).send(JSON.stringify({'Error':'Access Denied'}));
  });

  // route to authenticate a user (POST http://localhost:8080/api/authenticate)
  mstream.post('/login', function(req, res) {
    let username = req.body.username;
    let password = req.body.password;

    // Check is user is in array
    if(typeof Users[username] === 'undefined') {
      // user does not exist
      return res.redirect('/login-failed');
    }

    // Check is password is correct
    bcrypt.compare(password, Users[username]['password'], function(err, match) {
      if(match == false){
        // Password does not match
        return res.redirect('/login-failed');
      }


      var sendData = {
        username: username,
      }

      var vPath;
      if(Users[username].guestTo){
        vPath = Users[Users[username].guestTo].vPath;
      }else{
        vPath = Users[username].vPath;
      }

      // return the information including token as JSON
      var sendThis = {
        success: true,
        message: 'Welcome To mStream',
        vPath: vPath,
        token: jwt.sign(sendData, program.secret) // Make the token
      };

      res.send(JSON.stringify(sendThis));
    });
  });

  // Guest Users are not allowed to access these functions
  const forbiddenFunctions = ['/db/recursive-scan', '/saveplaylist', '/deleteplaylist'];

  // Middleware that checks for token
  mstream.use(function(req, res, next) {
    // check header or url parameters or post parameters for token
    var token = req.body.token || req.query.token || req.headers['x-access-token'];
    if (!token) {
      return res.redirect('/access-denied');
    }

    // verifies secret and checks exp
    jwt.verify(token, program.secret, function(err, decoded) {
      if (err) {
        return res.redirect('/access-denied');
      }

      // Check if share token
      if(decoded.shareToken && decoded.shareToken === true){
        // We limit the endpoints to download and anythign in the allowedFiles array
        // TODO: There's gottab be a better way to habdle vpaths
        // TODO: Add vpath to allowedFiles when it's created ???
        // console.log(decodeURIComponent(req.path.substring(38)));
        if(req.path !== '/download' && decoded.allowedFiles.indexOf(decodeURIComponent(req.path.substring(38))) === -1){ // The substring is to cut out the vPath
          return res.redirect('/guest-access-denied');
        }
        req.allowedFiles = decoded.allowedFiles;
        next();
        return;
      }
        // User may access those files and no others

      // Check for any hardcoded restrictions baked right into token
      if(decoded.restrictedFunctions && decoded.restrictedFunctions.indexOf(req.path) != -1){
        return res.redirect('/guest-access-denied');
      }

      // TODO: Verify that users in token exist and vPath matches
        // TODO: Longterm goal - use vPath from request variable instead of having the user manually add it
      req.user = Users[decoded.username];
      req.user.username = decoded.username;

      // Deny guest access
      if(req.user.guestTo && forbiddenFunctions.indexOf(req.path) != -1){
        return res.redirect('/guest-access-denied');
      }


      // Set user request data
      // TODO: Should we clone this in stead of referencing it ???
      if(req.user.guestTo){
        // Setup guest credentials based and normal user credentials
        req.user.username = req.user.guestTo;
        req.user.vPath = Users[req.user.guestTo].vPath;
        req.user.musicDir = Users[req.user.guestTo].musicDir;
      }
      next();
    });
  });

  // Setup Music Dirs here so they are protected by middleware
  for (var key in permissionsMap) {
    mstream.use( '/' + permissionsMap[key] + '/' , express.static( key  ));
  }
}
