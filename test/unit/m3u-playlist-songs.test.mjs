/**
 * util/m3u.js readPlaylistSongs: an .m3u's songs, as paths relative to it.
 * The file explorer's m3u route lists them as rows and the m3u download
 * zips them.
 *
 * m3u8-parser fills `segments` only once it meets an #EXTINF tag, so a
 * plain list (paths alone, maybe under an #EXTM3U header) is read with a
 * line split instead. That split kept every line that was not empty: the
 * header came back as a song named '#EXTM3U' (its Play and Instant Mix
 * then failed on it), a comment did too, and a path kept the spaces around
 * it. By the format a line that starts with '#' is a directive or a
 * comment, so the split now reads lines the way the parser does: trimmed,
 * with blank lines and '#' lines skipped.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readPlaylistSongs } from '../../src/util/m3u.js';

describe('readPlaylistSongs', () => {
  let dir;
  let n = 0;
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-m3u-'));
  });
  after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  // The songs of a playlist file holding `lines`, joined by `eol`.
  async function songsOf(lines, eol = '\n') {
    const file = path.join(dir, `list-${n++}.m3u`);
    await fs.writeFile(file, lines.join(eol), 'utf8');
    return readPlaylistSongs(file);
  }

  test('a list with a header and no #EXTINF gives its songs, not the header (LF and CRLF)', async () => {
    const lines = ['#EXTM3U', 'Dolo.mp3', '6AM.mp3', 'SkyWalk.mp3', 'The Hangout.mp3', ''];
    const songs = ['Dolo.mp3', '6AM.mp3', 'SkyWalk.mp3', 'The Hangout.mp3'];
    assert.deepEqual(await songsOf(lines, '\n'), songs);
    assert.deepEqual(await songsOf(lines, '\r\n'), songs);
    // A header and nothing else is an empty playlist, as is a BOM before it.
    assert.deepEqual(await songsOf(['#EXTM3U', ''], '\r\n'), []);
    assert.deepEqual(await songsOf(['\uFEFF#EXTM3U', 'Dolo.mp3']), ['Dolo.mp3']);
  });

  test('comments and other directives are not songs, and the spaces around a path are not part of it', async () => {
    const songs = await songsOf([
      '#EXTM3U',
      '# a road trip',
      '#PLAYLIST:Road trip',
      '  Dolo.mp3  ',
      '',
      '   ',
      '\tsub dir/6AM.mp3\t',
      '  #EXTGRP:Side B',
      'The Hangout.mp3',
    ], '\r\n');
    assert.deepEqual(songs, ['Dolo.mp3', 'sub dir/6AM.mp3', 'The Hangout.mp3']);
  });

  test('a list with #EXTINF still reads through the parser, and a plain list with no header is unchanged', async () => {
    assert.deepEqual(await songsOf([
      '#EXTM3U',
      '#EXTINF:211,Boukmanflow - Dolo',
      'Dolo.mp3',
      '6AM.mp3',
      '#EXTINF:-1,The Hangout',
      'sub\\The Hangout.mp3',
    ]), ['Dolo.mp3', '6AM.mp3', 'sub/The Hangout.mp3']);
    assert.deepEqual(await songsOf(['Dolo.mp3', 'sub\\6AM.mp3', ''], '\r\n'), ['Dolo.mp3', 'sub/6AM.mp3']);
  });

  test('absolute paths and traversal are still rejected, with spaces around them or not', async () => {
    const outside = [
      '/etc/passwd',
      '  /etc/passwd  ',
      '\\\\server\\share\\x.mp3',
      'C:\\Music\\x.mp3',
      ' c:/Music/x.mp3',
      '../outside.mp3',
      '\t..\\up.mp3',
      'sub/../../outside.mp3',
    ];
    // Read by the line split (no #EXTINF) and by the parser (#EXTINF before each).
    assert.deepEqual(await songsOf(['#EXTM3U', 'Dolo.mp3', ...outside]), ['Dolo.mp3']);
    assert.deepEqual(await songsOf(['Dolo.mp3', ...outside], '\r\n'), ['Dolo.mp3']);
    assert.deepEqual(await songsOf(['#EXTM3U', ...['Dolo.mp3', ...outside].flatMap((l) => ['#EXTINF:1,x', l])]), ['Dolo.mp3']);
  });
});
