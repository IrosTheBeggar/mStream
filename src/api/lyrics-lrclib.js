/**
 * LRCLib external-lookup fallback for the lyrics endpoints (Phase 3).
 *
 * Called by src/api/subsonic/handlers.js and src/api/lyrics.js when a
 * track has no embedded or sidecar lyrics. Consults the `lyrics_cache`
 * table first; on cache miss, enqueues a background fetch against
 * https://lrclib.net and returns immediately so the HTTP response
 * stays snappy. The client sees "no lyrics" on the first request for
 * an unseen track and real data on the next one.
 *
 * NAMING GOTCHA: lyrics_cache.audio_hash actually stores the CANONICAL
 * hash — COALESCE(audio_hash, file_hash) — not audio_hash specifically.
 * Every call site keys with the fallback, and the scanner's hash rekey
 * migrates this table along with the other canonical-keyed user state.
 *
 * Opt-in via `config.lyrics.lrclib = true`. When disabled, `getCached`
 * returns null for everything and `maybeEnqueueFetch` is a no-op —
 * the cache table stays empty and no network traffic happens.
 *
 * Design choices worth knowing:
 *   - Keyed on `audio_hash` (V14 / scanner canonical identity) so a
 *     cache hit survives tag rewrites and ReplayGain updates. Only a
 *     genuine content edit invalidates.
 *   - Dedup via a `status='pending'` row: two simultaneous requests
 *     for the same track enqueue once; the second request still returns
 *     empty but doesn't double-fetch.
 *   - In-process concurrency cap (config.lyrics.concurrency, default 2).
 *     LRCLib is free and generous but a bulk-scrobble burst shouldn't
 *     hammer them.
 *   - Two-attempt fetch strategy: duration-exact first (LRCLib's
 *     matcher is stricter than users expect — re-rips at different
 *     bitrates miss the duration filter), then duration=0 fuzzy.
 *     Credit: pattern adapted from the Velvet fork
 *     (aroundmyroom/mStream:src/api/lyrics.js).
 *   - TTLs per status (config.lyrics.cacheTtl*Ms). Stale hits
 *     continue to be served while a re-fetch runs — no request
 *     regresses from "had lyrics" to "empty" on a single blip.
 *
 * Test hook: the exported `_setHttpClient` lets the test harness
 * inject a mock fetcher so we never hit lrclib.net in CI.
 */

import https from 'node:https';
import http  from 'node:http';
import zlib  from 'node:zlib';
import fs   from 'node:fs';
import path from 'node:path';
import winston from 'winston';
import * as db from '../db/manager.js';
import * as config from '../state/config.js';

// Maximum redirects any single fetch will follow. Protects against
// A→B→A loops (malicious or misconfigured proxy) that would otherwise
// recurse until the stack blows.
const MAX_REDIRECTS = 5;

// Default HTTP GET implementation. Returns `{status, body}` where body
// is parsed JSON (or null for non-200). Overridable for tests. Follows
// redirects up to MAX_REDIRECTS; dispatches to `https` or `http` based
// on scheme so the test harness can point us at a local plain-http
// mock. Accepts gzip/deflate from the origin and inflates transparently
// — LRCLib serves gzipped JSON, so identity-only would pay bandwidth
// for no reason.
function defaultHttpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let redirectCount = 0;
    const follow = (u) => {
      const mod = u.startsWith('https:') ? https : http;
      const req = mod.get(u, {
        headers: {
          'User-Agent':       'mStream/lrclib-fetch (+https://mstream.io)',
          'Accept':           'application/json',
          'Accept-Encoding':  'gzip, deflate',
        },
      }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (++redirectCount > MAX_REDIRECTS) {
            return reject(new Error(`lrclib redirect limit exceeded (${MAX_REDIRECTS})`));
          }
          return follow(res.headers.location);
        }
        // Pipe through gunzip/inflate if the origin said it compressed.
        // Identity responses flow through as-is. A malformed gzipped body
        // emits 'error' on the decompressor; we reject via the stream
        // error handler below.
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        let stream = res;
        if (enc === 'gzip')    { stream = res.pipe(zlib.createGunzip()); }
        else if (enc === 'deflate') { stream = res.pipe(zlib.createInflate()); }

        const chunks = [];
        stream.on('data', c => { chunks.push(c); });
        stream.on('end', () => {
          if (res.statusCode !== 200) { return resolve({ status: res.statusCode, body: null }); }
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve({ status: 200, body });
          } catch { resolve({ status: 200, body: null }); }
        });
        stream.on('error', err => reject(err));
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => {
        // Log explicitly — without this, a silent timeout-then-reject
        // path just writes status='error' with no breadcrumb in logs,
        // which makes "lrclib suddenly stopped working" hard to
        // diagnose. winston.warn keeps noise low while still showing
        // up in the daily rotation.
        winston.warn(`[lyrics-lrclib] timeout after ${timeoutMs}ms fetching ${u}`);
        req.destroy(new Error('lrclib timeout'));
      });
    };
    follow(url);
  });
}

