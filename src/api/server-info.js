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
//   Base: `server` (the version), `instanceId`, `apiVersions`, and
//     `features` — server-wide capability facts (see buildFeatures).
//     Visible to every authenticated caller including federated peers;
//     rule for what may appear: config/capability facts only — no counts,
//     no library or content names, no identity of the caller or of anyone
//     else. The one identity here is the SERVER's own: `instanceId`, the
//     random id mDNS already advertises to the whole LAN (see
//     serverInstanceId).
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
// granted-library view — the mobile app's "what can this peer do" call —
// and their key's allowance (`user.federationAllowance`: the caps and
// today's use), so a holder paces itself instead of meeting the quota as a
// 429.
// Share tokens get the wall's path-gating and cannot call this (401),
// same as ping. /api/v1/ping is deprecated in favor of this endpoint
// but kept indefinitely; it composes its frozen flat payload from the
// two builders below — one source of truth, zero drift.

import packageJson from '../../package.json' with { type: 'json' };
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as fedDb from '../db/federation.js';
import * as fedRequestsDb from '../db/federation-requests.js';
import * as sim from '../db/discovery-similarity.js';
import * as discoveryPlugins from '../discovery-plugins/index.js';
import * as transcode from './transcode.js';
import { describeAllowance } from './federation-limits.js';
import { describeProxy } from './federation-stream.js';

// The server's stable id: the random UUID config.js generates on first boot
// and persists (discovery.mdns.instanceId — the key's name predates this
// use; mDNS has always advertised it as `id=`). It survives restarts,
// address and port changes, and a rename, so a client that stores
// something per server (a portable player's card, an offline index) can
// tell "the same server under another URL" from "another server" without
// keeping a URL or a token. null only on a config that never booted
// through config.js. Generated whether or not mDNS advertises, and
// identical to what it advertises, so a server found on the LAN and the
// one reached by URL compare equal.
export function serverInstanceId() {
  const id = config.program.discovery?.mdns?.instanceId;
  return typeof id === 'string' && id !== '' ? id : null;
}

// Server-wide capability facts — the `features` object. Everything here
// is a config/capability fact (the rule above); nothing is caller-scoped.
export function buildFeatures() {
  // Signal "transcoding available" only when ffmpeg actually resolved
  // (bundled binaries ready OR system-PATH fallback succeeded).
  let transcodeInfo = false;
  if (transcode.isDownloaded() && config.program.transcode) {
    transcodeInfo = {
      defaultCodec: config.program.transcode.defaultCodec,
      defaultBitrate: config.program.transcode.defaultBitrate,
      // What a request may ask of each codec: its bitrates (MP3 reaches
      // 320k) and the output sample rates `?sampleRate=` takes. Absent on
      // older servers, which take only 64k-192k and no sample rate.
      codecs: transcode.getTransCodecOptions(),
      // This server takes `?bulk=1` (one file of a long job: kept out of
      // the cache, queued behind a server-wide cap) and runs this many such
      // transcodes at once — a bulk client need not open more.
      bulk: { concurrency: transcode.bulkConcurrency() },
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
    // At least one discovery plug-in is switched on, so a recommendation
    // row has actions to offer (GET /api/v1/discovery/plugins lists them).
    // The flag, never the list, lives here: the list is per-plug-in state.
    discoveryPlugins: discoveryPlugins.anyPluginEnabled(),
    // This server answers POST /api/v1/discovery/owned — "which of these
    // songs, albums and artists does my library have", a list at a time —
    // the marks the peer browse draws. A version fact, like `sync`: a
    // client gates on the key, never on the version string.
    discoveryOwned: true,
    // false, or the server's transcode defaults.
    transcode: transcodeInfo,
    // Per-format booleans from config.
    supportedAudioFiles: config.program.supportedAudioFiles,
    // Stats API v2 (/api/v1/stats/*): the version a client should speak.
    // Absent on older servers, so a client gates on this — never on the
    // version string. 2 = ingest, reads and management together; a partial
    // surface was never advertised.
    stats: 2,
    // Library sync manifest (POST /api/v1/sync/manifest) — the server half
    // of the mobile / desktop app's local mirror + offline index. Same
    // contract as the discovery flags: the key's presence says this VERSION
    // has the route; clients never probe for it.
    sync: true,
    // The peer stream proxy (/api/v1/federation/peers/:id/stream/*,
    // api/federation-stream.js) forwards X-mStream-Purpose: `{ purpose:
    // true }`, so a client copying a peer's files through this server knows
    // the peer is told they are copies. A version fact like `sync`, present
    // with federation on or off (whether there is a peer to reach is
    // user.federationBrowse); older servers omit the key and drop the
    // header. /api/-only, like discoveryReady: ping never carried it.
    federationProxy: describeProxy(),
  };
}

// The CALLER-SCOPED half of the old ping payload: what this user (or
// federation key, or public-mode caller) may see and do. Server-wide
// capabilities live in buildFeatures(); ping composes both halves (plus
// its legacy fields) back into its frozen flat shape:
//   - `playlists`            — a resource (the playlist routes), not a
//                              server capability;
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
    // Direct access to a peer (the `access` route in api/federation-browse.js):
    // a device dials the peer itself with a guest token this server fetches
    // on its behalf (state/federation-guest.js). Same shape as
    // federationBrowse — the key's presence says this build has the route,
    // its value says there is a peer to reach. Whether a given PEER
    // cooperates is answered per peer by the access route (an older peer
    // refuses, and the client keeps using the proxies above).
    federationDirect: federationEnabled && federationPeers.length > 0,
    // Federation requests waiting on this operator — inbound rows still in
    // the `received` state (the V67 inbox), the number the admin panel's
    // Requests badge shows. A client draws its "N requests waiting" banner
    // from the value alone, so it is scoped to who can ACT on it: a number
    // only for an admin, on an unlocked admin API, of a federation-enabled
    // server (the same three gates the accept/reject routes sit behind);
    // everyone else reads 0. The key's presence says the build has the
    // requests feature — an older server omits it and the client shows
    // nothing.
    federationInbox: federationEnabled && user.admin === true && config.program.lockAdmin !== true
      ? fedRequestsDb.countPendingInbound() : 0,
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
      // The server's own stable id (serverInstanceId above) — not the
      // caller's identity, which lives in `user`.
      instanceId: serverInstanceId(),
      apiVersions: ["1"],
      features: buildFeatures(),
    };

    // ── `user`: caller-scoped ──────────────────────────────────────────
    info.user = {
      username: user.username,
      admin: user.admin === true,
      federation: user.federation === true,
      // A device of a key holder, on a guest token rather than the key
      // itself (state/federation-guest.js). Same scope as the key.
      federationGuest: user.federationGuest === true,
      // A federation caller's own allowance: its key's caps and today's use
      // (api/federation-limits.js describeAllowance, built field by field —
      // the synthetic user's internal federationLimits / federationKeyId
      // never reach the response). Federation callers only: it describes
      // the caller's key, and a local account has none.
      ...(user.federation === true ? { federationAllowance: describeAllowance(user) } : {}),
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
