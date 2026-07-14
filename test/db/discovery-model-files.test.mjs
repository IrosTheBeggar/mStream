/**
 * Model registry contract + pinned model-file acquisition
 * (src/db/discovery-features-lib.js).
 *
 * ensureModelFile is exercised against a local HTTP server — no network:
 *   - downloads to modelCacheDir and verifies the sha256 pin;
 *   - a checksum mismatch deletes the download and throws (no partial file
 *     left behind — better no model than the wrong model);
 *   - a valid cached copy short-circuits (no second request);
 *   - a corrupt cached copy (crashed previous run) is re-fetched.
 *
 * The registry contract pins what every model entry must declare — dim,
 * version, license, attribution — because exports and the (future) network
 * protocol read them.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

import {
  EMBEDDING_MODELS, DEFAULT_EMBEDDING_MODEL, ensureModelFile,
} from '../../src/db/discovery-features-lib.js';

let scratch;
let server;
let baseUrl;
let hits;
const BLOB = Buffer.from('pretend-onnx-weights-'.repeat(64));
const BLOB_SHA = crypto.createHash('sha256').update(BLOB).digest('hex');

before(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-modelfile-'));
  hits = 0;
  server = http.createServer((req, res) => {
    hits++;
    if (req.url === '/model.bin') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(BLOB);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('model registry contract', () => {
  test('default model is effnet-discogs and exists', () => {
    assert.equal(DEFAULT_EMBEDDING_MODEL, 'effnet-discogs');
    assert.ok(EMBEDDING_MODELS[DEFAULT_EMBEDDING_MODEL]);
  });

  test('every entry declares the fields exports/protocol depend on', () => {
    for (const [key, spec] of Object.entries(EMBEDDING_MODELS)) {
      assert.ok(Number.isInteger(spec.dim) && spec.dim > 0, `${key}.dim`);
      assert.ok(spec.version, `${key}.version`);
      assert.ok(Number.isInteger(spec.sampleRate), `${key}.sampleRate`);
      assert.ok(typeof spec.license === 'string' && spec.license.length, `${key}.license`);
      assert.ok(typeof spec.attribution === 'string' && spec.attribution.length, `${key}.attribution`);
    }
  });

  test('effnet weights are pinned to the project mirror with sha256', () => {
    const { weights, labels } = EMBEDDING_MODELS['effnet-discogs'];
    for (const dl of [weights, labels]) {
      assert.match(dl.url, /^https:\/\/github\.com\/IrosTheBeggar\/mStream\/releases\/download\//,
        'weights come from the project-controlled release mirror');
      assert.match(dl.sha256, /^[0-9a-f]{64}$/);
      assert.ok(dl.filename);
    }
    assert.equal(EMBEDDING_MODELS['effnet-discogs'].license, 'CC-BY-NC-SA-4.0');
  });
});

describe('ensureModelFile', () => {
  test('downloads, verifies the pin, and lands the file', async () => {
    const dir = path.join(scratch, 'dl-ok');
    const dest = await ensureModelFile(
      { filename: 'model.bin', url: `${baseUrl}/model.bin`, sha256: BLOB_SHA }, dir);
    assert.equal(dest, path.join(dir, 'model.bin'));
    assert.ok(Buffer.from(fs.readFileSync(dest)).equals(BLOB));
    assert.ok(!fs.existsSync(`${dest}.downloading`), 'temp file cleaned up');
  });

  test('checksum mismatch throws and leaves nothing behind', async () => {
    const dir = path.join(scratch, 'dl-bad');
    await assert.rejects(
      ensureModelFile({ filename: 'model.bin', url: `${baseUrl}/model.bin`, sha256: 'f'.repeat(64) }, dir),
      /checksum mismatch/);
    assert.ok(!fs.existsSync(path.join(dir, 'model.bin')));
    assert.ok(!fs.existsSync(path.join(dir, 'model.bin.downloading')));
  });

  test('valid cached copy short-circuits without a request', async () => {
    const dir = path.join(scratch, 'dl-cache');
    const spec = { filename: 'model.bin', url: `${baseUrl}/model.bin`, sha256: BLOB_SHA };
    await ensureModelFile(spec, dir);
    const before = hits;
    await ensureModelFile(spec, dir);
    assert.equal(hits, before, 'no re-download of a valid cached file');
  });

  test('corrupt cached copy is re-fetched', async () => {
    const dir = path.join(scratch, 'dl-corrupt');
    const spec = { filename: 'model.bin', url: `${baseUrl}/model.bin`, sha256: BLOB_SHA };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'model.bin'), 'garbage from a crashed run');
    const dest = await ensureModelFile(spec, dir);
    assert.ok(Buffer.from(fs.readFileSync(dest)).equals(BLOB), 'replaced with the verified copy');
  });

  test('missing URL → clean error', async () => {
    await assert.rejects(
      ensureModelFile({ filename: 'nope.bin', url: `${baseUrl}/nope.bin`, sha256: BLOB_SHA },
        path.join(scratch, 'dl-404')),
      /HTTP 404/);
  });
});

// An unwritable cache dir is an OPERATOR problem (storage.modelCacheDirectory
// pointing at a read-only location — the Docker read-only-app-dir case), so
// the error must name the config key, not just echo the syscall. chmod-based
// denial doesn't bind root and Windows ACLs don't map to POSIX modes; the
// scenario under test is POSIX non-root by construction, so skip elsewhere.
describe('ensureModelFile: unwritable cache dir', () => {
  const skip = (process.platform === 'win32' || process.getuid?.() === 0)
    && 'POSIX non-root only: chmod denial does not bind here';

  test('uncreatable dir (read-only parent) → error names storage.modelCacheDirectory', { skip }, async () => {
    const parent = path.join(scratch, 'ro-parent');
    fs.mkdirSync(parent, { recursive: true });
    fs.chmodSync(parent, 0o555);
    try {
      await assert.rejects(
        ensureModelFile({ filename: 'model.bin', url: `${baseUrl}/model.bin`, sha256: BLOB_SHA },
          path.join(parent, 'model-cache')),
        /storage\.modelCacheDirectory/);
    } finally {
      fs.chmodSync(parent, 0o755);
    }
  });

  test('dir exists but is unwritable (PUID-remap case) → same actionable error', { skip }, async () => {
    const dir = path.join(scratch, 'ro-cache');
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o555);
    try {
      await assert.rejects(
        ensureModelFile({ filename: 'model.bin', url: `${baseUrl}/model.bin`, sha256: BLOB_SHA }, dir),
        /storage\.modelCacheDirectory/);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });
});
