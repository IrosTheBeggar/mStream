// "youtube" — "Get it" from YouTube: search for the recommendation, pick the
// upload that is actually the song, download its audio with yt-dlp into the
// Discover downloads scratch library, tag it from the recommendation and
// insert the row so it plays at once (design card 03).
//
// Off by default and listed only while yt-dlp and ffmpeg are actually
// present (probe()): an enabled-but-unconfigured plug-in shows no row.
//
// Matching: a YouTube search is noisy — lyric videos, live takes, covers,
// karaoke, the right song by the wrong artist. Every result is read two
// ways (as titled, and split at " - " into artist / title), scored with the
// shared match scorer against the recommendation (title, artist, album,
// length), given a small bonus when it comes from an auto-generated
// "<Artist> - Topic" channel (YouTube's own release audio), and dropped
// when its title carries a blocked word (cover, karaoke, live, remix, …)
// the recommendation does not. Below MIN_SCORE the job fails with the
// best score, rather than landing the wrong song.

import fs from 'node:fs/promises';
import winston from 'winston';
import * as config from '../../state/config.js';
import * as transcode from '../../api/transcode.js';
import { ffmpegBin } from '../../util/ffmpeg-bootstrap.js';
import * as ytdlp from '../../util/yt-dlp.js';
import * as downloads from '../downloads.js';
import { scoreCandidate, MIN_SCORE } from '../match.js';
import { searchPhrase } from '../recommendation.js';
import { CAPABILITIES, SCOPES } from '../registry.js';

export const NAME = 'youtube';
export const SOURCE = 'plugin:youtube';
export const TOPIC_BONUS = 0.05;

const CONFIRM_TOP = 2;
const CANCEL_POLL_MS = 500;

// ── Pure: reading YouTube titles (unit-tested) ────────────────────────────

// Bracketed or trailing edition noise YouTube uploads carry that a catalogue
// title never does.
const BRACKET_NOISE = /[([][^)\]]*\b(official|lyrics?|audio|video|visuali[sz]er|hd|hq|4k|1080p|720p|explicit|clean|full\s+(song|track))\b[^)\]]*[)\]]/gi;
const TRAILING_NOISE = /\s*[-–—|:]\s*(official\s+)?(hd\s+|hq\s+)?(music\s+video|lyric\s+video|lyrics?|audio|video|visuali[sz]er|audio\s+only)\s*$/i;
const BLOCKED = /\b(cover|karaoke|instrumental|live|remix|reaction|nightcore|slowed|sped[\s-]*up|8d|tutorial|lesson|backing\s+track|mashup|parody|reverb)\b/i;

