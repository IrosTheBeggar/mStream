// GET /api/ — the layered server-info endpoint.
//
// One endpoint, three layers, built ADDITIVELY (base → +user → +admin).
// Never build this response by filtering a full object down: an additive
// bug omits a field, a filtering bug discloses everything.
//
//   Base (always): `apiVersions` + `features` — server-wide capability
//     facts (see buildFeatures). `server` (the version) is included ONLY
//     when the request carries no credentials at all: the anonymous
//     probe surface ("is this an mStream server, which version") is the
//     one place a client needs it, and an authenticated session doesn't
//     re-learn its server's version on every call. This layer is
//     deliberately public and must stay allocation-cheap: config reads
//     and the guarded one-row discovery probe, nothing an anonymous
//     caller can use to make the server do work. Rule for what may
//     appear here: config/capability facts only — no counts, no
//     library or content names, no identity.
//
//   Layer 2 (valid JWT, public-access mode, jukebox session, or a
//   federation key): adds `user` — identity plus the CALLER-SCOPED boot
//   payload (vpaths, permission flags, federationDiscovery,
//   vpathMetaData). Server-wide capabilities live in `features`, not
//   here; ping's frozen contract still carries both halves flat (see
//   buildClientBootPayload).
//
//   Layer 3 (admin only — never federation, never jukebox): adds `admin`
//   — cheap support/debug facts. Mostly a framework hook today.
//
// Auth contract: a request with NO credentials gets the base (with
// `server`); a request with PRESENT-but-invalid credentials gets 401
// (403 for a federation key off its allowlist) — a bad token is an error
// the client must see, never a silent downgrade to the public layer (a
// webapp with an expired cookie needs the 401 to know to re-login).
// Share tokens get the base layer, without `server` (they are presented
// credentials, just not a session). A federated client that wants the
// version probes WITHOUT its key header — the anonymous base — and sends
// the key when it wants its scoped view.
//
// Mounted BEFORE the auth wall (see server.js) so it owns its auth via
// resolveOptionalUser(); /api/v1/ping stays behind the wall unchanged and
// composes its frozen flat payload from the two builders below — one
// source of truth, zero drift between the two routes. Ping is deprecated
// in favor of this endpoint but kept indefinitely: older mobile clients,
// CI liveness probes, and the torrent/velvet webapps still call it.

import packageJson from '../../package.json' with { type: 'json' };
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as fedDb from '../db/federation.js';
import * as sim from '../db/discovery-similarity.js';
import * as transcode from './transcode.js';
import * as authApi from './auth.js';

// Server-wide capability facts — the public `features` object. Everything
// here is a config/capability fact safe for anonymous eyes (the public
// rule above); nothing is caller-scoped.
export function buildFeatures() {
  // Signal "transcoding available" only when ffmpeg actually resolved
  // (bundled binaries ready OR system-PATH fallback succeeded).
  let transcodeInfo = false;
  if (transcode.isDownloaded() && config.program.transcode) {
    transcodeInfo = {
      defaultCodec: config.program.transcode.defaultCodec,
      defaultBitrate: config.program.transcode.defaultBitrate
    };
  }

  return {
    // Whether a sonic-similarity query would find anything RIGHT NOW.
    // Distinct from `discovery`, which says the feature is switched on: a
    // server can have it on with an unfinished scan, and that combination
    // is exactly what makes clients look broken. Auto DJ sends
    // similarTo/minSimilarity, every pick 400s on the empty pool, and the
    // queue silently stops advancing.
    //
    // A boolean, not a count: this layer is public, and how many tracks
    // are analysed is library-size information. Clients only need to know
    // whether to offer the feature.
    discoveryReady: sim.hasEmbeddings(),
    // The Discover panel has a server to talk to (no /api/v1/discovery/*
    // probes needed — flags, never probes, is the house rule).
    discovery: config.program.scanOptions.collectDiscoveryData === true,
    // Same contract for the panel's "From the network" section
    // (/api/v1/discovery/p2p/*).
    discoveryP2p: config.program.discoveryP2p.enabled === true,
    // false, or the server's transcode defaults.
    transcode: transcodeInfo,
    // Per-format booleans from config.
    supportedAudioFiles: config.program.supportedAudioFiles,
  };
}

