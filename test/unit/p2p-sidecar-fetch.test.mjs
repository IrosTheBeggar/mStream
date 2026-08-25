/**
 * p2p-sidecar-bootstrap: fetch-on-first-use of the sidecar binary from the
 * sidecar repo's release assets, verified against the COMMITTED manifest.
 *
 * The sidecar lives in its own repo (IrosTheBeggar/mstream-p2p-sidecar) and
 * nothing binary lives in git on either side; what remains in this tree is
 * a tiny manifest pinning {repo, tag} + {file, sha256, size} per platform,
 * and this module derives the URL from those pins and downloads + verifies
 * + installs on demand. These tests pin the trust model:
 *
 *   - a download that doesn't hash to the manifest's pin is DELETED and the
 *     ensure throws (no fallback, nothing installed)
 *   - a body larger than the pinned size is aborted mid-flight
 *   - malformed pins (repo/tag/file that aren't plain tokens) are treated
 *     as unfetchable, never interpolated into a URL
 *   - binaries the operator placed themselves (no receipt entry) are never
 *     re-fetched or replaced
 *   - installs the module made itself ARE refreshed when the manifest moves
 *     on (receipt-gated)
 *   - concurrent ensures share one download (the ffmpeg-bootstrap
 *     single-flight lesson)
 *   - MSTREAM_SIDECAR_BASE swaps the URL base, not the verification
 *
 * Hermetic: a loopback server hands out fixture bytes; the execution probe
 * is injected (fixture bytes aren't executable on any OS — the REAL
 * --print-id probe is covered by the Docker end-to-end with real binaries).
 */

