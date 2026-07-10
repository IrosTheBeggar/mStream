// Backup worker — child process spawned by src/db/task-queue.js.
//
// Mirrors a source library tree to a destination path on the same host
// using a sorted merge-walk: source and destination are read in lockstep,
// per directory, with entries sorted by name. Copies new/changed source
// entries; soft-deletes orphan dest entries into <dest>/.mstream-trash/
// <YYYY-MM-DD>/. The previous implementation built a Set of every
// relative path during a source walk, then walked dest separately to
// find orphans by Set lookup — that pattern uses O(N total files) RAM
// (~100MB for a 1M-file library). The merge-walk uses O(max files in
// one directory) instead — typically a few KB regardless of library
// size. This is the same algorithm rsync, robocopy, and every other
// serious sync tool use.
//
// CLI input — single argv entry, JSON-encoded:
//   { sourcePath, destPath, retentionDays, followSymlinks }
//
// stdout protocol — line-buffered single-line JSON events:
//   { event: 'progress', filesCopied, filesUnchanged, filesTrashed, bytesCopied }
//   { event: 'done',     ...counts, fileErrors, sampleErrorMessage }
//   { event: 'error',    message }     ← always followed by exit 1
//
// Exit codes:
//   0 — sync completed (per-file errors counted in fileErrors)
//   1 — fatal error (bad input, source unmounted, dest unwritable, empty source)
//
// Per-file errors (unreadable file, permission denied on a single dest path,
// etc.) are NOT fatal — they're logged on stderr and surfaced via the
// done event's fileErrors counter. Fatal errors mean the run produced no
// useful work (source unmounted, dest write-denied at root, etc.).

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const TRASH_DIR_NAME = '.mstream-trash';
const TMP_PREFIX = '.mstream-tmp-';
// Resume-capable partial files use a deterministic filename so the next
// run can find and continue them. See atomicCopy / partialName for the
// naming scheme. Distinct prefix from TMP_PREFIX because:
//   - TMP_PREFIX entries are random-named in-flight buffers; we never
//     resume from them, only clean them up.
//   - PARTIAL_PREFIX entries encode source identity (size + mtime) so
//     a future run can decide "is this still valid for resume?"
const PARTIAL_PREFIX = '.mstream-partial-';

// mtime equality tolerance for the "is this file unchanged" check. Has to
// span the worst-case rounding granularity of any filesystem we might be
// mirroring to or from:
//   FAT32 / older exFAT — 2-second precision (rounds DOWN)
//   HFS+               — 1-second precision
//   NTFS / ext4 / APFS — sub-millisecond precision (no slack needed)
// 2000ms covers FAT32's 2s rounding with no margin to spare; we accept
// the trade-off that real edits happening within 2 seconds of each other
// look "unchanged" to us. For a music library that's a non-issue —
// nobody rewrites the same track twice in two seconds.
const MTIME_TOLERANCE_MS = 2000;

// Files smaller than this skip the resume-capable code path and use a
// random-named tmp + plain fs.copyFile (which on most platforms uses a
// fast-copy syscall like copy_file_range / clonefile / CopyFileEx).
// Resume only saves time when re-copying would take long enough to
// notice: at ~50 MB/s on a slow USB drive, a 16 MB file copies in 0.3s
// — not worth the bookkeeping. A 500 MB FLAC concert recording at the
// same speed is 10s, where resume genuinely helps.
const RESUME_MIN_SIZE = 16 * 1024 * 1024;

// HFS+ normalises filenames to NFD on disk; ext4/NTFS/APFS preserve
// whatever bytes you wrote. We sort merge-walk keys by NFC form so a
// case where source is on ext4 (NFC) and dest is on HFS+ (NFD) still
// pairs the same file on both sides. Without the normalisation, the
// source name and dest name would compare unequal and we'd treat the
// dest copy as orphan + re-copy from source on every run.
const toKey = (name) => name.normalize('NFC');

// Emit one final event line and exit, deferring the exit until the
// write callback fires so the bytes actually reach the parent. On POSIX,
// child-process stdout pipes are asynchronous (the write returns before
// the kernel pipe buffer drains to the reader), and process.exit() will
// tear the worker down without flushing pending writes. The most painful
// loss is the 'done' event's fileErrors + sampleErrorMessage — the close
// handler in task-queue.js reads those off `lastEvent` and surfaces them
// as the run's error_message. If 'done' is dropped, every per-file
// failure is silently absorbed and the run reports a clean "success"
// with no indication that anything went wrong. Same shape for fatal
// error events (lost → falls back to "Worker exited with code 1" instead
// of the real reason).
//
// The returned Promise NEVER resolves on success — process.exit fires
// from the callback and tears the process down. Callers `await` it so
// further top-level / IIFE code is guaranteed not to run after the exit
// is queued. Windows pipes are synchronous so the race doesn't bite
// there, but we use this helper everywhere for cross-platform
// consistency and to centralise the contract.
function emitAndExit(event, code) {
  return new Promise(() => {
    process.stdout.write(JSON.stringify(event) + '\n', () => process.exit(code));
  });
}

let loadJson;
try {
  loadJson = JSON.parse(process.argv[process.argv.length - 1]);
} catch (_err) {
  await emitAndExit({ event: 'error', message: 'Invalid JSON input' }, 1);
}

const { sourcePath, destPath, retentionDays, followSymlinks = false, excludeGlobs = [], interFileDelayMs = 0 } = loadJson;

if (!sourcePath || !destPath || typeof retentionDays !== 'number') {
  await emitAndExit({ event: 'error', message: 'sourcePath, destPath, retentionDays required' }, 1);
}

// Optional inter-file throttle. Applied after each file the worker
// actually wrote bytes for (skips unchanged files and finalize-only
// completes-partial cases — those did no I/O worth throttling for).
// Crude but cheap, and well-suited to libraries dominated by small/
// medium files that copy in << 1s each.
function throttleAfterCopy() {
  if (interFileDelayMs <= 0) { return Promise.resolve(); }
  return new Promise((resolve) => setTimeout(resolve, interFileDelayMs));
}

