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
    assert.match(tarFailureHint("tar: can't execute 'xz': No such file or directory"), /xz tool/);
    assert.match(tarFailureHint('tar (child): /usr/bin/xz: Cannot exec: No such file or directory'), /xz tool/);
  });

  test('says nothing about xz for other tar failures', () => {
    assert.equal(tarFailureHint('tar: ffmpeg-x/bin/ffmpeg: Not found in archive'), '');
    assert.equal(tarFailureHint(''), '');
  });

  // Every complaint about the archive itself carries its ".tar.xz" name; that
  // is not the xz tool, and the hint would send the operator the wrong way.
  test('the archive\'s own .tar.xz name is not the xz tool', () => {
    const ARCHIVE = 'ffmpeg-n7.1-latest-linux64-gpl-7.1.tar.xz';
    assert.equal(tarFailureHint(`tar: /tmp/mstream-ffmpeg/${ARCHIVE}: Cannot open: No such file or directory\ntar: Error is not recoverable: exiting now\n`), '');
    assert.equal(tarFailureHint(`tar: ${ARCHIVE}: Not found in archive`), '');
    assert.equal(tarFailureHint('tar: /opt/xz/ffmpeg.tar: Cannot open: No such file or directory'), '');
    // xz ran and rejected the bytes: present, so nothing to install.
    assert.equal(tarFailureHint('xz: (stdin): File format not recognized\ntar: Child returned status 1\n'), '');
  });
});
