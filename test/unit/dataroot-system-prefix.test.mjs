import { test } from 'node:test';
import assert from 'node:assert/strict';
import { underSystemPrefix, resolveDataRoot, userDataHome } from '../../src/util/esm-helpers.js';

// ── underSystemPrefix ────────────────────────────────────────────────────────
// System install locations must never become data homes even when writable:
// root under /opt (a sudo'd `mstream-server -j …` from a deb/rpm) and admin
// users under /Applications (the pkg) both pass W_OK, and the db then lands
// inside a package-managed tree — leftovers survive `apt remove`, upgrades
// clobber the library, and on macOS it breaks the bundle's signature.

test('deb/rpm install roots are system prefixes', () => {
  assert.equal(underSystemPrefix('/opt/mstream', 'linux'), true);
  assert.equal(underSystemPrefix('/opt/mstream/', 'linux'), true);
  assert.equal(underSystemPrefix('/usr/lib/mstream', 'linux'), true);
  assert.equal(underSystemPrefix('/usr/local/mstream', 'linux'), true);
});

test('the mac pkg install root is a system prefix', () => {
  assert.equal(underSystemPrefix('/Applications/mStream.app/Contents/MacOS', 'darwin'), true);
});

test('user-space roots are not system prefixes', () => {
  assert.equal(underSystemPrefix('/home/u/mstream', 'linux'), false);
  assert.equal(underSystemPrefix('/home/u/Downloads/mStream-6.20.3-linux-x64', 'linux'), false);
  assert.equal(underSystemPrefix('/Users/u/Downloads/mStream.app/Contents/MacOS', 'darwin'), false);
  // Sibling names must not prefix-match: /optimized is not /opt.
  assert.equal(underSystemPrefix('/optimized/mstream', 'linux'), false);
  assert.equal(underSystemPrefix('/usrland/mstream', 'linux'), false);
});

test('windows never treats a root as a system prefix', () => {
  // The per-user install dir (LOCALAPPDATA\Programs) is user space, and no
  // package manager reclaims it — portable-style anchoring stays legal there.
  assert.equal(underSystemPrefix('C:\\Users\\u\\AppData\\Local\\Programs\\mStream', 'win32'), false);
  assert.equal(underSystemPrefix('C:\\Program Files\\mStream', 'win32'), false);
});

// ── resolveDataRoot decision table ───────────────────────────────────────────

const writable = () => {};                                  // accessSync: no throw
const readOnly = () => { throw new Error('EACCES'); };      // accessSync: throws

test('a system-prefix root diverts to the user data home even when writable', () => {
  // This is the whole fix: before it, root's W_OK on /opt/mstream won and
  // runtime state landed in the package tree.
  assert.equal(resolveDataRoot('/opt/mstream', 'linux', writable), userDataHome());
  assert.equal(
    resolveDataRoot('/Applications/mStream.app/Contents/MacOS', 'darwin', writable),
    userDataHome());
});

test('a writable user-space root anchors in place (existing installs untouched)', () => {
  assert.equal(resolveDataRoot('/home/u/mstream', 'linux', writable), '/home/u/mstream');
});

test('an unwritable root still falls back to the user data home (the #802 flow)', () => {
  assert.equal(resolveDataRoot('/home/u/mstream', 'linux', readOnly), userDataHome());
});
