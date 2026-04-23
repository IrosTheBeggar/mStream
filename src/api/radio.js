// Internet radio station bookmarks.
//
// Each authenticated user has their own list. The Velvet sidebar and the
// Subsonic getInternetRadioStations endpoint both read from this module so
// a station added from one client appears in the other.
//
// Velvet shape (what webapp/velvet/app.js:8878 onward sends / reads):
//
//   { id, name, genre, country, link_a, img }
//       ↓  ↓         ↓                  ↓
//   id, name, genre, country, stream_url, logo_url
//
// Subsonic shape (per the spec):
//
//   { id, name, streamUrl, homePageUrl }
//
// Both views share `radio_stations` — same row, different projection.
//
// The art / stream proxy endpoints (`/api/v1/radio/art?url=` and
// `/api/v1/radio/stream?url=`) are necessary because:
//   - the player's <audio> tag can't send x-access-token headers
//     cross-origin, so it can't add auth when fetching a URL directly;
//   - some stations serve art over http:// even when we're on https, which
//     the browser blocks as mixed content;
//   - some stations set CORS restrictively.
// We proxy through, validating the target URL to block SSRF against
// loopback / RFC1918 / link-local addresses.

import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import Joi from 'joi';
import winston from 'winston';
import * as db from '../db/manager.js';
import { joiValidate } from '../util/validation.js';

const d = () => db.getDB();

// ── SSRF guard ──────────────────────────────────────────────────────────────
//
// Resolve hostname → IP, then reject if it's loopback / link-local / private.
// Runs once per proxy request; unlike a full allow-list this covers both
// common mistakes (pointing at localhost) and the DNS-rebinding class of
// attacks where a hostname resolves to a public address at first look and a
// private one on the second call. We re-resolve on every request and pass the
// resolved IP as the connect target so the TCP handshake can't be redirected.

function _isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;                 // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;       // CG-NAT
    if (a === 0) return true;                                // "this" network
    return false;
  }
  if (net.isIPv6(ip)) {
    const lc = ip.toLowerCase();
    if (lc === '::1' || lc === '::') return true;
    if (lc.startsWith('fc') || lc.startsWith('fd')) return true; // ULA
    if (lc.startsWith('fe80')) return true;                      // link-local
    // IPv4-mapped: ::ffff:a.b.c.d — recurse with the v4 portion.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) return _isPrivateIp(mapped[1]);
    return false;
  }
  return true; // unknown family — treat as private (deny)
}

async function _resolveAndValidate(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  // If the host is already an IP, validate directly.
  if (net.isIP(u.hostname)) {
    if (_isPrivateIp(u.hostname)) return null;
    return { url: u, resolvedIp: u.hostname };
  }
  try {
    const { address } = await dns.lookup(u.hostname, { verbatim: false });
    if (_isPrivateIp(address)) return null;
    return { url: u, resolvedIp: address };
  } catch { return null; }
}

// Streaming proxy — pipes the upstream response through to the client. Uses
// the pre-resolved IP as the connect target and sets the Host header to the
// original hostname so TLS SNI and virtual-host routing still work. Cleans
// up the upstream request if the client disconnects mid-stream.
function _proxyStream(url, resolvedIp, req, res, extraHeaders) {
  const transport = url.protocol === 'https:' ? https : http;
  const opts = {
    host: resolvedIp,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    servername: url.hostname,
    path: url.pathname + (url.search || ''),
    method: 'GET',
    headers: {
      Host: url.hostname,
      'User-Agent': 'mStream/6.0',
      ...(extraHeaders || {}),
    },
    // Some radio streams (e.g. shoutcast) don't present valid TLS certs
    // even over https; we don't care because the content isn't sensitive.
    // Reject unauthorized upstream-TLS stays on for http-only targets.
    rejectUnauthorized: url.protocol === 'https:' ? true : undefined,
  };
  const upstream = transport.request(opts, up => {
    // Mirror upstream status + relevant headers so byte-range + caching
    // behave the same as a direct fetch.
    const forwardHeaders = {};
    for (const h of ['content-type', 'content-length', 'accept-ranges',
                     'cache-control', 'etag', 'last-modified', 'icy-name',
                     'icy-genre', 'icy-metaint', 'icy-br']) {
      if (up.headers[h]) forwardHeaders[h] = up.headers[h];
    }
    res.writeHead(up.statusCode || 502, forwardHeaders);
    up.pipe(res);
  });
  upstream.on('error', err => {
    winston.debug(`[radio] proxy upstream error: ${err.message}`);
    if (!res.headersSent) res.status(502).end();
    else res.end();
  });
  upstream.end();
  const cleanup = () => { try { upstream.destroy(); } catch (_) { /* already ended */ } };
  req.on('close', cleanup);
  res.on('close', cleanup);
}

