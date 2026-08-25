/**
 * The ffmpeg half of the waveform pass (src/db/waveform-fallback.js).
 *
 * symphonia has no Opus decoder, so the rust pass leaves Opus keys
 * uncached by design. Before this module existed those tracks got no
 * proactive waveform at all: the first play of every Opus file paid a cold
 * ffmpeg decode with an empty progress bar, and the pass reported them as
 * permanent failures in the admin panel.
 *
 * Covered here: Opus is picked up and generated; symphonia-only failure
 * markers are retried and cleared on success; an ffmpeg-recorded failure
 * is NOT retried; already-cached keys are left alone; duplicate content
 * decodes once; a vanished file leaves no marker; and abort stops the run.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import child from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MIGRATIONS } from '../../src/db/schema.js';
import { run, shouldChain } from '../../src/db/waveform-fallback.js';
import {
  NUM_BARS, cacheFilePath, failedMarkerPath, deferredMarkerPath,
} from '../../src/db/waveform-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FFMPEG = path.join(REPO_ROOT, 'bin', 'ffmpeg',
  process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const ffmpegOk = fs.existsSync(FFMPEG);

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = child.spawn(FFMPEG, ['-nostdin', '-y', '-loglevel', 'error', ...args],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('exit', code => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.slice(-300)}`)));
  });
}

let tmp;
let seq = 0;

before(async () => { tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'wffb-test-')); });
after(async () => {
  if (tmp) { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
});

// Encode each DISTINCT fixture once for the whole file and copy it per
// case. Every test wants the same handful of one-second tones, so
// re-encoding them per case spent an extra ffmpeg spawn or two on top of
// the one the code under test needs.
//
// Measured: this is a wash locally (89s -> 91s, inside the noise) because
// a spawn here costs ~1s. It is worth keeping anyway because the cost it
// removes is spawns, and spawns are what is expensive on the Windows CI
// runner — there a single ffmpeg spawn measured ~15s, the ffmpeg tests in
// this file ran 27-30s apiece, and one of them blew a 60s timeout with
// nothing actually wrong. The rust-binary waveform suites, which spawn
// nothing per case, stayed at 2-8s on that same runner.
//
// 2026-08: a slower windows runner reran the lesson — PASSING tests in this
// file measured 87-135s and one blew the then-120s cap, again with nothing
// wrong. Hence the uniform 240s per-test timeout: the caps exist to fail a
// genuinely hung ffmpeg rather than hang the shard, not to race the runner.
const fixtureCache = new Map();
async function fixtureFor(name, codec, freq) {
  const ext = path.extname(name);
  // `codec` override lets a test put Opus inside a .ogg container — the
  // case the extension alone cannot classify.
  const useOpus = codec === 'opus' || ext === '.opus';
  const key = `${ext}|${useOpus ? 'opus' : 'mp3'}|${freq}`;
  if (fixtureCache.has(key)) { return fixtureCache.get(key); }

  const codecArgs = useOpus
    ? ['-c:a', 'libopus', '-b:a', '64k', ...(ext === '.opus' ? ['-f', 'opus'] : [])]
    : ['-c:a', 'libmp3lame', '-b:a', '64k'];
  const out = path.join(tmp, `fixture-${fixtureCache.size}${ext}`);
  await runFfmpeg([
    '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=1:sample_rate=48000`,
    ...codecArgs, out,
  ]);
  fixtureCache.set(key, out);
  return out;
}

// A minimal DB with hand-written track rows: this module reads
// tracks+libraries and nothing else, so a real scan would only add
// runtime and a rust-binary dependency the fallback itself doesn't have.
async function makeCase(tracks) {
  const root = path.join(tmp, `case-${seq++}`);
  const lib = path.join(root, 'music');
  const cache = path.join(root, 'wfcache');
  await fsp.mkdir(lib, { recursive: true });
  await fsp.mkdir(cache, { recursive: true });

  const db = new DatabaseSync(path.join(root, 'wf.db'));
  for (const m of MIGRATIONS) { db.exec(m.sql); db.exec(`PRAGMA user_version = ${m.version}`); }
  db.prepare('INSERT INTO libraries (id, name, root_path) VALUES (1, ?, ?)').run('lib', lib);

  for (const t of tracks) {
    if (t.create !== false) {
      const src = await fixtureFor(t.name, t.codec, t.freq || 440);
      await fsp.copyFile(src, path.join(lib, t.name));
    }
    db.prepare(`INSERT INTO tracks (library_id, filepath, title, audio_hash)
                VALUES (1, ?, ?, ?)`).run(t.name, t.name, t.hash);
  }
  return { db, lib, cache };
}

const newAbort = () => ({ stopped: false });

describe('waveform ffmpeg fallback', () => {
  test('generates a waveform for Opus, which symphonia cannot decode', { timeout: 240_000 }, async (t) => {
    if (!ffmpegOk) { return t.skip('no bundled ffmpeg'); }
    const { db, cache } = await makeCase([{ name: 'a.opus', hash: 'aaa' }]);

    const res = await run({ db, cacheDir: cache, ffmpegBin: FFMPEG, abort: newAbort() });
    db.close();

    assert.equal(res.total, 1);
    assert.equal(res.generated, 1);
    assert.equal(res.failed, 0);
    const buf = fs.readFileSync(cacheFilePath(cache, 'aaa'));
    assert.equal(buf.length, NUM_BARS, 'cache file must be exactly NUM_BARS bytes');
    assert.ok(Math.max(...buf) > 0, 'a 440 Hz tone must produce real peaks');
    assert.ok(!fs.existsSync(failedMarkerPath(cache, 'aaa')), 'success leaves no marker');
  });

  test('mp3s are left to the rust pass; only unsupported codecs are picked up', { timeout: 240_000 }, async (t) => {
    if (!ffmpegOk) { return t.skip('no bundled ffmpeg'); }
    const { db, cache } = await makeCase([
      { name: 'a.opus', hash: 'aaa' },
      { name: 'b.mp3', hash: 'bbb', freq: 880 },
    ]);

    const res = await run({ db, cacheDir: cache, ffmpegBin: FFMPEG, abort: newAbort() });
    db.close();

    assert.equal(res.total, 1, 'the mp3 is the rust pass’s work, not ours');
    assert.ok(fs.existsSync(cacheFilePath(cache, 'aaa')));
    assert.ok(!fs.existsSync(cacheFilePath(cache, 'bbb')));
  });

  test('an already-cached key is skipped', { timeout: 240_000 }, async (t) => {
    if (!ffmpegOk) { return t.skip('no bundled ffmpeg'); }
    const { db, cache } = await makeCase([{ name: 'a.opus', hash: 'aaa' }]);
    await fsp.writeFile(cacheFilePath(cache, 'aaa'), Buffer.alloc(NUM_BARS, 7));

    const res = await run({ db, cacheDir: cache, ffmpegBin: FFMPEG, abort: newAbort() });
    db.close();

    assert.equal(res.total, 0, 'nothing to do');
    assert.equal(fs.readFileSync(cacheFilePath(cache, 'aaa'))[0], 7, 'existing cache untouched');
  });

  test('a symphonia-only marker is retried and cleared when ffmpeg succeeds', { timeout: 240_000 }, async (t) => {
    if (!ffmpegOk) { return t.skip('no bundled ffmpeg'); }
    // An mp3 symphonia choked on: not an unsupported codec, so it only
    // reaches the fallback via its marker.
    const { db, cache } = await makeCase([{ name: 'b.mp3', hash: 'bbb' }]);
    await fsp.writeFile(failedMarkerPath(cache, 'bbb'), 'symphonia\n');

    const res = await run({ db, cacheDir: cache, ffmpegBin: FFMPEG, abort: newAbort() });
    db.close();

    assert.equal(res.generated, 1, 'ffmpeg decodes plenty symphonia will not');
    assert.ok(fs.existsSync(cacheFilePath(cache, 'bbb')));
    assert.ok(!fs.existsSync(failedMarkerPath(cache, 'bbb')),
      'a marker that is no longer true must be removed');
  });

  test('a marker naming ffmpeg is not retried', { timeout: 240_000 }, async (t) => {
    if (!ffmpegOk) { return t.skip('no bundled ffmpeg'); }
    const { db, cache } = await makeCase([{ name: 'a.opus', hash: 'aaa' }]);
    await fsp.writeFile(failedMarkerPath(cache, 'aaa'), 'symphonia\nffmpeg\n');

    const res = await run({ db, cacheDir: cache, ffmpegBin: FFMPEG, abort: newAbort() });
    db.close();

    assert.equal(res.total, 0, 'ffmpeg already rendered its verdict on this content');
    assert.ok(!fs.existsSync(cacheFilePath(cache, 'aaa')));
  });

  test('undecodable content records an ffmpeg failure exactly once', { timeout: 240_000 }, async (t) => {
    if (!ffmpegOk) { return t.skip('no bundled ffmpeg'); }
    const { db, cache, lib } = await makeCase([{ name: 'a.opus', hash: 'aaa', create: false }]);
    await fsp.writeFile(path.join(lib, 'a.opus'), 'this is not an opus stream');

    const first = await run({ db, cacheDir: cache, ffmpegBin: FFMPEG, abort: newAbort() });
    assert.equal(first.failed, 1);
    assert.match(fs.readFileSync(failedMarkerPath(cache, 'aaa'), 'utf8'), /ffmpeg/);

    // Second pass must see the marker and not spawn ffmpeg again.
    const second = await run({ db, cacheDir: cache, ffmpegBin: FFMPEG, abort: newAbort() });
    db.close();
    assert.equal(second.total, 0, 'a recorded failure is not re-attempted');
  });

  test('duplicate content decodes once; a vanished copy falls through to a live one', { timeout: 240_000 }, async (t) => {
    if (!ffmpegOk) { return t.skip('no bundled ffmpeg'); }
    const { db, cache, lib } = await makeCase([
      { name: 'gone.opus', hash: 'dup' },
      { name: 'alive.opus', hash: 'dup' },
    ]);
    fs.rmSync(path.join(lib, 'gone.opus'));

    const res = await run({ db, cacheDir: cache, ffmpegBin: FFMPEG, abort: newAbort() });
    db.close();

    assert.equal(res.total, 1, 'two rows, one content key, one unit of work');
    assert.equal(res.generated, 1, 'the surviving copy carried it');
    assert.ok(fs.existsSync(cacheFilePath(cache, 'dup')));
  });

  test('a key whose every copy has vanished leaves no marker', { timeout: 240_000 }, async (t) => {
    if (!ffmpegOk) { return t.skip('no bundled ffmpeg'); }
    const { db, cache, lib } = await makeCase([{ name: 'a.opus', hash: 'aaa' }]);
    fs.rmSync(path.join(lib, 'a.opus'));

    const res = await run({ db, cacheDir: cache, ffmpegBin: FFMPEG, abort: newAbort() });
    db.close();

    assert.equal(res.generated, 0);
    assert.equal(res.failed, 0, 'a missing file is the sweep’s business, not a decode failure');
    assert.ok(!fs.existsSync(failedMarkerPath(cache, 'aaa')),
      'the file may come back unchanged — do not poison the key');
  });

  test('abort stops the run without generating anything further', { timeout: 240_000 }, async (t) => {
    if (!ffmpegOk) { return t.skip('no bundled ffmpeg'); }
    const { db, cache } = await makeCase([
      { name: 'a.opus', hash: 'aaa' },
      { name: 'b.opus', hash: 'bbb', freq: 660 },
      { name: 'c.opus', hash: 'ccc', freq: 880 },
    ]);

    const abort = { stopped: true };   // as if shutdown landed before the first item
    const res = await run({ db, cacheDir: cache, ffmpegBin: FFMPEG, abort });
    db.close();

    assert.equal(res.total, 3, 'the plan is still reported');
    assert.equal(res.generated, 0, 'but no work is started');
    assert.equal(fs.readdirSync(cache).length, 0);
  });

  // ── Regressions from the adversarial review of PR #818 ────────────────────

  test('an unreachable cache dir reports zero DURABLE progress — the self-chain spin guard', { timeout: 240_000 }, async (t) => {
    if (!ffmpegOk) { return t.skip('no bundled ffmpeg'); }
    // The dir vanished after boot (unmounted volume, deleted tree). Every
    // decode succeeds but nothing can persist; the old chain gate counted
    // the attempt-failures as progress and re-forked the whole pass
    // forever against a byte-identical plan.
    const { db, lib } = await makeCase([{ name: 'a.opus', hash: 'aaa' }]);
    const gone = path.join(path.dirname(lib), 'cache-that-vanished');

    const r1 = await run({ db, cacheDir: gone, ffmpegBin: FFMPEG, abort: newAbort() });
    const r2 = await run({ db, cacheDir: gone, ffmpegBin: FFMPEG, abort: newAbort() });
    db.close();

    for (const r of [r1, r2]) {
      assert.equal(r.total, 1, 'the work was genuinely attempted, not skipped');
      assert.equal(r.generated, 0);
      assert.equal(r.failed, 0,
        'a write that could not land is not a decode verdict on the audio');
      assert.equal(r.markersRecorded, 0,
        'a marker that never landed must not be counted as durable progress');
    }
    assert.ok(!fs.existsSync(gone), 'nothing was persisted anywhere');
    assert.equal(shouldChain({ ...r1, capped: true }, null), false,
      'the chain gate must refuse a round that landed nothing');
  });

  test('a cache-write failure is NOT recorded as ffmpeg’s verdict on the audio', { timeout: 240_000 }, async (t) => {
    if (!ffmpegOk) { return t.skip('no bundled ffmpeg'); }
    const { db, lib } = await makeCase([{ name: 'good.opus', hash: 'aaa' }]);
    // The cache "directory" is a FILE. Every write into it fails, and —
    // unlike obstructing the final path with a directory — planWork cannot
    // mistake the obstruction for a cache hit. That mattered: the first
    // version of this test planted a directory named <key>.w2.bin, which
    // planWork classifies as cached by suffix alone, so the run did NOTHING
    // and every assertion passed vacuously on reverted code.
    const cache = path.join(path.dirname(lib), 'cache-is-a-file');
    await fsp.writeFile(cache, 'not a directory');

    const res = await run({ db, cacheDir: cache, ffmpegBin: FFMPEG, abort: newAbort() });

    assert.equal(res.total, 1, 'the decode really ran — otherwise this test proves nothing');
    assert.equal(res.generated, 0, 'the write could not land');
    assert.equal(res.failed, 0, 'a disk error is not a decode failure');
    assert.equal(res.markersRecorded, 0);

    // Replace the obstruction with a real directory: the very next pass
    // succeeds, proving the disk error was never remembered anywhere.
    await fsp.rm(cache);
    await fsp.mkdir(cache, { recursive: true });
    const retry = await run({ db, cacheDir: cache, ffmpegBin: FFMPEG, abort: newAbort() });
    db.close();
    assert.equal(retry.generated, 1, 'nothing durable blocked the retry');
    assert.ok(!fs.existsSync(failedMarkerPath(cache, 'aaa')),
      'ffmpeg decoded this file fine — a marker would be a lie no pass ever clears');
    assert.equal(fs.readFileSync(cacheFilePath(cache, 'aaa')).length, NUM_BARS);
  });

  test('an undecodable file whose marker cannot be written counts no durable progress', { timeout: 240_000 }, async (t) => {
    if (!ffmpegOk) { return t.skip('no bundled ffmpeg'); }
    // Pins recordFfmpegFailure's boolean return AND the markersRecorded
    // gate, in both directions: the decode genuinely fails (so `failed`
    // must rise) but the marker cannot land (so `markersRecorded` must
    // not, and the chain must refuse).
    const { db, lib } = await makeCase([{ name: 'junk.opus', hash: 'aaa', create: false }]);
    await fsp.writeFile(path.join(lib, 'junk.opus'), 'this is not an opus stream');
    const cache = path.join(path.dirname(lib), 'cache-file-2');
    await fsp.writeFile(cache, 'not a directory');

    const res = await run({ db, cacheDir: cache, ffmpegBin: FFMPEG, abort: newAbort() });
    db.close();

    assert.equal(res.total, 1);
    assert.equal(res.failed, 1, 'the content really is undecodable');
    assert.equal(res.markersRecorded, 0, 'but no marker landed, so nothing durable happened');
    assert.equal(shouldChain({ ...res, capped: true }, null), false,
      'a round that recorded nothing must not chain');
  });

  test('an unreadable file is not given a permanent ffmpeg verdict', { timeout: 240_000 }, async (t) => {
    if (!ffmpegOk) { return t.skip('no bundled ffmpeg'); }
    // A path that exists but cannot be READ — a lock, an ACL change, a
    // stale mount. ffmpeg exits non-zero exactly as it would for corrupt
    // audio, and treating that as a content verdict wrote a marker nothing
    // ever clears: the key left every future plan and the endpoint 500'd
    // on it forever. A directory standing in for the file reproduces the
    // stat-succeeds-read-fails shape portably.
    const { db, cache, lib } = await makeCase([{ name: 'locked.opus', hash: 'aaa', create: false }]);
    fs.mkdirSync(path.join(lib, 'locked.opus'));

    const res = await run({ db, cacheDir: cache, ffmpegBin: FFMPEG, abort: newAbort() });

    assert.equal(res.failed, 0, 'unreadable is not undecodable');
    assert.equal(res.markersRecorded, 0);
    assert.ok(!fs.existsSync(failedMarkerPath(cache, 'aaa')),
      'a terminal marker here would strand the track forever');

    // The obstruction clears (permissions restored, mount back): the very
    // next pass must be able to generate.
    fs.rmdirSync(path.join(lib, 'locked.opus'));
    await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=48000',
      '-c:a', 'libopus', '-b:a', '64k', '-f', 'opus', path.join(lib, 'locked.opus')]);
    const retry = await run({ db, cacheDir: cache, ffmpegBin: FFMPEG, abort: newAbort() });
    db.close();
    assert.equal(retry.generated, 1, 'the key must still be reachable once readable again');
  });

  test('a deferred artifact routes the key here whatever its container', { timeout: 240_000 }, async (t) => {
    if (!ffmpegOk) { return t.skip('no bundled ffmpeg'); }
    // The rust pass writes a `.w2.deferred` artifact for a codec it has no
    // decoder for. The container may be one CANDIDATE_EXTS never queries
    // (5.1 or HE-AAC in .m4a/.m4b/.aac), so that artifact is the ONLY route
    // to a waveform — routing by extension alone left those files uncovered
    // by both passes.
    const { db, cache, lib } = await makeCase([{ name: 'multi.m4a', hash: 'aaa', create: false }]);
    await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=48000',
      '-ac', '6', '-c:a', 'aac', '-b:a', '192k', path.join(lib, 'multi.m4a')]);
    await fsp.writeFile(deferredMarkerPath(cache, 'aaa'), 'no-decoder\n');

    const res = await run({ db, cacheDir: cache, ffmpegBin: FFMPEG, abort: newAbort() });
    db.close();

    assert.equal(res.total, 1, '.m4a is not in CANDIDATE_EXTS — the deferral is what found it');
    assert.equal(res.generated, 1);
    assert.equal(fs.readFileSync(cacheFilePath(cache, 'aaa')).length, NUM_BARS);
    assert.ok(!fs.existsSync(deferredMarkerPath(cache, 'aaa')),
      'success clears the deferral so the key stops being replanned');
    assert.ok(!fs.existsSync(failedMarkerPath(cache, 'aaa')),
      'and a deferral must never have been a failure');
  });

  test('an unreadable copy does not end the walk while a good copy remains', { timeout: 240_000 }, async (t) => {
    if (!ffmpegOk) { return t.skip('no bundled ffmpeg'); }
    const { db, cache, lib } = await makeCase([
      { name: 'bad.opus', hash: 'dup2', create: false },
      { name: 'zz-good.opus', hash: 'dup2' },
    ]);
    // The bad copy EXISTS (existsSync true) but cannot be decoded — a
    // directory stands in for a permission-denied or rotted file. The old
    // walk returned on the first non-transient failure and wrote a
    // terminal ffmpeg marker with the good copy still on disk.
    fs.mkdirSync(path.join(lib, 'bad.opus'));

    const res = await run({ db, cacheDir: cache, ffmpegBin: FFMPEG, abort: newAbort() });
    db.close();

    assert.equal(res.generated, 1, 'the good copy must be tried and carry the key');
    assert.equal(res.failed, 0);
    assert.ok(fs.existsSync(cacheFilePath(cache, 'dup2')));
    assert.ok(!fs.existsSync(failedMarkerPath(cache, 'dup2')));
  });

  test('opus inside a .ogg container is picked up via the extension source', { timeout: 240_000 }, async (t) => {
    if (!ffmpegOk) { return t.skip('no bundled ffmpeg'); }
    // The rust pass probes these, finds no decoder, and skips them
    // silently (no marker) — so the ONLY route to a waveform is this
    // pass noticing the extension. A vorbis .ogg the rust pass already
    // cached must not be re-decoded.
    const { db, cache } = await makeCase([{ name: 'hidden.ogg', hash: 'ogg1', codec: 'opus' }]);
    await fsp.writeFile(cacheFilePath(cache, 'vorbis1'), Buffer.alloc(NUM_BARS, 3));
    db.prepare(`INSERT INTO tracks (library_id, filepath, title, audio_hash)
                VALUES (1, 'cached.ogg', 'cached.ogg', 'vorbis1')`).run();

    const res = await run({ db, cacheDir: cache, ffmpegBin: FFMPEG, abort: newAbort() });
    db.close();

    assert.equal(res.total, 1, 'only the uncached ogg is work; the cached one is excluded');
    assert.equal(res.generated, 1);
    const buf = fs.readFileSync(cacheFilePath(cache, 'ogg1'));
    assert.equal(buf.length, NUM_BARS);
    assert.ok(Math.max(...buf) > 0, 'the hidden Opus stream produced real peaks');
    assert.equal(fs.readFileSync(cacheFilePath(cache, 'vorbis1'))[0], 3, 'cached entry untouched');
  });

  test('shouldChain: only durable, shrinking progress justifies another round', () => {
    const base = { capped: true, generated: 0, markersRecorded: 0, backlog: 1000 };
    assert.equal(shouldChain({ ...base }, null), false, 'attempts alone never chain');
    assert.equal(shouldChain({ ...base, generated: 5 }, null), true, 'landed cache files chain');
    assert.equal(shouldChain({ ...base, markersRecorded: 5 }, null), true, 'landed markers chain');
    assert.equal(shouldChain({ ...base, generated: 5, capped: false }, null), false,
      'an uncapped run finished the backlog — nothing to chain');
    assert.equal(shouldChain({ ...base, generated: 5, backlog: 1000 }, 1000), false,
      'a backlog that failed to shrink stops the chain even with progress claimed');
    assert.equal(shouldChain({ ...base, generated: 5, backlog: 500 }, 1000), true,
      'a genuinely shrinking backlog keeps draining');
  });
});
