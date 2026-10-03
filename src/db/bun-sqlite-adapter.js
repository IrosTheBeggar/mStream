// node:sqlite `DatabaseSync`-compatible shim backed by `bun:sqlite`.
//
// Bun 1.3 has no `node:sqlite` module, but it ships `bun:sqlite` with FTS5 (its
// own SQLite on Linux/Windows; on macOS it loads the system libsqlite3, 3.51.0
// on macOS 26). mStream's DB usage is narrow — new DatabaseSync(path[, {readOnly}]),
// .exec(sql), .prepare(sql) -> {run,get,all}(...positionalParams), .close() —
// with no user-defined functions, named params, BigInt, or extension loading,
// so this thin wrapper is enough. Used only under the Bun runtime; Node keeps
// using the real node:sqlite (see sqlite-driver.js).
import { Database } from 'bun:sqlite';

// sqlite3_errstr() text, indexed by primary result code (extended & 0xff) —
// what node:sqlite reports as `errstr`. 516 is the one extended code with its
// own text.
const ERRSTR = [
  'not an error', 'SQL logic error', 'unknown error', 'access permission denied',
  'query aborted', 'database is locked', 'database table is locked', 'out of memory',
  'attempt to write a readonly database', 'interrupted', 'disk I/O error',
  'database disk image is malformed', 'unknown operation', 'database or disk is full',
  'unable to open database file', 'locking protocol', 'unknown error',
  'database schema has changed', 'string or blob too big', 'constraint failed',
  'datatype mismatch', 'bad parameter or other API misuse', 'unknown error',
  'authorization denied', 'unknown error', 'column index out of range',
  'file is not a database', 'notification message', 'warning message',
];
const errstr = (errcode) => (errcode === 516 ? 'abort due to ROLLBACK' : ERRSTR[errcode & 0xff] ?? 'unknown error');

// node:sqlite raises a plain Error { code: 'ERR_SQLITE_ERROR', errcode, errstr }
// for every SQLite failure; bun:sqlite raises a SQLiteError whose `errno` is
// the extended result code and whose `code` is the native name. That `code` is
// a read-only own property — on native-coded errors (constraints, BUSY) in
// 1.3.x and on EVERY error in 1.4.x ('SQLITE_ERROR' for syntax / FTS5 MATCH
// failures) — so it cannot be rewritten in place: assigning it throws a
// TypeError that hides the real error. Build a node-shaped Error instead.
// Callers key on that shape — the FTS5->LIKE search fallback in
// src/api/search.js on `code`, the duplicate-peer / revoked-key paths on the
// message — so the shim is behaviourally indistinguishable from node:sqlite.
// Bun's own errors (parameter count, bad bindings) pass through untouched.
function withNodeErrors(fn) {
  try {
    return fn();
  } catch (err) {
    if (err?.name !== 'SQLiteError') { throw err; }
    const e = new Error(err.message, { cause: err });
    e.code = 'ERR_SQLITE_ERROR';
    e.errcode = err.errno;
    e.errstr = errstr(err.errno);
    // The native name, e.g. 'SQLITE_CONSTRAINT_UNIQUE'. Non-enumerable, so the
    // error's own keys (and its JSON) stay exactly node:sqlite's.
    Object.defineProperty(e, 'sqliteCode', { value: err.code, writable: true, configurable: true });
    throw e;
  }
}

// node:sqlite refuses any use of a closed database with ERR_INVALID_STATE.
// Bun 1.4 still steps a live statement after close() — the row is written —
// so the check has to happen here, before bun is called.
function invalidState(message) {
  return Object.assign(new Error(message), { code: 'ERR_INVALID_STATE' });
}

class StatementSync {
  #stmt;
  #conn;
  constructor(stmt, conn) { this.#stmt = stmt; this.#conn = conn; }
  #live() {
    if (!this.#conn.open) { throw invalidState('statement has been finalized'); }
    return this.#stmt;
  }
  // bun:sqlite's .run() reports `changes` as a total_changes() delta, which
  // also counts rows written by triggers and FK cascades (a track insert
  // reports 8); node:sqlite reports sqlite3_changes() — the statement's own
  // rows. Callers compare it (orphan-cleanup's `=== ORPHAN_CHUNK_SIZE` yield),
  // so read the real changes() back. lastInsertRowid already matches.
  run(...params) {
    const stmt = this.#live();
    return withNodeErrors(() => {
      const { lastInsertRowid } = stmt.run(...params);
      return { changes: this.#conn.changes(), lastInsertRowid };
    });
  }
  // node:sqlite returns `undefined` on a miss; bun:sqlite returns `null`.
  get(...params) { const stmt = this.#live(); return withNodeErrors(() => { const row = stmt.get(...params); return row === null ? undefined : row; }); }
  all(...params) { const stmt = this.#live(); return withNodeErrors(() => stmt.all(...params)); }
}

export class DatabaseSync {
  #db;
  #changesStmt = null;
  // Shared with every statement: whether the connection is still open, and
  // the statement-level changes() reader that run() reports.
  #conn = {
    open: true,
    changes: () => (this.#changesStmt ??= this.#db.prepare('SELECT changes()')).values()[0][0],
  };
  constructor(location, options = {}) {
    this.#db = withNodeErrors(() => (options.readOnly
      ? new Database(location, { readonly: true })
      : new Database(location, { create: true })));
  }
  #live() {
    if (!this.#conn.open) { throw invalidState('database is not open'); }
    return this.#db;
  }
  // node:sqlite's exec() returns undefined; bun:sqlite's returns a run result.
  exec(sql) { const db = this.#live(); withNodeErrors(() => db.exec(sql)); }
  prepare(sql) { const db = this.#live(); return new StatementSync(withNodeErrors(() => db.prepare(sql)), this.#conn); }
  // A second close() is a no-op here, where node:sqlite throws: being lenient
  // can't lose data, and Node (CI's runtime) still catches a double close.
  close() {
    if (!this.#conn.open) { return; }
    this.#conn.open = false;
    // A live statement keeps bun's connection (and its file handles) open
    // until GC, so finalize the cached one first.
    this.#changesStmt?.finalize();
    this.#changesStmt = null;
    this.#db.close();
  }
}