let httpGet = defaultHttpGet;
/** Test-only: replace the HTTP client. Pass `null` to restore the real one. */
export function _setHttpClient(fn) { httpGet = fn || defaultHttpGet; }

// Default endpoint; overridable via env for internal testing.
const LRCLIB_BASE = process.env.MSTREAM_LRCLIB_BASE || 'https://lrclib.net';

// Per-call fetch timeout. Default 8s (matches the Velvet fork and is
// well inside LRCLib's typical latency at the 99th percentile). Read
// on every call so the admin can tune without restarting.
function fetchTimeoutMs() {
  const l = config.program.lyrics || {};
  return l.fetchTimeoutMs ?? 8000;
}

// ── Boot hook ───────────────────────────────────────────────────────────────

/**
 * Called once at server boot (wired in server.js right after the db is
 * initialised). Cleans up 'pending' rows left behind by a previous
 * process that crashed mid-fetch — without this, those rows would be
 * served as "empty, never retry" indefinitely because their TTL is
 * Infinity and `queued` dedups new fetches only while the in-process
 * Set has the entry.
 *
 * Stale pending rows are demoted to 'error' with `fetched_at=0` so
 * the TTL (1 hour) starts counting from the next real observation
 * rather than from whenever the crashed process queued them.
 */
export function onBoot() {
  try {
    const r = db.getDB().prepare(
      "UPDATE lyrics_cache SET status = 'error', fetched_at = 0 WHERE status = 'pending'"
    ).run();
    if (r.changes > 0) {
      winston.info(`[lyrics-lrclib] demoted ${r.changes} stale pending row(s) left by a previous run`);
    }
  } catch (err) {
    // lyrics_cache may not exist yet on a fresh DB before migrations
    // ran — boot is called after migrations, so this is a genuine
    // error and worth logging. Don't throw: lyrics are non-critical
    // and the server should come up regardless.
    winston.warn(`[lyrics-lrclib] boot cleanup skipped: ${err.message}`);
  }

  // Immediate orphan sweep, plus a daily repeat. Cheap enough that
  // we don't guard on isEnabled — even a disabled deployment might
  // have leftover rows from a previous enabled-era that the admin
  // never purged.
  purgeOrphans();
  if (_orphanTimer) { clearInterval(_orphanTimer); }
  _orphanTimer = setInterval(() => {
    try { purgeOrphans(); } catch (_) { /* already logged */ }
  }, 24 * 60 * 60 * 1000);
  // In Node 16+, unref() makes the timer not keep the process alive —
  // exactly what we want for a background housekeeping tick. Test
  // harnesses that spin up/tear down the server repeatedly rely on
  // this to exit cleanly.
  if (typeof _orphanTimer.unref === 'function') { _orphanTimer.unref(); }
}

// ── Cache access ────────────────────────────────────────────────────────────

function now() { return Date.now(); }

