// Child-process fixture for test/db/insert-downloaded-track-race.test.mjs —
// the scanner's end-of-scan orphan sweep, as the separate process it really
// is: its own connection to the same mstream.db, the scanner's pragmas, and
// the real cleanupOrphans (src/db/orphan-cleanup.js).
//
// argv[2] = the mstream.db path. Driven over the fork() IPC channel:
//   { cmd: 'sweep' }            sweep over and over, a random 0–1 ms apart,
//                               until { cmd: 'stop' }; replies
//                               { swept: { sweeps, albums, artists } }
//   { cmd: 'hold', ms }         BEGIN IMMEDIATE, sweep inside it, reply
//                               { held: { albums, artists } } and COMMIT
//                               `ms` later — the window in which a writer
//                               on the other connection is locked out
//                               while the deletes are not yet visible
//                               to it; replies { released: true } after
// Replies { ready: true } once the connection is open.
import { DatabaseSync } from '../../src/db/sqlite-driver.js';
import { cleanupOrphans } from '../../src/db/orphan-cleanup.js';

const db = new DatabaseSync(process.argv[2]);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA recursive_triggers = ON');

const countAlbums = db.prepare('SELECT COUNT(*) AS n FROM albums');
const countArtists = db.prepare('SELECT COUNT(*) AS n FROM artists');
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// One sweep; how many albums / artists it took.
function sweep() {
  const albums = countAlbums.get().n;
  const artists = countArtists.get().n;
  cleanupOrphans(db);
  return { albums: albums - countAlbums.get().n, artists: artists - countArtists.get().n };
}

let sweeping = false;
const swept = { sweeps: 0, albums: 0, artists: 0 };

// Sweeps in ~20 ms slices, so the stop message gets through between them.
function slice() {
  if (!sweeping) { return; }
  const until = performance.now() + 20;
  while (performance.now() < until) {
    const r = sweep();
    swept.sweeps++;
    swept.albums += r.albums;
    swept.artists += r.artists;
    pause(Math.random());
  }
  setImmediate(slice);
}

process.on('message', (msg) => {
  if (msg.cmd === 'sweep') {
    sweeping = true;
    setImmediate(slice);
  } else if (msg.cmd === 'stop') {
    sweeping = false;
    process.send({ swept });
  } else if (msg.cmd === 'hold') {
    db.exec('BEGIN IMMEDIATE');
    process.send({ held: sweep() });
    setTimeout(() => {
      db.exec('COMMIT');
      process.send({ released: true });
    }, msg.ms);
  }
});
process.on('disconnect', () => {
  try { db.close(); } catch { /* already closed */ }
  process.exit(0);
});

process.send({ ready: true });