// Compile glob patterns into a single OR'd regex for fast matching.
// Patterns match against basenames (not relative paths), case-
// insensitively. Glob syntax is minimal — just `*` (any chars except
// path separators) and `?` (any single non-separator char), which
// covers the realistic use cases:
//   Thumbs.db        — exact filename
//   *.tmp            — any temp file
//   .DS_Store        — exact (dotfiles are normal entries here)
//   ._*              — macOS resource forks
// Case-insensitive because the dominant target filesystems for this
// feature (NTFS, default HFS+, exFAT) are case-insensitive, and a
// user typing `Thumbs.db` reasonably expects it to match `thumbs.db`.
//
// Combining all patterns into one regex (instead of testing each in
// a loop) cuts isExcluded() from O(N patterns) to O(1) per filename.
// For a worst-case 64 patterns × 1M files that's 63M regex tests
// avoided. The regex engine handles the alternation efficiently.
function globToRegexBody(glob) {
  let r = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') { r += '[^/\\\\]*'; }
    else if (c === '?') { r += '[^/\\\\]'; }
    else if ('.+()^$|{}[]\\'.includes(c)) { r += '\\' + c; }
    else { r += c; }
  }
  return r;
}
const excludeRegex = (() => {
  const list = Array.isArray(excludeGlobs) ? excludeGlobs : [];
  if (list.length === 0) { return null; }
  const body = list.map((g) => `(?:${globToRegexBody(g)})`).join('|');
  return new RegExp('^(?:' + body + ')$', 'i');
})();

function isExcluded(name) {
  return excludeRegex !== null && excludeRegex.test(name);
}

const counts = { filesCopied: 0, filesUnchanged: 0, filesTrashed: 0, bytesCopied: 0 };
let fileErrors = 0;
let sampleErrorMessage = null;

// Throttled progress emit. The worker can do thousands of fs ops/sec —
// flushing progress every file would flood the manager's stdout reader
// for no benefit.
let lastProgressMs = 0;
function emitProgress(force = false) {
  const now = Date.now();
  if (!force && now - lastProgressMs < 500) { return; }
  lastProgressMs = now;
  process.stdout.write(JSON.stringify({ event: 'progress', ...counts }) + '\n');
}

function recordFileError(message) {
  fileErrors++;
  if (!sampleErrorMessage) { sampleErrorMessage = message; }
  process.stderr.write(`Warning: ${message}\n`);
}

// followSymlinks mirrors the library's per-vpath flag (libraries.follow_symlinks):
// indexed-with-symlinks libraries get backed up the same way, while libraries
// configured to skip symlinks skip them on the dest side too.
function statForWalk(p) {
  return followSymlinks ? fs.stat(p) : fs.lstat(p);
}

// Per-worker cache of dirs we've already mkdir'd. atomicCopy calls
// ensureDir(path.dirname(dest)) for every file it copies — without a
// cache, a 100k-file library with ~5k unique parent dirs incurs ~95k
// redundant mkdir-recursive calls (each does an internal stat to
// short-circuit, but the syscall overhead still adds up). Skipping
// already-ensured dirs trims that to ~5k. The cache is a simple Set;
// max size = number of dirs in the library, ~tens of MB even for
// pathological cases (1M dirs × ~50 char paths × 2 bytes = 100MB,
// but that's a 1M-dir library which doesn't exist in practice).
const ensuredDirs = new Set();
async function ensureDir(dir) {
  if (ensuredDirs.has(dir)) { return; }
  await fs.mkdir(dir, { recursive: true });
  ensuredDirs.add(dir);
}

// Deterministic partial-file name. Encodes source identity (size +
// mtime) so a future run can decide whether the partial is still
// resume-eligible: if the source has been edited since the partial was
// written, its size or mtime will differ and a fresh partial will be
// created under a different name (the stale one then becomes an orphan
// that the dir-cleanup pass removes).
//
// Takes a Date object (not numeric ms) so both sides of the
// "is this the same source state?" comparison use Date.getTime() as
// the canonical mtime source. fs.statSync().mtimeMs can carry sub-ms
// fractional precision (NTFS FILETIME → ns → ms conversion) that the
// Date object doesn't preserve, and the rounding direction differs
// across Node versions. Funneling through Date avoids that drift.
//
// targetBasename gets hashed because filenames on some filesystems have
// length / character restrictions that the basename might violate
// (Windows reserved names, path-length limits). 12 hex chars (48 bits)
// is enough — collisions within a single dir are vanishingly unlikely
// and the only consequence of a collision would be wasted work, not
// corruption.
function partialName(targetBasename, srcSize, srcMtimeDate) {
  const targetHash = crypto
    .createHash('sha1')
    .update(targetBasename, 'utf8')
    .digest('hex')
    .slice(0, 12);
  // The trailing -v2 versions the WRITE DISCIPLINE, not the format:
  // v2 partials are written strictly sequentially (streamResume), so
  // "size === srcSize" really means every byte is valid and finalising
  // is safe. Unversioned partials were written with fs.copyFile, which
  // on Windows (CopyFileW) pre-extends the file to full size before the
  // data lands — a kill mid-copy left a full-size garbage-tail partial
  // that the next run would have blind-finalised into a silently
  // corrupt "complete" file. Old-name partials never match a v2 lookup
  // and age out via the staleness sweep.
  return `${PARTIAL_PREFIX}${targetHash}-${srcSize}-${srcMtimeDate.getTime()}-v2`;
}

// Stream `src` into `partial` starting at `offset` bytes — offset 0 is
// a fresh copy, offset > 0 resumes a previous interrupted run's partial.
// We trust the bytes already in the partial because the partial filename
// encodes the source's size+mtime; a different source state would have
// produced a different partial filename and we wouldn't be resuming it.
//
// ALL large-file writes go through here (fresh copies included, not just
// resumes) because strictly-sequential positional writes maintain the
// invariant the finalise path depends on: the partial's size always
// equals its count of VALID bytes. fs.copyFile cannot guarantee that —
// Windows' CopyFileW pre-extends the destination to full size before
// the data arrives, so a kill mid-copy left a full-size garbage-tail
// partial that the next run finalised into a corrupt "complete" file.
//
// Opens the partial with 'r+' when resuming (must exist) or 'w' for a
// fresh copy (create/truncate), and writes with an explicit position
// rather than relying on 'a' mode's append-at-end semantics — Windows
// in particular has historical quirks around FILE_APPEND_DATA + Node's
// libuv write path that can result in writes landing at the file
// pointer (offset 0 by default) instead of EOF. Explicit positions are
// simpler to reason about and portable.
async function streamResume(src, partial, srcSize, offset) {
  let reader, writer;
  try {
    reader = await fs.open(src, 'r');
    writer = await fs.open(partial, offset > 0 ? 'r+' : 'w');
    const buf = Buffer.alloc(256 * 1024);
    let pos = offset;
    while (pos < srcSize) {
      const { bytesRead } = await reader.read(buf, 0, buf.length, pos);
      if (bytesRead === 0) { break; }
      await writer.write(buf, 0, bytesRead, pos);
      pos += bytesRead;
    }
  } finally {
    if (reader) { try { await reader.close(); } catch (_) {} }
    if (writer) { try { await writer.close(); } catch (_) {} }
  }
}

