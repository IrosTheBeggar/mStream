// Backup configuration + status endpoints.
//
// All routes are mounted under /api/v1/admin/backup/, which inherits the
// admin gate registered in src/api/admin.js (rejects non-admin requests
// and lockAdmin sessions). No additional auth check needed here.
//
// The actual backup execution lives in src/backup/manager.js — this
// module is just a thin HTTP face over the db helpers + manager triggers.

import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import Joi from 'joi';
import * as db from '../db/manager.js';
import * as backupManager from '../backup/manager.js';
import { joiValidate } from '../util/validation.js';
import WebError from '../util/web-error.js';

const TRIGGER_TYPES = ['after-scan', 'daily', 'manual'];

// Default exclude patterns live in db/manager.js (DEFAULT_BACKUP_EXCLUDE_GLOBS)
// so this module, the task-queue, and any future caller all read the same
// list. Resolution from "stored value (NULL or JSON)" → "concrete array"
// also lives there as db.getEffectiveExcludeGlobs.

// Cap on glob count + pattern length, mostly to keep a misbehaving
// client from stuffing megabytes of regex-DoS material into a row.
const MAX_GLOBS = 64;
const MAX_GLOB_LENGTH = 256;

// Cap on inter-file throttle. Anything above 60s between files is almost
// certainly a typo (a 100k-file library at 60s/file would take 70 days).
// Keeping a hard upper bound makes runaway misconfiguration recoverable
// without an admin reaching into the DB.
const MAX_INTER_FILE_DELAY_MS = 60_000;

function validateExcludeGlobs(globs) {
  if (!Array.isArray(globs)) {
    throw new Error('excludeGlobs must be an array of strings');
  }
  if (globs.length > MAX_GLOBS) {
    throw new Error(`excludeGlobs may have at most ${MAX_GLOBS} patterns`);
  }
  for (const g of globs) {
    if (typeof g !== 'string') {
      throw new Error('excludeGlobs entries must be strings');
    }
    if (g.length === 0 || g.length > MAX_GLOB_LENGTH) {
      throw new Error(`excludeGlobs entries must be 1..${MAX_GLOB_LENGTH} chars`);
    }
  }
}

// Daily-at-hour is required when triggerType=daily, optional otherwise.
// Validated together rather than as a Joi conditional so the error
// message is clearer. WebError so the global handler answers 400 —
// a plain Error here used to surface as a bare 500 'Server Error'
// with the message swallowed.
function requireDailyHour(body) {
  if (body.triggerType === 'daily' && (body.dailyAtHour == null)) {
    throw new WebError("dailyAtHour is required when triggerType is 'daily'", 400);
  }
}

// Path comparison normalisation, shared by every containment/overlap
// check below. Trailing-separator so /music isn't a prefix of /musical.
//
// Case-folded on Windows AND macOS because both NTFS/exFAT/FAT32 and
// the default APFS/HFS+ are case-INSENSITIVE — `C:\Music` and
// `c:\music\sub` (or `~/Music` and `~/music/backup`) are the same
// hierarchy to the OS, and a strict-string startsWith would miss the
// containment. Linux ext4 stays case-sensitive (its default) so we
// don't over-restrict valid Linux configurations. macOS users who
// explicitly opt into case-sensitive APFS get a slightly stricter
// check than their FS requires — a small acceptable cost vs. the
// alternative of missing a containment loop.
//
// Unicode-normalised to NFC because HFS+ stores filenames as NFD on
// disk; if either path goes through HFS+ at any point, comparison
// without normalisation can miss a match (the same logical filename
// in NFC and NFD forms differs as raw bytes). NFC is idempotent so
// the normalisation is free for paths that don't need it.
const CASE_FOLD = process.platform === 'win32' || process.platform === 'darwin';
function normForCompare(p) {
  let r = path.resolve(p).normalize('NFC') + path.sep;
  if (CASE_FOLD) { r = r.toLowerCase(); }
  return r;
}

