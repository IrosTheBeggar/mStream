// SQLite journal mode for mStream's multi-process databases.
//
// mstream.db and discovery.db have writers in several processes: the server,
// the scanner (rust-parser or scanner.mjs) and the enrichment workers. WAL
// coordinates them with POSIX locks on the -shm file, and a closing
// connection decides whether it is the LAST one (and may checkpoint and
// unlink the WAL) by trying for a lock on the database file. Both assume a
// lock held by one process is visible to every other process.
//
// Docker Desktop bind mounts break that in one precise way (macOS host,
// `fakeowner` over virtiofs, statfs magic 0x6a656a63; measured 2026-10-28 on
// Docker Desktop 4.85, kernel 6.12.76-linuxkit): a lock taken through the
// file descriptor that CREATED the file is invisible to other processes,
// while a lock taken through any later open of it works. SQLite creates -shm
// on the first open after every clean shutdown, so the server, always the
// first opener, coordinates with no one: other processes' commits overwrite
// its WAL frames, and on a fresh install (the server also creates mstream.db)
// the first other process to close takes itself for the last connection and
// unlinks the WAL under the server, which then commits into a deleted file.
// Silent data loss, with integrity_check still reporting ok.
//
// A rollback journal keeps every lock on the database file itself. Opened,
// never created, by every connection (ensureDbFile), that file's locks work
// on such a mount, so there mStream falls back to journal_mode=DELETE. The
// server owns the mode: it decides here, sets it on open, and the mode
// persists in the database header; every other process inherits it from the
// header instead of forcing WAL.
//
// The decision needs a second process (POSIX locks never conflict within one
// process), so it costs one short child at boot. It is skipped where it can
// only say "fine": off Linux (the quirk is the Linux VM's fakeowner module)
// and on local Linux filesystems, whose locks are the kernel's own.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import winston from 'winston';
import { DatabaseSync } from './sqlite-driver.js';
import { getDirname } from '../util/esm-helpers.js';
import { runWorkerSync } from '../util/worker-process.js';

const PROBE_SCRIPT = path.join(getDirname(import.meta.url), 'lock-probe.mjs');

// One open, one locked read per file: well under a second even on a slow
// NAS. Anything near this means a hung filesystem, not a verdict.
export const LOCK_PROBE_TIMEOUT_MS = 15 * 1000;

// statfs(2) f_type of local Linux filesystems. Their locks never leave the
// kernel, so no probe: the verdict is WAL. (ext2/3/4 share one magic.)
const LOCAL_FS = new Map([
  [0xEF53, 'ext4'], [0x58465342, 'xfs'], [0x9123683E, 'btrfs'],
  [0x2FC12FC1, 'zfs'], [0xF2F52010, 'f2fs'], [0xCA451A4E, 'bcachefs'],
  [0x01021994, 'tmpfs'], [0x794C7630, 'overlayfs'],
]);
// Names for the log line only; anything else is printed as its magic.
const OTHER_FS = new Map([
  [0x6A656A63, 'fakeowner'], [0x65735546, 'fuse'],
  [0x6969, 'nfs'], [0xFF534D42, 'cifs'], [0xFE534D42, 'smb2'], [0x01021997, '9p'],
]);

function fsName(type) {
  if (type === null || type === undefined) { return 'unknown filesystem'; }
  return LOCAL_FS.get(type) || OTHER_FS.get(type) || `filesystem 0x${type.toString(16)}`;
}

// Create the database file, empty, if it does not exist yet, so SQLite's
// own open never creates it: a connection holding its database through the
// creating descriptor has invisible locks on the mounts described above. An
// empty file is a valid empty database. Any other failure (missing
// directory, no permission) is left to SQLite's open, which reports it the
// way it always has.
export function ensureDbFile(dbPath) {
  try {
    fs.closeSync(fs.openSync(dbPath, 'wx'));
  } catch (_err) { /* exists — or SQLite's open reports the real problem */ }
}

