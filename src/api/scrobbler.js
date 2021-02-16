const Joi = require('joi');
const winston = require('winston');
const config = require('../state/config');
const scribble = require('../state/lastfm');
const Scrobbler = new scribble('25627de528b6603d6471cd331ac819e0', 'a9df934fc504174d4cb68853d9feb143', 'irosTheBeggar', 'qnUQjESA1Eg4+fH01WVY1');

exports.setup = (mstream) => {
  for (const user in config.program.users) {
    if (!config.program.users.hasOwnProperty(user)) { continue; }
    if (!config.program.users[user]['lastfm-user'] || !config.program.users[user]['lastfm-password']) { continue; }
    // TODO: Test Auth and alert user if it doesn't work        
    Scrobbler.addUser(config.program.users[user]['lastfm-user'], config.program.users[user]['lastfm-password']);
  }

  mstream.post('/api/v1/lastfm/scrobble-by-metadata', async (req, res) => {
    try {
      const schema = Joi.object({
        artist: Joi.string().required(),
        album: Joi.string().required(),
        track: Joi.string().required(),
      });
      await schema.validateAsync(req.body);
    } catch (err) {
      return res.status(500).json({ error: 'Validation Error' });
    }

    try {
      // TODO: update last-played field in DB
      if (!req.user['lastfm-user'] || !req.user['lastfm-password']) {
        return res.json({ scrobble: false });
      }

      Scrobbler.Scrobble(
        req.body,
        req.user['lastfm-user'],
        (post_return_data) => { res.json({}); }
      );
    }catch (err) {
      winston.error('Scrobble Error', { stack: err });
      res.status(500).json({ error: typeof err === 'string' ? err : 'Unknown Error' });
    }
  });
}

exports.reset = () => {
  Scrobbler.reset();
}