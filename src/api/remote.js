const url = require('url');
const path = require('path');
const fs = require('fs').promises;
const Joi = require('joi');
const nanoid = require('nanoid');
const jwt = require('jsonwebtoken');
const WebSocketServer = require('ws').Server;
const winston = require('winston');
const config = require('../state/config');

// list of currently connected clients (users)
const clients = {};
// Map code to JWT
const codeTokenMap = {};
const allowedCommands = [
  'next',
  'previous',
  'playPause',
  'addSong',
  'getPlaylist',
  'removeSong',
];

exports.setupAfterAuth = (mstream, server) => {
  const wss = new WebSocketServer({ server: server, verifyClient: (info, cb) => {
    if (config.program.users && Object.keys(config.program.users).length !== 0) {
      try {
        const token = url.parse(info.req.url, true).query.token;
        if (!token) { throw 'Token Not Found'; }

        const decoded = jwt.verify(token, config.program.secret);

        info.req.code = url.parse(info.req.url, true).query.code;

        if (info.req.code in clients) { throw 'Code In Use'; }
        
        info.req.jwt = jwt.sign({
          username: decoded.username,
          jukebox: true
        }, config.program.secret);
        cb(true);
      } catch (err) {
        console.log(err)
        cb(false, 401, 'Unauthorized');
      }
    } else {
      try {
       info.req.code =  url.parse(info.req.url, true).query.code;
       if (info.req.code in clients) { throw 'Code In Use'; }
       cb(true);
      } catch (err) {
        console.log(err)
        cb(false, 401, 'Unauthorized');
      }
    }
  }});

  wss.on('connection', (connection, req) => {
    const code = nanoid.nanoid(8);
    winston.info(`Websocket Connection Accepted With Code: ${code}`);
    clients[code] = connection;

    if (req.jwt) { codeTokenMap[code] = req.jwt; }

    connection.send(JSON.stringify({ code: code, token: req.jwt ? req.jwt : false }));

    // user sent  message
    connection.on('message', (message) => {
      connection.send(JSON.stringify({ code: code }));
    });

    connection.on('close', (connection) => {
      delete clients[code];
      if (codeTokenMap[code]) {delete codeTokenMap[code];}
    });
  });


  mstream.post('/api/v1/jukebox/push-to-client', async (req, res) => {
    try {
      const schema = Joi.object({
        code: Joi.string().required(),
        command: Joi.string().required(),
        file: Joi.string().optional()
      });
      await schema.validateAsync(req.body);
    }catch (err) {
      console.log(err)
      return res.status(500).json({ error: 'Validation Error' });
    }

    try {
      if (!(req.body.code in clients)) {
        throw 'Code Not Found';
      }

      if (allowedCommands.indexOf(req.body.command) === -1) {
        throw 'Command Not Recognized';
      }

      // Push commands to client
      clients[req.body.code].send(JSON.stringify({ command: req.body.command, file: req.body.file ? req.body.file : '' }));

      // Send confirmation back to user
      res.json({ });
    } catch(err) {
      winston.error('Jukebox Error', { stack: err });
      res.status(500).json({ error: typeof err === 'string' ? err : 'Unknown Error' });
    }
  });
}

// This part is run before the login code
exports.setupBeforeAuth = (mstream) => {
  mstream.post('/api/v1/jukebox/does-code-exist', (req, res) => {
    const clientCode = req.body.code;

    // Check that code exists
    if (!(clientCode in clients) || !(clientCode in codeTokenMap)) {
      return res.json({ status: false });
    }

    res.json({ status: true, token: codeTokenMap[clientCode] });
  });

  mstream.get('/remote/:remoteId', async (req, res) => {
    try {
      const clientCode = req.params.remoteId;
      if (!(clientCode in clients) || !(clientCode in codeTokenMap)) {
        throw 'Token Not Found';
      }

      let sharePage = await fs.readFile(path.join(config.program.webAppDirectory, 'remote/index.html'), 'utf-8');
      sharePage = sharePage.replace(/\.\.\//g, '../../');
      sharePage = sharePage.replace(
        '<script></script>',
        `<script>var remoteProperties = ${JSON.stringify({ code: clientCode, error: false, token: codeTokenMap[clientCode] })}</script>`
      );
      res.send(sharePage);
    } catch (err) {
      winston.error('Jukebox Error', { stack: err });
      res.status(500).json({ error: typeof err === 'string' ? err : 'Unknown Error' });
    }
  });
}
