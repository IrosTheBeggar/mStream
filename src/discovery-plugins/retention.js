// Retention for the discovery plug-ins: the job rows nobody reads, and the
// staging folders a crash left behind.
//
// Each pass:
//   1. prunes finished job rows (done / failed / cancelled) older than
//      discoveryJobs.retentionDays — jobsDb.pruneFinished, which existed
//      since V74 with nothing calling it;
//   2. removes staging folders (staging.js) nothing has written to for a
//      day. A download interrupted by a crash re-runs at boot and clears its
//      own folder first; a folder whose job was cancelled or pruned in the
//      meantime is caught here.
//
// Scheduled like the stats sweep (src/stats/retention.js): once shortly
// after boot, then on an interval; both timers unref'd. Admins can run a
// pass on demand (POST /api/v1/admin/discovery-jobs/sweep).

import winston from 'winston';
import * as config from '../state/config.js';
import * as jobsDb from '../db/discovery-plugin-jobs.js';
import * as staging from './staging.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const BOOT_DELAY_MS = 90 * 1000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;

let bootTimer = null;
let intervalTimer = null;
let running = false;
let startedAt = null;   // when start() armed the timers
let lastRun = null;     // { at, prunedJobs, removedStaging }

export async function sweep({ now = Date.now() } = {}) {
  const out = { prunedJobs: 0, removedStaging: 0 };
  const jobDays = Number(config.program && config.program.discoveryJobs && config.program.discoveryJobs.retentionDays);
  if (Number.isInteger(jobDays) && jobDays > 0) { out.prunedJobs = jobsDb.pruneFinished(jobDays * DAY_MS, now); }
  out.removedStaging = await staging.removeStale({ now });
  if (out.prunedJobs || out.removedStaging) {
    winston.info(`discovery retention: pruned ${out.prunedJobs} job row(s), removed ${out.removedStaging} stale staging folder(s)`);
  }
  lastRun = { at: Date.now(), ...out };
  return out;
}

// For the admin panel: is a pass running, what did the last one do, and when
// is the next one due. The interval ticks from start(); the first pass is the
// boot delay.
export function status({ now = Date.now() } = {}) {
  let nextRunAt = null;
  if (startedAt !== null) {
    const firstAt = startedAt + BOOT_DELAY_MS;
    nextRunAt = now < firstAt
      ? firstAt
      : startedAt + (Math.floor((now - startedAt) / INTERVAL_MS) + 1) * INTERVAL_MS;
  }
  return { running, lastRun, nextRunAt, intervalMs: INTERVAL_MS };
}

async function safeRun() {
  if (running) { return; }
  running = true;
  try { await sweep(); } catch (err) { winston.warn(`discovery retention: pass failed: ${err.message}`); } finally { running = false; }
}

export function start() {
  stop();
  startedAt = Date.now();
  bootTimer = setTimeout(safeRun, BOOT_DELAY_MS);
  intervalTimer = setInterval(safeRun, INTERVAL_MS);
  if (bootTimer.unref) { bootTimer.unref(); }
  if (intervalTimer.unref) { intervalTimer.unref(); }
}

export function stop() {
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
  if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
  startedAt = null;
}
