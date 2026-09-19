// Retention for the discovery plug-ins: the Discover downloads nobody kept,
// and the job rows nobody reads.
//
// Each pass:
//   1. walks the scratch library (downloads.js) and removes every file older
//      than discoveryJobs.downloads.retentionDays, with its library row, and
//      marks the job behind it `removed` so a client shows "expired" instead
//      of a dead Play button. The FILE's age is the clock, not the job row's:
//      files outlive pruned job rows, and a kept file has already left the
//      folder. 0 days = never. A file Windows still holds open is skipped
//      and caught by the next pass.
//   2. removes partial files a crash or a kill left behind, once a day old,
//      and folders the pass emptied;
//   3. prunes finished job rows older than discoveryJobs.retentionDays —
//      jobsDb.pruneFinished existed since V74 and nothing ever called it.
//
// Scheduled like the stats sweep (src/stats/retention.js): once shortly
// after boot, then on an interval; both timers unref'd. Admins can run a
// pass on demand (POST /api/v1/admin/discovery-jobs/sweep).

import path from 'node:path';
import fs from 'node:fs/promises';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as jobsDb from '../db/discovery-plugin-jobs.js';
import * as downloads from './downloads.js';
import { removeDownloadedTrack } from '../db/insert-downloaded-track.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const BOOT_DELAY_MS = 90 * 1000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;
const PARTIAL_RE = /\.(part|ytdl|temp)$/i;

let bootTimer = null;
let intervalTimer = null;
let running = false;

async function walk(dir, out = []) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (err) {
    if (err.code !== 'ENOENT') { winston.warn(`discovery retention: cannot read ${dir}: ${err.message}`); }
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { await walk(full, out); } else if (e.isFile()) { out.push(full); }
  }
  return out;
}

// Deepest first, never the root itself.
async function removeEmptyDirs(root, dir = root) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (_e) { return; }
  for (const e of entries) {
    if (e.isDirectory()) { await removeEmptyDirs(root, path.join(dir, e.name)); }
  }
  if (dir === root) { return; }
  try {
    if ((await fs.readdir(dir)).length === 0) { await fs.rmdir(dir); }
  } catch (err) {
    winston.warn(`discovery retention: could not remove empty folder ${dir}: ${err.message}`);
  }
}

export async function sweep({ now = Date.now() } = {}) {
  const out = { removedFiles: 0, removedPartials: 0, skipped: 0, prunedJobs: 0 };
  const lib = db.getLibraryByName(downloads.LIBRARY_NAME);
  const days = downloads.retentionDays();
  if (lib) {
    const cutoff = days > 0 ? now - days * DAY_MS : null;
    for (const file of await walk(lib.root_path)) {
      let stat;
      try { stat = await fs.stat(file); } catch (_e) { continue; }   // went away under us
      const name = path.basename(file);
      const partial = PARTIAL_RE.test(name) || name.startsWith('.mstream-copy-');
      const expired = partial ? stat.mtimeMs < now - DAY_MS : (cutoff !== null && stat.mtimeMs < cutoff);
      if (!expired) { continue; }
      try {
        await fs.unlink(file);
      } catch (err) {
        out.skipped += 1;
        winston.warn(`discovery retention: could not remove ${file} (${err.code || err.message}); the next pass retries`);
        continue;
      }
      if (partial) { out.removedPartials += 1; continue; }
      const rel = path.relative(lib.root_path, file).replace(/\\/g, '/');
      removeDownloadedTrack({ vpath: downloads.LIBRARY_NAME, relativePath: rel, log: 'discovery retention' });
      for (const job of jobsDb.findByDownloadedFilepath(`${downloads.LIBRARY_NAME}/${rel}`)) {
        if (job.result && !job.result.kept && !job.result.removed) { jobsDb.patchResult(job.id, { removed: { at: now } }); }
      }
      out.removedFiles += 1;
    }
    if (out.removedFiles > 0 || out.removedPartials > 0) { await removeEmptyDirs(lib.root_path); }
  }
  const jobDays = Number(config.program && config.program.discoveryJobs && config.program.discoveryJobs.retentionDays);
  if (Number.isInteger(jobDays) && jobDays > 0) { out.prunedJobs = jobsDb.pruneFinished(jobDays * DAY_MS, now); }
  if (out.removedFiles || out.removedPartials || out.prunedJobs || out.skipped) {
    winston.info(`discovery retention: removed ${out.removedFiles} expired download(s) and ${out.removedPartials} partial file(s), `
      + `pruned ${out.prunedJobs} job row(s)${out.skipped ? `, ${out.skipped} file(s) in use left for the next pass` : ''}`);
  }
  return out;
}

async function safeRun() {
  if (running) { return; }
  running = true;
  try { await sweep(); } catch (err) { winston.warn(`discovery retention: pass failed: ${err.message}`); } finally { running = false; }
}

export function start() {
  stop();
  bootTimer = setTimeout(safeRun, BOOT_DELAY_MS);
  intervalTimer = setInterval(safeRun, INTERVAL_MS);
  if (bootTimer.unref) { bootTimer.unref(); }
  if (intervalTimer.unref) { intervalTimer.unref(); }
}

export function stop() {
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
  if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
}