// ── Destination mtime fidelity ──────────────────────────────────────────────
//
// The "unchanged" fast-path compares source vs dest mtimes, and atomicCopy
// stamps the source mtime onto every file it writes. Both assume the
// destination filesystem can store an explicit timestamp. Some can't:
// root-squash NFS returns EPERM (explicit utimes needs ownership /
// CAP_FOWNER), SMB shares can deny FILE_WRITE_ATTRIBUTES, and some FUSE
// backends return ENOSYS — or worse, report success and quietly keep
// their own timestamp. On such destinations a naive mtime compare
// classifies EVERY file as changed on EVERY run: the whole library gets
// trashed + recopied each time, bloating .mstream-trash by a full
// library size per run until retention prunes it.
//
// probeDestMtimeFidelity() detects this once per run with a throwaway
// file: stamp a fixed past mtime, stat it back, compare. If the stamp
// didn't take (or threw), destMtimeTrustworthy flips false and:
//   - the unchanged check falls back to size + dest-not-older-than-source
//     (see syncMatchedPair), so previously-landed files stay put;
//   - setMtimeSafe suppresses per-file stamp errors (the copies are the
//     backup; the timestamp is an optimisation for the next run's diff).
// One file error is recorded so the run summary surfaces the condition
// without a per-file flood.
let destMtimeTrustworthy = true;
let mtimeWarningIssued = false;

// 2000-01-01T00:00:00Z — arbitrary fixed instant, far enough from "now"
// that a filesystem ignoring the stamp can't pass the probe by accident.
const PROBE_MTIME_MS = 946684800000;

async function probeDestMtimeFidelity() {
  const probePath = path.join(
    destPath,
    TMP_PREFIX + 'mtime-probe-' + crypto.randomBytes(6).toString('hex'),
  );
  // Stage 1: can we write at all? A writeFile failure (read-only
  // remount, full disk, EACCES on the dest root) says nothing about
  // mtime fidelity — keep the exact comparison (already-stamped files
  // still compare exactly) and let the walk surface the real write
  // errors per-file, where they'll carry the true error message.
  try {
    await fs.writeFile(probePath, 'mtime-probe');
  } catch (_) {
    return;
  }
  // Stage 2: does an explicit stamp survive a round-trip?
  try {
    const want = new Date(PROBE_MTIME_MS);
    await fs.utimes(probePath, want, want);
    const st = await fs.stat(probePath);
    destMtimeTrustworthy = Math.abs(st.mtimeMs - PROBE_MTIME_MS) < MTIME_TOLERANCE_MS;
  } catch (_) {
    destMtimeTrustworthy = false;
  } finally {
    try { await fs.unlink(probePath); } catch (_) { /* best-effort cleanup */ }
  }
  if (!destMtimeTrustworthy) {
    mtimeWarningIssued = true;
    recordFileError('destination does not preserve file modification times; using size-based change detection for this run');
  }
}

// One stderr notice per run when the future-mtime clamp in
// syncMatchedPair fires, so genuinely skewed setups stay visible in the
// server log without inflating the run's fileErrors count.
let futureMtimeNoticed = false;
function noteFutureMtime(p) {
  if (futureMtimeNoticed) { return; }
  futureMtimeNoticed = true;
  process.stderr.write(`Warning: source files carry mtimes in the future (e.g. ${p}); treating same-size dest copies as unchanged\n`);
}

// Stamp the source mtime onto a freshly-written dest file, tolerating
// failure. Aborting the copy over a failed stamp would throw away the
// already-copied bytes and mean the file NEVER reaches the destination
// (each run re-copies and re-discards it, while the run still reports
// success). The bytes are the backup; the stamp only feeds the next
// run's cheap diff — and when it can't be stored, the fidelity probe
// above has already switched that diff to size-based.
async function setMtimeSafe(p, mtime) {
  try { await fs.utimes(p, mtime, mtime); }
  catch (err) {
    if (!mtimeWarningIssued) {
      mtimeWarningIssued = true;
      recordFileError(`utimes ${p}: ${err.message} — destination does not preserve modification times`);
    }
  }
}

// Atomic file copy: write to a sibling tmp/partial, rename onto target.
// On the same filesystem the rename is atomic, so partial writes never
// appear at the final path.
//
// Two paths:
//   - Small files (< RESUME_MIN_SIZE): random-named TMP_PREFIX file +
//     fs.copyFile. Fast-path syscall on supporting platforms.
//   - Large files: deterministic-named PARTIAL_PREFIX file. If a partial
//     for this source state already exists, resume from where it left
//     off; otherwise start fresh. Either way the partial gets renamed
//     to dest atomically once complete.
//
// Resume invariant: the partial filename encodes (target-name-hash,
// source-size, source-mtime). When we find a matching partial, the bytes
// 0..partial.size are guaranteed to be from a copy of THIS source state,
// so appending the rest produces a correct file. If the source has been
// edited since the partial was written, the encoded size/mtime would
// differ and we'd never find it via fs.stat (different filename).
// Returns the number of bytes actually written during this call. The
// caller adds this to its bytesCopied counter — so resume only counts
// the suffix that needed to be written, and the "finalise an already-
// complete partial" path counts zero. A user looking at the run summary
// then sees actual disk-write volume, not nominal file size.
//
// `beforeReplace` (optional async hook) runs after the new content is
// FULLY staged (tmp/partial complete, mtime stamped) and immediately
// before the rename onto `dest`. syncMatchedPair uses it to move the
// old dest copy to trash at the last possible moment — trashing before
// staging (the pre-batch-2 order) meant an ENOSPC mid-copy left the
// destination without a live copy of exactly the files that changed.
// If the hook throws, the rename never happens: the old dest copy is
// untouched and a large file's staged partial survives for resume.
async function atomicCopy(src, dest, srcMtime, srcSize, beforeReplace = null) {
  await ensureDir(path.dirname(dest));

  if (srcSize < RESUME_MIN_SIZE) {
    // Small-file path: keep the simple fast-copy implementation.
    const tmpName = TMP_PREFIX + crypto.randomBytes(6).toString('hex');
    const tmpPath = path.join(path.dirname(dest), tmpName);
    try {
      await fs.copyFile(src, tmpPath);
      await assertSrcUnchanged(src, srcMtime, srcSize);
      await setMtimeSafe(tmpPath, srcMtime);
      if (beforeReplace) { await beforeReplace(); }
      await renameOverwrite(tmpPath, dest);
    } catch (err) {
      try { await fs.unlink(tmpPath); } catch (_) {}
      throw err;
    }
    return srcSize;
  }

  const partialPath = path.join(
    path.dirname(dest),
    partialName(path.basename(dest), srcSize, srcMtime),
  );

  // Look for a resumable partial. If one exists with the same encoded
  // source state and a sane size (>0 and ≤ srcSize), resume from there.
  // If it's exactly srcSize, the previous run completed the bytes but
  // crashed before the rename — just finalise. Trusting size === srcSize
  // as "every byte valid" is sound for v2 partials because they're
  // written strictly sequentially (see streamResume).
  //
  // Only the stat probe is inside the catch. Pre-batch-2 the whole
  // finalise branch shared it, so a failed finalise RENAME was silently
  // swallowed and fell through to a full fresh copy — every run re-paid
  // the entire copy for that file, forever. Now the rename's error
  // propagates to the caller's per-file error accounting.
  let resumeFrom = 0;
  let partialStat = null;
  try { partialStat = await fs.stat(partialPath); }
  catch (_) { /* no partial yet — fresh copy */ }
  if (partialStat) {
    if (partialStat.size === srcSize) {
      if (beforeReplace) { await beforeReplace(); }
      await renameOverwrite(partialPath, dest);
      // Stamp AFTER the rename, on dest. Stamping the partial first
      // would give it the source's (typically months-old) mtime — and
      // if the rename then failed, cleanupOrphanBookkeeping's 7-day
      // staleness sweep would delete the fully-staged partial as an
      // orphan, re-paying the entire copy next run. The partial keeps
      // its natural write-time mtime (always fresh) until it actually
      // becomes the dest file. A crash between rename and stamp costs
      // one spurious trash+recopy next run — cheap by comparison.
      await setMtimeSafe(dest, srcMtime);
      return 0;  // already-complete partial — finalised without writing
    }
    if (partialStat.size > 0 && partialStat.size < srcSize) {
      resumeFrom = partialStat.size;
    } else {
      // Bigger than source (shouldn't happen) or zero-byte — treat as
      // unusable, blow it away and start fresh.
      try { await fs.unlink(partialPath); } catch (_) {}
    }
  }

  // Note on error handling: we deliberately DO NOT wrap in try/unlink
  // like the small-file path. The whole point of a resumable partial is
  // to survive a failed copy attempt so the next run can pick up where
  // this one left off; deleting on failure would defeat that. The
  // staleness sweep at the end of each dir's syncDir handles cleanup
  // for partials whose source no longer matches.
  //
  // Fresh copies (resumeFrom 0) stream through streamResume too — NOT
  // fs.copyFile — to keep the size-equals-valid-bytes invariant that
  // makes the finalise path above safe (see streamResume's comment).
  await streamResume(src, partialPath, srcSize, resumeFrom);
  await assertSrcUnchanged(src, srcMtime, srcSize);
  if (beforeReplace) { await beforeReplace(); }
  await renameOverwrite(partialPath, dest);
  await setMtimeSafe(dest, srcMtime);   // after the rename — see the finalise branch
  return srcSize - resumeFrom;
}

