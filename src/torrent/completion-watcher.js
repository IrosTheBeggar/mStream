// Periodically polls the active torrent client and, when a managed
// torrent transitions from `downloading` to `seeding`, kicks off a
// subtree scan of the directory the torrent landed in so its files
// land in the library index without waiting for the next scheduled
// full scan.
//
// Why polling instead of a webhook: none of the three clients
// (Transmission, qBittorrent, Deluge) ship a completion webhook in
// their core RPC. Transmission has script-on-done but it's a daemon-
// side hook that wouldn't reach mStream. qBittorrent has `Run external
// program on torrent completion` but configuring it requires touching
// the daemon's UI, which is the friction we're trying to avoid. So we
// poll.
//
// The watcher is cheap: it only runs while at least one managed
// torrent is non-seeding, the poll interval is conservative (default
// 30 s), and per-(client, info_hash) prior-status state is held in
// memory so we only fire scans on the actual transition edge, not on
// every poll where a torrent is already seeding.
//
// Threading: a single setInterval drives everything. Calls into the
// RPC modules are already async + bounded by their own AbortSignal
// timeout, so a slow daemon can't pile up overlapping ticks (a tick
// that takes longer than the interval just means the next tick fires
// late — we never have two ticks racing the same Map writes).

import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as dbQueue from '../db/task-queue.js';
import * as managedTorrents from './managed-torrents.js';
import * as vpathAccessCache from './vpath-access-cache.js';
import * as transmissionRpc from './transmission-rpc.js';
import * as qbittorrentRpc from './qbittorrent-rpc.js';
import * as delugeRpc from './deluge-rpc.js';
import { CLIENT_TYPE, STATUS, isClientActive } from './constants.js';

// Conservative default — 30 s is fast enough that a typical user
// notices their album appearing "shortly after the torrent finishes"
// rather than "on the next library scan." A daemon can usually handle
// /list calls every few seconds, so this is well within budget.
const DEFAULT_POLL_INTERVAL_MS = 30_000;

// Per-(client, info_hash) last-known status. Cleared on watcher stop
// so a fresh start doesn't see a stale "was downloading, now seeding"
// edge that already triggered a scan in a prior process.
const _priorStatus = new Map();

// setInterval handle so the watcher can be stopped (used by tests
// + the graceful-shutdown path).
let _timer = null;

function _cacheKey(client, hash) { return `${client}:${hash}`; }

// Translate a daemon-side download path into a vpath-relative path
// suitable for dbQueue.scanSubtree. The vpath-access cache holds the
// (daemonPath ↔ mstream library root) mapping; we strip the daemon
// prefix and what's left is the relative subtree.
//
// Returns `{vpath, relPath}` on success or `null` if the daemon path
// doesn't sit under the cached daemonPath for any known vpath (which
// can happen if an admin changed the mapping after a torrent was added).
function _resolveSubtree(clientType, vpath, daemonDownloadPath) {
  if (!vpath || !daemonDownloadPath) { return null; }
  const access = vpathAccessCache.getOne(clientType, vpath);
  if (!access || !access.daemonPath) { return null; }
  // Normalise trailing slash on the cached daemonPath so the prefix
  // compare doesn't fail because one ends with / and the other doesn't.
  const root = access.daemonPath.replace(/[/\\]+$/, '');
  // download_path is daemon-side; both / and \ separators are possible
  // depending on the daemon host's OS. Normalise both to / for compare.
  const dl = daemonDownloadPath.replace(/\\/g, '/').replace(/[/\\]+$/, '');
  if (!dl.startsWith(root + '/') && dl !== root) {
    return null;
  }
  const rel = dl === root ? '' : dl.slice(root.length + 1);
  return { vpath, relPath: rel };
}

// Map an RPC module's listTorrents() result to a flat array of
// {infoHash, status, name}. The three RPC modules already normalise
// status to the STATUS enum so this is just selecting fields.
function _flattenList(list) {
  return (list || []).map(t => ({
    infoHash: (t.infoHash || '').toLowerCase(),
    status:   t.status,
    name:     t.name || '',
  }));
}

