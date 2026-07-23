import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCueSheet, tracksForAudioFile } from '../../src/util/cue-parser.js';

const EAC_CUE = `\uFEFFREM GENRE Electronic
REM DATE 1998
PERFORMER "Boards of Canada"
TITLE "Music Has the Right to Children"
FILE "album.wav" WAVE
  TRACK 01 AUDIO
    TITLE "Wildlife Analysis"
    PERFORMER "Boards of Canada"
    INDEX 01 00:00:00
  TRACK 02 AUDIO
    TITLE "An Eagle in Your Mind"
    INDEX 00 01:15:00
    INDEX 01 01:17:37
  TRACK 03 AUDIO
    TITLE "The Color of the Fire"
    INDEX 01 07:36:74
`;

describe('cue-parser', () => {
  test('parses an EAC-style single-file cue (BOM, quotes, pregap, frames)', () => {
    const files = parseCueSheet(EAC_CUE);
    assert.equal(files.length, 1);
    assert.equal(files[0].file, 'album.wav');
    const tracks = files[0].tracks;
    assert.equal(tracks.length, 3);

    assert.deepEqual(tracks.map(t => t.title),
      ['Wildlife Analysis', 'An Eagle in Your Mind', 'The Color of the Fire']);
    assert.equal(tracks[0].startSec, 0);
    // INDEX 01 wins over INDEX 00: 1*60 + 17 + 37/75
    assert.ok(Math.abs(tracks[1].startSec - (77 + 37 / 75)) < 1e-9);
    // frames: 7*60 + 36 + 74/75
    assert.ok(Math.abs(tracks[2].startSec - (456 + 74 / 75)) < 1e-9);
    // album-level TITLE must not leak into track 1
    assert.equal(tracks[0].title, 'Wildlife Analysis');
  });

  test('single-FILE cue applies regardless of referenced name (wav vs flac rip)', () => {
    const files = parseCueSheet(EAC_CUE);
    const tracks = tracksForAudioFile(files, 'album.flac');
    assert.equal(tracks.length, 3);
  });

  test('multi-FILE cue binds by referenced filename, case-insensitively', () => {
    const cue = [
      'FILE "Disc1.flac" WAVE',
      '  TRACK 01 AUDIO',
      '    TITLE "One"',
      '    INDEX 01 00:00:00',
      'FILE "Disc2.flac" WAVE',
      '  TRACK 01 AUDIO',
      '    TITLE "Two"',
      '    INDEX 01 00:00:00',
      '  TRACK 02 AUDIO',
      '    TITLE "Three"',
      '    INDEX 01 04:20:00',
    ].join('\r\n');
    const files = parseCueSheet(cue);
    assert.equal(files.length, 2);
    assert.deepEqual(tracksForAudioFile(files, 'disc2.FLAC').map(t => t.title), ['Two', 'Three']);
    assert.deepEqual(tracksForAudioFile(files, 'disc1.flac').map(t => t.title), ['One']);
    assert.deepEqual(tracksForAudioFile(files, 'unrelated.flac'), []);
  });

  test('tolerates junk: indexless tracks dropped, unknown commands skipped, INDEX 00 fallback', () => {
    const cue = [
      'CATALOG 1234567890123',
      'FILE noquotes.mp3 MP3',
      'TRACK 01 AUDIO',
      'FLAGS DCP',
      'TITLE "No Index"',       // dropped: no INDEX at all
      'TRACK 02 AUDIO',
      'TITLE "Pregap Only"',
      'INDEX 00 00:30:00',      // used as fallback start
      'REM COMMENT whatever',
    ].join('\n');
    const files = parseCueSheet(cue);
    assert.equal(files.length, 1);
    assert.equal(files[0].file, 'noquotes.mp3');
    assert.equal(files[0].tracks.length, 1);
    assert.equal(files[0].tracks[0].title, 'Pregap Only');
    assert.equal(files[0].tracks[0].startSec, 30);
  });

  test('empty / garbage input yields no sections', () => {
    assert.deepEqual(parseCueSheet(''), []);
    assert.deepEqual(parseCueSheet('not a cue sheet\nat all'), []);
    assert.deepEqual(tracksForAudioFile([], 'x.flac'), []);
  });

  test('long-mix minutes past 99 parse (mm has no two-digit cap)', () => {
    const cue = 'FILE "mix.mp3" MP3\nTRACK 01 AUDIO\nINDEX 01 132:05:00\n';
    const files = parseCueSheet(cue);
    assert.equal(files[0].tracks[0].startSec, 132 * 60 + 5);
  });
});