// Ask a child process whether it can read two databases this process holds
// EXCLUSIVE locks on: one that SQLite's open created (its lock goes through
// the creating descriptor) and one that existed before SQLite opened it (the
// way every connection opens a live database). Returns
// { created, reopened }, each 'locked' (the lock is visible: correct) or
// 'readable' (it is not); throws when the probe cannot run or answer.
export function probeLockVisibility(dir, { run = runProbeChild } = {}) {
  const stem = path.join(dir, `.mstream-lock-probe-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  const created = `${stem}-created.db`;
  const reopened = `${stem}-reopened.db`;
  const held = [];
  try {
    const a = new DatabaseSync(created);
    held.push(a);
    a.exec('BEGIN EXCLUSIVE');
    fs.closeSync(fs.openSync(reopened, 'wx'));
    const b = new DatabaseSync(reopened);
    held.push(b);
    b.exec('BEGIN EXCLUSIVE');

    const results = run([created, reopened]);
    const [createdResult, reopenedResult] = Array.isArray(results) ? results : [];
    for (const r of [createdResult, reopenedResult]) {
      if (r !== 'locked' && r !== 'readable') {
        throw new Error(`unexpected probe answer: ${JSON.stringify(results)}`);
      }
    }
    return { created: createdResult, reopened: reopenedResult };
  } finally {
    for (const db of held) {
      try { db.exec('ROLLBACK'); } catch (_err) { /* no transaction */ }
      try { db.close(); } catch (_err) { /* already closed */ }
    }
    for (const file of [created, reopened]) {
      for (const suffix of ['', '-journal']) {
        try { fs.unlinkSync(file + suffix); } catch (_err) { /* never created */ }
      }
    }
  }
}

function runProbeChild(paths) {
  const r = runWorkerSync('lock-probe', PROBE_SCRIPT, JSON.stringify({ paths }),
    { timeout: LOCK_PROBE_TIMEOUT_MS });
  if (r.error) { throw r.error; }
  const line = String(r.stdout || '').split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l.startsWith('{')).pop();
  let verdict = null;
  try { verdict = JSON.parse(line); } catch (_err) { /* no verdict line */ }
  if (!verdict?.results) {
    const why = r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
    const stderr = String(r.stderr || '').trim().split(/\r?\n/).slice(-2).join(' | ');
    throw new Error(`the probe gave no answer (${why})${stderr ? `: ${stderr}` : ''}`);
  }
  return verdict.results;
}

const verdicts = new Map();

// Test hook: forget every directory's verdict.
export function resetJournalModeVerdicts() {
  verdicts.clear();
}

// The journal mode for databases in `dir`: 'WAL', or 'DELETE' where locks
// are not reliable across processes. `override` is config db.journalMode
// ('auto' probes). Decided once per directory per process — a soft reboot
// reuses it — and logged when it is not plain WAL.
export function resolveJournalMode(dir, {
  override = 'auto',
  platform = process.platform,
  statfs = (d) => fs.statfsSync(d),
  probe = probeLockVisibility,
  log = winston,
} = {}) {
  if (override === 'WAL' || override === 'DELETE') { return override; }

  const key = path.resolve(dir);
  if (verdicts.has(key)) { return verdicts.get(key); }

  let mode = 'WAL';
  let type = null;
  try { type = statfs(dir).type; } catch (_err) { /* unknown — probe it */ }
  if (platform === 'linux' && !LOCAL_FS.has(type)) {
    const where = `${dir} (${fsName(type)})`;
    try {
      const seen = probe(dir);
      if (seen.reopened === 'readable') {
        mode = 'DELETE';
        log.error(`SQLite: file locks do not work across processes on ${where}. `
          + 'The scanner and workers share the database from separate processes, so it can be '
          + 'damaged here; using journal_mode=DELETE, but move storage.dbDirectory to a local disk.');
      } else if (seen.created === 'readable') {
        mode = 'DELETE';
        log.warn(`SQLite: on ${where} a file lock taken through the handle that created the file `
          + 'is invisible to other processes (Docker Desktop bind mounts do this). WAL would '
          + 'silently lose writes there, so mStream uses journal_mode=DELETE: safe, but slower '
          + 'while a scan runs. For full speed keep storage.dbDirectory on a Docker named volume '
          + 'or a local disk.');
      }
    } catch (err) {
      log.warn(`SQLite: could not check file locking on ${where} — keeping WAL: ${err.message}`);
    }
  }
  verdicts.set(key, mode);
  return mode;
}

// How long leaving WAL keeps trying while another process has the database
// open. That switch takes its EXCLUSIVE lock without the busy handler, so
// busy_timeout never applies: it fails at once. Same budget as busy_timeout.
export const LEAVE_WAL_WAIT_MS = 5000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Put a freshly opened connection in `mode` ('WAL' | 'DELETE') and return
// the mode it ends up in. The mode is stored in the database header, so this
// decides it for every other process's connection too.
//
// Entering WAL throws what SQLite throws, as opening this way always has: a
// database that can't be used fails the boot loudly. A filesystem that can't
// map WAL's shared memory may answer with the old mode instead — a rollback
// journal, which works there — and that is only logged.
//
// Leaving WAL needs the database to itself, so it is retried while another
// process still holds it; one that holds it past `waitMs` (a second server
// on the same files, a `sqlite3` shell) wins, and the database stays WAL
// with an error naming the cure.
export function setJournalMode(db, mode, dbPath, { log = winston, waitMs = LEAVE_WAL_WAIT_MS } = {}) {
  const want = mode === 'DELETE' ? 'DELETE' : 'WAL';
  const pragma = () => db.prepare(`PRAGMA journal_mode = ${want}`).get()?.journal_mode;
  if (want === 'WAL') {
    const got = pragma();
    if (String(got).toLowerCase() !== 'wal') {
      log.warn(`SQLite: ${dbPath} could not enter WAL; it stays in journal_mode=${got}.`);
    }
    return got;
  }

  const deadline = Date.now() + waitMs;
  let failure;
  let busy = false;
  for (;;) {
    try {
      const got = pragma();
      if (String(got).toLowerCase() === 'delete') { return got; }
      failure = `still ${got}`;
      break;
    } catch (err) {
      failure = err.message;
      busy = (err.errcode & 0xff) === 5;
      if (!busy || Date.now() >= deadline) { break; }
      sleepSync(50);
    }
  }
  let now = null;
  try { now = db.prepare('PRAGMA journal_mode').get()?.journal_mode; } catch (_err) { /* reported below */ }
  log.error(`SQLite: could not put ${dbPath} in journal_mode=DELETE (${failure}); it stays `
    + `${now ?? 'as it was'}.`
    + (busy ? ' Another process still has it open: stop it and restart mStream.' : ''));
  return now;
}
