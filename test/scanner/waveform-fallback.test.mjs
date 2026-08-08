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
import { run } from '../../src/db/waveform-fallback.js';
import {
  NUM_BARS, cacheFilePath, failedMarkerPath,
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
      await runFfmpeg([
        '-f', 'lavfi', '-i', `sine=frequency=${t.freq || 440}:duration=1:sample_rate=48000`,
        ...(t.name.endsWith('.opus')
          ? ['-c:a', 'libopus', '-b:a', '64k', '-f', 'opus']
          : ['-c:a', 'libmp3lame', '-b:a', '64k']),
        path.join(lib, t.name),
      ]);
    }
    db.prepare(`INSERT INTO tracks (library_id, filepath, title, audio_hash)
                VALUES (1, ?, ?, ?)`).run(t.name, t.name, t.hash);
  }
  return { db, lib, cache };
}

const newAbort = () => ({ stopped: false });

describe('waveform ffmpeg fallback', () => {
  test('generates a waveform for Opus, which symphonia cannot decode', { timeout: 60_000 }, async (t) => {
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

  test('mp3s are left to the rust pass; only unsupported codecs are picked up', { timeout: 60_000 }, async (t) => {
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

  test('an already-cached key is skipped', { timeout: 60_000 }, async (t) => {
    if (!ffmpegOk) { return t.skip('no bundled ffmpeg'); }
    const { db, cache } = await makeCase([{ name: 'a.opus', hash: 'aaa' }]);
    await fsp.writeFile(cacheFilePath(cache, 'aaa'), Buffer.alloc(NUM_BARS, 7));

    const res = await run({ db, cacheDir: cache, ffmpegBin: FFMPEG, abort: newAbort() });
    db.close();

    assert.equal(res.total, 0, 'nothing to do');
    assert.equal(fs.readFileSync(cacheFilePath(cache, 'aaa'))[0], 7, 'existing cache untouched');
  });

  test('a symphonia-only marker is retried and cleared when ffmpeg succeeds', { timeout: 60_000 }, async (t) => {
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

  test('a marker naming ffmpeg is not retried', { timeout: 60_000 }, async (t) => {
    if (!ffmpegOk) { return t.skip('no bundled ffmpeg'); }
    const { db, cache } = await makeCase([{ name: 'a.opus', hash: 'aaa' }]);
    await fsp.writeFile(failedMarkerPath(cache, 'aaa'), 'symphonia\nffmpeg\n');

    const res = await run({ db, cacheDir: cache, ffmpegBin: FFMPEG, abort: newAbort() });
    db.close();

    assert.equal(res.total, 0, 'ffmpeg already rendered its verdict on this content');
    assert.ok(!fs.existsSync(cacheFilePath(cache, 'aaa')));
  });

  test('undecodable content records an ffmpeg failure exactly once', { timeout: 60_000 }, async (t) => {
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

  test('duplicate content decodes once; a vanished copy falls through to a live one', { timeout: 60_000 }, async (t) => {
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

  test('a key whose every copy has vanished leaves no marker', { timeout: 60_000 }, async (t) => {
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

  test('abort stops the run without generating anything further', { timeout: 60_000 }, async (t) => {
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
});
