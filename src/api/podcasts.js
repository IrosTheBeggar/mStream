// Podcast subscriptions.
//
// Each authenticated user has their own list of feeds. Each feed has its own
// episode list, refreshed on-demand from the upstream RSS when the user hits
// the refresh button or subscribes for the first time. Episodes are stored
// metadata-only by default; "save to library" downloads an episode to disk
// so it shows up in the regular library after the next scan.
//
// Shape contract (what webapp/velvet/app.js:9177 onward consumes):
//
//   feed: {
//     id, url, title, description, author, img,
//     last_fetched    // ISO
//   }
//   episode: {
//     id, title, description, pub_date, duration_secs,
//     enclosure_url, enclosure_type
//   }
//
// Subsonic consumers (src/api/subsonic/handlers.js:getPodcasts,
// getNewestPodcasts, createPodcastChannel, etc.) hit the same tables via
// the exported helpers below.
//
// SSRF: RSS fetches and enclosure downloads validate the target URL against
// the same loopback/RFC1918 guard used by the radio-stream proxy. Symlink
// traversal and writes outside the target library are blocked by the
// path.resolve + startsWith(root + sep) pattern used elsewhere.

import dns from 'node:dns/promises';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import Joi from 'joi';
import winston from 'winston';
import { XMLParser } from 'fast-xml-parser';
import * as db from '../db/manager.js';
import * as config from '../state/config.js';
import { joiValidate } from '../util/validation.js';

const d = () => db.getDB();

// ── SSRF guard (shared with radio.js pattern) ───────────────────────────────

function _isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 0) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lc = ip.toLowerCase();
    if (lc === '::1' || lc === '::') return true;
    if (lc.startsWith('fc') || lc.startsWith('fd')) return true;
    if (lc.startsWith('fe80')) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) return _isPrivateIp(mapped[1]);
    return false;
  }
  return true;
}

async function _resolveAndValidate(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (net.isIP(u.hostname)) {
    return _isPrivateIp(u.hostname) ? null : { url: u, resolvedIp: u.hostname };
  }
  try {
    const { address } = await dns.lookup(u.hostname, { verbatim: false });
    return _isPrivateIp(address) ? null : { url: u, resolvedIp: address };
  } catch { return null; }
}

// Fetch a URL into a Buffer. Bounded size + timeout — RSS feeds can be
// surprisingly large (a decade-long podcast's history is easily 5 MB) but
// megabyte-scale is far too big for accidental/malicious targets.
const MAX_RSS_BYTES = 10 * 1024 * 1024;      // 10 MB
const MAX_ENCLOSURE_BYTES = 500 * 1024 * 1024; // 500 MB — podcasts can be 3h+
const FETCH_TIMEOUT_MS = 30_000;

async function _fetchBytes(urlStr, maxBytes) {
  const resolved = await _resolveAndValidate(urlStr);
  if (!resolved) throw new Error('invalid URL or SSRF blocked');
  return new Promise((resolve, reject) => {
    const transport = resolved.url.protocol === 'https:' ? https : http;
    const opts = {
      host: resolved.resolvedIp,
      port: resolved.url.port || (resolved.url.protocol === 'https:' ? 443 : 80),
      servername: resolved.url.hostname,
      path: resolved.url.pathname + (resolved.url.search || ''),
      method: 'GET',
      headers: { Host: resolved.url.hostname, 'User-Agent': 'mStream/6.0' },
      timeout: FETCH_TIMEOUT_MS,
    };
    const req = transport.request(opts, res => {
      // Follow one level of redirect. Not a full redirect chain — RSS feeds
      // rarely chain, and the new URL gets a fresh SSRF validation anyway.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return _fetchBytes(
          new URL(res.headers.location, resolved.url).toString(),
          maxBytes,
        ).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const declaredLen = parseInt(res.headers['content-length'] || '0', 10);
      if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
        res.destroy();
        return reject(new Error(`response too large (${declaredLen} > ${maxBytes})`));
      }
      const chunks = [];
      let total = 0;
      res.on('data', c => {
        total += c.length;
        if (total > maxBytes) {
          res.destroy();
          return reject(new Error(`response exceeded size cap (${maxBytes})`));
        }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('fetch timeout')); });
    req.end();
  });
}

