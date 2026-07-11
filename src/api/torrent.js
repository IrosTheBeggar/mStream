// User-facing torrent endpoints.
//
//   POST /api/v1/torrent/add        — submit a torrent for the
//                                     authenticated user. Body is
//                                     multipart with either a
//                                     `torrentFile` upload OR a
//                                     `magnet` field, plus `vpath`,
//                                     optional `subPath`, and
//                                     `directoryName`.
//
//   GET  /api/v1/torrent/preflight  — read-only "should the UI even
//                                     enable the submit button?"
//                                     check. Tells the modal what
//                                     the active client is, whether
//                                     the operator's current
//                                     file-explorer vpath is
//                                     verified, and whether uploads
//                                     are server-wide-disabled.
//
// All gating happens here, not in the RPC layer. The RPC modules
// (transmission-rpc, qbittorrent-rpc) are protocol shims; the
// "is the user allowed to do this?" logic is here, near the auth
// middleware.

import busboy from 'busboy';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as vpathUtil from '../util/vpath.js';
import * as transmissionRpc from '../torrent/transmission-rpc.js';
import * as qbittorrentRpc from '../torrent/qbittorrent-rpc.js';
import * as delugeRpc       from '../torrent/deluge-rpc.js';
import * as infoHashLib from '../torrent/info-hash.js';
import * as metadataLib from '../torrent/metadata.js';
import * as tagProbe from '../torrent/tag-probe.js';
import * as vpathAccessCache from '../torrent/vpath-access-cache.js';
import * as pathTemplate from '../torrent/path-template.js';
import { processSeedExistingFlow } from '../torrent/seed-existing-flow.js';
import { _joinDaemonPath } from '../torrent/path-probe.js';
import { CLIENT_TYPE, ENABLED_FOR, isUsable, isClientActive } from '../torrent/constants.js';

// Hard cap on .torrent uploads. The cap matters for two routes that
// both consume metainfo blobs from untrusted clients:
//   POST /api/v1/torrent/add           — submits a torrent for download
//   POST /api/v1/torrent/auto-detect   — runs the metadata pipeline
// Both go through `_parseMultipart` below, so the constant is one
// place. Future torrent-file endpoints MUST go through the same
// helper, not roll their own multipart parser.
//
// Why 2 MB:
//   Typical music release  — 10-100 KB
//   Multi-disc lossless    — 100-500 KB
//   Large discography      — 500 KB - 2 MB
//   Pathological (Linux ISO collections with huge piece counts) — ~5 MB
// 2 MB covers 99%+ of legitimate use. Operators who hit the cap with
// a real torrent can request an increase via a feature flag, but the
// default is the strict floor.
//
// Why a small cap matters: busboy buffers the file in memory until
// the request finishes. Per-request memory cost is bounded by the
// cap × concurrent uploads; a 50 MB cap with 100 concurrent hostile
// clients eats 5 GB. 2 MB × 100 = 200 MB — uncomfortable but not
// fatal. Keep the cap small.
const TORRENT_FILE_MAX_BYTES = 2 * 1024 * 1024;

// Multipart-body shape limits applied alongside the file-size cap.
// Defends against multipart-abuse vectors that aren't covered by
// fileSize alone (e.g. an unbounded sequence of fields, a 1 GB
// fieldname, slowloris-style sequential parts).
const MULTIPART_LIMITS = Object.freeze({
  fileSize:      TORRENT_FILE_MAX_BYTES,
  files:         1,        // one .torrent at a time — no batch uploads
  parts:         16,       // .torrent file + a handful of fields + a margin
  fields:        16,       // vpath / subPath / directoryName / magnet + margin
  fieldSize:     8 * 1024, // magnet URIs are the largest field — bounded ≪ 8KB
  fieldNameSize: 100,
});

// Reject directory names that would let a request escape the vpath
// (path traversal) or create awkward filesystem entries. Keep it
// permissive enough that operators can use Unicode album names —
// just refuse the segment separators and control characters.
// Exported alongside _validateSubPath + _relativeFromRoot for the unit
// tests in test/torrent-routes.test.mjs — they verify that paths
// returned by /api/v1/torrent/seed-existing's partial_match outcome
// (UserSeedResult.matches[].relativePath, split client-side into
// subPath + directoryName) survive these validators. The contract
// matters because the sidebar's [Use this path] button feeds those
// values directly back into POST /api/v1/torrent/add.
export { _validateDirectoryName, _validateSubPath };
function _validateDirectoryName(name) {
  if (typeof name !== 'string') { return 'directoryName must be a string'; }
  const trimmed = name.trim();
  if (trimmed.length === 0)     { return 'directoryName is required'; }
  if (trimmed.length > 200)     { return 'directoryName is too long (max 200)'; }
  if (/[\/\\]/.test(trimmed))   { return 'directoryName cannot contain / or \\'; }
  if (trimmed === '.' || trimmed === '..') { return 'directoryName cannot be . or ..'; }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(trimmed)) { return 'directoryName cannot contain control characters'; }
  return null;
}

function _validateSubPath(sub) {
  if (sub == null || sub === '') { return null; }  // optional
  if (typeof sub !== 'string')   { return 'subPath must be a string'; }
  if (sub.length > 500)          { return 'subPath is too long (max 500)'; }
  // Absolute on POSIX (`/foo`) or current-drive on Windows (`\foo`).
  // Either form would root the constructed downloadPath outside the
  // verified daemon vpath, since we join the segments with '/'.
  if (sub.startsWith('/') || sub.startsWith('\\')) {
    return 'subPath cannot start with / or \\';
  }
  // Windows drive letters (`C:foo`, `C:/foo`) and UNC paths
  // (`//server/share`, `\\server\share`). On a Windows daemon these
  // would target wherever the colon/server points, sidestepping the
  // daemonPath prefix entirely.
  if (/^[a-zA-Z]:/.test(sub)) { return 'subPath cannot start with a drive letter'; }
  // Control characters, including NUL — NUL is particularly nasty
  // because some lower-level filesystem APIs truncate at the first
  // NUL, so `foo\0/../etc` becomes `foo` AFTER our `..` check.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(sub)) { return 'subPath cannot contain control characters'; }
  // Drive-letter or device-relative tricks inside segments
  // (`foo/C:bar`, segments named `..` after splitting on either
  // separator). Normalize separators first so we can do one walk.
  const segs = sub.split(/[\\/]/);
  for (const seg of segs) {
    if (seg === '..')               { return 'subPath cannot contain ..'; }
    if (/^[a-zA-Z]:/.test(seg))     { return 'subPath segment cannot start with a drive letter'; }
  }
  return null;
}

