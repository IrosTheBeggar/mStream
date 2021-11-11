const winston = require('winston');
const nanoId = require('nanoid');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs').promises;
const Joi = require('joi');
const config = require('../state/config');
const db = require('../db/manager');
const { joiValidate } = require('../util/validation');
const WebError = require('../util/web-error');

function lookupShared(playlistId) {
  const playlistItem = db.getShareCollection().findOne({ 'playlistId': playlistId });
  if (!playlistItem) { throw new WebError('Playlist Not Found'); }

  // make sure the token is still good
  jwt.verify(playlistItem.token, config.program.secret);
  return {
    token: playlistItem.token,
    playlist: playlistItem.playlist
  };
}

exports.lookupPlaylist = (playlistId) => {
  return lookupShared(playlistId);
}

exports.setupBeforeSecurity = async (mstream) => {
  mstream.get('/shared/:playlistId', async (req, res) => {
    // don't end this with a slash. otherwise relative URLs don't work
    if (req.path.endsWith('/')) {
      const matchEnd = req.path.match(/(\/)+$/g);
      const queryString = req.url.match(/(\?.*)/g) === null ? '' : req.url.match(/(\?.*)/g);
      // redirect to a more sane URL
      return res.redirect(301, req.path.slice(0, (matchEnd[0].length)*-1) + queryString[0]);
    }

    if (!req.params.playlistId) { throw new WebError('Validation Error', 403); }
    let sharePage = await fs.readFile(path.join(config.program.webAppDirectory, 'shared/index.html'), 'utf-8');
    sharePage = sharePage.replace(
      '<script></script>',
      `<script>const sharedPlaylist = ${JSON.stringify(lookupShared(req.params.playlistId))}</script>`
    );
    res.send(sharePage);
  });

  mstream.get('/api/v1/shared/:playlistId', (req, res) => {
    if (!req.params.playlistId) { throw new WebError('Validation Error', 403); }
    res.json(lookupShared(req.params.playlistId));
  });
}

exports.setupAfterSecurity = async (mstream) => {
  mstream.post('/api/v1/share', (req, res) => {
    const schema = Joi.object({
      playlist: Joi.array().items(Joi.string()).required(),
      time: Joi.number().integer().positive().optional()
    });
    joiValidate(schema, req.body);

    // Setup Token Data
    const playlistId = nanoId.nanoid(10);

    const tokenData = {
      playlistId: playlistId,
      shareToken: true,
      username: req.user.username
    };

    const jwtOptions = {};
    if (req.body.time) { jwtOptions.expiresIn = `${req.body.time}d`; }
    const token = jwt.sign(tokenData, config.program.secret, jwtOptions)

    const sharedItem = {
      playlistId: playlistId,
      playlist: req.body.playlist,
      user: req.user.username,
      expires: req.body.time ? jwt.verify(token, config.program.secret).exp : null,
      token: token
    };

    db.getShareCollection().insert(sharedItem);
    db.saveShareDB();
    res.json(sharedItem);
  });
}
