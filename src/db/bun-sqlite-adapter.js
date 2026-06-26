// node:sqlite `DatabaseSync`-compatible shim backed by `bun:sqlite`.
//
// Bun has no `node:sqlite` module, but it ships `bun:sqlite` (SQLite 3.53.0 with
// FTS5). mStream's DB usage is narrow — new DatabaseSync(path[, {readOnly}]),
// .exec(sql), .prepare(sql) -> {run,get,all}(...positionalParams), .close() —
// with no user-defined functions, named params, BigInt, or extension loading,
// so this thin wrapper is enough. Used only under the Bun runtime; Node keeps
// using the real node:sqlite (see sqlite-driver.js).
import { Database } from 'bun:sqlite';

// node:sqlite raises errors with code 'ERR_SQLITE_ERROR' for SQL/exec/MATCH
// failures; bun:sqlite raises a SQLiteError whose code is the native SQLite
// name ('SQLITE_ERROR', ...) or undefined (e.g. FTS5 MATCH parse errors).
// Callers key on the node-style code — notably the FTS5->LIKE search fallback
// in src/api/search.js and src/api/subsonic/handlers.js — so translate it here
// so the shim is behaviourally indistinguishable from node:sqlite.
function withNodeErrors(fn) {
  try {
    return fn();
  } catch (err) {
    if (err && err.name === 'SQLiteError') { err.code = 'ERR_SQLITE_ERROR'; }
    throw err;
  }
}

class StatementSync {
  #stmt;
  constructor(stmt) { this.#stmt = stmt; }
  // bun:sqlite .run() already returns { changes, lastInsertRowid }.
  run(...params) { return withNodeErrors(() => this.#stmt.run(...params)); }
  // node:sqlite returns `undefined` on a miss; bun:sqlite returns `null`.
  get(...params) { return withNodeErrors(() => { const row = this.#stmt.get(...params); return row === null ? undefined : row; }); }
  all(...params) { return withNodeErrors(() => this.#stmt.all(...params)); }
}

export class DatabaseSync {
  #db;
  constructor(location, options = {}) {
    this.#db = options.readOnly
      ? new Database(location, { readonly: true })
      : new Database(location, { create: true });
  }
  exec(sql) { return withNodeErrors(() => this.#db.exec(sql)); }
  prepare(sql) { return new StatementSync(withNodeErrors(() => this.#db.prepare(sql))); }
  close() { this.#db.close(); }
}
