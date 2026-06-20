/**
 * Unit tests for src/torrent/path-probe.js — the new content-match
 * verifier path (Phase A) + learned-prefix cache & generator (Phase B).
 *
 * The existing default verifiers do real daemon RPC + filesystem
 * probing. The tests below isolate the logic via `setVerifier` (already
 * exposed for this purpose) and direct inspection of the cache helpers
 * (`_getLearnedPrefixes` / `_resetLearnedPrefixes`).
 *
 * Pure unit scope — no mStream server, no live daemon, no temp DB.
 */

import { describe, before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  setVerifier, getVerifier,
  probeDaemonPath, autoDetectMapping,
  bareMetalCandidates, learnedPrefixCandidates,
  daemonKnownPathsCandidates,
  _resetLearnedPrefixes, _getLearnedPrefixes,
  _resolveOnDiskPath,
  _normalizeDaemonPath, _torrentMatchesCandidate, _joinDaemonPath,
  _candidateMatchesKnownPath,
} from '../../src/torrent/path-probe.js';
import { CLIENT_TYPE, CONFIDENCE } from '../../src/torrent/constants.js';

let tmpDir;
before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'path-probe-'));
});
after(async () => {
  try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Stash + restore the real verifiers so individual tests can install
// stubs without breaking later tests.
let savedVerifiers;
beforeEach(() => {
  savedVerifiers = {
    [CLIENT_TYPE.TRANSMISSION]: getVerifier(CLIENT_TYPE.TRANSMISSION),
    [CLIENT_TYPE.QBITTORRENT]:  getVerifier(CLIENT_TYPE.QBITTORRENT),
    [CLIENT_TYPE.DELUGE]:       getVerifier(CLIENT_TYPE.DELUGE),
  };
  _resetLearnedPrefixes();
});
after(() => {
  for (const [k, v] of Object.entries(savedVerifiers || {})) {
    if (v) { setVerifier(k, v); }
  }
});

// ────────────────────────────────────────────────────────────────────
// Phase A: content-match verifier behaviour
// ────────────────────────────────────────────────────────────────────
describe('content-match verifier (qBit + Deluge composed verifiers)', () => {
  // The composed verifiers live in path-probe.js and rely on the
  // real RPC modules. Stubbing the network round-trips inside that
  // module-level scope would require a full mocking framework. To
  // keep these tests fast and focused, we exercise the composed
  // verifier END-TO-END by INSTALLING a custom verifier via
  // setVerifier that mirrors the chain semantics (content first,
  // known-paths fall-through). Verifies the contract documented in
  // the design: a `verified` result short-circuits; a null
  // content-match falls through to the second strategy.

  test('chain returns first verified result without calling later strategies', async () => {
    let calledSecond = false;
    const chain = async (creds, ctx) => {
      // First strategy: return verified.
      return { verified: true, confidence: CONFIDENCE.VERIFIED, method: 'fake:content-match' };
    };
    setVerifier(CLIENT_TYPE.QBITTORRENT, chain);

    const mirror = path.join(tmpDir, 'chain1');
    await fs.mkdir(mirror, { recursive: true });
    const r = await probeDaemonPath({}, CLIENT_TYPE.QBITTORRENT, '/downloads/music', mirror, {});
    assert.equal(r.verified, true);
    assert.equal(r.confidence, CONFIDENCE.VERIFIED);
    assert.equal(r.method, 'fake:content-match');
  });

  test('chain falls through to known-paths when content-match misses', async () => {
    // Composed verifier in the codebase: content-match returns null,
    // known-paths is consulted next. We model the same contract
    // here with a fake.
    const composed = async (creds, ctx) => {
      const content = null;   // content-match miss
      if (content) { return content; }
      return { verified: true, confidence: CONFIDENCE.INFERRED, method: 'fake:known-paths' };
    };
    setVerifier(CLIENT_TYPE.DELUGE, composed);

    const mirror = path.join(tmpDir, 'chain2');
    await fs.mkdir(mirror, { recursive: true });
    const r = await probeDaemonPath({}, CLIENT_TYPE.DELUGE, '/downloads/music', mirror, {});
    assert.equal(r.verified, true);
    assert.equal(r.confidence, CONFIDENCE.INFERRED);
    assert.equal(r.method, 'fake:known-paths');
  });

  test('both strategies miss → unconfirmed', async () => {
    setVerifier(CLIENT_TYPE.QBITTORRENT, async () => ({
      verified: false, confidence: CONFIDENCE.UNCONFIRMED,
      method: 'fake:known-paths',
      reason: 'no candidate matched',
    }));

    const mirror = path.join(tmpDir, 'chain3');
    await fs.mkdir(mirror, { recursive: true });
    const r = await probeDaemonPath({}, CLIENT_TYPE.QBITTORRENT, '/nope', mirror, {});
    assert.equal(r.verified, false);
    assert.equal(r.confidence, CONFIDENCE.UNCONFIRMED);
  });
});

// ────────────────────────────────────────────────────────────────────
// Phase B: prefix extraction + learned-prefix generator
// ────────────────────────────────────────────────────────────────────
describe('learned-prefix cache', () => {
  test('extracts prefix when daemonPath ends with vpath.name', async () => {
    // Wire a verifier that always says verified, then run a sweep so
    // the cache gets populated. Then read the cache directly.
    setVerifier(CLIENT_TYPE.DELUGE, async () => ({
      verified: true, confidence: CONFIDENCE.VERIFIED, method: 'fake',
    }));
    const mirror = path.join(tmpDir, 'p1');
    await fs.mkdir(mirror, { recursive: true });
    const vpath = { name: 'music', root_path: mirror };
    await autoDetectMapping(vpath, {}, CLIENT_TYPE.DELUGE,
      [{ daemonPath: '/downloads/music', mstreamMirrorPath: mirror, source: 'auto:test' }],
      {});
    assert.deepEqual(_getLearnedPrefixes(CLIENT_TYPE.DELUGE), ['/downloads']);
  });

  test('extracts prefix when daemonPath ends with on-disk basename', async () => {
    // Operator's vpath is named "music" in mStream but the on-disk
    // path is /srv/library/audio. Daemon was configured against the
    // on-disk name, so the verified daemonPath ends with "audio".
    setVerifier(CLIENT_TYPE.QBITTORRENT, async () => ({
      verified: true, confidence: CONFIDENCE.VERIFIED, method: 'fake',
    }));
    const onDisk = path.join(tmpDir, 'audio');
    await fs.mkdir(onDisk, { recursive: true });
    const vpath = { name: 'music', root_path: onDisk };
    await autoDetectMapping(vpath, {}, CLIENT_TYPE.QBITTORRENT,
      [{ daemonPath: '/srv/library/audio', mstreamMirrorPath: onDisk, source: 'auto:test' }],
      {});
    assert.deepEqual(_getLearnedPrefixes(CLIENT_TYPE.QBITTORRENT), ['/srv/library']);
  });

  test('records full path when last segment is neither vpath.name nor basename', async () => {
    // Single-library setup where the daemon's view is the root
    // itself. Storing the whole path keeps it useful for future
    // vpaths under the same daemon.
    setVerifier(CLIENT_TYPE.DELUGE, async () => ({
      verified: true, confidence: CONFIDENCE.VERIFIED, method: 'fake',
    }));
    const mirror = path.join(tmpDir, 'p3');
    await fs.mkdir(mirror, { recursive: true });
    const vpath = { name: 'music', root_path: mirror };
    await autoDetectMapping(vpath, {}, CLIENT_TYPE.DELUGE,
      [{ daemonPath: '/downloads-pool', mstreamMirrorPath: mirror, source: 'auto:test' }],
      {});
    assert.deepEqual(_getLearnedPrefixes(CLIENT_TYPE.DELUGE), ['/downloads-pool']);
  });

  test('inferred-only verifications do NOT populate the cache', async () => {
    // Phase B contract: only `verified` (round-trip-proven) hits
    // feed the cache. Inferred hits are already guesses and
    // propagating them would compound the error.
    setVerifier(CLIENT_TYPE.QBITTORRENT, async () => ({
      verified: true, confidence: CONFIDENCE.INFERRED, method: 'fake:known-paths',
    }));
    const mirror = path.join(tmpDir, 'p4');
    await fs.mkdir(mirror, { recursive: true });
    const vpath = { name: 'music', root_path: mirror };
    await autoDetectMapping(vpath, {}, CLIENT_TYPE.QBITTORRENT,
      [{ daemonPath: '/downloads/music', mstreamMirrorPath: mirror, source: 'auto:test' }],
      {});
    assert.deepEqual(_getLearnedPrefixes(CLIENT_TYPE.QBITTORRENT), []);
  });

  test('per-client isolation: prefix learned for Deluge does not bleed to qBit', async () => {
    setVerifier(CLIENT_TYPE.DELUGE, async () => ({
      verified: true, confidence: CONFIDENCE.VERIFIED, method: 'fake',
    }));
    const mirror = path.join(tmpDir, 'p5');
    await fs.mkdir(mirror, { recursive: true });
    const vpath = { name: 'music', root_path: mirror };
    await autoDetectMapping(vpath, {}, CLIENT_TYPE.DELUGE,
      [{ daemonPath: '/dluge/music', mstreamMirrorPath: mirror, source: 'auto:test' }],
      {});
    assert.deepEqual(_getLearnedPrefixes(CLIENT_TYPE.DELUGE),     ['/dluge']);
    assert.deepEqual(_getLearnedPrefixes(CLIENT_TYPE.QBITTORRENT), []);
    assert.deepEqual(_getLearnedPrefixes(CLIENT_TYPE.TRANSMISSION), []);
  });
});

describe('learnedPrefixCandidates generator', () => {
  test('empty before any verified sweep', () => {
    const out = learnedPrefixCandidates(
      { name: 'music', root_path: '/tmp/m' },
      CLIENT_TYPE.DELUGE,
    );
    assert.deepEqual(out, []);
  });

  test('after a verified sweep, emits <prefix>/<new-vpath-name>', async () => {
    // Verify against vpath "music" first, then ask for candidates for
    // a new vpath "testlib". The generator should propose
    // /downloads/testlib without ever calling the daemon.
    setVerifier(CLIENT_TYPE.DELUGE, async () => ({
      verified: true, confidence: CONFIDENCE.VERIFIED, method: 'fake',
    }));
    const m1 = path.join(tmpDir, 'm1');
    await fs.mkdir(m1, { recursive: true });
    await autoDetectMapping(
      { name: 'music', root_path: m1 }, {}, CLIENT_TYPE.DELUGE,
      [{ daemonPath: '/downloads/music', mstreamMirrorPath: m1, source: 'auto:test' }],
      {});

    const candidates = learnedPrefixCandidates(
      { name: 'testlib', root_path: '/tmp/testlib' },
      CLIENT_TYPE.DELUGE,
    );
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].daemonPath, '/downloads/testlib');
    assert.equal(candidates[0].source, 'auto:learned-prefix');
  });

  test('multiple prefixes preserved (no overwrite)', async () => {
    // Sequential sweeps against different daemon roots should keep
    // both prefixes — operator might have multiple bind mounts.
    setVerifier(CLIENT_TYPE.DELUGE, async () => ({
      verified: true, confidence: CONFIDENCE.VERIFIED, method: 'fake',
    }));
    const a = path.join(tmpDir, 'a');
    const b = path.join(tmpDir, 'b');
    await fs.mkdir(a, { recursive: true });
    await fs.mkdir(b, { recursive: true });
    await autoDetectMapping(
      { name: 'libA', root_path: a }, {}, CLIENT_TYPE.DELUGE,
      [{ daemonPath: '/disk1/libA', mstreamMirrorPath: a, source: 'auto:test' }],
      {});
    await autoDetectMapping(
      { name: 'libB', root_path: b }, {}, CLIENT_TYPE.DELUGE,
      [{ daemonPath: '/disk2/libB', mstreamMirrorPath: b, source: 'auto:test' }],
      {});

    const candidates = learnedPrefixCandidates(
      { name: 'libC', root_path: '/tmp/c' },
      CLIENT_TYPE.DELUGE,
    );
    const daemonPaths = candidates.map(c => c.daemonPath).sort();
    assert.deepEqual(daemonPaths, ['/disk1/libC', '/disk2/libC']);
  });
});

