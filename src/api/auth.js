const jwt = require('jsonwebtoken');
const Joi = require('joi');
const winston = require('winston');
const auth = require('../util/auth');

exports.setup = (mstream, program) => {
  mstream.post('/api/v1/auth/login', async (req, res) => {
    try {
      const schema = Joi.object({ 
        username: Joi.string().required(),
        password: Joi.string().required()
      });
      await schema.validateAsync(req.body);

      if (!program.users[req.body.username]) { throw 'user not found'; }

      await auth.authenticateUser(program.users[req.body.username].password, program.users[req.body.username].salt, req.body.password)

      res.json({
        vpaths: program.users[req.body.username].vpaths,
        token: jwt.sign({ username: req.body.username }, program.secret)
      });
    }catch (err) {
      winston.warn(`Failed login attempt from ${req.ip}. Username: ${req.body.username}`);
      setTimeout(() => { res.status(401).json({ error: 'Login Failed' }); }, 800);
    }
  });

  mstream.use((req, res, next) => {
    try {
      // Handle No Users
      if (program.users && Object.keys(program.users).length === 0) {
        req.user = {
          vpaths: Object.keys(program.folders),
          username: 'mstream-user',
          admin: true
        };

        return next();
      }

      const token = req.body.token || req.query.token || req.headers['x-access-token'];
      if (!token) { throw 'Token Not Found'; }

      const decoded = jwt.verify(token, program.secret);

      // handle federation invite tokens
      if (decoded.invite && decoded.invite === true) {
        // Invite tokens can only be used with one API path
        if (req.path === '/federation/invite/exchange') { return next(); }
        throw 'Invalid Invite Token';
      }

      // Handle Shared Tokens
      if (decoded.shareToken && decoded.shareToken === true) {
        // We limit the endpoints to `/download` and anything in the allowedFiles array
        if (req.path !== '/download' && decoded.allowedFiles.indexOf(decodeURIComponent(req.path).slice(7)) === -1) {
          throw 'Invalid Share Token';
        }
        req.allowedFiles = decoded.allowedFiles;
        return next();
      }


      if (!decoded.username || !program.users[decoded.username]) {
        throw 'Invalid Auth Token';
      }

      // TODO: Re-enable this later
      // const restrictedFunctions = { '/db/recursive-scan': true };
      // if (decoded.federation || decoded.jukebox || program.users[decoded.username].guest) {
      //   if (restrictedFunctions[req.path]) { throw 'Invalid Token'; }
      // }

      req.user = program.users[decoded.username];
      req.user.username = decoded.username;

      next();
    } catch (err) {
      return res.status(403).json({ error: 'Access Denied' });
    }
  });
}