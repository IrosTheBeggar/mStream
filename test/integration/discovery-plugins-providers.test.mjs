/**
 * The catalogue and federation plug-ins over HTTP, against LOCAL mocks:
 *
 *   POST /api/v1/discovery/plugins/deezer/resolve
 *   POST /api/v1/discovery/plugins/itunes/resolve
 *   POST /api/v1/discovery/plugins/federation-play/resolve
 *
 * A single mock HTTP server plays both Deezer (`/track/isrc:…`, `/search`)
 * and the iTunes Search API (`/lookup`, `/search?term=`); the server under
 * test is pointed at it through MSTREAM_DEEZER_BASE / MSTREAM_ITUNES_BASE —
 * the same overrides the album-art downloader's tests use — so nothing here
 * touches the real services. The federation plug-in gets a peer row seeded
 * straight into mstream.db (a real ticket needs a live peer); the stream
 * itself is not exercised — this plug-in only builds the URL the existing
 * proxy route serves.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../helpers/server.mjs';

let server;
let mock;
let mockBase;
const seen = [];   // every mock request path, for assertions on what was sent

const DEEZER_TRACK = {
  id: 101, title: 'Opening', duration: 216, isrc: 'GBCMP9800001',
  preview: 'https://cdn.deezer.example/opening.mp3', link: 'https://www.deezer.com/track/101',
  artist: { name: 'Compat Artist' }, album: { title: 'First Album', cover_medium: 'https://cdn.deezer.example/first.jpg' },
};
const DEEZER_SEARCH = [
  { id: 202, title: 'Opening (Karaoke Version)', duration: 216, preview: 'https://cdn.deezer.example/karaoke.mp3', link: 'https://www.deezer.com/track/202', artist: { name: 'Karaoke Kings' }, album: { title: 'Sing Along' } },
  { id: 203, title: 'Opening', duration: 217, preview: 'https://cdn.deezer.example/opening-search.mp3', link: 'https://www.deezer.com/track/203', artist: { name: 'Compat Artist' }, album: { title: 'First Album' } },
];
const ITUNES_SONG = {
  wrapperType: 'track', kind: 'song', trackId: 501, trackName: 'Opening', artistName: 'Compat Artist', collectionName: 'First Album',
  trackTimeMillis: 216000, previewUrl: 'https://audio-ssl.itunes.example/opening.m4a', trackViewUrl: 'https://music.apple.com/us/album/opening/500?i=501',
  artworkUrl100: 'https://is1.example/opening.jpg',
};

function startMock() {
  return new Promise((resolve) => {
    mock = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://mock');
      seen.push(url.pathname + url.search);
      const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      // Deezer
      if (url.pathname === '/track/isrc:GBCMP9800001') { return json(200, DEEZER_TRACK); }
      if (url.pathname.startsWith('/track/isrc:')) { return json(200, { error: { code: 800, message: 'no data' } }); }
      if (url.pathname === '/search' && url.searchParams.has('q')) {
        const q = url.searchParams.get('q');
        if (/Opening/.test(q)) { return json(200, { data: DEEZER_SEARCH }); }
        if (/boom/i.test(q)) { return json(500, { error: 'boom' }); }
        return json(200, { data: [] });
      }
      // iTunes
      if (url.pathname === '/lookup') {
        const isrc = url.searchParams.get('isrc');
        return json(200, isrc === 'GBCMP9800001' ? { resultCount: 1, results: [ITUNES_SONG] } : { resultCount: 0, results: [] });
      }
      if (url.pathname === '/search' && url.searchParams.has('term')) {
        const term = url.searchParams.get('term');
        if (/Opening/.test(term)) { return json(200, { resultCount: 1, results: [ITUNES_SONG] }); }
        if (/boom/i.test(term)) { return json(429, {}); }
        return json(200, { resultCount: 0, results: [] });
      }
      json(404, {});
    });
    mock.listen(0, '127.0.0.1', () => {
      mockBase = `http://127.0.0.1:${mock.address().port}`;
      resolve();
    });
  });
}

const resolve = (name, recommendation) => fetch(`${server.baseUrl}/api/v1/discovery/plugins/${name}/resolve`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recommendation }),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

describe('discovery plug-ins — Deezer, iTunes, federation-play', () => {
  before(async () => {
    await startMock();
    server = await startServer({
      dlnaMode: 'disabled', waitForScan: false,
      env: { MSTREAM_DEEZER_BASE: mockBase, MSTREAM_ITUNES_BASE: mockBase },
      extraConfig: { federation: { enabled: true } },
    });
    // A paired peer for federation-play — the row is all the plug-in reads.
    const db = new DatabaseSync(path.join(server.tmpDir, 'db', 'mstream.db'));
    try {
      db.prepare("INSERT INTO federation_peers (id, name, endpoint_ticket, api_key) VALUES (7, 'Peer F', 'ticket-not-used', 'fedk_test')").run();
    } finally { db.close(); }
  });
  after(async () => {
    if (server) { await server.stop(); }
    if (mock) { await new Promise((r) => mock.close(r)); }
  });

  test('the four plug-ins are listed with the right capabilities', async () => {
    const { plugins } = await (await fetch(`${server.baseUrl}/api/v1/discovery/plugins`)).json();
    const byName = Object.fromEntries(plugins.map((p) => [p.name, p]));
    assert.deepEqual(byName.deezer.capabilities, ['preview']);
    assert.deepEqual(byName.itunes.capabilities, ['preview']);
    assert.deepEqual(byName['federation-play'].capabilities, ['play']);
    assert.deepEqual(byName.links.capabilities, ['links']);
  });

  test('deezer: an ISRC hits the exact track and nothing else is searched', async () => {
    seen.length = 0;
    const { status, body } = await resolve('deezer', { artist: 'Compat Artist', title: 'Opening', isrc: 'GBCMP9800001', duration: 216 });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.result.preview.provider, 'deezer');
    assert.equal(body.result.preview.url, 'https://cdn.deezer.example/opening.mp3');
    assert.equal(body.result.preview.match, 1);
    assert.equal(body.result.preview.link, 'https://www.deezer.com/track/101');
    assert.deepEqual(seen, ['/track/isrc:GBCMP9800001']);
  });

  test('deezer: without an ISRC the advanced search is matched, the karaoke cover loses', async () => {
    seen.length = 0;
    const { status, body } = await resolve('deezer', { artist: 'Compat Artist', title: 'Opening', album: 'First Album', duration: 216 });
    assert.equal(status, 200);
    assert.equal(body.result.preview.url, 'https://cdn.deezer.example/opening-search.mp3');
    assert.ok(seen[0].startsWith('/search?q=artist%3A%22Compat%20Artist%22%20track%3A%22Opening%22'), seen[0]);
  });

  test('deezer: no match is a 200 with preview null; a second ask is served from cache', async () => {
    seen.length = 0;
    const first = await resolve('deezer', { artist: 'Nobody', title: 'Nothing Here', duration: 100 });
    assert.equal(first.status, 200);
    assert.equal(first.body.result.preview, null);
    const requestsAfterFirst = seen.length;
    assert.ok(requestsAfterFirst >= 1, 'advanced + plain search tried');
    await resolve('deezer', { artist: 'Nobody', title: 'Nothing Here', duration: 100 });
    assert.equal(seen.length, requestsAfterFirst, 'cached: no new catalogue requests');
  });

  test('deezer: a catalogue failure is a 502, never a server error', async () => {
    const { status } = await resolve('deezer', { artist: 'boom', title: 'boom' });
    assert.equal(status, 502);
  });

  test('itunes: search is matched and carries the attribution and store link', async () => {
    seen.length = 0;
    const { status, body } = await resolve('itunes', { artist: 'Compat Artist', title: 'Opening', album: 'First Album', duration: 216 });
    assert.equal(status, 200, JSON.stringify(body));
    const p = body.result.preview;
    assert.equal(p.provider, 'itunes');
    assert.equal(p.url, 'https://audio-ssl.itunes.example/opening.m4a');
    assert.equal(p.attribution, 'Provided courtesy of iTunes');
    assert.equal(p.link, 'https://music.apple.com/us/album/opening/500?i=501');
    assert.match(seen[0], /^\/search\?term=Compat%20Artist%20Opening&media=music&entity=song&limit=10&country=US$/);
  });

  test('itunes: an ISRC goes to lookup first', async () => {
    seen.length = 0;
    const { body } = await resolve('itunes', { artist: 'X', title: 'Y', isrc: 'GBCMP9800001' });
    assert.equal(body.result.preview.match, 1);
    assert.equal(seen[0], '/lookup?isrc=GBCMP9800001&entity=song&country=US');
  });

  test('itunes: a 429 from the catalogue is passed through as 429', async () => {
    const { status } = await resolve('itunes', { artist: 'boom', title: 'boom' });
    assert.equal(status, 429);
  });

  test('federation-play: a peer row becomes the stream proxy URL; a network row answers null', async () => {
    const yes = await resolve('federation-play', {
      artist: 'Ana', title: 'Alpha Song', source: 'federation', filepath: 'shared/Ana/Alpha Song.mp3', peer: { id: 7, name: 'Peer F' },
    });
    assert.equal(yes.status, 200, JSON.stringify(yes.body));
    assert.equal(yes.body.result.play.url, '/api/v1/federation/peers/7/stream/shared/Ana/Alpha%20Song.mp3');
    assert.deepEqual(yes.body.result.play.peer, { id: 7, name: 'Peer F' });

    const p2p = await resolve('federation-play', { artist: 'Ana', title: 'Alpha Song', source: 'p2p', peer: { endpointId: 'a'.repeat(64) } });
    assert.equal(p2p.body.result.play, null);
    const unknown = await resolve('federation-play', { source: 'federation', filepath: 'x.mp3', peer: { id: 99 } });
    assert.equal(unknown.body.result.play, null);
  });
});
