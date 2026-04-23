import express from 'express';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { getBaseUrl } from '../dlna/ssdp.js';
import { timeSeekMiddleware } from '../dlna/time-seek.js';

// ── Mutable state ────────────────────────────────────────────────────────────

// SystemUpdateID increments each time the library changes (e.g. scan completes).
// Control points use it to decide whether to invalidate their caches.
let systemUpdateID = 1;

// GENA subscribers, keyed by SID. Each entry holds the service it subscribed
// to, its callback URLs, expiry, and a per-subscription event sequence number.
const subscribers = new Map();

// Hard upper bound on RequestedCount for Browse/Search. DIDL responses grow
// roughly linearly in number of items; this keeps a single response from
// consuming excessive memory (~5MB at 512 bytes/item and this cap).
const MAX_BROWSE_COUNT = 10000;

// Hard cap on concurrent GENA subscribers. Each entry is tiny but we still
// don't want a malicious client to grow the Map without bound by SUBSCRIBEing
// repeatedly without UNSUBSCRIBEing.
const MAX_SUBSCRIBERS = 256;

// Build a Map<library_id, library> for O(1) lookups inside track loops.
function libraryIndex(libraries) {
  const m = new Map();
  for (const lib of libraries) { m.set(lib.id, lib); }
  return m;
}

// ── XML / SOAP helpers ───────────────────────────────────────────────────────

// Characters forbidden in XML 1.0 content: C0 control chars except TAB, LF, CR.
// Sloppy ID3 tags sometimes include stray bytes here; stripping them keeps the
// DIDL well-formed for strict renderers. Control chars in the regex are
// intentional (that's what we're filtering).
// eslint-disable-next-line no-control-regex
const XML_INVALID_CTRL = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

// XML 1.0 also forbids lone surrogate halves (U+D800–U+DFFF that aren't part
// of a valid pair) and the two non-characters U+FFFE / U+FFFF. JS strings are
// UTF-16, so a mojibake-ridden ID3 tag can easily contain a stray 0xD800 that
// would produce `&#xD800;` downstream and crash strict parsers. We drop them.
const XML_LONE_HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g;
const XML_LONE_LOW_SURROGATE = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const XML_NONCHARS = /[\uFFFE\uFFFF]/g;

