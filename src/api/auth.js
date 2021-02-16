const jwt = require('jsonwebtoken');
const Joi = require('joi');
const winston = require('winston');
const auth = require('../util/auth');
const config = require('../state/config');
const shared = require('../api/shared');

exports.setup = (mstream) => {
  mstream.post('/api/v1/auth/login', async (req, res) => {
    try {
      const schema = Joi.object({ 
        username: Joi.string().required(),
        password: Joi.string().required()
      });
      await schema.validateAsync(req.body);

      if (!config.program.users[req.body.username]) { throw 'user not found'; }

      await auth.authenticateUser(config.program.users[req.body.username].password, config.program.users[req.body.username].salt, req.body.password)

      res.json({
        vpaths: config.program.users[req.body.username].vpaths,
        token: jwt.sign({ username: req.body.username }, config.program.secret)
      });
    }catch (err) {
      winston.warn(`Failed login attempt from ${req.ip}. Username: ${req.body.username}`);
      setTimeout(() => { res.status(401).json({ error: 'Login Failed' }); }, 800);
    }
  });

  mstream.use((req, res, next) => {
    try {
      // Handle No Users
      if (config.program.users && Object.keys(config.program.users).length === 0) {
        req.user = {
          vpaths: Object.keys(config.program.folders),
          username: 'mstream-user',
          admin: true
        };

        return next();
      }

      const token = req.body.token || req.query.token || req.headers['x-access-token'];
      if (!token) { throw 'Token Not Found'; }

      const decoded = jwt.verify(token, config.program.secret);

      // handle federation invite tokens
      if (decoded.invite && decoded.invite === true) {
        // Invite tokens can only be used with one API path
        if (req.path === '/federation/invite/exchange') { return next(); }
        throw 'Invalid Invite Token';
      }

      if (!decoded.username || !config.program.users[decoded.username]) {
        throw 'Invalid Auth Token';
      }

      req.user = config.program.users[decoded.username];
      req.user.username = decoded.username;

      // Handle Shared Tokens
      if (decoded.shareToken && decoded.shareToken === true) {
        const playlistItem = shared.lookupPlaylist(decoded.playlistId);

        if (
          req.path !== '/api/v1/download/shared' && 
          req.path !== '/db/metadata' &&
          req.path.substring(0,11) !== '/album-art/' &&
          playlistItem.playlist.indexOf(decodeURIComponent(req.path).slice(7)) === -1
        ) {
          throw 'Invalid Share Token';
        }

        req.sharedPlaylistId = decoded.playlistId;
        return next();
      }

      // TODO: Re-enable this later
      // const restrictedFunctions = { '/db/recursive-scan': true };
      // if (decoded.federation || decoded.jukebox || config.program.users[decoded.username].guest) {
      //   if (restrictedFunctions[req.path]) { throw 'Invalid Token'; }
      // }

      next();
    } catch (err) {
      return res.status(403).json({ error: 'Access Denied' });
    }
  });
}