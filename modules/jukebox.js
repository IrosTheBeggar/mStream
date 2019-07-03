// Websocket Server
const WebSocketServer = require('ws').Server;
const url = require('url');
const winston = require('winston');
const jwt = require('jsonwebtoken');

// list of currently connected clients (users)
var clients = {};
// Any code in here will be limited in functionality
var guests = {};

// Map code to JWT
var codeTokenMap = {};

const allowedCommands = [
  'next',
  'previous',
  'playPause',
  'addSong',
  'getPlaylist',
  'removeSong',
];
const guestCommands = [
  'addSong',
  'getPlaylist'
];


// This part is run after the login code
exports.setup = function (mstream, server, program) {
  var vcFunc = function (info, cb) {
    try {
      const code = url.parse(info.req.url, true).query.code;
      info.req.code = code;
      if (info.req.code && ((code in clients) || (code in guests))) {
        cb(false, 403, 'Code In Use');
        return;
      }
    } catch (err) {}
    cb(true);
  }

  // If we are logging in
  if (program.auth) {
    vcFunc = function (info, cb) {
      var token;

      // Tokens are attached as a GET param
      try {
        token = url.parse(info.req.url, true).query.token;
      } catch (err) {
        cb(false, 401, 'Unauthorized');
        return;
      }

      if (!token) {
        cb(false, 401, 'Unauthorized');
      }
      else {
        jwt.verify(token, program.secret, (err, decoded) => {
          if (err) {
            cb(false, 401, 'Unauthorized');
            return;
          } 

          try {
            const code = url.parse(info.req.url, true).query.code;
            info.req.code = code;
          } catch (err) {}

          if (info.req.code && ((info.req.code in clients) || (info.req.code in guests))) {
            cb(false, 403, 'Code In Use');
            return;
          }

          // We are going to create a new JWT specifically for this session
          const sendData = {
            username: decoded.username,
            jukebox: true
          }

          info.req.jwt = jwt.sign(sendData, program.secret);
          cb(true);
        });
      }
    }
  }


  const wss = new WebSocketServer({ server: server, verifyClient: vcFunc });
  wss.on('connection', (connection, req) => {
    // Generate code and assure it doesn't exist
    var code = createAccountNumber(10000);
    var guestcode = createAccountNumber(10000);
    if (req.code) {
      code = req.code;
    }

    // Handle code failures
    if (code === false || guestcode === false) {
      connection.send(JSON.stringify({ error: 'Failed To Create Instance' }));
      return;
    }

    winston.info(`Websocket Connection Accepted With Code: ${code}`);

    // Add code to clients object
    clients[code] = connection;
    guests[guestcode] = code;

    // create JWT
    var token = false;
    if (req.jwt) {
      token = req.jwt;
      codeTokenMap[code] = token;
      codeTokenMap[guestcode] = token;
    }

    // Send Code
    connection.send(JSON.stringify({ code: code, guestCode: guestcode, token: token }));

    // user sent some message
    connection.on('message', (message) => {
      // Send client code back
      connection.send(JSON.stringify({ code: code, guestCode: guestcode }));
    });


    // user disconnected
    connection.on('close', (connection) => {
      // Remove client from array
      delete guests[guestcode];
      delete clients[code];

      if (codeTokenMap[code]) {
        delete codeTokenMap[code];
        delete codeTokenMap[guestcode];
      }
    });
  });


  // Function for creating account numbers
  function createAccountNumber(limit = 100000) {
    var n = 0;
    while (true) {
      code = Math.floor(Math.random() * (limit * 9)) + limit;
      if (!(code in clients) && !(code in guests)) {
        break;
      }
      if (n === 10) {
        winston.error('Failed to create ID for jukebox.');
        // FIXME: Try again with a larger number size
        return false;
      }
      n++;
    }
    return code;
  }

  // Send codes to client
  mstream.post('/jukebox/push-to-client', (req, res) => {
    var clientCode = req.body.code;
    const command = req.body.command;

    // Check that code exists
    if (!(clientCode in clients) && !(clientCode in guests)) {
      res.status(500).json({ error: 'Client code not found' });
      return;
    }

    // Make sure command is allowed
    if (allowedCommands.indexOf(command) === -1) {
      res.status(500).json({ error: 'Command Not Recognized' });
      return;
    }

    if (clientCode in guests) {
      // Check that command does not violate guest conditions
      if (guestCommands.indexOf(command) === -1) {
        res.status(500).json({ error: 'The command is not allowed for guests' });
        return;
      }

      clientCode = guests[clientCode];
    }

    // Handle extra data for Add File Commands
    var sendFile = '';
    if (req.body.file) {
      sendFile = req.body.file;
    }

    // Push commands to client
    clients[clientCode].send(JSON.stringify({ command: command, file: sendFile }));

    // Send confirmation back to user
    res.json({ status: 'done' });
  });
}

// This part is run before the login code
exports.setup2 = function (mstream, server, program) {
  mstream.post('/jukebox/does-code-exist', function (req, res) {
    const clientCode = req.body.code;

    // Check that code exists
    if (!(clientCode in clients) && !(clientCode in guests)) {
      res.json({ status: false });
      return;
    }

    // Get Token
    var jwt = false;
    if (codeTokenMap[clientCode]) {
      jwt = codeTokenMap[clientCode];
    }

    var guestStatus = (clientCode in guests);
    res.json({ status: true, guestStatus: guestStatus, token: jwt });
  });
}
