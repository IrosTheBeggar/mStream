#!/usr/bin/env node
// Standalone rollback script for migration V36 (tracks.source provenance).
//
// Drops the `source` column from the `tracks` table and resets
// PRAGMA user_version from 36 back to 35. The migration runner is one-
// way up-only by design — this script is the escape hatch for the rare
// case where the column needs to come off without a full DB restore
// (e.g. a downstream consumer started reading it incorrectly and an
// admin wants to roll the schema back to V35 while a fix ships).
//
// ── BOOMERANG CAVEAT ──────────────────────────────────────────────────
// If you run this against a database still attached to a V36-aware
// codebase, the next process boot will re-apply V36. The migration
// runner detects user_version = 35 and just re-runs it.
//
// The supported way to use this script is:
//   1. Stop the mStream service.
//   2. Check out a pre-V36 build of the code (or otherwise prevent the
//      next boot from auto-migrating — e.g. set a wrapper env var).
//   3. Run this script against the DB path.
//   4. Start the pre-V36 build.
//
// Without step 2, the rollback reverses on the next boot.
//
// ── USAGE ─────────────────────────────────────────────────────────────
//   node scripts/rollback-v36.js <path-to-mstream.db>
//
//   Examples:
//     node scripts/rollback-v36.js ~/.mstream/save/mstream.db
//     node scripts/rollback-v36.js /var/lib/mstream/mstream.db
//
// Exits 0 on success, 1 on error. Logs what it did to stderr so the
// operator has a record even when stdout is piped.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_V36_DOWN } from '../src/db/schema.js';

function fail(msg) {
  process.stderr.write(`[rollback-v36] ERROR: ${msg}\n`);
  process.exit(1);
}

function info(msg) {
  process.stderr.write(`[rollback-v36] ${msg}\n`);
}

const dbPath = process.argv[2];
if (!dbPath) {
  fail('missing database path. Usage: node scripts/rollback-v36.js <path-to-mstream.db>');
}
if (!fs.existsSync(dbPath)) {
  fail(`database not found: ${path.resolve(dbPath)}`);
}

info(`opening database: ${path.resolve(dbPath)}`);
const db = new DatabaseSync(dbPath);

// Match the connection setup mStream uses so we behave consistently
// during rollback. Not strictly required for a simple ALTER TABLE
// DROP COLUMN but keeps semantics symmetric with the live server.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA recursive_triggers = ON');

const beforeVersion = db.prepare('PRAGMA user_version').get().user_version;
info(`current user_version: ${beforeVersion}`);

if (beforeVersion < 36) {
  info('user_version is already below 36 — nothing to roll back.');
  db.close();
  process.exit(0);
}

// Snapshot whether the `source` column is currently present, so the log
// records what changed (not just "ran SQL").
const hadColumn = db.prepare("PRAGMA table_info(tracks)").all()
  .some(c => c.name === 'source');
info(`tracks.source column present before rollback: ${hadColumn}`);

// Single transaction so a mid-rollback failure leaves the DB at V36
// rather than partly-stripped (where the next boot would see
// user_version=35 + a still-present `source` column and bomb on the
// scanner's INSERT, which targets the V36 column list).
db.exec('BEGIN');
try {
  db.exec(SCHEMA_V36_DOWN);
  db.exec('COMMIT');
} catch (err) {
  try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
  fail(`SCHEMA_V36_DOWN failed: ${err.message}`);
}

const afterVersion = db.prepare('PRAGMA user_version').get().user_version;
const stillHasColumn = db.prepare("PRAGMA table_info(tracks)").all()
  .some(c => c.name === 'source');

info(`rollback complete. user_version: ${beforeVersion} → ${afterVersion}`);
info(`tracks.source column present after rollback: ${stillHasColumn}`);

if (afterVersion !== 35 || stillHasColumn) {
  fail(`unexpected residual state — expected user_version=35 and column gone, got ${afterVersion} and column=${stillHasColumn}`);
}

db.close();

process.stderr.write('\n');
process.stderr.write('[rollback-v36] WARNING: BOOMERANG\n');
process.stderr.write('[rollback-v36] If this database is opened by a V36-aware mStream\n');
process.stderr.write('[rollback-v36] build, the next boot will re-apply V36 automatically.\n');
process.stderr.write('[rollback-v36] Roll the code back to a pre-V36 image before starting\n');
process.stderr.write('[rollback-v36] the server, or this rollback will reverse itself.\n');
process.stderr.write('[rollback-v36] See docs/migration-rollback.md for the runbook.\n');