export function cleanTitle(raw) {
  let s = String(raw || '');
  s = s.replace(BRACKET_NOISE, ' ');
  s = s.replace(TRAILING_NOISE, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// The blocked word a candidate title carries that the recommendation does
// not, or null.
export function blockedWord(candidateTitle, recTitle) {
  const m = BLOCKED.exec(String(candidateTitle || ''));
  if (!m) { return null; }
  const word = m[1].toLowerCase();
  const rec = String(recTitle || '').toLowerCase();
  return rec.includes(word) ? null : word;
}

// "Artist - Title" → { artist, title }, else null.
export function splitArtistTitle(title) {
  const m = /^(.{1,80}?)\s+[-–—:]\s+(.{1,160})$/.exec(String(title || '').trim());
  return m ? { artist: m[1].trim(), title: m[2].trim() } : null;
}

export function isTopicChannel(channel) {
  return /-\s*Topic$/i.test(String(channel || '').trim());
}

export function channelArtist(channel) {
  const s = String(channel || '').replace(/\s*-\s*Topic$/i, '').trim();
  return s || null;
}

// The ways one result can be read, in the scorer's shape.
export function toCandidates(entry) {
  const title = cleanTitle(entry.title);
  const base = {
    id: entry.id, url: entry.url, rawTitle: entry.title, title,
    artist: entry.artist || channelArtist(entry.channel) || entry.uploader || null,
    album: entry.album || null,
    durationSec: entry.durationSec,
    channel: entry.channel || null,
    topic: isTopicChannel(entry.channel),
    thumbnail: entry.thumbnail || null,
    year: entry.year || null,
  };
  const split = splitArtistTitle(title);
  return split ? [base, { ...base, artist: split.artist, title: split.title, split: true }] : [base];
}

// Every result scored: [{ entry, candidate, score }] best first. A result
// with a blocked word, or a length that rules it out, is not in the list.
// The Topic bonus orders the list (a full match from the artist's own
// channel beats a full match from a lyric channel) while the reported score
// stays within 0..1.
export function rankCandidates(rec, entries) {
  const out = [];
  for (const entry of entries || []) {
    if (!entry || !entry.url) { continue; }
    if (blockedWord(entry.title, rec.title)) { continue; }
    let best = null;
    for (const candidate of toCandidates(entry)) {
      const s = scoreCandidate(rec, candidate);
      if (s === null) { continue; }
      const rank = s + (candidate.topic ? TOPIC_BONUS : 0);
      if (!best || rank > best.rank) {
        best = { entry, candidate, rank, score: Math.round(Math.min(1, rank) * 1000) / 1000 };
      }
    }
    if (best) { out.push(best); }
  }
  out.sort((a, b) => b.rank - a.rank);
  return out.map(({ entry, candidate, score }) => ({ entry, candidate, score }));
}

export function pickBest(ranked, minScore = MIN_SCORE) {
  return ranked.length && ranked[0].score >= minScore ? ranked[0] : null;
}

// ── The job ───────────────────────────────────────────────────────────────

function cfg() {
  const c = config.program && config.program.discoveryPlugins && config.program.discoveryPlugins.youtube;
  return { binary: 'yt-dlp', codec: 'mp3', maxFilesizeMb: 100, searchResults: 8, ...(c || {}) };
}

// ffmpeg resolves asynchronously at boot (and may still be downloading on
// a fresh install); give its bootstrap a moment before calling it absent.
const FFMPEG_WAIT_MS = 15_000;

async function ffmpegReady() {
  if (transcode.isDownloaded() && ffmpegBin()) { return true; }
  await Promise.race([
    transcode.downloadedFFmpeg().catch(() => {}),
    new Promise((r) => setTimeout(r, FFMPEG_WAIT_MS)),
  ]);
  return !!(transcode.isDownloaded() && ffmpegBin());
}

async function probe() {
  const bin = ytdlp.resolveBinary(cfg().binary);
  if (!(await ytdlp.isAvailable(bin))) {
    return { ok: false, reason: `yt-dlp not found (${bin.script || bin.cmd})` };
  }
  if (!(await ffmpegReady())) {
    return { ok: false, reason: 'ffmpeg is not available yet' };
  }
  return { ok: true };
}

async function run(ctx) {
  const rec = ctx.recommendation || {};
  const settings = cfg();
  const bin = ytdlp.resolveBinary(settings.binary);
  if (!(await ytdlp.isAvailable(bin))) { throw new Error('yt-dlp is not installed on this server'); }
  if (!(await ffmpegReady())) { throw new Error('ffmpeg is not available yet'); }
  const phrase = searchPhrase(rec);
  if (!phrase) { throw new Error('the recommendation has no artist or title to search for'); }

  // 1. Search, rank, confirm the top results with their full record.
  ctx.progress(0.02, `searching YouTube for “${phrase}”`);
  const entries = await ytdlp.search(phrase, { bin, results: settings.searchResults });
  if (entries.length === 0) { throw new Error(`YouTube returned no results for “${phrase}”`); }
  let ranked = rankCandidates(rec, entries);
  if (ranked.length > 0) {
    const confirmed = [];
    for (const r of ranked.slice(0, CONFIRM_TOP)) {
      if (ctx.isCancelled()) { return null; }
      try {
        const full = await ytdlp.details(r.entry.url, { bin });
        confirmed.push({ ...r.entry, ...Object.fromEntries(Object.entries(full).filter(([, v]) => v != null)) });
      } catch (err) {
        winston.warn(`youtube: could not confirm ${r.entry.url} (${err.message}); scoring the search entry as is`);
        confirmed.push(r.entry);
      }
    }
    ranked = rankCandidates(rec, confirmed);
  }
  const best = pickBest(ranked);
  if (!best) {
    const top = ranked.length ? ranked[0].score.toFixed(2) : '0.00';
    throw new Error(`Nothing matched closely enough (best score ${top}, needs ${MIN_SCORE})`);
  }

  // 2. Download into the user's Discover downloads folder.
  const user = downloads.userForJob(ctx.userId);
  if (!user) { throw new Error('the account that asked for this download no longer exists'); }
  await downloads.ensureLibrary(user);
  const dir = await downloads.userDir(user);
  const chosen = best.candidate;
  ctx.progress(0.08, `downloading “${best.entry.title}” from ${chosen.channel || 'YouTube'}`);
  const startedAt = Date.now();
  const handle = ytdlp.startDownload({
    bin, url: best.entry.url, dir, codec: settings.codec, ffmpegPath: ffmpegBin(), maxFilesizeMb: settings.maxFilesizeMb,
    onProgress: (f) => ctx.progress(0.1 + 0.8 * f, `${Math.round(f * 100)}% of “${best.entry.title}”`),
  });
  const poll = setInterval(() => { if (ctx.isCancelled()) { handle.abort(); } }, CANCEL_POLL_MS);
  let filePath;
  let warning;
  try {
    ({ filePath, warning } = await handle.done);
  } catch (err) {
    if (err.cancelled || ctx.isCancelled()) {
      await ytdlp.removePartials(dir, startedAt);
      return null;   // the runner records the cancel
    }
    throw new Error(`YouTube download failed: ${err.message}`, { cause: err });
  } finally {
    clearInterval(poll);
  }
  if (warning) { winston.warn(`youtube: yt-dlp exited unhappily but left a file (${warning})`); }

  // 3. Tags from the recommendation (YouTube's own are unreliable), the
  // cover where yt-dlp could not embed it, then the row.
  ctx.progress(0.93, 'tagging');
  const meta = { title: rec.title, artist: rec.artist, album: rec.album, year: rec.year };
  await ytdlp.embedThumbnailIfMissing(filePath, { codec: settings.codec, thumbnailUrl: chosen.thumbnail, ffmpegPath: ffmpegBin(), log: 'youtube' });
  await ytdlp.writeTags(filePath, { codec: settings.codec, meta, source: SOURCE, ffmpegPath: ffmpegBin(), log: 'youtube' });
  ctx.progress(0.97, 'adding to your library');
  const { insertDownloadedTrack } = await import('../../db/insert-downloaded-track.js');
  const inserted = await insertDownloadedTrack({
    filePath, vpath: downloads.LIBRARY_NAME, basePath: downloads.downloadsDir(), source: SOURCE,
    format: ytdlp.outputExtension(settings.codec), userMeta: meta, log: 'youtube',
  });
  const stat = await fs.stat(filePath);
  winston.info(`youtube: downloaded “${best.entry.title}” (${best.entry.url}, score ${best.score}) to ${downloads.LIBRARY_NAME}/${inserted.relativePath}`);
  return {
    downloaded: {
      vpath: downloads.LIBRARY_NAME, filepath: `${downloads.LIBRARY_NAME}/${inserted.relativePath}`,
      trackId: inserted.trackId, bytes: stat.size, format: ytdlp.outputExtension(settings.codec),
    },
    match: { score: best.score, url: best.entry.url, title: best.entry.title, channel: chosen.channel, durationSec: chosen.durationSec },
    expiresAt: downloads.expiresAt(),
  };
}

export default Object.freeze({
  name: NAME,
  title: 'YouTube',
  description: 'Searches YouTube for the recommendation, downloads the best-matching upload\'s audio with yt-dlp into the Discover downloads folder, tags it and adds it to the library. Needs yt-dlp and ffmpeg; off by default.',
  capabilities: [CAPABILITIES.ACQUIRE],
  scope: SCOPES.SERVER,
  concurrency: 1,
  probe,
  run,
});
