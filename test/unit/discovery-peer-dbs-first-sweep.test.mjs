/**
 * The shelf's first orphan sweep on a dbDirectory (src/state/discovery-peer-dbs.js
 * sweepOrphans): a server upgraded from a version whose raw admin
 * p2p/fetch route exported into discovery-peers/ — the shelf's own
 * directory — so an unnamed *.db there may be a file an admin pulled, not
 * an interrupted download. The first sweep moves those to rawFetchDir()
 * instead of deleting them and leaves a marker naming any it could not
 * move; later sweeps move just those again and delete the rest
 * (test/unit/discovery-peer-dbs-inflight.test.mjs, 'boot', is a server
 * past its first sweep).
 *
 * The registry loads once per process, so the boot after this file's own
 * runs in a child process on the same dbDirectory.
 *
 * Also here, since it is a boot: a registry entry whose stored path points
 * into a dbDirectory that has since moved is re-attached to its file in the
 * shelf directory as it stands, not dropped (and its file never swept).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import winston from 'winston';

const quiet = new winston.transports.Console({ silent: true });
const HELD = 'a'.repeat(64);
const MOVED = 'b'.repeat(64);
let testRoot, configFile, dbDirectory, peerDir, rawDir, marker, peerDbs;

const readMarker = () => JSON.parse(fs.readFileSync(marker, 'utf8'));
const entry = (endpointId, file) => ({
  endpointId, hash: `f${endpointId.slice(0, 63)}`, path: file, snapshotSeq: 1, modelId: 'test-model',
  rowCount: 1, sizeBytes: 4, name: 'Held', fetchedAt: new Date().toISOString(),
});

// The next boot of the shelf on this dbDirectory: what its registry holds.
function bootAgain() {
  const configUrl = new URL('../../src/state/config.js', import.meta.url).href;
  const shelfUrl = new URL('../../src/state/discovery-peer-dbs.js', import.meta.url).href;
  const script = `
    const winston = (await import('winston')).default;
    winston.add(new winston.transports.Console({ silent: true }));
    const config = await import(${JSON.stringify(configUrl)});
    await config.setup(${JSON.stringify(configFile)});
    const peerDbs = await import(${JSON.stringify(shelfUrl)});
    process.stdout.write(JSON.stringify(peerDbs.list().map((e) => e.endpointId)));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', cwd: process.cwd() });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

before(async () => {
  winston.add(quiet);
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-peer-first-sweep-'));
  configFile = path.join(testRoot, 'config.json');
  dbDirectory = path.join(testRoot, 'db');
  peerDir = path.join(dbDirectory, 'discovery-peers');
  rawDir = path.join(dbDirectory, 'discovery-fetched');
  marker = path.join(dbDirectory, 'discovery-p2p', 'peer-dbs-swept');
  fs.mkdirSync(peerDir, { recursive: true });
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({
    storage: {
      dbDirectory,
      albumArtDirectory: path.join(testRoot, 'art'),
      logsDirectory: path.join(testRoot, 'logs'),
    },
    port: 0,
  }));

  // The upgraded server's shelf directory: a snapshot the registry names, one
  // it names under the dbDirectory's old place, a file the raw route pulled
  // there, one it pulled there AND (by the next boot) already kept in the new
  // place, and a file that is not a snapshot.
  fs.writeFileSync(path.join(peerDir, 'held.db'), 'held');
  fs.writeFileSync(path.join(peerDir, 'moved.db'), 'moved');
  fs.writeFileSync(path.join(peerDir, 'pulled.db'), 'pulled');
  fs.writeFileSync(path.join(peerDir, 'twice.db'), 'twice, old place');
  fs.writeFileSync(path.join(peerDir, 'notes.txt'), 'not a snapshot');
  fs.writeFileSync(path.join(path.dirname(marker), 'peer-dbs.json'), JSON.stringify([
    entry(HELD, path.join(peerDir, 'held.db')),
    entry(MOVED, path.join(testRoot, 'old-place', 'db', 'discovery-peers', 'moved.db')),
  ]));
  // This boot cannot move anything: a file stands where the directory goes.
  fs.writeFileSync(rawDir, 'in the way');

  const config = await import('../../src/state/config.js');
  await config.setup(configFile);
  peerDbs = await import('../../src/state/discovery-peer-dbs.js');
});

after(() => {
  winston.remove(quiet);
  try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch (_e) { /* win file locks */ }
});

test('a held entry whose dbDirectory moved is re-attached to its file here, not dropped or swept', () => {
  assert.ok(!fs.existsSync(marker), 'precondition: an upgraded server has no marker');
  assert.deepEqual(peerDbs.list().map((e) => e.endpointId), [HELD, MOVED]);
  assert.equal(peerDbs.get(MOVED).path, path.join(peerDir, 'moved.db'));
  assert.equal(fs.readFileSync(path.join(peerDir, 'moved.db'), 'utf8'), 'moved');
  assert.equal(fs.readFileSync(path.join(peerDir, 'held.db'), 'utf8'), 'held');
});

test('a move that fails leaves the file where it was and names it in the marker', () => {
  assert.equal(fs.readFileSync(path.join(peerDir, 'pulled.db'), 'utf8'), 'pulled', 'never deleted');
  assert.equal(fs.readFileSync(path.join(peerDir, 'twice.db'), 'utf8'), 'twice, old place');
  assert.deepEqual(readMarker().pending.sort(), ['pulled.db', 'twice.db']);
});

test('the next boot moves those, deletes a download interrupted since, and clears the marker', () => {
  fs.rmSync(rawDir);
  fs.mkdirSync(rawDir);
  fs.writeFileSync(path.join(rawDir, 'twice.db'), 'twice, new place');
  fs.writeFileSync(path.join(peerDir, 'fresh.db'), 'a download killed after the upgrade');

  assert.deepEqual(bootAgain(), [HELD, MOVED]);
  assert.ok(!fs.existsSync(path.join(peerDir, 'pulled.db')));
  assert.equal(fs.readFileSync(path.join(rawDir, 'pulled.db'), 'utf8'), 'pulled', 'moved, not deleted');
  assert.ok(!fs.existsSync(path.join(peerDir, 'twice.db')), 'the old-place copy goes');
  assert.equal(fs.readFileSync(path.join(rawDir, 'twice.db'), 'utf8'), 'twice, new place', 'the kept copy is untouched');
  assert.ok(!fs.existsSync(path.join(peerDir, 'fresh.db')), 'not a legacy file: deleted');
  assert.ok(!fs.existsSync(path.join(rawDir, 'fresh.db')), 'and not moved');
  assert.ok(fs.existsSync(path.join(peerDir, 'notes.txt')), 'only *.db files are snapshots');
  assert.deepEqual(readMarker().pending, []);
});
