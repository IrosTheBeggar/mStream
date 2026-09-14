/**
 * src/stats/ingest.js — the pure judgements the ingest route applies.
 *
 *  - decideCounted: the play-threshold rule at its boundaries, with and
 *    without a known duration, and under a changed config;
 *  - parseInstant / checkStartedAt: ISO, epoch-ms and stored-text inputs,
 *    the five-minute future skew, the retention floor (and retention off);
 *  - clientLabel: the `name/version` stored on every row.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideCounted, parseInstant, checkStartedAt, retentionFloor, DEFAULTS, FUTURE_SKEW_MS,
} from '../../src/stats/ingest.js';
import { clientLabel } from '../../src/api/stats.js';

describe('decideCounted', () => {
  test('30 seconds counts; a hair under does not', () => {
    assert.equal(decideCounted(30000, 300000), true);
    assert.equal(decideCounted(29999, 300000), false);
  });
  test('half of a short track counts before 30 seconds', () => {
    assert.equal(decideCounted(20000, 40000), true);
    assert.equal(decideCounted(19999, 40000), false);
  });
  test('unknown or zero duration falls back to the time rule alone', () => {
    assert.equal(decideCounted(25000, null), false);
    assert.equal(decideCounted(25000, 0), false);
    assert.equal(decideCounted(30000, undefined), true);
  });
  test('the config moves the bar; a fraction of 0 disables that rule', () => {
    assert.equal(decideCounted(10000, 300000, { playThresholdMs: 10000, playThresholdFraction: 0.5 }), true);
    assert.equal(decideCounted(20000, 40000, { playThresholdMs: 30000, playThresholdFraction: 0 }), false);
    assert.equal(decideCounted(20000, 40000, {}), true); // missing keys → defaults
  });
  test('garbage never counts', () => {
    assert.equal(decideCounted(-1, 100), false);
    assert.equal(decideCounted('30000', 100), false);
  });
});

describe('parseInstant', () => {
  test('accepts ISO, epoch ms, stored text and Dates', () => {
    assert.equal(parseInstant('2026-09-04T19:04:00.500Z').toISOString(), '2026-09-04T19:04:00.500Z');
    assert.equal(parseInstant(Date.UTC(2026, 8, 4, 19, 4)).toISOString(), '2026-09-04T19:04:00.000Z');
    assert.equal(parseInstant('2026-09-04 19:04:00').toISOString(), '2026-09-04T19:04:00.000Z');
    assert.equal(parseInstant(new Date(0)).getTime(), 0);
  });
  test('rejects nonsense', () => {
    assert.equal(parseInstant('yesterday'), null);
    assert.equal(parseInstant(-5), null);
    assert.equal(parseInstant(1.5), null);
    assert.equal(parseInstant(''), null);
    assert.equal(parseInstant(null), null);
  });
});

describe('checkStartedAt', () => {
  const now = new Date('2026-09-09T12:00:00Z');
  test('a recent play passes; the future is allowed only within the skew', () => {
    assert.ok(checkStartedAt('2026-09-09T11:00:00Z', { now }));
    assert.ok(checkStartedAt(now.getTime() + FUTURE_SKEW_MS, { now }));
    assert.equal(checkStartedAt(now.getTime() + FUTURE_SKEW_MS + 1, { now }), null);
  });
  test('retention is the floor, to the hour', () => {
    assert.equal(retentionFloor(now, 24).toISOString(), '2024-09-09T12:00:00.000Z');
    assert.ok(checkStartedAt('2024-09-09T12:00:00Z', { now, retentionMonths: 24 }));
    assert.equal(checkStartedAt('2024-09-09T11:59:59Z', { now, retentionMonths: 24 }), null);
    assert.ok(checkStartedAt('2010-01-01T00:00:00Z', { now, retentionMonths: 0 }));
    assert.equal(checkStartedAt('1999-12-31T23:59:59Z', { now, retentionMonths: 0 }), null);
  });
  test('unparsable is null', () => {
    assert.equal(checkStartedAt('soon', { now }), null);
  });
  test('defaults match the config defaults', () => {
    assert.equal(DEFAULTS.playThresholdMs, 30000);
    assert.equal(DEFAULTS.playThresholdFraction, 0.5);
    assert.equal(DEFAULTS.retentionMonths, 24);
  });
});

describe('clientLabel', () => {
  test('name/version, version optional', () => {
    assert.equal(clientLabel({ name: 'mstream-music', version: '0.36.0' }), 'mstream-music/0.36.0');
    assert.equal(clientLabel({ name: 'web' }), 'web');
    assert.equal(clientLabel({ name: 'web', version: '' }), 'web');
    assert.equal(clientLabel(null), null);
  });
});
