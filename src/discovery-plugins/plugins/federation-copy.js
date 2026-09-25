// "federation-copy" — "Add to your collection": copies a PAIRED peer's
// recommendation into a folder of the user's own library, as a job.
//
// Where it lands is the user's collection destination
// (src/discovery-plugins/destination.js): a library
// the user may upload to, a base folder, and a layout rendered from the
// song's tags ({{ARTIST}}/{{ALBUM}} by default, {{PEER}} = the server it
// came from). The file keeps the peer's name.
//
// How a copy runs (run(ctx), one at a time per server):
//   1. the peer's metadata for the file (its hash) — a song this library
//      already has, by hash or by artist + album + title, is skipped
//      before a byte moves;
//   2. the bytes, through the same /media route the stream proxy uses, so
//      the peer's key limits (bandwidth, daily quota, 429) apply exactly as
//      they do to playback, into a .part file inside the destination;
//   3. the file's own tags render the layout (per song — an album whose
//      tags agree lands in one folder); a second owned check by audio
//      hash, and an existing file at the target path is never overwritten;
//   4. the row is inserted the way a Youtube DL download is
//      (src/db/insert-downloaded-track.js, source = 'federation-copy'), so
//      the song plays at once.
// Cancel is polled between chunks; the .part file is removed.
//
// The album scope (a job started with scope: 'album'): the peer's own
// album-songs listing, then that copy song by song — the same owned skip,
// never-overwrite and per-song layout for each, in disc / track order — with
// the account of what happened to every song as the result. One song's own
// failure does not stop the album; the peer's transfer limit (a 429) or the
// peer going away does, and so does a cancel, whose finished songs stay
// (the runner keeps the partial result). Re-running an album copies only
// the gaps, since every song the library has is skipped.
//
// The artist scopes ('artist', 'artist-missing'): the peer's own listing of
// the artist's albums, then the album copy above for each album whose
// album artist IS the artist (a compilation or a collaboration the artist
// merely appears on is listed as skipped, never pulled whole for one
// track); 'artist-missing' also leaves out every album this library
// already has by the artist (src/discovery-plugins/owned.js
// ownedAlbumKeys, by normalised name). One job, album by album, so a cancel
// keeps the finished albums and songs.
//
// Access: the account must be allowed to upload (config.noUpload and the
// user's allow_upload — a copy is an upload by another road) and to start
// jobs (the jobs route's gate). The webapp hides the rows and the
// destination bar when either is false; the job refuses either way.
//
// The peer's side: every request this plug-in makes carries
// X-mStream-Purpose: copy, so a peer whose key for this server has copies
// switched off (V77 allow_copies; api/federation-limits.js) answers 403 on
// the file — the job fails with "does not allow copies", an album or artist
// run stops with `stopped: 'refused'`. Playback is never affected.

import path from 'node:path';
import fs from 'node:fs/promises';
import winston from 'winston';
import * as config from '../../state/config.js';
import * as fedDb from '../../db/federation.js';
import * as vpathUtil from '../../util/vpath.js';
import * as destinations from '../destination.js';
import * as downloadsDb from '../../db/plugin-downloads.js';
import { ownedTrack, ownedAlbumKeys, libraryIdsFor } from '../owned.js';
import { nameKey } from '../../db/name-key.js';
import { CAPABILITIES, SCOPES } from '../registry.js';
import { JOB_SCOPES, RECOMMENDATION_SOURCES } from '../recommendation.js';

export const NAME = 'federation-copy';

// Dial + headers only (fedFetchWithDeadline); the body streams for as long
// as the file takes.
const HEADER_DEADLINE_MS = 15_000;
const PROGRESS_EVERY_MS = 400;
// What this plug-in tells the peer it is doing (api/federation-limits.js
// reads it on the peer's side).
const COPY_HEADERS = Object.freeze({ 'X-mStream-Purpose': 'copy' });

