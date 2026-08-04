// Bandwidth limits for federated readers (the V62 columns on federation_keys).
//
// Registered as middleware immediately after the auth wall, so it sees every
// request a federation key makes — the wall already resolved the key and
// attached its limits to the synthetic req.user (api/federation-auth.js).
// Non-federation requests pass through untouched.
//
// Three per-key caps, all "0 = unlimited":
//   maxStreams — concurrent /media responses. Checked before the handler
//                runs; over the cap is a 429.
//   dailyMb    — per-UTC-day transfer quota over EVERYTHING the key pulls
//                (media, art, metadata JSON). Enforced with a 429 on the
//                byte-heavy routes only: browse and health keep answering,
//                so the peer's UI can still say WHY playback stopped. An
//                in-flight response is never cut, so a day can overshoot by
//                at most one file.
//   streamKbps — a token-bucket rate cap on /media responses, with the
//                bucket SHARED across the key's concurrent streams (two
//                parallel downloads split the same budget).
//
// Accounting is an in-process accumulator flushed to federation_key_usage
// every ~15s (never a DB write per request — same reasoning as
// touchFederationKeyLastUsed). Quota checks read baseline-from-DB plus the
// unflushed remainder, so restarts can't forget a day and bursts can't
// outrun the flusher.
//
// Throttling wraps res.write/res.end (the compression-middleware technique).
// The wrapper preserves pipe semantics: a delayed chunk makes write() return
// false (pausing the producing file stream), and once the chunk actually
// goes out we emit 'drain' to resume it. Chunks are dispatched strictly FIFO
// so a delayed body chunk can never be overtaken by end().

import winston from 'winston';
import WebError from '../util/web-error.js';
import * as fedDb from '../db/federation.js';

const MB = 1024 * 1024;
// Test override, same pattern as MSTREAM_TEST_DISCOVERY_PRUNE_MS: production
// installs should never set it.
const FLUSH_INTERVAL_MS = Number(process.env.MSTREAM_TEST_FED_FLUSH_MS) || 15 * 1000;
const FLUSH_THRESHOLD_BYTES = 8 * MB; // don't let a fast pull sit unflushed
const USAGE_KEEP_DAYS = 90;

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

function secondsToUtcMidnight() {
  const now = Date.now();
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now) / 1000));
}

// ── Usage accounting ─────────────────────────────────────────────────────────

const pending = new Map(); // keyId -> { day, bytes, requests } (unflushed)
const dbBaseline = new Map(); // keyId -> { day, bytes } (DB value at first touch today)
let flushTimer = null;
let lastPruneDay = null;

function ensureFlushTimer() {
  if (flushTimer) { return; }
  flushTimer = setInterval(() => flushUsage(), FLUSH_INTERVAL_MS);
  if (flushTimer.unref) { flushTimer.unref(); }
  // Best-effort final flush — node:sqlite is synchronous, so this is safe in
  // an exit handler. Losing it costs at most one interval of quota memory.
  process.once('exit', () => { try { flushUsage(); } catch (_err) { /* db already closed */ } });
}

function flushKey(keyId, entry) {
  if (entry.bytes === 0 && entry.requests === 0) { pending.delete(keyId); return; }
  fedDb.recordFederationKeyUsage(keyId, entry.day, entry.bytes, entry.requests);
  const base = dbBaseline.get(keyId);
  if (base && base.day === entry.day) { base.bytes += entry.bytes; }
  pending.delete(keyId);
}

export function flushUsage() {
  for (const [keyId, entry] of [...pending]) {
    try {
      flushKey(keyId, entry);
    } catch (err) {
      // Keep accumulating and retry next interval — a locked/closing DB
      // must not lose the day's count or take a stream down with it.
      winston.warn(`[federation] usage flush failed for key id=${keyId}: ${err.message}`);
      return;
    }
  }
  const today = utcDay();
  if (lastPruneDay !== today) {
    lastPruneDay = today;
    try { fedDb.pruneFederationKeyUsage(USAGE_KEEP_DAYS); } catch (err) {
      winston.warn(`[federation] usage prune failed: ${err.message}`);
    }
  }
}

