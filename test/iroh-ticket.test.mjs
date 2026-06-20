/**
 * Composite pairing-ticket encode/parse round-trip for the Iroh tunnel.
 * Pure functions (no native module needed), so these always run.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCompositeTicket, parseCompositeTicket } from '../src/state/iroh.js';

describe('iroh composite ticket', () => {
  test('round-trips an EndpointTicket + secret', () => {
    const ticketStr = 'endpointaaaabbbbccccddddeeeeffff';
    const secret = Buffer.from('0123456789abcdef0123456789abcdef'); // 32 bytes
    const composite = buildCompositeTicket(ticketStr, secret);
    assert.equal(typeof composite, 'string');

    const parsed = parseCompositeTicket(composite);
    assert.equal(parsed.ticket, ticketStr);
    // secret comes back as a base64 string of the original bytes
    assert.equal(Buffer.from(parsed.secret, 'base64').toString('hex'), secret.toString('hex'));
  });

  test('accepts a base64-string secret too', () => {
    const secretB64 = Buffer.from('a-shared-secret').toString('base64');
    const composite = buildCompositeTicket('endpointxyz', secretB64);
    const parsed = parseCompositeTicket(composite);
    assert.equal(Buffer.from(parsed.secret, 'base64').toString('utf8'), 'a-shared-secret');
  });

  test('rejects garbage', () => {
    assert.throws(() => parseCompositeTicket('not-a-real-ticket!!'), /Invalid tunnel ticket/);
  });

  test('rejects a well-formed-but-incomplete payload', () => {
    const bad = Buffer.from(JSON.stringify({ t: 'only-ticket' })).toString('base64url');
    assert.throws(() => parseCompositeTicket(bad), /Invalid tunnel ticket/);
  });
});
