// Velvet UI API endpoints
// Real implementations where the data exists in our SQLite DB,
// stubs for features that aren't implemented yet.

import fs from 'node:fs';
import path from 'node:path';
import * as db from '../db/manager.js';
import * as config from '../state/config.js';
import { renderMetadataObj, libraryFilter, trackQuery } from './db.js';
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
    // Emit `aaFile` alongside `album_art_file` so the Velvet UI (which reads
    // `aaFile`) can render art. The legacy field is kept for any older
    // consumer that may still parse it.
    res.json({ albums: rows.map(r => ({ ...r, aaFile: r.album_art_file })) });
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
    const rows = d().prepare(`
      SELECT DISTINCT al.name, a.name AS artist, al.year, al.album_art_file
      FROM albums al
      JOIN tracks t ON t.album_id = al.id
      JOIN track_genres tg ON tg.track_id = t.id
      JOIN genres g ON g.id = tg.genre_id
      LEFT JOIN artists a ON al.artist_id = a.id
      WHERE g.name = ? AND ${f.clause}
      ORDER BY al.name COLLATE NOCASE
    `).all(genre, ...f.params);
    // See decade/albums above for why we emit both field names.
    res.json({ albums: rows.map(r => ({ ...r, aaFile: r.album_art_file })) });
  });

  mstream.post('/api/v1/db/genre/songs', (req, res) => {
    const genre = req.body.genre;
    if (!genre) return res.json([]);
    const f = libraryFilter(req.user);
    const rows = d().prepare(`
      ${trackQuery(req.user?.id)}
      JOIN track_genres tg ON tg.track_id = t.id
      JOIN genres g ON g.id = tg.genre_id
      WHERE g.name = ? AND ${f.clause}
      ORDER BY a.name COLLATE NOCASE, al.name COLLATE NOCASE, t.track_number
    `).all(...(req.user?.id ? [req.user.id] : []), genre, ...f.params);
    res.json(rows.map(renderMetadataObj));
  });

  // `/api/v1/albums/browse` now lives in its own module (src/api/albums-browse.js)
  // — the old flat stub returned a shape the Velvet UI couldn't consume, so
  // the Albums page was effectively dead. See that file for the response
  // contract and disc-grouping logic.

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
    // Velvet reads `aaFile`; older consumers (e.g. docs-driven clients)
    // may still look for `file`. Emit both so neither path silently fails.
    res.json({ file: artFile, aaFile: artFile });
  });

  // ── Folder-scanned album art ─────────────────────────────────
  // Serves an art file (cover.jpg / folder.jpg / etc.) located inside a
  // library root, addressed by its vpath-qualified relative path. The
  // Velvet Album Library uses this for albums whose art was scanned from
  // the filesystem rather than extracted into the image-cache directory.
  //
  // Our scanner today always routes art through the image-cache (served
  // via /album-art/<file>), so most installations will populate `aaFile`
  // on album rows and never hit this endpoint. It exists for two cases:
  //   1. External tooling that stores cover.jpg next to audio files.
  //   2. The Velvet "Albums Only" folder-scan mode (partial support —
  //      albums-browse emits `artFile` on a per-album basis when we can
  //      locate folder art).
  //
  // Path parameter `p` is a vpath-qualified relative path like
  // "Music/Artist/Album/cover.jpg". We split off the vpath name, resolve
  // against the library root, and enforce a traversal guard identical to
  // time-seek.js — no symlink escapes, no `..` shenanigans.
  mstream.get('/api/v1/albums/art-file', (req, res) => {
    const p = req.query.p;
    if (!p || typeof p !== 'string') { return res.status(400).json({ error: 'missing path' }); }

    // Split `p` into vpath (first segment) + relative path (rest).
    const firstSlash = p.indexOf('/');
    if (firstSlash <= 0) { return res.status(400).json({ error: 'invalid path' }); }
    const vpathName = p.slice(0, firstSlash);
    const relPath = p.slice(firstSlash + 1);
    if (!relPath) { return res.status(400).json({ error: 'invalid path' }); }

    // Require the caller to have access to the library.
    const vpaths = req.user?.vpaths || [];
    if (!vpaths.includes(vpathName)) { return res.status(403).json({ error: 'access denied' }); }
    const lib = db.getLibraryByName(vpathName);
    if (!lib) { return res.status(404).json({ error: 'library not found' }); }

    // Traversal guard — identical pattern to src/dlna/time-seek.js.
    const resolved = path.resolve(path.join(lib.root_path, ...relPath.split('/')));
    const root = path.resolve(lib.root_path);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      return res.status(403).json({ error: 'path traversal' });
    }
    if (!fs.existsSync(resolved)) { return res.status(404).json({ error: 'not found' }); }

    // Only serve known image extensions. Anything else is a mistake in the
    // URL (or an attempt to exfiltrate an audio file through the art path).
    const ext = path.extname(resolved).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) {
      return res.status(415).json({ error: 'unsupported type' });
    }
    res.sendFile(resolved, { dotfiles: 'allow' });
  });

  // ── Share list and delete ────────────────────────────────────
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

  // `/api/v1/admin/directories` is implemented by src/api/admin.js and
  // admin-gated by its prefix middleware; the earlier stub here was dead
  // code (admin.js mounts first, emits the keyed-object shape the Velvet
  // admin panel reads) and returned a different shape which would have
  // broken the admin panel if it ever won the load race.

  // ── Scan progress (reads from scan_progress table written by scanners) ──
  mstream.get('/api/v1/admin/db/scan/progress', (req, res) => {
    const rows = d().prepare('SELECT * FROM scan_progress').all();
    res.json(rows.map(r => ({
      vpath: r.vpath || 'Scanning…',
      pct: r.expected ? Math.min(100, Math.round((r.scanned / r.expected) * 100)) : null,
      scanned: r.scanned || 0,
      expected: r.expected || null,
      currentFile: r.current_file || null,
      countingFound: 0
    })));
  });

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

  // Last.fm status
  mstream.get('/api/v1/lastfm/status', (req, res) => {
    const hasApiKey = !!(config.program.lastFM?.apiKey);
    const linkedUser = req.user?.lastfm_user || null;
    res.json({
      serverEnabled: hasApiKey,
      hasApiKey,
      linkedUser
    });
  });

  // Last.fm connect/disconnect (update user's lastfm credentials in DB)
  mstream.post('/api/v1/lastfm/connect', (req, res) => {
    const { lastfmUser, lastfmPassword } = req.body;
    if (!lastfmUser || !lastfmPassword || !req.user?.id) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    d().prepare('UPDATE users SET lastfm_user = ?, lastfm_password = ? WHERE id = ?')
      .run(lastfmUser, lastfmPassword, req.user.id);
    db.invalidateCache();
    res.json({ ok: true });
  });

  mstream.post('/api/v1/lastfm/disconnect', (req, res) => {
    if (!req.user?.id) return res.json({ ok: true });
    d().prepare('UPDATE users SET lastfm_user = NULL, lastfm_password = NULL WHERE id = ?')
      .run(req.user.id);
    db.invalidateCache();
    res.json({ ok: true });
  });

  // Similar artists via Last.fm API (powers Auto-DJ recommendations)
  mstream.get('/api/v1/lastfm/similar-artists', async (req, res) => {
    const artist = req.query.artist;
    const apiKey = config.program.lastFM?.apiKey;
    if (!artist || !apiKey) return res.json({ artists: [] });

    try {
      const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getsimilar&artist=${encodeURIComponent(artist)}&api_key=${apiKey}&format=json&limit=15`;
      const r = await fetch(url, { headers: { 'User-Agent': 'mStream/6.0' } });
      if (!r.ok) return res.json({ artists: [] });
      const data = await r.json();
      const names = (data?.similarartists?.artist || []).map(a => a.name).filter(Boolean);
      res.json({ artists: names });
    } catch (_) {
      res.json({ artists: [] });
    }
  });

  // Cue points — handled by cuepoints.js (loaded before stubs)

  // Wrapped session end — handled by wrapped.js

  // Discogs — handled by discogs.js (loaded before stubs)

  // ── Subsonic password setter ─────────────────────────────────
  // Admin-scoped (the /api/v1/admin/* prefix middleware in admin.js gates
  // this route for us). Accepts {username, password} and writes plaintext
  // to users.subsonic_password. Empty password clears it.
  //
  // Subsonic auth (src/api/subsonic/auth.js:userForPassword) checks this
  // column before falling through to the mStream PBKDF2 comparison, so
  // users can give Subsonic clients a simpler / app-specific password
  // without revealing (or weakening) their main login. We deliberately
  // store plaintext — Subsonic's u/p handshake has no protocol-level
  // support for hashed comparison, and token auth requires the plaintext
  // server-side anyway. Document the tradeoff in the admin UI.
  mstream.post('/api/v1/admin/users/subsonic-password', (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || !username) {
      return res.status(400).json({ error: 'username required' });
    }
    if (password !== null && typeof password !== 'string') {
      return res.status(400).json({ error: 'password must be string or null' });
    }
    const user = db.getUserByUsername(username);
    if (!user) return res.status(404).json({ error: 'user not found' });

    // Empty-string → null so the auth path's truthiness check works as
    // "is a Subsonic password set?".
    const valueToStore = password ? String(password) : null;
    d().prepare('UPDATE users SET subsonic_password = ? WHERE id = ?')
      .run(valueToStore, user.id);
    db.invalidateCache();
    res.json({ ok: true });
  });

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
      if (genre !== undefined) { updates.push('genre = ?'); params.push(genre || null); }

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

      res.json({ ok: true });
    } catch (e) {
      try { await fsp.unlink(tmpOut); } catch (_) {}
      res.status(500).json({ error: e.message || 'Tag write failed' });
    }
  });

  // File delete — removes a file from disk and its DB row.
  //
  // The endpoint name is historical ("recording" from the radio-recording
  // feature in the upstream Velvet fork); the Velvet player also calls it
  // from the playlist context menu for arbitrary tracks. Safeguards:
  //   • user must be authenticated;
  //   • server-wide noFileModify or per-user allow_file_modify = 0 blocks
  //     the operation (same gate as the tag-writer + album-art-embed
  //     paths);
  //   • path is resolved through getVPathInfo so the caller can only
  //     address files in libraries they already have access to;
  //   • traversal guard matches the pattern in src/dlna/time-seek.js.
  mstream.delete('/api/v1/files/recording', (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'unauthorized' });

    const filepath = req.body?.filepath;
    if (typeof filepath !== 'string' || !filepath) {
      return res.status(400).json({ error: 'filepath required' });
    }

    const canModify = !config.program.noFileModify
      && req.user.allow_file_modify !== false
      && req.user.allow_file_modify !== 0;
    if (!canModify) return res.status(403).json({ error: 'File modification not allowed' });

    let pathInfo;
    try { pathInfo = getVPathInfo(filepath, req.user); }
    catch (_) { return res.status(403).json({ error: 'access denied' }); }

    const lib = db.getLibraryByName(pathInfo.vpath);
    if (!lib) return res.status(404).json({ error: 'library not found' });

    const resolved = path.resolve(path.join(lib.root_path, pathInfo.relativePath));
    const root = path.resolve(lib.root_path);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      return res.status(403).json({ error: 'path traversal' });
    }

    try { fs.unlinkSync(resolved); }
    catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'file not found' });
      return res.status(500).json({ error: err.message });
    }

    // Drop the DB row so the track disappears from browse/search without
    // waiting for the next scan. user_metadata (keyed on track_hash) and
    // playlist_tracks (keyed on the filepath string, not track_id — that
    // denormalisation is intentional so ids reshuffling on rescan doesn't
    // corrupt playlists) are *not* cascaded. A stale user_metadata row
    // becomes unreachable once the track is gone; a playlist_tracks entry
    // will just fail to resolve and get skipped at playback time. Both
    // outcomes are benign and self-healing.
    d().prepare('DELETE FROM tracks WHERE filepath = ? AND library_id = ?')
      .run(pathInfo.relativePath, lib.id);

    res.json({ ok: true });
  });

  // Playlist rename — handled by playlist.js
}
