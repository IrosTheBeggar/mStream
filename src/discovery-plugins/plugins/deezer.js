// "deezer" — a 30-second preview from Deezer's public catalogue API.
//
// No credentials: Deezer's search and track endpoints are open. The lookup
// is ISRC-first (`/track/isrc:<ISRC>` — undocumented but stable and exact),
// then an advanced search (`artist:"…" track:"…"`), then the plain phrase;
// every search result goes through match.js so a remaster, a live take or a
// karaoke cover never becomes "the" preview. Nothing is sent until a user
// asks for this provider's preview.
//
// Deezer allows ~50 requests per 5 s per IP; the limiter stays under it and
// a per-recommendation cache keeps repeat menu opens free.

import * as config from '../../state/config.js';
import { CAPABILITIES, SCOPES } from '../registry.js';
import { searchPhrase, recommendationKey } from '../recommendation.js';
import { pickBestMatch } from '../match.js';
import { fetchJson, RateLimiter, TtlCache, providerError } from '../http.js';

export const DEEZER_BASE = process.env.MSTREAM_DEEZER_BASE || 'https://api.deezer.com';
const PROVIDER = 'deezer';
const limiter = new RateLimiter({ tokens: 40, perMs: 5000 });
const cache = new TtlCache({ ttlMs: 10 * 60 * 1000, max: 500 });

export function toCandidate(t) {
  if (!t || typeof t !== 'object') { return null; }
  return {
    id: t.id ?? null,
    title: typeof t.title === 'string' ? t.title : null,
    artist: t.artist && typeof t.artist.name === 'string' ? t.artist.name : null,
    album: t.album && typeof t.album.title === 'string' ? t.album.title : null,
    durationSec: Number.isFinite(t.duration) ? t.duration : null,
    isrc: typeof t.isrc === 'string' && t.isrc ? t.isrc : null,
    preview: typeof t.preview === 'string' && /^https?:\/\//.test(t.preview) ? t.preview : null,
    link: typeof t.link === 'string' && /^https?:\/\//.test(t.link) ? t.link : null,
    artwork: t.album && typeof t.album.cover_medium === 'string' ? t.album.cover_medium : null,
  };
}

function take() {
  if (!limiter.take()) { throw providerError('Deezer lookups are rate-limited right now — try again in a moment', 429); }
}

async function byIsrc(isrc) {
  take();
  const j = await fetchJson(`${DEEZER_BASE}/track/isrc:${encodeURIComponent(isrc)}`);
  if (!j || j.error) { return null; }   // Deezer answers 200 + { error } for "no data"
  return toCandidate(j);
}

async function search(q) {
  take();
  const j = await fetchJson(`${DEEZER_BASE}/search?q=${encodeURIComponent(q)}&limit=10`);
  if (!j || !Array.isArray(j.data)) { return []; }
  return j.data.map(toCandidate).filter(Boolean);
}

// Pure selection over already-fetched candidates — unit-tested directly.
export function choose(rec, candidates) {
  const best = pickBestMatch(rec, candidates);
  if (!best || !best.candidate.preview) { return null; }
  const c = best.candidate;
  return {
    provider: PROVIDER, url: c.preview, seconds: 30,
    title: c.title, artist: c.artist, album: c.album, link: c.link, artwork: c.artwork,
    attribution: 'Preview from Deezer', match: best.score,
  };
}

export async function findPreview(rec) {
  const key = `${PROVIDER}:${recommendationKey(rec)}`;
  const hit = cache.get(key);
  if (hit !== undefined) { return hit; }

  let preview = null;
  if (rec.isrc) {
    const exact = await byIsrc(rec.isrc);
    if (exact && exact.preview) {
      preview = { provider: PROVIDER, url: exact.preview, seconds: 30, title: exact.title, artist: exact.artist,
        album: exact.album, link: exact.link, artwork: exact.artwork, attribution: 'Preview from Deezer', match: 1 };
    }
  }
  if (!preview) {
    const clean = (s) => String(s).replace(/"/g, ' ').trim();
    let candidates = [];
    if (rec.artist && rec.title) {
      candidates = await search(`artist:"${clean(rec.artist)}" track:"${clean(rec.title)}"`);
    }
    if (candidates.length === 0) {
      const phrase = searchPhrase(rec);
      if (phrase) { candidates = await search(phrase); }
    }
    preview = choose(rec, candidates);
  }
  cache.set(key, preview);
  return preview;
}

export default Object.freeze({
  name: PROVIDER,
  title: 'Preview on Deezer',
  description: 'A 30-second preview from Deezer\'s public catalogue, matched by ISRC when the recommendation carries one, else by artist, title, album and length. Sends the search to Deezer only when a user asks for the preview.',
  capabilities: [CAPABILITIES.PREVIEW],
  scope: SCOPES.SERVER,
  async resolve(rec) {
    if (config.program && config.program.discoveryPlugins && config.program.discoveryPlugins.deezer
      && config.program.discoveryPlugins.deezer.enabled !== true) {
      return { preview: null };
    }
    return { preview: await findPreview(rec) };
  },
});
