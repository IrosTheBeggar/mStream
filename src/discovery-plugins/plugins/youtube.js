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
//
// The lookup (capability `lookup`, resolve()): the same search, ranking
// and confirmation with nothing fetched, answered as candidates best first
// so a window can show what "Get it" would download and let the user pick
// another upload. A job started with `choice: { url }` then reads that
// upload instead of searching, and the user's pick stands even where the
// scorer would have passed it over. Answers are cached for a while: a
// search is a yt-dlp process and a request to YouTube, and one window is
// opened more than once.

import path from 'node:path';
import fs from 'node:fs/promises';
import winston from 'winston';
import * as config from '../../state/config.js';
import * as transcode from '../../api/transcode.js';
import { ffmpegBin } from '../../util/ffmpeg-bootstrap.js';
import * as ytdlp from '../../util/yt-dlp.js';
import * as ytDlpBootstrap from '../../util/yt-dlp-bootstrap.js';
import * as vpathUtil from '../../util/vpath.js';
import * as destinations from '../destination.js';
import * as staging from '../staging.js';
import * as downloadsDb from '../../db/plugin-downloads.js';
import { ownedTrack, libraryIdsFor } from '../owned.js';
import { norm } from '../../db/discovery-novelty.js';
import { scoreCandidate, MIN_SCORE } from '../match.js';
import { recommendationKey, searchPhrase } from '../recommendation.js';
import { CAPABILITIES, SCOPES } from '../registry.js';

export const NAME = 'youtube';
export const SOURCE = 'plugin:youtube';
export const TOPIC_BONUS = 0.05;

const CONFIRM_TOP = 2;
const CANCEL_POLL_MS = 500;
// The lookup: how many candidates a window gets, how long an answer is
// kept, and how many answers are kept.
const LOOKUP_MAX = 5;
const LOOKUP_TTL_MS = 6 * 60 * 60 * 1000;
const LOOKUP_CACHE_MAX = 200;
// A lookup that misses the cache is a yt-dlp search plus a details call per
// confirmed result — processes and requests to YouTube on this server's
// behalf. So few run at once, a short line waits, and the rest are told to
// come back (429, which the resolve route passes through); a search that
// hangs is cut off.
export const LOOKUP_CONCURRENCY = 2;
export const LOOKUP_QUEUE_MAX = 6;
const LOOKUP_TIMEOUT_MS = 90 * 1000;
// A song is a song: a download runs at most this long, whatever yt-dlp is
// pulling (the size cap is enforced by mStream too — src/util/yt-dlp.js).
const DOWNLOAD_MAX_SECONDS = 30 * 60;

// A live stream, one that has not started, or one just ended is not a
// song: yt-dlp fetches those through ffmpeg, where --max-filesize does not
// apply, and a 24/7 stream would run until the disk filled. Never picked,
// never offered, and refused as a user's choice.
export function isLiveEntry(entry) {
  if (!entry) { return false; }
  return entry.isLive === true || ['is_live', 'is_upcoming', 'post_live'].includes(entry.liveStatus);
}

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
    if (isLiveEntry(entry)) { continue; }
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

// A chosen upload's link, as the job start route checks it: YouTube's own
// hosts, a watch page, a short or a live page. Anything else is refused
// before a job exists — yt-dlp fetches from hundreds of sites, and the
// choice would otherwise be a way to make this server download from any
// of them.
export function isYouTubeUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch (_e) { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') { return false; }
  const host = u.hostname.toLowerCase();
  const ID = /^[A-Za-z0-9_-]+$/;
  if (host === 'youtu.be') { return ID.test(u.pathname.slice(1)); }
  if (!/^(www\.|m\.|music\.)?youtube\.com$/.test(host)) { return false; }
  if (u.pathname === '/watch') { return ID.test(u.searchParams.get('v') || ''); }
  const m = /^\/(shorts|live)\/([^/]+)$/.exec(u.pathname);
  return !!m && ID.test(m[2]);
}