// `peerLimit` / `peerDown` mark the failures that end an album copy: the
// rest of the songs would fail the same way.
function peerStatusError(status, peerName) {
  if (status === 429) { return Object.assign(new Error(`${peerName} has reached its transfer limit for this server — try again later`), { peerLimit: true }); }
  if (status === 404) { return new Error(`${peerName} no longer has this file`); }
  if (status === 401 || status === 403) { return Object.assign(new Error(`${peerName} refused this server's key`), { peerDown: true }); }
  return new Error(`${peerName} answered http ${status}`);
}

function peerUnreachable(peerName, err) {
  return Object.assign(new Error(`${peerName} is unreachable (${err.message})`), { peerDown: true, cause: err });
}

// The peer answers two different 429s on /media (api/federation-limits.js):
// "Too many concurrent streams" with a Retry-After of a few seconds — the
// key's stream cap, which this server's own playback from that peer
// shares — and "Daily transfer quota exceeded" with a Retry-After at
// midnight. The first is waited out and the song retried, up to
// STREAM_CAP_RETRIES times; the second, or a wait longer than
// RETRY_AFTER_MAX_S, is the transfer limit (`peerLimit`). Retries run out
// as `peerBusy` (stopped: 'busy'). Null when the job was cancelled while
// waiting.
const STREAM_CAP_RETRIES = 3;
const RETRY_AFTER_MAX_S = 60;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUnlessCancelled(ctx, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (ctx.isCancelled()) { return false; }
    await pause(Math.min(500, until - Date.now()));
  }
  return true;
}

export async function fetchMedia(env, ctx, route, signal) {
  const { peer, fedFetchWithDeadline, fedClient } = env;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fedFetchWithDeadline(fedClient, peer, route, { signal, headers: { ...COPY_HEADERS } }, HEADER_DEADLINE_MS);
    } catch (err) {
      throw peerUnreachable(peer.name, err);
    }
    if (res.status !== 429) { return res; }
    const retryAfter = Number(res.headers.get('retry-after'));
    let body;
    try { body = await res.json(); } catch (_e) { body = null; }
    const quota = /quota/i.test(String((body && body.error) || ''));
    const waitS = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;
    if (quota || waitS === null || waitS > RETRY_AFTER_MAX_S) { throw peerStatusError(429, peer.name); }
    if (attempt >= STREAM_CAP_RETRIES) {
      throw Object.assign(new Error(`${peer.name} is serving too many streams right now — try again in a moment`), { peerBusy: true });
    }
    winston.info(`federation-copy: ${peer.name} is at its stream cap — waiting ${waitS} s before asking again for ${route}`);
    if (!(await waitUnlessCancelled(ctx, waitS * 1000))) { return null; }
  }
}

// A refusal on the file itself: a 403 whose body says copies are switched
// off for this server's key (`copiesOff`, which ends an album with
// stopped: 'refused'), else the status as peerStatusError reads it.
async function peerRefusal(res, peerName) {
  if (res.status === 403) {
    let body;
    try { body = await res.json(); } catch (_e) { body = null; }
    if (body && /copies are not allowed/i.test(String(body.error || ''))) {
      return Object.assign(new Error(`${peerName} does not allow copies with this server's key`), { peerDown: true, copiesOff: true });
    }
  }
  return peerStatusError(res.status, peerName);
}