function xmlEscape(str) {
  if (str == null) { return ''; }
  return String(str)
    .replace(XML_INVALID_CTRL, '')
    .replace(XML_LONE_HIGH_SURROGATE, '')
    .replace(XML_LONE_LOW_SURROGATE, '')
    .replace(XML_NONCHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Reverse of xmlEscape — converts XML entities back to raw characters so
// field values (especially SearchCriteria) reflect what the client meant.
function xmlUnescape(str) {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractSoapField(body, field) {
  const m = body.match(new RegExp(`<(?:[^:>]+:)?${field}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]+:)?${field}>`, 'i'));
  return m ? xmlUnescape(m[1].trim()) : '';
}

function soapEnvelope(serviceNs, actionName, innerXml) {
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${actionName} xmlns:u="${serviceNs}">
      ${innerXml}
    </u:${actionName}>
  </s:Body>
</s:Envelope>`;
}

function soapError(code, description) {
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <s:Fault>
      <faultcode>s:Client</faultcode>
      <faultstring>UPnPError</faultstring>
      <detail>
        <UPnPError xmlns="urn:schemas-upnp-org:control-1-0">
          <errorCode>${code}</errorCode>
          <errorDescription>${xmlEscape(description)}</errorDescription>
        </UPnPError>
      </detail>
    </s:Fault>
  </s:Body>
</s:Envelope>`;
}

function sendXml(res, body, status = 200) {
  res.status(status).set('Content-Type', 'text/xml; charset="utf-8"').send(body);
}

// ── Duration / MIME helpers ──────────────────────────────────────────────────

function formatDuration(secs) {
  if (!secs) { return undefined; }
  // Work in integer milliseconds to avoid floating-point carry (e.g. 59.9996s rounding to "60.000")
  const totalMs = Math.round(secs * 1000);
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = (totalMs % 60000) / 1000;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

// filepath segments → URL path (forward slashes, percent-encoded)
function filePathToUrlPath(fp) {
  return fp
    .split(/[\\/]/)
    .map(seg => encodeURIComponent(seg))
    .join('/');
}

const MIME_MAP = {
  mp3:  { mime: 'audio/mpeg', dlnaProfile: 'MP3' },
  flac: { mime: 'audio/flac', dlnaProfile: 'FLAC' },
  wav:  { mime: 'audio/wav',  dlnaProfile: 'WAV' },
  ogg:  { mime: 'audio/ogg',  dlnaProfile: null },
  aac:  { mime: 'audio/mp4',  dlnaProfile: 'AAC_ISO' },
  m4a:  { mime: 'audio/mp4',  dlnaProfile: 'AAC_ISO' },
  m4b:  { mime: 'audio/mp4',  dlnaProfile: 'AAC_ISO' },
  opus: { mime: 'audio/opus', dlnaProfile: null },
};
const DEFAULT_MIME = { mime: 'application/octet-stream', dlnaProfile: null };
const DLNA_FLAGS = '01500000000000000000000000000000';

function protocolInfo(format) {
  const info = MIME_MAP[(format || '').toLowerCase()] || DEFAULT_MIME;
  // DLNA.ORG_OP=11: bit 0 (range/byte-seek) + bit 1 (time-seek) both set.
  // Byte-seek is served by express.static; time-seek via the TimeSeekRange
  // middleware that transcodes from the requested offset using ffmpeg.
  const parts = ['DLNA.ORG_OP=11', 'DLNA.ORG_CI=0', `DLNA.ORG_FLAGS=${DLNA_FLAGS}`];
  if (info.dlnaProfile) { parts.unshift(`DLNA.ORG_PN=${info.dlnaProfile}`); }
  return `http-get:*:${info.mime}:${parts.join(';')}`;
}

// ── DIDL-Lite builders ───────────────────────────────────────────────────────

function didlWrapper(items) {
  return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"
  xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">${items}</DIDL-Lite>`;
}

function containerArtXml(albumArtFile) {
  if (!albumArtFile) return '';
  const base = getBaseUrl();
  return `\n    <upnp:albumArtURI dlna:profileID="JPEG_TN">${xmlEscape(`${base}/album-art/${encodeURIComponent(albumArtFile)}`)}</upnp:albumArtURI>`;
}

function libraryContainer(lib, parentId, childCount) {
  // Libraries of type `audio-books` advertise as
  // `object.container.album.audioBook` so bookmark-capable renderers
  // (Plex, Sonos, some TVs) light up their resume-playback UI. Music
  // libraries stay on `storageFolder` — promoting them to album.audioBook
  // would make every library look like a single book, which breaks nested
  // browsing on strict renderers.
  const cls = lib.type === 'audio-books'
    ? 'object.container.album.audioBook'
    : 'object.container.storageFolder';
  return `
  <container id="lib-${lib.id}" parentID="${xmlEscape(parentId)}" restricted="1" childCount="${childCount}">
    <dc:title>${xmlEscape(lib.name)}</dc:title>
    <upnp:class>${cls}</upnp:class>
  </container>`;
}

function dirContainer(libId, relPath, parentId, childCount) {
  const name = relPath.split('/').pop();
  return `
  <container id="dir-${libId}-${encodeRelPath(relPath)}" parentID="${xmlEscape(parentId)}" restricted="1" childCount="${childCount}">
    <dc:title>${xmlEscape(name)}</dc:title>
    <upnp:class>object.container.storageFolder</upnp:class>
  </container>`;
}

function artistContainer(libId, artist, parentId) {
  return `
  <container id="artist-${libId}-${artist.id}" parentID="${xmlEscape(parentId)}" restricted="1" childCount="${artist.album_count}">${containerArtXml(artist.album_art_file)}
    <dc:title>${xmlEscape(artist.name)}</dc:title>
    <upnp:class>object.container.person.musicArtist</upnp:class>
  </container>`;
}

function albumContainer(libId, album, parentId) {
  return `
  <container id="album-${libId}-${album.id}" parentID="${xmlEscape(parentId)}" restricted="1" childCount="${album.track_count}">${containerArtXml(album.album_art_file)}
    <dc:title>${xmlEscape(album.name)}</dc:title>
    <upnp:class>object.container.album.musicAlbum</upnp:class>
  </container>`;
}

function genreContainer(libId, genre, parentId) {
  // genre.name is null for tracks with no genre tag; encode null as empty string sentinel
  const encodedName = encodeRelPath(genre.name ?? '');
  const displayName = genre.name ?? 'Unknown Genre';
  return `
  <container id="genre-${libId}-${encodedName}" parentID="${xmlEscape(parentId)}" restricted="1" childCount="${genre.artist_count}">${containerArtXml(genre.album_art_file)}
    <dc:title>${xmlEscape(displayName)}</dc:title>
    <upnp:class>object.container.genre.musicGenre</upnp:class>
  </container>`;
}

function genreArtistContainer(libId, artist, parentId, genre) {
  return `
  <container id="gartist-${libId}-${artist.id}-${encodeRelPath(genre)}" parentID="${xmlEscape(parentId)}" restricted="1" childCount="${artist.album_count}">${containerArtXml(artist.album_art_file)}
    <dc:title>${xmlEscape(artist.name)}</dc:title>
    <upnp:class>object.container.person.musicArtist</upnp:class>
  </container>`;
}

function playlistsContainer(parentId, childCount) {
  return `
  <container id="playlists" parentID="${xmlEscape(parentId)}" restricted="1" childCount="${childCount}">
    <dc:title>Playlists</dc:title>
    <upnp:class>object.container</upnp:class>
  </container>`;
}

function playlistContainer(playlist, parentId) {
  return `
  <container id="playlist-${playlist.id}" parentID="${xmlEscape(parentId)}" restricted="1" childCount="${playlist.track_count}">
    <dc:title>${xmlEscape(playlist.name)}</dc:title>
    <upnp:class>object.container.playlistContainer</upnp:class>
  </container>`;
}

function recentContainer(parentId, childCount) {
  return `
  <container id="recent" parentID="${xmlEscape(parentId)}" restricted="1" childCount="${childCount}">
    <dc:title>Recently Added</dc:title>
    <upnp:class>object.container</upnp:class>
  </container>`;
}

// Standard DLNA-style multi-view layout: each library exposes six sibling
// sub-containers (Folders, Artists, Album Artists, Albums, Genres, All Tracks)
// simultaneously. The `dlna.browse` config picks which one is listed first —
// clients that auto-drill into the first child respect the user's preference.
const VIEW_ORDER_BY_MODE = {
  dirs:   ['folders', 'artists', 'albumartists', 'albums', 'genres', 'tracks'],
  artist: ['artists', 'albumartists', 'albums', 'genres', 'folders', 'tracks'],
  album:  ['albums', 'albumartists', 'artists', 'genres', 'folders', 'tracks'],
  genre:  ['genres', 'artists', 'albumartists', 'albums', 'folders', 'tracks'],
  flat:   ['tracks', 'folders', 'artists', 'albumartists', 'albums', 'genres'],
};
const VIEW_TITLES = {
  folders:      'Folders',
  artists:      'Artists',
  albumartists: 'Album Artists',
  albums:       'Albums',
  genres:       'Genres',
  tracks:       'All Tracks',
};
const VIEW_UPNP_CLASS = {
  folders:      'object.container.storageFolder',
  artists:      'object.container',
  albumartists: 'object.container',
  albums:       'object.container',
  genres:       'object.container',
  tracks:       'object.container',
};

function viewContainer(libId, view, childCount) {
  return `
  <container id="${view}-${libId}" parentID="lib-${libId}" restricted="1" childCount="${childCount}">
    <dc:title>${xmlEscape(VIEW_TITLES[view])}</dc:title>
    <upnp:class>${VIEW_UPNP_CLASS[view]}</upnp:class>
  </container>`;
}

function libraryViewContainers(libId) {
  const mode = config.program.dlna.browse || 'dirs';
  const order = VIEW_ORDER_BY_MODE[mode] || VIEW_ORDER_BY_MODE.dirs;
  // Counts are required per UPnP. Folders needs a filepath scan — the others
  // are fast aggregate queries.
  const allTracks = getAllLibraryTracks(libId);
  const { dirs: rootDirs, items: rootItems } = dirChildren(allTracks, '');
  const counts = {
    folders:      rootDirs.length + rootItems.length,
    artists:      getLibraryArtists(libId).length,
    albumartists: getLibraryAlbumArtists(libId).length,
    albums:       getLibraryAlbums(libId).length,
    genres:       getLibraryGenres(libId).length,
    tracks:       allTracks.length,
  };
  return order.map(v => viewContainer(libId, v, counts[v]));
}

// ── Music root & smart containers ────────────────────────────────────────────

const SMART_LIMIT = 200;

function simpleContainer(id, parentId, title, childCount, cls = 'object.container') {
  return `
  <container id="${xmlEscape(id)}" parentID="${xmlEscape(parentId)}" restricted="1" childCount="${childCount}">
    <dc:title>${xmlEscape(title)}</dc:title>
    <upnp:class>${cls}</upnp:class>
  </container>`;
}

function yearContainer(year, childCount) {
  return `
  <container id="year-${year}" parentID="years" restricted="1" childCount="${childCount}">
    <dc:title>${year}</dc:title>
    <upnp:class>object.container</upnp:class>
  </container>`;
}

// `lib` is a library-descriptor with at least `{name, type}`. Callers either
// pass the full libraries row or a lightweight `{name: ..., type: ...}` blob
// (e.g. playlist rows where we only joined the two columns).
function trackItem(track, lib, parentId) {
  const base = getBaseUrl();
  const mediaUrl = `${base}/media/${encodeURIComponent(lib.name)}/${filePathToUrlPath(track.filepath)}`;

  let artXml = '';
  if (track.album_art_file) {
    artXml = `\n    <upnp:albumArtURI dlna:profileID="JPEG_TN">${xmlEscape(`${base}/album-art/${encodeURIComponent(track.album_art_file)}`)}</upnp:albumArtURI>`;
  }

  const duration = formatDuration(track.duration);
  const durationAttr = duration ? ` duration="${duration}"` : '';
  const sizeAttr = track.file_size ? ` size="${track.file_size}"` : '';

  // dc:date: renderers use this for display and sort-by-date. upnp:originalYear
  // is the Samsung/LG variant that a few clients prefer — emitting both is safe.
  const yearXml = track.year
    ? `\n    <dc:date>${track.year}-01-01</dc:date>\n    <upnp:originalYear>${track.year}</upnp:originalYear>`
    : '';

  // Tracks from `type: 'audio-books'` libraries advertise as
  // `object.item.audioItem.audioBook` so resume-playback-capable renderers
  // (Plex, Sonos, some TVs) actually enable the resume UI. Advertising it
  // only on the parent container (which we do) isn't enough for most
  // renderers — they key their bookmark tracking off the track class.
  const itemClass = lib.type === 'audio-books'
    ? 'object.item.audioItem.audioBook'
    : 'object.item.audioItem.musicTrack';

  return `
  <item id="track-${track.id}" parentID="${xmlEscape(parentId)}" restricted="1">
    <dc:title>${xmlEscape(track.title || path.basename(track.filepath))}</dc:title>
    <dc:creator>${xmlEscape(track.artist_name)}</dc:creator>
    <upnp:artist>${xmlEscape(track.artist_name)}</upnp:artist>
    <upnp:album>${xmlEscape(track.album_name)}</upnp:album>${track.track_number ? `\n    <upnp:originalTrackNumber>${track.track_number}</upnp:originalTrackNumber>` : ''}${track.genre ? `\n    <upnp:genre>${xmlEscape(track.genre)}</upnp:genre>` : ''}${yearXml}${artXml}
    <upnp:class>${itemClass}</upnp:class>
    <res protocolInfo="${xmlEscape(protocolInfo(track.format))}"${durationAttr}${sizeAttr}>${xmlEscape(mediaUrl)}</res>
  </item>`;
}

// ── DB queries ───────────────────────────────────────────────────────────────

function getLibraryTrackCount(libraryId) {
  const row = db.getDB()
    .prepare('SELECT COUNT(*) AS n FROM tracks WHERE library_id = ?')
    .get(libraryId);
  return row ? row.n : 0;
}

function getLibraryTracks(libraryId, start, count, orderBy = 'al.name, t.disc_number, t.track_number, t.title') {
  const limit = count > 0 ? count : -1; // SQLite: -1 = no limit
  return db.getDB().prepare(`
    SELECT t.id, t.filepath, t.title, t.track_number, t.duration, t.format,
           t.file_size, t.genre, t.album_art_file, t.year,
           a.name AS artist_name,
           al.name AS album_name
    FROM tracks t
    LEFT JOIN artists a  ON t.artist_id = a.id
    LEFT JOIN albums al  ON t.album_id  = al.id
    WHERE t.library_id = ?
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(libraryId, limit, start);
}

function getAllLibraryTracks(libraryId) {
  return db.getDB().prepare(`
    SELECT t.id, t.filepath, t.title, t.track_number, t.duration, t.format,
           t.file_size, t.genre, t.album_art_file, t.year,
           a.name AS artist_name,
           al.name AS album_name
    FROM tracks t
    LEFT JOIN artists a  ON t.artist_id = a.id
    LEFT JOIN albums al  ON t.album_id  = al.id
    WHERE t.library_id = ?
    ORDER BY t.filepath
  `).all(libraryId);
}

function getLibraryArtists(libraryId) {
  return db.getDB().prepare(`
    SELECT COALESCE(t.artist_id, 0) AS id,
           COALESCE(a.name, 'Unknown Artist') AS name,
           COUNT(DISTINCT COALESCE(t.album_id, 0)) AS album_count,
           (SELECT t2.album_art_file FROM tracks t2
            WHERE t2.library_id = t.library_id AND t2.artist_id IS t.artist_id
              AND t2.album_art_file IS NOT NULL LIMIT 1) AS album_art_file
    FROM tracks t
    LEFT JOIN artists a ON t.artist_id = a.id
    WHERE t.library_id = ?
    GROUP BY COALESCE(t.artist_id, 0)
    ORDER BY COALESCE(a.name, '') COLLATE NOCASE
  `).all(libraryId);
}

// Targeted single-row lookups for BrowseMetadata. artistId=0 means "Unknown
// Artist" (tracks with NULL artist_id); returns null if no matching tracks.
function getArtistById(libraryId, artistId) {
  const artistCond = artistId === 0 ? 't.artist_id IS NULL' : 't.artist_id = ?';
  const params = artistId === 0 ? [libraryId] : [libraryId, artistId];
  const row = db.getDB().prepare(`
    SELECT COALESCE(t.artist_id, 0) AS id,
           COALESCE(a.name, 'Unknown Artist') AS name,
           COUNT(DISTINCT COALESCE(t.album_id, 0)) AS album_count,
           MIN(t.album_art_file) AS album_art_file,
           COUNT(*) AS _n
    FROM tracks t
    LEFT JOIN artists a ON t.artist_id = a.id
    WHERE t.library_id = ? AND ${artistCond}
  `).get(...params);
  if (!row || row._n === 0) return null;
  delete row._n;
  return row;
}

function getArtistAlbums(libraryId, artistId) {
  if (artistId === 0) {
    return db.getDB().prepare(`
      SELECT COALESCE(t.album_id, 0) AS id,
             COALESCE(al.name, 'Unknown Album') AS name,
             COUNT(*) AS track_count,
             COALESCE(al.album_art_file, MIN(t.album_art_file)) AS album_art_file
      FROM tracks t
      LEFT JOIN albums al ON t.album_id = al.id
      WHERE t.library_id = ? AND t.artist_id IS NULL
      GROUP BY COALESCE(t.album_id, 0)
      ORDER BY COALESCE(al.name, '') COLLATE NOCASE
    `).all(libraryId);
  }
  return db.getDB().prepare(`
    SELECT COALESCE(t.album_id, 0) AS id,
           COALESCE(al.name, 'Unknown Album') AS name,
           COUNT(*) AS track_count,
           COALESCE(al.album_art_file, MIN(t.album_art_file)) AS album_art_file
    FROM tracks t
    LEFT JOIN albums al ON t.album_id = al.id
    WHERE t.library_id = ? AND t.artist_id = ?
    GROUP BY COALESCE(t.album_id, 0)
    ORDER BY COALESCE(al.name, '') COLLATE NOCASE
  `).all(libraryId, artistId);
}

function getAlbumTracks(libraryId, albumId) {
  if (albumId === 0) {
    return db.getDB().prepare(`
      SELECT t.id, t.filepath, t.title, t.track_number, t.duration, t.format,
             t.file_size, t.genre, t.album_art_file, t.year,
             a.name AS artist_name, al.name AS album_name
      FROM tracks t
      LEFT JOIN artists a  ON t.artist_id = a.id
      LEFT JOIN albums  al ON t.album_id  = al.id
      WHERE t.library_id = ? AND t.album_id IS NULL
      ORDER BY t.disc_number, t.track_number, t.title
    `).all(libraryId);
  }
  return db.getDB().prepare(`
    SELECT t.id, t.filepath, t.title, t.track_number, t.duration, t.format,
           t.file_size, t.genre, t.album_art_file, t.year,
           a.name AS artist_name, al.name AS album_name
    FROM tracks t
    LEFT JOIN artists a  ON t.artist_id = a.id
    LEFT JOIN albums  al ON t.album_id  = al.id
    WHERE t.library_id = ? AND t.album_id = ?
    ORDER BY t.disc_number, t.track_number, t.title
  `).all(libraryId, albumId);
}

function getLibraryAlbums(libraryId) {
  return db.getDB().prepare(`
    SELECT COALESCE(t.album_id, 0) AS id,
           COALESCE(al.name, 'Unknown Album') AS name,
           COUNT(*) AS track_count,
           COALESCE(al.album_art_file, MIN(t.album_art_file)) AS album_art_file
    FROM tracks t
    LEFT JOIN albums al ON t.album_id = al.id
    WHERE t.library_id = ?
    GROUP BY COALESCE(t.album_id, 0)
    ORDER BY COALESCE(al.name, '') COLLATE NOCASE
  `).all(libraryId);
}

function getLibraryGenres(libraryId) {
  return db.getDB().prepare(`
    SELECT genre AS name,
           COUNT(DISTINCT COALESCE(t.artist_id, 0)) AS artist_count,
           MIN(t.album_art_file) AS album_art_file
    FROM tracks t
    WHERE library_id = ?
    GROUP BY genre
    ORDER BY COALESCE(genre, '') COLLATE NOCASE
  `).all(libraryId);
}

// genre='' means "Unknown Genre" (tracks with NULL genre).
function getGenreByName(libraryId, genre) {
  const cond = genre === '' ? 't.genre IS NULL' : 't.genre = ?';
  const params = genre === '' ? [libraryId] : [libraryId, genre];
  const row = db.getDB().prepare(`
    SELECT t.genre AS name,
           COUNT(DISTINCT COALESCE(t.artist_id, 0)) AS artist_count,
           MIN(t.album_art_file) AS album_art_file,
           COUNT(*) AS _n
    FROM tracks t
    WHERE t.library_id = ? AND ${cond}
  `).get(...params);
  if (!row || row._n === 0) return null;
  delete row._n;
  return row;
}

function getGenreArtists(libraryId, genre) {
  const isUnknown = genre === '';
  return db.getDB().prepare(`
    SELECT COALESCE(t.artist_id, 0) AS id,
           COALESCE(a.name, 'Unknown Artist') AS name,
           COUNT(DISTINCT COALESCE(t.album_id, 0)) AS album_count,
           MIN(t.album_art_file) AS album_art_file
    FROM tracks t
    LEFT JOIN artists a ON t.artist_id = a.id
    WHERE t.library_id = ? AND ${isUnknown ? 't.genre IS NULL' : 't.genre = ?'}
    GROUP BY COALESCE(t.artist_id, 0)
    ORDER BY COALESCE(a.name, '') COLLATE NOCASE
  `).all(...(isUnknown ? [libraryId] : [libraryId, genre]));
}

function getGenreArtistById(libraryId, genre, artistId) {
  const genreCond  = genre === '' ? 't.genre IS NULL' : 't.genre = ?';
  const artistCond = artistId === 0 ? 't.artist_id IS NULL' : 't.artist_id = ?';
  const params = [libraryId];
  if (genre !== '') params.push(genre);
  if (artistId !== 0) params.push(artistId);
  const row = db.getDB().prepare(`
    SELECT COALESCE(t.artist_id, 0) AS id,
           COALESCE(a.name, 'Unknown Artist') AS name,
           COUNT(DISTINCT COALESCE(t.album_id, 0)) AS album_count,
           MIN(t.album_art_file) AS album_art_file,
           COUNT(*) AS _n
    FROM tracks t
    LEFT JOIN artists a ON t.artist_id = a.id
    WHERE t.library_id = ? AND ${genreCond} AND ${artistCond}
  `).get(...params);
  if (!row || row._n === 0) return null;
  delete row._n;
  return row;
}

function getGenreArtistAlbums(libraryId, genre, artistId) {
  const genreCond  = genre === '' ? 't.genre IS NULL'    : 't.genre = ?';
  const artistCond = artistId === 0 ? 't.artist_id IS NULL' : 't.artist_id = ?';
  const params = [libraryId];
  if (genre !== '') params.push(genre);
  if (artistId !== 0)            params.push(artistId);
  return db.getDB().prepare(`
    SELECT COALESCE(t.album_id, 0) AS id,
           COALESCE(al.name, 'Unknown Album') AS name,
           COUNT(*) AS track_count,
           COALESCE(al.album_art_file, MIN(t.album_art_file)) AS album_art_file
    FROM tracks t
    LEFT JOIN albums al ON t.album_id = al.id
    WHERE t.library_id = ? AND ${genreCond} AND ${artistCond}
    GROUP BY COALESCE(t.album_id, 0)
    ORDER BY COALESCE(al.name, '') COLLATE NOCASE
  `).all(...params);
}

// ── Album-artist queries ────────────────────────────────────────────────────
// Uses albums.artist_id (the album-level artist) rather than tracks.artist_id,
// so compilation albums don't explode into dozens of single-album entries.

function getLibraryAlbumArtists(libraryId) {
  return db.getDB().prepare(`
    SELECT COALESCE(a.id, 0) AS id,
           COALESCE(a.name, 'Unknown Artist') AS name,
           COUNT(DISTINCT al.id) AS album_count,
           MIN(al.album_art_file) AS album_art_file
    FROM albums al
    LEFT JOIN artists a ON al.artist_id = a.id
    WHERE EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id AND t.library_id = ?)
    GROUP BY COALESCE(a.id, 0)
    ORDER BY COALESCE(a.name, '') COLLATE NOCASE
  `).all(libraryId);
}

function getAlbumArtistById(libraryId, artistId) {
  const row = db.getDB().prepare(`
    SELECT COALESCE(a.id, 0) AS id,
           COALESCE(a.name, 'Unknown Artist') AS name,
           COUNT(DISTINCT al.id) AS album_count,
           MIN(al.album_art_file) AS album_art_file,
           COUNT(*) AS _n
    FROM albums al
    LEFT JOIN artists a ON al.artist_id = a.id
    WHERE EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id AND t.library_id = ?)
      AND COALESCE(al.artist_id, 0) = ?
  `).get(libraryId, artistId);
  if (!row || row._n === 0) return null;
  delete row._n;
  return row;
}

function getAlbumArtistAlbums(libraryId, artistId) {
  return db.getDB().prepare(`
    SELECT al.id,
           COALESCE(al.name, 'Unknown Album') AS name,
           COUNT(t.id) AS track_count,
           COALESCE(al.album_art_file, MIN(t.album_art_file)) AS album_art_file
    FROM albums al
    JOIN tracks t ON t.album_id = al.id
    WHERE t.library_id = ? AND COALESCE(al.artist_id, 0) = ?
    GROUP BY al.id
    ORDER BY al.year, COALESCE(al.name, '') COLLATE NOCASE
  `).all(libraryId, artistId);
}

// ── Smart-container queries ─────────────────────────────────────────────────
// These aggregate across all users/libraries since DLNA has no auth context.

const SMART_TRACK_COLS = `
  t.id, t.filepath, t.title, t.track_number, t.duration, t.format,
  t.file_size, t.genre, t.album_art_file, t.year, t.library_id,
  a.name AS artist_name, al.name AS album_name
`;

function getRecentPlayedCount() {
  const row = db.getDB().prepare(`
    SELECT COUNT(DISTINCT t.id) AS n
    FROM tracks t
    JOIN user_metadata um ON um.track_hash = COALESCE(t.audio_hash, t.file_hash)
    WHERE um.last_played IS NOT NULL
  `).get();
  return Math.min(row?.n || 0, SMART_LIMIT);
}

function getRecentPlayedTracks(start, count) {
  const available = Math.max(0, SMART_LIMIT - start);
  const limit = count > 0 ? Math.min(count, available) : available;
  if (limit <= 0) return [];
  return db.getDB().prepare(`
    SELECT ${SMART_TRACK_COLS}, MAX(um.last_played) AS sort_key
    FROM tracks t
    JOIN user_metadata um ON um.track_hash = COALESCE(t.audio_hash, t.file_hash)
    LEFT JOIN artists a  ON t.artist_id = a.id
    LEFT JOIN albums  al ON t.album_id  = al.id
    WHERE um.last_played IS NOT NULL
    GROUP BY t.id
    ORDER BY sort_key DESC
    LIMIT ? OFFSET ?
  `).all(limit, start);
}

function getMostPlayedCount() {
  const row = db.getDB().prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT t.id FROM tracks t
      JOIN user_metadata um ON um.track_hash = COALESCE(t.audio_hash, t.file_hash)
      GROUP BY t.id
      HAVING SUM(um.play_count) > 0
    )
  `).get();
  return Math.min(row?.n || 0, SMART_LIMIT);
}

function getMostPlayedTracks(start, count) {
  const available = Math.max(0, SMART_LIMIT - start);
  const limit = count > 0 ? Math.min(count, available) : available;
  if (limit <= 0) return [];
  return db.getDB().prepare(`
    SELECT ${SMART_TRACK_COLS}, SUM(um.play_count) AS total_plays
    FROM tracks t
    JOIN user_metadata um ON um.track_hash = COALESCE(t.audio_hash, t.file_hash)
    LEFT JOIN artists a  ON t.artist_id = a.id
    LEFT JOIN albums  al ON t.album_id  = al.id
    GROUP BY t.id
    HAVING total_plays > 0
    ORDER BY total_plays DESC, t.title
    LIMIT ? OFFSET ?
  `).all(limit, start);
}

function getFavoriteCount() {
  const row = db.getDB().prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT t.id FROM tracks t
      JOIN user_metadata um ON um.track_hash = COALESCE(t.audio_hash, t.file_hash)
      GROUP BY t.id
      HAVING MAX(um.rating) >= 4
    )
  `).get();
  return row?.n || 0;
}

function getFavoriteTracks(start, count) {
  const limit = count > 0 ? count : -1;
  return db.getDB().prepare(`
    SELECT ${SMART_TRACK_COLS}, MAX(um.rating) AS top_rating
    FROM tracks t
    JOIN user_metadata um ON um.track_hash = COALESCE(t.audio_hash, t.file_hash)
    LEFT JOIN artists a  ON t.artist_id = a.id
    LEFT JOIN albums  al ON t.album_id  = al.id
    GROUP BY t.id
    HAVING top_rating >= 4
    ORDER BY top_rating DESC, a.name, al.name, t.disc_number, t.track_number
    LIMIT ? OFFSET ?
  `).all(limit, start);
}

function getShuffleCount() {
  const row = db.getDB().prepare('SELECT COUNT(*) AS n FROM tracks').get();
  return Math.min(row?.n || 0, SMART_LIMIT);
}

// Shuffle is re-rolled per request — no pagination semantics beyond "give me a
// random N tracks". Clients that browse page 2 get a different random slice;
// DLNA renderers typically ask for all at once with RequestedCount=0 so this
// works out in practice.
function getShuffleTracks(count) {
  const limit = Math.min(count > 0 ? count : SMART_LIMIT, SMART_LIMIT);
  return db.getDB().prepare(`
    SELECT ${SMART_TRACK_COLS}
    FROM tracks t
    LEFT JOIN artists a  ON t.artist_id = a.id
    LEFT JOIN albums  al ON t.album_id  = al.id
    ORDER BY RANDOM()
    LIMIT ?
  `).all(limit);
}

function getYears() {
  return db.getDB().prepare(`
    SELECT t.year AS year, COUNT(*) AS track_count
    FROM tracks t
    WHERE t.year IS NOT NULL AND t.year > 0
    GROUP BY t.year
    ORDER BY t.year DESC
  `).all();
}

function getYearTrackCount(year) {
  const row = db.getDB().prepare('SELECT COUNT(*) AS n FROM tracks WHERE year = ?').get(year);
  return row?.n || 0;
}

function getYearTracks(year, start, count) {
  const limit = count > 0 ? count : -1;
  return db.getDB().prepare(`
    SELECT ${SMART_TRACK_COLS}
    FROM tracks t
    LEFT JOIN artists a  ON t.artist_id = a.id
    LEFT JOIN albums  al ON t.album_id  = al.id
    WHERE t.year = ?
    ORDER BY a.name COLLATE NOCASE, al.name COLLATE NOCASE, t.disc_number, t.track_number, t.title
    LIMIT ? OFFSET ?
  `).all(year, limit, start);
}

function getAllPlaylists() {
  return db.getDB().prepare(`
    SELECT p.id, p.name, u.username, COUNT(pt.id) AS track_count
    FROM playlists p
    JOIN users u ON p.user_id = u.id
    LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
    GROUP BY p.id
    ORDER BY p.name COLLATE NOCASE
  `).all();
}

function getPlaylistById(playlistId) {
  return db.getDB().prepare(`
    SELECT p.id, p.name, u.username, COUNT(pt.id) AS track_count
    FROM playlists p
    JOIN users u ON p.user_id = u.id
    LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
    WHERE p.id = ?
    GROUP BY p.id
  `).get(playlistId);
}

function getPlaylistTracks(playlistId) {
  return db.getDB().prepare(`
    SELECT pt.id, pt.position,
           t.id AS track_id,
           CASE WHEN INSTR(pt.filepath, '/') > 0
                THEN SUBSTR(pt.filepath, INSTR(pt.filepath, '/') + 1)
                ELSE '' END AS rel_filepath,
           t.title, t.track_number, t.duration, t.format, t.file_size,
           t.genre, t.album_art_file, t.year,
           a.name AS artist_name, al.name AS album_name,
           l.name AS library_name, l.type AS library_type
    FROM playlist_tracks pt
    JOIN libraries l ON l.name = CASE
        WHEN INSTR(pt.filepath, '/') > 0 THEN SUBSTR(pt.filepath, 1, INSTR(pt.filepath, '/') - 1)
        ELSE pt.filepath
      END
    JOIN tracks t ON t.library_id = l.id
        AND t.filepath = CASE
            WHEN INSTR(pt.filepath, '/') > 0 THEN SUBSTR(pt.filepath, INSTR(pt.filepath, '/') + 1)
            ELSE '' END
    LEFT JOIN artists a  ON t.artist_id = a.id
    LEFT JOIN albums  al ON t.album_id  = al.id
    WHERE pt.playlist_id = ?
    ORDER BY pt.position
  `).all(playlistId);
}

function getRecentCount() {
  const total = db.getDB().prepare('SELECT COUNT(*) AS n FROM tracks').get()?.n || 0;
  return Math.min(total, RECENT_LIMIT);
}

function getRecentTracks(start, count) {
  const available = Math.max(0, RECENT_LIMIT - start);
  const limit = count > 0 ? Math.min(count, available) : available;
  if (limit <= 0) return [];
  return db.getDB().prepare(`
    SELECT t.id, t.filepath, t.title, t.track_number, t.duration, t.format,
           t.file_size, t.genre, t.album_art_file, t.year, t.library_id,
           a.name AS artist_name, al.name AS album_name
    FROM tracks t
    LEFT JOIN artists a  ON t.artist_id = a.id
    LEFT JOIN albums  al ON t.album_id  = al.id
    ORDER BY t.created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, start);
}