// Pull the active client + its creds, OR return a structured "not
// usable" sentinel that the caller can convert to an HTTP error. The
// add-torrent endpoint and preflight share this logic.
function _resolveActiveClient() {
  const t = config.program.torrent || {};
  if (!isClientActive(t.client)) {
    return { error: 'client_disabled', message: 'No torrent client is selected' };
  }
  const creds =
    t.client === CLIENT_TYPE.TRANSMISSION ? (t.transmission || {}) :
    t.client === CLIENT_TYPE.QBITTORRENT  ? (t.qbittorrent  || {}) :
    t.client === CLIENT_TYPE.DELUGE       ? (t.deluge       || {}) : null;
  if (!creds || !creds.host) {
    return { error: 'no_credentials', message: `No saved credentials for ${t.client}` };
  }
  const rpc = t.client === CLIENT_TYPE.TRANSMISSION ? transmissionRpc
            : t.client === CLIENT_TYPE.QBITTORRENT  ? qbittorrentRpc
            : delugeRpc;
  return { clientType: t.client, creds, rpc };
}

// Per-client "remove torrent + delete local data". Used when /add
// successfully handed the torrent to the daemon but then aborted on a
// post-add check (info-hash mismatch, managed_torrents write failure).
// We want the daemon state to match mStream's state, so we undo the
// daemon-side add. Best-effort: caller still surfaces the original
// failure, but we log here so an operator who sees a 5xx in the
// browser can correlate it with a daemon-side stranded torrent
// rather than discovering it later via the admin Torrents list.
async function _removeFromDaemon(client, infoHash, reason) {
  try {
    if (client.clientType === CLIENT_TYPE.TRANSMISSION) {
      await transmissionRpc.rpcCall(client.creds, 'torrent-remove', {
        ids: [infoHash],
        'delete-local-data': true,
      });
    } else if (client.clientType === CLIENT_TYPE.QBITTORRENT) {
      await qbittorrentRpc.qbittorrentDelete(client.creds, infoHash, true);
    } else if (client.clientType === CLIENT_TYPE.DELUGE) {
      await delugeRpc.delugeDelete(client.creds, infoHash, true);
    } else {
      throw new Error(`unknown client type ${client.clientType}`);
    }
  } catch (rmErr) {
    // Rollback failed. The daemon now has a stray torrent with no
    // managed_torrents row. Log loudly so the operator can clean up
    // via the admin Torrents list (it'll show as "external"). We
    // intentionally don't rethrow — the caller already has its own
    // error to report and we don't want to mask it.
    winston.warn(
      `[torrent] failed to roll back daemon add for ${infoHash} on ${client.clientType} after ${reason}: ${rmErr.message}. Torrent may be stranded in the daemon.`
    );
  }
}

// User-permission gate. Returns null when allowed, or an error
// descriptor when not.
function _checkUserPermissions(user) {
  const t = config.program.torrent || {};
  if (!isClientActive(t.client)) {
    return { status: 403, error: 'feature_disabled', message: 'Torrent feature is disabled' };
  }
  if (t.enabledFor === ENABLED_FOR.WHITELIST && user.allow_torrent !== 1) {
    return { status: 403, error: 'not_whitelisted', message: 'You are not on the torrent whitelist' };
  }
  return null;
}

// Uniform error-response shape across every torrent endpoint:
//   { ok: false, error: <stable-code>, message: <human-readable>, …extras }
// The UI consumers (m.js add panel, admin/index.js connect cards) already
// fall back through `body.message || body.error || err.message`, so this
// is backwards-compatible — but `ok: false` lets new client code branch
// cleanly without inspecting the status code.
function _err(res, status, error, message, extras) {
  return res.status(status).json({ ok: false, error, message, ...(extras || {}) });
}

