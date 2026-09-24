// "federation-copy" — "Add to your collection": copies a PAIRED peer's
// recommendation into a folder of the user's own library, as a job.
//
// Where it lands is the user's collection destination
// (src/discovery-plugins/destination.js; design cards 02 and 10): a library
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
// Access: the account must be allowed to upload (config.noUpload and the
// user's allow_upload — a copy is an upload by another road) and to start
// jobs (the jobs route's gate). The webapp hides the rows and the
// destination bar when either is false; the job refuses either way.

import path from 'node:path';
import fs from 'node:fs/promises';
import winston from 'winston';
import * as config from '../../state/config.js';
import * as fedDb from '../../db/federation.js';
import * as vpathUtil from '../../util/vpath.js';
import * as destinations from '../destination.js';
import { ownedTrack } from '../owned.js';
import { CAPABILITIES, SCOPES } from '../registry.js';
import { RECOMMENDATION_SOURCES } from '../recommendation.js';

export const NAME = 'federation-copy';

// Dial + headers only (fedFetchWithDeadline); the body streams for as long
// as the file takes.
const HEADER_DEADLINE_MS = 15_000;
const PROGRESS_EVERY_MS = 400;

function peerStatusError(status, peerName) {
  if (status === 429) { return new Error(`${peerName} has reached its transfer limit for this server — try again later`); }
  if (status === 404) { return new Error(`${peerName} no longer has this file`); }
  if (status === 401 || status === 403) { return new Error(`${peerName} refused this server's key`); }
  return new Error(`${peerName} answered http ${status}`);
}

async function copyBody(res, tmpPath, ctx, total) {
  const handle = await fs.open(tmpPath, 'w');
  let bytes = 0;
  let lastReport = 0;
  const mb = (n) => (n / (1024 * 1024)).toFixed(1);
  try {
    for await (const chunk of res.body) {
      if (ctx.isCancelled()) { throw Object.assign(new Error('cancelled'), { cancelled: true }); }
      await handle.write(chunk);
      bytes += chunk.length;
      const now = Date.now();
      if (now - lastReport >= PROGRESS_EVERY_MS) {
        lastReport = now;
        ctx.progress(total ? Math.min(0.95, (bytes / total) * 0.95) : 0.5,
          total ? `${mb(bytes)} of ${mb(total)} MB` : `${mb(bytes)} MB`);
      }
    }
  } finally {
    await handle.close();
  }
  return bytes;
}

async function run(ctx) {
  const rec = ctx.recommendation || {};
  if (rec.source !== RECOMMENDATION_SOURCES.FEDERATION || typeof rec.filepath !== 'string' || !rec.filepath.trim()
    || !rec.peer || rec.peer.id == null) {
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

  // 1. The peer's word on the file: its hash, for the pre-copy owned check.
  ctx.progress(0, `asking ${peer.name} about the file`);
  const { fedFetchWithDeadline } = await import('../../api/discovery-federation.js');
  const fedClient = await import('../../state/federation-client.js');
  let peerMeta = null;
  try {
    const r = await fedFetchWithDeadline(fedClient, peer, '/api/v1/db/metadata', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filepath: rec.filepath }),
    }, HEADER_DEADLINE_MS);
    if (r.ok) { peerMeta = ((await r.json()) || {}).metadata || null; }
  } catch (err) {
    throw new Error(`${peer.name} is unreachable (${err.message})`, { cause: err });
  }
  const owned = ownedTrack({
    hash: peerMeta && peerMeta.hash,
    artist: rec.artist || (peerMeta && peerMeta.artist), title: rec.title || (peerMeta && peerMeta.title),
    album: rec.album || (peerMeta && peerMeta.album),
  });
  if (owned) { return { skipped: 'owned', existing: owned, destination }; }

  // 2. The bytes, into a .part file inside the destination library.
  const baseInfo = vpathUtil.getVPathInfo(destination.base ? `${destination.vpath}/${destination.base}` : destination.vpath, user);
  await fs.mkdir(baseInfo.fullPath, { recursive: true });
  const tmpPath = path.join(baseInfo.fullPath, `.mstream-copy-${ctx.job.id}.part`);
  const remotePath = rec.filepath.split('/').filter((s) => s && s !== '.' && s !== '..').map(encodeURIComponent).join('/');
  const abort = new AbortController();
  let res;
  try {
    res = await fedFetchWithDeadline(fedClient, peer, `/media/${remotePath}`, { signal: abort.signal }, HEADER_DEADLINE_MS);
  } catch (err) {
    throw new Error(`${peer.name} is unreachable (${err.message})`, { cause: err });
  }
  if (!res.ok || !res.body) { throw peerStatusError(res.status, peer.name); }
  const total = Number(res.headers.get('content-length')) || null;
  let bytes;
  try {
    bytes = await copyBody(res, tmpPath, ctx, total);
  } catch (err) {
    abort.abort();
    await fs.unlink(tmpPath).catch(() => {});
    if (err.cancelled) { return null; }   // the runner records the cancel
    throw new Error(`copy from ${peer.name} failed: ${err.message}`, { cause: err });
  }

  // 3. Where it goes, from the file's own tags; never over an existing file.
  try {
    const { parseFile } = await import('music-metadata');
    let common = {};
    try { common = (await parseFile(tmpPath, { skipCovers: true })).common || {}; } catch (err) {
      winston.warn(`federation-copy: could not read tags from the copied file (${err.message}); using the recommendation's`);
    }
    const tags = destinations.tagsForLayout(common, rec);
    const fileName = destinations.safeFileName(rec.filepath);
    const target = destinations.renderTarget({ destination, tags, peerName: peer.name, fileName });
    const targetInfo = vpathUtil.getVPathInfo(`${destination.vpath}/${target.relPath}`, user);

    const audioHashLib = await import('../../db/audio-hash.js');
    const hashes = await audioHashLib.computeHashes(tmpPath);
    const ownedNow = ownedTrack({ hash: hashes.fileHash, audioHash: hashes.audioHash });
    if (ownedNow) {
      await fs.unlink(tmpPath);
      return { skipped: 'owned', existing: ownedNow, destination };
    }
    if (await fs.stat(targetInfo.fullPath).then(() => true, () => false)) {
      await fs.unlink(tmpPath);
      return { skipped: 'exists', filepath: `${destination.vpath}/${target.relPath}`, destination };
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
    winston.info(`federation-copy: copied '${rec.filepath}' from peer '${peer.name}' (id=${peer.id}) to ${destination.vpath}/${inserted.relativePath} (${bytes} bytes)`);
    return {
      copied: {
        vpath: destination.vpath, filepath: `${destination.vpath}/${inserted.relativePath}`,
        trackId: inserted.trackId, bytes, title: inserted.title, artist: inserted.artist, album: inserted.album,
      },
      missingVars: target.missingVars,
      peer: { id: peer.id, name: peer.name },
      destination,
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
  concurrency: 1,
  run,
});