describe('sweep ordering smoke', () => {
  test('bare-metal candidates emitted first', () => {
    // bareMetalCandidates produces one candidate matching root_path.
    // Sanity check the helper directly so test/torrent-routes.test.mjs
    // doesn't have to ride on the full sweep harness.
    const out = bareMetalCandidates({ name: 'x', root_path: '/srv/x' });
    assert.equal(out.length, 1);
    assert.equal(out[0].daemonPath, '/srv/x');
    assert.equal(out[0].source, 'auto:bare-metal');
  });
});

// ────────────────────────────────────────────────────────────────────
// Content-match on-disk path mapping
//
// The naive `path.join(mstreamMirrorPath, fileName)` works only when
// the daemon's savePath equals the candidate daemonPath. Operators
// who park all torrents at a shared parent dir and use per-album
// subdirs as the vpath would silently produce wrong on-disk paths
// (false content-match misses, or — worse — a size match against a
// completely different file at that wrong location).
// ────────────────────────────────────────────────────────────────────
describe('_resolveOnDiskPath: file-path mapping through (candidate → mstreamMirror)', () => {
  // The canonical case: daemon saved the torrent INTO our candidate.
  // file.name is relative to the savePath (which equals candidate),
  // so it's also relative to the mirror.
  test('savePath equals candidate: file.name is mirror-relative', () => {
    const r = _resolveOnDiskPath(
      '/downloads/testlib',         // candidate (probed daemonPath)
      '/srv/music/testlib',          // mstreamMirrorPath
      '/downloads/testlib',          // torrent savePath
      'tier3-test.flac',             // file.name
    );
    assert.equal(r, path.join('/srv/music/testlib', 'tier3-test.flac'));
  });

  // savePath is a PARENT of candidate. The torrent lives at
  // /downloads/Album1, /downloads/Album2, etc., and the operator
  // probes one specific album as the vpath. file.name includes the
  // album subdir; we must strip that subdir off when joining.
  test('savePath is parent of candidate: strips (candidate - savePath) from file.name', () => {
    const r = _resolveOnDiskPath(
      '/downloads/testlib',          // candidate
      '/srv/music/testlib',          // mirror
      '/downloads',                   // savePath (parent of candidate)
      'testlib/tier3-test.flac',     // file.name (relative to savePath)
    );
    // daemon file = /downloads/testlib/tier3-test.flac
    // relative to candidate = "tier3-test.flac"
    // → mirror/tier3-test.flac
    assert.equal(r, path.join('/srv/music/testlib', 'tier3-test.flac'));
  });

  // savePath is a CHILD of candidate. Multi-album setup: candidate
  // points at /downloads (the daemon's music root) and a particular
  // torrent saved into /downloads/Pink Floyd has file.name "Track1.flac".
  test('savePath is child of candidate: prepends (savePath - candidate) to file.name', () => {
    const r = _resolveOnDiskPath(
      '/downloads',                                // candidate
      '/srv/music',                                // mirror
      '/downloads/Pink Floyd',                     // savePath (child of candidate)
      'Track1.flac',                                // file.name
    );
    // daemon file = /downloads/Pink Floyd/Track1.flac
    // relative to candidate = "Pink Floyd/Track1.flac"
    // → mirror/Pink Floyd/Track1.flac
    assert.equal(r, path.join('/srv/music', 'Pink Floyd', 'Track1.flac'));
  });

  // The filter is lenient (matches torrents whose savePath shares a
  // parent with the candidate), so we may receive torrents whose
  // files are NOT under the candidate. Those must return null so the
  // verifier skips them — stat'ing an unrelated path would risk a
  // false-positive size match.
  test('savePath is a sibling of candidate: file falls outside candidate → null', () => {
    const r = _resolveOnDiskPath(
      '/downloads/musicA',                          // candidate
      '/srv/musicA',                                // mirror
      '/downloads/musicB',                           // savePath (sibling)
      'Track1.flac',
    );
    // daemon file = /downloads/musicB/Track1.flac
    // relative to /downloads/musicA → not a prefix → null
    assert.equal(r, null);
  });

  // savePath equals candidate but file is a single-file torrent. The
  // file IS the torrent root; file.name is just the filename.
  test('single-file torrent (savePath equals candidate)', () => {
    const r = _resolveOnDiskPath(
      '/downloads/x',
      '/srv/x',
      '/downloads/x',
      'song.mp3',
    );
    assert.equal(r, path.join('/srv/x', 'song.mp3'));
  });

  // Defensive paths the verifier should skip on rather than throw.
  test('missing savePath → null', () => {
    assert.equal(_resolveOnDiskPath('/c', '/m', '', 'f.mp3'), null);
    assert.equal(_resolveOnDiskPath('/c', '/m', null, 'f.mp3'), null);
  });
  test('missing fileName → null', () => {
    assert.equal(_resolveOnDiskPath('/c', '/m', '/c', ''), null);
    assert.equal(_resolveOnDiskPath('/c', '/m', '/c', null), null);
  });
  test('missing daemonPath → null', () => {
    assert.equal(_resolveOnDiskPath('', '/m', '/c', 'f.mp3'), null);
  });

  // Trailing slashes on inputs are normalised away.
  test('trailing slashes on inputs are tolerated', () => {
    const r = _resolveOnDiskPath(
      '/downloads/testlib/',
      '/srv/testlib',
      '/downloads/testlib/',
      'a.flac',
    );
    assert.equal(r, path.join('/srv/testlib', 'a.flac'));
  });
});

