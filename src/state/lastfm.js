// Scrobbler code shamelessly stolen from
// https://github.com/dittodhole/node-scribble-js
//
// Last.fm's signed-call protocol: a write carries api_sig = md5 of its
// parameters sorted by name, name+value concatenated, the shared secret
// appended. The three writers (scrobble, now-playing, love) build a
// parameter set and hand it to signedForm(); the hand-built per-method
// signature strings this file used to carry went when scrobble gained
// `timestamp` and `duration` for the Stats API (the sort order has to be
// right for any parameter set, so it is computed, not typed).
//
// Nothing here throws inside an HTTP callback — an unknown user, a failed
// login, a network error or a timeout answer the caller's callback with
// null. (A thrown TypeError in a response handler takes the process down;
// `ret.session.key` on an "Authentication Failed" answer used to do that.)
//
// Endpoint: ws.audioscrobbler.com over plain HTTP, as it always was. A test
// points an instance at a local fake with setEndpoint(); scrobbler.js reads
// MSTREAM_TEST_LASTFM_ENDPOINT for that.

import http from 'http';
import crypto from 'crypto';
import querystring from 'querystring';

const DEFAULT_ENDPOINT = Object.freeze({ host: 'ws.audioscrobbler.com', port: 80 });
const REQUEST_TIMEOUT_MS = 10000;

const Scribble = function () {
  this.users = {}
  this.endpoint = { ...DEFAULT_ENDPOINT }
}

Scribble.prototype.addUser = function (username, password) {
  this.users[username] = {
    password: password,
    sessionKey: null
  }
}

Scribble.prototype.hasUser = function (username) {
  return Object.prototype.hasOwnProperty.call(this.users, username)
}

// Forget a user's session so the next call logs in again — the answer to
// Last.fm's error 9 (invalid session key).
Scribble.prototype.dropSession = function (username) {
  if (this.users[username]) { this.users[username].sessionKey = null }
}

Scribble.prototype.reset = function () {
  Object.keys(this.users).forEach(k => delete this.users[k])
}

Scribble.prototype.setKeys = function (api_key, api_secret) {
  this.apiKey = api_key
  this.apiSecret = api_secret
}

Scribble.prototype.setEndpoint = function (endpoint) {
  this.endpoint = { ...DEFAULT_ENDPOINT, ...(endpoint || {}) }
}

Scribble.prototype.Love = function (song, username, callback) {
  const self = this
  withSession(self, username, callback, (sk) => postLove(self, song, sk, callback))
}

Scribble.prototype.Scrobble = function (song, username, callback) {
  const self = this
  withSession(self, username, callback, (sk) => postScrobble(self, song, sk, callback))
}

Scribble.prototype.NowPlaying = function (song, username, callback) {
  const self = this
  withSession(self, username, callback, (sk) => postNowPlaying(self, song, sk, callback))
}

Scribble.prototype.MakeSession = function (username, callback) {
  const self = this
  const user = this.users[username]
  if (!user) { done(callback, null); return }

  const token = makeHash(username + makeHash(user.password))
    , apiSig = makeHash('api_key' + this.apiKey + 'authToken' + token + 'methodauth.getMobileSessionusername' + username + this.apiSecret)
    , path = '/2.0/?method=auth.getMobileSession&' +
      'username=' + encodeURIComponent(username) +
      '&authToken=' + token +
      '&api_key=' + this.apiKey +
      '&api_sig=' + apiSig + '&format=json'
  sendGet(self, path, function (ret) {
    const key = ret && ret.session && ret.session.key
    if (!key) { done(callback, null); return }
    user.sessionKey = key
    done(callback, key)
  })
}

Scribble.prototype.GetArtistInfo = function (artist, callback) {
  const path = '/2.0/?method=artist.getInfo&artist=' + artist + '&api_key=' + this.apiKey + '&format=json'
  sendGet(this, path, callback)
}

Scribble.prototype.GetSimilarArtists = function (artist, callback, limit) {
  const amt = limit || 50;
  const path = '/2.0/?method=artist.getSimilar&artist=' + artist + '&api_key=' + this.apiKey + '&format=json&limit=' + amt
  sendGet(this, path, callback)
}

Scribble.prototype.GetArtistEvents = function (artist, callback, limit) {
  const amt = limit || 50;
  const path = '/2.0/?method=artist.getevents&artist=' + artist + '&api_key=' + this.apiKey + '&format=json&limit=' + amt
  sendGet(this, path, callback)
}

Scribble.prototype.GetArtistTopAlbums = function (artist, callback, limit) {
  const amt = limit || 50;
  const path = '/2.0/?method=artist.gettopalbums&artist=' + artist + '&api_key=' + this.apiKey + '&format=json&limit=' + amt
  sendGet(this, path, callback)
}

Scribble.prototype.GetArtistTopTracks = function (artist, callback, limit) {
  const amt = limit || 50;
  const path = '/2.0/?method=artist.gettoptracks&artist=' + artist + '&api_key=' + this.apiKey + '&format=json&limit=' + amt
  sendGet(this, path, callback)
}

