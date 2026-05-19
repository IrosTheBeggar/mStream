// Orchestrator for the seed-existing flow. Wraps the pure
// `checkFilesExist` primitive + the daemon's addTorrent + the
// managed_torrents row write so both routes that expose this feature
// (the admin `/api/v1/admin/torrent/seed-existing` panel and the
// user-facing `/api/v1/torrent/seed-existing` from the player's
// torrent tab) get identical semantics.
//
// The route handlers are still responsible for:
//   - auth / permission gates
//   - parsing the multipart body
//   - choosing the default vpathNames when the caller didn't filter
// This module's only job is "given the bytes + a candidate vpath
// list, produce one of the outcome shapes."

import winston from 'winston';
import * as db from '../db/manager.js';
import * as vpathAccessCache from './vpath-access-cache.js';
import * as infoHashLib from './info-hash.js';
import * as seedExisting from './seed-existing.js';
import { isUsable } from './constants.js';

export const SEED_OUTCOMES = Object.freeze({
  SEEDED:            'seeded',
  PARTIAL_MATCH:     'partial_match',
  NO_MATCH:          'no_match',
  ALREADY_IN_DAEMON: 'already_in_daemon',
  INVALID_TORRENT:   'invalid_torrent',
  DAEMON_ERROR:      'daemon_error',
});

/**
 * Execute the seed-existing flow for a single .torrent upload.
 *
 * Side effects when allMatch: calls `active.module.addTorrent` and
 * inserts/upserts a `managed_torrents` row. Callers should pass the
 * user_id that owns the resulting row.
 *
 * @param {object} opts
 * @param {Buffer} opts.fileBuffer  Raw .torrent bytes.
 * @param {string[]} opts.vpathNames Vpaths to probe, in priority order.
 *                                    Caller is responsible for any
 *                                    permission-based filtering before
 *                                    handing the list to us.
 * @param {string} opts.clientType  Active torrent client type.
 * @param {object} opts.active      `{ creds, module }` — both the
 *                                    credentials block and the RPC
 *                                    module are passed in so the
 *                                    flow doesn't reach back into
 *                                    `config` (admin/user routes
 *                                    resolve this differently).
 * @param {number} opts.userId      Owner of the resulting
 *                                    managed_torrents row.
 * @returns {Promise<object>} Response body (JSON-serialisable).
 *   Always includes `ok: true` and one of the `SEED_OUTCOMES` values.
 *   `partial_match` returns a `matches[]` array with one entry per
 *   vpath that had >0 matched files; top-level keys mirror matches[0]
 *   for backward compatibility with older admin consumers.
 */
export async function processSeedExistingFlow(opts) {
  const { fileBuffer, vpathNames, clientType, active, userId } = opts;

  // Step 1 — info-hash + display name. `invalid_torrent` is a normal
  // outcome we hand back as a 200; the UI table renders it as a row.
  let infoHash, displayName;
  try {
    const r = infoHashLib.infoHashFromMetainfo(fileBuffer);
    infoHash    = r.infoHash;
    displayName = r.name;
  } catch (err) {
    return {
      ok:       true,
      outcome:  SEED_OUTCOMES.INVALID_TORRENT,
      infoHash: null,
      name:     null,
      error:    err.message,
    };
  }

  // Step 2 — daemon-side dedup. One cheap RPC. Failure is non-fatal:
  // we let the addTorrent below surface as daemon_error if it really
  // is unreachable.
  try {
    const list = await active.module.listTorrents(active.creds);
    const hit = (list || []).find(t => (t.infoHash || '').toLowerCase() === infoHash);
    if (hit) {
      return {
        ok:       true,
        outcome:  SEED_OUTCOMES.ALREADY_IN_DAEMON,
        infoHash,
        name:     displayName,
      };
    }
  } catch { /* fall through */ }

  // Step 3 — probe vpaths. First all-match wins and triggers the
  // daemon add; otherwise we collect EVERY partial hit (matched > 0)
  // and return them as `matches[]` so the UI can render one row
  // per library. The vpath order is preserved.
  const partials = [];
  for (const vp of vpathNames) {
    const lib = db.getLibraryByName(vp);
    if (!lib) { continue; }
    const access = vpathAccessCache.getOne(clientType, vp);
    if (!access || !isUsable(access.confidence)) { continue; }

    let result;
    try { result = await seedExisting.checkFilesExist(fileBuffer, lib.root_path); }
    catch { continue; }

    if (result.allMatch) {
      const daemonDownloadDir = access.daemonPath.replace(/\/+$/, '');
      try {
        await active.module.addTorrent(active.creds, {
          metainfo:    fileBuffer,
          downloadDir: daemonDownloadDir,
          paused:      false,
        });
      } catch (err) {
        return {
          ok:          true,
          outcome:     SEED_OUTCOMES.DAEMON_ERROR,
          infoHash,
          name:        displayName,
          vpath:       vp,
          vpathRoot:   lib.root_path,
          matchedRoot: result.matchedRoot,
          error:       err.message,
        };
      }
      const dlPath = result.topName
        ? `${daemonDownloadDir}/${result.topName}`
        : daemonDownloadDir;
      try {
        db.getDB().prepare(`
          INSERT INTO managed_torrents (info_hash, client_type, user_id, vpath, added_at, download_path)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(info_hash, client_type) DO UPDATE SET
            user_id       = excluded.user_id,
            vpath         = excluded.vpath,
            added_at      = excluded.added_at,
            download_path = excluded.download_path
        `).run(infoHash, clientType, userId, vp, Math.floor(Date.now() / 1000), dlPath);
      } catch (sqlErr) {
        // Daemon already owns it — log + continue. Same trade-off as
        // /torrent/add: the user's intent (seed) succeeded; the row
        // can be rebuilt by a future scan if needed.
        winston.warn(`[seed-existing] managed_torrents UPSERT failed for ${infoHash}: ${sqlErr.message}`);
      }
      return {
        ok:          true,
        outcome:     SEED_OUTCOMES.SEEDED,
        infoHash,
        name:        displayName,
        vpath:       vp,
        vpathRoot:   lib.root_path,
        matchedRoot: result.matchedRoot,
        addedAt:     dlPath,
      };
    }

    if (result.matched > 0) {
      partials.push({
        vpath:       vp,
        vpathRoot:   lib.root_path,
        partialRoot: result.partialRoot,
        matched:     result.matched,
        total:       result.total,
        missing:     result.missing,
      });
    }
  }

  if (partials.length > 0) {
    // Sort by matched-ratio descending so the highest-quality match
    // is matches[0] (and mirrors into the back-compat top-level keys).
    partials.sort((a, b) => (b.matched / b.total) - (a.matched / a.total));
    const best = partials[0];
    return {
      ok:           true,
      outcome:      SEED_OUTCOMES.PARTIAL_MATCH,
      infoHash,
      name:         displayName,
      matches:      partials,
      // Backward-compat: existing admin-UI consumers read these flat
      // fields. New consumers should prefer `matches[]`.
      vpath:        best.vpath,
      vpathRoot:    best.vpathRoot,
      partialRoot:  best.partialRoot,
      matched:      best.matched,
      total:        best.total,
      missing:      best.missing,
      checkedVpaths: vpathNames,
    };
  }

  return {
    ok:            true,
    outcome:       SEED_OUTCOMES.NO_MATCH,
    infoHash,
    name:          displayName,
    checkedVpaths: vpathNames,
  };
}