// ── Directory-tree helpers ───────────────────────────────────────────────────
// filepath in DB is already relative to library root, forward-slash separated.

function encodeRelPath(p) { return Buffer.from(p).toString('base64url'); }
function decodeRelPath(s) { return Buffer.from(s, 'base64url').toString('utf8'); }

// Returns immediate subdirectory names and direct-child track items for a given prefix.
function dirChildren(tracks, prefix) {
  const prefixSlash = prefix ? prefix + '/' : '';
  const dirSet = new Set();
  const items = [];
  for (const t of tracks) {
    if (prefixSlash && !t.filepath.startsWith(prefixSlash)) continue;
    const remainder = t.filepath.slice(prefixSlash.length);
    if (!remainder) continue;
    const slash = remainder.indexOf('/');
    if (slash === -1) items.push(t);
    else dirSet.add(remainder.slice(0, slash));
  }
  return { dirs: [...dirSet].sort(), items };
}

function dirChildCount(tracks, prefix) {
  const { dirs, items } = dirChildren(tracks, prefix);
  return dirs.length + items.length;
}

function paginate(arr, start, count) {
  return count > 0 ? arr.slice(start, start + count) : arr.slice(start);
}

const RECENT_LIMIT = 200;

// ── Sort helpers ─────────────────────────────────────────────────────────────

