/**
 * Unit tests for lrcToSearchText (src/api/subsonic/lrc-parser.js) — the
 * V59 derivation of tracks.lyrics_search_text from synced LRC.
 *
 * The contract under test (see the function's doc comment):
 *   - metadata tag lines ([ar:], [ti:], [offset:+500], …) are dropped
 *   - leading [mm:ss(.xx)] stamps are peeled, multi-stamp lines included
 *   - inline <mm:ss.xx> word stamps (enhanced LRC) are blanked
 *   - everything else survives VERBATIM in line order — no per-stamp
 *     duplication, no time-sort
 *   - null (never '') when nothing survives
 *
 * The Rust mirror (rust-parser/src/main.rs lrc_to_search_text) is held to
 * byte-parity by test/scanner/lyrics-parity.test.mjs; these tests pin the
 * JS reference behaviour the mirror is measured against.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { lrcToSearchText } from '../../src/api/subsonic/lrc-parser.js';

describe('lrcToSearchText basics', () => {
  test('null / empty / non-string inputs → null', () => {
    assert.equal(lrcToSearchText(null), null);
    assert.equal(lrcToSearchText(undefined), null);
    assert.equal(lrcToSearchText(''), null);
    assert.equal(lrcToSearchText(42), null);
  });

  test('plain LRC: stamps peeled, words and line order kept', () => {
    const lrc = '[00:22.10]I do not know about you\n[00:26.45]I am feeling twenty two';
    assert.equal(lrcToSearchText(lrc),
      'I do not know about you\nI am feeling twenty two');
  });

  test('no timestamp digits survive (the V53 pollution bug)', () => {
    const lrc = '[00:22.10]hello\n[01:45.99]world';
    const out = lrcToSearchText(lrc);
    assert.doesNotMatch(out, /\d/, 'no digit from any stamp may survive');
  });

  test('lyric words that ARE numbers survive', () => {
    assert.equal(lrcToSearchText('[00:10.00]I was 22 in 1979'), 'I was 22 in 1979');
  });

  test('whitespace-only and blank lines are dropped', () => {
    assert.equal(lrcToSearchText('[00:01.00]one\n\n   \n[00:02.00]two'), 'one\ntwo');
  });

  test('stamp-only lines (instrumental breaks) are dropped', () => {
    assert.equal(lrcToSearchText('[00:01.00]words\n[00:17.00]\n[00:20.00]more'), 'words\nmore');
  });

  test('all-stamps/all-tags input → null, not empty string', () => {
    assert.equal(lrcToSearchText('[ar:Someone]\n[00:01.00]\n[00:02.00]'), null);
  });
});

describe('lrcToSearchText metadata tags', () => {
  test('header tag lines are dropped, including their words', () => {
    const lrc = '[ar:Taylor Swift]\n[ti:Twenty Two]\n[al:Red]\n[00:01.00]real line';
    assert.equal(lrcToSearchText(lrc), 'real line');
  });

  test('offset / length / lang / tool forms are dropped', () => {
    const lrc = '[offset:+250]\n[length:03:45]\n[lang:en]\n[tool:foobar]\n[00:01.00]kept';
    assert.equal(lrcToSearchText(lrc), 'kept');
  });

  test('tag keys match case-insensitively', () => {
    assert.equal(lrcToSearchText('[AR:Loud Artist]\n[00:01.00]kept'), 'kept');
  });

  test('unknown bracket forms are NOT tags and survive verbatim', () => {
    const lrc = '[Chorus]\n[not:a:tag]still here\n[8]also here';
    assert.equal(lrcToSearchText(lrc), '[Chorus]\n[not:a:tag]still here\n[8]also here');
  });
});

describe('lrcToSearchText stamp forms', () => {
  test('multi-stamp compaction lines keep ONE copy of the text', () => {
    assert.equal(lrcToSearchText('[00:15.00][00:45.00]Chorus once'), 'Chorus once');
  });

  test('multi-stamp with spaces between stamps still peels', () => {
    assert.equal(lrcToSearchText('[00:15.00] [00:45.00]Chorus once'), 'Chorus once');
  });

  test('short, colon-frac, millisecond and 3-digit-minute forms all peel', () => {
    const lrc = '[1:2.3]a\n[99:59:99]b\n[00:20.123]c\n[123:45.678]d\n[00:15]e';
    assert.equal(lrcToSearchText(lrc), 'a\nb\nc\nd\ne');
  });

  test('out-of-range forms are not stamps and survive', () => {
    // 4-digit minutes / 3-digit seconds / 4-digit fraction — the JS
    // TIMESTAMP_RE rejects all three, so the text is kept as-is.
    const lrc = '[1234:56]x\n[12:345]y\n[12:34.5678]z';
    assert.equal(lrcToSearchText(lrc), '[1234:56]x\n[12:345]y\n[12:34.5678]z');
  });

  test('enhanced-LRC inline word stamps are blanked', () => {
    assert.equal(
      lrcToSearchText('[00:12.00]<00:12.00>Never <00:12.50>gonna <00:13.00>give'),
      'Never gonna give');
  });

  test('non-stamp angle brackets survive', () => {
    assert.equal(lrcToSearchText('[00:01.00]a <heart> b'), 'a <heart> b');
  });
});

describe('lrcToSearchText whitespace + encoding details', () => {
  test('space/tab runs collapse to one space; solo tab survives', () => {
    assert.equal(lrcToSearchText('[00:15]   spaced   out\t\twords'), 'spaced out words');
    assert.equal(lrcToSearchText('[00:15]a\tb'), 'a\tb', 'a single tab is kept');
  });

  test('leading BOM is stripped', () => {
    assert.equal(lrcToSearchText('﻿[00:01.00]first line'), 'first line');
  });

  test('CRLF input splits cleanly', () => {
    assert.equal(lrcToSearchText('[00:01.00]one\r\n[00:02.00]two'), 'one\ntwo');
  });

  test('plain unsynced fallback lines are kept in place', () => {
    const lrc = '[00:01.00]timed\nplain fallback line\n[00:05.00]more';
    assert.equal(lrcToSearchText(lrc), 'timed\nplain fallback line\nmore');
  });
});
