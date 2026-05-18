// Frozen enums for the torrent feature surface. Every bare string the
// codebase compared or assigned (status names, confidence levels,
// client identifiers, etc.) lives here, so adding a new value to one
// enum is a single-file change instead of an N-file grep-and-update.
//
// Wire-format implications: these string values ARE the serialised
// form. They appear in API responses, DB columns, UI class names, and
// frontend code. Renaming a value means migrating all four. Adding a
// value is safe.

/**
 * Vpath-access confidence ladder. The add-torrent gate accepts
 * VERIFIED and INFERRED (see `isUsable`); UNCONFIRMED + PENDING both
 * block the request with a structured 4xx telling the operator to
 * wait or fix the mapping.
 *
 *   VERIFIED    — round-trip proven (Transmission's free-space probe
 *                 saw the sentinel directory mStream just wrote)
 *   INFERRED    — daemon is configured to use a parent of the
 *                 candidate path, but we haven't actually round-trip-
 *                 verified shared filesystem view (the qBittorrent
 *                 case — no free-space equivalent in its WebAPI)
 *   PENDING     — a background probe is in flight. Written at the
 *                 start of a sweep, overwritten by the final result.
 *                 The row exists so the admin UI can render a
 *                 spinner for the active probe instead of leaving
 *                 the row blank during the daemon round-trip.
 *   UNCONFIRMED — probe failed or no row exists yet
 */
export const CONFIDENCE = Object.freeze({
  VERIFIED:    'verified',
  INFERRED:    'inferred',
  PENDING:     'pending',
  UNCONFIRMED: 'unconfirmed',
});

/**
 * How a torrent_client_vpath_access row arrived. Auto sweeps preserve
 * (don't overwrite) MANUAL rows — enforced atomically by the WHERE
 * clause on the V39 upsert.
 */
export const SOURCE = Object.freeze({
  AUTO:   'auto',
  MANUAL: 'manual',
});

/**
 * Normalised torrent status. Both RPC modules map their native
 * protocols' state representations onto this set so the UI never
 * sees Transmission's integer codes or qBittorrent's flat state
 * strings. The CSS chip classes in admin/index.css are keyed by
 * these literal strings — keep them in sync if values change here.
 */
export const STATUS = Object.freeze({
  DOWNLOADING: 'downloading',
  SEEDING:     'seeding',
  PAUSED:      'paused',
  QUEUED:      'queued',
  VERIFYING:   'verifying',
  ERROR:       'error',
  UNKNOWN:     'unknown',
});

/**
 * Active torrent-client backend. DISABLED is the off state — every
 * route checks against it as the first gate. Adding a new client
 * (Deluge, rTorrent, …) is a value addition plus a new RPC module.
 */
export const CLIENT_TYPE = Object.freeze({
  DISABLED:     'disabled',
  TRANSMISSION: 'transmission',
  QBITTORRENT:  'qbittorrent',
  DELUGE:       'deluge',
});

/**
 * Per-user gating policy for the torrent feature.
 *   ALL       — every authenticated user can add torrents
 *   WHITELIST — only users with users.allow_torrent = 1 (V36)
 */
export const ENABLED_FOR = Object.freeze({
  ALL:       'all',
  WHITELIST: 'whitelist',
});

// ── Predicates ────────────────────────────────────────────────────────

/**
 * The add-torrent gate's confidence check. True iff a vpath-access
 * row is usable for torrent operations — either fully verified or
 * inferred-from-daemon-config.
 *
 * Used by `POST /api/v1/torrent/add` to decide between 409 (unusable)
 * and pass-through, and by the UI to enable/disable the submit
 * button at preflight time.
 */
export function isUsable(confidence) {
  return confidence === CONFIDENCE.VERIFIED || confidence === CONFIDENCE.INFERRED;
}

/**
 * Active-torrent-client detection. Treats DISABLED + null/undefined
 * as "no client" so callers can short-circuit before touching the
 * RPC modules.
 */
export function isClientActive(clientType) {
  return clientType != null && clientType !== CLIENT_TYPE.DISABLED;
}
