/**
 * Federation ticket (mstrfed<V>:) encode/parse round-trip. Pure functions —
 * no native module needed. Spec: docs/federation-ticket.md.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFederationTicket, parseFederationTicket,
  buildFederationGuestTicket, parseFederationGuestTicket,
} from '../../src/state/federation.js';
import { buildCompositeTicket } from '../../src/state/iroh.js';

describe('federation ticket (mstrfed envelope)', () => {
  test('round-trips endpoint ticket + key + name + libraries, emits mstrfed1:', () => {
    const ticket = buildFederationTicket({
      endpointTicket: 'endpointaaaabbbbcccc',
      key: 'fedk_0123456789',
      serverName: "Paul's mStream",
      libraries: ['Music', 'Vinyl Rips'],
    });
    assert.match(ticket, /^mstrfed1:/);

    const parsed = parseFederationTicket(ticket);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.endpointTicket, 'endpointaaaabbbbcccc');
    assert.equal(parsed.apiKey, 'fedk_0123456789');
    assert.equal(parsed.name, "Paul's mStream");
    assert.deepEqual(parsed.libraries, ['Music', 'Vinyl Rips']);
  });

  test('name and libraries are optional', () => {
    const ticket = buildFederationTicket({ endpointTicket: 'endpointx', key: 'fedk_y' });
    const parsed = parseFederationTicket(ticket);
    assert.equal(parsed.name, null);
    assert.deepEqual(parsed.libraries, []);
  });

  test('ignores unknown payload fields (forward compat)', () => {
    const body = Buffer.from(JSON.stringify({ t: 'endpointz', k: 'fedk_z', zzz: { future: true } })).toString('base64url');
    const parsed = parseFederationTicket(`mstrfed1:${body}`);
    assert.equal(parsed.endpointTicket, 'endpointz');
  });

  test('rejects a newer version with an actionable error', () => {
    const body = Buffer.from(JSON.stringify({ t: 'x', k: 'y' })).toString('base64url');
    assert.throws(() => parseFederationTicket(`mstrfed2:${body}`), /version 2.*supports up to v1.*[Uu]pdate/s);
  });

  test('rejects missing required fields', () => {
    const noKey = 'mstrfed1:' + Buffer.from(JSON.stringify({ t: 'only-endpoint' })).toString('base64url');
    assert.throws(() => parseFederationTicket(noKey), /Invalid federation ticket/);
  });

  test('rejects garbage and bare (prefix-less) bodies', () => {
    assert.throws(() => parseFederationTicket('not-a-ticket!!'), /Invalid federation ticket/);
    const bare = Buffer.from(JSON.stringify({ t: 'x', k: 'y' })).toString('base64url');
    assert.throws(() => parseFederationTicket(bare), /Invalid federation ticket/, 'no bare-body legacy for a new format');
  });

  test('a tunnel pairing code fails cleanly in the federation parser', () => {
    const tunnelCode = buildCompositeTicket('endpointabc', Buffer.alloc(32, 1));
    assert.throws(() => parseFederationTicket(tunnelCode), /Invalid federation ticket/);
  });
});

// The device-facing sibling: what a parent hands its own app to dial a peer
// directly (docs/federation-guest-ticket.md). Same envelope mechanics, a
// disjoint prefix, a token instead of a key.
describe('federation guest ticket (mstrfedg envelope)', () => {
  const jwtish = 'eyJhbGciOiJIUzI1NiJ9.eyJmZWRlcmF0aW9uR3Vlc3QiOnRydWV9.sig';

  test('round-trips endpoint ticket + guest token, emits mstrfedg1:', () => {
    const ticket = buildFederationGuestTicket({ endpointTicket: 'endpointpeer', guestToken: jwtish });
    assert.match(ticket, /^mstrfedg1:/);
    const parsed = parseFederationGuestTicket(ticket);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.endpointTicket, 'endpointpeer');
    assert.equal(parsed.guestToken, jwtish);
  });

  test('the three envelopes are disjoint — each parser refuses the other two', () => {
    const guest = buildFederationGuestTicket({ endpointTicket: 'e', guestToken: jwtish });
    const fed = buildFederationTicket({ endpointTicket: 'e', key: 'fedk_k' });
    const tunnel = buildCompositeTicket('e', Buffer.alloc(32, 1));
    assert.throws(() => parseFederationTicket(guest), /Invalid federation ticket/,
      'mstrfedg1: must not read as mstrfed<digits>:');
    assert.throws(() => parseFederationGuestTicket(fed), /Invalid federation guest ticket/);
    assert.throws(() => parseFederationGuestTicket(tunnel), /Invalid federation guest ticket/);
  });

  test('rejects missing fields, garbage, bare bodies, and newer versions', () => {
    const noToken = 'mstrfedg1:' + Buffer.from(JSON.stringify({ t: 'only-endpoint' })).toString('base64url');
    assert.throws(() => parseFederationGuestTicket(noToken), /Invalid federation guest ticket/);
    assert.throws(() => parseFederationGuestTicket('not-a-ticket!!'), /Invalid federation guest ticket/);
    const bare = Buffer.from(JSON.stringify({ t: 'x', g: 'y' })).toString('base64url');
    assert.throws(() => parseFederationGuestTicket(bare), /Invalid federation guest ticket/);
    assert.throws(() => parseFederationGuestTicket(`mstrfedg2:${bare}`), /version 2.*supports up to v1.*[Uu]pdate/s);
  });

  test('ignores unknown payload fields (forward compat)', () => {
    const body = Buffer.from(JSON.stringify({ t: 'e', g: jwtish, e: 'soon', zzz: 1 })).toString('base64url');
    assert.equal(parseFederationGuestTicket(`mstrfedg1:${body}`).guestToken, jwtish);
  });
});
