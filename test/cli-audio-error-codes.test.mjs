/**
 * cli-audio's handleRequest used to collapse EVERY failure to a blanket 400.
 * It now maps known conditions to real codes via WebError (409 queue-state,
 * 404 unknown route, 400 bad input) and treats anything unexpected as 500.
 *
 * BaseCliAdapter owns handleRequest + _dispatch + the queue logic, so a stub
 * subclass (no-op player hooks) exercises all of it without a real CLI player.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BaseCliAdapter } from '../src/api/cli-audio/base.js';

class StubAdapter extends BaseCliAdapter {
  async _loadFile() {}
  async _pause() {}
  async _resume() {}
  async _stop() {}
  async _seek() {}
  async _setVolume() {}
}

test('happy path returns 200', async () => {
  const a = new StubAdapter('stub');
  assert.equal((await a.handleRequest('POST', '/pause', {})).status, 200);
});

test('missing required body → 400', async () => {
  const a = new StubAdapter('stub');
  assert.equal((await a.handleRequest('POST', '/play', {})).status, 400);
  assert.equal((await a.handleRequest('POST', '/queue/add', {})).status, 400);
  assert.equal((await a.handleRequest('POST', '/queue/add-many', {})).status, 400);
});

test('out-of-range queue index → 400', async () => {
  const a = new StubAdapter('stub');
  assert.equal((await a.handleRequest('POST', '/queue/play-index', { index: 5 })).status, 400);
  assert.equal((await a.handleRequest('POST', '/queue/remove', { index: 5 })).status, 400);
});

test('queue-state conflicts → 409', async () => {
  const a = new StubAdapter('stub');
  // empty queue: nothing to advance to / nothing to step back from
  assert.equal((await a.handleRequest('POST', '/next', {})).status, 409);
  assert.equal((await a.handleRequest('POST', '/previous', {})).status, 409);
});

test('unknown route → 404', async () => {
  const a = new StubAdapter('stub');
  assert.equal((await a.handleRequest('GET', '/does-not-exist', {})).status, 404);
  assert.equal((await a.handleRequest('POST', '/play/extra', {})).status, 404);
});

test('an unexpected (non-WebError) failure → 500, not 400', async () => {
  class Boom extends StubAdapter {
    async _loadFile() { throw new Error('kaboom'); }
  }
  const a = new Boom('boom');
  const r = await a.handleRequest('POST', '/play', { file: '/x.mp3' });
  assert.equal(r.status, 500);
  assert.equal(r.data.error, 'kaboom');
});