// The lookup's answer from the ranked results: what a window shows before
// anything is fetched. Best first, at most `max`.
export function lookupCandidates(ranked, { max = LOOKUP_MAX } = {}) {
  return (ranked || []).slice(0, max).map(({ entry, candidate, score }) => ({
    id: entry.id || null,
    url: entry.url,
    title: entry.title || '',
    channel: candidate.channel || null,
    durationSec: Number.isFinite(candidate.durationSec) ? candidate.durationSec : null,
    thumbnail: candidate.thumbnail || null,
    topic: candidate.topic === true,
    score,
  }));
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

// yt-dlp's own words for an upload it cannot serve: private, removed,
// region-locked, "not available". Such a result is dropped rather than
// scored thin — it would only fail the download later.
const UNAVAILABLE_RE = /not available|unavailable|private video|has been removed|video is private|blocked|age.restricted|sign in to confirm your age/i;

export function isUnavailableMessage(message) {
  return UNAVAILABLE_RE.test(String(message || ''));
}

// Rank the search results, then confirm the top ones with their full
// record (flat search entries are thin: no reliable duration or channel)
// and rank those again. `top` is what a job picks from — confirmed
// records only, so a thin entry never wins on missing data; `rest` is the
// tail as found, for a lookup to offer. An upload YouTube will not serve
// leaves the list. Null when the caller cancelled.
async function rankConfirmed(rec, entries, { bin, isCancelled = () => false, signal } = {}) {
  const ranked = rankCandidates(rec, entries);
  if (ranked.length === 0) { return { top: [], rest: [] }; }
  const confirmed = [];
  for (const r of ranked.slice(0, CONFIRM_TOP)) {
    if (isCancelled()) { return null; }
    try {
      const full = await ytdlp.details(r.entry.url, { bin, signal });
      if (isLiveEntry(full)) {
        winston.info(`youtube: ${r.entry.url} is a live stream (${full.liveStatus || 'live'}); not a candidate`);
        continue;
      }
      confirmed.push({ ...r.entry, ...Object.fromEntries(Object.entries(full).filter(([, v]) => v != null)) });
    } catch (err) {
      if (isUnavailableMessage(err.message)) {
        winston.info(`youtube: ${r.entry.url} is not served (${err.message}); not a candidate`);
        continue;
      }
      winston.warn(`youtube: could not confirm ${r.entry.url} (${err.message}); scoring the search entry as is`);
      confirmed.push(r.entry);
    }
  }
  return { top: rankCandidates(rec, confirmed), rest: ranked.slice(CONFIRM_TOP) };
}

// ── The lookup ───────────────────────────────────────────────────────────
// What "Get it" would fetch, before anything is: the uploads found for the
// recommendation, scored, best first. A song the library already has
// answers `owned` without asking YouTube. One search serves concurrent
// askers, and an answer is kept for LOOKUP_TTL_MS.
const lookupCache = new Map();      // key → { at, answer }
const lookupInFlight = new Map();   // key → Promise<answer>

function cachedLookup(key) {
  const hit = lookupCache.get(key);
  if (!hit) { return null; }
  if (Date.now() - hit.at > LOOKUP_TTL_MS) { lookupCache.delete(key); return null; }
  return hit.answer;
}

function rememberLookup(key, answer) {
  lookupCache.set(key, { at: Date.now(), answer });
  while (lookupCache.size > LOOKUP_CACHE_MAX) { lookupCache.delete(lookupCache.keys().next().value); }
}

export function forgetLookups() { lookupCache.clear(); }

// The lookup's slots: LOOKUP_CONCURRENCY searches at once, LOOKUP_QUEUE_MAX
// waiting, the rest refused with a 429. acquire() resolves to the release
// function; a released slot goes to the next in line.
const lookupSlots = { busy: 0, waiting: [] };
export function lookupLoad() { return { busy: lookupSlots.busy, waiting: lookupSlots.waiting.length }; }
export function acquireLookupSlot() {
  const release = () => {
    const next = lookupSlots.waiting.shift();
    if (next) { next(release); } else { lookupSlots.busy -= 1; }
  };
  if (lookupSlots.busy < LOOKUP_CONCURRENCY) {
    lookupSlots.busy += 1;
    return Promise.resolve(release);
  }
  if (lookupSlots.waiting.length >= LOOKUP_QUEUE_MAX) {
    return Promise.reject(Object.assign(new Error('too many lookups at once — try again in a moment'), { status: 429 }));
  }
  return new Promise((resolve) => { lookupSlots.waiting.push(resolve); });
}

// What a lookup answered is a function of what was searched (the phrase)
// and what the results were scored against (album, length), and of how
// many results were asked for. The recommendation's identity is part of
// the key, never the whole of it: an MBID alone would let any caller plant
// an answer under a real recording's id for everyone who opens it.
export function lookupCacheKey(rec, query, searchResults) {
  return [recommendationKey(rec), norm(query), norm(rec.album), rec.duration == null ? '' : String(rec.duration), String(searchResults)].join('|');
}

async function resolve(rec, { user = null } = {}) {
  const settings = cfg();
  const query = searchPhrase(rec);
  const answer = (over) => ({ lookup: { query, minScore: MIN_SCORE, candidates: [], owned: null, ...over } });
  if (!query) { return answer(); }
  const owned = ownedTrack({ artist: rec.artist, title: rec.title, album: rec.album, duration: rec.duration, libraryIds: libraryIdsFor(user) });
  if (owned) { return answer({ owned }); }
  const key = lookupCacheKey(rec, query, settings.searchResults);
  const cached = cachedLookup(key);
  if (cached) { return { lookup: cached }; }
  if (!lookupInFlight.has(key)) {
    const p = (async () => {
      const release = await acquireLookupSlot();
      try {
        const signal = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
        const bin = await ytDlpBin(settings);
        const entries = await ytdlp.search(query, { bin, results: settings.searchResults, signal });
        const r = await rankConfirmed(rec, entries, { bin, signal });
        const found = { query, minScore: MIN_SCORE, candidates: lookupCandidates(r.top.concat(r.rest)), owned: null };
        rememberLookup(key, found);
        return found;
      } finally {
        release();
      }
    })().finally(() => lookupInFlight.delete(key));
    lookupInFlight.set(key, p);
  }
  return { lookup: await lookupInFlight.get(key) };
}

// The job start route's check of `choice` (a lookup candidate the user
// picked): a YouTube link, nothing else.
function validateChoice(choice) {
  if (!choice || !isYouTubeUrl(choice.url)) { throw new Error('the chosen upload must be a YouTube link'); }
}

// The yt-dlp a lookup or a job runs: whichever copy the bootstrap decided
// on (the server's own while it is current, else the managed one — fetched
// on the spot the first time). Throws the sentence the job shows when there
// is none.
async function ytDlpBin(settings) {
  const found = await ytDlpBootstrap.locate(settings.binary);
  if (!found.bin) { throw new Error('yt-dlp is not installed on this server'); }
  // The plug-in is on and running yt-dlp: keep that copy current from here
  // on (idempotent; the boot path arms it too when the plug-in starts on).
  ytDlpBootstrap.startAutoUpdate();
  return found.bin;
}

// `settings` = values to try instead of the saved ones (the admin probe
// route's dry run). The executable itself is not among them: `binary` is a
// config-file setting, never editable through the admin API — an executable
// path settable by an admin session would be code execution on the host —
// so the probe always runs the configured one. The answer's `detail` is what
// an operator wants to read back: which yt-dlp answered, from where, and
// whether mStream keeps it current. On a server without yt-dlp this probe
// is what fetches mStream's own copy (src/util/yt-dlp-bootstrap.js).
async function probe({ settings } = {}) {
  const tried = { ...cfg(), ...(settings && typeof settings === 'object' ? settings : {}), binary: cfg().binary };
  const found = await ytDlpBootstrap.locate(tried.binary);
  if (!found.bin) {
    return { ok: false, reason: found.reason || `yt-dlp not found (${found.label || tried.binary})` };
  }
  const label = found.label || found.bin.script || found.bin.cmd;
  let version = found.version;
  if (!version) {
    try {
      version = await ytdlp.version(found.bin);
    } catch (err) {
      return { ok: false, reason: `yt-dlp (${label}) ${err.message}` };
    }
  }
  const st = ytDlpBootstrap.status();
  const detail = {
    ytdlp: version, ffmpeg: true, binary: label, source: found.source,
    note: found.note || null, latest: st.latest, autoUpdate: st.autoUpdate, checkedAt: st.checkedAt,
  };
  if (!(await ffmpegReady())) {
    return { ok: false, reason: 'ffmpeg is not available yet', detail: { ...detail, ffmpeg: false } };
  }
  return { ok: true, detail };
}

async function run(ctx) {
  const rec = ctx.recommendation || {};
  const settings = cfg();
  const bin = await ytDlpBin(settings);
  if (!(await ffmpegReady())) { throw new Error('ffmpeg is not available yet'); }
  const phrase = searchPhrase(rec);
  if (!phrase) { throw new Error('the recommendation has no artist or title to search for'); }

  // Where it will land, settled before anything is searched for or fetched.
  const user = destinations.userForJob(ctx.userId);
  if (!user) { throw new Error('the account that asked for this download no longer exists'); }
  if (!destinations.uploadsAllowed(user)) { throw new Error('uploads are disabled for this account, and a download is an upload'); }
  const destination = destinations.getDestination(user);
  if (!destination) { throw new Error('no library to download into'); }
  const libraryIds = libraryIdsFor(user);
  const owned = ownedTrack({ artist: rec.artist, title: rec.title, album: rec.album, duration: rec.duration, libraryIds });
  if (owned) { return { skipped: 'owned', existing: owned, destination }; }

  // 1. The upload the user picked from the lookup, read in full — their
  // pick stands even where the scorer would have passed it over (a live
  // take, a length that does not fit), the score is only reported — or
  // else the search: rank, confirm the top results with their full record,
  // take the best.
  const choice = ctx.params && ctx.params.choice;
  let best;
  if (choice) {
    validateChoice(choice);
    ctx.progress(0.02, 'reading the chosen upload');
    let entry;
    try {
      entry = await ytdlp.details(choice.url, { bin });
    } catch (err) {
      throw new Error(`the chosen upload could not be read: ${err.message}`, { cause: err });
    }
    entry = { ...entry, url: entry.url || choice.url, title: entry.title || '' };
    if (isLiveEntry(entry)) { throw new Error('the chosen upload is a live stream, not a song — pick another'); }
    best = rankCandidates(rec, [entry])[0] || { entry, candidate: toCandidates(entry)[0], score: 0 };
  } else {
    ctx.progress(0.02, `searching YouTube for “${phrase}”`);
    const entries = await ytdlp.search(phrase, { bin, results: settings.searchResults });
    if (entries.length === 0) { throw new Error(`YouTube returned no results for “${phrase}”`); }
    const r = await rankConfirmed(rec, entries, { bin, isCancelled: ctx.isCancelled });
    if (!r) { return null; }
    best = pickBest(r.top);
    if (!best) {
      const top = r.top.length ? r.top[0].score.toFixed(2) : '0.00';
      throw new Error(`Nothing matched closely enough (best score ${top}, needs ${MIN_SCORE})`);
    }
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
    maxSeconds: DOWNLOAD_MAX_SECONDS,
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
    const ownedNow = ownedTrack({ hash: hashes.fileHash, audioHash: hashes.audioHash, libraryIds });
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
    // The account that asked may have been deleted while this ran: nothing
    // is filed for an account that is gone (its record could not be kept).
    if (!destinations.userForJob(ctx.userId)) { throw new Error('the account that asked for this download no longer exists'); }
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
      match: { score: best.score, url: best.entry.url, title: best.entry.title, channel: chosen.channel, durationSec: chosen.durationSec, chosen: !!choice },
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
  capabilities: [CAPABILITIES.ACQUIRE, CAPABILITIES.LOOKUP],
  scope: SCOPES.SERVER,
  // `binary` is deliberately not here: see probe().
  adminSettings: ['codec', 'maxFilesizeMb', 'searchResults'],
  concurrency: 1,
  probe,
  resolve,
  validateChoice,
  run,
});
