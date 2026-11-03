/**
 * src/api/ytdl-jobs.js — the Youtube DL route's job list, against the pure
 * module with an injected clock: ids, one account's entries newest first
 * with the account left out, settling, a day's retention for settled
 * entries (never a running one), the per-account cap, and the words a
 * failure may show (no server paths).
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as jobs from '../../src/api/ytdl-jobs.js';

const T0 = 1_800_000_000_000;
const add = (userId, at, extra = {}) => jobs.create({
  userId, pid: 4000 + at % 1000, url: 'https://www.youtube.com/watch?v=x', directory: 'inbox', outputCodec: 'mp3', now: at, ...extra,
});

describe('ytdl jobs', () => {
  beforeEach(() => jobs._resetForTests());

  test('an entry: a string id of its own, every field the clients read, running until it settles', () => {
    const a = add(1, T0, { fileName: 'Remote_Hit.mp3' });
    const b = add(1, T0 + 1);
    assert.equal(typeof a.id, 'string');
    assert.ok(a.id.length >= 16);
    assert.notEqual(a.id, b.id);
    const [entry] = jobs.listFor(1, { now: T0 + 2 }).filter((j) => j.id === a.id);
    assert.deepEqual(entry, {
      id: a.id, pid: a.pid, url: 'https://www.youtube.com/watch?v=x', directory: 'inbox', outputCodec: 'mp3',
      status: 'downloading', startTime: T0, endTime: null, fileName: 'Remote_Hit.mp3', filePath: null,
      downloadId: null, error: null, reason: null,
    });
    assert.ok(!('userId' in entry), 'the account is never sent');
    assert.equal(add(1, T0 + 3, { pid: undefined }).pid, null, 'a spawn that got no pid reads null, not undefined');
  });

  test('one account\'s entries only, newest first', () => {
    const old = add(1, T0);
    const other = add(2, T0 + 5);
    const fresh = add(1, T0 + 10);
    assert.deepEqual(jobs.listFor(1, { now: T0 + 20 }).map((j) => j.id), [fresh.id, old.id]);
    assert.deepEqual(jobs.listFor(2, { now: T0 + 20 }).map((j) => j.id), [other.id]);
    assert.deepEqual(jobs.listFor(3, { now: T0 + 20 }), []);
    assert.deepEqual(jobs.listFor(null, { now: T0 + 20 }), [], 'null is an account of its own, not "everyone"');
  });

  test('complete and fail settle an entry with its end time; a reason outside the codes reads null; long words are cut', () => {
    const ok = add(1, T0, { fileName: 'Guess.mp3' });
    jobs.complete(ok, { filePath: 'inbox/Remote_Hit.mp3', fileName: 'Remote_Hit.mp3', downloadId: 7, now: T0 + 1000 });
    assert.deepEqual([ok.status, ok.endTime, ok.filePath, ok.fileName, ok.downloadId, ok.error, ok.reason],
      ['complete', T0 + 1000, 'inbox/Remote_Hit.mp3', 'Remote_Hit.mp3', 7, null, null]);

    const bad = add(1, T0);
    jobs.fail(bad, { error: 'Video unavailable', reason: 'unavailable', now: T0 + 2000 });
    assert.deepEqual([bad.status, bad.endTime, bad.error, bad.reason, bad.filePath], ['error', T0 + 2000, 'Video unavailable', 'unavailable', null]);

    for (const reason of ['exists', 'too-big', 'too-long', 'live', 'unavailable']) {
      assert.equal(jobs.fail(add(1, T0), { error: 'x', reason }).reason, reason);
    }
    assert.equal(jobs.fail(add(1, T0), { error: 'x', reason: 'adding' }).reason, null);
    assert.equal(jobs.fail(add(1, T0), { error: '' }).error, 'the download failed');
    const long = jobs.fail(add(1, T0), { error: 'y'.repeat(2000) }).error;
    assert.equal(long.length, jobs.MAX_ERROR_CHARS);
    assert.ok(long.endsWith('…'));
  });

  test('settled entries are kept a day after they settle; a running one is never dropped', () => {
    const running = add(1, T0);
    const settled = add(1, T0);
    jobs.complete(settled, { filePath: 'inbox/a.mp3', fileName: 'a.mp3', now: T0 + 60_000 });
    const day = jobs.SETTLED_TTL_MS;
    assert.equal(jobs.listFor(1, { now: T0 + 60_000 + day }).length, 2, 'a day to the millisecond: still there');
    assert.deepEqual(jobs.listFor(1, { now: T0 + 60_001 + day }).map((j) => j.id), [running.id], 'then gone');
    assert.deepEqual(jobs.listFor(1, { now: T0 + 30 * day }).map((j) => j.id), [running.id], 'running: kept however long');
  });

  test('each account keeps its newest settled entries up to the cap; another account\'s are not counted', () => {
    const n = jobs.MAX_SETTLED_PER_USER;
    const ids = [];
    for (let i = 0; i < n + 5; i++) {
      const j = add(1, T0 + i);
      jobs.fail(j, { error: 'x', now: T0 + i });
      ids.push(j.id);
    }
    const running = add(1, T0 + n + 10);
    const theirs = add(2, T0);
    jobs.fail(theirs, { error: 'x', now: T0 });
    const listed = jobs.listFor(1, { now: T0 + n + 20 });
    assert.equal(listed.length, n + 1, 'the cap, plus the running one');
    assert.equal(listed[0].id, running.id);
    assert.deepEqual(listed.slice(1).map((j) => j.id), ids.slice(5).reverse(), 'the oldest five went');
    assert.equal(jobs.listFor(2, { now: T0 + n + 20 }).length, 1);
  });

  test('publicMessage: the staging folder and the library\'s place on disk never reach the caller', () => {
    const stage = path.join(path.sep, 'srv', 'mstream', 'save', 'discover-staging', 'job-ytdl-Ab12Cd');
    const lib = path.join(path.sep, 'mnt', 'music', 'Inbox');
    const pairs = [[stage, ''], [lib, 'inbox'], [path.join(path.sep, 'mnt', 'music'), 'music'], [null, 'ffmpeg']];
    assert.equal(jobs.publicMessage(new Error(`ffmpeg exited with code 1: ${path.join(stage, 'Remote_Hit.mp3')}: Invalid data found`), pairs),
      'ffmpeg exited with code 1: Remote_Hit.mp3: Invalid data found');
    assert.equal(jobs.publicMessage(new Error(`a file named X.mp3 already exists in ${lib} — nothing was replaced`), pairs),
      'a file named X.mp3 already exists in inbox — nothing was replaced');
    assert.equal(jobs.publicMessage(new Error(`could not write ${path.join(lib, 'X.mp3')}`), pairs), 'could not write inbox/X.mp3');
    assert.equal(jobs.publicMessage(new Error(`cannot open ${path.join(path.sep, 'mnt', 'music', 'Other', 'y.mp3')}`), pairs), 'cannot open music/Other/y.mp3');
    // Both separators, whatever the platform wrote.
    assert.equal(jobs.publicMessage(new Error('C:\\data\\stage\\job-ytdl-1\\Song.mp3 vanished'), [['C:\\data\\stage\\job-ytdl-1', '']]), 'Song.mp3 vanished');
    // yt-dlp is Python: its OS errors quote a Windows path as a repr, with
    // every backslash doubled.
    const win = [['C:\\data\\stage\\job-ytdl-1', ''], ['D:\\Music\\Inbox', 'inbox']];
    assert.equal(jobs.publicMessage(new Error('unable to write data: [Errno 28] No space left on device: \'C:\\\\data\\\\stage\\\\job-ytdl-1\\\\Song.webm.part\''), win),
      'unable to write data: [Errno 28] No space left on device: \'Song.webm.part\'');
    assert.equal(jobs.publicMessage(new Error('[Errno 13] Permission denied: \'D:\\\\Music\\\\Inbox\\\\Song.mp3\''), win), '[Errno 13] Permission denied: \'inbox/Song.mp3\'');
    assert.equal(jobs.publicMessage(new Error('[youtube] x: Video unavailable'), pairs), '[youtube] x: Video unavailable', 'words without paths are left alone');
    assert.equal(jobs.publicMessage('a string', pairs), 'a string');
    assert.equal(jobs.publicMessage(null, pairs), 'the download failed');
  });
});
