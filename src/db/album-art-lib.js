/**
 * Shared, config-free album-art helpers.
 *
 * Written for the post-scan art downloader (src/db/album-art-backfill.mjs),
 * which runs as a forked child process with no populated `config.program`
 * and must not drag in the API module's dependency graph (express
 * handlers, ffmpeg bootstrap, the db manager singleton, …). The future
 * manual-art API shares these so the set-from-UI and set-from-downloader
 * paths produce identical cache state.
 *
 * Everything here is intentionally dependency-light: no config, no db, no
 * req/res. Callers pass in whatever they need (the album-art directory,
 * the compress flag) explicitly.
 *
 * Service base URLs are env-overridable — same pattern as
 * MSTREAM_LRCLIB_BASE in src/api/lyrics-lrclib.js — so tests point the
 * downloader at a local mock instead of the real services.
 */

import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import https from 'https';
import http from 'http';
import { Jimp } from 'jimp';

const MUSICBRAINZ_BASE = process.env.MSTREAM_MUSICBRAINZ_BASE || 'https://musicbrainz.org';
const COVERART_BASE = process.env.MSTREAM_COVERARTARCHIVE_BASE || 'https://coverartarchive.org';
const ITUNES_BASE = process.env.MSTREAM_ITUNES_BASE || 'https://itunes.apple.com';
const DEEZER_BASE = process.env.MSTREAM_DEEZER_BASE || 'https://api.deezer.com';

// ── HTTP helpers ────────────────────────────────────────────────────────────

// Bounded GET: rejects past `maxBytes` DURING streaming (a 200 that lies
// about its size can't balloon memory), per-request 15s inactivity timeout
// PLUS a 60s overall deadline (the inactivity timer alone never fires
// against a trickling server), redirects followed safely — Location is
// resolved + protocol-checked inside the promise so a malformed or
// non-http(s) target rejects instead of throwing uncaught inside the
// response event callback (which would kill the whole worker process).
export function httpGet(url, { maxBytes = 10 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      reject(new Error('Request deadline exceeded'));
    }, 60_000);
    const done = (err, value) => {
      clearTimeout(deadline);
      if (err) { reject(err); } else { resolve(value); }
    };
    const follow = (u, redirects = 0) => {
      if (redirects > 5) return done(new Error('Too many redirects'));
      const mod = u.startsWith('https') ? https : http;
      let req;
      try {
        req = mod.get(u, {
          headers: { 'User-Agent': 'mStream/7.0 (https://mstream.io)' },
          timeout: 15000
        }, res => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            let next;
            try { next = new URL(res.headers.location, u); }
            catch (_e) { return done(new Error('Malformed redirect Location')); }
            if (next.protocol !== 'http:' && next.protocol !== 'https:') {
              return done(new Error(`Refusing redirect to ${next.protocol} URL`));
            }
            return follow(next.href, redirects + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return done(new Error(`HTTP ${res.statusCode}`));
          }
          const chunks = [];
          let received = 0;
          res.on('data', c => {
            received += c.length;
            if (received > maxBytes) {
              res.destroy();
              return done(new Error(`Response exceeded ${maxBytes} bytes`));
            }
            chunks.push(c);
          });
          res.on('end', () => done(null, Buffer.concat(chunks)));
          res.on('error', e => done(e));
        });
      } catch (e) {
        // e.g. ERR_INVALID_PROTOCOL from a poisoned initial URL.
        return done(e);
      }
      req.on('timeout', function () {
        // 'timeout' does NOT destroy the socket by itself — without this
        // the request would hang until the server closed it.
        this.destroy(new Error('Request timeout'));
      }).on('error', e => done(e));
    };
    follow(url);
  });
}

export async function httpGetJson(url) {
  const buf = await httpGet(url);
  return JSON.parse(buf.toString('utf8'));
}

// ── Service search functions (return candidate URLs, not images) ────────────
//
// Return contract: [] means "the service answered and offered nothing"
// (a genuine miss — the caller may negative-cache it long-term); NULL
// means "the search itself failed" (DNS, timeout, 5xx, rate-limit 503,
// unparseable response) — transient, the caller must use the SHORT
// cooldown. Collapsing the two was the bug that let one network blip
// poison albums with the 30-day not-found cooldown. HTTP 4xx stays []:
// the service answered, there's just no such album.

function searchFailureToResult(e) {
  return /^HTTP 4\d\d/.test(e?.message || '') ? [] : null;
}