// ── The album loop's accounting (pure; unit-tested with a scripted copyOne) ──
// Runs `songs` one by one through `copyOne(song, { progress })`, which
// answers { copied, missingVars } | { skipped: 'owned', existing } |
// { skipped: 'exists', filepath } | null (cancelled mid-song), or throws.
// Keeps going past one song's own failure; stops for a cancel, for the
// peer's transfer limit (`peerLimit`) and for the peer going away
// (`peerDown`). Progress reads "4 of 11 songs · 38.2 MB".
export async function copySongs(songs, { copyOne, isCancelled = () => false, progress = () => {} }) {
  const list = Array.isArray(songs) ? songs : [];
  const out = { total: list.length, copied: [], skipped: [], failed: [] };
  const missing = new Set();
  let bytes = 0;
  let stopped = null;
  const mb = (n) => (n / (1024 * 1024)).toFixed(1);
  const done = () => out.copied.length + out.skipped.length + out.failed.length;
  const line = (extra) => `${done()} of ${out.total} songs · ${mb(bytes)} MB${extra ? ` · ${extra}` : ''}`;
  const fraction = (f) => Math.min(0.97, (done() + Math.max(0, Math.min(1, f))) / Math.max(1, out.total));
  for (const song of list) {
    if (isCancelled()) { stopped = 'cancelled'; break; }
    progress(fraction(0), line());
    let r;
    try {
      r = await copyOne(song, { progress: (f, text) => progress(fraction(Number.isFinite(f) ? f : 0), line(text)) });
    } catch (err) {
      out.failed.push({ from: song.filepath, error: err && err.message ? err.message : String(err) });
      if (err && err.peerLimit) { stopped = 'quota'; break; }
      if (err && err.peerBusy) { stopped = 'busy'; break; }
      if (err && err.copiesOff) { stopped = 'refused'; break; }
      if (err && err.peerDown) { stopped = 'peer'; break; }
      continue;
    }
    if (r === null) { stopped = 'cancelled'; break; }   // cancelled mid-song; its .part is gone
    if (r.copied) {
      out.copied.push({ from: song.filepath, ...r.copied });
      bytes += Number(r.copied.bytes) || 0;
      for (const v of (r.missingVars || [])) { missing.add(v); }
    } else if (r.skipped === 'owned') {
      out.skipped.push({ from: song.filepath, why: 'owned', at: (r.existing && r.existing.filepath) || null });
    } else if (r.skipped === 'exists') {
      out.skipped.push({ from: song.filepath, why: 'exists', at: r.filepath || null });
    } else {
      out.failed.push({ from: song.filepath, error: 'the copy answered nothing' });
    }
  }
  progress(Math.min(0.99, done() / Math.max(1, out.total)), line());
  return { songs: out, bytes, stopped, missingVars: [...missing] };
}

// How much one copy may be, and how long a peer may go quiet mid-body. A
// length the peer declares is the cap for that file (undici holds it to
// its word); a body with no declared length gets MAX_COPY_BYTES, so a peer
// that streams for ever cannot fill the library's disk. A chunk that does
// not arrive within IDLE_CHUNK_MS ends the copy — a cancel is polled
// between chunks, so a stalled peer would otherwise hold the job.
export const MAX_COPY_BYTES = 2 * 1024 * 1024 * 1024;
export const IDLE_CHUNK_MS = 60_000;

