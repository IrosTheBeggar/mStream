/**
 * Album track ordering on the OTHER surface — DLNA.
 *
 * test/integration/album-track-order.test.mjs covers the webapp album view
 * (/api/v1/db/album-songs). The same ALBUM_TRACK_ORDER fragment
 * (src/db/track-order.js) also drives the DLNA content directory, and that
 * had no ordering coverage at all: the shared fixture library is entirely
 * `disc: 1` with no NULLs, so every existing DLNA test would pass just as
 * happily with the discs interleaved or the untagged tracks hoisted to the
 * top.
 *
 * Three albums, covering two different jobs:
 *   - "Order Half Tagged" and "Order Partly Numbered" are the cases that
 *     actually broke — SQLite sorts NULL FIRST, so a track missing its disc
 *     or track number used to be hoisted above the properly tagged ones.
 *     Both fail here against the pre-fix ordering (2 of these 3
 *     assertions do).
 *   - "Order Two Disc" is fully tagged, so the old and new orderings agree
 *     on it and it is NOT a regression guard for that fix. It is here to
 *     pin disc separation itself: a two-disc set whose track numbers restart
 *     at 1 must not interleave, which is what a future refactor dropping the
 *     disc term would do.
 *
 * Titles are deliberately anti-alphabetical, so a regression to alphabetical
 * — or to raw filepath order, since the files are named after their titles —
 * shows up as a wrong result rather than an accidental pass.
 *
 * Tags are written BARE (`disc: 1`, not `1/2`) on purpose. The combined
 * "N/total" form is the subject of test/scanner/scanner-track-disc-numbers
 * .test.mjs and depends on which rust-parser binary is on disk; this suite is
 * about ORDERING, so it uses the tag shape every scanner build reads
 * identically and stays deterministic either way.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';
import { generateLibrary, mkSpec } from '../helpers/library-gen.mjs';

const VPATH = 'ordersurf';

// [album, title, track, disc]. disc === null means the file carries no disc
// tag at all — the case that used to sort first.
const TRACKS = [
  ['Order Two Disc',      'Zulu',     1, 1],
  ['Order Two Disc',      'Yankee',   2, 1],
  ['Order Two Disc',      'Alpha',    1, 2],
  ['Order Two Disc',      'Bravo',    2, 2],

  ['Order Half Tagged',   'Zulu',     1, 1],
  ['Order Half Tagged',   'Yankee',   2, null],
  ['Order Half Tagged',   'Xray',     3, 1],
  ['Order Half Tagged',   'Whiskey',  4, null],

  ['Order Partly Numbered', 'Zulu',     1,    1],
  ['Order Partly Numbered', 'Yankee',   2,    1],
  ['Order Partly Numbered', 'Alpha',    null, 1],
  ['Order Partly Numbered', 'Bravo',    null, 1],
];

// What each album must look like, top to bottom.
const EXPECTED = {
  // Disc 2 follows disc 1 even though its track numbers restart at 1.
  // Alphabetical would be Alpha, Bravo, Yankee, Zulu; disc-blind track order
  // would interleave as Zulu, Alpha, Yankee, Bravo.
  'Order Two Disc': ['Zulu', 'Yankee', 'Alpha', 'Bravo'],
  // The untagged-disc tracks belong WITH disc 1 (COALESCE(disc_number, 1)),
  // interleaved by track number — not stacked on top as NULL-first gave.
  'Order Half Tagged': ['Zulu', 'Yankee', 'Xray', 'Whiskey'],
  // Unnumbered tracks fall to the bottom and tie-break on title, which is
  // what the DLNA query uses as its last sort key.
  'Order Partly Numbered': ['Zulu', 'Yankee', 'Alpha', 'Bravo'],
};

const USER = { username: 'order-admin', password: 'passw0rd-order' };

let server;
let tmpLib;

before(async () => {
  tmpLib = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-ordersurf-'));
  await generateLibrary({
    outputDir: tmpLib,
    cleanFirst: true,
    specs: TRACKS.map(([album, title, track, disc], i) => mkSpec({
      // Named after the title, so filename order == alphabetical title order.
      // Any fallback to filepath ordering is therefore indistinguishable from
      // "sorted alphabetically" — exactly the regression being guarded.
      filepath: `${album}/${title}.mp3`,
      title,
      artist: 'Order Artist',
      album,
      year: 2001,
      ...(track != null ? { track } : {}),
      ...(disc  != null ? { disc }  : {}),
      toneFreq: 200 + i,
    })),
  });

  server = await startServer({
    // The helper grants ['testlib'] by default; without the curated vpath the
    // user can't see it and every library-scoped query filters it away.
    users: [{ ...USER, admin: true, vpaths: ['testlib', VPATH] }],
    extraFolders: { [VPATH]: tmpLib },
    dlnaMode: 'same-port',
  });
});

after(async () => {
  if (server) { await server.stop(); }
  if (tmpLib) { await fs.rm(tmpLib, { recursive: true, force: true }).catch(() => {}); }
});

// ── DLNA ────────────────────────────────────────────────────────────────────

function soapBody(action, fields) {
  const inner = Object.entries(fields).map(([k, v]) => `<${k}>${v}</${k}>`).join('');
  return '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">'
    + `<s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">${inner}`
    + `</u:${action}></s:Body></s:Envelope>`;
}

async function browse(objectId) {
  const r = await fetch(`${server.baseUrl}/dlna/control/content-directory`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml',
      SOAPACTION: '"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"',
    },
    body: soapBody('Browse', {
      ObjectID: objectId, BrowseFlag: 'BrowseDirectChildren', Filter: '*',
      StartingIndex: 0, RequestedCount: 0, SortCriteria: '',
    }),
  });
  assert.equal(r.status, 200, `Browse ${objectId} returned ${r.status}`);
  return r.text();
}

// The DIDL payload is XML-escaped inside the SOAP envelope, so ids and titles
// come back as &lt;container id=&quot;…&quot;&gt; / &lt;dc:title&gt;…
const titlesOf = (xml) => [...xml.matchAll(/&lt;dc:title&gt;(.*?)&lt;\/dc:title&gt;/g)].map((m) => m[1]);

function containerIdFor(xml, title) {
  // Each container element carries its id before its title, so pair them up
  // by walking the elements rather than matching across the whole document.
  for (const el of xml.split('&lt;container ').slice(1)) {
    const id = (el.match(/id=&quot;([^&]*)&quot;/) || [])[1];
    const name = (el.match(/&lt;dc:title&gt;(.*?)&lt;\/dc:title&gt;/) || [])[1];
    if (name === title) { return id; }
  }
  return null;
}

describe('DLNA album track ordering', () => {
  let albumsContainerId;

  before(async () => {
    // root → "Music" → the library container for our curated vpath → Albums.
    const root = await browse('0');
    const musicId = containerIdFor(root, 'Music');
    assert.ok(musicId, 'Music container not found in the DLNA root');
    const libId = containerIdFor(await browse(musicId), VPATH);
    assert.ok(libId, `library container "${VPATH}" not found under Music`);
    albumsContainerId = containerIdFor(await browse(libId), 'Albums');
    assert.ok(albumsContainerId, 'Albums view container not found under the library');
  });

  for (const album of Object.keys(EXPECTED)) {
    test(`browsing "${album}" lists tracks in disc/track order`, async () => {
      const albums = await browse(albumsContainerId);
      const albumId = containerIdFor(albums, album);
      assert.ok(albumId, `album container "${album}" not found`);
      assert.deepEqual(titlesOf(await browse(albumId)), EXPECTED[album]);
    });
  }
});