function addUsage(keyId, bytes, requests = 0) {
  const day = utcDay();
  let entry = pending.get(keyId);
  if (entry && entry.day !== day) {
    // UTC day rolled over mid-accumulation: bank yesterday before counting.
    try { flushKey(keyId, entry); } catch (err) {
      winston.warn(`[federation] day-rollover flush failed for key id=${keyId}: ${err.message}`);
    }
    entry = pending.get(keyId);
  }
  if (!entry) { entry = { day, bytes: 0, requests: 0 }; pending.set(keyId, entry); }
  entry.bytes += bytes;
  entry.requests += requests;
  ensureFlushTimer();
  if (entry.bytes >= FLUSH_THRESHOLD_BYTES) {
    try { flushKey(keyId, entry); } catch (_err) { /* interval flush retries */ }
  }
}

// Today's total for a key, unflushed remainder included — what the quota
// gate compares and what the admin key list shows as "today".
export function usedTodayBytes(keyId) {
  const day = utcDay();
  let base = dbBaseline.get(keyId);
  if (!base || base.day !== day) {
    base = { day, bytes: fedDb.getFederationKeyUsage(keyId, day).bytes };
    dbBaseline.set(keyId, base);
  }
  const entry = pending.get(keyId);
  return base.bytes + (entry && entry.day === day ? entry.bytes : 0);
}

// ── Shared token buckets (per key, /media responses only) ────────────────────

const buckets = new Map(); // keyId -> { tokens, last }

// Deduct `size` bytes; returns how long this chunk must wait (ms). Tokens go
// negative (debt), which is what serializes successive chunks — each caller
// inherits the debt the previous one left. Burst capacity is one second of
// rate, so playback starts and seeks stay snappy.
function takeTokens(keyId, bytesPerSec, size) {
  const now = Date.now();
  let b = buckets.get(keyId);
  if (!b) { b = { tokens: bytesPerSec, last: now }; buckets.set(keyId, b); }
  b.tokens = Math.min(bytesPerSec, b.tokens + ((now - b.last) / 1000) * bytesPerSec);
  b.last = now;
  b.tokens -= size;
  if (b.tokens >= 0) { return 0; }
  return Math.ceil((-b.tokens / bytesPerSec) * 1000);
}

// ── Response metering (count always, throttle when asked) ────────────────────

function chunkBytes(chunk, encoding) {
  if (chunk == null) { return 0; }
  if (typeof chunk === 'string') { return Buffer.byteLength(chunk, encoding || 'utf8'); }
  return chunk.byteLength || chunk.length || 0;
}

