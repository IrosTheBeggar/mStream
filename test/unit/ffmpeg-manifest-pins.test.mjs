/**
 * ffmpeg-bootstrap pinnedRelease(): the committed-manifest pin reader must
 * derive URLs from validated pins only, and refuse malformed entries
 * (traversal paths, bad hashes, unknown sources) rather than fetch from
 * them. Pure-function tests — a crafted manifest dir, no network, no config.
 *
 * (MSTREAM_FFMPEG_MIRROR is unset in this process, so derivation is the
 * real-upstream shape; the mirror shape is exercised end-to-end by
 * ffmpeg-bootstrap.test.mjs, whose loopback server + real repo manifest also
 * prove that bytes failing the pin are refused.)
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

delete process.env.MSTREAM_FFMPEG_MIRROR; // must be read as unset at import
const { pinnedRelease, platformKey } = await import('../../src/util/ffmpeg-bootstrap.js');

const SHA = 'a'.repeat(64);
let dir;

function writeManifest(obj) {
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(obj));
}

function baseManifest() {
  return {
    family: 'ffmpeg',
    schema: 1,
    btbn: { repo: 'BtbN/FFmpeg-Builds', tag: 'autobuild-2026-08-19-19-21' },
    assets: {
      'win32-x64': { source: 'btbn', file: 'ffmpeg-N-1-gabc-win64-gpl.zip', sha256: SHA, size: 42 },
      'darwin-arm64': {
        source: 'martinriedl',
        files: {
          ffmpeg: { path: 'download/macos/arm64/123_9.0.1/ffmpeg.zip', sha256: SHA, size: 10 },
          ffprobe: { path: 'download/macos/arm64/123_9.0.1/ffprobe.zip', sha256: SHA, size: 11 },
        },
      },
    },
  };
}

describe('ffmpeg-bootstrap: pinnedRelease() validation + URL derivation', () => {
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-ffmpeg-pins-')); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('btbn entry derives the release-asset URL from repo+tag+file', () => {
    writeManifest(baseManifest());
    const r = pinnedRelease({ manifestDir: dir, key: 'win32-x64' });
    assert.equal(r.source, 'btbn');
    assert.equal(r.url, 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-19-19-21/ffmpeg-N-1-gabc-win64-gpl.zip');
    assert.equal(r.sha256, SHA);
    assert.equal(r.size, 42);
  });

  test('martinriedl entry derives per-binary URLs under the hardcoded host', () => {
    writeManifest(baseManifest());
    const r = pinnedRelease({ manifestDir: dir, key: 'darwin-arm64' });
    assert.equal(r.source, 'martinriedl');
    assert.equal(r.files.ffmpeg.url, 'https://ffmpeg.martin-riedl.de/download/macos/arm64/123_9.0.1/ffmpeg.zip');
    assert.equal(r.files.ffprobe.url, 'https://ffmpeg.martin-riedl.de/download/macos/arm64/123_9.0.1/ffprobe.zip');
    assert.equal(r.files.ffprobe.size, 11);
  });

  test('platform with no entry -> null (unsupported, not an error)', () => {
    writeManifest(baseManifest());
    assert.equal(pinnedRelease({ manifestDir: dir, key: 'freebsd-x64' }), null);
  });

  test('missing or unparseable manifest -> null', () => {
    fs.rmSync(path.join(dir, 'manifest.json'), { force: true });
    assert.equal(pinnedRelease({ manifestDir: dir, key: 'win32-x64' }), null);
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{nope');
    assert.equal(pinnedRelease({ manifestDir: dir, key: 'win32-x64' }), null);
  });

  test('malformed entries are refused: bad hash, bad size, bad tokens', () => {
    for (const mutate of [
      (m) => { m.assets['win32-x64'].sha256 = 'ZZ'.repeat(32); },
      (m) => { m.assets['win32-x64'].sha256 = SHA.slice(0, 63); },
      (m) => { m.assets['win32-x64'].size = 0; },
      (m) => { m.assets['win32-x64'].size = 41.5; },
      (m) => { m.assets['win32-x64'].file = 'evil/../../name.zip'; },
      (m) => { m.assets['win32-x64'].file = 'has space.zip'; },
      (m) => { m.btbn.tag = 'v1 OR 1=1'; },
      (m) => { m.btbn.repo = 'no-slash'; },
      (m) => { m.assets['win32-x64'].source = 'somewhere-else'; },
    ]) {
      const m = baseManifest();
      mutate(m);
      writeManifest(m);
      assert.equal(pinnedRelease({ manifestDir: dir, key: 'win32-x64' }), null);
    }
  });

  test('martinriedl paths cannot traverse, be absolute, or smuggle schemes', () => {
    for (const badPath of [
      '../outside/ffmpeg.zip',
      'download/../../ffmpeg.zip',
      '/absolute/ffmpeg.zip',
      'download\\windows\\ffmpeg.zip',
      'https://evil.example/ffmpeg.zip',
      'download/macos/x/ffmpeg.tar.gz', // must be a .zip
      '',
    ]) {
      const m = baseManifest();
      m.assets['darwin-arm64'].files.ffmpeg.path = badPath;
      writeManifest(m);
      assert.equal(pinnedRelease({ manifestDir: dir, key: 'darwin-arm64' }), null, `accepted: ${badPath}`);
    }
  });

  test('platformKey matches manifest keys for every supported platform', () => {
    assert.equal(platformKey('win32', 'x64'), 'win32-x64');
    assert.equal(platformKey('darwin', 'arm64'), 'darwin-arm64');
    assert.equal(platformKey('linux', 'x64'), 'linux-x64');
  });

  test('the COMMITTED repo manifest itself validates for all five platforms', () => {
    const repoManifestDir = path.join(process.cwd(), 'bin', 'ffmpeg');
    for (const key of ['linux-x64', 'linux-arm64', 'win32-x64', 'darwin-x64', 'darwin-arm64']) {
      const r = pinnedRelease({ manifestDir: repoManifestDir, key });
      assert.ok(r, `committed manifest entry for ${key} failed validation`);
      assert.match(r.source === 'btbn' ? r.url : r.files.ffmpeg.url, /^https:\/\//);
    }
  });
});
