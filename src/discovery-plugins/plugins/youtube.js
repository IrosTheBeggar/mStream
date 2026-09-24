// "youtube" — "Get it" from YouTube: search for the recommendation, pick the
// upload that is actually the song, download its audio with yt-dlp, tag it
// from the recommendation and file it in the user's collection destination
// (src/discovery-plugins/destination.js) the way a peer copy is filed, with
// the row inserted so it plays at once.
//
// Off by default and listed only while yt-dlp and ffmpeg are actually
// present (probe()): an enabled-but-unconfigured plug-in shows no row.
//
// A download is an upload by another road: the account must be allowed to
// upload and have a library to put files into, the copy plug-in's rules. A
// song the library already has (by tags before the search, by hash after the
// download) is skipped, and a file already at the target path is never
// overwritten. yt-dlp works in a staging folder of the job's own
// (src/discovery-plugins/staging.js); only the finished file enters the
// library.
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

import path from 'node:path';
import fs from 'node:fs/promises';
import winston from 'winston';
import * as config from '../../state/config.js';
import * as transcode from '../../api/transcode.js';
import { ffmpegBin } from '../../util/ffmpeg-bootstrap.js';
import * as ytdlp from '../../util/yt-dlp.js';
import * as vpathUtil from '../../util/vpath.js';
import * as destinations from '../destination.js';
import * as staging from '../staging.js';
import * as downloadsDb from '../../db/plugin-downloads.js';
import { ownedTrack } from '../owned.js';
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
    // unref'd: a probe still waiting must never be what keeps a process alive.
    new Promise((r) => { const t = setTimeout(r, FFMPEG_WAIT_MS); if (t.unref) { t.unref(); } }),
  ]);
  return !!(transcode.isDownloaded() && ffmpegBin());
}

// `settings` = values to try instead of the saved ones (the admin probe
// route's dry run). The executable itself is not among them: `binary` is a
// config-file setting, never editable through the admin API — an executable
// path settable by an admin session would be code execution on the host —
// so the probe always runs the configured one. The answer's `detail` is what
// an operator wants to read back: which yt-dlp answered, and from where.
async function probe({ settings } = {}) {
  const tried = { ...cfg(), ...(settings && typeof settings === 'object' ? settings : {}), binary: cfg().binary };
  const bin = ytdlp.resolveBinary(tried.binary);
  const label = bin.script || bin.cmd;
  if (!(await ytdlp.isAvailable(bin))) {
    return { ok: false, reason: `yt-dlp not found (${label})` };
  }
  let version;
  try {
    version = await ytdlp.version(bin);
  } catch (err) {
    return { ok: false, reason: `yt-dlp (${label}) ${err.message}` };
  }
  if (!(await ffmpegReady())) {
    return { ok: false, reason: 'ffmpeg is not available yet', detail: { ytdlp: version, ffmpeg: false, binary: label } };
  }
  return { ok: true, detail: { ytdlp: version, ffmpeg: true, binary: label } };
}

