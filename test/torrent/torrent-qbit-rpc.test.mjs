/**
 * qBittorrent RPC internals — version-skew regression tests.
 *
 * qBit's WebUI session-cookie name has changed at least once across
 * the versions mStream supports. The historical bug that triggered
 * this suite: v4.5.3 native-Windows installs emit a plain `SID=…`
 * Set-Cookie header, but mStream's cookie extractor was only
 * matching `QBT_SID…`. Login succeeded, the cookie was on the wire,
 * and mStream's testConnection failed with "no session cookie".
 *
 * These tests pin the shapes we accept so a future regex tightening
 * can't silently re-break older installs.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { _extractSid } from '../../src/torrent/qbittorrent-rpc.js';

describe('_extractSid (qBit session cookie extraction)', () => {
  test('plain SID= (qBit v4.5.3 native Windows)', () => {
    // Real cookie from the live probe that surfaced the regression:
    //   set-cookie: SID=pHar/EkmUDSMROkQa8cpFUAaopqn4lDo;
    //                   HttpOnly; path=/; SameSite=Strict
    const got = _extractSid([
      'SID=pHar/EkmUDSMROkQa8cpFUAaopqn4lDo; HttpOnly; path=/; SameSite=Strict',
    ]);
    assert.equal(got, 'SID=pHar/EkmUDSMROkQa8cpFUAaopqn4lDo');
  });

  test('QBT_SID= (newer versions / docker default)', () => {
    const got = _extractSid([
      'QBT_SID=abc123def; HttpOnly; path=/',
    ]);
    assert.equal(got, 'QBT_SID=abc123def');
  });

  test('QBT_SID_<port>= (alt-port builds)', () => {
    const got = _extractSid([
      'QBT_SID_8080=xyz789; HttpOnly; path=/',
    ]);
    assert.equal(got, 'QBT_SID_8080=xyz789');
  });

  test('rejects unrelated cookies a reverse proxy might inject', () => {
    // Critical: the anchor `^(QBT_SID|SID)=` keeps us from grabbing
    // cookies whose names happen to CONTAIN "SID" — e.g. a CSRF
    // cookie named `mySIDproxy` shouldn't be mistaken for a qBit
    // session.
    assert.equal(_extractSid([
      'mySIDproxy=evilvalue; HttpOnly; path=/',
    ]), null);
    assert.equal(_extractSid([
      'session=other; HttpOnly',
      'NOT_SID=neither; HttpOnly',
    ]), null);
  });

  test('picks the qBit cookie when mixed in with others', () => {
    // Real-world setup: qBit behind a reverse proxy that adds its
    // own cookies before/after. Only the qBit one matters.
    const got = _extractSid([
      'tracking=1234; path=/',
      'SID=qbitsession; HttpOnly; path=/',
      'theme=dark; path=/',
    ]);
    assert.equal(got, 'SID=qbitsession');
  });

  test('case-insensitive cookie-name match', () => {
    // The HTTP spec says cookie names are case-sensitive, but qBit
    // could ship a build with a different casing one day; the
    // matcher's `/i` flag tolerates that without re-breaking on the
    // operator side.
    assert.equal(_extractSid(['sid=lowercased; HttpOnly']), 'sid=lowercased');
    assert.equal(_extractSid(['qbt_sid=lowercased; HttpOnly']), 'qbt_sid=lowercased');
  });

  test('handles single string (not array) — defensive', () => {
    // `getSetCookie()` returns an array, but the old test harness
    // may have passed a single string. The extractor tolerates both.
    assert.equal(_extractSid('SID=single; HttpOnly'), 'SID=single');
  });

  test('null / undefined / empty array → null', () => {
    assert.equal(_extractSid(null),       null);
    assert.equal(_extractSid(undefined),  null);
    assert.equal(_extractSid([]),         null);
  });

  test('header with no qBit cookie → null', () => {
    assert.equal(_extractSid([
      'tracking=1234; path=/',
      'analytics=abc; path=/',
    ]), null);
  });
});