// Fetch a cache row. Returns null if there's no row for this audio_hash.
//
// Intentionally NOT gated on isEnabled(): disabling LRCLib stops new
// fetches (see maybeEnqueueFetch) but previously-cached hits keep
// serving. A "don't use what I already have" action is what the
// admin Purge button is for. This way, an operator who toggles the
// feature off to stop network traffic doesn't lose the lyrics they
// already fetched — their clients keep rendering text from the
// local SQLite cache, only new-track fetches are gated.
//
// Side-effect: an operator who wants to pretend LRCLib never
// happened must disable AND purge. The admin UI shows both
// actions together so this is discoverable.
export function getCached(audioHash) {
  if (!audioHash) { return null; }
  const row = db.getDB().prepare(
    'SELECT audio_hash, status, synced_lrc, plain, lang, source, fetched_at FROM lyrics_cache WHERE audio_hash = ?'
  ).get(audioHash);
  if (!row) { return null; }
  const age = now() - (row.fetched_at || 0);
  const ttl = ttlForStatus(row.status);
  row.isFresh = age < ttl;
  return row;
}

function ttlForStatus(status) {
  const l = config.program.lyrics || {};
  if (status === 'hit')   { return l.cacheTtlHitsMs   ?? 7 * 24 * 60 * 60 * 1000; }
  if (status === 'miss')  { return l.cacheTtlMissesMs ??     24 * 60 * 60 * 1000; }
  if (status === 'error') { return l.cacheTtlErrorsMs ??          60 * 60 * 1000; }
  // 'pending' — infinite TTL in practice; the fetcher clears it to
  // hit/miss/error when the call resolves. A crashed process could
  // leave this stuck; the admin "retry errors" button also wipes
  // pending so operators have an escape hatch.
  return Infinity;
}

function writeCacheRow(audioHash, { status, syncedLrc = null, plain = null, lang = null, source = 'lrclib' }) {
  db.getDB().prepare(`
    INSERT INTO lyrics_cache (audio_hash, status, synced_lrc, plain, lang, source, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(audio_hash) DO UPDATE SET
      status     = excluded.status,
      synced_lrc = excluded.synced_lrc,
      plain      = excluded.plain,
      lang       = excluded.lang,
      source     = excluded.source,
      fetched_at = excluded.fetched_at
  `).run(audioHash, status, syncedLrc, plain, lang, source, now());
}

// ── Async fetch queue (in-process semaphore) ────────────────────────────────

const queued = new Set();    // audio_hashes currently queued OR in-flight
let inFlight = 0;
const pendingJobs = [];

// Bumped on every `purgeAll()` / `purgeTransient()` call. Each job
// captures the generation at start and skips its writeCacheRow if the
// generation moved — that's how an in-flight fetch avoids resurrecting
// a row right after the admin wiped the table. No explicit "wait for
// inFlight=0 before DELETE" — that'd block the admin request for up
// to the 8s fetch timeout, which feels wrong for a purge button.
let purgeGeneration = 0;

/**
 * If configured + not already cached-fresh + not already queued,
 * enqueue an async fetch for this track. Returns true when enqueued.
 *
 * Never throws — every failure path logs + writes a status='error'
 * row so the caller can just await and move on.
 */
export function maybeEnqueueFetch({ audioHash, artist, title, duration }) {
  if (!isEnabled())         { return false; }
  if (!audioHash)           { return false; }
  if (!artist || !title)    { return false; }
  if (queued.has(audioHash)) { return false; }

  // Stale-hit case: the cache already has a 'hit' row whose fetched_at
  // is outside the TTL. Re-fetching is fine; flipping the row straight
  // to 'pending' would hide the stale content from resolveLyrics until
  // the refresh completes (which is exactly the "no regression on blip"
  // failure mode we're trying to avoid). Skip the pending-row write in
  // that case — the job still queues, the Set guards against duplicate
  // enqueueing, and stale content continues to serve.
  const existing = db.getDB().prepare(
    "SELECT status FROM lyrics_cache WHERE audio_hash = ?"
  ).get(audioHash);
  const isStaleHitRefresh = existing && existing.status === 'hit';

  if (!isStaleHitRefresh) {
    // Fresh enqueue: write a 'pending' row so concurrent requests
    // see it and skip enqueueing. (Also serves as a crash breadcrumb —
    // the boot hook demotes stuck pending rows to 'error' so a
    // dead-process-midway never wedges a track forever.)
    writeCacheRow(audioHash, { status: 'pending' });
  }
  queued.add(audioHash);
  pendingJobs.push({
    audioHash, artist, title,
    duration: duration || 0,
    generation: purgeGeneration,
  });
  drain();
  return true;
}

