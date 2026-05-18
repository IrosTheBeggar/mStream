// Minimal bencode decoder. The BEP-3 grammar has exactly four token
// types:
//
//   i<int>e         integer
//   <len>:<bytes>   byte string (length-prefixed; not null-terminated)
//   l...e           list
//   d...e           dict (sorted byte-string keys, alternating with
//                          values)
//
// Two public entry points:
//
//   decode(buf)            Full recursive parse from offset 0. Returns
//                          the root value; dicts also expose a `raw`
//                          slice so the caller can SHA-1 byte ranges
//                          (info-hash use case).
//
//   findField(buf, key)    Walks the top-level dict for a single key
//                          without decoding siblings. Useful when the
//                          value lives in a fat sibling — e.g. the
//                          info dict sits next to a multi-MB `pieces`
//                          blob, and the caller only needs `info`.
//                          O(siblings + target value size) rather
//                          than O(file size).
//
// No npm dependency — the BEP-3 grammar is small enough that a
// targeted parser beats pulling `bencode` for ~200 lines of utility.
// Validation is loud: malformed input throws at the first violation
// with the byte offset, rather than silently producing truncated
// values that confuse downstream consumers.

const ASCII_d = 0x64, ASCII_e = 0x65, ASCII_i = 0x69, ASCII_l = 0x6c, ASCII_colon = 0x3a;
const ASCII_0 = 0x30, ASCII_9 = 0x39;

/**
 * Parse a single bencode token starting at `off`. Returns
 *   { value, end, raw? }
 * where:
 *   - `value` is the decoded JS representation (Number, Buffer,
 *     Array, or Object)
 *   - `end` is the offset immediately past the parsed token
 *   - `raw` is populated only for dicts, capturing the slice
 *     `buf[off..end)` so callers can hash byte ranges without
 *     re-serialising (which would be wrong — bencode dicts must be
 *     sorted by key, and a re-serialiser might diverge on edge
 *     cases).
 *
 * Throws on every malformed-input path with the offset so the error
 * is locatable in the source file.
 */
export function _token(buf, off) {
  if (off >= buf.length) { throw new Error(`unexpected end of input at ${off}`); }
  const c = buf[off];

  if (c === ASCII_i) {
    const e = buf.indexOf(ASCII_e, off + 1);
    if (e < 0) { throw new Error(`unterminated integer at ${off}`); }
    const raw = buf.slice(off + 1, e).toString('ascii');
    // Bencoded integers are ASCII digits with optional leading `-`.
    // Reject anything else loudly rather than letting Number() return
    // NaN and the bug surface later as a confusing decode result.
    if (!/^-?(?:0|[1-9]\d*)$/.test(raw)) {
      throw new Error(`invalid integer '${raw}' at offset ${off}`);
    }
    return { value: Number(raw), end: e + 1 };
  }

  if (c >= ASCII_0 && c <= ASCII_9) {
    const colon = buf.indexOf(ASCII_colon, off);
    if (colon < 0) { throw new Error(`malformed string at ${off}`); }
    const rawLen = buf.slice(off, colon).toString('ascii');
    if (!/^(?:0|[1-9]\d*)$/.test(rawLen)) {
      throw new Error(`invalid string length '${rawLen}' at offset ${off}`);
    }
    const len = Number(rawLen);
    const end = colon + 1 + len;
    if (end > buf.length) {
      throw new Error(`string length ${len} at offset ${off} exceeds buffer (have ${buf.length - colon - 1} bytes left)`);
    }
    return { value: buf.slice(colon + 1, end), end };
  }

  if (c === ASCII_l) {
    const items = [];
    let o = off + 1;
    while (o < buf.length && buf[o] !== ASCII_e) {
      const v = _token(buf, o);
      items.push(v.value);
      o = v.end;
    }
    if (o >= buf.length) { throw new Error(`unterminated list starting at ${off}`); }
    return { value: items, end: o + 1 };
  }

  if (c === ASCII_d) {
    const obj = {};
    let o = off + 1;
    while (o < buf.length && buf[o] !== ASCII_e) {
      const k = _token(buf, o);
      // Dict keys are byte strings per BEP-3, but in practice always
      // ASCII for torrents — UTF-8 decode works either way.
      const key = Buffer.isBuffer(k.value) ? k.value.toString('utf8') : String(k.value);
      const v = _token(buf, k.end);
      obj[key] = v.value;
      o = v.end;
    }
    if (o >= buf.length) { throw new Error(`unterminated dict starting at ${off}`); }
    return { value: obj, end: o + 1, raw: buf.slice(off, o + 1) };
  }

  throw new Error(`unknown bencode token 0x${c?.toString(16) ?? '??'} at offset ${off}`);
}

/**
 * Full decode from offset 0. Returns the root value with `raw`
 * populated on every nested dict.
 */
export function decode(buf) {
  return _token(buf, 0);
}

/**
 * Look up a top-level dict key without decoding siblings. Designed
 * for the .torrent → info-hash use case, where the `info` value sits
 * adjacent to a `pieces` blob that we don't want to decode just to
 * find `info`.
 *
 * Returns `{ found, value, raw, end }` — `found = false` and the
 * other fields are undefined when the key isn't present. `raw` is
 * populated when the value is a dict (typical for `info`).
 *
 * Caveat: this walks the dict in physical order. BEP-3 mandates
 * keys are sorted, so an early-alphabet target is cheap and a
 * late-alphabet target costs the same as a full decode. The win is
 * single-key lookups against monsters like `pieces`.
 */
export function findField(buf, key) {
  if (buf.length === 0 || buf[0] !== ASCII_d) {
    throw new Error('not a bencoded dict');
  }
  let o = 1;
  while (o < buf.length && buf[o] !== ASCII_e) {
    const k = _token(buf, o);
    const keyName = Buffer.isBuffer(k.value) ? k.value.toString('utf8') : String(k.value);
    const v = _token(buf, k.end);
    if (keyName === key) {
      return { found: true, value: v.value, raw: v.raw, end: v.end };
    }
    o = v.end;
  }
  if (o >= buf.length) { throw new Error('unterminated top-level dict'); }
  return { found: false };
}
