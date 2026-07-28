/**
 * Federation ticket (mstrfed<V>:) encode/parse round-trip. Pure functions —
 * no native module needed. Spec: docs/federation-ticket.md.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFederationTicket, parseFederationTicket } from '../../src/state/federation.js';
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