Scribble.prototype.GetSimilarSongs = function (song, callback, limit) {
  const amt = limit || 50;
  const path = '/2.0/?method=track.getSimilar&artist=' + song.artist + '&track=' + song.track + '&api_key=' + this.apiKey + '&format=json&limit=' + amt
  sendGet(this, path, callback)
}

Scribble.prototype.GetTrackInfo = function (song, callback) {
  const path = '/2.0/?method=track.getInfo&api_key=' + this.apiKey + '&artist=' + encodeURIComponent(song.artist) + '&track=' + encodeURIComponent(song.track) + '&format=json'
  sendGet(this, path, callback)
}

Scribble.prototype.GetAlbumInfo = function (song, callback) {
  song.album = song.album.replace(/\s/g, '%20')
  const path = '2.0/?method=album.getinfo&api_key=' + this.apiKey + '&artist=' + song.artist + '&album=' + song.album + '&format=json'
  sendGet(this, path, callback)
}

// ── Signing ─────────────────────────────────────────────────────────────────

// The request signature: parameters sorted by name, name+value concatenated,
// the shared secret appended, md5'd. `format` never takes part; absent
// values are not sent and so not signed.
export function signParams(params, secret) {
  const keys = Object.keys(params)
    .filter((k) => k !== 'format' && params[k] !== undefined && params[k] !== null)
    .sort()
  return makeHash(keys.map((k) => k + String(params[k])).join('') + secret)
}

// The signed form body for a write: api_key added, api_sig computed over
// what is actually sent, `format=json` so the answer can be read for errors.
function signedForm(self, params) {
  const clean = {}
  for (const k of Object.keys(params)) {
    if (params[k] !== undefined && params[k] !== null) { clean[k] = params[k] }
  }
  clean.api_key = self.apiKey
  clean.api_sig = signParams(clean, self.apiSecret)
  clean.format = 'json'
  return querystring.stringify(clean)
}

// ── Writers ─────────────────────────────────────────────────────────────────

function postLove(self, song, sk, callback) {
  sendPost(self, signedForm(self, {
    method: 'track.love',
    sk,
    artist: song.artist,
    track: song.track,
    album: song.album || '_',
  }), callback)
}

function postNowPlaying(self, song, sk, callback) {
  sendPost(self, signedForm(self, {
    method: 'track.updateNowPlaying',
    sk,
    artist: song.artist,
    track: song.track,
    album: song.album || '_',
    duration: song.duration || undefined,
  }), callback)
}

// `song.timestamp` is the play's own start in epoch seconds — the Stats API
// forwards plays after the fact, so an offline afternoon lands on the right
// day. A caller without one gets "now", as before. `song.duration` (seconds)
// rides along when known.
function postScrobble(self, song, sk, callback) {
  const timestamp = Number.isInteger(song.timestamp) ? song.timestamp : Math.floor(Date.now() / 1000)
  sendPost(self, signedForm(self, {
    method: 'track.scrobble',
    sk,
    timestamp,
    artist: song.artist,
    track: song.track,
    album: song.album || '_',
    duration: song.duration || undefined,
  }), callback)
}

// ── Transport ───────────────────────────────────────────────────────────────

// Log in when there is no session yet, then post. An unknown user or a
// failed login answers the callback with null.
function withSession(self, username, callback, post) {
  const user = self.users[username]
  if (!user) { done(callback, null); return }
  if (user.sessionKey != null) { post(user.sessionKey); return }
  self.MakeSession(username, function (sk) {
    if (!sk) { done(callback, null); return }
    post(sk)
  })
}

function done(callback, value) {
  if (typeof callback === 'function') { callback(value) }
}

// POST a form body; the callback gets the response text, or null on a
// network error or timeout.
function sendPost(self, data, callback) {
  let settled = false
  const finish = (v) => { if (!settled) { settled = true; done(callback, v) } }
  const options = {
    host: self.endpoint.host,
    port: self.endpoint.port,
    path: '/2.0/',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(data)
    }
  }
  const req = http.request(options, function (res) {
    let body = ''
    res.setEncoding('utf8')
    res.on('data', (chunk) => { body += chunk })
    res.on('end', () => finish(body))
  })
  req.on('error', () => finish(null))
  req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('timeout')))
  req.write(data)
  req.end()
}

// GET a JSON answer; the callback gets the parsed object, or null on a
// network error, timeout, or a body that is not JSON.
function sendGet(self, path, callback) {
  let settled = false
  const finish = (v) => { if (!settled) { settled = true; done(callback, v) } }
  const req = http.get({ host: self.endpoint.host, port: self.endpoint.port, path }, function (res) {
    let body = ''
    res.setEncoding('utf8')
    res.on('data', (chunk) => { body += chunk })
    res.on('end', () => {
      let ret = null
      try {
        ret = JSON.parse(body)
      } catch (_err) {
        console.log('[INVALID RETURN] the return was invalid JSON: ' + body.slice(0, 200))
      }
      finish(ret)
    })
  })
  req.on('error', (err) => { console.log(err.message); finish(null) })
  req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('timeout')))
}

function makeHash(input) {
  return crypto.createHash('md5').update(input, 'utf8').digest("hex")
}

export default Scribble;