// Same as _fetchBytes but streams to a file via a write stream — avoids
// buffering a 500MB podcast episode in memory.
async function _downloadToFile(urlStr, destPath, maxBytes) {
  const resolved = await _resolveAndValidate(urlStr);
  if (!resolved) throw new Error('invalid URL or SSRF blocked');
  return new Promise((resolve, reject) => {
    const transport = resolved.url.protocol === 'https:' ? https : http;
    const opts = {
      host: resolved.resolvedIp,
      port: resolved.url.port || (resolved.url.protocol === 'https:' ? 443 : 80),
      servername: resolved.url.hostname,
      path: resolved.url.pathname + (resolved.url.search || ''),
      method: 'GET',
      headers: { Host: resolved.url.hostname, 'User-Agent': 'mStream/6.0' },
      timeout: FETCH_TIMEOUT_MS,
    };
    const req = transport.request(opts, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return _downloadToFile(
          new URL(res.headers.location, resolved.url).toString(),
          destPath,
          maxBytes,
        ).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let total = 0;
      const ws = fs.createWriteStream(destPath);
      res.on('data', c => {
        total += c.length;
        if (total > maxBytes) {
          res.destroy();
          ws.destroy();
          fsp.unlink(destPath).catch(() => {});
          return reject(new Error(`download exceeded size cap`));
        }
      });
      res.pipe(ws);
      ws.on('finish', () => resolve({ bytes: total, contentType: res.headers['content-type'] || null }));
      ws.on('error', err => { fsp.unlink(destPath).catch(() => {}); reject(err); });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('download timeout')); });
    req.end();
  });
}

// ── RSS parsing ─────────────────────────────────────────────────────────────
//
// RSS 2.0 channel → feed, item → episode. iTunes namespace extensions
// (itunes:duration, itunes:image, itunes:author) populate fields the
// vanilla RSS spec doesn't have. Atom feeds are rare for podcasts; we
// don't handle them explicitly but many show up wrapped in RSS by hosts.

const _xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: false,
  parseTagValue: true,
  trimValues: true,
  // Always return arrays for item so a single-episode feed still gives us
  // an array to iterate.
  isArray: (name) => name === 'item' || name === 'itunes:category',
});

