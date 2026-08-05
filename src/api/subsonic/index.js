/**
 * Subsonic REST API — Phase 1.
 *
 * Mounts `/rest/<method>` routes on the main Express app with Subsonic-style
 * authentication (see `./auth.js`) and envelope responses (see `./response.js`).
 *
 * All routes sit *before* the main mStream auth wall — they do their own
 * auth via Subsonic credentials and populate `req.user` on success. Routes
 * that fall through to query-string username + plaintext password, or to an
 * API key, never see mStream's JWT cookie.
 *
 * Clients dispatch by method name, either as the path (`/rest/ping`) or with
 * Subsonic's historical `.view` suffix (`/rest/ping.view`). Both are accepted.
 */

import winston from 'winston';
import { subsonicAuth } from './auth.js';
import { SubErr } from './response.js';
import * as H from './handlers.js';

// Map Subsonic method names to handler functions. Keep this flat — adding a
// new endpoint is a one-line change. Exported (via `listImplementedMethods`)
// for the admin-panel "X of Y implemented" card.
const METHODS = {
  // System
  ping:              H.ping,
  getLicense:        H.getLicense,
  getMusicFolders:   H.getMusicFolders,
  getOpenSubsonicExtensions: H.getOpenSubsonicExtensions,
  tokenInfo:                 H.tokenInfo,

  // Browsing
  getIndexes:        H.getIndexes,
  getMusicDirectory: H.getMusicDirectory,
  getArtists:        H.getArtists,
  getArtist:         H.getArtist,
  getAlbum:          H.getAlbum,
  getSong:           H.getSong,
  getGenres:         H.getGenres,
  getArtistInfo:     H.getArtistInfo,
  getArtistInfo2:    H.getArtistInfo2,
  getAlbumInfo:      H.getAlbumInfo,
  getAlbumInfo2:     H.getAlbumInfo2,
  getTopSongs:       H.getTopSongs,
  getSimilarSongs:   H.getSimilarSongs,
  getSimilarSongs2:  H.getSimilarSongs2,

  // Media
  getCoverArt:       H.getCoverArt,
  stream:            H.stream,
  download:          H.download,
  getAvatar:         H.getAvatar,

  // Search
  search:            H.search,
  search2:           H.search2,
  search3:           H.search3,

  // Phase 2 — scrobble / favourites
  scrobble:          H.scrobble,
  star:              H.star,
  unstar:            H.unstar,
  setRating:         H.setRating,
  getStarred:        H.getStarred,
  getStarred2:       H.getStarred2,

  // Phase 2 — album/song lists
  getAlbumList:      H.getAlbumList,
  getAlbumList2:     H.getAlbumList2,
  getRandomSongs:    H.getRandomSongs,
  getSongsByGenre:   H.getSongsByGenre,

  // Phase 2 — playlists
  getPlaylists:      H.getPlaylists,
  getPlaylist:       H.getPlaylist,
  createPlaylist:    H.createPlaylist,
  updatePlaylist:    H.updatePlaylist,
  deletePlaylist:    H.deletePlaylist,

  // Phase 3 — user management
  getUser:           H.getUser,
  getUsers:          H.getUsers,
  createUser:        H.createUser,
  updateUser:        H.updateUser,
  deleteUser:        H.deleteUser,
  changePassword:    H.changePassword,

  // Phase 3 — now playing / scanning
  getNowPlaying:     H.getNowPlaying,
  getScanStatus:     H.getScanStatus,
  startScan:         H.startScan,

  // Phase 3 — shares / bookmarks / play queue
  getShares:         H.getShares,
  createShare:       H.createShare,
  updateShare:       H.updateShare,
  deleteShare:       H.deleteShare,
  getBookmarks:      H.getBookmarks,
  createBookmark:    H.createBookmark,
  deleteBookmark:    H.deleteBookmark,
  getPlayQueue:      H.getPlayQueue,
  savePlayQueue:     H.savePlayQueue,

  // Phase 3 — Tier 3 explicit stubs / declines
  getInternetRadioStations: H.getInternetRadioStations,
  getPodcasts:       H.getPodcasts,
  getNewestPodcasts: H.getNewestPodcasts,
  getLyrics:         H.getLyrics,
  getLyricsBySongId: H.getLyricsBySongId,
  jukeboxControl:    H.jukeboxControl,
};