const SORT_PROP_MAP = {
  'dc:title':                 't.title',
  'dc:creator':               'a.name',
  'upnp:artist':              'a.name',
  'upnp:album':               'al.name',
  'upnp:originalTrackNumber': 't.track_number',
  'upnp:genre':               't.genre',
  'dc:date':                  't.year',
  'upnp:originalYear':        't.year',
  'res@duration':             't.duration',
  'res@size':                 't.file_size',
  '@refID':                   't.id',
};

function parseSortCriteria(sortStr) {
  if (!sortStr || !sortStr.trim()) return [];
  return sortStr.split(',')
    .map(s => s.trim()).filter(Boolean)
    .map(s => {
      const dir = s[0] === '-' ? 'DESC' : 'ASC';
      const prop = s.replace(/^[+-]/, '');
      const col = SORT_PROP_MAP[prop];
      return col ? { col, dir } : null;
    })
    .filter(Boolean);
}

function buildOrderBy(sortTerms, defaultOrder) {
  if (!sortTerms || !sortTerms.length) return defaultOrder;
  return sortTerms.map(t => `${t.col} ${t.dir} NULLS LAST`).join(', ');
}

// ── Browse handler ───────────────────────────────────────────────────────────

const CDS_NS = 'urn:schemas-upnp-org:service:ContentDirectory:1';

