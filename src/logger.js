import winston from 'winston';
import fs from 'fs';
import path from 'path';
import os from 'os';

let fileTransport;
let rotateInterval;
let currentDirname;
let currentDateKey;

const myFormat = winston.format.printf(info => {
  const msg = `${info.timestamp} ${info.level}: ${info.message}`;
  if (!info.stack) { return msg; }

  const stackStr = typeof info.stack === 'string' ?
    { stack: info.stack } :
    JSON.parse(JSON.stringify(info.stack, Object.getOwnPropertyNames(info.stack)));

  return msg + os.EOL + stackStr.stack;
});

// Callers across the codebase log errors as `winston.error('msg', { stack: err })`,
// passing the Error OBJECT. winston's json() serializer (used by the file
// transport) calls JSON.stringify, which drops Error's non-enumerable `message`
// and `stack` — so a raw `{ stack: err }` lands on disk as `"stack":{}` (or just
// the enumerable `.code`), hiding the actual cause from anyone reading the log
// file. Normalize a non-string stack to its text form BEFORE json() so on-disk
// logs stay useful. The Console (myFormat) and live-buffer transports already do
// this themselves, so this only needs to feed the file transport.
const normalizeStack = winston.format(info => {
  if (info.stack && typeof info.stack !== 'string') {
    info.stack = info.stack.stack || info.stack.message || String(info.stack);
  }
  return info;
});

// ── In-memory ring buffer for the admin live-log viewer ─────────────────────
// A fixed-capacity circular buffer of the most recent log entries, fed by a
// winston transport that is ALWAYS attached — independent of the on-disk file
// transport. The admin panel polls getRecentLogs() to stream these without
// ever touching disk, so live logs work even when writeLogs is off.
//
// Memory is bounded two ways: `ringCapacity` caps the entry count, and each
// entry's text is truncated to MAX_ENTRY_LEN so one giant stack trace can't
// blow the per-entry budget. See logBufferSize in src/state/config.js.
const MAX_ENTRY_LEN = 4000;

// Hard ceiling mirrored from the logBufferSize Joi validator — defends the
// buffer against an out-of-range value reaching setBufferCapacity() directly.
const MAX_CAPACITY = 10000;

// Boot-time default. Mirrors the logBufferSize config default so the buffer
// captures early-boot logs (config validation, etc.) before server.js applies
// the configured value via setBufferCapacity().
const BOOT_DEFAULT_CAPACITY = 500;

// The discovery/p2p ring's fixed capacity — deliberately not a config knob.
// Worst case is capacity × MAX_ENTRY_LEN ≈ 2MB, but real discovery lines run
// ~100–200 bytes, so a full ring is ~150KB.
const P2P_RING_CAPACITY = 500;

// One fixed-capacity circular buffer of recent log entries. Two instances
// below: the main ring behind the admin live-log viewer, and a discovery/p2p
// ring behind the Discovery panel's Activity feed — its own ring so a chatty
// scan can never wash mesh events out of the feed.
class LogRing {
  constructor(capacity) {
    this.ring = new Array(capacity);
    this.capacity = capacity;
    this.head = 0;       // index of the next slot to write
    this.count = 0;      // number of valid entries currently stored
    this.seqCounter = 0; // monotonic id so clients can ask "entries after N"
  }

  push(level, message) {
    if (this.capacity <= 0) { return; }
    if (message.length > MAX_ENTRY_LEN) {
      message = message.slice(0, MAX_ENTRY_LEN) + '… [truncated]';
    }
    this.seqCounter += 1;
    this.ring[this.head] = { seq: this.seqCounter, t: new Date().toISOString(), level, message };
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) { this.count += 1; }
  }

  // Entries oldest→newest. `sinceSeq` returns only entries with a greater seq
  // (what the live poll uses); 0 returns the whole buffer.
  snapshot(sinceSeq) {
    const out = [];
    if (this.capacity <= 0 || this.count === 0) { return out; }
    // Oldest valid entry sits `count` slots behind the write head.
    const start = (this.head - this.count + this.capacity * 2) % this.capacity;
    for (let i = 0; i < this.count; i++) {
      const e = this.ring[(start + i) % this.capacity];
      if (e && e.seq > sinceSeq) { out.push(e); }
    }
    return out;
  }

  // The poll contract shared by both ring endpoints: a stale/out-of-range
  // cursor (e.g. a client holding a high seq from before a server restart
  // reset the counter) falls back to the full buffer so the view recovers
  // instead of showing nothing.
  read(sinceSeq) {
    let since = Number(sinceSeq) || 0;
    if (since < 0 || since > this.seqCounter) { since = 0; }
    return { entries: this.snapshot(since), lastSeq: this.seqCounter, capacity: this.capacity };
  }

  resize(capacity) {
    const keep = capacity === 0 ? [] : this.snapshot(0).slice(-capacity);
    this.ring = new Array(capacity);
    this.capacity = capacity;
    this.head = 0;
    this.count = 0;
    for (const e of keep) {
      this.ring[this.head] = e;
      this.head = (this.head + 1) % this.capacity;
      this.count += 1;
    }
  }
}

