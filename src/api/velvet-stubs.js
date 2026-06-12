// Velvet UI API endpoints
// Real implementations where the data exists in our SQLite DB,
// stubs for features that aren't implemented yet.

import * as db from '../db/manager.js';
import * as config from '../state/config.js';
import { renderMetadataObj, libraryFilter, trackQuery } from './db.js';
import { warmScrobbleUser } from './scrobbler.js';
import { getVPathInfo } from '../util/vpath.js';

const d = () => db.getDB();

export function setup(mstream) {

  // ══════════════════════════════════════════════════════════════
  // REAL IMPLEMENTATIONS — backed by our SQLite DB
  // ══════════════════════════════════════════════════════════════

  // ── Decade browsing ──────────────────────────────────────────
  mstream.get('/api/v1/db/decades', (req, res) => {
    const f = libraryFilter(req.user);
    const rows = d().prepare(`
      SELECT
        CAST(t.year / 10 * 10 AS INTEGER) AS decade,
        COUNT(*) AS cnt,
        COUNT(DISTINCT t.album_id) AS albums
      FROM tracks t
      WHERE t.year IS NOT NULL AND t.year > 0 AND ${f.clause}
      GROUP BY decade
      ORDER BY decade DESC
    `).all(...f.params);
    res.json({ decades: rows });
  });

  mstream.post('/api/v1/db/decade/albums', (req, res) => {
    const decade = parseInt(req.body.decade);
    if (isNaN(decade)) return res.json({ albums: [] });
    const f = libraryFilter(req.user);
    const rows = d().prepare(`
      SELECT DISTINCT al.name, a.name AS artist, al.year, al.album_art_file
      FROM albums al
      JOIN tracks t ON t.album_id = al.id
      LEFT JOIN artists a ON al.artist_id = a.id
      WHERE t.year >= ? AND t.year < ? AND ${f.clause}
      ORDER BY al.name COLLATE NOCASE
    `).all(decade, decade + 10, ...f.params);
    res.json({ albums: rows });
  });

  mstream.post('/api/v1/db/decade/songs', (req, res) => {
    const decade = parseInt(req.body.decade);
    if (isNaN(decade)) return res.json([]);
    const f = libraryFilter(req.user);
    const rows = d().prepare(`
      ${trackQuery(req.user?.id)}
      WHERE t.year >= ? AND t.year < ? AND ${f.clause}
      ORDER BY a.name COLLATE NOCASE, al.name COLLATE NOCASE, t.track_number
    `).all(...(req.user?.id ? [req.user.id] : []), decade, decade + 10, ...f.params);
    res.json(rows.map(renderMetadataObj));
  });

  // ── Genre groups ─────────────────────────────────────────────
  mstream.get('/api/v1/db/genre-groups', (req, res) => {
    const f = libraryFilter(req.user);
    const rows = d().prepare(`
      SELECT g.name AS genre, COUNT(DISTINCT tg.track_id) AS count
      FROM genres g
      JOIN track_genres tg ON tg.genre_id = g.id
      JOIN tracks t ON t.id = tg.track_id
      WHERE ${f.clause}
      GROUP BY g.id
      ORDER BY g.name COLLATE NOCASE
    `).all(...f.params);
    res.json({ genres: rows, groups: null });
  });

  mstream.post('/api/v1/db/genre/albums', (req, res) => {
    const genre = req.body.genre;
    if (!genre) return res.json({ albums: [] });
    const f = libraryFilter(req.user);
    // V34: case-insensitive name match — folds in the case-sensitivity
    // fix flagged in the genre scout. Clients pick names from
    // /api/v1/db/genres which canonicalises case; this guards against
    // legacy clients that lower-case the value before sending it back.
    const rows = d().prepare(`
      SELECT DISTINCT al.name, a.name AS artist, al.year, al.album_art_file
      FROM albums al
      JOIN tracks t ON t.album_id = al.id
      JOIN track_genres tg ON tg.track_id = t.id
      JOIN genres g ON g.id = tg.genre_id
      LEFT JOIN artists a ON al.artist_id = a.id
      WHERE g.name COLLATE NOCASE = ? AND ${f.clause}
      ORDER BY al.name COLLATE NOCASE
    `).all(genre, ...f.params);
    res.json({ albums: rows });
  });

  mstream.post('/api/v1/db/genre/songs', (req, res) => {
    const genre = req.body.genre;
    if (!genre) return res.json([]);
    const f = libraryFilter(req.user);
    const rows = d().prepare(`
      ${trackQuery(req.user?.id)}
      JOIN track_genres tg ON tg.track_id = t.id
      JOIN genres g ON g.id = tg.genre_id
      WHERE g.name COLLATE NOCASE = ? AND ${f.clause}
      ORDER BY a.name COLLATE NOCASE, al.name COLLATE NOCASE, t.track_number
    `).all(...(req.user?.id ? [req.user.id] : []), genre, ...f.params);
    res.json(rows.map(renderMetadataObj));
  });

  // ── Album library browse ─────────────────────────────────────
  mstream.get('/api/v1/albums/browse', (req, res) => {
    const f = libraryFilter(req.user);
    const rows = d().prepare(`
      SELECT al.id, al.name, a.name AS artist, al.year, al.album_art_file,
             COUNT(t.id) AS track_count
      FROM albums al
      JOIN tracks t ON t.album_id = al.id
      LEFT JOIN artists a ON al.artist_id = a.id
      WHERE ${f.clause}
      GROUP BY al.id
      ORDER BY al.name COLLATE NOCASE
    `).all(...f.params);
    // Velvet expects displayName (from its Albums Only folder mode)
    const albums = rows.map(r => ({
      ...r,
      displayName: r.name + (r.artist ? ` — ${r.artist}` : ''),
    }));
    res.json({ albums, series: [] });
  });

  // ── Multi-artist album query ─────────────────────────────────
  // V17: match albums where ANY of the requested artists appears in
  // album_artists (compilation/collab) OR is the primary album-artist.
  mstream.post('/api/v1/db/artists-albums-multi', (req, res) => {
    const artists = req.body.artists;
    if (!Array.isArray(artists) || !artists.length) return res.json({ albums: [] });
    const f = libraryFilter(req.user);
    const placeholders = artists.map(() => '?').join(',');
    const rows = d().prepare(`
      SELECT DISTINCT al.name, a.name AS artist, al.year, al.album_art_file
      FROM albums al
      JOIN tracks t ON t.album_id = al.id
      LEFT JOIN artists a ON al.artist_id = a.id
      WHERE (
        a.name COLLATE NOCASE IN (${placeholders})
        OR al.id IN (SELECT aa.album_id FROM album_artists aa
                     JOIN artists aa2 ON aa2.id = aa.artist_id
                     WHERE aa2.name COLLATE NOCASE IN (${placeholders}))
      ) AND ${f.clause}
      ORDER BY al.year DESC, al.name COLLATE NOCASE
    `).all(...artists, ...artists, ...f.params);
    res.json({ albums: rows });
  });

  // ── Songs by artists (Auto-DJ) ──────────────────────────────
  mstream.post('/api/v1/db/songs-by-artists', (req, res) => {
    const artists = req.body.artists;
    const limit = Math.min(parseInt(req.body.limit) || 50, 200);
    if (!Array.isArray(artists) || !artists.length) return res.json([]);
    const f = libraryFilter(req.user);
    const placeholders = artists.map(() => '?').join(',');
    const rows = d().prepare(`
      ${trackQuery(req.user?.id)}
      WHERE a.name COLLATE NOCASE IN (${placeholders}) AND ${f.clause}
      ORDER BY RANDOM()
      LIMIT ?
    `).all(...(req.user?.id ? [req.user.id] : []), ...artists, ...f.params, limit);
    res.json(rows.map(renderMetadataObj));
  });

  // ── Play logging ─────────────────────────────────────────────
  // In public/no-users mode the play count hangs off the V25 anonymous
  // sentinel — the operator's "what I've been listening to" history,
  // same model as user_metadata.rating and the playlists table.
  mstream.post('/api/v1/db/stats/log-play', (req, res) => {
    const filePath = req.body.filePath;
    if (!filePath || !req.user?.id) return res.json({ ok: true });

    let pathInfo;
    try { pathInfo = getVPathInfo(filePath, req.user); } catch (_) { return res.json({ ok: true }); }
    const lib = db.getLibraryByName(pathInfo.vpath);
    if (!lib) return res.json({ ok: true });

    const track = d().prepare(
      'SELECT file_hash, audio_hash FROM tracks WHERE filepath = ? AND library_id = ?'
    ).get(pathInfo.relativePath, lib.id);
    if (!track) return res.json({ ok: true });
    const trackKey = track.audio_hash || track.file_hash;
    // Hashless row (failed parse): track_hash is NOT NULL — binding
    // null would 500 on the constraint instead of no-opping.
    if (!trackKey) return res.json({ ok: true });

    d().prepare(`
      INSERT INTO user_metadata (user_id, track_hash, play_count, last_played)
      VALUES (?, ?, 1, datetime('now'))
      ON CONFLICT(user_id, track_hash) DO UPDATE SET
        play_count = play_count + 1,
        last_played = datetime('now')
    `).run(req.user.id, trackKey);

    res.json({ ok: true });
  });

  mstream.post('/api/v1/db/stats/reset-play-counts', (req, res) => {
    if (!req.user?.id) return res.json({ ok: true });
    d().prepare('UPDATE user_metadata SET play_count = 0 WHERE user_id = ?').run(req.user.id);
    res.json({ ok: true });
  });

  mstream.post('/api/v1/db/stats/reset-recently-played', (req, res) => {
    if (!req.user?.id) return res.json({ ok: true });
    d().prepare('UPDATE user_metadata SET last_played = NULL WHERE user_id = ?').run(req.user.id);
    res.json({ ok: true });
  });

  // ── File art (by filepath) ──────────────────────────────────
  mstream.get('/api/v1/files/art', (req, res) => {
    const fp = req.query.fp;
    if (!fp) return res.status(404).json({ error: 'missing filepath' });

    let pathInfo;
    try { pathInfo = getVPathInfo(fp, req.user); } catch (_) { return res.status(403).json({ error: 'access denied' }); }
    const lib = db.getLibraryByName(pathInfo.vpath);
    if (!lib) return res.status(404).json({ error: 'not found' });

    const row = d().prepare(`
      SELECT t.album_art_file, al.album_art_file AS album_album_art_file
      FROM tracks t
      LEFT JOIN albums al ON t.album_id = al.id
      WHERE t.filepath = ? AND t.library_id = ?
    `).get(pathInfo.relativePath, lib.id);

    const artFile = row?.album_art_file || row?.album_album_art_file;
    if (!artFile) return res.status(404).json({ error: 'no art' });
    res.json({ file: artFile });
  });

  // ── Share list and delete ────────────────────────────────────
  // In public/no-users mode the rows are scoped to the V25 anonymous
  // sentinel. Share links are intentionally public-by-design — they
  // carry their own access token in the URL — so listing them under
  // the sentinel just gives the operator a "manage shares I created"
  // surface in single-user public deployments.
  mstream.get('/api/v1/share/list', (req, res) => {
    if (!req.user?.id) return res.json([]);
    const rows = d().prepare(
      'SELECT share_id, playlist_json, expires, created_at FROM shared_playlists WHERE user_id = ? ORDER BY created_at DESC'
    ).all(req.user.id);
    res.json(rows.map(r => {
      let songCount = 0;
      try { songCount = JSON.parse(r.playlist_json).length; } catch (_) {}
      return {
        playlistId: r.share_id,
        songCount,
        expires: r.expires || null,
        createdAt: r.created_at
      };
    }));
  });

  mstream.delete('/api/v1/share/:id', (req, res) => {
    if (!req.user?.id) return res.status(403).json({ error: 'unauthorized' });
    d().prepare('DELETE FROM shared_playlists WHERE share_id = ? AND user_id = ?').run(req.params.id, req.user.id);
    res.json({ ok: true });
  });

  // ── Admin directories (for checking admin status) ────────────
  mstream.get('/api/v1/admin/directories', (req, res) => {
    if (!req.user?.admin) return res.status(403).json({ error: 'not admin' });
    const libs = db.getAllLibraries();
    res.json(libs.map(l => ({ name: l.name, root: l.root_path, type: l.type })));
  });

  // Scan progress moved to /api/v1/scan/progress (core API, not admin-only,
  // vpath-filtered per caller, basenames only). See src/api/scan.js.

  // ══════════════════════════════════════════════════════════════
  // STUBS — features not yet implemented, return safe defaults
  // ══════════════════════════════════════════════════════════════

  // User settings — handled by user-settings.js (loaded before stubs)

  // Wrapped / stats — handled by wrapped.js (loaded before stubs)

  // Radio
  mstream.get('/api/v1/radio/stations', (req, res) => res.json([]));
  mstream.get('/api/v1/radio/enabled', (req, res) => res.json({ enabled: false }));
  mstream.get('/api/v1/radio/schedules', (req, res) => res.json([]));

  // Podcasts
  mstream.get('/api/v1/podcast/feeds', (req, res) => res.json([]));

  // Smart playlists — handled by smart-playlists.js (loaded before stubs)

  // Waveform — handled by waveform.js (loaded before stubs)

  // ListenBrainz — handled by listenbrainz.js (loaded before stubs)

  // /api/v1/lastfm/status moved to src/api/scrobbler.js — the
  // default-UI Auto-DJ panel (PR-E client work) needs to gate the
  // "Similar artists" toggle on whether a Last.fm API key is
  // configured, and `velvet-stubs.js` only loads when
  // `ui === 'velvet'`. Same reason `/api/v1/lastfm/similar-artists`
  // was moved in PR #587.

  // Last.fm connect/disconnect (update user's lastfm credentials in DB).
  //
  // Public/no-users mode is supported: writes target the V25 anonymous
  // sentinel via req.user.id, which auth.js's no-users branch pins for
  // the operator. Admin-gated to prevent random viewers in adminLocked
  // public deployments from overwriting the operator's stored Last.fm
  // credentials. Same gate the ListenBrainz handlers use.
  //
  // After saving creds we warm the Scribble session map so the next
  // /scrobble-by-filepath call doesn't need a server restart to pick
  // them up — the boot-time pre-load only covers credentials present
  // when scrobbler.setup() ran.
  mstream.post('/api/v1/lastfm/connect', (req, res) => {
    const { lastfmUser, lastfmPassword } = req.body;
    if (!lastfmUser || !lastfmPassword) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    if (!req.user?.admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    d().prepare('UPDATE users SET lastfm_user = ?, lastfm_password = ? WHERE id = ?')
      .run(lastfmUser, lastfmPassword, req.user.id);
    db.invalidateCache();
    warmScrobbleUser(lastfmUser, lastfmPassword);
    res.json({ ok: true });
  });

  mstream.post('/api/v1/lastfm/disconnect', (req, res) => {
    if (!req.user?.admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    d().prepare('UPDATE users SET lastfm_user = NULL, lastfm_password = NULL WHERE id = ?')
      .run(req.user.id);
    db.invalidateCache();
    res.json({ ok: true });
  });

  // /api/v1/lastfm/similar-artists moved to src/api/scrobbler.js
  // — the route is consumed by the core random-songs Auto-DJ route
  // (PR D) which is available in BOTH default and velvet UI modes,
  // so the endpoint can't be gated on `ui === 'velvet'`.

  // Cue points — handled by cuepoints.js (loaded before stubs)

  // Wrapped session end — handled by wrapped.js

  // Discogs — handled by discogs.js (loaded before stubs)

  // Subsonic password — handled by admin.js (POST /api/v1/admin/users/subsonic-password)
  // which is registered before this file, so a 501 stub here was unreachable dead code.

  // ID3 tag writing — write metadata tags to audio files via ffmpeg
  mstream.post('/api/v1/admin/tags/write', async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'unauthorized' });

    const { filepath, title, artist, album, year, genre, track, disk } = req.body;
    if (!filepath) return res.status(400).json({ error: 'filepath required' });

    // Check file modification permission
    const canModify = !config.program.noFileModify
      && req.user.allow_file_modify !== false
      && req.user.allow_file_modify !== 0;
    if (!canModify) return res.status(403).json({ error: 'File modification not allowed' });

    // Resolve the file path
    const { getVPathInfo } = await import('../util/vpath.js');
    const { ffmpegBin } = await import('../util/ffmpeg-bootstrap.js');
    const { isDownloaded } = await import('./transcode.js');
    const { spawn } = await import('child_process');
    const fsp = (await import('fs/promises')).default;
    const path = (await import('path')).default;

    if (!isDownloaded()) return res.status(500).json({ error: 'ffmpeg not available' });

    let pathInfo;
    try { pathInfo = getVPathInfo(filepath, req.user); } catch (_) {
      return res.status(404).json({ error: 'file not found' });
    }
    const lib = db.getLibraryByName(pathInfo.vpath);
    if (!lib) return res.status(404).json({ error: 'library not found' });

    const fullPath = path.join(lib.root_path, pathInfo.relativePath);
    const ext = path.extname(fullPath).toLowerCase();
    const tmpOut = fullPath + '.tmp_tags' + ext;

    // Build ffmpeg metadata args
    const ffmpegArgs = ['-i', fullPath, '-c', 'copy'];
    if (title !== undefined)  ffmpegArgs.push('-metadata', `title=${title}`);
    if (artist !== undefined) ffmpegArgs.push('-metadata', `artist=${artist}`);
    if (album !== undefined)  ffmpegArgs.push('-metadata', `album=${album}`);
    if (year !== undefined)   ffmpegArgs.push('-metadata', `date=${year}`);
    if (genre !== undefined)  ffmpegArgs.push('-metadata', `genre=${genre}`);
    if (track !== undefined)  ffmpegArgs.push('-metadata', `track=${track}`);
    if (disk !== undefined)   ffmpegArgs.push('-metadata', `disc=${disk}`);
    ffmpegArgs.push('-y', tmpOut);

    try {
      await new Promise((resolve, reject) => {
        const proc = spawn(ffmpegBin(), ffmpegArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
        const timer = setTimeout(() => { proc.kill('SIGTERM'); reject(new Error('ffmpeg timeout')); }, 30000);
        proc.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('ffmpeg failed')); });
        proc.on('error', (err) => { clearTimeout(timer); reject(err); });
      });

      await fsp.rename(tmpOut, fullPath);

      // Update DB to match new tags
      const updates = [];
      const params = [];
      if (title !== undefined) { updates.push('title = ?'); params.push(title || null); }
      if (year !== undefined)  { updates.push('year = ?');  params.push(year ? Number(year) || null : null); }
      if (track !== undefined) { updates.push('track_number = ?'); params.push(track ? Number(track) || null : null); }
      if (disk !== undefined)  { updates.push('disc_number = ?');  params.push(disk ? Number(disk) || null : null); }
      // V34: tracks.genre dropped — genre tag changes flow through
      // the track_genres M2M instead. Handled after the UPDATE below
      // (we need the track's id, which we look up by filepath+lib).
      //
      // Note this was also a latent bug pre-V34: the old code only
      // updated the flat column, never the M2M, so a tag edit on a
      // genre would silently fall out of sync with what every M2M-
      // aware reader (alpha-UI getGenres) saw. After this PR the M2M
      // is the only path and the bug is gone.

      if (artist !== undefined) {
        const artistId = db.findOrCreateArtist(artist || null);
        updates.push('artist_id = ?'); params.push(artistId);
      }
      if (album !== undefined) {
        const artistName = artist !== undefined ? artist : null;
        const artistId = db.findOrCreateArtist(artistName);
        const albumId = db.findOrCreateAlbum(album || null, artistId, year ? Number(year) || null : null);
        updates.push('album_id = ?'); params.push(albumId);
      }

      if (updates.length > 0) {
        params.push(pathInfo.relativePath, lib.id);
        d().prepare(`UPDATE tracks SET ${updates.join(', ')} WHERE filepath = ? AND library_id = ?`).run(...params);
      }

      // V34: apply genre changes via the M2M. Look up the track id
      // (filepath+library is unique enough to identify it) and
      // replace its track_genres rows.
      if (genre !== undefined) {
        const trackRow = d().prepare(
          'SELECT id FROM tracks WHERE filepath = ? AND library_id = ?'
        ).get(pathInfo.relativePath, lib.id);
        if (trackRow) {
          db.replaceTrackGenres(trackRow.id, genre || null);
        }
      }

      res.json({ ok: true });
    } catch (e) {
      try { await fsp.unlink(tmpOut); } catch (_) {}
      res.status(500).json({ error: e.message || 'Tag write failed' });
    }
  });

  // File delete (recordings)
  mstream.delete('/api/v1/files/recording', (req, res) => res.status(501).json({ error: 'Not implemented' }));

  // Playlist rename — handled by playlist.js
}
