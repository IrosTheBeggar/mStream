// Federation-key authentication for the auth wall (src/api/auth.js).
//
// A federated peer presents its minted key in the `x-federation-key` header
// on every HTTP request (the key is NOT a JWT — it never touches jwt.verify).
// The wall calls authenticateFederationKey() as its FIRST branch, before the
// public-mode branch: on a no-users server the public branch would otherwise
// hand every request a full-access user, silently bypassing federation
// scoping.
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

// Read routes a federation key may call. Exact "METHOD path" matches plus
// GET-only prefixes for the static media/art trees. The file-explorer
// listing routes are included — getVPathInfo scopes them to the key's
// granted libraries — but its mkdir/upload siblings are writes and stay
// off the list. Deliberately excludes rated/recently-played/most-played
// (per-user stats — meaningless and privacy-adjacent for a foreign
// reader) and every write route.
const ALLOWED_EXACT = new Set([
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
]);
const ALLOWED_GET_PREFIXES = ['/media/', '/album-art/'];

export function isFederationPathAllowed(req) {
  if (ALLOWED_EXACT.has(`${req.method} ${req.path}`)) { return true; }
  if (req.method === 'GET' && ALLOWED_GET_PREFIXES.some((p) => req.path.startsWith(p))) { return true; }
  return false;
}

// Validate a presented key and build the synthetic read-only req.user.
// Throws WebError 401 (bad/inert key) or 403 (valid key, off-limits route).
export function authenticateFederationKey(key, req) {
  // Feature off = every minted key is inert, even over plain LAN HTTP. The
  // key is the credential and the iroh endpoint just a rendezvous, so the
  // enabled flag has to gate here, not only at the endpoint.
  if (config.program.federation.enabled !== true) {
    winston.warn(`[federation] rejected key auth from ${req.ip} on ${req.path}: federation is disabled`);
    throw new WebError('Authentication Error', 401);
  }

  const row = fedDb.getFederationKeyByKey(key);
  if (!row) {
    // A wrong key at this wall is a probing signal, same as an invalid JWT.
    winston.warn(`[federation] rejected unknown key from ${req.ip} on ${req.path}`);
    throw new WebError('Authentication Error', 401);
  }

  if (!isFederationPathAllowed(req)) {
    winston.warn(`[federation] key '${row.name}' denied off-allowlist route ${req.method} ${req.path} from ${req.ip}`);
    throw new WebError('Forbidden', 403);
  }

  const grants = fedDb.getFederationKeyLibraries(row.id);
  fedDb.touchFederationKeyLastUsed(row.id);

  return {
    id: null,
    username: `federation:${row.name}`,
    federation: true,
    federationKeyId: row.id,
    admin: false,
    vpaths: grants.map((g) => g.name),
    libraryIds: grants.map((g) => g.id),
    allow_upload: 0,
    allow_mkdir: 0,
    allow_file_modify: 0,
    allow_server_audio: 0,
  };
}
