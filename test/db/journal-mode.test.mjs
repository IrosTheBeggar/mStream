/**
 * SQLite journal mode for the multi-process databases (src/db/journal-mode.js).
 *
 * WAL is only safe where a file lock one process holds is visible to the
 * others. Docker Desktop bind mounts hide locks taken through the descriptor
 * that created a file, which is exactly how SQLite holds -shm, so there the
 * server falls back to a rollback journal and every other process inherits
 * it from the database header. The broken filesystem itself can't be had in
 * CI (test/smoke/docker/sqlite-bind-mount-smoke.sh reproduces it on Docker
 * Desktop); these tests cover the decision with the probe stubbed, the real
 * probe on a healthy disk, and the open paths that apply the decision.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import winston from 'winston';

import {
  resolveJournalMode, resetJournalModeVerdicts, probeLockVisibility,
  ensureDbFile, setJournalMode,
} from '../../src/db/journal-mode.js';

const FAKEOWNER = 0x6A656A63;
const EXT4 = 0xEF53;

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `journal-mode-${label}-`));
}

function recorder() {
  const lines = [];
  return {
    lines,
    warn: (m) => lines.push(['warn', m]),
    error: (m) => lines.push(['error', m]),
  };
}

function journalModeOf(dbPath) {
  const db = new DatabaseSync(dbPath);
  try { return db.prepare('PRAGMA journal_mode').get().journal_mode; } finally { db.close(); }
}

// A probe that fails the test if the decision should not have needed one.
const noProbe = () => { throw new Error('probe must not run'); };

describe('resolveJournalMode', () => {
  test('config override skips the check', () => {
    resetJournalModeVerdicts();
    const opts = { platform: 'linux', statfs: () => ({ type: FAKEOWNER }), probe: noProbe };
    assert.equal(resolveJournalMode('/x', { ...opts, override: 'WAL' }), 'WAL');
    assert.equal(resolveJournalMode('/x', { ...opts, override: 'DELETE' }), 'DELETE');
  });

  test('WAL without a probe off Linux and on local Linux filesystems', () => {
    resetJournalModeVerdicts();
    assert.equal(resolveJournalMode('/a', { platform: 'darwin', probe: noProbe }), 'WAL');
    assert.equal(resolveJournalMode('/b', { platform: 'win32', probe: noProbe }), 'WAL');
    assert.equal(resolveJournalMode('/c',
      { platform: 'linux', statfs: () => ({ type: EXT4 }), probe: noProbe }), 'WAL');
  });

  test('DELETE where only the creating handle\'s locks are invisible (Docker Desktop)', () => {
    resetJournalModeVerdicts();
    const log = recorder();
    const mode = resolveJournalMode('/config/db', {
      platform: 'linux', statfs: () => ({ type: FAKEOWNER }), log,
      probe: () => ({ created: 'readable', reopened: 'locked' }),
    });
    assert.equal(mode, 'DELETE');
    assert.equal(log.lines.length, 1);
    const [level, msg] = log.lines[0];
    assert.equal(level, 'warn');
    assert.match(msg, /\/config\/db \(fakeowner\)/);
    assert.match(msg, /journal_mode=DELETE/);
  });

  test('DELETE with an error when no lock is visible across processes', () => {
    resetJournalModeVerdicts();
    const log = recorder();
    const mode = resolveJournalMode('/nolocks', {
      platform: 'linux', statfs: () => ({ type: 0x65735546 }), log,
      probe: () => ({ created: 'readable', reopened: 'readable' }),
    });
    assert.equal(mode, 'DELETE');
    assert.equal(log.lines[0][0], 'error');
    assert.match(log.lines[0][1], /\/nolocks \(fuse\)/);
  });

  test('WAL, silently, where the probe finds working locks', () => {
    resetJournalModeVerdicts();
    const log = recorder();
    assert.equal(resolveJournalMode('/healthy', {
      platform: 'linux', statfs: () => ({ type: 0x6969 }), log,
      probe: () => ({ created: 'locked', reopened: 'locked' }),
    }), 'WAL');
    assert.deepEqual(log.lines, []);
  });

  test('a probe that cannot answer keeps WAL and says so', () => {
    resetJournalModeVerdicts();
    const log = recorder();
    assert.equal(resolveJournalMode('/flaky', {
      platform: 'linux', statfs: () => { throw new Error('ENOSYS'); }, log,
      probe: () => { throw new Error('the probe gave no answer (exit 1)'); },
    }), 'WAL');
    assert.equal(log.lines[0][0], 'warn');
    assert.match(log.lines[0][1], /\/flaky \(unknown filesystem\).*keeping WAL.*no answer/);
  });

  test('decided once per directory', () => {
    resetJournalModeVerdicts();
    let probes = 0;
    const opts = {
      platform: 'linux', statfs: () => ({ type: FAKEOWNER }), log: recorder(),
      probe: () => { probes++; return { created: 'readable', reopened: 'locked' }; },
    };
    assert.equal(resolveJournalMode('/once/db', opts), 'DELETE');
    assert.equal(resolveJournalMode('/once/db/', opts), 'DELETE');
    assert.equal(probes, 1);
    resetJournalModeVerdicts();
    resolveJournalMode('/once/db', opts);
    assert.equal(probes, 2);
  });
});

describe('probeLockVisibility (real child process)', () => {
  test('both locks are visible on a local disk, and the probe cleans up', () => {
    const dir = tmpDir('probe');
    try {
      assert.deepEqual(probeLockVisibility(dir), { created: 'locked', reopened: 'locked' });
      assert.deepEqual(fs.readdirSync(dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unusable answer throws, and the probe still cleans up', () => {
    const dir = tmpDir('probe-bad');
    try {
      assert.throws(() => probeLockVisibility(dir, { run: () => ['locked'] }), /unexpected probe answer/);
      assert.deepEqual(fs.readdirSync(dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ensureDbFile', () => {
  test('creates a missing database empty and never touches an existing one', () => {
    const dir = tmpDir('ensure');
    try {
      const p = path.join(dir, 'x.db');
      ensureDbFile(p);
      assert.equal(fs.statSync(p).size, 0);
      fs.writeFileSync(p, 'keep me');
      ensureDbFile(p);
      assert.equal(fs.readFileSync(p, 'utf8'), 'keep me');
      // A missing directory is left for SQLite's own open to report.
      ensureDbFile(path.join(dir, 'missing', 'x.db'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('setJournalMode', () => {
  test('switches a WAL database to DELETE and back', () => {
    const dir = tmpDir('set');
    try {
      const p = path.join(dir, 'x.db');
      const db = new DatabaseSync(p);
      db.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x); INSERT INTO t VALUES (1)');
      assert.equal(setJournalMode(db, 'DELETE', p, { log: recorder() }), 'delete');
      assert.equal(fs.existsSync(`${p}-wal`), false);
      assert.equal(setJournalMode(db, 'WAL', p, { log: recorder() }), 'wal');
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a database still held elsewhere stays WAL, with an error', () => {
    const dir = tmpDir('set-busy');
    try {
      const p = path.join(dir, 'x.db');
      const other = new DatabaseSync(p);
      other.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x)');
      // An open WAL connection keeps a shared lock on the database file for
      // its lifetime; that alone refuses the switch.
      other.prepare('SELECT count(*) FROM t').get();
      const db = new DatabaseSync(p);
      const log = recorder();
      assert.equal(setJournalMode(db, 'DELETE', p, { log, waitMs: 100 }), 'wal');
      assert.equal(log.lines[0][0], 'error');
      assert.match(log.lines[0][1], /journal_mode=DELETE \(database is locked\); it stays wal\. Another process/);
      db.close();
      other.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // busy_timeout does not cover leaving WAL (SQLite takes that lock without
  // the busy handler), so the switch retries on its own.
  test('leaving WAL waits for another process to let go', async () => {
    const dir = tmpDir('set-wait');
    try {
      const p = path.join(dir, 'x.db');
      const seed = new DatabaseSync(p);
      seed.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x)');
      seed.close();
      const holder = spawn(process.execPath, ['--no-warnings', '-e', `
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(${JSON.stringify(p)});
        db.prepare('SELECT count(*) FROM t').get();
        console.log('holding');
        setTimeout(() => db.close(), 400);`], { stdio: ['ignore', 'pipe', 'inherit'] });
      await new Promise((resolve, reject) => {
        holder.stdout.on('data', (d) => { if (String(d).includes('holding')) { resolve(); } });
        holder.on('error', reject);
        holder.on('exit', () => reject(new Error('holder exited before holding the database')));
      });
      const db = new DatabaseSync(p);
      db.exec('PRAGMA busy_timeout = 5000');
      const log = recorder();
      const started = Date.now();
      assert.equal(setJournalMode(db, 'DELETE', p, { log }), 'delete');
      assert.ok(Date.now() - started >= 100, 'the switch waited out the holder');
      assert.deepEqual(log.lines, []);
      db.close();
      await new Promise((resolve) => { if (holder.exitCode !== null) { resolve(); } else { holder.on('exit', resolve); } });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('entering WAL throws what SQLite throws, as opening always has', () => {
    const failing = { prepare: () => ({ get: () => { throw new Error('disk I/O error'); } }) };
    assert.throws(() => setJournalMode(failing, 'WAL', '/x.db', { log: recorder() }), /disk I\/O error/);
  });
});

// ── The open paths ──────────────────────────────────────────────────────────

describe('initDB / initDiscoveryDb apply the decision', () => {
  let root, config, dbManager, discoveryDb, dbPath;

  before(async () => {
    winston.add(new winston.transports.Console({ silent: true }));
    root = tmpDir('initdb');
    fs.mkdirSync(path.join(root, 'db'));
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      storage: {
        dbDirectory: path.join(root, 'db'),
        albumArtDirectory: path.join(root, 'art'),
        logsDirectory: path.join(root, 'logs'),
      },
      port: 0,
    }));
    config = await import('../../src/state/config.js');
    await config.setup(path.join(root, 'config.json'));
    dbManager = await import('../../src/db/manager.js');
    discoveryDb = await import('../../src/db/discovery-db.js');
    dbPath = path.join(root, 'db', 'mstream.db');
  });

  after(() => {
    try { dbManager.close(); } catch { /* not open */ }
    try { discoveryDb.closeDiscoveryDb(); } catch { /* not open */ }
    fs.rmSync(root, { recursive: true, force: true });
    // config.setup leaves module-level timers alive (winston rotation and
    // friends); exit like the other config-backed DB tests.
    setImmediate(() => process.exit(0));
  });

  test('defaults to WAL on a healthy disk', () => {
    assert.equal(config.program.db.journalMode, 'auto');
    dbManager.initDB();
    assert.equal(journalModeOf(dbPath), 'wal');
    dbManager.close();
  });

  test('DELETE converts the existing WAL database, and a soft reboot keeps it', () => {
    config.program.db.journalMode = 'DELETE';
    dbManager.initDB();
    assert.equal(journalModeOf(dbPath), 'delete');
    assert.equal(fs.existsSync(`${dbPath}-wal`), false);
    dbManager.initDB();   // soft reboot: the server reopens
    assert.equal(journalModeOf(dbPath), 'delete');
    dbManager.close();
  });

  test('DELETE on a fresh install', () => {
    for (const s of ['', '-wal', '-shm']) { fs.rmSync(dbPath + s, { force: true }); }
    config.program.db.journalMode = 'DELETE';
    dbManager.initDB();
    assert.equal(journalModeOf(dbPath), 'delete');
    assert.ok(dbManager.getAllUsers().length >= 0);   // migrated and usable
    dbManager.close();
  });

  test('back to WAL when the decision changes', () => {
    config.program.db.journalMode = 'WAL';
    dbManager.initDB();
    assert.equal(journalModeOf(dbPath), 'wal');
    dbManager.close();
  });

  test('discovery.db: the server sets the mode, a worker inherits it', () => {
    const discPath = path.join(root, 'db', 'discovery.db');
    config.program.db.journalMode = 'DELETE';
    discoveryDb.initDiscoveryDb();             // the server's open
    discoveryDb.closeDiscoveryDb();
    assert.equal(journalModeOf(discPath), 'delete');

    config.program.db.journalMode = 'WAL';     // a worker never decides
    discoveryDb.initDiscoveryDb(discPath);     // the workers' open (explicit path)
    discoveryDb.closeDiscoveryDb();
    assert.equal(journalModeOf(discPath), 'delete');

    discoveryDb.initDiscoveryDb();             // the server again
    discoveryDb.closeDiscoveryDb();
    assert.equal(journalModeOf(discPath), 'wal');
    discoveryDb.initDiscoveryDb(discPath);
    discoveryDb.closeDiscoveryDb();
    assert.equal(journalModeOf(discPath), 'wal');
  });

  test('boot with collection off settles an existing discovery.db into DELETE', () => {
    const discPath = path.join(root, 'db', 'discovery.db');
    const seed = new DatabaseSync(discPath);   // left in WAL, as builds before the fallback kept it
    seed.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS t (x)');
    seed.close();

    config.program.db.journalMode = 'WAL';
    discoveryDb.settleDiscoveryJournalMode();  // nothing to do under WAL
    assert.equal(journalModeOf(discPath), 'wal');

    config.program.db.journalMode = 'DELETE';
    discoveryDb.settleDiscoveryJournalMode();
    assert.equal(journalModeOf(discPath), 'delete');
    assert.equal(discoveryDb.isDiscoveryDbOpen(), false);   // settled, not opened

    fs.rmSync(discPath, { force: true });
    discoveryDb.settleDiscoveryJournalMode();  // no file: it never creates one
    assert.equal(fs.existsSync(discPath), false);
  });

  test('the server keeps synchronous=FULL on the DELETE journal', () => {
    const synchronous = () => dbManager.getDB().prepare('PRAGMA synchronous').get().synchronous;
    config.program.db.synchronous = 'NORMAL';
    try {
      config.program.db.journalMode = 'WAL';
      dbManager.initDB();
      assert.equal(dbManager.isWalMode(), true);
      assert.equal(synchronous(), 1);          // NORMAL, as configured
      config.program.db.journalMode = 'DELETE';
      dbManager.initDB();
      assert.equal(dbManager.isWalMode(), false);
      assert.equal(synchronous(), 2);          // FULL, whatever the setting
      dbManager.setSynchronous('NORMAL');      // the admin's live toggle
      assert.equal(synchronous(), 2);
    } finally {
      config.program.db.synchronous = 'FULL';
      dbManager.close();
    }
  });
});
