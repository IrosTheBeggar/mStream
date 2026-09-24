// Data access for discovery_plugin_jobs (V74) — the persistence behind the
// plug-in runner (src/discovery-plugins/jobs.js) and the jobs API.
//
// States:  queued → running → done | failed | cancelled
//   queued     waiting for the runner (a boot re-queues interrupted 'running')
//   running    a plug-in's run() is in flight in THIS process
//   done       run() returned; `result` is what it produced (JSON)
//   failed     run() threw; `error` is the message
//   cancelled  the user asked; a queued job flips at once, a running one
//              once its run() has returned (plug-ins poll ctx.isCancelled())
//
// Every write goes through here so the invariants hold no matter who
// writes: updated_at moves on every change, the live-job uniqueness is one
// INSERT OR IGNORE away, and rows always leave as the same JSON shape
// (rowToJob) the API and the runner both read.

import * as manager from './manager.js';

export const JOB_STATES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});
export const LIVE_STATES = Object.freeze([JOB_STATES.QUEUED, JOB_STATES.RUNNING]);
export const FINISHED_STATES = Object.freeze([JOB_STATES.DONE, JOB_STATES.FAILED, JOB_STATES.CANCELLED]);

const d = () => manager.getDB();

function parse(text) {
  if (text == null) { return null; }
  try { return JSON.parse(text); } catch (_e) { return null; }
}

