/**
 * Unit tests for src/torrent/metadata.js — the Tier 1 (name-parse) +
 * Tier 2 (file-list heuristics) composition. Tier 3 (partial-byte tag
 * fetch) needs a live daemon and lives in src/torrent/tag-probe.js,
 * covered separately.
 *
 * Tests exercise extractMetadata at the surface level since both
 * tiers feed into the same return shape.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { extractMetadata, analyseFileList } from '../../src/torrent/metadata.js';
import { findField } from '../../src/torrent/bencode.js';

// Build a synthetic bencoded torrent. info dict gets a `name`,
// optional `length` (single-file) or `files` (multi-file).
function makeSingleFile(name, length = 100) {
  return Buffer.from(`d4:info` + `d4:name${name.length}:${name}6:lengthi${length}ee` + 'e');
}

// Multi-file: info.files is a list of {path: [seg, seg], length}.
function makeMultiFile(topName, files) {
  let inner = `d4:name${topName.length}:${topName}5:files` + 'l';
  for (const f of files) {
    let pathList = 'l';
    for (const seg of f.path) { pathList += `${seg.length}:${seg}`; }
    pathList += 'e';
    inner += `d6:lengthi${f.length}e4:path${pathList}e`;
  }
  inner += 'ee';
  return Buffer.from(`d4:info${inner}e`);
}

describe('extractMetadata: Tier 1 (name-parse)', () => {
  test('high confidence on a well-formed torrent name', () => {
    const buf = makeMultiFile('Pink Floyd - The Dark Side of the Moon (1973) [FLAC]', [
      { path: ['01 - Speak to Me.flac'], length: 100 },
      { path: ['02 - Breathe.flac'], length: 100 },
    ]);
    const r = extractMetadata(buf);
    assert.equal(r.metadata.artist, 'Pink Floyd');
    assert.equal(r.metadata.album, 'The Dark Side of the Moon');
    assert.equal(r.metadata.year, '1973');
    assert.equal(r.confidence, 'high');
  });
  test('low confidence on a name we can barely parse', () => {
    const buf = makeSingleFile('tier3-test.flac', 1000);
    const r = extractMetadata(buf);
    assert.equal(r.confidence, 'low');
  });
});

describe('analyseFileList: Tier 2 heuristics', () => {
  test('detects album shape from track-prefixed audio files', () => {
    const buf = makeMultiFile('AlbumDir', [
      { path: ['01 - foo.flac'], length: 100 },
      { path: ['02 - bar.flac'], length: 100 },
      { path: ['03 - baz.flac'], length: 100 },
    ]);
    // Pull the parsed info dict back through to analyseFileList.
    
    const info = findField(buf, 'info').value;
    const r = analyseFileList(info);
    assert.equal(r.fileCount, 3);
    assert.equal(r.audioFileCount, 3);
    assert.equal(r.hasTrackNumberPrefixes, true);
    assert.ok(r.smallestAudio, 'smallestAudio should be present for Tier 3 handoff');
  });
  test('single-file torrent registers as 1 file', async () => {
    const buf = makeSingleFile('single.flac', 5000);
    
    const info = findField(buf, 'info').value;
    const r = analyseFileList(info);
    assert.equal(r.fileCount, 1);
    assert.equal(r.audioFileCount, 1);
  });
  test('no audio files reports audioFileCount = 0', async () => {
    const buf = makeMultiFile('Junk', [
      { path: ['readme.txt'], length: 100 },
      { path: ['cover.jpg'], length: 100 },
    ]);
    
    const info = findField(buf, 'info').value;
    const r = analyseFileList(info);
    assert.equal(r.audioFileCount, 0);
  });
});

describe('extractMetadata: Tier 1+2 composition', () => {
  test('high-confidence name + audio present → stays high', () => {
    const buf = makeMultiFile('Pink Floyd - The Wall (1979) [FLAC]', [
      { path: ['01 - In the Flesh.flac'], length: 100 },
    ]);
    const r = extractMetadata(buf);
    assert.equal(r.confidence, 'high');
    assert.equal(r.fileShape.hasAudio, true);
  });
  test('high-confidence name + NO audio → demoted', () => {
    const buf = makeMultiFile('Pink Floyd - The Wall (1979)', [
      { path: ['readme.txt'], length: 100 },
    ]);
    const r = extractMetadata(buf);
    // Tier 1 had a high read but Tier 2 vetoes because there's no
    // audio to act on. Composition demotes to 'none' to surface the
    // mismatch.
    assert.equal(r.confidence, 'none');
  });
  test('low-confidence name (no year) + track-prefixed audio → promoted to high', () => {
    // "Artist - Album" with no year matches the bare-pattern in
    // metadata.js _NAME_PATTERNS as confidence='low'. Tier 2 sees
    // track-prefixed audio → composition promotes to 'high'.
    const buf = makeMultiFile('Some Artist - Some Album', [
      { path: ['01 - Track A.flac'], length: 100 },
      { path: ['02 - Track B.flac'], length: 100 },
    ]);
    const r = extractMetadata(buf);
    assert.equal(r.confidence, 'high', `compose reason: ${r._composeReason}`);
  });
  test('exposes internal _topName and _isMultiFile for Tier 3 handoff', () => {
    const buf = makeMultiFile('TopFolder', [
      { path: ['01.flac'], length: 100 },
    ]);
    const r = extractMetadata(buf);
    assert.equal(r._topName, 'TopFolder');
    assert.equal(r._isMultiFile, true);
  });
  test('info.name truncated at 256 chars (post-audit cap)', () => {
    const longName = 'A'.repeat(2_000_000);
    const buf = makeSingleFile(longName, 100);
    const r = extractMetadata(buf);
    assert.ok(r.sourceName.length <= 256, `sourceName should be capped; got ${r.sourceName.length}`);
    assert.ok(r._topName.length <= 256);
  });
});
