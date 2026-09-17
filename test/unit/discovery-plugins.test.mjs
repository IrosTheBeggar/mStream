/**
 * Discovery plug-in system, pure parts (src/discovery-plugins/*):
 *   - the recommendation contract: normalisation, stripping, the persistence
 *     key (MBID-first, novelty-normalised text fallback);
 *   - the registry: contract validation, enablement is config-driven and
 *     OFF by default, listing honours it;
 *   - the built-in "links" plug-in: canonical MusicBrainz links only when the
 *     ids exist, search links from the artist+title phrase, nothing at all
 *     for an empty recommendation.
 * The HTTP surface is covered by test/integration/discovery-plugins-api.test.mjs.
 */

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITIES, SCOPES, getPlugin, isPluginEnabled, listPlugins, anyPluginEnabled, pluginNames,
  normalizeRecommendation, recommendationKey, searchPhrase,
} from '../../src/discovery-plugins/index.js';
import { registerPlugin, unregisterPluginForTests } from '../../src/discovery-plugins/registry.js';
import { buildLinks } from '../../src/discovery-plugins/plugins/links.js';

const ON = { links: { enabled: true } };
const OFF = { links: { enabled: false } };

describe('recommendation contract', () => {
  test('normalises a p2p similar row: unknown keys stripped, missing fields null, isrc upper-cased', () => {
    const rec = normalizeRecommendation({
      artist: '  Compat Artist ', title: 'Opening', similarity: 0.9, exportId: 'anon:abc',
      isrc: 'gbcmp9800001', peer: { endpointId: 'a'.repeat(64), name: 'Peer X' },
    });
    assert.equal(rec.artist, 'Compat Artist');
    assert.equal(rec.album, null);
    assert.equal(rec.year, null);
    assert.equal(rec.isrc, 'GBCMP9800001');
    assert.equal(rec.source, 'p2p', 'default provenance');
    assert.equal(rec.peer.name, 'Peer X');
    assert.ok(!('similarity' in rec), 'ranking noise is not part of the contract');
  });

  test('rejects garbage: a malformed ISRC, an out-of-range year, a non-object', () => {
    assert.throws(() => normalizeRecommendation({ isrc: 'not-an-isrc' }));
    assert.throws(() => normalizeRecommendation({ year: 12 }));
    assert.throws(() => normalizeRecommendation('Artist - Title'));
  });

  test('key: MBID first, else a normalised artist|title|album digest that ignores case and punctuation', () => {
    const a = recommendationKey(normalizeRecommendation({ artist: 'The Beatles', title: 'Help!', album: 'Help!' }));
    const b = recommendationKey(normalizeRecommendation({ artist: 'the beatles', title: 'help', album: 'HELP' }));
    const c = recommendationKey(normalizeRecommendation({ artist: 'The Beatles', title: 'Help!', album: 'Anthology 2' }));
    assert.equal(a, b, 'same song, different tagging → same key');
    assert.notEqual(a, c, 'album is part of the text identity');
    assert.match(a, /^text:[0-9a-f]{32}$/);
    const m = recommendationKey(normalizeRecommendation({ artist: 'X', title: 'Y', recordingMbid: 'ABC-123' }));
    assert.equal(m, 'mbid:abc-123');
  });

  test('searchPhrase joins what is known and is empty for nothing', () => {
    assert.equal(searchPhrase({ artist: 'A', title: 'T' }), 'A T');
    assert.equal(searchPhrase({ artist: null, title: 'T' }), 'T');
    assert.equal(searchPhrase({ artist: null, title: null }), '');
  });
});