// The CALLER-SCOPED half of the old ping payload: what this user (or
// federation key, or public-mode caller) may see and do. Server-wide
// capabilities moved to buildFeatures(); ping composes both halves (plus
// its legacy fields) back into its frozen flat shape:
//   - `playlists`            — a resource (the playlist routes), not a
//                              server capability;
//   - `allowYoutubeDownload` — velvet-only and always === !noUpload;
//   - `discoveryPath`        — a historical "this server VERSION has the
//                              sonic-path route" gate, always ===
//                              `discovery` on any build carrying this
//                              code, so on /api/ it says nothing.
// Field changes in these builders reach BOTH routes — that is the point.
export function buildClientBootPayload(user) {
  // Get user's library names
  const vpaths = user.vpaths || [];

  const payload = {
    vpaths,
    noMkdir: config.program.noMkdir || user.allow_mkdir === false || user.allow_mkdir === 0,
    noUpload: config.program.noUpload || user.allow_upload === false || user.allow_upload === 0,
    noFileModify: config.program.noFileModify || user.allow_file_modify === false || user.allow_file_modify === 0,
    // "From your peers" in the Discover panel: needs local embeddings (the
    // seed vector comes from our discovery.db) plus at least one federated
    // peer that hasn't opted out of discovery. Caller-scoped by nature —
    // it reflects this server's live peer RELATIONSHIPS, which is not a
    // fact for the anonymous features object.
    federationDiscovery: config.program.federation.enabled === true
      && config.program.scanOptions.collectDiscoveryData === true
      && fedDb.getFederationPeers().some((p) => p.use_discovery === 1),
    vpathMetaData: {}
  };

  // Get library type metadata
  for (const vpathName of vpaths) {
    const lib = db.getLibraryByName(vpathName);
    if (lib) {
      payload.vpathMetaData[vpathName] = { type: lib.type };
    }
  }

  return payload;
}

export function setup(mstream) {
  mstream.get('/api/', (req, res) => {
    // Throws 401 on a presented-but-bad token/key (403 for a federation
    // key off its allowlist); returns null for "no credentials at all"
    // and for share tokens.
    const user = authApi.resolveOptionalUser(req);

    // ── Base layer: always ─────────────────────────────────────────────
    const info = {
      // The version is the anonymous probe's payload — see the header.
      ...(authApi.credentialsPresented(req) ? {} : { server: packageJson.version }),
      apiVersions: ["1"],
      features: buildFeatures(),
    };
    if (!user) { return res.json(info); }

    // ── Layer 2: any authenticated caller ──────────────────────────────
    info.user = {
      username: user.username,
      admin: user.admin === true,
      federation: user.federation === true,
      ...buildClientBootPayload(user),
    };

    // ── Layer 3: admin only ────────────────────────────────────────────
    // user.admin is false by construction for federation keys, jukebox
    // sessions, and the lockAdmin public-mode user, so gating on the flag
    // alone is sufficient. Cheap support/debug facts; grows as needed.
    //
    // DELIBERATE: in public-access mode (no users, lockAdmin off) this
    // layer is visible to anonymous callers — public mode IS admin
    // everywhere else on the server (the whole /admin surface is open),
    // and /api/ pretending otherwise would be the one inconsistent route.
    // Operators who expose a no-users server and want this hidden have
    // the same lever as for everything else: lockAdmin.
    if (user.admin === true) {
      info.admin = {
        uptime: Math.floor(process.uptime()),
        nodeVersion: process.version,
        platform: process.platform,
        dbSchemaVersion: db.getDB().prepare('PRAGMA user_version').get().user_version,
        lockAdmin: config.program.lockAdmin === true,
      };
    }

    res.json(info);
  });
}
