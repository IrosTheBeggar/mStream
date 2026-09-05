// Federation-key authentication for the auth wall (src/api/auth.js).
//
// A federated peer presents its minted key in the `x-federation-key` header
// on every HTTP request (the key is NOT a JWT — it never touches jwt.verify).
// The wall calls authenticateFederationKey() as its FIRST branch, before the
// public-mode branch: on a no-users server the public branch would otherwise
// hand every request a full-access user, silently bypassing federation
// scoping.
//
// A GUEST of a key — one of the key holder's own devices, carrying a
// short-lived JWT this server signed for the key (state/federation-guest.js)
// in the ordinary token slots — takes the wall's SECOND branch,
// authenticateGuestToken(), for the same ordering reason. It resolves to the
// same synthetic user as the key it belongs to, with `federationGuest: true`
// on top; the one thing a guest may not do that the key may is mint further
// guests (api/federation.js checks the flag).
//
// A validated key resolves to a synthetic read-only req.user:
//   - admin false + every allow_* flag 0 → all write handlers refuse
//     (the same construction the jukebox-token branch uses);
//   - vpaths / libraryIds restricted to the key's granted libraries →
//     getVPathInfo, the /media/:vpath static gate, and libraryFilter scope
//     browse/stream/download automatically;
//   - id null → no users-table row; user_metadata joins simply match nothing.
//     db/manager.getUserLibraryIds honors the explicit libraryIds override
//     BEFORE its public-mode branch, so the null id can't fall into
//     all-libraries public mode.
//
// Defense-in-depth: on top of the read-only user, requests are limited to an
// explicit allowlist of read routes (same idea as the share-token path
// whitelist), so a future write endpoint that forgets a permission check is
// still unreachable with a federation key.

import winston from 'winston';
import WebError from '../util/web-error.js';
import * as config from '../state/config.js';
import * as fedDb from '../db/federation.js';
import { verifyGuestToken } from '../state/federation-guest.js';

// Read routes a federation key may call. Exact "METHOD path" matches plus
// GET-only prefixes for the static media/art trees. The file-explorer
// listing routes are included — getVPathInfo scopes them to the key's
// granted libraries — but its mkdir/upload siblings are writes and stay
// off the list. Deliberately excludes rated/recently-played/most-played
// (per-user stats — meaningless and privacy-adjacent for a foreign
// reader) and every write route.
const ALLOWED_EXACT = new Set([
  // The layered server-info endpoint (server-info.js): version +
  // capabilities, plus the key-scoped `user` boot payload — how a
  // federated client (the mobile app) learns what this peer can do.
  // Both spellings: the route sits behind the wall (#934) and req.path
  // arrives exactly as the client sent it, trailing slash or not.
  'GET /api',
  'GET /api/',
  'GET /api/v1/db/status',
  'POST /api/v1/db/metadata',
  'POST /api/v1/db/metadata/batch',
  'GET /api/v1/db/artists',
  'POST /api/v1/db/artists',
  'POST /api/v1/db/artists-albums',
  'GET /api/v1/db/albums',
  'POST /api/v1/db/albums',
  'GET /api/v1/db/genres',
  'POST /api/v1/db/genres',
  'POST /api/v1/db/genre-songs',
  'POST /api/v1/db/album-songs',
  'POST /api/v1/db/recent/added',
  'POST /api/v1/db/search',
  'POST /api/v1/file-explorer',
  'POST /api/v1/file-explorer/recursive',
  'POST /api/v1/file-explorer/m3u',
  'GET /api/v1/federation/health',
  'POST /api/v1/federation/discovery/similar',
  // The guest mint (api/federation.js): a key holder asks for a token one
  // of its own devices can dial us with. Listed for the KEY's sake; the
  // route itself refuses guests, so being on the shared allowlist does not
  // let a guest mint guests.
  'POST /api/v1/federation/guest',
]);
const ALLOWED_GET_PREFIXES = ['/media/', '/album-art/'];

export function isFederationPathAllowed(req) {
  return isFederationRouteAllowed(req.method, req.path);
}

// Same decision, addressable by (method, path) instead of a live request.
// The OUTBOUND browse proxy (api/federation-browse.js) forwards local-user
// calls to a peer's allowlisted routes, and it screens the path against
// THIS list before dialing: a peer re-checks its own copy anyway, but
// sharing one table means the two directions can never drift into a route
// we proxy to but no peer will answer (or worse, the reverse).
// `exactOnly` drops the media/art prefixes. The OUTBOUND browse proxy only
// forwards the exact db/file-explorer reads (the byte trees have their own
// dedicated stream and art proxies), so it screens exactOnly and never inherits
// /media//album-art as a second path. Inbound auth leaves it false — a paired
// peer legitimately streams and fetches art from us over those prefixes.
export function isFederationRouteAllowed(method, path, { exactOnly = false } = {}) {
  if (ALLOWED_EXACT.has(`${method} ${path}`)) { return true; }
  if (!exactOnly && method === 'GET' && ALLOWED_GET_PREFIXES.some((p) => path.startsWith(p))) { return true; }
  return false;
}

