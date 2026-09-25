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
// copy or a download tags what it lands.
async function land(relativePath, meta) {
  const file = path.join(libDir, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `not really audio: ${relativePath}`);
  return insertDownloadedTrack({ filePath: file, vpath: VPATH, basePath: libDir, source: 'plugin:unit', userMeta: meta, log: 'unit' });
}

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
