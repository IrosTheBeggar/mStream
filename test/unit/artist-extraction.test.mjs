/**
 * Unit tests for the V72 credit rules (src/db/artist-extraction.js) and the
 * raw ID3v2 credit-frame reader (src/db/id3-raw.js) the JS scanner uses to
 * see tags the way lofty does.
 *
 *   - a multi-valued tag is honoured verbatim (never delimiter-split);
 *   - a single value is split on the Navidrome delimiter list, except the
 *     names in the exceptions list (exact spelling, list order);
 *   - the display string is the tag as written (plural joined with ", ");
 *   - credits dedup by identity key, first spelling wins;
 *   - credit values come from the container's PRIMARY tag (Vorbis / MP4 /
 *     APE native entries, raw ID3v2 frames), never from the ARTISTS list tag;
 *   - the raw reader handles v2.2 / v2.3 / v2.4, unsynchronisation, RIFF
 *     chunks, and bails (null) on what it cannot read.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  splitArtistString, resolveCredits, creditDisplay, extractArtists, creditValuesFromParsed, id3IsPrimary,
  ROLE_TAGS, TRACK_ROLES,
} from '../../src/db/artist-extraction.js';
import { readId3TextFrames } from '../../src/db/id3-raw.js';
import { appendId3TextFrames, id3TextFrame } from '../helpers/id3.mjs';

describe('splitArtistString', () => {
  test('splits a single value on the delimiter list, trimmed, empties dropped', () => {
    assert.deepEqual(splitArtistString('A feat. B / C; D ft. E'), ['A', 'B', 'C', 'D', 'E']);
    assert.deepEqual(splitArtistString('  Solo  '), ['Solo']);
    assert.deepEqual(splitArtistString(''), []);
    assert.deepEqual(splitArtistString(null), []);
  });

  test('a bare slash is not a delimiter (AC/DC stays whole)', () => {
    assert.deepEqual(splitArtistString('AC/DC'), ['AC/DC']);
    assert.deepEqual(splitArtistString('AC / DC'), ['AC', 'DC']);
  });

  test('exceptions survive the split with their tagged spelling', () => {
    assert.deepEqual(splitArtistString('AC / DC feat. Bon', ['AC / DC']), ['AC / DC', 'Bon']);
    assert.deepEqual(splitArtistString('AC / DC', ['AC / DC']), ['AC / DC']);
    // An exception inside a longer name is restored in place.
    assert.deepEqual(splitArtistString("AC / DC's Band / Other", ['AC / DC']), ["AC / DC's Band", 'Other']);
    // Exact spelling: a case variant is not protected.
    assert.deepEqual(splitArtistString('ac / dc', ['AC / DC']), ['ac', 'dc']);
    // List order is match priority.
    assert.deepEqual(splitArtistString('Earth; Wind feat. Fire', ['Earth; Wind feat. Fire', 'Earth; Wind']),
      ['Earth; Wind feat. Fire']);
    // Digits in names never collide with a placeholder, whatever the list position.
    const many = Array.from({ length: 120 }, (_, i) => `Band ${i} / X`);
    assert.deepEqual(splitArtistString('112 / Band 1 / X; 0', [...many, '112', '0']), ['112', 'Band 1 / X', '0']);
    // A value without any delimiter is untouched even with exceptions listed.
    assert.deepEqual(splitArtistString('AC/DC', ['AC/DC']), ['AC/DC']);
  });
});

describe('resolveCredits / creditDisplay', () => {
  test('two or more values are honoured verbatim — never split', () => {
    assert.deepEqual(resolveCredits(['Simon & Garfunkel; Art', 'Foo feat. Bar']), ['Simon & Garfunkel; Art', 'Foo feat. Bar']);
    assert.equal(creditDisplay(['Simon & Garfunkel; Art', 'Foo feat. Bar']), 'Simon & Garfunkel; Art, Foo feat. Bar');
  });

  test('a single value is split; the display keeps it as written', () => {
    assert.deepEqual(resolveCredits(['Foo feat. Bar']), ['Foo', 'Bar']);
    assert.equal(creditDisplay(['Foo feat. Bar']), 'Foo feat. Bar');
    assert.deepEqual(resolveCredits(['Foo feat. Bar'], ['Foo feat. Bar']), ['Foo feat. Bar']);
  });

  test('dedups by identity key, first spelling wins — the display too', () => {
    assert.deepEqual(resolveCredits(["Guns N' Roses / Guns N’ Roses"]), ["Guns N' Roses"]);
    assert.deepEqual(resolveCredits(['Beatles', 'beatles', 'Solo']), ['Beatles', 'Solo']);
    assert.equal(creditDisplay(['Foo', 'Foo']), 'Foo', 'two identical ARTIST comments read once');
    assert.equal(creditDisplay(['Foo', 'foo', 'Bar']), 'Foo, Bar');
  });

  test('empty / blank input', () => {
    assert.deepEqual(resolveCredits([]), []);
    assert.deepEqual(resolveCredits(['  ']), []);
    assert.equal(creditDisplay([]), '');
  });
});

describe('creditValuesFromParsed — the primary tag, the way lofty reads it', () => {
  const vorbis = (entries, common = {}) => ({
    format: { container: 'FLAC', tagTypes: ['vorbis'] },
    native: { vorbis: entries.map(([id, value]) => ({ id, value })) },
    common,
  });

  test('Vorbis: ARTIST comments only — the ARTISTS list tag is ignored (Picard writes one)', () => {
    const parsed = vorbis([['ARTIST', 'A feat. B'], ['ARTISTS', 'A'], ['ARTISTS', 'B'], ['COMPOSER', 'C1; C2'], ['MixArtist', 'R']],
      { artist: 'A feat. B', artists: ['A', 'B'] });
    const v = creditValuesFromParsed(parsed);
    assert.deepEqual(v.trackArtists, ['A feat. B']);
    assert.deepEqual(v.composer, ['C1; C2']);
    assert.deepEqual(v.remixer, ['R'], 'keys compare case-insensitively (MIXARTIST alias)');
    assert.deepEqual(v.albumArtists, []);
    const ai = extractArtists(parsed.common, { values: v });
    assert.deepEqual(ai.trackArtists, ['A', 'B']);
    assert.equal(ai.trackArtistDisplay, 'A feat. B', 'not "A, B" from the ARTISTS list');
  });

  test('Vorbis: two ARTIST comments are plural; a stray leading ID3 header does not switch to ID3', () => {
    const parsed = vorbis([['ARTIST', 'Duet A'], ['ARTIST', 'Duet B feat. Nobody'], ['ALBUMARTIST', 'Duet A'], ['ALBUMARTIST', 'Duet B']]);
    parsed.format.tagTypes = ['ID3v2.3', 'vorbis'];
    assert.equal(id3IsPrimary(parsed), false);
    const ai = extractArtists({}, { values: creditValuesFromParsed(parsed) });
    assert.deepEqual(ai.trackArtists, ['Duet A', 'Duet B feat. Nobody']);
    assert.equal(ai.trackArtistDisplay, 'Duet A, Duet B feat. Nobody');
    assert.equal(ai.albumArtistDisplay, 'Duet A, Duet B');
  });

  test('MP4: ©ART / aART / ©wrt and the iTunes freeform role atoms', () => {
    const parsed = {
      format: { container: 'M4A/isom/iso2', tagTypes: ['iTunes'] },
      native: { iTunes: [
        { id: '©ART', value: 'AC/DC feat. X' }, { id: 'aART', value: 'AA' }, { id: '©wrt', value: 'Comp' },
        { id: '----:com.apple.iTunes:CONDUCTOR', value: 'Cond' }, { id: '----:com.apple.iTunes:ARTISTS', value: 'AC/DC' },
      ] },
      common: { artist: 'AC/DC feat. X', artists: ['AC/DC'] },
    };
    const v = creditValuesFromParsed(parsed);
    assert.deepEqual(v, { trackArtists: ['AC/DC feat. X'], albumArtists: ['AA'], composer: ['Comp'], conductor: ['Cond'], remixer: [], lyricist: [] });
    assert.deepEqual(extractArtists(parsed.common, { values: v }).trackArtists, ['AC/DC', 'X']);
  });

  test('APEv2: Artist / Album Artist / MixArtist', () => {
    const parsed = {
      format: { container: 'Musepack', tagTypes: ['APEv2'] },
      native: { APEv2: [{ id: 'Artist', value: 'Solo' }, { id: 'Album Artist', value: 'AA' }, { id: 'MixArtist', value: 'R' }] },
      common: {},
    };
    assert.deepEqual(creditValuesFromParsed(parsed), { trackArtists: ['Solo'], albumArtists: ['AA'], composer: [], conductor: [], remixer: ['R'], lyricist: [] });
  });

  test('ID3v2 primary: raw frames win; without them the pre-split v2.3 view is re-joined (degraded)', () => {
    const parsed = { format: { container: 'MPEG', tagTypes: ['ID3v2.3'] }, native: { 'ID3v2.3': [] },
      common: { artist: 'AC', artists: ['AC', 'DC'], composer: ['Comp A', 'Comp B'], conductor: ['Cond'] } };
    assert.equal(id3IsPrimary(parsed), true);
    const raw = creditValuesFromParsed(parsed, { TPE1: ['AC/DC'], TCOM: ['Comp A / Comp B'] });
    assert.deepEqual(raw.trackArtists, ['AC/DC']);
    assert.deepEqual(raw.composer, ['Comp A / Comp B']);
    assert.deepEqual(raw.conductor, [], 'a frame the raw read did not carry is absent');
    assert.equal(raw.degraded, undefined);
    const degraded = creditValuesFromParsed(parsed, null);
    assert.equal(degraded.degraded, true);
    assert.deepEqual(degraded.trackArtists, ['AC/DC'], 'the "/"-split halves are re-joined, not treated as plural');
    assert.deepEqual(degraded.composer, ['Comp A/Comp B']);
    assert.deepEqual(degraded.conductor, ['Cond'], 'frames music-metadata does not pre-split are taken as-is');
    // v2.4 arrays are genuine multi-values — no re-join.
    const v24 = creditValuesFromParsed({ ...parsed, format: { container: 'MPEG', tagTypes: ['ID3v2.4'] } }, null);
    assert.deepEqual(v24.trackArtists, ['AC', 'DC']);
  });

  test('an unmapped container yields null → the common view', () => {
    const parsed = { format: { container: 'ASF', tagTypes: ['asf'] }, native: { asf: [] }, common: { artists: ['X; Y'] } };
    assert.equal(creditValuesFromParsed(parsed), null);
    assert.deepEqual(extractArtists(parsed.common, { values: null }).trackArtists, ['X', 'Y']);
  });
});

describe('extractArtists', () => {
  test('music-metadata view: arrays are plural, scalars are split, roles are read', () => {
    const ai = extractArtists({
      artist: 'A feat. B', artists: ['A feat. B'],
      albumartist: 'A', albumartists: ['A'],
      composer: ['C1 / C2'], conductor: ['Cond'], remixer: ['Rmx'], lyricist: ['Lyr'],
      compilation: false,
    });
    assert.deepEqual(ai.trackArtists, ['A', 'B']);
    assert.equal(ai.trackArtistDisplay, 'A feat. B');
    assert.deepEqual(ai.albumArtists, ['A']);
    assert.equal(ai.albumArtistDisplay, 'A');
    assert.deepEqual(ai.roleCredits, { composer: ['C1', 'C2'], conductor: ['Cond'], remixer: ['Rmx'], lyricist: ['Lyr'] });
  });

  test('a plural ARTIST tag is verbatim; its display joins the values', () => {
    const ai = extractArtists({ artists: ['X; Y', 'Z feat. W'], artist: 'X; Y' });
    assert.deepEqual(ai.trackArtists, ['X; Y', 'Z feat. W']);
    assert.equal(ai.trackArtistDisplay, 'X; Y, Z feat. W');
  });

  test('split exceptions reach every credit list', () => {
    const ai = extractArtists({ artists: ['AC / DC feat. Bon'], composer: ['AC / DC'] }, { splitExceptions: ['AC / DC'] });
    assert.deepEqual(ai.trackArtists, ['AC / DC', 'Bon']);
    assert.deepEqual(ai.roleCredits.composer, ['AC / DC']);
  });

  test('MusicBrainz artist ids joined with "/" (Picard, ID3v2.3) align like separate values', () => {
    const ai = extractArtists({ artists: ['Betamaxnomates feat. Junia-T'], musicbrainz_artistid: ['4755f284-f2a0-483e-b77e-29af4c663fba/ffee77a9-fa8a-4fda-936a-2c78b8de44ca'] });
    assert.deepEqual(ai.trackArtists, ['Betamaxnomates', 'Junia-T']);
    assert.deepEqual(ai.trackArtistMbids, ['4755f284-f2a0-483e-b77e-29af4c663fba', 'ffee77a9-fa8a-4fda-936a-2c78b8de44ca']);
    // Count mismatch still yields nothing.
    assert.deepEqual(extractArtists({ artists: ['Solo'], musicbrainz_artistid: ['a/b'] }).trackArtistMbids, []);
  });

  test('no credits at all', () => {
    const ai = extractArtists({});
    assert.deepEqual(ai.trackArtists, []);
    assert.equal(ai.trackArtistDisplay, '');
    assert.equal(ai.albumArtistDisplay, null);
    assert.deepEqual(ai.roleCredits, {});
  });

  test('the role list is the four non-performer roles', () => {
    assert.deepEqual(ROLE_TAGS.map((r) => r.role), ['composer', 'conductor', 'remixer', 'lyricist']);
    assert.deepEqual(ROLE_TAGS.map((r) => r.frame), ['TCOM', 'TPE3', 'TPE4', 'TEXT']);
    assert.deepEqual(TRACK_ROLES, ['main', 'featured', 'composer', 'conductor', 'remixer', 'lyricist']);
  });
});

describe('readId3TextFrames', () => {
  let dir;
  before(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-id3raw-')); });
  after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  // A file that is only an ID3v2 tag (no audio) is all the reader needs.
  async function tagOnly(name, frames, opts) {
    const p = path.join(dir, name);
    await fs.writeFile(p, Buffer.alloc(0));
    await appendId3TextFrames(p, frames, opts);
    return p;
  }
  const header = (major, flags, size) => {
    const h = Buffer.from('ID3\0\0\0\0\0\0\0', 'latin1');
    h[3] = major; h[5] = flags;
    h[6] = (size >> 21) & 0x7f; h[7] = (size >> 14) & 0x7f; h[8] = (size >> 7) & 0x7f; h[9] = size & 0x7f;
    return h;
  };

  test('v2.3: one value per frame, verbatim (no slash split)', async () => {
    const p = await tagOnly('v3.mp3', { TPE1: 'AC/DC', TPE2: 'AC/DC', TCOM: 'Comp A / Comp B', TIT2: 'Title' }, { version: 3 });
    assert.deepEqual(readId3TextFrames(p), { TPE1: ['AC/DC'], TPE2: ['AC/DC'], TCOM: ['Comp A / Comp B'] });
  });

  test('v2.4: null-separated values become separate entries', async () => {
    const p = await tagOnly('v4.mp3', { TPE1: 'A\0B', TEXT: 'Lyr', TPE4: 'Rmx' }, { version: 4 });
    assert.deepEqual(readId3TextFrames(p), { TPE1: ['A', 'B'], TEXT: ['Lyr'], TPE4: ['Rmx'] });
  });

  test('v2.2: 3-byte frame ids map onto the v2.4 ids', async () => {
    const frame = (id, text) => {
      const body = Buffer.concat([Buffer.from([0x00]), Buffer.from(text, 'latin1')]);
      const h = Buffer.alloc(6); h.write(id, 0, 'latin1');
      h[3] = (body.length >> 16) & 0xff; h[4] = (body.length >> 8) & 0xff; h[5] = body.length & 0xff;
      return Buffer.concat([h, body]);
    };
    const frames = Buffer.concat([frame('TP1', 'AC/DC'), frame('TCM', 'Comp'), frame('TT2', 'Title')]);
    const p = path.join(dir, 'v2.mp3');
    await fs.writeFile(p, Buffer.concat([header(2, 0, frames.length), frames]));
    assert.deepEqual(readId3TextFrames(p), { TPE1: ['AC/DC'], TCOM: ['Comp'] });
  });

  test('UTF-16 (BOM), UTF-16BE, UTF-8, and a per-value BOM in a v2.4 frame', async () => {
    const p = await tagOnly('enc.mp3', {
      TPE1: { text: 'Björk', encoding: 'utf16' },
      TPE2: { text: 'Sigur Rós', encoding: 'utf16be' },
      TCOM: { text: 'Édith Piaf', encoding: 'utf8' },
    }, { version: 3 });
    assert.deepEqual(readId3TextFrames(p), { TPE1: ['Björk'], TPE2: ['Sigur Rós'], TCOM: ['Édith Piaf'] });
    // v2.4, UTF-16 with a BOM on EACH value, second value big-endian.
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Ärzte', 'utf16le')]);
    const beText = Buffer.from('Bø', 'utf16le'); beText.swap16();
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), beText]);
    const body = Buffer.concat([Buffer.from([0x01]), le, Buffer.from([0x00, 0x00]), be]);
    const fh = Buffer.alloc(10); fh.write('TPE1', 0, 'latin1');   // size at 4..7 (syncsafe), flags at 8..9
    fh[5] = (body.length >> 14) & 0x7f; fh[6] = (body.length >> 7) & 0x7f; fh[7] = body.length & 0x7f;
    const frame = Buffer.concat([fh, body]);
    const p2 = path.join(dir, 'bom.mp3');
    await fs.writeFile(p2, Buffer.concat([header(4, 0, frame.length), frame]));
    assert.deepEqual(readId3TextFrames(p2), { TPE1: ['Ärzte', 'Bø'] });
  });

  test('an unsynchronised v2.3 tag is decoded, not skipped', async () => {
    // A latin1 name containing 0xFF 0xE0.. would be stuffed; build the tag
    // body then unsynchronise it by hand and set the header flag.
    const frame = id3TextFrame('TPE1', 'AÿéB', { version: 3 });   // ÿ = 0xFF, é = 0xE9 → FF E9 needs stuffing
    const unsynced = [];
    for (let i = 0; i < frame.length; i++) {
      unsynced.push(frame[i]);
      if (frame[i] === 0xff && (frame[i + 1] === undefined || frame[i + 1] === 0x00 || (frame[i + 1] & 0xe0) === 0xe0)) { unsynced.push(0x00); }
    }
    const body = Buffer.from(unsynced);
    const p = path.join(dir, 'unsync.mp3');
    await fs.writeFile(p, Buffer.concat([header(3, 0x80, body.length), body]));
    assert.deepEqual(readId3TextFrames(p), { TPE1: ['AÿéB'] });
  });

  test('chained tags: a v2.4 tag appended after the v2.3 one wins per frame, earlier-only frames survive', async () => {
    // A re-tagger left the original v2.3 tag (TPE1 + TCOM with three names)
    // and appended a v2.4 tag (TPE1 + TPE2 + TCOM=Muse). lofty merges the
    // two and music-metadata ranks v2.4 higher: TCOM is "Muse", TPE2 comes
    // from the second tag, TPE1 is not duplicated.
    const first = await tagOnly('chain-a.mp3', { TPE1: 'Muse', TCOM: 'Chris Wolstenholme/Dominic Howard/Matthew Bellamy' }, { version: 3 });
    const second = await tagOnly('chain-b.mp3', { TPE1: 'Muse', TPE2: 'Muse', TCOM: 'Muse' }, { version: 4 });
    const p = path.join(dir, 'chained.mp3');
    await fs.writeFile(p, Buffer.concat([await fs.readFile(first), await fs.readFile(second)]));
    assert.deepEqual(readId3TextFrames(p), { TPE1: ['Muse'], TCOM: ['Muse'], TPE2: ['Muse'] });
    // The reverse order: the (later) v2.3 tag's TCOM wins.
    const p2 = path.join(dir, 'chained2.mp3');
    await fs.writeFile(p2, Buffer.concat([await fs.readFile(second), await fs.readFile(first)]));
    assert.deepEqual(readId3TextFrames(p2), { TPE1: ['Muse'], TPE2: ['Muse'], TCOM: ['Chris Wolstenholme/Dominic Howard/Matthew Bellamy'] });
  });

  test('a RIFF/WAVE `id3 ` chunk is found', async () => {
    const tag = await tagOnly('inner.bin', { TPE1: 'AC/DC' }, { version: 3 });
    const id3 = await fs.readFile(tag);
    const fmt = Buffer.alloc(8 + 16); fmt.write('fmt ', 0, 'latin1'); fmt.writeUInt32LE(16, 4);
    const id3Chunk = Buffer.alloc(8); id3Chunk.write('id3 ', 0, 'latin1'); id3Chunk.writeUInt32LE(id3.length, 4);
    const data = Buffer.alloc(8); data.write('data', 0, 'latin1'); data.writeUInt32LE(0, 4);
    const riffBody = Buffer.concat([Buffer.from('WAVE', 'latin1'), fmt, data, id3Chunk, id3]);
    const riff = Buffer.alloc(8); riff.write('RIFF', 0, 'latin1'); riff.writeUInt32LE(riffBody.length, 4);
    const p = path.join(dir, 'chunk.wav');
    await fs.writeFile(p, Buffer.concat([riff, riffBody]));
    assert.deepEqual(readId3TextFrames(p), { TPE1: ['AC/DC'] });
  });

  test('a file without a tag, an unknown version, or a compressed credit frame yields null', async () => {
    const plain = path.join(dir, 'plain.bin');
    await fs.writeFile(plain, Buffer.from('not an id3 tag at all'));
    assert.equal(readId3TextFrames(plain), null);
    const p = await tagOnly('v3flags.mp3', { TPE1: 'X' }, { version: 3 });
    const buf = await fs.readFile(p);
    buf[3] = 0x05;                                    // ID3v2.5 does not exist
    await fs.writeFile(p, buf);
    assert.equal(readId3TextFrames(p), null);
    buf[3] = 0x03; buf[10 + 9] = 0x80;                // frame format flag: compression
    await fs.writeFile(p, buf);
    assert.equal(readId3TextFrames(p), null);
    assert.equal(readId3TextFrames(path.join(dir, 'missing.mp3')), null);
  });

  test('only the requested frames are read; a tag with none yields {}', async () => {
    const p = await tagOnly('none.mp3', { TIT2: 'Title', TALB: 'Album' }, { version: 3 });
    assert.deepEqual(readId3TextFrames(p), {});
    assert.deepEqual(readId3TextFrames(p, ['TALB']), { TALB: ['Album'] });
  });
});
