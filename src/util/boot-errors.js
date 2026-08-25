// Boot-time database failures come in two kinds. Bugs — a migration with a
// typo, a schema from this build's future — must crash loudly: restarting
// cannot help, and the stack IS the diagnosis. Environmental failures — a
// full disk, a read-only or vanished volume, a damaged database file — are
// the opposite: the stack is noise ("disk I/O error", errcode 4874), and
// every supervisor around us (s6 in the docker image, the desktop launcher,
// systemd) answers a crash by restarting, turning the failure into an
// infinite banner-spamming boot loop with a dead port (the 2026-08-25
// disk-full incident, to the letter). classifyBootError() draws that line:
// a non-null result means "environmental — hold the boot, serve this
// diagnosis, retry"; null means "not ours to soften — crash as before".
// server.js owns the holding; this module owns the judgement and the words.
import fs from 'fs';
import path from 'path';

// SQLite primary result codes (the low byte of the extended code).
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_READONLY = 8;
const SQLITE_IOERR = 10;
const SQLITE_CORRUPT = 11;
const SQLITE_FULL = 13;
const SQLITE_CANTOPEN = 14;
const SQLITE_NOTADB = 26;

// SQLITE_IOERR_* subcode names (extended code >> 8) worth spelling out —
// "disk I/O error" alone sends the operator nowhere, but "SHMSIZE" is
// googlable and tells us exactly which syscall failed in a bug report.
const IOERR_SUBCODES = {
  1: 'READ', 2: 'SHORT_READ', 3: 'WRITE', 4: 'FSYNC', 5: 'DIR_FSYNC',
  6: 'TRUNCATE', 7: 'FSTAT', 13: 'ACCESS', 15: 'LOCK', 18: 'SHMOPEN',
  19: 'SHMSIZE', 20: 'SHMLOCK', 21: 'SHMMAP', 24: 'MMAP',
};

// Below this much free space, an SQLITE_IOERR at open is called a full disk
// outright: growing the WAL shared-memory file (32 KB) or replaying a WAL
// needs room, and "I/O error on a disk with 3 MB free" has exactly one
// realistic cause. Above it, the honest answer is the broader io-error text.
const LOW_DISK_BYTES = 64 * 1024 * 1024;

// Free space on the filesystem holding `dir`, or null when it can't be read:
// statfs is missing on some runtimes (older Bun builds), and the directory
// itself may be the thing that's broken. Enrichment only — never load-bearing.
export function freeSpace(dir) {
  try {
    const s = fs.statfsSync(dir);
    return {
      freeBytes: Number(s.bavail) * Number(s.bsize),
      totalBytes: Number(s.blocks) * Number(s.bsize),
    };
  } catch (_err) {
    return null;
  }
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) { return 'unknown'; }
  if (n >= 1024 ** 3) { return `${(n / 1024 ** 3).toFixed(1)} GB`; }
  if (n >= 1024 ** 2) { return `${(n / 1024 ** 2).toFixed(1)} MB`; }
  if (n >= 1024) { return `${Math.round(n / 1024)} KB`; }
  return `${n} B`;
}