// Wrap res.write/res.end. bytesPerSec 0 = count only (cheap pass-through).
function meterResponse(res, keyId, bytesPerSec) {
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);

  if (bytesPerSec <= 0) {
    res.write = function write(chunk, encoding, cb) {
      if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
      addUsage(keyId, chunkBytes(chunk, encoding));
      return origWrite(chunk, encoding, cb);
    };
    res.end = function end(chunk, encoding, cb) {
      if (typeof chunk === 'function') { cb = chunk; chunk = null; encoding = undefined; }
      else if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
      addUsage(keyId, chunkBytes(chunk, encoding));
      return origEnd(chunk, encoding, cb);
    };
    return;
  }

  // Throttled path. Invariants:
  //  - at most one chunk is "in flight" (waiting on its timer);
  //  - queue holds everything that arrived while one was in flight, in
  //    order, with end() as a terminal queue item;
  //  - once we've returned false, the producer is resumed exactly once, by
  //    'drain' — ours when the underlying write succeeded, the socket's own
  //    when it reported backpressure.
  const queue = [];
  let inFlight = false;
  let timer = null;
  let closed = false;

  res.once('close', () => {
    closed = true;
    if (timer) { clearTimeout(timer); timer = null; }
    // Unstick any producer waiting on a write callback we'll never issue.
    for (const item of queue.splice(0)) {
      if (item.cb) { try { item.cb(); } catch (_err) { /* producer gone */ } }
    }
  });

  function dispatchNext(lastWriteOk) {
    if (closed) { return; }
    const next = queue.shift();
    if (!next) {
      // Queue drained: if the socket took our last chunk without complaint,
      // wake the producer we paused; otherwise its own 'drain' will.
      if (lastWriteOk) { res.emit('drain'); }
      return;
    }
    if (next.kind === 'end') { origEnd(next.cb); return; }
    schedule(next, takeTokens(keyId, bytesPerSec, next.size));
  }

  function schedule(item, delayMs) {
    if (delayMs <= 0) {
      const ok = origWrite(item.chunk, item.encoding, item.cb);
      dispatchNext(ok);
      return;
    }
    inFlight = true;
    timer = setTimeout(() => {
      timer = null;
      inFlight = false;
      if (closed) { if (item.cb) { try { item.cb(); } catch (_err) { /* noop */ } } return; }
      const ok = origWrite(item.chunk, item.encoding, item.cb);
      dispatchNext(ok);
    }, delayMs);
  }

  res.write = function write(chunk, encoding, cb) {
    if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
    const size = chunkBytes(chunk, encoding);
    addUsage(keyId, size);
    if (closed) { if (cb) { cb(); } return false; }
    if (!inFlight && queue.length === 0) {
      const delayMs = takeTokens(keyId, bytesPerSec, size);
      if (delayMs <= 0) { return origWrite(chunk, encoding, cb); }
      schedule({ kind: 'write', chunk, encoding, cb, size }, delayMs);
      return false;
    }
    queue.push({ kind: 'write', chunk, encoding, cb, size });
    return false;
  };

  res.end = function end(chunk, encoding, cb) {
    if (typeof chunk === 'function') { cb = chunk; chunk = null; encoding = undefined; }
    else if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
    if (closed) { if (cb) { cb(); } return this; }
    if (chunk != null) {
      const size = chunkBytes(chunk, encoding);
      addUsage(keyId, size);
      if (!inFlight && queue.length === 0) {
        const delayMs = takeTokens(keyId, bytesPerSec, size);
        if (delayMs <= 0) { return origEnd(chunk, encoding, cb); }
        queue.push({ kind: 'end', cb });
        schedule({ kind: 'write', chunk, encoding, cb: undefined, size }, delayMs);
        return this;
      }
      queue.push({ kind: 'write', chunk, encoding, cb: undefined, size });
      queue.push({ kind: 'end', cb });
      return this;
    }
    if (!inFlight && queue.length === 0) { return origEnd(cb); }
    queue.push({ kind: 'end', cb });
    return this;
  };
}

// ── Concurrency + the middleware ─────────────────────────────────────────────

const activeStreams = new Map(); // keyId -> live /media response count

export function activeStreamCount(keyId) {
  return activeStreams.get(keyId) || 0;
}

// The byte-heavy surface: media files. Art files are counted against the
// quota like everything else but stay off the stream cap / throttle — they
// are small, and starving a UI of thumbnails punishes nobody who matters.
function isHeavy(req) {
  return req.method === 'GET' && req.path.startsWith('/media/');
}

export function setup(mstream) {
  mstream.use((req, res, next) => {
    const user = req.user;
    if (!user || user.federation !== true) { return next(); }

    const keyId = user.federationKeyId;
    const limits = user.federationLimits || {};
    addUsage(keyId, 0, 1);

    const heavy = isHeavy(req);
    if (heavy) {
      if (limits.maxStreams > 0 && activeStreamCount(keyId) >= limits.maxStreams) {
        winston.warn(`[federation] ${user.username} over the concurrent-stream cap `
          + `(${limits.maxStreams}) on ${req.path} from ${req.ip}`);
        res.set('Retry-After', '5');
        throw new WebError('Too many concurrent streams', 429);
      }
      if (limits.dailyMb > 0 && usedTodayBytes(keyId) >= limits.dailyMb * MB) {
        winston.warn(`[federation] ${user.username} over the daily transfer quota `
          + `(${limits.dailyMb} MB) on ${req.path} from ${req.ip}`);
        res.set('Retry-After', String(secondsToUtcMidnight()));
        throw new WebError('Daily transfer quota exceeded', 429);
      }
      activeStreams.set(keyId, activeStreamCount(keyId) + 1);
      res.once('close', () => {
        const n = activeStreamCount(keyId) - 1;
        if (n <= 0) { activeStreams.delete(keyId); } else { activeStreams.set(keyId, n); }
      });
    }

    // kbps -> bytes/sec (* 1000 / 8). Throttle only media; count everything.
    meterResponse(res, keyId, heavy && limits.streamKbps > 0 ? limits.streamKbps * 125 : 0);
    next();
  });
}
