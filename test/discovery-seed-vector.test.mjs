/**
 * decodeSeedVector — the shared front door for a client-supplied embedding.
 *
 * Two routes accept a vector from somewhere else: the federation peer route
 * (a peer's track) and the Auto-DJ picker's `similarToVector` (a seed the
 * caller carried from another server). They used to be one implementation
 * and a copy waiting to happen; these pin the behaviour both rely on.
 *
 * The interesting cases are all rejections. A vector that decodes to the
 * wrong length, or holds NaN, or is all zeros, cannot produce a meaningful
 * cosine — and because the pool is a hard constraint on what Auto-DJ may
 * play, a bad seed that is quietly tolerated becomes "the DJ picked nonsense
 * for the rest of the session" rather than a visible error.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeSeedVector } from '../src/api/discovery.js';

const DIM = 8;
const index = { dim: DIM };

/** base64 of a float32 little-endian vector, the wire form both routes take. */
function b64(values) {
  const f = Float32Array.from(values);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64');
}

test('decodes a well-formed vector to the right length', () => {
  const v = decodeSeedVector(index, b64([1, 0, 0, 0, 0, 0, 0, 0]));
  assert.equal(v.length, DIM);
  assert.ok(v instanceof Float32Array);
});

test('returns a unit vector even when the input is scaled', () => {
  // The index is L2-normalized at write time, so a dot product is only a
  // cosine if the query is normalized too. A caller that averaged vectors
  // without re-normalizing must not silently get inflated similarities.
  const v = decodeSeedVector(index, b64([3, 4, 0, 0, 0, 0, 0, 0]));
  const norm = Math.hypot(...v);
  assert.ok(Math.abs(norm - 1) < 1e-6, `expected unit length, got ${norm}`);
  assert.ok(Math.abs(v[0] - 0.6) < 1e-6);
  assert.ok(Math.abs(v[1] - 0.8) < 1e-6);
});

test('leaves an already-normalized vector alone', () => {
  const v = decodeSeedVector(index, b64([0, 1, 0, 0, 0, 0, 0, 0]));
  assert.ok(Math.abs(v[1] - 1) < 1e-6);
});

test('rejects a vector of the wrong length', () => {
  assert.throws(
    () => decodeSeedVector(index, b64([1, 0, 0])),
    (err) => err.status === 400 && /1280|8 float32|float32 values/.test(err.message),
  );
});

test('rejects non-finite values', () => {
  assert.throws(
    () => decodeSeedVector(index, b64([NaN, 0, 0, 0, 0, 0, 0, 0])),
    (err) => err.status === 400 && /non-finite/.test(err.message),
  );
  assert.throws(
    () => decodeSeedVector(index, b64([Infinity, 0, 0, 0, 0, 0, 0, 0])),
    (err) => err.status === 400 && /non-finite/.test(err.message),
  );
});

test('rejects a zero vector', () => {
  // Normalizing this would divide by zero and yield NaNs that then compare
  // against every track in the index.
  assert.throws(
    () => decodeSeedVector(index, b64([0, 0, 0, 0, 0, 0, 0, 0])),
    (err) => err.status === 400 && /zero vector/.test(err.message),
  );
});

test('handles a buffer whose byteOffset is not 4-byte aligned', () => {
  // Buffer.from(base64) can hand back a view into a shared pool at an
  // arbitrary offset; constructing a Float32Array over it directly throws.
  // The decoder copies into a fresh ArrayBuffer for exactly this reason, so
  // decoding many vectors in a row must stay stable.
  for (let i = 0; i < 64; i++) {
    const v = decodeSeedVector(index, b64([i + 1, 1, 0, 0, 0, 0, 0, 0]));
    assert.equal(v.length, DIM);
    assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-6);
  }
});
