/**
 * Unit tests for src/torrent/bencode.js.
 *
 * Pure / no I/O / no DB — runs in milliseconds. The bencode parser is
 * the bottom of the torrent feature's trust boundary: every code path
 * that processes .torrent bytes feeds through `decode` or `findField`,
 * so an audit-class bug here would ripple everywhere. The cases below
 * lock the invariants the prior audit cycle established (prototype
 * pollution + depth-cap + canonical-form rejection).
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { decode, findField } from '../../src/torrent/bencode.js';

const B = (s) => Buffer.from(s);

describe('bencode: primitives', () => {
  test('integer i42e', () => {
    assert.equal(decode(B('i42e')).value, 42);
  });
  test('integer i-1e', () => {
    assert.equal(decode(B('i-1e')).value, -1);
  });
  test('integer i0e', () => {
    assert.equal(decode(B('i0e')).value, 0);
  });
  test('string 4:spam', () => {
    assert.equal(decode(B('4:spam')).value.toString('utf8'), 'spam');
  });
  test('empty string 0:', () => {
    assert.equal(decode(B('0:')).value.length, 0);
  });
  test('list lspami42ee', () => {
    const r = decode(B('l4:spami42ee')).value;
    assert.equal(r.length, 2);
    assert.equal(r[0].toString('utf8'), 'spam');
    assert.equal(r[1], 42);
  });
  test('dict d3:bar4:spam3:fooi42ee', () => {
    const r = decode(B('d3:bar4:spam3:fooi42ee')).value;
    assert.equal(r.bar.toString('utf8'), 'spam');
    assert.equal(r.foo, 42);
  });
});

describe('bencode: canonical-form rejection', () => {
  test('rejects negative zero i-0e', () => {
    assert.throws(() => decode(B('i-0e')), /invalid integer/);
  });
  test('rejects leading-zero i01e', () => {
    assert.throws(() => decode(B('i01e')), /invalid integer/);
  });
  test('rejects empty integer ie', () => {
    assert.throws(() => decode(B('ie')), /invalid integer/);
  });
  test('rejects garbage prefix', () => {
    assert.throws(() => decode(B('x42e')), /unknown bencode token/);
  });
  test('rejects unterminated dict', () => {
    assert.throws(() => decode(B('d3:foo4:bare')), /unexpected end of input|unterminated/);
  });
});

describe('bencode: prototype-pollution defence', () => {
  test('__proto__ key becomes an own property on null-prototype dict', () => {
    // The post-audit fix: parsed dicts use Object.create(null). A
    // torrent with key "__proto__" must NOT mutate Object.prototype.
    const evil = B('d9:__proto__d4:flagi1eee');
    const parsed = decode(evil).value;
    const fresh = {};
    assert.equal(fresh.flag, undefined, 'Object.prototype must not be polluted');
    assert.equal(Object.getPrototypeOf(parsed), null, 'dicts must have null prototype');
    assert.notEqual(parsed['__proto__'], undefined, '__proto__ key must be reachable as own property');
  });
  test('constructor key does not corrupt the parser output', () => {
    const evil = B('d11:constructor4:wateee');
    // Just confirm decode doesn't throw and the key is an own property.
    const r = decode(evil).value;
    assert.equal(r.constructor.toString('utf8'), 'wate');
  });
});

describe('bencode: depth cap', () => {
  test('rejects a 100-deep nested list', () => {
    // Post-audit DoS defence — 64-deep cap rejects deeply nested input
    // that would otherwise blow the recursion stack.
    const deep = B('l'.repeat(100) + 'e'.repeat(100));
    assert.throws(() => decode(deep), /exceeds 64 levels/);
  });
  test('accepts a 10-deep nested list', () => {
    const ok = B('l'.repeat(10) + 'e'.repeat(10));
    // Should not throw.
    decode(ok);
  });
});

describe('bencode: findField', () => {
  test('finds top-level dict field without decoding siblings', () => {
    const buf = B('d4:info' + 'd4:name4:spam6:lengthi100ee' + '8:announce30:http://tracker.example.com/xxe');
    const r = findField(buf, 'info');
    assert.equal(r.found, true);
    assert.equal(r.value.name.toString('utf8'), 'spam');
    assert.equal(r.value.length, 100);
    assert.ok(Buffer.isBuffer(r.raw), 'raw byte slice should be exposed for SHA-1');
  });
  test('returns found=false when the key is absent', () => {
    const buf = B('d4:info' + 'd4:name4:spam6:lengthi100ee' + 'e');
    const r = findField(buf, 'nope');
    assert.equal(r.found, false);
  });
  test('throws when input is not a dict', () => {
    assert.throws(() => findField(B('i42e'), 'foo'), /not a bencoded dict/);
  });
});
