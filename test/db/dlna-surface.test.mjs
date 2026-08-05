/**
 * Tests for the DLNA browse/search surface fixes (audit PR-H: M6, M10, M14
 * + the per-item getBaseUrl() syscall the audit missed):
 *
 *   - getLocalIp() memoises the adapter enumeration, so getBaseUrl() stops
 *     being an O(DIDL-elements) syscall;
 *   - xmlEscape's strip-probe fast path is byte-for-byte identical to the
 *     nine-pass original, including on the pathological inputs the strip
 *     passes exist for;
 *   - library-shaped listings (view containers, filepath tree, artists,
 *     albums, genres, counts) are memoised and SystemUpdateID invalidates
 *     them;
 *   - smart-container totals are memoised on a short window, and Favorites
 *     is bounded by SMART_LIMIT like every sibling;
 *   - Search picks a bounded page when RequestedCount is 0 but still honours
 *     an explicit count, and TotalMatches stays truthful either way;
 *   - V64 indexes tracks.year.
 *
 * The browse surface is driven the way a renderer drives it — real SOAP over
 * HTTP against dlna.setup()'s own route table — so the assertions cover the
 * handlers, not just the query helpers.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { setTimeout as sleep } from 'node:timers/promises';

// Captured at import by dlna.js. Long enough that back-to-back browses in one
// test stay inside the window, short enough that "aging out" is a quick sleep.
process.env.MSTREAM_TEST_DLNA_CACHE_TTL_MS = '150';

const SMART_LIMIT = 200;      // mirrors dlna.js
const RATED_TRACKS = 260;     // > SMART_LIMIT, so the Favorites cap is observable
const TRACKS = 900;           // > DEFAULT_SEARCH_COUNT (500), so the cap is observable

let testRoot, server, base;
let config, manager, dlna, ssdp;
let libId;

function soap(action, fields) {
  const inner = Object.entries(fields).map(([k, v]) => `<${k}>${v}</${k}>`).join('');
  return '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">'
    + `<s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">${inner}`
    + `</u:${action}></s:Body></s:Envelope>`;
}

async function cds(action, fields) {
  const r = await fetch(`${base}/dlna/control/content-directory`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml',
      SOAPACTION: `"urn:schemas-upnp-org:service:ContentDirectory:1#${action}"`,
    },
    body: soap(action, fields),
  });
  return { status: r.status, text: await r.text() };
}

const browse = (ObjectID, extra = {}) => cds('Browse', {
  ObjectID, BrowseFlag: 'BrowseDirectChildren', Filter: '*',
  StartingIndex: 0, RequestedCount: 0, SortCriteria: '', ...extra,
});
const search = (ContainerID, SearchCriteria, extra = {}) => cds('Search', {
  ContainerID, SearchCriteria, Filter: '*',
  StartingIndex: 0, RequestedCount: 0, SortCriteria: '', ...extra,
});

const numberReturned = (t) => Number((t.match(/<NumberReturned>(\d+)</) || [])[1]);
const totalMatches = (t) => Number((t.match(/<TotalMatches>(\d+)</) || [])[1]);
const childCountOf = (t) => Number((t.match(/childCount=&quot;(\d+)&quot;/) || [])[1]);

before(async () => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-prh-'));
  fs.mkdirSync(path.join(testRoot, 'db'), { recursive: true });
  fs.writeFileSync(path.join(testRoot, 'config.json'), JSON.stringify({
    storage: {
      dbDirectory: path.join(testRoot, 'db'),
      albumArtDirectory: path.join(testRoot, 'art'),
      logsDirectory: path.join(testRoot, 'logs'),
      waveformCacheDirectory: path.join(testRoot, 'waveforms'),
    },
    port: 0,
    dlna: { mode: 'same-port', browse: 'dirs' },
  }, null, 2));

  config = await import('../../src/state/config.js');
  await config.setup(path.join(testRoot, 'config.json'));
  manager = await import('../../src/db/manager.js');
  manager.initDB();
  dlna = await import('../../src/api/dlna.js');
  ssdp = await import('../../src/dlna/ssdp.js');

  const d = manager.getDB();
  d.exec('BEGIN');
  d.prepare(`INSERT INTO libraries (name, root_path, type, follow_symlinks)
             VALUES ('prh', ?, 'music', 0)`).run(testRoot);
  manager.invalidateCache();
  libId = d.prepare("SELECT id FROM libraries WHERE name='prh'").get().id;
  d.prepare("INSERT INTO users (username, password, salt) VALUES ('prh-user','x','y')").run();
  const uid = d.prepare("SELECT id FROM users WHERE username='prh-user'").get().id;

  const insArtist = d.prepare('INSERT INTO artists (name) VALUES (?)');
  const insAlbum = d.prepare('INSERT INTO albums (name, artist_id) VALUES (?, ?)');
  for (let i = 0; i < 12; i++) { insArtist.run(`Artist ${i}`); }
  const artistIds = d.prepare('SELECT id FROM artists ORDER BY id').all().map((r) => r.id);
  for (let i = 0; i < 30; i++) { insAlbum.run(`Album ${i}`, artistIds[i % artistIds.length]); }
  const albumIds = d.prepare('SELECT id FROM albums ORDER BY id').all().map((r) => r.id);

  const insTrack = d.prepare(`INSERT INTO tracks
      (filepath, library_id, title, artist_id, album_id, year, audio_hash, duration, format)
      VALUES (?, ?, ?, ?, ?, ?, ?, 200, 'mp3')`);
  for (let i = 0; i < TRACKS; i++) {
    insTrack.run(`d${i % 6}/t${i}.mp3`, libId, `Track ${i}`,
      artistIds[i % artistIds.length], albumIds[i % albumIds.length],
      1990 + (i % 5), `ah-${i}`);
  }
  // Ratings for more tracks than the smart containers are allowed to show.
  const insUm = d.prepare(`INSERT INTO user_metadata (user_id, track_hash, rating, play_count, last_played)
                           VALUES (?, ?, 5, 3, 1700000000)`);
  for (let i = 0; i < RATED_TRACKS; i++) { insUm.run(uid, `ah-${i}`); }
  d.exec('COMMIT');

  const app = express();
  dlna.setup(app, { checkMode: false });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  try { if (server) { server.close(); } } catch (_e) { /* closed */ }
  try { manager.close(); } catch (_e) { /* closed */ }
  try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch (_e) { /* win locks */ }
  setImmediate(() => process.exit(0));
});