// A diagnosis: { reason, headline, detail, hint }. `reason` is a stable
// machine token (tests, the X-MStream-Boot-Hold header); the three strings
// are operator-facing. `probe` is injectable so unit tests can dictate the
// free-space reading instead of inheriting the CI runner's disk.
export function classifyBootError(err, dbDirectory, probe = freeSpace) {
  if (!err) { return null; }
  const dbPath = path.join(dbDirectory || '.', 'mstream.db');
  const space = probe(dbDirectory);
  const spaceNote = space
    ? `${formatBytes(space.freeBytes)} free of ${formatBytes(space.totalBytes)}`
    : 'free space unreadable';

  const diskFull = (saidWhat) => ({
    reason: 'disk-full',
    headline: 'mStream cannot start: the disk holding its database is full.',
    detail: `${dbPath} — ${spaceNote}; ${saidWhat}`,
    hint: `Free up space on the volume that holds ${dbDirectory} (or grow it).`,
  });
  const unwritable = (saidWhat) => ({
    reason: 'db-unwritable',
    headline: 'mStream cannot start: it cannot write to its database.',
    detail: `${dbPath} — ${saidWhat}`,
    hint: `Check ownership and permissions on ${dbDirectory} — in docker, the PUID/PGID mapping of the config volume is the usual culprit; a volume mounted read-only is the other.`,
  });
  const missingDir = () => ({
    reason: 'db-missing-dir',
    headline: 'mStream cannot start: its database directory is missing.',
    detail: `${dbDirectory} does not exist.`,
    hint: 'If this directory lives on a mounted volume, the mount is gone — reattach it. Otherwise fix storage.dbDirectory in the config file.',
  });

  // node:sqlite tags errors with code ERR_SQLITE_ERROR and the extended
  // result code in `errcode`; the bun:sqlite adapter normalizes `code` the
  // same way but the number rides in bun's own `errno`.
  const sqliteCode = err.code === 'ERR_SQLITE_ERROR'
    ? (Number.isInteger(err.errcode) ? err.errcode : (Number.isInteger(err.errno) ? err.errno : null))
    : null;
  if (sqliteCode !== null) {
    const primary = sqliteCode & 0xff;
    const sub = sqliteCode >> 8;
    const saidWhat = `SQLite said: ${err.errstr || err.message} (code ${sqliteCode})`;

    switch (primary) {
      case SQLITE_FULL:
        return diskFull(saidWhat);
      case SQLITE_IOERR: {
        const subName = IOERR_SUBCODES[sub] ? `SQLITE_IOERR_${IOERR_SUBCODES[sub]}` : `SQLITE_IOERR subcode ${sub}`;
        if (space && space.freeBytes < LOW_DISK_BYTES) {
          return diskFull(`${saidWhat}, ${subName}`);
        }
        return {
          reason: 'db-io',
          headline: 'mStream cannot start: the disk or filesystem holding its database failed a low-level I/O operation.',
          detail: `${dbPath} — ${saidWhat}, ${subName}; ${spaceNote}`,
          hint: `This usually means a nearly-full disk, a failing drive, or a network/overlay filesystem that misbehaves under SQLite — check the volume that holds ${dbDirectory}.`,
        };
      }
      case SQLITE_BUSY:
      case SQLITE_LOCKED:
        return {
          reason: 'db-locked',
          headline: 'mStream cannot start: another process is holding its database.',
          detail: `${dbPath} — ${saidWhat}`,
          hint: `Is a second mStream instance (or a stuck scanner) pointed at the same database directory ${dbDirectory}?`,
        };
      case SQLITE_READONLY:
        return unwritable(saidWhat);
      case SQLITE_CANTOPEN:
        // The config layer normally creates the directory; reaching CANTOPEN
        // with the directory absent means it vanished after that — a volume
        // that came unmounted being the case worth naming.
        if (dbDirectory && !fs.existsSync(dbDirectory)) { return missingDir(); }
        return unwritable(saidWhat);
      case SQLITE_CORRUPT:
      case SQLITE_NOTADB:
        return {
          reason: 'db-damaged',
          headline: 'mStream cannot start: its database file is damaged.',
          detail: `${dbPath} — ${saidWhat}`,
          hint: `Restore ${dbPath} from a backup if you have one. Moving the file aside lets mStream start fresh and rebuild the library by scanning — but playlists, play history and shares live in that file and would be lost with it.`,
        };
      default:
        // Everything else — SQL logic errors, constraint violations, schema
        // mismatches — is a bug or an incompatibility, not an environment.
        return null;
    }
  }

  // Plain filesystem errors: the scanner-pidfile reap, or the sqlite driver
  // surfacing an open() failure as an fs error.
  switch (err.code) {
    case 'ENOSPC':
    case 'EDQUOT':
      return diskFull(`the filesystem said: ${err.message}`);
    case 'EROFS':
    case 'EACCES':
    case 'EPERM':
      return unwritable(err.message);
    case 'ENOENT':
      // Only when the database directory itself is gone: an ENOENT with the
      // directory intact is some other path — let it crash and be seen.
      if (dbDirectory && !fs.existsSync(dbDirectory)) { return missingDir(); }
      return null;
    case 'EMFILE':
    case 'ENFILE':
      return {
        reason: 'fs-limit',
        headline: 'mStream cannot start: the process ran out of open-file descriptors.',
        detail: err.message,
        hint: 'Raise the open-files limit for the mStream process (ulimit -n, or LimitNOFILE in a systemd unit).',
      };
    case 'EIO':
      return {
        reason: 'db-io',
        headline: 'mStream cannot start: the disk holding its database reported an I/O error.',
        detail: `${dbPath} — ${err.message}; ${spaceNote}`,
        hint: `Check the health of the volume that holds ${dbDirectory} — kernel logs (dmesg) usually name the device.`,
      };
    default:
      return null;
  }
}

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// The page a browser sees while the boot holds. Self-contained (no webapp
// assets — the app never mounted its static routes), self-refreshing (when a
// retry succeeds, the next refresh lands in the real app), and honest about
// what is wrong and what fixes it. API callers get JSON from the same 503
// handler; this is only the text/html arm.
export function renderHoldPage(diagnosis, { retrySeconds = 15 } = {}) {
  const d = diagnosis || {
    headline: 'mStream cannot start yet.',
    detail: '',
    hint: '',
  };
  // Refresh tracks the retry cadence but is clamped: never faster than 5s
  // (pointless 503 churn), never slower than 15s (after a fix lands, the
  // next refresh is what carries the user into the real app — a long retry
  // interval must not also mean a long stare at a stale error page).
  const refreshSeconds = Math.min(Math.max(Number(retrySeconds) || 15, 5), 15);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${refreshSeconds}">
<title>mStream — cannot start</title>
<style>
  body { margin: 0; padding: 3rem 1.5rem; background: #16181d; color: #e6e8eb;
         font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 44rem; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 1rem; color: #ff9f43; }
  .detail { background: #0d0f12; border: 1px solid #2a2e36; border-radius: 6px;
            padding: 0.9rem 1.1rem; white-space: pre-wrap; word-break: break-word;
            font-family: ui-monospace, Consolas, monospace; font-size: 0.85rem; color: #aeb4bd; }
  .hint { margin-top: 1.2rem; }
  .footer { margin-top: 2rem; font-size: 0.85rem; color: #7b8494; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(d.headline)}</h1>
<div class="detail">${escapeHtml(d.detail)}</div>
<p class="hint">${escapeHtml(d.hint)}</p>
<p class="footer">mStream retries automatically every ${Number(retrySeconds)}&thinsp;s and starts the moment the problem is fixed — this page refreshes itself.</p>
</main>
</body>
</html>
`;
}
