import winston from 'winston';
import fs from 'fs';
import path from 'path';
import os from 'os';

let fileTransport;
let rotateInterval;
let currentDirname;
let currentDateKey;

const myFormat = winston.format.printf(info => {
  let msg = `${info.timestamp} ${info.level}: ${info.message}`;
  if (!info.stack) { return msg; }

  const stackStr = typeof info.stack === 'string' ?
    { stack: info.stack } :
    JSON.parse(JSON.stringify(info.stack, Object.getOwnPropertyNames(info.stack)));

  return msg +=  os.EOL + stackStr.stack;
});

winston.configure({
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp(),
        myFormat
      )
    })
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
