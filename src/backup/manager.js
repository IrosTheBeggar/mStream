// Backup manager — schedules + dispatches backup runs.
//
// Execution itself (the queue, mutex with scans, worker spawn, history-row
// lifecycle) lives in src/db/task-queue.js: that's the single sequencer
// for "expensive disk work" and is what makes the scan/backup mutex
// possible. This module's remaining jobs:
//
//   1. Crash recovery on init — flip any 'running' rows from a previous
//      process to 'failed' so the dedup check + UI status don't think
//      a long-dead worker is still in flight.
//   2. The daily-trigger tick (5-minute cadence) — figure out which
//      destinations are due for a scheduled run and add them to the queue.
//   3. The trash-retention sweep — prune .mstream-trash/<date>/ folders
//      past their destination's retention.
//   4. After-scan trigger registration — wire src/db/task-queue.js's
//      onScanComplete callback to enqueue 'after-scan' destinations
//      whose source library matches the scan that just finished.
//   5. Public trigger API — manual + after-scan + daily call points.
//
// Skip-row policy: when a trigger arrives for a destination that's
// already queued or running, we record a 'skipped' history row only
// for 'manual' triggers (user clicked, deserves explicit feedback).
// 'after-scan' and 'scheduled' triggers silent-skip with a log line —
// otherwise a 30-hour backup would accumulate ~360 noise rows from the
// 5-minute scheduler tick alone, which clutters the history view
// without surfacing useful information (the active row already tells
// the user what's running).

import path from 'path';
import fs from 'fs/promises';
import winston from 'winston';
import * as db from '../db/manager.js';
import * as taskQueue from '../db/task-queue.js';

let scheduleTimer = null;
let trashTimer = null;

// Re-entrancy latches. setInterval doesn't queue calls — if a previous
// tick's work is still in progress when the next interval fires, Node
// invokes the callback again concurrently. For trash sweeps in
// particular this is realistic on slow disks with deep retention
// (recursive fs.rm of dated buckets can take longer than a tick), and
// concurrent sweeps can race on the same dir. Cheap insurance: latch
// on entry, clear on exit, skip the new tick if the old one's still
// running.
let scheduleRunning = false;
let trashRunning = false;

const SCHEDULE_TICK_MS = 5 * 60 * 1000;
const TRASH_TICK_MS = 60 * 60 * 1000;

const POST_BOOT_SCHEDULE_DELAY_MS = 60 * 1000;
const POST_BOOT_TRASH_DELAY_MS = 30 * 1000;

export function init() {
  // Crash recovery: any 'running' row at startup belongs to a previous
  // process killed mid-backup. Flip them to 'failed' so dedup +
  // last-run UI don't think a dead worker is still in flight.
  //
  // Special case for reboot-without-process-exit (server.js:reboot()):
  // Node modules stay loaded across reboot, so task-queue's
  // activeBackupRun still points at a worker that's genuinely still
  // running. Skip its row to avoid the brief 'failed → success' flicker
  // when its real close handler eventually fires.
  try {
    const active = taskQueue.getActiveBackupRun();
    const stale = db.markStaleBackupRunsFailed(active?.historyId ?? null);
    if (stale > 0) {
      winston.info(`Backup: marked ${stale} stale 'running' row(s) as failed (server restart)`);
    }
  } catch (err) {
    winston.error('Backup: failed to mark stale runs', { stack: err });
  }

  // Wire the after-scan trigger. task-queue.js calls this fn from
  // onScanClose with the finished scan's task object. We resolve its
  // vpath to a library id and call our normal trigger path; from
  // task-queue's perspective the call looks just like a manual or
  // scheduled trigger and goes through the same dedup gate.
  taskQueue.setOnScanCompleteCallback((scanObj) => {
    try {
      const library = db.getLibraryByName(scanObj.vpath);
      if (library) { triggerForLibrary(library.id); }
    } catch (err) {
      winston.error(`Backup: after-scan trigger failed for vpath ${scanObj.vpath}`, { stack: err });
    }
  });

  if (scheduleTimer) { clearInterval(scheduleTimer); }
  scheduleTimer = setInterval(runScheduleTickGuarded, SCHEDULE_TICK_MS);
  setTimeout(runScheduleTickGuarded, POST_BOOT_SCHEDULE_DELAY_MS);

  if (trashTimer) { clearInterval(trashTimer); }
  trashTimer = setInterval(runTrashTickGuarded, TRASH_TICK_MS);
  setTimeout(runTrashTickGuarded, POST_BOOT_TRASH_DELAY_MS);
}