function isEnabled() {
  return !!(config.program.lyrics && config.program.lyrics.lrclib);
}

function concurrencyCap() {
  return (config.program.lyrics && config.program.lyrics.concurrency) || 2;
}

function drain() {
  // Admin-flipped-to-disabled case: purge whatever was queued so
  // jobs don't fire fetches AFTER the operator asked us to stop.
  // maybeEnqueueFetch already blocks NEW entries via isEnabled();
  // this catches the ones that landed before the toggle flipped.
  // In-flight jobs continue (their HTTP call is already out) —
  // we accept one more request to LRCLib in exchange for not having
  // to plumb AbortSignal through the whole stack.
  if (!isEnabled()) {
    if (pendingJobs.length) {
      pendingJobs.length = 0;
      // Don't clear `queued` — any entry there is in-flight; we
      // still want its .finally to decrement inFlight cleanly.
    }
    return;
  }
  while (inFlight < concurrencyCap() && pendingJobs.length) {
    const job = pendingJobs.shift();
    inFlight++;
    // Defensive .catch on top of runJob's own try/catch: if the DB
    // write inside runJob's error path itself throws (DB closed
    // during shutdown, corrupt, or ENOSPC on WAL), the promise
    // would reject into .finally-without-a-catch and surface as
    // an `unhandledRejection` event. Node 20+ exits on that by
    // default under strict runtime modes, so we swallow it here
    // after a log — lyrics are non-critical, the server should
    // survive a dead cache writer.
    runJob(job)
      .catch(err => winston.warn(`[lyrics-lrclib] runJob crashed: ${err.message}`))
      .finally(() => {
        inFlight--;
        queued.delete(job.audioHash);
        // Kick the queue again — a pile-up could have landed during the
        // await and we don't want to stall until the next external call.
        if (pendingJobs.length) { drain(); }
      });
  }
}

async function runJob(job) {
  try {
    const data = await fetchFromLrclib(job.artist, job.title, job.duration);
    // Admin wiped the cache while we were mid-fetch — respect the
    // admin's intent and drop this write instead of resurrecting the
    // row. Next request for this track re-enqueues cleanly.
    if (job.generation !== purgeGeneration) { return; }

    if (!data || (!data.syncedLyrics && !data.plainLyrics)) {
      writeCacheRow(job.audioHash, { status: 'miss' });
      return;
    }
    writeCacheRow(job.audioHash, {
      status:     'hit',
      syncedLrc:  data.syncedLyrics || null,
      plain:      data.plainLyrics  || null,
      lang:       data.lang         || null,
      source:     'lrclib',
    });
    // Optional write-back to filesystem so the lyrics travel with the
    // audio file if it's copied/exported. Never clobbers an existing
    // sidecar; silent no-op when the file moved or parent dir is
    // read-only. Next scan picks up the written sidecar and mirrors
    // it into tracks.lyrics_synced_lrc via the normal path (at which
    // point the cache row becomes a duplicate that still serves fast).
    if (config.program.lyrics?.writeSidecar) {
      writeSidecarIfPossible(job.audioHash, data);
    }
  } catch (err) {
    if (job.generation !== purgeGeneration) { return; }
    // Network / parse / timeout. Status='error' has a short TTL so a
    // transient blip doesn't stick — next request retries in ~1hr.
    writeCacheRow(job.audioHash, { status: 'error' });
  }
}

/**
 * Resolve the audio file's absolute path from its audio_hash and
 * drop a sibling .lrc (preferred) or .txt (fallback) containing the
 * fetched lyrics. Called from runJob only when the writeSidecar
 * config flag is true.
 *
 * Safety policy:
 *   - Only writes if we can resolve the track row AND the library's
 *     root_path.
 *   - Silently bails if an `.lrc` or `.txt` sibling already exists
 *     (user curation wins).
 *   - Silently bails if the audio file doesn't exist at the computed
 *     path (track renamed / moved / deleted between scan and fetch).
 *   - Silently bails on any fs error (read-only FS, permission denied,
 *     ENOSPC). These aren't fatal to the lyrics-serving path — the
 *     cache row already has the lyrics and will continue to serve.
 *
 * Exported for tests so the unit suite can assert the safety rules
 * without needing a full server spin-up.
 */
