/**
 * Unit tests for src/torrent/seed-existing.js.
 *
 * Each test builds a real on-disk directory tree under a temp dir,
 * constructs a synthetic .torrent that points at it, and asks
 * checkFilesExist to score the match. Covers single-file, multi-file,
 * partial-match, size-mismatch, and the missing-files cap.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { checkFilesExist } from '../src/torrent/seed-existing.js';

const B = (s) => Buffer.from(s);

// Build a bencoded .torrent buffer for a single-file torrent.
function makeSingleFile(name, length) {
  const inner = `d4:name${name.length}:${name}6:lengthi${length}ee`;
  return B(`d4:info${inner}e`);
}

// Build a multi-file torrent. files = [{path: [seg], length: N}, ...]
function makeMultiFile(topName, files) {
  let inner = `d4:name${topName.length}:${topName}5:files` + 'l';
  for (const f of files) {
    let pathList = 'l';
    for (const seg of f.path) { pathList += `${seg.length}:${seg}`; }
    pathList += 'e';
    inner += `d6:lengthi${f.length}e4:path${pathList}e`;
  }
  inner += 'ee';
  return B(`d4:info${inner}e`);
}

let tmpDir;
before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-existing-'));
});
after(async () => {
  try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* leave it */ }
});

// Lay out a directory tree under tmpDir/<sub>. files = {relPath: 'a/b', size: N}
async function layOut(sub, files) {
  const root = path.join(tmpDir, sub);
  await fs.mkdir(root, { recursive: true });
  for (const f of files) {
    const full = path.join(root, f.relPath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, Buffer.alloc(f.size, 0));
  }
  return root;
}

describe('single-file torrents', () => {
  test('happy path: file present with matching size', async () => {
    const root = await layOut('s1', [{ relPath: 'Sintel.mkv', size: 1234 }]);
    const meta = makeSingleFile('Sintel.mkv', 1234);
    const r = await checkFilesExist(meta, root);
    assert.equal(r.allMatch, true);
    assert.equal(r.matched, 1);
    assert.equal(r.total, 1);
    assert.equal(r.missing.length, 0);
    assert.equal(r.matchedRoot, path.join(root, 'Sintel.mkv'));
    assert.equal(r.isMulti, false);
  });

  test('size mismatch → no match', async () => {
    const root = await layOut('s2', [{ relPath: 'Sintel.mkv', size: 500 }]);
    const meta = makeSingleFile('Sintel.mkv', 1234);
    const r = await checkFilesExist(meta, root);
    assert.equal(r.allMatch, false);
    assert.equal(r.matched, 0);
    assert.deepEqual(r.missing, ['Sintel.mkv']);
  });

  test('file missing → no match', async () => {
    const root = await layOut('s3', []);  // empty
    const meta = makeSingleFile('Sintel.mkv', 1234);
    const r = await checkFilesExist(meta, root);
    assert.equal(r.allMatch, false);
    assert.equal(r.matched, 0);
    assert.equal(r.matchedRoot, null);
  });
});

describe('multi-file torrents', () => {
  test('happy path: every file under <root>/<topName>/ matches', async () => {
    const root = await layOut('m1', [
      { relPath: 'Sintel/01.flac', size: 100 },
      { relPath: 'Sintel/02.flac', size: 200 },
      { relPath: 'Sintel/cover.jpg', size: 50 },
    ]);
    const meta = makeMultiFile('Sintel', [
      { path: ['01.flac'], length: 100 },
      { path: ['02.flac'], length: 200 },
      { path: ['cover.jpg'], length: 50 },
    ]);
    const r = await checkFilesExist(meta, root);
    assert.equal(r.allMatch, true);
    assert.equal(r.matched, 3);
    assert.equal(r.total, 3);
    assert.equal(r.topName, 'Sintel');
    assert.equal(r.matchedRoot, path.join(root, 'Sintel'));
  });

  test('nested directories preserved', async () => {
    const root = await layOut('m2', [
      { relPath: 'Album/Disc 1/01.flac', size: 100 },
      { relPath: 'Album/Disc 2/01.flac', size: 200 },
    ]);
    const meta = makeMultiFile('Album', [
      { path: ['Disc 1', '01.flac'], length: 100 },
      { path: ['Disc 2', '01.flac'], length: 200 },
    ]);
    const r = await checkFilesExist(meta, root);
    assert.equal(r.allMatch, true);
  });

  test('partial match: 2 of 3 files present', async () => {
    const root = await layOut('m3', [
      { relPath: 'Album/01.flac', size: 100 },
      { relPath: 'Album/02.flac', size: 200 },
      // 03.flac intentionally missing
    ]);
    const meta = makeMultiFile('Album', [
      { path: ['01.flac'], length: 100 },
      { path: ['02.flac'], length: 200 },
      { path: ['03.flac'], length: 300 },
    ]);
    const r = await checkFilesExist(meta, root);
    assert.equal(r.allMatch, false);
    assert.equal(r.matched, 2);
    assert.equal(r.total, 3);
    assert.deepEqual(r.missing, ['03.flac']);
    assert.equal(r.matchedRoot, null);  // null when not all matched
  });

  test('one file with wrong size → partial', async () => {
    const root = await layOut('m4', [
      { relPath: 'Album/01.flac', size: 100 },
      { relPath: 'Album/02.flac', size: 999 },  // expected 200
    ]);
    const meta = makeMultiFile('Album', [
      { path: ['01.flac'], length: 100 },
      { path: ['02.flac'], length: 200 },
    ]);
    const r = await checkFilesExist(meta, root);
    assert.equal(r.matched, 1);
    assert.deepEqual(r.missing, ['02.flac']);
  });

  test('files extracted WITHOUT the top dir → no match (v1 limitation)', async () => {
    // Operator extracted to <root>/<file>... directly without an
    // info.name subdirectory. We only check <root>/<info.name>/...
    // in v1, so this case correctly reports no match.
    const root = await layOut('m5', [
      { relPath: '01.flac', size: 100 },
      { relPath: '02.flac', size: 200 },
    ]);
    const meta = makeMultiFile('Album', [
      { path: ['01.flac'], length: 100 },
      { path: ['02.flac'], length: 200 },
    ]);
    const r = await checkFilesExist(meta, root);
    assert.equal(r.allMatch, false);
    assert.equal(r.matched, 0);
  });

  test('missing files array capped at 20 entries', async () => {
    const root = await layOut('m6', []);  // empty — every file will be "missing"
    const files = [];
    for (let i = 0; i < 50; i++) {
      files.push({ path: [`${i}.flac`], length: 100 });
    }
    const meta = makeMultiFile('Album', files);
    const r = await checkFilesExist(meta, root);
    assert.equal(r.matched, 0);
    assert.equal(r.total, 50);
    assert.equal(r.missing.length, 20, 'missing array should be capped at 20');
  });
});

describe('error handling', () => {
  test('throws on metainfo with no info dict', async () => {
    const buf = B('d4:size4:tinye');  // valid bencode, no info
    await assert.rejects(
      () => checkFilesExist(buf, '/tmp'),
      /no info dict/,
    );
  });
});
