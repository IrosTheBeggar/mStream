// classifyBootError() draws the crash-vs-hold line for boot failures
// (src/util/boot-errors.js): environmental causes — full disk, read-only or
// missing volume, damaged db file — produce a diagnosis the boot hold
// serves; everything else returns null and crashes exactly as before. The
// free-space probe is injected so these tests dictate the disk state
// instead of inheriting the runner's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { classifyBootError, renderHoldPage, formatBytes } from '../../src/util/boot-errors.js';

const EXISTING_DIR = os.tmpdir();
const MISSING_DIR = path.join(os.tmpdir(), 'mstream-definitely-absent', 'db');

// node:sqlite error shape (the real 2026-08-25 crash carried exactly this:
// code ERR_SQLITE_ERROR, errcode 4874, errstr 'disk I/O error').
const sqliteErr = (errcode, errstr = 'disk I/O error') =>
  Object.assign(new Error(errstr), { code: 'ERR_SQLITE_ERROR', errcode, errstr });

const fsErr = (code, message = `${code}: it broke`) =>
  Object.assign(new Error(message), { code });

const noSpace = () => ({ freeBytes: 1024, totalBytes: 100 * 2 ** 30 });
const plentySpace = () => ({ freeBytes: 500 * 2 ** 30, totalBytes: 1000 * 2 ** 30 });

test('SQLITE_IOERR_SHMSIZE (4874) on a full disk classifies as disk-full', () => {
  const d = classifyBootError(sqliteErr(4874), EXISTING_DIR, noSpace);
  assert.equal(d.reason, 'disk-full');
  assert.match(d.detail, /SHMSIZE/);
  assert.match(d.headline, /full/);
});

test('SQLITE_IOERR with plenty of space classifies as db-io, naming the subcode', () => {
  const d = classifyBootError(sqliteErr(4874), EXISTING_DIR, plentySpace);
  assert.equal(d.reason, 'db-io');
  assert.match(d.detail, /SQLITE_IOERR_SHMSIZE/);
});

test('SQLITE_IOERR with statfs unavailable stays db-io and says space is unreadable', () => {
  const d = classifyBootError(sqliteErr(4874), EXISTING_DIR, () => null);
  assert.equal(d.reason, 'db-io');
  assert.match(d.detail, /free space unreadable/);
});

test('SQLITE_FULL (13) classifies as disk-full regardless of statfs', () => {
  const d = classifyBootError(sqliteErr(13, 'database or disk is full'), EXISTING_DIR, plentySpace);
  assert.equal(d.reason, 'disk-full');
});

test('SQLITE_CORRUPT and SQLITE_NOTADB classify as db-damaged with a data-loss-aware hint', () => {
  for (const code of [11, 26]) {
    const d = classifyBootError(sqliteErr(code, 'file is not a database'), EXISTING_DIR, plentySpace);
    assert.equal(d.reason, 'db-damaged', `errcode ${code}`);
    assert.match(d.hint, /playlists/, 'the hint must warn what a fresh start loses');
  }
});

test('SQLITE_READONLY classifies as db-unwritable', () => {
  const d = classifyBootError(sqliteErr(8, 'attempt to write a readonly database'), EXISTING_DIR, plentySpace);
  assert.equal(d.reason, 'db-unwritable');
});

test('SQLITE_BUSY and SQLITE_LOCKED classify as db-locked', () => {
  for (const code of [5, 6]) {
    assert.equal(classifyBootError(sqliteErr(code, 'database is locked'), EXISTING_DIR, plentySpace).reason,
      'db-locked', `errcode ${code}`);
  }
});

test('SQLITE_CANTOPEN splits on whether the db directory still exists', () => {
  assert.equal(classifyBootError(sqliteErr(14, 'unable to open database file'), EXISTING_DIR, plentySpace).reason,
    'db-unwritable');
  assert.equal(classifyBootError(sqliteErr(14, 'unable to open database file'), MISSING_DIR, plentySpace).reason,
    'db-missing-dir');
});

test('non-environmental SQLite codes are not holdable', () => {
  // 1 = SQLITE_ERROR (a migration typo), 787 = SQLITE_CONSTRAINT_FOREIGNKEY.
  for (const code of [1, 787]) {
    assert.equal(classifyBootError(sqliteErr(code, 'SQL logic error'), EXISTING_DIR, plentySpace), null,
      `errcode ${code}`);
  }
});

test('the bun:sqlite shape (errno instead of errcode) still classifies', () => {
  const err = Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errno: 4874 });
  const d = classifyBootError(err, EXISTING_DIR, noSpace);
  assert.equal(d.reason, 'disk-full');
});

test('plain filesystem errors map to their environmental classes', () => {
  assert.equal(classifyBootError(fsErr('ENOSPC'), EXISTING_DIR, noSpace).reason, 'disk-full');
  assert.equal(classifyBootError(fsErr('EDQUOT'), EXISTING_DIR, noSpace).reason, 'disk-full');
  assert.equal(classifyBootError(fsErr('EACCES'), EXISTING_DIR, plentySpace).reason, 'db-unwritable');
  assert.equal(classifyBootError(fsErr('EROFS'), EXISTING_DIR, plentySpace).reason, 'db-unwritable');
  assert.equal(classifyBootError(fsErr('EPERM'), EXISTING_DIR, plentySpace).reason, 'db-unwritable');
  assert.equal(classifyBootError(fsErr('EMFILE'), EXISTING_DIR, plentySpace).reason, 'fs-limit');
  assert.equal(classifyBootError(fsErr('EIO'), EXISTING_DIR, plentySpace).reason, 'db-io');
});

test('ENOENT is holdable only when the db directory itself is gone', () => {
  assert.equal(classifyBootError(fsErr('ENOENT'), EXISTING_DIR, plentySpace), null);
  assert.equal(classifyBootError(fsErr('ENOENT'), MISSING_DIR, plentySpace).reason, 'db-missing-dir');
});

test('unrecognized errors are never holdable', () => {
  assert.equal(classifyBootError(new Error('undefined is not a function'), EXISTING_DIR, plentySpace), null);
  assert.equal(classifyBootError(new TypeError('boom'), EXISTING_DIR, plentySpace), null);
  assert.equal(classifyBootError(null, EXISTING_DIR, plentySpace), null);
});

test('renderHoldPage escapes diagnosis text and names the retry cadence', () => {
  const html = renderHoldPage({
    headline: 'mStream cannot start: <script>alert(1)</script>',
    detail: 'a & b < c',
    hint: 'do "this"',
  }, { retrySeconds: 15 });
  assert.ok(!html.includes('<script>alert'), 'headline must be escaped');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /a &amp; b &lt; c/);
  assert.match(html, /every 15/);
  assert.match(html, /refreshes itself/);
});

test('formatBytes covers the ranges the diagnosis prints', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.match(formatBytes(5 * 2 ** 20), /5\.0 MB/);
  assert.match(formatBytes(3 * 2 ** 30), /3\.0 GB/);
  assert.equal(formatBytes(-1), 'unknown');
});
