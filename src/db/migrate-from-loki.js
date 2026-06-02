// One-time migration from LokiJS + JSON config to SQLite.
// Migrates: users, folders/libraries, playlists, user metadata, shared playlists.
// Does NOT migrate file metadata (tracks) — the scanner will rescan.
//
// This runs automatically on server boot if:
// 1. The old LokiJS DB files exist
// 2. A .migrated marker file does NOT exist

import fs from 'fs';
import path from 'path';
import winston from 'winston';
import * as config from '../state/config.js';

const MARKER_FILE = '.migrated-from-loki';

export function shouldMigrate() {
  const dbDir = config.program.storage.dbDirectory;
  const markerPath = path.join(dbDir, MARKER_FILE);

  // Already migrated
  if (fs.existsSync(markerPath)) { return false; }

  // Check if any old LokiJS files exist
  const oldFiles = ['user-data.loki-v1.db', 'files.loki-v3.db', 'shared.loki-v1.db'];
  for (const f of oldFiles) {
    if (fs.existsSync(path.join(dbDir, f))) { return true; }
  }

  // Check if config has users or folders (need to migrate to DB)
  if (config.program.users && Object.keys(config.program.users).length > 0) { return true; }
  if (config.program.folders && Object.keys(config.program.folders).length > 0) { return true; }

  return false;
}

export function migrate(db) {
  const dbDir = config.program.storage.dbDirectory;
  winston.info('Starting migration from LokiJS/config to SQLite...');

  // Run all four sub-migrations inside ONE transaction so a partial
  // failure rolls back cleanly. Previously they ran in autocommit: a
  // failure in a later step (e.g. user-metadata) left the earlier steps'
  // rows committed, and because the success marker is only written at the
  // very end, the next boot re-ran the WHOLE migration on top of that
  // partial state. Most inserts are INSERT OR IGNORE (idempotent), but
  // playlist_tracks was a plain INSERT with no unique constraint, so every
  // retry duplicated every playlist's tracks — compounding each boot, and
  // unbounded if the failing step never succeeds. All-or-nothing makes a
  // retry start from a clean slate. Mirrors the per-migration transaction
  // in manager.js runMigrations().
  db.exec('BEGIN');
  try {
    migrateUsersAndFolders(db);
    migratePlaylists(db, dbDir);
    migrateUserMetadata(db, dbDir);
    migrateSharedPlaylists(db, dbDir);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    winston.error('Migration failed — rolled back; will retry on next boot', { stack: err });
    return; // Don't create the marker — allow a clean retry on next boot.
  }

  // Write the success marker only after the transaction committed. If this
  // file write fails the next boot re-runs migrate(); that's now safe —
  // the transaction plus the idempotent inserts (incl. the playlist_tracks
  // clear-before-insert in migratePlaylists) make a re-run a no-op.
  try {
    fs.writeFileSync(path.join(dbDir, MARKER_FILE), new Date().toISOString());
  } catch (err) {
    winston.warn(`Migration committed but marker write failed (${err.message}); will re-run harmlessly next boot`);
  }
  winston.info('Migration from LokiJS complete');
}

// ── Migrate users and folders from JSON config ──────────────────────────────

