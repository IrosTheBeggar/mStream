/**
 * bin/iroh/iroh-ffi-pin.json — the upstream source pin build-bun.yml compiles
 * the darwin-x64 iroh binding from (upstream publishes no darwin-x64 npm
 * package; see bin/iroh/README.md).
 *
 * Two halves of @number0/iroh ship in the Intel-Mac bundle: the JS loader
 * from package-lock.json's version and a .node compiled from the pinned tag.
 * They must be one release — a dependency bump that forgets the pin would
 * ship a JS half calling into the wrong native ABI, and only Intel Macs would
 * notice, at runtime. Pure file reads, no network, no build.
 *
 * The last case is an expiry alarm: it fails the day the lockfile gains a
 * @number0/iroh-darwin-x64 platform package, which means upstream now ships
 * the binary and the source build should be retired, not kept.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

const pin = read('bin/iroh/iroh-ffi-pin.json');
const lock = read('package-lock.json').packages;

describe('bin/iroh/iroh-ffi-pin.json', () => {
  test('has the shape build-bun.yml reads', () => {
    assert.equal(pin.family, 'iroh-ffi');
    assert.equal(pin.schema, 1);
    assert.match(pin.repo, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'repo is owner/name');
    assert.match(pin.tag, /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, 'tag is v<semver>');
    assert.match(pin.commit, /^[0-9a-f]{40}$/, 'commit is a full sha');
    assert.match(pin.crate, /^[A-Za-z0-9_-]+$/, 'crate is a cargo package name');
    assert.equal(pin.builds['darwin-x64'].target, 'x86_64-apple-darwin');
    assert.match(pin.builds['darwin-x64'].macosxDeploymentTarget, /^\d+\.\d+$/);
  });

  test('pins the same @number0/iroh release the lockfile installs', () => {
    const js = lock['node_modules/@number0/iroh'];
    assert.ok(js && js.version, 'package-lock.json has @number0/iroh');
    assert.equal(pin.tag, `v${js.version}`,
      `iroh-ffi-pin.json pins ${pin.tag} but package-lock.json installs @number0/iroh ${js.version} — bump the pin with the dependency (bin/iroh/README.md)`);
  });

  test('the source build is still needed: no darwin-x64 platform package in the lockfile', () => {
    // Every platform package upstream publishes lands in the lockfile as an
    // optional dependency of @number0/iroh. darwin-x64 among them means
    // upstream ships the binary now — retire the CI cross-build (the
    // build-bun.yml step, this pin, bin/iroh/README.md) and let stageIroh()'s
    // npm-pack path serve the Intel-Mac bundle like every other cross leg.
    assert.equal(lock['node_modules/@number0/iroh-darwin-x64'], undefined,
      'package-lock.json now has @number0/iroh-darwin-x64: upstream publishes the Intel-Mac binary — retire the source build');
    // …and the gap is real, not a lockfile that dropped every platform:
    assert.ok(lock['node_modules/@number0/iroh-darwin-arm64'], 'the darwin-arm64 platform package is still pinned');
  });

  test('git tracks the pin but never a built .node', () => {
    const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/);
    assert.ok(ignore.includes('bin/iroh/*'), '.gitignore ignores bin/iroh/*');
    assert.ok(ignore.includes('!bin/iroh/iroh-ffi-pin.json'), '.gitignore un-ignores the pin (CI reads it from the checkout)');
    assert.ok(ignore.includes('!bin/iroh/README.md'), '.gitignore un-ignores the README');
    assert.ok(!ignore.some((l) => /^!bin\/iroh\/.*\.node$/.test(l)), 'no .node is un-ignored');
  });
});
