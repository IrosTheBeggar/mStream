/**
 * Federation guest tokens (src/state/federation-guest.js) — the pure parts:
 *
 *  - mint → verify round-trip, with the expiry read back out of the token;
 *  - looksLikeGuestToken is a CLAIM check only (no signature), so the auth
 *    wall can route a token before the public-mode branch without
 *    verifying ordinary user tokens twice;
 *  - verifyGuestToken refuses ordinary user tokens, foreign signatures,
 *    expired tokens and malformed claims.
 *
 * The wall branch, the handshake and the mint route are covered by the
 * integration suites (federation-e2e, federation-handshake,
 * federation-browse).
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';

import * as config from '../../src/state/config.js';
import {
  mintGuestToken, verifyGuestToken, looksLikeGuestToken, GUEST_TOKEN_TTL_MS,
} from '../../src/state/federation-guest.js';

describe('federation guest tokens', () => {
  let tmpDir;
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-fed-guest-'));
    await config.setup(path.join(tmpDir, 'config.json')); // generates the JWT secret
  });
  after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } });

  test('mint → verify round-trips the key id; expiry comes from the token itself', () => {
    const before = Date.now();
    const { token, expiresAt } = mintGuestToken({ id: 7 });
    const { keyId, exp } = verifyGuestToken(token);
    assert.equal(keyId, 7);
    assert.equal(new Date(expiresAt).getTime(), exp * 1000, 'expiresAt is the signed exp');
    const life = exp * 1000 - before;
    assert.ok(life > GUEST_TOKEN_TTL_MS - 5000 && life <= GUEST_TOKEN_TTL_MS + 1000, `lifetime ${life}ms`);
    assert.equal(GUEST_TOKEN_TTL_MS, 24 * 60 * 60 * 1000, 'default lifetime is a day');
  });

  test('a custom ttl sticks', () => {
    const { token } = mintGuestToken({ id: 1 }, { ttlMs: 60_000 });
    const { exp, iat } = jwt.decode(token);
    assert.equal(exp - iat, 60);
  });

  test('looksLikeGuestToken is a claim check, not a signature check', () => {
    const { token } = mintGuestToken({ id: 3 });
    assert.equal(looksLikeGuestToken(token), true);
    // Same claims, foreign signature: still LOOKS like a guest (so the wall
    // routes it to the guest branch, where verification fails it with 401
    // instead of letting it fall through to public mode).
    const forged = jwt.sign({ federationGuest: true, federationKeyId: 3 }, 'not-the-secret');
    assert.equal(looksLikeGuestToken(forged), true);
    assert.throws(() => verifyGuestToken(forged), /signature/);
    // Ordinary user tokens, garbage and empties do not.
    const user = jwt.sign({ username: 'alice' }, config.program.secret);
    assert.equal(looksLikeGuestToken(user), false);
    assert.equal(looksLikeGuestToken('not.a.jwt'), false);
    assert.equal(looksLikeGuestToken(''), false);
    assert.equal(looksLikeGuestToken(undefined), false);
  });

  test('verify refuses user tokens, malformed claims and expired tokens', () => {
    const user = jwt.sign({ username: 'alice' }, config.program.secret);
    assert.throws(() => verifyGuestToken(user), /not a federation guest token/);
    const noKey = jwt.sign({ federationGuest: true }, config.program.secret);
    assert.throws(() => verifyGuestToken(noKey), /not a federation guest token/);
    const stringKey = jwt.sign({ federationGuest: true, federationKeyId: '7' }, config.program.secret);
    assert.throws(() => verifyGuestToken(stringKey), /not a federation guest token/);
    const expired = jwt.sign(
      { federationGuest: true, federationKeyId: 7, exp: Math.floor(Date.now() / 1000) - 60 },
      config.program.secret,
    );
    assert.throws(() => verifyGuestToken(expired), /expired/);
  });
});
