/**
 * The federation-copy plug-in's pure parts (src/discovery-plugins/plugins/
 * federation-copy.js) and the PEER variable it adds to the torrent path
 * template engine. No server, no disk: the destination rules, the layout
 * validation, the base-folder rules, the file name, and the rendered target.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Joi from 'joi';
import * as pathTemplate from '../../src/torrent/path-template.js';
import { registerPlugin, unregisterPluginForTests, listPlugins } from '../../src/discovery-plugins/registry.js';
import plugin, {
  DEFAULT_LAYOUT, LAYOUT_VARS, writableLibraries, destinationFor, validateLayout,
  normalizeBase, safeFileName, renderTarget,
} from '../../src/discovery-plugins/plugins/federation-copy.js';

const LIBS = [
  { name: 'music', torrent_path_template: '{{ALBUMARTIST}}/{{ALBUM}}' },
  { name: 'other', torrent_path_template: null },
  { name: 'private', torrent_path_template: null },
];
const user = (over = {}) => ({ id: 7, vpaths: ['music', 'other'], allow_upload: 1, ...over });
const opts = { libraries: LIBS, noUpload: false };

describe('federation-copy · plug-in shape', () => {
  test('an acquire plug-in with one user setting, run(), one at a time', () => {
    assert.equal(plugin.name, 'federation-copy');
    assert.deepEqual([...plugin.capabilities], ['acquire']);
    assert.equal(plugin.scope, 'user');
    assert.equal(plugin.concurrency, 1);
    assert.equal(typeof plugin.run, 'function');
    assert.deepEqual(Object.keys(plugin.userSettings), ['destination']);
    assert.equal(typeof plugin.validateSetting, 'function');
    assert.equal(typeof plugin.describeSettings, 'function');
    const ok = plugin.userSettings.destination.schema.validate({ vpath: 'music', base: '', layout: DEFAULT_LAYOUT });
    assert.equal(ok.error, undefined);
    const bad = plugin.userSettings.destination.schema.validate({ vpath: 'music' });
    assert.ok(bad.error, 'layout is required');
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

describe('federation-copy · the PEER variable', () => {
  test('LAYOUT_VARS is the torrent set plus PEER, in that order', () => {
    assert.deepEqual([...LAYOUT_VARS], [...pathTemplate.SUPPORTED_VARS, 'PEER']);
    assert.equal(pathTemplate.EXTRA_VARS.PEER, 'PEER');
  });

  test('the copy layout accepts PEER; the torrent validator still refuses it', () => {
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

describe('federation-copy · destination', () => {
  test('writable libraries: the user\'s vpaths, with each admin template', () => {
    assert.deepEqual(writableLibraries(user(), opts), [
      { vpath: 'music', template: '{{ALBUMARTIST}}/{{ALBUM}}' },
      { vpath: 'other', template: null },
    ]);
  });

  test('no upload rights, no library, no user → nothing to copy into', () => {
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
    assert.deepEqual(destinationFor(user({ vpaths: ['other'] }), {}, opts),
      { vpath: 'other', base: '', layout: DEFAULT_LAYOUT, source: 'default' });
  });

  test('a saved destination wins while it still makes sense', () => {
    const saved = { destination: { vpath: 'other', base: 'From peers/', layout: '{{PEER}}/{{ARTIST}}/{{ALBUM}}' } };
    assert.deepEqual(destinationFor(user(), saved, opts),
      { vpath: 'other', base: 'From peers', layout: '{{PEER}}/{{ARTIST}}/{{ALBUM}}', source: 'user' });
    // A library the user lost, a layout that no longer validates, a base
    // that climbs out: back to the default, never a half-applied setting.
    assert.equal(destinationFor(user(), { destination: { vpath: 'private', base: '', layout: DEFAULT_LAYOUT } }, opts).source, 'default');
    assert.equal(destinationFor(user(), { destination: { vpath: 'other', base: '', layout: '{{TRACK}}' } }, opts).source, 'default');
    assert.equal(destinationFor(user(), { destination: { vpath: 'other', base: '../up', layout: DEFAULT_LAYOUT } }, opts).source, 'default');
    assert.equal(destinationFor(user(), { destination: 'nonsense' }, opts).source, 'default');
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

describe('federation-copy · file name and target', () => {
  test('the peer\'s file name is kept, minus what a path cannot carry', () => {
    assert.equal(safeFileName('shared/Nova/Remote Hit.mp3'), 'Remote Hit.mp3');
    assert.equal(safeFileName('shared/Nova/ 01. Song?.flac '), '01. Song-.flac');
    assert.equal(safeFileName('x:y|z.mp3'), 'x-y-z.mp3');
    assert.equal(safeFileName('shared/'), 'shared', 'the last non-empty segment');
    assert.equal(safeFileName(''), 'track');
    assert.equal(safeFileName('a/..'), 'track');
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
