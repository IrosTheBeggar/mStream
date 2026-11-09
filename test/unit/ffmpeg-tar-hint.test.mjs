/**
 * tarFailureHint (src/util/ffmpeg-bootstrap.js): the ffmpeg bootstrap unpacks
 * BtbN's .tar.xz with tar, which delegates to the xz tool — absent on minimal
 * images (Debian 11 slim), where the log read "tar failed (2): xz: Cannot
 * exec" and nothing said what to install.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { tarFailureHint } from '../../src/util/ffmpeg-bootstrap.js';

describe('ffmpeg-bootstrap: tarFailureHint', () => {
  test('names the missing xz tool', () => {
    assert.match(tarFailureHint('tar (child): xz: Cannot exec: No such file or directory\ntar (child): Error is not recoverable: exiting now\n'),
      /needs the xz tool \(debian\/ubuntu: apt install xz-utils/);
    assert.match(tarFailureHint('tar: xz: not found'), /xz tool/);
  });

  test('says nothing about xz for other tar failures', () => {
    assert.equal(tarFailureHint('tar: ffmpeg-x/bin/ffmpeg: Not found in archive'), '');
    assert.equal(tarFailureHint(''), '');
  });
});