function handleBrowse(body, res) {
  const objectId   = extractSoapField(body, 'ObjectID');
  const browseFlag = extractSoapField(body, 'BrowseFlag');
  const startIdx   = Math.max(0, parseInt(extractSoapField(body, 'StartingIndex') || '0', 10) || 0);
  // UPnP: RequestedCount=0 means "as many as the server wants to return".
  // We treat that as MAX_BROWSE_COUNT so one request can't generate an
  // unbounded response. Explicit counts are likewise capped.
  const rawCount   = Math.max(0, parseInt(extractSoapField(body, 'RequestedCount') || '0', 10) || 0);
  const reqCount   = rawCount === 0 ? MAX_BROWSE_COUNT : Math.min(rawCount, MAX_BROWSE_COUNT);
  const sortTerms  = parseSortCriteria(extractSoapField(body, 'SortCriteria'));

  const libraries = db.getAllLibraries();
  const libById = libraryIndex(libraries);

  // ── Root container — wraps everything in a single "Music" child ──────────
  // Matches the layout of MiniDLNA / Plex / Jellyfin: renderers expect a
  // top-level category folder, not libraries scattered at root.
  if (objectId === '0') {
    if (browseFlag === 'BrowseMetadata') {
      const didl = didlWrapper(`
  <container id="0" parentID="-1" restricted="1" childCount="1">
    <dc:title>${xmlEscape(config.program.dlna.name)}</dc:title>
    <upnp:class>object.container</upnp:class>
  </container>`);
      return sendBrowseResponse(res, didl, 1, 1);
    }
    const music = simpleContainer('music', '0', 'Music', libraries.length + 7);
    const slice = paginate([music], startIdx, reqCount);
    return sendBrowseResponse(res, didlWrapper(slice.join('')), slice.length, 1);
  }

  // ── Music container — libraries + virtual "Recently Added/Played/..." ────
  if (objectId === 'music') {
    // N libraries + 7 fixed virtual containers (Recently Added, Recently
    // Played, Most Played, Favorites, Shuffle, By Year, Playlists).
    const musicTotal = libraries.length + 7;
    if (browseFlag === 'BrowseMetadata') {
      return sendBrowseResponse(res, didlWrapper(simpleContainer('music', '0', 'Music', musicTotal)), 1, 1);
    }
    const musicChildren = [
      ...libraries.map(lib => libraryContainer(lib, 'music', getLibraryTrackCount(lib.id))),
      recentContainer('music', getRecentCount()),
      simpleContainer('recentplayed', 'music', 'Recently Played', getRecentPlayedCount()),
      simpleContainer('mostplayed',   'music', 'Most Played',     getMostPlayedCount()),
      simpleContainer('favorites',    'music', 'Favorites',       getFavoriteCount()),
      simpleContainer('shuffle',      'music', 'Shuffle',         getShuffleCount()),
      simpleContainer('years',        'music', 'By Year',         getYears().length),
      playlistsContainer('music', getAllPlaylists().length),
    ];
    const slice = paginate(musicChildren, startIdx, reqCount);
    return sendBrowseResponse(res, didlWrapper(slice.join('')), slice.length, musicTotal);
  }

  // ── Samsung BASICVIEW audio root ──────────────────────────────────────────
  // Advertised via X_GetFeatureList as the shortcut container for audio.
  // Expose libraries directly so Samsung's UI shows them as browsable folders.
  if (objectId === 'A') {
    if (browseFlag === 'BrowseMetadata') {
      const didl = didlWrapper(`
  <container id="A" parentID="0" restricted="1" childCount="${libraries.length}">
    <dc:title>Music</dc:title>
    <upnp:class>object.container.storageFolder</upnp:class>
  </container>`);
      return sendBrowseResponse(res, didl, 1, 1);
    }
    const children = libraries.map(lib => libraryContainer(lib, 'A', getLibraryTrackCount(lib.id)));
    const slice = paginate(children, startIdx, reqCount);
    return sendBrowseResponse(res, didlWrapper(slice.join('')), slice.length, libraries.length);
  }

  // ── Playlists virtual folder ───────────────────────────────────────────────
  if (objectId === 'playlists') {
    const playlists = getAllPlaylists();
    if (browseFlag === 'BrowseMetadata') {
      return sendBrowseResponse(res, didlWrapper(playlistsContainer('music', playlists.length)), 1, 1);
    }
    const slice = paginate(playlists, startIdx, reqCount);
    return sendBrowseResponse(res, didlWrapper(slice.map(p => playlistContainer(p, 'playlists')).join('')), slice.length, playlists.length);
  }

  // ── Recently Added virtual folder ─────────────────────────────────────────
  if (objectId === 'recent') {
    const totalRecent = getRecentCount();
    if (browseFlag === 'BrowseMetadata') {
      return sendBrowseResponse(res, didlWrapper(recentContainer('music', totalRecent)), 1, 1);
    }
    const tracks = getRecentTracks(startIdx, reqCount);
    const items = tracks.map(t => {
      const lib = libById.get(t.library_id);
      return lib ? trackItem(t, lib, 'recent') : '';
    }).filter(Boolean);
    return sendBrowseResponse(res, didlWrapper(items.join('')), items.length, totalRecent);
  }

  // ── Smart containers under Music ─────────────────────────────────────────

  function smartTrackHandler(id, title, getTotal, getRows) {
    const total = getTotal();
    if (browseFlag === 'BrowseMetadata') {
      return sendBrowseResponse(res, didlWrapper(simpleContainer(id, 'music', title, total)), 1, 1);
    }
    const rows = getRows(startIdx, reqCount);
    const items = rows.map(t => {
      const lib = libById.get(t.library_id);
      return lib ? trackItem(t, lib, id) : '';
    }).filter(Boolean);
    return sendBrowseResponse(res, didlWrapper(items.join('')), items.length, total);
  }

  if (objectId === 'recentplayed') { return smartTrackHandler('recentplayed', 'Recently Played', getRecentPlayedCount, getRecentPlayedTracks); }
  if (objectId === 'mostplayed')   { return smartTrackHandler('mostplayed',   'Most Played',     getMostPlayedCount,   getMostPlayedTracks); }
  if (objectId === 'favorites')    { return smartTrackHandler('favorites',    'Favorites',       getFavoriteCount,     getFavoriteTracks); }
  if (objectId === 'shuffle')      { return smartTrackHandler('shuffle',      'Shuffle',         getShuffleCount,      (s, c) => getShuffleTracks(c || SMART_LIMIT)); }

  // ── Years index and per-year track list ─────────────────────────────────
  if (objectId === 'years') {
    const years = getYears();
    if (browseFlag === 'BrowseMetadata') {
      return sendBrowseResponse(res, didlWrapper(simpleContainer('years', 'music', 'By Year', years.length)), 1, 1);
    }
    const slice = paginate(years, startIdx, reqCount);
    return sendBrowseResponse(res, didlWrapper(slice.map(y => yearContainer(y.year, y.track_count)).join('')), slice.length, years.length);
  }

  const yearMatch = objectId.match(/^year-(\d{1,4})$/);
  if (yearMatch) {
    const year = parseInt(yearMatch[1], 10);
    const total = getYearTrackCount(year);
    if (total === 0) { return sendXml(res, soapError('701', 'No Such Object'), 500); }
    if (browseFlag === 'BrowseMetadata') {
      return sendBrowseResponse(res, didlWrapper(yearContainer(year, total)), 1, 1);
    }
    const tracks = getYearTracks(year, startIdx, reqCount);
    const items = tracks.map(t => {
      const lib = libById.get(t.library_id);
      return lib ? trackItem(t, lib, objectId) : '';
    }).filter(Boolean);
    return sendBrowseResponse(res, didlWrapper(items.join('')), items.length, total);
  }

  // ── Library container — lists the six view sub-containers ────────────────
  const libMatch = objectId.match(/^lib-(\d+)$/);
  if (libMatch) {
    const libId = parseInt(libMatch[1], 10);
    const lib = libById.get(libId);
    if (!lib) { return sendXml(res, soapError('701', 'No Such Object'), 500); }

    if (browseFlag === 'BrowseMetadata') {
      return sendBrowseResponse(res, didlWrapper(libraryContainer(lib, 'music', 6)), 1, 1);
    }

    const children = libraryViewContainers(libId);
    const slice = paginate(children, startIdx, reqCount);
    return sendBrowseResponse(res, didlWrapper(slice.join('')), slice.length, children.length);
  }

  // ── Folders view — top-level directory entries for a library ─────────────
  const foldersMatch = objectId.match(/^folders-(\d+)$/);
  if (foldersMatch) {
    const libId = parseInt(foldersMatch[1], 10);
    const lib = libById.get(libId);
    if (!lib) { return sendXml(res, soapError('701', 'No Such Object'), 500); }

    const allTracks = getAllLibraryTracks(libId);
    const { dirs, items } = dirChildren(allTracks, '');

    if (browseFlag === 'BrowseMetadata') {
      return sendBrowseResponse(res, didlWrapper(viewContainer(libId, 'folders', dirs.length + items.length)), 1, 1);
    }

    const children = [
      ...dirs.map(d => dirContainer(libId, d, objectId, dirChildCount(allTracks, d))),
      ...items.map(t => trackItem(t, lib, objectId)),
    ];
    const slice = paginate(children, startIdx, reqCount);
    return sendBrowseResponse(res, didlWrapper(slice.join('')), slice.length, children.length);
  }

  // ── Artists view — all artists in a library ──────────────────────────────
  const artistsMatch = objectId.match(/^artists-(\d+)$/);
  if (artistsMatch) {
    const libId = parseInt(artistsMatch[1], 10);
    const lib = libById.get(libId);
    if (!lib) { return sendXml(res, soapError('701', 'No Such Object'), 500); }

    const artists = getLibraryArtists(libId);

    if (browseFlag === 'BrowseMetadata') {
      return sendBrowseResponse(res, didlWrapper(viewContainer(libId, 'artists', artists.length)), 1, 1);
    }

    const slice = paginate(artists, startIdx, reqCount);
    return sendBrowseResponse(res, didlWrapper(slice.map(a => artistContainer(libId, a, objectId)).join('')), slice.length, artists.length);
  }

  // ── Album-Artists view — all album-artists in a library ─────────────────
  const albumArtistsMatch = objectId.match(/^albumartists-(\d+)$/);
  if (albumArtistsMatch) {
    const libId = parseInt(albumArtistsMatch[1], 10);
    const lib = libById.get(libId);
    if (!lib) { return sendXml(res, soapError('701', 'No Such Object'), 500); }

    const albumArtists = getLibraryAlbumArtists(libId);

    if (browseFlag === 'BrowseMetadata') {
      return sendBrowseResponse(res, didlWrapper(viewContainer(libId, 'albumartists', albumArtists.length)), 1, 1);
    }

    const slice = paginate(albumArtists, startIdx, reqCount);
    // Reuse artistContainer shape but with the "aartist-" prefix so the drill
    // hits getAlbumArtistAlbums (filtered by albums.artist_id) rather than
    // getArtistAlbums (filtered by tracks.artist_id).
    const didl = slice.map(a => `
  <container id="aartist-${libId}-${a.id}" parentID="${xmlEscape(objectId)}" restricted="1" childCount="${a.album_count}">${containerArtXml(a.album_art_file)}
    <dc:title>${xmlEscape(a.name)}</dc:title>
    <upnp:class>object.container.person.musicArtist</upnp:class>
  </container>`).join('');
    return sendBrowseResponse(res, didlWrapper(didl), slice.length, albumArtists.length);
  }

  // ── Album-Artist drill — albums by this album-artist ────────────────────
  const aartistMatch = objectId.match(/^aartist-(\d+)-(\d+)$/);
  if (aartistMatch) {
    const libId    = parseInt(aartistMatch[1], 10);
    const artistId = parseInt(aartistMatch[2], 10);
    const lib = libById.get(libId);
    if (!lib) { return sendXml(res, soapError('701', 'No Such Object'), 500); }

    if (browseFlag === 'BrowseMetadata') {
      const artist = getAlbumArtistById(libId, artistId);
      if (!artist) { return sendXml(res, soapError('701', 'No Such Object'), 500); }
      return sendBrowseResponse(res, didlWrapper(`
  <container id="${objectId}" parentID="albumartists-${libId}" restricted="1" childCount="${artist.album_count}">${containerArtXml(artist.album_art_file)}
    <dc:title>${xmlEscape(artist.name)}</dc:title>
    <upnp:class>object.container.person.musicArtist</upnp:class>
  </container>`), 1, 1);
    }

    const albums = getAlbumArtistAlbums(libId, artistId);
    const slice = paginate(albums, startIdx, reqCount);
    return sendBrowseResponse(res, didlWrapper(slice.map(al => albumContainer(libId, al, objectId)).join('')), slice.length, albums.length);
  }

  // ── Albums view — all albums in a library ────────────────────────────────
  const albumsMatch = objectId.match(/^albums-(\d+)$/);
  if (albumsMatch) {
    const libId = parseInt(albumsMatch[1], 10);
    const lib = libById.get(libId);
    if (!lib) { return sendXml(res, soapError('701', 'No Such Object'), 500); }

    const albums = getLibraryAlbums(libId);

    if (browseFlag === 'BrowseMetadata') {
      return sendBrowseResponse(res, didlWrapper(viewContainer(libId, 'albums', albums.length)), 1, 1);
    }

    const slice = paginate(albums, startIdx, reqCount);
    return sendBrowseResponse(res, didlWrapper(slice.map(al => albumContainer(libId, al, objectId)).join('')), slice.length, albums.length);
  }

  // ── Genres view — all genres in a library ────────────────────────────────
  const genresMatch = objectId.match(/^genres-(\d+)$/);
  if (genresMatch) {
    const libId = parseInt(genresMatch[1], 10);
    const lib = libById.get(libId);
    if (!lib) { return sendXml(res, soapError('701', 'No Such Object'), 500); }

    const genres = getLibraryGenres(libId);

    if (browseFlag === 'BrowseMetadata') {
      return sendBrowseResponse(res, didlWrapper(viewContainer(libId, 'genres', genres.length)), 1, 1);
    }

    const slice = paginate(genres, startIdx, reqCount);
    return sendBrowseResponse(res, didlWrapper(slice.map(g => genreContainer(libId, g, objectId)).join('')), slice.length, genres.length);
  }

  // ── All-Tracks view — flat, sortable track list ──────────────────────────
  const tracksMatch = objectId.match(/^tracks-(\d+)$/);
  if (tracksMatch) {
    const libId = parseInt(tracksMatch[1], 10);
    const lib = libById.get(libId);
    if (!lib) { return sendXml(res, soapError('701', 'No Such Object'), 500); }

    const total = getLibraryTrackCount(libId);

    if (browseFlag === 'BrowseMetadata') {
      return sendBrowseResponse(res, didlWrapper(viewContainer(libId, 'tracks', total)), 1, 1);
    }

    const orderBy = buildOrderBy(sortTerms, 'al.name, t.disc_number, t.track_number, t.title');
    const tracks = getLibraryTracks(libId, startIdx, reqCount, orderBy);
    return sendBrowseResponse(res, didlWrapper(tracks.map(t => trackItem(t, lib, objectId)).join('')), tracks.length, total);
  }

  // ── Directory container (dirs mode) ──────────────────────────────────────
  const dirMatch = objectId.match(/^dir-(\d+)-(.+)$/);
  if (dirMatch) {
    const libId = parseInt(dirMatch[1], 10);
    const relPath = decodeRelPath(dirMatch[2]);
    const lib = libById.get(libId);
    if (!lib) { return sendXml(res, soapError('701', 'No Such Object'), 500); }

    const allTracks = getAllLibraryTracks(libId);
    const { dirs, items } = dirChildren(allTracks, relPath);

    if (browseFlag === 'BrowseMetadata') {
      const lastSlash = relPath.lastIndexOf('/');
      const parentRel = lastSlash === -1 ? '' : relPath.slice(0, lastSlash);
      const parentId  = parentRel ? `dir-${libId}-${encodeRelPath(parentRel)}` : `folders-${libId}`;
      return sendBrowseResponse(res, didlWrapper(dirContainer(libId, relPath, parentId, dirs.length + items.length)), 1, 1);
    }

    const children = [
      ...dirs.map(d => {
        const full = relPath + '/' + d;
        return dirContainer(libId, full, objectId, dirChildCount(allTracks, full));
      }),
      ...items.map(t => trackItem(t, lib, objectId)),
    ];
    const slice = paginate(children, startIdx, reqCount);
    return sendBrowseResponse(res, didlWrapper(slice.join('')), slice.length, children.length);
  }

  // ── Artist container (artist mode) ────────────────────────────────────────
  const artistMatch = objectId.match(/^artist-(\d+)-(\d+)$/);
  if (artistMatch) {
    const libId    = parseInt(artistMatch[1], 10);
    const artistId = parseInt(artistMatch[2], 10);
    const lib = libById.get(libId);
    if (!lib) { return sendXml(res, soapError('701', 'No Such Object'), 500); }

    if (browseFlag === 'BrowseMetadata') {
      const artist = getArtistById(libId, artistId);
      if (!artist) { return sendXml(res, soapError('701', 'No Such Object'), 500); }
      return sendBrowseResponse(res, didlWrapper(artistContainer(libId, artist, `artists-${libId}`)), 1, 1);
    }

    const albums = getArtistAlbums(libId, artistId);
    const slice = paginate(albums, startIdx, reqCount);
    return sendBrowseResponse(res, didlWrapper(slice.map(al => albumContainer(libId, al, objectId)).join('')), slice.length, albums.length);
  }

  // ── Album container (artist mode) ─────────────────────────────────────────
  const albumMatch = objectId.match(/^album-(\d+)-(\d+)$/);
  if (albumMatch) {
    const libId   = parseInt(albumMatch[1], 10);
    const albumId = parseInt(albumMatch[2], 10);
    const lib = libById.get(libId);
    if (!lib) { return sendXml(res, soapError('701', 'No Such Object'), 500); }

    const tracks = getAlbumTracks(libId, albumId);

    if (browseFlag === 'BrowseMetadata') {
      if (!tracks.length) { return sendXml(res, soapError('701', 'No Such Object'), 500); }
      const album = { id: albumId, name: tracks[0].album_name || 'Unknown Album', track_count: tracks.length, album_art_file: tracks.find(t => t.album_art_file)?.album_art_file || null };
      return sendBrowseResponse(res, didlWrapper(albumContainer(libId, album, `albums-${libId}`)), 1, 1);
    }

    const slice = paginate(tracks, startIdx, reqCount);
    return sendBrowseResponse(res, didlWrapper(slice.map(t => trackItem(t, lib, objectId)).join('')), slice.length, tracks.length);
  }

  // ── Genre container (genre mode) ─────────────────────────────────────────
  const genreMatch = objectId.match(/^genre-(\d+)-(.*)$/);
  if (genreMatch) {
    const libId = parseInt(genreMatch[1], 10);
    const genre = decodeRelPath(genreMatch[2]);
    const lib = libById.get(libId);
    if (!lib) { return sendXml(res, soapError('701', 'No Such Object'), 500); }

    if (browseFlag === 'BrowseMetadata') {
      const g = getGenreByName(libId, genre);
      if (!g) { return sendXml(res, soapError('701', 'No Such Object'), 500); }
      return sendBrowseResponse(res, didlWrapper(genreContainer(libId, g, `genres-${libId}`)), 1, 1);
    }

    const artists = getGenreArtists(libId, genre);
    const slice = paginate(artists, startIdx, reqCount);
    return sendBrowseResponse(res, didlWrapper(slice.map(a => genreArtistContainer(libId, a, objectId, genre)).join('')), slice.length, artists.length);
  }

  // ── Genre-scoped artist container (genre mode) ────────────────────────────
  const gartistMatch = objectId.match(/^gartist-(\d+)-(\d+)-(.*)$/);
  if (gartistMatch) {
    const libId    = parseInt(gartistMatch[1], 10);
    const artistId = parseInt(gartistMatch[2], 10);
    const genre    = decodeRelPath(gartistMatch[3]);
    const lib = libById.get(libId);
    if (!lib) { return sendXml(res, soapError('701', 'No Such Object'), 500); }

    if (browseFlag === 'BrowseMetadata') {
      const artist = getGenreArtistById(libId, genre, artistId);
      if (!artist) { return sendXml(res, soapError('701', 'No Such Object'), 500); }
      return sendBrowseResponse(res, didlWrapper(genreArtistContainer(libId, artist, `genre-${libId}-${encodeRelPath(genre)}`, genre)), 1, 1);
    }

    const albums = getGenreArtistAlbums(libId, genre, artistId);
    const slice = paginate(albums, startIdx, reqCount);
    return sendBrowseResponse(res, didlWrapper(slice.map(al => albumContainer(libId, al, objectId)).join('')), slice.length, albums.length);
  }

  // ── Individual playlist container ────────────────────────────────────────
  const playlistMatch = objectId.match(/^playlist-(\d+)$/);
  if (playlistMatch) {
    const playlistId = parseInt(playlistMatch[1], 10);
    const playlist = getPlaylistById(playlistId);
    if (!playlist) { return sendXml(res, soapError('701', 'No Such Object'), 500); }

    if (browseFlag === 'BrowseMetadata') {
      return sendBrowseResponse(res, didlWrapper(playlistContainer(playlist, 'playlists')), 1, 1);
    }

    const rows = getPlaylistTracks(playlistId);
    const slice = paginate(rows, startIdx, reqCount);
    const items = slice.map(row => trackItem({
      id: row.track_id, filepath: row.rel_filepath,
      title: row.title, track_number: row.track_number,
      duration: row.duration, format: row.format, file_size: row.file_size,
      genre: row.genre, album_art_file: row.album_art_file,
      artist_name: row.artist_name, album_name: row.album_name,
    }, { name: row.library_name, type: row.library_type }, objectId)).join('');
    return sendBrowseResponse(res, didlWrapper(items), slice.length, rows.length);
  }

  // ── Track item ────────────────────────────────────────────────────────────
  const trackMatch = objectId.match(/^track-(\d+)$/);
  if (trackMatch) {
    const trackId = parseInt(trackMatch[1], 10);
    const row = db.getDB().prepare(`
      SELECT t.id, t.filepath, t.title, t.track_number, t.duration, t.format,
             t.file_size, t.genre, t.album_art_file, t.year, t.library_id,
             a.name AS artist_name, al.name AS album_name
      FROM tracks t
      LEFT JOIN artists a  ON t.artist_id = a.id
      LEFT JOIN albums al  ON t.album_id  = al.id
      WHERE t.id = ?
    `).get(trackId);
    if (!row) { return sendXml(res, soapError('701', 'No Such Object'), 500); }

    const lib = libById.get(row.library_id);
    if (!lib) { return sendXml(res, soapError('701', 'No Such Object'), 500); }

    if (browseFlag === 'BrowseDirectChildren') {
      return sendBrowseResponse(res, didlWrapper(''), 0, 0);
    }
    return sendBrowseResponse(res, didlWrapper(trackItem(row, lib, `tracks-${lib.id}`)), 1, 1);
  }

  sendXml(res, soapError('701', 'No Such Object'), 500);
}

