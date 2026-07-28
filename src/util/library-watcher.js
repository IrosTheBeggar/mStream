// Filesystem watcher → near-instant targeted scans.
//
// Watches each library root (chokidar) and maps change events to the
// EXISTING scan machinery — the watcher never touches the index itself,
// it only enqueues scans through the same task-queue dedup every other
// trigger uses. A missed or duplicated event can therefore never corrupt
// anything: worst case is a redundant subtree scan, or a delay until the
// scanInterval loop covers it. That loop stays untouched as the delivery
// mechanism for storage that emits no events (most CIFS/NFS mounts —
// the reason the watcher defaults OFF).
//
// Control loop (modeled on Navidrome's watcher):
//   event → relevance filter (scan-ignore rules + watched extensions)
//         → directory target (files map to their parent; deletions walk
//           UP to the nearest still-existing ancestor — you can't scan a
//           directory that's gone)
//         → per-vpath pending set, debounced until the library has been
//           QUIET for watcherWait seconds (a torrent writing 200 files
//           becomes one subtree scan)
//         → if a scan is already running, re-arm at 3× the wait instead
//           of enqueueing into the storm
//         → flush: nested targets collapse to their shallowest ancestor,
//           '' (library root) absorbs everything and becomes a full
//           vpath scan; everything else goes through addSubtreeScanTask,
//           whose scoped sweep (PR #757) makes deletions land too.
//
// The pure mapping/coalescing pieces are exported for unit tests; only
// startLibraryWatchers/stopLibraryWatchers touch chokidar or timers.

import path from 'path';
import fs from 'fs';
import chokidar from 'chokidar';
import winston from 'winston';
import * as config from '../state/config.js';
import { isIgnoredDirName, isIgnoredRelPath } from '../db/scan-ignore.js';

// Non-audio files whose changes still warrant a scan: folder art feeds
// album-art discovery, .lrc/.txt sidecars feed lyrics. False positives
// are cheap — a debounced subtree scan that fast-paths every unchanged
// file.
const EXTRA_WATCH_EXTS = new Set(['jpg', 'jpeg', 'png', 'lrc', 'txt']);

// Library-relative forward-slash path for an absolute event path, or
// null when the path escapes the root (defensive: chokidar shouldn't
// produce one). '' means the root itself.
export function relFromRoot(libraryRoot, absPath) {
  const rel = path.relative(libraryRoot, absPath);
  if (rel === '') { return ''; }
  if (rel.startsWith('..') || path.isAbsolute(rel)) { return null; }
  return rel.replace(/\\/g, '/');
}

// The directory a file event should scan: its parent ('' at root level).
export function parentRel(rel) {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}

// Walk a target up to the nearest ancestor that still exists as a
// directory ('' = library root, which the caller turns into a full
// scan). Deletion events point at paths that are already gone; the scan
// must root somewhere real so its scoped sweep covers the removed rows.
export function walkUpToExisting(libraryRoot, rel, isDirFn = defaultIsDir) {
  let cur = rel;
  while (cur !== '' && !isDirFn(path.join(libraryRoot, cur))) {
    cur = parentRel(cur);
  }
  return cur;
}

function defaultIsDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_e) { return false; }
}

// Should this event schedule a scan at all? Reuses the scanners' ignore
// predicate (hardcoded blocklist + the LIVE dot-entry flags — the admin
// toggles apply to the very next event) and, for files, the watched
// extension set: configured audio formats plus art/lyrics sidecars.
export function eventLooksRelevant(rel, isDirEvent, {
  supportedFiles = {}, ignoreDotFiles = false, ignoreDotFolders = false,
} = {}) {
  if (rel === null) { return false; }
  if (rel === '') { return true; }
  // For file events the last segment is a filename and isIgnoredRelPath's
  // semantics match exactly. For directory events, check the dir path's
  // segments under the FOLDER rule by probing it as "<rel>/x" so the
  // final segment is treated as a directory, not a filename.
  const probe = isDirEvent ? `${rel}/x` : rel;
  if (isIgnoredRelPath(probe, { ignoreDotFiles, ignoreDotFolders })) { return false; }
  if (isDirEvent) { return true; }
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) { return false; }
  const ext = name.slice(dot + 1).toLowerCase();
  return supportedFiles[ext] === true || EXTRA_WATCH_EXTS.has(ext);
}

// Minimal covering set of directory targets: '' absorbs everything;
// otherwise descendants of another member are dropped (segment-boundary
// safe, so 'sub' never absorbs 'subX'). Order: shallowest first for
// deterministic enqueueing.
export function collapseTargets(targets) {
  const list = [...targets];
  if (list.includes('')) { return ['']; }
  list.sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  const kept = [];
  for (const t of list) {
    if (!kept.some((k) => t === k || t.startsWith(`${k}/`))) { kept.push(t); }
  }
  return kept;
}

// Debounce-until-quiet coalescer. Every add() re-arms the timer, so a
// long busy burst (rsync, torrent) holds the flush off until the
// library settles for waitMs; an active scan re-arms at 3× instead of
// piling more scans behind it. Timers are unref'd — the watcher never
// keeps the server process alive on its own.
export class ScanCoalescer {
  constructor({ waitMs, isScanActive, enqueueFull, enqueueSubtree }) {
    this.waitMs = waitMs;
    this.isScanActive = isScanActive;
    this.enqueueFull = enqueueFull;
    this.enqueueSubtree = enqueueSubtree;
    this.pending = new Map(); // vpath -> Set(relDir)
    this.timer = null;
  }