async function run(ctx) {
  const rec = ctx.recommendation || {};
  const settings = cfg();
  const bin = ytdlp.resolveBinary(settings.binary);
  if (!(await ytdlp.isAvailable(bin))) { throw new Error('yt-dlp is not installed on this server'); }
  if (!(await ffmpegReady())) { throw new Error('ffmpeg is not available yet'); }
  const phrase = searchPhrase(rec);
  if (!phrase) { throw new Error('the recommendation has no artist or title to search for'); }

  // Where it will land, settled before anything is searched for or fetched.
  const user = destinations.userForJob(ctx.userId);
  if (!user) { throw new Error('the account that asked for this download no longer exists'); }
  if (!destinations.uploadsAllowed(user)) { throw new Error('uploads are disabled for this account, and a download is an upload'); }
  const destination = destinations.getDestination(user);
  if (!destination) { throw new Error('no library to download into'); }
  const owned = ownedTrack({ artist: rec.artist, title: rec.title, album: rec.album });
  if (owned) { return { skipped: 'owned', existing: owned, destination }; }

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

  // 2. Download into a staging folder of this job's own — never straight
  // into a library folder, where what yt-dlp writes on the way (the
  // thumbnail before the media, fragments, a .part) would be taken for
  // songs and art.
  const chosen = best.candidate;
  ctx.progress(0.08, `downloading “${best.entry.title}” from ${chosen.channel || 'YouTube'}`);
  const dir = await staging.jobStagingDir(ctx.job.id);
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
    // Cancelled or failed: the folder goes whole, with whatever yt-dlp had
    // reached.
    await staging.discardStaging(dir);
    if (err.cancelled || ctx.isCancelled()) { return null; }   // the runner records the cancel
    throw new Error(`YouTube download failed: ${err.message}`, { cause: err });
  } finally {
    clearInterval(poll);
  }
  if (warning) { winston.warn(`youtube: yt-dlp exited unhappily but left a file (${warning})`); }

  try {
    // 3. Tags from the recommendation (YouTube's own are unreliable), the
    // cover where yt-dlp could not embed it.
    ctx.progress(0.93, 'tagging');
    const meta = { title: rec.title, artist: rec.artist, album: rec.album, year: rec.year };
    await ytdlp.embedThumbnailIfMissing(filePath, { codec: settings.codec, thumbnailUrl: chosen.thumbnail, ffmpegPath: ffmpegBin(), log: 'youtube' });
    await ytdlp.writeTags(filePath, { codec: settings.codec, meta, source: SOURCE, ffmpegPath: ffmpegBin(), log: 'youtube' });

    // 4. Where it goes: the destination's layout from those tags, a second
    // owned check by hash, and never over an existing file.
    const audioHashLib = await import('../../db/audio-hash.js');
    const hashes = await audioHashLib.computeHashes(filePath);
    const ownedNow = ownedTrack({ hash: hashes.fileHash, audioHash: hashes.audioHash });
    if (ownedNow) {
      await staging.discardStaging(dir);
      return { skipped: 'owned', existing: ownedNow, destination };
    }
    const tags = destinations.tagsForLayout(meta, rec);
    const fileName = destinations.safeFileName(path.basename(filePath));
    const target = destinations.renderTarget({ destination, tags, peerName: null, fileName });
    const targetInfo = vpathUtil.getVPathInfo(`${destination.vpath}/${target.relPath}`, user);
    if (await fs.stat(targetInfo.fullPath).then(() => true, () => false)) {
      await staging.discardStaging(dir);
      return { skipped: 'exists', filepath: `${destination.vpath}/${target.relPath}`, destination };
    }
    await staging.moveIntoPlace(filePath, targetInfo.fullPath);

    // 5. A row, so it plays at once.
    ctx.progress(0.97, 'adding to your library');
    const { insertDownloadedTrack } = await import('../../db/insert-downloaded-track.js');
    const inserted = await insertDownloadedTrack({
      filePath: targetInfo.fullPath, vpath: destination.vpath, basePath: targetInfo.basePath, source: SOURCE,
      format: ytdlp.outputExtension(settings.codec), userMeta: meta, log: 'youtube',
    });
    const stat = await fs.stat(targetInfo.fullPath);
    await staging.discardStaging(dir);
    // The record of what this plug-in brought in (src/db/plugin-downloads.js).
    const recorded = downloadsDb.recordQuietly({
      plugin: NAME, userId: ctx.userId, jobId: ctx.job.id, vpath: destination.vpath, relativePath: inserted.relativePath,
      fileHash: inserted.hash, origin: best.entry.url, title: inserted.title, artist: inserted.artist, album: inserted.album, bytes: stat.size,
    });
    winston.info(`youtube: downloaded “${best.entry.title}” (${best.entry.url}, score ${best.score}) to ${destination.vpath}/${inserted.relativePath}`);
    return {
      downloaded: {
        vpath: destination.vpath, filepath: `${destination.vpath}/${inserted.relativePath}`,
        trackId: inserted.trackId, bytes: stat.size, format: ytdlp.outputExtension(settings.codec),
        title: inserted.title, artist: inserted.artist, album: inserted.album,
        downloadId: recorded ? recorded.id : null,
      },
      match: { score: best.score, url: best.entry.url, title: best.entry.title, channel: chosen.channel, durationSec: chosen.durationSec },
      missingVars: target.missingVars,
      destination,
    };
  } catch (err) {
    await staging.discardStaging(dir);
    throw err;
  }
}

export default Object.freeze({
  name: NAME,
  title: 'YouTube',
  description: 'Searches YouTube, scores the uploads against the recommendation and saves the best match\'s audio into the user\'s collection with yt-dlp, tagged and playable at once. Needs yt-dlp and ffmpeg, and upload rights.',
  capabilities: [CAPABILITIES.ACQUIRE],
  scope: SCOPES.SERVER,
  // `binary` is deliberately not here: see probe().
  adminSettings: ['codec', 'maxFilesizeMb', 'searchResults'],
  concurrency: 1,
  probe,
  run,
});