// Parse multipart body. busboy events fire as the request streams;
// we accumulate fields + the (single) file buffer and resolve when
// the request finishes. Returns { fields, fileBuffer }.
//
// Defence-in-depth ordering:
//   1. Pre-flight Content-Length check — refuse obvious oversized
//      uploads before allocating any buffers (saves bandwidth and
//      memory; a hostile client claiming Content-Length: 1GB gets
//      dropped immediately).
//   2. busboy fileSize streaming check — catches clients that lie
//      about Content-Length and stream past the cap.
//   3. busboy parts/fields/fieldSize/fieldNameSize — bounds the
//      shape of the multipart body itself; prevents slowloris-style
//      sequential abuse.
// When the streaming check trips we destroy the request stream to
// drop the rest of the upload immediately rather than letting the
// client tie up a connection slot.
// Exported as `parseTorrentMultipart` (without the underscore prefix
// outsiders associate with "internal") so admin-torrent.js can reuse
// the same Content-Length precheck + busboy structural limits for
// its own multipart routes (seed-existing). Keeping a single helper
// avoids drift between the two routes' upload guards.
export { _parseMultipart as parseTorrentMultipart };
function _parseMultipart(req) {
  return new Promise((resolve, reject) => {
    // Step 1: Content-Length pre-check. Reject before reading bytes.
    // `content-length` is always set by well-formed multipart clients
    // (mStream's UI uses fetch with FormData, which sets it).
    // Absence or non-numeric value → reject conservatively. The cap
    // accounts for multipart envelope overhead (boundaries, headers
    // per part) — TORRENT_FILE_MAX_BYTES + ~10% leaves headroom.
    const contentLength = Number(req.headers['content-length']);
    const requestMax    = Math.floor(TORRENT_FILE_MAX_BYTES * 1.1) + 4096;
    if (!Number.isFinite(contentLength) || contentLength <= 0) {
      reject({ status: 411, error: 'length_required', message: 'Content-Length header is required for torrent uploads' });
      return;
    }
    if (contentLength > requestMax) {
      reject({ status: 413, error: 'file_too_large', message: `Request size ${contentLength} exceeds the ${requestMax}-byte limit for torrent uploads` });
      return;
    }

    let bb;
    try {
      bb = busboy({ headers: req.headers, limits: MULTIPART_LIMITS });
    } catch (err) {
      reject({ status: 400, error: 'multipart_error', message: err.message });
      return;
    }

    const fields = {};
    let fileBuffer = null;
    let fileTooLarge = false;
    let fieldsTruncated = false;

    bb.on('field', (name, value, info) => {
      // busboy sets info.valueTruncated when fieldSize cap is hit.
      // Treat as a hard fail — a torrent endpoint that needs an 8KB
      // magnet URI shouldn't tolerate fields silently truncated to
      // arbitrary lengths.
      if (info?.valueTruncated || info?.nameTruncated) { fieldsTruncated = true; }
      fields[name] = value;
    });

    bb.on('file', (name, stream) => {
      if (name !== 'torrentFile') {
        // Unknown file field — drain quickly and ignore.
        stream.resume();
        return;
      }
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('limit', () => {
        fileTooLarge = true;
        // Drop the connection immediately rather than letting a slow
        // client keep streaming bytes past the cap. The 'close'
        // handler below will see fileTooLarge and reject; destroying
        // req here just gets us off the wire promptly.
        try { req.destroy(); } catch { /* ignore */ }
      });
      stream.on('end', () => {
        if (!fileTooLarge) { fileBuffer = Buffer.concat(chunks); }
      });
    });

    // partsLimit / filesLimit / fieldsLimit emit when those caps are
    // hit. Reject loudly rather than silently accept a truncated body.
    // Same prompt-disconnect rationale as the 'limit' handler above.
    bb.on('partsLimit',  () => { fieldsTruncated = true; try { req.destroy(); } catch { /* ignore */ } });
    bb.on('filesLimit',  () => { fileTooLarge    = true; try { req.destroy(); } catch { /* ignore */ } });
    bb.on('fieldsLimit', () => { fieldsTruncated = true; try { req.destroy(); } catch { /* ignore */ } });

    bb.on('close', () => {
      if (fileTooLarge) {
        // The 'limit' handlers above already destroyed req. Re-call
        // is a no-op but doesn't hurt — defense in depth in case a
        // future code path reaches 'close' without going through one
        // of the limit events.
        try { req.destroy(); } catch { /* ignore */ }
        reject({
          status: 413, error: 'file_too_large',
          message: `Torrent file exceeds the ${TORRENT_FILE_MAX_BYTES}-byte limit`,
        });
        return;
      }
      if (fieldsTruncated) {
        reject({ status: 413, error: 'multipart_truncated', message: 'Multipart body exceeded structural limits (too many parts/fields, or a field is too large)' });
        return;
      }
      resolve({ fields, fileBuffer });
    });
    bb.on('error', err => reject({ status: 400, error: 'multipart_error', message: err.message }));
    req.pipe(bb);
  });
}

