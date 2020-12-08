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
}