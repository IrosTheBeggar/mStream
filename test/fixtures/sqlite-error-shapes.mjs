// Child-process fixture for test/db/sqlite-driver-errors.test.mjs. Runs under
// Node OR Bun and goes through the runtime-switched driver — node:sqlite on
// Node, the bun:sqlite adapter on Bun — so the test can hold the adapter to
// node:sqlite's observable behaviour: the error shape callers key on
// (src/api/search.js's MATCH fallback on `code`, the duplicate-peer and
// revoked-key paths on the message), run()'s `changes`, and a closed
// database refusing further use.
//
// argv[2] = a scratch directory for the file-backed cases. Prints ONE JSON line
// mapping case name -> { ok: true, value } | { ok: false, err: <shape> }.
import path from 'node:path';
import { DatabaseSync } from '../../src/db/sqlite-driver.js';

const dir = process.argv[2];
const shape = (e) => ({
  isError: e instanceof Error, name: e?.name, message: e?.message,
  code: e?.code, errcode: e?.errcode, errstr: e?.errstr,
});
const cases = {};
const run = (label, fn) => {
  try { cases[label] = { ok: true, value: fn() }; } catch (e) { cases[label] = { ok: false, err: shape(e) }; }
};
const changes = (r) => ({ changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) });

const db = new DatabaseSync(':memory:');
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE u (a UNIQUE);
  CREATE TABLE n (a NOT NULL);
  CREATE TABLE c (a CHECK (a > 0));
  CREATE TABLE k (id INTEGER PRIMARY KEY);
  CREATE TABLE r (k INTEGER REFERENCES k(id) ON DELETE CASCADE);
  CREATE TABLE logged (x);
  CREATE TABLE log (x);
  CREATE TRIGGER logged_ai AFTER INSERT ON logged BEGIN
    INSERT INTO log VALUES (new.x); INSERT INTO log VALUES (new.x);
  END;
  CREATE VIRTUAL TABLE f USING fts5(t, tokenize = 'unicode61 remove_diacritics 1');
  INSERT INTO f VALUES ('hello world');
`);
db.prepare('INSERT INTO u VALUES (?)').run(1);

// Errors: every SQLite failure is a plain Error { code: 'ERR_SQLITE_ERROR',
// errcode, errstr } with SQLite's own message.
run('unique', () => db.prepare('INSERT INTO u VALUES (?)').run(1));
run('notNull', () => db.prepare('INSERT INTO n VALUES (NULL)').run());
run('check', () => db.prepare('INSERT INTO c VALUES (?)').run(-1));
run('foreignKey', () => db.prepare('INSERT INTO r VALUES (?)').run(42));
run('syntaxExec', () => db.exec('SELEC 1'));
run('syntaxPrepare', () => db.prepare('SELEC 1'));
run('noSuchTable', () => db.prepare('SELECT * FROM nope').all());
run('commitNoTxn', () => db.exec('COMMIT'));
// The one user-reachable MATCH failure: a NUL inside a search token.
run('ftsUnterminated', () => db.prepare('SELECT t FROM f WHERE f MATCH ?').all('{t} : "Funny\u0000"*'));
run('ftsOk', () => db.prepare('SELECT t FROM f WHERE f MATCH ?').all('{t} : "hel"*'));

// run(): `changes` counts the statement's own rows only — not trigger or FK
// cascade writes.
run('runOk', () => changes(db.prepare('INSERT INTO u VALUES (?)').run(2)));
run('changesTrigger', () => changes(db.prepare('INSERT INTO logged VALUES (?)').run(7)));
run('changesCascade', () => {
  db.exec('INSERT INTO k VALUES (1); INSERT INTO r VALUES (1); INSERT INTO r VALUES (1); INSERT INTO r VALUES (1)');
  return changes(db.prepare('DELETE FROM k WHERE id = ?').run(1));
});
run('changesMany', () => changes(db.prepare('UPDATE log SET x = ?').run(8)));
run('getMiss', () => db.prepare('SELECT a FROM u WHERE a = ?').get(99) === undefined);
run('execReturns', () => typeof db.exec('SELECT 1'));
db.close();

// BUSY: connection A holds the write lock, B gives up after 50 ms.
const file = path.join(dir, 'busy.db');
const a = new DatabaseSync(file);
a.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x)');
a.exec('BEGIN IMMEDIATE');
const b = new DatabaseSync(file);
b.exec('PRAGMA busy_timeout = 50');
run('busy', () => b.exec('BEGIN IMMEDIATE'));
a.exec('ROLLBACK');
b.close();
a.close();

const ro = new DatabaseSync(file, { readOnly: true });
run('readOnlyWrite', () => ro.exec('INSERT INTO t VALUES (1)'));
ro.close();
run('openFail', () => new DatabaseSync(path.join(dir, 'missing.db'), { readOnly: true }));

// A closed database: every use is an Error { code: 'ERR_INVALID_STATE' }, and
// a statement prepared before close() writes nothing after it.
const closedFile = path.join(dir, 'closed.db');
const closed = new DatabaseSync(closedFile);
closed.exec('CREATE TABLE t (x)');
const insert = closed.prepare('INSERT INTO t VALUES (?)');
const select = closed.prepare('SELECT x FROM t');
insert.run(1);
closed.close();
run('runAfterClose', () => insert.run(2));
run('getAfterClose', () => select.get());
run('execAfterClose', () => closed.exec('SELECT 1'));
run('prepareAfterClose', () => closed.prepare('SELECT 1'));
run('rowsAfterClose', () => {
  const check = new DatabaseSync(closedFile);
  const { n } = check.prepare('SELECT count(*) AS n FROM t').get();
  check.close();
  return n;
});

console.log(JSON.stringify(cases));