function nextWithin(iterator, ms) {
  let timer;
  return Promise.race([
    iterator.next(),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`no data for ${Math.round(ms / 1000)} s`), { stalled: true })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// The bytes of `res.body` (any async iterable of chunks) into tmpPath.
// Exported for the unit tests; the plug-in calls it from copyOne.
export async function copyBody(res, tmpPath, ctx, total, { maxBytes = MAX_COPY_BYTES, idleMs = IDLE_CHUNK_MS } = {}) {
  const handle = await fs.open(tmpPath, 'w');
  const cap = total && total <= maxBytes ? total : maxBytes;
  let bytes = 0;
  let lastReport = 0;
  const mb = (n) => (n / (1024 * 1024)).toFixed(1);
  const iterator = res.body[Symbol.asyncIterator]();
  try {
    for (;;) {
      const { done, value: chunk } = await nextWithin(iterator, idleMs);
      if (done) { break; }
      if (ctx.isCancelled()) { throw Object.assign(new Error('cancelled'), { cancelled: true }); }
      bytes += chunk.length;
      if (bytes > cap) {
        throw new Error(total && total <= maxBytes
          ? `the peer sent more than the ${mb(total)} MB it declared`
          : `the file is larger than the ${mb(maxBytes)} MB a copy may be`);
      }
      await handle.write(chunk);
      const now = Date.now();
      if (now - lastReport >= PROGRESS_EVERY_MS) {
        lastReport = now;
        ctx.progress(total ? Math.min(0.95, (bytes / total) * 0.95) : 0.5,
          total ? `${mb(bytes)} of ${mb(total)} MB` : `${mb(bytes)} MB`);
      }
    }
  } catch (err) {
    // Let the source go — without waiting on it: a stalled iterator settles
    // its return() only once its pending read does (the caller's abort()
    // sees to that for a real response).
    if (typeof iterator.return === 'function') { try { iterator.return().catch(() => {}); } catch (_e) { /* already done */ } }
    throw err;
  } finally {
    await handle.close();
  }
  return bytes;
}

async function run(ctx) {
  const rec = ctx.recommendation || {};
  const scope = (ctx.params && ctx.params.scope) || JOB_SCOPES.SONG;
  if (!Object.values(JOB_SCOPES).includes(scope)) { throw new Error(`federation-copy has no "${scope}" scope`); }
  const has = (v) => typeof v === 'string' && v.trim().length > 0;
  const artistScope = scope === JOB_SCOPES.ARTIST || scope === JOB_SCOPES.ARTIST_MISSING;
  if (rec.source !== RECOMMENDATION_SOURCES.FEDERATION || !rec.peer || rec.peer.id == null
    || (scope === JOB_SCOPES.SONG && !has(rec.filepath)) || (scope === JOB_SCOPES.ALBUM && !has(rec.album)) || (artistScope && !has(rec.artist))) {
    throw new Error('only a paired peer\'s recommendation can be copied');
  }
  if (!(config.program && config.program.federation && config.program.federation.enabled === true)) {
    throw new Error('federation is disabled on this server');
  }
  const peer = fedDb.getFederationPeerById(Number(rec.peer.id));
  if (!peer) { throw new Error('this server is no longer paired with that peer'); }

  const user = destinations.userForJob(ctx.userId);
  if (!user) { throw new Error('the account that asked for this copy no longer exists'); }
  if (!destinations.uploadsAllowed(user)) { throw new Error('uploads are disabled for this account, and a copy is an upload'); }
  const destination = destinations.getDestination(user);
  if (!destination) { throw new Error('no library to copy into'); }

  const { fedFetchWithDeadline } = await import('../../api/discovery-federation.js');
  const fedClient = await import('../../state/federation-client.js');
  // The owned checks look only into the libraries this user may see.
  const env = { peer, user, destination, fedFetchWithDeadline, fedClient, libraryIds: libraryIdsFor(user) };

  if (scope === JOB_SCOPES.ALBUM) { return copyAlbum(ctx, env, rec); }
  if (artistScope) { return copyArtist(ctx, env, rec, { onlyMissing: scope === JOB_SCOPES.ARTIST_MISSING }); }

  const r = await copyOne(ctx, env, { filepath: rec.filepath, title: rec.title, artist: rec.artist, album: rec.album });
  if (r === null) { return null; }   // the runner records the cancel
  if (r.skipped) { return { ...r, destination }; }
  return { copied: r.copied, missingVars: r.missingVars, peer: { id: peer.id, name: peer.name }, destination };
}

// One read of the peer's API, as JSON; a refusal or a dead peer is marked
// (peerStatusError / peerUnreachable) so the loops know whether to stop.
async function peerJson(env, route, body) {
  let r;
  try {
    r = await env.fedFetchWithDeadline(env.fedClient, env.peer, route, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...COPY_HEADERS }, body: JSON.stringify(body),
    }, HEADER_DEADLINE_MS);
  } catch (err) {
    throw peerUnreachable(env.peer.name, err);
  }
  if (!r.ok) { throw peerStatusError(r.status, env.peer.name); }
  return r.json();
}

// The peer's songs of one album, as copyOne takes them. `artist` narrows to
// the track artist (the modal's album view's narrowing); `albumArtist` to
// one album credit (the artist loop's, so a feature on the album still
// comes along).
async function listAlbumSongs(env, { album, artist = null, albumArtist = null, year = null, fallbackArtist = null }) {
  const body = { album, artist: artist || null, year: year || null };
  if (albumArtist) { body.album_artist = albumArtist; }
  const listing = await peerJson(env, '/api/v1/db/album-songs', body);
  return (Array.isArray(listing) ? listing : [])
    .filter((s) => s && typeof s.filepath === 'string' && s.filepath.trim())
    .map((s) => {
      const md = (s.metadata && typeof s.metadata === 'object') ? s.metadata : {};
      return { filepath: s.filepath, title: md.title || null, artist: md.artist || fallbackArtist || null, album: md.album || album };
    });
}