describe('registry', () => {
  after(() => unregisterPluginForTests('unit-test-plugin'));

  test('the built-in links plug-in is registered with the links capability', () => {
    assert.ok(pluginNames().includes('links'));
    const p = getPlugin('links');
    assert.deepEqual(p.capabilities, [CAPABILITIES.LINKS]);
    assert.equal(p.scope, SCOPES.SERVER);
  });

  test('enablement comes from config and is OFF without an entry', () => {
    assert.equal(isPluginEnabled('links', { config: ON }), true);
    assert.equal(isPluginEnabled('links', { config: OFF }), false);
    assert.equal(isPluginEnabled('links', { config: {} }), false, 'no entry → off');
    assert.equal(isPluginEnabled('no-such-plugin', { config: { 'no-such-plugin': { enabled: true } } }), false);
    assert.equal(anyPluginEnabled({ config: ON }), true);
    assert.equal(anyPluginEnabled({ config: OFF }), false);
  });

  test('listPlugins hides disabled plug-ins unless asked, and reports the flag', () => {
    assert.deepEqual(listPlugins({ config: OFF }), []);
    const all = listPlugins({ config: OFF, includeDisabled: true });
    assert.equal(all.find((p) => p.name === 'links').enabled, false);
    const on = listPlugins({ config: ON });
    assert.equal(on.length >= 1, true);
    assert.deepEqual(Object.keys(on[0]).sort(), ['available', 'capabilities', 'description', 'enabled', 'name', 'scope', 'settings', 'title']);
  });

  test('registerPlugin enforces the contract', () => {
    assert.throws(() => registerPlugin({ name: 'Bad Name', title: 'x', capabilities: ['links'], scope: 'server', resolve() {} }), /invalid plug-in name/);
    assert.throws(() => registerPlugin({ name: 'links', title: 'x', capabilities: ['links'], scope: 'server', resolve() {} }), /already registered/);
    assert.throws(() => registerPlugin({ name: 'p1', title: 'x', capabilities: ['teleport'], scope: 'server' }), /unknown capabilities/);
    assert.throws(() => registerPlugin({ name: 'p2', title: 'x', capabilities: ['links'], scope: 'server' }), /must implement resolve/);
    assert.throws(() => registerPlugin({ name: 'p3', title: 'x', capabilities: ['handoff'], scope: 'user' }), /must implement run/);
    assert.throws(() => registerPlugin({ name: 'p4', title: 'x', capabilities: ['acquire'], scope: 'server', run() {}, concurrency: 0 }), /concurrency/);
    const def = registerPlugin({ name: 'unit-test-plugin', title: 'Unit', capabilities: ['handoff'], scope: 'user', run() {} });
    assert.ok(Object.isFrozen(def));
    assert.equal(def.description, '');
  });
});

describe('links plug-in', () => {
  test('canonical links only for the ids present, search links from artist+title', () => {
    const rec = normalizeRecommendation({
      artist: 'Compat Artist', title: 'Opening', album: 'First Album', year: 1998,
      isrc: 'GBCMP9800001', releaseGroupMbid: 'rg-first', recordingMbid: null,
    });
    const links = buildLinks(rec);
    const ids = links.map((l) => l.id);
    assert.ok(!ids.includes('musicbrainz-recording'), 'no recording MBID → no recording link');
    assert.ok(ids.includes('musicbrainz-release-group'));
    assert.ok(ids.includes('musicbrainz-isrc'));
    const rg = links.find((l) => l.id === 'musicbrainz-release-group');
    assert.equal(rg.url, 'https://musicbrainz.org/release-group/rg-first');
    assert.equal(rg.kind, 'canonical');
    const yt = links.find((l) => l.id === 'youtube-search');
    assert.equal(yt.url, 'https://www.youtube.com/results?search_query=Compat%20Artist%20Opening');
    assert.equal(yt.kind, 'search');
    for (const l of links) {
      assert.match(l.url, /^https:\/\//);
      assert.ok(l.label && l.id);
    }
  });

  test('an empty recommendation yields no links at all', () => {
    assert.deepEqual(buildLinks(normalizeRecommendation({})), []);
  });

  test('resolve() wraps the links and encodes hostile input', async () => {
    const rec = normalizeRecommendation({ artist: 'A&B <script>', title: 'T/1?', recordingMbid: '../x' });
    const { links } = await getPlugin('links').resolve(rec);
    const mb = links.find((l) => l.id === 'musicbrainz-recording');
    assert.equal(mb.url, 'https://musicbrainz.org/recording/..%2Fx');
    const dz = links.find((l) => l.id === 'deezer-search');
    assert.equal(dz.url, 'https://www.deezer.com/search/A%26B%20%3Cscript%3E%20T%2F1%3F');
  });
});
