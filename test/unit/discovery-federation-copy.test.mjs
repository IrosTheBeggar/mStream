/**
 * The pure parts behind "Add to your collection": the collection destination
 * rules (src/discovery-plugins/destination.js — shared by the federation-copy
 * and youtube plug-ins), the PEER variable they add to the torrent path template
 * engine, the registry's per-user settings contract, and the plug-in's shape.
 * No server, no disk.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Joi from 'joi';
import * as pathTemplate from '../../src/torrent/path-template.js';
import { registerPlugin, unregisterPluginForTests, listPlugins } from '../../src/discovery-plugins/registry.js';
import plugin, { copySongs, copyAlbums, planArtistAlbums } from '../../src/discovery-plugins/plugins/federation-copy.js';
import {
  NAMESPACE, KEY, DEFAULT_LAYOUT, LAYOUT_VARS, destinationSchema, uploadsAllowed, writableLibraries,
  destinationFor, validateLayout, normalizeBase, safeFileName, tagsForLayout, renderTarget,
} from '../../src/discovery-plugins/destination.js';

const LIBS = [
  { name: 'music', torrent_path_template: '{{ALBUMARTIST}}/{{ALBUM}}' },
  { name: 'other', torrent_path_template: null },
  { name: 'private', torrent_path_template: null },
];
const user = (over = {}) => ({ id: 7, vpaths: ['music', 'other'], allow_upload: 1, ...over });
const opts = { libraries: LIBS, noUpload: false };

describe('federation-copy · plug-in shape', () => {
  test('an acquire plug-in with run(), one at a time, and no settings of its own', () => {
    assert.equal(plugin.name, 'federation-copy');
    assert.deepEqual([...plugin.capabilities], ['acquire']);
    assert.deepEqual([...plugin.scopes], ['song', 'album', 'artist', 'artist-missing'], 'a song, its album, or its artist\'s albums');
    assert.equal(plugin.scope, 'user');
    assert.equal(plugin.concurrency, 1);
    assert.equal(typeof plugin.run, 'function');
    // The destination is the user's, shared by every acquire plug-in — not this one's setting.
    assert.equal(plugin.userSettings, undefined);
    assert.equal(plugin.validateSetting, undefined);
    assert.equal(plugin.describeSettings, undefined);
  });
});

describe('registry · the per-user settings contract', () => {
  const base = { title: 'x', capabilities: ['acquire'], scope: 'user', run() {} };

  test('userSettings must map valid keys to Joi schemas; the hooks must be functions', () => {
    assert.throws(() => registerPlugin({ ...base, name: 'us-bad-shape', userSettings: ['destination'] }), /userSettings must be an object/);
    assert.throws(() => registerPlugin({ ...base, name: 'us-bad-key', userSettings: { 'bad key!': { schema: Joi.string() } } }), /invalid setting key/);
    assert.throws(() => registerPlugin({ ...base, name: 'us-no-schema', userSettings: { token: {} } }), /needs a Joi schema/);
    assert.throws(() => registerPlugin({ ...base, name: 'us-bad-hook', userSettings: { token: { schema: Joi.string() } }, describeSettings: 'nope' }), /describeSettings must be a function/);
    assert.throws(() => registerPlugin({ ...base, name: 'us-bad-hook-2', userSettings: { token: { schema: Joi.string() } }, validateSetting: 42 }), /validateSetting must be a function/);
    assert.throws(() => registerPlugin({ ...base, name: 'us-bad-probe', probe: true }), /probe must be a function/);
  });

  test('a plug-in with settings lists their keys; one without lists none', () => {
    const cfg = { 'us-ok': { enabled: true }, 'us-none': { enabled: true } };
    registerPlugin({ ...base, name: 'us-ok', userSettings: { token: { schema: Joi.string(), secret: true }, opts: { schema: Joi.object() } } });
    registerPlugin({ ...base, name: 'us-none' });
    try {
      const listed = listPlugins({ config: cfg });
      assert.deepEqual(listed.find((p) => p.name === 'us-ok').settings, ['token', 'opts']);
      assert.deepEqual(listed.find((p) => p.name === 'us-none').settings, []);
    } finally {
      unregisterPluginForTests('us-ok');
      unregisterPluginForTests('us-none');
    }
  });
});

describe('collection destination · the PEER variable', () => {
  test('LAYOUT_VARS is the torrent set plus PEER, in that order', () => {
    assert.deepEqual([...LAYOUT_VARS], [...pathTemplate.SUPPORTED_VARS, 'PEER']);
    assert.equal(pathTemplate.EXTRA_VARS.PEER, 'PEER');
  });

  test('the layout accepts PEER; the torrent validator still refuses it', () => {
    assert.equal(validateLayout('{{PEER}}/{{ARTIST}}/{{ALBUM}}').valid, true);
    const torrent = pathTemplate.validateForSave('{{PEER}}/{{ARTIST}}');
    assert.equal(torrent.valid, false);
    assert.equal(torrent.error, 'unknown_variable');
    assert.match(torrent.message, /Supported: \{\{ARTIST\}\}/);
    assert.doesNotMatch(torrent.message, /Supported:.*PEER/, 'the torrent set does not offer PEER');
  });

  test('an unknown variable, an empty layout and an absolute layout are refused', () => {
    assert.equal(validateLayout('{{ARTIST}}/{{TRACK}}').error, 'unknown_variable');
    assert.match(validateLayout('{{ARTIST}}/{{TRACK}}').message, /PEER/, 'the message lists the widened set');
    assert.equal(validateLayout('').error, 'empty_template');
    assert.equal(validateLayout('/{{ARTIST}}').error, 'absolute_template');
    assert.equal(validateLayout('{{ARTIST}').error, 'unbalanced_braces');
  });

  test('resolveTemplate renders PEER from `peer` and drops it when absent', () => {
    const withPeer = pathTemplate.resolveTemplate('{{PEER}}/{{ARTIST}}', { artist: 'Nova', peer: "Sam's server" });
    assert.equal(withPeer.path, "Sam's server/Nova");
    const without = pathTemplate.resolveTemplate('{{PEER}}/{{ARTIST}}', { artist: 'Nova' });
    assert.equal(without.path, 'Nova');
    assert.deepEqual(without.missingVars, ['PEER']);
    // Sanitised like every other segment.
    assert.equal(pathTemplate.resolveTemplate('{{PEER}}', { peer: 'a/b:c' }).path, 'a-b-c');
  });
});

describe('collection destination · rules', () => {
  test('it lives in a neutral namespace the settings store accepts', () => {
    assert.equal(NAMESPACE, 'discovery:collection');
    assert.equal(KEY, 'destination');
    assert.match(NAMESPACE, /^[a-z0-9][a-z0-9:_-]{0,63}$/);
    assert.equal(destinationSchema.validate({ vpath: 'music', base: '', layout: DEFAULT_LAYOUT }).error, undefined);
    assert.equal(destinationSchema.validate({ vpath: 'music', layout: DEFAULT_LAYOUT }).value.base, '', 'base defaults to the root');
    assert.ok(destinationSchema.validate({ vpath: 'music' }).error, 'layout is required');
  });

  test('writable libraries: the user\'s vpaths, with each admin template', () => {
    assert.deepEqual(writableLibraries(user(), opts), [
      { vpath: 'music', template: '{{ALBUMARTIST}}/{{ALBUM}}' },
      { vpath: 'other', template: null },
    ]);
  });

  test('no upload rights, no library, no user → nowhere to put a file', () => {
    assert.equal(uploadsAllowed(user(), { noUpload: true }), false);
    assert.equal(uploadsAllowed(user({ allow_upload: 0 }), { noUpload: false }), false);
    assert.equal(uploadsAllowed(user(), { noUpload: false }), true);
    assert.deepEqual(writableLibraries(user(), { ...opts, noUpload: true }), []);
    assert.deepEqual(writableLibraries(user({ allow_upload: 0 }), opts), []);
    assert.deepEqual(writableLibraries(user({ allow_upload: false }), opts), []);
    assert.deepEqual(writableLibraries(user({ vpaths: [] }), opts), []);
    assert.deepEqual(writableLibraries(null, opts), []);
    assert.equal(destinationFor(user(), null, { ...opts, noUpload: true }), null);
  });

  test('the default: the first library, its admin template or {{ARTIST}}/{{ALBUM}}, at the root', () => {
    assert.deepEqual(destinationFor(user(), null, opts),
      { vpath: 'music', base: '', layout: '{{ALBUMARTIST}}/{{ALBUM}}', source: 'default' });
    assert.deepEqual(destinationFor(user({ vpaths: ['other'] }), null, opts),
      { vpath: 'other', base: '', layout: DEFAULT_LAYOUT, source: 'default' });
  });

  test('a saved destination wins while it still makes sense', () => {
    const saved = { vpath: 'other', base: 'From peers/', layout: '{{PEER}}/{{ARTIST}}/{{ALBUM}}' };
    assert.deepEqual(destinationFor(user(), saved, opts),
      { vpath: 'other', base: 'From peers', layout: '{{PEER}}/{{ARTIST}}/{{ALBUM}}', source: 'user' });
    // A library the user lost, a layout that no longer validates, a base
    // that climbs out: back to the default, never a half-applied setting.
    assert.equal(destinationFor(user(), { vpath: 'private', base: '', layout: DEFAULT_LAYOUT }, opts).source, 'default');
    assert.equal(destinationFor(user(), { vpath: 'other', base: '', layout: '{{TRACK}}' }, opts).source, 'default');
    assert.equal(destinationFor(user(), { vpath: 'other', base: '../up', layout: DEFAULT_LAYOUT }, opts).source, 'default');
    assert.equal(destinationFor(user(), 'nonsense', opts).source, 'default');
  });

  test('base folder: relative, inside the library, normalised', () => {
    assert.deepEqual(normalizeBase(''), { valid: true, base: '' });
    assert.deepEqual(normalizeBase(null), { valid: true, base: '' });
    assert.deepEqual(normalizeBase(' From peers / Sam '), { valid: true, base: 'From peers/Sam' });
    assert.deepEqual(normalizeBase('From peers\\Sam\\'), { valid: true, base: 'From peers/Sam' });
    assert.equal(normalizeBase('../x').error, 'traversal');
    assert.equal(normalizeBase('a/../b').error, 'traversal');
    assert.equal(normalizeBase('C:/music').error, 'drive_letter');
    assert.equal(normalizeBase('~/music').error, 'home_string');
  });
});

describe('collection destination · file name and target', () => {
  test('the file name is kept, minus what a path cannot carry', () => {
    assert.equal(safeFileName('shared/Nova/Remote Hit.mp3'), 'Remote Hit.mp3');
    assert.equal(safeFileName('shared/Nova/ 01. Song?.flac '), '01. Song-.flac');
    assert.equal(safeFileName('x:y|z.mp3'), 'x-y-z.mp3');
    assert.equal(safeFileName('shared/'), 'shared', 'the last non-empty segment');
    assert.equal(safeFileName(''), 'track');
    assert.equal(safeFileName('a/..'), 'track');
  });

  test('tagsForLayout: the file\'s tags first, the recommendation\'s where it has none', () => {
    assert.deepEqual(tagsForLayout({ artist: 'A', album: 'B', year: 2019, genre: ['Dub', 'Techno'], albumartist: 'VA' }, { artist: 'X', title: 'T' }),
      { artist: 'A', album: 'B', title: 'T', year: 2019, genre: 'Dub', albumartist: 'VA' });
    assert.deepEqual(tagsForLayout({}, { artist: 'X', album: 'Y', title: 'T', year: 2001 }),
      { artist: 'X', album: 'Y', title: 'T', year: 2001, genre: null, albumartist: null });
    assert.deepEqual(tagsForLayout(null), { artist: null, album: null, title: null, year: null, genre: null, albumartist: null });
  });

  test('renderTarget: base + layout per song + file name, forward slashes', () => {
    const destination = { vpath: 'music', base: 'From peers', layout: '{{PEER}}/{{ARTIST}}/{{ALBUM}} ({{YEAR}})' };
    const full = renderTarget({
      destination, peerName: "Sam's server", fileName: '03 Paper Lanterns.flac',
      tags: { artist: 'Marlowe Vale', album: 'Night Ferry', year: 2019 },
    });
    assert.equal(full.relDir, "From peers/Sam's server/Marlowe Vale/Night Ferry (2019)");
    assert.equal(full.relPath, "From peers/Sam's server/Marlowe Vale/Night Ferry (2019)/03 Paper Lanterns.flac");
    assert.deepEqual(full.missingVars, []);

    // An empty tag renders as the engine renders it and is reported.
    const noYear = renderTarget({
      destination, peerName: 'Sam', fileName: 'x.mp3', tags: { artist: 'A', album: 'B', year: null },
    });
    assert.equal(noYear.relPath, 'From peers/Sam/A/B ()/x.mp3');
    assert.deepEqual(noYear.missingVars, ['YEAR']);

    // No peer (a download from a network row): PEER drops out of the path.
    const kept = renderTarget({ destination, peerName: null, fileName: 'x.mp3', tags: { artist: 'A', album: 'B', year: 2020 } });
    assert.equal(kept.relPath, 'From peers/A/B (2020)/x.mp3');
    assert.deepEqual(kept.missingVars, ['PEER']);

    // No base, every variable empty: the file lands at the library root.
    const bare = renderTarget({ destination: { vpath: 'music', base: '', layout: DEFAULT_LAYOUT }, peerName: 'Sam', fileName: 'x.mp3', tags: {} });
    assert.equal(bare.relDir, '');
    assert.equal(bare.relPath, 'x.mp3');
    assert.deepEqual(bare.missingVars, ['ARTIST', 'ALBUM']);
  });

  test('ALBUMARTIST keeps a compilation together and falls back to ARTIST', () => {
    const destination = { vpath: 'music', base: '', layout: '{{ALBUMARTIST}}/{{ALBUM}}' };
    const comp = renderTarget({ destination, peerName: 'Sam', fileName: 'x.mp3', tags: { artist: 'Ondine', album: 'Low Tide Sessions', albumartist: 'Various Artists' } });
    assert.equal(comp.relDir, 'Various Artists/Low Tide Sessions');
    const plain = renderTarget({ destination, peerName: 'Sam', fileName: 'x.mp3', tags: { artist: 'Ondine', album: 'Glass Hours' } });
    assert.equal(plain.relDir, 'Ondine/Glass Hours');
  });
});

describe('federation-copy · the album loop (copySongs with a scripted copyOne)', () => {
  const song = (n) => ({ filepath: `shared/${n}.mp3`, title: n, artist: 'Nova', album: 'Night Ferry' });
  const copied = (n, bytes, missingVars = []) => ({ copied: { vpath: 'collection', filepath: `collection/Nova/Night Ferry/${n}.mp3`, bytes, title: n }, missingVars });

  test('every song accounted for: copied with its bytes, skipped with why and where, a failure of its own does not stop the rest', async () => {
    const answers = { a: copied('a', 1024 * 1024, ['YEAR']), b: { skipped: 'owned', existing: { filepath: 'collection/x/b.mp3', by: 'hash' } }, c: { skipped: 'exists', filepath: 'collection/Nova/Night Ferry/c.mp3' }, d: new Error('the peer no longer has this file'), e: copied('e', 2 * 1024 * 1024, ['YEAR', 'GENRE']) };
    const lines = [];
    const out = await copySongs(['a', 'b', 'c', 'd', 'e'].map(song), {
      copyOne: async (s, { progress }) => { progress(0.5, 'half'); const r = answers[s.title]; if (r instanceof Error) { throw r; } return r; },
      progress: (f, text) => lines.push([Math.round(f * 100), text]),
    });
    assert.equal(out.songs.total, 5);
    assert.deepEqual(out.songs.copied.map((c) => [c.from, c.filepath, c.bytes]), [['shared/a.mp3', 'collection/Nova/Night Ferry/a.mp3', 1048576], ['shared/e.mp3', 'collection/Nova/Night Ferry/e.mp3', 2097152]]);
    assert.deepEqual(out.songs.skipped, [{ from: 'shared/b.mp3', why: 'owned', at: 'collection/x/b.mp3' }, { from: 'shared/c.mp3', why: 'exists', at: 'collection/Nova/Night Ferry/c.mp3' }]);
    assert.deepEqual(out.songs.failed, [{ from: 'shared/d.mp3', error: 'the peer no longer has this file' }]);
    assert.equal(out.bytes, 3 * 1024 * 1024);
    assert.equal(out.stopped, null);
    assert.deepEqual(out.missingVars, ['YEAR', 'GENRE']);
    assert.deepEqual(lines[0], [0, '0 of 5 songs · 0.0 MB']);
    assert.deepEqual(lines[1], [10, '0 of 5 songs · 0.0 MB · half'], 'a song\'s own progress maps into the album\'s');
    assert.deepEqual(lines[lines.length - 1], [99, '5 of 5 songs · 3.0 MB']);
    assert.ok(lines.every(([f]) => f <= 99));
  });

  test('a cancel between songs, or one answered mid-song, stops the loop and keeps what finished', async () => {
    let calls = 0;
    const between = await copySongs(['a', 'b', 'c'].map(song), {
      copyOne: async () => { calls += 1; return copied('a', 10); },
      isCancelled: () => calls >= 1,
    });
    assert.equal(calls, 1);
    assert.equal(between.songs.copied.length, 1);
    assert.equal(between.stopped, 'cancelled');
    const mid = await copySongs(['a', 'b', 'c'].map(song), { copyOne: async (s) => (s.title === 'a' ? copied('a', 10) : null) });
    assert.deepEqual([mid.songs.copied.length, mid.songs.failed.length, mid.stopped], [1, 0, 'cancelled']);
  });

  test('the peer\'s transfer limit or the peer going away ends the album; the rest are not tried', async () => {
    let tried = 0;
    const limit = await copySongs(['a', 'b', 'c'].map(song), {
      copyOne: async (s) => { tried += 1; if (s.title === 'b') { throw Object.assign(new Error('copier has reached its transfer limit'), { peerLimit: true }); } return copied(s.title, 10); },
    });
    assert.equal(tried, 2);
    assert.equal(limit.stopped, 'quota');
    assert.deepEqual(limit.songs.failed, [{ from: 'shared/b.mp3', error: 'copier has reached its transfer limit' }]);
    assert.equal(limit.songs.copied.length, 1);
    const down = await copySongs(['a', 'b'].map(song), { copyOne: async () => { throw Object.assign(new Error('copier is unreachable (dial)'), { peerDown: true }); } });
    assert.deepEqual([down.stopped, down.songs.failed.length, down.songs.copied.length], ['peer', 1, 0]);
    const refused = await copySongs(['a', 'b'].map(song), { copyOne: async () => { throw Object.assign(new Error('copier does not allow copies with this server\'s key'), { peerDown: true, copiesOff: true }); } });
    assert.deepEqual([refused.stopped, refused.songs.failed.length], ['refused', 1], 'the peer refusing copies is its own stop');
    assert.deepEqual(await copySongs([], { copyOne: async () => copied('x', 1) }), { songs: { total: 0, copied: [], skipped: [], failed: [] }, bytes: 0, stopped: null, missingVars: [] });
  });
});

describe('federation-copy · the artist\'s albums (planArtistAlbums) and the album loop (copyAlbums)', () => {
  const album = (name, over = {}) => ({ name, year: 2019, album_artist: 'Nova', artists: ['Nova'], compilation: false, track_count: 4, ...over });

  test('the artist\'s own albums are copied; appearances are listed, never pulled; the singles bucket is no album', () => {
    const listing = { albums: [
      album('Night Ferry'),
      album('Second Wind', { year: 2021, album_artist: 'nova' }),
      album('Various Hits', { album_artist: 'Various Artists', artists: ['Various Artists'], compilation: true, year: 2020 }),
      album('Split EP', { album_artist: 'Nova & Vosto', artists: ['Nova', 'Vosto'] }),
      album('Hits Comp', { album_artist: 'Various Artists', artists: ['Nova', 'Vosto'], compilation: true }),
      album(null, { track_count: null }),
      album('', {}),
    ] };
    const { plan, skipped } = planArtistAlbums(listing, 'Nova');
    assert.deepEqual(plan.map((a) => [a.name, a.year, a.trackCount]), [['Night Ferry', 2019, 4], ['Second Wind', 2021, 4], ['Split EP', 2019, 4]], 'the primary album artist by normalised name, and a credit outside a compilation');
    assert.deepEqual(skipped.map((a) => [a.name, a.why]), [['Various Hits', 'appearance'], ['Hits Comp', 'appearance']]);
    assert.deepEqual(planArtistAlbums({ albums: [] }, 'Nova'), { plan: [], skipped: [] });
    assert.deepEqual(planArtistAlbums(null, 'Nova'), { plan: [], skipped: [] });
  });

  test('what you\'re missing: the albums the library has by the artist are left out', () => {
    const listing = { albums: [album('Night Ferry'), album('Second Wind', { year: 2021 }), album('Various Hits', { album_artist: 'Various Artists', artists: ['Various Artists'], compilation: true })] };
    const localKeys = new Set(['night ferry']);
    const { plan, skipped } = planArtistAlbums(listing, 'Nova', { localKeys, onlyMissing: true });
    assert.deepEqual(plan.map((a) => a.name), ['Second Wind']);
    assert.deepEqual(skipped.map((a) => [a.name, a.why]), [['Night Ferry', 'owned'], ['Various Hits', 'appearance']]);
    assert.deepEqual(planArtistAlbums(listing, 'Nova', { localKeys }).plan.map((a) => a.name), ['Night Ferry', 'Second Wind'], 'without onlyMissing the owned album is still copied (its songs skip one by one)');
  });

  test('copyAlbums: every album\'s songs gathered with the album\'s name, bytes and missing variables summed, progress per album', async () => {
    const answers = {
      'Night Ferry': { songs: { total: 2, copied: [{ from: 'a', bytes: 10 }], skipped: [{ from: 'b', why: 'owned', at: 'x' }], failed: [] }, bytes: 10, stopped: null, missingVars: ['YEAR'] },
      'Second Wind': { songs: { total: 1, copied: [{ from: 'c', bytes: 5 }], skipped: [], failed: [] }, bytes: 5, stopped: null, missingVars: ['GENRE', 'YEAR'] },
    };
    const lines = [];
    const out = await copyAlbums([{ name: 'Night Ferry', year: 2019 }, { name: 'Second Wind', year: 2021 }], {
      copyAlbum: async (al, { progress }) => { progress(0.5, '1 of 2 songs · 0.0 MB'); return answers[al.name]; },
      progress: (f, text) => lines.push([Math.round(f * 100), text]),
    });
    assert.deepEqual(out.albums.map((a) => [a.name, a.year, a.songs.total, a.bytes, a.stopped]), [['Night Ferry', 2019, 2, 10, null], ['Second Wind', 2021, 1, 5, null]]);
    assert.equal(out.songs.total, 3);
    assert.deepEqual(out.songs.copied, [{ album: 'Night Ferry', from: 'a', bytes: 10 }, { album: 'Second Wind', from: 'c', bytes: 5 }]);
    assert.deepEqual(out.songs.skipped, [{ album: 'Night Ferry', from: 'b', why: 'owned', at: 'x' }]);
    assert.deepEqual([out.bytes, out.stopped, out.missingVars], [15, null, ['YEAR', 'GENRE']]);
    assert.deepEqual(lines[0], [0, 'album 1 of 2 · Night Ferry']);
    assert.deepEqual(lines[1], [25, 'album 1 of 2 · Night Ferry · 1 of 2 songs · 0.0 MB']);
    assert.deepEqual(lines[lines.length - 1], [99, '2 of 2 albums · 2 songs copied · 0.0 MB']);
  });

  test('copyAlbums: an album that stopped stops the run; a listing that failed marks the album and goes on unless the peer is the problem; a cancel between albums', async () => {
    const one = (stopped) => ({ songs: { total: 1, copied: [], skipped: [], failed: [] }, bytes: 0, stopped, missingVars: [] });
    let tried = 0;
    const quota = await copyAlbums([{ name: 'A' }, { name: 'B' }, { name: 'C' }], { copyAlbum: async (al) => { tried += 1; return one(al.name === 'B' ? 'quota' : null); } });
    assert.deepEqual([tried, quota.stopped, quota.albums.map((a) => a.name)], [2, 'quota', ['A', 'B']]);
    const listing = await copyAlbums([{ name: 'A' }, { name: 'B' }], { copyAlbum: async (al) => { if (al.name === 'A') { throw new Error('the peer answered http 500'); } return one(null); } });
    assert.deepEqual([listing.stopped, listing.albums.map((a) => [a.name, a.error || null, a.songs.total])], [null, [['A', 'the peer answered http 500', 0], ['B', null, 1]]]);
    const down = await copyAlbums([{ name: 'A' }, { name: 'B' }], { copyAlbum: async () => { throw Object.assign(new Error('copier is unreachable (dial)'), { peerDown: true }); } });
    assert.deepEqual([down.stopped, down.albums.length], ['peer', 1]);
    let calls = 0;
    const cancelled = await copyAlbums([{ name: 'A' }, { name: 'B' }], { copyAlbum: async () => { calls += 1; return one(null); }, isCancelled: () => calls >= 1 });
    assert.deepEqual([cancelled.stopped, calls], ['cancelled', 1]);
    assert.deepEqual(await copyAlbums([], { copyAlbum: async () => one(null) }), { albums: [], songs: { total: 0, copied: [], skipped: [], failed: [] }, bytes: 0, stopped: null, missingVars: [] });
  });
});
