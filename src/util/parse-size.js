'use strict';

// Parse a human-readable size string into a byte count.
//
//   parseSizeToBytes('500MB') -> 524288000
//   parseSizeToBytes('1.5GB') -> 1610612736
//   parseSizeToBytes('0')     -> 0   (sentinel: "no limit")
//
// Units are case-insensitive and 1024-based (KB = 1024 B, MB = 1024 KB,
// GB = 1024 MB) — matching the `bytes` library that body-parser uses for
// `maxRequestSize`, so the two size knobs behave the same way. The number may
// be a whole value or a decimal ('1.5GB', '0.5MB'). The bare string '0' means
// "unlimited" and returns 0. Anything that doesn't match `number + KB|MB|GB`
// (or '0') returns null so the caller can decide how to treat malformed input
// rather than silently coercing it.
const UNITS = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

export function parseSizeToBytes(str) {
  if (typeof str !== 'string') { return null; }
  const s = str.trim();
  if (s === '0') { return 0; }
  // Whole number or decimal; a leading digit is required, so '.5GB' and a
  // trailing-dot '1.GB' are both rejected.
  const m = /^([0-9]+(?:\.[0-9]+)?)(KB|MB|GB)$/i.exec(s);
  if (!m) { return null; }
  return Math.round(Number(m[1]) * UNITS[m[2].toUpperCase()]);
}
