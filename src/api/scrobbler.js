import crypto from 'crypto';
import Joi from 'joi';
import * as config from '../state/config.js';
import Scribble from '../state/lastfm.js';
import * as db from '../db/manager.js';
import { joiValidate } from '../util/validation.js';
import { getVPathInfo } from '../util/vpath.js';

const Scrobbler = new Scribble();

// ── Last.fm similar-artists cache ────────────────────────────────────────────
//
// Auto-DJ fires `artist.getSimilar` once per DJ pick (every ~3-5 min
// per active user). Without a cache, a steady-state session hammers
// Last.fm with the same query — they rate-limit at 5 req/s/IP and we
// don't want to burn through that budget on duplicates. 24-hour TTL
// is plenty: similar-artist relationships are nearly static at this
// scale.
//
// Map insertion order doubles as the LRU order — when we hit MAX_SIZE,
// drop the oldest entry. Capped at 500: each entry is ~1KB of strings,
// so worst case ~500KB RAM. Not worth pulling in a real LRU library.
//
// Key: case-folded artist name (the raw query, lowercased — NOT the
// full normalizer pass). Last.fm's response is deterministic per
// case-folded artist; mixing the full normalizer in would conflate
// distinct cache entries that aren't actually the same query.
const _lastfmCache = new Map();
const LASTFM_CACHE_TTL_MS = 24 * 60 * 60 * 1000;          // 24h — legit results (200 OK)
const LASTFM_CACHE_TTL_TRANSIENT_MS = 5 * 60 * 1000;      // 5min — 5xx/429/network errors
const LASTFM_CACHE_MAX = 500;

// Exported for tests so a scenario can reset cache state without
// restarting the server.
export function _clearLastfmCache() { _lastfmCache.clear(); }

// Read-only TTL constants for tests that assert cache-branch behaviour.
// Not for production callers — these only matter inside fetchLastfm…'s
// branch selection.
export const _LASTFM_TTLS = Object.freeze({
  ok: LASTFM_CACHE_TTL_MS,
  transient: LASTFM_CACHE_TTL_TRANSIENT_MS,
});

// Test-only peek into a cache entry. Returns { names, ts, ttl } or
// undefined if the key has never been cached / has been LRU-evicted.
// The returned object is a SHALLOW COPY — tests can inspect it but
// can't mutate the live cache through it.
export function _peekLastfmCache(artistKey) {
  const entry = _lastfmCache.get(String(artistKey).toLowerCase());
  if (!entry) { return undefined; }
  return { names: [...entry.names], ts: entry.ts, ttl: entry.ttl };
}