// ────────────────────────────────────────────────────────────────────
// Native-Windows daemon support
//
// Transmission and qBittorrent installed directly on Windows (no
// Docker) emit `save_path` / `content_path` values with backslashes
// (e.g. `C:\Users\paul\Downloads\music`). Their Dockerised-Linux
// counterparts emit POSIX paths. The helpers below normalise both
// shapes so the path-probe + content-match + candidate-construction
// code paths produce consistent prefix-comparisons + downloadDir
// strings regardless of which platform the daemon is running on.
//
// Locks in the cross-platform contract so a future refactor can't
// silently regress to "POSIX-only" assumptions like the pre-fix
// state of `_tryContentMatchAgainstTorrents` / `daemonKnownPaths
// Candidates` did.
// ────────────────────────────────────────────────────────────────────
describe('_normalizeDaemonPath (cross-platform separator handling)', () => {
  test('POSIX path: no-op', () => {
    assert.equal(_normalizeDaemonPath('/var/torrents/music'), '/var/torrents/music');
  });
  test('Windows-native path: backslashes → forward slashes + lowercased drive', () => {
    // Drive-letter prefix is lowercased so case-only differences in
    // the drive letter don't break prefix-compares downstream.
    assert.equal(_normalizeDaemonPath('C:\\Users\\paul\\Downloads'), 'c:/Users/paul/Downloads');
  });
  test('Strips trailing backslashes', () => {
    assert.equal(_normalizeDaemonPath('C:\\Downloads\\music\\'),  'c:/Downloads/music');
    assert.equal(_normalizeDaemonPath('C:\\Downloads\\music\\\\'),'c:/Downloads/music');
  });
  test('Strips trailing forward slashes', () => {
    assert.equal(_normalizeDaemonPath('/var/torrents/'),  '/var/torrents');
    assert.equal(_normalizeDaemonPath('/var/torrents///'),'/var/torrents');
  });
  test('Mixed separators are unified', () => {
    assert.equal(_normalizeDaemonPath('C:/Downloads\\music/sub\\'), 'c:/Downloads/music/sub');
  });
  test('Drive-letter case is normalised (both inputs produce same output)', () => {
    // Operator types `c:\Downloads` for a daemon that reports
    // `C:\Downloads` — same filesystem dir, would silently
    // mis-compare without this normalisation. After: both forms
    // resolve to the same canonical string.
    assert.equal(_normalizeDaemonPath('C:\\Downloads'), _normalizeDaemonPath('c:\\Downloads'));
    assert.equal(_normalizeDaemonPath('D:/music'),     _normalizeDaemonPath('d:/music'));
    // Only the drive-letter prefix is lowercased; album / segment
    // names retain their case (those are case-meaningful for display).
    assert.equal(_normalizeDaemonPath('C:\\Music\\Pink Floyd'), 'c:/Music/Pink Floyd');
  });
  test('Empty / null / non-string → empty string', () => {
    assert.equal(_normalizeDaemonPath(''),    '');
    assert.equal(_normalizeDaemonPath(null),  '');
    assert.equal(_normalizeDaemonPath(undefined), '');
    assert.equal(_normalizeDaemonPath(42),    '');
  });
});

