/**
 * DLNA integration tests — exercise the full SOAP / SSDP / GENA surface of
 * src/api/dlna.js + src/dlna/*, against a live mStream process spawned on a
 * temp config + fresh DB. ~185 assertions covering browse hierarchy, smart
 * containers, album-artist split, sort/search, Samsung BASICVIEW, GENA
 * subscribe/notify, time-based seek, and error paths.
 *
 * Run: `npm test` or `node --test test/dlna.test.mjs`
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer } from '../helpers/server.mjs';
import { makeClient, CDS, CMS, decodeResult, extractField, countTag } from '../helpers/soap.mjs';
import { FIXTURE_SUMMARY } from '../helpers/fixtures.mjs';

// ── Shared harness ───────────────────────────────────────────────────────────
// Tests within a single file share this process, so one server is spawned for
// the whole suite and torn down on `after`.

let server, client;

before(async () => {
  server = await startServer({ dlnaMode: 'same-port', browseMode: 'dirs' });
  client = makeClient(server.baseUrl);
});

after(async () => {
  if (server) { await server.stop(); }
});

// ── Helpers local to this file ───────────────────────────────────────────────

const getLibObjId = async () => {
  const { text } = await client.browse('music');
  const m = decodeResult(text).match(/id="(lib-\d+)"/);
  return m ? m[1] : null;
};

const getTotalMatches = t => parseInt(extractField(t, 'TotalMatches') || '0', 10);
const getNumberReturned = t => parseInt(extractField(t, 'NumberReturned') || '0', 10);

// ── 1. Server & UPnP descriptions ────────────────────────────────────────────

describe('Server connectivity', () => {
  test('root HTTP 200', async () => {
    const r = await client.httpGet('/');
    assert.equal(r.status, 200);
  });

  test('device.xml served with expected services', async () => {
    const r = await client.httpGet('/dlna/device.xml');
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.match(body, /MediaServer/);
    assert.match(body, /ContentDirectory/);
    assert.match(body, /ConnectionManager/);
  });

  test('SCPDs served', async () => {
    const cds = await client.httpGet('/dlna/content-directory-scpd.xml');
    const cm  = await client.httpGet('/dlna/connection-manager-scpd.xml');
    assert.equal(cds.status, 200);
    assert.equal(cm.status,  200);
  });
});

// ── 2. Capabilities / ConnectionManager ──────────────────────────────────────

describe('Capabilities & ConnectionManager', () => {
  test('GetSearchCapabilities advertises expected properties', async () => {
    const { status, text } = await client.soap('/dlna/control/content-directory', CDS, 'GetSearchCapabilities');
    assert.equal(status, 200);
    for (const p of ['dc:title', 'dc:creator', 'upnp:artist', 'upnp:album', 'upnp:genre', 'upnp:class']) {
      assert.match(text, new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  test('GetSortCapabilities includes extended properties', async () => {
    const { status, text } = await client.soap('/dlna/control/content-directory', CDS, 'GetSortCapabilities');
    assert.equal(status, 200);
    for (const p of ['dc:title', 'dc:date', 'upnp:originalYear', 'res@duration', 'res@size']) {
      assert.match(text, new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  test('GetSystemUpdateID returns a numeric id', async () => {
    const { status, text } = await client.soap('/dlna/control/content-directory', CDS, 'GetSystemUpdateID');
    assert.equal(status, 200);
    const id = parseInt(extractField(text, 'Id') || '0', 10);
    assert.ok(id >= 1, `expected id >= 1, got ${id}`);
  });

  test('GetProtocolInfo advertises MP3+FLAC', async () => {
    const { status, text } = await client.soap('/dlna/control/connection-manager', CMS, 'GetProtocolInfo');
    assert.equal(status, 200);
    assert.match(text, /audio\/mpeg/);
    assert.match(text, /audio\/flac/);
    // Time-seek support announced
    assert.match(text, /DLNA\.ORG_OP=11/);
  });
});

// ── 3. Root container & Music wrapper ────────────────────────────────────────

describe('Root & Music container', () => {
  test('root has exactly one child: Music', async () => {
    const { status, text } = await client.browse('0');
    assert.equal(status, 200);
    assert.equal(getTotalMatches(text), 1);
    const didl = decodeResult(text);
    assert.match(didl, /id="music"/);
    assert.match(didl, /<dc:title>Music<\/dc:title>/);
  });

  test('root BrowseMetadata returns the friendly-name container', async () => {
    const { text } = await client.browse('0', 'BrowseMetadata');
    assert.match(decodeResult(text), /<upnp:class>object\.container<\/upnp:class>/);
  });

  test('Music container exposes libraries + virtual folders', async () => {
    const { text } = await client.browse('music');
    const didl = decodeResult(text);
    for (const id of ['lib-', 'recent', 'recentplayed', 'mostplayed', 'favorites', 'shuffle', 'years', 'playlists']) {
      assert.match(didl, new RegExp(`id="${id}`), `Music should expose ${id}…`);
    }
    for (const t of ['Recently Added', 'Recently Played', 'Most Played', 'Favorites', 'Shuffle', 'By Year', 'Playlists']) {
      assert.match(didl, new RegExp(`<dc:title>${t}</dc:title>`));
    }
  });

  test('Music BrowseMetadata has childCount = libraries + 7', async () => {
    const { text } = await client.browse('music', 'BrowseMetadata');
    const didl = decodeResult(text);
    const m = didl.match(/childCount="(\d+)"/);
    assert.ok(m);
    // One test library + 7 virtual containers
    assert.equal(parseInt(m[1], 10), 1 + 7);
  });
});

// ── 4. Library multi-view layout ─────────────────────────────────────────────

describe('Library multi-view layout', () => {
  let libObjId, libId;

  before(async () => { libObjId = await getLibObjId(); libId = libObjId.replace('lib-', ''); });

  test('library has exactly 6 view containers', async () => {
    const { text } = await client.browse(libObjId);
    assert.equal(getTotalMatches(text), 6);
  });

  test('all six views are present by id and title', async () => {
    const { text } = await client.browse(libObjId);
    const didl = decodeResult(text);
    for (const view of ['folders', 'artists', 'albumartists', 'albums', 'genres', 'tracks']) {
      assert.match(didl, new RegExp(`id="${view}-${libId}"`));
    }
    for (const title of ['Folders', 'Artists', 'Album Artists', 'Albums', 'Genres', 'All Tracks']) {
      assert.match(didl, new RegExp(`<dc:title>${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</dc:title>`));
    }
  });

  test('BrowseMetadata childCount is 6', async () => {
    const { text } = await client.browse(libObjId, 'BrowseMetadata');
    const m = decodeResult(text).match(/childCount="(\d+)"/);
    assert.equal(parseInt(m[1], 10), 6);
  });

  test('dlna.browse=flat puts "All Tracks" first', async () => {
    await client.apiPost('/api/v1/admin/dlna/browse', { browse: 'flat' });
    await sleep(50);
    const { text } = await client.browse(libObjId, 'BrowseDirectChildren', { count: 1 });
    assert.match(decodeResult(text), new RegExp(`id="tracks-${libId}"`));
  });

  test('dlna.browse=artist puts "Artists" first', async () => {
    await client.apiPost('/api/v1/admin/dlna/browse', { browse: 'artist' });
    await sleep(50);
    const { text } = await client.browse(libObjId, 'BrowseDirectChildren', { count: 1 });
    assert.match(decodeResult(text), new RegExp(`id="artists-${libId}"`));
  });
});

// ── 5. Each view drill-down ──────────────────────────────────────────────────

describe('Folders view', () => {
  let libObjId, libId;
  before(async () => { libObjId = await getLibObjId(); libId = libObjId.replace('lib-', ''); });

  test('Folders view returns top-level directories', async () => {
    const { status, text } = await client.browse(`folders-${libId}`);
    assert.equal(status, 200);
    const didl = decodeResult(text);
    const total = countTag(didl, 'container') + countTag(didl, 'item');
    assert.ok(total > 0);
  });

  test('drilling into a dir returns track items', async () => {
    const { text: root } = await client.browse(`folders-${libId}`);
    const dirId = (decodeResult(root).match(/id="(dir-[^"]+)"/) || [])[1];
    assert.ok(dirId, 'at least one subdirectory');
    const { text } = await client.browse(dirId);
    const didl = decodeResult(text);
    // Either nested dir container(s) or track items, depending on fixture depth
    assert.ok(countTag(didl, 'container') + countTag(didl, 'item') > 0);
  });
});

describe('Artists view', () => {
  let libObjId, libId;
  before(async () => { libObjId = await getLibObjId(); libId = libObjId.replace('lib-', ''); });

  test('Artists view lists all artists', async () => {
    const { text } = await client.browse(`artists-${libId}`);
    assert.equal(getTotalMatches(text), FIXTURE_SUMMARY.artists);
  });

  test('drilling artist → albums → tracks', async () => {
    const { text: rt } = await client.browse(`artists-${libId}`);
    const artistId = (decodeResult(rt).match(/id="(artist-[^"]+)"/) || [])[1];
    assert.ok(artistId);

    const { text: at } = await client.browse(artistId);
    const albumId = (decodeResult(at).match(/id="(album-[^"]+)"/) || [])[1];
    assert.ok(albumId);

    const { text: alt } = await client.browse(albumId);
    assert.ok(countTag(decodeResult(alt), 'item') > 0);
  });

  test('artist BrowseMetadata parent is artists-view', async () => {
    const { text: rt } = await client.browse(`artists-${libId}`);
    const artistId = (decodeResult(rt).match(/id="(artist-[^"]+)"/) || [])[1];
    const { text } = await client.browse(artistId, 'BrowseMetadata');
    assert.match(decodeResult(text), new RegExp(`parentID="artists-${libId}"`));
  });
});

describe('Album-Artists view', () => {
  let libObjId, libId;
  before(async () => { libObjId = await getLibObjId(); libId = libObjId.replace('lib-', ''); });

  test('Album-Artists uses "aartist-" prefix', async () => {
    const { text } = await client.browse(`albumartists-${libId}`);
    assert.match(decodeResult(text), /id="aartist-/);
  });

  test('drilling aartist → albums', async () => {
    const { text: rt } = await client.browse(`albumartists-${libId}`);
    const aartistId = (decodeResult(rt).match(/id="(aartist-[^"]+)"/) || [])[1];
    assert.ok(aartistId);
    const { text } = await client.browse(aartistId);
    assert.ok(countTag(decodeResult(text), 'container') > 0);
  });

  test('aartist BrowseMetadata parent is albumartists-view', async () => {
    const { text: rt } = await client.browse(`albumartists-${libId}`);
    const aartistId = (decodeResult(rt).match(/id="(aartist-[^"]+)"/) || [])[1];
    const { text } = await client.browse(aartistId, 'BrowseMetadata');
    assert.match(decodeResult(text), new RegExp(`parentID="albumartists-${libId}"`));
  });
});

describe('Albums view', () => {
  let libObjId, libId;
  before(async () => { libObjId = await getLibObjId(); libId = libObjId.replace('lib-', ''); });

  test('Albums view counts unique albums', async () => {
    const { text } = await client.browse(`albums-${libId}`);
    assert.equal(getTotalMatches(text), FIXTURE_SUMMARY.albums);
  });

  test('album drill returns tracks', async () => {
    const { text: rt } = await client.browse(`albums-${libId}`);
    const albumId = (decodeResult(rt).match(/id="(album-[^"]+)"/) || [])[1];
    const { text } = await client.browse(albumId);
    assert.ok(countTag(decodeResult(text), 'item') > 0);
  });

  test('album BrowseMetadata parent is albums-view', async () => {
    const { text: rt } = await client.browse(`albums-${libId}`);
    const albumId = (decodeResult(rt).match(/id="(album-[^"]+)"/) || [])[1];
    const { text } = await client.browse(albumId, 'BrowseMetadata');
    assert.match(decodeResult(text), new RegExp(`parentID="albums-${libId}"`));
  });
});

describe('Genres view', () => {
  let libObjId, libId;
  before(async () => { libObjId = await getLibObjId(); libId = libObjId.replace('lib-', ''); });

  test('Genres view counts distinct genres (including Unknown)', async () => {
    const { text } = await client.browse(`genres-${libId}`);
    assert.equal(getTotalMatches(text), FIXTURE_SUMMARY.genres);
  });

  test('genre → gartist → album → track drill path', async () => {
    const { text: rt } = await client.browse(`genres-${libId}`);
    const genreId = (decodeResult(rt).match(/id="(genre-[^"]+)"/) || [])[1];
    assert.ok(genreId);
    const { text: gt } = await client.browse(genreId);
    const gartistId = (decodeResult(gt).match(/id="(gartist-[^"]+)"/) || [])[1];
    assert.ok(gartistId);
    const { text: gat } = await client.browse(gartistId);
    const albumId = (decodeResult(gat).match(/id="(album-[^"]+)"/) || [])[1];
    assert.ok(albumId);
    const { text: alt } = await client.browse(albumId);
    assert.ok(countTag(decodeResult(alt), 'item') > 0);
  });

  test('genre BrowseMetadata parent is genres-view', async () => {
    const { text: rt } = await client.browse(`genres-${libId}`);
    const genreId = (decodeResult(rt).match(/id="(genre-[^"]+)"/) || [])[1];
    const { text } = await client.browse(genreId, 'BrowseMetadata');
    assert.match(decodeResult(text), new RegExp(`parentID="genres-${libId}"`));
  });

  // V34 regression: getGenreByName's count must come from
  // COUNT(DISTINCT t.id) — a multi-genre track must NOT be double-
  // counted in artist_count by appearing in multiple track_genres
  // rows.
  // Helper for the V34 tests below — find a tagged genre container's
  // id by browsing the genres view and matching by display name.
  // DLNA encodes the genre name with `Buffer.from(name).toString('base64url')`
  // so we can't reconstruct the id from the name without duplicating
  // the encoder. Browsing + grepping is cheaper than mirroring the encoder.
  async function findGenreContainerIdByName(displayName) {
    const { text } = await client.browse(`genres-${libId}`);
    const decoded = decodeResult(text);
    // Each genre container looks like:
    //   <container id="genre-N-ENCODED" ... ><dc:title>NAME</dc:title>...
    // Walk the list and pick the one whose dc:title matches.
    const re = /<container\s+id="(genre-[^"]+)"[^>]*>[\s\S]*?<dc:title>([^<]+)<\/dc:title>/g;
    let m;
    while ((m = re.exec(decoded)) !== null) {
      if (m[2] === displayName) { return m[1]; }
    }
    return null;
  }

  test('V34: artist_count uses DISTINCT and does not inflate on multi-genre tracks', async () => {
    const dbPath = path.join(server.tmpDir, 'db', 'mstream.db');
    const direct = new DatabaseSync(dbPath);
    try {
      const ambientId = direct.prepare('SELECT id FROM genres WHERE name = ?').get('Ambient').id;
      const electronicId = direct.prepare('SELECT id FROM genres WHERE name = ?').get('Electronic').id;
      const target = direct.prepare(
        `SELECT t.id FROM tracks t
         WHERE EXISTS (SELECT 1 FROM track_genres tg WHERE tg.track_id = t.id AND tg.genre_id = ?)
         LIMIT 1`
      ).get(ambientId);
      const ambientArtistCountBefore = direct.prepare(
        `SELECT COUNT(DISTINCT COALESCE(t.artist_id, 0)) AS n FROM tracks t
         JOIN track_genres tg ON tg.track_id = t.id
         WHERE tg.genre_id = ?`
      ).get(ambientId).n;

      direct.prepare(
        'INSERT OR IGNORE INTO track_genres (track_id, genre_id) VALUES (?, ?)'
      ).run(target.id, electronicId);

      const ambientContainerId = await findGenreContainerIdByName('Ambient');
      assert.ok(ambientContainerId, 'expected to find the Ambient genre container');
      const { text } = await client.browse(ambientContainerId, 'BrowseMetadata');
      const m = decodeResult(text).match(/childCount="(\d+)"/);
      assert.ok(m, 'expected childCount attribute on the genre container');
      assert.equal(Number(m[1]), ambientArtistCountBefore,
        'multi-genre track must not inflate artist_count via M2M join');
    } finally {
      const ambientId = direct.prepare('SELECT id FROM genres WHERE name = ?').get('Ambient').id;
      const electronicId = direct.prepare('SELECT id FROM genres WHERE name = ?').get('Electronic').id;
      const target = direct.prepare(
        `SELECT t.id FROM tracks t
         WHERE EXISTS (SELECT 1 FROM track_genres tg WHERE tg.track_id = t.id AND tg.genre_id = ?)
         LIMIT 1`
      ).get(ambientId);
      if (target) {
        direct.prepare(
          'DELETE FROM track_genres WHERE track_id = ? AND genre_id = ?'
        ).run(target.id, electronicId);
      }
      direct.close();
    }
  });

  // V34 regression: the DIDL item element should carry an upnp:genre
  // value sourced from the M2M correlated subquery. Single-string
  // contract preserved.
  test('V34: track item DIDL XML carries a single upnp:genre string for tagged tracks', async () => {
    const electronicContainerId = await findGenreContainerIdByName('Electronic');
    assert.ok(electronicContainerId, 'expected to find the Electronic genre container');
    const { text: gt } = await client.browse(electronicContainerId);
    const gartistId = (decodeResult(gt).match(/id="(gartist-[^"]+)"/) || [])[1];
    assert.ok(gartistId, 'expected a gartist-* child under the Electronic genre');
    const { text: gat } = await client.browse(gartistId);
    const albumId = (decodeResult(gat).match(/id="(album-[^"]+)"/) || [])[1];
    assert.ok(albumId, 'expected an album-* child under the gartist');
    const { text: alt } = await client.browse(albumId);
    const inner = decodeResult(alt);
    // Pre-V34 this came from the dropped column; post-V34 the value
    // source changes but the wire shape is identical.
    assert.match(inner, /<upnp:genre>Electronic<\/upnp:genre>/,
      'expected at least one upnp:genre>Electronic< on a tagged track');
  });
});

describe('All Tracks view', () => {
  let libObjId, libId;
  before(async () => { libObjId = await getLibObjId(); libId = libObjId.replace('lib-', ''); });

  test('flat track count matches the fixture library', async () => {
    const { text } = await client.browse(`tracks-${libId}`);
    assert.equal(getTotalMatches(text), FIXTURE_SUMMARY.trackCount);
  });

  test('sort criteria accepted', async () => {
    const { status } = await client.browse(`tracks-${libId}`, 'BrowseDirectChildren', { sort: '+dc:title', count: 5 });
    assert.equal(status, 200);
  });

  test('pagination via StartingIndex + RequestedCount', async () => {
    const { text: p1 } = await client.browse(`tracks-${libId}`, 'BrowseDirectChildren', { start: 0, count: 3 });
    const { text: p2 } = await client.browse(`tracks-${libId}`, 'BrowseDirectChildren', { start: 3, count: 3 });
    assert.equal(getNumberReturned(p1), 3);
    assert.ok(getNumberReturned(p2) > 0);
  });

  test('track media URL is served', async () => {
    const { text } = await client.browse(`tracks-${libId}`);
    const m = decodeResult(text).match(/<res[^>]*>(http:[^<]+)<\/res>/);
    assert.ok(m);
    const url = m[1].replace(/&amp;/g, '&');
    const r = await fetch(url, { method: 'HEAD' });
    assert.equal(r.status, 200);
  });
});

// ── 6. Virtual folders & smart containers ───────────────────────────────────

describe('Recently Added', () => {
  test('lists scanned tracks', async () => {
    const { text } = await client.browse('recent');
    assert.ok(getTotalMatches(text) > 0);
  });

  test('BrowseMetadata title is "Recently Added"', async () => {
    const { text } = await client.browse('recent', 'BrowseMetadata');
    assert.match(decodeResult(text), /<dc:title>Recently Added<\/dc:title>/);
  });
});

describe('Playlists', () => {
  test('playlists container returns 200', async () => {
    const { status } = await client.browse('playlists');
    assert.equal(status, 200);
  });

  test('BrowseMetadata title is "Playlists"', async () => {
    const { text } = await client.browse('playlists', 'BrowseMetadata');
    assert.match(decodeResult(text), /<dc:title>Playlists<\/dc:title>/);
  });
});

describe('Smart containers', () => {
  for (const { id, title } of [
    { id: 'recentplayed', title: 'Recently Played' },
    { id: 'mostplayed',   title: 'Most Played' },
    { id: 'favorites',    title: 'Favorites' },
    { id: 'shuffle',      title: 'Shuffle' },
  ]) {
    test(`"${id}" container exists and reports a valid total`, async () => {
      const { status, text } = await client.browse(id);
      assert.equal(status, 200);
      assert.ok(getNumberReturned(text) <= getTotalMatches(text));
      const { text: mt } = await client.browse(id, 'BrowseMetadata');
      assert.match(decodeResult(mt), new RegExp(`<dc:title>${title}</dc:title>`));
    });
  }

  test('shuffle returns the requested page size', async () => {
    const { text } = await client.browse('shuffle', 'BrowseDirectChildren', { count: 5 });
    assert.equal(getNumberReturned(text), 5);
  });

  test('By Year index lists distinct years', async () => {
    const { status, text } = await client.browse('years');
    assert.equal(status, 200);
    const didl = decodeResult(text);
    assert.equal(getTotalMatches(text), FIXTURE_SUMMARY.years);
    assert.match(didl, /id="year-\d+"/);
  });

  test('year-YYYY returns tracks from that year', async () => {
    const { text: ys } = await client.browse('years');
    const yearId = (decodeResult(ys).match(/id="(year-\d+)"/) || [])[1];
    const { text } = await client.browse(yearId);
    assert.ok(countTag(decodeResult(text), 'item') > 0);
  });
});

// ── 7. Search ────────────────────────────────────────────────────────────────

describe('Search', () => {
  test('wildcard "*" returns all tracks', async () => {
    const { text } = await client.search('0', '*');
    assert.equal(getTotalMatches(text), FIXTURE_SUMMARY.trackCount);
  });

  test('class filter for musicTrack matches all', async () => {
    const { text } = await client.search('0', 'upnp:class = "object.item.audioItem.musicTrack"');
    assert.equal(getTotalMatches(text), FIXTURE_SUMMARY.trackCount);
  });

  test('dc:title contains + sort + pagination', async () => {
    // Every fixture title contains at least one vowel — use a letter that
    // appears in multiple titles to make the assertion meaningful.
    const { text } = await client.search('0', 'dc:title contains "e"', { sort: '+dc:title', count: 3 });
    assert.equal(getNumberReturned(text), 3);
  });

  test('library-scoped search matches global when only one library exists', async () => {
    const libObjId = await getLibObjId();
    const { text: g } = await client.search('0', '*');
    const { text: l } = await client.search(libObjId, '*');
    assert.equal(getTotalMatches(l), getTotalMatches(g));
  });

  test('XML-encoded quotes decode correctly', async () => {
    const plain   = await client.search('0', 'dc:title contains "e"');
    const encoded = await client.search('0', 'dc:title contains &quot;e&quot;');
    assert.equal(getTotalMatches(encoded.text), getTotalMatches(plain.text));
  });

  test('compound AND', async () => {
    const { status } = await client.search('0', 'upnp:class = "object.item.audioItem.musicTrack" and dc:title contains "e"');
    assert.equal(status, 200);
  });

  test('derivedfrom matches audioItem', async () => {
    const { text } = await client.search('0', 'upnp:class derivedfrom "object.item.audioItem"');
    assert.equal(getTotalMatches(text), FIXTURE_SUMMARY.trackCount);
  });
});

// ── 8. Track items: metadata, dc:date, originalYear ─────────────────────────

describe('Track items', () => {
  test('track BrowseMetadata has audioItem class + <res>', async () => {
    const { text: rt } = await client.browse('recent', 'BrowseDirectChildren', { count: 1 });
    const trackId = (decodeResult(rt).match(/id="(track-\d+)"/) || [])[1];
    const { status, text } = await client.browse(trackId, 'BrowseMetadata');
    assert.equal(status, 200);
    const didl = decodeResult(text);
    assert.match(didl, /audioItem/);
    assert.match(didl, /<res /);
  });

  test('track BrowseDirectChildren returns zero items', async () => {
    const { text: rt } = await client.browse('recent', 'BrowseDirectChildren', { count: 1 });
    const trackId = (decodeResult(rt).match(/id="(track-\d+)"/) || [])[1];
    const { text } = await client.browse(trackId, 'BrowseDirectChildren');
    assert.equal(countTag(decodeResult(text), 'item'), 0);
  });

  test('tracks carry <dc:date> and <upnp:originalYear>', async () => {
    const { text } = await client.browse('recent');
    const didl = decodeResult(text);
    assert.match(didl, /<dc:date>\d{4}-01-01<\/dc:date>/);
    assert.match(didl, /<upnp:originalYear>\d{4}<\/upnp:originalYear>/);
  });

  test('protocolInfo advertises DLNA.ORG_OP=11 (byte + time seek)', async () => {
    const { text } = await client.browse('recent', 'BrowseDirectChildren', { count: 1 });
    const didl = decodeResult(text);
    assert.match(didl, /DLNA\.ORG_OP=11/);
  });
});

// ── 9. Time-based seek (TimeSeekRange.dlna.org) ─────────────────────────────

describe('Time-based seek', () => {
  let mediaUrl;

  before(async () => {
    const libObjId = await getLibObjId();
    const libId    = libObjId.replace('lib-', '');
    const { text } = await client.browse(`tracks-${libId}`);
    const m = decodeResult(text).match(/<res[^>]*>(http:[^<]+)<\/res>/);
    mediaUrl = m[1].replace(/&amp;/g, '&');
  });

  test('HEAD with TimeSeekRange returns 200 + TimeSeekRange header', async () => {
    const r = await fetch(mediaUrl, { method: 'HEAD', headers: { 'TimeSeekRange.dlna.org': 'npt=0.5-' } });
    assert.equal(r.status, 200);
    const ts = r.headers.get('timeseekrange.dlna.org');
    assert.ok(ts && /npt=\d+:\d+:\d+\.\d+/.test(ts), `expected npt range, got ${ts}`);
  });

  test('GET with TimeSeekRange streams audio/mpeg bytes', async () => {
    const r = await fetch(mediaUrl, { headers: { 'TimeSeekRange.dlna.org': 'npt=0.5-' } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /audio\/mpeg/);
    const buf = new Uint8Array(await r.arrayBuffer());
    assert.ok(buf.length > 100, `expected some body bytes, got ${buf.length}`);
  });

  test('plain HEAD (no TimeSeekRange) still works', async () => {
    const r = await fetch(mediaUrl, { method: 'HEAD' });
    assert.equal(r.status, 200);
  });

  test('non-GET/HEAD method with TimeSeekRange returns 405', async () => {
    const r = await fetch(mediaUrl, { method: 'POST', headers: { 'TimeSeekRange.dlna.org': 'npt=0.5-' } });
    assert.equal(r.status, 405);
  });

  test('malformed NPT returns 400', async () => {
    const r = await fetch(mediaUrl, { method: 'HEAD', headers: { 'TimeSeekRange.dlna.org': 'npt=abc-' } });
    assert.equal(r.status, 400);
  });
});

// ── 10. Samsung BASICVIEW (X_GetFeatureList) ────────────────────────────────

describe('Samsung BASICVIEW', () => {
  test('X_GetFeatureList advertises container "A"', async () => {
    const { status, text } = await client.soap('/dlna/control/content-directory', CDS, 'X_GetFeatureList');
    assert.equal(status, 200);
    assert.match(text, /samsung\.com_BASICVIEW/);
    assert.ok(
      /container id=&quot;A&quot;/.test(text) || /container id="A"/.test(text),
      'container id="A" should be advertised',
    );
  });

  test('browsing "A" returns libraries', async () => {
    const { status, text } = await client.browse('A');
    assert.equal(status, 200);
    assert.match(decodeResult(text), /lib-/);
  });

  test('BrowseMetadata on "A" titles it "Music"', async () => {
    const { text } = await client.browse('A', 'BrowseMetadata');
    assert.match(decodeResult(text), /<dc:title>Music<\/dc:title>/);
  });
});

// ── 11. GENA subscribe / notify / unsubscribe ───────────────────────────────

describe('GENA events', () => {
  test('SUBSCRIBE / initial NOTIFY / renewal / UNSUBSCRIBE', async () => {
    const received = [];
    const listener = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        received.push({ method: req.method, sid: req.headers.sid, seq: req.headers.seq, body });
        res.statusCode = 200;
        res.end();
      });
    });
    await new Promise(r => listener.listen(0, '127.0.0.1', r));
    const cbPort = listener.address().port;

    try {
      const sub = await fetch(`${server.baseUrl}/dlna/event/content-directory`, {
        method: 'SUBSCRIBE',
        headers: {
          'CALLBACK': `<http://127.0.0.1:${cbPort}/cb>`,
          'NT': 'upnp:event',
          'TIMEOUT': 'Second-60',
        },
      });
      assert.equal(sub.status, 200);
      const sid = sub.headers.get('sid');
      assert.ok(sid?.startsWith('uuid:'), `invalid SID: ${sid}`);
      assert.equal(sub.headers.get('timeout'), 'Second-60');

      // Wait for initial NOTIFY
      for (let i = 0; i < 20 && received.length === 0; i++) { await sleep(50); }
      assert.ok(received.length >= 1, 'expected initial NOTIFY');
      assert.equal(received[0].method, 'NOTIFY');
      assert.equal(received[0].sid, sid);
      assert.match(received[0].body, /SystemUpdateID/);

      // Renewal with same SID
      const renew = await fetch(`${server.baseUrl}/dlna/event/content-directory`, {
        method: 'SUBSCRIBE',
        headers: { 'SID': sid, 'TIMEOUT': 'Second-120' },
      });
      assert.equal(renew.status, 200);
      assert.equal(renew.headers.get('sid'), sid);

      // Renewal with unknown SID → 412
      const bad = await fetch(`${server.baseUrl}/dlna/event/content-directory`, {
        method: 'SUBSCRIBE',
        headers: { 'SID': 'uuid:nonexistent-xyz', 'TIMEOUT': 'Second-60' },
      });
      assert.equal(bad.status, 412);

      // Missing CALLBACK → 412
      const missing = await fetch(`${server.baseUrl}/dlna/event/content-directory`, {
        method: 'SUBSCRIBE',
        headers: { 'TIMEOUT': 'Second-60' },
      });
      assert.equal(missing.status, 412);

      // UNSUBSCRIBE
      const unsub = await fetch(`${server.baseUrl}/dlna/event/content-directory`, {
        method: 'UNSUBSCRIBE',
        headers: { 'SID': sid },
      });
      assert.equal(unsub.status, 200);

      // Renewal after unsubscribe → 412
      const postUnsub = await fetch(`${server.baseUrl}/dlna/event/content-directory`, {
        method: 'SUBSCRIBE',
        headers: { 'SID': sid, 'TIMEOUT': 'Second-60' },
      });
      assert.equal(postUnsub.status, 412);
    } finally {
      await new Promise(r => listener.close(r));
    }
  });
});

// ── 12. Error handling ──────────────────────────────────────────────────────

describe('Error handling', () => {
  test('unknown ObjectID returns 500 UPnPError', async () => {
    const { status } = await client.browse('does-not-exist-xyz');
    assert.equal(status, 500);
  });

  test('unknown track id returns 500', async () => {
    const { status } = await client.browse('track-99999999');
    assert.equal(status, 500);
  });

  test('unknown SOAP action returns 500', async () => {
    const { status } = await client.soap('/dlna/control/content-directory', CDS, 'NonExistentAction');
    assert.equal(status, 500);
  });
});

// ── DLNA identity (name + uuid) ───────────────────────────────────────────
// Admin API is unauthenticated in this no-users harness, so we can POST the
// new endpoints directly and verify the live device.xml reflects them
// (friendlyName + UDN are rendered fresh on each fetch).

describe('DLNA identity (name + uuid)', () => {
  let originalName, originalUuid;

  before(async () => {
    const r = await client.httpGet('/api/v1/admin/dlna');
    const j = await r.json();
    originalName = j.name;
    originalUuid = j.uuid;
  });

  after(async () => {
    // Restore so other suites / reruns see the fixture defaults.
    await client.apiPost('/api/v1/admin/dlna/name', { name: originalName });
    if (originalUuid) { await client.apiPost('/api/v1/admin/dlna/uuid', { uuid: originalUuid }); }
  });

  test('GET /admin/dlna exposes name and uuid', async () => {
    const r = await client.httpGet('/api/v1/admin/dlna');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(typeof j.name, 'string');
    assert.ok(j.name.length > 0);
    assert.match(j.uuid, /^[0-9a-f-]{36}$/i, `expected a uuid, got ${j.uuid}`);
  });

  test('POST /admin/dlna/name updates the friendlyName in device.xml', async () => {
    const newName = 'Living Room mStream';
    const { status } = await client.apiPost('/api/v1/admin/dlna/name', { name: newName });
    assert.equal(status, 200);

    const xml = await (await client.httpGet('/dlna/device.xml')).text();
    assert.match(xml, new RegExp(`<friendlyName>${newName}</friendlyName>`));
  });

  test('name is trimmed and rejects empty', async () => {
    const { status } = await client.apiPost('/api/v1/admin/dlna/name', { name: '   Padded Name   ' });
    assert.equal(status, 200);
    const xml = await (await client.httpGet('/dlna/device.xml')).text();
    assert.match(xml, /<friendlyName>Padded Name<\/friendlyName>/);

    // Empty / whitespace-only is rejected (joiValidate throws → 400).
    for (const bad of [{ name: '' }, { name: '   ' }, {}]) {
      const r = await client.apiPost('/api/v1/admin/dlna/name', bad);
      assert.equal(r.status, 400, `expected rejection for ${JSON.stringify(bad)}, got ${r.status}`);
    }
  });

  test('POST /admin/dlna/uuid updates the UDN in device.xml', async () => {
    const newUuid = '12345678-1234-4123-8123-1234567890ab';
    const { status } = await client.apiPost('/api/v1/admin/dlna/uuid', { uuid: newUuid });
    assert.equal(status, 200);

    const xml = await (await client.httpGet('/dlna/device.xml')).text();
    assert.match(xml, new RegExp(`<UDN>uuid:${newUuid}</UDN>`));
  });

  test('rejects a malformed uuid', async () => {
    for (const bad of [{ uuid: 'not-a-uuid' }, { uuid: 'uuid:1234' }, { uuid: '' }, {}]) {
      const r = await client.apiPost('/api/v1/admin/dlna/uuid', bad);
      assert.equal(r.status, 400, `expected rejection for ${JSON.stringify(bad)}, got ${r.status}`);
    }
  });
});
