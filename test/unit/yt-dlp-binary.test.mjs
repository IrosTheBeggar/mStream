/**
 * src/util/yt-dlp.js — resolving and checking the executable. Which yt-dlp
 * runs is a config-file setting (never editable through the admin API), so
 * what the youtube plug-in's probe reports for a bad one is pinned here
 * rather than through the admin routes: a missing path, a file that exists
 * but cannot be run, and a file named like a program that is not one.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ytdlp from '../../src/util/yt-dlp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(__dirname, '..', 'helpers', 'fake-yt-dlp.mjs');

let dir;
let savedHook;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-ytdlp-bin-'));
  savedHook = process.env.MSTREAM_YTDLP_BIN;
  delete process.env.MSTREAM_YTDLP_BIN;   // the configured value decides, as on a real server
});
after(() => {
  if (savedHook === undefined) { delete process.env.MSTREAM_YTDLP_BIN; } else { process.env.MSTREAM_YTDLP_BIN = savedHook; }
  if (dir) { fs.rmSync(dir, { recursive: true, force: true }); }
});

describe('the yt-dlp executable', () => {
  test('resolveBinary: the default, a name on PATH, a path, and the test hook that outranks them', () => {
    assert.deepEqual(ytdlp.resolveBinary(undefined), { cmd: 'yt-dlp', prefix: [] });
    assert.deepEqual(ytdlp.resolveBinary('   '), { cmd: 'yt-dlp', prefix: [] });
    assert.deepEqual(ytdlp.resolveBinary('yt-dlp-nightly'), { cmd: 'yt-dlp-nightly', prefix: [] });
    assert.deepEqual(ytdlp.resolveBinary('/opt/yt-dlp/yt-dlp'), { cmd: '/opt/yt-dlp/yt-dlp', prefix: [] });
    process.env.MSTREAM_YTDLP_BIN = FAKE;
    try {
      assert.deepEqual(ytdlp.resolveBinary('/opt/yt-dlp/yt-dlp'), { cmd: process.execPath, prefix: [FAKE], script: FAKE }, 'a script hook runs under node');
      process.env.MSTREAM_YTDLP_BIN = '/tmp/some-yt-dlp';
      assert.deepEqual(ytdlp.resolveBinary('/opt/yt-dlp/yt-dlp'), { cmd: '/tmp/some-yt-dlp', prefix: [] }, 'a binary hook is used as is');
    } finally {
      delete process.env.MSTREAM_YTDLP_BIN;
    }
  });

  test('a path that is not there is not available; a file that exists is, until it is run', async () => {
    assert.equal(await ytdlp.isAvailable(ytdlp.resolveBinary(path.join(dir, 'still-not-here'))), false);
    // The stand-in script EXISTS, but without the env hook nothing runs it
    // under node — the case that used to pass a naive probe and then fail
    // every job with "spawn EFTYPE".
    const script = ytdlp.resolveBinary(FAKE);
    assert.equal(await ytdlp.isAvailable(script), true, 'exists');
    await assert.rejects(ytdlp.version(script), (err) => {
      assert.doesNotMatch(err.message, /not found/, 'it exists; the message says it cannot be run');
      return true;
    });
  });

  test('startDownload never adopts a file that was already in the folder', async () => {
    // The stand-in "downloads" by copying a fixture to <dir>/<title>.mp3 and
    // printing that path — as yt-dlp prints an existing file's path when
    // --no-overwrites made it skip the fetch. The snapshot taken before the
    // run is what tells the two apart.
    const fixture = path.join(dir, 'fixture.mp3');
    fs.writeFileSync(fixture, 'the download');
    const out = path.join(dir, 'out');
    fs.mkdirSync(out, { recursive: true });
    const bin = { cmd: process.execPath, prefix: [FAKE] };
    const saved = { script: process.env.MSTREAM_FAKE_YTDLP_SCRIPT, fixture: process.env.MSTREAM_FAKE_YTDLP_FIXTURE };
    delete process.env.MSTREAM_FAKE_YTDLP_SCRIPT;
    process.env.MSTREAM_FAKE_YTDLP_FIXTURE = fixture;
    try {
      const fresh = await ytdlp.startDownload({ bin, url: 'https://www.youtube.com/watch?v=abcdefghijk', dir: out, codec: 'mp3' }).done;
      assert.equal(path.basename(fresh.filePath), 'Unknown_Upload.mp3', 'a new file is the download');
      // Now that file is "already there": a second run must not hand it back.
      fs.writeFileSync(fresh.filePath, 'somebody else\'s file');
      await assert.rejects(ytdlp.startDownload({ bin, url: 'https://www.youtube.com/watch?v=abcdefghijk', dir: out, codec: 'mp3' }).done,
        (err) => err.exists === true && /already exists/.test(err.message));
    } finally {
      if (saved.script === undefined) { delete process.env.MSTREAM_FAKE_YTDLP_SCRIPT; } else { process.env.MSTREAM_FAKE_YTDLP_SCRIPT = saved.script; }
      if (saved.fixture === undefined) { delete process.env.MSTREAM_FAKE_YTDLP_FIXTURE; } else { process.env.MSTREAM_FAKE_YTDLP_FIXTURE = saved.fixture; }
    }
  });

  test('startDownload enforces the size cap and the wall clock itself, whatever yt-dlp fetches', async () => {
    const fixture = path.join(dir, 'fixture2.mp3');
    fs.writeFileSync(fixture, 'the download');
    const bin = { cmd: process.execPath, prefix: [FAKE] };
    const script = path.join(dir, 'script.json');
    const saved = { script: process.env.MSTREAM_FAKE_YTDLP_SCRIPT, fixture: process.env.MSTREAM_FAKE_YTDLP_FIXTURE };
    process.env.MSTREAM_FAKE_YTDLP_SCRIPT = script;
    process.env.MSTREAM_FAKE_YTDLP_FIXTURE = fixture;
    try {
      // A fragment of 3 MB lands first and the "download" idles: past a 1 MB
      // cap the folder is measured and the tree is killed.
      const outA = path.join(dir, 'cap');
      fs.mkdirSync(outA, { recursive: true });
      fs.writeFileSync(script, JSON.stringify({ download: { partBytes: 3 * 1024 * 1024, slowMs: 1500 } }));
      const t0 = Date.now();
      await assert.rejects(ytdlp.startDownload({ bin, url: 'https://www.youtube.com/watch?v=abcdefghijk', dir: outA, codec: 'mp3', maxFilesizeMb: 1 }).done,
        (err) => err.stopped === true && /passed the 1 MB size cap/.test(err.message));
      assert.ok(Date.now() - t0 < 6000, 'stopped by the poll, not by the fake finishing');
      // A run that outlives its wall clock is stopped the same way.
      const outB = path.join(dir, 'clock');
      fs.mkdirSync(outB, { recursive: true });
      fs.writeFileSync(script, JSON.stringify({ download: { slowMs: 800 } }));
      await assert.rejects(ytdlp.startDownload({ bin, url: 'https://www.youtube.com/watch?v=abcdefghijk', dir: outB, codec: 'mp3', maxSeconds: 1 }).done,
        (err) => err.stopped === true && /took longer than/.test(err.message));
      // Within both, the download lands as before.
      const outC = path.join(dir, 'fine');
      fs.mkdirSync(outC, { recursive: true });
      fs.writeFileSync(script, JSON.stringify({ download: {} }));
      const ok = await ytdlp.startDownload({ bin, url: 'https://www.youtube.com/watch?v=abcdefghijk', dir: outC, codec: 'mp3', maxFilesizeMb: 1, maxSeconds: 30 }).done;
      assert.equal(path.basename(ok.filePath), 'Unknown_Upload.mp3');
    } finally {
      if (saved.script === undefined) { delete process.env.MSTREAM_FAKE_YTDLP_SCRIPT; } else { process.env.MSTREAM_FAKE_YTDLP_SCRIPT = saved.script; }
      if (saved.fixture === undefined) { delete process.env.MSTREAM_FAKE_YTDLP_FIXTURE; } else { process.env.MSTREAM_FAKE_YTDLP_FIXTURE = saved.fixture; }
    }
  });

  test('a file named like a program that is not one says so, on every platform', async () => {
    // Windows answers this with the bare code UNKNOWN, the others with EACCES
    // or ENOEXEC: one sentence for all of them.
    const impostor = path.join(dir, 'yt-dlp-impostor.exe');
    fs.writeFileSync(impostor, 'not a program', { mode: 0o644 });
    const bin = ytdlp.resolveBinary(impostor);
    assert.equal(await ytdlp.isAvailable(bin), true);
    await assert.rejects(ytdlp.version(bin), /is not something this system can run \(\w+\)$/);
  });
});
