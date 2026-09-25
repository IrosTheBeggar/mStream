/**
 * ownedAlbumKeys (src/discovery-plugins/owned.js): the albums a library has
 * by an artist, for "what you're missing" — in-process against a real
 * mstream.db in a temp dir, the rows made the way a copy makes them
 * (insertDownloadedTrack on files that are not really audio). An album row
 * whose songs were removed (the Downloads view's Remove deletes tracks, not
 * the album row) is not an album the library has.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let libDir;
let manager;
let owned;
let insertDownloadedTrack;
let removeDownloadedTrack;
const VPATH = 'owned-unit';

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-owned-albums-'));
  libDir = path.join(tmpDir, 'collection');
  fs.mkdirSync(libDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ port: 3000, storage: { dbDirectory: tmpDir } }));
  const config = await import('../../src/state/config.js');
  await config.setup(path.join(tmpDir, 'config.json'));
  config.program.storage = { ...(config.program.storage || {}), dbDirectory: tmpDir, albumArtDirectory: path.join(tmpDir, 'art') };
  fs.mkdirSync(path.join(tmpDir, 'art'), { recursive: true });
  manager = await import('../../src/db/manager.js');
  manager.initDB();
  owned = await import('../../src/discovery-plugins/owned.js');
  ({ insertDownloadedTrack, removeDownloadedTrack } = await import('../../src/db/insert-downloaded-track.js'));
  manager.getDB().prepare("INSERT INTO libraries (name, root_path, type) VALUES (?, ?, 'music')").run(VPATH, libDir);
  manager.invalidateCache();
});

after(() => {
  try { manager.close(); } catch { /* already closed */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* windows locks */ }
  setImmediate(() => process.exit(0));
});

// A file in the library with a track row, tagged through userMeta the way a
// copy or a download tags what it lands. `.mp3` names, as a copy's are: the
// insert takes audio only.
async function land(relativePath, meta, { vpath = VPATH, dir = libDir } = {}) {
  const file = path.join(dir, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `not really audio: ${relativePath}`);
  return insertDownloadedTrack({ filePath: file, vpath, basePath: dir, source: 'plugin:unit', userMeta: meta, log: 'unit' });
}

