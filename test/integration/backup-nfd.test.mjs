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

function runWorker(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, JSON.stringify(payload)], {
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

  test('a genuine byte-exact sibling next to the variant is never clobbered by the convergence rename', async () => {
    const root = makeTempRoot('sibling');
    try {
      // Adversarial layout: dest holds an NFD variant AND a distinct
      // NFC-named file that is NOT in the dest readdir snapshot's
      // matched set... simulate the mid-run-creation edge by pre-seeding
      // both where the NFC one has DIFFERENT content and a DIFFERENT
      // inode. Two-phase classifies the NFC one as this pair's partner
      // (byte-equal) and the NFD one as a same-key duplicate — order
      // varies — but under NO ordering may the rename overwrite a
      // distinct inode: the run must end with the source content live
      // and the displaced bytes in trash, never silently destroyed.
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
});
