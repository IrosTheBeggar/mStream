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
  for (const m of MIGRATIONS) {
    if (m.version <= fromVersion) { continue; }
    if (m.version > upToVersion) { break; }
    db.exec(m.sql);
    db.exec(`PRAGMA user_version = ${m.version}`);
  }
}
