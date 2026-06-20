'use strict';

// Parse a human-readable size string into a byte count.
//
//   parseSizeToBytes('500MB') -> 524288000
//   parseSizeToBytes('2GB')   -> 2147483648
//   parseSizeToBytes('0')     -> 0   (sentinel: "no limit")
//
// Units are case-insensitive and 1024-based (KB = 1024 B, MB = 1024 KB,
// GB = 1024 MB) — matching the `bytes` library that body-parser uses for
// `maxRequestSize`, so the two size knobs behave the same way. The bare
// string '0' means "unlimited" and returns 0. Anything that doesn't match
// `digits + KB|MB|GB` (or '0') returns null so the caller can decide how to
// treat malformed input rather than silently coercing it.
const UNITS = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

export function parseSizeToBytes(str) {
  if (typeof str !== 'string') { return null; }
  const s = str.trim();
  if (s === '0') { return 0; }
  const m = /^([0-9]+)(KB|MB|GB)$/i.exec(s);
  if (!m) { return null; }
  return Number(m[1]) * UNITS[m[2].toUpperCase()];
}
