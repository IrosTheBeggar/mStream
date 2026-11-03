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
        (err) => err.exists === true && err.reason === 'exists' && /already exists/.test(err.message));
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
        (err) => err.stopped === true && err.reason === 'too-big' && /passed the 1 MB size cap/.test(err.message));
      assert.ok(Date.now() - t0 < 6000, 'stopped by the poll, not by the fake finishing');
      // A run that outlives its wall clock is stopped the same way.
      const outB = path.join(dir, 'clock');
      fs.mkdirSync(outB, { recursive: true });
      fs.writeFileSync(script, JSON.stringify({ download: { slowMs: 800 } }));
      await assert.rejects(ytdlp.startDownload({ bin, url: 'https://www.youtube.com/watch?v=abcdefghijk', dir: outB, codec: 'mp3', maxSeconds: 1 }).done,
        (err) => err.stopped === true && err.reason === 'too-long' && /took longer than/.test(err.message));
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

  test('fileNameFor: the probed stem and the extension the codec lands with', () => {
    const table = { mp3: 'mp3', aac: 'm4a', m4a: 'm4a', m4b: 'm4a', ogg: 'ogg', opus: 'opus', flac: 'flac', wav: 'wav' };
    for (const [codec, ext] of Object.entries(table)) {
      assert.equal(ytdlp.fileNameFor('Remote_Hit', codec), `Remote_Hit.${ext}`, codec);
      assert.equal(ytdlp.outputExtension(codec), ext, `outputExtension(${codec})`);
    }
    assert.equal(ytdlp.fileNameFor(null, 'mp3'), null, 'no stem, no name');
    assert.equal(ytdlp.fileNameFor('', 'mp3'), null);
  });

  test('probe: the record, the route\'s artist and year rule, and the stem of the name a download would get', async () => {
    const script = path.join(dir, 'probe.json');
    const saved = process.env.MSTREAM_FAKE_YTDLP_SCRIPT;
    process.env.MSTREAM_FAKE_YTDLP_SCRIPT = script;
    const bin = { cmd: process.execPath, prefix: [FAKE] };
    try {
      fs.writeFileSync(script, JSON.stringify({ details: {
        song: { id: 'song', title: 'Daft Punk - One More Time (Official Video)', duration: 320, uploader: 'Daft Punk', channel: 'Daft Punk',
          release_date: '20010312', thumbnail: 'https://i.ytimg.com/vi/song/hq.jpg', filesize: 5120 },
        stream: { id: 'stream', title: 'Radio 24/7', is_live: true, live_status: 'is_live', channel: 'Radio' },
        gone: { id: 'gone', title: 'Gone', fail: 'Video unavailable. This video has been removed by the uploader' },
      } }));
      const p = await ytdlp.probe('https://www.youtube.com/watch?v=song', { bin });
      assert.equal(p.fileStem, 'Daft_Punk_-_One_More_Time_Official_Video', 'the source extension is not part of the stem');
      assert.deepEqual([p.title, p.artist, p.year, p.durationSec, p.channel, p.isLive, p.liveStatus, p.bytes],
        ['Daft Punk - One More Time (Official Video)', 'Daft Punk', '2001', 320, 'Daft Punk', false, null, 5120]);
      assert.equal(p.thumbnail, 'https://i.ytimg.com/vi/song/hq.jpg');
      assert.deepEqual(ytdlp.metadataOf(p), {
        title: 'Daft Punk - One More Time (Official Video)', artist: 'Daft Punk', album: null, year: '2001',
        thumbnail: 'https://i.ytimg.com/vi/song/hq.jpg', fileStem: 'Daft_Punk_-_One_More_Time_Official_Video',
        isLive: false, liveStatus: null, durationSec: 320, channel: 'Daft Punk',
      });
      const live = await ytdlp.probe('https://www.youtube.com/watch?v=stream', { bin });
      assert.deepEqual([live.isLive, live.liveStatus, live.fileStem], [true, 'is_live', 'Radio_24_7']);
      await assert.rejects(ytdlp.probe('https://www.youtube.com/watch?v=gone', { bin }), /\[youtube\] gone: Video unavailable/);
      await assert.rejects(ytdlp.lookupMetadata('https://www.youtube.com/watch?v=gone', { bin }), (err) => err.message === 'Failed to lookup metadata',
        'the metadata lookup keeps its plain failure');

      // A lookup that hangs is killed at its bound and says so — the POST's
      // name check waits on it, so it must never hold the request open.
      fs.writeFileSync(script, JSON.stringify({ probe: { slowMs: 20_000 }, details: {} }));
      const t0 = Date.now();
      await assert.rejects(ytdlp.probe('https://www.youtube.com/watch?v=song', { bin, timeoutMs: 400 }),
        (err) => err.timedOut === true && /did not answer within/.test(err.message));
      assert.ok(Date.now() - t0 < 5000, `killed at the bound, not when the fake gave up (${Date.now() - t0} ms)`);
    } finally {
      if (saved === undefined) { delete process.env.MSTREAM_FAKE_YTDLP_SCRIPT; } else { process.env.MSTREAM_FAKE_YTDLP_SCRIPT = saved; }
    }
  });

  test('startDownload says why yt-dlp refused without failing (a live stream, a file past its cap), and takes only a path in its folder for the printed one', async () => {
    const fixture = path.join(dir, 'fixture3.mp3');
    fs.writeFileSync(fixture, 'the download');
    const script = path.join(dir, 'refusals.json');
    const saved = { script: process.env.MSTREAM_FAKE_YTDLP_SCRIPT, fixture: process.env.MSTREAM_FAKE_YTDLP_FIXTURE };
    process.env.MSTREAM_FAKE_YTDLP_SCRIPT = script;
    process.env.MSTREAM_FAKE_YTDLP_FIXTURE = fixture;
    const bin = { cmd: process.execPath, prefix: [FAKE] };
    const run = (name, url, extra = {}) => {
      const out = path.join(dir, name);
      fs.mkdirSync(out, { recursive: true });
      return ytdlp.startDownload({ bin, url, dir: out, codec: 'mp3', ...extra }).done;
    };
    try {
      fs.writeFileSync(script, JSON.stringify({ details: { stream: { id: 'stream', title: 'On Air', is_live: true, live_status: 'is_live' } } }));
      // Quiet (--print without --no-quiet), yt-dlp would say nothing here
      // and exit 0: the reason exists only because downloadArgs asks for
      // the loud output.
      assert.ok(ytdlp.downloadArgs({ url: 'u', dir: 'd' }).includes('--no-quiet'));
      await assert.rejects(run('live', 'https://www.youtube.com/watch?v=stream'),
        (err) => err.reason === 'live' && /live stream/.test(err.message));

      fs.writeFileSync(script, JSON.stringify({ download: { tooBig: true } }));
      await assert.rejects(run('big', 'https://www.youtube.com/watch?v=abcdefghijk', { maxFilesizeMb: 500 }),
        (err) => err.reason === 'too-big' && /larger than the 500 MB size cap/.test(err.message));

      // Loud, yt-dlp also prints "Deleting original file <path> (pass -k to
      // keep)" — a line with no [tag] — and a path outside the folder must
      // never be taken for the download either.
      const elsewhere = path.join(dir, 'elsewhere.mp3');
      fs.writeFileSync(elsewhere, 'not the download');
      fs.writeFileSync(script, JSON.stringify({ download: { extraStdout: [`Deleting original file ${elsewhere} (pass -k to keep)`, elsewhere] } }));
      const ok = await run('capture', 'https://www.youtube.com/watch?v=abcdefghijk');
      assert.equal(ok.filePath, path.join(dir, 'capture', 'Unknown_Upload.mp3'));

      // Exit 0 with no file and nothing said: the plain message, no reason.
      fs.writeFileSync(script, JSON.stringify({ download: { fail: 'nothing to see', exitCode: 0 } }));
      await assert.rejects(run('none', 'https://www.youtube.com/watch?v=abcdefghijk'),
        (err) => err.reason === undefined && /no output file/.test(err.message));

      // A failed run: the reason is read from an extractor's refusal only.
      fs.writeFileSync(script, JSON.stringify({ download: { fail: '[youtube] abcdefghijk: Video unavailable. This video is private' } }));
      await assert.rejects(run('refused', 'https://www.youtube.com/watch?v=abcdefghijk'),
        (err) => err.reason === 'unavailable' && /Video unavailable/.test(err.message));
      // An error that runs on: a geo block ends on yt-dlp's VPN hint, and
      // the ERROR line above it is the one that says what happened.
      fs.writeFileSync(script, JSON.stringify({ download: { fail: '[youtube] abcdefghijk: The uploader has not made this video available in your country\n'
        + 'This video is available in Germany, France.\nYou might want to use a VPN or a proxy server (with --proxy) to workaround.' } }));
      await assert.rejects(run('geo', 'https://www.youtube.com/watch?v=abcdefghijk'),
        (err) => err.reason === 'unavailable' && err.message === '[youtube] abcdefghijk: The uploader has not made this video available in your country');
      // Any other line names the file, and so the title: a "No Copyright
      // Music" upload that hit a full disk is no video YouTube refused.
      fs.writeFileSync(script, JSON.stringify({ details: { nc: { id: 'nc', title: 'No Copyright Music - Premieres in May' } },
        download: { fail: 'unable to write data: [Errno 28] No space left on device: \'%(out)s.part\'' } }));
      await assert.rejects(run('disk', 'https://www.youtube.com/watch?v=nc'),
        (err) => err.reason === null && /No_Copyright_Music_-_Premieres_in_May\.mp3\.part/.test(err.message));
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
