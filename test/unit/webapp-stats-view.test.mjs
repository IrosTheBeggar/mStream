/**
 * webapp/stats/stats-view.js — the /stats page's pure half, on node: the
 * formatters, the period options built from GET stats/periods, the column
 * chart's mark rules, the zero-filled series, the row markup and its
 * escaping, and the six tiles.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const V = require('../../webapp/stats/stats-view.js');

const NOW = '2026-09-30T20:30:00Z';

describe('formatters', () => {
  test('durations and clocks', () => {
    assert.equal(V.fmtDuration(9 * 3600000 + 24 * 60000), '9h 24m');
    assert.equal(V.fmtDuration(44 * 60000), '44 min');
    assert.equal(V.fmtDuration(2 * 3600000), '2h');
    assert.equal(V.fmtDuration(0), '0 min');
    assert.equal(V.fmtClock(247000), '4:07');
    assert.equal(V.fmtClock(8000), '0:08');
    assert.equal(V.fmtClock(3725000), '1:02:05');
    assert.equal(V.fmtInt(1234), '1,234');
    assert.equal(V.fmtPercent(0.113), '11%');
    assert.equal(V.fmtPercent(NaN), null);
  });

  test('deltas against the previous period, or nothing to compare with', () => {
    assert.equal(V.deltaText(142, 127, 'August'), '+12% vs August');
    assert.equal(V.deltaText(100, 120, 'last week'), '−17% vs last week');
    assert.equal(V.deltaText(50, 50, 'August'), 'same as August');
    assert.equal(V.deltaText(50, 0, 'August'), null);
    assert.equal(V.deltaText(50, undefined, 'August'), null);
    assert.equal(V.deltaDuration(9 * 3600000, 8 * 3600000 - 5 * 60000, 'August'), '+1h 05m vs August');
    assert.equal(V.deltaDuration(3600000, 3600000 + 30000, 'August'), 'same as August');
  });

  test('day and time labels follow the given zone', () => {
    assert.equal(V.dayLabel('2026-09-30T05:00:00Z', NOW, 'UTC'), 'Today');
    assert.equal(V.dayLabel('2026-09-29T23:30:00Z', NOW, 'UTC'), 'Yesterday');
    assert.equal(V.dayLabel('2026-09-29T23:30:00Z', NOW, 'Europe/Berlin'), 'Today', '01:30 Berlin is the same day');
    assert.equal(V.dayLabel('2026-09-28T09:12:00Z', NOW, 'UTC'), 'Sep 28');
    assert.equal(V.dayLabel('2025-12-31T09:12:00Z', NOW, 'UTC'), 'Dec 31, 2025');
    assert.equal(V.dayLabel('garbage', NOW, 'UTC'), '');
    assert.equal(V.timeLabel('2026-09-30T20:14:00Z', 'UTC'), '20:14');
    assert.equal(V.timeLabel('2026-09-30T20:14:00Z', 'Europe/Berlin'), '22:14');
    assert.equal(V.dayKeyLabel('2026-09-03'), 'Thu 3');
    assert.equal(V.hourLabel(20), '20:00');
  });

  test('the notes under the charts come from the summary', () => {
    assert.equal(V.hoursNote({ peakHour: 20, peakWeekday: 4 }), 'Most around 20:00, mostly Thursdays');
    assert.equal(V.hoursNote({ peakHour: null, peakWeekday: 0 }), 'Mostly Sundays');
    assert.equal(V.hoursNote({}), '');
    assert.equal(V.daysNote({ topDay: { date: '2026-09-03', plays: 19, listenedMs: 72 * 60000 } }), 'Most on Thu 3 · 19 plays, 1h 12m');
    assert.equal(V.daysNote({ topDay: null }), '');
  });
});

describe('periods', () => {
  const periods = {
    earliest: '2026-07-14T10:00:00.000Z', latest: NOW, tz: 'UTC',
    periods: [
      { period: 'week', offset: 0, label: 'Week 40' }, { period: 'week', offset: -1, label: 'Week 39' },
      { period: 'month', offset: 0, label: 'September 2026' }, { period: 'month', offset: -1, label: 'August 2026' }, { period: 'month', offset: -2, label: 'July 2026' },
      { period: 'quarter', offset: 0, label: 'Q3 2026' }, { period: 'year', offset: 0, label: '2026' },
    ],
  };
  test('the select offers this and last of each preset with data, older months by name, then All time', () => {
    const o = V.periodOptions(periods);
    assert.deepEqual(o.map((x) => x.value), ['week:0', 'week:-1', 'month:0', 'month:-1', 'month:-2', 'quarter:0', 'year:0', 'all:0']);
    assert.equal(o[2].label, 'This month · September 2026');
    assert.equal(o[3].label, 'Last month · August 2026');
    assert.equal(o[4].label, 'July 2026');
    assert.equal(o.at(-1).label, 'All time');
  });
  test('an empty log still gets This month and All time', () => {
    assert.deepEqual(V.periodOptions({ periods: [] }).map((x) => x.value), ['month:0', 'all:0']);
    assert.deepEqual(V.periodOptions(null).map((x) => x.value), ['month:0', 'all:0']);
  });
  test('versus wording', () => {
    assert.equal(V.versusLabel('month', 'August 2026'), 'August 2026');
    assert.equal(V.versusLabel('week', null), 'last week');
    assert.equal(V.versusLabel('all', null), null);
  });
});

describe('the column chart', () => {
  test('marks: at most 24px thick, a 4px rounded top and a square base, hairline grid, one peak label, muted axis ink', () => {
    const svg = V.columnChart([3, 19, 0, 7], { width: 400, height: 190, labels: [[0, '1'], [3, '4']], peakLabel: '19', titles: ['a', 'b', 'c', 'd'] });
    const paths = svg.match(/<path [^>]*>/g) || [];
    assert.equal(paths.length, 3, 'three bars with height; the zero day is a hairline');
    for (const p of paths) {
      const w = Number(/ h(\d+\.\d)/.exec(p)[1]) + 8;
      assert.ok(w <= 24 && w >= 3, 'bar width ' + w);
      assert.match(p, /a4 4 0 0 1 4 -4 h[\d.]+ a4 4 0 0 1 4 4/, 'rounded top, square base');
      assert.match(p, /fill="#657ee4"/);
    }
    assert.equal((svg.match(/<rect /g) || []).length, 1, 'the zero value draws a baseline hairline');
    assert.equal((svg.match(/stroke="#30353e" stroke-width="1"/g) || []).length, V.niceTicks(19).length, 'one solid hairline per tick');
    assert.equal((svg.match(/font-weight="600"/g) || []).length, 1, 'one label on the peak');
    assert.ok(svg.includes('>19</text>'));
    assert.ok(!svg.includes('font-family'), 'the svg inherits the page font');
    assert.equal((svg.match(/fill="#8c919a"/g) || []).length, V.niceTicks(19).length + 2, 'axis text in the muted ink');
    assert.ok(svg.includes('<title>b</title>'));
  });
  test('ticks are clean numbers reaching the maximum', () => {
    assert.deepEqual(V.niceTicks(19), [0, 5, 10, 15, 20]);
    assert.deepEqual(V.niceTicks(3), [0, 1, 2, 3]);
    assert.deepEqual(V.niceTicks(0), [0, 1]);
    assert.deepEqual(V.niceTicks(140), [0, 50, 100, 150]);
  });
  test('series are zero-filled across the range', () => {
    const d = V.dailySeries([{ bucket: '2026-09-03', plays: 19 }, { bucket: '2026-09-30', plays: 5 }], '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    assert.equal(d.keys.length, 30);
    assert.equal(d.values[2], 19);
    assert.equal(d.values[29], 5);
    assert.equal(d.values.reduce((a, b) => a + b, 0), 24);
    assert.deepEqual(V.dayAxisLabels(d.keys).map((x) => x[1]), ['1', '5', '10', '15', '20', '25', '30']);
    const m = V.monthSeries([{ bucket: '2026-03', plays: 4 }], '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z');
    assert.equal(m.keys.length, 12);
    assert.equal(m.values[2], 4);
    assert.deepEqual(V.monthAxisLabels(m.keys)[0], [0, 'Jan 2026']);
    const h = V.hourSeries([{ bucket: '20', plays: 18 }, { bucket: '25', plays: 1 }]);
    assert.equal(h.length, 24);
    assert.equal(h[20], 18);
    assert.equal(h.reduce((a, b) => a + b, 0), 18);
  });
});

describe('rows and tiles', () => {
  const peers = [{ id: 3, name: "Bob's records" }];
  test('the track object is the metadata shape, with a bare fallback and a filename when untitled', () => {
    assert.deepEqual(V.metaOf({ filepath: 'demo/a/b.mp3', metadata: { title: 'B', artist: 'A', album: 'L', 'album-art': 'x.jpeg' } }),
      { title: 'B', artist: 'A', album: 'L', art: 'x.jpeg', filepath: 'demo/a/b.mp3' });
    assert.equal(V.metaOf({ filepath: 'demo/a/Been a While.mp3', metadata: { title: null } }).title, 'Been a While.mp3');
    assert.equal(V.metaOf({ title: 'flat' }).title, 'flat');
    assert.equal(V.metaOf(null).title, '');
    const withArt = V.topRowHtml({ rank: 1, plays: 2, listenedMs: 0, track: { filepath: 'demo/x.mp3', metadata: { title: 'X', 'album-art': 'a b.jpeg' } } }, 'tracks', 2, { artUrl: (f) => '../album-art/' + encodeURIComponent(f) });
    assert.ok(withArt.includes('src="../album-art/a%20b.jpeg"'));
  });
  test('a top track row: rank, strings escaped, the peer named, share by plays', () => {
    const html = V.topRowHtml({ rank: 5, plays: 7, listenedMs: 26 * 60000, origin: 'peer', peerId: 3, lastPlayed: '2026-09-30T18:31:00Z', track: { filepath: 'x.mp3', metadata: { title: 'Gold <Coast>', artist: 'Color Out' } } }, 'tracks', 14, { peers, now: NOW, tz: 'UTC' });
    assert.ok(html.includes('Gold &lt;Coast&gt;'));
    assert.ok(html.includes('via Bob&#39;s records'));
    assert.ok(html.includes('width: 50%'));
    assert.ok(html.includes('7 plays') && html.includes('26 min') && html.includes('Today'));
    const artists = V.topRowHtml({ rank: 1, plays: 40, listenedMs: 0, name: 'Boukmanflow', tracks: 12 }, 'artists', 40, {});
    assert.ok(artists.includes('12 tracks') && artists.includes('width: 100%'));
  });
  test('history rows: outcomes, not counted, the legacy scrobble, the client label, escaping', () => {
    const base = { id: 'e1', startedAt: '2026-09-30T20:14:00Z', playedMs: 247000, durationMs: 247000, outcome: 'completed', counted: true, client: 'mstream-webapp', origin: 'local', track: { filepath: 'demo/Boukmanflow/Been a While.mp3', metadata: { title: 'Been a While', artist: 'Boukmanflow' } } };
    const done = V.historyRowHtml(base, { now: NOW, tz: 'UTC' });
    assert.ok(done.includes('stats-dot completed') && done.includes('>Completed<') && done.includes('>4:07<') && done.includes('web player'));
    assert.ok(done.includes('data-id="e1"') && done.includes('20:14') && done.includes('Today'));
    const skip = V.historyRowHtml({ ...base, id: 'e2', playedMs: 8000, durationMs: 123000, outcome: 'skipped', counted: false }, { now: NOW, tz: 'UTC' });
    assert.ok(skip.includes('Skipped at 0:08') && skip.includes('0:08 of 2:03') && skip.includes('not counted'));
    const legacy = V.historyRowHtml({ ...base, id: 'e3', playedMs: 30000, source: 'legacy', client: 'legacy', outcome: 'stopped' }, { now: NOW, tz: 'UTC' });
    assert.ok(legacy.includes('stats-dot legacy') && legacy.includes('Scrobbled at 0:30') && legacy.includes('older web player'));
    const peer = V.historyRowHtml({ ...base, id: 'e4', origin: 'peer', peerId: 3, client: 'mstream-music/0.36.0', track: { title: '<b>x</b>', artist: 'Color Out' } }, { now: NOW, tz: 'UTC', peers });
    assert.ok(peer.includes('&lt;b&gt;x&lt;/b&gt;') && peer.includes('via Bob&#39;s records') && peer.includes('mstream-music 0.36.0'));
    assert.equal(V.clientText({ client: '' , source: 'legacy' }), 'older client');
  });
  test('six tiles from a summary and its predecessor', () => {
    const t = V.tiles(
      { plays: 142, listenedMs: 9 * 3600000 + 24 * 60000, uniqueTracks: 61, libraryCoveragePct: 52.2, skips: 18, skipRate: 0.11, streakDays: { current: 8, longest: 12 }, sessions: { count: 23, avgMs: 25 * 60000 } },
      { plays: 127, listenedMs: 8 * 3600000 + 19 * 60000 }, { versus: 'August 2026', libraryTracks: 115 });
    assert.deepEqual(t.map((x) => x.label), ['Plays', 'Listening time', 'Tracks', 'Skips', 'Streak', 'Sessions']);
    assert.equal(t[0].value, '142'); assert.equal(t[0].sub, '+12% vs August 2026');
    assert.equal(t[1].value, '9h 24m'); assert.equal(t[1].sub, '+1h 05m vs August 2026');
    assert.equal(t[2].sub, 'of 115 in the library · 52%');
    assert.equal(t[3].sub, '11% of starts');
    assert.equal(t[4].value, '8 days'); assert.equal(t[4].sub, 'longest 12');
    assert.equal(t[5].sub, 'about 25 min each');
    const alone = V.tiles({ plays: 3, streakDays: {}, sessions: {} }, null, { versus: null });
    assert.equal(alone[0].sub, 'counted plays');
    assert.equal(alone[4].value, '0 days');
    assert.ok(V.tilesHtml(t).includes('stats-tile-value'));
  });
  test('the provenance line', () => {
    assert.equal(V.provenance({ period: { from: '2026-09-01T00:00:00.000Z' } }, { peersNamed: 1 }),
      'Every play this account reported through this server since 1 Sep, including peers’ tracks played here. Times in your zone.');
    assert.equal(V.provenance({ period: {} }, {}), 'Every play this account reported through this server. Times in your zone.');
  });
});