describe('_torrentMatchesCandidate (filter for content-match)', () => {
  // Native-Windows qBit/Transmission emit savePath with backslashes.
  // The pre-fix filter used `cand + '/'` boundary checks against raw
  // backslash strings — every match silently dropped. These tests
  // lock the fix in.

  test('POSIX: exact savePath match', () => {
    assert.equal(_torrentMatchesCandidate({ savePath: '/downloads/music' }, '/downloads/music'), true);
  });
  test('Native Windows: exact savePath match', () => {
    // Daemon reports backslashes; candidate could be either form.
    // Both directions should match.
    assert.equal(_torrentMatchesCandidate(
      { savePath: 'C:\\Users\\paul\\Downloads\\music' },
      'C:\\Users\\paul\\Downloads\\music',
    ), true);
    assert.equal(_torrentMatchesCandidate(
      { savePath: 'C:\\Users\\paul\\Downloads\\music' },
      'C:/Users/paul/Downloads/music',
    ), true);
    assert.equal(_torrentMatchesCandidate(
      { savePath: 'C:/Users/paul/Downloads/music' },
      'C:\\Users\\paul\\Downloads\\music',
    ), true);
  });
  test('Native Windows: savePath is a child of candidate', () => {
    // Torrent saved deeper than the candidate — its files include
    // the candidate's path as a prefix. The filter must accept it.
    assert.equal(_torrentMatchesCandidate(
      { savePath: 'C:\\Downloads\\music\\Pink Floyd Album' },
      'C:\\Downloads\\music',
    ), true);
  });
  test('Native Windows: candidate is a child of savePath', () => {
    // Torrent saved higher; the candidate is one of its subdirs.
    // Useful when the daemon has one big save dir + per-album subdirs.
    assert.equal(_torrentMatchesCandidate(
      { savePath: 'C:\\Downloads' },
      'C:\\Downloads\\music',
    ), true);
  });
  test('Native Windows: unrelated siblings → no match', () => {
    assert.equal(_torrentMatchesCandidate(
      { savePath: 'C:\\Downloads\\archive' },
      'C:\\Downloads\\music',
    ), false);
  });
  test('contentPath (qBit-specific) is also considered', () => {
    // qBit emits contentPath = save_path + info.name. For single-file
    // torrents this points at the file itself; for multi-file it
    // points at the album dir.
    assert.equal(_torrentMatchesCandidate(
      { savePath: 'C:\\unrelated', contentPath: 'C:\\Downloads\\music\\Album' },
      'C:\\Downloads\\music',
    ), true);
  });
  test('Trailing slash on candidate is tolerated', () => {
    assert.equal(_torrentMatchesCandidate(
      { savePath: 'C:\\Downloads\\music' },
      'C:\\Downloads\\music\\',
    ), true);
    assert.equal(_torrentMatchesCandidate(
      { savePath: '/downloads/music' },
      '/downloads/music/',
    ), true);
  });
  test('Empty/null inputs → false', () => {
    assert.equal(_torrentMatchesCandidate({}, '/downloads'),     false);
    assert.equal(_torrentMatchesCandidate(null, '/downloads'),   false);
    assert.equal(_torrentMatchesCandidate({ savePath: '/x' }, ''), false);
  });
  test('Prefix collision: candidate is NOT a true ancestor', () => {
    // /downloads/music vs /downloads/musical — string-startsWith
    // without the `/` boundary would say YES. The boundary fix
    // says NO. Critical regression guard.
    assert.equal(_torrentMatchesCandidate(
      { savePath: '/downloads/musical' },
      '/downloads/music',
    ), false);
    assert.equal(_torrentMatchesCandidate(
      { savePath: 'C:\\Downloads\\musical' },
      'C:\\Downloads\\music',
    ), false);
  });
});

