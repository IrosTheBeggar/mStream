/**
 * webapp/alpha/discover-jobs.js — the Discover job rows' pure half, on node:
 * the layout preview held to the server's engine (src/torrent/path-template.js
 * and src/discovery-plugins/destination.js render the real path; the picker
 * must show the same thing as the user types), a job as a row in every state,
 * the downloads strip, a download record as a row (the Downloads view), and
 * the queue after a download is removed.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as pathTemplate from '../../src/torrent/path-template.js';
import * as destination from '../../src/discovery-plugins/destination.js';

const require = createRequire(import.meta.url);
const J = require('../../webapp/alpha/discover-jobs.js');

const TAGS = [
  { artist: 'Marlowe Vale', album: 'Night Ferry', year: 2019, genre: 'Dream Pop', albumartist: null },
  { artist: 'AC/DC', album: 'Back in Black: Deluxe?', year: '1980', genre: null, albumartist: 'AC/DC' },
  { artist: '  ...Trail of Dead. ', album: 'Source Tags & Codes', year: null, genre: '', albumartist: '' },
  { artist: null, album: null, year: null, genre: null, albumartist: null },
  { artist: 'x'.repeat(260), album: 'tab\there', year: 0, genre: 'a\\b', albumartist: 'Various' },
  { artist: 'Björk', album: '音楽 / ロック', year: 1997, genre: 'Électro', albumartist: null },
];
const LAYOUTS = [
  '{{ARTIST}}/{{ALBUM}}', '{{ALBUMARTIST}}/{{ALBUM}} ({{YEAR}})', '{{PEER}}/{{ARTIST}}/{{ALBUM}}', '{{ artist }}\\{{Album}}',
  'From peers/{{GENRE}}/{{ARTIST}} - {{ALBUM}}', '{{YEAR}}', 'literal only', '{{ARTIST}}//{{ALBUM}}/', '{{GENRE}}/{{YEAR}}/{{PEER}}',
];
const BAD_LAYOUTS = [
  '', '/{{ARTIST}}', '\\{{ARTIST}}', '{{ARTIST}}/{{TRACK}}', '{{ARTIST}/{{ALBUM}}', '{ARTIST}', '{{ARTIST}}/../{{ALBUM}}', '~/{{ARTIST}}',
  '$HOME/{{ARTIST}}', 'C:/{{ARTIST}}', '{{ARTIST}}/D:stuff', 'a\u0001b/{{ARTIST}}', 'x'.repeat(501), '{{YEAR}}{{GENRE}}',
];
const BASES = ['', 'From peers', ' From peers / Sam ', 'a\\b\\c', '/lead/and/trail/', '..', 'ok/../up', '~home', 'C:/x', 'x'.repeat(600), 'tab\tin'];

describe('the layout preview agrees with the server engine', () => {
  test('sanitizeSegment and resolveLayout, value for value', () => {
    for (const raw of [null, undefined, '', 'AC/DC', ' . dots . ', 'a:b*c?d<e>f|g"h', 'multi   space', 'x'.repeat(300), 42, 'new\nline']) {
      assert.equal(J.sanitizeSegment(raw), pathTemplate.sanitizeSegment(raw), `sanitize ${JSON.stringify(raw)}`);
    }
    for (const layout of [...LAYOUTS, ...BAD_LAYOUTS]) {
      for (const tags of TAGS) {
        for (const peer of ["Sam's server", null, 'a/b']) {
          const mine = J.resolveLayout(layout, { ...tags, peer });
          const theirs = pathTemplate.resolveTemplate(layout, { ...tags, peer });
          assert.deepEqual(mine, theirs, `resolve ${JSON.stringify(layout)} with ${JSON.stringify(tags)} / ${peer}`);
        }
      }
    }
  });

  test('validateLayout accepts and refuses what the server does, with the same error code', () => {
    for (const layout of [...LAYOUTS, ...BAD_LAYOUTS]) {
      const mine = J.validateLayout(layout);
      const theirs = destination.validateLayout(layout);
      assert.equal(mine.valid, theirs.valid, `validity of ${JSON.stringify(layout.slice(0, 40))}`);
      if (!theirs.valid) { assert.equal(mine.error, theirs.error, `error code for ${JSON.stringify(layout.slice(0, 40))}`); }
    }
    assert.deepEqual(J.validateLayout('{{ARTIST}}/{{TRACK}}'), { valid: false, error: 'unknown_variable', variable: 'TRACK' });
    assert.equal(J.validateLayout(null).valid, false);
    assert.deepEqual([...J.LAYOUT_VARS].sort(), [...destination.LAYOUT_VARS].sort(), 'the same variables are offered');
    assert.equal(J.DEFAULT_LAYOUT, destination.DEFAULT_LAYOUT);
  });

  test('the base folder and the file name follow the same rules', () => {
    for (const base of BASES) {
      const mine = J.normalizeBase(base);
      const theirs = destination.normalizeBase(base);
      assert.equal(mine.valid, theirs.valid, `base ${JSON.stringify(base.slice(0, 30))}`);
      if (theirs.valid) { assert.equal(mine.base, theirs.base); } else { assert.equal(mine.error, theirs.error); }
    }
    for (const name of ['shared/03 Paper Lanterns.flac', 'a/b/..', '', 'dir/', 'bad:name?.mp3', '   .hidden. ', 'x/y\\z.mp3']) {
      assert.equal(J.safeFileName(name), destination.safeFileName(name), `file name ${JSON.stringify(name)}`);
    }
  });

  test('previewTarget is renderTarget for everything the server would accept', () => {
    for (const layout of LAYOUTS) {
      for (const tags of TAGS) {
        for (const base of ['', 'From peers', 'a\\b']) {
          const theirs = destination.renderTarget({
            destination: { vpath: 'music', base: destination.normalizeBase(base).base, layout },
            tags, peerName: "Sam's server", fileName: destination.safeFileName('shared/03 Paper Lanterns.flac'),
          });
          const mine = J.previewTarget({ vpath: 'music', base, layout, tags, peerName: "Sam's server", fileName: 'shared/03 Paper Lanterns.flac' });
          assert.equal(mine.valid, true);
          assert.equal(mine.relPath, theirs.relPath, `${layout} / ${base}`);
          assert.deepEqual(mine.missingVars, theirs.missingVars);
        }
      }
    }
  });

  test('previewTarget names the broken field, and splits the path for the preview line', () => {
    const ok = J.previewTarget({ vpath: 'music', base: 'From peers', layout: '{{ARTIST}}/{{ALBUM}} ({{YEAR}})', tags: { artist: 'Marlowe Vale', album: 'Night Ferry' }, peerName: 'Sam', fileName: 'x/03 Paper Lanterns.flac' });
    assert.deepEqual(
      { library: ok.library, base: ok.base, rendered: ok.rendered, file: ok.file, relPath: ok.relPath, missingVars: ok.missingVars },
      { library: 'music', base: 'From peers', rendered: 'Marlowe Vale/Night Ferry ()', file: '03 Paper Lanterns.flac', relPath: 'From peers/Marlowe Vale/Night Ferry ()/03 Paper Lanterns.flac', missingVars: ['YEAR'] });
    const badLayout = J.previewTarget({ vpath: 'music', base: '', layout: '{{ARTIST}}/{{TRACK}}', tags: {}, fileName: 'a.mp3' });
    assert.deepEqual([badLayout.valid, badLayout.field, badLayout.error, badLayout.variable], [false, 'layout', 'unknown_variable', 'TRACK']);
    const badBase = J.previewTarget({ vpath: 'music', base: '../up', layout: '{{ARTIST}}', tags: {}, fileName: 'a.mp3' });
    assert.deepEqual([badBase.valid, badBase.field, badBase.error], [false, 'base', 'traversal']);
    // Tags that render nothing: the file lands in the base folder itself.
    const bare = J.previewTarget({ vpath: 'music', base: 'Inbox', layout: '{{GENRE}}', tags: {}, fileName: 'a.mp3' });
    assert.equal(bare.relPath, 'Inbox/a.mp3');
    assert.deepEqual(J.pathCrumbs('music/A/B/c.mp3'), ['music', 'A', 'B', 'c.mp3']);
  });
});

const NOW = Date.UTC(2026, 8, 18, 12);
const DAY = 24 * 60 * 60 * 1000;
const job = (over) => ({ id: 1, plugin: 'youtube', state: 'queued', progress: null, statusText: null, result: null, error: null, cancelRequested: false, createdAt: NOW, recommendation: { artist: 'Neon Harbor', title: 'Salt & Static' }, ...over });

describe('a job as a row', () => {
  test('idle: a download offers Download, a copy offers Add', () => {
    const dl = J.jobRowState(null, { plugin: 'youtube' });
    assert.deepEqual([dl.state, dl.actions, dl.icon, dl.live], ['idle', ['start'], 'download', false]);
    assert.equal(J.jobRowState(null, { plugin: 'federation-copy' }).icon, 'folder');
  });

  test('queued and running: progress, the status line, Cancel; a requested cancel takes the button away', () => {
    const q = J.jobRowState(job({ state: 'queued' }));
    assert.deepEqual([q.state, q.tag, q.actions, q.live, q.icon], ['queued', 'discover.job.queued', ['cancel'], true, 'clock']);
    const r = J.jobRowState(job({ state: 'running', progress: 0.432, statusText: 'Neon Harbor – Salt & Static (Official Audio)' }));
    assert.deepEqual([r.state, r.tag, r.progress, r.actions], ['running', 'discover.job.downloading', 43, ['cancel']]);
    assert.deepEqual(r.sub, { text: 'Neon Harbor – Salt & Static (Official Audio) · 43%' });
    // A status line with its own percentage is not given a second one.
    assert.deepEqual(J.jobRowState(job({ state: 'running', progress: 0.45, statusText: '43% of “Salt & Static”' })).sub, { text: '43% of “Salt & Static”' });
    const searching = J.jobRowState(job({ state: 'running', progress: null, statusText: 'Searching YouTube' }));
    assert.deepEqual([searching.progress, searching.sub], ['indeterminate', { text: 'Searching YouTube' }]);
    assert.deepEqual(J.jobRowState(job({ state: 'running' })).sub, { key: 'discover.job.starting' });
    const copying = J.jobRowState(job({ plugin: 'federation-copy', state: 'running', progress: 0.5 }));
    assert.deepEqual([copying.tag, copying.sub], ['discover.job.copying', { text: '50%' }]);
    const stopping = J.jobRowState(job({ state: 'running', progress: 0.5, cancelRequested: true }));
    assert.deepEqual([stopping.tag, stopping.actions], ['discover.job.stopping', []]);
  });

  test('a finished download: done, saved to its place in the collection, playable', () => {
    const downloaded = { vpath: 'music', filepath: 'music/Neon Harbor/Low Tide/Salt_Static.mp3', trackId: 9, bytes: 10066329, format: 'mp3', downloadId: 4 };
    const done = J.jobRowState(job({ state: 'done', result: { downloaded, match: { url: 'https://youtu.be/x' }, missingVars: [] } }));
    assert.deepEqual([done.state, done.tag, done.tagCls, done.actions, done.filepath], ['downloaded', 'discover.job.done', 'ok', ['play', 'queue'], downloaded.filepath]);
    assert.deepEqual(done.sub, { key: 'discover.job.savedTo', params: { path: 'music / Neon Harbor / Low Tide / Salt_Static.mp3' } });
  });

  test('a finished copy: copied, already owned, or a file in the way', () => {
    const copied = J.jobRowState(job({ plugin: 'federation-copy', state: 'done', result: { copied: { vpath: 'music', filepath: 'music/Marlowe Vale/Night Ferry/03 Paper Lanterns.flac' } } }));
    assert.deepEqual([copied.state, copied.tag, copied.actions], ['copied', 'discover.job.inCollection', ['play', 'queue']]);
    assert.equal(copied.filepath, 'music/Marlowe Vale/Night Ferry/03 Paper Lanterns.flac');
    const owned = J.jobRowState(job({ plugin: 'federation-copy', state: 'done', result: { skipped: 'owned', existing: { filepath: 'music/x/y.flac', by: 'hash' } } }));
    assert.deepEqual([owned.state, owned.actions, owned.filepath], ['owned', ['play', 'queue'], 'music/x/y.flac']);
    const exists = J.jobRowState(job({ plugin: 'federation-copy', state: 'done', result: { skipped: 'exists', filepath: 'music/x/y.flac' } }));
    assert.deepEqual([exists.state, exists.actions, exists.sub], ['exists', ['retry'], { key: 'discover.job.existsSub', params: { path: 'music / x / y.flac' } }]);
  });

  test('failed carries the server\'s reason; cancelled offers the download again; an unknown result is just done', () => {
    const failed = J.jobRowState(job({ state: 'failed', error: 'Nothing matched closely enough (best score 0.41, needs 0.62)' }));
    assert.deepEqual([failed.state, failed.tagCls, failed.actions, failed.sub], ['failed', 'err', ['retry'], { text: 'Nothing matched closely enough (best score 0.41, needs 0.62)' }]);
    assert.deepEqual(J.jobRowState(job({ state: 'failed' })).sub, { key: 'discover.job.failedSub' });
    const cancelled = J.jobRowState(job({ state: 'cancelled' }));
    assert.deepEqual([cancelled.state, cancelled.muted, cancelled.actions, cancelled.sub.key], ['cancelled', true, ['start'], 'discover.job.cancelledSub']);
    assert.equal(J.jobRowState(job({ plugin: 'federation-copy', state: 'cancelled' })).sub.key, 'discover.job.cancelledCopySub');
    assert.deepEqual([J.jobRowState(job({ state: 'done', result: { echoed: 'x' } })).state, J.jobRowState(job({ state: 'done' })).actions], ['done', []]);
  });

  test('formatting helpers', () => {
    assert.deepEqual([0, 512, 2048, 5.5 * 1024 * 1024, 98 * 1024 * 1024, 3 * 1024 ** 3, NaN].map(J.fmtBytes), ['', '512 B', '2 KB', '5.5 MB', '98 MB', '3.0 GB', '']);
    assert.deepEqual(J.jobsByPlugin([job({ id: 5, plugin: 'youtube' }), job({ id: 4, plugin: 'youtube' }), job({ id: 3, plugin: 'federation-copy' })]), {
      youtube: job({ id: 5, plugin: 'youtube' }), 'federation-copy': job({ id: 3, plugin: 'federation-copy' }),
    });
    assert.deepEqual(J.jobsByPlugin(null), {});
  });
});

describe('the downloads strip', () => {
  const downloaded = { filepath: 'music/Neon Harbor/a.mp3' };
  const jobs = [
    job({ id: 1, state: 'done', createdAt: NOW - 50, result: { copied: { filepath: 'music/a.flac' } } }),
    job({ id: 2, state: 'failed', createdAt: NOW - 40, error: 'nope' }),
    job({ id: 3, state: 'done', createdAt: NOW - 30, result: { downloaded } }),
    job({ id: 4, state: 'queued', createdAt: NOW - 20 }),
    job({ id: 5, state: 'running', createdAt: NOW - 10 }),
    job({ id: 6, state: 'cancelled', createdAt: NOW - 5 }),
    job({ id: 7, state: 'done', createdAt: NOW - 4, result: { skipped: 'owned', existing: { filepath: 'music/a.mp3' } } }),
    job({ id: 8, state: 'failed', createdAt: NOW - 3, error: 'also nope' }),
    job({ id: 9, state: 'running', createdAt: NOW - 2 }),
  ];

  test('holds what still wants the user — live work first, then failures, newest first within a kind; a landed download is settled', () => {
    assert.deepEqual(J.trayRows(jobs).map((j) => j.id), [9, 5, 4, 8, 2]);
    assert.deepEqual(J.trayRows(null), []);
  });

  test('a failure that was retried leaves the strip: a newer job for the same plug-in and recommendation supersedes it', () => {
    const retried = [
      job({ id: 10, key: 'text:a', state: 'failed', createdAt: NOW - 30 }),
      job({ id: 11, key: 'text:a', state: 'running', createdAt: NOW - 20 }),
      job({ id: 12, key: 'text:b', state: 'failed', createdAt: NOW - 10 }),
      job({ id: 13, key: 'text:a', plugin: 'other', state: 'failed', createdAt: NOW - 5 }),
    ];
    assert.deepEqual(J.trayRows(retried).map((j) => j.id), [11, 13, 12]);
    // Even a cancelled retry closes the matter; the newest failure still shows.
    assert.deepEqual(J.trayRows([job({ id: 20, key: 'text:c', state: 'failed' }), job({ id: 21, key: 'text:c', state: 'cancelled' })]), []);
    assert.deepEqual(J.trayRows([job({ id: 30, key: 'text:d', state: 'failed' }), job({ id: 31, key: 'text:d', state: 'failed' })]).map((j) => j.id), [31]);
    assert.equal(J.traySummary(retried).failed, 2);
  });

  test('the summary counts running and failed, leaves zeroes out, and says whether to keep polling fast', () => {
    const s = J.traySummary(jobs);
    assert.deepEqual([s.total, s.running, s.failed, s.live, s.clearable], [5, 3, 2, true, true]);
    assert.deepEqual(s.parts, [{ key: 'discover.tray.running', count: 3 }, { key: 'discover.tray.failed', count: 2 }]);
    const quiet = J.traySummary([jobs[1]]);
    assert.deepEqual([quiet.total, quiet.live, quiet.clearable, quiet.parts], [1, false, true, [{ key: 'discover.tray.failed', count: 1 }]]);
    assert.deepEqual([J.traySummary([jobs[2]]).total, J.traySummary([]).total], [0, 0], 'a landed download is not in the strip');
  });

  test('titles, and what finished between two polls', () => {
    assert.equal(J.jobTitle(jobs[0]), 'Salt & Static — Neon Harbor');
    assert.equal(J.jobTitle({ recommendation: { title: 'Only a title' } }), 'Only a title');
    assert.equal(J.jobTitle(null), '');
    const before = [job({ id: 1, state: 'running' }), job({ id: 2, state: 'queued' }), job({ id: 3, state: 'failed' })];
    const after = [job({ id: 1, state: 'done', result: { downloaded } }), job({ id: 2, state: 'running' }), job({ id: 3, state: 'failed' }), job({ id: 4, state: 'done' })];
    assert.deepEqual(J.finishedSince(before, after).map((j) => j.id), [1], 'only a job seen live and now finished is news');
    assert.deepEqual(J.finishedSince(null, after), []);
  });
});

describe('a download record as a row', () => {
  const record = {
    id: 7, plugin: 'youtube', userId: 3, username: undefined, jobId: 12, vpath: 'music', filepath: 'music/Neon Harbor/Low Tide/Salt #1.mp3',
    relativePath: 'Neon Harbor/Low Tide/Salt #1.mp3', fileHash: 'abc', origin: 'https://youtu.be/x', title: 'Salt #1', artist: 'Neon Harbor', album: 'Low Tide',
    bytes: 10066329, downloadedAt: NOW - DAY, removedAt: null, removedBy: null, present: true, trackId: 9,
  };

  test('present: the song, its origin and its place, every action', () => {
    const r = J.downloadRow(record);
    assert.deepEqual([r.id, r.state, r.title, r.artist, r.album, r.plugin, r.filepath], [7, 'present', 'Salt #1', 'Neon Harbor', 'Low Tide', 'youtube', record.filepath]);
    assert.deepEqual(r.crumbs, ['music', 'Neon Harbor', 'Low Tide', 'Salt #1.mp3']);
    assert.deepEqual([r.present, r.removed, r.size, r.bytes, r.at, r.removedAt, r.username], [true, false, '9.6 MB', 10066329, NOW - DAY, null, null]);
    assert.deepEqual(r.actions, ['play', 'queue', 'show', 'remove']);
    assert.equal(J.downloadRow({ ...record, username: 'dana' }).username, 'dana', "the admin's list names the owner");
  });

  test('missing: the file is gone but the record stays, so Remove settles it; removed: history, nothing to do', () => {
    const missing = J.downloadRow({ ...record, present: false, trackId: null });
    assert.deepEqual([missing.state, missing.present, missing.actions], ['missing', false, ['remove']]);
    const removed = J.downloadRow({ ...record, present: false, trackId: null, removedAt: NOW, removedBy: 3 });
    assert.deepEqual([removed.state, removed.present, removed.removed, removed.removedAt, removed.actions], ['removed', false, true, NOW, []]);
    // A record with no tags falls back to the file name.
    assert.equal(J.downloadRow({ ...record, title: null, artist: null, album: null }).title, 'Salt #1.mp3');
    assert.deepEqual([J.downloadRow(null).state, J.downloadRow(null).crumbs, J.downloadRow(null).size], ['missing', [], '']);
  });

  test('the totals count what is still there', () => {
    const list = [record, { ...record, id: 8, bytes: 1024, removedAt: NOW }, { ...record, id: 9, bytes: 2048, present: false }];
    assert.deepEqual(J.downloadsTotals(list), { count: 2, bytes: 10066329 + 2048 });
    assert.deepEqual(J.downloadsTotals(null), { count: 0, bytes: 0 });
  });
});

describe('the queue after a download is removed', () => {
  test('the entries on that path, highest index first; peer tracks and other songs are left alone', () => {
    const gone = 'music/Neon Harbor/Low Tide/Salt #1.mp3';
    const playlist = [
      { rawFilePath: gone, filepath: 'music/Neon Harbor/Low Tide/Salt %231.mp3', url: 'a', metadata: { filepath: gone, title: 'Salt' } },
      { rawFilePath: 'music/other.mp3', filepath: 'music/other.mp3', url: 'keep', metadata: {} },
      { rawFilePath: gone, filepath: 'peer-side', url: 'peer', federation: { peerId: 'p1' }, metadata: {} },
      null,
      { rawFilePath: gone, filepath: 'x', url: 'b', metadata: null },
    ];
    assert.deepEqual(J.queueIndexesFor(playlist, gone), [4, 0]);
    assert.deepEqual(J.queueIndexesFor(playlist, 'music/none.mp3'), []);
    assert.deepEqual(J.queueIndexesFor(null, gone), []);
  });
});

describe('the lookup card', () => {
  test('fmtSeconds: m:ss, h:mm:ss, nothing for an unknown length', () => {
    assert.equal(J.fmtSeconds(253), '4:13');
    assert.equal(J.fmtSeconds(3725), '1:02:05');
    assert.equal(J.fmtSeconds(0), '0:00');
    assert.equal(J.fmtSeconds(null), '');
    assert.equal(J.fmtSeconds('x'), '');
  });

  test('hasLookup reads the capability', () => {
    assert.equal(J.hasLookup({ capabilities: ['acquire', 'lookup'] }), true);
    assert.equal(J.hasLookup({ capabilities: ['acquire'] }), false);
    assert.equal(J.hasLookup(null), false);
  });

  test('lookupCard: the chosen candidate (else the best) and the others, each scored against the bar', () => {
    const c = (id, score) => ({ id, url: 'https://youtu.be/' + id, title: 'T ' + id, channel: 'C', durationSec: 253, thumbnail: null, topic: id === 'a', score });
    const ready = { status: 'ready', query: 'q', minScore: 0.62, candidates: [c('a', 0.9), c('b', 0.7), c('c', 0.4)], chosen: null, owned: null, error: '' };
    let card = J.lookupCard(ready);
    assert.equal(card.state, 'ready');
    assert.equal(card.query, 'q');
    assert.deepEqual([card.card.url, card.card.scorePct, card.card.loose, card.card.length, card.card.topic], ['https://youtu.be/a', 90, false, '4:13', true]);
    assert.deepEqual(card.others.map((o) => [o.url, o.loose]), [['https://youtu.be/b', false], ['https://youtu.be/c', true]]);
    card = J.lookupCard({ ...ready, chosen: 'https://youtu.be/c' });
    assert.deepEqual([card.card.url, card.card.loose, card.card.scorePct], ['https://youtu.be/c', true, 40]);
    assert.deepEqual(card.others.map((o) => o.url), ['https://youtu.be/a', 'https://youtu.be/b']);
    assert.equal(J.lookupCard({ ...ready, candidates: [] }).state, 'none', 'ready with nothing to show reads as none');
    assert.equal(J.lookupCard({ status: 'owned', owned: { filepath: 'music/x.mp3', by: 'tags' } }).owned.filepath, 'music/x.mp3');
    assert.equal(J.lookupCard(null).state, 'idle');
    assert.equal(J.lookupCard({ status: 'loading' }).card, null);
    assert.equal(J.lookupCard({ status: 'error', error: 'boom' }).error, 'boom');
  });
});