import { describe, before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { ensureSidecar, manifestEntry, canAutoFetch, deriveAssetUrl, sidecarKey, reset } from '../../src/util/p2p-sidecar-bootstrap.js';

const KEY = sidecarKey();
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Fixture "binary" bodies, served by the loopback server under any name.
const GOOD_BODY = Buffer.from(`fake sidecar body for ${KEY} `.repeat(64));
const EVIL_BODY = Buffer.from('tampered bytes that hash to something else entirely');

let server;
let baseUrl;
let tmpRoot;
const hits = [];            // request paths, in order
let responseBody = GOOD_BODY; // what the server answers with (per-test switch)
const okProbe = () => Promise.resolve(true);

// Write a family manifest into `dir` pinning GOOD_BODY under this platform's
// key — the real schema-2 shape (asset file name == platform key, URL
// derived from repo+tag+file, never stored). Overrides let individual tests
// poison one field at a time.
function writeManifest(dir, { body = GOOD_BODY, size, sha, file = KEY, repo = 'IrosTheBeggar/mstream-p2p-sidecar', tag = 'v1.0.0-test' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    family: 'p2p-sidecar',
    schema: 2,
    repo,
    tag,
    builtFrom: 'b'.repeat(40),
    workflowRun: 'https://example.invalid/run/1',
    assets: {
      [KEY]: {
        file,
        sha256: sha ?? sha256(body),
        size: size ?? body.length,
      },
    },
  };
  const name = KEY.includes('-musl') ? 'manifest-musl.json' : 'manifest.json';
  fs.writeFileSync(path.join(dir, name), JSON.stringify(manifest, null, 2));
  return manifest.assets[KEY];
}

function freshDirs(label) {
  const manifestDir = path.join(tmpRoot, `${label}-manifest`);
  const installDir = path.join(tmpRoot, `${label}-install`);
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.mkdirSync(installDir, { recursive: true });
  return { manifestDir, installDir };
}

describe('p2p-sidecar-bootstrap: manifest-pinned fetch', () => {
  before(async () => {
    server = http.createServer((req, res) => {
      hits.push(new URL(req.url, 'http://x').pathname);
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(responseBody);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-sidecar-fetch-'));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.MSTREAM_SIDECAR_BASE;
  });

  beforeEach(() => {
    reset();
    hits.length = 0;
    responseBody = GOOD_BODY;
    // The derived default URL points at github.com; the suite is hermetic,
    // so every test runs through the base override against the loopback
    // server (exactly how an air-gapped mirror would). Tests probing the
    // override/refusal behavior adjust this themselves.
    process.env.MSTREAM_SIDECAR_BASE = baseUrl;
  });

  test('happy path: downloads (from the pinned file name), verifies, installs, and writes the receipt', async () => {
    const { manifestDir, installDir } = freshDirs('happy');
    const entry = writeManifest(manifestDir);

    assert.equal(canAutoFetch({ manifestDir }), true);
    const installed = await ensureSidecar({ manifestDir, installDir, probe: okProbe });

    assert.equal(installed, path.join(installDir, KEY));
    assert.deepEqual(fs.readFileSync(installed), GOOD_BODY);
    // Exactly one request, addressed by the manifest's file pin (== key).
    assert.deepEqual(hits, [`/${entry.file}`]);
    const receipt = JSON.parse(fs.readFileSync(path.join(installDir, '.fetched.json'), 'utf8'));
    assert.equal(receipt[KEY], entry.sha256);
    // No staging debris left behind.
    assert.deepEqual(fs.readdirSync(installDir).filter((f) => f.startsWith('.staging')), []);
  });

  test('checksum mismatch: download refused, nothing installed, staging cleaned', async () => {
    const { manifestDir, installDir } = freshDirs('tamper');
    writeManifest(manifestDir); // pins GOOD_BODY...
    responseBody = EVIL_BODY;   // ...server hands out something else

    // Size guard first: EVIL is shorter than GOOD here, so it passes the
    // byte cap and must die on the hash compare.
    assert.ok(EVIL_BODY.length <= GOOD_BODY.length);
    await assert.rejects(
      () => ensureSidecar({ manifestDir, installDir, probe: okProbe }),
      /checksum mismatch/);
    assert.equal(fs.existsSync(path.join(installDir, KEY)), false);
    assert.deepEqual(fs.readdirSync(installDir).filter((f) => f.startsWith('.staging')), []);
    assert.equal(fs.existsSync(path.join(installDir, '.fetched.json')), false);
  });

  test('a body larger than the pinned size is aborted mid-flight', async () => {
    const { manifestDir, installDir } = freshDirs('oversize');
    writeManifest(manifestDir, { size: 16 }); // pin claims 16 bytes; server sends far more
    await assert.rejects(
      () => ensureSidecar({ manifestDir, installDir, probe: okProbe }),
      /exceeds expected 16 bytes/);
    assert.equal(fs.existsSync(path.join(installDir, KEY)), false);
  });

  test('failed execution probe: verified bytes are still refused', async () => {
    const { manifestDir, installDir } = freshDirs('probe');
    writeManifest(manifestDir);
    await assert.rejects(
      () => ensureSidecar({ manifestDir, installDir, probe: () => Promise.resolve(false) }),
      /execution probe/);
    assert.equal(fs.existsSync(path.join(installDir, KEY)), false);
  });

  test('no manifest entry: returns null without touching the network', async () => {
    const { manifestDir, installDir } = freshDirs('empty');
    // Committed-stub shape: repo pinned, no release yet (tag null, no assets).
    const name = KEY.includes('-musl') ? 'manifest-musl.json' : 'manifest.json';
    fs.writeFileSync(path.join(manifestDir, name), JSON.stringify(
      { family: 'p2p-sidecar', schema: 2, repo: 'IrosTheBeggar/mstream-p2p-sidecar', tag: null, assets: {} }));

    assert.equal(canAutoFetch({ manifestDir }), false);
    assert.equal(await ensureSidecar({ manifestDir, installDir, probe: okProbe }), null);
    assert.equal(hits.length, 0);
  });

  test('malformed manifest entry (bad sha) is treated as unfetchable, not fetched unverified', async () => {
    const { manifestDir, installDir } = freshDirs('malformed');
    writeManifest(manifestDir, { sha: 'not-a-sha' });
    assert.equal(manifestEntry({ manifestDir }), null);
    assert.equal(await ensureSidecar({ manifestDir, installDir, probe: okProbe }), null);
    assert.equal(hits.length, 0);
  });

  test('non-token repo/tag/file pins are unfetchable — never interpolated into a URL', async () => {
    // Each of these would otherwise steer the derived
    // github.com/<repo>/releases/download/<tag>/<file> URL somewhere else.
    const cases = [
      ['repo-path', { repo: 'IrosTheBeggar/mstream/../evil' }],
      ['repo-shape', { repo: 'not-a-repo' }],
      ['tag-null', { tag: null }],              // the committed stub shape
      ['tag-traversal', { tag: '../../latest' }],
      ['file-traversal', { file: '../mstream-server' }],
      ['file-slash', { file: 'nested/name' }],
    ];
    for (const [label, poison] of cases) {
      const { manifestDir, installDir } = freshDirs(`pin-${label}`);
      writeManifest(manifestDir, poison);
      assert.equal(manifestEntry({ manifestDir }), null, `${label}: entry must be rejected`);
      assert.equal(await ensureSidecar({ manifestDir, installDir, probe: okProbe }), null, `${label}: ensure must degrade`);
      reset();
    }
    assert.equal(hits.length, 0, `no request may leave for a malformed pin, saw: ${hits.join(', ')}`);
  });

  test('a binary matching the pin is used as-is — no receipt required, no download', async () => {
    // Pin enforcement is a HASH check, not a provenance check: a hand-copied
    // or image-baked file that IS the pinned build passes untouched.
    const { manifestDir, installDir } = freshDirs('pinned-copy');
    writeManifest(manifestDir);
    const dest = path.join(installDir, KEY);
    fs.writeFileSync(dest, GOOD_BODY); // right bytes, no receipt

    const resolved = await ensureSidecar({ manifestDir, installDir, probe: okProbe });
    assert.equal(resolved, dest);
    assert.equal(hits.length, 0, 'a pin-matching binary must never trigger a download');
    assert.equal(fs.existsSync(path.join(installDir, '.fetched.json')), false,
      'and adoption must not fake a receipt — provenance stays honest');
  });

  test('a binary that does not hash to the pin is replaced — whoever installed it', async () => {
    // THE contract change (one pinned sidecar everywhere): provenance used
    // to buy exemption — an unreceipted file was "operator property, never
    // touched" — which let install types drift apart and a stale binary
    // quietly reintroduce a fixed bug. Now the pin is law; the dev cargo
    // build (checked before this module is consulted) is the one override.
    const { manifestDir, installDir } = freshDirs('drifted');
    writeManifest(manifestDir);
    const dest = path.join(installDir, KEY);
    fs.writeFileSync(dest, 'my hand-built sidecar'); // no receipt, wrong hash

    const resolved = await ensureSidecar({ manifestDir, installDir, probe: okProbe });
    assert.equal(resolved, dest);
    assert.equal(hits.length, 1, 'the drifted binary must be re-fetched to the pin');
    assert.deepEqual(fs.readFileSync(dest), GOOD_BODY, 'pinned bytes on disk');
    assert.equal(fs.existsSync(`${dest}.old`), false, 'rename-aside swept');
  });

  test('a drifted binary that cannot be re-fetched fails the ensure and stays on disk untouched', async () => {
    // Degrade loudly rather than run drift: the caller surfaces the cause
    // (and the boot-retry ladder keeps trying); the file is left exactly as
    // found — replacing it with nothing would be strictly worse.
    const { manifestDir, installDir } = freshDirs('drift-dead');
    writeManifest(manifestDir);
    responseBody = EVIL_BODY; // the store serves bytes that fail the pin
    const dest = path.join(installDir, KEY);
    fs.writeFileSync(dest, 'my hand-built sidecar');

    await assert.rejects(
      () => ensureSidecar({ manifestDir, installDir, probe: okProbe }),
      /checksum mismatch/);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'my hand-built sidecar',
      'the existing file is untouched by a failed replacement');
    assert.equal(fs.existsSync(path.join(installDir, `.staging-${KEY}`)), false, 'staging cleaned');
  });

  test('no manifest entry: an existing binary is untouched — nothing to enforce against', async () => {
    const { manifestDir, installDir } = freshDirs('unpinned-platform');
    // No manifest written at all.
    const dest = path.join(installDir, KEY);
    fs.writeFileSync(dest, 'self-built for an unpinned platform');
    const resolved = await ensureSidecar({ manifestDir, installDir, probe: okProbe });
    assert.equal(resolved, dest);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'self-built for an unpinned platform');
    assert.equal(hits.length, 0);
  });

  test('an install is refreshed when the manifest moves on (hash-gated)', async () => {
    const { manifestDir, installDir } = freshDirs('upgrade');
    writeManifest(manifestDir);
    await ensureSidecar({ manifestDir, installDir, probe: okProbe });
    assert.equal(hits.length, 1);

    // Same manifest again: the on-disk hash matches the pin, no new download.
    reset();
    const again = await ensureSidecar({ manifestDir, installDir, probe: okProbe });
    assert.equal(again, path.join(installDir, KEY));
    assert.equal(hits.length, 1, 'a current install must not re-download');

    // Manifest now pins a NEW build → the on-disk hash no longer matches → refresh.
    const v2 = Buffer.from('sidecar v2 bytes, longer than before to be sure'.repeat(8));
    writeManifest(manifestDir, { body: v2 });
    responseBody = v2;
    reset();
    const upgraded = await ensureSidecar({ manifestDir, installDir, probe: okProbe });
    assert.equal(hits.length, 2, 'a stale binary must trigger exactly one refresh download');
    assert.deepEqual(fs.readFileSync(upgraded), v2);
    const receipt = JSON.parse(fs.readFileSync(path.join(installDir, '.fetched.json'), 'utf8'));
    assert.equal(receipt[KEY], sha256(v2));
    // The rename-aside sweep leaves no .old behind on the happy path.
    assert.equal(fs.existsSync(path.join(installDir, `${KEY}.old`)), false);
  });

  test('concurrent ensures share one download (single-flight)', async () => {
    const { manifestDir, installDir } = freshDirs('flight');
    writeManifest(manifestDir);
    const [a, b, c] = await Promise.all([
      ensureSidecar({ manifestDir, installDir, probe: okProbe }),
      ensureSidecar({ manifestDir, installDir, probe: okProbe }),
      ensureSidecar({ manifestDir, installDir, probe: okProbe }),
    ]);
    assert.equal(a, b);
    assert.equal(b, c);
    assert.equal(hits.length, 1, `expected one shared download, saw: ${hits.join(', ')}`);
  });

  test('MSTREAM_SIDECAR_BASE swaps the base (mirror path observed); a lying mirror is still refused by the pin', async () => {
    const { manifestDir, installDir } = freshDirs('mirror');
    const entry = writeManifest(manifestDir);
    process.env.MSTREAM_SIDECAR_BASE = `${baseUrl}/mirror/`;

    const installed = await ensureSidecar({ manifestDir, installDir, probe: okProbe });
    assert.equal(installed, path.join(installDir, KEY));
    assert.deepEqual(hits, [`/mirror/${entry.file}`]);

    // And a LYING mirror is still refused by the pin.
    const poisoned = freshDirs('mirror-poisoned');
    writeManifest(poisoned.manifestDir);
    responseBody = EVIL_BODY;
    reset();
    await assert.rejects(
      () => ensureSidecar({ manifestDir: poisoned.manifestDir, installDir: poisoned.installDir, probe: okProbe }),
      /checksum mismatch/);
  });

  test('a non-https, non-loopback mirror base is refused outright', async () => {
    const { manifestDir, installDir } = freshDirs('cleartext');
    writeManifest(manifestDir);
    process.env.MSTREAM_SIDECAR_BASE = 'http://releases.example.com';
    await assert.rejects(
      () => ensureSidecar({ manifestDir, installDir, probe: okProbe }),
      /Refusing non-HTTPS URL/);
    assert.equal(hits.length, 0);
  });

  test('with no mirror base, the URL derives from the validated pins (github release-asset shape)', () => {
    const { manifestDir } = freshDirs('derived');
    writeManifest(manifestDir, { repo: 'example-owner/example-repo', tag: 'v9.9.9' });
    const entry = manifestEntry({ manifestDir });
    assert.ok(entry, 'the pin must validate');
    assert.equal(
      deriveAssetUrl(entry),
      `https://github.com/example-owner/example-repo/releases/download/v9.9.9/${entry.file}`);
  });
});
