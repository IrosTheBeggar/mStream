/**
 * Unit tests for src/torrent/info-hash.js.
 *
 * Verifies the round-trip from bencoded metainfo / magnet URI to the
 * canonical { infoHash, name } shape. Includes the 256-char name cap
 * the audit fixes added (truncation of attacker-controlled fields
 * before they reach managed_torrents or the UI).
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { infoHashFromMetainfo, infoHashFromMagnet } from '../src/torrent/info-hash.js';

const B = (s) => Buffer.from(s);

// Build a minimal valid single-file metainfo. We control the info
// dict contents (so we know the SHA-1 hash) and surround it with the
// outer dict + a sibling field.
function makeMetainfo(name, length = 100) {
  const inner = `d4:name${name.length}:${name}6:lengthi${length}ee`;
  const outer = `d4:info${inner}8:announce20:http://x.example.com/e`;
  const buf = B(outer);
  // Compute expected SHA-1 of just the info-dict bytes (between d and e).
  const infoStart = buf.indexOf(B('d'), buf.indexOf(B('4:info')) + '4:info'.length);
  // findField pattern: the value bytes start right after "4:info".
  const infoOffset = '4:info'.length + 1; // +1 to skip 'd', but findField returns raw INCLUDING d..e
  // Easier: re-compute by hashing the inner string verbatim
  const expectedHash = crypto.createHash('sha1').update(B(inner)).digest('hex');
  return { buf, expectedHash };
}

describe('infoHashFromMetainfo', () => {
  test('happy path: single-file torrent', () => {
    const { buf, expectedHash } = makeMetainfo('spam', 100);
    const r = infoHashFromMetainfo(buf);
    assert.equal(r.infoHash, expectedHash);
    assert.equal(r.name, 'spam');
  });
  test('throws when info dict is absent', () => {
    // Valid bencode dict with one sibling field but no `info` key.
    const buf = B('d6:author5:spam4:size3:foofe'.replace('foofe', 'foo' + 'e'));
    // Simpler hand-rolled: single key/value pair, no info.
    const valid = B('d4:size4:tinye');
    assert.throws(() => infoHashFromMetainfo(valid), /no info dict/);
  });
  test('throws when bytes are not bencoded', () => {
    assert.throws(() => infoHashFromMetainfo(B('hello world')), /not a bencoded dict/);
  });
  test('truncates name to 256 chars', () => {
    // info.name is attacker-controlled; the post-audit cap (256 chars)
    // protects downstream code from multi-MB names.
    const longName = 'A'.repeat(2_000_000);
    const inner = `d4:name${longName.length}:${longName}6:lengthi100ee`;
    const buf = B(`d4:info${inner}e`);
    const r = infoHashFromMetainfo(buf);
    assert.equal(r.name.length, 256);
    // Sanity: still a valid hex hash
    assert.match(r.infoHash, /^[a-f0-9]{40}$/);
  });
});

describe('infoHashFromMagnet', () => {
  const HASH40 = '08ada5a7a6183aae1e09d831df6748d566095a10';
  test('happy path: hex hash', () => {
    const r = infoHashFromMagnet(`magnet:?xt=urn:btih:${HASH40}&dn=Sintel`);
    assert.equal(r.infoHash, HASH40);
    assert.equal(r.name, 'Sintel');
  });
  test('uppercase hex normalises to lowercase', () => {
    const r = infoHashFromMagnet(`magnet:?xt=urn:btih:${HASH40.toUpperCase()}`);
    assert.equal(r.infoHash, HASH40);
  });
  test('base32 hash decoded to hex', () => {
    // SHA-1 = 20 bytes = 32 base32 chars. Base32-encode the hex hash
    // to verify the decode path symmetrically.
    const bytes = Buffer.from(HASH40, 'hex');
    // RFC 4648 encode (same alphabet as the decoder)
    const ALPH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0, value = 0, b32 = '';
    for (const b of bytes) {
      value = (value << 8) | b;
      bits += 8;
      while (bits >= 5) {
        b32 += ALPH[(value >>> (bits - 5)) & 0x1f];
        bits -= 5;
      }
    }
    if (bits > 0) { b32 += ALPH[(value << (5 - bits)) & 0x1f]; }
    const r = infoHashFromMagnet(`magnet:?xt=urn:btih:${b32}`);
    assert.equal(r.infoHash, HASH40);
  });
  test('empty dn= yields empty name (not undefined)', () => {
    const r = infoHashFromMagnet(`magnet:?xt=urn:btih:${HASH40}`);
    assert.equal(r.name, '');
  });
  test('truncates 2MB dn= to 256 chars', () => {
    const longName = 'A'.repeat(2_000_000);
    const uri = `magnet:?xt=urn:btih:${HASH40}&dn=${encodeURIComponent(longName)}`;
    const r = infoHashFromMagnet(uri);
    assert.equal(r.name.length, 256);
  });
  test('throws on non-magnet URI', () => {
    assert.throws(() => infoHashFromMagnet('http://example.com'), /not a magnet/);
  });
  test('throws on magnet without btih xt', () => {
    assert.throws(() => infoHashFromMagnet('magnet:?xt=urn:other:foo'), /no urn:btih/);
  });
  test('throws on malformed hash', () => {
    assert.throws(() => infoHashFromMagnet('magnet:?xt=urn:btih:notahex'), /neither 40-hex nor 32-base32/);
  });
});