// Resolve a path to its REAL location before comparing: a symlink or
// junction anywhere in the chain is what containment must be judged
// against, not the lexical spelling — `/backup` pointing into `/music`
// passes every string comparison while creating exactly the recursion
// loop the checks exist to prevent. The path may not exist yet (a fresh
// dest is created on the first run), so walk up to the deepest EXISTING
// ancestor, realpath that, and re-append the not-yet-existing tail.
async function resolveRealPath(p) {
  let probe = path.resolve(p);
  const tail = [];
  for (let i = 0; i < 64; i++) {
    try {
      const real = await fs.realpath(probe);
      return tail.length > 0 ? path.join(real, ...tail) : real;
    } catch (_) {
      const parent = path.dirname(probe);
      if (parent === probe) { break; }
      tail.unshift(path.basename(probe));
      probe = parent;
    }
  }
  return path.resolve(p);   // nothing exists / resolver quirk — lexical fallback
}

// Reject configurations that would create an obvious mirror loop:
// dest path inside the source library (each backup would copy the
// previous backup) or vice versa (deleting from dest would propagate
// into the source library on the next sweep).
async function checkPathContainment(libraryRoot, destPath) {
  const lib = normForCompare(await resolveRealPath(libraryRoot));
  const dest = normForCompare(await resolveRealPath(destPath));
  if (dest.startsWith(lib)) {
    throw new WebError('Destination path is inside the source library — would create a recursion loop', 400);
  }
  if (lib.startsWith(dest)) {
    throw new WebError('Source library is inside the destination path — would propagate edits back to the library', 400);
  }
}

// Cross-object overlap validation. A destination may not overlap ANY
// library root (a backup tree inside another library gets scanned and
// indexed as music, then possibly re-backed-up), nor ANY other
// destination (two mirror jobs sharing a hierarchy each classify the
// other's files as orphans and repeatedly destroy each other's mirror —
// a nested destination's .mstream-trash reads as just another orphan
// dir to the outer job). Path equality after real-path resolution and
// case/separator normalisation also catches the "same path spelled
// differently" duplicates that the byte-exact UNIQUE(library_id,
// dest_path) constraint misses.
async function checkDestOverlaps(destPath, { libraryId, excludeDestId = null } = {}) {
  const dest = normForCompare(await resolveRealPath(destPath));

  for (const lib of db.getAllLibraries()) {
    if (lib.id === libraryId) { continue; }   // own root: checkPathContainment's clearer messages
    const root = normForCompare(await resolveRealPath(lib.root_path));
    if (dest.startsWith(root) || root.startsWith(dest)) {
      throw new WebError(`Destination path overlaps library "${lib.name}" (${lib.root_path}) — the backup would be scanned as library content`, 400);
    }
  }

  for (const other of db.getBackupDestinations()) {
    if (excludeDestId !== null && other.id === excludeDestId) { continue; }
    const otherPath = normForCompare(await resolveRealPath(other.dest_path));
    if (dest === otherPath) {
      throw new WebError(`A destination already uses this path (destination #${other.id} for library "${other.library_name}")`, 409);
    }
    if (dest.startsWith(otherPath) || otherPath.startsWith(dest)) {
      throw new WebError(`Destination path overlaps destination #${other.id} (${other.dest_path}) — nested mirror jobs repeatedly destroy each other's copies`, 400);
    }
  }
}

// "Same drive as source" check used by the path-validation endpoint.
// On POSIX: stat both paths and compare st_dev. The dest path may not
// exist yet — walk up the parent chain until we find an existing
// directory, since stat'ing that gives us the device the dest WILL
// land on once mkdir creates it.
// On Windows: compare drive letters via path.parse — different drive
// letters always mean different physical volumes for typical setups.
// Returns { same: boolean, reliable: boolean }. reliable=false flags
// situations where the answer is more likely to mislead than help —
// notably Docker bind mounts, where overlayfs can make a single host
// disk look like multiple st_dev values, and vice versa.
async function checkSameDrive(sourcePath, destPath) {
  if (process.platform === 'win32') {
    const srcRoot = path.parse(path.resolve(sourcePath)).root.toUpperCase();
    const dstRoot = path.parse(path.resolve(destPath)).root.toUpperCase();
    return { same: srcRoot === dstRoot, reliable: true };
  }

  // Crude Docker heuristic — if /.dockerenv exists or the cgroup file
  // mentions docker/containerd, surface "reliable: false" so the UI can
  // soften the same-drive warning. We don't try to be smart about it.
  let inContainer = false;
  try { await fs.access('/.dockerenv'); inContainer = true; } catch (_) {}
  if (!inContainer) {
    try {
      const cg = await fs.readFile('/proc/1/cgroup', 'utf8');
      if (/docker|containerd|kubepods/.test(cg)) { inContainer = true; }
    } catch (_) {}
  }

  let srcStat;
  try { srcStat = await fs.stat(sourcePath); } catch (_) { return { same: false, reliable: false }; }

  // Walk up the dest's parent chain until we find a directory that exists.
  // The first such ancestor is on the same filesystem the dest will end up
  // on after mkdir -p. If we reach the root without finding one, give up.
  let probe = path.resolve(destPath);
  let dstStat = null;
  for (let i = 0; i < 64; i++) {
    try {
      dstStat = await fs.stat(probe);
      break;
    } catch (_) {
      const parent = path.dirname(probe);
      if (parent === probe) { break; }
      probe = parent;
    }
  }
  if (!dstStat) { return { same: false, reliable: false }; }

  return { same: srcStat.dev === dstStat.dev, reliable: !inContainer };
}

