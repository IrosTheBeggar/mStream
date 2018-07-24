const jwt = require('jsonwebtoken');
const crypto = require('crypto');

exports.setup = function (mstream, program) {
  // Convenience variable
  var Users = program.users;

  // Crypto Config
  const hashConfig = {
    // size of the generated hash
    hashBytes: 32,
    // larger salt means hashed passwords are more resistant to rainbow table, but
    // you get diminishing returns pretty fast
    saltBytes: 16,
    iterations: 15000,
    encoding: 'base64'
  };

  // TODO: Need a way to store and use already hashed passwords

  // TODO: Add/delete user functionality
  // TODO: password change function

  // mstream.post('/change-password-request', function (req, res) {
  //   // Get email address from request
  //     // validate email against user array
  //   // Generate change password token
  //   // Invalidate all other change password tokens
  //   // Email the user the token
  //   res.status(500).json( {error: 'Coming Soon'} );
  // });
  // mstream.post('/change-password', function (req, res){
  //   // Check token
  //   // Get new password
  //   // Hash password and update user array
  //   res.status(500).json( {error: 'Coming Soon'} );
  // });
  // mstream.post('/sunset-user', function(req,res){
  //   // Removes all user info
  //   res.status(500).json( {error: 'Coming Soon'} );
  // });
  // mstream.post('/add-user', function(req,res){
  //   // Add a user
  //   res.status(500).json( {error: 'Coming Soon'} );
  // });

  // Loop through users and setup passwords
  for (let username in Users) {
    if(!Users[username]["password"]){
      console.log(`User ${username} is missing password and will not be able to log in!`)
      continue;
    }

    if (Users[username].salt) {
      // If the user already has a salt, it means the password is hashed and can be used as is
      Users[username].salt = new Buffer(Users[username].salt);
      continue;
    }

    generateSaltedPassword(username, Users[username]["password"]);
  }


  function generateSaltedPassword(username, password) {
    crypto.randomBytes(hashConfig.saltBytes, function (err, salt) {
      if (err) {
        console.log(`Failed to hash password for user ${username}`);
        return;
      }

      crypto.pbkdf2(password, salt, hashConfig.iterations, hashConfig.hashBytes, 'sha512', function (err, hash) {
        if (err) {
          console.log(`Failed to hash password for user ${username}`);
          return;
        }
        Users[username]['password'] = new Buffer(hash).toString('hex');
        Users[username]['salt'] = salt;
      });
    });
  }

  // Failed Login Attempt
  mstream.get('/login-failed', function (req, res) {
    // Wait before sending the response
    setTimeout((function () {
      res.status(401).json({ error: 'Try Again' })
    }), 800);
  });

  mstream.get('/access-denied', function (req, res) {
    res.status(403).json({ error: 'Access Denied' });
  });

  // Authenticate User
  mstream.post('/login', function (req, res) {
    if (!req.body.username || !req.body.password) {
      return res.redirect('/login-failed');
    }

    let username = req.body.username;
    let password = req.body.password;

    // Check is user is in array
    if (typeof Users[username] === 'undefined') {
      // user does not exist
      return res.redirect('/login-failed');
    }

    if (!Users[username].password || !Users[username].password ) {
      console.log('User is mising password or salt');
      return res.redirect('/login-failed');
    }

    // Check is password is correct
    crypto.pbkdf2(password, Users[username]['salt'], hashConfig.iterations, hashConfig.hashBytes, 'sha512', function (err, verifyHash) {
      // Make sure passwords match
      if (new Buffer(verifyHash).toString('hex') !== Users[username]['password']) {
        return res.redirect('/login-failed');
      }

      // return the information including token as JSON
      res.json(
        {
          vpaths: Users[username].vpaths,
          token: jwt.sign({ username: username }, program.secret) // Make the token
        }
      );
    });
  });

  // Middleware that checks for token
  mstream.use(function (req, res, next) {
    // check header or url parameters or post parameters for token
    var token = req.body.token || req.query.token || req.headers['x-access-token'];
    if (!token) {
      return res.redirect('/access-denied');
    }

    // verifies secret and checks exp
    jwt.verify(token, program.secret, function (err, decoded) {
      if (err) {
        return res.redirect('/access-denied');
      }

      // Check if share token
      // User may access those files and no others
      if (decoded.shareToken && decoded.shareToken === true) {
        // We limit the endpoints to download and anythign in the allowedFiles array
        if (req.path !== '/download' && decoded.allowedFiles.indexOf(decodeURIComponent(req.path).slice(7)) === -1) {
          return res.redirect('/access-denied');
        }
        req.allowedFiles = decoded.allowedFiles;
        next();
        return;
      }

      // Check for any hardcoded restrictions baked right into token
      if (decoded.restrictedFunctions && decoded.restrictedFunctions.indexOf(req.path) != -1) {
        return res.redirect('/access-denied');
      }

      // Setup User variable for api endpoints to access
      req.user = Users[decoded.username];
      req.user.username = decoded.username;

      next();
    });
  });

}