// Remove a dest-side symlink/junction WITHOUT touching its target —
// deleting a link only removes the reparse point / inode reference.
// fs.unlink handles file symlinks everywhere and junctions on modern
// Node/Windows; some Windows configurations report EPERM for directory
// links, where fs.rmdir removes the reparse point instead. When BOTH
// fail, the ORIGINAL unlink error propagates: for a file symlink the
// rmdir fallback dies with a misleading ENOTDIR while the real cause
// (permissions, busy handle) is the unlink's.
async function removeDestLink(p) {
  try { await fs.unlink(p); }
  catch (unlinkErr) {
    try { await fs.rmdir(p); }
    catch (_) { throw unlinkErr; }
  }
}

// Torn-copy guard: a file being WRITTEN while we copy it (an upload
// streaming in, a tagger rewriting in place) yields a dest copy that is
// neither the old nor the new version — and because we stamp the
// PRE-COPY mtime, the next run's unchanged-check can permanently
// classify the torn copy as current. Re-stat the source after the bytes
// are staged and refuse to finalise if it moved under us; the caller
// records a per-file error and the NEXT run picks up the settled file.
// The dest keeps its previous copy (staging happens before any
// displacement), so nothing is lost — one run of lag, no torn mirror.
async function assertSrcUnchanged(src, srcMtime, srcSize) {
  const now = await fs.stat(src);
  if (now.size !== srcSize || Math.abs(now.mtimeMs - srcMtime.getTime()) >= MTIME_TOLERANCE_MS) {
    throw new Error('source changed during copy — will retry next run');
  }
}

// Rename with a Windows read-only fallback. fs.rename cannot replace a
// target carrying FILE_ATTRIBUTE_READONLY (EPERM/EACCES) — an attribute
// fs.copyFile happily propagates from read-only source files, so a
// mirrored library CAN hold read-only dest entries. The pre-batch-2
// unlink-based replacement cleared the attribute implicitly; keep that
// as a fallback while preserving the atomic rename for the normal case.
// If the fallback can't fix it either, the ORIGINAL rename error
// propagates.
async function renameOverwrite(from, to) {
  try { await fs.rename(from, to); }
  catch (err) {
    if (err.code !== 'EPERM' && err.code !== 'EACCES') { throw err; }
    try { await fs.unlink(to); }
    catch (_) { throw err; }
    await fs.rename(from, to);
  }
}

// Move a dest file out of the live tree into the trash bucket for this
// run's date. retentionDays === 0 short-circuits the bucket and unlinks
// directly — opt-in for users who'd rather not pay the storage cost of
// a deletion log.
async function moveToTrash(destFile, relPath) {
  if (retentionDays <= 0) {
    await fs.unlink(destFile);
    return;
  }
  const dateStamp = new Date().toISOString().slice(0, 10);
  const trashTarget = path.join(destPath, TRASH_DIR_NAME, dateStamp, relPath);
  await ensureDir(path.dirname(trashTarget));
  // If a previous run today already trashed this exact relPath (e.g. file
  // gets deleted, re-added, then deleted again same day), suffix the new
  // entry so the older copy isn't lost.
  let target = trashTarget;
  let suffix = 1;
  while (true) {
    try {
      await fs.access(target);
      target = `${trashTarget}.${suffix++}`;
    } catch (_) {
      break;
    }
  }
  await fs.rename(destFile, target);
}