function _parseDurationField(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const parts = s.split(':').map(n => parseInt(n, 10));
  if (parts.some(Number.isNaN)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return null;
}

function _firstString(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return _firstString(v[0]);
  if (typeof v === 'object') {
    if ('#text' in v) return _firstString(v['#text']);
    return null;
  }
  return null;
}

function _parseRss(xml) {
  const tree = _xmlParser.parse(xml);
  const channel = tree?.rss?.channel;
  if (!channel) throw new Error('not an RSS 2.0 feed (no channel element)');

  const feed = {
    title: _firstString(channel.title) || null,
    description: _firstString(channel.description) || null,
    author: _firstString(channel['itunes:author']) || _firstString(channel.author) || null,
    image_url:
      _firstString(channel['itunes:image']?.['@_href']) ||
      _firstString(channel.image?.url) ||
      null,
  };

  const items = Array.isArray(channel.item) ? channel.item : [];
  const episodes = items.map(item => {
    const enc = item.enclosure;
    return {
      guid: _firstString(item.guid) || _firstString(item.link) || null,
      title: _firstString(item.title) || null,
      description: _firstString(item.description) || null,
      pub_date: _firstString(item.pubDate) || null,
      enclosure_url: _firstString(enc?.['@_url']) || null,
      enclosure_type: _firstString(enc?.['@_type']) || null,
      duration: _parseDurationField(item['itunes:duration']),
    };
  }).filter(ep => ep.enclosure_url); // no audio → drop

  return { feed, episodes };
}

// Upsert parsed feed + episodes into the DB. Episodes keyed on (feed_id, guid);
// rows with the same guid get their metadata refreshed so title / duration /
// description tweaks from the publisher show up in the UI. Returns the updated
// feed row.
function _persistFeedUpdate(feedId, parsed) {
  const tx = d().transaction(() => {
    d().prepare(`
      UPDATE podcast_feeds
      SET title = ?, description = ?, image_url = ?, last_fetched = datetime('now')
      WHERE id = ?
    `).run(
      parsed.feed.title,
      parsed.feed.description,
      parsed.feed.image_url,
      feedId,
    );

    const upsertEp = d().prepare(`
      INSERT INTO podcast_episodes
        (feed_id, guid, title, description, pub_date,
         enclosure_url, enclosure_type, duration)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(feed_id, guid) DO UPDATE SET
        title          = excluded.title,
        description    = excluded.description,
        pub_date       = excluded.pub_date,
        enclosure_url  = excluded.enclosure_url,
        enclosure_type = excluded.enclosure_type,
        duration       = excluded.duration
    `);
    for (const ep of parsed.episodes) {
      if (!ep.guid) { continue; } // skip ambiguous entries rather than inserting unkeyed rows
      // pub_date: convert to SQLite-friendly format if present. Tolerant parser —
      // if the date is malformed we store null rather than failing the whole
      // refresh.
      let pubIso = null;
      if (ep.pub_date) {
        const dt = new Date(ep.pub_date);
        if (!Number.isNaN(dt.getTime())) { pubIso = dt.toISOString().replace('T', ' ').slice(0, 19); }
      }
      upsertEp.run(
        feedId,
        ep.guid,
        ep.title,
        ep.description,
        pubIso,
        ep.enclosure_url,
        ep.enclosure_type,
        ep.duration,
      );
    }
  });
  tx();
  return d().prepare('SELECT * FROM podcast_feeds WHERE id = ?').get(feedId);
}

// ── Row → client shape ──────────────────────────────────────────────────────

function _feedToVelvet(row) {
  return {
    id: row.id,
    url: row.url,
    title: row.title || null,
    description: row.description || null,
    img: row.image_url || null,
    last_fetched: row.last_fetched || null,
  };
}

function _episodeToVelvet(row) {
  return {
    id: row.id,
    title: row.title || null,
    description: row.description || null,
    pub_date: row.pub_date || null,
    duration_secs: row.duration || null,
    enclosure_url: row.enclosure_url,
    enclosure_type: row.enclosure_type || null,
    downloaded: !!row.downloaded,
  };
}

// Exported for Subsonic handlers.
export function listFeeds(userId) {
  return d().prepare(
    'SELECT * FROM podcast_feeds WHERE user_id = ? ORDER BY id ASC'
  ).all(userId);
}

export function listEpisodes(feedId, limit) {
  const rows = d().prepare(`
    SELECT * FROM podcast_episodes
    WHERE feed_id = ?
    ORDER BY pub_date DESC, id DESC
    ${limit ? 'LIMIT ?' : ''}
  `).all(...(limit ? [feedId, limit] : [feedId]));
  return rows;
}

export function listNewestEpisodesForUser(userId, limit) {
  return d().prepare(`
    SELECT e.*, f.title AS feed_title
    FROM podcast_episodes e
    JOIN podcast_feeds f ON f.id = e.feed_id
    WHERE f.user_id = ?
    ORDER BY e.pub_date DESC
    LIMIT ?
  `).all(userId, limit);
}

export async function refreshFeed(feedId) {
  const feed = d().prepare('SELECT * FROM podcast_feeds WHERE id = ?').get(feedId);
  if (!feed) throw new Error('feed not found');
  const buf = await _fetchBytes(feed.url, MAX_RSS_BYTES);
  const parsed = _parseRss(buf.toString('utf8'));
  return _persistFeedUpdate(feedId, parsed);
}

export function deleteFeed(userId, id) {
  const info = d().prepare(
    'DELETE FROM podcast_feeds WHERE id = ? AND user_id = ?'
  ).run(id, userId);
  return info.changes > 0;
}

// Resolve the target vpath for "save to library" downloads: prefer a
// writable library whose type is music / default. Falls back to the user's
// first writable library.
function _writableVpath(user) {
  if (!user?.vpaths) return null;
  const libs = db.getAllLibraries();
  for (const name of user.vpaths) {
    const lib = libs.find(l => l.name === name);
    if (lib) return lib;
  }
  return null;
}

// Turn an arbitrary string into a filesystem-safe component. Preserves
// printable ASCII other than path separators and control chars; replaces
// the rest with `_`. Caps at 120 chars.
function _safeFilename(s) {
  if (!s) return 'untitled';
  // Strip path separators, nulls, and anything non-printable.
  return String(s)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'untitled';
}

// Extension for a saved episode. Prefer the URL extension; fall back to a
// mapping from Content-Type; default to .mp3.
function _extensionForEpisode(enclosureUrl, contentType) {
  try {
    const u = new URL(enclosureUrl);
    const urlExt = path.extname(u.pathname).toLowerCase().slice(1);
    if (['mp3', 'm4a', 'ogg', 'opus', 'flac', 'wav', 'aac'].includes(urlExt)) {
      return '.' + urlExt;
    }
  } catch (_) { /* fall through */ }
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('mpeg')) return '.mp3';
  if (ct.includes('mp4') || ct.includes('m4a')) return '.m4a';
  if (ct.includes('ogg')) return '.ogg';
  if (ct.includes('opus')) return '.opus';
  if (ct.includes('flac')) return '.flac';
  if (ct.includes('wav')) return '.wav';
  return '.mp3';
}

