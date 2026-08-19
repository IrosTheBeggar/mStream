/**
 * p2p-sidecar-bootstrap: fetch-on-first-use of the sidecar binary from
 * release assets, verified against the COMMITTED manifest.
 *
 * The sidecar binaries left git (each CI refresh of the 9-binary set added
 * ~172 MB of undeltifiable blobs to history); what remains in the tree is a
 * tiny manifest pinning {file, sha256, size, url} per platform, and this
 * module downloads + verifies + installs on demand. These tests pin the
 * trust model:
 *
 *   - a download that doesn't hash to the manifest's pin is DELETED and the
 *     ensure throws (no fallback, nothing installed)
 *   - a body larger than the pinned size is aborted mid-flight
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

import { ensureSidecar, manifestEntry, canAutoFetch, sidecarKey, reset } from '../../src/util/p2p-sidecar-bootstrap.js';

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

// Real asset naming (scripts/p2p-sidecar-manifest.mjs): tree12 + sha8
// appended to the key's stem, extension kept at the end.
function assetNameFor(body) {
  const stem = KEY.endsWith('.exe') ? KEY.slice(0, -4) : KEY;
  const ext = KEY.endsWith('.exe') ? '.exe' : '';
  return `${stem}-aaaaaaaaaaaa-${sha256(body).slice(0, 8)}${ext}`;
}

// Write a family manifest into `dir` pinning GOOD_BODY under this platform's
// key. Overrides let individual tests poison one field at a time.
function writeManifest(dir, { body = GOOD_BODY, url, size, sha, file = assetNameFor(body) } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    family: 'p2p-sidecar',
    schema: 1,
    sourceTree: 'a'.repeat(40),
    version: '0.1.0-test',
    builtFrom: 'b'.repeat(40),
    workflowRun: 'https://example.invalid/run/1',
    assets: {
      [KEY]: {
        file,
        sha256: sha ?? sha256(body),
        size: size ?? body.length,
        url: url ?? `${baseUrl}/${file}`,
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
    delete process.env.MSTREAM_SIDECAR_BASE;
  });

  test('happy path: downloads, verifies, installs, and writes the receipt', async () => {
    const { manifestDir, installDir } = freshDirs('happy');
    const entry = writeManifest(manifestDir);

    assert.equal(canAutoFetch({ manifestDir }), true);
    const installed = await ensureSidecar({ manifestDir, installDir, probe: okProbe });

    assert.equal(installed, path.join(installDir, KEY));
    assert.deepEqual(fs.readFileSync(installed), GOOD_BODY);
    assert.equal(hits.length, 1, `expected exactly one download, saw: ${hits.join(', ')}`);
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
    // Committed-stub shape: a manifest with no assets yet.
    const name = KEY.includes('-musl') ? 'manifest-musl.json' : 'manifest.json';
    fs.writeFileSync(path.join(manifestDir, name), JSON.stringify({ family: 'p2p-sidecar', schema: 1, assets: {} }));

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

  test('operator-placed binary (no receipt) is used as-is and never re-fetched', async () => {
    const { manifestDir, installDir } = freshDirs('operator');
    writeManifest(manifestDir);
    const dest = path.join(installDir, KEY);
    fs.writeFileSync(dest, 'my hand-built sidecar');

    const resolved = await ensureSidecar({ manifestDir, installDir, probe: okProbe });
    assert.equal(resolved, dest);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'my hand-built sidecar');
    assert.equal(hits.length, 0, 'an operator binary must never trigger a download');
  });

  test('our own install is refreshed when the manifest moves on (receipt-gated)', async () => {
    const { manifestDir, installDir } = freshDirs('upgrade');
    writeManifest(manifestDir);
    await ensureSidecar({ manifestDir, installDir, probe: okProbe });
    assert.equal(hits.length, 1);

    // Same manifest again: receipt matches, no new download.
    reset();
    const again = await ensureSidecar({ manifestDir, installDir, probe: okProbe });
    assert.equal(again, path.join(installDir, KEY));
    assert.equal(hits.length, 1, 'a current install must not re-download');

    // Manifest now pins a NEW build → refresh.
    const v2 = Buffer.from('sidecar v2 bytes, longer than before to be sure'.repeat(8));
    writeManifest(manifestDir, { body: v2 });
    responseBody = v2;
    reset();
    const upgraded = await ensureSidecar({ manifestDir, installDir, probe: okProbe });
    assert.equal(hits.length, 2, 'a stale receipt must trigger exactly one refresh download');
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

  test('MSTREAM_SIDECAR_BASE overrides the URL base; the sha256 pin still applies', async () => {
    const { manifestDir, installDir } = freshDirs('mirror');
    // Manifest URL points somewhere unreachable — the mirror must win.
    const entry = writeManifest(manifestDir, { url: 'https://releases.invalid/nope' });
    process.env.MSTREAM_SIDECAR_BASE = `${baseUrl}/mirror/`;

    const installed = await ensureSidecar({ manifestDir, installDir, probe: okProbe });
    assert.equal(installed, path.join(installDir, KEY));
    assert.deepEqual(hits, [`/mirror/${entry.file}`]);

    // And a LYING mirror is still refused by the pin.
    const poisoned = freshDirs('mirror-poisoned');
    writeManifest(poisoned.manifestDir, { url: 'https://releases.invalid/nope' });
    responseBody = EVIL_BODY;
    reset();
    await assert.rejects(
      () => ensureSidecar({ manifestDir: poisoned.manifestDir, installDir: poisoned.installDir, probe: okProbe }),
      /checksum mismatch/);
  });

  test('non-https, non-loopback URLs are refused outright', async () => {
    const { manifestDir, installDir } = freshDirs('cleartext');
    writeManifest(manifestDir, { url: 'http://releases.example.com/sidecar' });
    await assert.rejects(
      () => ensureSidecar({ manifestDir, installDir, probe: okProbe }),
      /Refusing non-HTTPS URL/);
    assert.equal(hits.length, 0);
  });
});
