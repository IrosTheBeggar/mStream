// GET /api/ — the layered server-info endpoint. Sits BEHIND the auth
// wall, and that placement is a CLIENT-FACING API CONTRACT, not an
// accident of mounting order:
//
//   ⚠ Tokenless GET /api/ on a server with users MUST return 401.
//   Third-party mobile clients probe this endpoint (like ping before it)
//   with no token to decide whether to show a login form — 401 means
//   "authenticate first", 200 means public-access mode. #932 briefly
//   mounted this route before the wall with an anonymous base layer and
//   broke exactly that detection (every server answered 200, so every
//   server looked public). Do not make this endpoint anonymous again.
//
// For authenticated callers (valid JWT, public-access mode, jukebox
// session, or a federation key — the wall resolves all of them), the
// response is built ADDITIVELY in three layers. Never build it by
// filtering a full object down: an additive bug omits a field, a
// filtering bug discloses everything.
//
//   Base: `server` (the version), `apiVersions`, and `features` —
//     server-wide capability facts (see buildFeatures). Visible to every
//     authenticated caller including federated peers; rule for what may
//     appear: config/capability facts only — no counts, no library or
//     content names, no identity.
//
//   `user`: identity plus the CALLER-SCOPED boot payload (vpaths,
//     permission flags, federationDiscovery, vpathMetaData), scoped
//     exactly as ping scopes it.
//
//   `admin`: cheap support/debug facts. Admin callers only — never
//     federation keys or jukebox sessions — and never while lockAdmin
//     is on: a locked admin API serves no admin params, so an is_admin
//     account under the lock sees user.admin=true (identity) with no
//     admin object, which is how a client tells "locked" from "not an
//     admin". In public-access mode (no users, lockAdmin off) the layer
//     is visible to tokenless callers — deliberate: public mode IS
//     admin on every other route, and lockAdmin is the hardening lever.
//
// Federation keys reach this route via their allowlist ('GET /api' +
// 'GET /api/' in federation-auth.js) and get the version plus their
// granted-library view — the mobile app's "what can this peer do" call.
// Share tokens get the wall's path-gating and cannot call this (401),
// same as ping. /api/v1/ping is deprecated in favor of this endpoint
// but kept indefinitely; it composes its frozen flat payload from the
// two builders below — one source of truth, zero drift.

import packageJson from '../../package.json' with { type: 'json' };
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as fedDb from '../db/federation.js';
import * as sim from '../db/discovery-similarity.js';
import * as transcode from './transcode.js';

// Server-wide capability facts — the `features` object. Everything here
// is a config/capability fact (the rule above); nothing is caller-scoped.
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
    // A boolean, not a count: how many tracks are analysed is
    // library-size information no client needs.
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
// capabilities live in buildFeatures(); ping composes both halves (plus
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

  // Read the peer list once — both federation flags below need it.
  const federationEnabled = config.program.federation.enabled === true;
  const federationPeers = federationEnabled ? fedDb.getFederationPeers() : [];

  const payload = {
    vpaths,
    noMkdir: config.program.noMkdir || user.allow_mkdir === false || user.allow_mkdir === 0,
    noUpload: config.program.noUpload || user.allow_upload === false || user.allow_upload === 0,
    noFileModify: config.program.noFileModify || user.allow_file_modify === false || user.allow_file_modify === 0,
    // "From your peers" in the Discover panel: needs local embeddings (the
    // seed vector comes from our discovery.db) plus at least one federated
    // peer that hasn't opted out of discovery. Caller-scoped by nature —
    // it reflects this server's live peer RELATIONSHIPS.
    federationDiscovery: federationEnabled
      && config.program.scanOptions.collectDiscoveryData === true
      && federationPeers.some((peer) => peer.use_discovery === 1),
    // Browsing a peer's library (api/federation-browse.js): the top-bar
    // server switcher. Same no-probe contract as the discovery flags — an
    // older build omits the key and the client simply never offers the
    // feature. Requires a peer to browse, so a federation-enabled server
    // with none stays quiet. Caller-scoped for the same reason
    // federationDiscovery is: it reports live peer RELATIONSHIPS.
    federationBrowse: federationEnabled && federationPeers.length > 0,
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
    // Behind the wall: req.user is always resolved (or the wall already
    // threw the 401 the tokenless-probe contract depends on).
    const user = req.user;

    // ── Base ───────────────────────────────────────────────────────────
    const info = {
      server: packageJson.version,
      apiVersions: ["1"],
      features: buildFeatures(),
    };

    // ── `user`: caller-scoped ──────────────────────────────────────────
    info.user = {
      username: user.username,
      admin: user.admin === true,
      federation: user.federation === true,
      ...buildClientBootPayload(user),
    };

    // ── `admin`: admin only, and only while the admin API is usable ────
    // (See the header for the lockAdmin and public-mode reasoning.)
    if (user.admin === true && config.program.lockAdmin !== true) {
      info.admin = {
        uptime: Math.floor(process.uptime()),
        nodeVersion: process.version,
        platform: process.platform,
        dbSchemaVersion: db.getDB().prepare('PRAGMA user_version').get().user_version,
      };
    }

    res.json(info);
  });
}