function migrateUsersAndFolders(db) {
  // Migrate folders → libraries
  if (config.program.folders) {
    const insertLib = db.prepare(
      'INSERT OR IGNORE INTO libraries (name, root_path, type) VALUES (?, ?, ?)'
    );
    for (const [name, folder] of Object.entries(config.program.folders)) {
      insertLib.run(name, folder.root, folder.type || 'music');
      winston.info(`  Migrated library: ${name} → ${folder.root}`);
    }
  }

  // Migrate users
  if (config.program.users) {
    const insertUser = db.prepare(
      `INSERT OR IGNORE INTO users (username, password, salt, is_admin, allow_upload, allow_mkdir, lastfm_user, lastfm_password)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertUserLib = db.prepare(
      'INSERT OR IGNORE INTO user_libraries (user_id, library_id) VALUES (?, ?)'
    );

    for (const [username, userData] of Object.entries(config.program.users)) {
      insertUser.run(
        username,
        userData.password,
        userData.salt,
        userData.admin ? 1 : 0,
        userData.allowUpload !== false ? 1 : 0,
        userData.allowMkdir !== false ? 1 : 0,
        userData['lastfm-user'] || null,
        userData['lastfm-password'] || null
      );

      // Link user to their vpaths
      const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (user && userData.vpaths) {
        for (const vpathName of userData.vpaths) {
          const lib = db.prepare('SELECT id FROM libraries WHERE name = ?').get(vpathName);
          if (lib) {
            insertUserLib.run(user.id, lib.id);
          }
        }
      }

      winston.info(`  Migrated user: ${username}`);
    }
  }
}

// ── Migrate playlists from LokiJS ───────────────────────────────────────────

function migratePlaylists(db, dbDir) {
  const lokiPath = path.join(dbDir, 'user-data.loki-v1.db');
  if (!fs.existsSync(lokiPath)) { return; }

  let lokiData;
  try {
    lokiData = JSON.parse(fs.readFileSync(lokiPath, 'utf8'));
  } catch (_e) {
    winston.warn('  Could not parse user-data.loki-v1.db, skipping playlist migration');
    return;
  }

  const playlistCol = lokiData.collections?.find(c => c.name === 'playlists');
  if (!playlistCol || !playlistCol.data) { return; }

  const insertPlaylist = db.prepare(
    'INSERT OR IGNORE INTO playlists (name, user_id) VALUES (?, ?)'
  );
  // playlist_tracks has no unique constraint, so clear any prior rows for
  // this playlist before (re)inserting. Without this, a re-run of
  // migrate() — after a partial failure, or if the success-marker write
  // failed — would APPEND a second copy of every track. Belt-and-braces
  // alongside the migrate() transaction so the migration is fully
  // idempotent however it gets re-entered.
  const clearTracks = db.prepare(
    'DELETE FROM playlist_tracks WHERE playlist_id = ?'
  );
  const insertTrack = db.prepare(
    'INSERT INTO playlist_tracks (playlist_id, filepath, position) VALUES (?, ?, ?)'
  );

  // Group by playlist name + user
  const playlistMap = {};
  for (const row of playlistCol.data) {
    const key = `${row.user}::${row.name}`;
    if (!playlistMap[key]) {
      playlistMap[key] = { name: row.name, user: row.user, songs: [] };
    }
    if (row.filepath) {
      playlistMap[key].songs.push(row.filepath);
    }
  }

  let count = 0;
  for (const pl of Object.values(playlistMap)) {
    const user = db.prepare('SELECT id FROM users WHERE username = ?').get(pl.user);
    if (!user) { continue; }

    insertPlaylist.run(pl.name, user.id);
    const playlist = db.prepare(
      'SELECT id FROM playlists WHERE name = ? AND user_id = ?'
    ).get(pl.name, user.id);
    if (!playlist) { continue; }

    clearTracks.run(playlist.id);   // idempotent: drop any rows from a prior run
    for (let i = 0; i < pl.songs.length; i++) {
      insertTrack.run(playlist.id, pl.songs[i], i);
    }
    count++;
  }

  winston.info(`  Migrated ${count} playlists`);
}

// ── Migrate user metadata (ratings, play counts) from LokiJS ────────────────

function migrateUserMetadata(db, dbDir) {
  const lokiPath = path.join(dbDir, 'user-data.loki-v1.db');
  if (!fs.existsSync(lokiPath)) { return; }

  let lokiData;
  try {
    lokiData = JSON.parse(fs.readFileSync(lokiPath, 'utf8'));
  } catch (_e) { return; }

  const metaCol = lokiData.collections?.find(c => c.name === 'user-metadata');
  if (!metaCol || !metaCol.data) { return; }

  const insertMeta = db.prepare(`
    INSERT OR IGNORE INTO user_metadata (user_id, track_hash, play_count, last_played, rating)
    VALUES (?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (const row of metaCol.data) {
    if (!row.hash || !row.user) { continue; }

    const user = db.prepare('SELECT id FROM users WHERE username = ?').get(row.user);
    if (!user) { continue; }

    const lastPlayed = row.lp ? new Date(row.lp).toISOString() : null;
    insertMeta.run(user.id, row.hash, row.pc || 0, lastPlayed, row.rating || null);
    count++;
  }

  winston.info(`  Migrated ${count} user metadata records`);
}

// ── Migrate shared playlists from LokiJS ────────────────────────────────────

function migrateSharedPlaylists(db, dbDir) {
  const lokiPath = path.join(dbDir, 'shared.loki-v1.db');
  if (!fs.existsSync(lokiPath)) { return; }

  let lokiData;
  try {
    lokiData = JSON.parse(fs.readFileSync(lokiPath, 'utf8'));
  } catch (_e) {
    winston.warn('  Could not parse shared.loki-v1.db, skipping shared playlist migration');
    return;
  }

  const shareCol = lokiData.collections?.find(c => c.name === 'playlists');
  if (!shareCol || !shareCol.data) { return; }

  const insertShare = db.prepare(`
    INSERT OR IGNORE INTO shared_playlists (share_id, playlist_json, user_id, expires, token)
    VALUES (?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (const row of shareCol.data) {
    if (!row.playlistId) { continue; }

    let userId = null;
    if (row.user) {
      const user = db.prepare('SELECT id FROM users WHERE username = ?').get(row.user);
      if (user) { userId = user.id; }
    }

    const playlistJson = JSON.stringify(row.playlist || []);
    insertShare.run(row.playlistId, playlistJson, userId, row.expires || null, row.token || null);
    count++;
  }

  winston.info(`  Migrated ${count} shared playlists`);
}
