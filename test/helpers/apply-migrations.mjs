// Shared helper: apply every MIGRATIONS entry to a DB.
//
// Test files previously inlined `for (const m of MIGRATIONS) db.exec(m.sql)`
// in 6 different places. Centralising keeps them in lock-step with the
// migration runner in src/db/manager.js and means a future migration
// that needs a different application shape can be handled here in one
// place instead of fanning out across the test surface.

import { MIGRATIONS } from '../../src/db/schema.js';

// fromVersion is an exclusive lower bound — pass the fixture DB's current
// user_version to apply only the migrations a real upgrade would run,
// matching the `migration.version > currentVersion` gate in manager.js.
export function applyAllMigrations(db, { upToVersion = Infinity, fromVersion = 0 } = {}) {
  // The chain is 70+ DDL statements. At SQLite's default synchronous = FULL
  // each one fsyncs, and on a rollback-journal DB that measured ~5s per
  // chain (~2.4s in WAL) against ~0.17s at NORMAL. It is applied at ~99 call
  // sites across the suite, so this one line is the single cheapest speed-up
  // available to it.
  //
  // NORMAL is not a durability downgrade worth worrying about here: these are
  // throwaway temp DBs, and it is what BOTH production scanners already open
  // with (src/db/scanner.mjs, rust-parser/src/main.rs). Only a power loss or
  // OS crash can drop the last transactions — a process crash cannot, and no
  // test asserts on post-crash durability.
  //
  // Set on the caller's connection, so callers that build a schema this way
  // benefit without each having to remember the pragma.
  try { db.exec('PRAGMA synchronous = NORMAL'); }
  catch (err) { console.warn(`could not set synchronous=NORMAL on the test DB: ${err.message}`); }

  for (const m of MIGRATIONS) {
    if (m.version <= fromVersion) { continue; }
    if (m.version > upToVersion) { break; }
    db.exec(m.sql);
    // Per-migration JS hook (V59+) — matches the runner in manager.js.
    if (m.js) { m.js(db); }
    db.exec(`PRAGMA user_version = ${m.version}`);
  }
}
