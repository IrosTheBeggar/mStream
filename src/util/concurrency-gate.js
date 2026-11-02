// A small in-process concurrency gate: at most `maxActive` holders at once,
// at most `maxWaiting` callers queued (FIFO) behind them, and an immediate
// 429 for anyone past that. For CPU-heavy routes that nothing else limits —
// the flow orderer (api/flow.js) costs up to about a second of CPU per call
// at its 1000-song cap, and a burst of them would starve every other request.
//
// The queue is capped by count only, with no timer: a waiter's turn comes
// when a holder releases, and a holder always releases (callers release in a
// `finally`).

import WebError from './web-error.js';

export function createConcurrencyGate({ maxActive = 1, maxWaiting = 4, busyMessage = 'Too many requests in progress, try again shortly' } = {}) {
  let active = 0;
  const queue = [];

  // Each grant gets its own release; a second call is a no-op, so a double
  // release can never free a slot someone else holds. A release hands the
  // slot straight to the next waiter (active stays the same).
  const grant = () => {
    let done = false;
    return () => {
      if (done) { return; }
      done = true;
      const next = queue.shift();
      if (next) { next(grant()); } else { active--; }
    };
  };

  return {
    acquire() {
      if (active < maxActive) {
        active++;
        return Promise.resolve(grant());
      }
      if (queue.length < maxWaiting) {
        return new Promise((resolve) => { queue.push(resolve); });
      }
      return Promise.reject(new WebError(busyMessage, 429));
    },
    get active() { return active; },
    get waiting() { return queue.length; },
  };
}
