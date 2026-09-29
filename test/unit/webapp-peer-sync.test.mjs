/**
 * The peer-sync module's pure half (webapp/alpha/peer-sync.js, a UMD the
 * browser reads as window.PEERSYNC): the name key in parity with the
 * server's (src/db/name-key.js), paths as one string, row keys that agree
 * with the job that acts on the row, a peer's album list as an artist index,
 * the slot's markup for every row state (built on the job rows' own state
 * engine, webapp/alpha/discover-jobs.js), the facts line, and a
 * recommendation a row builds that the job route's Joi accepts.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { nameKey as serverNameKey } from '../../src/db/name-key.js';
import { normalizePeerPath } from '../../src/discovery-plugins/recommendation.js';
import { recommendationSchema } from '../../src/discovery-plugins/recommendation.js';
import { sanitizeSegment as serverSanitizeSegment } from '../../src/torrent/path-template.js';

const require = createRequire(import.meta.url);
const P = require('../../webapp/alpha/peer-sync.js');
const J = require('../../webapp/alpha/discover-jobs.js');

const t = (key, params) => (params && params.count !== undefined ? `${key}#${params.count}` : key);
const peer = { id: 3, name: "Sam's server" };
const job = (over) => ({ id: 1, plugin: 'federation-copy', state: 'done', params: null, progress: 1, statusText: null, result: null, error: null, cancelRequested: false, recommendation: { source: 'federation', peer: { id: 3, name: "Sam's server" }, filepath: 'shared/Vosto/Night Drive/01 Sodium.flac', title: 'Sodium', artist: 'Vosto', album: 'Night Drive' }, ...over });

describe('peer-sync · keys', () => {
  test('nameKey is the server\'s, byte for byte', () => {
    const samples = ['Beyoncé', '  The   Beatles ', 'R.E.M.', 'Sam’s server', '“Quoted”', 'Night — Drive', 'Ke$ha', '', null, undefined, 'ÁRVORE', '‐‑‒–—―−', '′ prime ″'];
    for (const s of samples) { assert.equal(P.nameKey(s), serverNameKey(s), JSON.stringify(s)); }
  });

  test('normalizePath is the server\'s normalizePeerPath: slashes either way, no dot segments, case kept', () => {
    for (const p of ['/shared/Vosto/', 'shared//Vosto/./Night Drive', 'shared\\Vosto\\x.flac', '', null, ' shared / Vosto ']) {
      assert.equal(P.normalizePath(p), normalizePeerPath(p), JSON.stringify(p));
    }
    assert.equal(P.normalizePath('/shared/Vosto/Night Drive/'), 'shared/Vosto/Night Drive');
    assert.notEqual(P.normalizePath('shared/vosto'), P.normalizePath('shared/Vosto'));
  });

  test('sanitizeSegment is the server\'s, byte for byte; mirrorSegments is where a folder lands by default', () => {
    for (const raw of [null, undefined, '', 'AC/DC', ' . dots . ', 'a:b*c?d<e>f|g"h', 'multi   space', 'x'.repeat(300), 42, 'new\nline', '~temp mixes', '$HOME/x', 'ok']) {
      assert.equal(P.sanitizeSegment(raw), serverSanitizeSegment(raw), `sanitize ${JSON.stringify(raw)}`);
    }
    assert.deepEqual(P.mirrorSegments('/shared/Vosto/Underpass Remixes/'), ['Vosto', 'Underpass Remixes'], 'the vpath dropped, the rest kept');
    assert.deepEqual(P.mirrorSegments('shared/Bootlegs/Wren & Wire/~temp mixes'), ['Bootlegs', 'Wren & Wire', '-temp mixes'], 'each segment as the server would write it');
    assert.deepEqual(P.mirrorSegments('shared'), [], 'a vpath root lands directly under the base');
    assert.deepEqual(P.mirrorSegments(''), []);
  });

  test('a row\'s key and the job\'s key are the same thing', () => {
    assert.equal(P.syncKey('song', 3, '/shared/Vosto/Night Drive/01 Sodium.flac'), 'song:3:shared/Vosto/Night Drive/01 Sodium.flac');
    assert.equal(P.jobKeyOf(job({})), P.syncKey('song', 3, 'shared/Vosto/Night Drive/01 Sodium.flac'));
    assert.equal(P.jobKeyOf(job({ params: { scope: 'album' } })), P.syncKey('album', 3, { album: 'night drive', albumArtist: 'VOSTO' }), 'an album by normalised credit and name');
    assert.equal(P.jobKeyOf(job({ params: { scope: 'album' }, recommendation: { peer, album: 'Various Hits', albumArtist: 'Various Artists' } })), P.syncKey('album', '3', { name: 'Various Hits', album_artist: undefined, albumArtist: 'Various Artists' }));
    assert.equal(P.jobKeyOf(job({ params: { scope: 'artist' } })), P.syncKey('artist', 3, 'Vosto'));
    assert.equal(P.jobKeyOf(job({ params: { scope: 'artist-missing' } })), P.syncKey('artist', 3, { name: 'vosto' }), 'both artist scopes act on the artist row');
    assert.equal(P.jobKeyOf(job({ params: { scope: 'folder' }, recommendation: { peer, filepath: '/shared/Vosto/' } })), P.syncKey('folder', 3, 'shared/Vosto'));
    assert.equal(P.jobKeyOf(job({ plugin: 'youtube' })), null, 'not a peer copy');
    assert.equal(P.jobKeyOf(job({ recommendation: { source: 'p2p', title: 'x' } })), null, 'no peer, no row');
    assert.equal(P.jobKeyOf(null), null);
    assert.equal(P.syncKey('galaxy', 3, 'x'), null);
  });

  test('matchJobs keeps the newest job per row', () => {
    const jobs = [job({ id: 5, state: 'queued' }), job({ id: 2, state: 'done' }), job({ id: 9, params: { scope: 'album' } }), job({ id: 7, plugin: 'youtube' })];
    const m = P.matchJobs(jobs);
    assert.equal(m.size, 2);
    assert.equal(m.get(P.syncKey('song', 3, 'shared/Vosto/Night Drive/01 Sodium.flac')).id, 5);
    assert.equal(m.get(P.syncKey('album', 3, { album: 'Night Drive', albumArtist: 'Vosto' })).id, 9);
    assert.equal(P.matchJobs(null).size, 0);
  });

  test('the live registry: visible rows with a live job make the poller hurry', () => {
    P.applyJobs([job({ id: 5, state: 'running' }), job({ id: 9, params: { scope: 'album' }, state: 'done' })]);
    P.setVisible([P.syncKey('album', 3, { album: 'Night Drive', albumArtist: 'Vosto' })]);
    assert.equal(P.hasLiveVisible(), false, 'the visible row\'s job is done');
    P.setVisible([P.syncKey('song', 3, 'shared/Vosto/Night Drive/01 Sodium.flac')]);
    assert.equal(P.hasLiveVisible(), true);
    assert.equal(P.jobFor(P.syncKey('song', 3, 'shared/Vosto/Night Drive/01 Sodium.flac')).id, 5);
    P.applyJobs([]);
    assert.equal(P.hasLiveVisible(), false);
    P.setVisible(null);
  });
});

describe('peer-sync · a peer\'s album list as an artist index', () => {
  test('grouped by album artist with counts and names; albums without a credit belong to no row', () => {
    const idx = P.artistIndex([
      { name: 'Night Drive', album_artist: 'Vosto', track_count: 3 },
      { name: 'Underpass Remixes', album_artist: 'vosto ', track_count: 8 },
      { name: 'Live at the Depot', album_artist: 'Vosto', track_count: null },
      { name: 'Low Tide Recordings', album_artist: 'Neon Harbor', track_count: 4 },
      { name: 'Untagged', album_artist: null, track_count: 2 },
      null,
    ]);
    assert.deepEqual(idx.get('vosto'), { name: 'Vosto', albums: 3, songs: 11, names: ['Night Drive', 'Underpass Remixes', 'Live at the Depot'] });
    assert.deepEqual(idx.get('neon harbor'), { name: 'Neon Harbor', albums: 1, songs: 4, names: ['Low Tide Recordings'] });
    assert.equal(idx.size, 2);
    assert.equal(P.artistIndex(undefined).size, 0);
  });

  test('what an owned answer means for the row, with and without the index', () => {
    const entry = { name: 'Vosto', albums: 3, songs: 11, names: ['Night Drive', 'Underpass Remixes', 'Live at the Depot'] };
    assert.deepEqual(P.artistOwnership(entry, { owned: true, have: 1, missing: ['Underpass Remixes', 'Live at the Depot'] }), { owned: 'part', have: 1, missing: 2, total: 3 });
    assert.deepEqual(P.artistOwnership(entry, { owned: true, have: 3, missing: [] }), { owned: 'all', have: 3, missing: 0, total: 3 });
    assert.deepEqual(P.artistOwnership(entry, { owned: false, have: 0, missing: entry.names }), { owned: 'none', have: 0, missing: 3, total: 3 });
    assert.deepEqual(P.artistOwnership(null, { owned: true, have: 0, missing: [] }), { owned: 'part', have: null, missing: null, total: null }, 'the artist is yours; the numbers wait for the list');
    assert.equal(P.artistOwnership(entry, null), null, 'nothing known yet');
    assert.equal(P.artistFacts(entry, { owned: true, have: 1, missing: ['a', 'b'] }, t), 'peers.sync.albumCount#3 · <em>peers.sync.youHave#1</em>');
    assert.equal(P.artistFacts(entry, null, t), 'peers.sync.albumCount#3 · peers.sync.songCount#11');
    assert.equal(P.artistFacts(null, { owned: true }, t), '<em>peers.sync.inCollection</em>');
    assert.equal(P.artistFacts(null, null, t), '');
  });
});

describe('peer-sync · the slot', () => {
  const clean = (html) => {
    assert.ok(!/<li[\s>]/.test(html), 'no list item inside a row');
    assert.ok(!/data-file_location/.test(html), 'never the queue\'s attribute');
    assert.ok(!/\bfilez\b/.test(html), 'never the queue\'s class');
    return html;
  };

  test('idle: one Add whose word is the kind; part: the count; all: a tick and no button', () => {
    assert.match(clean(P.slotHtml({ kind: 'artist', facts: null, row: null, t })), /class="sync-act" data-sync-act="add">.*peers\.sync\.add\.artist</);
    assert.match(clean(P.slotHtml({ kind: 'song', facts: { owned: 'none' }, row: null, t })), /peers\.sync\.add\.song</);
    assert.match(clean(P.slotHtml({ kind: 'folder', facts: null, row: null, t })), /peers\.sync\.add\.folder</);
    assert.match(clean(P.slotHtml({ kind: 'galaxy', facts: null, row: null, t })), /peers\.sync\.add\.song</, 'an unknown kind reads as a song');
    const part = clean(P.slotHtml({ kind: 'artist', facts: { owned: 'part', have: 1, missing: 2, total: 3 }, row: null, t }));
    assert.match(part, /class="sync-act sync-show" data-sync-act="add">.*peers\.sync\.addMissing#2</, 'always visible, with the count');
    assert.match(clean(P.slotHtml({ kind: 'artist', facts: { owned: 'part', have: null, missing: null }, row: null, t })), /peers\.sync\.addMissingSome</, 'no count yet: the words without one');
    const all = clean(P.slotHtml({ kind: 'artist', facts: { owned: 'all' }, row: null, t }));
    assert.match(all, /class="sync-tick">.*peers\.sync\.allYours</);
    assert.ok(!/data-sync-act/.test(all), 'nothing to press');
    assert.match(clean(P.slotHtml({ kind: 'song', facts: { owned: 'all' }, row: null, t })), /peers\.sync\.yours</);
    // The badge an album card wears instead of a slot when the whole album is here.
    const badge = clean(P.badgeHtml(t));
    assert.match(badge, /^<span class="sync-badge-tick"><svg .*<\/svg>peers\.sync\.yours<\/span>$/);
    assert.ok(!/data-sync-act/.test(badge), 'nothing to press on it');
    // The explorer bar's word for the folder being shown; the partial case keeps its count.
    assert.match(clean(P.slotHtml({ kind: 'folder', facts: null, row: null, t, label: 'Add this folder' })), /data-sync-act="add">.*Add this folder</);
    assert.match(clean(P.slotHtml({ kind: 'folder', facts: { owned: 'part', missing: 5 }, row: null, t, label: 'Add this folder' })), /peers\.sync\.addMissing#5</);
    assert.match(clean(P.slotHtml({ kind: 'folder', facts: null, row: null, t, label: '' })), /peers\.sync\.add\.folder</, 'an empty label is no label');
    // The words sit in their own span, so a phone can show the icon alone.
    assert.match(clean(P.slotHtml({ kind: 'song', facts: null, row: null, t })), /<\/svg><span class="sync-act-w">peers\.sync\.add\.song<\/span><\/a>$/);
  });

  test('a folder that landed can be opened where it landed', () => {
    const many = { scope: 'folder', folder: { path: 'shared/Vosto/Demos 2015', name: 'Demos 2015', landed: 'music/From peers/Vosto/Demos 2015' }, layout: 'mirror',
      songs: { total: 8, copied: [{ from: 'a' }], skipped: [{ from: 'c', why: 'owned' }], failed: [] }, counts: { total: 8, copied: 6, skipped: 2, failed: 0 }, bytes: 10, stopped: null, peer };
    const row = J.jobRowState(job({ result: many, params: { scope: 'folder' } }));
    assert.equal(row.landed, 'music/From peers/Vosto/Demos 2015');
    const html = clean(P.slotHtml({ kind: 'folder', facts: null, row, t }));
    assert.match(html, /discover\.job\.copiedCount#6 · discover\.job\.ownedCount#2 · music \/ From peers \/ Vosto \/ Demos 2015</, 'the row ends with where it landed');
    assert.match(html, /data-sync-act="open" data-sync-file="music\/From peers\/Vosto\/Demos 2015">peers\.sync\.open</);
    const tags = J.jobRowState(job({ result: { ...many, folder: { ...many.folder, landed: null }, layout: 'tags' }, params: { scope: 'folder' } }));
    assert.equal(tags.landed, null, 'filed by tags: nowhere single to open');
    assert.ok(!/data-sync-act="open"/.test(clean(P.slotHtml({ kind: 'folder', facts: null, row: tags, t }))));
    const stopped = J.jobRowState(job({ result: { ...many, stopped: 'quota' }, params: { scope: 'folder' } }));
    assert.equal(stopped.landed, 'music/From peers/Vosto/Demos 2015', 'what landed is kept, and can be opened');
  });

  test('a job: the row\'s state engine\'s tag, sub-line, progress and actions, escaped', () => {
    const running = J.jobRowState(job({ state: 'running', progress: 0.58, statusText: '2 of 4 songs · 7.4 MB <b>' }));
    const html = clean(P.slotHtml({ kind: 'album', facts: null, row: running, t }));
    assert.match(html, /class="sync-tag sync-tag-src">.*discover\.job\.copying</);
    assert.match(html, /<small class="sync-sub">2 of 4 songs · 7\.4 MB &lt;b&gt; · 58%<\/small>/, 'the peer\'s text escaped, the percentage appended');
    assert.match(html, /<span class="sync-progress"><i style="width:58%"><\/i><\/span>/);
    assert.match(html, /data-sync-act="cancel"/);
    const queued = clean(P.slotHtml({ kind: 'song', facts: null, row: J.jobRowState(job({ state: 'queued' })), t }));
    assert.match(queued, /discover\.job\.queued<.*discover\.job\.queuedSub<.*data-sync-act="cancel"/);
    const many = { scope: 'folder', songs: { total: 4, copied: [{ from: 'a' }, { from: 'b' }], skipped: [{ from: 'c', why: 'owned' }], failed: [] }, counts: { total: 4, copied: 2, skipped: 1, failed: 0 }, bytes: 10, stopped: null, peer: { id: 3, name: "Sam's server" } };
    const done = clean(P.slotHtml({ kind: 'folder', facts: null, row: J.jobRowState(job({ result: many, params: { scope: 'folder' } })), t }));
    assert.match(done, /sync-tag-ok">.*discover\.job\.inCollection</);
    assert.match(done, /discover\.job\.copiedCount#2 · discover\.job\.ownedCount#1/);
    const stopped = clean(P.slotHtml({ kind: 'folder', facts: null, row: J.jobRowState(job({ result: { ...many, stopped: 'quota' } })), t }));
    assert.match(stopped, /sync-tag-err">.*discover\.job\.stopped<.*discover\.job\.stoppedQuota.*data-sync-act="retry"/);
    const cancelled = clean(P.slotHtml({ kind: 'folder', facts: null, row: J.jobRowState(job({ state: 'cancelled', result: { ...many, stopped: 'cancelled' } })), t }));
    assert.match(cancelled, /sync-job-muted.*discover\.job\.cancelled<.*data-sync-act="add">peers\.sync\.addRest</);
    const copied = clean(P.slotHtml({ kind: 'song', facts: null, row: J.jobRowState(job({ result: { copied: { filepath: 'music/Vosto/Night Drive/01 Sodium.flac' } } })), t }));
    assert.match(copied, /data-sync-act="play" data-sync-file="music\/Vosto\/Night Drive\/01 Sodium\.flac"/);
    const failed = clean(P.slotHtml({ kind: 'song', facts: null, row: J.jobRowState(job({ state: 'failed', error: 'Sam\'s server is unreachable' })), t }));
    assert.match(failed, /sync-tag-err.*Sam&#39;s server is unreachable.*data-sync-act="retry"/);
  });

  test('subText joins parts the way the window does', () => {
    assert.equal(P.subText({ parts: [{ key: 'a' }, { text: 'b' }, null] }, t), 'a · b');
    assert.equal(P.subText({ key: 'k', params: { count: 2 } }, t), 'k#2');
    assert.equal(P.subText(null, t), '');
  });
});

describe('peer-sync · a file row\'s facts', () => {
  test('the tags the listing brought, a length as the player writes one, and the untagged case', () => {
    assert.equal(P.songFacts({ title: 'Sodium', artist: 'Vosto', duration: 221.4 }, t), 'Sodium · Vosto · 3:41');
    assert.equal(P.songFacts({ title: 'Sodium', artist: null, duration: 0 }, t), 'Sodium');
    assert.equal(P.songFacts({ title: null, artist: null, duration: 252 }, t), 'peers.sync.noTags · 4:12 · peers.sync.landsByName');
    assert.equal(P.songFacts({ title: '', artist: '' }, t), 'peers.sync.noTags · peers.sync.landsByName');
    assert.equal(P.songFacts(null, t), '', 'not in the peer\'s database: nothing known');
    assert.equal(P.duration(3725), '1:02:05');
    assert.equal(P.duration('59.6'), '1:00');
    assert.equal(P.duration(null), '');
  });
});

describe('peer-sync · a recommendation from a row', () => {
  test('what the job route\'s Joi accepts: bounded strings, a year only when it is one, no ISRC, the album\'s own credit', () => {
    const song = P.buildRecommendation('song', { filepath: '/shared/Vosto/01.flac', title: ' Sodium ', artist: 'Vosto', album: 'Night Drive', album_artist: 'Vosto', year: '2019', duration: '212.4', isrc: 'bad' }, peer);
    assert.deepEqual(song, { source: 'federation', peer: { id: 3, name: "Sam's server" }, filepath: 'shared/Vosto/01.flac', title: 'Sodium', artist: 'Vosto', album: 'Night Drive', albumArtist: 'Vosto', year: 2019, duration: 212.4 });
    assert.equal(recommendationSchema.validate(song).error, undefined);
    const album = P.buildRecommendation('album', { name: 'Various Hits', album_artist: 'Various Artists', year: 0 }, peer);
    assert.deepEqual(album, { source: 'federation', peer: { id: 3, name: "Sam's server" }, album: 'Various Hits', albumArtist: 'Various Artists', artist: null, year: null });
    assert.equal(recommendationSchema.validate(album).error, undefined);
    const artist = P.buildRecommendation('artist', { name: 'Wren & Wire' }, peer);
    assert.equal(artist.artist, 'Wren & Wire');
    assert.equal(recommendationSchema.validate(artist).error, undefined);
    const folder = P.buildRecommendation('folder', { directory: '/shared/Bootlegs/Wren & Wire/' }, { id: '3', name: null });
    assert.deepEqual(folder, { source: 'federation', peer: { id: '3', name: null }, filepath: 'shared/Bootlegs/Wren & Wire', title: 'Wren & Wire' });
    assert.equal(recommendationSchema.validate(folder).error, undefined);
    assert.equal(P.buildRecommendation('song', { title: 'x'.repeat(600), filepath: 'a/b' }, peer).title.length, 512);
    assert.equal(P.buildRecommendation('galaxy', {}, peer), null);
  });

  test('the scope an Add asks for: what you\'re missing when the library has part of an artist', () => {
    assert.equal(P.scopeFor('artist', { owned: 'part' }), 'artist-missing');
    assert.equal(P.scopeFor('artist', { owned: 'none' }), 'artist');
    assert.equal(P.scopeFor('artist', null), 'artist');
    assert.equal(P.scopeFor('album', { owned: 'part' }), 'album');
    assert.equal(P.scopeFor('folder', null), 'folder');
    assert.equal(P.scopeFor('song', null), 'song');
  });
});
