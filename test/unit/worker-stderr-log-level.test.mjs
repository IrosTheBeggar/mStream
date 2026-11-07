/**
 * logWorkerStderr (src/db/task-queue.js) — which log level a forked worker's
 * stderr line lands at.
 *
 * Every background worker's stderr goes through it, and a line that lands at
 * error level paints the server log red. This file pins:
 *
 *   - Node runtime chatter (the ExperimentalWarning banner) stays debug
 *   - "Warning:" lines and ONNX Runtime's own warnings are warn-level: the
 *     native discovery runtime prints "onnxruntime cpuid_info warning: Unknown
 *     CPU vendor …" on every pass on Apple Silicon Linux VMs (Docker Desktop
 *     for Mac), and its logger tags warnings "[W:onnxruntime:…]" inside ANSI
 *     colour codes
 *   - ONNX Runtime's error lines, the API-version mismatch a forced native
 *     runtime prints before it crashes, and any other text stay error-level
 *   - an empty line logs nothing
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import winston from 'winston';

import { logWorkerStderr } from '../../src/db/task-queue.js';

// The module calls winston.<level>() at call time, so swapping the methods
// is enough to capture what one stderr line turns into.
function levelsFor(line, prefix = 'Discovery-embedding') {
  const lines = { debug: [], info: [], warn: [], error: [] };
  const real = { debug: winston.debug, info: winston.info, warn: winston.warn, error: winston.error };
  for (const level of Object.keys(lines)) { winston[level] = (msg) => { lines[level].push(String(msg)); }; }
  try { logWorkerStderr(prefix, line); } finally { Object.assign(winston, real); }
  return lines;
}

function only(lines, level) {
  for (const [name, got] of Object.entries(lines)) {
    assert.equal(got.length, name === level ? 1 : 0, `expected one ${level} line, got ${JSON.stringify(lines)}`);
  }
  return lines[level][0];
}

describe('logWorkerStderr', () => {
  test('Node runtime chatter is debug-level', () => {
    only(levelsFor('(node:4242) ExperimentalWarning: SQLite is an experimental feature'), 'debug');
    only(levelsFor('(Use `node --trace-warnings ...` to show where the warning was created)'), 'debug');
  });

  test('a "Warning:" line is warn-level', () => {
    assert.equal(only(levelsFor('Warning: something odd', 'File scan'), 'warn'), 'File scan: Warning: something odd');
  });

  test("ONNX Runtime's early cpuid_info warning is warn-level, without the error tag", () => {
    const line = 'onnxruntime cpuid_info warning: Unknown CPU vendor. cpuinfo_vendor value: 0';
    assert.equal(only(levelsFor(line), 'warn'), `Discovery-embedding: ${line}`);
  });

  test("ONNX Runtime's logger warnings are warn-level, colour codes and all", () => {
    const line = '\u001b[0;93m2026-10-28 13:45:04.158934 [W:onnxruntime:onnxruntime-node, '
      + 'session_state.cc:1166 VerifyEachNodeIsAssignedToAnEp] Some nodes were not assigned '
      + 'to the preferred execution providers\u001b[m';
    only(levelsFor(line), 'warn');
  });

  test("ONNX Runtime's logger errors stay error-level", () => {
    const line = '\u001b[1;31m2026-10-28 13:45:04.158934 [E:onnxruntime:, inference_session.cc:2105 '
      + 'operator()] Exception during initialization\u001b[m';
    assert.equal(only(levelsFor(line), 'error'), `Discovery-embedding error: ${line}`);
  });

  test('the API-version mismatch a forced native runtime prints stays error-level', () => {
    only(levelsFor('The requested API version [30] is not available, only API versions [1, 24] are '
      + 'supported in this build. Current ORT Version is: 1.24.4'), 'error');
  });

  test('anything else is error-level', () => {
    assert.equal(only(levelsFor('TypeError: x is not a function', 'Waveform pass'), 'error'),
      'Waveform pass error: TypeError: x is not a function');
    only(levelsFor('a warning: inside an ordinary error message'), 'error');
  });

  test('an empty line logs nothing', () => {
    const lines = levelsFor('');
    assert.deepEqual(lines, { debug: [], info: [], warn: [], error: [] });
  });
});
