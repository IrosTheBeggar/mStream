// The Youtube DL route's jobs (src/api/ytdl.js): one entry per pasted URL,
// per account, in memory. A running entry stays until it settles; a settled
// one (complete or error) is kept a day, then forgotten — and a restart
// forgets them all. The durable record of what came in is plugin_downloads
// (`downloadId` links an entry to its row there).
//
// Pure apart from the clock, which every call takes as `now`, so the unit
// tests drive retention without waiting a day.
//
// Ids are random strings, never a counter: a client keeps them across
// reloads, and a counter that restarts at 1 with the server would match a
// stale id to somebody's new job. Keying by id (not by pid, as the route
// once did) also survives a pid the OS reuses within the day and a spawn
// that never got one.

import crypto from 'node:crypto';

export const SETTLED_TTL_MS = 24 * 60 * 60 * 1000;
// Bounds the memory one account's settled entries take; the newest stay.
export const MAX_SETTLED_PER_USER = 50;
// The longest error text an entry keeps (an ffmpeg tail can run on).
export const MAX_ERROR_CHARS = 500;

export const REASONS = Object.freeze(['exists', 'too-big', 'too-long', 'live', 'unavailable']);

const jobs = new Map();   // id → job, in start order

export function create({ userId = null, pid = null, url, directory, outputCodec, fileName = null, now = Date.now() }) {
  prune(now);
  const job = {
    id: crypto.randomUUID(),
    userId,
    pid: Number.isInteger(pid) ? pid : null,
    url,
    directory,
    outputCodec,
    status: 'downloading',
    startTime: now,
    endTime: null,
    fileName: fileName || null,
    filePath: null,
    downloadId: null,
    error: null,
    reason: null,
  };
  jobs.set(job.id, job);
  return job;
}

// The song is in the library: `filePath` is its library path
// ("<vpath>/<relative path>", as every API spells a song), `fileName` the
// name it landed with, `downloadId` its plugin_downloads row (null when the
// record could not be written — the song is in the library regardless).
export function complete(job, { filePath, fileName, downloadId = null, now = Date.now() }) {
  Object.assign(job, {
    status: 'complete', endTime: now, filePath, fileName: fileName || job.fileName, downloadId, error: null, reason: null,
  });
  return job;
}

// It did not come in: `error` is the sentence to show (publicMessage has
// already taken the server's own paths out of it), `reason` one of REASONS
// or null when no code fits and the words are the answer.
export function fail(job, { error, reason = null, now = Date.now() }) {
  const text = String(error || 'the download failed');
  Object.assign(job, {
    status: 'error',
    endTime: now,
    error: text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text,
    reason: REASONS.includes(reason) ? reason : null,
  });
  return job;
}

// Settled entries older than a day go; then each account keeps its newest
// MAX_SETTLED_PER_USER settled ones. Running entries are never pruned.
export function prune(now = Date.now()) {
  const settledBy = new Map();
  for (const job of jobs.values()) {
    if (job.status === 'downloading') { continue; }
    if (job.endTime < now - SETTLED_TTL_MS) { jobs.delete(job.id); continue; }
    if (!settledBy.has(job.userId)) { settledBy.set(job.userId, []); }
    settledBy.get(job.userId).push(job);
  }
  for (const list of settledBy.values()) {
    if (list.length <= MAX_SETTLED_PER_USER) { continue; }
    list.sort((a, b) => b.endTime - a.endTime);
    for (const job of list.slice(MAX_SETTLED_PER_USER)) { jobs.delete(job.id); }
  }
}

// One account's entries, newest first (a client that follows an entry by
// pid + url + folder takes the first match, so a reused pid finds the
// newest), with the account itself left out.
export function listFor(userId, { now = Date.now() } = {}) {
  prune(now);
  return [...jobs.values()]
    .filter((j) => j.userId === userId)
    .sort((a, b) => b.startTime - a.startTime)
    .map(toPublic);
}

export function toPublic(job) {
  const { userId: _userId, ...pub } = job;
  return pub;
}

// What a failure says to the person who asked. The server's own places on
// disk never leave it: each `[path, replacement]` pair swaps an absolute
// path for what the caller may see (the staging folder for nothing, so a
// staged file reads as its bare name; the library folder for the folder
// they named). Longest first, so a folder inside another is swapped whole.
// An extractor's refusal ("[youtube] <id>: Sign in to confirm …") keeps
// YouTube's words and drops yt-dlp's tag for itself.
export function publicMessage(err, replacements = []) {
  let text = String((err && err.message) || err || 'the download failed').trim()
    .replace(/^\[[^\]\s]+\]\s+[^\s:]+:\s+(?=\S)/, '');
  const pairs = replacements
    .filter(([from]) => typeof from === 'string' && from.length > 1)
    .sort((a, b) => b[0].length - a[0].length);
  for (const [from, to] of pairs) {
    const trimmed = from.replace(/[\\/]+$/, '');
    // yt-dlp is Python: an OS error quotes a Windows path as its repr, every
    // backslash doubled ("… device: 'C:\\\\data\\\\job-ytdl-x\\\\Song.webm'").
    const forms = trimmed.includes('\\') ? [trimmed.replace(/\\/g, '\\\\'), trimmed] : [trimmed];
    for (const form of forms) {
      // "<from>/name" → "<to>/name" (or just "name" when `to` is empty).
      for (const sep of ['/', '\\\\', '\\']) { text = text.split(form + sep).join(to ? to + '/' : ''); }
      text = text.split(form).join(to || '');
    }
  }
  return text || 'the download failed';
}

export function _resetForTests() { jobs.clear(); }
