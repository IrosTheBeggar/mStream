/**
 * Tests for the containment check behind absoluteToVpath()
 * (src/api/server-playback.js).
 *
 * absoluteToVpath maps an absolute path reported by the audio engine back to
 * a library-relative vpath for the frontend. It used to decide "is this file
 * in that library?" with a plain startsWith, which is true for sibling
 * directories that merely share a prefix — a library at "/music" claimed
 * "/music-videos/clip.mp3" and produced a vpath containing "..".
 *
 * isWithin is exported purely so this boundary can be tested without
 * standing up a database.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';

import { isWithin } from '../../src/api/server-playback.js';

describe('isWithin', () => {
  const join = (...parts) => parts.join(path.sep);

  test('accepts a file inside the library', () => {
    assert.equal(isWithin(join('C:', 'Music', 'song.mp3'), join('C:', 'Music')), true);
    assert.equal(
      isWithin(join('C:', 'Music', 'Artist', 'Album', 'song.mp3'), join('C:', 'Music')),
      true,
    );
  });

  test('accepts the library root itself', () => {
    assert.equal(isWithin(join('C:', 'Music'), join('C:', 'Music')), true);
  });

  test('rejects a sibling directory that shares a prefix', () => {
    // The regression: "C:\Music" is a string prefix of "C:\MusicVideos".
    assert.equal(isWithin(join('C:', 'MusicVideos', 'clip.mp3'), join('C:', 'Music')), false);
    assert.equal(isWithin(join('C:', 'Music2', 'song.mp3'), join('C:', 'Music')), false);
  });

  test('rejects an unrelated path', () => {
    assert.equal(isWithin(join('D:', 'Other', 'song.mp3'), join('C:', 'Music')), false);
  });

  test('tolerates a library root stored with a trailing separator', () => {
    assert.equal(isWithin(join('C:', 'Music', 'song.mp3'), join('C:', 'Music') + path.sep), true);
    assert.equal(isWithin(join('C:', 'MusicVideos', 'clip.mp3'), join('C:', 'Music') + path.sep), false);
  });
});
