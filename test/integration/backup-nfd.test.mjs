/**
 * Unicode-normalization pairing (audit finding #6 — the last open one).
 *
 * The merge-walk pairs entries by NFC key, but historically built every
 * dest-side path from srcEntry.name. A dest written in NFD (rsync from a
 * Mac is the classic source) on a normalization-SENSITIVE filesystem
 * (ext4, NTFS) therefore stat'd ENOENT: the file was recopied in full
 * under the NFC name, the NFD original was never trashed, and later
 * runs paired the equal sort keys in arbitrary order — trash+recopy
 * churn forever.
 *
 * The fix (convergeDestName): matched pairs with byte-different names
 * operate through the dest's ACTUAL bytes and converge to the source's
 * bytes with a cheap same-directory rename. These tests pin: no recopy,
 * name convergence (file + directory subtree), churn-state cleanup, and
 * two-run idempotence.
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

// 'café.mp3' in composed and decomposed spellings — byte-different,
// same NFC key. Guard the fixture itself so a source-file normalization
// mishap can't silently turn these tests into name-equal no-ops.
const NFC_NAME = 'café.mp3';
const NFD_NAME = 'café.mp3';
assert.notEqual(NFC_NAME, NFD_NAME);
assert.equal(NFD_NAME.normalize('NFC'), NFC_NAME);

const NFC_DIR = 'Béla Fleck';
const NFD_DIR = 'Béla Fleck';

let envCounter = 0;
function makeTempRoot(tag) {
  const rand = crypto.randomBytes(4).toString('hex');
  const root = path.join(os.tmpdir(), `mstream-nfd-${tag}-${rand}-` + (envCounter++));
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  return root;
}

// Forward slashes: NODE_OPTIONS eats backslashes on Windows.
const REVERSE_READDIR = path.join(REPO_ROOT, 'test', 'fixtures', 'reverse-readdir.cjs').replace(/\\/g, '/');

function runWorker(payload, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, JSON.stringify(payload)], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      const events = out.split(/\r?\n/).filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch (_) { return null; }
      }).filter(Boolean);
      resolve({ code, events });
    });
  });
}
const doneEvent = (events) => events.find((e) => e.event === 'done') || null;
// Byte-exact directory listing (readdir returns stored bytes on ext4/
// NTFS/APFS alike), excluding bookkeeping + trash.
const liveNames = (dir) => fs.readdirSync(dir)
  .filter((n) => n !== '.mstream-trash' && !n.startsWith('.mstream-tmp-') && !n.startsWith('.mstream-partial-'))
  .sort();

// Seed src/<name> and dest/<destName> with identical content and equal
// mtimes (backdated past tolerance) — the "rsync'd from a Mac" state.
function seedPair(root, srcName, destName, content) {
  const src = path.join(root, 'src');
  const dest = path.join(root, 'dest');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(dest, { recursive: true });
  const past = new Date(Date.now() - 90_000);
  fs.writeFileSync(path.join(src, srcName), content);
  fs.utimesSync(path.join(src, srcName), past, past);
  fs.writeFileSync(path.join(dest, destName), content);
  fs.utimesSync(path.join(dest, destName), past, past);
  return { src, dest };
}

describe('NFD/NFC matched-pair convergence', () => {
  test('NFD-named dest file: no recopy, name converges to source bytes, nothing trashed', async () => {
    const root = makeTempRoot('file');
    try {
      const { src, dest } = seedPair(root, NFC_NAME, NFD_NAME, 'same-content');

      const first = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });
      assert.equal(first.code, 0);
      const done = doneEvent(first.events);
      assert.equal(done.filesCopied, 0, 'identical content behind a normalization variant must NOT recopy');
      assert.equal(done.filesUnchanged, 1);
      assert.equal(done.filesTrashed, 0, 'the NFD original is this pair\'s mirror, not an orphan');
      assert.equal(done.fileErrors, 0);
      assert.deepEqual(liveNames(dest), [NFC_NAME],
        'dest name must converge to the source\'s bytes (byte-exact readdir compare)');
      assert.ok(!fs.existsSync(path.join(dest, '.mstream-trash')), 'no trash bucket for a pure rename');

      const second = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });
      const done2 = doneEvent(second.events);
      assert.equal(done2.filesCopied, 0);
      assert.equal(done2.filesTrashed, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('NFD-named dest directory: subtree converges without copying', async () => {
    const root = makeTempRoot('dir');
    try {
      const src = path.join(root, 'src');
      const dest = path.join(root, 'dest');
      const past = new Date(Date.now() - 90_000);
      fs.mkdirSync(path.join(src, NFC_DIR), { recursive: true });
      fs.mkdirSync(path.join(dest, NFD_DIR), { recursive: true });
      // The child is itself NFD-named on dest — convergence must recurse.
      fs.writeFileSync(path.join(src, NFC_DIR, NFC_NAME), 'track-content');
      fs.utimesSync(path.join(src, NFC_DIR, NFC_NAME), past, past);
      fs.writeFileSync(path.join(dest, NFD_DIR, NFD_NAME), 'track-content');
      fs.utimesSync(path.join(dest, NFD_DIR, NFD_NAME), past, past);

      const { code, events } = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });
      assert.equal(code, 0);
      const done = doneEvent(events);
      assert.equal(done.filesCopied, 0, 'a matched dir tree must converge by rename, not recopy');
      assert.equal(done.filesTrashed, 0);
      assert.equal(done.fileErrors, 0);
      assert.deepEqual(liveNames(dest), [NFC_DIR], 'directory name converged');
      assert.deepEqual(liveNames(path.join(dest, NFC_DIR)), [NFC_NAME], 'child name converged');
      assert.equal(fs.readFileSync(path.join(dest, NFC_DIR, NFC_NAME), 'utf8'), 'track-content');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('pre-fix churn state (both variants on dest) converges and stays converged', { skip: process.platform === 'darwin' ? 'APFS resolves both spellings to one file — the dual-entry state cannot exist' : false }, async () => {
    const root = makeTempRoot('churn');
    try {
      // The state pre-fix runs left behind: the NFC copy (fresh, matches
      // source) AND the NFD original (stale content) side by side.
      const { src, dest } = seedPair(root, NFC_NAME, NFC_NAME, 'fresh-content');
      fs.writeFileSync(path.join(dest, NFD_NAME), 'stale-old-content-longer');
      assert.equal(liveNames(dest).length, 2, 'fixture must start with both spellings');

      const first = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });
      assert.equal(first.code, 0);
      assert.equal(doneEvent(first.events).fileErrors, 0);
      assert.deepEqual(liveNames(dest), [NFC_NAME], 'exactly one converged entry survives');
      assert.equal(fs.readFileSync(path.join(dest, NFC_NAME), 'utf8'), 'fresh-content',
        'the surviving copy carries the source content');
      // Whichever variant lost the pairing went through the deletion log.
      const buckets = fs.readdirSync(path.join(dest, '.mstream-trash'));
      assert.equal(buckets.length, 1, 'the duplicate was trashed, not silently unlinked');

      const second = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });
      const done2 = doneEvent(second.events);
      assert.equal(done2.filesCopied, 0, 'converged state must be stable — no churn');
      assert.equal(done2.filesTrashed, 0);
      assert.equal(done2.filesUnchanged, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a byte-exact dest twin wins the pairing deterministically; the variant is trashed as an orphan', async () => {
    const root = makeTempRoot('sibling');
    try {
      // Dest holds an NFD variant (stale) AND a byte-exact NFC twin
      // with different content. Byte-preferring pairing means the NFC
      // twin is ALWAYS this pair's partner (no readdir-order roulette)
      // and the NFD variant is always the phase-1 orphan: the run must
      // end with the source content live under the NFC name and every
      // displaced byte-stream in trash, never silently destroyed.
      const { src, dest } = seedPair(root, NFC_NAME, NFD_NAME, 'content-A');
      fs.writeFileSync(path.join(dest, NFC_NAME), 'content-B-distinct');

      const { code, events } = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });
      assert.equal(code, 0);
      assert.equal(doneEvent(events).fileErrors, 0);
      assert.deepEqual(liveNames(dest), [NFC_NAME]);
      assert.equal(fs.readFileSync(path.join(dest, NFC_NAME), 'utf8'), 'content-A',
        'live copy must mirror the source');
      // Every displaced byte-stream is accounted for in the trash.
      const bucket = path.join(dest, '.mstream-trash', fs.readdirSync(path.join(dest, '.mstream-trash'))[0]);
      const trashed = fs.readdirSync(bucket);
      assert.ok(trashed.length >= 1, 'the displaced duplicate landed in trash, not oblivion');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('dual-spelling SOURCE never swaps contents, even when dest enumerates in reverse order', { skip: process.platform === 'darwin' ? 'APFS cannot hold both spellings as distinct files' : false }, async () => {
    const root = makeTempRoot('crosspair');
    try {
      // The review-caught regression: a source that legitimately holds
      // BOTH spellings as distinct files (a library merged from a
      // Mac-rsync'd tree and a Linux-native one), dest correctly
      // mirroring both. Positional equal-key pairing cross-paired when
      // the two directories enumerated in different orders (legal on
      // ext4: per-dir hash seeds) and SWAPPED the two files' contents
      // on the mirror — silently, and stably. The reverse-readdir shim
      // forces the divergent order deterministically; byte-preferring
      // pairing must be immune to it.
      const src = path.join(root, 'src');
      const dest = path.join(root, 'dest');
      fs.mkdirSync(src, { recursive: true });
      fs.mkdirSync(dest, { recursive: true });
      const past = new Date(Date.now() - 90_000);
      for (const [name, content] of [[NFC_NAME, 'nfc-content-long-form'], [NFD_NAME, 'nfd-short']]) {
        fs.writeFileSync(path.join(src, name), content);
        fs.utimesSync(path.join(src, name), past, past);
        fs.writeFileSync(path.join(dest, name), content);
        fs.utimesSync(path.join(dest, name), past, past);
      }
      assert.equal(liveNames(src).length, 2, 'fixture needs both spellings as distinct source files');

      const { code, events } = await runWorker(
        { sourcePath: src, destPath: dest, retentionDays: 30 },
        { env: { NODE_OPTIONS: `--require "${REVERSE_READDIR}"`, REVERSE_READDIR_DIR: dest } });
      assert.equal(code, 0);
      const done = doneEvent(events);
      assert.equal(done.filesCopied, 0, 'a byte-correct mirror must not be recopied under ANY enumeration order');
      assert.equal(done.filesTrashed, 0);
      assert.equal(done.filesUnchanged, 2);
      assert.equal(fs.readFileSync(path.join(dest, NFC_NAME), 'utf8'), 'nfc-content-long-form',
        'NFC name keeps NFC content — no swap');
      assert.equal(fs.readFileSync(path.join(dest, NFD_NAME), 'utf8'), 'nfd-short',
        'NFD name keeps NFD content — no swap');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('NFD-named dest symlink colliding with a matched source dir is removed via its actual bytes', async () => {
    const root = makeTempRoot('destlink');
    try {
      const src = path.join(root, 'src');
      const dest = path.join(root, 'dest');
      const target = path.join(root, 'link-target');
      fs.mkdirSync(path.join(src, NFC_DIR), { recursive: true });
      fs.writeFileSync(path.join(src, NFC_DIR, 'track.mp3'), 'real-track');
      fs.mkdirSync(dest, { recursive: true });
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'canary.txt'), 'must-survive');
      // A dest-side link whose stored name is the NFD spelling. The
      // link-removal branch must reach it through its ACTUAL bytes —
      // built from srcEntry.name it was ENOENT on normalization-
      // sensitive filesystems, leaving the link in place forever with a
      // per-run error.
      fs.symlinkSync(target, path.join(dest, NFD_DIR), process.platform === 'win32' ? 'junction' : 'dir');

      const { code, events } = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });
      assert.equal(code, 0);
      const done = doneEvent(events);
      assert.equal(done.fileErrors, 0, 'the NFD-named link must be reachable and removed cleanly');
      assert.deepEqual(liveNames(dest), [NFC_DIR], 'source dir materialised under source bytes');
      assert.equal(fs.readFileSync(path.join(dest, NFC_DIR, 'track.mp3'), 'utf8'), 'real-track');
      assert.equal(fs.readFileSync(path.join(target, 'canary.txt'), 'utf8'), 'must-survive',
        'the link TARGET must never be touched');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
