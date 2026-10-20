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
  CAPABILITIES, RESOLVING_CAPABILITIES, RUNNABLE_CAPABILITIES, SCOPES, getPlugin, isPluginEnabled, listPlugins, anyPluginEnabled, pluginNames,
  normalizeRecommendation, recommendationKey, searchPhrase, JOB_SCOPES, scopeMissing, jobKey, jobKeysFor, albumCredit,
  NULLABLE_FACTS, repairRecommendation,
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

  test('key: every script has an identity of its own — non-Latin recommendations never share one key', () => {
    const key = (fields) => recommendationKey(normalizeRecommendation(fields));
    const kino = key({ artist: 'Кино', title: 'Группа крови', album: 'Группа крови' });
    const splean = key({ artist: 'Сплин', title: 'Выхода нет', album: 'Гранатовый альбом' });
    const utada = key({ artist: '宇多田ヒカル', title: 'First Love' });
    const bts = key({ artist: 'BTS', title: '봄날' });
    assert.equal(new Set([kino, splean, utada, bts]).size, 4, 'four songs, four keys');
    assert.equal(kino, key({ artist: 'кино', title: 'ГРУППА КРОВИ', album: 'группа крови' }), 'case still collides');
    assert.equal(key({ artist: 'Röyksopp', title: 'Eple' }), key({ artist: 'Royksopp', title: 'Eple' }), 'accents fold');
    assert.equal(key({ artist: 'ＡＢＣ', title: '１２３' }), key({ artist: 'ABC', title: '123' }), 'compatibility forms fold');
    assert.notEqual(key({ artist: '!!!', title: '???' }), key({ artist: '***', title: '???' }), 'symbol-only names fall back to their raw text, not to one empty key');
    // The scopes' keys are built the same way.
    const a = normalizeRecommendation({ artist: 'Кино', title: 'x', album: 'Группа крови' });
    const b = normalizeRecommendation({ artist: 'Сплин', title: 'y', album: 'Гранатовый альбом' });
    assert.notEqual(jobKey(a, 'album'), jobKey(b, 'album'));
    assert.notEqual(jobKey(a, 'artist'), jobKey(b, 'artist'));
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

// The taste route's peer rows (src/api/discovery-taste.js sendableRow, over
// repairRecommendation): a bad optional catalogue fact is nulled, the row
// kept; a bad identity, handle or provenance field still drops the row.
// What comes out always passes the schema, so a client's batch lookup never
// 400s on it.
describe('a peer row made sendable: bad optional fields nulled, not the row dropped', () => {
  const sendableRow = (row) => repairRecommendation(row).row;
  const NULLABLE_ROW_FIELDS = NULLABLE_FACTS;
  const fed = (over = {}) => ({
    artist: 'Boukmanflow', title: 'Late Train Verse', album: 'Borrowed Tapes', albumArtist: 'Boukmanflow', year: 2026,
    isrc: null, releaseGroupMbid: null, recordingMbid: null, duration: 8.046, similarity: 0.9324, genreTags: ['Hip-Hop'],
    albumArt: '4f15f49add7102e1dadd216887ce32ac.jpeg', filepath: 'peerlib/Boukmanflow/Borrowed Tapes/02 - Late Train Verse.mp3',
    peer: { id: 1, name: 'Stage Peer B' }, source: 'federation', seedHash: null, ...over,
  });
  // What the jobs, resolve and lookup routes do with it: no 400.
  const valid = (row) => assert.doesNotThrow(() => normalizeRecommendation(row), JSON.stringify(row));

  test('a valid row comes back as it is (the same object, every wire field kept)', () => {
    const row = fed();
    assert.deepEqual(repairRecommendation(row), { row, nulled: [], error: null });
    assert.equal(sendableRow(row), row);
  });

  test('it says what it nulled, and why', () => {
    const r = repairRecommendation(fed({ isrc: 'US-RC1-76-07839', year: 99999 }));
    assert.deepEqual(r.nulled.sort(), ['isrc', 'year']);
    assert.match(r.error, /isrc/);
    assert.match(r.error, /year/);
    const dropped = repairRecommendation(fed({ artist: 42 }));
    assert.equal(dropped.row, null);
    assert.deepEqual(dropped.nulled, []);
    assert.match(dropped.error, /artist/);
  });

  test('the skeptic\'s rows: an ISRC with hyphens and a five-digit year are nulled, and the song stays', () => {
    const hyphens = sendableRow(fed({ isrc: 'US-RC1-76-07839' }));
    assert.ok(hyphens, 'kept');
    assert.equal(hyphens.isrc, null);
    assert.equal(hyphens.title, 'Late Train Verse');
    assert.equal(hyphens.similarity, 0.9324, 'wire fields the schema does not know ride along');
    assert.equal(hyphens.albumArt, '4f15f49add7102e1dadd216887ce32ac.jpeg');
    valid(hyphens);
    const year = sendableRow(fed({ year: 99999 }));
    assert.equal(year.year, null);
    assert.equal(year.isrc, null);
    valid(year);
    const both = sendableRow(fed({ isrc: 'US-RC1-76-07839', year: 99999 }));
    assert.deepEqual([both.isrc, both.year], [null, null], 'every bad field at once (abortEarly off)');
    assert.equal(both.album, 'Borrowed Tapes', 'the good ones untouched');
    valid(both);
  });

  test('every optional field: a bad value nulls just that field', () => {
    const bad = {
      album: 'x'.repeat(513), albumArtist: 'y'.repeat(513), year: 12, isrc: 'not-an-isrc', releaseGroupMbid: 'r'.repeat(65),
      recordingMbid: 'm'.repeat(65), duration: -3,
    };
    assert.deepEqual(Object.keys(bad).sort(), [...NULLABLE_ROW_FIELDS].sort(), 'the list this test walks is the list the route nulls');
    for (const [k, v] of Object.entries(bad)) {
      const out = sendableRow(fed({ [k]: v }));
      assert.ok(out, `${k}: kept`);
      assert.equal(out[k], null, `${k}: nulled`);
      for (const other of NULLABLE_ROW_FIELDS.filter((f) => f !== k)) { assert.equal(out[other], fed()[other], `${k}: ${other} untouched`); }
      valid(out);
    }
    const all = sendableRow(fed(bad));
    for (const k of NULLABLE_ROW_FIELDS) { assert.equal(all[k], null, k); }
    valid(all);
    // A type the schema cannot convert is bad the same way.
    assert.equal(sendableRow(fed({ year: 'soon' })).year, null);
    assert.equal(sendableRow(fed({ duration: 'long' })).duration, null);
  });

  test('what a row IS is never nulled: a bad artist, title, filepath, source, peer or exportId drops it, alone or beside a nullable one', () => {
    for (const over of [
      { artist: 42 }, { title: 'x'.repeat(600) }, { filepath: 'p'.repeat(3000) }, { source: 'elsewhere' },
      { peer: { id: 1, name: 'n'.repeat(200) } }, { exportId: 'e'.repeat(300) },
      { title: 'x'.repeat(600), isrc: 'US-RC1-76-07839' },
    ]) {
      assert.equal(sendableRow(fed(over)), null, JSON.stringify(Object.keys(over)));
    }
    assert.equal(sendableRow('Artist - Title'), null, 'not an object');
    assert.equal(sendableRow(null), null);
    assert.equal(sendableRow(undefined), null);
    assert.equal(sendableRow([fed()]), null);
  });

  test('a network row (p2p) is made sendable by the same rule', () => {
    const row = { artist: 'A', title: 'Fine', isrc: 'gb-cmp-98-00001', duration: 200, similarity: 0.9, exportId: 'anon:fine', peer: { endpointId: 'e1', name: 'P' }, source: 'p2p', seedHash: 'h0' };
    const out = sendableRow(row);
    assert.equal(out.isrc, null, 'hyphens are not the 12 alphanumerics');
    assert.equal(out.seedHash, 'h0');
    valid(out);
    assert.equal(sendableRow({ ...row, isrc: 'gbcmp9800001' }).isrc, 'gbcmp9800001', 'a valid ISRC is left as the peer spelled it (the plug-ins normalise it)');
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
    assert.deepEqual(Object.keys(on[0]).sort(), ['available', 'capabilities', 'description', 'enabled', 'name', 'scope', 'scopes', 'settings', 'title']);
  });

  test('registerPlugin enforces the contract', () => {
    assert.throws(() => registerPlugin({ name: 'Bad Name', title: 'x', capabilities: ['links'], scope: 'server', resolve() {} }), /invalid plug-in name/);
    assert.throws(() => registerPlugin({ name: 'links', title: 'x', capabilities: ['links'], scope: 'server', resolve() {} }), /already registered/);
    assert.throws(() => registerPlugin({ name: 'p1', title: 'x', capabilities: ['teleport'], scope: 'server' }), /unknown capabilities/);
    assert.throws(() => registerPlugin({ name: 'p2', title: 'x', capabilities: ['links'], scope: 'server' }), /must implement resolve/);
    assert.throws(() => registerPlugin({ name: 'p3', title: 'x', capabilities: ['handoff'], scope: 'user' }), /must implement run/);
    assert.throws(() => registerPlugin({ name: 'p4', title: 'x', capabilities: ['acquire'], scope: 'server', run() {}, concurrency: 0 }), /concurrency/);
    // lookup is answered by resolve(): an acquire plug-in that declares it needs both run() and resolve().
    assert.equal(CAPABILITIES.LOOKUP, 'lookup');
    assert.ok(RESOLVING_CAPABILITIES.includes('lookup') && !RUNNABLE_CAPABILITIES.includes('lookup'));
    assert.throws(() => registerPlugin({ name: 'p5', title: 'x', capabilities: ['acquire', 'lookup'], scope: 'server', run() {} }), /must implement resolve/);
    // Job scopes: a known subset of JOB_SCOPES, never empty.
    assert.throws(() => registerPlugin({ name: 'p6', title: 'x', capabilities: ['acquire'], scope: 'server', run() {}, scopes: ['album', 'galaxy'] }), /unknown job scopes/);
    assert.throws(() => registerPlugin({ name: 'p7', title: 'x', capabilities: ['acquire'], scope: 'server', run() {}, scopes: [] }), /unknown job scopes/);
    const def = registerPlugin({ name: 'unit-test-plugin', title: 'Unit', capabilities: ['handoff'], scope: 'user', run() {} });
    assert.ok(Object.isFrozen(def));
    assert.equal(def.description, '');
    assert.deepEqual([...def.scopes], ['song'], 'the song scope unless declared');
    assert.deepEqual([...registerPlugin({ name: 'unit-album-plugin', title: 'Unit', capabilities: ['acquire'], scope: 'server', run() {}, scopes: [JOB_SCOPES.SONG, JOB_SCOPES.ALBUM] }).scopes], ['song', 'album']);
    unregisterPluginForTests('unit-album-plugin');
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

describe('job scopes: what a job acts on, and the key it dedupes on', () => {
  const rec = normalizeRecommendation({ artist: 'Nova', title: 'Remote Hit', album: 'Night Ferry' });

  test('a song job keys as the recommendation; an album job on artist + album; the artist scopes on the artist', () => {
    assert.deepEqual(Object.values(JOB_SCOPES), ['song', 'album', 'artist', 'artist-missing', 'folder']);
    assert.equal(jobKey(rec), recommendationKey(rec));
    assert.equal(jobKey(rec, 'song'), recommendationKey(rec));
    assert.match(jobKey(rec, 'album'), /^album:[0-9a-f]{32}$/);
    assert.match(jobKey(rec, 'artist'), /^artist:[0-9a-f]{32}$/);
    assert.match(jobKey(rec, 'artist-missing'), /^artist-missing:[0-9a-f]{32}$/);
    const other = normalizeRecommendation({ artist: 'Nova', title: 'Second Song', album: 'Night Ferry' });
    assert.equal(jobKey(other, 'album'), jobKey(rec, 'album'), 'two songs of one album ask for the same album job');
    assert.equal(jobKey(other, 'artist'), jobKey(rec, 'artist'));
    assert.notEqual(jobKey(rec, 'artist-missing'), jobKey(rec, 'artist'), 'two different jobs');
    assert.notEqual(jobKey(normalizeRecommendation({ artist: 'Nova', title: 'x', album: 'Solo' }), 'album'), jobKey(rec, 'album'));
    assert.equal(jobKey(normalizeRecommendation({ artist: 'nova ', title: 'x', album: 'NIGHT FERRY' }), 'album'), jobKey(rec, 'album'), 'normalised like the song key');
  });

  test('what a scope needs, and every key a recommendation may sit under', () => {
    assert.equal(scopeMissing(rec, 'album'), null);
    assert.equal(scopeMissing(rec, 'song'), null);
    assert.equal(scopeMissing(normalizeRecommendation({ artist: 'Nova', title: 'x' }), 'album'), 'album');
    assert.equal(scopeMissing(normalizeRecommendation({ title: 'x', album: 'y' }), 'artist'), 'artist');
    assert.equal(scopeMissing(normalizeRecommendation({ title: 'x' }), 'artist-missing'), 'artist');
    assert.deepEqual(Object.keys(jobKeysFor(rec)), ['song', 'album', 'artist', 'artist-missing']);
    assert.deepEqual(Object.keys(jobKeysFor(normalizeRecommendation({ artist: 'Nova', title: 'x' }))), ['song', 'artist', 'artist-missing']);
    assert.deepEqual(Object.keys(jobKeysFor(normalizeRecommendation({ title: 'x' }))), ['song']);
    assert.equal(jobKeysFor(rec).song, recommendationKey(rec));
    assert.equal(jobKeysFor(rec).album, jobKey(rec, 'album'));
  });

  test('a folder job keys on the peer and the folder\'s path, case kept, whatever spelling the client held', () => {
    const peer = { id: 3, name: 'Sam' };
    const folder = normalizeRecommendation({ source: 'federation', peer, filepath: 'shared/Vosto/Underpass Remixes', title: 'Underpass Remixes' });
    assert.equal(scopeMissing(folder, 'folder'), null);
    assert.equal(scopeMissing(normalizeRecommendation({ source: 'federation', peer }), 'folder'), 'filepath');
    assert.equal(scopeMissing(normalizeRecommendation({ source: 'federation', filepath: 'shared/x' }), 'folder'), 'peer');
    assert.match(jobKey(folder, 'folder'), /^folder:[0-9a-f]{32}$/);
    const same = (fp) => jobKey(normalizeRecommendation({ source: 'federation', peer, filepath: fp }), 'folder');
    assert.equal(same('/shared/Vosto/Underpass Remixes/'), jobKey(folder, 'folder'), 'slashes at the ends do not count');
    assert.equal(same('shared//Vosto/./Underpass Remixes'), jobKey(folder, 'folder'), 'nor doubled ones or dot segments');
    assert.equal(same('shared\\Vosto\\Underpass Remixes'), jobKey(folder, 'folder'), 'a backslash spelling is the same folder');
    assert.notEqual(same('shared/Vosto/underpass remixes'), jobKey(folder, 'folder'), 'case is kept: a peer may tell the two apart');
    assert.notEqual(same('shared/VostoUnderpass Remixes'), jobKey(folder, 'folder'), 'never the text key, which drops spaces');
    assert.notEqual(jobKey(normalizeRecommendation({ source: 'federation', peer: { id: 4 }, filepath: 'shared/Vosto/Underpass Remixes' }), 'folder'), jobKey(folder, 'folder'), 'another peer, another folder');
    assert.equal(jobKeysFor(folder).folder, jobKey(folder, 'folder'));
    assert.deepEqual(Object.keys(jobKeysFor(folder)), ['song', 'folder'], 'no artist or album: only the song and folder keys');
  });

  test('a file the peer never tagged keys on its path there, not on the empty text every such file shares', () => {
    const peer = { id: 3 };
    const a = normalizeRecommendation({ source: 'federation', peer, filepath: 'shared/bootleg_03.mp3' });
    const b = normalizeRecommendation({ source: 'federation', peer, filepath: 'shared/bootleg_04.mp3' });
    assert.match(recommendationKey(a), /^file:[0-9a-f]{32}$/);
    assert.notEqual(recommendationKey(a), recommendationKey(b));
    assert.equal(recommendationKey(a), recommendationKey(normalizeRecommendation({ source: 'federation', peer, filepath: '/shared/bootleg_03.mp3' })));
    assert.notEqual(recommendationKey(a), recommendationKey(normalizeRecommendation({ source: 'federation', peer: { id: 9 }, filepath: 'shared/bootleg_03.mp3' })));
    // A tagged file keys on its tags as ever, whatever its path.
    const tagged = normalizeRecommendation({ artist: 'Nova', title: 'Remote Hit', album: 'Night Ferry', filepath: 'shared/x.mp3' });
    assert.equal(recommendationKey(tagged), recommendationKey(normalizeRecommendation({ artist: 'Nova', title: 'Remote Hit', album: 'Night Ferry' })));
    assert.match(recommendationKey(tagged), /^text:/);
    // Nothing at all still has a key of its own kind.
    assert.match(recommendationKey(normalizeRecommendation({})), /^text:/);
  });

  test('an album job keys on the album\'s own credit when that is all the client sent', () => {
    const song = normalizeRecommendation({ artist: 'Various Artists', title: 'x', album: 'Various Hits' });
    const card = normalizeRecommendation({ albumArtist: 'Various Artists', album: 'Various Hits' });
    assert.equal(card.albumArtist, 'Various Artists', 'albumArtist is part of the contract');
    assert.equal(scopeMissing(card, 'album'), null);
    assert.equal(jobKey(card, 'album'), jobKey(song, 'album'));
  });

  test('a compilation: every row keys ONE album job on the album\'s credit, whoever performs the song (2026-10-19)', () => {
    const kim = normalizeRecommendation({ artist: 'Peer Kim', title: 'Kim Song', album: 'Mixtape Vol 1', albumArtist: 'Various Artists' });
    const lou = normalizeRecommendation({ artist: 'Peer Lou', title: 'Lou Song', album: 'Mixtape Vol 1', albumArtist: 'Various Artists' });
    const card = normalizeRecommendation({ albumArtist: 'Various Artists', album: 'Mixtape Vol 1' });
    assert.equal(albumCredit(kim), 'Various Artists', 'the album credit wins over the track artist');
    assert.equal(jobKey(kim, 'album'), jobKey(lou, 'album'), 'two track artists, one album job');
    assert.equal(jobKey(kim, 'album'), jobKey(card, 'album'), 'the card form asks for the same job');
    assert.equal(jobKeysFor(lou).album, jobKey(kim, 'album'), 'the lookup finds it from either row');
    // Each row keeps its own song and artist keys: only the album is shared.
    assert.notEqual(jobKey(kim), jobKey(lou));
    assert.notEqual(jobKey(kim, 'artist'), jobKey(lou, 'artist'));
    // An album whose credit IS the track artist keys exactly as before (the
    // track artist alone) — a peer row naming it changes no stored job.
    const own = normalizeRecommendation({ artist: 'Nova', title: 'x', album: 'Night Ferry', albumArtist: 'Nova' });
    assert.equal(jobKey(own, 'album'), jobKey(normalizeRecommendation({ artist: 'Nova', title: 'x', album: 'Night Ferry' }), 'album'));
    assert.equal(jobKey(normalizeRecommendation({ artist: 'NOVA', album: 'night ferry', albumArtist: 'nova ' }), 'album'), jobKey(own, 'album'), 'normalised like every key');
    // A blank credit is no credit: the track artist stands in.
    assert.equal(albumCredit(normalizeRecommendation({ artist: 'Nova', albumArtist: '   ' })), 'Nova');
    assert.equal(albumCredit(normalizeRecommendation({ title: 'x' })), null);
  });

  test('an album job needs a credit as well as the name: an album NAME alone is every same-named album on the peer', () => {
    const nameOnly = normalizeRecommendation({ title: 'Untagged Hit', album: 'Greatest Hits' });
    assert.equal(scopeMissing(nameOnly, 'album'), 'artist');
    assert.equal(scopeMissing(normalizeRecommendation({ title: 'x' }), 'album'), 'album', 'the album name is asked for first');
    assert.equal(scopeMissing(normalizeRecommendation({ album: 'Greatest Hits', artist: 'Other Band' }), 'album'), null);
    assert.equal(scopeMissing(normalizeRecommendation({ album: 'Greatest Hits', albumArtist: 'Various Artists' }), 'album'), null);
    assert.equal(scopeMissing(normalizeRecommendation({ album: 'Greatest Hits', albumArtist: '' }), 'album'), 'artist', 'an empty credit is none');
    assert.deepEqual(Object.keys(jobKeysFor(nameOnly)), ['song'], 'no album key for a row that cannot start one');
    const peerRow = normalizeRecommendation({ source: 'federation', peer: { id: 3 }, filepath: 'ceelib/Unknown/Greatest Hits/01.mp3', album: 'Greatest Hits' });
    assert.deepEqual(Object.keys(jobKeysFor(peerRow)), ['song', 'folder']);
  });
});