export function setup(mstream) {
  // ── Preflight — UI calls this when the upload modal opens so it
  // can decide whether to enable the Torrent tab's submit button.
  // Read-only; never mutates state. Takes ?path=<file-explorer-path>
  // (the existing vpath-relative path the player uses).
  mstream.get('/api/v1/torrent/preflight', (req, res) => {
    const t = config.program.torrent || {};
    const out = {
      active:           isClientActive(t.client),
      clientType:       t.client,
      displayName:      t.client === CLIENT_TYPE.TRANSMISSION ? 'Transmission'
                      : t.client === CLIENT_TYPE.QBITTORRENT  ? 'qBittorrent'
                      : t.client === CLIENT_TYPE.DELUGE       ? 'Deluge'
                      : null,
      noUpload:         !!config.program.noUpload,
      whitelistMode:    t.enabledFor === ENABLED_FOR.WHITELIST,
      userAllowed:      t.enabledFor === ENABLED_FOR.ALL || req.user.allow_torrent === 1,
      vpath:            null,
      subPath:          null,
      vpathConfirmed:   false,
      vpathConfidence:  null,
      daemonPath:       null,
      reason:           null,
    };

    // Resolve the vpath the operator is currently browsing. Empty/
    // missing path is the legitimate "no vpath context" state — the
    // form will just refuse to submit until they navigate somewhere.
    const rawPath = (req.query.path || '').toString().trim();
    if (rawPath) {
      try {
        const info = vpathUtil.getVPathInfo(rawPath, req.user);
        out.vpath   = info.vpath;
        out.subPath = info.relativePath || '';
      } catch (err) {
        out.reason = err.message;
        return res.json(out);
      }
    }
    if (!out.active)        { out.reason = 'No torrent client is selected'; return res.json(out); }
    if (out.noUpload)       { out.reason = 'Uploads are disabled server-wide'; return res.json(out); }
    if (!out.userAllowed)   { out.reason = 'You are not on the torrent whitelist'; return res.json(out); }
    if (!out.vpath)         { out.reason = 'No vpath in the current path';        return res.json(out); }

    const access = vpathAccessCache.getOne(t.client, out.vpath);
    if (!access) {
      out.reason = `Path mapping for '${out.vpath}' has not been probed yet for ${t.client}. An admin needs to run auto-detect.`;
      return res.json(out);
    }
    out.vpathConfidence = access.confidence;
    out.daemonPath      = access.daemonPath;
    if (!isUsable(access.confidence)) {
      out.reason = `Path mapping for '${out.vpath}' is not confirmed for ${t.client}. An admin needs to set it up.`;
      return res.json(out);
    }
    out.vpathConfirmed = true;
    return res.json(out);
  });

  // ── Path templates — return per-vpath template strings for the
  // libraries the authenticated user has access to. The player's
  // Add Torrent panel calls this once at init to pre-populate its
  // path field with a template-resolved value when the user selects
  // a vpath. Read-only; the admin GET/PUT lives on /api/v1/admin/
  // torrent/path-templates and is the only way to write a template.
  //
  // Response shape:
  //   {
  //     vpaths: { <vpath>: { template: <string|null> }, ... },
  //     supportedVars: [...],
  //     suggestedTemplate: '...',
  //   }
  //
  // No status code surprises: returns 200 with an empty vpaths object
  // when the user has access to no libraries. The torrent feature's
  // own gates (whitelist, client active, vpath confirmed) live on
  // /preflight; this endpoint only carries the template strings.
  mstream.get('/api/v1/torrent/path-templates', (req, res) => {
    const userVpaths = Array.isArray(req.user?.vpaths) ? req.user.vpaths : [];
    const libs = db.getAllLibraries().filter(l => userVpaths.includes(l.name));
    const vpaths = {};
    for (const lib of libs) {
      vpaths[lib.name] = { template: lib.torrent_path_template || null };
    }
    res.json({
      vpaths,
      supportedVars:     pathTemplate.SUPPORTED_VARS,
      suggestedTemplate: pathTemplate.SUGGESTED_TEMPLATE,
    });
  });

  // ── Add — the submit path. Multipart body, file or magnet, plus
  // vpath context. All gating happens up-front; the call to the
  // daemon's RPC is the last step so we don't add to the daemon and
  // THEN fail validation.
  // ── Auto-detect — try to derive metadata (artist / album / year)
  // from a torrent file. v1: server-side name-string parsing. Same
  // shape as `/add` for the multipart body so the UI can reuse the
  // same upload code path. Read-only — never persists state.
  //
  // The response is intentionally uniform regardless of which
  // extraction tier produced the result; the UI inspects
  // `confidence` to decide between silent fill, "best guess" warning,
  // and "couldn't detect" alert.
  //
  // Future tiers (file-list heuristics, partial-byte tag fetching,
  // MusicBrainz lookup, AcoustID) land in src/torrent/metadata.js's
  // extractMetadata pipeline; the route handler stays unchanged.
  mstream.post('/api/v1/torrent/auto-detect', async (req, res) => {
    // Same permission gates as /add — only users who could
    // *eventually* submit the torrent should be able to invoke the
    // server-side metadata pipeline (which may grow expensive when
    // tiers 3+ land).
    const permErr = _checkUserPermissions(req.user);
    if (permErr) { return _err(res, permErr.status, permErr.error, permErr.message); }

    let parsed;
    try { parsed = await _parseMultipart(req); }
    catch (err) { return _err(res, err.status || 400, err.error || 'multipart_error', err.message); }
    const { fields, fileBuffer } = parsed;
    if (!fileBuffer) {
      return _err(res, 400, 'no_source', 'Provide a .torrent file (auto-detect requires the metainfo to inspect)');
    }

    let result;
    try { result = metadataLib.extractMetadata(fileBuffer); }
    catch (err) {
      return _err(res, 400, 'invalid_torrent', err.message);
    }

    // Strip internal-only fields before serialising. _smallestAudio,
    // _composeReason, _topName, _isMultiFile are the Tier 3 / debug
    // handoff; the public API contract doesn't include them.
    const _smallestAudio = result._smallestAudio;
    const _topName       = result._topName;
    const _isMultiFile   = result._isMultiFile;
    delete result._smallestAudio;
    delete result._composeReason;
    delete result._topName;
    delete result._isMultiFile;

    // ── Tier 3: partial-byte tag fetch ─────────────────────────────
    // Run when Tier 1+2 didn't yield a 'high' result AND we have:
    //   - an audio file to target (smallestAudio)
    //   - a vpath context to download into
    //   - an active client with verified path access for that vpath
    //
    // Tier 3 is OPTIONAL — it elevates rather than gates. If any
    // precondition is missing, or if the probe fails (no peers,
    // untagged audio, etc.), we still return whatever Tier 1+2 had.
    const wantsTier3 = result.confidence !== 'high'
                    && _smallestAudio
                    && result.fileShape.hasAudio;
    const vpathRaw = (fields.vpath || '').trim();
    // Per-user vpath authorization: Tier 3 writes a probe directory
    // into the daemon's view of the vpath. A user who can't read the
    // vpath should not be able to drop bytes into it under the cover
    // of "auto-detect". Quietly skip Tier 3 (rather than 403) so the
    // rest of the pipeline still returns Tier 1+2 metadata — same
    // shape as every other Tier 3 precondition miss.
    const userVpaths = Array.isArray(req.user?.vpaths) ? req.user.vpaths : [];
    const vpathAuthorized = vpathRaw && userVpaths.includes(vpathRaw);
    if (wantsTier3 && vpathAuthorized) {
      const client = _resolveActiveClient();
      if (!client.error) {
        const access = vpathAccessCache.getOne(client.clientType, vpathRaw);
        const lib = db.getLibraryByName(vpathRaw);
        if (access && isUsable(access.confidence) && lib) {
          try {
            // Tier-3 inputs flow from extractMetadata's internal
            // handoff — _topName / _isMultiFile / fileShape.fileCount
            // — so we don't re-parse the same bencoded info dict here.
            const probe = await tagProbe.probeTags({
              metainfo:          fileBuffer,
              clientType:        client.clientType,
              creds:             client.creds,
              daemonVpathPath:   access.daemonPath,
              mstreamVpathPath:  lib.root_path,
              topName:           _topName,
              smallestAudio:     _smallestAudio,
              isMultiFile:       _isMultiFile,
              fileCount:         result.fileShape.fileCount,
            });
            if (probe.ok && (probe.metadata.album || probe.metadata.artist)) {
              // Tier 3 wins — its tags are authoritative. Promote
              // confidence to 'high' and stamp the method.
              result.metadata.artist = probe.metadata.artist || result.metadata.artist;
              result.metadata.album  = probe.metadata.album  || result.metadata.album;
              result.metadata.year   = probe.metadata.year   || result.metadata.year;
              if (probe.metadata.genre) { result.metadata.genre = probe.metadata.genre; }
              result.confidence = 'high';
              result.method     = `tag-fetch${probe.tagFormat ? ' (' + probe.tagFormat + ')' : ''}`;
              result.tier3      = { ok: true, format: probe.tagFormat };
            } else {
              // Probe didn't find tags or couldn't run — surface a
              // hint but keep Tier 1+2's result.
              result.tier3 = { ok: false, reason: probe.reason };
            }
          } catch (err) {
            // The probe is fire-and-forget for the response — if it
            // throws unexpectedly, log into the response body and
            // still return Tier 1+2.
            result.tier3 = { ok: false, reason: `tag-probe threw: ${err.message}` };
          }
        } else {
          result.tier3 = { ok: false, reason: 'vpath not confirmed for active client' };
        }
      } else {
        result.tier3 = { ok: false, reason: `active client unavailable: ${client.error}` };
      }
    }

    // Map the pipeline's confidence to the response's ok flag.
    if (result.confidence === 'none') {
      return res.json({
        ok:         false,
        error:      'insufficient_metadata',
        message:    `Couldn't extract reliable metadata from this torrent. You may need to fill the fields in manually.`,
        metadata:   result.metadata,
        confidence: result.confidence,
        method:     result.method,
        sourceName: result.sourceName,
        fileShape:  result.fileShape,
        tier3:      result.tier3,
      });
    }

    res.json({
      ok:         true,
      metadata:   result.metadata,
      confidence: result.confidence,
      method:     result.method,
      sourceName: result.sourceName,
      fileShape:  result.fileShape,
      tier3:      result.tier3,
    });
  });

  mstream.post('/api/v1/torrent/add', async (req, res) => {
    // Gate 1: user permissions
    const permErr = _checkUserPermissions(req.user);
    if (permErr) { return _err(res, permErr.status, permErr.error, permErr.message); }

    // Gate 2: active client has saved creds
    const client = _resolveActiveClient();
    if (client.error) {
      const status = client.error === 'client_disabled' ? 403 : 503;
      return _err(res, status, client.error, client.message);
    }

    // Parse the multipart body (or throw 4xx)
    let parsed;
    try { parsed = await _parseMultipart(req); }
    catch (err) { return _err(res, err.status || 400, err.error || 'multipart_error', err.message); }
    const { fields, fileBuffer } = parsed;

    // Gate 3: validate inputs
    const directoryName = (fields.directoryName || '').trim();
    const dirErr = _validateDirectoryName(directoryName);
    if (dirErr) { return _err(res, 400, 'invalid_directory_name', dirErr); }

    const subPath = (fields.subPath || '').trim();
    const subErr = _validateSubPath(subPath);
    if (subErr) { return _err(res, 400, 'invalid_sub_path', subErr); }

    const vpathName = (fields.vpath || '').trim();
    if (!vpathName) { return _err(res, 400, 'missing_vpath', 'vpath is required'); }

    // Gate 3.5: per-user vpath authorization. Without this, a torrent-
    // enabled user can target ANY vpath in the access cache — including
    // libraries they have no read access to — by sending an arbitrary
    // `vpath` field. We deliberately return the same shape as
    // vpath_not_confirmed/vpath_unusable so the UI does not leak which
    // names exist on the server (the UI itself should not even offer
    // those vpaths in the dropdown, but defense-in-depth here).
    const userVpaths = Array.isArray(req.user?.vpaths) ? req.user.vpaths : [];
    if (!userVpaths.includes(vpathName)) {
      return _err(res, 403, 'vpath_forbidden', `You do not have access to '${vpathName}'.`, { vpath: vpathName });
    }

    // Gate 4: vpath access verification
    const access = vpathAccessCache.getOne(client.clientType, vpathName);
    if (!access) {
      return _err(res, 412, 'vpath_not_confirmed',
        `Path mapping for '${vpathName}' has not been probed yet for ${client.clientType}. An admin must run auto-detect on the Torrent admin page.`,
        { vpath: vpathName, clientType: client.clientType });
    }
    if (!isUsable(access.confidence)) {
      return _err(res, 409, 'vpath_unusable',
        `'${vpathName}' is not reachable from ${client.clientType}: ${access.lastError || 'no candidate verified'}. An admin must set the mapping.`,
        { vpath: vpathName, clientType: client.clientType, lastError: access.lastError });
    }

    // Gate 5: must have either a .torrent file OR a magnet
    const magnet = (fields.magnet || '').trim() || null;
    if (!fileBuffer && !magnet) {
      return _err(res, 400, 'no_source', 'Provide either a .torrent file or a magnet URI');
    }
    if (fileBuffer && magnet) {
      return _err(res, 400, 'too_many_sources', 'Provide a .torrent file OR a magnet URI, not both');
    }

    // Compute info hash + display name from the source. This step
    // also doubles as a sanity check — malformed input throws here
    // before we touch the daemon.
    let infoHash, torrentName, isMultiFile;
    try {
      if (fileBuffer) {
        const r = infoHashLib.infoHashFromMetainfo(fileBuffer);
        infoHash    = r.infoHash;
        torrentName = r.name;
        isMultiFile = r.isMultiFile;
      } else {
        const r = infoHashLib.infoHashFromMagnet(magnet);
        infoHash    = r.infoHash;
        torrentName = r.name;
        // Magnets don't carry the file list — we don't know yet
        // whether the torrent is multi-file. The rename-root branch
        // below requires this signal, so magnets always fall through
        // to the legacy "wrap with directoryName" path. A future v2
        // could defer the rename via the completion-watcher once the
        // daemon has fetched metadata.
        isMultiFile = false;
      }
    } catch (err) {
      return _err(res, 400, 'invalid_source', err.message);
    }

    // Rename-root path: when the user opts in AND the torrent has its
    // own root folder (multi-file .torrent), we ask the daemon to put
    // the torrent's natural root inside the PARENT directory and then
    // rename that root to the user-supplied `directoryName`. Net result
    // on disk:
    //   pre  : <daemonPath>/<subPath>/<directoryName>/<info.name>/track*.flac
    //   post : <daemonPath>/<subPath>/<directoryName>/track*.flac
    // Skipped (legacy behaviour) when:
    //   - the user didn't tick the box (renameRoot=false)
    //   - this is a magnet (no info.name known yet — see above)
    //   - the torrent is single-file (no root folder to rename)
    //   - directoryName === torrentName (rename would be a no-op)
    //   - torrentName contains a path separator: BEP-3 says info.name
    //     SHOULD be a single segment, but malformed torrents can carry
    //     slashes. The three clients disagree on what `oldPath="a/b"`
    //     means (rename leaf vs flatten vs move), so the post-rename
    //     on-disk layout would be unpredictable — refuse rather than
    //     guess.
    const renameRoot = String(fields.renameRoot || '').toLowerCase() === 'true'
                    && !!fileBuffer
                    && isMultiFile
                    && !!torrentName
                    && torrentName !== directoryName
                    && !/[/\\]/.test(torrentName);

    // Build daemon-side download dir.
    //   <verified daemon_path> / <subPath?> / <directoryName>
    // No leading-slash mistakes — daemon_path is absolute, subPath is
    // pre-validated to not start with /. _joinDaemonPath normalises
    // separators so a native-Windows daemon root (`C:\Downloads`)
    // produces forward-slash output (`C:/Downloads/Album`) — accepted
    // natively by all three clients, and keeps mStream's own future
    // string compares (completion-watcher, managed_torrents lookups)
    // free of mixed-separator failure modes.
    //
    // When renameRoot is active, the daemon's downloadDir is the
    // PARENT (no directoryName segment) so the torrent's natural root
    // lands as a sibling of where we want it; the post-add rename
    // step then renames that root to directoryName. The persisted
    // managed_torrents.download_path tracks the ACTUAL on-disk
    // location — see the post-rename fallback below.
    const renamedPath     = _joinDaemonPath(access.daemonPath, subPath, directoryName);
    const unrenamedPath   = _joinDaemonPath(access.daemonPath, subPath, torrentName || directoryName);
    const daemonDir       = renameRoot ? _joinDaemonPath(access.daemonPath, subPath) : renamedPath;

    // Hand to the client. `paused: false` is passed explicitly so we
    // override whatever the daemon's session-level "add paused" default
    // is set to — an operator with start_added_torrents=false on
    // Transmission, or start_paused_enabled=true on qBittorrent, would
    // otherwise have user-submitted torrents silently start paused
    // with no UI hint. The RPC modules also default to false, but the
    // explicit flag at the call site documents the intent.
    let addResult;
    try {
      addResult = await client.rpc.addTorrent(client.creds, {
        metainfo:    fileBuffer || undefined,
        magnet:      magnet     || undefined,
        downloadDir: daemonDir,
        paused:      false,
      });
    } catch (err) {
      return _err(res, 502, 'daemon_rejected', `${client.clientType} could not add the torrent: ${err.message}`);
    }

    // Cross-check: if the daemon returned a hash (Transmission does),
    // it must match what we computed. A mismatch means we're talking
    // to a daemon-version mismatch or there's a bug in our hashing —
    // surface loudly rather than silently mismatching the
    // managed_torrents row.
    //
    // Done BEFORE the rename so we never key a rename call on a hash
    // the daemon doesn't recognise: in the (rare) event a coincidentally-
    // matching torrent already lives at our computed hash, the rename
    // would mutate someone else's torrent. Mismatch handling rolls
    // back the daemon's actually-accepted hash so neither torrent
    // gets touched by the rename below.
    //
    // Critical: the daemon already accepted the torrent at this point.
    // If we just 500-return, the torrent stays in the daemon with no
    // managed_torrents row, showing up as "external" in the admin
    // list and confusing future operators. _removeFromDaemon now logs
    // its own failure path via winston, so an op who hits this case
    // can correlate the 500 with a daemon-side stranded torrent. We
    // remove the hash the DAEMON claims it accepted (addResult.infoHash)
    // — that's the row actually present there; removing the hash WE
    // computed would be a no-op.
    if (addResult.infoHash && addResult.infoHash !== infoHash) {
      await _removeFromDaemon(client, addResult.infoHash, 'info-hash mismatch');
      return _err(res, 500, 'info_hash_mismatch',
        `client returned info hash ${addResult.infoHash} but mStream computed ${infoHash}`);
    }

    // Post-add rename-root step. Non-fatal: if the daemon refuses the
    // rename, the torrent is already downloading at <daemonDir>/
    // <torrentName> — we surface a warning AND fall the persisted
    // download_path back to the un-renamed location. Otherwise the
    // completion-watcher would scan the wrong subtree
    // (managed_torrents.download_path → _resolveSubtree in
    // completion-watcher.js) and the finished torrent's files would
    // never trigger a library re-scan. The user can rename manually
    // from their client if they care; the bookkeeping stays correct
    // regardless. Skipped entirely for duplicates: a duplicate add
    // means the torrent was already there before this request, with
    // its own existing on-disk layout; renaming would mutate state the
    // user didn't ask us to touch.
    let renameWarning = null;
    // Tri-state: true = ran and succeeded; false = ran and failed;
    // null = didn't run (no opt-in, duplicate, or other skip).
    let renameRan = null;
    if (renameRoot && !addResult.isDuplicate) {
      try {
        await client.rpc.renameFolder(client.creds, infoHash, torrentName, directoryName);
        renameRan = true;
      } catch (err) {
        renameRan = false;
        renameWarning = `Torrent added but root-folder rename failed: ${err.message}`;
        winston.warn(`[torrent] rename-root failed for ${infoHash}: ${err.message}`);
      }
    }

    // Source-of-truth path for managed_torrents. Cases:
    //   - renameRoot off / magnet / single-file: daemon wrote to
    //     <daemonPath>/<subPath>/<directoryName>; the daemon's own
    //     "wrap with downloadDir" behaviour put the files there.
    //   - rename ran and succeeded: same final location; rename moved
    //     <torrentName> → <directoryName> in-place.
    //   - rename ran and failed: daemon left files at
    //     <daemonPath>/<subPath>/<torrentName>; completion-watcher
    //     needs THAT path to find them.
    //   - rename skipped due to duplicate: the daemon's actual on-disk
    //     location is wherever the original add wrote — neither
    //     renamedPath nor unrenamedPath is necessarily accurate. Keep
    //     renamedPath here to match the legacy non-renameRoot behaviour
    //     for duplicates; revisiting duplicate-path accuracy is its
    //     own task.
    const downloadPath = (renameRan === false) ? unrenamedPath : renamedPath;

    // Insert managed_torrents row. INSERT OR REPLACE so a re-add of
    // the same torrent by the same user against the same client just
    // updates timestamps + path — saves a "is it already there?"
    // round-trip on the happy path.
    //
    // If this write throws (locked DB, disk full, schema mismatch),
    // the daemon already has the torrent but mStream won't have the
    // row tying it back to a user. Roll back the daemon side and
    // report a stable 500 — never leak the SQL error message to the
    // client (it'd surface Express's default error renderer with
    // implementation detail an attacker could fingerprint with).
    // `torrentName` (computed locally from the metainfo/magnet) is
    // authoritative — Transmission's addResult.name echoes back the
    // same value, and qBittorrent/Deluge always return empty. Drop
    // the addResult.name fallback as dead code; if the source had no
    // name (magnet with no dn=), fall through to the user-supplied
    // directoryName.
    const finalName = torrentName || directoryName;
    const hashWeOwn = addResult.infoHash || infoHash;
    try {
      db.getDB().prepare(`
        INSERT INTO managed_torrents (info_hash, client_type, user_id, vpath, added_at, download_path)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(info_hash, client_type) DO UPDATE SET
          user_id       = excluded.user_id,
          vpath         = excluded.vpath,
          added_at      = excluded.added_at,
          download_path = excluded.download_path
      `).run(
        infoHash,
        client.clientType,
        req.user.id,
        vpathName,
        Math.floor(Date.now() / 1000),
        downloadPath,
      );
    } catch (sqlErr) {
      winston.error(`[torrent] managed_torrents UPSERT failed for ${infoHash}: ${sqlErr.message}`);
      await _removeFromDaemon(client, hashWeOwn, 'managed_torrents write failed');
      return _err(res, 500, 'persistence_failed',
        'Torrent was rolled back: mStream could not record it. Check server logs.');
    }

    res.json({
      ok:           true,
      infoHash,
      name:         finalName,
      clientType:   client.clientType,
      downloadPath,
      isDuplicate:  !!addResult.isDuplicate,
      // Only present when the rename-root step ran and failed; lets
      // the UI surface a non-fatal toast without inventing a separate
      // status. Omitted (undefined) on the happy path so existing
      // clients that don't know about this field are unaffected.
      renameWarning: renameWarning || undefined,
    });
  });

  // ── Seed-existing — check whether the torrent's files already live
  // under one of the user's libraries, and (when every file matches)
  // hand the torrent to the daemon paused=false so it can recheck and
  // start seeding without re-downloading. The player's torrent tab
  // calls this BEFORE /add: a `seeded` outcome short-circuits the
  // normal download path entirely.
  //
  // Same multipart shape as /add minus directoryName/subPath/magnet —
  // a single `torrentFile` and an optional `vpaths` JSON array. We
  // intersect the requested vpath list with the caller's own vpath
  // access (req.user.vpaths) so a torrent-enabled user can't seed
  // into a library they're not allowed to see.
  //
  // Same outcome enum as /api/v1/admin/torrent/seed-existing (the
  // admin and user routes share the orchestrator). The admin route
  // exists for the operator's "import existing collection" panel; this
  // route is what the player UI uses as a pre-/add check.
  mstream.post('/api/v1/torrent/seed-existing', async (req, res) => {
    // Gate 1: whitelist + feature-enabled. This also enforces "client
    // is set"; without it _resolveActiveClient below would still trip,
    // but feature_disabled is the friendlier error for the player UI.
    const permErr = _checkUserPermissions(req.user);
    if (permErr) { return _err(res, permErr.status, permErr.error, permErr.message); }

    // Parse multipart up-front so we can inspect the vpaths field
    // and short-circuit the empty-scope case before resolving creds.
    let parsed;
    try { parsed = await _parseMultipart(req); }
    catch (err) { return _err(res, err.status || 400, err.error || 'multipart_error', err.message); }
    const { fields, fileBuffer } = parsed;
    if (!fileBuffer) {
      return _err(res, 400, 'no_source', 'Provide a .torrent file');
    }

    // Per-user vpath scoping. Without this, a torrent-whitelisted
    // user could probe libraries they don't have read access to —
    // the response would leak names + match counts. Intersect any
    // requested vpaths with the user's allowed set; default to the
    // full user-allowed set when the request didn't filter.
    const userVpaths = Array.isArray(req.user?.vpaths) ? req.user.vpaths : [];
    let requested = [];
    if (fields.vpaths) {
      try {
        const arr = JSON.parse(fields.vpaths);
        if (Array.isArray(arr)) {
          requested = arr.filter(v => typeof v === 'string' && v.length > 0);
        }
      } catch { /* fall through */ }
    }
    const vpathNames = requested.length === 0
      ? userVpaths.slice()
      : requested.filter(v => userVpaths.includes(v));

    if (vpathNames.length === 0) {
      // No libraries to check — equivalent to no_match without ever
      // touching the daemon. Returning the standard no_match shape
      // keeps the client's outcome-branch table the same shape as
      // every other case. Deliberately placed BEFORE _resolveActiveClient
      // so a user who's whitelisted but lacks any library access
      // doesn't get a misleading no_credentials/daemon error.
      return res.json({
        ok:            true,
        outcome:       'no_match',
        infoHash:      null,
        name:          null,
        checkedVpaths: [],
      });
    }

    const client = _resolveActiveClient();
    if (client.error) {
      const status = client.error === 'client_disabled' ? 403 : 503;
      return _err(res, status, client.error, client.message);
    }

    const raw = await processSeedExistingFlow({
      fileBuffer,
      vpathNames,
      clientType: client.clientType,
      active:     { creds: client.creds, module: client.rpc },
      userId:     req.user.id,
    });
    res.json(_sanitizeSeedExistingForUser(raw));
  });
}

