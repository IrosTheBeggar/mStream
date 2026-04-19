// Desktop Player sync engine — runs in the Electron main process.
// Flow: fetch /api/v1/offline/snapshot → enumerate user's vpaths →
// download each media file that's missing or size-mismatched.
// Progress is pushed out via the onProgress callback.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

let state = {
  state: 'idle',
  current: 0,
  total: 0,
  currentFile: null,
  lastError: null,
  startedAt: null,
};

let abortController = null;
let progressCb = null;

function emit() {
  if (progressCb) {
    try { progressCb({ ...state }); } catch { /* ignore listener errors */ }
  }
}

function getStatus() {
  return { ...state };
}

// Downloads `url` to `destPath`. If `expectedMd5` is provided, the stream is
// hashed inline (zero extra IO) and a mismatch fails the download.
// The mStream server stores MD5 of the raw file (lowercase hex) in
// tracks.file_hash — see rust-parser/src/main.rs calculate_hash().
async function downloadToFile(url, headers, destPath, signal, expectedMd5) {
  const res = await fetch(url, { headers, signal });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url}`);
  }
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const tmp = destPath + '.part';
  const out = fs.createWriteStream(tmp);
  const hasher = expectedMd5 ? crypto.createHash('md5') : null;
  try {
    for await (const chunk of res.body) {
      if (hasher) { hasher.update(chunk); }
      if (!out.write(chunk)) {
        await new Promise(r => out.once('drain', r));
      }
    }
    await new Promise((resolve, reject) => out.end(err => err ? reject(err) : resolve()));
    if (hasher) {
      const got = hasher.digest('hex');
      if (got !== expectedMd5.toLowerCase()) {
        try { await fsp.unlink(tmp); } catch { /* best effort */ }
        throw new Error(`hash mismatch (expected ${expectedMd5}, got ${got})`);
      }
    }
    await fsp.rename(tmp, destPath);
  } catch (err) {
    out.destroy();
    try { await fsp.unlink(tmp); } catch { /* best effort */ }
    throw err;
  }
}

async function start({ serverUrl, token, localFolder, vpaths, onProgress, snapshotOnly }) {
  if (state.state === 'running') {
    throw new Error('Sync already running');
  }
  if (!serverUrl) { throw new Error('serverUrl required'); }
  if (!token) { throw new Error('token required'); }
  if (!localFolder) { throw new Error('localFolder required'); }
  // In snapshotOnly mode we don't enumerate tracks, so vpaths may be empty.
  if (!snapshotOnly && (!Array.isArray(vpaths) || vpaths.length === 0)) {
    throw new Error('at least one vpath required');
  }

  // Webapp stores host with a trailing slash ("http://host:3000/"); normalize
  // so our URL concatenation doesn't produce double slashes.
  const base = serverUrl.replace(/\/+$/, '');

  progressCb = onProgress || null;
  abortController = new AbortController();
  const signal = abortController.signal;
  const headers = { 'x-access-token': token };

  state = {
    state: 'running',
    current: 0,
    total: 0,
    currentFile: '(library snapshot)',
    lastError: null,
    startedAt: new Date().toISOString(),
  };
  emit();

  try {
    const syncDir = path.join(localFolder, '.mstream-sync');
    await fsp.mkdir(syncDir, { recursive: true });

    const snapshotPath = path.join(syncDir, 'library.db');
    const snapshotTmp = snapshotPath + '.tmp';
    await downloadToFile(`${base}/api/v1/offline/snapshot`, headers, snapshotTmp, signal);
    await fsp.rename(snapshotTmp, snapshotPath);

    if (snapshotOnly) {
      state.currentFile = null;
      state.state = signal.aborted ? 'cancelled' : 'idle';
      emit();
      return;
    }

    const db = new DatabaseSync(snapshotPath);
    const placeholders = vpaths.map(() => '?').join(',');
    const tracks = db.prepare(`
      SELECT vpath, relative_path, file_size
      FROM tracks
      WHERE vpath IN (${placeholders})
      ORDER BY vpath, relative_path
    `).all(...vpaths);
    db.close();

    state.total = tracks.length;
    state.currentFile = null;
    emit();

    for (const track of tracks) {
      if (signal.aborted) { break; }

      const localPath = path.join(localFolder, track.vpath, track.relative_path);

      let needsDownload = true;
      try {
        const stat = await fsp.stat(localPath);
        if (track.file_size != null && stat.size === track.file_size) {
          needsDownload = false;
        }
      } catch { /* not present */ }

      if (!needsDownload) {
        state.current += 1;
        emit();
        continue;
      }

      state.currentFile = path.posix.join(track.vpath, track.relative_path.replace(/\\/g, '/'));
      emit();

      try {
        const url = base +
          '/media/' + encodeURIComponent(track.vpath) + '/' +
          track.relative_path.split('/').map(encodeURIComponent).join('/');
        await downloadToFile(url, headers, localPath, signal, track.file_hash);
      } catch (err) {
        if (signal.aborted) { break; }
        state.lastError = `${state.currentFile}: ${err.message}`;
      }

      state.current += 1;
      emit();
    }

    state.currentFile = null;
    state.state = signal.aborted ? 'cancelled' : 'idle';
    emit();
  } catch (err) {
    state.state = signal?.aborted ? 'cancelled' : 'error';
    state.lastError = err.message;
    state.currentFile = null;
    emit();
  } finally {
    abortController = null;
  }
}

function stop() {
  if (abortController) { abortController.abort(); }
}

// Sync a caller-provided list of files into the local folder. Used by the
// Desktop Player's "basic-manual" mode when the user clicks a download link:
// instead of streaming to the browser, we save the file to the configured
// sync folder so it's available offline.
//
// files: Array<{ vpath, relPath }>
async function syncFiles({ serverUrl, token, localFolder, files, onProgress }) {
  if (state.state === 'running') {
    throw new Error('Sync already running');
  }
  if (!serverUrl) { throw new Error('serverUrl required'); }
  if (!token) { throw new Error('token required'); }
  if (!localFolder) { throw new Error('localFolder required'); }
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('files required');
  }

  const base = serverUrl.replace(/\/+$/, '');
  progressCb = onProgress || null;
  abortController = new AbortController();
  const signal = abortController.signal;
  const headers = { 'x-access-token': token };

  state = {
    state: 'running',
    current: 0,
    total: files.length,
    currentFile: null,
    lastError: null,
    startedAt: new Date().toISOString(),
  };
  emit();

  try {
    for (const f of files) {
      if (signal.aborted) { break; }
      if (!f || !f.vpath || !f.relPath) {
        state.current += 1;
        state.lastError = 'skipped invalid entry';
        emit();
        continue;
      }

      const localPath = path.join(localFolder, f.vpath, f.relPath);

      // Existence check only — no hash available at this entry point.
      let already = false;
      try { await fsp.access(localPath); already = true; } catch { /* missing */ }

      if (already) {
        state.current += 1;
        emit();
        continue;
      }

      state.currentFile = path.posix.join(f.vpath, f.relPath.replace(/\\/g, '/'));
      emit();

      try {
        const url = base +
          '/media/' + encodeURIComponent(f.vpath) + '/' +
          f.relPath.split('/').map(encodeURIComponent).join('/');
        await downloadToFile(url, headers, localPath, signal);
      } catch (err) {
        if (signal.aborted) { break; }
        state.lastError = `${state.currentFile}: ${err.message}`;
      }

      state.current += 1;
      emit();
    }

    state.currentFile = null;
    state.state = signal.aborted ? 'cancelled' : 'idle';
    emit();
  } catch (err) {
    state.state = signal?.aborted ? 'cancelled' : 'error';
    state.lastError = err.message;
    state.currentFile = null;
    emit();
    throw err;
  } finally {
    abortController = null;
  }
}

module.exports = { start, stop, syncFiles, getStatus };
