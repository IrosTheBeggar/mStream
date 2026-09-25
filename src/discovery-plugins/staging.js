// The staging folder a download is assembled in before it enters a library.
//
// yt-dlp writes several files while it works — format fragments, the
// thumbnail it fetches for --embed-thumbnail (before the media), a .part
// file — and a run that fails or is cancelled leaves whichever it had
// reached. None of that may touch a library folder: a stray thumbnail
// becomes folder art at the next scan, a stray .part a "song". So a job gets
// a folder of its own under discoveryJobs.stagingDir, moves the one finished
// file out, and the folder goes whole. A folder a crash left behind goes at
// the next retention pass once nothing has written to it for a day; a job
// that re-runs after the crash clears its own first.

import path from 'node:path';
import fs from 'node:fs/promises';
import winston from 'winston';
import * as config from '../state/config.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PREFIX = 'job-';

export function stagingRoot() {
  const c = config.program && config.program.discoveryJobs;
  return (c && c.stagingDir) || null;
}

// Where one job's folder is (or would be), without touching the disk.
export function jobStagingPath(jobId) {
  const root = stagingRoot();
  return root ? path.join(root, `${PREFIX}${jobId}`) : null;
}

// A folder for one job, made (or made again) empty.
export async function jobStagingDir(jobId) {
  const root = stagingRoot();
  if (!root) { throw new Error('discoveryJobs.stagingDir is not configured'); }
  const dir = path.join(root, `${PREFIX}${jobId}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// A fresh folder for a download that is not a job (the Youtube DL route),
// under the same root and the same `job-` prefix, so the retention pass
// clears one a crash left behind exactly as it clears a job's. The name is
// unique per call.
export async function scratchStagingDir(label) {
  const root = stagingRoot();
  if (!root) { throw new Error('discoveryJobs.stagingDir is not configured'); }
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, `${PREFIX}${label}-`));
}

export async function discardStaging(dir) {
  if (!dir) { return; }
  await fs.rm(dir, { recursive: true, force: true })
    .catch((err) => winston.warn(`discovery staging: could not remove ${dir} (${err.code || err.message})`));
}

// A finished file out of staging into its library path: a rename where the
// two share a drive, a copy and an unlink otherwise.
export async function moveIntoPlace(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true });
  try {
    await fs.rename(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') { throw err; }
    await fs.copyFile(from, to);
    await fs.unlink(from).catch((e) => winston.warn(`discovery staging: moved ${from} but could not remove the original: ${e.message}`));
  }
}

async function newestMtime(dir) {
  let stat;
  try { stat = await fs.stat(dir); } catch (_e) { return 0; }
  let newest = stat.mtimeMs;
  let names;
  try { names = await fs.readdir(dir); } catch (_e) { return newest; }
  for (const name of names) {
    try { newest = Math.max(newest, (await fs.stat(path.join(dir, name))).mtimeMs); } catch (_e) { /* went away under us */ }
  }
  return newest;
}

// The folders no job is writing any more: nothing in them newer than
// `olderThanMs`. Returns how many went; one that cannot be removed is left
// for the next pass.
export async function removeStale({ now = Date.now(), olderThanMs = DAY_MS } = {}) {
  const root = stagingRoot();
  if (!root) { return 0; }
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch (err) {
    if (err.code !== 'ENOENT') { winston.warn(`discovery staging: cannot read ${root}: ${err.message}`); }
    return 0;
  }
  let n = 0;
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(PREFIX)) { continue; }
    const dir = path.join(root, e.name);
    if (await newestMtime(dir) >= now - olderThanMs) { continue; }
    try {
      await fs.rm(dir, { recursive: true, force: true });
      n += 1;
    } catch (err) {
      winston.warn(`discovery staging: could not remove ${dir} (${err.code || err.message}); the next pass retries`);
    }
  }
  return n;
}
