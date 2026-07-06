// Seed-list signing: the canonicalization + ed25519 verify that guards the
// community bootstrap path. Adversarial by design — every rejection here is
// an attack the fetcher must treat as a failed fetch.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  canonicalSeedListString,
  signSeedList,
  verifySeedList,
  SEEDS_PUBLIC_KEY_B64,
} from '../../src/state/discovery-seeds-verify.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUB_B64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const PRIV_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

const BASE_DOC = {
  version: 1,
  seq: 3,
  seeds: [
    { name: 'seed-one', endpointId: 'a'.repeat(64), ticket: 'endpoint' + 'x'.repeat(40) },
    { name: 'seed-two', endpointId: 'b'.repeat(64), ticket: 'endpoint' + 'y'.repeat(40) },
  ],
};

describe('discovery seeds — list signing', () => {
  // Verify against OUR throwaway key for the whole suite; the baked
  // production key is asserted on separately below.
  before(() => { process.env.MSTREAM_TEST_SEEDS_PUBKEY = PUB_B64; });
  after(() => { delete process.env.MSTREAM_TEST_SEEDS_PUBKEY; });

  test('sign → verify roundtrip accepts a genuine list', () => {
    const signed = signSeedList(BASE_DOC, PRIV_PEM);
    assert.equal(typeof signed.signature, 'string');
    verifySeedList(signed); // throws on failure
  });

  test('canonical string covers seq and every entry field, in order', () => {
    const s = canonicalSeedListString(BASE_DOC);
    assert.equal(s,
      'mstream-discovery-seeds-v1|seq:3'
      + `|seed-one,${'a'.repeat(64)},endpoint${'x'.repeat(40)}`
      + `|seed-two,${'b'.repeat(64)},endpoint${'y'.repeat(40)}`);
  });

  test('any field tamper after signing is rejected', () => {
    const signed = signSeedList(BASE_DOC, PRIV_PEM);
    const tampers = [
      (d) => { d.seeds[0].ticket = 'endpoint' + 'z'.repeat(40); },   // swapped dial target
      (d) => { d.seeds[0].endpointId = 'c'.repeat(64); },            // swapped identity
      (d) => { d.seq = d.seq + 1; },                                  // seq forged forward
      (d) => { d.seeds.push({ name: 'evil', endpointId: 'd'.repeat(64), ticket: 'endpoint' + 'e'.repeat(40) }); },
      (d) => { d.seeds.pop(); },                                      // entry removed
      (d) => { [d.seeds[0], d.seeds[1]] = [d.seeds[1], d.seeds[0]]; }, // reordered
    ];
    for (const tamper of tampers) {
      const doc = structuredClone(signed);
      tamper(doc);
      assert.throws(() => verifySeedList(doc), /signature verification failed/);
    }
  });

  test('a stripped or garbage signature is rejected, never treated as unsigned-ok', () => {
    const signed = signSeedList(BASE_DOC, PRIV_PEM);
    const stripped = { ...signed };
    delete stripped.signature;
    assert.throws(() => verifySeedList(stripped), /missing signature/);
    assert.throws(() => verifySeedList({ ...signed, signature: '' }), /missing signature/);
    assert.throws(() => verifySeedList({ ...signed, signature: 'AAAA' }), /verification failed/);
  });

  test('a list signed by a different key is rejected', () => {
    const other = crypto.generateKeyPairSync('ed25519');
    const signed = signSeedList(BASE_DOC, other.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    assert.throws(() => verifySeedList(signed), /signature verification failed/);
  });

  test('separator characters in fields are refused at both sign and verify time', () => {
    for (const bad of ['pipe|name', 'comma,name']) {
      const doc = structuredClone(BASE_DOC);
      doc.seeds[0].name = bad;
      assert.throws(() => signSeedList(doc, PRIV_PEM), /without '\|' or ','/);
      assert.throws(() => verifySeedList({ ...doc, signature: 'AAAA' }), /without '\|' or ','/);
    }
  });

  test('missing or non-integer seq is refused', () => {
    for (const seq of [undefined, -1, 1.5, '3']) {
      const doc = { ...structuredClone(BASE_DOC), seq };
      assert.throws(() => signSeedList(doc, PRIV_PEM), /integer `seq`/);
    }
  });
});

describe('discovery seeds — production trust root', () => {
  test('the baked public key is a valid ed25519 SPKI key', () => {
    const key = crypto.createPublicKey({
      key: Buffer.from(SEEDS_PUBLIC_KEY_B64, 'base64'), format: 'der', type: 'spki',
    });
    assert.equal(key.asymmetricKeyType, 'ed25519');
  });

  test('the committed seeds/discovery-seeds.json verifies against the baked key', async () => {
    const fs = await import('node:fs');
    const url = new URL('../../seeds/discovery-seeds.json', import.meta.url);
    const doc = JSON.parse(fs.readFileSync(url, 'utf8'));
    // No env override in this suite — this is the real production check:
    // a PR that edits the seed list without running the signing script
    // fails here before it can break every client's fetch.
    assert.equal(process.env.MSTREAM_TEST_SEEDS_PUBKEY, undefined);
    verifySeedList(doc);
    assert.ok(doc.seq >= 1);
  });
});
