/**
 * bin/iroh/iroh-ffi-pin.json — the upstream source pin build-bun.yml compiles
 * iroh bindings from: darwin-x64 because upstream publishes no such npm
 * package, linux-x64 and linux-arm64 because upstream's prebuilts need glibc
 * 2.34 while the bundles promise 2.28 (see bin/iroh/README.md).
 *
 * Two halves of @number0/iroh ship in those bundles: the JS loader from
 * package-lock.json's version and a .node compiled from the pinned tag. They
 * must be one release — a dependency bump that forgets the pin would ship a
 * JS half calling into the wrong native ABI, noticed only at runtime. Pure
 * file reads, no network, no build.
 *
 * The darwin case is an expiry alarm: it fails the day the lockfile gains a
 * @number0/iroh-darwin-x64 platform package, which means upstream now ships
 * the binary and that source build should be retired, not kept. The Linux
 * builds have no such alarm — their platform packages exist and stay pinned;
 * the source build replaces them for their floor.
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
    assert.equal(pin.schema, 2);
    assert.match(pin.repo, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'repo is owner/name');
    assert.match(pin.tag, /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, 'tag is v<semver>');
    assert.match(pin.commit, /^[0-9a-f]{40}$/, 'commit is a full sha');
    assert.match(pin.crate, /^[A-Za-z0-9_-]+$/, 'crate is a cargo package name');
    // Every build names the napi triple (the .node file name stageIroh()
    // looks for) and the rust target it compiles for.
    for (const [key, b] of Object.entries(pin.builds)) {
      assert.match(b.napi, /^(darwin|linux|win32)-(x64|arm64)(-(gnu|musl|msvc))?$/, `${key}: napi triple`);
      assert.match(b.target, /^[a-z0-9_]+-[a-z0-9-]+$/, `${key}: rust target triple`);
    }
    assert.equal(pin.builds['darwin-x64'].target, 'x86_64-apple-darwin');
    assert.match(pin.builds['darwin-x64'].macosxDeploymentTarget, /^\d+\.\d+$/);
    assert.equal(pin.builds['linux-x64'].napi, 'linux-x64-gnu');
    assert.equal(pin.builds['linux-x64'].target, 'x86_64-unknown-linux-gnu');
    assert.equal(pin.builds['linux-arm64'].napi, 'linux-arm64-gnu');
    assert.equal(pin.builds['linux-arm64'].target, 'aarch64-unknown-linux-gnu');
  });

  test('the Linux gnu builds replace prebuilts the lockfile still pins (for the glibc floor, not a gap)', () => {
    // stageIroh() would fall back to these on a leg whose source-build
    // step did not run — build-bun.yml's floor assert is what catches that.
    assert.ok(lock['node_modules/@number0/iroh-linux-x64-gnu'], 'the linux-x64-gnu platform package is still pinned');
    assert.ok(lock['node_modules/@number0/iroh-linux-arm64-gnu'], 'the linux-arm64-gnu platform package is still pinned');
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
