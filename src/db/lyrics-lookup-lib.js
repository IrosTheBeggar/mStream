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
import dns from 'node:dns';
import net from 'node:net';

const MAX_REDIRECTS = 5;
// Hard cap on a single response body (post-decompression). Lyrics payloads
// are a few KB; this guards the forked worker against an oversized or
// decompression-bomb response from a grey-area provider buffering unbounded
// memory.
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
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

// SSRF guard. The fetcher follows provider redirects, so a malicious or MITM'd
// provider response (the Kugou search base is plain HTTP) could 30x us at an
// internal address — cloud metadata (169.254.169.254), loopback, or the LAN —
// and the body would be stored as "lyrics" and served back. We refuse to
// connect to any non-public address. The operator-configured provider bases
// themselves (env-overridden — a 127.0.0.1 mock in tests, or a deliberate
// internal mirror) are trusted: the guard is about UNEXPECTED redirect targets,
// not the base you pointed us at.
const TRUSTED_HOSTS = new Set(
  [LRCLIB_BASE, NETEASE_BASE, KUGOU_SEARCH_BASE, KUGOU_LYRICS_BASE]
    .map((b) => { try { return new URL(b).hostname.toLowerCase(); } catch { return null; } })
    .filter(Boolean),
);

function isBlockedV4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) { return true; }
  const [a, b] = p;
  if (a === 0)   { return true; }                        // 0.0.0.0/8 "this host"
  if (a === 10)  { return true; }                        // 10/8 private
  if (a === 127) { return true; }                        // loopback
  if (a === 169 && b === 254) { return true; }           // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) { return true; }  // 172.16/12 private
  if (a === 192 && b === 168) { return true; }           // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) { return true; } // 100.64/10 CGNAT
  if (a >= 224)  { return true; }                        // multicast + reserved
  return false;
}

// True if `ip` (a literal, as produced by DNS resolution) is loopback, private,
// link-local, CGNAT, multicast or otherwise non-public.
function isBlockedAddress(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) { return isBlockedV4(ip); }
  if (fam === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') { return true; }   // loopback / unspecified
    if (/^fe[89ab]/.test(lower)) { return true; }            // fe80::/10 link-local
    if (/^f[cd]/.test(lower))    { return true; }            // fc00::/7 unique-local
    if (lower.startsWith('ff'))  { return true; }            // ff00::/8 multicast
    const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) { return isBlockedV4(mapped[1]); }           // IPv4-mapped ::ffff:a.b.c.d
    return false;
  }
  return true; // not a parseable IP — refuse
}

// A drop-in dns.lookup that refuses to resolve a host to a non-public address.
// Because the socket connects to exactly the address we return here, validating
// it also defeats DNS-rebinding. Trusted provider-base hosts skip the check.
function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const enforce = !TRUSTED_HOSTS.has(String(hostname).toLowerCase());
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) { return callback(err); }
    const list = Array.isArray(addresses) ? addresses : [addresses];
    if (enforce) {
      for (const a of list) {
        if (isBlockedAddress(a.address)) {
          return callback(new Error(`refusing to connect to non-public address ${a.address} (${hostname})`));
        }
      }
    }
    if (options.all) { return callback(null, list); }
    return callback(null, list[0].address, list[0].family);
  });
}

// GET → { status, body, text }. body is parsed JSON (null if non-JSON/empty).
// Follows redirects, transparently inflates gzip/deflate. Overridable in tests
// via _setHttpClient.
function defaultHttpGet(url, { timeoutMs = 8000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let redirects = 0;
    const startedAt = Date.now();
    // Absolute wall-clock budget across all hops — bounds the worst case
    // (MAX_REDIRECTS × per-hop timeout) to something sane.
    const overallMs = Math.max(timeoutMs, 12000);
    const follow = (u) => {
      let parsed;
      try { parsed = new URL(u); } catch { return reject(new Error(`invalid url: ${u}`)); }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return reject(new Error(`refusing non-http(s) url: ${parsed.protocol}`));
      }
      // IP-literal hosts skip DNS, so safeLookup may never run for them — check
      // the literal here (this is the main redirect-to-metadata vector).
      const host = parsed.hostname.toLowerCase();
      if (!TRUSTED_HOSTS.has(host) && net.isIP(host) && isBlockedAddress(host)) {
        return reject(new Error(`refusing to connect to non-public address ${host}`));
      }
      const remaining = overallMs - (Date.now() - startedAt);
      if (remaining <= 0) { return reject(new Error('request deadline exceeded')); }
      const mod = parsed.protocol === 'https:' ? https : http;
      const req = mod.get(u, {
        lookup: safeLookup,
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
        // When decompressing, `stream` is the transform — .pipe() does NOT
        // forward a source error to it, so a mid-body socket reset (ECONNRESET
        // / truncated gzip) surfaces on `res`, which would otherwise have no
        // listener: the promise never settles and the backfill pass hangs
        // (req.setTimeout can't fire once the socket is already destroyed, and
        // there's no per-pass watchdog). Reject on `res` too so a source error
        // becomes a clean transient. (When stream===res the listener below
        // already covers it, so only bind the extra one when decompressing.)
        if (stream !== res) { res.on('error', reject); }
        const chunks = [];
        let total = 0;
        stream.on('data', (c) => {
          total += c.length;
          if (total > MAX_RESPONSE_BYTES) {
            // Abort the socket; req 'error' → reject (classified transient).
            req.destroy(new Error('response exceeds size cap'));
            return;
          }
          chunks.push(c);
        });
        stream.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body = null;
          try { body = JSON.parse(text); } catch { /* non-JSON response */ }
          resolve({ status: res.statusCode, body, text });
        });
        stream.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(Math.min(timeoutMs, remaining), () => req.destroy(new Error('request timeout')));
    };
    follow(url);
  });
}

let httpGet = defaultHttpGet;
/** Test-only: replace the HTTP client. Pass null to restore the real one. */
export function _setHttpClient(fn) { httpGet = fn || defaultHttpGet; }
/** Test-only: the real HTTP client + the SSRF address classifier. */
export { defaultHttpGet as _defaultHttpGet, isBlockedAddress as _isBlockedAddress };

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
