import Joi from 'joi';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as transcode from './transcode.js';
import { joiValidate, resolveId } from '../util/validation.js';
import WebError from '../util/web-error.js';

export function setup(mstream) {
  const d = () => db.getDB();

  // ── Ping (initial app load) ─────────────────────────────────────────────

  mstream.get('/api/v1/ping', (req, res) => {
    // Signal "transcoding available" only when ffmpeg actually resolved
    // (bundled binaries ready OR system-PATH fallback succeeded).
    let transcodeInfo = false;
    if (transcode.isDownloaded() && config.program.transcode) {
      transcodeInfo = {
        defaultCodec: config.program.transcode.defaultCodec,
        defaultBitrate: config.program.transcode.defaultBitrate
      };
    }

    // Get user's library names
    const vpaths = req.user.vpaths || [];

    const returnThis = {
      vpaths,
      playlists: getPlaylists(req.user.id),
      transcode: transcodeInfo,
      noMkdir: config.program.noMkdir || req.user.allow_mkdir === false || req.user.allow_mkdir === 0,
      noUpload: config.program.noUpload || req.user.allow_upload === false || req.user.allow_upload === 0,
      noFileModify: config.program.noFileModify || req.user.allow_file_modify === false || req.user.allow_file_modify === 0,
      // VELVET ONLY: redundant with noUpload — update Velvet UI to use noUpload instead, then remove this
      allowYoutubeDownload: !(config.program.noUpload || req.user.allow_upload === false || req.user.allow_upload === 0),
      supportedAudioFiles: config.program.supportedAudioFiles,
      vpathMetaData: {}
    };

    // Get library type metadata
    for (const vpathName of vpaths) {
      const lib = db.getLibraryByName(vpathName);
      if (lib) {
        returnThis.vpathMetaData[vpathName] = { type: lib.type };
      }
    }

    res.json(returnThis);
  });

  // ── Delete playlist ─────────────────────────────────────────────────────

  mstream.post('/api/v1/playlist/delete', (req, res) => {
    const schema = Joi.object({ playlistname: Joi.string().required() });
    joiValidate(schema, req.body);

    d().prepare(
      'DELETE FROM playlists WHERE name = ? AND user_id = ?'
    ).run(req.body.playlistname, req.user.id);

    res.json({});
  });

  // ── Add song to playlist ────────────────────────────────────────────────

  mstream.post('/api/v1/playlist/add-song', (req, res) => {
    const schema = Joi.object({
      song: Joi.string().required(),
      playlist: Joi.string().required()
    });
    joiValidate(schema, req.body);

    // Ensure playlist exists
    let playlist = d().prepare(
      'SELECT id FROM playlists WHERE name = ? AND user_id = ?'
    ).get(req.body.playlist, req.user.id);

    if (!playlist) {
      const result = d().prepare(
        'INSERT INTO playlists (name, user_id) VALUES (?, ?)'
      ).run(req.body.playlist, req.user.id);
      playlist = { id: Number(result.lastInsertRowid) };
    }

    // Get next position
    const maxPos = d().prepare(
      'SELECT COALESCE(MAX(position), -1) AS max_pos FROM playlist_tracks WHERE playlist_id = ?'
    ).get(playlist.id);

    d().prepare(
      'INSERT INTO playlist_tracks (playlist_id, filepath, position) VALUES (?, ?, ?)'
    ).run(playlist.id, req.body.song, maxPos.max_pos + 1);

    res.json({});
  });

  // ── Remove song from playlist ───────────────────────────────────────────

  mstream.post('/api/v1/playlist/remove-song', (req, res) => {
    const trackId = resolveId(req.body);

    // id maps to playlist_tracks.id
    const track = d().prepare(`
      SELECT pt.id, p.user_id FROM playlist_tracks pt
      JOIN playlists p ON pt.playlist_id = p.id
      WHERE pt.id = ?
    `).get(trackId);

    if (!track || track.user_id !== req.user.id) {
      throw new WebError('Access denied or track not found', 404);
    }

    d().prepare('DELETE FROM playlist_tracks WHERE id = ?').run(trackId);
    res.json({});
  });

  // ── Create playlist ─────────────────────────────────────────────────────

  mstream.post('/api/v1/playlist/new', (req, res) => {
    const schema = Joi.object({ title: Joi.string().required() });
    joiValidate(schema, req.body);

    const existing = d().prepare(
      'SELECT id FROM playlists WHERE name = ? AND user_id = ?'
    ).get(req.body.title, req.user.id);

    if (existing) {
      return res.status(400).json({ error: 'Playlist Already Exists' });
    }

    d().prepare(
      'INSERT INTO playlists (name, user_id) VALUES (?, ?)'
    ).run(req.body.title, req.user.id);

    res.json({});
  });

  // ── Save playlist (overwrite) ───────────────────────────────────────────

  mstream.post('/api/v1/playlist/save', (req, res) => {
    const schema = Joi.object({
      title: Joi.string().required(),
      songs: Joi.array().items(Joi.string()),
      live: Joi.boolean().optional()
    });
    joiValidate(schema, req.body);

    // Find or create playlist
    let playlist = d().prepare(
      'SELECT id FROM playlists WHERE name = ? AND user_id = ?'
    ).get(req.body.title, req.user.id);

    // Overwrite atomically: create-or-clear + re-insert run in one transaction,
    // so a concurrent reader never sees the playlist mid-rewrite (empty between
    // the DELETE and the inserts) and a large save costs one fsync, not one per
    // track.
    db.transaction(() => {
      if (playlist) {
        // Delete existing tracks
        d().prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(playlist.id);
      } else {
        const result = d().prepare(
          'INSERT INTO playlists (name, user_id) VALUES (?, ?)'
        ).run(req.body.title, req.user.id);
        playlist = { id: Number(result.lastInsertRowid) };
      }

      // Insert new tracks with positions
      const insert = d().prepare(
        'INSERT INTO playlist_tracks (playlist_id, filepath, position) VALUES (?, ?, ?)'
      );
      if (req.body.songs) {
        for (let i = 0; i < req.body.songs.length; i++) {
          insert.run(playlist.id, req.body.songs[i], i);
        }
      }
    });

    res.json({});
  });

  // ── Rename playlist ─────────────────────────────────────────────────────

  mstream.post('/api/v1/playlist/rename', (req, res) => {
    const schema = Joi.object({
      oldName: Joi.string().required(),
      newName: Joi.string().required()
    });
    joiValidate(schema, req.body);

    const existing = d().prepare(
      'SELECT id FROM playlists WHERE name = ? AND user_id = ?'
    ).get(req.body.newName, req.user.id);

    if (existing) {
      return res.status(400).json({ error: 'A playlist with that name already exists' });
    }

    d().prepare(
      'UPDATE playlists SET name = ? WHERE name = ? AND user_id = ?'
    ).run(req.body.newName, req.body.oldName, req.user.id);

    res.json({});
  });

  // ── Get all playlists ───────────────────────────────────────────────────

  mstream.get('/api/v1/playlist/getall', (req, res) => {
    res.json(getPlaylists(req.user.id));
  });

  function getPlaylists(userId) {
    if (!userId) { return []; }
    return d().prepare(
      'SELECT name FROM playlists WHERE user_id = ? ORDER BY name COLLATE NOCASE'
    ).all(userId).map(r => ({ name: r.name }));
  }
}
