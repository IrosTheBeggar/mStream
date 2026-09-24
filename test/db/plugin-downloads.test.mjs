/**
 * plugin_downloads data access (src/db/plugin-downloads.js), in-process
 * against a real mstream.db in a temp dir — the DB-backed suite pattern
 * (config.setup + manager.initDB). The track rows behind `present` come
 * from the same insert helper the plug-ins use, on files that are not
 * really audio (the helper copes: empty tags, a row all the same).
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let libDir;
let manager;
let downloads;
let insertDownloadedTrack;
let removeDownloadedTrack;
let alice;
let bob;
const VPATH = 'unit-collection';

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-plugin-downloads-'));
  libDir = path.join(tmpDir, 'collection');
  fs.mkdirSync(libDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ port: 3000, storage: { dbDirectory: tmpDir } }));
  const config = await import('../../src/state/config.js');
  await config.setup(path.join(tmpDir, 'config.json'));
  config.program.storage = { ...(config.program.storage || {}), dbDirectory: tmpDir, albumArtDirectory: path.join(tmpDir, 'art') };
  fs.mkdirSync(path.join(tmpDir, 'art'), { recursive: true });
  manager = await import('../../src/db/manager.js');
  manager.initDB();
  downloads = await import('../../src/db/plugin-downloads.js');
  ({ insertDownloadedTrack, removeDownloadedTrack } = await import('../../src/db/insert-downloaded-track.js'));
  const d = manager.getDB();
  d.prepare("INSERT INTO libraries (name, root_path, type) VALUES (?, ?, 'music')").run(VPATH, libDir);
  manager.invalidateCache();
  const ins = d.prepare('INSERT INTO users (username, password, salt) VALUES (?, ?, ?)');
  alice = Number(ins.run('alice', 'h', 's').lastInsertRowid);
  bob = Number(ins.run('bob', 'h', 's').lastInsertRowid);
});

after(() => {
  try { manager.close(); } catch { /* already closed */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* windows locks */ }
  setImmediate(() => process.exit(0)); // module-level timers, like the other DB-backed suites
});

// A file in the library with a track row, the way a plug-in leaves one.
function land(relativePath) {
  const file = path.join(libDir, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `not really audio: ${relativePath}`);
  return insertDownloadedTrack({ filePath: file, vpath: VPATH, basePath: libDir, source: 'plugin:unit', log: 'unit' });
}

