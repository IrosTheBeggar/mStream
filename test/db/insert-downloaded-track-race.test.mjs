/**
 * insertDownloadedTrack against the scanner's orphan sweep (CI run
 * 37146091164: a discovery download failed "FOREIGN KEY constraint failed").
 *
 * The scanner is a separate process, and its end-of-scan sweep deletes
 * every album / artist no track references. A download whose artist and
 * album had just lost their last track found them (find-or-create), the
 * sweep deleted them, and the track INSERT then referenced rows that were
 * gone. The fix holds the write lock (BEGIN IMMEDIATE) from the lookups to
 * the credit row, so a sweep waits and then sees the new track.
 *
 * In-process against a real mstream.db in a temp dir (the DB-backed suite
 * pattern), with the sweep in a child process on its own connection
 * (test/fixtures/orphan-sweeper.mjs). Rows are made on files that are not
 * really audio, tagged through userMeta, like the other insert-helper suites.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SWEEPER = path.join(__dirname, '..', 'fixtures', 'orphan-sweeper.mjs');
const VPATH = 'race-unit';

let tmpDir;
let libDir;
let manager;
let insertDownloadedTrack;
let removeDownloadedTrack;
let sweeper;

// The next message from the sweeper that carries `key`.
function reply(key) {
  return new Promise((resolve, reject) => {
    if (sweeper.exitCode !== null || sweeper.signalCode !== null) {
      reject(new Error(`orphan sweeper already exited (${sweeper.exitCode ?? sweeper.signalCode}) before replying ${key}`));
      return;
    }
    const onMessage = (msg) => {
      if (!(key in msg)) { return; }
      sweeper.off('message', onMessage);
      sweeper.off('exit', onExit);
      resolve(msg[key]);
    };
    const onExit = (code) => {
      sweeper.off('message', onMessage);
      reject(new Error(`orphan sweeper exited (${code}) before replying ${key}`));
    };
    sweeper.on('message', onMessage);
    sweeper.once('exit', onExit);
  });
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-insert-race-'));
  libDir = path.join(tmpDir, 'collection');
  fs.mkdirSync(libDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ port: 3000, storage: { dbDirectory: tmpDir } }));
  const config = await import('../../src/state/config.js');
  await config.setup(path.join(tmpDir, 'config.json'));
  config.program.storage = { ...(config.program.storage || {}), dbDirectory: tmpDir, albumArtDirectory: path.join(tmpDir, 'art') };
  fs.mkdirSync(path.join(tmpDir, 'art'), { recursive: true });
  manager = await import('../../src/db/manager.js');
  manager.initDB();
  ({ insertDownloadedTrack, removeDownloadedTrack } = await import('../../src/db/insert-downloaded-track.js'));
  manager.getDB().prepare("INSERT INTO libraries (name, root_path, type) VALUES (?, ?, 'music')").run(VPATH, libDir);
  manager.invalidateCache();

  sweeper = fork(SWEEPER, [path.join(tmpDir, 'mstream.db')], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  await reply('ready');
});

after(async () => {
  if (sweeper && sweeper.exitCode === null && sweeper.signalCode === null) {
    // It exits on disconnect; a child wedged in a busy wait must not hold
    // the CI shard open, so it gets 5 s and then is killed.
    const exited = once(sweeper, 'exit');
    if (sweeper.connected) { sweeper.disconnect(); }
    const timer = setTimeout(() => sweeper.kill(), 5000);
    await exited;
    clearTimeout(timer);
  }
  try { manager.close(); } catch { /* already closed */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* windows locks */ }
  setImmediate(() => process.exit(0)); // module-level timers, like the other DB-backed suites
});

// A file in the library with a track row, the way a download lands one.
function land(relativePath, meta) {
  const file = path.join(libDir, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `not really audio: ${relativePath}`);
  return insertDownloadedTrack({ filePath: file, vpath: VPATH, basePath: libDir, source: 'plugin:unit', userMeta: meta, log: 'unit' });
}

const albumOf = (trackId) => ({ ...manager.getDB().prepare(
  `SELECT al.name AS album, ar.name AS artist FROM tracks t
     JOIN albums al ON al.id = t.album_id JOIN artists ar ON ar.id = t.artist_id WHERE t.id = ?`
).get(trackId) });

describe('insertDownloadedTrack vs the scanner\'s orphan sweep', () => {
  test('a sweep that deletes the orphaned album while the insert waits for the lock is seen, not raced', async () => {
    // The CI shape: the artist's only song is removed, leaving its artist
    // and album orphaned, and the next download lands on them.
    const rel = 'Nova/Night Ferry/01 Remote Hit.mp3';
    const meta = { title: 'Remote Hit', artist: 'Nova', album: 'Night Ferry' };
    await land(rel, meta);
    assert.equal(removeDownloadedTrack({ vpath: VPATH, relativePath: rel, log: 'unit' }), 1);

    // The sweeper takes the write lock and deletes the orphans, uncommitted:
    // until its COMMIT the deletes are invisible on this connection, so a
    // lookup outside the write lock still finds "Nova" / "Night Ferry" and
    // its INSERT — after the COMMIT — references rows that are gone. Inside
    // the lock, the lookup waits for the COMMIT and creates them afresh.
    sweeper.send({ cmd: 'hold', ms: 400 });
    const held = await reply('held');
    assert.deepEqual(held, { albums: 1, artists: 1 }, 'the sweep took the orphaned album and artist');
    const released = reply('released');
    const inserted = await land(rel, meta);
    await released;

    assert.ok(inserted.trackId, 'the row went in');
    assert.deepEqual(albumOf(inserted.trackId), { album: 'Night Ferry', artist: 'Nova' });
    const credit = manager.getDB().prepare(
      "SELECT ar.name FROM track_artists ta JOIN artists ar ON ar.id = ta.artist_id WHERE ta.track_id = ? AND ta.role = 'main'"
    ).get(inserted.trackId);
    assert.equal(credit.name, 'Nova', 'the credit row went in with it');
  });

  test('stress: orphan and re-insert over and over while another process sweeps — no FOREIGN KEY failure', async (t) => {
    const rel = 'Vale/Harbour Days/01 Harbour Days.mp3';
    const meta = { title: 'Harbour Days', artist: 'Marlowe Vale', album: 'Harbour Days' };
    await land(rel, meta);

    sweeper.send({ cmd: 'sweep' });
    const deadline = Date.now() + 2000;
    let iterations = 0;
    let failures = 0;
    let last = null;
    while (Date.now() < deadline) {
      // Remove the only track (artist + album orphaned), then land it again:
      // the sweep runs a random 0–1 ms apart, so it sometimes takes the
      // orphans first (the insert re-creates them) and sometimes lands
      // while the insert is between its lookup and its INSERT.
      removeDownloadedTrack({ vpath: VPATH, relativePath: rel, log: 'unit' });
      try {
        last = await land(rel, meta);
      } catch (err) {
        if (!/FOREIGN KEY/.test(err.message)) { throw err; }
        failures++;
      }
      iterations++;
    }
    sweeper.send({ cmd: 'stop' });
    const swept = await reply('swept');
    const summary = `${iterations} inserts, ${failures} FOREIGN KEY failures; sweeper: ${swept.sweeps} sweeps took ${swept.albums} albums / ${swept.artists} artists`;
    t.diagnostic(summary);

    assert.equal(failures, 0, summary);
    assert.ok(swept.albums > 0, 'the sweeper deleted orphaned albums while the loop ran (the race was live)');
    assert.deepEqual(albumOf(last.trackId), { album: 'Harbour Days', artist: 'Marlowe Vale' });
  });
});
