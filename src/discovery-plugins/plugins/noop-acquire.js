// "noop-acquire" — a test-only runnable plug-in, registered only when
// MSTREAM_TEST_DISCOVERY_NOOP_PLUGIN=1 (the integration suites set it).
//
// It exercises the whole job path without touching a catalogue or a disk:
// claims, progress, results, failures and cancellation. The recommendation's
// title steers it — "fail" throws, "slow" takes several steps, anything else
// finishes in three quick ones — so a test can script every outcome.

//
// It also keeps two per-user settings, so the generic plug-in settings routes
// have something to exercise: a plain `note` (one value is refused on
// meaning, not shape) and a secret `token` that must never be read back.

import Joi from 'joi';
import { CAPABILITIES, SCOPES } from '../registry.js';
import { JOB_SCOPES } from '../recommendation.js';
import WebError from '../../util/web-error.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default Object.freeze({
  name: 'noop-acquire',
  title: 'No-op acquire (test only)',
  description: 'Test-only plug-in that pretends to acquire a recommendation. Never registered outside the test environment.',
  capabilities: [CAPABILITIES.ACQUIRE],
  scope: SCOPES.SERVER,
  scopes: [JOB_SCOPES.SONG, JOB_SCOPES.ALBUM],
  concurrency: 2,
  userSettings: {
    note: { schema: Joi.string().max(100) },
    token: { schema: Joi.string().min(4).max(200), secret: true },
  },
  validateSetting(key, value) {
    if (key === 'note' && /forbidden/i.test(value)) { throw new WebError('note: that word is not allowed', 400); }
  },
  describeSettings({ stored }) {
    return { connected: typeof stored.token === 'string' && stored.token.length > 0 };
  },
  async run(ctx) {
    const title = String((ctx.recommendation && ctx.recommendation.title) || '');
    if (/fail/i.test(title)) { throw new Error(`noop-acquire refused "${title}"`); }
    const steps = /slow/i.test(title) ? 40 : 3;
    for (let i = 1; i <= steps; i++) {
      // What a plug-in returns when it honoured a cancel: the runner records
      // the cancel only for a `stopped: 'cancelled'` account (or nothing).
      if (ctx.isCancelled()) { return { stopped: 'cancelled', cancelledAt: i }; }
      ctx.progress(i / steps, `step ${i} of ${steps}`);
      await sleep(/slow/i.test(title) ? 100 : 10);
    }
    return { echoed: title, steps, scope: (ctx.params && ctx.params.scope) || JOB_SCOPES.SONG };
  },
});
