/**
 * src/util/pinned-binary.js — the shared core behind p2p-sidecar-bootstrap.js
 * and mstream-player-bootstrap.js.
 *
 * Each of those two keeps its own suite (p2p-sidecar-fetch, mstream-player-
 * fetch), and both passed UNCHANGED across the extraction — that is the proof
 * the trust model did not move. This file pins what only the core can say:
 *
 *   - the two on-disk policies, side by side on the SAME state: a binary at
 *     the managed path with no receipt that does not hash to the pin is
 *     REPLACED under 'pin-is-law' and left ALONE under 'receipt-gated'. The
 *     difference is a security decision per family, so it must never blur.
 *   - 'receipt-gated' decides from the receipt, not from the file's bytes
 *   - families are isolated: their own mirror env var, their own single
 *     flight, their own key prefix
 *   - a probe that needs a scratch dir gets one and it is always swept; one
 *     that does not is called with the binary alone
 *   - a misconfigured family fails at creation, not at first download
 *   - the operator-visible log lines of both real families are word for word
 *     what they were before the extraction
 *
 * Hermetic: a loopback server hands out fixture bytes and the probe is
 * injected, exactly like the two family suites.
 */

import { describe, before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import winston from 'winston';

import { createPinnedBinary, deriveAssetUrl } from '../../src/util/pinned-binary.js';
import * as sidecarBootstrap from '../../src/util/p2p-sidecar-bootstrap.js';
import * as playerBootstrap from '../../src/util/mstream-player-bootstrap.js';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const PINNED = Buffer.from('the pinned build '.repeat(64));
const okProbe = () => Promise.resolve(true);

let server;
let baseUrl;
let tmpRoot;
const hits = [];

function family(name, onDiskPolicy, probeExtra = {}) {
  return createPinnedBinary({
    family: name,
    baseEnv: `MSTREAM_TEST_${name.toUpperCase().replace(/-/g, '_')}_BASE`,
    onDiskPolicy,
    probe: { flag: '--probe', args: () => ['--probe'], accept: /ok/, scratchDir: false, ...probeExtra },
    noun: 'binary',
    unpublishedMeans: 'the feature is unavailable',
  });
}

function dirs(label) {
  const manifestDir = path.join(tmpRoot, `${label}-manifest`);
  const installDir = path.join(tmpRoot, `${label}-install`);
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.mkdirSync(installDir, { recursive: true });
  return { manifestDir, installDir };
}

function writeManifest(dir, key, { body = PINNED } = {}) {
  const name = key.includes('-musl') ? 'manifest-musl.json' : 'manifest.json';
  fs.writeFileSync(path.join(dir, name), JSON.stringify({
    repo: 'example-owner/example-repo', tag: 'v1.0.0-test',
    assets: { [key]: { file: key, sha256: sha256(body), size: body.length } },
  }));
}

async function withLogs(fn) {
  const lines = { info: [], warn: [], error: [] };
  const real = { info: winston.info, warn: winston.warn, error: winston.error };
  for (const level of Object.keys(lines)) { winston[level] = (line) => { lines[level].push(String(line)); }; }
  try { await fn(lines); } finally { Object.assign(winston, real); }
  return lines;
}

describe('pinned-binary core', () => {
  before(async () => {
    server = http.createServer((req, res) => {
      hits.push(new URL(req.url, 'http://x').pathname);
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(PINNED);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-binary-'));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) { if (/^MSTREAM_TEST_.*_BASE$/.test(k)) { delete process.env[k]; } }
    delete process.env.MSTREAM_SIDECAR_BASE;
    delete process.env.MSTREAM_PLAYER_BASE;
  });

  beforeEach(() => { hits.length = 0; });

  test('the three policies part ways on the same disk: an unreceipted binary that misses the pin', async () => {
    const outcomes = {};
    for (const policy of ['pin-is-law', 'receipt-gated', 'receipt-is-law']) {
      const bin = family(`contrast-${policy}`, policy);
      process.env[`MSTREAM_TEST_CONTRAST_${policy.toUpperCase().replace(/-/g, '_')}_BASE`] = baseUrl;
      const { manifestDir, installDir } = dirs(`contrast-${policy}`);
      writeManifest(manifestDir, bin.key());
      const dest = path.join(installDir, bin.key());
      fs.writeFileSync(dest, 'a build somebody put here by hand');   // no receipt, not the pinned bytes

      const before = hits.length;
      const resolved = await bin.ensure({ manifestDir, installDir, probe: okProbe });

      assert.equal(resolved, dest);
      outcomes[policy] = { downloaded: hits.length - before, bytes: fs.readFileSync(dest) };
    }

    assert.equal(outcomes['pin-is-law'].downloaded, 1, 'pin-is-law: whoever installed it, a miss is replaced');
    assert.deepEqual(outcomes['pin-is-law'].bytes, PINNED);
    assert.equal(outcomes['receipt-gated'].downloaded, 0, 'receipt-gated: no receipt means the operator’s — hands off');
    assert.equal(outcomes['receipt-gated'].bytes.toString(), 'a build somebody put here by hand');
    assert.equal(outcomes['receipt-is-law'].downloaded, 0, 'receipt-is-law: no receipt means the operator’s — hands off');
    assert.equal(outcomes['receipt-is-law'].bytes.toString(), 'a build somebody put here by hand');
  });

  test('receipt-is-law keeps a receipted binary that hashes to its receipt — whatever build that is — and replaces one that does not', async () => {
    const bin = family('law', 'receipt-is-law');
    process.env.MSTREAM_TEST_LAW_BASE = baseUrl;
    const { manifestDir, installDir } = dirs('law');
    writeManifest(manifestDir, bin.key());
    const dest = path.join(installDir, bin.key());

    // Ours, moved past the pin by a live update (an object receipt with the
    // hash of what is on disk): current, no download.
    const live = Buffer.from('a newer build the family installed itself');
    fs.writeFileSync(dest, live);
    fs.writeFileSync(path.join(installDir, '.fetched.json'), JSON.stringify({ [bin.key()]: { sha256: sha256(live), version: '2.0' } }));
    await bin.ensure({ manifestDir, installDir, probe: okProbe });
    assert.equal(hits.length, 0, 'a receipted, intact build is kept even though it does not hash to the pin');
    assert.deepEqual(bin.receiptEntry({ installDir }), { sha256: sha256(live), version: '2.0' });

    // Damaged since — no longer hashing to its receipt → the pin comes back.
    fs.appendFileSync(dest, ' and then bit rot');
    bin.reset();
    const lines = await withLogs(() => bin.ensure({ manifestDir, installDir, probe: okProbe }));
    assert.equal(hits.length, 1);
    assert.deepEqual(fs.readFileSync(dest), PINNED);
    assert.match(lines.info[0], /no longer matches its install receipt — replacing it with the pinned build$/);
    assert.equal(bin.receiptEntry({ installDir }), sha256(PINNED), 'a pin install without pinReceipt writes the bare string');
  });

  test('install(): the download-verify-probe-swap step on its own, with a receipt that carries what the family hands it', async () => {
    const bin = createPinnedBinary({
      family: 'live', baseEnv: 'MSTREAM_TEST_LIVE_BASE', onDiskPolicy: 'receipt-is-law',
      probe: { flag: '--probe', args: () => ['--probe'], accept: /ok/, scratchDir: false },
      noun: 'binary', unpublishedMeans: 'the feature is unavailable',
      pinReceipt: (entry) => ({ version: entry.tag, source: 'pin' }),
    });
    process.env.MSTREAM_TEST_LIVE_BASE = baseUrl;
    const { manifestDir, installDir } = dirs('live');
    writeManifest(manifestDir, bin.key());
    const dest = path.join(installDir, bin.key());

    await bin.ensure({ manifestDir, installDir, probe: okProbe });
    assert.deepEqual(bin.receiptEntry({ installDir }), { sha256: sha256(PINNED), version: 'v1.0.0-test', source: 'pin' }, 'pinReceipt shapes the pin install\'s receipt');

    // A live build: the URL and hash come from the family, the receipt meta
    // from a function called once the probe has passed.
    let probed = null;
    await bin.install({
      installDir, url: `${baseUrl}/${bin.key()}`, sha256: sha256(PINNED), maxBytes: PINNED.length, label: 'live-build',
      probe: () => { probed = 'seen'; return Promise.resolve(true); },
      receiptMeta: () => ({ version: probed, source: 'latest' }),
    });
    assert.deepEqual(bin.receiptEntry({ installDir }), { sha256: sha256(PINNED), version: 'seen', source: 'latest' });
    assert.deepEqual(fs.readFileSync(dest), PINNED);

    // A wrong hash is refused with the label in the message, the file untouched, and the receipt as it was.
    const lines = await withLogs(() => assert.rejects(
      bin.install({ installDir, url: `${baseUrl}/${bin.key()}`, sha256: 'e'.repeat(64), maxBytes: PINNED.length, label: 'live-build', probe: okProbe }),
      /checksum mismatch for live-build/));
    assert.match(lines.error[0], /^\[live\] fetch failed: checksum mismatch for live-build/);
    assert.deepEqual(bin.receiptEntry({ installDir }), { sha256: sha256(PINNED), version: 'seen', source: 'latest' });
    // And without a hash there is nothing to verify against: refused before any request.
    const before = hits.length;
    await assert.rejects(bin.install({ installDir, url: `${baseUrl}/${bin.key()}`, sha256: null, probe: okProbe }), /no sha256 to verify against/);
    assert.equal(hits.length, before);
    assert.equal(bin.mirrorBase(), baseUrl);
  });

  test('receipt-gated decides from the receipt, never from the file’s bytes', async () => {
    const bin = family('receipt', 'receipt-gated');
    process.env.MSTREAM_TEST_RECEIPT_BASE = baseUrl;
    const { manifestDir, installDir } = dirs('receipt');
    writeManifest(manifestDir, bin.key());
    const dest = path.join(installDir, bin.key());

    // Ours and current by receipt — even though the bytes on disk are not the
    // pinned ones. This is what the player module did before the extraction;
    // a refactor is not the place to change it.
    fs.writeFileSync(dest, 'bytes that would not hash to the pin');
    fs.writeFileSync(path.join(installDir, '.fetched.json'), JSON.stringify({ [bin.key()]: sha256(PINNED) }));
    await bin.ensure({ manifestDir, installDir, probe: okProbe });
    assert.equal(hits.length, 0, 'a receipt equal to the pin is current');

    // Ours, and the manifest has moved on since → refreshed.
    fs.writeFileSync(path.join(installDir, '.fetched.json'), JSON.stringify({ [bin.key()]: 'f'.repeat(64) }));
    bin.reset();
    await bin.ensure({ manifestDir, installDir, probe: okProbe });
    assert.equal(hits.length, 1);
    assert.deepEqual(fs.readFileSync(dest), PINNED);
  });

  test('families are isolated: own key prefix, own mirror env var, own single flight', async () => {
    const alpha = family('alpha', 'pin-is-law');
    const beta = family('beta', 'pin-is-law');
    assert.ok(alpha.key().startsWith('alpha-') && beta.key().startsWith('beta-'));
    assert.match(alpha.key('linux', 'x64'), /^alpha-linux-x64(-musl)?$/);
    assert.equal(alpha.key('win32', 'x64'), 'alpha-win32-x64.exe');

    process.env.MSTREAM_TEST_ALPHA_BASE = `${baseUrl}/mirror-a`;
    process.env.MSTREAM_TEST_BETA_BASE = `${baseUrl}/mirror-b/`;   // trailing slash tolerated
    const shared = dirs('isolated');                                // the SAME install dir on purpose
    writeManifest(shared.manifestDir, alpha.key());
    const betaManifest = path.join(tmpRoot, 'isolated-beta-manifest');
    fs.mkdirSync(betaManifest, { recursive: true });
    writeManifest(betaManifest, beta.key());

    await Promise.all([
      alpha.ensure({ manifestDir: shared.manifestDir, installDir: shared.installDir, probe: okProbe }),
      beta.ensure({ manifestDir: betaManifest, installDir: shared.installDir, probe: okProbe }),
    ]);

    assert.deepEqual([...hits].sort(), [`/mirror-a/${alpha.key()}`, `/mirror-b/${beta.key()}`],
      'each family fetched through ITS env var — and one family’s flight did not swallow the other’s');
    assert.deepEqual(fs.readFileSync(path.join(shared.installDir, alpha.key())), PINNED);
    assert.deepEqual(fs.readFileSync(path.join(shared.installDir, beta.key())), PINNED);
    // Not asserted: the shared .fetched.json. Two families writing ONE receipt
    // file at the same moment is a read-modify-write race, and this test is
    // the only place it can happen — in production every family installs into
    // its own bin/<family>/ with its own receipt, and within a family the
    // single flight serialises the writers.
  });

  test('a probe that needs a scratch dir gets one under the install dir, swept even when the probe fails', async () => {
    const seen = [];
    const bin = family('scratch', 'pin-is-law', { scratchDir: true });
    process.env.MSTREAM_TEST_SCRATCH_BASE = baseUrl;
    const { manifestDir, installDir } = dirs('scratch');
    writeManifest(manifestDir, bin.key());

    await assert.rejects(() => bin.ensure({
      manifestDir, installDir,
      probe: (staged, scratchDir) => { seen.push({ staged, scratchDir }); fs.mkdirSync(scratchDir, { recursive: true }); return Promise.resolve(false); },
    }), /failed its --probe execution probe/);

    assert.equal(seen.length, 1);
    assert.equal(path.dirname(seen[0].scratchDir), installDir);
    assert.match(path.basename(seen[0].scratchDir), /^\.probe-\d+$/);
    assert.equal(fs.existsSync(seen[0].scratchDir), false, 'the scratch dir is swept');
    assert.deepEqual(fs.readdirSync(installDir), [], 'and nothing else is left behind: no staging file, no binary, no receipt');
  });

  test('a probe that needs no scratch dir is called with the binary alone', async () => {
    const calls = [];
    const bin = family('noscratch', 'receipt-gated');
    process.env.MSTREAM_TEST_NOSCRATCH_BASE = baseUrl;
    const { manifestDir, installDir } = dirs('noscratch');
    writeManifest(manifestDir, bin.key());

    await bin.ensure({ manifestDir, installDir, probe: (...args) => { calls.push(args); return Promise.resolve(true); } });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 1, 'no second argument');
    assert.equal(path.basename(calls[0][0]), `.staging-${bin.key()}`);
  });

  test('a misconfigured family fails at creation, not at its first download', () => {
    const good = { family: 'x', baseEnv: 'X_BASE', onDiskPolicy: 'pin-is-law', noun: 'binary', unpublishedMeans: 'nothing works',
      probe: { flag: '--v', args: () => ['--v'], accept: /x/, scratchDir: false } };
    assert.doesNotThrow(() => createPinnedBinary(good));
    assert.throws(() => createPinnedBinary({ ...good, onDiskPolicy: 'trust-everything' }), /unknown onDiskPolicy 'trust-everything'/);
    assert.throws(() => createPinnedBinary({ ...good, onDiskPolicy: undefined }), /unknown onDiskPolicy/);
    for (const missing of ['family', 'baseEnv', 'noun', 'unpublishedMeans', 'probe']) {
      assert.throws(() => createPinnedBinary({ ...good, [missing]: undefined }), /incomplete configuration/, `missing ${missing}`);
    }
    assert.throws(() => createPinnedBinary({ ...good, probe: { ...good.probe, accept: 'not a regexp' } }), /incomplete configuration/);
  });

  test('deriveAssetUrl is the GitHub release-asset shape, shared by both families', () => {
    const entry = { repo: 'o/r', tag: 'v1', file: 'f.bin' };
    assert.equal(deriveAssetUrl(entry), 'https://github.com/o/r/releases/download/v1/f.bin');
    assert.equal(sidecarBootstrap.deriveAssetUrl, deriveAssetUrl);
    assert.equal(playerBootstrap.deriveAssetUrl, deriveAssetUrl);
  });

  test('the operator-visible log lines of both real families are word for word what they were', async () => {
    const sk = sidecarBootstrap.sidecarKey();
    const pk = playerBootstrap.playerKey();
    const stale = 'an older build';

    // 1. No build published for this platform.
    const none = dirs('lines-none');
    const unpublished = await withLogs(async () => {
      assert.equal(await sidecarBootstrap.ensureSidecar({ manifestDir: none.manifestDir, installDir: none.installDir, probe: okProbe }), null);
      assert.equal(await playerBootstrap.ensurePlayer({ manifestDir: none.manifestDir, installDir: none.installDir, probe: okProbe }), null);
    });
    assert.deepEqual(unpublished.warn, [
      `[p2p-sidecar] no prebuilt binary is published for this platform (${sk}) — the discovery network stays unavailable until one is (bin/p2p-sidecar/README.md has the manual options)`,
      `[mstream-player] no prebuilt player is published for this platform (${pk}) — server audio is unavailable here (bin/mstream-player/README.md has the manual options)`,
    ]);

    // 2. Something on disk has to be replaced — each family says why in its own words.
    process.env.MSTREAM_SIDECAR_BASE = baseUrl;
    process.env.MSTREAM_PLAYER_BASE = baseUrl;
    const s = dirs('lines-sidecar');
    writeManifest(s.manifestDir, sk);
    fs.writeFileSync(path.join(s.installDir, sk), stale);
    const p = dirs('lines-player');
    writeManifest(p.manifestDir, pk);
    fs.writeFileSync(path.join(p.installDir, pk), stale);
    fs.writeFileSync(path.join(p.installDir, '.fetched.json'), JSON.stringify({ [pk]: 'e'.repeat(64) }));
    sidecarBootstrap.reset();
    playerBootstrap.reset();

    const replaced = await withLogs(async () => {
      await sidecarBootstrap.ensureSidecar({ manifestDir: s.manifestDir, installDir: s.installDir, probe: okProbe });
      await playerBootstrap.ensurePlayer({ manifestDir: p.manifestDir, installDir: p.installDir, probe: okProbe });
    });
    const mb = (PINNED.length / 1024 / 1024).toFixed(1);
    assert.deepEqual(replaced.info, [
      `[p2p-sidecar] ${sk} on disk (${sha256(Buffer.from(stale)).slice(0, 12)}…) does not match the manifest pin (${sha256(PINNED).slice(0, 12)}…) — replacing it with the pinned build`,
      `[p2p-sidecar] downloading ${sk} (${mb} MB) from ${baseUrl}...`,
      `[p2p-sidecar] checksum verified — installed ${sk}`,
      `[mstream-player] a newer player build is pinned by the manifest — updating ${pk}`,
      `[mstream-player] downloading ${pk} (${mb} MB) from ${baseUrl}...`,
      `[mstream-player] checksum verified — installed ${pk}`,
    ]);

    // 3. A failed probe names the family's own probe flag.
    const sf = dirs('lines-sidecar-probe');
    writeManifest(sf.manifestDir, sk);
    const pf = dirs('lines-player-probe');
    writeManifest(pf.manifestDir, pk);
    sidecarBootstrap.reset();
    playerBootstrap.reset();
    const failed = await withLogs(async () => {
      await assert.rejects(() => sidecarBootstrap.ensureSidecar({ manifestDir: sf.manifestDir, installDir: sf.installDir, probe: () => Promise.resolve(false) }));
      await assert.rejects(() => playerBootstrap.ensurePlayer({ manifestDir: pf.manifestDir, installDir: pf.installDir, probe: () => Promise.resolve(false) }));
    });
    assert.deepEqual(failed.error, [
      `[p2p-sidecar] fetch failed: downloaded ${sk} verified but failed its --print-id execution probe — wrong platform build or unsupported host`,
      `[mstream-player] fetch failed: downloaded ${pk} verified but failed its --version execution probe — wrong platform build or unsupported host`,
    ]);
  });
});
