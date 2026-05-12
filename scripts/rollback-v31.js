#!/usr/bin/env node
// Standalone rollback script for migration V31 (FTS5 search index).
//
// Drops the three FTS5 virtual tables, their nine sync triggers, and
// resets PRAGMA user_version from 31 back to 30. The migration runner
// is one-way up-only by design — this script is the rare-case escape
// hatch for when something about FTS5 specifically needs to be undone
// without a full DB restore.
//
// ── BOOMERANG CAVEAT ──────────────────────────────────────────────────
// If you run this against a database that is still attached to a
// v31-aware codebase, the next process boot will re-apply V31. The
// migration runner detects user_version = 30 and just re-runs it.
//
// The supported way to use this script is:
//   1. Stop the mStream service.
//   2. Check out a pre-V31 build of the code (or otherwise prevent the
//      next boot from auto-migrating — e.g. set a wrapper env var).
//   3. Run this script against the DB path.
//   4. Start the pre-V31 build.
//
// Without step 2, the rollback reverses on the next boot.
//
// ── USAGE ─────────────────────────────────────────────────────────────
//   node scripts/rollback-v31.js <path-to-mstream.db>
//
//   Examples:
//     node scripts/rollback-v31.js ~/.mstream/save/mstream.db
//     node scripts/rollback-v31.js /var/lib/mstream/mstream.db
//
// Exits 0 on success, 1 on error. Logs what it did to stderr so the
// operator has a record even when stdout is piped.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_V31_DOWN } from '../src/db/schema.js';

function fail(msg) {
  process.stderr.write(`[rollback-v31] ERROR: ${msg}\n`);
  process.exit(1);
}

function info(msg) {
  process.stderr.write(`[rollback-v31] ${msg}\n`);
}

const dbPath = process.argv[2];
if (!dbPath) {
  fail('missing database path. Usage: node scripts/rollback-v31.js <path-to-mstream.db>');
}
if (!fs.existsSync(dbPath)) {
  fail(`database not found: ${path.resolve(dbPath)}`);
}

info(`opening database: ${path.resolve(dbPath)}`);
const db = new DatabaseSync(dbPath);

// Match the connection setup mStream uses so we behave consistently
// if anything in the migration relies on FK / WAL semantics. The
// recursive_triggers pragma is what V31 itself relies on; not strictly
// needed for the down path (we're only dropping objects, not firing
// cascades) but keeps the connection symmetric with the live server.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA recursive_triggers = ON');

const beforeVersion = db.prepare('PRAGMA user_version').get().user_version;
info(`current user_version: ${beforeVersion}`);

if (beforeVersion < 31) {
  info('user_version is already below 31 — nothing to roll back.');
  db.close();
  process.exit(0);
}

// Snapshot the FTS objects we're about to drop so the log shows what
// happened, not just "ran SQL". Helpful when troubleshooting.
const objectsBefore = db.prepare(
  "SELECT type, name FROM sqlite_master WHERE name LIKE 'fts_%' OR name LIKE '%_fts'"
).all();
info(`will drop ${objectsBefore.length} FTS-related objects:`);
for (const obj of objectsBefore) {
  info(`  ${obj.type.padEnd(8)} ${obj.name}`);
}

// Single transaction so a mid-rollback failure leaves the DB at v31
// rather than partly-stripped (where the next boot would see
// user_version=30 + half the triggers gone and bomb on the next write).
db.exec('BEGIN');
try {
  db.exec(SCHEMA_V31_DOWN);
  db.exec('COMMIT');
} catch (err) {
  try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
  fail(`SCHEMA_V31_DOWN failed: ${err.message}`);
}

const afterVersion = db.prepare('PRAGMA user_version').get().user_version;
const objectsAfter = db.prepare(
  "SELECT name FROM sqlite_master WHERE name LIKE 'fts_%' OR name LIKE '%_fts'"
).all();

info(`rollback complete. user_version: ${beforeVersion} → ${afterVersion}`);
info(`FTS-related objects remaining: ${objectsAfter.length}`);

if (afterVersion !== 30 || objectsAfter.length !== 0) {
  // Strict check — if the schema down didn't fully clean up, something
  // unexpected was already on disk. Bail loudly so the operator
  // investigates rather than continuing with a half-rolled DB.
  fail(`unexpected residual state — expected user_version=30 and 0 objects, got ${afterVersion} and ${objectsAfter.length}`);
}

db.close();

process.stderr.write('\n');
process.stderr.write('[rollback-v31] WARNING: BOOMERANG\n');
process.stderr.write('[rollback-v31] If this database is opened by a v31-aware mStream\n');
process.stderr.write('[rollback-v31] build, the next boot will re-apply V31 automatically.\n');
process.stderr.write('[rollback-v31] Roll the code back to a pre-V31 image before starting\n');
process.stderr.write('[rollback-v31] the server, or this rollback will reverse itself.\n');
process.stderr.write('[rollback-v31] See docs/migration-rollback.md for the runbook.\n');