// Re-entrancy-guarded wrappers around the two periodic ticks. If a
// previous invocation is still in progress, just skip — there's no
// value queueing up the same work (the next tick will see the same
// state and decide what to do then). For checkScheduledBackups this
// is mostly defensive (the work is cheap); for sweepAllTrash it's
// load-bearing on slow disks with deep retention.
async function runScheduleTickGuarded() {
  if (scheduleRunning) {
    winston.info('Backup: schedule tick skipped — previous tick still running');
    return;
  }
  scheduleRunning = true;
  try { await checkScheduledBackups(); }
  catch (err) { winston.error('Backup: schedule tick threw', { stack: err }); }
  finally { scheduleRunning = false; }
}

async function runTrashTickGuarded() {
  if (trashRunning) {
    winston.info('Backup: trash sweep skipped — previous sweep still running');
    return;
  }
  trashRunning = true;
  try { await sweepAllTrash(); }
  catch (err) { winston.error('Backup: trash sweep threw', { stack: err }); }
  finally { trashRunning = false; }
}

export function shutdown() {
  if (scheduleTimer) { clearInterval(scheduleTimer); scheduleTimer = null; }
  if (trashTimer) { clearInterval(trashTimer); trashTimer = null; }
  // Active workers belong to task-queue; we don't kill them from here.
  // The kill-queue process-exit hook in src/state/kill-list.js handles
  // them on actual process termination.
}

// ── Public trigger API ──────────────────────────────────────────────────────

// Walk this library's enabled 'after-scan' destinations and trigger a run
// for each. Called by the onScanComplete callback wired in init() —
// hence the implicit 'after-scan' trigger reason. Idempotent: per-
// destination dedup in addBackupTask drops duplicates that arrive while
// a backup is already queued or active. Per-destination try/catch so
// one misbehaving destination doesn't prevent the rest from triggering
// (defensive; triggerForDestination catches its own errors today).
export function triggerForLibrary(libraryId) {
  let destinations;
  try {
    destinations = db.getBackupDestinationsByLibrary(libraryId, { triggerType: 'after-scan' });
  } catch (err) {
    winston.error(`Backup: failed to look up destinations for library ${libraryId}`, { stack: err });
    return;
  }
  for (const dest of destinations) {
    try {
      triggerForDestination(dest.id, 'after-scan');
    } catch (err) {
      winston.error(`Backup: failed to trigger dest #${dest.id} for library ${libraryId}`, { stack: err });
    }
  }
}

// Trigger a backup for a specific destination. Used by:
//   - the API's manual-run endpoint            (reason='manual')
//   - the daily-scheduler tick below           (reason='scheduled')
//   - triggerForLibrary's after-scan callback  (reason='after-scan')
//
// Returns the history-row id of a 'skipped' row when the destination is
// already busy (so manual-trigger callers can surface "previous run
// still in progress" to the UI), or null on a clean enqueue / a silent
// drop (disabled / unknown destination).
export function triggerForDestination(destinationId, triggerReason) {
  const dest = db.getBackupDestinationById(destinationId);
  if (!dest) {
    winston.warn(`Backup: trigger for unknown destination id ${destinationId}`);
    return null;
  }
  if (!dest.enabled) {
    winston.info(`Backup: skipping disabled destination ${destinationId} (${dest.dest_path})`);
    return null;
  }

  const queued = taskQueue.addBackupTask(destinationId, triggerReason);
  if (queued) { return null; }

  // Dedup hit. For manual triggers we write a 'skipped' history row so
  // the UI surfaces an explicit "previous run still in progress" entry.
  // For after-scan / scheduled, log only — those fire on their own
  // cadence and writing a row each time would flood history during a
  // long-running backup (5-min scheduler tick × hours = hundreds of
  // rows that all say the same thing).
  if (triggerReason === 'manual') {
    const historyId = db.createBackupRunRow({
      destinationId,
      triggerReason,
      status: 'skipped',
      errorMessage: 'previous run still in progress',
    });
    winston.info(`Backup: skipping ${dest.dest_path} (manual) — previous run still in progress (history #${historyId})`);
    return historyId;
  }
  winston.info(`Backup: skipping ${dest.dest_path} (${triggerReason}) — previous run still in progress`);
  return null;
}

