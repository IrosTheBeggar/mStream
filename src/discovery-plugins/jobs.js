// The plug-in job runner.
//
// Acquire and hand-off plug-ins do their work as JOBS: a user asks, a row
// lands in discovery_plugin_jobs (queued), and this runner claims it and
// calls the plug-in's run() — in-process, async, several at a time under a
// global cap and a per-plug-in concurrency. It is deliberately NOT the
// enrichment task queue: that one is a serial chain of scanner passes with
// no cancel; these are user-initiated, cancellable, and one slow catalogue
// must not hold up another.
//
// Contract for a runnable plug-in (registry.js): `run(ctx)` returns a
// result (stored as JSON) or throws (the message is the job's error).
// ctx = { job, recommendation, userId, progress(fraction, text),
// isCancelled() }. A plug-in that can take a while polls isCancelled()
// between steps and returns early; the runner records the cancel.
//
// Lifecycle: start() at boot re-queues whatever the previous process left
// running and arms a slow tick; kick() after an enqueue makes the next tick
// immediate; stop() on shutdown/reboot disarms the tick (in-flight run()s
// finish on their own, and anything still 'running' at exit is re-queued
// by the next start()).

import winston from 'winston';
import * as config from '../state/config.js';
import * as jobsDb from '../db/discovery-plugin-jobs.js';
import * as registry from './registry.js';

const TICK_MS = 1000;
const running = new Map();   // job id -> plugin name
let timer = null;
let ticking = false;
let stopped = true;

function maxConcurrent() {
  const n = config.program && config.program.discoveryJobs && config.program.discoveryJobs.maxConcurrent;
  return Number.isInteger(n) && n > 0 ? n : 2;
}

function runningFor(pluginName) {
  let n = 0;
  for (const p of running.values()) { if (p === pluginName) { n += 1; } }
  return n;
}

function schedule(ms = TICK_MS) {
  if (stopped) { return; }
  if (timer) { clearTimeout(timer); }
  timer = setTimeout(() => {
    timer = null;
    tick().catch((err) => winston.warn(`discovery plug-in runner tick failed: ${err.message}`))
      .finally(() => { if (!stopped && !timer) { schedule(); } });
  }, ms);
  if (typeof timer.unref === 'function') { timer.unref(); }
}

export function start() {
  if (!stopped) { return; }
  stopped = false;
  try {
    // A soft reboot start()s again in the same process: what is in
    // `running` is alive and stays out of the re-queue.
    const n = jobsDb.requeueInterrupted({ exceptIds: [...running.keys()] });
    if (n > 0) { winston.info(`discovery plug-in jobs: re-queued ${n} job(s) interrupted by the last shutdown`); }
  } catch (err) {
    winston.warn(`discovery plug-in jobs: could not re-queue interrupted jobs: ${err.message}`);
  }
  schedule(0);
}

export function stop() {
  stopped = true;
  if (timer) { clearTimeout(timer); timer = null; }
}

export function isRunning() { return !stopped; }

// After an enqueue: don't wait for the slow tick.
export function kick() {
  if (!stopped) { schedule(0); }
}

export function runningCount() { return running.size; }

// One pass: for every enabled runnable plug-in, claim queued jobs up to its
// concurrency and the global cap, and start them. Never throws.
export async function tick() {
  if (ticking) { return; }
  ticking = true;
  try {
    for (const plugin of registry.runnablePlugins()) {
      if (!registry.isPluginEnabled(plugin.name)) { continue; }
      const per = Number.isInteger(plugin.concurrency) && plugin.concurrency > 0 ? plugin.concurrency : 1;
      while (running.size < maxConcurrent() && runningFor(plugin.name) < per) {
        const job = jobsDb.claimNextQueued(plugin.name);
        if (!job) { break; }
        // Intentionally not awaited — concurrency. runJob settles its own
        // failures; the catch is the backstop that keeps a rejection here
        // from ever being unhandled (Node exits the process on one).
        runJob(plugin, job).catch((err) => winston.warn(`discovery plug-in ${plugin.name}: job ${job.id} runner error: ${err && err.message ? err.message : err}`));
      }
    }
  } finally {
    ticking = false;
  }
}

// The row's final write. Separate from the run so a write that fails —
// SQLITE_BUSY past busy_timeout while a scan holds the lock, SQLITE_FULL —
// is caught by name: the row then stays 'running' and requeueInterrupted()
// picks it up at the next start(), instead of the rejection escaping an
// un-awaited promise and taking the server down.
function settle(plugin, job, { result, error }) {
  if (error === undefined) {
    // A cancel is recorded only when the plug-in honoured it — it returned
    // nothing, or a many-song account that says it stopped for the cancel.
    // A cancel asked for after the point of no return (the file is being
    // tagged, moved, added) lands the song; the row must say so, not
    // "stopped, nothing was saved". What the plug-in returned on its way
    // out stays with the row either way: an album copy's finished songs
    // are in the library.
    const honoured = result == null || (typeof result === 'object' && result.stopped === 'cancelled');
    if (honoured && jobsDb.isCancelRequested(job.id)) {
      jobsDb.cancelJob(job.id, result);
    } else {
      jobsDb.finishJob(job.id, result);
    }
    return;
  }
  if (jobsDb.isCancelRequested(job.id)) {
    jobsDb.cancelJob(job.id);
    return;
  }
  // The plug-in's failure, logged with the cause — a job that keeps
  // failing is a signal worth reading in the logs.
  winston.warn(`discovery plug-in ${plugin.name}: job ${job.id} failed: ${error && error.message ? error.message : error}`);
  jobsDb.failJob(job.id, error);
}

async function runJob(plugin, job) {
  running.set(job.id, plugin.name);
  const ctx = {
    job,
    recommendation: job.recommendation,
    params: job.params || null,
    userId: job.userId,
    progress: (fraction, text) => { try { jobsDb.updateProgress(job.id, fraction, text); } catch (_e) { /* best-effort */ } },
    isCancelled: () => { try { return jobsDb.isCancelRequested(job.id); } catch (_e) { return false; } },
  };
  let outcome;
  try {
    const result = await plugin.run(ctx);
    outcome = { result: result === undefined ? null : result };
  } catch (err) {
    outcome = { error: err };
  }
  try {
    settle(plugin, job, outcome);
  } catch (err) {
    winston.warn(`discovery plug-in ${plugin.name}: job ${job.id} could not be settled (${err && err.message ? err.message : err});`
      + ' the row stays running and is re-queued at the next start');
  } finally {
    running.delete(job.id);
    if (!stopped) { schedule(0); }   // a slot freed up — look for more work now
  }
}
