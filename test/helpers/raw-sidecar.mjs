/**
 * A bare p2p-sidecar child for protocol-level tests: spawn the binary, speak
 * line-JSON RPC, collect unsolicited events. This is the same shape
 * discovery-p2p.test.mjs uses inline for its two-peer suites — extracted for
 * new protocol suites (first consumer: the DM tests) so they don't re-clone
 * it. The inline copy in discovery-p2p.test.mjs predates this helper;
 * folding it over is deliberate follow-up churn, not this PR's job.
 */

import { spawn } from 'node:child_process';
import readline from 'node:readline';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function pollUntil(fn, { timeoutMs = 20000, stepMs = 100, what = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) { return v; }
    if (Date.now() - start > timeoutMs) { throw new Error(`timed out waiting for ${what}`); }
    await sleep(stepMs);
  }
}

export class RawSidecar {
  constructor(bin, dataDir) {
    this.proc = spawn(bin, ['--data-dir', dataDir], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map();
    this.nextId = 1;
    this.events = [];   // every unsolicited event, in arrival order
    this.endpointId = null;
    this.ticket = null;
    this.ready = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('sidecar never became ready')), 30000);
      readline.createInterface({ input: this.proc.stdout }).on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.event === 'ready') {
          clearTimeout(t);
          this.endpointId = msg.endpointId;
          this.ticket = msg.ticket;
          resolve(msg);
          return;
        }
        if (msg.event) { this.events.push(msg); return; }
        const w = this.pending.get(msg.id);
        if (w) { this.pending.delete(msg.id); msg.ok ? w.resolve(msg) : w.reject(new Error(msg.error)); }
      });
      this.proc.once('exit', () => reject(new Error('sidecar exited before ready')));
    });
  }

  rpc(cmd, params = {}, timeoutMs = 60000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, cmd, ...params }) + '\n');
      setTimeout(() => {
        if (this.pending.delete(id)) { reject(new Error(`sidecar rpc timeout (${cmd})`)); }
      }, timeoutMs).unref();
    });
  }

  waitForEvent(type, predicate = () => true, timeoutMs = 20000) {
    return pollUntil(
      () => this.events.find((e) => e.event === type && predicate(e)),
      { timeoutMs, what: `sidecar event '${type}'` },
    );
  }

  async stop() {
    try { this.proc.stdin.end(); } catch (_err) { /* noop */ }
    await new Promise((resolve) => {
      const t = setTimeout(() => { this.proc.kill(); resolve(); }, 5000);
      this.proc.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }
}