  add(vpath, relDir) {
    let set = this.pending.get(vpath);
    if (!set) { set = new Set(); this.pending.set(vpath, set); }
    set.add(relDir);
    this.arm(this.waitMs);
  }

  arm(ms) {
    if (this.timer) { clearTimeout(this.timer); }
    this.timer = setTimeout(() => this.flush(), ms);
    if (this.timer.unref) { this.timer.unref(); }
  }

  flush() {
    this.timer = null;
    if (this.pending.size === 0) { return; }
    if (this.isScanActive()) {
      this.arm(this.waitMs * 3);
      return;
    }
    for (const [vpath, targets] of this.pending) {
      for (const target of collapseTargets(targets)) {
        if (target === '') { this.enqueueFull(vpath); }
        else { this.enqueueSubtree(vpath, target); }
      }
    }
    this.pending.clear();
  }

  stop() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.pending.clear();
  }
}

// ── chokidar lifecycle ─────────────────────────────────────────────────
// Module-level state, restart-idempotent like backupManager.init():
// startLibraryWatchers always tears down first, so boot, reboot(), and
// the admin toggle can all call it blindly.

let watchers = [];
let coalescer = null;

export function isRunning() {
  return watchers.length > 0;
}

// Per-event options come from live config so the admin dot-entry
// toggles apply to the very next event; injectable for tests that run
// without a booted config.
function defaultEventOpts() {
  return {
    supportedFiles: config.program.supportedAudioFiles,
    ignoreDotFiles: config.program.scanOptions.ignoreDotFiles === true,
    ignoreDotFolders: config.program.scanOptions.ignoreDotFolders === true,
  };
}

export function startLibraryWatchers({
  libraries, waitSeconds, isScanActive, enqueueFull, enqueueSubtree,
  getEventOpts = defaultEventOpts,
}) {
  stopLibraryWatchers();
  coalescer = new ScanCoalescer({
    waitMs: Math.max(1, waitSeconds) * 1000,
    isScanActive, enqueueFull, enqueueSubtree,
  });

  for (const lib of libraries) {
    // Long-form real path, not the configured string: on Windows a root
    // containing an 8.3 short name (RUNNER~1, PROGRA~1) trips a NATIVE
    // libuv assert in fs-event.c when events come back long-form —
    // aborting the whole server process, uncatchable from JS. realpath
    // (native) expands short names and resolves symlinks; fall back to
    // the raw path when it fails (root momentarily unavailable) and let
    // the error handler below report whatever chokidar hits.
    const name = lib.name;
    let root = lib.root_path;
    try { root = fs.realpathSync.native(root); } catch (_e) { /* keep raw */ }
    let watcher;
    try {
      watcher = chokidar.watch(root, {
        ignoreInitial: true,
        followSymlinks: lib.follow_symlinks === 1,
        // Don't fire while a file is still being written (torrents,
        // rsync): wait for 2s of size stability first.
        awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 },
        // Prune only the HARDCODED blocklist here (static — never
        // watch #recycle churn at all). The dot-entry rules are
        // config-live, so they filter per-event instead, where the
        // current flag values apply.
        ignored: (p) => {
          const rel = relFromRoot(root, p);
          if (rel === null || rel === '') { return false; }
          return rel.split('/').some((seg) => isIgnoredDirName(seg));
        },
      });
    } catch (err) {
      winston.warn(`Library watcher failed to start for '${name}': ${err.message}`);
      continue;
    }

    const onEvent = (isDirEvent, isDeletion) => (absPath) => {
      const rel = relFromRoot(root, absPath);
      if (!eventLooksRelevant(rel, isDirEvent, getEventOpts())) { return; }
      let target = isDirEvent ? rel : parentRel(rel);
      if (isDeletion) { target = walkUpToExisting(root, target); }
      coalescer.add(name, target);
    };

    watcher.on('add', onEvent(false, false));
    watcher.on('change', onEvent(false, false));
    watcher.on('unlink', onEvent(false, true));
    watcher.on('addDir', onEvent(true, false));
    watcher.on('unlinkDir', onEvent(true, true));
    // EMFILE/inotify-limit and permission errors land here; the watcher
    // degrades to "quiet" and the scanInterval loop still covers the
    // library. Warn so the operator can raise fs.inotify.max_user_watches
    // or exclude the library rather than wonder why events stopped.
    watcher.on('error', (err) => {
      winston.warn(`Library watcher error for '${name}': ${err.message}`);
    });

    watchers.push(watcher);
    winston.info(`Library watcher started for '${name}' (${root})`);
  }
}

export function stopLibraryWatchers() {
  for (const w of watchers) {
    try { w.close(); } catch (_e) { /* already dead */ }
  }
  if (watchers.length > 0) { winston.info('Library watchers stopped'); }
  watchers = [];
  if (coalescer) { coalescer.stop(); coalescer = null; }
}
