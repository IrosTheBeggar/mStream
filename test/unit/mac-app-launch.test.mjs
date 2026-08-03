import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectMacAppLaunch, urlHost, MAC_BUNDLE_ID } from '../../src/util/mac-app-launch.js';

// The bundle id lives in two places that must agree: the Info.plist the build
// script stages into mStream.app, and MAC_BUNDLE_ID here (what LaunchServices
// puts in __CFBundleIdentifier at launch). If they drift, every desktop
// affordance silently switches off — and with LSUIElement set there is no
// window and no Dock icon, so the failure is completely invisible.
test('the staged Info.plist bundle id matches MAC_BUNDLE_ID', () => {
  const buildScript = readFileSync(new URL('../../scripts/build-bun.mjs', import.meta.url), 'utf8');
  const match = buildScript.match(/<key>CFBundleIdentifier<\/key><string>([^<]+)<\/string>/);
  assert.ok(match, 'CFBundleIdentifier not found in scripts/build-bun.mjs');
  assert.equal(match[1], MAC_BUNDLE_ID);
});

test('the staged Info.plist marks the app LSUIElement', () => {
  const buildScript = readFileSync(new URL('../../scripts/build-bun.mjs', import.meta.url), 'utf8');
  // Without this key macOS expects a window-server checkin the faceless
  // server never makes: Dock bounce, then "Application Not Responding".
  assert.match(buildScript, /<key>LSUIElement<\/key><true\/>/);
});

// The gate that keeps every desktop affordance (browser open, osascript
// alerts) away from terminal runs, CI, and other platforms. LaunchServices
// stamps the launched bundle's own id into __CFBundleIdentifier; anything
// else — including a shell inherited from Terminal.app — must not trigger.

test('detects a LaunchServices launch of the mStream bundle', () => {
  assert.equal(detectMacAppLaunch('darwin', { __CFBundleIdentifier: MAC_BUNDLE_ID }), true);
});

test('a terminal run (inherited terminal bundle id) is not an app launch', () => {
  assert.equal(detectMacAppLaunch('darwin', { __CFBundleIdentifier: 'com.apple.Terminal' }), false);
  assert.equal(detectMacAppLaunch('darwin', { __CFBundleIdentifier: 'com.googlecode.iterm2' }), false);
});

test('no bundle id in the environment (daemon / bare shell) is not an app launch', () => {
  assert.equal(detectMacAppLaunch('darwin', {}), false);
});

test('other platforms are never an app launch, even with the env marker', () => {
  for (const plat of ['linux', 'win32']) {
    assert.equal(detectMacAppLaunch(plat, { __CFBundleIdentifier: MAC_BUNDLE_ID }), false);
  }
});

// URL host derivation: the browser can always reach a wildcard bind via
// localhost, but an explicit bind may not have localhost bound at all — the
// URL must target the configured address itself, bracketed for IPv6.

test('wildcard and empty binds map to localhost', () => {
  assert.equal(urlHost('::'), 'localhost');
  assert.equal(urlHost('0.0.0.0'), 'localhost');
  assert.equal(urlHost(undefined), 'localhost');
  assert.equal(urlHost(''), 'localhost');
});

test('explicit IPv4 bind is used as-is', () => {
  assert.equal(urlHost('192.168.1.5'), '192.168.1.5');
  assert.equal(urlHost('127.0.0.1'), '127.0.0.1');
});

test('explicit IPv6 bind is bracketed', () => {
  assert.equal(urlHost('fe80::1'), '[fe80::1]');
  assert.equal(urlHost('::1'), '[::1]');
});