// Pre-flight: does the source contain ANY files (recursively, short-
// circuiting on the first hit)? Replaces the previous "expectedDestFiles
// is empty after walk" safety net. Catches the common library-disconnected
// failure (mount point exists but is empty) before merge-walk would start
// trashing dest entries.
async function hasAnyFiles(dir, seenRealDirs = null, depth = 0) {
  if (followSymlinks) {
    // Link-following turns the tree into a graph — track each visited
    // directory's REAL path so a link cycle (a → b → a) terminates
    // instead of recursing forever. realpath failure is tolerated (some
    // mounts fail it while readdir works; refusing would fatally block
    // the whole library) — the depth cap backstops runaway cycles then.
    if (depth > MAX_WALK_DEPTH) { return false; }
    if (seenRealDirs === null) { seenRealDirs = new Set(); }
    let real = null;
    try { real = await fs.realpath(dir); }
    catch (_) { /* resolver quirk — keep walking, depth cap protects */ }
    if (real !== null) {
      if (seenRealDirs.has(real)) { return false; }
      seenRealDirs.add(real);
    }
  }
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch (_) { return false; }
  for (const entry of entries) {
    if (entry.name.startsWith(TMP_PREFIX)) { continue; }
    if (entry.name.startsWith(PARTIAL_PREFIX)) { continue; }
    // Must mirror readSortedDir's exclude filtering. If excluded names
    // counted as "populated", a dead mountpoint holding only OS litter
    // (.DS_Store, Thumbs.db — the default excludes) would pass this
    // guard while the merge-walk sees an empty source — and the walk
    // would then sweep the ENTIRE destination into trash. Excluded
    // directories are skipped whole, same as the walk does.
    if (isExcluded(entry.name)) { continue; }
    if (entry.isFile()) { return true; }
    if (entry.isDirectory()) {
      if (await hasAnyFiles(path.join(dir, entry.name), seenRealDirs, depth + 1)) { return true; }
    }
    if (followSymlinks && entry.isSymbolicLink()) {
      // The walk (statForWalk → fs.stat) follows links when the library
      // is configured to, so this guard must follow them too — otherwise
      // a library whose content sits entirely behind links can never
      // back up: the guard refuses with "zero files" while the walk
      // would have mirrored it fine. With followSymlinks=false, links
      // stay invisible here, matching the walk's lstat-and-skip.
      let st = null;
      try { st = await fs.stat(path.join(dir, entry.name)); }
      catch (_) { /* broken link — ignore */ }
      if (st?.isFile()) { return true; }
      if (st?.isDirectory()) {
        if (await hasAnyFiles(path.join(dir, entry.name), seenRealDirs, depth + 1)) { return true; }
      }
    }
  }
  return false;
}

// Read a directory and return entries sorted by NFC-normalised name,
// filtering out our own bookkeeping. Three classes of names get skipped:
//   - TMP_PREFIX:     random-named in-flight buffers from atomicCopy.
//   - PARTIAL_PREFIX: deterministic-named resumable partials (atomicCopy
//                     looks them up by name via fs.stat, not by walking).
//   - TRASH_DIR_NAME: our soft-delete bucket — only filtered at the dest
//                     ROOT level, since a user could legitimately have a
//                     folder named .mstream-trash deeper in their tree.
//
// `hasBookkeeping` (returned alongside entries) signals whether any
// PARTIAL/TMP entries were observed during the filter pass. syncDir
// uses it to skip the cleanup readdir when there's nothing to clean
// — a meaningful speedup on libraries with thousands of directories
// that have no leftover bookkeeping (the common steady-state case).
async function readSortedDir(dir, { isDestRoot } = { isDestRoot: false }) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') { return { entries: [], existed: false, hasBookkeeping: false }; }
    throw err;
  }
  const filtered = [];
  let hasBookkeeping = false;
  for (const entry of entries) {
    if (entry.name.startsWith(TMP_PREFIX)) { hasBookkeeping = true; continue; }
    if (entry.name.startsWith(PARTIAL_PREFIX)) { hasBookkeeping = true; continue; }
    if (isDestRoot && entry.name === TRASH_DIR_NAME) { continue; }
    // Exclude patterns apply symmetrically on source AND dest. If we
    // filtered only on source, a previously-backed-up matching file
    // would survive on dest, then the merge-walk would treat it as
    // dest-only-orphan and trash it — which is the opposite of what
    // an operator adding `Thumbs.db` to their excludes wants. By
    // skipping on both sides, an excluded file is invisible to the
    // sync entirely (already-backed-up copies stay where they are).
    if (isExcluded(entry.name)) { continue; }
    filtered.push({ entry, key: toKey(entry.name) });
  }
  filtered.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { entries: filtered, existed: true, hasBookkeeping };
}

// Stale-partial age threshold. Partials touched within this window get
// preserved so an interrupted backup can resume from them on the next
// run; older ones are assumed orphaned (their source has been edited
// or deleted, so atomicCopy's deterministic-name lookup would never
// find them anyway).
//
// 7 days covers most real-world backup cadences — a destination running
// after-scan, daily, or even manually-once-a-week will get a chance to
// pick up its partials before they're cleaned. For users whose backups
// run less often than that, the trade-off is "lose resume capability"
// vs "leave possibly-many-GB orphan partials forever," and the latter
// is the worse failure mode for disk-constrained operators.
const PARTIAL_STALE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Stale-tmp age threshold. Random-named .mstream-tmp-* files belong to
// in-flight small-file copies; on a successful copy they're renamed to
// the target. A killed worker leaves them behind, where they're useless
// (no resume support — random name, no source identity encoded).
// 1 hour is generous for any in-flight copy: small files (< 16MB) will
// always finish faster than that, and any tmp older than 1h MUST be
// orphaned. Shorter than the partial threshold because there's no
// resume value to preserve.
const TMP_STALE_AGE_MS = 60 * 60 * 1000;

// Remove stale bookkeeping files from `dir`. Called after a directory's
// merge-walk completes. Two classes of leftovers:
//   - PARTIAL_PREFIX: keep if recent (resumable) or remove if older than
//     PARTIAL_STALE_AGE_MS (source has likely changed, no longer matches).
//   - TMP_PREFIX: never resumable; remove anything older than
//     TMP_STALE_AGE_MS. Without this, killed mid-copies of small files
//     accumulate forever (random names, never seen by atomicCopy again).
async function cleanupOrphanBookkeeping(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (_) { return; }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isFile()) { continue; }
    const isPartial = entry.name.startsWith(PARTIAL_PREFIX);
    const isTmp = entry.name.startsWith(TMP_PREFIX);
    if (!isPartial && !isTmp) { continue; }
    const threshold = isPartial ? PARTIAL_STALE_AGE_MS : TMP_STALE_AGE_MS;
    const p = path.join(dir, entry.name);
    try {
      const stat = await fs.stat(p);
      if (now - stat.mtimeMs > threshold) {
        await fs.unlink(p);
      }
    } catch (_) { /* best-effort */ }
  }
}

