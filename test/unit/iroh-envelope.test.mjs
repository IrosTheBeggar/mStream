/**
 * Versioned ticket-envelope helpers shared by the tunnel pairing code and the
 * federation ticket. Pure functions (no native module needed), so these always
 * run. The tunnel-specific wrapper behavior (field validation, legacy bare
 * codes) stays covered by iroh-ticket.test.mjs.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelope, parseEnvelope } from '../../src/state/iroh-common.js';

describe('iroh ticket envelope', () => {
  test('round-trips a payload under a prefix + version', () => {
    const s = buildEnvelope('mstrfed', 1, { t: 'endpointabc', k: 'fedk_xyz' });
    assert.match(s, /^mstrfed1:/);
    const { version, payload } = parseEnvelope(s, { prefix: 'mstrfed', maxVersion: 1, label: 'federation ticket' });
    assert.equal(version, 1);
    assert.deepEqual(payload, { t: 'endpointabc', k: 'fedk_xyz' });
  });

  test('rejects a missing prefix unless allowBare', () => {
    const bare = Buffer.from(JSON.stringify({ a: 1 })).toString('base64url');
    assert.throws(
      () => parseEnvelope(bare, { prefix: 'mstrfed', maxVersion: 1, label: 'federation ticket' }),
      /Invalid federation ticket/,
    );
    const { version, payload } = parseEnvelope(bare, { prefix: 'mstr', maxVersion: 1, allowBare: true, label: 'pairing code' });
    assert.equal(version, 1); // bare body = implicit v1
    assert.deepEqual(payload, { a: 1 });
  });

  test('a ticket from one prefix fails cleanly in the other parser', () => {
    const fed = buildEnvelope('mstrfed', 1, { t: 'x', k: 'y' });
    // 'mstr' + allowBare: 'mstrfed1:...' is not ^mstr\d+: so it falls to the
    // bare-body path and fails JSON parsing — the tunnel parser can't half-read
    // a federation ticket.
    assert.throws(
      () => parseEnvelope(fed, { prefix: 'mstr', maxVersion: 1, allowBare: true, label: 'pairing code' }),
      /Invalid pairing code/,
    );
    const tun = buildEnvelope('mstr', 1, { t: 'x', s: 'y' });
    assert.throws(
      () => parseEnvelope(tun, { prefix: 'mstrfed', maxVersion: 1, label: 'federation ticket' }),
      /Invalid federation ticket/,
    );
  });

  test('rejects a newer version with an actionable error naming the label', () => {
    const s = buildEnvelope('mstrfed', 9, { t: 'x' });
    assert.throws(
      () => parseEnvelope(s, { prefix: 'mstrfed', maxVersion: 1, label: 'federation ticket' }),
      /Federation ticket is version 9.*supports up to v1.*[Uu]pdate/s,
    );
  });

  test('rejects garbage bodies with the label in the message', () => {
    assert.throws(
      () => parseEnvelope('mstrfed1:!!!not-base64-json!!!', { prefix: 'mstrfed', maxVersion: 1, label: 'federation ticket' }),
      /Invalid federation ticket/,
    );
  });
});
