// "noop-acquire" — a test-only runnable plug-in, registered only when
// MSTREAM_TEST_DISCOVERY_NOOP_PLUGIN=1 (the integration suites set it).
//
// It exercises the whole job path without touching a catalogue or a disk:
// claims, progress, results, failures and cancellation. The recommendation's
// title steers it — "fail" throws, "slow" takes several steps, anything else
// finishes in three quick ones — so a test can script every outcome.

import { CAPABILITIES, SCOPES } from '../registry.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default Object.freeze({
  name: 'noop-acquire',
  title: 'No-op acquire (test only)',
  description: 'Test-only plug-in that pretends to acquire a recommendation. Never registered outside the test environment.',
  capabilities: [CAPABILITIES.ACQUIRE],
  scope: SCOPES.SERVER,
  concurrency: 2,
  async run(ctx) {
    const title = String((ctx.recommendation && ctx.recommendation.title) || '');
    if (/fail/i.test(title)) { throw new Error(`noop-acquire refused "${title}"`); }
    const steps = /slow/i.test(title) ? 40 : 3;
    for (let i = 1; i <= steps; i++) {
      if (ctx.isCancelled()) { return { cancelledAt: i }; }
      ctx.progress(i / steps, `step ${i} of ${steps}`);
      await sleep(/slow/i.test(title) ? 100 : 10);
    }
    return { echoed: title, steps };
  },
});