// ── Merge-walk core ─────────────────────────────────────────────────────────
//
// syncDir walks one source directory and one dest directory in lockstep,
// sorted by name. For each name it sees:
//   src only          → copy/recurse from source
//   dest only         → trash from dest
//   both, types match → file: compare and copy if different;
//                       dir:  recurse
//   both, types differ → trash dest entry, then process src entry
// Cycle protection for link-following libraries. With followSymlinks
// the source "tree" is really a graph: statForWalk follows links, so a
// link pointing at an ancestor recurses forever. Before walking INTO a
// source directory, claim its real path; a second claim is either a
// cycle (skip, or hang forever) or two links aliasing the same
// directory (skip the second — its content is already mirrored under
// the first path; the recorded error keeps the skipped alias visible,
// and its dest counterpart is left untouched rather than swept).
//
// Claims happen at the CALL SITES, before any dest-side mkdir — a
// skipped alias must never materialise an empty dest dir (it would
// oscillate: created this run, orphaned the next). The depth cap
// backstops the realpath-failure case: some mounts fail realpath while
// readdir works fine, and refusing to walk them would block whole
// libraries over a resolver quirk. Only consulted for followSymlinks
// libraries; plain trees are cycle-free by construction.
const walkedSrcRealDirs = new Set();
const MAX_WALK_DEPTH = 128;

async function claimSrcDir(srcDir, relPath) {
  if (!followSymlinks) { return true; }
  if (relPath && relPath.split(path.sep).length > MAX_WALK_DEPTH) {
    recordFileError(`source dir exceeds max walk depth (${MAX_WALK_DEPTH}): ${srcDir}`);
    return false;
  }
  let real;
  try { real = await fs.realpath(srcDir); }
  catch (_) { return true; }   // resolver quirk — walk anyway, depth cap protects
  if (walkedSrcRealDirs.has(real)) {
    recordFileError(`skipping source dir already visited via another link (cycle or alias): ${srcDir}`);
    return false;
  }
  walkedSrcRealDirs.add(real);
  return true;
}

async function syncDir(srcDir, destDir, relPath) {
  const isRoot = relPath === '';

  let srcSorted;
  try {
    const srcRead = await readSortedDir(srcDir);
    if (!srcRead.existed) {
      // The parent's readdir saw this directory but it's gone now — a
      // mid-run unmount or concurrent delete. Treating it as empty
      // (the pre-batch-2 behaviour: ENOENT → entries: []) would sweep
      // the entire matching dest subtree into trash. Leave dest alone
      // and let the next run reconcile from settled state.
      recordFileError(`source dir vanished mid-run: ${srcDir}`);
      return;
    }
    srcSorted = srcRead.entries;
  } catch (err) {
    recordFileError(`readdir source ${srcDir}: ${err.message}`);
    return;
  }

  // Dest dir might not exist yet (fresh subtree). readSortedDir returns
  // empty in that case; we'll mkdir lazily via atomicCopy when the first
  // file gets written.
  let destSorted;
  let destHadBookkeeping = false;
  try {
    const destRead = await readSortedDir(destDir, { isDestRoot: isRoot });
    destSorted = destRead.entries;
    destHadBookkeeping = destRead.hasBookkeeping;
  } catch (err) {
    recordFileError(`readdir dest ${destDir}: ${err.message}`);
    destSorted = [];
  }

  // Classify the whole merge BEFORE acting on it, then perform ALL
  // dest-only trashes before any source-only copies. On case-insensitive
  // destinations (NTFS, default APFS) a case-only rename makes the same
  // physical file appear as BOTH a source-only and a dest-only entry
  // (merge keys are NFC- but not case-folded). With interleaved
  // copy-then-trash ordering, trashing the stale dest name resolved —
  // case-insensitively — to the FRESHLY-COPIED file and removed it: the
  // backup lost the file until the next run (an entire subtree when a
  // directory was case-renamed). Trash-first moves the old bytes to
  // trash and lands the fresh copy afterwards, at the cost of a full
  // recopy on case-only renames. (Two source names differing only by
  // case still collapse to one file on such destinations — a filesystem
  // limitation we don't try to paper over.) The three lists hold
  // dirents for ONE directory, so the O(max files in one dir) memory
  // bound of the merge-walk is unchanged.
  const destOnly = [];
  const srcOnly = [];
  const matched = [];
  let i = 0, j = 0;
  while (i < srcSorted.length || j < destSorted.length) {
    const s = srcSorted[i];
    const d = destSorted[j];

    if (!s) {
      destOnly.push(d.entry);
      j++;
    } else if (!d) {
      srcOnly.push(s.entry);
      i++;
    } else if (s.key < d.key) {
      srcOnly.push(s.entry);
      i++;
    } else if (s.key > d.key) {
      destOnly.push(d.entry);
      j++;
    } else {
      matched.push([s.entry, d.entry]);
      i++; j++;
    }
  }

  for (const entry of destOnly) {
    await trashDestEntry(entry, destDir, relPath);
  }
  for (const [srcEntry, destEntry] of matched) {
    await syncMatchedPair(srcEntry, destEntry, srcDir, destDir, relPath);
  }
  for (const entry of srcOnly) {
    await syncSrcEntry(entry, srcDir, destDir, relPath);
  }

  // Sweep stale bookkeeping files — but only if readSortedDir actually
  // saw any. The fast-path "this dir has nothing to clean" case skips
  // the second readdir, which adds up: a 5,000-directory library with
  // no leftover tmps/partials would otherwise eat ~5,000 wasted
  // readdirs per run on the (often slow) backup destination.
  //
  // Cleanup targets:
  //   - Partials whose encoded (size, mtime) no longer matches a
  //     current source file — atomicCopy never found them via fs.stat,
  //     and after PARTIAL_STALE_AGE_MS we assume the source has been
  //     edited/deleted and they're truly orphan.
  //   - Random-named tmp files older than TMP_STALE_AGE_MS — killed
  //     mid-copies of small files. They never participate in resume,
  //     so anything > 1h old is unambiguously orphan.
  //
  // Edge case: atomicCopy can create a NEW partial mid-walk if a copy
  // fails partway. That new partial has mtime ~now and would pass the
  // staleness check anyway (kept, not removed) — so skipping cleanup
  // doesn't lose anything. The NEXT run's readSortedDir will see it,
  // set destHadBookkeeping=true, and either keep it (still fresh) or
  // remove it (now over PARTIAL_STALE_AGE_MS, source has long-since
  // changed). Small-file failures don't leak because atomicCopy's
  // small-file path unlinks its tmp on error before throwing.
  if (destHadBookkeeping) {
    await cleanupOrphanBookkeeping(destDir);
  }
}

