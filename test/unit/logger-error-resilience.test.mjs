// A winston transport write failure (ENOSPC on the log file when the disk
// fills) is re-emitted as 'error' on the default logger; with no listener
// that is an uncaught exception that kills the process — at exactly the
// moment the boot hold (src/server.js) needs logging to stay soft.
// src/logger.js attaches the listener at module init; this proves it holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import winston from 'winston';
import '../../src/logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a transport error does not crash the process', async () => {
  const t = new winston.transports.Console({ silent: true });
  winston.add(t);
  try {
    // Without src/logger.js's logger-level 'error' listener this emit is an
    // uncaught exception: the test (and its runner process) would die here,
    // not fail an assertion.
    t.emit('error', new Error('fake ENOSPC'));
    await sleep(50);
    assert.ok(true, 'process survived a transport error');
  } finally {
    winston.remove(t);
  }
});