// Strip information from a seed-existing flow result that the
// orchestrator produces unredacted for admin callers but must not
// reach a non-admin requester. Three concerns:
//
//   1. daemon_error.error — raw RPC error from the torrent client
//      (often contains internal hostnames, ports, daemon version
//      strings, filesystem paths). Replaced with a generic message.
//   2. *Root fields — absolute server filesystem paths
//      (vpathRoot, partialRoot, matchedRoot). The user already has
//      access to these libraries by virtue of req.user.vpaths, but
//      surfacing the absolute on-disk root reveals server layout
//      that's otherwise not exposed at this trust boundary. Replaced
//      with a vpath-relative `relativePath` for partial_match so the
//      UI can still surface a clickable "use this path" suggestion
//      without needing the absolute root.
//   3. addedAt — daemon-side download path; harmless on its own but
//      not useful to the player UI, so trimmed for consistency.
//
// All other fields (outcome, vpath, matched, total, missing, name,
// infoHash) are part of the documented contract and stay.
function _sanitizeSeedExistingForUser(body) {
  if (!body || !body.outcome) { return body; }
  const out = { ...body };
  switch (body.outcome) {
    case 'daemon_error':
      out.error = 'The torrent client could not add the file. Try again later or ask your admin to check the daemon.';
      delete out.vpathRoot;
      delete out.matchedRoot;
      break;
    case 'seeded':
      delete out.vpathRoot;
      delete out.matchedRoot;
      delete out.addedAt;
      break;
    case 'match_unmapped':
      // Same absolute-path concern as `seeded`. vpath and
      // mappingConfidence stay — the player UI uses them to tell the
      // user which library matched and that an admin needs to confirm
      // the path mapping before seeding can proceed.
      delete out.vpathRoot;
      delete out.matchedRoot;
      break;
    case 'partial_match':
      delete out.vpathRoot;
      delete out.partialRoot;
      // Replace each match's vpathRoot + partialRoot with a single
      // forward-slash-joined relativePath so the UI doesn't need to
      // know the server's absolute roots (and can't fingerprint OS
      // separators by inspecting them).
      out.matches = (body.matches || []).map(m => ({
        vpath:        m.vpath,
        relativePath: _relativeFromRoot(m.partialRoot, m.vpathRoot),
        matched:      m.matched,
        total:        m.total,
        missing:      m.missing,
      }));
      // Top-level back-compat: mirror the best match's relativePath
      // so older clients that read flat fields still see something
      // useful (and don't see a leftover partialRoot).
      if (out.matches[0]) {
        out.relativePath = out.matches[0].relativePath;
      }
      break;
    case 'invalid_torrent':
    case 'already_in_daemon':
    case 'no_match':
    default:
      // No sensitive fields to strip on these outcomes. invalid_torrent's
      // `error` is from our own bencode parser (caller-supplied input),
      // not from the daemon.
      break;
  }
  return out;
}

// Compute the vpath-relative form of an absolute path. Server might
// run on POSIX or Windows, and the two inputs can arrive with
// *different* separators — partialRoot is the output of `path.join`
// (uses the platform native separator, ie backslashes on Windows)
// while vpathRoot is whatever the operator typed into the library
// config (often forward slashes, even on Windows). Normalise both
// to forward slashes BEFORE comparing so the startsWith prefix-strip
// actually fires; otherwise the entire absolute path leaks back to
// the user (verified by release-smoke run).
//
// Exported with the underscore prefix for the unit test in
// test/torrent-routes.test.mjs — not part of the public API.
export function _relativeFromRoot(absPath, vpathRoot) {
  if (!absPath || !vpathRoot) { return ''; }
  const normAbs  = absPath.replace(/\\+/g, '/');
  const normRoot = vpathRoot.replace(/\\+/g, '/').replace(/\/+$/, '');
  let rel = normAbs;
  if (rel === normRoot) { return ''; }
  if (rel.startsWith(normRoot + '/')) {
    rel = rel.slice(normRoot.length);
  }
  return rel.replace(/^\/+/, '');
}