// Both MusicBrainz (Lucene) and Deezer use double quotes as the phrase
// delimiter — a quote inside the name breaks the query syntax and those
// albums could never match. Lucene wants backslash-escaping; Deezer has
// no escape, so quotes are dropped there.
function luceneQuote(s) {
  return String(s || '').replace(/(["\\])/g, '\\$1');
}
function stripQuotes(s) {
  return String(s || '').replace(/"/g, '');
}

export async function searchMusicBrainzUrls(artist, album) {
  try {
    const query = encodeURIComponent(`release:"${luceneQuote(album)}" AND artist:"${luceneQuote(artist)}"`);
    const url = `${MUSICBRAINZ_BASE}/ws/2/release/?query=${query}&limit=3&fmt=json`;
    const data = await httpGetJson(url);
    if (!data.releases || data.releases.length === 0) return [];

    return data.releases.slice(0, 3).map(release => ({
      service: 'musicbrainz',
      url: `${COVERART_BASE}/release/${release.id}/front-500`,
      label: `MusicBrainz: ${release.title}${release.date ? ' (' + release.date.substring(0, 4) + ')' : ''}`
    }));
  } catch (e) { return searchFailureToResult(e); }
}

export async function searchItunesUrls(artist, album) {
  try {
    const term = encodeURIComponent(`${artist} ${album}`);
    const data = await httpGetJson(`${ITUNES_BASE}/search?term=${term}&entity=album&limit=3`);
    if (!data.results) return [];

    return data.results.map(r => ({
      service: 'itunes',
      url: r.artworkUrl100 ? r.artworkUrl100.replace('100x100bb', '600x600bb') : null,
      label: `iTunes: ${r.collectionName}${r.releaseDate ? ' (' + r.releaseDate.substring(0, 4) + ')' : ''}`
    })).filter(r => r.url);
  } catch (e) { return searchFailureToResult(e); }
}

export async function searchDeezerUrls(artist, album) {
  try {
    const query = encodeURIComponent(`artist:"${stripQuotes(artist)}" album:"${stripQuotes(album)}"`);
    const data = await httpGetJson(`${DEEZER_BASE}/search/album?q=${query}&limit=3`);
    if (!data.data) return [];

    return data.data.map(r => ({
      service: 'deezer',
      url: r.cover_xl || r.cover_big || r.cover_medium,
      label: `Deezer: ${r.title}${r.nb_tracks ? ' (' + r.nb_tracks + ' tracks)' : ''}`
    })).filter(r => r.url);
  } catch (e) { return searchFailureToResult(e); }
}

// Map of service name → search function, so callers can iterate the
// operator-configured `albumArtServices` list in order without a switch.
export const SERVICE_SEARCHERS = {
  musicbrainz: searchMusicBrainzUrls,
  itunes: searchItunesUrls,
  deezer: searchDeezerUrls,
};

// ── Image validation ────────────────────────────────────────────────────────

// Magic-byte sniff: { ext } for JPEG/PNG/GIF/WebP, null for anything else.
// The downloader's acceptance gate — without it a captive portal or CDN
// error page served with 200 becomes permanent "album art" (and, with
// folder-writing on, a cover.jpg the next scan indexes for every track in
// the directory). Extensions use the scanners' spellings ('jpeg', not
// 'jpg') so content-addressed cache names converge across writers.
export function sniffImage(buf) {
  if (!buf || buf.length < 12) { return null; }
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) { return { ext: 'jpeg' }; }
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) { return { ext: 'png' }; }
  if (buf.slice(0, 6).toString('latin1') === 'GIF87a'
    || buf.slice(0, 6).toString('latin1') === 'GIF89a') { return { ext: 'gif' }; }
  if (buf.slice(0, 4).toString('latin1') === 'RIFF'
    && buf.slice(8, 12).toString('latin1') === 'WEBP') { return { ext: 'webp' }; }
  return null;
}

// ── Image cache helpers ─────────────────────────────────────────────────────

// Generate the zl-/zs- thumbnail variants for an already-known cache
// filename. Best-effort — the full-size cover serves regardless.
export async function generateThumbnails(imgBuf, albumArtDir, filename) {
  try {
    const img = await Jimp.fromBuffer(imgBuf);
    await img.scaleToFit({ w: 256, h: 256 }).write(path.join(albumArtDir, 'zl-' + filename));
    await img.scaleToFit({ w: 92, h: 92 }).write(path.join(albumArtDir, 'zs-' + filename));
  } catch (_e) { /* thumbnails are best-effort */ }
}

// Hash the image bytes (MD5 → `<hash>.<ext>`), write into `albumArtDir`
// if not already present, and — when `compress` — emit the thumbnail
// variants the server serves via ?compress=. Returns { filename, hash }:
// the hash IS the filename stem (the V50 content-addressing invariant),
// handed back so callers can stamp art_files.content_hash and run dedupe
// probes without re-digesting. The extension comes from a magic-byte
// sniff using the scanners' spellings, so the same bytes cached here and
// by a scanner produce the SAME filename (one art_files row, one file).
export async function saveImageToCache(imgBuf, albumArtDir, compress) {
  const hash = crypto.createHash('md5').update(imgBuf).digest('hex');
  const filename = `${hash}.${sniffImage(imgBuf)?.ext || 'jpeg'}`;
  const artPath = path.join(albumArtDir, filename);

  if (!fs.existsSync(artPath)) {
    await fsp.writeFile(artPath, imgBuf);
    if (compress) { await generateThumbnails(imgBuf, albumArtDir, filename); }
  }
  return { filename, hash };
}

// Write `imgBuf` as `<dir>/cover.jpg`, unless a cover.jpg already exists
// there (never overwrite a file the user may have placed deliberately —
// 'wx' makes the no-clobber atomic, no exists/write race). Returns true
// if written, false if one already existed. Throws on a real write
// failure — callers that treat folder-writing as best-effort (the
// downloader) wrap in try/catch.
export async function saveCoverJpg(dir, imgBuf) {
  try {
    await fsp.writeFile(path.join(dir, 'cover.jpg'), imgBuf, { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') { return false; }
    throw e;
  }
}
