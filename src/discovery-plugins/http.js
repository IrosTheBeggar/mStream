// Outbound helpers for catalogue plug-ins: bounded JSON GET, a token-bucket
// rate limiter, a small TTL cache, and the error shape the route turns into
// a status code.
//
// The GET rides album-art-lib's httpGet — the same bounded, redirect-safe,
// deadline-guarded client the album-art downloader already points at these
// services, and the same MSTREAM_*_BASE env overrides tests use for mocks.

import { httpGet } from '../db/album-art-lib.js';

// An error a plug-in throws on purpose: `status` is what the client gets
// (429 for a rate limit, 502 for a catalogue failure). Anything without a
// status is a 502 too — a plug-in failure is never a server error.
export function providerError(message, status = 502) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export async function fetchJson(url, { maxBytes = 2 * 1024 * 1024 } = {}) {
  let buf;
  try {
    buf = await httpGet(url, { maxBytes });
  } catch (err) {
    const m = /^HTTP (\d{3})$/.exec(err.message || '');
    // A 429 (or a 403, which the iTunes API uses for rate limiting) from
    // the catalogue is passed on as 429 so the client backs off; every
    // other failure is the catalogue's problem, not ours.
    const status = m && (m[1] === '429' || m[1] === '403') ? 429 : 502;
    throw providerError(`catalogue request failed: ${err.message}`, status);
  }
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (_e) {
    throw providerError('catalogue returned malformed JSON', 502);
  }
}

// Token bucket: `tokens` requests per `perMs`, refilled continuously.
// take() never waits — a plug-in that is out of budget says so (429)
// instead of queueing requests behind a limit a user cannot see.
export class RateLimiter {
  constructor({ tokens, perMs, now = Date.now }) {
    this.capacity = tokens;
    this.perMs = perMs;
    this.now = now;
    this.available = tokens;
    this.last = now();
  }
  take(n = 1) {
    const t = this.now();
    this.available = Math.min(this.capacity, this.available + ((t - this.last) / this.perMs) * this.capacity);
    this.last = t;
    if (this.available < n) { return false; }
    this.available -= n;
    return true;
  }
}

// Small LRU-ish TTL cache keyed by string. `undefined` means "not cached";
// null is a legitimate cached value ("we looked, there is nothing").
export class TtlCache {
  constructor({ ttlMs, max = 500, now = Date.now }) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.now = now;
    this.map = new Map();
  }
  get(key) {
    const e = this.map.get(key);
    if (!e) { return undefined; }
    if (this.now() - e.at > this.ttlMs) { this.map.delete(key); return undefined; }
    // Touch: Map keeps insertion order, so re-inserting makes eviction LRU.
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }
  set(key, value) {
    this.map.delete(key);
    this.map.set(key, { value, at: this.now() });
    while (this.map.size > this.max) { this.map.delete(this.map.keys().next().value); }
  }
  clear() { this.map.clear(); }
}