// ── migration ───────────────────────────────────────────────────────────────

describe('V64', () => {
  test('tracks.year is indexed and the By-Year queries seek', () => {
    const d = manager.getDB();
    const idx = d.prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_tracks_year'").get();
    assert.ok(idx, 'idx_tracks_year present');
    assert.match(idx.sql, /WHERE year IS NOT NULL/);
    const plan = d.prepare(
      'EXPLAIN QUERY PLAN SELECT COUNT(*) FROM tracks WHERE year = ?').all()
      .map((r) => r.detail).join(' | ');
    assert.match(plan, /idx_tracks_year/, `expected the year index in: ${plan}`);
  });
});

// ── the per-item syscall ────────────────────────────────────────────────────

describe('getLocalIp memo', () => {
  test('repeat calls are memoised and the test hook forces a re-resolve', () => {
    ssdp.invalidateLocalIpCache();
    const a = ssdp.getLocalIp();
    assert.equal(ssdp.getLocalIp(), a, 'same answer inside the window');
    ssdp.invalidateLocalIpCache();
    assert.equal(ssdp.getLocalIp(), a, 'and the same answer after a forced re-resolve');
  });

  test('an explicitly configured address bypasses adapter enumeration entirely', () => {
    const saved = config.program.address;
    try {
      config.program.address = '10.9.8.7';
      ssdp.invalidateLocalIpCache();
      assert.equal(ssdp.getLocalIp(), '10.9.8.7');
      // No cache involved: a config change is visible immediately.
      config.program.address = '10.9.8.6';
      assert.equal(ssdp.getLocalIp(), '10.9.8.6');
    } finally { config.program.address = saved; }
  });

  test('a DIDL response carries one consistent media host', async () => {
    const { text } = await browse(`tracks-${libId}`, { RequestedCount: 50 });
    const hosts = new Set([...text.matchAll(/http:\/\/([\d.]+:\d+)\/media\//g)].map((m) => m[1]));
    assert.equal(hosts.size, 1, `expected a single media host, got ${[...hosts]}`);
  });
});

// ── xmlEscape fast path ─────────────────────────────────────────────────────

describe('xmlEscape strip-probe fast path', () => {
  // The verbatim pre-PR implementation, kept as the oracle.
  const CTRL = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;                 // eslint-disable-line no-control-regex
  const HIGH = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g;
  const LOW = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
  const NON = /[￾￿]/g;
  const oldEscape = (str) => {
    if (str == null) { return ''; }
    return String(str)
      .replace(CTRL, '').replace(HIGH, '').replace(LOW, '').replace(NON, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  };

  test('matches the nine-pass original on an exhaustive hostile alphabet', () => {
    // Every character class the strip passes care about, plus a valid
    // surrogate PAIR (which must survive) and ordinary text.
    const alphabet = ['a', 'é', '&', '<', '>', '"', "'", '\t', '\n',
      '\x01', '\x0B', '\x1F', '￾', '￿',
      '\uD800', '\uDC00', '\uD83D', '\uDE00'];
    let checked = 0;
    // All strings of length 1..3 over the alphabet: 18 + 324 + 5832 = 6174.
    const walk = (prefix, depth) => {
      if (depth === 0) {
        assert.equal(dlna.xmlEscape(prefix), oldEscape(prefix),
          `divergence on ${JSON.stringify(prefix)}`);
        checked++;
        return;
      }
      for (const c of alphabet) { walk(prefix + c, depth - 1); }
    };
    for (let len = 1; len <= 3; len++) { walk('', len); }
    assert.ok(checked > 6000, `expected a broad sweep, checked ${checked}`);
  });

  test('a valid astral character survives and stays on the fast path', () => {
    assert.equal(dlna.xmlEscape('Sig\u{1F600}nal'), 'Sig\u{1F600}nal');
  });

  test('the strip classes are still stripped and the entities still escaped', () => {
    assert.equal(dlna.xmlEscape('a\x01b'), 'ab');
    assert.equal(dlna.xmlEscape('a\uD800b'), 'ab');
    assert.equal(dlna.xmlEscape('a\uDC00b'), 'ab');
    assert.equal(dlna.xmlEscape('a￾b'), 'ab');
    assert.equal(dlna.xmlEscape(`&<>"'`), '&amp;&lt;&gt;&quot;&apos;');
    assert.equal(dlna.xmlEscape(null), '');
  });

  // A LONE SURROGATE deliberately isn't part of this case: it cannot reach
  // the wire at all, because SQLite stores TEXT as UTF-8 and a half-pair has
  // no UTF-8 encoding — node:sqlite hands it back as U+FFFD. Control
  // characters and the two noncharacters do round-trip, so those are what an
  // end-to-end test can actually exercise; the surrogate passes are pinned
  // directly against the oracle above.
  test('a hostile tag never reaches the wire as invalid XML', async () => {
    const d = manager.getDB();
    d.prepare('UPDATE tracks SET title = ? WHERE filepath = ?')
      .run('Bad\x01Tag￾ & <stuff>', 'd0/t0.mp3');
    dlna.invalidateBrowseCaches();
    const { text } = await browse(`tracks-${libId}`, { RequestedCount: 900 });
    assert.match(text, /BadTag &amp;amp; &amp;lt;stuff&amp;gt;/,
      'control char and noncharacter stripped, entities double-escaped for <Result>');
    assert.doesNotMatch(text, /[\x00-\x08\x0B\x0C\x0E-\x1F]/, // eslint-disable-line no-control-regex
      'no raw control characters on the wire');
    d.prepare('UPDATE tracks SET title = ? WHERE filepath = ?').run('Track 0', 'd0/t0.mp3');
    dlna.invalidateBrowseCaches();
  });
});

// ── M10: library-shaped memos ───────────────────────────────────────────────

describe('library browse memos', () => {
  test('the six view containers are served from the memo inside the window', async () => {
    dlna.invalidateBrowseCaches();
    const first = await browse(`lib-${libId}`);
    assert.equal(numberReturned(first.text), 6);
    assert.match(first.text, /All Tracks/);

    // A direct edit that does NOT bump SystemUpdateID stays invisible while
    // the memo is warm — that is the deal the cache makes.
    const d = manager.getDB();
    d.prepare(`INSERT INTO tracks (filepath, library_id, title, audio_hash)
               VALUES ('d0/extra.mp3', ?, 'Extra', 'ah-extra')`).run(libId);
    const warm = await browse(`lib-${libId}`);
    assert.equal(warm.text, first.text, 'same rendered listing while the memo is warm');

    // ...and the TTL is the safety net that eventually reconciles it.
    await sleep(250);
    const cold = await browse(`lib-${libId}`);
    assert.notEqual(cold.text, first.text, 'TTL expiry picks the new track up');
    d.prepare("DELETE FROM tracks WHERE filepath = 'd0/extra.mp3'").run();
    dlna.invalidateBrowseCaches();
  });

  test('a SystemUpdateID bump invalidates immediately, without waiting for the TTL', async () => {
    dlna.invalidateBrowseCaches();
    const before = await browse(`lib-${libId}`);
    const d = manager.getDB();
    d.prepare(`INSERT INTO tracks (filepath, library_id, title, audio_hash)
               VALUES ('d0/bumped.mp3', ?, 'Bumped', 'ah-bumped')`).run(libId);
    dlna.bumpSystemUpdateID();
    const after = await browse(`lib-${libId}`);
    assert.notEqual(after.text, before.text, 'the bump dropped the memo');
    d.prepare("DELETE FROM tracks WHERE filepath = 'd0/bumped.mp3'").run();
    dlna.bumpSystemUpdateID();
  });

  test('the memoised filepath tree still paginates folders correctly', async () => {
    dlna.invalidateBrowseCaches();
    const p1 = await browse(`folders-${libId}`, { RequestedCount: 4 });
    const p2 = await browse(`folders-${libId}`, { RequestedCount: 4, StartingIndex: 4 });
    assert.equal(numberReturned(p1.text), 4);
    assert.equal(totalMatches(p1.text), totalMatches(p2.text));
    const ids = (t) => [...t.matchAll(/id=&quot;(dir-[^&]+)&quot;/g)].map((m) => m[1]);
    const overlap = ids(p1.text).filter((x) => ids(p2.text).includes(x));
    assert.equal(overlap.length, 0, 'pages do not repeat entries');
  });
});

// ── M14: smart containers ───────────────────────────────────────────────────

describe('smart containers', () => {
  test('Favorites is bounded by SMART_LIMIT in both the count and the listing', async () => {
    const { text } = await browse('favorites');
    assert.equal(numberReturned(text), SMART_LIMIT,
      `${RATED_TRACKS} rated tracks must still list at most ${SMART_LIMIT}`);
    assert.equal(totalMatches(text), SMART_LIMIT, 'the advertised total matches the listing');
  });

  test('Favorites BrowseMetadata advertises the same bounded childCount', async () => {
    const { text } = await browse('favorites', { BrowseFlag: 'BrowseMetadata' });
    assert.equal(childCountOf(text), SMART_LIMIT);
  });

  test('paging past the cap returns nothing rather than spilling', async () => {
    const { text } = await browse('favorites', { StartingIndex: SMART_LIMIT, RequestedCount: 50 });
    assert.equal(numberReturned(text), 0);
  });

  test('the root listing still reports every container', async () => {
    const { text } = await browse('music');
    for (const title of ['Recently Added', 'Recently Played', 'Most Played',
      'Favorites', 'Shuffle', 'By Year', 'Playlists']) {
      assert.match(text, new RegExp(title.replace(' ', '\\s')), `missing ${title}`);
    }
  });

  test('smart totals reconcile after the short window', async () => {
    dlna.invalidateBrowseCaches();
    const d = manager.getDB();
    const before = totalMatches((await browse('favorites')).text);
    assert.equal(before, SMART_LIMIT);
    // Drop below the cap so the number has somewhere to move.
    d.prepare('DELETE FROM user_metadata').run();
    await sleep(250);
    assert.equal(totalMatches((await browse('favorites')).text), 0,
      'the short window reconciles play/rating changes, which never bump SystemUpdateID');
    const uid = d.prepare("SELECT id FROM users WHERE username='prh-user'").get().id;
    const insUm = d.prepare(`INSERT INTO user_metadata (user_id, track_hash, rating, play_count, last_played)
                             VALUES (?, ?, 5, 3, 1700000000)`);
    for (let i = 0; i < RATED_TRACKS; i++) { insUm.run(uid, `ah-${i}`); }
    dlna.invalidateBrowseCaches();
  });
});

// ── M6: search bounds ───────────────────────────────────────────────────────

describe('Search response bounds', () => {
  test('RequestedCount=0 returns a bounded page but a truthful TotalMatches', async () => {
    const { text } = await search('0', '*');
    const n = numberReturned(text);
    assert.ok(n > 0 && n <= 500, `expected a bounded page, got ${n}`);
    assert.equal(totalMatches(text), TRACKS,
      'TotalMatches still advertises the full result set so clients can page');
  });

  test('an explicit RequestedCount is honoured', async () => {
    const { text } = await search('0', '*', { RequestedCount: 700 });
    assert.equal(numberReturned(text), 700);
  });

  test('paging with StartingIndex walks the whole result set', async () => {
    const seen = new Set();
    for (let start = 0; start < TRACKS; start += 500) {
      const { text } = await search('0', '*', { StartingIndex: start });
      for (const m of text.matchAll(/id=&quot;track-(\d+)&quot;/g)) { seen.add(m[1]); }
    }
    assert.equal(seen.size, TRACKS, 'every track is reachable by paging');
  });

  test('Browse is deliberately NOT capped the same way', async () => {
    // Renderers drill into a container expecting its listing and some do not
    // page; Browse keeps its historical ceiling.
    const { text } = await browse(`tracks-${libId}`);
    assert.equal(numberReturned(text), TRACKS);
  });
});