export function writeSidecarIfPossible(audioHash, data) {
  try {
    // Resolve library root + tracks.filepath for this hash. Library
    // root comes from libraries.root_path. We accept EITHER
    // audio_hash or file_hash so legacy rows (pre-V14) still get
    // write-back.
    const row = db.getDB().prepare(`
      SELECT t.filepath, l.root_path
      FROM tracks t
      JOIN libraries l ON l.id = t.library_id
      WHERE t.audio_hash = ? OR t.file_hash = ?
      LIMIT 1
    `).get(audioHash, audioHash);
    if (!row || !row.filepath || !row.root_path) { return false; }

    // Defense in depth: compute the absolute path and confirm it
    // actually resolves inside the library's root directory. Uses
    // realpath to follow symlinks — `path.resolve` alone would let
    // `/music/outward-link` (a symlink pointing to /etc) pass the
    // prefix check even though the file it points at lives outside
    // the library. The scanner writes well-formed relative paths so
    // the non-symlink case is always fine; this guard protects the
    // "someone planted a symlink inside the library" edge case from
    // turning a lyrics fetch into an arbitrary-file write.
    const rootReal = fs.realpathSync(path.resolve(row.root_path));
    const candidate = path.resolve(rootReal, row.filepath);
    if (!fs.existsSync(candidate)) { return false; }
    // realpath the CANDIDATE too so we follow a symlink that might
    // exist on the audio file. `realpathSync` throws on missing
    // files; we've already existsSync'd.
    const absolute = fs.realpathSync(candidate);
    if (absolute !== rootReal && !absolute.startsWith(rootReal + path.sep)) {
      winston.warn(`[lyrics-lrclib] refusing to write sidecar outside library root: ${absolute}`);
      return false;
    }

    // Compute sibling base. `<base>.lrc` preferred for synced content,
    // `<base>.txt` for plain. Both probed for existence; if either
    // variant already exists, we bail — curated content wins.
    const parsed = path.parse(absolute);
    const baseName = path.join(parsed.dir, parsed.name);
    const lrcPath = `${baseName}.lrc`;
    const txtPath = `${baseName}.txt`;
    if (fs.existsSync(lrcPath) || fs.existsSync(txtPath)) { return false; }

    // Pick variant + content. If we have synced lyrics, emit `.lrc`;
    // if only plain, emit `.txt`. Writing both would double-write
    // the same info.
    const target = data.syncedLyrics ? lrcPath : txtPath;
    const payload = data.syncedLyrics || data.plainLyrics;
    if (!payload) { return false; }

    // Respect the scanner's sidecar size cap on the write path too —
    // otherwise a pathologically large LRCLib response would produce
    // a sidecar the scanner immediately refuses to re-read (cap check
    // in lyrics-extraction.js), leaving a dead file on disk. LRCLib in
    // practice returns <32KB, so this is belt-and-braces.
    if (Buffer.byteLength(payload, 'utf8') > 256 * 1024) {
      winston.warn(`[lyrics-lrclib] sidecar payload > 256KB for ${audioHash}; keeping cache only`);
      return false;
    }

    // Atomic write via .tmp + rename so a crashed process never leaves
    // a truncated sidecar that the next scan would cache verbatim.
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch (err) {
    winston.warn(`[lyrics-lrclib] sidecar write-back failed for ${audioHash}: ${err.message}`);
    return false;
  }
}

// Two-attempt fetch: exact-duration first (LRCLib's matcher is strict),
// then fuzzy (duration=0) as a fallback.
//
// tryOnce distinguishes three outcomes:
//   - body (non-null)       → success, return to caller
//   - null                  → authoritative miss (HTTP 404, or 200 with
//                             empty syncedLyrics + plainLyrics)
//   - throw                 → transient error (5xx, timeout, connection
//                             refused, parse failure). `runJob` catches
//                             this and writes status='error' so the
//                             short-TTL retry logic kicks in.
//
// fetchFromLrclib returns null for a clean "LRCLib has no match for
// this track" (both attempts 404). Anything transient propagates.
async function fetchFromLrclib(artist, title, duration) {
  const tryOnce = async (dur) => {
    const params = new URLSearchParams({ artist_name: artist, track_name: title });
    if (dur > 0) { params.set('duration', String(Math.round(dur))); }
    const url = `${LRCLIB_BASE}/api/get?${params}`;
    const { status, body } = await httpGet(url, fetchTimeoutMs());
    if (status === 404) { return null; }              // authoritative miss
    if (status !== 200)  { throw new Error(`lrclib ${status}`); }  // transient
    if (!body)           { throw new Error('lrclib parse error'); }
    if (!body.syncedLyrics && !body.plainLyrics) { return null; }  // 200-but-empty
    return body;
  };

  // Exact-duration first — matches the way the Velvet fork does it,
  // which avoids spurious hits on other tracks with the same title.
  // A miss (null) falls through to fuzzy; a throw propagates so the
  // whole fetch counts as transient and retries soon.
  if (duration > 0) {
    const hit = await tryOnce(duration);
    if (hit) { return hit; }
  }
  return tryOnce(0);
}

// ── Admin helpers (purge / stats) ───────────────────────────────────────────

/**
 * Called by the admin /enabled toggle on transition to disabled.
 * Drops queued-but-not-yet-running jobs so we don't fire HTTP calls
 * against a service the operator just asked us to stop talking to.
 * In-flight jobs are left alone — their HTTP call is already out and
 * aborting a partial fetch buys us nothing. Also flips the
 * corresponding lyrics_cache 'pending' rows to 'miss' so readers
 * don't wait on a job that'll never run.
 */
export function cancelQueuedJobs() {
  if (!pendingJobs.length) { return 0; }
  const cancelled = pendingJobs.length;
  const hashes = pendingJobs.map(j => j.audioHash);
  pendingJobs.length = 0;
  // Demote the 'pending' rows we wrote in maybeEnqueueFetch so
  // requests see 'miss' and fall into the negative-cache branch
  // instead of the "let the in-flight fetch finish" branch.
  const stmt = db.getDB().prepare(
    "UPDATE lyrics_cache SET status = 'miss', fetched_at = ? WHERE audio_hash = ? AND status = 'pending'"
  );
  const ts = now();
  for (const h of hashes) { stmt.run(ts, h); }
  // Clear queued entries for cancelled jobs too. In-flight ones are
  // still in `queued` and their .finally will clean up.
  for (const h of hashes) { queued.delete(h); }
  return cancelled;
}

export function cacheStats() {
  const rows = db.getDB().prepare(
    'SELECT status, COUNT(*) AS n FROM lyrics_cache GROUP BY status'
  ).all();
  // `other` catches any status we don't recognise so `total` always
  // equals the sum of the named buckets. Future status values (e.g.
  // a `'stale'` variant) become visible in the admin panel without
  // silently inflating `total`.
  const out = { hit: 0, miss: 0, error: 0, pending: 0, other: 0, total: 0 };
  for (const r of rows) {
    if (r.status in out && r.status !== 'total' && r.status !== 'other') {
      out[r.status] = r.n;
    } else {
      out.other += r.n;
    }
    out.total += r.n;
  }
  return out;
}

/**
 * Drop every cache row. Called by the admin "purge all" button.
 * Returns the number of rows deleted.
 *
 * Race handling: bumps `purgeGeneration` so any in-flight fetch
 * whose job captured the old generation will skip its writeCacheRow
 * rather than resurrect a row right after the admin cleared the
 * table. Jobs already in the `pendingJobs` queue are cleared here
 * too — they'd write rows for data the admin just asked to forget.
 * In-flight jobs DO continue their HTTP call (we can't safely cancel
 * a partial fetch); the generation check is what makes the result
 * a no-op.
 */
export function purgeAll() {
  const r = db.getDB().prepare('DELETE FROM lyrics_cache').run();
  purgeGeneration++;
  pendingJobs.length = 0;
  // Leave `queued` alone: an entry there means "a fetch is in-flight
  // for this hash right now". Dropping it would allow a duplicate
  // enqueue for the same track before the in-flight one notices the
  // generation bump. The in-flight worker's `.finally` cleans up the
  // Set entry when it's actually done.
  return r.changes;
}

/**
 * Delete cache rows whose audio_hash no longer appears in the tracks
 * table (neither audio_hash nor file_hash matches). Called periodically
 * so we don't accumulate dead rows for tracks the user removed from
 * the library.
 *
 * Not in a hot path — runs once at boot and on a daily timer. The
 * query is a single NOT EXISTS subquery; even at 100k cache rows vs
 * 100k tracks it completes in tens of ms on a warm DB.
 *
 * Returns the number of orphans deleted.
 */
export function purgeOrphans() {
  try {
    const r = db.getDB().prepare(`
      DELETE FROM lyrics_cache
      WHERE audio_hash NOT IN (
        SELECT audio_hash FROM tracks WHERE audio_hash IS NOT NULL
        UNION
        SELECT file_hash  FROM tracks WHERE file_hash  IS NOT NULL
      )
    `).run();
    // Superseded rows: EVERY track carrying this hash now has its OWN
    // lyrics (a later scan found embedded/sidecar text — e.g. the
    // writeSidecar flow turning a cache hit into a sidecar). The read
    // path prefers track lyrics, so the row is permanent dead weight.
    // The NOT EXISTS arm is load-bearing: embedded lyrics live in TAGS,
    // so a tag-divergent duplicate (same audio_hash, no lyrics tag) is
    // still served from this row — evicting it would put that twin on
    // a daily evict→refetch treadmill against LRCLib.
    const s = db.getDB().prepare(`
      DELETE FROM lyrics_cache
      WHERE EXISTS (
        SELECT 1 FROM tracks t
        WHERE (t.audio_hash = lyrics_cache.audio_hash OR t.file_hash = lyrics_cache.audio_hash)
          AND (t.lyrics_synced_lrc IS NOT NULL OR t.lyrics_embedded IS NOT NULL)
      )
      AND NOT EXISTS (
        SELECT 1 FROM tracks t
        WHERE (t.audio_hash = lyrics_cache.audio_hash OR t.file_hash = lyrics_cache.audio_hash)
          AND t.lyrics_synced_lrc IS NULL AND t.lyrics_embedded IS NULL
      )
    `).run();
    const total = r.changes + s.changes;
    if (total > 0) {
      winston.info(`[lyrics-lrclib] swept ${r.changes} orphan + ${s.changes} superseded cache row(s)`);
    }
    return total;
  } catch (err) {
    winston.warn(`[lyrics-lrclib] orphan sweep failed: ${err.message}`);
    return 0;
  }
}

// Daily sweep timer. Bookkept so `reset()` (used in tests) can stop it.
let _orphanTimer = null;

/**
 * Wipe just the error + pending rows so those tracks get retried on
 * next request. Used by the admin "retry errors" button to shake
 * loose a network-outage window without dropping successful hits.
 *
 * Does NOT bump `purgeGeneration` — we want in-flight fetches to
 * complete and write their real result. Only pre-existing rows
 * (from a prior run or a cancelled scan) are wiped.
 */
export function purgeTransient() {
  const r = db.getDB().prepare(
    "DELETE FROM lyrics_cache WHERE status IN ('error', 'pending')"
  ).run();
  // Intentionally do NOT touch `queued`/`pendingJobs`:
  //   - `queued` reflects in-memory in-flight work; draining it
  //     would just let duplicate enqueues fire for the same track.
  //   - `pendingJobs` may contain brand-new queued jobs that are
  //     not yet represented by any row — dropping them would lose
  //     requests the admin didn't intend to cancel.
  return r.changes;
}

// ── Test-only internals ─────────────────────────────────────────────────────

/**
 * Wait until the background queue drains. Returns a Promise that
 * resolves when `inFlight === 0 && pendingJobs.length === 0`. Poll-
 * based (5ms) — accurate enough for tests and zero overhead when
 * not called.
 */
export function _drainForTests() {
  return new Promise(resolve => {
    const tick = () => {
      if (inFlight === 0 && pendingJobs.length === 0) { return resolve(); }
      setTimeout(tick, 5);
    };
    tick();
  });
}

/** Test-only: reset the in-memory queue state between cases. */
export function _resetForTests() {
  queued.clear();
  pendingJobs.length = 0;
  inFlight = 0;
  purgeGeneration = 0;
  if (_orphanTimer) {
    clearInterval(_orphanTimer);
    _orphanTimer = null;
  }
}