// ── Route setup ─────────────────────────────────────────────────────────────

export function setup(mstream) {

  // List feeds for the current user.
  mstream.get('/api/v1/podcast/feeds', (req, res) => {
    if (!req.user?.id) return res.json([]);
    res.json(listFeeds(req.user.id).map(_feedToVelvet));
  });

  // Subscribe to a new feed. Body: { url, name }. Fetches + parses the RSS
  // synchronously so the returned feed row has title/description/image_url
  // populated — the UI displays the row immediately on success. Refresh
  // failures after that point are soft (feed row still exists, UI shows
  // empty episode list).
  mstream.post('/api/v1/podcast/feeds', async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'unauthorized' });
    const schema = Joi.object({
      url: Joi.string().uri({ scheme: ['http', 'https'] }).required(),
      name: Joi.string().trim().min(1).max(200).allow(null).optional(),
    });
    const { value } = joiValidate(schema, req.body);

    // Unique per (user, url); re-subscribing is just a no-op refresh.
    const existing = d().prepare(
      'SELECT id FROM podcast_feeds WHERE user_id = ? AND url = ?'
    ).get(req.user.id, value.url);

    let feedId;
    if (existing) {
      feedId = existing.id;
    } else {
      const info = d().prepare(`
        INSERT INTO podcast_feeds (user_id, url, title) VALUES (?, ?, ?)
      `).run(req.user.id, value.url, value.name || null);
      feedId = Number(info.lastInsertRowid);
    }

    try {
      const feedRow = await refreshFeed(feedId);
      res.json(_feedToVelvet(feedRow));
    } catch (err) {
      // Leave the row in place so the UI can refresh later; just tell the
      // client why the initial parse failed.
      const row = d().prepare('SELECT * FROM podcast_feeds WHERE id = ?').get(feedId);
      res.status(row ? 200 : 500).json({
        ..._feedToVelvet(row || {}),
        error: err.message || 'feed fetch failed',
      });
    }
  });

  // Rename / change URL on an existing feed.
  mstream.patch('/api/v1/podcast/feeds/:id', (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'unauthorized' });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

    const schema = Joi.object({
      title: Joi.string().trim().min(1).max(200).optional(),
      url: Joi.string().uri({ scheme: ['http', 'https'] }).optional(),
    });
    const { value } = joiValidate(schema, req.body);

    const row = d().prepare(
      'SELECT id FROM podcast_feeds WHERE id = ? AND user_id = ?'
    ).get(id, req.user.id);
    if (!row) return res.status(404).json({ error: 'not found' });

    const sets = [];
    const params = [];
    if (value.title !== undefined) { sets.push('title = ?'); params.push(value.title); }
    if (value.url !== undefined) { sets.push('url = ?'); params.push(value.url); }
    if (sets.length) {
      params.push(id, req.user.id);
      d().prepare(
        `UPDATE podcast_feeds SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`
      ).run(...params);
    }

    const updated = d().prepare('SELECT * FROM podcast_feeds WHERE id = ?').get(id);
    res.json(_feedToVelvet(updated));
  });

  // Unsubscribe.
  mstream.delete('/api/v1/podcast/feeds/:id', (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'unauthorized' });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const ok = deleteFeed(req.user.id, id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  // Reorder is accepted for UI compat but a no-op today — our listing order
  // is pub_date DESC so the user's drag order wouldn't survive the next
  // refresh anyway. Returning 200 keeps the UI's "order saved" toast happy.
  mstream.put('/api/v1/podcast/feeds/reorder', (req, res) => res.json({ ok: true }));

  // Manually refresh a feed's episodes.
  mstream.post('/api/v1/podcast/feeds/:id/refresh', async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'unauthorized' });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

    const own = d().prepare(
      'SELECT id FROM podcast_feeds WHERE id = ? AND user_id = ?'
    ).get(id, req.user.id);
    if (!own) return res.status(404).json({ error: 'not found' });

    try {
      const updated = await refreshFeed(id);
      res.json(_feedToVelvet(updated));
    } catch (err) {
      res.status(502).json({ error: err.message || 'refresh failed' });
    }
  });

  // Episodes for a feed.
  mstream.get('/api/v1/podcast/episodes/:feedId', (req, res) => {
    if (!req.user?.id) return res.json([]);
    const feedId = parseInt(req.params.feedId, 10);
    if (!Number.isFinite(feedId)) return res.status(400).json({ error: 'invalid id' });

    const own = d().prepare(
      'SELECT id FROM podcast_feeds WHERE id = ? AND user_id = ?'
    ).get(feedId, req.user.id);
    if (!own) return res.status(404).json({ error: 'not found' });

    res.json(listEpisodes(feedId).map(_episodeToVelvet));
  });

  // Save an episode to a library. Downloads the enclosure into
  // <first-vpath-root>/Podcasts/<feed-title>/<episode-title>.<ext>.
  // Marks the row as downloaded + stores local_path so subsequent save
  // clicks return the existing path.
  mstream.post('/api/v1/podcast/episode/save', async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'unauthorized' });
    const canModify = !config.program.noFileModify
      && req.user.allow_file_modify !== false
      && req.user.allow_file_modify !== 0;
    if (!canModify) return res.status(403).json({ error: 'File modification not allowed' });

    const schema = Joi.object({
      feedId: Joi.number().integer().required(),
      episodeId: Joi.number().integer().required(),
    });
    const { value } = joiValidate(schema, req.body);

    const ep = d().prepare(`
      SELECT e.*, f.user_id AS owner, f.title AS feed_title
      FROM podcast_episodes e
      JOIN podcast_feeds f ON f.id = e.feed_id
      WHERE e.id = ? AND e.feed_id = ?
    `).get(value.episodeId, value.feedId);
    if (!ep || ep.owner !== req.user.id) return res.status(404).json({ error: 'not found' });

    // If it's already saved and the file still exists, return the existing
    // path so a double-click is idempotent.
    if (ep.local_path && fs.existsSync(ep.local_path)) {
      return res.json({ savedTo: ep.local_path, alreadyExists: true });
    }

    const lib = _writableVpath(req.user);
    if (!lib) return res.status(400).json({ error: 'no writable library' });

    const folder = path.join(
      lib.root_path,
      'Podcasts',
      _safeFilename(ep.feed_title || 'Podcast'),
    );
    await fsp.mkdir(folder, { recursive: true });

    // We don't know the extension until we start the download (URL hint +
    // Content-Type). Do a quick HEAD-less fetch and rename once we have it.
    const tmpPath = path.join(folder, `.download-${ep.id}.part`);
    try {
      const { contentType } = await _downloadToFile(ep.enclosure_url, tmpPath, MAX_ENCLOSURE_BYTES);
      const ext = _extensionForEpisode(ep.enclosure_url, contentType);
      const finalName = _safeFilename(ep.title || `episode-${ep.id}`) + ext;
      const finalPath = path.join(folder, finalName);

      // Traversal guard — the safeFilename step already strips separators
      // but double-check the resolved path stays inside the library root.
      const resolved = path.resolve(finalPath);
      const root = path.resolve(lib.root_path);
      if (!resolved.startsWith(root + path.sep)) {
        await fsp.unlink(tmpPath).catch(() => {});
        return res.status(500).json({ error: 'path traversal' });
      }

      await fsp.rename(tmpPath, finalPath);
      d().prepare(
        'UPDATE podcast_episodes SET downloaded = 1, local_path = ? WHERE id = ?'
      ).run(finalPath, ep.id);

      // Return the vpath-qualified filepath the scanner will end up with
      // so the UI can optimistically display "saved to X" without waiting.
      const savedTo = path.posix.join(
        lib.name,
        path.relative(lib.root_path, finalPath).split(path.sep).join('/'),
      );
      res.json({ savedTo });
    } catch (err) {
      await fsp.unlink(tmpPath).catch(() => {});
      winston.warn(`[podcasts] save-episode failed: ${err.message}`);
      res.status(502).json({ error: err.message || 'download failed' });
    }
  });
}
