// Album Library endpoint — powers the Velvet "Albums" grid.
//
// Response shape (what webapp/velvet/app.js:5016-5299 consumes):
//
//   {
//     albums: [{
//       id,                  // stable album id (our albums.id, stringified)
//       displayName,         // title shown on the card and detail header
//       artist,              // album artist (nullable)
//       year,                // nullable
//       aaFile,              // image-cache album-art filename, resolved by UI
//                            // via /album-art/<file> — most albums use this
//       artFile,             // vpath-qualified path to a folder-scanned art
//                            // file (e.g. "Music/Artist/Album/cover.jpg"),
//                            // resolved via /api/v1/albums/art-file?p=…
//                            // Null today because our scanner routes art to
//                            // image-cache; reserved for a future folder-
//                            // scan mode.
//       seriesId,            // optional — groups box-sets. Null today.
//       discs: [{            // one entry per distinct disc_number, sorted
//         label,             // null → UI renders "Disc N"
//         discIndex,         // 1-based
//         tracks: [{
//           filepath,        // "<vpath>/<relative>" — what Player.setQueue
//                            // feeds to /media/…
//           title, artist, number, duration
//         }]
//       }]
//     }],
//     series: []              // empty until we implement box-set grouping
//   }
//
// Design notes:
//
// - Single pass query pulls every (album, track) row the user can see and
//   JS groups them in one walk — avoids an N+1 pattern that would become
//   pathological on large libraries. SQLite handles the join cheaply and
//   the row volume is bounded by track count, not track × albums.
// - Albums with ZERO reachable tracks (all tracks live in libraries the
//   user doesn't have access to) are filtered by the library-id IN clause
//   on the tracks side — they won't appear in the rowset at all.
// - disc_number NULL coalesces to disc 1 so single-disc albums that
//   stored NULL and single-disc albums that stored 1 group identically.
//   Multi-disc albums get one `discs[]` entry per distinct non-null
//   value; the UI renders "Disc N" when label is null.
// - track.filepath is emitted pre-joined to the library name so the
//   Velvet player's Player.setQueue() can feed it straight to /media/…
//   without a second round-trip. Always forward slashes.

import * as db from '../db/manager.js';
import { libraryFilter } from './db.js';

const d = () => db.getDB();

function rowsToAlbums(rows) {
  // Map<albumId, album> — preserves first-seen order which, because the
  // SQL ORDER BY is `al.name`, corresponds to alphabetical album name.
  const byId = new Map();

  for (const r of rows) {
    const albumKey = String(r.album_id);
    let album = byId.get(albumKey);
    if (!album) {
      album = {
        id: albumKey,
        displayName: r.album_name || '(Unknown Album)',
        artist: r.album_artist || null,
        year: r.year || null,
        aaFile: r.album_art_file || null,
        artFile: null,         // reserved for folder-scan mode
        seriesId: null,        // reserved for series grouping
        discs: new Map(),      // discNumber → { label, discIndex, tracks }
      };
      byId.set(albumKey, album);
    }

    // Coalesce NULL disc_number into 1 so "track from single-disc album
    // with disc=NULL" doesn't end up in a separate bucket from
    // "track from single-disc album with disc=1".
    const discIndex = r.disc_number || 1;
    let disc = album.discs.get(discIndex);
    if (!disc) {
      disc = { label: null, discIndex, tracks: [] };
      album.discs.set(discIndex, disc);
    }

    disc.tracks.push({
      // vpath-qualified path — what the Velvet player feeds to /media/…
      filepath: `${r.library_name}/${r.filepath}`,
      title: r.title || null,
      artist: r.track_artist || album.artist || null,
      number: r.track_number || null,
      duration: r.duration || null,
    });
  }

  // Materialize discs as sorted arrays; drop the Map.
  const out = [];
  for (const album of byId.values()) {
    const discs = Array.from(album.discs.values())
      .sort((a, b) => a.discIndex - b.discIndex);
    // If the album is single-disc, the UI treats a single entry as
    // "no disc tabs" and renders the track list flat. We still emit
    // the single-element discs array — that's what the UI iterates.
    out.push({ ...album, discs });
  }
  return out;
}

export function setup(mstream) {

  mstream.get('/api/v1/albums/browse', (req, res) => {
    const f = libraryFilter(req.user);
    if (f.clause === '1=0') {
      return res.json({ albums: [], series: [] });
    }

    const rows = d().prepare(`
      SELECT
        al.id               AS album_id,
        al.name             AS album_name,
        al.year             AS year,
        al.album_art_file   AS album_art_file,
        aa.name             AS album_artist,
        t.id                AS track_id,
        t.filepath          AS filepath,
        t.title             AS title,
        t.track_number      AS track_number,
        t.disc_number       AS disc_number,
        t.duration          AS duration,
        ta.name             AS track_artist,
        l.name              AS library_name
      FROM tracks t
      JOIN albums    al ON t.album_id = al.id
      JOIN libraries l  ON l.id = t.library_id
      LEFT JOIN artists aa ON al.artist_id = aa.id
      LEFT JOIN artists ta ON t.artist_id  = ta.id
      WHERE ${f.clause}
      ORDER BY al.name COLLATE NOCASE,
               t.disc_number,
               t.track_number,
               t.title COLLATE NOCASE
    `).all(...f.params);

    const albums = rowsToAlbums(rows);
    res.json({ albums, series: [] });
  });
}
