/**
 * Backup-worker batch-2 semantics (audit batch 2).
 *
 * Extends the batch-1 harness pattern (drive src/backup/worker.mjs
 * directly against temp trees, fault-inject via NODE_OPTIONS preloads)
 * to pin the merge-walk data-loss fixes:
 *
 *   - Two-phase walk: all dest-only trashes happen before source-only
 *     copies, so a case-only rename on a case-insensitive destination
 *     can no longer trash the freshly-copied file (or a whole subtree
 *     for a renamed directory).
 *   - Dest-side symlinks/junctions are removed, never operated through
 *     — a dest link colliding with a source dir used to redirect
 *     mirroring AND orphan-trashing into the link target.
 *   - Replacement copies stage fully before the old dest copy is
 *     displaced (ENOSPC mid-copy used to destroy the only backup copy
 *     of exactly the files that changed).
 *   - Large-file crash-safety: fresh copies stream sequentially so an
 *     interrupted partial always equals its valid bytes (fs.copyFile on
 *     Windows pre-extends — a kill left a full-size garbage partial the
 *     next run finalised into silent corruption); unversioned (pre-v2)
 *     partials are never trusted; a failed finalise rename surfaces
 *     instead of triggering a silent full recopy every run.
 *   - A source dir that vanishes mid-run (unmount) no longer reads as
 *     "empty" and sweeps the matching dest subtree.
 *   - The empty-source guard and the walk follow links (cycle-safe)
 *     when the library's followSymlinks flag is set.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKER = path.join(REPO_ROOT, 'src', 'backup', 'worker.mjs');
const FIXTURES = path.join(REPO_ROOT, 'test', 'fixtures').replace(/\\/g, '/');

const BIG = 17 * 1024 * 1024;   // over RESUME_MIN_SIZE (16MB)

let envCounter = 0;
function makeTempRoot(tag) {
  const root = path.join(os.tmpdir(), `mstream-b2-${tag}-` + Date.now() + '-' + (envCounter++));
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function runWorker(payload, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, JSON.stringify(payload)], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let errOut = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { errOut += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      const events = out.split(/\r?\n/).filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch (_) { return null; }
      }).filter(Boolean);
      resolve({ code, events, stderr: errOut });
    });
  });
}

function doneEvent(events) { return events.find((e) => e.event === 'done') || null; }
function errorEvent(events) { return events.find((e) => e.event === 'error') || null; }

function sha(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

// Live dest names at one level, ignoring trash + bookkeeping.
function liveNames(dir) {
  if (!fs.existsSync(dir)) { return []; }
  return fs.readdirSync(dir)
    .filter((n) => n !== '.mstream-trash' && !n.startsWith('.mstream-tmp-') && !n.startsWith('.mstream-partial-'))
    .sort();
}

function findInTrash(dest, basename) {
  const trash = path.join(dest, '.mstream-trash');
  if (!fs.existsSync(trash)) { return null; }
  const stack = [trash];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(p); }
      else if (e.name === basename || e.name.startsWith(basename + '.')) { return p; }
    }
  }
  return null;
}

// Mirrors worker.mjs partialName WITHOUT the -v2 suffix — the pre-batch-2
// name — for the "unversioned partials are never trusted" regression.
function oldPartialName(basename, size, mtimeDate) {
  const hash = crypto.createHash('sha1').update(basename, 'utf8').digest('hex').slice(0, 12);
  return `.mstream-partial-${hash}-${size}-${mtimeDate.getTime()}`;
}

// ── two-phase walk: case-only renames ───────────────────────────────────────

describe('batch2: case-only renames survive on any destination', () => {
  test('file rename a.mp3 -> A.mp3: fresh copy lands, old bytes in trash', async () => {
    const root = makeTempRoot('case-file');
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'a.mp3'), 'track-content');

    await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });
    fs.renameSync(path.join(src, 'a.mp3'), path.join(src, 'A.mp3'));
    const run2 = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });

    assert.equal(run2.code, 0);
    assert.deepEqual(liveNames(dest), ['A.mp3'],
      'dest must hold exactly the renamed file — pre-batch-2 the trash of the stale name removed the fresh copy on case-insensitive destinations');
    assert.equal(fs.readFileSync(path.join(dest, 'A.mp3'), 'utf8'), 'track-content');
    assert.ok(findInTrash(dest, 'a.mp3'), 'old-name copy must be preserved in trash');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('dir rename band -> Band: subtree intact under the new name', async () => {
    const root = makeTempRoot('case-dir');
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(path.join(src, 'band', 'album'), { recursive: true });
    fs.writeFileSync(path.join(src, 'band', 'album', 'x.mp3'), 'x-content');

    await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });
    fs.renameSync(path.join(src, 'band'), path.join(src, 'Band'));
    const run2 = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });

    assert.equal(run2.code, 0);
    assert.deepEqual(liveNames(dest), ['Band'],
      'pre-batch-2 the whole just-synced subtree was trashed on case-insensitive destinations');
    assert.equal(fs.readFileSync(path.join(dest, 'Band', 'album', 'x.mp3'), 'utf8'), 'x-content');
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ── dest-side links ─────────────────────────────────────────────────────────

describe('batch2: dest-side links are removed, never traversed', () => {
  test('dest dir-link colliding with source dir: link target untouched, real dir mirrored', async () => {
    const root = makeTempRoot('junction');
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    const victim = path.join(root, 'victim');
    fs.mkdirSync(path.join(src, 'linked'), { recursive: true });
    fs.writeFileSync(path.join(src, 'linked', 'song.mp3'), 'real-song');
    fs.mkdirSync(path.join(victim, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(victim, 'doc.txt'), 'precious');
    fs.writeFileSync(path.join(victim, 'sub', 'photo.jpg'), 'precious-2');
    fs.mkdirSync(dest, { recursive: true });
    fs.symlinkSync(victim, path.join(dest, 'linked'), 'junction');

    const { code } = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });

    assert.equal(code, 0);
    assert.equal(fs.readFileSync(path.join(victim, 'doc.txt'), 'utf8'), 'precious',
      'link target must be untouched — pre-batch-2 the walk trashed "orphans" out of it');
    assert.equal(fs.readFileSync(path.join(victim, 'sub', 'photo.jpg'), 'utf8'), 'precious-2');
    assert.equal(fs.lstatSync(path.join(dest, 'linked')).isSymbolicLink(), false,
      'dest entry must be a real directory now');
    assert.equal(fs.readFileSync(path.join(dest, 'linked', 'song.mp3'), 'utf8'), 'real-song');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('dest-only dir-link is removed (target untouched), parent stays prunable', async () => {
    const root = makeTempRoot('stale-link');
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    const victim = path.join(root, 'victim');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'keep.mp3'), 'keep');
    fs.mkdirSync(victim, { recursive: true });
    fs.writeFileSync(path.join(victim, 'data.txt'), 'safe');
    fs.mkdirSync(dest, { recursive: true });
    fs.symlinkSync(victim, path.join(dest, 'stale-link'), 'junction');

    const { code } = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });

    assert.equal(code, 0);
    assert.equal(fs.existsSync(path.join(dest, 'stale-link')), false,
      'dest-only link must be removed — pre-batch-2 it persisted forever');
    assert.equal(fs.readFileSync(path.join(victim, 'data.txt'), 'utf8'), 'safe');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('dest file-link pointing at the source file is replaced by a real copy', async (t) => {
    const root = makeTempRoot('file-link');
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(src, 'song.mp3'), 'the-song');
    try {
      fs.symlinkSync(path.join(src, 'song.mp3'), path.join(dest, 'song.mp3'), 'file');
    } catch (_) {
      fs.rmSync(root, { recursive: true, force: true });
      return t.skip('file symlinks unavailable on this host');
    }

    const { code, events } = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });

    assert.equal(code, 0);
    assert.equal(doneEvent(events).filesCopied, 1,
      'pre-batch-2 fs.stat followed the link to the source file and validated it as "unchanged"');
    assert.equal(fs.lstatSync(path.join(dest, 'song.mp3')).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(dest, 'song.mp3'), 'utf8'), 'the-song');
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ── staging order under failure ─────────────────────────────────────────────

describe('batch2: replacement copies stage before the old copy is displaced', () => {
  const injectEnv = { NODE_OPTIONS: `--require "${FIXTURES}/fail-copyfile.cjs"` };

  test('failed replacement copy leaves the old dest copy live', async () => {
    const root = makeTempRoot('enospc');
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src, { recursive: true });
    const f = path.join(src, 'FAILCOPY-track.mp3');
    fs.writeFileSync(f, 'version-1');

    await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });
    fs.writeFileSync(f, 'version-2-longer');   // size + mtime change

    const run2 = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 }, { env: injectEnv });
    assert.equal(run2.code, 0);
    assert.equal(doneEvent(run2.events).fileErrors, 1);
    assert.equal(fs.readFileSync(path.join(dest, 'FAILCOPY-track.mp3'), 'utf8'), 'version-1',
      'old copy must stay live when the replacement copy fails — pre-batch-2 it was already in trash');
    assert.equal(doneEvent(run2.events).filesTrashed, 0, 'nothing may be displaced on a failed copy');

    const run3 = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });
    assert.equal(fs.readFileSync(path.join(dest, 'FAILCOPY-track.mp3'), 'utf8'), 'version-2-longer');
    assert.ok(findInTrash(dest, 'FAILCOPY-track.mp3'), 'old version reaches trash once the replacement lands');
    assert.equal(doneEvent(run3.events).filesTrashed, 1);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ── large-file crash-safety ─────────────────────────────────────────────────

describe('batch2: large-file partials are crash-safe', () => {
  test('interrupted fresh copy leaves a valid-bytes partial; next run resumes it', async () => {
    const root = makeTempRoot('bigkill');
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src, { recursive: true });
    const big = path.join(src, 'big.mp3');
    fs.writeFileSync(big, crypto.randomBytes(BIG));

    const run1 = await runWorker(
      { sourcePath: src, destPath: dest, retentionDays: 30 },
      { env: { NODE_OPTIONS: `--require "${FIXTURES}/fail-partial-write.cjs"` } },
    );
    assert.notEqual(run1.code, 0, 'worker must have been killed mid-copy');

    const partials = fs.readdirSync(dest).filter((n) => n.startsWith('.mstream-partial-'));
    assert.equal(partials.length, 1, 'an interrupted partial must survive for resume');
    const pStat = fs.statSync(path.join(dest, partials[0]));
    assert.ok(pStat.size > 0 && pStat.size < BIG,
      `partial size must equal valid bytes written (got ${pStat.size}) — fs.copyFile on Windows pre-extended to full size with a garbage tail`);
    const srcPrefix = fs.readFileSync(big).subarray(0, pStat.size);
    const partialBytes = fs.readFileSync(path.join(dest, partials[0]));
    assert.ok(srcPrefix.equals(partialBytes), 'every byte in the partial must be valid source data');

    const run2 = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });
    assert.equal(run2.code, 0);
    assert.equal(sha(path.join(dest, 'big.mp3')), sha(big), 'resumed file must be byte-identical');
    assert.ok(doneEvent(run2.events).bytesCopied < BIG,
      'second run must resume the partial, not re-copy the whole file');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('full-size unversioned (pre-v2) partial is never blind-finalised', async () => {
    const root = makeTempRoot('oldpartial');
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(dest, { recursive: true });
    const big = path.join(src, 'big.mp3');
    fs.writeFileSync(big, crypto.randomBytes(BIG));
    const st = fs.statSync(big);
    // The pre-batch-2 crash shape: a full-size partial whose tail is
    // garbage (CopyFileW pre-extension), under the OLD unversioned name.
    fs.writeFileSync(path.join(dest, oldPartialName('big.mp3', st.size, st.mtime)), crypto.randomBytes(BIG));

    const { code } = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });
    assert.equal(code, 0);
    assert.equal(sha(path.join(dest, 'big.mp3')), sha(big),
      'dest must be copied fresh from source — pre-batch-2 the garbage partial was renamed in as "complete"');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('failed finalise rename surfaces, and the next run finalises without re-copying', async () => {
    const root = makeTempRoot('renamefail');
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src, { recursive: true });
    const big = path.join(src, 'FAILRENAME-big.mp3');
    fs.writeFileSync(big, crypto.randomBytes(BIG));

    const run1 = await runWorker(
      { sourcePath: src, destPath: dest, retentionDays: 30 },
      { env: { NODE_OPTIONS: `--require "${FIXTURES}/fail-rename-once.cjs"` } },
    );
    assert.equal(run1.code, 0);
    assert.equal(doneEvent(run1.events).fileErrors, 1,
      'the failed finalise must be recorded — pre-batch-2 the resume-lookup catch swallowed it');
    assert.equal(fs.existsSync(path.join(dest, 'FAILRENAME-big.mp3')), false);
    const partials = fs.readdirSync(dest).filter((n) => n.startsWith('.mstream-partial-'));
    assert.equal(partials.length, 1, 'fully-staged partial must survive the failed rename');
    assert.equal(fs.statSync(path.join(dest, partials[0])).size, BIG);

    const run2 = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });
    assert.equal(run2.code, 0);
    assert.equal(doneEvent(run2.events).bytesCopied, 0,
      'the complete partial must be finalised without re-copying — pre-batch-2 every run re-paid the full copy');
    assert.equal(sha(path.join(dest, 'FAILRENAME-big.mp3')), sha(big));
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ── source vanishes mid-run ─────────────────────────────────────────────────

describe('batch2: source dir vanishing mid-run does not sweep the dest subtree', () => {
  test('ENOENT on a child readdir skips the subtree instead of trashing it', async () => {
    const root = makeTempRoot('vanish');
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    const sub = path.join(src, 'vanish-sub');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'track.mp3'), 'still-here');

    await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });
    assert.equal(fs.readFileSync(path.join(dest, 'vanish-sub', 'track.mp3'), 'utf8'), 'still-here');

    // Fixture deletes the source subdir right before its 2nd readdir:
    // call #1 is hasAnyFiles' pre-flight, call #2 is the merge-walk.
    const run2 = await runWorker(
      { sourcePath: src, destPath: dest, retentionDays: 30 },
      { env: { NODE_OPTIONS: `--require "${FIXTURES}/vanish-readdir.cjs"`, VANISH_DIR: sub } },
    );

    assert.equal(run2.code, 0);
    assert.ok(doneEvent(run2.events).fileErrors >= 1);
    assert.match(run2.stderr, /vanished/i);
    assert.equal(fs.readFileSync(path.join(dest, 'vanish-sub', 'track.mp3'), 'utf8'), 'still-here',
      'dest subtree must be untouched — pre-batch-2 the vanished dir read as empty and the subtree was trashed');
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ── follow-links guard + walk ───────────────────────────────────────────────

describe('batch2: link-following libraries pass the guard and walk safely', () => {
  test('all-links root backs up when followSymlinks=true', async () => {
    const root = makeTempRoot('alllinks');
    const src = path.join(root, 'src');
    const outside = path.join(root, 'outside');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'track.mp3'), 'linked-track');
    fs.symlinkSync(outside, path.join(src, 'linked'), 'junction');

    const { code } = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30, followSymlinks: true });
    assert.equal(code, 0,
      'guard must follow links when the library does — pre-batch-2 it refused with "zero files"');
    assert.equal(fs.readFileSync(path.join(dest, 'linked', 'track.mp3'), 'utf8'), 'linked-track');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('all-links root still refused when followSymlinks=false (fail-closed)', async () => {
    const root = makeTempRoot('alllinks-off');
    const src = path.join(root, 'src');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'track.mp3'), 'linked-track');
    fs.symlinkSync(outside, path.join(src, 'linked'), 'junction');

    const { code, events } = await runWorker({ sourcePath: src, destPath: path.join(root, 'dest'), retentionDays: 30, followSymlinks: false });
    assert.equal(code, 1);
    assert.match(errorEvent(events).message, /zero files/i);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('link cycle with no files terminates and is refused', async () => {
    const root = makeTempRoot('cycle-empty');
    const src = path.join(root, 'src');
    const a = path.join(src, 'a');
    fs.mkdirSync(a, { recursive: true });
    fs.symlinkSync(a, path.join(a, 'loop'), 'junction');

    const { code, events } = await runWorker({ sourcePath: src, destPath: path.join(root, 'dest'), retentionDays: 30, followSymlinks: true });
    assert.equal(code, 1, 'cycle-only source must terminate (not hang) and be refused as empty');
    assert.match(errorEvent(events).message, /zero files/i);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* cycle cleanup */ }
  });

  test('link cycle alongside real content mirrors the content and skips the loop', async () => {
    const root = makeTempRoot('cycle-full');
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    const a = path.join(src, 'a');
    fs.mkdirSync(a, { recursive: true });
    fs.writeFileSync(path.join(a, 'track.mp3'), 'real-track');
    fs.symlinkSync(a, path.join(a, 'loop'), 'junction');

    const { code, events } = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30, followSymlinks: true });
    assert.equal(code, 0, 'walk must terminate on cycles — batch 1 made followSymlinks live, so cycles became reachable');
    assert.equal(fs.readFileSync(path.join(dest, 'a', 'track.mp3'), 'utf8'), 'real-track');
    assert.ok(doneEvent(events).fileErrors >= 1, 'the skipped cycle should be recorded');
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* cycle cleanup */ }
  });
});
