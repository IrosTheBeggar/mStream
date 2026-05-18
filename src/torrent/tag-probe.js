// Tier 3: partial-byte tag fetch. The "clever" tier.
//
// The pipeline so far (Tier 1 + Tier 2 in metadata.js) only inspects
// the .torrent file itself — name string + file list. Tier 3 goes
// further: it asks the daemon to download a tiny slice of one audio
// file, then reads that slice with music-metadata to extract real
// ID3/Vorbis/MP4 tags. Coverage jumps from ~80% (well-named) to
// ~95% (well-tagged).
//
// Lifecycle:
//   1. Add torrent to daemon paused, in a probe-specific subdir
//      under the verified vpath path
//   2. Set file priorities so only the target audio file downloads
//   3. Resume the torrent
//   4. Poll daemon until the target file has TAG_FETCH_BYTES on disk
//   5. Read the partial file from mStream's filesystem view
//   6. Parse tags via music-metadata
//   7. Remove the torrent (delete-local-data: true)
//   8. Return the parsed tags, OR null if any step failed
//
// The cleanup path (step 7) runs in a `finally` so timeouts /
// exceptions don't strand the daemon. Best-effort — if cleanup
// itself fails, the operator may need to manually remove a stray
// `.mstream-probe-XXX/` directory. Worth flagging as a known
// limitation; could be auto-cleaned at next boot via a sweep of
// daemon torrents matching our naming convention.

import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseFile } from 'music-metadata';

import * as transmissionRpc from './transmission-rpc.js';
import * as qbittorrentRpc from './qbittorrent-rpc.js';
import { infoHashFromMetainfo } from './info-hash.js';
import { CLIENT_TYPE } from './constants.js';

// How much of the audio file to wait for before reading. 256KB
// covers FLAC, Vorbis, Opus, leading-ID3v2 (~99% of audio in the
// wild). MP4 with trailing `moov` would need the file's tail too —
// we currently don't handle that and fall back gracefully (tags
// come back empty).
const TAG_FETCH_BYTES   = 256 * 1024;

// Poll cadence + timeout. 20s is generous for swarms with active
// seeders; tighter cadence wastes daemon RPC. With 800ms intervals
// we get ~25 polls before timeout.
const POLL_INTERVAL_MS  = 800;
const TIMEOUT_MS        = 20_000;

/**
 * Run the probe. Returns
 *   { ok: true,  metadata: {artist, album, year, …}, method: 'tag-fetch' }
 * on success, or
 *   { ok: false, reason: 'string' }
 * on every failure mode (no peers, missing file, untagged audio,
 * cleanup failure during success — caller can ignore the cleanup
 * branch). NEVER throws — the caller orchestrates fallback to Tier
 * 1+2 based on `ok`.
 */
