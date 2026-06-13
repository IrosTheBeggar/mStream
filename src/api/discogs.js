// Discogs integration — album art search via Discogs and Deezer APIs.
// Provides admin config persistence, cover art search, and embed endpoints.

import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as vpath from '../util/vpath.js';
import { loadFile, saveFile } from '../util/admin.js';
import { httpGet, httpGetJson, saveImageToCache, embedArtInFile } from './album-art.js';
import { isDownloaded as ffmpegIsDownloaded } from './transcode.js';
import path from 'path';

const d = () => db.getDB();

const DISCOGS_API = 'https://api.discogs.com';
const USER_AGENT = 'mStream/6.0 +https://mstream.io';

function discogsHeaders() {
  const headers = { 'User-Agent': USER_AGENT };
  if (config.program.discogs.apiKey && config.program.discogs.apiSecret) {
    headers['Authorization'] = `Discogs key=${config.program.discogs.apiKey}, secret=${config.program.discogs.apiSecret}`;
  }
  return headers;
}

async function discogsGet(apiPath) {
  const url = `${DISCOGS_API}${apiPath}`;
  const res = await fetch(url, { headers: discogsHeaders() });
  if (!res.ok) {
    throw new Error(`Discogs API ${res.status}`);
  }
  return res.json();
}