// The album: the peer's own listing of its songs, then copyOne for each
// (copySongs keeps the account). `rec` names the album (and the artist,
// which narrows the listing the way the modal's album view narrows it).
async function copyAlbum(ctx, env, rec) {
  const { peer, destination } = env;
  ctx.progress(0, `asking ${peer.name} for “${rec.album}”`);
  const songs = await listAlbumSongs(env, { album: rec.album, artist: rec.artist || null, year: rec.year || null, fallbackArtist: rec.artist || null });
  if (songs.length === 0) { throw new Error(`${peer.name} has no songs for “${rec.album}”`); }

  const outcome = await copySongs(songs, {
    isCancelled: ctx.isCancelled,
    progress: ctx.progress,
    copyOne: (song, { progress }) => copyOne({ job: ctx.job, userId: ctx.userId, isCancelled: ctx.isCancelled, progress }, env, song),
  });
  const { copied, skipped, failed } = outcome.songs;
  winston.info(`federation-copy: album “${rec.album}” from peer '${peer.name}': ${copied.length} copied, ${skipped.length} skipped, ${failed.length} failed${outcome.stopped ? ` — stopped: ${outcome.stopped}` : ''}`);
  return {
    scope: JOB_SCOPES.ALBUM,
    album: { name: rec.album, artist: rec.artist || null, year: rec.year || null },
    songs: outcome.songs,
    bytes: outcome.bytes,
    stopped: outcome.stopped,
    missingVars: outcome.missingVars,
    peer: { id: peer.id, name: peer.name },
    destination,
  };
}

// ── The artist's albums (pure; unit-tested) ──────────────────────────────
// Which of the peer's albums by an artist a job copies: the ones whose album
// artist IS the artist (its primary album artist, or one of its credits
// outside a compilation). An album the artist merely appears on is listed
// as skipped ('appearance'); with `onlyMissing`, so is one this library
// already has (`localKeys`, ownedAlbumKeys). The singles bucket (no album
// name) is not an album.
export function planArtistAlbums(listing, artist, { localKeys = new Set(), onlyMissing = false } = {}) {
  const key = nameKey(artist);
  const rows = Array.isArray(listing && listing.albums) ? listing.albums : [];
  const plan = [];
  const skipped = [];
  for (const al of rows) {
    if (!al || typeof al.name !== 'string' || !al.name.trim()) { continue; }
    const year = al.year == null || !Number.isFinite(Number(al.year)) ? null : Number(al.year);
    const entry = { name: al.name, year, trackCount: Number.isFinite(Number(al.track_count)) && al.track_count !== null ? Number(al.track_count) : null };
    const credited = Array.isArray(al.artists) && al.artists.some((n) => nameKey(n) === key);
    const theirs = nameKey(al.album_artist) === key || (credited && al.compilation !== true);
    if (!theirs) { skipped.push({ ...entry, why: 'appearance' }); continue; }
    if (onlyMissing && localKeys.has(nameKey(al.name))) { skipped.push({ ...entry, why: 'owned' }); continue; }
    plan.push(entry);
  }
  return { plan, skipped };
}

