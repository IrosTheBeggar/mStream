// Info-hash + magnet URI helpers. Two entry points:
//
//   infoHashFromMetainfo(buf)   → { infoHash, name }
//   infoHashFromMagnet(uri)     → { infoHash, name }
//
// `infoHash` is always 40-char lowercase hex (the BEP-3 form).
// `name` is the suggested display name — UTF-8 from a .torrent's
// info.name, or `dn=` from a magnet URI. Both default to empty
// string when absent.
//
// Bencode parsing lives in `./bencode.js`. This file is the
// torrent-format-specific layer on top: it knows that `info` is the
// dict to hash, that the hash algorithm is SHA-1, that magnet URIs
// carry their hash in `xt=urn:btih:`, and that older clients
// occasionally emit base32 hashes that need converting to hex.

import crypto from 'node:crypto';
import { findField } from './bencode.js';

// Magnet `dn=` and a .torrent's `info.name` are both attacker-
// controlled with no protocol-level length cap. A multi-megabyte name
// would bloat managed_torrents and any downstream UI that renders it.
// Anything beyond ~256 chars is almost certainly junk or hostile;
// truncate without erroring so the caller still gets a usable
// info-hash + a name they can display.
const _MAX_NAME_LEN = 256;
function _truncateName(s) {
  if (!s) { return ''; }
  return s.length > _MAX_NAME_LEN ? s.slice(0, _MAX_NAME_LEN) : s;
}

/**
 * Extract `{ name, infoHash }` from a .torrent file's raw bytes.
 *
 * The info hash is the SHA-1 of the bencoded `info` dict — the
 * EXACT byte slice between its opening `d` and matching `e`.
 * Re-encoding the parsed dict is wrong because dict-key ordering
 * and whitespace differences would change the hash. We use
 * `findField` to locate the dict's byte range without decoding
 * fat siblings (a typical 4 GB torrent has a multi-MB `pieces`
 * blob next to `info`).
 *
 * Throws if the bytes aren't a valid bencoded torrent dict.
 * Caller should treat any throw as "this isn't a valid .torrent"
 * and surface a clean 400.
 */
export function infoHashFromMetainfo(buf) {
  const r = findField(buf, 'info');
  if (!r.found) { throw new Error('no info dict in torrent file'); }
  if (!r.raw)   { throw new Error('info value is not a dict'); }

  const infoHash = crypto.createHash('sha1').update(r.raw).digest('hex');
  // info.name is attacker-controlled like magnet dn=; same cap applies.
  // We slice the bytes BEFORE the UTF-8 decode so a multi-MB name in
  // the .torrent doesn't allocate a huge string we'll throw away.
  const rawName = r.value.name;
  const name = rawName
    ? _truncateName(Buffer.from(rawName).slice(0, _MAX_NAME_LEN * 4).toString('utf8'))
    : '';
  return { infoHash, name };
}

/**
 * Extract `{ infoHash, name }` from a magnet URI.
 *
 *   magnet:?xt=urn:btih:<hash>&dn=<name>&tr=...
 *
 * Hash may be:
 *   - 40-char hex (BEP-9 standard)
 *   - 32-char base32 (older clients)
 * Both are normalised to lowercase hex. `name` is the URL-decoded
 * `dn=` value, or empty string.
 *
 * Throws when the URI is malformed or lacks a btih xt. Caller maps
 * to 400 with a "not a valid magnet" message.
 */
export function infoHashFromMagnet(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('magnet:?')) {
    throw new Error('not a magnet URI');
  }
  const params = new URLSearchParams(uri.slice('magnet:?'.length));
  // A magnet may carry multiple xt= entries; we look for the first
  // urn:btih: one.
  const xts = params.getAll('xt');
  const btih = xts.find(x => x.startsWith('urn:btih:'));
  if (!btih) { throw new Error('magnet has no urn:btih: xt parameter'); }
  const hash = btih.slice('urn:btih:'.length).trim();

  if (/^[a-fA-F0-9]{40}$/.test(hash)) {
    return { infoHash: hash.toLowerCase(), name: _truncateName(params.get('dn')) };
  }
  if (/^[a-zA-Z2-7]{32}$/.test(hash)) {
    // base32 → hex. SHA-1 is 20 bytes = 32 base32 chars.
    const buf = Buffer.from(_base32Decode(hash.toUpperCase()));
    if (buf.length !== 20) { throw new Error('base32 info hash is not 20 bytes'); }
    return { infoHash: buf.toString('hex'), name: _truncateName(params.get('dn')) };
  }
  throw new Error('info hash is neither 40-hex nor 32-base32');
}

// RFC 4648 base32 decoder. Used only for the magnet info-hash
// branch; kept inline rather than pulling a base32 npm dep for
// ~6 lines.
function _base32Decode(s) {
  const ALPH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const out = [];
  let bits = 0, value = 0;
  for (const ch of s) {
    const v = ALPH.indexOf(ch);
    if (v < 0) { throw new Error(`invalid base32 character: ${ch}`); }
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return out;
}
