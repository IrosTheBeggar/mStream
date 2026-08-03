import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectMacAppLaunch, urlHost, MAC_BUNDLE_ID } from '../../src/util/mac-app-launch.js';

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