// Source-only path: file → copy; directory → ensure dest dir, recurse.
async function syncSrcEntry(srcEntry, srcDir, destDir, relPath) {
  const srcChild = path.join(srcDir, srcEntry.name);
  const destChild = path.join(destDir, srcEntry.name);
  const childRel = relPath ? path.join(relPath, srcEntry.name) : srcEntry.name;

  let stat;
  try { stat = await statForWalk(srcChild); }
  catch (err) {
    recordFileError(`stat ${srcChild}: ${err.message}`);
    return;
  }

  // followSymlinks=false reaches here via lstat; skip the link.
  if (stat.isSymbolicLink()) { return; }

  if (stat.isDirectory()) {
    // Claim BEFORE ensureDir — a skipped alias/cycle must not leave an
    // empty dest dir behind (see claimSrcDir).
    if (!(await claimSrcDir(srcChild, childRel))) { return; }
    try { await ensureDir(destChild); }
    catch (err) {
      recordFileError(`mkdir ${destChild}: ${err.message}`);
      return;
    }
    await syncDir(srcChild, destChild, childRel);
    return;
  }

  // Skip sockets, fifos, character devices — not something we mirror.
  if (!stat.isFile()) { return; }

  try {
    const bytesWritten = await atomicCopy(srcChild, destChild, stat.mtime, stat.size);
    counts.filesCopied++;
    counts.bytesCopied += bytesWritten;
    if (bytesWritten > 0) { await throttleAfterCopy(); }
  } catch (err) {
    recordFileError(`copy ${srcChild}: ${err.message}`);
  }
  emitProgress();
}

// Both source and dest have an entry with the same name. Decide what to do.
async function syncMatchedPair(srcEntry, destEntry, srcDir, destDir, relPath) {
  const srcChild = path.join(srcDir, srcEntry.name);
  const destChild = path.join(destDir, srcEntry.name);
  const childRel = relPath ? path.join(relPath, srcEntry.name) : srcEntry.name;

  let srcStat;
  try { srcStat = await statForWalk(srcChild); }
  catch (err) {
    recordFileError(`stat ${srcChild}: ${err.message}`);
    return;
  }

  // Source is a symlink and we're not following — treat as if source has
  // no entry here, so the dest copy becomes orphan and gets trashed.
  if (srcStat.isSymbolicLink()) {
    await trashDestEntry(destEntry, destDir, relPath);
    return;
  }

  // Dest side is a link (file symlink or directory junction): NEVER
  // operate through it — remove the link itself and materialise the
  // source entry as real content. Without this, a dest dir-link
  // colliding with a same-named source dir sent the walk THROUGH the
  // link (the type-mismatch branch below skipped the link, ensureDir
  // no-op'd because the link stats as a dir, and syncDir then mirrored
  // into and trashed "orphans" out of whatever the link targeted —
  // verified against arbitrary directories, including the source
  // library itself). A dest file-link pointing back at the source file
  // was equally bad in the matched-file path: fs.stat follows the link,
  // so it validated as "unchanged" and the backup never held a real
  // copy of the file.
  if (destEntry.isSymbolicLink()) {
    try {
      await removeDestLink(destChild);
      counts.filesTrashed++;
    } catch (err) {
      recordFileError(`remove link ${destChild}: ${err.message}`);
      return;
    }
    await syncSrcEntry(srcEntry, srcDir, destDir, relPath);
    return;
  }

  // Type mismatch — e.g. source is a file but dest has a directory at the
  // same name, because the user reorganised their library. Trash whatever
  // is on dest (recursively, if it's a dir), then process source as new.
  // Without this, syncDir would try to recurse into a dest "dir" that's
  // actually a file (or vice versa) and error.
  const srcIsDir = srcStat.isDirectory();
  const destIsDir = destEntry.isDirectory();
  if (srcIsDir !== destIsDir) {
    await trashDestEntry(destEntry, destDir, relPath);
    await syncSrcEntry(srcEntry, srcDir, destDir, relPath);
    return;
  }

  if (srcIsDir) {
    // A skipped alias/cycle leaves the existing dest dir exactly as-is
    // (stale but stable) — no sweep, no prune (see claimSrcDir).
    if (!(await claimSrcDir(srcChild, childRel))) { return; }
    await syncDir(srcChild, destChild, childRel);
    // After syncing, prune the dest dir if it's now empty (e.g. source had
    // only directories that were themselves emptied into trash). Best-
    // effort — fs.rmdir errors if non-empty, which we ignore.
    try { await fs.rmdir(destChild); } catch (_) {}
    return;
  }

  if (!srcStat.isFile()) { return; }  // non-regular source file

  // Both are regular files — compare via stat + tolerance
  let destStat = null;
  try { destStat = await fs.stat(destChild); } catch (_) { /* fall through */ }

  // Same-size files are "unchanged" when the mtimes agree. On
  // destinations that can't store explicit timestamps (fidelity probe
  // failed), dest files carry copy-time mtimes instead of the stamped
  // source mtimes — an exact compare would recopy the whole library
  // every run. Fall back to dest-not-older-than-source: a dest copy at
  // least as new as the source's last edit was copied after that edit.
  // The cost: a same-size source edit that also backdates the file's
  // mtime goes undetected on such destinations.
  if (destStat && destStat.isFile() && destStat.size === srcStat.size) {
    let mtimeAgrees;
    if (destMtimeTrustworthy) {
      mtimeAgrees = Math.abs(destStat.mtimeMs - srcStat.mtimeMs) < MTIME_TOLERANCE_MS;
    } else {
      mtimeAgrees = destStat.mtimeMs + MTIME_TOLERANCE_MS >= srcStat.mtimeMs;
      if (!mtimeAgrees && srcStat.mtimeMs > Date.now() + MTIME_TOLERANCE_MS) {
        // Future-stamped source (wrong-clock rip, FAT TZ/DST shift, NFS
        // server clock behind the source host): its stamp can never
        // legitimately postdate this run's copy, so without this clamp
        // the file would be trashed + recopied on EVERY run until wall
        // time catches up with the stamp.
        mtimeAgrees = true;
        noteFutureMtime(srcChild);
      }
    }
    if (mtimeAgrees) {
      counts.filesUnchanged++;
      emitProgress();
      return;
    }
  }

  // Source differs — stage the replacement FIRST, and only displace the
  // old dest copy once the new bytes are fully staged (atomicCopy's
  // beforeReplace hook runs between staging and the final rename).
  // Trash-then-copy — the pre-batch-2 order — meant an ENOSPC or any
  // other mid-copy failure left the destination without a live copy of
  // exactly the files that changed. With retention 0 the old copy needs
  // no explicit unlink at all: the rename replaces it atomically, so
  // there is no window where neither version exists.
  const oldExists = !!(destStat && destStat.isFile());
  // retention>0: the hook counts when moveToTrash actually displaced the
  // old copy — even if the rename after it fails, the old copy IS in
  // trash, so the count stays truthful. retention<=0: nothing displaces
  // the old copy until the rename itself lands (no hook needed at all;
  // renameOverwrite replaces atomically), so count only on success.
  const preserveOld = (!oldExists || retentionDays <= 0) ? null
    : async () => {
      await moveToTrash(destChild, childRel);
      counts.filesTrashed++;
    };

  try {
    const bytesWritten = await atomicCopy(srcChild, destChild, srcStat.mtime, srcStat.size, preserveOld);
    if (oldExists && retentionDays <= 0) { counts.filesTrashed++; }
    counts.filesCopied++;
    counts.bytesCopied += bytesWritten;
    if (bytesWritten > 0) { await throttleAfterCopy(); }
  } catch (err) {
    recordFileError(`copy ${srcChild}: ${err.message}`);
  }
  emitProgress();
}

