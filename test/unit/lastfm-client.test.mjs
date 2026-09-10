/**
 * The Last.fm client (src/state/lastfm.js) against a local fake Last.fm.
 *
 * Pins what the Stats API's forwarding relies on: a scrobble carries the
 * caller's `timestamp` (the play's own start) and `duration`, the signature
 * is computed over the parameters actually sent (sorted by name, secret
 * appended — the Last.fm rule), the session is fetched once and reused, and
 * every failure path — unknown user, refused login, unreachable host —
 * answers the callback with null instead of throwing inside an HTTP callback
 * (which would take the server down).
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import Scribble, { signParams } from '../../src/state/lastfm.js';

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

let server;
let port;
let calls = [];
let sessionResponse = { session: { name: 'u', key: 'sk1' } };

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET') {
        calls.push({ method: 'GET', params: Object.fromEntries(new URL(req.url, 'http://fake').searchParams) });
        res.end(JSON.stringify(sessionResponse));
        return;
      }
      const params = Object.fromEntries(new URLSearchParams(body));
      calls.push({ method: 'POST', params });
      res.end(JSON.stringify(params.method === 'track.scrobble'
        ? { scrobbles: { '@attr': { accepted: 1, ignored: 0 } } }
        : { nowplaying: {} }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });

function client() {
  const s = new Scribble();
  s.setKeys('key', 'secret');
  s.setEndpoint({ host: '127.0.0.1', port });
  return s;
}
const call = (s, method, song, user) => new Promise((resolve) => s[method](song, user, resolve));

describe('Scribble — the Last.fm client', () => {
  test('signParams: sorted by name, format and absent values left out, secret appended', () => {
    const sig = signParams({
      track: 'T', method: 'track.love', artist: 'A', album: '_', api_key: 'key', sk: 'S',
      format: 'json', duration: undefined, timestamp: null,
    }, 'secret');
    assert.equal(sig, md5('album_api_keykeyartistAmethodtrack.loveskStrackTsecret'));
  });

  test('a scrobble logs in once, then posts the given timestamp and duration, correctly signed', async () => {
    calls = []; sessionResponse = { session: { name: 'u', key: 'sk1' } };
    const s = client();
    s.addUser('u', 'pw');
    const body = await call(s, 'Scrobble',
      { artist: 'Radiohead', track: 'Let Down', album: 'OK Computer', timestamp: 1757415600, duration: 299 }, 'u');
    assert.ok(JSON.parse(body).scrobbles, 'the response text comes back to the caller');

    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].params.method, 'auth.getMobileSession');
    assert.equal(calls[0].params.authToken, md5('u' + md5('pw')));
    assert.equal(calls[0].params.format, 'json');

    const p = calls[1].params;
    assert.equal(calls[1].method, 'POST');
    assert.equal(p.method, 'track.scrobble');
    assert.equal(p.timestamp, '1757415600');
    assert.equal(p.duration, '299');
    assert.equal(p.sk, 'sk1');
    assert.equal(p.api_key, 'key');
    assert.equal(p.format, 'json', 'answers come back as JSON so errors can be read');
    assert.equal(p.api_sig,
      md5('albumOK Computerapi_keykeyartistRadioheadduration299methodtrack.scrobblesksk1timestamp1757415600trackLet Downsecret'));

    // The second call reuses the session; no timestamp means "now", and
    // the album still defaults to "_" the way it always did.
    const before = Math.floor(Date.now() / 1000);
    await call(s, 'Scrobble', { artist: 'A', track: 'B' }, 'u');
    assert.equal(calls.filter((c) => c.method === 'GET').length, 1);
    assert.equal(calls[2].params.album, '_');
    assert.equal(calls[2].params.duration, undefined, 'no duration → not sent, not signed');
    const ts = Number(calls[2].params.timestamp);
    assert.ok(ts >= before && ts <= before + 5, `timestamp ${ts} is now`);
  });

  test('now-playing keeps the pre-existing signature (regression against the hand-built string)', async () => {
    calls = []; sessionResponse = { session: { key: 'sk2' } };
    const s = client();
    s.addUser('u', 'pw');
    await call(s, 'NowPlaying', { artist: 'A', track: 'T', album: 'L', duration: 180 }, 'u');
    const p = calls[1].params;
    assert.equal(p.method, 'track.updateNowPlaying');
    // What src/state/lastfm.js used to concatenate by hand for this call.
    const legacy = md5('album' + 'L' + 'api_key' + 'key' + 'artist' + 'A' + 'duration' + 180
      + 'methodtrack.updateNowPlayingsk' + 'sk2' + 'track' + 'T' + 'secret');
    assert.equal(p.api_sig, legacy);
  });

  test('a refused login answers null and posts nothing — no throw inside the HTTP callback', async () => {
    calls = []; sessionResponse = { error: 4, message: 'Authentication Failed' };
    const s = client();
    s.addUser('bad', 'pw');
    assert.equal(await call(s, 'Scrobble', { artist: 'A', track: 'T' }, 'bad'), null);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
    assert.equal(s.users.bad.sessionKey, null, 'nothing cached from a refusal');
  });

  test('an unknown user answers null', async () => {
    const s = client();
    assert.equal(await call(s, 'Scrobble', { artist: 'A', track: 'T' }, 'nobody'), null);
    assert.equal(await call(s, 'NowPlaying', { artist: 'A', track: 'T' }, 'nobody'), null);
  });

  test('an unreachable endpoint answers null instead of hanging', async () => {
    const s = new Scribble();
    s.setKeys('k', 's');
    s.setEndpoint({ host: '127.0.0.1', port: 1 });
    s.addUser('u', 'pw');
    assert.equal(await call(s, 'Scrobble', { artist: 'A', track: 'T' }, 'u'), null);
  });

  test('dropSession forgets the key so the next call logs in again', async () => {
    calls = []; sessionResponse = { session: { key: 'sk3' } };
    const s = client();
    s.addUser('u', 'pw');
    await call(s, 'Scrobble', { artist: 'A', track: 'T' }, 'u');
    s.dropSession('u');
    await call(s, 'Scrobble', { artist: 'A', track: 'T' }, 'u');
    assert.equal(calls.filter((c) => c.method === 'GET').length, 2);
    assert.equal(s.hasUser('u'), true);
    assert.equal(s.hasUser('x'), false);
  });
});
