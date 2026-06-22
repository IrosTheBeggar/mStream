/**
 * Composite pairing-ticket encode/parse round-trip for the Iroh tunnel.
 * Pure functions (no native module needed), so these always run.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCompositeTicket, parseCompositeTicket } from '../../src/state/iroh.js';

describe('iroh pairing code (versioned envelope)', () => {
  test('round-trips an EndpointTicket + secret, emits the mstr1: prefix', () => {
    const ticketStr = 'endpointaaaabbbbccccddddeeeeffff';
    const secret = Buffer.from('0123456789abcdef0123456789abcdef'); // 32 bytes
    const composite = buildCompositeTicket(ticketStr, secret);
    assert.match(composite, /^mstr1:/);

    const parsed = parseCompositeTicket(composite);
    assert.equal(parsed.version, 1);
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

  test('parses a legacy bare (un-prefixed) code as implicit v1', () => {
    const bare = Buffer.from(JSON.stringify({ t: 'endpointlegacy', s: 'c2VjcmV0' })).toString('base64url');
    const parsed = parseCompositeTicket(bare);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.ticket, 'endpointlegacy');
  });

  test('rejects a newer version with an actionable error', () => {
    const body = Buffer.from(JSON.stringify({ t: 'x', s: 'y' })).toString('base64url');
    assert.throws(() => parseCompositeTicket(`mstr2:${body}`), /version 2.*supports up to v1.*[Uu]pdate/s);
  });

  test('rejects garbage', () => {
    assert.throws(() => parseCompositeTicket('not-a-real-ticket!!'), /Invalid pairing code/);
  });

  test('rejects a well-formed-but-incomplete payload', () => {
    const bad = 'mstr1:' + Buffer.from(JSON.stringify({ t: 'only-ticket' })).toString('base64url');
    assert.throws(() => parseCompositeTicket(bad), /Invalid pairing code/);
  });
});