describe('ownedTrack', () => {
  let privateDir;
  let publicId;
  let privateId;
  const setRow = (relPath, { track = null, disk = null, duration = null }) => manager.getDB()
    .prepare('UPDATE tracks SET track_number = ?, disc_number = ?, duration = ? WHERE filepath = ?').run(track, disk, duration, relPath);

  before(async () => {
    privateDir = path.join(tmpDir, 'private');
    fs.mkdirSync(privateDir, { recursive: true });
    manager.getDB().prepare("INSERT INTO libraries (name, root_path, type) VALUES (?, ?, 'music')").run('owned-private', privateDir);
    manager.invalidateCache();
    publicId = manager.getLibraryByName(VPATH).id;
    privateId = manager.getLibraryByName('owned-private').id;
    // Two different recordings that share a title on one album (an artist of
    // its own, so the ownedAlbumKeys cases below keep their counts).
    await land('Riverbed/Interludes/03 Interlude.mp3', { title: 'Interlude', artist: 'Riverbed', album: 'Interludes' });
    setRow('Riverbed/Interludes/03 Interlude.mp3', { track: 3, disk: 1, duration: 61 });
    // A song only the private library has.
    await land('Secret/Album/01 Song.mp3', { title: 'Song', artist: 'Secret', album: 'Album' }, { vpath: 'owned-private', dir: privateDir });
  });

  test('the tag arm matches the recording, not the name: track and disc numbers and the length tell same-titled tracks apart', () => {
    const rec = { artist: 'Riverbed', title: 'Interlude', album: 'Interludes' };
    assert.ok(owned.ownedTrack(rec), 'nothing known about the recording: the name is enough');
    assert.equal(owned.ownedTrack(rec).filepath, `${VPATH}/Riverbed/Interludes/03 Interlude.mp3`);
    assert.ok(owned.ownedTrack({ ...rec, track: 3 }), 'the same track number');
    assert.ok(owned.ownedTrack({ ...rec, track: 3, disk: 1, duration: 63 }), 'a length within tolerance');
    assert.equal(owned.ownedTrack({ ...rec, track: 9 }), null, 'track 9 is another recording — not owned');
    assert.equal(owned.ownedTrack({ ...rec, track: 3, disk: 2 }), null, 'another disc');
    assert.equal(owned.ownedTrack({ ...rec, duration: 240 }), null, 'a length that is not this recording');
    assert.equal(owned.ownedTrack({ ...rec, track: '3', duration: '60' }).by, 'tags', 'numbers as strings, as a peer sends them');
  });

  test('libraryIds scopes every arm to the libraries the user may see', async () => {
    const secret = { artist: 'Secret', title: 'Song', album: 'Album' };
    assert.ok(owned.ownedTrack(secret), 'unscoped: the whole server');
    assert.equal(owned.ownedTrack({ ...secret, libraryIds: [publicId] }), null, 'a library hidden from the user is not theirs');
    assert.ok(owned.ownedTrack({ ...secret, libraryIds: [privateId] }));
    assert.ok(owned.ownedTrack({ ...secret, libraryIds: [publicId, privateId] }));
    assert.equal(owned.ownedTrack({ ...secret, libraryIds: [] }), null, 'no libraries, nothing owned');
    const row = manager.getDB().prepare('SELECT file_hash, audio_hash FROM tracks WHERE filepath = ?').get('Secret/Album/01 Song.mp3');
    assert.ok(owned.ownedTrack({ hash: row.file_hash }));
    assert.equal(owned.ownedTrack({ hash: row.file_hash, libraryIds: [publicId] }), null, 'the hash arm too');
    assert.equal(owned.libraryIdsFor({ vpaths: [VPATH] }).join(), String(publicId));
    assert.equal(owned.libraryIdsFor({ vpaths: [] }).length, 0);
    assert.equal(owned.libraryIdsFor({}), null, 'a caller without vpaths is not scoped');
    assert.equal(owned.libraryIdsFor(null), null);
  });

  test('ownedAlbumKeys scopes the same way', () => {
    assert.deepEqual([...owned.ownedAlbumKeys('Secret')], ['album']);
    assert.deepEqual([...owned.ownedAlbumKeys('Secret', { libraryIds: [publicId] })], []);
    assert.deepEqual([...owned.ownedAlbumKeys('Secret', { libraryIds: [privateId] })], ['album']);
    assert.deepEqual([...owned.ownedAlbumKeys('Secret', { libraryIds: [] })], []);
  });
});

describe('ownedAlbumKeys', () => {
  test('the albums with songs by the artist, as normalised name keys; a spelling of the artist resolves; nothing for an unknown one', async () => {
    await land('Nova/Night Ferry/01 Remote Hit.mp3', { title: 'Remote Hit', artist: 'Nova', album: 'Night Ferry' });
    await land('Nova/Second Wind/01 Fourth Song.mp3', { title: 'Fourth Song', artist: 'Nova', album: 'Second Wind' });
    await land('Vosto/Solo/01 Third Song.mp3', { title: 'Third Song', artist: 'Vosto', album: 'Solo' });
    assert.deepEqual([...owned.ownedAlbumKeys('Nova')].sort(), ['night ferry', 'second wind']);
    assert.deepEqual([...owned.ownedAlbumKeys('nova ')].sort(), ['night ferry', 'second wind'], 'matched on the normalised name');
    assert.deepEqual([...owned.ownedAlbumKeys('Vosto')], ['solo']);
    assert.deepEqual([...owned.ownedAlbumKeys('Nobody')], []);
    assert.deepEqual([...owned.ownedAlbumKeys('')], []);
    assert.deepEqual([...owned.ownedAlbumKeys('Nova', null)], [], 'no database, nothing owned');
  });

  test('an album whose songs were removed is not owned any more, even though its row stays', async () => {
    const db = manager.getDB();
    assert.equal(removeDownloadedTrack({ vpath: VPATH, relativePath: 'Nova/Night Ferry/01 Remote Hit.mp3', log: 'unit' }), 1);
    assert.ok(db.prepare("SELECT id FROM albums WHERE name = 'Night Ferry'").get(), 'the album row is still there');
    assert.deepEqual([...owned.ownedAlbumKeys('Nova')], ['second wind'], 'only the album with songs left');
    // Landed again, it is owned again.
    await land('Nova/Night Ferry/01 Remote Hit.mp3', { title: 'Remote Hit', artist: 'Nova', album: 'Night Ferry' });
    assert.deepEqual([...owned.ownedAlbumKeys('Nova')].sort(), ['night ferry', 'second wind']);
  });
});