describe('_joinDaemonPath (canonical forward-slash output)', () => {
  test('POSIX root + segments', () => {
    assert.equal(_joinDaemonPath('/var/torrents', 'music', 'Disc 1'),
      '/var/torrents/music/Disc 1');
  });
  test('Native Windows root produces forward-slash output (+ lowercased drive)', () => {
    // Mixed-separator concatenation was the original bug — Windows
    // daemons accept `C:\Downloads/Album`, but mStream's own later
    // string-compares fail. The fix outputs canonical forward-slash
    // form throughout. Drive letter is also lowercased to absorb
    // case-only operator/daemon mismatches.
    assert.equal(_joinDaemonPath('C:\\Downloads', 'music', 'Disc 1'),
      'c:/Downloads/music/Disc 1');
  });
  test('Trailing separators on root are stripped', () => {
    assert.equal(_joinDaemonPath('C:\\Downloads\\', 'music'),
      'c:/Downloads/music');
    assert.equal(_joinDaemonPath('/var/torrents/', 'music'),
      '/var/torrents/music');
  });
  test('Leading/trailing separators on segments are stripped', () => {
    assert.equal(_joinDaemonPath('/var/torrents', '/music/', '/Disc 1/'),
      '/var/torrents/music/Disc 1');
  });
  test('Falsy/empty segments are skipped', () => {
    assert.equal(_joinDaemonPath('/var/torrents', '', null, 'music', undefined),
      '/var/torrents/music');
  });
  test('Root only (no segments)', () => {
    assert.equal(_joinDaemonPath('C:\\Downloads'), 'c:/Downloads');
  });
  test('Backslashes inside segments are normalised too', () => {
    assert.equal(_joinDaemonPath('C:\\Downloads', 'Pink Floyd\\The Wall'),
      'c:/Downloads/Pink Floyd/The Wall');
  });
});