// Names of every implemented Subsonic method. Used by the admin panel
// to show "N methods implemented" and by docs/tests that enumerate the
// server surface. Sorted so the list is stable regardless of object
// literal iteration order.
export function listImplementedMethods() {
  return Object.keys(METHODS).sort();
}

// Per-method implementation status. Used by the admin panel to render
// Full / Stub badges alongside the method name so an operator can tell
// at a glance which endpoints actually DO something vs. which return a
// decline-shaped empty envelope.
//
//   'full' — real data, real behaviour
//   'stub' — well-formed response but always empty (no backend feature)
//
// Missing entries default to 'full' — add a row here when you land a
// new stub so the card stays accurate. Declined-at-the-router methods
// (returning error 70 because they're not in METHODS) never reach the
// admin card so they don't need a status here.
const METHOD_STATUS = {
  // Mood boards / catalogue features we deliberately don't implement;
  // the handler returns an empty envelope so clients don't error out.
  getInternetRadioStations: 'stub',
  getPodcasts:              'stub',
  getNewestPodcasts:        'stub',
  getArtistInfo:            'stub',
  getArtistInfo2:           'stub',
  getAlbumInfo:             'stub',
  getAlbumInfo2:            'stub',
  getTopSongs:              'stub',
  getSimilarSongs:          'stub',
  getSimilarSongs2:         'stub',
  getAvatar:                'stub',
  // V19: lyrics went from 'stub' to 'full' once the scanner extracts
  // embedded tags + sidecars and the handler serves real
  // structuredLyrics entries. Kept here explicitly so a future editor
  // auditing this table sees the move.
  getLyrics:                'full',
  getLyricsBySongId:        'full',
};

/**
 * Returns `[{ name, status }]` for every implemented method, where
 * `status` is one of 'full' | 'stub'. Consumed by the admin panel's
 * API-surface card.
 */
export function methodStatusTable() {
  return listImplementedMethods().map(name => ({
    name,
    status: METHOD_STATUS[name] || 'full',
  }));
}

export function setup(mstream) {
  // Runs once per boot for whichever mode mounts the surface (same-port
  // via server.js, separate-port via subsonic-server.js) — never when the
  // mode is 'disabled', so a server that has not opted in stays silent.
  winston.warn(
    '[subsonic] The Subsonic API is DEPRECATED and will be removed in a future '
    + 'release once the first-party mStream apps are available — development '
    + 'focus is on the first-party apps and their iroh-based Quick Connect. '
    + 'If you rely on the Subsonic API, please say so: '
    + 'https://github.com/IrosTheBeggar/mStream/issues (see docs/subsonic-deprecation.md)');

  // Single handler for both `/rest/:method` and `/rest/:method.view`. We
  // normalise the method name (stripping any ".view"), look it up in the
  // METHODS table, authenticate, and dispatch.
  const handle = async (req, res) => {
    const raw = String(req.params.method || '').replace(/\.view$/i, '');
    const fn = METHODS[raw];
    if (!fn) {
      // Subsonic spec has no dedicated "unknown method" code; code 70
      // ("not found") is what Navidrome / Gonic use and lets clients
      // distinguish a truly-broken endpoint from a generic backend
      // failure (code 0).
      return SubErr.NOT_FOUND(req, res, `Subsonic method "${raw}"`);
    }
    try {
      await subsonicAuth(req, res, () => fn(req, res));
    } catch (err) {
      // Authoritative error path — should be rare; subsonicAuth handles its
      // own failures. If a handler throws synchronously we surface it here.
      req.app?.get?.('logger')?.error?.('[subsonic] unhandled', { stack: err });
      if (!res.headersSent) { SubErr.GENERIC(req, res, 'Internal server error.'); }
    }
  };

  // Subsonic supports both GET and POST on every endpoint; clients pick
  // based on whether they're sending a large `songId` list etc. HEAD is
  // required by some clients to probe stream size before playback.
  mstream.get( '/rest/:method', handle);
  mstream.post('/rest/:method', handle);
  mstream.head('/rest/:method', handle);
}
