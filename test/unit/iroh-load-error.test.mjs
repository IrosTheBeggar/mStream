/**
 * describeLoadError (src/state/iroh-common.js): what the server logs when the
 * iroh native binding does not load. napi-rs's loader throws one generic
 * "Cannot find native binding. npm has a bug…" error for every failure and
 * keeps each attempt's error in `cause`; the dlopen failure of the shipped
 * .node — on Linux a glibc older than the binding needs — is what the
 * operator has to see (mStream#1101's host logged the npm text instead, and
 * Quick Connect looked "unavailable on this platform").
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { describeLoadError } from '../../src/state/iroh-common.js';

const NAPI_MSG = 'Cannot find native binding. npm has a bug related to optional dependencies (https://github.com/npm/cli/issues/4828). Please try `npm i` again after removing both package-lock.json and node_modules directory.';
const notFound = (name) => Object.assign(new Error(`Cannot find module '${name}'`), { code: 'MODULE_NOT_FOUND' });
const DLOPEN = "/opt/mstream/bin/iroh/iroh.linux-x64-gnu.node: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.34' not found (required by /opt/mstream/bin/iroh/iroh.linux-x64-gnu.node)";

// What @number0/iroh's index.js throws: the attempts in order, chained so
// that each one's `cause` is the previous attempt (loadErrors.reduce), the
// last attempt being the thrown error's cause.
function napiError(attempts) {
  const chained = attempts.reduce((prev, cur) => { cur.cause = prev; return cur; });
  return new Error(NAPI_MSG, { cause: chained });
}

describe('iroh-common: describeLoadError', () => {
  test('surfaces the dlopen failure behind the napi-rs text, with the host glibc', () => {
    // NAPI_RS_NATIVE_LIBRARY_PATH is tried first, so the dlopen error is the
    // deepest link of the chain, behind the platform-package misses.
    const err = napiError([new Error(DLOPEN), notFound('@number0/iroh-linux-x64-gnu'), notFound('@number0/iroh-linux-x64-musl')]);
    assert.equal(describeLoadError(err, '2.31'), `native binding failed to load (this host's glibc is 2.31): ${DLOPEN}`);
  });

  test('without a known host glibc: the dlopen message alone', () => {
    const err = napiError([new Error(DLOPEN)]);
    assert.equal(describeLoadError(err, null), `native binding failed to load: ${DLOPEN}`);
  });

  test('an array of attempts works too', () => {
    const err = new Error(NAPI_MSG, { cause: [notFound('@number0/iroh-linux-x64-gnu'), new Error('wrong ELF class: ELFCLASS32')] });
    assert.equal(describeLoadError(err, '2.39'), "native binding failed to load (this host's glibc is 2.39): wrong ELF class: ELFCLASS32");
  });

  test('only module-not-found attempts (no platform package at all): the original message', () => {
    const err = napiError([notFound('@number0/iroh-linux-x64-gnu'), notFound('@number0/iroh-linux-x64-musl')]);
    assert.equal(describeLoadError(err, '2.31'), NAPI_MSG);
  });

  test('an error without causes passes through', () => {
    assert.equal(describeLoadError(new Error('boom'), '2.31'), 'boom');
    assert.equal(describeLoadError('not an error', null), 'not an error');
  });
});
