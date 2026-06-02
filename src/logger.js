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

let ring = new Array(BOOT_DEFAULT_CAPACITY);
let ringCapacity = BOOT_DEFAULT_CAPACITY;
let ringHead = 0;   // index of the next slot to write
let ringCount = 0;  // number of valid entries currently stored
let seqCounter = 0; // monotonic id so clients can ask "entries after N"

function pushEntry(level, message) {
  if (ringCapacity <= 0) { return; }
  if (message.length > MAX_ENTRY_LEN) {
    message = message.slice(0, MAX_ENTRY_LEN) + '… [truncated]';
  }
  seqCounter += 1;
  ring[ringHead] = { seq: seqCounter, t: new Date().toISOString(), level, message };
  ringHead = (ringHead + 1) % ringCapacity;
  if (ringCount < ringCapacity) { ringCount += 1; }
}

// Entries oldest→newest. `sinceSeq` returns only entries with a greater seq
// (what the live poll uses); 0 returns the whole buffer.
function snapshot(sinceSeq) {
  const out = [];
  if (ringCapacity <= 0 || ringCount === 0) { return out; }
  // Oldest valid entry sits `ringCount` slots behind the write head.
  const start = (ringHead - ringCount + ringCapacity * 2) % ringCapacity;
  for (let i = 0; i < ringCount; i++) {
    const e = ring[(start + i) % ringCapacity];
    if (e && e.seq > sinceSeq) { out.push(e); }
  }
  return out;
}

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
      pushEntry(level, message);
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
  if (next === ringCapacity) { return; }

  const keep = next === 0 ? [] : snapshot(0).slice(-next);
  ring = new Array(next);
  ringCapacity = next;
  ringHead = 0;
  ringCount = 0;
  for (const e of keep) {
    ring[ringHead] = e;
    ringHead = (ringHead + 1) % ringCapacity;
    ringCount += 1;
  }
}

// Read recent log entries for the admin live-log viewer. `sinceSeq` is the
// highest seq the client has already seen; entries newer than it are returned
// (oldest→newest) along with the current `lastSeq` cursor and the buffer
// `capacity`. A stale/out-of-range cursor (e.g. a client holding a high seq
// from before a server restart reset the counter to 0) falls back to the full
// buffer so the view recovers instead of showing nothing.
export function getRecentLogs(sinceSeq) {
  let since = Number(sinceSeq) || 0;
  if (since < 0 || since > seqCounter) { since = 0; }
  return { entries: snapshot(since), lastSeq: seqCounter, capacity: ringCapacity };
}