// ── Search helpers ───────────────────────────────────────────────────────────

function tokenizeSearch(input) {
  const tokens = [];
  const re = /"(?:[^"\\]|\\.)*"|!=|<=|>=|[()=!<>]|[\w:.]+/g;
  for (const m of (input || '').matchAll(re)) { tokens.push(m[0]); }
  return tokens;
}

class SearchParser {
  constructor(tokens) { this.tokens = tokens; this.pos = 0; }
  peek() { return this.tokens[this.pos]; }
  next() { return this.tokens[this.pos++]; }

  parse() { return this.tokens.length ? this.parseOr() : null; }

  parseOr() {
    let left = this.parseAnd();
    while (this.peek() && this.peek().toLowerCase() === 'or') {
      this.next();
      left = { op: 'or', left, right: this.parseAnd() };
    }
    return left;
  }

  parseAnd() {
    let left = this.parsePrimary();
    while (this.peek() && this.peek().toLowerCase() === 'and') {
      this.next();
      left = { op: 'and', left, right: this.parsePrimary() };
    }
    return left;
  }

  parsePrimary() {
    if (this.peek() === '(') {
      this.next();
      const inner = this.parseOr();
      if (this.peek() === ')') this.next();
      return inner;
    }
    const property = this.next() || '';
    const relOp = (this.next() || '').toLowerCase();
    const raw = this.next() || '';
    const value = raw.startsWith('"') ? raw.slice(1, raw.endsWith('"') ? -1 : undefined) : raw;
    return { op: 'rel', property, relOp, value };
  }
}

const SEARCH_PROP_MAP = {
  'dc:title':                 "COALESCE(t.title, '')",
  'dc:creator':               "COALESCE(a.name, '')",
  'upnp:artist':              "COALESCE(a.name, '')",
  'upnp:album':               "COALESCE(al.name, '')",
  'upnp:genre':               "COALESCE(t.genre, '')",
  'upnp:originalTrackNumber': 't.track_number',
};

function searchNodeToSql(node, params) {
  if (!node) return '1=1';
  if (node.op === 'and') return `(${searchNodeToSql(node.left, params)} AND ${searchNodeToSql(node.right, params)})`;
  if (node.op === 'or')  return `(${searchNodeToSql(node.left, params)} OR ${searchNodeToSql(node.right, params)})`;
  if (node.op === 'rel') {
    const { property, relOp, value } = node;
    if (property === 'upnp:class') {
      if (relOp === 'exists') return value === 'true' ? '1=1' : '1=0';
      return (relOp === '=' || relOp === 'derivedfrom')
        ? (value.includes('audioItem') || value === '*' ? '1=1' : '1=0')
        : '1=1';
    }
    const col = SEARCH_PROP_MAP[property];
    if (!col) return '1=1';
    const escaped = value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    switch (relOp) {
      case '=':             params.push(value);               return `${col} = ?`;
      case '!=':            params.push(value);               return `${col} != ?`;
      case 'contains':      params.push(`%${escaped}%`);      return `${col} LIKE ? ESCAPE '\\'`;
      case 'doesnotcontain':params.push(`%${escaped}%`);      return `(${col} NOT LIKE ? ESCAPE '\\')`;
      case 'startswith':    params.push(`${escaped}%`);       return `${col} LIKE ? ESCAPE '\\'`;
      case 'exists':        return value === 'true' ? `${col} IS NOT NULL` : `${col} IS NULL`;
      default:              return '1=1';
    }
  }
  return '1=1';
}