describe('plugin downloads data access', () => {
  test('record returns the joined row: the full library path, the account, whether the track is there', async () => {
    const inserted = await land('Nova/Night Ferry/Remote_Hit.mp3');
    const rec = downloads.record({
      plugin: 'youtube', userId: alice, jobId: 7, vpath: VPATH, relativePath: inserted.relativePath,
      fileHash: inserted.hash, origin: 'https://www.youtube.com/watch?v=topic', title: 'Remote Hit', artist: 'Nova', album: 'Night Ferry', bytes: 2048, at: 1000,
    });
    assert.ok(rec.id > 0);
    assert.equal(rec.plugin, 'youtube');
    assert.equal(rec.userId, alice);
    assert.equal(rec.username, 'alice');
    assert.equal(rec.jobId, 7);
    assert.equal(rec.vpath, VPATH);
    assert.equal(rec.filepath, `${VPATH}/Nova/Night Ferry/Remote_Hit.mp3`);
    assert.equal(rec.relativePath, 'Nova/Night Ferry/Remote_Hit.mp3');
    assert.equal(rec.fileHash, inserted.hash);
    assert.ok(rec.fileHash, 'the insert helper hands the hash back');
    assert.equal(rec.origin, 'https://www.youtube.com/watch?v=topic');
    assert.deepEqual([rec.title, rec.artist, rec.album, rec.bytes], ['Remote Hit', 'Nova', 'Night Ferry', 2048]);
    assert.equal(rec.downloadedAt, 1000);
    assert.equal(rec.removedAt, null);
    assert.equal(rec.present, true);
    assert.equal(rec.trackId, inserted.trackId);
    assert.deepEqual(downloads.get(rec.id), rec);
    assert.throws(() => downloads.record({ plugin: 'youtube', vpath: VPATH }), /required/);
  });

  test('a record at a path an earlier one held retires the earlier one instead of sitting beside it', () => {
    // The live record at a path, as the list shows it (every account, no history).
    const liveAt = (rel) => downloads.list({ limit: 500 }).find((d) => d.filepath === `${VPATH}/${rel}`);
    const first = liveAt('Nova/Night Ferry/Remote_Hit.mp3');
    const again = downloads.record({ plugin: 'federation-copy', userId: bob, vpath: VPATH, relativePath: 'Nova/Night Ferry/Remote_Hit.mp3', origin: "Sam's server", at: 2000 });
    assert.notEqual(again.id, first.id);
    assert.equal(again.removedAt, null);
    const retired = downloads.get(first.id);
    assert.equal(retired.removedAt, 2000, 'the earlier record is history now');
    assert.equal(retired.removedBy, null);
    assert.equal(liveAt('Nova/Night Ferry/Remote_Hit.mp3').id, again.id, 'the live one wins');
    // Back to alice's for the tests below (bob's copy was only a stand-in).
    downloads.markRemoved(again.id, { by: bob, at: 2100 });
    const back = downloads.record({ plugin: 'youtube', userId: alice, vpath: VPATH, relativePath: 'Nova/Night Ferry/Remote_Hit.mp3', at: 2200 });
    assert.equal(liveAt('Nova/Night Ferry/Remote_Hit.mp3').id, back.id);
  });

  test('list: newest first, one account or every account, history only when asked, paged by id', async () => {
    await land('Bonobo/Migration/Kerala.mp3');
    const b1 = downloads.record({ plugin: 'youtube', userId: bob, vpath: VPATH, relativePath: 'Bonobo/Migration/Kerala.mp3', at: 3000 });
    await land('Marlowe Vale/Harbour Days/01 Harbour Days.mp3');
    const a2 = downloads.record({ plugin: 'federation-copy', userId: alice, vpath: VPATH, relativePath: 'Marlowe Vale/Harbour Days/01 Harbour Days.mp3', at: 4000 });
    const anon = downloads.record({ plugin: 'ytdl', userId: null, vpath: VPATH, relativePath: 'inbox/Pasted.mp3', at: 5000 });

    const everyone = downloads.list();
    assert.deepEqual(everyone.map((r) => r.id).slice(0, 3), [anon.id, a2.id, b1.id], 'newest first, every account');
    assert.ok(everyone.every((r) => r.removedAt === null), 'history is hidden by default');
    assert.deepEqual(downloads.list({ userId: bob }).map((r) => r.id), [b1.id]);
    assert.deepEqual(downloads.list({ userId: null }).map((r) => r.id), [anon.id], 'null = the anonymous account, not everyone');
    const alices = downloads.list({ userId: alice }).map((r) => r.id);
    assert.equal(alices[0], a2.id);
    assert.ok(downloads.list({ includeRemoved: true }).length > everyone.length, 'history comes back when asked');
    assert.deepEqual(downloads.list({ limit: 1 }).map((r) => r.id), [anon.id]);
    assert.deepEqual(downloads.list({ limit: 1, before: anon.id }).map((r) => r.id), [a2.id], 'before = an id');
    assert.equal(downloads.list({ userId: alice })[0].present, true);
    assert.equal(downloads.list({ userId: null })[0].present, false, 'nothing was ever inserted for the pasted one');
  });

  test('markRemoved: once, by whom; present follows the track row, not the record', () => {
    const rec = downloads.list({ userId: bob })[0];
    const removed = downloads.markRemoved(rec.id, { by: alice, at: 6000 });
    assert.deepEqual([removed.removedAt, removed.removedBy], [6000, alice]);
    assert.equal(downloads.markRemoved(rec.id, { by: alice }), null, 'already removed');
    assert.equal(downloads.markRemoved(999999), null, 'unknown');
    assert.deepEqual(downloads.list({ userId: bob }), [], 'gone from the live list');
    assert.equal(downloads.list({ userId: bob, includeRemoved: true })[0].id, rec.id);

    // A scan that sweeps the file leaves the record alone: `present` says so.
    const live = downloads.list({ userId: alice })[0];
    assert.equal(live.present, true);
    assert.equal(removeDownloadedTrack({ vpath: VPATH, relativePath: live.relativePath, log: 'unit' }), 1);
    const after = downloads.get(live.id);
    assert.equal(after.present, false);
    assert.equal(after.trackId, null);
    assert.equal(after.removedAt, null, 'the record is not removed, the file is just not there');
  });

  test('summary: live records by plug-in', () => {
    const s = downloads.summary();
    const byPlugin = Object.fromEntries(s.map((r) => [r.plugin, r.count]));
    assert.equal(byPlugin.youtube, 1, 'alice\'s Remote Hit; bob\'s Kerala is removed');
    assert.equal(byPlugin['federation-copy'], 1);
    assert.equal(byPlugin.ytdl, 1);
    assert.ok(s.every((r) => Number.isInteger(r.bytes)));
  });
});
