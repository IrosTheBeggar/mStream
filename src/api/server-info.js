// GET /api/ — the layered server-info endpoint.
//
// One endpoint, three layers, built ADDITIVELY (base → +user → +admin).
// Never build this response by filtering a full object down: an additive
// bug omits a field, a filtering bug discloses everything.
//
//   Layer 1 (always, no credentials):
//     { server, apiVersions, features } — version + capability booleans
//     only. This layer is deliberately public (mobile clients need a
//     pre-auth "is this an mStream server, which version" probe when
//     adding a server) and must stay allocation-cheap: config reads and
//     the guarded one-row discovery probe, nothing an anonymous caller
//     can use to make the server do work.
//
//   Layer 2 (valid JWT, public-access mode, jukebox session, or a
//   federation key): adds `user` — identity plus the client boot payload
//   that /api/v1/ping has always served (vpaths, transcode, permission
//   flags, discovery flags, vpathMetaData), scoped to the caller exactly
//   as ping scopes it. Playlists are deliberately NOT here — they're a
//   resource (the playlist routes), not a capability.
//
//   Layer 3 (admin only — never federation, never jukebox): adds `admin`
//   — cheap support/debug facts. Mostly a framework hook today.
//
// Auth contract: a request with NO credentials gets layer 1; a request
// with PRESENT-but-invalid credentials gets 401 (403 for a federation key
// off its allowlist) — a bad token is an error the client must see, never
// a silent downgrade to the public layer (a webapp with an expired cookie
// needs the 401 to know to re-login). Share tokens get layer 1 only.
//
// Mounted BEFORE the auth wall (see server.js) so it owns its auth via
// resolveOptionalUser(); /api/v1/ping stays behind the wall unchanged and
// is now a thin wrapper over buildClientBootPayload() below — one payload
// builder, zero drift between the two routes. Ping is deprecated in favor
// of this endpoint but kept indefinitely: older mobile clients, CI
// liveness probes, and the torrent/velvet webapps still call it.

import packageJson from '../../package.json' with { type: 'json' };
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as fedDb from '../db/federation.js';
import * as sim from '../db/discovery-similarity.js';
import * as transcode from './transcode.js';
import * as authApi from './auth.js';

// The client boot payload — the object /api/v1/ping has always returned,
// minus `playlists` (moved here otherwise verbatim). Ping composes
// playlists back on top to keep its frozen contract; the layered /api/
// deliberately does NOT serve them — playlist content is its own
// resource (the playlist routes), not a server capability. Field changes
// here reach BOTH routes — that is the point.
export function buildClientBootPayload(user) {
  // Signal "transcoding available" only when ffmpeg actually resolved
  // (bundled binaries ready OR system-PATH fallback succeeded).
  let transcodeInfo = false;
  if (transcode.isDownloaded() && config.program.transcode) {
    transcodeInfo = {
      defaultCodec: config.program.transcode.defaultCodec,
      defaultBitrate: config.program.transcode.defaultBitrate
    };
  }

  // Get user's library names
  const vpaths = user.vpaths || [];

  const payload = {
    vpaths,
    transcode: transcodeInfo,
    noMkdir: config.program.noMkdir || user.allow_mkdir === false || user.allow_mkdir === 0,
    noUpload: config.program.noUpload || user.allow_upload === false || user.allow_upload === 0,
    noFileModify: config.program.noFileModify || user.allow_file_modify === false || user.allow_file_modify === 0,
    // VELVET ONLY: redundant with noUpload — update Velvet UI to use noUpload instead, then remove this
    allowYoutubeDownload: !(config.program.noUpload || user.allow_upload === false || user.allow_upload === 0),
    supportedAudioFiles: config.program.supportedAudioFiles,
    // Lets the webapp know the Discover panel has a server to talk to
    // without probing /api/v1/discovery/* (kept collapsed by default, the
    // panel sends no discovery requests at all until expanded).
    discovery: config.program.scanOptions.collectDiscoveryData === true,
    // Sonic path (POST /api/v1/discovery/local/path). Same condition as
    // `discovery` — the flag's real payload is "this server VERSION has
    // the route": older builds omit the key entirely, so clients that
    // never probe (the house rule) simply don't show the feature.
    discoveryPath: config.program.scanOptions.collectDiscoveryData === true,
    // Same contract for the panel's "From the network" section
    // (/api/v1/discovery/p2p/*): no flag, no probes.
    discoveryP2p: config.program.discoveryP2p.enabled === true,
    // And again for "From your peers" (/api/v1/discovery/federation/*):
    // needs local embeddings (the seed vector comes from our discovery.db)
    // plus at least one federated peer that hasn't opted out of discovery.
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
    // ── Layer 1: always ────────────────────────────────────────────────
    const info = {
      server: packageJson.version,
      apiVersions: ["1"],
      features: {
        subsonic: config.program.subsonic.mode !== 'disabled',
        // Whether a sonic-similarity query would find anything RIGHT NOW.
        // Distinct from the boot payload's `discovery` flag, which says the
        // feature is switched on: a server can have it on with an
        // unfinished scan, and that combination is exactly what makes
        // clients look broken. Auto DJ sends similarTo/minSimilarity,
        // every pick 400s on the empty pool, and the queue silently stops
        // advancing.
        //
        // A boolean, not a count: this layer is public, and how many
        // tracks are analysed is library-size information. Clients only
        // need to know whether to offer the feature.
        discoveryReady: sim.hasEmbeddings(),
      },
    };

    // Throws 401 on a presented-but-bad token/key (403 for a federation
    // key off its allowlist); returns null for "no credentials at all".
    const user = authApi.resolveOptionalUser(req);
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
