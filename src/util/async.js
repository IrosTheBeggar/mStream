/**
 * Small async primitives shared across the server.
 *
 * Both helpers here exist to fix one recurring bug: racing a promise against a
 * BARE timer.
 *
 *   await Promise.race([
 *     thing(),
 *     new Promise((_r, rej) => setTimeout(() => rej(new Error('too slow')), 25000)),
 *   ]);
 *
 * When `thing()` wins, the timer is still armed. Node keeps the event loop
 * alive until every pending timer fires, so a call that finished in
 * milliseconds still holds the process — and the orphaned rejection handler —
 * for the full timeout. In the iroh/federation dial paths that was 25s per
 * connect and 8s per online() wait, on every call, in the running server.
 *
 * Clearing the timer in a `finally` costs nothing and removes the leak. Both
 * helpers return exactly what the bare race returned; only the leak is gone.
 *
 * NOTE on the tempting wrong fix: do NOT reach for `.unref()` on the timer in
 * the online() waits. There the timer is the intended WINNER when the relay
 * stalls (it is what lets boot proceed on a slow network), and an unref'd
 * timer would let the process exit instead of carrying on. Disarming the
 * LOSER, as below, is the fix; never silencing the winner.
 *
 * (These replaced a `delay()` helper in state/iroh-common.js, which is why
 * that export is gone — every caller raced it bare.)
 */

/**
 * Race `promise` against a deadline, rejecting with `message` if the deadline
 * wins. The timer is always disarmed.
 *
 * Use where exceeding the deadline is a FAILURE the caller must handle — a
 * dial that never lands, a peer that never answers.
 */
export async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Settle when `promise` settles or `ms` elapses, whichever comes first,
 * resolving to `timeoutValue` if the timer wins. The timer is always disarmed.
 *
 * Use where exceeding the budget is NOT a failure — "wait for this, but don't
 * block forever." The caller carries on either way, so this never rejects for
 * the timeout; a rejection from `promise` itself still propagates, which is why
 * callers that want to ignore those pass one that has already `.catch()`ed.
 */
export async function settleWithin(promise, ms, timeoutValue) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(timeoutValue), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
