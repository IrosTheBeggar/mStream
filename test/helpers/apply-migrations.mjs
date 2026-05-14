// Shared helper: apply every MIGRATIONS entry to a DB.
//
// Test files previously inlined `for (const m of MIGRATIONS) db.exec(m.sql)`
// in 6 different places. Centralising keeps them in lock-step with the
// migration runner in src/db/manager.js and means a future migration
// that needs a different application shape can be handled here in one
// place instead of fanning out across the test surface.

import { MIGRATIONS } from '../../src/db/schema.js';

export function applyAllMigrations(db, { upToVersion = Infinity } = {}) {
  for (const m of MIGRATIONS) {
    if (m.version > upToVersion) { break; }
    db.exec(m.sql);
    db.exec(`PRAGMA user_version = ${m.version}`);
  }
}