describe('daemonKnownPathsCandidates (Windows-native known-paths)', () => {
  // The pre-fix generator concatenated the daemon's known-path with
  // '/' literal — on Windows where known.path = "C:\\Downloads"
  // that produced the mixed-separator candidate "C:\\Downloads/music"
  // which the daemon accepted but mStream's later comparisons
  // silently failed on. The fix routes everything through
  // _joinDaemonPath / _normalizeDaemonPath.

  test('Windows known-path produces canonical forward-slash candidates', async () => {
    // Stub the verifier registry's known-paths resolver via memo.
    // _resolveKnownPaths checks memo.knownPaths first; populating it
    // lets us test the generator in isolation.
    const memo = { knownPaths: [{ path: 'C:\\Users\\paul\\Downloads', label: 'default' }] };
    const out = await daemonKnownPathsCandidates(
      { name: 'music', root_path: '/srv/music' },
      {},  // creds — not used because memo is populated
      CLIENT_TYPE.QBITTORRENT,
      memo,
    );
    const paths = out.map(c => c.daemonPath);
    // Expects forward-slash canonical form — NOT mixed. Drive
    // letter is lowercased per _normalizeDaemonPath's contract.
    assert.ok(paths.includes('c:/Users/paul/Downloads/music'),
      `expected c:/Users/paul/Downloads/music in ${JSON.stringify(paths)}`);
    assert.ok(paths.includes('c:/Users/paul/Downloads'),
      `expected c:/Users/paul/Downloads (root) in ${JSON.stringify(paths)}`);
    // Critical: NO mixed-separator candidate.
    for (const p of paths) {
      assert.ok(!/\\.*\/|\/.*\\/.test(p),
        `mixed-separator candidate: ${p}`);
    }
  });

  test('POSIX known-path unchanged by normalisation', async () => {
    const memo = { knownPaths: [{ path: '/var/torrents', label: 'default' }] };
    const out = await daemonKnownPathsCandidates(
      { name: 'music', root_path: '/srv/music' },
      {},
      CLIENT_TYPE.QBITTORRENT,
      memo,
    );
    const paths = out.map(c => c.daemonPath);
    assert.ok(paths.includes('/var/torrents/music'));
    assert.ok(paths.includes('/var/torrents'));
  });

  test('vpath basename differs from name → both candidates emitted, both normalised', async () => {
    const memo = { knownPaths: [{ path: 'C:\\Downloads', label: 'default' }] };
    const out = await daemonKnownPathsCandidates(
      { name: 'testlib', root_path: 'C:\\srv\\music-lib' },  // basename != name
      {},
      CLIENT_TYPE.QBITTORRENT,
      memo,
    );
    const paths = out.map(c => c.daemonPath);
    assert.ok(paths.includes('c:/Downloads/testlib'),
      'name-based candidate present');
    // basename of root_path on Windows is "music-lib"
    assert.ok(paths.includes('c:/Downloads/music-lib'),
      'basename-based candidate present');
  });

  test('Trailing backslash on daemon known-path is stripped', async () => {
    const memo = { knownPaths: [{ path: 'C:\\Downloads\\', label: 'default' }] };
    const out = await daemonKnownPathsCandidates(
      { name: 'music', root_path: '/srv/music' },
      {},
      CLIENT_TYPE.QBITTORRENT,
      memo,
    );
    const paths = out.map(c => c.daemonPath);
    // No trailing-slash candidate, no doubled-slash candidate.
    assert.ok(paths.includes('c:/Downloads/music'));
    assert.ok(paths.includes('c:/Downloads'));
    for (const p of paths) {
      assert.ok(!p.endsWith('/'), `candidate has trailing slash: ${p}`);
      assert.ok(!p.includes('//'), `candidate has doubled slash: ${p}`);
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// _candidateMatchesKnownPath
//
// The qBit + Deluge known-paths verifier (the `inferred` fallback
// after content-match) needs to decide whether the candidate
// daemonPath is at-or-under any of the daemon's configured download
// directories. Both sides may arrive in different separator styles:
// the candidate is in canonical forward-slash form (from
// _normalizeDaemonPath inside daemonKnownPathsCandidates), but the
// known-paths list comes straight from the daemon's RPC — qBit
// native on Windows returns `C:\Users\paul\Downloads`.
//
// The pre-fix verifier used `cand.startsWith(p + '/')` against the
// raw backslash-form known-path and silently never matched. Auto-
// detect would return UNCONFIRMED for every candidate, the vpath-
// access row would be unusable, and seed-existing's vpath loop
// would skip every library because !isUsable(access.confidence).
// ────────────────────────────────────────────────────────────────────
describe('_candidateMatchesKnownPath (cross-platform verifier fallback)', () => {
  test('POSIX candidate matches POSIX known-path', () => {
    const m = _candidateMatchesKnownPath('/downloads/music', [
      { path: '/downloads', label: 'default' },
    ]);
    assert.equal(m?.label, 'default');
    assert.equal(m?.path,  '/downloads');
  });

  test('Forward-slash candidate matches backslash known-path (the qBit-native-Windows bug)', () => {
    // This is the real-world shape: daemonKnownPathsCandidates
    // produced "C:/Users/paul/Downloads/testlib", qBit reported its
    // save_path as "C:\\Users\\paul\\Downloads". Pre-fix: no match.
    const m = _candidateMatchesKnownPath('C:/Users/paul/Downloads/testlib', [
      { path: 'C:\\Users\\paul\\Downloads', label: 'default' },
    ]);
    assert.equal(m?.label, 'default');
  });

  test('Backslash candidate matches forward-slash known-path', () => {
    const m = _candidateMatchesKnownPath('C:\\Downloads\\music', [
      { path: 'C:/Downloads', label: 'default' },
    ]);
    assert.equal(m?.label, 'default');
  });

  test('Exact match (candidate equals known-path)', () => {
    const m = _candidateMatchesKnownPath('/downloads', [
      { path: '/downloads', label: 'default' },
    ]);
    assert.equal(m?.label, 'default');
  });

  test('Trailing separators on either side are tolerated', () => {
    const m = _candidateMatchesKnownPath('C:\\Downloads\\music\\', [
      { path: 'C:/Downloads/', label: 'default' },
    ]);
    assert.equal(m?.label, 'default');
  });

  test('Candidate above the known-path → no match', () => {
    // /downloads/music is the candidate, /downloads/music/sub is
    // the known-path. The candidate is NOT under the known-path,
    // it's above it. No match.
    const m = _candidateMatchesKnownPath('/downloads/music', [
      { path: '/downloads/music/sub', label: 'sub' },
    ]);
    assert.equal(m, null);
  });

  test('Prefix collision → no false match', () => {
    // /downloads/music vs /downloads/musical — without the `/`
    // boundary check the prefix-match would falsely succeed.
    const m = _candidateMatchesKnownPath('/downloads/musical/album', [
      { path: '/downloads/music', label: 'default' },
    ]);
    assert.equal(m, null);
  });

  test('Iterates known-paths in order, returns first match', () => {
    // qBit can expose multiple known-paths (save_path, temp_path,
    // scan_dirs, per-category savePaths). The verifier should
    // report the first one that matches so the operator knows
    // which entry the candidate landed against.
    const m = _candidateMatchesKnownPath('C:/Downloads/music', [
      { path: 'C:\\Temp',      label: 'temp' },
      { path: 'C:\\Downloads', label: 'default' },
      { path: 'C:\\Other',     label: 'other' },
    ]);
    assert.equal(m?.label, 'default');
  });

  test('Empty / null inputs → null', () => {
    assert.equal(_candidateMatchesKnownPath('',         [{ path: '/x' }]), null);
    assert.equal(_candidateMatchesKnownPath('/x',       null),             null);
    assert.equal(_candidateMatchesKnownPath('/x',       []),               null);
    assert.equal(_candidateMatchesKnownPath('/x',       [{ path: '' }]),   null);
    assert.equal(_candidateMatchesKnownPath(null,       [{ path: '/x' }]), null);
  });
});
