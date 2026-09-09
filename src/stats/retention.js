// The retention sweep: once a day (and once shortly after boot), prune raw
// play events older than config `stats.retentionMonths`. Counters and the
// hourly rollup keep the totals, so what goes is only the per-play detail
// that the history and top-N reads no longer need to show. Ingest already
// refuses plays older than the same floor, so the log's age is bounded at
// both ends. 0 months = keep everything; the sweep is then a no-op.
//
// After a prune, an incremental vacuum hands the freed pages back when the
// database was created in that auto-vacuum mode; otherwise the pages are
// simply reused by the next writes.

import winston from 'winston';
import * as db from '../db/manager.js';
import * as config from '../state/config.js';
import { sweepRetention } from './store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const BOOT_DELAY_MS = 60 * 1000;

let bootTimer = null;
let dailyTimer = null;

export function runRetentionSweep({ now = new Date() } = {}) {
  const d = db.getDB();
  if (!d) { return { deleted: 0, cutoff: null }; }
  const retentionMonths = config.program.stats?.retentionMonths ?? 24;
  const r = sweepRetention(d, { retentionMonths, now });
  if (r.deleted > 0) {
    winston.info(`[stats] retention: pruned ${r.deleted} play event(s) that started before ${r.cutoff}`);
    try {
      if (d.prepare('PRAGMA auto_vacuum').get().auto_vacuum === 2) { d.exec('PRAGMA incremental_vacuum'); }
    } catch (err) {
      winston.warn(`[stats] retention: incremental vacuum failed: ${err.message}`);
    }
  }
  return r;
}

function safeRun() {
  try { runRetentionSweep(); } catch (err) { winston.warn(`[stats] retention sweep failed: ${err.message}`); }
}

export function startRetentionSweep() {
  stopRetentionSweep();
  bootTimer = setTimeout(safeRun, BOOT_DELAY_MS);
  dailyTimer = setInterval(safeRun, DAY_MS);
  if (bootTimer.unref) { bootTimer.unref(); }
  if (dailyTimer.unref) { dailyTimer.unref(); }
}

export function stopRetentionSweep() {
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
  if (dailyTimer) { clearInterval(dailyTimer); dailyTimer = null; }
}