const mainRing = new LogRing(BOOT_DEFAULT_CAPACITY);
const p2pRing = new LogRing(P2P_RING_CAPACITY);

// Every discovery-stack module logs under a bracketed prefix, and nothing
// outside the stack uses these ([discovery-p2p], [discovery-p2p-stack],
// [discovery-peer-dbs], [discovery-catalog], [discovery-seeds],
// [p2p-sidecar]) — so line-start prefix matching IS the event filter.
const P2P_LINE = /^\[(discovery-|p2p-sidecar)/;

// winston re-exports the winston-transport base class as winston.Transport,
// so we don't need a separate winston-transport dependency to subclass it.
class MemoryRingTransport extends winston.Transport {
  log(info, callback) {
    setImmediate(() => this.emit('logged', info));
    try {
      // Symbol.for('level') is winston's immutable raw level — unaffected by
      // the Console transport's colorize() mutating the visible info.level.
      const level = info[Symbol.for('level')] || info.level;
      let message = String(info.message ?? '');
      // Mirror myFormat: append a stack trace when present. Callers pass
      // either a string or an Error object via { stack: err }.
      if (info.stack) {
        const stackText = typeof info.stack === 'string'
          ? info.stack
          : (info.stack.stack || info.stack.message || '');
        if (stackText) { message += os.EOL + stackText; }
      }
      mainRing.push(level, message);
      if (P2P_LINE.test(message)) { p2pRing.push(level, message); }
    } catch { /* logging must never throw */ }
    callback();
  }
}

const memoryTransport = new MemoryRingTransport();

winston.configure({
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp(),
        myFormat
      )
    }),
    memoryTransport
  ],
  exitOnError: false
});

function dateKey() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}`;
}

// Matches mstream-YYYY-MM-DD-HH.log and size-rotated variants mstream-...log.1, .log.2, etc.
const LOG_FILE_PATTERN = /^mstream-\d{4}-\d{2}-\d{2}-\d{2}\.log(\.\d+)?$/;

function pruneOldLogs(dirname, maxAgeDays) {
  try {
    const cutoff = Date.now() - maxAgeDays * 86400_000;
    for (const f of fs.readdirSync(dirname)) {
      if (!LOG_FILE_PATTERN.test(f)) { continue; }
      const full = path.join(dirname, f);
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.unlinkSync(full);
      }
    }
  } catch { /* best-effort cleanup */ }
}

function buildFileTransport(dirname, key) {
  return new winston.transports.File({
    filename: path.join(dirname, `mstream-${key}.log`),
    maxsize: 20 * 1024 * 1024,
    format: winston.format.combine(
      normalizeStack(),
      winston.format.timestamp(),
      winston.format.json()
    ),
  });
}

function rotateIfNeeded() {
  const key = dateKey();
  if (key === currentDateKey) { return; }

  if (fileTransport) { winston.remove(fileTransport); }
  currentDateKey = key;
  fileTransport = buildFileTransport(currentDirname, key);
  winston.add(fileTransport);
  pruneOldLogs(currentDirname, 14);
}

export function addFileLogger(filepath) {
  if (fileTransport) { reset(); }

  fs.mkdirSync(filepath, { recursive: true });
  currentDirname = filepath;
  currentDateKey = dateKey();
  fileTransport = buildFileTransport(filepath, currentDateKey);
  winston.add(fileTransport);
  pruneOldLogs(filepath, 14);

  rotateInterval = setInterval(rotateIfNeeded, 60_000);
  rotateInterval.unref();
}

export function reset() {
  if (rotateInterval) {
    clearInterval(rotateInterval);
    rotateInterval = undefined;
  }
  if (fileTransport) {
    winston.remove(fileTransport);
    fileTransport = undefined;
  }
  currentDateKey = undefined;
  currentDirname = undefined;
}

// Resize the in-memory live-log ring buffer (see the block above). Takes
// effect immediately, preserving the most recent entries that still fit under
// the new capacity. 0 disables the buffer. Called at boot from server.js with
// the configured logBufferSize, and at runtime from util/admin.js when an
// admin edits the value — no reboot required. NOT touched by reset(): the live
// buffer is independent of whether logs are written to disk.
export function setBufferCapacity(n) {
  const next = Math.max(0, Math.min(MAX_CAPACITY, Math.floor(Number(n) || 0)));
  if (next === mainRing.capacity) { return; }
  mainRing.resize(next);
}

// Read recent log entries for the admin live-log viewer. `sinceSeq` is the
// highest seq the client has already seen; entries newer than it are returned
// (oldest→newest) along with the current `lastSeq` cursor and the buffer
// `capacity` (see LogRing.read for the stale-cursor recovery contract).
export function getRecentLogs(sinceSeq) {
  return mainRing.read(sinceSeq);
}

// The discovery/p2p slice of the log stream, from its own fixed-size ring —
// the Discovery panel's Activity feed. Same poll contract as getRecentLogs;
// the two rings' seq counters are independent, so cursors from one endpoint
// mean nothing at the other.
export function getP2pActivity(sinceSeq) {
  return p2pRing.read(sinceSeq);
}