// ── Daily-trigger scheduler ─────────────────────────────────────────────────

// Format a Date as local-timezone YYYY-MM-DD. We need this (not toISOString,
// which is UTC) so the "did this run today?" check stays consistent with
// daily_at_hour, which is interpreted as a *local* hour. Without local-time
// formatting on both sides, a user in e.g. UTC-8 sees the comparison drift
// near UTC midnight and either misses a daily run or fires a duplicate.
function localDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// SQLite's datetime('now') writes 'YYYY-MM-DD HH:MM:SS' in UTC. Parse it
// back as UTC, then re-format in local time so the comparison with
// localDateKey(now) is apples-to-apples.
function sqliteUtcToLocalDateKey(s) {
  if (!s) { return null; }
  return localDateKey(new Date(s.replace(' ', 'T') + 'Z'));
}

function checkScheduledBackups() {
  let candidates;
  try {
    candidates = db.getBackupDestinationsByTrigger('daily');
  } catch (err) {
    winston.error('Backup: scheduler lookup failed', { stack: err });
    return;
  }
  if (candidates.length === 0) { return; }

  const now = new Date();
  const currentHour = now.getHours();
  const todayKey = localDateKey(now);

  for (const dest of candidates) {
    if (dest.daily_at_hour == null) { continue; }
    if (currentHour < dest.daily_at_hour) { continue; }

    // One scheduled attempt per destination per local day. We key on the
    // most recent run of ANY status (not just 'success'): keying on success
    // alone meant a destination whose drive is unplugged would fail in
    // seconds and be re-triggered on every 5-minute tick, piling up ~288
    // 'failed' rows/day — exactly the history flooding the skip-row policy
    // avoids elsewhere. A failed daily run now records the failure and waits
    // for tomorrow's window; an operator who wants an immediate retry uses
    // the manual-run endpoint (after-scan triggers also still fire
    // independently). A 'running' row from today likewise blocks re-trigger
    // (the dedup gate would drop it anyway).
    const last = db.getLastBackupRun(dest.id);
    if (last && sqliteUtcToLocalDateKey(last.started_at) === todayKey) { continue; }

    triggerForDestination(dest.id, 'scheduled');
  }
}

// ── Trash retention sweep ───────────────────────────────────────────────────

async function sweepAllTrash() {
  let destinations;
  try {
    destinations = db.getBackupDestinations();
  } catch (err) {
    winston.error('Backup: trash sweep lookup failed', { stack: err });
    return;
  }
  for (const dest of destinations) {
    if (dest.retention_days <= 0) { continue; }  // hard-prune mode never writes to trash
    await sweepDestTrash(dest);
  }
}

async function sweepDestTrash(dest) {
  const trashRoot = path.join(dest.dest_path, '.mstream-trash');
  let entries;
  try {
    entries = await fs.readdir(trashRoot, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') {
      winston.warn(`Backup trash sweep: cannot read ${trashRoot}: ${err.message}`);
    }
    return;
  }

  const cutoffMs = Date.now() - (dest.retention_days * 24 * 60 * 60 * 1000);

  for (const entry of entries) {
    if (!entry.isDirectory()) { continue; }
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(entry.name);
    if (!m) { continue; }
    const folderMs = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    if (folderMs >= cutoffMs) { continue; }

    const folderPath = path.join(trashRoot, entry.name);
    try {
      await fs.rm(folderPath, { recursive: true, force: true });
      winston.info(`Backup: pruned trash folder ${folderPath} (older than ${dest.retention_days} days)`);
    } catch (err) {
      winston.warn(`Backup trash sweep: failed to remove ${folderPath}: ${err.message}`);
    }
  }
}

// ── Pass-through getters used by the API ────────────────────────────────────

// Thin re-exports of task-queue introspection so api/backup.js has a
// single import (this module) for everything backup-related, and so
// task-queue's "is anything happening?" view stays the source of truth
// (this module's only state is the timer latches above).
export const getActiveBackupRun = taskQueue.getActiveBackupRun;
export const getQueueLength = taskQueue.getQueueLength;
