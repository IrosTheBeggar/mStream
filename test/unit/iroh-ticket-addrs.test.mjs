import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDirectAddresses } from '../../src/state/iroh-common.js';

// mStream#940: a ticket must not advertise the NAT-reflexive public addresses
// iroh learns through the relays — a phone on the same LAN dials them first,
// the router hairpins the first packet and the path only works one way.
test('keeps the addresses on this machine, drops the reflexive ones', () => {
  const addrs = ['73.60.222.134:52111', '73.60.222.134:64140', '192.168.1.120:64140'];
  assert.deepEqual(localDirectAddresses(addrs, new Set(['192.168.1.120', '127.0.0.1'])), ['192.168.1.120:64140']);
});

test('a public IP that IS on an interface (a VPS) is kept', () => {
  const addrs = ['203.0.113.7:4000', '10.0.0.5:4000'];
  assert.deepEqual(localDirectAddresses(addrs, new Set(['203.0.113.7', '10.0.0.5'])), addrs);
});

test('IPv6 with brackets and zone ids', () => {
  const addrs = ['[fe80::1c2b:3d4e:5f60:7a8b]:4000', '[2001:db8::10]:4000', '192.168.1.120:4000'];
  const ifaces = new Set(['fe80::1c2b:3d4e:5f60:7a8b%en0', '192.168.1.120']);
  assert.deepEqual(localDirectAddresses(addrs, ifaces), ['[fe80::1c2b:3d4e:5f60:7a8b]:4000', '192.168.1.120:4000']);
});

test('nothing local → empty (the caller then keeps the original set)', () => {
  assert.deepEqual(localDirectAddresses(['73.60.222.134:1'], new Set(['192.168.1.120'])), []);
});