// Feature off = every minted key (and every guest of one) is inert, even
// over plain LAN HTTP. The key is the credential and the iroh endpoint just
// a rendezvous, so the enabled flag has to gate here, not only at the
// endpoint.
function requireFederationEnabled(req, what) {
  if (config.program.federation.enabled !== true) {
    winston.warn(`[federation] rejected ${what} from ${req.ip} on ${req.path}: federation is disabled`);
    throw new WebError('Authentication Error', 401);
  }
}

// Lazy severing of an expired key's pipes: an iroh pipe opened before the
// cutoff would otherwise coast on keep-alives (each request inside it dies
// at the wall anyway, but the connection itself should go too). DELAYED a
// beat on purpose: severing in-line races the 401 through the bridge — the
// pipe died under the in-flight response and the peer saw "unreachable"
// instead of the clean auth error (caught by the two-server live smoke).
// Two seconds lets the rejection flush; anything the peer sends in the
// window still dies at the wall.
function severExpiredKeyLater(row) {
  const sever = setTimeout(() => {
    import('../state/federation.js')
      .then((federation) => federation.closeConnectionsForKey(row.id))
      .catch(() => { /* native binary absent — nothing live to sever */ });
  }, 2000);
  if (sever.unref) { sever.unref(); }
}

// The shared tail of both branches: a key row that exists resolves to the
// synthetic read-only user — after the expiry check and the allowlist
// screen. `guest` marks a token-carrying device rather than the paired
// server itself; everything else about the user is the key's.
function buildFederationUser(row, req, { guest = false } = {}) {
  const who = guest ? `guest of key '${row.name}'` : `key '${row.name}'`;
  if (row.expired) {
    winston.warn(`[federation] rejected expired ${who} from ${req.ip} on ${req.path}`);
    severExpiredKeyLater(row);
    throw new WebError('Authentication Error', 401);
  }

  if (!isFederationPathAllowed(req)) {
    winston.warn(`[federation] ${who} denied off-allowlist route ${req.method} ${req.path} from ${req.ip}`);
    throw new WebError('Forbidden', 403);
  }

  const grants = fedDb.getFederationKeyLibraries(row.id);
  fedDb.touchFederationKeyLastUsed(row.id);

  return {
    id: null,
    username: `federation:${row.name}`,
    federation: true,
    federationKeyId: row.id,
    // A device of the key holder rather than the holder's server (see the
    // header). Same scope and caps; the mint route refuses it.
    federationGuest: guest,
    // Bandwidth caps ride along so the limits middleware (registered right
    // after this wall) never needs a second key lookup. 0 = unlimited.
    federationLimits: {
      streamKbps: row.stream_kbps || 0,
      dailyMb: row.daily_mb || 0,
      maxStreams: row.max_streams || 0,
    },
    admin: false,
    vpaths: grants.map((g) => g.name),
    libraryIds: grants.map((g) => g.id),
    allow_upload: 0,
    allow_mkdir: 0,
    allow_file_modify: 0,
    allow_server_audio: 0,
  };
}

// Validate a presented key and build the synthetic read-only req.user.
// Throws WebError 401 (bad/inert key) or 403 (valid key, off-limits route).
export function authenticateFederationKey(key, req) {
  requireFederationEnabled(req, 'key auth');

  const row = fedDb.getFederationKeyByKey(key);
  if (!row) {
    // A wrong key at this wall is a probing signal, same as an invalid JWT.
    winston.warn(`[federation] rejected unknown key from ${req.ip} on ${req.path}`);
    throw new WebError('Authentication Error', 401);
  }

  return buildFederationUser(row, req);
}

// Validate a guest token (state/federation-guest.js) presented in the
// ordinary token slots and build the same synthetic user for the key it
// belongs to — so a revoked or expired key takes its guests with it.
// Throws WebError 401 (bad, expired, or orphaned token) or 403 (off-limits
// route), exactly like authenticateFederationKey.
export function authenticateGuestToken(token, req) {
  requireFederationEnabled(req, 'guest auth');

  let guest;
  try {
    guest = verifyGuestToken(token);
  } catch (err) {
    winston.warn(`[federation] rejected guest token from ${req.ip} on ${req.path}: ${err.message}`);
    throw new WebError('Authentication Error', 401);
  }

  const row = fedDb.getFederationKeyById(guest.keyId);
  if (!row) {
    winston.warn(`[federation] rejected guest of a revoked key (id=${guest.keyId}) from ${req.ip} on ${req.path}`);
    throw new WebError('Authentication Error', 401);
  }

  return buildFederationUser(row, req, { guest: true });
}
