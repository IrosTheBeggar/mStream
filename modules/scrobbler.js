const scribble = require('./scribble.js');
const Scrobbler = new scribble('25627de528b6603d6471cd331ac819e0', 'a9df934fc504174d4cb68853d9feb143', 'irosTheBeggar', 'qnUQjESA1Eg4+fH01WVY1');

exports.setup = function (mstream, program) {
  for (let user in program.users) {
    if (program.users.hasOwnProperty(user)) {
      if (program.users[user]['lastfm-user'] && program.users[user]['lastfm-password']) {
        // TODO: Test Auth and alert user if it doesn't work        
        Scrobbler.addUser(program.users[user]['lastfm-user'], program.users[user]['lastfm-password']);
      }
    }
  }

  mstream.post('/lastfm/scrobble-by-metadata', function (req, res) {
    var artist = req.body.artist;
    var album = req.body.album;
    var track = req.body.track;

    // TODO: update last-played field in DB

    if (!req.user['lastfm-user'] || !req.user['lastfm-password']) {
      res.json({ scrobble: false });
      return;
    }

    Scrobbler.Scrobble({
      artist: artist,
      track: track,
      album: album
    },
      req.user['lastfm-user'],
      function (post_return_data) {
        res.json({ scrobble: true });
      });
  });
}
