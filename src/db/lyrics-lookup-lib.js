// Lyrics provider library — used by the lyrics-backfill worker
// (src/db/lyrics-backfill.mjs). Dependency-light on purpose (no `config`/`db`
// imports) so the forked worker and the unit tests can use it directly.
//
// Each provider is `async (artist, title, durationSec) => Result`:
//   Result = { syncedLrc, plain, lang, source } | null
//   null   → authoritative miss (provider answered, no usable lyrics)
//   throw  → transient (5xx, timeout, parse error, gated/encrypted response)
// `source` is the literal provider key written into tracks.lyrics_source.
//
// Endpoints + KRC key were verified live 2026-06-23 (see the lyrics feature
// plan). LRCLib is the clean default; NetEase + Kugou are unofficial /
// reverse-engineered (off by default in config). Fetched lyrics live only in
// the operator's own DB — never redistributed.

import https from 'node:https';
import http from 'node:http';
import zlib from 'node:zlib';

const MAX_REDIRECTS = 5;
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LRCLIB_UA = 'mStream/lrclib-fetch (+https://mstream.io)';

// Endpoint bases — env-overridable so tests can point at a local mock server.
const LRCLIB_BASE       = process.env.MSTREAM_LRCLIB_BASE       || 'https://lrclib.net';
const NETEASE_BASE      = process.env.MSTREAM_NETEASE_BASE      || 'https://music.163.com';
const KUGOU_SEARCH_BASE = process.env.MSTREAM_KUGOU_SEARCH_BASE || 'http://mobilecdn.kugou.com';
const KUGOU_LYRICS_BASE = process.env.MSTREAM_KUGOU_LYRICS_BASE || 'https://lyrics.kugou.com';

// ── HTTP ──────────────────────────────────────────────────────────────────

// GET → { status, body, text }. body is parsed JSON (null if non-JSON/empty).
// Follows redirects, transparently inflates gzip/deflate. Overridable in tests
// via _setHttpClient.
function defaultHttpGet(url, { timeoutMs = 8000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let redirects = 0;
    const follow = (u) => {
      const mod = u.startsWith('https:') ? https : http;
      const req = mod.get(u, {
        headers: { 'User-Agent': BROWSER_UA, 'Accept-Encoding': 'gzip, deflate', ...headers },
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (++redirects > MAX_REDIRECTS) { return reject(new Error('redirect limit exceeded')); }
          return follow(new URL(res.headers.location, u).toString());
        }
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        let stream = res;
        if (enc === 'gzip') { stream = res.pipe(zlib.createGunzip()); }
        else if (enc === 'deflate') { stream = res.pipe(zlib.createInflate()); }
        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body = null;
          try { body = JSON.parse(text); } catch { /* non-JSON response */ }
          resolve({ status: res.statusCode, body, text });
        });
        stream.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => req.destroy(new Error('request timeout')));
    };
    follow(url);
  });
}

let httpGet = defaultHttpGet;
/** Test-only: replace the HTTP client. Pass null to restore the real one. */
export function _setHttpClient(fn) { httpGet = fn || defaultHttpGet; }

// Cheap "is this LRC?" check — at least one [mm:ss(.xx)] timestamp.
function looksLikeLrc(text) {
  return !!text && /^[ \t]*\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/m.test(text);
}

// ── KRC decode (for a future Kugou fmt=krc word-timed path) ──────────────────
// Verified key (byte-for-byte across 5 sources + a live decode 2026-06-23):
//   '@Gaw^2tGQ61-' + 0xCE 0xD2 0x6E 0x69
const KRC_KEY = Buffer.from([64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105]);

/** base64 → strip 'krc1' magic → XOR with the repeating key → inflate → KRC text. */
export function decodeKrc(b64) {
  const enc = Buffer.from(b64, 'base64');
  if (enc.toString('ascii', 0, 4) !== 'krc1') { throw new Error('not a krc1 payload'); }
  const body = enc.subarray(4);
  const out = Buffer.allocUnsafe(body.length);
  for (let i = 0; i < body.length; i++) { out[i] = body[i] ^ KRC_KEY[i & 0x0f]; }
  // unzipSync auto-detects zlib AND gzip — a real payload was zlib-wrapped, so
  // gunzipSync would fail on it. HARD REQUIREMENT.
  return zlib.unzipSync(out).toString('utf8');
}

/** Collapse word-timed KRC (`[start,dur]<off,dur,0>word…`) to line-level LRC. */
export function krcToLrc(krc) {
  const out = [];
  for (const raw of String(krc).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { continue; }
    const meta = line.match(/^\[(ti|ar|al|by|offset):(.*)\]$/i);
    if (meta) { out.push(`[${meta[1].toLowerCase()}:${meta[2]}]`); continue; }
    if (/^\[language:/i.test(line)) { continue; } // translation blob — drop
    const m = line.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!m) { continue; }
    const startMs = parseInt(m[1], 10);
    const text = m[3].replace(/<\d+,\d+,\d+>/g, ''); // strip per-word tags
    const mm = String(Math.floor(startMs / 60000)).padStart(2, '0');
    const ss = String(Math.floor((startMs % 60000) / 1000)).padStart(2, '0');
    const cs = String(Math.floor((startMs % 1000) / 10)).padStart(2, '0');
    out.push(`[${mm}:${ss}.${cs}]${text}`);
  }
  return out.join('\n');
}

// ── Providers ────────────────────────────────────────────────────────────────

