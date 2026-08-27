/**
 * Direct messages over the sidecar's third ALPN (mstream/discovery-dm/1) —
 * the transport under federation requests. Two bare sidecars on loopback,
 * real iroh dials:
 *
 *  - fail-closed: a peer that never opted in refuses with 'not-accepting'
 *    (delivered:false — REACHED and refused, distinct from unreachable);
 *  - round-trip: after setDmAccept, a dm lands as a {event:'dm'} with the
 *    QUIC-authenticated sender id, and the sender sees delivered:true;
 *  - addressing: an endpoint ticket works cold; a bare endpoint id works
 *    once the ticket dial seeded the address book (the catalog flow);
 *  - sender-side size cap refuses oversized payloads before dialing;
 *  - per-remote rate limit: a fresh sender gets DM_PER_REMOTE_MAX through,
 *    then 'rate-limited';
 *  - a dead peer REJECTS (unreachable) rather than resolving refused — the
 *    retry/terminal distinction PR 3's request queue is built on.
 *
 * ⚠ SIDECAR-VERSION GATE: the transport lives in the sidecar repo
 * (IrosTheBeggar/mstream-p2p-sidecar); the release this checkout pins
 * (v1.0.2) predates the `dm` command. A checkout with no sidecar binary
 * at all skips the whole suite (resolveSidecarBinary → null — fresh CI's
 * state); a fetched pre-dm binary probes and skips each test with a
 * reason; a dev cargo build of the DM branch (cloned into p2p-sidecar/)
 * or a ≥v1.0.3 pin runs everything for real.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RawSidecar } from '../helpers/raw-sidecar.mjs';
import { resolveSidecarBinary } from '../../src/state/discovery-p2p.js';

const SIDECAR_BIN = resolveSidecarBinary();
const PER_REMOTE_MAX = 6; // mirrors DM_PER_REMOTE_MAX in the sidecar repo's src/main.rs

(SIDECAR_BIN ? describe : describe.skip)('discovery-dm — sidecar direct messages', () => {
  let tmpDir;
  let alice, bob; // alice sends, bob receives
  let sidecarHasDm = false;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-dm-'));
    alice = new RawSidecar(SIDECAR_BIN, path.join(tmpDir, 'alice'));
    bob = new RawSidecar(SIDECAR_BIN, path.join(tmpDir, 'bob'));
    await alice.ready; await bob.ready;
    try {
      await alice.rpc('setDmAccept', { accept: false });
      sidecarHasDm = true;
    } catch (_err) {
      sidecarHasDm = false; // old binary: "unknown command: setDmAccept"
    }
  });

  after(async () => {
    if (alice) { await alice.stop(); }
    if (bob) { await bob.stop(); }
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); }
  });

  const gate = (t) => {
    if (!sidecarHasDm) { t.skip('pinned sidecar predates the dm protocol (pin bumps after the sidecar release)'); return true; }
    return false;
  };

  test('fail-closed: a peer that never opted in refuses, typed and immediate', async (t) => {
    if (gate(t)) { return; }
    // Bob has NOT called setDmAccept — boot state must refuse.
    const r = await alice.rpc('dm', { to: bob.ticket, payload: { type: 'probe', uuid: 'dm-0' } });
    assert.equal(r.delivered, false);
    assert.equal(r.reason, 'not-accepting');
    assert.equal(bob.events.filter((e) => e.event === 'dm').length, 0,
      'a refused dm must never surface to Node');
  });

  test('round-trip: dm lands as an event with the authenticated sender id', async (t) => {
    if (gate(t)) { return; }
    await bob.rpc('setDmAccept', { accept: true });
    const payload = { type: 'federation-request', uuid: 'dm-1', name: "Alice's mStream", msg: 'hello' };
    const r = await alice.rpc('dm', { to: bob.ticket, payload });
    assert.equal(r.delivered, true);

    const evt = await bob.waitForEvent('dm', (e) => e.payload && e.payload.uuid === 'dm-1');
    assert.equal(evt.from, alice.endpointId, 'from must be the QUIC-authenticated sender');
    assert.deepEqual(evt.payload, payload, 'payload must arrive verbatim');
  });

  test('bare endpoint id addresses a peer the address book already knows', async (t) => {
    if (gate(t)) { return; }
    // The ticket dial above seeded MemoryLookup — a bare id (what the
    // catalog stores) must now dial without any external discovery.
    const r = await alice.rpc('dm', { to: bob.endpointId, payload: { type: 'probe', uuid: 'dm-2' } });
    assert.equal(r.delivered, true);
    await bob.waitForEvent('dm', (e) => e.payload && e.payload.uuid === 'dm-2');
  });

  test('sender refuses an oversized payload before dialing', async (t) => {
    if (gate(t)) { return; }
    await assert.rejects(
      alice.rpc('dm', { to: bob.ticket, payload: { type: 'bloat', blob: 'x'.repeat(9000) } }),
      /too large/);
  });

  test('per-remote rate limit trips on a fresh sender, typed refusal', async (t) => {
    if (gate(t)) { return; }
    // A fresh identity gets a clean per-remote budget against bob.
    const mallory = new RawSidecar(SIDECAR_BIN, path.join(tmpDir, 'mallory'));
    try {
      await mallory.ready;
      for (let i = 0; i < PER_REMOTE_MAX; i++) {
        const r = await mallory.rpc('dm', { to: bob.ticket, payload: { type: 'spam', uuid: `m-${i}` } });
        assert.equal(r.delivered, true, `send ${i + 1}/${PER_REMOTE_MAX} is inside the budget`);
      }
      const over = await mallory.rpc('dm', { to: bob.ticket, payload: { type: 'spam', uuid: 'm-over' } });
      assert.equal(over.delivered, false);
      assert.equal(over.reason, 'rate-limited');
    } finally {
      await mallory.stop();
    }
  });

  test('a dead peer rejects (unreachable) — never a typed refusal', { timeout: 60000 }, async (t) => {
    if (gate(t)) { return; }
    // PR 3's queue retries transport errors and treats refusals as
    // terminal, so the two must never blur. Kill a sidecar, keep its
    // ticket, dial it. (The dial burns its failure budget — up to the 25s
    // connect timeout — hence this test's own generous timeout.)
    const ghost = new RawSidecar(SIDECAR_BIN, path.join(tmpDir, 'ghost'));
    await ghost.ready;
    const ghostTicket = ghost.ticket;
    await ghost.stop();

    await assert.rejects(
      alice.rpc('dm', { to: ghostTicket, payload: { type: 'probe', uuid: 'dm-ghost' } }),
      /unreachable|timed out|support direct messages/);
  });
});
