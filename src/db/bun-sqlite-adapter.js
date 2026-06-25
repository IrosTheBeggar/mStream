// node:sqlite `DatabaseSync`-compatible shim backed by `bun:sqlite`.
//
// Bun has no `node:sqlite` module, but it ships `bun:sqlite` (SQLite 3.53.0 with
// FTS5). mStream's DB usage is narrow — new DatabaseSync(path[, {readOnly}]),
// .exec(sql), .prepare(sql) -> {run,get,all}(...positionalParams), .close() —
// with no user-defined functions, named params, BigInt, or extension loading,
// so this thin wrapper is enough. Used only under the Bun runtime; Node keeps
// using the real node:sqlite (see sqlite-driver.js).
import { Database } from 'bun:sqlite';

class StatementSync {
  #stmt;
  constructor(stmt) { this.#stmt = stmt; }
  // bun:sqlite .run() already returns { changes, lastInsertRowid }.
  run(...params) { return this.#stmt.run(...params); }
  // node:sqlite returns `undefined` on a miss; bun:sqlite returns `null`.
  get(...params) { const row = this.#stmt.get(...params); return row === null ? undefined : row; }
  all(...params) { return this.#stmt.all(...params); }
}

export class DatabaseSync {
  #db;
  constructor(location, options = {}) {
    this.#db = options.readOnly
      ? new Database(location, { readonly: true })
      : new Database(location, { create: true });
  }
  exec(sql) { this.#db.exec(sql); }
  prepare(sql) { return new StatementSync(this.#db.prepare(sql)); }
  close() { this.#db.close(); }
}
