/**
 * The peers listing's `direct` hint (src/api/federation-browse.js) — what
 * this server has learned about reaching a peer directly, from the outcomes
 * of its own mint attempts. The rules alone, without a peer: a refusal is
 * remembered, a success clears it, removal clears both, and never asked is
 * neither. The access route and the listing that reads the hint are covered
 * by the integration suite (federation-browse).
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { noteGuestOutcome, directHintFor, forgetPeerAccess } from '../../src/api/federation-browse.js';

describe('federation peers listing: the direct hint', () => {
  const entry = () => ({ token: 'eyJ.guest', expiresAt: Date.now() + 3600 * 1000, mintedAt: Date.now() });

  test('never asked → null', () => {
    assert.equal(directHintFor(9001), null);
  });

  test('a refused mint is remembered as false; a mint that succeeds clears it', () => {
    noteGuestOutcome(9002, null);
    assert.equal(directHintFor(9002), false);
    noteGuestOutcome(9002, entry());
    assert.equal(directHintFor(9002), true, 'the peer was upgraded — the refusal is gone');
  });

  test('a refusal after a success drops the cached token: the peer stopped minting', () => {
    noteGuestOutcome(9003, entry());
    assert.equal(directHintFor(9003), true);
    noteGuestOutcome(9003, null);
    assert.equal(directHintFor(9003), false);
  });

  test('removing the peer forgets both the token and the refusal', () => {
    noteGuestOutcome(9004, entry());
    forgetPeerAccess(9004);
    assert.equal(directHintFor(9004), null);
    noteGuestOutcome(9005, null);
    forgetPeerAccess(9005);
    assert.equal(directHintFor(9005), null);
  });
});
