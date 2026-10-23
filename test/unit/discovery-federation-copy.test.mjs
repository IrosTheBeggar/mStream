/**
 * The pure parts behind "Add to your collection": the collection destination
 * rules (src/discovery-plugins/destination.js — shared by the federation-copy
 * and youtube plug-ins), the PEER and SERVERFOLDER variables they add to the
 * torrent path template engine, the registry's per-user settings contract,
 * and the plug-in's shape.
 * No server, no disk.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Joi from 'joi';
import * as pathTemplate from '../../src/torrent/path-template.js';
import { registerPlugin, unregisterPluginForTests, listPlugins } from '../../src/discovery-plugins/registry.js';
import plugin, {
  copySongs, copyAlbums, planArtistAlbums, copyBody, MAX_COPY_BYTES, fetchMedia, planFolder, landingFor, accountFor, RESULT_LIST_CAP,
  albumListing, serverFolderOf,
} from '../../src/discovery-plugins/plugins/federation-copy.js';
import {
  NAMESPACE, KEY, DEFAULT_LAYOUT, LAYOUT_VARS, destinationSchema, uploadsAllowed, writableLibraries,
  destinationFor, validateLayout, normalizeBase, safeFileName, tagsForLayout, renderTarget, isSupportedAudioFile,
  sameDestination, destinationForJob,
} from '../../src/discovery-plugins/destination.js';

const LIBS = [
  { name: 'music', torrent_path_template: '{{ALBUMARTIST}}/{{ALBUM}}' },
  { name: 'other', torrent_path_template: null },
  { name: 'private', torrent_path_template: null },
];
const user = (over = {}) => ({ id: 7, vpaths: ['music', 'other'], allow_upload: 1, ...over });
const opts = { libraries: LIBS, noUpload: false };

describe('federation-copy · a tag value is a name, not a shell string', () => {
  test('a "~" or a "$HOME" in a tag folds to a dash, so the layout renders a usable path instead of failing after the transfer', () => {
    assert.equal(pathTemplate.sanitizeSegment('~home'), '-home');
    assert.equal(pathTemplate.sanitizeSegment('Nothing ~ Everything'), 'Nothing - Everything');
    assert.equal(pathTemplate.sanitizeSegment('$HOME sweet ${HOME}'), '- sweet -');
    assert.equal(pathTemplate.sanitizeSegment('Ke$ha'), 'Ke$ha', 'a dollar that is a name stays');
    const destination = { vpath: 'music', base: '', layout: '{{ARTIST}}/{{ALBUM}}' };
    const t = renderTarget({ destination, tags: { artist: 'Nova', album: 'Nothing ~ Everything' }, peerName: null, fileName: '01 Song.mp3' });
    assert.equal(t.relPath, 'Nova/Nothing - Everything/01 Song.mp3');
    assert.equal(pathTemplate.validateResolvedPath(t.relDir).valid, true);
    // A template with a literal tilde is still the operator's typo.
    assert.equal(validateLayout('~/{{ARTIST}}').valid, false);
  });
});

describe('federation-copy · only audio goes into a library', () => {
  const supported = { mp3: true, flac: true, m4a: true, html: false };
  test('a peer-named file is taken only when its extension is one the server plays', () => {
    assert.equal(isSupportedAudioFile('Nova/Night Ferry/01 Remote Hit.mp3', supported), true);
    assert.equal(isSupportedAudioFile('01 Remote Hit.FLAC', supported), true, 'case does not matter');
    assert.equal(isSupportedAudioFile('liner-notes.html', supported), false, 'a page is not a song');
    assert.equal(isSupportedAudioFile('folder.jpg', supported), false);
    assert.equal(isSupportedAudioFile('album.m3u', supported), false);
    assert.equal(isSupportedAudioFile('notes.mp3.html', supported), false, 'the last extension counts');
    assert.equal(isSupportedAudioFile('no-extension', supported), false);
    assert.equal(isSupportedAudioFile('', supported), false);
    assert.equal(isSupportedAudioFile('x.html', {}), false, 'nothing listed, nothing taken');
  });
});

describe('federation-copy · the body a peer sends', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-copybody-'));
  const ctx = { isCancelled: () => false, progress: () => {} };
  const body = (chunks, { stallAfter = Infinity } = {}) => ({
    body: {
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < chunks.length; i++) {
          if (i >= stallAfter) { await new Promise(() => {}); }   // never yields again
          yield chunks[i];
        }
      },
    },
  });
  const chunk = (n) => Buffer.alloc(n, 7);

  test('a declared length is the cap for that file, an undeclared body gets the ceiling; within them the bytes land', async () => {
    const out = path.join(tmp, 'a.part');
    assert.equal(await copyBody(body([chunk(100), chunk(100)]), out, ctx, 200), 200);
    assert.equal(fs.statSync(out).size, 200);
    assert.equal(await copyBody(body([chunk(100), chunk(100), chunk(50)]), out, ctx, null, { maxBytes: 250 }), 250, 'undeclared: the ceiling');
    assert.ok(MAX_COPY_BYTES >= 1024 * 1024 * 1024, 'the real ceiling is gigabytes, not a lossless album');
  });

  test('a body that goes past its cap ends the copy, with the reason', async () => {
    const out = path.join(tmp, 'b.part');
    await assert.rejects(copyBody(body([chunk(100), chunk(100), chunk(1)]), out, ctx, 200), /more than the 0\.0 MB it declared/);
    await assert.rejects(copyBody(body([chunk(100), chunk(100), chunk(100)]), out, ctx, null, { maxBytes: 250 }), /larger than the 0\.0 MB a copy may be/);
    await assert.rejects(copyBody(body([chunk(100), chunk(100), chunk(100)]), out, ctx, 5000, { maxBytes: 250 }),
      /larger than the .* a copy may be/, 'a declared length above the ceiling is held to the ceiling');
  });

  test('a peer that goes quiet mid-body ends the copy after the idle time, so a cancel is never stuck behind it', async () => {
    const out = path.join(tmp, 'c.part');
    const t0 = Date.now();
    await assert.rejects(copyBody(body([chunk(10), chunk(10), chunk(10)], { stallAfter: 2 }), out, ctx, null, { idleMs: 80 }),
      (err) => err.stalled === true && /no data for/.test(err.message));
    assert.ok(Date.now() - t0 < 5000, 'ended by the idle timer, not by anything slower');
    assert.equal(fs.statSync(out).size, 20, 'what arrived before the stall was written');
  });

  test('a cancel between chunks stops it', async () => {
    const out = path.join(tmp, 'd.part');
    let asked = 0;
    const cancelling = { isCancelled: () => (++asked > 1), progress: () => {} };
    await assert.rejects(copyBody(body([chunk(10), chunk(10), chunk(10)]), out, cancelling, null), (err) => err.cancelled === true);
  });
});

describe('federation-copy · the peer\'s two 429s', () => {
  const peer = { id: 1, name: 'Sam\'s server' };
  const ctx = (cancelled = () => false) => ({ isCancelled: cancelled, progress: () => {} });
  const answer = (status, { retryAfter = null, error = null } = {}) => ({
    status, ok: status < 300, body: status < 300 ? {} : null,
    headers: { get: (h) => (h === 'retry-after' ? retryAfter : null) },
    json: () => Promise.resolve(error ? { error } : {}),
  });
  const env = (answers) => {
    let i = 0;
    return { peer, fedClient: {}, fedFetchWithDeadline: () => Promise.resolve(answers[Math.min(i++, answers.length - 1)]), asked: () => i };
  };

  test('the stream cap (a short Retry-After) is waited out and the song asked for again', async () => {
    const e = env([answer(429, { retryAfter: '1', error: 'Too many concurrent streams' }), answer(200)]);
    const t0 = Date.now();
    const res = await fetchMedia(e, ctx(), '/media/x.mp3', null);
    assert.equal(res.status, 200);
    assert.equal(e.asked(), 2);
    assert.ok(Date.now() - t0 >= 900, 'waited the Retry-After');
  });

  test('the daily quota, or a wait too long to sit through, is the transfer limit: peerLimit, no retry', async () => {
    const quota = env([answer(429, { retryAfter: '43000', error: 'Daily transfer quota exceeded' })]);
    await assert.rejects(fetchMedia(quota, ctx(), '/media/x.mp3', null), (err) => err.peerLimit === true && /transfer limit/.test(err.message));
    assert.equal(quota.asked(), 1);
    const long = env([answer(429, { retryAfter: '600', error: 'Too many concurrent streams' })]);
    await assert.rejects(fetchMedia(long, ctx(), '/media/x.mp3', null), (err) => err.peerLimit === true);
    const bare = env([answer(429)]);
    await assert.rejects(fetchMedia(bare, ctx(), '/media/x.mp3', null), (err) => err.peerLimit === true, 'a 429 with no Retry-After is not waited on');
  });

  test('a peer that stays at its cap: three retries, then busy — and a cancel during the wait answers null', async () => {
    const busy = env([answer(429, { retryAfter: '1', error: 'Too many concurrent streams' })]);
    await assert.rejects(fetchMedia(busy, ctx(), '/media/x.mp3', null), (err) => err.peerBusy === true && !err.peerLimit && /too many streams/.test(err.message));
    assert.equal(busy.asked(), 4, 'the first ask and three retries');
    let polls = 0;
    const cancelling = env([answer(429, { retryAfter: '5', error: 'Too many concurrent streams' })]);
    assert.equal(await fetchMedia(cancelling, ctx(() => (++polls > 1)), '/media/x.mp3', null), null);
    assert.equal(cancelling.asked(), 1);
  });

  test('busy ends an album and an artist copy with its own reason, like the quota does', async () => {
    const song = (n) => ({ filepath: `Nova/Night Ferry/${n}.mp3`, title: n, artist: 'Nova', album: 'Night Ferry' });
    const out = await copySongs([song('a'), song('b'), song('c')], {
      copyOne: (s) => (s.title === 'b' ? Promise.reject(Object.assign(new Error('busy'), { peerBusy: true })) : Promise.resolve({ copied: { bytes: 1 } })),
    });
    assert.equal(out.stopped, 'busy');
    assert.deepEqual([out.songs.copied.length, out.songs.failed.length], [1, 1], 'c was never asked for');
    const albums = await copyAlbums([{ name: 'One' }, { name: 'Two' }], {
      copyAlbum: () => Promise.reject(Object.assign(new Error('busy'), { peerBusy: true })),
    });
    assert.equal(albums.stopped, 'busy');
    assert.equal(albums.albums.length, 1);
  });
});

describe('federation-copy · the folder (planFolder, landingFor, accountFor)', () => {
  const isSupported = (name) => /\.(mp3|flac)$/i.test(name);

  test('planFolder: every audio file under the folder, in path order, with where it sits relative to the folder; the rest listed with why', () => {
    const listing = [
      'shared/Vosto/Underpass Remixes/02 Night Drive.flac',
      'shared/Vosto/Underpass Remixes/01 Sodium.flac',
      'shared/Vosto/Underpass Remixes/Disc 2/03 Late Frost.mp3',
      'shared/Vosto/Underpass Remixes/notes.txt',
      'shared/Vosto/Underpass Remixes/#recycle/old.mp3',
      'shared/Vosto/Underpass Remixes/.hidden/x.mp3',
      'shared/Vosto/Underpass Remixes/.DS_Store.mp3',
      'shared/Vosto/Night Drive/01 Sodium.flac',
      'shared/Vosto/Underpass Remixes/../Night Drive/02.flac',
      'shared/Vosto/Underpass Remixes/01 Sodium.flac',
      42,
    ];
    const { songs, skipped } = planFolder(listing, '/shared/Vosto/Underpass Remixes/', { isSupported });
    assert.deepEqual(songs, [
      { filepath: 'shared/Vosto/Underpass Remixes/01 Sodium.flac', relDir: '' },
      { filepath: 'shared/Vosto/Underpass Remixes/02 Night Drive.flac', relDir: '' },
      { filepath: 'shared/Vosto/Underpass Remixes/Disc 2/03 Late Frost.mp3', relDir: 'Disc 2' },
    ], 'sorted, one entry per path, the folder above dropped from relDir');
    assert.deepEqual(skipped, [
      { from: 'shared/Vosto/Underpass Remixes/notes.txt', why: 'unsupported' },
      { from: 'shared/Vosto/Underpass Remixes/#recycle/old.mp3', why: 'ignored' },
      { from: 'shared/Vosto/Underpass Remixes/.hidden/x.mp3', why: 'ignored' },
      { from: 'shared/Vosto/Underpass Remixes/.DS_Store.mp3', why: 'ignored' },
      { from: 'shared/Vosto/Night Drive/01 Sodium.flac', why: 'outside' },
      { from: 'shared/Vosto/Underpass Remixes/../Night Drive/02.flac', why: 'outside' },
    ], 'the peer\'s listing is its word: a stray or climbing entry is left out, so are the scanner\'s ignored names');
  });

  test('planFolder: a peer\'s folder names are made safe for a path here; a library root pressed keeps every path; nothing is nothing', () => {
    const { songs } = planFolder(['lib/Live: 2015/a.mp3', 'lib/b.mp3'], 'lib', { isSupported });
    assert.deepEqual(songs, [{ filepath: 'lib/b.mp3', relDir: '' }, { filepath: 'lib/Live: 2015/a.mp3', relDir: 'Live- 2015' }]);
    assert.deepEqual(planFolder([], 'lib', { isSupported }), { songs: [], skipped: [] });
    assert.deepEqual(planFolder(null, 'lib', { isSupported }), { songs: [], skipped: [] });
  });

  test('landingFor: the folder as it is on the peer under the base by default; a chosen library and folder; or by tags', () => {
    const destination = { vpath: 'music', base: 'From peers', layout: '{{ARTIST}}/{{ALBUM}}' };
    const writable = [{ vpath: 'music' }, { vpath: 'other' }];
    assert.deepEqual(landingFor({ folder: 'shared/Vosto/Underpass Remixes', landing: null, destination, writable }),
      { mode: 'mirror', vpath: 'music', dir: 'From peers/Vosto/Underpass Remixes' }, 'the peer\'s library name dropped, the base kept');
    assert.deepEqual(landingFor({ folder: '/shared/', landing: undefined, destination: { ...destination, base: '' }, writable }),
      { mode: 'mirror', vpath: 'music', dir: '' }, 'a library root pressed: its subtree lands right under the base');
    assert.deepEqual(landingFor({ folder: 'shared/Live: 2015', landing: null, destination: { ...destination, base: '' }, writable }),
      { mode: 'mirror', vpath: 'music', dir: 'Live- 2015' }, 'the peer\'s names made safe');
    assert.deepEqual(landingFor({ folder: 'shared/Vosto', landing: { vpath: null, path: 'Chosen/Place' }, destination, writable }),
      { mode: 'folder', vpath: 'music', dir: 'Chosen/Place' }, 'a chosen folder in the destination\'s library');
    assert.deepEqual(landingFor({ folder: 'shared/Vosto', landing: { vpath: 'other', path: '' }, destination, writable }),
      { mode: 'folder', vpath: 'other', dir: '' }, 'another library\'s root');
    assert.throws(() => landingFor({ folder: 'shared/Vosto', landing: { vpath: 'private', path: 'x' }, destination, writable }), /may not put files into library 'private'/);
    assert.deepEqual(landingFor({ folder: 'shared/Vosto', landing: { tags: true }, destination, writable }), { mode: 'tags', vpath: 'music', dir: null });
  });

  test('accountFor: the whole numbers beside lists that stop at the cap', () => {
    const many = (n, why) => Array.from({ length: n }, (_, i) => ({ from: `f${i}`, ...(why ? { why } : {}) }));
    const small = { total: 3, copied: many(2), skipped: many(1, 'owned'), failed: [] };
    assert.deepEqual(accountFor(small), { songs: small, counts: { total: 3, copied: 2, skipped: 1, failed: 0 } });
    const big = { total: RESULT_LIST_CAP + 7, copied: many(RESULT_LIST_CAP + 7), skipped: [], failed: [] };
    const r = accountFor(big);
    assert.equal(r.songs.copied.length, RESULT_LIST_CAP);
    assert.equal(r.songs.total, RESULT_LIST_CAP + 7);
    assert.deepEqual(r.counts, { total: RESULT_LIST_CAP + 7, copied: RESULT_LIST_CAP + 7, skipped: 0, failed: 0 });
    assert.equal(r.truncated, true);
  });
});

describe('federation-copy · what an album job asks the peer for (albumListing)', () => {
  test('with the album\'s own credit: the album as that credit holds it, NOT narrowed by the track artist — a compilation comes whole', () => {
    assert.deepEqual(albumListing({ artist: 'Peer Kim', title: 'Kim Song', album: 'Mixtape Vol 1', albumArtist: 'Various Artists', year: 2020 }), {
      album: 'Mixtape Vol 1', artist: null, albumArtist: 'Various Artists', year: 2020, fallbackArtist: 'Various Artists',
    });
    // The card form (no track artist) asks the same.
    assert.deepEqual(albumListing({ album: 'Mixtape Vol 1', albumArtist: 'Various Artists' }), {
      album: 'Mixtape Vol 1', artist: null, albumArtist: 'Various Artists', year: null, fallbackArtist: 'Various Artists',
    });
  });

  test('without one: the track artist narrows it, as before', () => {
    assert.deepEqual(albumListing({ artist: 'Nova', title: 'Remote Hit', album: 'Night Ferry', albumArtist: null, year: 2019 }), {
      album: 'Night Ferry', artist: 'Nova', albumArtist: null, year: 2019, fallbackArtist: 'Nova',
    });
    assert.deepEqual(albumListing({ artist: 'Nova', album: 'Night Ferry', albumArtist: '  ' }), {
      album: 'Night Ferry', artist: 'Nova', albumArtist: null, year: null, fallbackArtist: 'Nova',
    }, 'a blank credit is none');
  });
});

describe('federation-copy · plug-in shape', () => {
  test('an acquire plug-in with run(), one at a time, and no settings of its own', () => {
    assert.equal(plugin.name, 'federation-copy');
    assert.deepEqual([...plugin.capabilities], ['acquire']);
    assert.deepEqual([...plugin.scopes], ['song', 'album', 'artist', 'artist-missing', 'folder'], 'a song, its album, its artist\'s albums, or a folder');
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
  test('LAYOUT_VARS is the torrent set plus PEER and SERVERFOLDER, in that order', () => {
    assert.deepEqual([...LAYOUT_VARS], [...pathTemplate.SUPPORTED_VARS, 'PEER', 'SERVERFOLDER']);
    assert.equal(pathTemplate.EXTRA_VARS.PEER, 'PEER');
    assert.equal(pathTemplate.EXTRA_VARS.SERVERFOLDER, 'SERVERFOLDER');
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

describe('collection destination · the SERVERFOLDER variable', () => {
  test('serverFolderOf: the folder the song sits in on the peer, the peer\'s library name dropped — several folders, one, or none at the root', () => {
    assert.equal(serverFolderOf('shared/Boukmanflow/Borrowed Tapes/01 Open Reel.mp3'), 'Boukmanflow/Borrowed Tapes');
    assert.equal(serverFolderOf('shared/Rock/Boukmanflow/Borrowed Tapes/Disc 2/07.flac'), 'Rock/Boukmanflow/Borrowed Tapes/Disc 2');
    assert.equal(serverFolderOf('shared/Singles/x.mp3'), 'Singles');
    assert.equal(serverFolderOf('shared/x.mp3'), '', 'a song at the library root has no server folder');
    assert.equal(serverFolderOf('x.mp3'), '', 'a bare file name has none either');
    assert.equal(serverFolderOf(''), '');
    assert.equal(serverFolderOf(null), '');
  });

  test('serverFolderOf: the peer\'s path is its word — each folder made safe for a path here, empty, "." and ".." segments dropped', () => {
    assert.equal(serverFolderOf('shared/Live: 2015/AC/DC?/x.mp3'), 'Live- 2015/AC/DC-', 'odd characters fold per folder, as sanitizeSegment folds a tag');
    assert.equal(serverFolderOf('shared/~/Nothing ~ Everything/x.mp3'), '-/Nothing - Everything', 'a "~" is a name, not a home');
    assert.equal(serverFolderOf('shared/../../etc/x.mp3'), 'etc', 'a climbing segment is no folder');
    assert.equal(serverFolderOf('shared/A/../B/x.mp3'), 'A/B');
    assert.equal(serverFolderOf('shared/./A/.../x.mp3'), 'A', 'a segment of dots alone is dropped');
    assert.equal(serverFolderOf('/shared//A///B/ x.mp3'), 'A/B', 'empty segments and a leading slash');
    assert.equal(serverFolderOf('shared\\A\\B\\x.mp3'), 'A/B', 'a backslashed path reads as the peer path it is');
    assert.equal(serverFolderOf('shared/  Spaced   Out  /x.mp3'), 'Spaced Out');
    for (const p of ['shared/../../etc/x.mp3', 'shared/Live: 2015/AC/DC?/x.mp3', '/shared//A///B/ x.mp3']) {
      assert.equal(pathTemplate.validateResolvedPath(serverFolderOf(p)).valid, true, p);
    }
  });

  test('serverFolderOf files a song where a folder copy\'s mirror lands it', () => {
    const destination = { vpath: 'music', base: 'Mirror', layout: '{{SERVERFOLDER}}' };
    const song = 'shared/Vosto/Underpass Remixes/Disc 2/03 Late Frost.mp3';
    const { songs } = planFolder([song], 'shared/Vosto', { isSupported: () => true });
    const mirror = landingFor({ folder: 'shared/Vosto', landing: null, destination });
    const mirrored = [mirror.dir, songs[0].relDir].filter(Boolean).join('/');
    const t = renderTarget({ destination, tags: {}, peerName: 'Sam', serverFolder: serverFolderOf(song), fileName: '03 Late Frost.mp3' });
    assert.equal(t.relDir, mirrored);
    assert.equal(t.relDir, 'Mirror/Vosto/Underpass Remixes/Disc 2');
  });

  test('sanitizeFolders: several folders, each sanitised on its own, never a climb', () => {
    assert.equal(pathTemplate.sanitizeFolders('Boukmanflow/Borrowed Tapes'), 'Boukmanflow/Borrowed Tapes');
    assert.equal(pathTemplate.sanitizeFolders('A\\B'), 'A/B');
    assert.equal(pathTemplate.sanitizeFolders('../a/./b/..'), 'a/b');
    assert.equal(pathTemplate.sanitizeFolders('a:b/c?'), 'a-b/c-');
    assert.equal(pathTemplate.sanitizeFolders('//'), '');
    assert.equal(pathTemplate.sanitizeFolders(''), '');
    assert.equal(pathTemplate.sanitizeFolders(null), '');
    assert.equal(pathTemplate.sanitizeFolders(undefined), '');
  });

  test('resolveTemplate: the value\'s folders stay folders — alone, beside others, and inside literal text', () => {
    const r = (layout, meta) => pathTemplate.resolveTemplate(layout, meta);
    assert.equal(r('{{SERVERFOLDER}}', { serverfolder: 'Boukmanflow/Borrowed Tapes' }).path, 'Boukmanflow/Borrowed Tapes');
    assert.equal(r('From friends/{{SERVERFOLDER}}', { serverfolder: 'Boukmanflow/Borrowed Tapes' }).path, 'From friends/Boukmanflow/Borrowed Tapes');
    assert.equal(r('{{PEER}}/{{SERVERFOLDER}}', { peer: 'Sam', serverfolder: 'A/B' }).path, 'Sam/A/B');
    // Inside a folder with literal text: the literal joins the value's first
    // and last folders, so a multi-folder value yields more folders.
    assert.equal(r('Copy of {{SERVERFOLDER}}', { serverfolder: 'Boukmanflow/Borrowed Tapes' }).path, 'Copy of Boukmanflow/Borrowed Tapes');
    assert.deepEqual(r('Copy of {{SERVERFOLDER}} (kept)', { serverfolder: 'A/B/C' }).path.split('/'), ['Copy of A', 'B', 'C (kept)']);
    // Each folder sanitised like any value; the separator kept between them.
    assert.equal(r('{{SERVERFOLDER}}', { serverfolder: 'Live: 2015/AC|DC' }).path, 'Live- 2015/AC-DC');
    assert.equal(r('{{SERVERFOLDER}}', { serverfolder: '../../etc' }).path, 'etc');
  });

  test('resolveTemplate: an empty SERVERFOLDER drops its folder and is reported, like any empty variable', () => {
    const root = pathTemplate.resolveTemplate('From friends/{{SERVERFOLDER}}', { serverfolder: '' });
    assert.equal(root.path, 'From friends');
    assert.deepEqual(root.missingVars, ['SERVERFOLDER']);
    assert.equal(pathTemplate.resolveTemplate('{{SERVERFOLDER}}', {}).path, '');
    assert.equal(pathTemplate.resolveTemplate('Copy of {{SERVERFOLDER}}', { serverfolder: '/./' }).path, 'Copy of');
  });

  test('the layout accepts SERVERFOLDER — alone, in literal text, beside the others; the torrent validator still refuses it', () => {
    const alone = validateLayout('{{SERVERFOLDER}}');
    assert.equal(alone.valid, true, JSON.stringify(alone));
    assert.equal(alone.sample.split('/').length, 2, 'the sample is two folders');
    assert.equal(validateLayout('Copy of {{SERVERFOLDER}}').valid, true);
    assert.equal(validateLayout('From friends/{{serverfolder}}').valid, true, 'case-insensitive like every variable');
    assert.equal(validateLayout('{{PEER}}/{{SERVERFOLDER}}/{{ALBUM}}').valid, true);
    assert.match(validateLayout('{{TRACK}}').message, /\{\{SERVERFOLDER\}\}/, 'the refusal lists it');
    const torrent = pathTemplate.validateForSave('{{SERVERFOLDER}}');
    assert.equal(torrent.valid, false);
    assert.equal(torrent.error, 'unknown_variable');
    assert.doesNotMatch(torrent.message, /Supported:.*SERVERFOLDER/, 'the torrent set does not offer it');
  });

  test('renderTarget: SERVERFOLDER under the base; a song at the peer root and a download drop it; the path is still checked', () => {
    const destination = { vpath: 'music', base: 'From friends', layout: '{{SERVERFOLDER}}' };
    const nested = renderTarget({ destination, tags: { artist: 'X' }, peerName: 'Sam', serverFolder: 'Boukmanflow/Borrowed Tapes', fileName: '01.mp3' });
    assert.equal(nested.relPath, 'From friends/Boukmanflow/Borrowed Tapes/01.mp3');
    assert.deepEqual(nested.missingVars, []);
    const root = renderTarget({ destination, tags: {}, peerName: 'Sam', serverFolder: serverFolderOf('shared/01.mp3'), fileName: '01.mp3' });
    assert.equal(root.relPath, 'From friends/01.mp3');
    assert.deepEqual(root.missingVars, ['SERVERFOLDER']);
    const download = renderTarget({ destination, tags: {}, peerName: null, fileName: 'x.mp3' });
    assert.equal(download.relPath, 'From friends/x.mp3', 'no server, no server folder');
    // A layout that is only usable with a folder: validateResolvedPath still
    // refuses what an empty value leaves (".." here), never writes it.
    const dotted = { ...destination, base: '', layout: '..{{SERVERFOLDER}}' };
    assert.equal(validateLayout(dotted.layout).valid, true, 'the sample has a folder');
    assert.throws(() => renderTarget({ destination: dotted, tags: {}, peerName: 'Sam', serverFolder: '', fileName: 'x.mp3' }), /unusable path: .*\.\. segments/);
  });

  test('renderTarget: a path past the length cap is refused, not cut — two deep sibling folders never share one cut path, as the mirror refuses them', () => {
    const deep = ['A', 'B', 'C'].map((c) => c.repeat(170)).join('/');
    const destination = { vpath: 'music', base: '', layout: '{{SERVERFOLDER}}' };
    for (const disc of ['Disc 1', 'Disc 2']) {
      const song = `shared/${deep}/${disc}/01.mp3`;
      assert.equal(serverFolderOf(song).length, 519);
      assert.throws(() => renderTarget({ destination, tags: {}, peerName: 'Sam', serverFolder: serverFolderOf(song), fileName: '01.mp3' }),
        /the layout rendered an unusable path: Resolved path exceeds 500 characters/, disc);
      const mirror = landingFor({ folder: `shared/${deep}/${disc}`, landing: null, destination });
      assert.equal(pathTemplate.validateResolvedPath(mirror.dir).error, 'path_too_long', `the mirror of ${disc} refuses the same folders`);
    }
    // At the cap it still files, whole.
    const atCap = `${'x'.repeat(200)}/${'y'.repeat(200)}/${'z'.repeat(98)}`;
    assert.equal(renderTarget({ destination, tags: {}, peerName: 'Sam', serverFolder: atCap, fileName: '01.mp3' }).relDir, atCap);
    // Not SERVERFOLDER's alone: long literal text and a long tag are refused the same way.
    const literal = { ...destination, layout: `${'L'.repeat(400)}/{{ALBUM}}` };
    assert.equal(validateLayout(literal.layout).valid, true, 'the sample fits');
    assert.throws(() => renderTarget({ destination: literal, tags: { album: 'a'.repeat(150) }, peerName: 'Sam', fileName: 'x.mp3' }), /exceeds 500 characters/);
    // The torrent pipeline keeps its cut; the whole path is there for a caller that asks.
    assert.equal(pathTemplate.resolveTemplate('{{SERVERFOLDER}}', { serverfolder: `${deep}/Disc 1` }).path.length, 500);
    assert.equal(pathTemplate.resolveTemplate('{{SERVERFOLDER}}', { serverfolder: `${deep}/Disc 1` }, { truncate: false }).path, `${deep}/Disc 1`);
  });

  test('serverFolderOf and the mirror drop the first segment as the peer wrote it, even a leading ".." — never a climb, and the same place for both', () => {
    // No peer's own listing starts by climbing; one that does keeps its
    // library's name in the value (the fetch skips the ".."), which the
    // clients' previews copy (webapp discover-jobs.js serverFolderOf).
    assert.equal(serverFolderOf('../shared/A/x.mp3'), 'shared/A');
    assert.equal(serverFolderOf('../../shared/A/x.mp3'), 'shared/A');
    assert.equal(serverFolderOf('../x.mp3'), '');
    const destination = { vpath: 'music', base: 'Mirror', layout: '{{SERVERFOLDER}}' };
    assert.equal(landingFor({ folder: '../shared/A', landing: null, destination }).dir, 'Mirror/shared/A');
    const t = renderTarget({ destination, tags: {}, peerName: 'Sam', serverFolder: serverFolderOf('../shared/A/x.mp3'), fileName: 'x.mp3' });
    assert.equal(t.relDir, 'Mirror/shared/A', 'where the mirror lands it');
    assert.equal(pathTemplate.validateResolvedPath(t.relDir).valid, true);
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

  test('the destination a client showed is the one in force when library, base (normalised) and layout agree; source is not compared', () => {
    const effective = { vpath: 'other', base: 'From peers', layout: '{{PEER}}/{{ARTIST}}', source: 'user' };
    assert.equal(sameDestination({ vpath: 'other', base: 'From peers', layout: '{{PEER}}/{{ARTIST}}' }, effective), true);
    assert.equal(sameDestination({ vpath: 'other', base: ' From peers/ ', layout: '{{PEER}}/{{ARTIST}}', source: 'default' }, effective), true, 'the base as normalizeBase reads it');
    assert.equal(sameDestination({ vpath: 'music', base: 'From peers', layout: '{{PEER}}/{{ARTIST}}' }, effective), false, 'another library');
    assert.equal(sameDestination({ vpath: 'other', base: '', layout: '{{PEER}}/{{ARTIST}}' }, effective), false, 'another base');
    assert.equal(sameDestination({ vpath: 'other', base: 'From peers', layout: '{{ARTIST}}' }, effective), false, 'another layout');
    assert.equal(sameDestination({ vpath: 'other', base: '../From peers', layout: '{{PEER}}/{{ARTIST}}' }, effective), false, 'a base that cannot be is no match');
    assert.equal(sameDestination({ vpath: 'other', layout: '{{ALBUMARTIST}}/{{ALBUM}}' }, { vpath: 'other', base: '', layout: '{{ALBUMARTIST}}/{{ALBUM}}', source: 'default' }), true, 'no base is the root');
    assert.equal(sameDestination(null, null), true, 'nowhere shown, nowhere in force');
    assert.equal(sameDestination(null, effective), false);
    assert.equal(sameDestination(effective, null), false);
  });

  test('a job lands where it was pinned while the account may still write there; a pin it lost fails, never moves', () => {
    const pinned = { vpath: 'other', base: 'Pinned/', layout: '{{ARTIST}}/{{ALBUM}}', source: 'user' };
    assert.deepEqual(destinationForJob(user(), { scope: 'album', destination: pinned }, opts),
      { vpath: 'other', base: 'Pinned', layout: '{{ARTIST}}/{{ALBUM}}', source: 'user' });
    assert.deepEqual(destinationForJob(user(), { destination: { vpath: 'music', base: '', layout: '{{ALBUMARTIST}}/{{ALBUM}}', source: 'default' } }, opts),
      { vpath: 'music', base: '', layout: '{{ALBUMARTIST}}/{{ALBUM}}', source: 'default' }, 'a pinned default stays the default it was');
    assert.throws(() => destinationForJob(user({ vpaths: ['music'] }), { destination: pinned }, opts), /no longer put files into library 'other'/);
    assert.throws(() => destinationForJob(user(), { destination: pinned }, { ...opts, noUpload: true }), /no longer put files into library 'other'/);
    assert.throws(() => destinationForJob(user(), { destination: { ...pinned, layout: '{{TRACK}}' } }, opts), /layout no longer validates/);
    assert.throws(() => destinationForJob(user(), { destination: { ...pinned, base: '../up' } }, opts), /base folder no longer validates/);
    // Pinned to nowhere: nowhere still, though the account may write now.
    assert.equal(destinationForJob(user(), { scope: 'album', destination: null }, opts), null);
    // Asked for before jobs were pinned: the destination in force when it runs.
    const inForce = { vpath: 'music', base: '', layout: '{{ALBUMARTIST}}/{{ALBUM}}', source: 'default' };
    assert.deepEqual(destinationForJob(user({ id: 0 }), { scope: 'album' }, opts), inForce);
    assert.deepEqual(destinationForJob(user({ id: 0 }), null, opts), inForce);
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

  test('tagsForLayout: {{ALBUMARTIST}} is the file\'s tag, else the album\'s credit the copy knows, else none — then the path template takes the artist', () => {
    const destination = { vpath: 'music', base: '', layout: DEFAULT_LAYOUT };
    const at = (common, rec) => renderTarget({ destination, peerName: 'Sam', fileName: 'x.mp3', tags: tagsForLayout(common, rec) }).relDir;
    const featured = { artist: 'Boukmanflow feat. Ola', album: 'Borrowed Tapes' };
    // the file's own tag wins over any credit
    assert.equal(tagsForLayout({ ...featured, albumartist: 'Tape Club' }, { albumArtist: 'Boukmanflow' }).albumartist, 'Tape Club');
    assert.equal(at({ ...featured, albumartist: 'Tape Club' }, { albumArtist: 'Boukmanflow' }), 'Tape Club/Borrowed Tapes');
    // no tag: the album's credit — the featured song lands with its album
    assert.equal(tagsForLayout(featured, { artist: 'Boukmanflow feat. Ola', albumArtist: 'Boukmanflow' }).albumartist, 'Boukmanflow');
    assert.equal(at(featured, { albumArtist: 'Boukmanflow' }), 'Boukmanflow/Borrowed Tapes');
    // an untagged compilation: every song under the one credit, whoever performs it
    assert.deepEqual(['Ana Vey', 'Ben Lusk'].map((artist) => at({ artist, album: 'Tape Swap' }, { albumArtist: 'Various Artists' })), ['Various Artists/Tape Swap', 'Various Artists/Tape Swap']);
    // neither: none, and the song's own artist names the folder, as before
    assert.equal(tagsForLayout(featured, { artist: 'Boukmanflow feat. Ola' }).albumartist, null);
    assert.equal(at(featured, {}), 'Boukmanflow feat. Ola/Borrowed Tapes');
    assert.equal(tagsForLayout(featured, { albumArtist: null }).albumartist, null);
    // the other fields are as they were
    const { albumartist, ...rest } = tagsForLayout(featured, { albumArtist: 'Boukmanflow', title: 'T' });
    assert.equal(albumartist, 'Boukmanflow');
    assert.deepEqual(rest, { artist: 'Boukmanflow feat. Ola', album: 'Borrowed Tapes', title: 'T', year: null, genre: null });
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
    assert.deepEqual(bare.missingVars, ['ALBUMARTIST', 'ALBUM']);

    // The default is the album's credit (2026-10-19): a compilation's songs
    // land in one folder, an ordinary album where {{ARTIST}} put it.
    assert.equal(DEFAULT_LAYOUT, '{{ALBUMARTIST}}/{{ALBUM}}');
    const comp = renderTarget({ destination: { vpath: 'music', base: '', layout: DEFAULT_LAYOUT }, peerName: 'Sam', fileName: 'x.mp3', tags: { artist: 'Ondine', album: 'Low Tide Sessions', albumartist: 'Various Artists' } });
    assert.equal(comp.relDir, 'Various Artists/Low Tide Sessions');
    const own = renderTarget({ destination: { vpath: 'music', base: '', layout: DEFAULT_LAYOUT }, peerName: 'Sam', fileName: 'x.mp3', tags: { artist: 'Nova', album: 'Night Ferry' } });
    assert.equal(own.relDir, 'Nova/Night Ferry');
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
    assert.deepEqual(plan.map((a) => a.albumArtist), ['Nova', 'nova', 'Nova & Vosto'], 'each album carries its own credit, as the peer spells it — what its untagged files land under');
    const split = planArtistAlbums({ albums: [album('Loose Ends', { album_artist: null }), album('Odd', { album_artist: 7 }), album('Blank', { album_artist: '  ' })] }, 'Nova');
    assert.deepEqual(split.plan.map((a) => [a.name, a.albumArtist]), [['Loose Ends', null], ['Odd', null], ['Blank', null]], 'rows that disagree (null), or anything that is not a name: no credit of its own');
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
