const crypto = require('crypto');
const Joi = require('joi');
const axios = require('axios');
const config = require('../state/config');
const scribble = require('../state/lastfm');
const db = require('../db/manager');
const { joiValidate } = require('../util/validation');
const { getVPathInfo } = require('../util/vpath');

const Scrobbler = new scribble();

exports.setup = (mstream) => {
  Scrobbler.setKeys(config.program.lastFM.apiKey, config.program.lastFM.apiSecret)

  for (const user in config.program.users) {
    if (!config.program.users.hasOwnProperty(user)) { continue; }
    if (!config.program.users[user]['lastfm-user'] || !config.program.users[user]['lastfm-password']) { continue; }
    // TODO: Test Auth and alert user if it doesn't work        
    Scrobbler.addUser(config.program.users[user]['lastfm-user'], config.program.users[user]['lastfm-password']);
  }

  mstream.post('/api/v1/lastfm/scrobble-by-metadata', (req, res) => {
    const schema = Joi.object({
      artist: Joi.string().optional().allow(''),
      album: Joi.string().optional().allow(''),
      track: Joi.string().required(),
    });
    joiValidate(schema, req.body);

    // TODO: update last-played field in DB
    if (!req.user['lastfm-user'] || !req.user['lastfm-password']) {
      return res.json({ scrobble: false });
    }

    Scrobbler.Scrobble(
      req.body,
      req.user['lastfm-user'],
      (post_return_data) => { res.json({}); }
    );
  });

  mstream.post('/api/v1/lastfm/scrobble-by-filepath', (req, res) => {
    const schema = Joi.object({
      filePath: Joi.string().required(),
    });
    joiValidate(schema, req.body);

    // lookup metadata
    const pathInfo = getVPathInfo(req.body.filePath, req.user);

    const dbObj = { '$and': [
      { 'filepath': { '$eq': pathInfo.relativePath } },
      { 'vpath': { '$eq': pathInfo.vpath } }
    ]};
    const dbFileInfo = db.getFileCollection().findOne(dbObj);

    if (!dbFileInfo) {
      return res.json({ scrobble: false });
    }

    // log play
    const result = db.getUserMetadataCollection().findOne({ '$and':[{ 'hash': dbFileInfo.hash}, { 'user': req.user.username }] });

    if (!result) {
      db.getUserMetadataCollection().insert({
        user: req.user.username,
        hash: dbFileInfo.hash,
        pc: 1,
        lp: Date.now()
      });
    } else {
      result.pc = result.pc && typeof result.pc === 'number'
        ? result.pc + 1 : 1;
      result.lp = Date.now();
      
      db.getUserMetadataCollection().update(result);
    }

    db.saveUserDB();
    res.json({});

    if (req.user['lastfm-user'] && req.user['lastfm-password']) {
      // scrobble on last fm
      Scrobbler.Scrobble(
        {
          artist: dbFileInfo.artist,
          album: dbFileInfo.album,
          track: dbFileInfo.title
        },
        req.user['lastfm-user'],
        (post_return_data) => {}
      );
    }
  });

  mstream.post('/api/v1/lastfm/test-login', async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required(),
      password: Joi.string().required()
    });
    joiValidate(schema, req.body);

    const token = crypto.createHash('md5').update(req.body.username + crypto.createHash('md5').update(req.body.password, 'utf8').digest("hex"), 'utf8').digest("hex");
    const cryptoString = `api_key${config.program.apiKey}authToken${token}methodauth.getMobileSessionusername${req.body.username}${config.program.apiSecret}`;
    const hash = crypto.createHash('md5').update(cryptoString, 'utf8').digest("hex");

    await axios({
      method: 'GET',
      url: `http://ws.audioscrobbler.com/2.0/?method=auth.getMobileSession&username=${req.body.username}&authToken=${token}&api_key=${apiKey1}&api_sig=${hash}`
    });
    res.json({});
  });
}

exports.reset = () => {
  Scrobbler.reset();
}