export async function probeTags({
  metainfo,             // Buffer — the .torrent bytes
  clientType,           // 'transmission' | 'qbittorrent'
  creds,                // active-client creds object
  daemonVpathPath,      // verified daemon-side vpath path (from vpath-access cache)
  mstreamVpathPath,     // mStream-side library root for the same vpath
  topName,              // info.name (top-level dir for multi-file, file name for single-file)
  smallestAudio,        // { pathIndex, length, path: [...segments] } from analyseFileList
  isMultiFile,          // boolean — true if torrent has info.files (multi-file)
  fileCount,            // total file count in torrent (for priority array sizing)
}) {
  if (!metainfo || !smallestAudio || !daemonVpathPath || !mstreamVpathPath) {
    return { ok: false, reason: 'tag-probe: missing required arguments' };
  }

  // Sanity-check that we know what daemon we're talking to.
  const rpc = clientType === CLIENT_TYPE.TRANSMISSION ? transmissionRpc
            : clientType === CLIENT_TYPE.QBITTORRENT  ? qbittorrentRpc
            : null;
  if (!rpc) {
    return { ok: false, reason: `tag-probe: unsupported client ${clientType}` };
  }

  // Probe-specific subdir. UUID-random keeps concurrent probes from
  // colliding. We use info-hash + UUID so leftover dirs after a
  // crash can be linked back to a specific torrent for debugging.
  const { infoHash } = (() => {
    try { return infoHashFromMetainfo(metainfo); }
    catch (err) { return { infoHash: null }; }
  })();
  if (!infoHash) {
    return { ok: false, reason: 'tag-probe: invalid metainfo' };
  }
  const probeId  = `${infoHash.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
  const probeDir = `.mstream-probe-${probeId}`;

  const daemonDownloadDir = `${daemonVpathPath.replace(/\/+$/, '')}/${probeDir}`;

  // mStream's view of where the target file will land. Joined with
  // path.join so Windows back-slashes work. info.name is the
  // top-level wrapper for multi-file torrents; for single-file it
  // IS the filename, so don't double-prefix.
  const innerSegments = isMultiFile
    ? [topName, ...smallestAudio.path]
    : smallestAudio.path;
  const mstreamFilePath = path.join(mstreamVpathPath, probeDir, ...innerSegments);

  // `addedHash` is the hash WE added to the daemon and own cleanup
  // responsibility for. It stays null on the duplicate path so the
  // `finally` block doesn't accidentally remove the user's existing
  // torrent (and, with delete-local-data: true, wipe their files).
  // The duplicate-detection guard relies on this: assignment happens
  // AFTER the isDuplicate check, not before.
  let addedHash = null;
  try {
    // Step 1: add paused.
    const addResult = await rpc.addTorrent(creds, {
      metainfo,
      downloadDir: daemonDownloadDir,
      paused:      true,
    });
    if (addResult.isDuplicate) {
      // Torrent already exists in the daemon. We must NOT touch it
      // — that would disturb the user's pre-existing download.
      // Treat as inconclusive; caller falls back to Tier 1+2.
      // NOTE: addedHash stays null here, so the finally-block cleanup
      // is a no-op. This is the critical invariant.
      return { ok: false, reason: 'tag-probe: torrent already exists in daemon (probe skipped to avoid disturbing existing state)' };
    }
    // Only NOW do we record the hash for cleanup. Transmission
    // returns the hash; qBittorrent doesn't but we computed it
    // locally. Use whichever we have.
    addedHash = addResult.infoHash || infoHash;

    // Step 2: set file priorities. Skip everything except the target.
    await _setFilePriorities(rpc, creds, addedHash, smallestAudio.pathIndex, fileCount);

    // Step 3: resume.
    await _resume(rpc, creds, addedHash);

    // Step 4: poll for bytes.
    const waited = await _waitForFile(rpc, creds, addedHash, smallestAudio.pathIndex, TAG_FETCH_BYTES, TIMEOUT_MS);
    if (!waited.ok) { return { ok: false, reason: `tag-probe: ${waited.reason}` }; }

    // Step 5+6: read partial + parse tags. music-metadata handles
    // partial files reasonably for FLAC/Vorbis/Opus/ID3v2 (tags at
    // start of file); silently returns empty tags for MP4 with
    // trailing moov (rare for music torrents).
    let parsed;
    try {
      // duration: false skips the slower (decode-side) frame
      // counting we don't need
      parsed = await parseFile(mstreamFilePath, { duration: false });
    } catch (err) {
      return { ok: false, reason: `tag-probe: could not read tags at ${mstreamFilePath}: ${err.message}` };
    }

    const common = parsed?.common || {};
    const album       = (common.album    || '').toString().trim();
    const artist      = (common.albumartist || common.artist || '').toString().trim();
    const year        = common.year ? String(common.year) : '';
    const genre       = Array.isArray(common.genre) && common.genre.length ? String(common.genre[0]).trim() : '';
    const trackTotal  = common.track?.of || null;

    if (!album && !artist) {
      return { ok: false, reason: 'tag-probe: file had no usable album/artist tags' };
    }

    return {
      ok: true,
      metadata: { artist, album, year, genre, trackTotal },
      method:   'tag-fetch',
      tagFormat: parsed?.format?.tagTypes?.[0] || null,
    };
  } finally {
    // Step 7: always clean up. delete-local-data: true makes the
    // daemon remove the partial files alongside the torrent record.
    // Best effort — if the daemon is unreachable we leave the
    // probeDir on disk, log nothing (no logger threaded through),
    // and trust the operator to notice via the periodic
    // `.mstream-probe-*` listing.
    if (addedHash) {
      try { await _removeTorrent(rpc, creds, addedHash); }
      catch { /* swallow — caller already has its result */ }
    }
    // mStream-side cleanup of the probe dir if it still exists.
    // Daemons may not have removed it (qBittorrent's delete is
    // best-effort too).
    //
    // We `lstat` first and bail unless the entry is a real directory.
    // The probeDir name embeds an attacker-influenced 8-char info-hash
    // prefix (plus a UUID for collision avoidance). If a hostile user
    // with write access to the library managed to pre-create a
    // symlink at that path pointing elsewhere, `fs.rm` with
    // `force: true` would delete the symlink target's contents rather
    // than the probe dir. lstat sees the symlink itself; we refuse to
    // recurse through it. Belt-and-braces over the UUID's randomness.
    try {
      const probeFullPath = path.join(mstreamVpathPath, probeDir);
      const st = await fs.lstat(probeFullPath);
      if (st.isDirectory() && !st.isSymbolicLink()) {
        await fs.rm(probeFullPath, { recursive: true, force: false });
      }
    } catch { /* swallow — probe dir absent is the happy path */ }
  }
}

// ── Per-client helpers ───────────────────────────────────────────────
// These are intentionally not exported — Tier 3 is the only consumer.
// If/when a future feature needs e.g. "set priority on a torrent",
// promote them to transmission-rpc.js / qbittorrent-rpc.js then.

async function _setFilePriorities(rpc, creds, infoHash, targetIndex, fileCount) {
  if (rpc === transmissionRpc) {
    // Transmission accepts arrays of file indices. files-unwanted +
    // files-wanted is the canonical pair for "download only this one."
    const allOthers = [];
    for (let i = 0; i < fileCount; i++) { if (i !== targetIndex) { allOthers.push(i); } }
    await transmissionRpc.rpcCall(creds, 'torrent-set', {
      ids:             [infoHash],
      'files-wanted':  [targetIndex],
      'files-unwanted': allOthers,
      'priority-high': [targetIndex],
    });
    return;
  }
  // qBittorrent uses filePrio with id list separated by '|'.
  // priority 0 = skip, 7 = max.
  const allOtherIds = [];
  for (let i = 0; i < fileCount; i++) { if (i !== targetIndex) { allOtherIds.push(i); } }
  if (allOtherIds.length > 0) {
    // qBittorrent's filePrio is GET-style via query params on /api/v2/torrents/filePrio
    await qbittorrentRpc.qbittorrentFilePrio(creds, infoHash, allOtherIds, 0);
  }
  await qbittorrentRpc.qbittorrentFilePrio(creds, infoHash, [targetIndex], 7);
}

async function _resume(rpc, creds, infoHash) {
  if (rpc === transmissionRpc) {
    await transmissionRpc.rpcCall(creds, 'torrent-start', { ids: [infoHash] });
    return;
  }
  await qbittorrentRpc.qbittorrentResume(creds, infoHash);
}

async function _removeTorrent(rpc, creds, infoHash) {
  if (rpc === transmissionRpc) {
    await transmissionRpc.rpcCall(creds, 'torrent-remove', {
      ids: [infoHash],
      'delete-local-data': true,
    });
    return;
  }
  await qbittorrentRpc.qbittorrentDelete(creds, infoHash, true);
}

// Poll until the target file has reached `targetBytes` bytes-
// downloaded, or until timeout. Returns `{ok, reason?}`.
async function _waitForFile(rpc, creds, infoHash, fileIndex, targetBytes, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let bytes;
    try { bytes = await _getFileBytesCompleted(rpc, creds, infoHash, fileIndex); }
    catch (err) { return { ok: false, reason: `poll error: ${err.message}` }; }
    if (bytes >= targetBytes) { return { ok: true }; }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { ok: false, reason: `timed out after ${timeoutMs}ms waiting for ${targetBytes} bytes (peers may be unavailable)` };
}

async function _getFileBytesCompleted(rpc, creds, infoHash, fileIndex) {
  if (rpc === transmissionRpc) {
    // torrent-get with fileStats returns array of {bytesCompleted, wanted, priority}
    const r = await transmissionRpc.rpcCall(creds, 'torrent-get', {
      ids: [infoHash],
      fields: ['fileStats'],
    });
    const stats = r.torrents?.[0]?.fileStats?.[fileIndex];
    return stats?.bytesCompleted || 0;
  }
  // qBittorrent's torrents/files returns array of file objects with
  // size + progress (0..1). bytes-completed = size * progress.
  const files = await qbittorrentRpc.qbittorrentTorrentFiles(creds, infoHash);
  const f = files?.[fileIndex];
  if (!f) { return 0; }
  return Math.floor((f.size || 0) * (f.progress || 0));
}