// LRCLib — two attempts: exact-duration first (its matcher is strict), then
// fuzzy (duration omitted). 404 / 200-empty → miss; other non-200 → transient.
async function lrclib(artist, title, durationSec) {
  const tryOnce = async (dur) => {
    const params = new URLSearchParams({ artist_name: artist, track_name: title });
    if (dur > 0) { params.set('duration', String(Math.round(dur))); }
    const { status, body } = await httpGet(`${LRCLIB_BASE}/api/get?${params}`, { headers: { 'User-Agent': LRCLIB_UA } });
    if (status === 404) { return null; }
    if (status !== 200) { throw new Error(`lrclib ${status}`); }
    if (!body) { throw new Error('lrclib parse error'); }
    if (!body.syncedLyrics && !body.plainLyrics) { return null; }
    return body;
  };
  let data = durationSec > 0 ? await tryOnce(durationSec) : null;
  if (!data) { data = await tryOnce(0); }
  if (!data) { return null; }
  return { syncedLrc: data.syncedLyrics || null, plain: data.plainLyrics || null, lang: null, source: 'lrclib' };
}

// NetEase — plain GETs, no auth/encryption. search/get → song id → song/lyric.
// pureMusic / untimed → miss. Verified live 2026-06-23.
async function netease(artist, title, durationSec) {
  const headers = { Referer: 'https://music.163.com' };
  const q = encodeURIComponent(`${artist} ${title}`.trim());

  const search = async (path) => {
    const r = await httpGet(`${NETEASE_BASE}${path}?s=${q}&type=1&limit=5&offset=0`, { headers });
    if (r.status !== 200 || !r.body) { throw new Error(`netease search ${r.status}`); }
    // -462 = phone-bind gate; a string `result` = AES blob — both transient.
    if (r.body.code === -462 || typeof r.body.result === 'string') { throw new Error('netease search gated'); }
    return Array.isArray(r.body.result?.songs) ? r.body.result.songs : null;
  };

  let songs = await search('/api/search/get');
  if (!songs || songs.length === 0) { songs = await search('/api/cloudsearch/pc'); } // shrinking-path fallback
  if (!songs || songs.length === 0) { return null; }

  const durMs = (durationSec || 0) * 1000;
  let song = songs[0];
  if (durMs > 0) {
    const match = songs.find((s) => Math.abs((s.duration || 0) - durMs) <= 3000);
    if (match) { song = match; }
  }
  if (!song?.id) { return null; }

  const lr = await httpGet(`${NETEASE_BASE}/api/song/lyric?id=${song.id}&lv=-1&kv=-1&tv=-1`, { headers });
  if (lr.status !== 200 || !lr.body) { throw new Error(`netease lyric ${lr.status}`); }
  if (lr.body.pureMusic === true) { return null; }
  let lrc = lr.body.lrc?.lyric;
  if (!looksLikeLrc(lrc)) { return null; }
  // Drop the crowd-sourced credit watermark lines (e.g. `[by:99Lrc.net]`).
  lrc = lrc.split(/\r?\n/).filter((l) => !/^\s*\[by:/i.test(l)).join('\n');
  if (!looksLikeLrc(lrc)) { return null; }
  return { syncedLrc: lrc, plain: null, lang: null, source: 'netease' };
}

// Kugou — search → hash → lyric candidate → download (fmt=lrc, no KRC crypto on
// the hot path). Verified live 2026-06-23.
async function kugou(artist, title, durationSec) {
  const kw = encodeURIComponent(`${title} ${artist}`.trim());
  const s = await httpGet(`${KUGOU_SEARCH_BASE}/api/v3/search/song?format=json&keyword=${kw}&page=1&pagesize=10&showtype=1`);
  if (s.status !== 200 || !s.body) { throw new Error(`kugou search ${s.status}`); }
  const info = s.body.data?.info;
  if (!Array.isArray(info) || info.length === 0) { return null; }
  let pick = info[0];
  if (durationSec > 0) {
    const match = info.find((i) => Math.abs((i.duration || 0) - durationSec) <= 2); // search duration is SECONDS
    if (match) { pick = match; }
  }
  if (!pick?.hash) { return null; }
  const durMs = (pick.duration || durationSec || 0) * 1000; // candidate search wants MS

  const c = await httpGet(`${KUGOU_LYRICS_BASE}/search?ver=1&man=yes&client=mobi&hash=${pick.hash}&duration=${durMs}&keyword=&album_audio_id=`);
  if (c.status !== 200 || !c.body) { throw new Error(`kugou candidate ${c.status}`); }
  if (c.body.status !== 200) { throw new Error(`kugou candidate status ${c.body.status}`); }
  const cand = c.body.candidates?.[0];
  if (!cand?.id || !cand?.accesskey) { return null; }

  const d = await httpGet(`${KUGOU_LYRICS_BASE}/download?ver=1&client=pc&id=${cand.id}&accesskey=${cand.accesskey}&fmt=lrc&charset=utf8`);
  if (d.status !== 200 || !d.body) { throw new Error(`kugou download ${d.status}`); }
  if (!d.body.content) { return null; }
  const lrc = Buffer.from(d.body.content, 'base64').toString('utf8');
  if (!looksLikeLrc(lrc)) { return null; }
  return { syncedLrc: lrc, plain: null, lang: null, source: 'kugou' };
}

export const LYRICS_PROVIDERS = { lrclib, netease, kugou };
