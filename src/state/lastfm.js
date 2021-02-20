// Scrobbler code shamelessly stolen from
// https://github.com/dittodhole/node-scribble-js

/**/// GLOBALS
var http = require('http')
  , crypto = require('crypto')
  , querystring = require('querystring')
/**/// Public: Scribble
/**///
/**/// Returns
/**/// return     - A scribble
var Scribble = function () {
  this.users = {}
}

Scribble.prototype.addUser = function (username, password) {
  this.users[username] = {
    password: password,
    sessionKey: null
  }
}

Scribble.prototype.reset = function () {
  Object.keys(this.users).forEach(k => delete this.users[k])
}

Scribble.prototype.setKeys = function (api_key, api_secret) {
  this.apiKey = api_key
  this.apiSecret = api_secret
}

/**/// Public: Love
/**///
/**/// Args
/**/// song - song object. artist, track keys
Scribble.prototype.Love = function (song, username, callback) {
  var self = this
  if (self.users[username].sessionKey == null) {
    self.MakeSession(username, function (sk) {
      postLove(self, song, sk, username, callback)
    })
  } else {
    postLove(self, song, self.users[username].sessionKey, username, callback)
  }
}
/**/// Public: Scrobble
/**///
/**/// Args
/**/// song - song object. artist, track keys
Scribble.prototype.Scrobble = function (song, username, callback) {
  var self = this

  if (self.users[username].sessionKey == null) {
    self.MakeSession(username, function (sk) {
      postScrobble(self, song, sk, username, callback)
    })
  } else {
    postScrobble(self, song, self.users[username].sessionKey, username, callback)
  }
}
/**/// Public: NowPlaying
/**///
/**/// Args
/**/// song - song object. artist, track keys
Scribble.prototype.NowPlaying = function (song, username, callback) {
  var self = this
  if (self.users[username].sessionKey == null) {
    self.MakeSession(username, function (sk) {
      postNowPlaying(self, song, sk, username, callback)
    })
  } else {
    postNowPlaying(self, song, self.users[username].sessionKey, username, callback)
  }
}
/**/// Public: MakeSession
/**///
/**/// Args
/**/// callback - optional callback function
/**///
/**/// Returns
/**/// return - a session key and optional callback
Scribble.prototype.MakeSession = function (username, callback) {
  var self = this
  var password = this.users[username].password;

  var token = makeHash(username + makeHash(password))
    , apiSig = makeHash('api_key' + this.apiKey + 'authToken' + token + 'methodauth.getMobileSessionusername' + username + this.apiSecret)
    , path = '/2.0/?method=auth.getMobileSession&' +
      'username=' + username +
      '&authToken=' + token +
      '&api_key=' + this.apiKey +
      '&api_sig=' + apiSig + '&format=json'
  sendGet(path, function (ret) {
    self.users[username].sessionKey = ret.session.key
    if (typeof (callback) == 'function') {
      callback(ret.session.key)
    }
  })
}
/**/// Public: GetArtistInfo
/**///
/**/// Args
/**/// artist   - artist string
/**/// callback - callback function
/**///
/**/// Returns
/**/// return   - object of artist summary
Scribble.prototype.GetArtistInfo = function (artist, callback) {
  var path = '/2.0/?method=artist.getInfo&artist=' + artist + '&api_key=' + this.apiKey + '&format=json'
  sendGet(path, function (ret) {
    if (typeof (callback) == 'function')
      callback(ret)
  })
}
/**/// Public: GetSimilarArtists
/**///
/**/// Args
/**/// artist   - artist string
/**/// callback - callback function
/**/// amt      - optional amount of returns
/**///
/**/// Returns
/**/// return   - object of similar artists
Scribble.prototype.GetSimilarArtists = function (artist, callback, amt) {
  var amt = amt || 50
    , path = '/2.0/?method=artist.getSimilar&artist=' + artist + '&api_key=' + this.apiKey + '&format=json&limit=' + amt
  sendGet(path, function (ret) {
    if (typeof (callback) == 'function')
      callback(ret)
  })
}
/**/// Public: GetArtistEvents
/**///
/**/// Args
/**/// song     - song object. artist, track keys
/**/// callback - callback function
/**/// amt      - optional amount of returns
/**///
/**/// Returns
/**/// return   - object of artist events
Scribble.prototype.GetArtistEvents = function (artist, callback, amt) {
  var amt = amt || 50
    , path = '/2.0/?method=artist.getevents&artist=' + artist + '&api_key=' + this.apiKey + '&format=json&limit=' + amt
  sendGet(path, function (ret) {
    if (typeof (callback) == 'function')
      callback(ret)
  })
}
/**/// Public: GetArtistTopAlbums
/**///
/**/// Args
/**/// song     - song object. artist, track keys
/**/// callback - callback function
/**/// amt      - optional amount of returns
/**///
/**/// Returns
/**/// return   - object of artist top albums
Scribble.prototype.GetArtistTopAlbums = function (artist, callback, amt) {
  var amt = amt || 50
    , path = '/2.0/?method=artist.gettopalbums&artist=' + artist + '&api_key=' + this.apiKey + '&format=json&limit=' + amt
  sendGet(path, function (ret) {
    if (typeof (callback) == 'function')
      callback(ret)
  })
}
/**/// Public: GetArtistTopTracks
/**///
/**/// Args
/**/// song     - song object. artist, track keys
/**/// callback - callback function
/**/// amt      - optional amount of returns
/**///
/**/// Returns
/**/// return   - object of artist top tracks
Scribble.prototype.GetArtistTopTracks = function (artist, callback, amt) {
  var amt = amt || 50
    , path = '/2.0/?method=artist.gettoptracks&artist=' + artist + '&api_key=' + this.apiKey + '&format=json&limit=' + amt
  sendGet(path, function (ret) {
    if (typeof (callback) == 'function')
      callback(ret)
  })
}
/**/// Public: GetSimilarSongs
/**///
/**/// Args
/**/// song     - song object. artist, track keys
/**/// callback - callback function
/**/// amt      - optional amount of returns
/**///
/**/// Returns
/**/// return   - object of similar songs
Scribble.prototype.GetSimilarSongs = function (song, callback, amt) {
  var amt = amt || 50
    , path = '/2.0/?method=track.getSimilar&artist=' + song.artist + '&track=' + song.track + '&api_key=' + this.apiKey + '&format=json&limit=' + amt
  sendGet(path, function (ret) {
    if (typeof (callback) == 'function')
      callback(ret)
  })
}
/**/// Public: GetTrackInfo
/**///
/**/// Args
/**/// song     - song object. artist, track keys
/**/// callback - callback function
/**///
/**/// Returns
/**/// return   - object of track info
Scribble.prototype.GetTrackInfo = function (song, callback) {
  var path = '/2.0/?method=track.getInfo&api_key=' + this.apiKey + '&artist=' + encodeURIComponent(song.artist) + '&track=' + encodeURIComponent(song.track) + '&format=json'
  sendGet(path, function (ret) {
    if (typeof (callback) == 'function')
      callback(ret)
  })
}
/**/// Public: GetAlbumInfo
/**///
/**/// Args
/**/// song     - song object. artist, track, album keys
/**/// callback - callback function
/**///
/**/// Returns
/**/// return   - object of album information
Scribble.prototype.GetAlbumInfo = function (song, callback) {
  song.album = song.album.replace(/\s/g, '%20')
  var path = '2.0/?method=album.getinfo&api_key=' + this.apiKey + '&artist=' + song.artist + '&album=' + song.album + '&format=json'
  sendGet(path, function (ret) {
    if (typeof (callback) == 'function')
      callback(ret)
  })
}
/**/// Private: postLove
/**///
/**/// Args
/**/// self     - your Scribble object
/**/// song     - song object. artist, track keys
/**/// sk       - optional session key
/**/// callback - callback function
/**///
/**/// Notes
/**/// note     - Build and send love request
function postLove(self, song, sk, username, callback) {
  if (sk && self.users[username].sessionKey == null) {
    self.users[username].sessionKey = sk
  }
  var apiSig = makeHash('album' + (song.album || '_') + 'api_key' + self.apiKey + 'artist' + song.artist + 'methodtrack.lovesk' + self.users[username].sessionKey + 'track' + song.track + self.apiSecret)
    , post_data = querystring.stringify({
      method: 'track.love',
      api_key: self.apiKey,
      sk: self.users[username].sessionKey,
      api_sig: apiSig,
      artist: song.artist,
      track: song.track,
      album: song.album || '_'
    })
  sendPost(post_data, callback)
}
/**/// Private: postNowPlaying
/**///
/**/// Args
/**/// self     - your Scribble object
/**/// song     - song object. artist, track keys
/**/// sk       - optional session key
/**/// callback - callback function
/**///
/**/// Notes
/**/// note     - Build and send now playing request
function postNowPlaying(self, song, sk, username, callback) {
  if (sk && self.users[username].sessionKey == null) {
    self.users[username].sessionKey = sk
  }
  var dur = (song.duration) ? 'duration' + song.duration : ''
    , apiSig = makeHash('album' + (song.album || '_') + 'api_key' + self.apiKey + 'artist' + song.artist + dur + 'methodtrack.updateNowPlayingsk' + self.users[username].sessionKey + 'track' + song.track + self.apiSecret)
    , post_data = querystring.stringify({
      method: 'track.updateNowPlaying',
      artist: song.artist,
      track: song.track,
      album: song.album || '_',
      duration: song.duration,
      api_key: self.apiKey,
      api_sig: apiSig,
      sk: self.users[username].sessionKey
    })
  sendPost(post_data, callback)
}
/**/// Private: postScrobble
/**///
/**/// Args
/**/// self     - your Scribble object
/**/// song     - song object. artist, track keys
/**/// sk       - optional session key
/**/// callback - callback function
/**///
/**/// Notes
/**/// note     - Build and send scrobble request
function postScrobble(self, song, sk, username, callback) {
  if (sk && self.users[username].sessionKey == null) {
    self.users[username].sessionKey = sk
  }
  var now = new Date().getTime()
    , timestamp = Math.floor(now / 1000)
    , apiSig = makeHash('album' + (song.album || '_') + 'api_key' + self.apiKey + 'artist' + song.artist + 'methodtrack.scrobblesk' + self.users[username].sessionKey + 'timestamp' + timestamp + 'track' + song.track + self.apiSecret)
    , post_data = querystring.stringify({
      method: 'track.scrobble',
      api_key: self.apiKey,
      sk: self.users[username].sessionKey,
      api_sig: apiSig,
      timestamp: timestamp,
      artist: song.artist,
      track: song.track,
      album: song.album || '_'
    })
  sendPost(post_data, callback)
}
/**/// Private: sendPost
/**///
/**/// Args
/**/// data     - POST data object
/**/// callback - callback function
/**///
/**/// Returns
/**/// console  - POST response from API
/**///
/**/// Notes
/**/// note     - Send POST requests to Last.fm
function sendPost(data, callback) {
  var options = {
    host: 'ws.audioscrobbler.com',
    path: '/2.0/',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': data.length
    }
  }
    , doPOST = http.request(options, function (request) {
      var reqReturn = ''
      request.setEncoding('utf8')
      request.on('data', function (chunk) {
        reqReturn += chunk
      })
      request.on('end', function () {
        if (typeof (callback) == 'function')
          callback(reqReturn)
      })
    }).on('error', function (err) {
      // TODO
    })
  doPOST.write(data)
  doPOST.end()
}
/**/// Public: sendGet
/**///
/**/// Args
/**/// path     - html path for API call
/**/// callback - callback function
/**///
/**/// Returns
/**/// return   - callback function with return value from API call
function sendGet(path, callback) {
  var response = ''
    , apiCall = {
      host: 'ws.audioscrobbler.com',
      port: 80,
      path: path
    }
  http.get(apiCall, function (res) {
    res.on('data', function (chunk) {
      try {
        response += chunk
      } catch (err) {
        // TODO
      }
    })
    res.on('end', function () {
      try {
        var ret = JSON.parse(response)
        //var ret = response
        if (typeof (callback) == 'function')
          callback(ret)
      } catch (err) {
        // TODO
        console.log(err)
        console.log('[INVALID RETURN] the return was invalid JSON: ' + err)
      }
    })
  }).on('error', function (err) {
    console.log(err.message)
  })
}
/**/// Private: makeHash
/**///
/**/// Args
/**/// input - string input to hash
/**///
/**/// Returns
/**/// return - md5 hash of the input string
function makeHash(input) {
  return crypto.createHash('md5').update(input, 'utf8').digest("hex")
}

module.exports = Scribble