export function rowToJob(row) {
  if (!row) { return null; }
  return {
    id: row.id,
    plugin: row.plugin,
    userId: row.user_id,
    key: row.rec_key,
    recommendation: parse(row.recommendation),
    state: row.state,
    progress: row.progress,
    statusText: row.status_text,
    result: parse(row.result),
    error: row.error,
    attempts: row.attempts,
    cancelRequested: row.cancel_requested === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

// Enqueue, or return the live job that already covers this
// (plugin, recommendation). `created` says which.
export function createJob({ plugin, userId = null, key, recommendation }) {
  if (!plugin || !key || !recommendation) { throw new Error('createJob: plugin, key and recommendation are required'); }
  const now = Date.now();
  const res = d().prepare(`
    INSERT OR IGNORE INTO discovery_plugin_jobs
      (plugin, user_id, rec_key, recommendation, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'queued', ?, ?)
  `).run(plugin, userId, key, JSON.stringify(recommendation), now, now);
  if (res.changes === 1) {
    return { job: getJob(Number(res.lastInsertRowid)), created: true };
  }
  const live = d().prepare(`
    SELECT * FROM discovery_plugin_jobs
     WHERE plugin = ? AND rec_key = ? AND state IN ('queued', 'running')
     LIMIT 1
  `).get(plugin, key);
  return { job: rowToJob(live), created: false };
}

export function getJob(id) {
  return rowToJob(d().prepare('SELECT * FROM discovery_plugin_jobs WHERE id = ?').get(id));
}

export function listJobs({ userId, states = null, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (userId !== undefined) { where.push('user_id IS ?'); params.push(userId); }
  if (Array.isArray(states) && states.length > 0) {
    where.push(`state IN (${states.map(() => '?').join(',')})`);
    params.push(...states);
  }
  const sql = `
    SELECT * FROM discovery_plugin_jobs
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at DESC, id DESC
    LIMIT ?`;
  params.push(Math.max(1, Math.min(500, Number(limit) || 100)));
  return d().prepare(sql).all(...params).map(rowToJob);
}

// One user's newest job per plug-in for one recommendation — what a client
// needs to draw a recommendation's rows ("Get it" is idle, running, done…)
// without walking the whole list. Newest first.
export function latestForKey({ userId = null, key }) {
  const rows = d().prepare(`
    SELECT * FROM discovery_plugin_jobs
     WHERE user_id IS ? AND rec_key = ?
     ORDER BY created_at DESC, id DESC
  `).all(userId, String(key));
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (seen.has(row.plugin)) { continue; }
    seen.add(row.plugin);
    out.push(rowToJob(row));
  }
  return out;
}

// "Clear finished": drop one user's finished rows (done, failed, cancelled).
// Live jobs stay. A finished job has nothing left to act on — what it
// fetched is in the library, or nothing is.
export function clearFinished(userId = null) {
  return d().prepare(`
    DELETE FROM discovery_plugin_jobs
     WHERE user_id IS ? AND state IN ('done', 'failed', 'cancelled')
  `).run(userId).changes;
}

// Atomically take the oldest queued job for one plug-in. RETURNING makes
// the claim and the read one statement; the process is single-threaded
// anyway, so two runners can't race — this just keeps it that way.
export function claimNextQueued(plugin) {
  const now = Date.now();
  const row = d().prepare(`
    UPDATE discovery_plugin_jobs
       SET state = 'running', started_at = ?, updated_at = ?, attempts = attempts + 1
     WHERE id = (
       SELECT id FROM discovery_plugin_jobs
        WHERE plugin = ? AND state = 'queued'
        ORDER BY created_at, id
        LIMIT 1)
    RETURNING *
  `).get(now, now, plugin);
  return rowToJob(row);
}

export function updateProgress(id, progress, statusText) {
  const p = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : null;
  d().prepare(`
    UPDATE discovery_plugin_jobs SET progress = ?, status_text = ?, updated_at = ?
     WHERE id = ? AND state = 'running'
  `).run(p, statusText == null ? null : String(statusText).slice(0, 500), Date.now(), id);
}

export function isCancelRequested(id) {
  const row = d().prepare('SELECT cancel_requested, state FROM discovery_plugin_jobs WHERE id = ?').get(id);
  return !!row && (row.cancel_requested === 1 || row.state === JOB_STATES.CANCELLED);
}

// The user's cancel. A queued job is cancelled on the spot; a running one is
// flagged and the runner finishes the state change once run() returns.
// Returns 'cancelled' | 'requested' | null (unknown or already finished).
export function requestCancel(id) {
  const now = Date.now();
  const queued = d().prepare(`
    UPDATE discovery_plugin_jobs
       SET state = 'cancelled', cancel_requested = 1, updated_at = ?, finished_at = ?
     WHERE id = ? AND state = 'queued'
  `).run(now, now, id);
  if (queued.changes === 1) { return 'cancelled'; }
  const running = d().prepare(`
    UPDATE discovery_plugin_jobs SET cancel_requested = 1, updated_at = ?
     WHERE id = ? AND state = 'running'
  `).run(now, id);
  return running.changes === 1 ? 'requested' : null;
}

function finish(id, state, patch) {
  const now = Date.now();
  d().prepare(`
    UPDATE discovery_plugin_jobs
       SET state = ?, result = ?, error = ?, progress = ?, updated_at = ?, finished_at = ?
     WHERE id = ? AND state = 'running'
  `).run(state, patch.result ?? null, patch.error ?? null, patch.progress ?? null, now, now, id);
}

export function finishJob(id, result) {
  finish(id, JOB_STATES.DONE, { result: result == null ? null : JSON.stringify(result), progress: 1 });
}

export function failJob(id, error) {
  finish(id, JOB_STATES.FAILED, { error: String(error && error.message ? error.message : error).slice(0, 1000) });
}

export function cancelJob(id) {
  finish(id, JOB_STATES.CANCELLED, {});
}

// Boot: whatever this process's predecessor left 'running' never finished.
// Back to the queue, attempts kept (a job that dies every boot is visible).
export function requeueInterrupted() {
  return d().prepare(`
    UPDATE discovery_plugin_jobs
       SET state = 'queued', progress = NULL, status_text = NULL, started_at = NULL, updated_at = ?
     WHERE state = 'running'
  `).run(Date.now()).changes;
}

// Finished rows older than the cut-off are history nobody reads.
export function pruneFinished(olderThanMs, now = Date.now()) {
  return d().prepare(`
    DELETE FROM discovery_plugin_jobs
     WHERE state IN ('done', 'failed', 'cancelled') AND finished_at IS NOT NULL AND finished_at < ?
  `).run(now - olderThanMs).changes;
}

// The runner's load across every account, for the admin panel's header.
export function countLive() {
  const rows = d().prepare(`
    SELECT state, COUNT(*) AS n FROM discovery_plugin_jobs
     WHERE state IN ('queued', 'running') GROUP BY state
  `).all();
  const out = { running: 0, queued: 0 };
  for (const r of rows) { out[r.state] = Number(r.n); }
  return out;
}

// id → username for the accounts behind a list of jobs (the admin's
// all-users view). A job outlives its account (user_id goes NULL), so a
// missing id simply has no name.
export function usernamesFor(userIds) {
  const ids = [...new Set((userIds || []).filter((id) => Number.isInteger(id)))];
  if (ids.length === 0) { return new Map(); }
  const rows = d().prepare(`SELECT id, username FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  return new Map(rows.map((r) => [r.id, r.username]));
}
