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

import Joi from 'joi';
import busboy from 'busboy';
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
  if (sub.startsWith('/'))       { return 'subPath cannot start with /'; }
  if (sub.split(/[\\/]/).some(s => s === '..')) { return 'subPath cannot contain ..'; }
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
        // Stop accumulating; let the request finish but don't keep
        // adding to the buffer. The 'end' event still fires when the
        // remaining body drains.
        stream.resume();
      });
      stream.on('end', () => {
        if (!fileTooLarge) { fileBuffer = Buffer.concat(chunks); }
      });
    });

    // partsLimit / filesLimit / fieldsLimit emit when those caps are
    // hit. Reject loudly rather than silently accept a truncated body.
    bb.on('partsLimit',  () => { fieldsTruncated = true; });
    bb.on('filesLimit',  () => { fileTooLarge    = true; });
    bb.on('fieldsLimit', () => { fieldsTruncated = true; });

    bb.on('close', () => {
      if (fileTooLarge) {
        // Defensive: by the time we reach 'close', we've already
        // emitted/absorbed the limit; destroying the request now is
        // a no-op but doesn't hurt.
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
    if (permErr) { return res.status(permErr.status).json(permErr); }

    let parsed;
    try { parsed = await _parseMultipart(req); }
    catch (err) { return res.status(err.status || 400).json(err); }
    const { fields, fileBuffer } = parsed;
    if (!fileBuffer) {
      return res.status(400).json({
        ok: false, error: 'no_source',
        message: 'Provide a .torrent file (auto-detect requires the metainfo to inspect)',
      });
    }

    let result;
    try { result = metadataLib.extractMetadata(fileBuffer); }
    catch (err) {
      return res.status(400).json({
        ok: false, error: 'invalid_torrent',
        message: err.message,
      });
    }

    // Strip internal-only fields before serialising. _smallestAudio
    // and _composeReason are consumed by Tier 3 / debug; the API
    // contract doesn't include them.
    const _smallestAudio = result._smallestAudio;
    const _composeReason = result._composeReason;
    delete result._smallestAudio;
    delete result._composeReason;

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
    if (wantsTier3 && vpathRaw) {
      const client = _resolveActiveClient();
      if (!client.error) {
        const access = vpathAccessCache.getOne(client.clientType, vpathRaw);
        const lib = db.getLibraryByName(vpathRaw);
        if (access && isUsable(access.confidence) && lib) {
          try {
            // info.name + multi-file flag both come from the bencode
            // parse — re-derive cheaply rather than threading them.
            const info = infoHashLib;  // unused; just keep symbol resolution
            const parsedInfo = (await import('../torrent/bencode.js')).findField(fileBuffer, 'info');
            const isMulti   = Array.isArray(parsedInfo.value?.files);
            const topName   = parsedInfo.value?.name
              ? Buffer.from(parsedInfo.value.name).toString('utf8')
              : '';
            const fileCount = isMulti ? parsedInfo.value.files.length : 1;
            const probe = await tagProbe.probeTags({
              metainfo:          fileBuffer,
              clientType:        client.clientType,
              creds:             client.creds,
              daemonVpathPath:   access.daemonPath,
              mstreamVpathPath:  lib.root_path,
              topName,
              smallestAudio:     _smallestAudio,
              isMultiFile:       isMulti,
              fileCount,
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
    if (permErr) { return res.status(permErr.status).json(permErr); }

    // Gate 2: active client has saved creds
    const client = _resolveActiveClient();
    if (client.error) {
      const status = client.error === 'client_disabled' ? 403 : 503;
      return res.status(status).json(client);
    }

    // Parse the multipart body (or throw 4xx)
    let parsed;
    try { parsed = await _parseMultipart(req); }
    catch (err) { return res.status(err.status || 400).json(err); }
    const { fields, fileBuffer } = parsed;

    // Gate 3: validate inputs
    const directoryName = (fields.directoryName || '').trim();
    const dirErr = _validateDirectoryName(directoryName);
    if (dirErr) { return res.status(400).json({ error: 'invalid_directory_name', message: dirErr }); }

    const subPath = (fields.subPath || '').trim();
    const subErr = _validateSubPath(subPath);
    if (subErr) { return res.status(400).json({ error: 'invalid_sub_path', message: subErr }); }

    const vpathName = (fields.vpath || '').trim();
    if (!vpathName) { return res.status(400).json({ error: 'missing_vpath', message: 'vpath is required' }); }

    // Gate 4: vpath access verification
    const access = vpathAccessCache.getOne(client.clientType, vpathName);
    if (!access) {
      return res.status(412).json({
        error: 'vpath_not_confirmed',
        message: `Path mapping for '${vpathName}' has not been probed yet for ${client.clientType}. An admin must run auto-detect on the Torrent admin page.`,
        vpath:  vpathName, clientType: client.clientType,
      });
    }
    if (!isUsable(access.confidence)) {
      return res.status(409).json({
        error: 'vpath_unusable',
        message: `'${vpathName}' is not reachable from ${client.clientType}: ${access.lastError || 'no candidate verified'}. An admin must set the mapping.`,
        vpath:  vpathName, clientType: client.clientType,
        lastError: access.lastError,
      });
    }

    // Gate 5: must have either a .torrent file OR a magnet
    const magnet = (fields.magnet || '').trim() || null;
    if (!fileBuffer && !magnet) {
      return res.status(400).json({ error: 'no_source', message: 'Provide either a .torrent file or a magnet URI' });
    }
    if (fileBuffer && magnet) {
      return res.status(400).json({ error: 'too_many_sources', message: 'Provide a .torrent file OR a magnet URI, not both' });
    }

    // Compute info hash + display name from the source. This step
    // also doubles as a sanity check — malformed input throws here
    // before we touch the daemon.
    let infoHash, torrentName;
    try {
      if (fileBuffer) {
        const r = infoHashLib.infoHashFromMetainfo(fileBuffer);
        infoHash    = r.infoHash;
        torrentName = r.name;
      } else {
        const r = infoHashLib.infoHashFromMagnet(magnet);
        infoHash    = r.infoHash;
        torrentName = r.name;
      }
    } catch (err) {
      return res.status(400).json({ error: 'invalid_source', message: err.message });
    }

    // Build daemon-side download dir.
    //   <verified daemon_path> / <subPath?> / <directoryName>
    // No leading-slash mistakes — daemon_path is absolute, subPath is
    // pre-validated to not start with /.
    const parts = [access.daemonPath.replace(/\/+$/, '')];
    if (subPath) { parts.push(subPath.replace(/\/+$/, '')); }
    parts.push(directoryName);
    const downloadPath = parts.filter(Boolean).join('/');

    // Hand to the client
    let addResult;
    try {
      addResult = await client.rpc.addTorrent(client.creds, {
        metainfo:    fileBuffer || undefined,
        magnet:      magnet     || undefined,
        downloadDir: downloadPath,
      });
    } catch (err) {
      return res.status(502).json({
        error: 'daemon_rejected',
        message: `${client.clientType} could not add the torrent: ${err.message}`,
      });
    }

    // Cross-check: if the daemon returned a hash (Transmission does),
    // it must match what we computed. A mismatch means we're talking
    // to a daemon-version mismatch or there's a bug in our hashing —
    // surface loudly rather than silently mismatching the
    // managed_torrents row.
    if (addResult.infoHash && addResult.infoHash !== infoHash) {
      return res.status(500).json({
        error: 'info_hash_mismatch',
        message: `client returned info hash ${addResult.infoHash} but mStream computed ${infoHash}`,
      });
    }

    // Insert managed_torrents row. INSERT OR REPLACE so a re-add of
    // the same torrent by the same user against the same client just
    // updates timestamps + path — saves a "is it already there?"
    // round-trip on the happy path.
    const finalName = addResult.name || torrentName || directoryName;
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

    res.json({
      ok:           true,
      infoHash,
      name:         finalName,
      clientType:   client.clientType,
      downloadPath,
      isDuplicate:  !!addResult.isDuplicate,
    });
  });
}