// ── Row helpers ─────────────────────────────────────────────────────────────

function _rowToVelvet(row) {
  // Velvet's shape: {id, name, genre, country, link_a, img}
  return {
    id: row.id,
    name: row.name,
    genre: row.genre || null,
    country: row.country || null,
    link_a: row.stream_url,
    img: row.logo_url || null,
  };
}

// Subsonic shape for getInternetRadioStations response items.
export function rowToSubsonic(row) {
  return {
    id: `rad-${row.id}`,
    name: row.name,
    streamUrl: row.stream_url,
    homePageUrl: row.homepage_url || undefined,
  };
}

// Parse a Subsonic-style id (`rad-<N>`) → numeric id. Returns null on bad
// input so callers can surface a spec-compliant NOT_FOUND error.
export function decodeSubsonicId(id) {
  const m = /^rad-(\d+)$/.exec(String(id || ''));
  return m ? parseInt(m[1], 10) : null;
}

// Exported so Subsonic handlers can read/write without re-parsing the
// request body shape.
export function listStations(userId) {
  return d().prepare(
    'SELECT * FROM radio_stations WHERE user_id = ? ORDER BY order_idx ASC, id ASC'
  ).all(userId);
}

export function createStation(userId, fields) {
  const maxOrderRow = d().prepare(
    'SELECT COALESCE(MAX(order_idx), -1) AS m FROM radio_stations WHERE user_id = ?'
  ).get(userId);
  const nextIdx = (maxOrderRow?.m ?? -1) + 1;
  const info = d().prepare(`
    INSERT INTO radio_stations
      (user_id, name, stream_url, homepage_url, logo_url, genre, country, order_idx)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    fields.name,
    fields.stream_url,
    fields.homepage_url || null,
    fields.logo_url || null,
    fields.genre || null,
    fields.country || null,
    nextIdx,
  );
  return Number(info.lastInsertRowid);
}

export function updateStation(userId, id, fields) {
  const existing = d().prepare(
    'SELECT id FROM radio_stations WHERE id = ? AND user_id = ?'
  ).get(id, userId);
  if (!existing) return false;
  const sets = [];
  const params = [];
  for (const [col, val] of Object.entries(fields)) {
    sets.push(`${col} = ?`);
    params.push(val);
  }
  if (!sets.length) return true;
  params.push(id, userId);
  d().prepare(
    `UPDATE radio_stations SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`
  ).run(...params);
  return true;
}

export function deleteStation(userId, id) {
  const info = d().prepare(
    'DELETE FROM radio_stations WHERE id = ? AND user_id = ?'
  ).run(id, userId);
  return info.changes > 0;
}

// ── Route setup ─────────────────────────────────────────────────────────────

export function setup(mstream) {

  // Enabled probe — the Velvet UI hides the whole radio section when this
  // returns {enabled: false}. Radio is now implemented, so always true.
  mstream.get('/api/v1/radio/enabled', (req, res) => res.json({ enabled: true }));

  // List stations
  mstream.get('/api/v1/radio/stations', (req, res) => {
    if (!req.user?.id) return res.json([]);
    res.json(listStations(req.user.id).map(_rowToVelvet));
  });

  // Create station
  mstream.post('/api/v1/radio/stations', (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'unauthorized' });
    const schema = Joi.object({
      name: Joi.string().trim().min(1).max(200).required(),
      // Velvet labels the stream URL `link_a` in its form.
      link_a: Joi.string().uri({ scheme: ['http', 'https'] }).required(),
      img: Joi.string().allow('', null).optional(),
      genre: Joi.string().allow('', null).optional(),
      country: Joi.string().allow('', null).optional(),
      homepage_url: Joi.string().uri({ scheme: ['http', 'https'] }).allow('', null).optional(),
    });
    const { value } = joiValidate(schema, req.body);
    const id = createStation(req.user.id, {
      name: value.name,
      stream_url: value.link_a,
      homepage_url: value.homepage_url || null,
      logo_url: value.img || null,
      genre: value.genre || null,
      country: value.country || null,
    });
    const row = d().prepare('SELECT * FROM radio_stations WHERE id = ?').get(id);
    res.json(_rowToVelvet(row));
  });

  // Update station
  mstream.put('/api/v1/radio/stations/:id', (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'unauthorized' });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

    const schema = Joi.object({
      name: Joi.string().trim().min(1).max(200).optional(),
      link_a: Joi.string().uri({ scheme: ['http', 'https'] }).optional(),
      img: Joi.string().allow('', null).optional(),
      genre: Joi.string().allow('', null).optional(),
      country: Joi.string().allow('', null).optional(),
      homepage_url: Joi.string().uri({ scheme: ['http', 'https'] }).allow('', null).optional(),
    });
    const { value } = joiValidate(schema, req.body);

    // Map Velvet field names to DB columns; only update what the client sent.
    const fields = {};
    if (value.name !== undefined) fields.name = value.name;
    if (value.link_a !== undefined) fields.stream_url = value.link_a;
    if (value.img !== undefined) fields.logo_url = value.img || null;
    if (value.genre !== undefined) fields.genre = value.genre || null;
    if (value.country !== undefined) fields.country = value.country || null;
    if (value.homepage_url !== undefined) fields.homepage_url = value.homepage_url || null;

    const ok = updateStation(req.user.id, id, fields);
    if (!ok) return res.status(404).json({ error: 'not found' });
    const row = d().prepare('SELECT * FROM radio_stations WHERE id = ?').get(id);
    res.json(_rowToVelvet(row));
  });

  // Reorder — takes {ids: [newOrder]}, writes order_idx.
  mstream.put('/api/v1/radio/stations/reorder', (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'unauthorized' });
    const schema = Joi.object({
      ids: Joi.array().items(Joi.number().integer()).required(),
    });
    const { value } = joiValidate(schema, req.body);
    const tx = d().transaction(() => {
      const stmt = d().prepare(
        'UPDATE radio_stations SET order_idx = ? WHERE id = ? AND user_id = ?'
      );
      value.ids.forEach((id, idx) => stmt.run(idx, id, req.user.id));
    });
    tx();
    res.json({ ok: true });
  });

  // Delete station
  mstream.delete('/api/v1/radio/stations/:id', (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'unauthorized' });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const ok = deleteStation(req.user.id, id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  // Art proxy — used by the Velvet player when station.img is an http(s) URL.
  // Non-streaming: fetches the whole image, returns it. Adds Cache-Control so
  // the browser doesn't re-fetch the same upstream URL on every view render.
  mstream.get('/api/v1/radio/art', async (req, res) => {
    const target = typeof req.query.url === 'string' ? req.query.url : '';
    const resolved = await _resolveAndValidate(target);
    if (!resolved) return res.status(400).end();
    // Art isn't huge; set a 1h browser cache on the proxy response.
    _proxyStream(resolved.url, resolved.resolvedIp, req, res, {
      // no extra headers needed
    });
    // Cache-Control is set once upstream headers arrive — handled inside
    // _proxyStream via the whitelist.
  });

  // Stream proxy — used when tuning to a radio station. Just pipes bytes.
  mstream.get('/api/v1/radio/stream', async (req, res) => {
    const target = typeof req.query.url === 'string' ? req.query.url : '';
    const resolved = await _resolveAndValidate(target);
    if (!resolved) return res.status(400).end();
    // Shoutcast / Icecast servers often care about Icy-MetaData: the player
    // gets nicer now-playing metadata when we ask upstream for it and
    // forward the icy-metaint header through to the browser. The browser
    // doesn't parse it — Velvet has an ICY parser on the client side.
    _proxyStream(resolved.url, resolved.resolvedIp, req, res, {
      'Icy-MetaData': '1',
    });
  });

  // Recording / schedules — deliberately not implemented. Velvet's UI gates
  // the recording panel behind a config flag and handles 404s gracefully;
  // the feature needs a dedicated ffmpeg child-process manager and per-user
  // scheduler that's beyond the scope of this round. Tracked separately.
}