// Dest-only path: trash whatever's there (recursively for dirs).
async function trashDestEntry(destEntry, destDir, relPath) {
  const destChild = path.join(destDir, destEntry.name);
  const childRel = relPath ? path.join(relPath, destEntry.name) : destEntry.name;

  if (destEntry.isDirectory()) {
    // Recursively trash the dir's contents so each file ends up under
    // .mstream-trash/<date>/<original-relpath> rather than a single
    // bulk move that loses per-file structure. Mirrors the previous
    // sweepDest behaviour.
    let kids;
    try { kids = await fs.readdir(destChild, { withFileTypes: true }); }
    catch (err) {
      recordFileError(`readdir orphan ${destChild}: ${err.message}`);
      return;
    }
    for (const kid of kids) {
      if (kid.name.startsWith(TMP_PREFIX)) { continue; }
      await trashDestEntry(kid, destChild, childRel);
    }
    // After recursion the dir should be empty; remove it.
    try { await fs.rmdir(destChild); } catch (_) {}
    return;
  }

  // Dest-side links get removed, not kept: deleting a link never
  // touches its target, so unlike sockets/devices this is safe — and
  // leaving them (pre-batch-2 behaviour) kept the dest an unfaithful
  // mirror, blocked parent-dir pruning forever (rmdir ENOTEMPTY every
  // run), and armed the traversal bug in syncMatchedPair if the source
  // later gained a same-named directory.
  if (destEntry.isSymbolicLink()) {
    try {
      await removeDestLink(destChild);
      counts.filesTrashed++;
    } catch (err) {
      recordFileError(`remove link ${destChild}: ${err.message}`);
    }
    emitProgress();
    return;
  }

  // Skip non-regular files on dest (sockets, devices). They didn't
  // come from our worker and we don't want to fight them.
  if (!destEntry.isFile()) { return; }

  try {
    await moveToTrash(destChild, childRel);
    counts.filesTrashed++;
  } catch (err) {
    recordFileError(`trash orphan ${destChild}: ${err.message}`);
  }
  emitProgress();
}

// ── Main ────────────────────────────────────────────────────────────────────

(async () => {
  // Validate source exists and is a directory. Missing/unmounted source
  // is a config or environment error — emit fatal so the manager can
  // mark the run failed without us ever touching dest.
  try {
    const srcStat = await fs.stat(sourcePath);
    if (!srcStat.isDirectory()) {
      throw new Error(`Source path is not a directory: ${sourcePath}`);
    }
  } catch (err) {
    await emitAndExit({ event: 'error', message: `Source unavailable: ${err.message}` }, 1);
  }

  // Pre-flight: refuse to run if the source has zero files anywhere.
  // Catches the common library-disconnected failure (mount-point exists
  // but is empty) BEFORE the merge-walk would start trashing dest entries.
  // Replaces the previous "expectedDestFiles.size === 0 after walk" check;
  // the merge-walk doesn't have an aggregate "expected" view to consult,
  // so we do this check up front instead. Cheap on populated libraries
  // (returns true on the first file we see).
  const populated = await hasAnyFiles(sourcePath);
  if (!populated) {
    await emitAndExit({
      event: 'error',
      message: 'Source produced zero files — refusing to sweep destination. Check that the source library is mounted and populated.',
    }, 1);
  }

  // Defense-in-depth against symlinked configs: containment is validated
  // at configuration time (api/backup.js realpaths both sides), but a
  // link anywhere in either chain can change AFTER the destination was
  // saved. If source and dest now resolve into the same hierarchy,
  // refuse — mirroring into the library, or sweeping the library as
  // "dest orphans", is the loop the config-time check exists to prevent.
  //
  // Runs BEFORE ensureDir: the dest may not exist yet, so resolve via
  // walk-up (deepest existing ancestor's realpath + the lexical tail,
  // mirroring api/backup.js's resolveRealPath) — mkdir'ing first would
  // create real directories INSIDE the library through the swapped
  // link before the guard fires. Walk-up never throws; a resolver
  // quirk degrades to the lexical spelling, same as at config time.
  const resolveWalkUp = async (p) => {
    let probe = path.resolve(p);
    const tail = [];
    for (let i = 0; i < 64; i++) {
      try {
        const real = await fs.realpath(probe);
        return tail.length > 0 ? path.join(real, ...tail) : real;
      } catch (_) {
        const parent = path.dirname(probe);
        if (parent === probe) { break; }
        tail.unshift(path.basename(probe));
        probe = parent;
      }
    }
    return path.resolve(p);
  };
  const realSrc = await resolveWalkUp(sourcePath);
  const realDest = await resolveWalkUp(destPath);
  {
    const fold = (p) => {
      let r = p.normalize('NFC');
      // Conditional append: realpath keeps the trailing separator for
      // drive roots ('C:\'); doubling it would match nothing and
      // silently exempt whole-drive libraries from the guard.
      if (!r.endsWith(path.sep)) { r += path.sep; }
      if (process.platform === 'win32' || process.platform === 'darwin') { r = r.toLowerCase(); }
      return r;
    };
    const s = fold(realSrc);
    const d = fold(realDest);
    if (s.startsWith(d) || d.startsWith(s)) {
      await emitAndExit({
        event: 'error',
        message: `Destination resolves into the source library hierarchy (source: ${realSrc}, destination: ${realDest}) — refusing to run`,
      }, 1);
    }
  }

  // Ensure dest exists. mkdir -p handles a fresh-formatted backup drive
  // on its first run; failure here means the path is unreachable
  // (unmounted, permission denied, parent missing on a read-only mount).
  try {
    await ensureDir(destPath);
  } catch (err) {
    await emitAndExit({ event: 'error', message: `Destination unavailable: ${err.message}` }, 1);
  }

  // Probe timestamp fidelity before the walk so the unchanged check
  // knows which comparison to trust (see probeDestMtimeFidelity).
  await probeDestMtimeFidelity();

  // Seed the cycle-protection set with the root's real path so a link
  // deeper in the tree pointing back AT the root is caught.
  await claimSrcDir(sourcePath, '');
  await syncDir(sourcePath, destPath, '');

  emitProgress(true);
  await emitAndExit({
    event: 'done',
    ...counts,
    fileErrors,
    sampleErrorMessage,
  }, 0);
})().catch((err) => emitAndExit({ event: 'error', message: err.message }, 1));
