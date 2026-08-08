/**
 * The waveform enrichment pass (`rust-parser --waveform-scan`) and the
 * on-demand endpoint's full-length generation.
 *
 * Pass coverage: generates one cache file per distinct content hash after
 * a real scan, is idempotent (second run plans zero), leaves codecs
 * symphonia cannot decode (Opus) OUT of the plan entirely rather than
 * marking them failed — the ffmpeg fallback owns those — skips vanished
 * files without burning a marker, and honours the schema-version guard
 * (exit 3).
 *
 * Endpoint coverage: generateWaveformBars must cover the WHOLE track —
 * the old implementation buffered 2 MB of 8 kHz PCM and silently
 * truncated anything past ~262s, then cached the wrong waveform
 * permanently. The fixture puts the tone in the last 50s of a 300s file:
 * under truncation those bars read silent, under full coverage they
 * peak. Failure markers round-trip through the lib helpers.
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

import { MIGRATIONS, SCHEMA_VERSION } from '../../src/db/schema.js';
import {
  generateWaveformBars, NUM_BARS, CACHE_EXT, FAILED_EXT,
  cacheFilePath, failedMarkerPath,
  hasFfmpegFailedMarker, recordFfmpegFailure, clearFailedMarker,
  sweepSupersededArtifacts, probeWaveformGeneration,
} from '../../src/db/waveform-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FFMPEG = path.join(REPO_ROOT, 'bin', 'ffmpeg',
  process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

function findRustParser() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const libc = process.platform === 'linux' ? '-musl' : '';
  const localBuild = path.join(REPO_ROOT, 'rust-parser', 'target', 'release', `rust-parser${ext}`);
  const prebuilt = path.join(REPO_ROOT, 'bin', 'rust-parser',
    `rust-parser-${process.platform}-${process.arch}${libc}${ext}`);

  // A LOCAL build is something this checkout produced on purpose (CI builds
  // one on every leg), so a generation mismatch there is a real defect —
  // a stale target/, or WAVEFORM_EXT and CACHE_EXT drifting apart — and
  // must FAIL, not quietly skip the whole suite green.
  if (fs.existsSync(localBuild)) {
    const gen = probeWaveformGeneration(localBuild);
    assert.equal(gen, CACHE_EXT,
      `local rust-parser build writes waveform generation ${gen} but the server ` +
      `expects ${CACHE_EXT} — run: cargo build --release --manifest-path rust-parser/Cargo.toml`);
    return localBuild;
  }
  // Only the committed prebuilt is available. CI rebuilds those on pushes
  // to master, so a mismatch here is the expected lag window after a
  // generation bump: skipping is the truthful result.
  if (fs.existsSync(prebuilt) && probeWaveformGeneration(prebuilt) === CACHE_EXT) {
    return prebuilt;
  }
  return null;
}

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

function spawnJson(bin, args) {
  return new Promise((resolve) => {
    const p = child.spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => resolve({ code, out, err }));
  });
}

function lastEvent(out, name) {
  const line = out.split('\n').map(l => l.trim()).filter(Boolean)
    .reverse().find(l => l.includes(`"${name}"`));
  return line ? JSON.parse(line) : null;
}

let tmp;
let rustBin;
const ffmpegOk = fs.existsSync(FFMPEG);

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'wfscan-test-'));
  rustBin = findRustParser();
});

after(async () => {
  if (tmp) { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
});

describe('rust-parser --waveform-scan (the enrichment pass)', () => {
  let dbPath;
  let lib;
  let cache;

  let setupSeq = 0;
  async function setupScannedLibrary(t) {
    if (!ffmpegOk) { t.skip('no bundled ffmpeg'); return false; }
    if (!rustBin)  { t.skip('no rust-parser binary'); return false; }
    const root = path.join(tmp, `case-${setupSeq++}`);
    lib = path.join(root, 'music');
    cache = path.join(root, 'wfcache');
    dbPath = path.join(root, 'wf.db');
    await fsp.mkdir(lib, { recursive: true });
    // Three distinct tones (distinct hashes) + one Opus (symphonia has no
    // decoder → must be left out of the plan entirely, no marker).
    for (const [name, freq] of [['a.mp3', 220], ['b.mp3', 440], ['c.mp3', 880]]) {
      await runFfmpeg(['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=1:sample_rate=44100`,
        '-c:a', 'libmp3lame', '-b:a', '64k', path.join(lib, name)]);
    }
    await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=48000',
      '-c:a', 'libopus', '-b:a', '64k', '-f', 'opus', path.join(lib, 'd.opus')]);

    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    for (const m of MIGRATIONS) { db.exec(m.sql); db.exec(`PRAGMA user_version = ${m.version}`); }
    db.prepare('INSERT INTO libraries (id, name, root_path) VALUES (1, ?, ?)').run('wflib', lib);
    db.close();

    const scan = await spawnJson(rustBin, [JSON.stringify({
      dbPath, libraryId: 1, vpath: 'wflib', directory: lib,
      skipImg: true, albumArtDirectory: path.join(tmp, 'art'), scanId: 'wf-1',
      compressImage: false, supportedFiles: { mp3: true, opus: true },
      scanCommitInterval: 25, forceRescan: false, followSymlinks: false,
      subtree: '', waveformCacheDir: '', analyzeBpm: false,
      expectedSchemaVersion: SCHEMA_VERSION, scanThreads: 1,
    })]);
    assert.equal(scan.code, 0, `scan should succeed: ${scan.err}`);
    return true;
  }

  const wfConfig = (overrides = {}) => JSON.stringify({
    dbPath, cacheDir: cache, expectedSchemaVersion: SCHEMA_VERSION,
    scanThreads: 1, ...overrides,
  });

  test('generates one 800-byte cache file per decodable track; opus stays out of the plan; idempotent', { timeout: 120_000 }, async (t) => {
    if (!(await setupScannedLibrary(t))) { return; }

    const r = await spawnJson(rustBin, ['--waveform-scan', wfConfig()]);
    assert.equal(r.code, 0, `pass should exit 0: ${r.err}`);
    const complete = lastEvent(r.out, 'waveformScanComplete');
    // The opus is NOT planned: a codec symphonia can't decode is not work
    // for this pass and not a failure. Counting it as one made the admin
    // panel report a permanent failure for a perfectly good file, and the
    // marker it left stopped the key ever being reconsidered.
    assert.equal(complete.total, 3, 'only the three decodable tracks planned');
    assert.equal(complete.generated, 3, 'the three mp3s generated');
    assert.equal(complete.failed, 0, 'nothing failed');

    const names = fs.readdirSync(cache);
    const bins = names.filter(n => n.endsWith(CACHE_EXT));
    const markers = names.filter(n => n.endsWith(FAILED_EXT));
    assert.equal(bins.length, 3);
    assert.equal(markers.length, 0, 'opus must not leave a failure marker');
    for (const b of bins) {
      const buf = fs.readFileSync(path.join(cache, b));
      assert.equal(buf.length, NUM_BARS, `${b} must be exactly ${NUM_BARS} bytes`);
      assert.ok(Math.max(...buf) > 0, `${b} must contain real peaks`);
    }

    // Second run: everything cached or marked — plans zero, touches nothing.
    const before = names.map(n => [n, fs.statSync(path.join(cache, n)).mtimeMs]);
    const r2 = await spawnJson(rustBin, ['--waveform-scan', wfConfig()]);
    assert.equal(r2.code, 0);
    assert.equal(lastEvent(r2.out, 'waveformScanPlan').total, 0, 'rerun plans no work');
    for (const [n, mtime] of before) {
      assert.equal(fs.statSync(path.join(cache, n)).mtimeMs, mtime, `${n} untouched on rerun`);
    }
  });

  test('schema-version guard refuses a mismatched DB with exit 3', { timeout: 60_000 }, async (t) => {
    if (!(await setupScannedLibrary(t))) { return; }
    const r = await spawnJson(rustBin, ['--waveform-scan',
      wfConfig({ expectedSchemaVersion: SCHEMA_VERSION + 1 })]);
    assert.equal(r.code, 3, `expected guard exit 3, got ${r.code}: ${r.err}`);
  });

  test('a file that vanished after the scan is skipped silently — no cache file, no marker', { timeout: 60_000 }, async (t) => {
    if (!(await setupScannedLibrary(t))) { return; }
    fs.rmSync(path.join(lib, 'b.mp3'));
    const r = await spawnJson(rustBin, ['--waveform-scan', wfConfig()]);
    assert.equal(r.code, 0);
    const complete = lastEvent(r.out, 'waveformScanComplete');
    assert.equal(complete.total, 3, 'the vanished file is still planned (row exists)');
    assert.equal(complete.generated, 2, 'two surviving mp3s generated');
    assert.equal(complete.failed, 0, 'a vanished file is not a decode failure');
    const names = fs.readdirSync(cache);
    assert.equal(names.filter(n => n.endsWith(CACHE_EXT)).length, 2);
    assert.equal(names.filter(n => n.endsWith(FAILED_EXT)).length, 0,
      'no marker for the vanished file — it may come back unchanged');
  });

  test('an ffmpeg-only marker does not block the pass; symphonia generates and unblocks the key', { timeout: 60_000 }, async (t) => {
    if (!(await setupScannedLibrary(t))) { return; }
    const db = new DatabaseSync(dbPath);
    const key = db.prepare(
      "SELECT COALESCE(NULLIF(audio_hash, ''), file_hash) AS k FROM tracks WHERE filepath = 'a.mp3'"
    ).get().k;
    db.close();
    // The on-demand endpoint hit a transient quirk and recorded its
    // engine line. The pass must still decode (symphonia ≠ ffmpeg) —
    // the .bin it writes is exactly what un-500s the endpoint.
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(failedMarkerPath(cache, key), 'ffmpeg\n');
    const r = await spawnJson(rustBin, ['--waveform-scan', wfConfig()]);
    assert.equal(r.code, 0);
    assert.ok(fs.existsSync(cacheFilePath(cache, key)),
      'ffmpeg-only marker must not exclude the key from the pass');
    const r2 = await spawnJson(rustBin, ['--waveform-scan', wfConfig()]);
    assert.equal(lastEvent(r2.out, 'waveformScanPlan').total, 0, 'rerun plans no work');
  });

  test('a symphonia marker keeps its key out of the plan', { timeout: 60_000 }, async (t) => {
    if (!(await setupScannedLibrary(t))) { return; }
    const db = new DatabaseSync(dbPath);
    const key = db.prepare(
      "SELECT COALESCE(NULLIF(audio_hash, ''), file_hash) AS k FROM tracks WHERE filepath = 'a.mp3'"
    ).get().k;
    db.close();
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(failedMarkerPath(cache, key), 'symphonia\n');
    const r = await spawnJson(rustBin, ['--waveform-scan', wfConfig()]);
    assert.equal(r.code, 0);
    assert.equal(lastEvent(r.out, 'waveformScanPlan').total, 2,
      'the marked key is excluded; the other two mp3s remain');
    assert.ok(!fs.existsSync(cacheFilePath(cache, key)),
      'a symphonia failure is not retried by this pass');
  });

  test('opus hidden in a .ogg container: skipped silently, no marker, left for the fallback', { timeout: 60_000 }, async (t) => {
    if (!(await setupScannedLibrary(t))) { return; }
    // The extension gate can't see this one — symphonia's ogg reader maps
    // the Opus stream happily and only decoder creation fails. It used to
    // be counted failed and marked `symphonia`, misreporting a fine file.
    await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=48000',
      '-c:a', 'libopus', '-b:a', '64k', path.join(lib, 'hidden.ogg')]);
    const rescan = await spawnJson(rustBin, [JSON.stringify({
      dbPath, libraryId: 1, vpath: 'wflib', directory: lib,
      skipImg: true, albumArtDirectory: path.join(tmp, 'art'), scanId: 'wf-ogg',
      compressImage: false, supportedFiles: { mp3: true, opus: true, ogg: true },
      scanCommitInterval: 25, forceRescan: false, followSymlinks: false,
      subtree: '', waveformCacheDir: '', analyzeBpm: false,
      expectedSchemaVersion: SCHEMA_VERSION, scanThreads: 1,
    })]);
    assert.equal(rescan.code, 0, rescan.err);
    const db = new DatabaseSync(dbPath);
    const key = db.prepare(
      "SELECT COALESCE(NULLIF(audio_hash, ''), file_hash) AS k FROM tracks WHERE filepath = 'hidden.ogg'"
    ).get().k;
    db.close();

    const r = await spawnJson(rustBin, ['--waveform-scan', wfConfig()]);
    assert.equal(r.code, 0, r.err);
    const complete = lastEvent(r.out, 'waveformScanComplete');
    assert.equal(complete.total, 4, 'the ogg-opus IS planned — only a probe can classify it');
    assert.equal(complete.generated, 3, 'the three mp3s generated');
    assert.equal(complete.failed, 0, 'a codec with no decoder is not a failure of the file');
    assert.ok(!fs.existsSync(cacheFilePath(cache, key)), 'and symphonia produced no bars');

    // It DOES leave a `no-decoder` marker. That is not a failure line — it
    // is how the key stays reachable: the ffmpeg fallback routes on it, and
    // without it anything undecodable in a container the fallback doesn't
    // query by extension had no route to a waveform from either pass.
    const marker = fs.readFileSync(failedMarkerPath(cache, key), 'utf8');
    assert.match(marker, /no-decoder/);
    assert.doesNotMatch(marker, /symphonia/, 'this is not a decode failure');

    // The marker also stops the endless re-probe: a second pass plans zero
    // for that key rather than re-opening the file on every scan forever.
    const r2 = await spawnJson(rustBin, ['--waveform-scan', wfConfig()]);
    assert.equal(lastEvent(r2.out, 'waveformScanPlan').total, 0,
      'the marker ends the re-probe');

    // And a later ffmpeg success clears it, so the key stops being planned
    // for the right reason.
    fs.writeFileSync(cacheFilePath(cache, key), Buffer.alloc(NUM_BARS, 5));
    fs.rmSync(failedMarkerPath(cache, key));
    const r3 = await spawnJson(rustBin, ['--waveform-scan', wfConfig()]);
    assert.equal(lastEvent(r3.out, 'waveformScanPlan').total, 0, 'cached key stays done');
  });

  test('duplicate content: a vanished first copy does not starve the surviving copy', { timeout: 60_000 }, async (t) => {
    if (!(await setupScannedLibrary(t))) { return; }
    // Two byte-identical files → one content key with two paths. The
    // walk indexes a-copy first (alphabetical), so the dead path wins
    // rowid order — the old single-path dedup starved the live copy.
    fs.copyFileSync(path.join(lib, 'a.mp3'), path.join(lib, 'a-copy1.mp3'));
    fs.renameSync(path.join(lib, 'a.mp3'), path.join(lib, 'zz-survivor.mp3'));
    fs.renameSync(path.join(lib, 'a-copy1.mp3'), path.join(lib, 'aa-vanished.mp3'));
    const rescan = await spawnJson(rustBin, [JSON.stringify({
      dbPath, libraryId: 1, vpath: 'wflib', directory: lib,
      skipImg: true, albumArtDirectory: path.join(tmp, 'art'), scanId: 'wf-2',
      compressImage: false, supportedFiles: { mp3: true, opus: true },
      scanCommitInterval: 25, forceRescan: false, followSymlinks: false,
      subtree: '', waveformCacheDir: '', analyzeBpm: false,
      expectedSchemaVersion: SCHEMA_VERSION, scanThreads: 1,
    })]);
    assert.equal(rescan.code, 0, rescan.err);
    const db = new DatabaseSync(dbPath);
    const key = db.prepare(
      "SELECT COALESCE(NULLIF(audio_hash, ''), file_hash) AS k FROM tracks WHERE filepath = 'zz-survivor.mp3'"
    ).get().k;
    const dupRows = db.prepare(
      "SELECT COUNT(*) AS n FROM tracks WHERE COALESCE(NULLIF(audio_hash, ''), file_hash) = ?"
    ).get(key).n;
    db.close();
    assert.equal(dupRows, 2, 'both copies share one content key');
    fs.rmSync(path.join(lib, 'aa-vanished.mp3'));

    const r = await spawnJson(rustBin, ['--waveform-scan', wfConfig()]);
    assert.equal(r.code, 0);
    assert.ok(fs.existsSync(cacheFilePath(cache, key)),
      'the surviving copy must produce the waveform even when the first path is dead');
    assert.ok(!fs.existsSync(failedMarkerPath(cache, key)),
      'a vanished path is not a decode failure');
  });
});

describe('on-demand generation covers the full track length', () => {
  test('a 300s track with the tone in its LAST 50s peaks in the tail bars', { timeout: 180_000 }, async (t) => {
    if (!ffmpegOk) { return t.skip('no bundled ffmpeg'); }
    // Old behaviour: only the first ~262s of PCM was kept, so the tail
    // tone never reached the waveform — these bars read as silence and
    // the wrong result was cached forever (every Opus user saw it).
    const fixture = path.join(tmp, 'long-tail-tone.mp3');
    await runFfmpeg([
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=44100:duration=250',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=50:sample_rate=44100',
      '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[out]', '-map', '[out]',
      '-c:a', 'libmp3lame', '-b:a', '64k', fixture,
    ]);
    const bars = await generateWaveformBars(fixture, FFMPEG);
    assert.equal(bars.length, NUM_BARS);
    // Tone region: 250s/300s → bars ~667-800. Sample the safe interior.
    const tail = bars.slice(700, 790);
    const middle = bars.slice(200, 600);
    assert.ok(Math.max(...tail) > 15,
      `tail-tone bars must peak (got max ${Math.max(...tail)}) — truncation regression`);
    assert.ok(Math.max(...middle) <= 2,
      `silent middle must stay near zero (got max ${Math.max(...middle)})`);
  });

  test('failure markers round-trip and gate only on the ffmpeg engine line', async () => {
    const dir = path.join(tmp, 'marker-dir');
    await fsp.mkdir(dir, { recursive: true });
    const key = 'deadbeef';
    assert.equal(hasFfmpegFailedMarker(dir, key), false);
    // A symphonia-only marker (written by the rust pass) must NOT gate
    // the ffmpeg endpoint — ffmpeg decodes formats symphonia can't.
    await fsp.writeFile(failedMarkerPath(dir, key), 'symphonia\n');
    assert.equal(hasFfmpegFailedMarker(dir, key), false);
    await recordFfmpegFailure(dir, key);
    assert.equal(hasFfmpegFailedMarker(dir, key), true);
    assert.match(await fsp.readFile(failedMarkerPath(dir, key), 'utf8'), /symphonia/,
      'recording ffmpeg must preserve the symphonia line');
    await clearFailedMarker(dir, key);
    assert.equal(hasFfmpegFailedMarker(dir, key), false);
  });

  // The fix that made all of the above necessary: the generator used to
  // ask ffmpeg for `-ac 1`, which SUMS channels. Anti-phase stereo
  // cancelled to digital silence and the resulting all-zero waveform was
  // cached permanently — a blank progress bar for plainly audible audio.
  test('anti-phase stereo does not cancel to a blank waveform', { timeout: 120_000 }, async (t) => {
    if (!ffmpegOk) { return t.skip('no bundled ffmpeg'); }
    const fixture = path.join(tmp, 'antiphase.flac');
    await runFfmpeg([
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4:sample_rate=44100',
      // split into L and R, invert R — L+R sums to zero everywhere
      '-filter_complex', '[0:a]asplit[l][r];[r]volume=-1[ri];[l][ri]amerge=inputs=2[out]',
      '-map', '[out]', '-c:a', 'flac', fixture,
    ]);
    const bars = await generateWaveformBars(fixture, FFMPEG);
    assert.equal(bars.length, NUM_BARS);
    const nonZero = bars.filter(b => b > 0).length;
    assert.ok(nonZero > NUM_BARS * 0.9,
      `expected a full waveform, got ${nonZero}/${NUM_BARS} non-zero bars — ` +
      `the channels are being summed again`);
    assert.ok(Math.max(...bars) > 20,
      `peaks read ${Math.max(...bars)}/255 — far below the source's level`);
  });

  test('sweepSupersededArtifacts removes previous-generation names only', async () => {
    const dir = path.join(tmp, 'sweep-dir');
    await fsp.mkdir(dir, { recursive: true });
    const hashA = 'a'.repeat(32);
    const hashB = 'b'.repeat(32);
    const hashC = 'c1d2e3f4'.repeat(4);
    const keep = [cacheFilePath(dir, hashA), failedMarkerPath(dir, hashB)];
    const drop = [path.join(dir, `${hashC}.bin`), path.join(dir, `${'d'.repeat(40)}.failed`)];
    // The cache directory is operator-pointable, and `.bin` is not ours
    // alone: cue/bin disc images and ML model weights are real residents
    // of real music folders. Only bare-hex hash names may ever be swept.
    const foreign = [
      path.join(dir, 'pytorch_model.bin'),
      path.join(dir, 'disc1.bin'),
      path.join(dir, 'MyAlbum.failed'),
      path.join(dir, 'DEADBEEF'.repeat(4) + '.bin'),   // uppercase = not a hash we wrote
      path.join(dir, 'README.md'),
    ];
    for (const f of [...keep, ...drop, ...foreign]) { await fsp.writeFile(f, 'x'); }

    assert.equal(await sweepSupersededArtifacts(dir), 2);
    for (const f of keep) { assert.ok(fs.existsSync(f), `${path.basename(f)} must survive`); }
    for (const f of drop) { assert.ok(!fs.existsSync(f), `${path.basename(f)} must be swept`); }
    for (const f of foreign) {
      assert.ok(fs.existsSync(f), `${path.basename(f)} is not ours and must never be deleted`);
    }
    // Idempotent, and a missing directory is not an error.
    assert.equal(await sweepSupersededArtifacts(dir), 0);
    assert.equal(await sweepSupersededArtifacts(path.join(tmp, 'nope')), 0);
  });
});