// Attach last-run summary to a destination row for the list/get endpoints.
// Trades one query per destination for a UI that doesn't need a second
// round-trip to render status icons. Backup destinations are tiny in
// count (operators configure a handful), so the N+1 cost is negligible.
//
// Also parses exclude_globs from its JSON storage form into a real
// array for the response. NULL in storage → defaults; the UI sees the
// effective applied list either way, so it can render and edit without
// special-casing "destination has never had patterns set."
//
// Drops the raw JSON `exclude_globs` column from the response — clients
// only need the parsed `excludeGlobs` array, and shipping both wastes
// bandwidth and invites confusion about which is authoritative.
function withLastRun(dest) {
  const lastRun = db.getLastBackupRun(dest.id);
  const rest = { ...dest };
  delete rest.exclude_globs;
  return {
    ...rest,
    excludeGlobs: db.getEffectiveExcludeGlobs(dest),
    lastRun: lastRun || null,
  };
}

export function setup(mstream) {
  // ── List destinations ────────────────────────────────────────────
  mstream.get('/api/v1/admin/backup/destinations', (req, res) => {
    const destinations = db.getBackupDestinations().map(withLastRun);
    res.json({ destinations });
  });

  // ── Get a single destination ─────────────────────────────────────
  mstream.get('/api/v1/admin/backup/destinations/:id', (req, res) => {
    const dest = db.getBackupDestinationById(Number(req.params.id));
    if (!dest) { return res.status(404).json({ error: 'Destination not found' }); }
    res.json(withLastRun(dest));
  });

  // ── Create a destination ─────────────────────────────────────────
  //
  // Async handler: the containment/overlap checks realpath the world,
  // and their WebError rejections flow to the global error handler
  // (Express 5 forwards async rejections).
  mstream.post('/api/v1/admin/backup/destinations', async (req, res) => {
    const schema = Joi.object({
      libraryId: Joi.number().integer().required(),
      destPath: Joi.string().required(),
      triggerType: Joi.string().valid(...TRIGGER_TYPES).default('after-scan'),
      dailyAtHour: Joi.number().integer().min(0).max(23).optional(),
      retentionDays: Joi.number().integer().min(0).default(30),
      enabled: Joi.boolean().default(true),
      // excludeGlobs stays optional. Omit → null in storage → DEFAULT_EXCLUDE_GLOBS
      // applied at read time. Empty array → "exclude nothing." Non-empty array →
      // exactly those patterns.
      excludeGlobs: Joi.array().items(Joi.string()).optional(),
      // 0 means no throttle (default). Non-zero pauses the worker that
      // many ms after each file with bytes actually written.
      interFileDelayMs: Joi.number().integer().min(0).max(MAX_INTER_FILE_DELAY_MS).default(0),
    });
    const { value } = joiValidate(schema, req.body);
    requireDailyHour(value);

    if (value.excludeGlobs !== undefined) {
      try { validateExcludeGlobs(value.excludeGlobs); }
      catch (err) { return res.status(400).json({ error: err.message }); }
    }

    const library = db.getLibraryById(value.libraryId);
    if (!library) { return res.status(400).json({ error: 'Library not found' }); }

    if (!path.isAbsolute(value.destPath)) {
      return res.status(400).json({ error: 'destPath must be an absolute path' });
    }

    await checkPathContainment(library.root_path, value.destPath);
    await checkDestOverlaps(value.destPath, { libraryId: value.libraryId });

    let id;
    try {
      id = db.addBackupDestination({
        libraryId: value.libraryId,
        destPath: value.destPath,
        triggerType: value.triggerType,
        dailyAtHour: value.dailyAtHour,
        retentionDays: value.retentionDays,
        enabled: value.enabled,
        // Caller-provided list goes straight in; omitted → null (defaults
        // applied lazily at read time via parseExcludeGlobs).
        excludeGlobs: value.excludeGlobs,
        interFileDelayMs: value.interFileDelayMs,
      });
    } catch (err) {
      // UNIQUE(library_id, dest_path) collision → friendly 409.
      if (/UNIQUE/.test(err.message)) {
        return res.status(409).json({ error: 'A destination already exists for this library + path' });
      }
      throw err;
    }

    const dest = db.getBackupDestinationById(id);
    res.json(withLastRun(dest));
  });

  // ── Update a destination (partial) ───────────────────────────────
  mstream.patch('/api/v1/admin/backup/destinations/:id', async (req, res) => {
    const id = Number(req.params.id);
    const existing = db.getBackupDestinationById(id);
    if (!existing) { return res.status(404).json({ error: 'Destination not found' }); }

    const schema = Joi.object({
      destPath: Joi.string().optional(),
      triggerType: Joi.string().valid(...TRIGGER_TYPES).optional(),
      dailyAtHour: Joi.number().integer().min(0).max(23).allow(null).optional(),
      retentionDays: Joi.number().integer().min(0).optional(),
      enabled: Joi.boolean().optional(),
      // excludeGlobs PATCH semantics:
      //   omitted        — leave as-is
      //   array provided — replace stored value (encoded as JSON below)
      //   null           — clear (revert to DEFAULT_EXCLUDE_GLOBS)
      excludeGlobs: Joi.array().items(Joi.string()).allow(null).optional(),
      interFileDelayMs: Joi.number().integer().min(0).max(MAX_INTER_FILE_DELAY_MS).optional(),
    });
    const { value } = joiValidate(schema, req.body);

    if (value.excludeGlobs !== undefined && value.excludeGlobs !== null) {
      try { validateExcludeGlobs(value.excludeGlobs); }
      catch (err) { return res.status(400).json({ error: err.message }); }
    }

    // Build the field map for the db helper. The helper only writes the
    // keys present in this object — unspecified fields stay as-is.
    const fields = {};
    if (value.destPath !== undefined) {
      if (!path.isAbsolute(value.destPath)) {
        return res.status(400).json({ error: 'destPath must be an absolute path' });
      }
      await checkPathContainment(existing.library_root_path, value.destPath);
      await checkDestOverlaps(value.destPath, {
        libraryId: existing.library_id,
        excludeDestId: id,
      });
      fields.dest_path = value.destPath;
    }
    if (value.triggerType !== undefined) { fields.trigger_type = value.triggerType; }
    if (value.dailyAtHour !== undefined) { fields.daily_at_hour = value.dailyAtHour; }
    if (value.retentionDays !== undefined) { fields.retention_days = value.retentionDays; }
    if (value.enabled !== undefined) { fields.enabled = value.enabled; }
    if (value.excludeGlobs !== undefined) {
      // null in the request → store NULL (reverts to defaults at read time).
      // Array in the request → JSON-encode for storage (db helper takes
      // exclude_globs verbatim; the API is the layer that owns the encoding).
      fields.exclude_globs = value.excludeGlobs === null ? null : JSON.stringify(value.excludeGlobs);
    }
    if (value.interFileDelayMs !== undefined) {
      fields.inter_file_delay_ms = value.interFileDelayMs;
    }

    // Cross-field check using the merged shape (existing + patch).
    const merged = {
      triggerType: value.triggerType ?? existing.trigger_type,
      dailyAtHour: value.dailyAtHour !== undefined ? value.dailyAtHour : existing.daily_at_hour,
    };
    requireDailyHour(merged);

    try {
      db.updateBackupDestination(id, fields);
    } catch (err) {
      if (/UNIQUE/.test(err.message)) {
        return res.status(409).json({ error: 'A destination already exists for this library + path' });
      }
      throw err;
    }

    res.json(withLastRun(db.getBackupDestinationById(id)));
  });

  // ── Delete a destination ─────────────────────────────────────────
  mstream.delete('/api/v1/admin/backup/destinations/:id', (req, res) => {
    const id = Number(req.params.id);
    const existing = db.getBackupDestinationById(id);
    if (!existing) { return res.status(404).json({ error: 'Destination not found' }); }
    db.deleteBackupDestination(id);
    res.json({});
  });

  // ── Manual trigger ───────────────────────────────────────────────
  mstream.post('/api/v1/admin/backup/destinations/:id/run', (req, res) => {
    const id = Number(req.params.id);
    const existing = db.getBackupDestinationById(id);
    if (!existing) { return res.status(404).json({ error: 'Destination not found' }); }
    if (!existing.enabled) { return res.status(400).json({ error: 'Destination is disabled' }); }

    const skipHistoryId = backupManager.triggerForDestination(id, 'manual');
    // triggerForDestination returns:
    //   null     — successfully enqueued (history row will be created
    //              when the worker actually starts)
    //   row id   — a 'skipped' row was written because the dest is busy
    if (skipHistoryId == null) {
      return res.json({ status: 'queued' });
    }
    res.json({ status: 'skipped', historyId: skipHistoryId });
  });

  // ── History for a destination ────────────────────────────────────
  mstream.get('/api/v1/admin/backup/destinations/:id/history', (req, res) => {
    const id = Number(req.params.id);
    const existing = db.getBackupDestinationById(id);
    if (!existing) { return res.status(404).json({ error: 'Destination not found' }); }

    // Clamp to [1, 500] integers. Fractionals reach SQLite's LIMIT as-is
    // and negatives mean UNLIMITED there — both bypassed the cap.
    const limit = Math.min(Math.max(Math.trunc(Number(req.query.limit)) || 50, 1), 500);
    res.json({ history: db.getBackupHistory(id, limit) });
  });

  // ── Live status ──────────────────────────────────────────────────
  //
  // Returns an enriched view of the in-flight backup, if any:
  //   - active: null when no backup is running, otherwise a flat object
  //     with everything the UI needs to render a progress card —
  //     destination identity, current counts (live, refreshed by the
  //     worker every 500ms via stdout 'progress' events), and an
  //     estimated total derived from the previous successful run.
  //   - queueLength: how many tasks (scans + backups) are waiting.
  //     The UI uses this to show "N task(s) queued" when there's
  //     nothing actively running but something will start soon.
  //
  // The estimate is intentionally cheap-best-effort: pre-walking the
  // source library to get an accurate file count would add seconds of
  // startup latency on large libraries (the very case where the user
  // most needs progress feedback). Using the previous run's
  // (copied + unchanged + trashed) total is free, accurate to within
  // a few percent for steady-state libraries, and gracefully degrades
  // to indeterminate-progress on the first-ever run for a destination.
  mstream.get('/api/v1/admin/backup/status', (req, res) => {
    const activeRun = backupManager.getActiveBackupRun();
    if (!activeRun) {
      return res.json({ active: null, queueLength: backupManager.getQueueLength() });
    }
    const dest = db.getBackupDestinationById(activeRun.destinationId);
    const liveRow = db.getBackupHistoryRowById(activeRun.historyId);
    const prevRun = db.getLastSuccessfulBackupBefore(activeRun.destinationId, activeRun.historyId);

    // Sum of all entries the previous run processed (whether copied,
    // skipped-unchanged, or trashed-as-orphan). Same denominator the
    // current run will hit assuming the source library hasn't gained
    // or lost a meaningful number of files between runs.
    const expectedFiles = prevRun
      ? (prevRun.files_copied + prevRun.files_unchanged + prevRun.files_trashed)
      : null;

    res.json({
      active: {
        destinationId: activeRun.destinationId,
        historyId: activeRun.historyId,
        libraryName: dest?.library_name ?? null,
        destPath: dest?.dest_path ?? null,
        startedAt: liveRow?.started_at ?? null,
        triggerReason: liveRow?.trigger_reason ?? null,
        filesCopied: liveRow?.files_copied || 0,
        filesUnchanged: liveRow?.files_unchanged || 0,
        filesTrashed: liveRow?.files_trashed || 0,
        bytesCopied: liveRow?.bytes_copied || 0,
        expectedFiles,
      },
      queueLength: backupManager.getQueueLength(),
    });
  });

  // ── Path validation (preview, called by the UI before submission) ─
  //
  // Returns the same hard errors the create/patch endpoints would raise
  // (so the UI can disable the submit button), plus soft warnings the
  // operator should be aware of but isn't blocked by — most importantly
  // "this destination is on the same drive as the source," which makes
  // a single disk failure lose both copies.
  mstream.post('/api/v1/admin/backup/check-path', async (req, res) => {
    const schema = Joi.object({
      libraryId: Joi.number().integer().required(),
      destPath: Joi.string().required(),
    });
    const { value } = joiValidate(schema, req.body);

    const errors = [];
    const warnings = [];
    const info = {
      platform: process.platform,
      destExists: false,
      destIsEmpty: null,
      parentExists: false,
      sameDrive: null,
      sameDriveReliable: true,
    };

    const library = db.getLibraryById(value.libraryId);
    if (!library) {
      errors.push('Library not found');
      return res.json({ ok: false, errors, warnings, info });
    }

    if (!path.isAbsolute(value.destPath)) {
      errors.push('Destination path must be absolute');
    }

    if (errors.length === 0) {
      try {
        await checkPathContainment(library.root_path, value.destPath);
      } catch (err) {
        errors.push(err.message);
      }
    }

    // Overlap checks are hard errors too — the preview must agree with
    // what create/PATCH would reject, or the UI's submit gate lies.
    if (errors.length === 0) {
      try {
        await checkDestOverlaps(value.destPath, { libraryId: value.libraryId });
      } catch (err) {
        errors.push(err.message);
      }
    }

    // Soft checks only run if the path passed the hard checks — we don't
    // want to confuse the user with "destination already exists" when
    // the real problem is "destination is inside the source library."
    if (errors.length === 0) {
      try {
        const stat = await fs.stat(value.destPath);
        info.destExists = stat.isDirectory();
        if (info.destExists) {
          const entries = await fs.readdir(value.destPath);
          // Ignore our own trash bucket when judging "empty" — a previous
          // run's trash shouldn't surface as a "destination not empty"
          // warning when the user is just adding the same destination back.
          const live = entries.filter((e) => e !== '.mstream-trash');
          info.destIsEmpty = live.length === 0;
          if (!info.destIsEmpty) {
            warnings.push('Destination already contains files. Existing files with names matching source files will be replaced; the originals will be moved to .mstream-trash/ before being overwritten.');
          }
          info.parentExists = true;
        }
      } catch (err) {
        if (err.code === 'ENOENT') {
          // Destination doesn't exist — check whether the parent does.
          // If even the parent is missing, the user almost certainly typed
          // a wrong path or the drive is unmounted; surface that loudly.
          try {
            await fs.stat(path.dirname(value.destPath));
            info.parentExists = true;
            warnings.push('Destination does not exist yet. It will be created on the first backup run.');
          } catch (_) {
            info.parentExists = false;
            warnings.push('Neither the destination nor its parent directory exists. Check that the target drive is mounted before saving.');
          }
        } else {
          warnings.push(`Could not stat destination: ${err.message}`);
        }
      }

      try {
        const driveCheck = await checkSameDrive(library.root_path, value.destPath);
        info.sameDrive = driveCheck.same;
        info.sameDriveReliable = driveCheck.reliable;
        if (driveCheck.same) {
          const caveat = driveCheck.reliable
            ? ''
            : ' (note: same-drive detection is unreliable inside Docker containers; this warning may be a false positive)';
          warnings.push(`Destination appears to be on the same physical drive as the source library — a single disk failure would lose both copies${caveat}.`);
        }
      } catch (_) {
        // Fall through silently — same-drive check is informational.
      }

      if (process.platform === 'win32' && info.parentExists === false) {
        // On Windows, a typical user-error is picking a drive letter that
        // doesn't exist (USB unplugged). Surfacing this distinct from the
        // generic "parent missing" message helps the user understand
        // what's wrong.
        const dstRoot = path.parse(path.resolve(value.destPath)).root;
        warnings.push(`Drive ${dstRoot} does not appear to be mounted.`);
      }
    }

    res.json({
      ok: errors.length === 0,
      errors,
      warnings,
      info,
    });
  });

  // ── Platform info (for the UI to render OS-specific affordances) ──
  // Mostly here so the frontend can decide whether to show the Windows
  // drive picker or just a directory browser. Not auth-sensitive but
  // kept under the admin gate for consistency with the rest of /backup.
  mstream.get('/api/v1/admin/backup/platform', (req, res) => {
    res.json({
      platform: process.platform,
      homedir: os.homedir(),
    });
  });
}