export function setup(mstream) {

  // ══════════════════════════════════════════════════════════════
  // ADMIN CONFIG
  // ══════════════════════════════════════════════════════════════

  mstream.get('/api/v1/admin/discogs/config', (req, res) => {
    res.json({
      enabled: config.program.discogs.enabled,
      allowArtUpdate: config.program.discogs.allowArtUpdate,
      allowId3Edit: !config.program.noFileModify,
      apiKey: config.program.discogs.apiKey || '',
      apiSecret: config.program.discogs.apiSecret ? '••••••••' : '',
    });
  });

  mstream.post('/api/v1/admin/discogs/config', async (req, res) => {
    if (!req.user?.admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { enabled, allowArtUpdate, apiKey, apiSecret } = req.body;

    try {
      const loadConfig = await loadFile(config.configFile);
      if (!loadConfig.discogs) loadConfig.discogs = {};
      if (enabled !== undefined) loadConfig.discogs.enabled = !!enabled;
      if (allowArtUpdate !== undefined) loadConfig.discogs.allowArtUpdate = !!allowArtUpdate;
      if (apiKey !== undefined) loadConfig.discogs.apiKey = apiKey;
      // Only update secret if it's not the masked placeholder
      if (apiSecret !== undefined && apiSecret !== '••••••••') {
        loadConfig.discogs.apiSecret = apiSecret;
      }
      await saveFile(loadConfig, config.configFile);

      // Update in-memory config
      config.program.discogs = { ...config.program.discogs, ...loadConfig.discogs };

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to save config' });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // DISCOGS COVER ART SEARCH
  // ══════════════════════════════════════════════════════════════

  mstream.get('/api/v1/discogs/coverart', async (req, res) => {
    if (!config.program.discogs.enabled) {
      return res.status(404).json({ error: 'Discogs not enabled' });
    }
    if (!config.program.discogs.apiKey || !config.program.discogs.apiSecret) {
      return res.status(400).json({ error: 'Discogs API key/secret not configured' });
    }

    const { artist, title, album, year } = req.query;
    const searchAlbum = album || title || '';
    const searchArtist = artist || '';

    if (!searchAlbum && !searchArtist) {
      return res.json({ choices: [] });
    }

    try {
      // Search Discogs for releases matching artist + album/title
      let query = '';
      if (searchArtist) query += searchArtist;
      if (searchAlbum) query += (query ? ' ' : '') + searchAlbum;

      const params = new URLSearchParams({
        q: query,
        type: 'release',
        per_page: '8'
      });
      if (searchArtist) params.set('artist', searchArtist);
      if (searchAlbum) params.set('release_title', searchAlbum);

      const data = await discogsGet(`/database/search?${params}`);

      if (!data.results || data.results.length === 0) {
        return res.json({ choices: [] });
      }

      // Build choices with thumbnail previews
      const choices = [];
      for (const result of data.results.slice(0, 8)) {
        if (!result.cover_image && !result.thumb) continue;

        // Download thumbnail and convert to base64
        let thumbB64 = '';
        const thumbUrl = result.thumb || result.cover_image;
        if (thumbUrl) {
          try {
            const imgBuf = await httpGet(thumbUrl);
            thumbB64 = 'data:image/jpeg;base64,' + imgBuf.toString('base64');
          } catch (_) {
            // Skip if thumbnail download fails
            continue;
          }
        }

        choices.push({
          releaseId: result.id,
          releaseTitle: result.title || 'Unknown',
          year: result.year || null,
          thumbB64,
          coverImage: result.cover_image || null,
        });
      }

      res.json({ choices });
    } catch (e) {
      winston.error('[discogs] Search failed', { stack: e });
      res.status(500).json({ error: 'Discogs search failed' });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // DEEZER SEARCH (for Velvet UI)
  // ══════════════════════════════════════════════════════════════

  mstream.get('/api/v1/deezer/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json({ data: [] });

    try {
      const data = await httpGetJson(
        `https://api.deezer.com/search/album?q=${encodeURIComponent(query)}&limit=8`
      );
      res.json({ data: data.data || [] });
    } catch (e) {
      res.json({ data: [] });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // EMBED ART (shared by Discogs, Deezer, and URL paste)
  // ══════════════════════════════════════════════════════════════

  mstream.post('/api/v1/discogs/embed', async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'unauthorized' });

    const { filepath, releaseId, coverUrl } = req.body;
    if (!filepath) {
      return res.status(400).json({ error: 'filepath required' });
    }

    let imgBuf;

    if (coverUrl) {
      // Direct URL (from Deezer or URL paste)
      try {
        imgBuf = await httpGet(coverUrl);
      } catch (e) {
        return res.status(400).json({ error: 'Failed to download image from URL' });
      }
    } else if (releaseId) {
      // Discogs release — fetch full-size cover from Discogs API
      if (!config.program.discogs.apiKey || !config.program.discogs.apiSecret) {
        return res.status(400).json({ error: 'Discogs API not configured' });
      }

      try {
        // Get the release details to find the primary image
        const release = await discogsGet(`/releases/${releaseId}`);
        let imageUrl = null;

        // Find the primary/front image
        if (release.images && release.images.length > 0) {
          const primary = release.images.find(i => i.type === 'primary');
          imageUrl = (primary || release.images[0]).resource_url || (primary || release.images[0]).uri;
        }

        if (!imageUrl) {
          return res.status(404).json({ error: 'No image found for this release' });
        }

        imgBuf = await httpGet(imageUrl);
      } catch (e) {
        return res.status(500).json({ error: 'Failed to fetch Discogs image: ' + e.message });
      }
    } else {
      return res.status(400).json({ error: 'releaseId or coverUrl required' });
    }

    // Validate image
    if (!imgBuf || imgBuf.length < 1024) {
      return res.status(400).json({ error: 'Image too small' });
    }
    if (imgBuf.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image too large (max 10MB)' });
    }

    try {
      // Parse vpath/filepath
      const pathInfo = vpath.getVPathInfo(filepath, req.user);
      const lib = db.getLibraryByName(pathInfo.vpath);
      if (!lib) return res.status(404).json({ error: 'Library not found' });

      const albumArtDir = config.program.storage.albumArtDirectory;
      const filename = await saveImageToCache(imgBuf, albumArtDir);

      // Update track in DB
      const track = d().prepare(
        'SELECT id, album_id FROM tracks WHERE filepath = ? AND library_id = ?'
      ).get(pathInfo.relativePath, lib.id);

      if (!track) return res.status(404).json({ error: 'Track not found in DB' });

      d().prepare('UPDATE tracks SET album_art_file = ? WHERE id = ?').run(filename, track.id);

      // Update album art
      if (track.album_id) {
        d().prepare('UPDATE albums SET album_art_file = ? WHERE id = ?').run(filename, track.album_id);
        d().prepare('UPDATE tracks SET album_art_file = ? WHERE album_id = ? AND album_art_file IS NULL')
          .run(filename, track.album_id);
      }

      // Embed in file if allowed
      const canModify = !config.program.noFileModify
        && req.user.allow_file_modify !== false
        && req.user.allow_file_modify !== 0;

      const ext = path.extname(filepath).toLowerCase();
      const canEmbed = ['.mp3', '.flac', '.m4a', '.aac', '.m4b', '.ogg'].includes(ext);

      if (canModify && canEmbed && ffmpegIsDownloaded()) {
        const fullPath = path.join(lib.root_path, pathInfo.relativePath);
        try {
          await embedArtInFile(fullPath, imgBuf);
        } catch (e) {
          winston.warn(`[discogs] Failed to embed art in ${fullPath}: ${e.message}`);
        }
      }

      res.json({ aaFile: filename });
    } catch (e) {
      winston.error('[discogs] Embed failed', { stack: e });
      res.status(500).json({ error: 'Failed to apply album art' });
    }
  });
}