// The artist loop's accounting (pure; unit-tested with a scripted
// copyAlbum). Runs `albums` one by one through `copyAlbum(album, { progress })`,
// which answers copySongs' shape ({ songs, bytes, stopped, missingVars }) or
// throws for a listing that failed — `peerLimit` / `peerDown` end the run,
// anything else marks the album and goes on. An album that stopped stops
// the run the same way; a cancel between albums does too. The songs of
// every album are gathered, each with its album's name, so a window can
// count them the way it counts an album's. Progress reads
// "album 2 of 5 · Night Ferry · 3 of 11 songs · 38.2 MB".
export async function copyAlbums(albums, { copyAlbum, isCancelled = () => false, progress = () => {} }) {
  const list = Array.isArray(albums) ? albums : [];
  const out = { albums: [], songs: { total: 0, copied: [], skipped: [], failed: [] }, bytes: 0, stopped: null, missingVars: [] };
  const missing = new Set();
  const empty = () => ({ total: 0, copied: [], skipped: [], failed: [] });
  for (let i = 0; i < list.length; i++) {
    const al = list[i];
    if (isCancelled()) { out.stopped = 'cancelled'; break; }
    const head = `album ${i + 1} of ${list.length} · ${al.name}`;
    const map = (f, text) => progress(Math.min(0.97, (i + Math.max(0, Math.min(1, Number.isFinite(f) ? f : 0))) / Math.max(1, list.length)), text ? `${head} · ${text}` : head);
    map(0);
    let r;
    try {
      r = await copyAlbum(al, { progress: map });
    } catch (err) {
      out.albums.push({ name: al.name, year: al.year == null ? null : al.year, error: err && err.message ? err.message : String(err), songs: empty(), bytes: 0, stopped: null });
      if (err && err.peerLimit) { out.stopped = 'quota'; break; }
      if (err && err.peerBusy) { out.stopped = 'busy'; break; }
      if (err && err.copiesOff) { out.stopped = 'refused'; break; }
      if (err && err.peerDown) { out.stopped = 'peer'; break; }
      continue;
    }
    out.albums.push({ name: al.name, year: al.year == null ? null : al.year, songs: r.songs, bytes: r.bytes, stopped: r.stopped || null });
    out.songs.total += r.songs.total;
    for (const k of ['copied', 'skipped', 'failed']) { for (const s of r.songs[k]) { out.songs[k].push({ album: al.name, ...s }); } }
    out.bytes += Number(r.bytes) || 0;
    for (const v of (r.missingVars || [])) { missing.add(v); }
    if (r.stopped) { out.stopped = r.stopped; break; }
  }
  const mb = (n) => (n / (1024 * 1024)).toFixed(1);
  progress(Math.min(0.99, out.albums.length / Math.max(1, list.length)), `${out.albums.length} of ${list.length} albums · ${out.songs.copied.length} songs copied · ${mb(out.bytes)} MB`);
  out.missingVars = [...missing];
  return out;
}

// The artist: the peer's listing of the artist's albums, the plan
// (planArtistAlbums — the artist's own albums, minus what this library has
// for 'artist-missing'), then the album copy for each (copyAlbums keeps
// the account).
async function copyArtist(ctx, env, rec, { onlyMissing }) {
  const { peer, destination } = env;
  ctx.progress(0, `asking ${peer.name} for ${rec.artist}'s albums`);
  const listing = await peerJson(env, '/api/v1/db/artists-albums', { artist: rec.artist });
  const localKeys = onlyMissing ? ownedAlbumKeys(rec.artist, { libraryIds: env.libraryIds }) : new Set();
  const { plan, skipped } = planArtistAlbums(listing, rec.artist, { localKeys, onlyMissing });
  if (plan.length === 0 && skipped.length === 0) { throw new Error(`${peer.name} lists no albums for “${rec.artist}”`); }

  const outcome = await copyAlbums(plan, {
    isCancelled: ctx.isCancelled,
    progress: ctx.progress,
    copyAlbum: async (al, { progress }) => {
      const songs = await listAlbumSongs(env, { album: al.name, albumArtist: rec.artist, year: al.year, fallbackArtist: rec.artist });
      return copySongs(songs, {
        isCancelled: ctx.isCancelled,
        progress,
        copyOne: (song, { progress: p }) => copyOne({ job: ctx.job, userId: ctx.userId, isCancelled: ctx.isCancelled, progress: p }, env, song),
      });
    },
  });
  const { copied, skipped: skippedSongs, failed } = outcome.songs;
  winston.info(`federation-copy: ${onlyMissing ? 'what is missing of' : 'every album of'} “${rec.artist}” from peer '${peer.name}': ${outcome.albums.length} album(s), ${copied.length} copied, ${skippedSongs.length} skipped, ${failed.length} failed; ${skipped.length} album(s) left out${outcome.stopped ? ` — stopped: ${outcome.stopped}` : ''}`);
  return {
    scope: onlyMissing ? JOB_SCOPES.ARTIST_MISSING : JOB_SCOPES.ARTIST,
    artist: { name: rec.artist },
    albums: outcome.albums,
    skippedAlbums: skipped,
    songs: outcome.songs,
    bytes: outcome.bytes,
    stopped: outcome.stopped,
    missingVars: outcome.missingVars,
    peer: { id: peer.id, name: peer.name },
    destination,
  };
}