// Exported for the unit test that mocks fetch — the route wrapper
// also calls this, so production behaviour is identical.
export async function fetchLastfmSimilarArtists(artist, apiKey) {
  const key = String(artist).toLowerCase();
  const now = Date.now();

  const hit = _lastfmCache.get(key);
  if (hit && now - hit.ts < hit.ttl) {
    // Clone before returning — callers can mutate the result without
    // poisoning the cached array. Defensive vs. a future call site
    // that does e.g. `.push()` on the response.
    return [...hit.names];
  }
  if (hit) { _lastfmCache.delete(key); }

  // Strip "feat. X" / "ft. X" / "featuring X" / "vs. X" suffixes — Last.fm
  // matches the primary artist far more reliably without them.
  // Mirrors velvet/src/api/scrobbler.js's strip pattern.
  const queryName = String(artist)
    .replace(/\s+(feat\.|ft\.|featuring|vs\.?)\s+.*/i, '')
    .trim();

  const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getsimilar&artist=${encodeURIComponent(queryName)}&api_key=${apiKey}&format=json&limit=50`;
  let r;
  try {
    r = await fetch(url, { headers: { 'User-Agent': 'mStream/6.0' } });
  } catch (_networkErr) {
    // Network error (DNS, connection refused, timeout) — cache empty
    // result on the SHORT TTL so a transient upstream blip doesn't
    // block similar-artists for 24h.
    _cacheLastfmResult(key, [], LASTFM_CACHE_TTL_TRANSIENT_MS);
    return [];
  }
  if (!r.ok) {
    // Distinguish between "Last.fm doesn't know this artist" (a
    // legitimate 200 with empty list, cached for 24h above) and
    // "Last.fm is having a bad day". 4xx codes that aren't 429 are
    // permanent-ish (bad API key, malformed request) — long TTL.
    // 429 (rate limited) and 5xx (server errors) are by definition
    // transient — short TTL so we recover within minutes instead of
    // a day.
    const ttl = (r.status === 429 || r.status >= 500)
      ? LASTFM_CACHE_TTL_TRANSIENT_MS
      : LASTFM_CACHE_TTL_MS;
    _cacheLastfmResult(key, [], ttl);
    return [];
  }
  let data;
  try {
    data = await r.json();
  } catch (_parseErr) {
    // 200 with unparseable body — almost certainly an upstream
    // outage serving HTML error pages. Short TTL.
    _cacheLastfmResult(key, [], LASTFM_CACHE_TTL_TRANSIENT_MS);
    return [];
  }
  const names = Array.isArray(data?.similarartists?.artist)
    ? data.similarartists.artist.map(a => a?.name).filter(n => typeof n === 'string' && n.length > 0)
    : [];

  _cacheLastfmResult(key, names, LASTFM_CACHE_TTL_MS);
  return [...names];
}

function _cacheLastfmResult(key, names, ttl) {
  // LRU eviction — drop the oldest entry. Map.delete + Map.set on
  // an existing key moves it to the back of the iteration order,
  // so this is a clean LRU on top of a plain Map.
  while (_lastfmCache.size >= LASTFM_CACHE_MAX) {
    const oldest = _lastfmCache.keys().next().value;
    if (oldest === undefined) { break; }
    _lastfmCache.delete(oldest);
  }
  _lastfmCache.set(key, { names, ts: Date.now(), ttl });
}

// Exposed so /lastfm/connect (in velvet-stubs.js) can register newly-saved
// credentials with the Scribble session map without waiting for a server
// restart. The boot-time pre-load below covers credentials already in the
// DB on startup; warmScrobbleUser handles the post-boot path.
export function warmScrobbleUser(lastfmUser, lastfmPassword) {
  if (!lastfmUser || !lastfmPassword) { return; }
  Scrobbler.addUser(lastfmUser, lastfmPassword);
}

export function setup(mstream) {
  Scrobbler.setKeys(config.program.lastFM.apiKey, config.program.lastFM.apiSecret);

  // Initialize lastfm users from database. getAllUsers() filters out the
  // anonymous sentinel (V25) — pull it in explicitly so a public-mode
  // operator who linked Last.fm gets their session warmed at boot.
  const users = [...db.getAllUsers()];
  const sentinel = db.getAnonymousUser();
  if (sentinel) { users.push(sentinel); }
  for (const user of users) {
    if (!user.lastfm_user || !user.lastfm_password) { continue; }
    Scrobbler.addUser(user.lastfm_user, user.lastfm_password);
  }

  const d = () => db.getDB();

  // Last.fm scrobbling (and play-count tracking on /scrobble-by-filepath).
  //
  // Public/no-users mode is supported here: auth.js's no-users branch
  // spreads the V25 anonymous sentinel's row onto req.user, so
  // `req.user.lastfm_user` / `lastfm_password` are populated when the
  // operator has linked an account via /lastfm/connect. The "operator
  // is the sentinel" model means scrobbles flow under that single
  // operator-supplied identity — same trade-off as sentinel-backed
  // playlists, cue points, and play counts.

  mstream.post('/api/v1/lastfm/scrobble-by-metadata', (req, res) => {
    const schema = Joi.object({
      artist: Joi.string().optional().allow(''),
      album: Joi.string().optional().allow(''),
      track: Joi.string().required(),
    });
    joiValidate(schema, req.body);

    if (!req.user.lastfm_user || !req.user.lastfm_password) {
      return res.json({ scrobble: false });
    }

    Scrobbler.Scrobble(
      req.body,
      req.user.lastfm_user,
      (_post_return_data) => { res.json({}); }
    );
  });

  mstream.post('/api/v1/lastfm/scrobble-by-filepath', (req, res) => {
    const schema = Joi.object({
      filePath: Joi.string().required(),
    });
    joiValidate(schema, req.body);

    const pathInfo = getVPathInfo(req.body.filePath, req.user);
    const lib = db.getLibraryByName(pathInfo.vpath);
    if (!lib) { return res.json({ scrobble: false }); }

    const track = d().prepare(`
      SELECT t.file_hash, t.title, a.name AS artist, al.name AS album
      FROM tracks t
      LEFT JOIN artists a ON t.artist_id = a.id
      LEFT JOIN albums al ON t.album_id = al.id
      WHERE t.filepath = ? AND t.library_id = ?
    `).get(pathInfo.relativePath, lib.id);

    if (!track) {
      return res.json({ scrobble: false });
    }

    // Prefer audio_hash (stable across tag edits). Older rows and
    // formats we don't yet parse fall back to file_hash.
    const trackKey = track.audio_hash || track.file_hash;

    // Update play count and last played. Sentinel-keyed in public mode
    // — the operator's listening history. See the header comment above.
    d().prepare(`
      INSERT INTO user_metadata (user_id, track_hash, play_count, last_played)
      VALUES (?, ?, 1, datetime('now'))
      ON CONFLICT(user_id, track_hash) DO UPDATE SET
        play_count = play_count + 1,
        last_played = datetime('now')
    `).run(req.user.id, trackKey);

    res.json({});

    // Scrobble to last.fm if configured.
    if (req.user.lastfm_user && req.user.lastfm_password) {
      Scrobbler.Scrobble(
        { artist: track.artist, album: track.album, track: track.title },
        req.user.lastfm_user,
        (_post_return_data) => {}
      );
    }
  });

  // Similar artists via Last.fm API (powers Auto-DJ recommendations).
  //
  // Two-step pipeline:
  //   1. Hit Last.fm `artist.getSimilar` (or pull from the LRU cache
  //      above — Last.fm rate-limits and the same query fires
  //      repeatedly on every DJ pick).
  //   2. Resolve the returned names against the local library via
  //      db.resolveArtistNamesForDJ — fold both sides through the
  //      same case/diacritic/`&`-normaliser. The response is the
  //      list of CANONICAL library names so the caller can pass them
  //      straight into a tracks-table `IN (?)` filter without further
  //      reshaping. Artists not in the library are dropped — they
  //      can't contribute candidate songs anyway.
  //
  // Returns `{ artists: [] }` (NOT a 4xx) when any of:
  //   - the artist query param is missing
  //   - no Last.fm API key is configured
  //   - the upstream HTTP call fails or returns malformed JSON
  //   - Last.fm has no similar artists for this name
  //   - none of the similar artists exist in the library
  // The Auto-DJ caller treats "empty array" as "fall back to non-
  // similar picks" — no need to distinguish failure modes.
  mstream.get('/api/v1/lastfm/similar-artists', async (req, res) => {
    const artist = req.query.artist;
    if (!artist) return res.json({ artists: [] });

    const apiKey = config.program.lastFM?.apiKey;
    if (!apiKey) return res.json({ artists: [] });

    try {
      const rawNames = await fetchLastfmSimilarArtists(artist, apiKey);
      const resolved = db.resolveArtistNamesForDJ(rawNames);
      res.json({ artists: resolved });
    } catch (_) {
      res.json({ artists: [] });
    }
  });

  mstream.post('/api/v1/lastfm/test-login', async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required(),
      password: Joi.string().required()
    });
    joiValidate(schema, req.body);

    const token = crypto.createHash('md5').update(req.body.username + crypto.createHash('md5').update(req.body.password, 'utf8').digest('hex'), 'utf8').digest('hex');
    const cryptoString = `api_key${config.program.lastFM.apiKey}authToken${token}methodauth.getMobileSessionusername${req.body.username}${config.program.lastFM.apiSecret}`;
    const hash = crypto.createHash('md5').update(cryptoString, 'utf8').digest('hex');

    const lastfmRes = await fetch(
      `http://ws.audioscrobbler.com/2.0/?method=auth.getMobileSession&username=${req.body.username}&authToken=${token}&api_key=${config.program.lastFM.apiKey}&api_sig=${hash}`
    );
    if (!lastfmRes.ok) {
      throw new Error(`last.fm test-login returned ${lastfmRes.status}`);
    }
    res.json({});
  });
}

export function reset() {
  Scrobbler.reset();
}
