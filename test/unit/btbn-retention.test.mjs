/**
 * BtbN retention helpers (scripts/btbn-retention.mjs): the manifest refresh
 * must pin a build BtbN will still serve months from now. Their prune keeps
 * the 14 newest dailies plus each month's final build (24 months), so the
 * durable pick is the final build of the most recent COMPLETED month — never
 * "the newest daily", which is what the 2026-08-19 pin was when it 404'd on
 * 2026-09-02, two weeks after being committed.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { pickRetainedTag, isRetainedTag, parseAutobuildTag } from '../../scripts/btbn-retention.mjs';

// What BtbN served on 2026-09-04 (newest first): 14 dailies, then month-ends.
const LIVE_2026_09_04 = [
  'autobuild-2026-09-04-14-01', 'autobuild-2026-09-03-13-17', 'autobuild-2026-09-02-13-13',
  'autobuild-2026-09-01-13-13', 'autobuild-2026-08-31-13-27', 'autobuild-2026-08-30-13-12',
  'autobuild-2026-08-29-13-12', 'autobuild-2026-08-28-17-08', 'autobuild-2026-08-27-16-45',
  'autobuild-2026-08-26-13-06', 'autobuild-2026-08-25-13-06', 'autobuild-2026-08-24-13-10',
  'autobuild-2026-08-23-13-03', 'autobuild-2026-08-22-12-58',
  'autobuild-2026-07-31-14-10', 'autobuild-2026-06-30-13-34', 'autobuild-2026-05-31-13-22',
  'autobuild-2024-10-31-12-59',
];
const NOW = new Date('2026-09-04T23:00:00Z');

describe('btbn-retention: pickRetainedTag', () => {
  test('picks the final build of the most recent completed month, not the newest daily', () => {
    assert.equal(pickRetainedTag(LIVE_2026_09_04, NOW), 'autobuild-2026-08-31-13-27');
  });

  test('on the 1st, before that day\'s build exists, still picks last month\'s final build', () => {
    const tags = LIVE_2026_09_04.filter((t) => !t.startsWith('autobuild-2026-09'));
    assert.equal(pickRetainedTag(tags, new Date('2026-09-01T08:23:00Z')), 'autobuild-2026-08-31-13-27');
  });

  test('a completed month with no builds is skipped, not chosen empty', () => {
    const tags = LIVE_2026_09_04.filter((t) => !t.startsWith('autobuild-2026-08'));
    assert.equal(pickRetainedTag(tags, NOW), 'autobuild-2026-07-31-14-10');
  });

  test('order of input does not matter and non-autobuild names are ignored', () => {
    const shuffled = ['latest', 'v1', ...LIVE_2026_09_04].reverse();
    assert.equal(pickRetainedTag(shuffled, NOW), 'autobuild-2026-08-31-13-27');
  });

  test('null when only the current month has builds, or nothing dated at all', () => {
    assert.equal(pickRetainedTag(['autobuild-2026-09-04-14-01', 'autobuild-2026-09-03-13-17'], NOW), null);
    assert.equal(pickRetainedTag(['latest'], NOW), null);
    assert.equal(pickRetainedTag([], NOW), null);
  });

  test('a year boundary counts December as completed in January', () => {
    const tags = ['autobuild-2027-01-02-13-00', 'autobuild-2026-12-31-13-05', 'autobuild-2026-12-30-13-05'];
    assert.equal(pickRetainedTag(tags, new Date('2027-01-03T08:23:00Z')), 'autobuild-2026-12-31-13-05');
  });
});

describe('btbn-retention: isRetainedTag', () => {
  test('the final build of a completed month is retained', () => {
    assert.equal(isRetainedTag('autobuild-2026-08-31-13-27', LIVE_2026_09_04, NOW), true);
    assert.equal(isRetainedTag('autobuild-2026-07-31-14-10', LIVE_2026_09_04, NOW), true);
  });

  test('a current-month build is never retained, however new', () => {
    assert.equal(isRetainedTag('autobuild-2026-09-04-14-01', LIVE_2026_09_04, NOW), false);
    assert.equal(isRetainedTag('autobuild-2026-09-02-13-13', LIVE_2026_09_04, NOW), false);
  });

  test('a superseded daily from a completed month is not retained', () => {
    assert.equal(isRetainedTag('autobuild-2026-08-30-13-12', LIVE_2026_09_04, NOW), false);
    assert.equal(isRetainedTag('autobuild-2026-08-19-19-21', LIVE_2026_09_04, NOW), false); // the pin that 404'd
  });

  test('malformed or non-dated tags are never retained', () => {
    assert.equal(isRetainedTag('latest', LIVE_2026_09_04, NOW), false);
    assert.equal(isRetainedTag('autobuild-2026-08-31', LIVE_2026_09_04, NOW), false);
    assert.equal(isRetainedTag(undefined, LIVE_2026_09_04, NOW), false);
  });
});

describe('btbn-retention: parseAutobuildTag', () => {
  test('parses the dated shape and rejects everything else', () => {
    assert.deepEqual(parseAutobuildTag('autobuild-2026-08-31-13-27'),
      { tag: 'autobuild-2026-08-31-13-27', year: 2026, month: 8, day: 31, hour: 13, minute: 27 });
    assert.equal(parseAutobuildTag('autobuild-2026-8-31-13-27'), null);
    assert.equal(parseAutobuildTag('latest'), null);
    assert.equal(parseAutobuildTag(''), null);
  });
});