// One song, start to finish: the peer's word on it (its hash, for the
// pre-copy owned check), the bytes into a .part file, the layout from the
// file's own tags, the second owned check, never over an existing file, the
// row. `ctx` is the job's (or, inside an album, a per-song view of it with
// the progress mapped). Answers { copied, missingVars } |
// { skipped: 'owned', existing } | { skipped: 'exists', filepath } | null
// (cancelled — the .part is gone); throws with `peerLimit` / `peerDown` for
// the failures that end an album.
export async function copyOne(ctx, env, song) {
  const { peer, user, destination, fedFetchWithDeadline, fedClient } = env;

  // 1. The peer's word on the file: its hash, for the pre-copy owned check.
  ctx.progress(0, `asking ${peer.name} about the file`);
  let peerMeta = null;
  try {
    const r = await fedFetchWithDeadline(fedClient, peer, '/api/v1/db/metadata', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...COPY_HEADERS }, body: JSON.stringify({ filepath: song.filepath }),
    }, HEADER_DEADLINE_MS);
    if (r.ok) { peerMeta = ((await r.json()) || {}).metadata || null; }
  } catch (err) {
    throw peerUnreachable(peer.name, err);
  }
  const owned = ownedTrack({
    hash: peerMeta && peerMeta.hash,
    artist: song.artist || (peerMeta && peerMeta.artist), title: song.title || (peerMeta && peerMeta.title),
    album: song.album || (peerMeta && peerMeta.album),
    // What tells two same-titled tracks of one album apart.
    track: peerMeta && peerMeta.track, disk: peerMeta && peerMeta.disk, duration: peerMeta && peerMeta.duration,
    libraryIds: env.libraryIds,
  });
  if (owned) { return { skipped: 'owned', existing: owned }; }

  // The name the file keeps — and only audio goes into a library: a peer's
  // listing names what the peer chose to, and a page or a playlist filed
  // among the songs would be served from this origin and read by the
  // scanner. Refused before a byte moves.
  const fileName = destinations.safeFileName(song.filepath);
  if (!destinations.isSupportedAudioFile(fileName)) {
    throw new Error(`${peer.name} lists '${fileName}' as a song, but it is not an audio file this server plays`);
  }

  // 2. The bytes, into a .part file inside the destination library.
  const baseInfo = vpathUtil.getVPathInfo(destination.base ? `${destination.vpath}/${destination.base}` : destination.vpath, user);
  await fs.mkdir(baseInfo.fullPath, { recursive: true });
  const tmpPath = path.join(baseInfo.fullPath, `.mstream-copy-${ctx.job.id}.part`);
  const remotePath = song.filepath.split('/').filter((s) => s && s !== '.' && s !== '..').map(encodeURIComponent).join('/');
  const abort = new AbortController();
  const res = await fetchMedia(env, ctx, `/media/${remotePath}`, abort.signal);
  if (res === null) { return null; }   // cancelled while waiting out the peer's stream cap
  if (!res.ok || !res.body) { throw await peerRefusal(res, peer.name); }
  const total = Number(res.headers.get('content-length')) || null;
  // env.maxCopyBytes / env.idleChunkMs: the tests' overrides of the limits.
  const maxBytes = Number.isFinite(env.maxCopyBytes) && env.maxCopyBytes > 0 ? env.maxCopyBytes : MAX_COPY_BYTES;
  if (total && total > maxBytes) {
    abort.abort();
    throw new Error(`${peer.name} says the file is ${(total / (1024 * 1024)).toFixed(0)} MB, more than the ${(maxBytes / (1024 * 1024)).toFixed(0)} MB a copy may be`);
  }
  let bytes;
  try {
    bytes = await copyBody(res, tmpPath, ctx, total, { maxBytes, idleMs: Number.isFinite(env.idleChunkMs) && env.idleChunkMs > 0 ? env.idleChunkMs : IDLE_CHUNK_MS });
  } catch (err) {
    abort.abort();
    await fs.unlink(tmpPath).catch(() => {});
    if (err.cancelled) { return null; }
    throw new Error(`copy from ${peer.name} failed: ${err.message}`, { cause: err });
  }

  // 3. Where it goes, from the file's own tags; never over an existing file.
  try {
    const { parseFile } = await import('music-metadata');
    let common = {};
    try { common = (await parseFile(tmpPath, { skipCovers: true })).common || {}; } catch (err) {
      winston.warn(`federation-copy: could not read tags from the copied file (${err.message}); using the recommendation's`);
    }
    const tags = destinations.tagsForLayout(common, song);
    const target = destinations.renderTarget({ destination, tags, peerName: peer.name, fileName });
    const targetInfo = vpathUtil.getVPathInfo(`${destination.vpath}/${target.relPath}`, user);

    const audioHashLib = await import('../../db/audio-hash.js');
    const hashes = await audioHashLib.computeHashes(tmpPath);
    const ownedNow = ownedTrack({ hash: hashes.fileHash, audioHash: hashes.audioHash, libraryIds: env.libraryIds });
    if (ownedNow) {
      await fs.unlink(tmpPath);
      return { skipped: 'owned', existing: ownedNow };
    }
    if (await fs.stat(targetInfo.fullPath).then(() => true, () => false)) {
      await fs.unlink(tmpPath);
      return { skipped: 'exists', filepath: `${destination.vpath}/${target.relPath}` };
    }
    await fs.mkdir(path.dirname(targetInfo.fullPath), { recursive: true });
    await fs.rename(tmpPath, targetInfo.fullPath);

    // 4. A row, so it plays at once.
    ctx.progress(0.97, 'adding to your library');
    const { insertDownloadedTrack } = await import('../../db/insert-downloaded-track.js');
    const inserted = await insertDownloadedTrack({
      filePath: targetInfo.fullPath, vpath: destination.vpath, basePath: targetInfo.basePath,
      source: NAME, log: 'federation-copy',
    });
    // The record of what this plug-in brought in (src/db/plugin-downloads.js).
    const recorded = downloadsDb.recordQuietly({
      plugin: NAME, userId: ctx.userId, jobId: ctx.job.id, vpath: destination.vpath, relativePath: inserted.relativePath,
      fileHash: inserted.hash, origin: peer.name, title: inserted.title, artist: inserted.artist, album: inserted.album, bytes,
    });
    winston.info(`federation-copy: copied '${song.filepath}' from peer '${peer.name}' (id=${peer.id}) to ${destination.vpath}/${inserted.relativePath} (${bytes} bytes)`);
    return {
      copied: {
        vpath: destination.vpath, filepath: `${destination.vpath}/${inserted.relativePath}`,
        trackId: inserted.trackId, bytes, title: inserted.title, artist: inserted.artist, album: inserted.album,
        downloadId: recorded ? recorded.id : null,
      },
      missingVars: target.missingVars,
    };
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

export default Object.freeze({
  name: NAME,
  title: 'Add to your collection',
  description: 'Copies a paired server\'s song into the user\'s own library folder (their collection destination) and adds it to the library at once. Needs upload rights; never overwrites; skips songs they already have.',
  capabilities: [CAPABILITIES.ACQUIRE],
  scope: SCOPES.USER,
  // A song, its whole album, every album of its artist, or only the artist's
  // albums this library lacks (song by song, the same rules for each).
  scopes: [JOB_SCOPES.SONG, JOB_SCOPES.ALBUM, JOB_SCOPES.ARTIST, JOB_SCOPES.ARTIST_MISSING],
  concurrency: 1,
  run,
});