async function _tick() {
  const clientType = config.program?.torrent?.client;
  if (!isClientActive(clientType)) { return; }
  const t = config.program.torrent || {};
  const creds =
    clientType === CLIENT_TYPE.TRANSMISSION ? (t.transmission || {}) :
    clientType === CLIENT_TYPE.QBITTORRENT  ? (t.qbittorrent  || {}) :
    clientType === CLIENT_TYPE.DELUGE       ? (t.deluge       || {}) : null;
  if (!creds || !creds.host) { return; }
  const rpc =
    clientType === CLIENT_TYPE.TRANSMISSION ? transmissionRpc :
    clientType === CLIENT_TYPE.QBITTORRENT  ? qbittorrentRpc  :
    clientType === CLIENT_TYPE.DELUGE       ? delugeRpc       : null;
  if (!rpc) { return; }

  let list;
  try { list = _flattenList(await rpc.listTorrents(creds)); }
  catch (err) {
    // Daemon offline / network blip — silently skip this tick. Don't
    // clear _priorStatus: a recovered daemon should pick up where we
    // left off, not re-fire every transition we already handled.
    return;
  }
  if (list.length === 0) { return; }

  // Pull the managed_torrents rows for everything we just listed; we
  // only fire scans for torrents mStream owns (avoid surprising the
  // operator with library writes triggered by daemon-side torrents
  // they added directly).
  const hashes = list.map(t => t.infoHash).filter(Boolean);
  const owned = managedTorrents.getByHashes(hashes, clientType);

  for (const t of list) {
    if (!t.infoHash || !owned.has(t.infoHash)) {
      // Not managed by mStream → ignore for autosc rescan purposes.
      // We DO still cache its status so a later admin "claim this
      // torrent" feature could see prior state, but for the v1 watcher
      // we don't even bother.
      continue;
    }
    const key = _cacheKey(clientType, t.infoHash);
    const prior = _priorStatus.get(key);
    _priorStatus.set(key, t.status);

    // The trigger condition: prior status was a non-complete state
    // and the current status is seeding. We accept downloading,
    // queued, verifying as "non-complete" — any of those flipping
    // to seeding means the daemon finished writing files. The
    // `prior == null` case (first time we see this torrent) is
    // skipped: we have no edge to detect on, and re-scanning every
    // torrent on watcher boot would defeat the point of the watcher.
    const wasIncomplete = prior === STATUS.DOWNLOADING ||
                          prior === STATUS.QUEUED ||
                          prior === STATUS.VERIFYING;
    if (!wasIncomplete || t.status !== STATUS.SEEDING) { continue; }

    // Resolve the managed row to find vpath + download_path.
    const row = managedTorrents.getByInfoHash(t.infoHash);
    if (!row) { continue; }  // race with delete; nothing to do
    const target = _resolveSubtree(clientType, row.vpath, row.downloadPath);
    if (!target) {
      winston.warn(`[torrent] completion-watcher: '${t.name}' (${t.infoHash.slice(0,8)}) finished but couldn't resolve a scan target (vpath='${row.vpath}', download_path='${row.downloadPath}'). Skipping subtree scan.`);
      continue;
    }
    if (target.relPath === '') {
      // Daemon dumped the files at the vpath root rather than into a
      // subdirectory. Trigger a full vpath scan instead — narrower
      // would miss the new files.
      winston.info(`[torrent] completion-watcher: '${t.name}' finished at vpath root '${target.vpath}'; queueing full scan.`);
      dbQueue.scanVPath(target.vpath);
    } else {
      winston.info(`[torrent] completion-watcher: '${t.name}' finished — queueing subtree scan of '${target.vpath}/${target.relPath}'.`);
      dbQueue.scanSubtree(target.vpath, target.relPath);
    }
  }
}

/**
 * Start the periodic poll loop. No-op if already running. Safe to
 * call multiple times — the second + subsequent calls return the
 * existing timer handle.
 */
export function start(intervalMs = DEFAULT_POLL_INTERVAL_MS) {
  if (_timer) { return _timer; }
  _timer = setInterval(() => {
    _tick().catch(err => {
      winston.warn(`[torrent] completion-watcher tick failed: ${err.message}`);
    });
  }, intervalMs);
  // Don't keep the event loop alive just for this — if mStream is
  // otherwise idle, Node should still be able to exit gracefully on
  // SIGTERM.
  if (typeof _timer.unref === 'function') { _timer.unref(); }
  winston.info(`[torrent] completion-watcher started (poll every ${intervalMs}ms)`);
  return _timer;
}

/** Stop the watcher and clear the prior-status cache. */
export function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _priorStatus.clear();
}

// Test helpers — not part of the public API. Exported for the unit
// tests so they can drive a single tick without waiting for the
// interval, and inspect the prior-status cache. Underscore prefix
// signals "internal" to anyone reading the imports.
export const _internal = {
  tick:         _tick,
  priorStatus:  _priorStatus,
  resolveSubtree: _resolveSubtree,
};
