/**
 * Unit tests for src/torrent/constants.js — the frozen enums + the
 * two predicates. Quick to run; locks the wire-format identity of the
 * value strings so a future rename can't quietly break the UI or the
 * DB rows that key off them.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIDENCE, SOURCE, STATUS, CLIENT_TYPE, ENABLED_FOR,
  isUsable, isClientActive,
} from '../src/torrent/constants.js';

describe('enums are frozen + have the expected wire values', () => {
  test('CONFIDENCE', () => {
    assert.deepEqual(CONFIDENCE, {
      VERIFIED: 'verified', INFERRED: 'inferred',
      PENDING: 'pending', UNCONFIRMED: 'unconfirmed',
    });
    assert.equal(Object.isFrozen(CONFIDENCE), true);
  });
  test('SOURCE', () => {
    assert.deepEqual(SOURCE, { AUTO: 'auto', MANUAL: 'manual' });
    assert.equal(Object.isFrozen(SOURCE), true);
  });
  test('STATUS', () => {
    assert.equal(STATUS.DOWNLOADING, 'downloading');
    assert.equal(STATUS.SEEDING, 'seeding');
    assert.equal(STATUS.PAUSED, 'paused');
    assert.equal(STATUS.ERROR, 'error');
    assert.equal(Object.isFrozen(STATUS), true);
  });
  test('CLIENT_TYPE', () => {
    assert.equal(CLIENT_TYPE.DISABLED, 'disabled');
    assert.equal(CLIENT_TYPE.TRANSMISSION, 'transmission');
    assert.equal(CLIENT_TYPE.QBITTORRENT, 'qbittorrent');
    assert.equal(CLIENT_TYPE.DELUGE, 'deluge');
    assert.equal(Object.isFrozen(CLIENT_TYPE), true);
  });
  test('ENABLED_FOR', () => {
    assert.deepEqual(ENABLED_FOR, { ALL: 'all', WHITELIST: 'whitelist' });
    assert.equal(Object.isFrozen(ENABLED_FOR), true);
  });
});

describe('isUsable predicate', () => {
  test('verified is usable', () => assert.equal(isUsable('verified'), true));
  test('inferred is usable', () => assert.equal(isUsable('inferred'), true));
  test('pending is NOT usable (race-window safety)', () => assert.equal(isUsable('pending'), false));
  test('unconfirmed is NOT usable', () => assert.equal(isUsable('unconfirmed'), false));
  test('null/undefined NOT usable', () => {
    assert.equal(isUsable(null), false);
    assert.equal(isUsable(undefined), false);
  });
  test('arbitrary string NOT usable', () => {
    assert.equal(isUsable('something_else'), false);
  });
});

describe('isClientActive predicate', () => {
  test('transmission/qbittorrent/deluge are active', () => {
    assert.equal(isClientActive('transmission'), true);
    assert.equal(isClientActive('qbittorrent'), true);
    assert.equal(isClientActive('deluge'), true);
  });
  test('disabled is not active', () => {
    assert.equal(isClientActive('disabled'), false);
  });
  test('null/undefined is not active', () => {
    assert.equal(isClientActive(null), false);
    assert.equal(isClientActive(undefined), false);
  });
});