function handleSearch(body, res) {
  const objectId  = extractSoapField(body, 'ContainerID') || extractSoapField(body, 'ObjectID') || '0';
  const criteria  = extractSoapField(body, 'SearchCriteria');
  const startIdx  = Math.max(0, parseInt(extractSoapField(body, 'StartingIndex') || '0', 10) || 0);
  const rawCount  = Math.max(0, parseInt(extractSoapField(body, 'RequestedCount') || '0', 10) || 0);
  const reqCount  = rawCount === 0 ? MAX_BROWSE_COUNT : Math.min(rawCount, MAX_BROWSE_COUNT);
  const sortTerms = parseSortCriteria(extractSoapField(body, 'SortCriteria'));

  const libraries = db.getAllLibraries();
  const libById = libraryIndex(libraries);

  const libParams = [];
  let libFilter = '';
  if (objectId !== '0') {
    const m = objectId.match(/^lib-(\d+)$/);
    if (m) { libFilter = 'AND t.library_id = ?'; libParams.push(parseInt(m[1], 10)); }
  }

  const whereParams = [];
  let whereClause = '1=1';
  if (criteria && criteria.trim() !== '*') {
    try {
      const ast = new SearchParser(tokenizeSearch(criteria)).parse();
      whereClause = searchNodeToSql(ast, whereParams);
    } catch (_) { whereClause = '1=1'; }
  }

  const d = db.getDB();
  const countRow = d.prepare(`
    SELECT COUNT(*) AS n FROM tracks t
    LEFT JOIN artists a  ON t.artist_id = a.id
    LEFT JOIN albums  al ON t.album_id  = al.id
    WHERE ${whereClause} ${libFilter}
  `).get(...whereParams, ...libParams);
  const total = countRow ? countRow.n : 0;

  const orderBy = buildOrderBy(sortTerms, 't.title');
  const limit = reqCount > 0 ? reqCount : -1;
  const rows = d.prepare(`
    SELECT t.id, t.filepath, t.title, t.track_number, t.duration, t.format,
           t.file_size, t.genre, t.album_art_file, t.year, t.library_id,
           a.name AS artist_name, al.name AS album_name
    FROM tracks t
    LEFT JOIN artists a  ON t.artist_id = a.id
    LEFT JOIN albums  al ON t.album_id  = al.id
    WHERE ${whereClause} ${libFilter}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...whereParams, ...libParams, limit, startIdx);

  const items = rows.map(row => {
    const lib = libById.get(row.library_id);
    return lib ? trackItem(row, lib, objectId) : '';
  }).filter(Boolean).join('');

  const escapedDidl = xmlEscape(didlWrapper(items));
  const inner = `<Result>${escapedDidl}</Result>
      <NumberReturned>${rows.length}</NumberReturned>
      <TotalMatches>${total}</TotalMatches>
      <UpdateID>${systemUpdateID}</UpdateID>`;
  sendXml(res, soapEnvelope(CDS_NS, 'SearchResponse', inner));
}

function sendBrowseResponse(res, didlXml, numberReturned, totalMatches) {
  const escapedDidl = xmlEscape(didlXml);
  const inner = `<Result>${escapedDidl}</Result>
      <NumberReturned>${numberReturned}</NumberReturned>
      <TotalMatches>${totalMatches}</TotalMatches>
      <UpdateID>${systemUpdateID}</UpdateID>`;
  sendXml(res, soapEnvelope(CDS_NS, 'BrowseResponse', inner));
}

// ── Static XML documents ─────────────────────────────────────────────────────

function deviceXml() {
  const d = config.program.dlna;
  return `<?xml version="1.0" encoding="utf-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0"
      xmlns:dlna="urn:schemas-dlna-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
    <friendlyName>${xmlEscape(d.name)}</friendlyName>
    <manufacturer>mStream</manufacturer>
    <manufacturerURL>https://mstream.io</manufacturerURL>
    <modelName>mStream</modelName>
    <modelNumber>1.0</modelNumber>
    <UDN>uuid:${xmlEscape(d.uuid)}</UDN>
    <dlna:X_DLNADOC xmlns:dlna="urn:schemas-dlna-org:device-1-0">DMS-1.50</dlna:X_DLNADOC>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId>
        <SCPDURL>/dlna/content-directory-scpd.xml</SCPDURL>
        <controlURL>/dlna/control/content-directory</controlURL>
        <eventSubURL>/dlna/event/content-directory</eventSubURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId>
        <SCPDURL>/dlna/connection-manager-scpd.xml</SCPDURL>
        <controlURL>/dlna/control/connection-manager</controlURL>
        <eventSubURL>/dlna/event/connection-manager</eventSubURL>
      </service>
    </serviceList>
  </device>
</root>`;
}

const CONTENT_DIRECTORY_SCPD = `<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action>
      <name>Browse</name>
      <argumentList>
        <argument><name>ObjectID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_ObjectID</relatedStateVariable></argument>
        <argument><name>BrowseFlag</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_BrowseFlag</relatedStateVariable></argument>
        <argument><name>Filter</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Filter</relatedStateVariable></argument>
        <argument><name>StartingIndex</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Index</relatedStateVariable></argument>
        <argument><name>RequestedCount</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
        <argument><name>SortCriteria</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_SortCriteria</relatedStateVariable></argument>
        <argument><name>Result</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Result</relatedStateVariable></argument>
        <argument><name>NumberReturned</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
        <argument><name>TotalMatches</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
        <argument><name>UpdateID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_UpdateID</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action>
      <name>Search</name>
      <argumentList>
        <argument><name>ContainerID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_ObjectID</relatedStateVariable></argument>
        <argument><name>SearchCriteria</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_SearchCriteria</relatedStateVariable></argument>
        <argument><name>Filter</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Filter</relatedStateVariable></argument>
        <argument><name>StartingIndex</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Index</relatedStateVariable></argument>
        <argument><name>RequestedCount</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
        <argument><name>SortCriteria</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_SortCriteria</relatedStateVariable></argument>
        <argument><name>Result</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Result</relatedStateVariable></argument>
        <argument><name>NumberReturned</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
        <argument><name>TotalMatches</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
        <argument><name>UpdateID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_UpdateID</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action>
      <name>GetSearchCapabilities</name>
      <argumentList>
        <argument><name>SearchCaps</name><direction>out</direction><relatedStateVariable>SearchCapabilities</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action>
      <name>GetSortCapabilities</name>
      <argumentList>
        <argument><name>SortCaps</name><direction>out</direction><relatedStateVariable>SortCapabilities</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action>
      <name>GetSystemUpdateID</name>
      <argumentList>
        <argument><name>Id</name><direction>out</direction><relatedStateVariable>SystemUpdateID</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action>
      <name>X_GetFeatureList</name>
      <argumentList>
        <argument><name>FeatureList</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Featurelist</relatedStateVariable></argument>
      </argumentList>
    </action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ObjectID</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Result</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no">
      <name>A_ARG_TYPE_BrowseFlag</name><dataType>string</dataType>
      <allowedValueList>
        <allowedValue>BrowseMetadata</allowedValue>
        <allowedValue>BrowseDirectChildren</allowedValue>
      </allowedValueList>
    </stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Filter</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_SearchCriteria</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_SortCriteria</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Index</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Count</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_UpdateID</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>SearchCapabilities</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>SortCapabilities</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="yes"><name>SystemUpdateID</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Featurelist</name><dataType>string</dataType></stateVariable>
  </serviceStateTable>
</scpd>`;

const CONNECTION_MANAGER_SCPD = `<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action>
      <name>GetProtocolInfo</name>
      <argumentList>
        <argument><name>Source</name><direction>out</direction><relatedStateVariable>SourceProtocolInfo</relatedStateVariable></argument>
        <argument><name>Sink</name><direction>out</direction><relatedStateVariable>SinkProtocolInfo</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action>
      <name>GetCurrentConnectionIDs</name>
      <argumentList>
        <argument><name>ConnectionIDs</name><direction>out</direction><relatedStateVariable>CurrentConnectionIDs</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action>
      <name>GetCurrentConnectionInfo</name>
      <argumentList>
        <argument><name>ConnectionID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_ConnectionID</relatedStateVariable></argument>
        <argument><name>RcsID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_RcsID</relatedStateVariable></argument>
        <argument><name>AVTransportID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_AVTransportID</relatedStateVariable></argument>
        <argument><name>ProtocolInfo</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_ProtocolInfo</relatedStateVariable></argument>
        <argument><name>PeerConnectionManager</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_ConnectionManager</relatedStateVariable></argument>
        <argument><name>PeerConnectionID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_ConnectionID</relatedStateVariable></argument>
        <argument><name>Direction</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Direction</relatedStateVariable></argument>
        <argument><name>Status</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_ConnectionStatus</relatedStateVariable></argument>
      </argumentList>
    </action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="yes"><name>SourceProtocolInfo</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="yes"><name>SinkProtocolInfo</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="yes"><name>CurrentConnectionIDs</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ConnectionStatus</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ConnectionManager</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Direction</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ProtocolInfo</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ConnectionID</name><dataType>i4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_AVTransportID</name><dataType>i4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_RcsID</name><dataType>i4</dataType></stateVariable>
  </serviceStateTable>
</scpd>`;

// ── Source protocol info list for ConnectionManager ──────────────────────────

const SOURCE_PROTOCOL_INFO = [
  `http-get:*:audio/mpeg:DLNA.ORG_PN=MP3;DLNA.ORG_OP=11;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=${DLNA_FLAGS}`,
  `http-get:*:audio/flac:DLNA.ORG_PN=FLAC;DLNA.ORG_OP=11;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=${DLNA_FLAGS}`,
  `http-get:*:audio/wav:DLNA.ORG_PN=WAV;DLNA.ORG_OP=11;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=${DLNA_FLAGS}`,
  `http-get:*:audio/mp4:DLNA.ORG_PN=AAC_ISO;DLNA.ORG_OP=11;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=${DLNA_FLAGS}`,
  `http-get:*:audio/ogg:DLNA.ORG_OP=11;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=${DLNA_FLAGS}`,
  `http-get:*:audio/opus:DLNA.ORG_OP=11;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=${DLNA_FLAGS}`,
].join(',');

// ── Samsung X_GetFeatureList ─────────────────────────────────────────────────
// Samsung TVs call this action to discover a shortcut container ID for the
// audio root. We point them at "A", which handleBrowse serves as a list of
// libraries (object.container.storageFolder entries).
const SAMSUNG_FEATURE_LIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Features xmlns="urn:schemas-upnp-org:av:avs"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
          xsi:schemaLocation="urn:schemas-upnp-org:av:avs http://www.upnp.org/schemas/av/avs-v1-20060531.xsd">
  <Feature name="samsung.com_BASICVIEW" version="1">
    <container id="A" type="object.item.audioItem"/>
  </Feature>
</Features>`;

// ── GENA event subscriptions ─────────────────────────────────────────────────
// Minimal UPnP event implementation: track subscribers per service, send the
// initial NOTIFY on subscribe, and re-NOTIFY on state change.

const GENA_DEFAULT_TIMEOUT = 1800; // seconds

function parseCallbackHeader(val) {
  const urls = [];
  const re = /<([^>]+)>/g;
  let m;
  while ((m = re.exec(val || '')) !== null) { urls.push(m[1]); }
  return urls;
}

function parseTimeout(val) {
  const m = /Second-(\d+)/i.exec(val || '');
  return m ? parseInt(m[1], 10) : GENA_DEFAULT_TIMEOUT;
}

function cleanExpiredSubscribers() {
  const now = Date.now();
  for (const [sid, sub] of subscribers) {
    if (sub.expiresAt < now) { subscribers.delete(sid); }
  }
}

// Periodic cleanup in case no one is bumping SystemUpdateID or subscribing —
// otherwise expired subscribers could linger in the Map indefinitely. unref()
// so this timer doesn't keep the process alive on shutdown.
setInterval(cleanExpiredSubscribers, 60_000).unref();

function cdsPropertySet() {
  // ContainerUpdateIDs would list specific changed containers; we don't track
  // them at that granularity, so it's left empty — clients that care will fall
  // back to SystemUpdateID and re-browse from the root.
  return `<?xml version="1.0"?>
<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">
  <e:property><SystemUpdateID>${systemUpdateID}</SystemUpdateID></e:property>
  <e:property><ContainerUpdateIDs></ContainerUpdateIDs></e:property>
</e:propertyset>`;
}

function cmPropertySet() {
  return `<?xml version="1.0"?>
<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">
  <e:property><SourceProtocolInfo>${xmlEscape(SOURCE_PROTOCOL_INFO)}</SourceProtocolInfo></e:property>
  <e:property><SinkProtocolInfo></SinkProtocolInfo></e:property>
  <e:property><CurrentConnectionIDs>0</CurrentConnectionIDs></e:property>
</e:propertyset>`;
}

function sendNotifyToSubscriber(sid, sub, body) {
  // UPnP: try callback URLs in order, stop on first success. Fire-and-forget;
  // a failing subscriber just misses this notification.
  for (const url of sub.callbacks) {
    try {
      const parsed = new URL(url);
      const req = http.request({
        method: 'NOTIFY',
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname + parsed.search,
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          'NT': 'upnp:event',
          'NTS': 'upnp:propchange',
          'SID': sid,
          'SEQ': String(sub.seq),
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 5000,
      });
      req.on('error', (err) => winston.debug(`[dlna] GENA NOTIFY error: ${err.message}`));
      req.on('timeout', () => req.destroy());
      req.write(body);
      req.end();
      sub.seq = (sub.seq + 1) & 0xFFFFFFFF;
      return;
    } catch (err) {
      winston.debug(`[dlna] GENA NOTIFY bad callback ${url}: ${err.message}`);
    }
  }
}

function broadcastToService(service) {
  cleanExpiredSubscribers();
  const body = service === 'cds' ? cdsPropertySet() : cmPropertySet();
  for (const [sid, sub] of subscribers) {
    if (sub.service === service) { sendNotifyToSubscriber(sid, sub, body); }
  }
}

function handleSubscribe(req, res, service) {
  cleanExpiredSubscribers();
  const timeout = parseTimeout(req.headers['timeout']);
  const existingSid = req.headers['sid'];

  if (existingSid) {
    // Renewal — must have SID and no CALLBACK/NT per UPnP 1.0 §4.1.2
    const sub = subscribers.get(existingSid);
    if (!sub || sub.service !== service) { return res.status(412).end(); }
    sub.expiresAt = Date.now() + timeout * 1000;
    return res.set({ SID: existingSid, TIMEOUT: `Second-${timeout}` }).status(200).end();
  }

  const callbacks = parseCallbackHeader(req.headers['callback']);
  const nt = (req.headers['nt'] || '').toLowerCase();
  if (!callbacks.length || nt !== 'upnp:event') {
    return res.status(412).end();
  }

  // Defence against a client churning new subscriptions without renewing or
  // unsubscribing. 503 "Service Unavailable" per UPnP 1.0 §4.1.2.
  if (subscribers.size >= MAX_SUBSCRIBERS) {
    return res.status(503).end();
  }

  const sid = `uuid:${crypto.randomUUID()}`;
  const sub = { service, callbacks, expiresAt: Date.now() + timeout * 1000, seq: 0 };
  subscribers.set(sid, sub);

  res.set({ SID: sid, TIMEOUT: `Second-${timeout}` }).status(200).end();

  // Spec requires an initial NOTIFY containing all evented state variables,
  // sent only after the SUBSCRIBE response is delivered.
  setImmediate(() => {
    const body = service === 'cds' ? cdsPropertySet() : cmPropertySet();
    sendNotifyToSubscriber(sid, sub, body);
  });
}

function handleUnsubscribe(req, res) {
  const sid = req.headers['sid'];
  if (sid) { subscribers.delete(sid); }
  res.status(200).end();
}

export function bumpSystemUpdateID() {
  // SystemUpdateID is a UPnP ui4 (32-bit unsigned). Wrap to stay in range.
  systemUpdateID = (systemUpdateID + 1) >>> 0;
  winston.debug(`[dlna] SystemUpdateID bumped to ${systemUpdateID}`);
  broadcastToService('cds');
}

// ── Route setup ──────────────────────────────────────────────────────────────

export function setup(mstream, { checkMode = true } = {}) {
  function modeOk() { return !checkMode || config.program.dlna.mode === 'same-port'; }

  // All DLNA routes check mode inline — they're registered unconditionally
  // so they sit before the auth wall but silently 503 when disabled/wrong-mode.

  // Time-seek support: intercept /media requests with TimeSeekRange headers
  // BEFORE the auth wall and the express.static mounts. Without a header the
  // middleware just calls next() and the normal static handler takes over.
  // Only mount on the main app — dlna-server.js mounts its own copy for the
  // separate-port server, so registering here too would double-invoke it.
  if (checkMode) {
    mstream.use('/media', (req, res, next) => {
      if (!modeOk()) { return next(); }
      timeSeekMiddleware(req, res, next);
    });
  }

  // Device description
  mstream.get('/dlna/device.xml', (req, res) => {
    if (!modeOk()) { return res.status(503).end(); }
    sendXml(res, deviceXml());
  });

  // Service descriptions
  mstream.get('/dlna/content-directory-scpd.xml', (req, res) => {
    if (!modeOk()) { return res.status(503).end(); }
    sendXml(res, CONTENT_DIRECTORY_SCPD);
  });

  mstream.get('/dlna/connection-manager-scpd.xml', (req, res) => {
    if (!modeOk()) { return res.status(503).end(); }
    sendXml(res, CONNECTION_MANAGER_SCPD);
  });

  // ContentDirectory control (SOAP) — parse XML body inline
  mstream.post('/dlna/control/content-directory',
    express.text({ type: ['text/xml', 'application/xml', 'application/soap+xml', 'text/*'] }),
    (req, res) => {
      if (!modeOk()) { return res.status(503).end(); }

      const body = typeof req.body === 'string' ? req.body : '';
      const soapAction = ((req.headers['soapaction'] || '')).replace(/"/g, '');
      const action = soapAction.split('#')[1] || '';

      winston.debug(`[dlna] ContentDirectory action: ${action}`);

      try {
        switch (action) {
          case 'Browse':
            return handleBrowse(body, res);

          case 'Search':
            return handleSearch(body, res);

          case 'GetSearchCapabilities':
            return sendXml(res, soapEnvelope(CDS_NS, 'GetSearchCapabilitiesResponse',
              '<SearchCaps>dc:title,dc:creator,upnp:artist,upnp:album,upnp:genre,upnp:class</SearchCaps>'));

          case 'GetSortCapabilities':
            return sendXml(res, soapEnvelope(CDS_NS, 'GetSortCapabilitiesResponse',
              '<SortCaps>dc:title,dc:creator,upnp:artist,upnp:album,upnp:originalTrackNumber,upnp:genre,dc:date,upnp:originalYear,res@duration,res@size,@refID</SortCaps>'));

          case 'GetSystemUpdateID':
            return sendXml(res, soapEnvelope(CDS_NS, 'GetSystemUpdateIDResponse',
              `<Id>${systemUpdateID}</Id>`));

          // Samsung's shortcut discovery action. The FeatureList body must be
          // XML-escaped once because it's embedded in the SOAP response.
          case 'X_GetFeatureList':
            return sendXml(res, soapEnvelope(CDS_NS, 'X_GetFeatureListResponse',
              `<FeatureList>${xmlEscape(SAMSUNG_FEATURE_LIST_XML)}</FeatureList>`));

          default:
            return sendXml(res, soapError('401', 'Invalid Action'), 500);
        }
      } catch (err) {
        winston.error('[dlna] ContentDirectory error', { stack: err });
        sendXml(res, soapError('501', 'Action Failed'), 500);
      }
    }
  );

  // ConnectionManager control (SOAP)
  const CM_NS = 'urn:schemas-upnp-org:service:ConnectionManager:1';
  mstream.post('/dlna/control/connection-manager',
    express.text({ type: ['text/xml', 'application/xml', 'application/soap+xml', 'text/*'] }),
    (req, res) => {
      if (!modeOk()) { return res.status(503).end(); }
      const soapAction = ((req.headers['soapaction'] || '')).replace(/"/g, '');
      const action = soapAction.split('#')[1] || '';

      try {
        switch (action) {
          case 'GetProtocolInfo':
            return sendXml(res, soapEnvelope(CM_NS, 'GetProtocolInfoResponse',
              `<Source>${xmlEscape(SOURCE_PROTOCOL_INFO)}</Source><Sink></Sink>`));
          case 'GetCurrentConnectionIDs':
            return sendXml(res, soapEnvelope(CM_NS, 'GetCurrentConnectionIDsResponse',
              '<ConnectionIDs>0</ConnectionIDs>'));
          case 'GetCurrentConnectionInfo':
            return sendXml(res, soapEnvelope(CM_NS, 'GetCurrentConnectionInfoResponse',
              '<RcsID>-1</RcsID><AVTransportID>-1</AVTransportID><ProtocolInfo></ProtocolInfo><PeerConnectionManager></PeerConnectionManager><PeerConnectionID>-1</PeerConnectionID><Direction>Output</Direction><Status>OK</Status>'));
          default:
            return sendXml(res, soapError('401', 'Invalid Action'), 500);
        }
      } catch (err) {
        winston.error('[dlna] ConnectionManager error', { stack: err });
        sendXml(res, soapError('501', 'Action Failed'), 500);
      }
    }
  );

  // GENA event subscription endpoints — dispatch by HTTP method. Express
  // routes custom methods (SUBSCRIBE, UNSUBSCRIBE) through `.all()`.
  function genaRoute(service) {
    return (req, res) => {
      if (!modeOk()) { return res.status(503).end(); }
      if (req.method === 'SUBSCRIBE')   { return handleSubscribe(req, res, service); }
      if (req.method === 'UNSUBSCRIBE') { return handleUnsubscribe(req, res); }
      res.status(405).end();
    };
  }
  mstream.all('/dlna/event/content-directory', genaRoute('cds'));
  mstream.all('/dlna/event/connection-manager', genaRoute('cm'));
}
