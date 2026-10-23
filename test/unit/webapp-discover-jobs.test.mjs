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
import * as federationCopy from '../../src/discovery-plugins/plugins/federation-copy.js';

const require = createRequire(import.meta.url);
const J = require('../../webapp/alpha/discover-jobs.js');

// `serverfolder` is {{SERVERFOLDER}} (the server's renderTarget takes it as
// its own `serverFolder`): folders, as federation-copy serverFolderOf
// writes them, and raw values the engine must make safe itself
const TAGS = [
  { artist: 'Marlowe Vale', album: 'Night Ferry', year: 2019, genre: 'Dream Pop', albumartist: null, serverfolder: 'Marlowe Vale/Night Ferry' },
  { artist: 'AC/DC', album: 'Back in Black: Deluxe?', year: '1980', genre: null, albumartist: 'AC/DC', serverfolder: 'AC-DC' },
  { artist: '  ...Trail of Dead. ', album: 'Source Tags & Codes', year: null, genre: '', albumartist: '', serverfolder: '' },
  { artist: null, album: null, year: null, genre: null, albumartist: null, serverfolder: null },
  { artist: 'x'.repeat(260), album: 'tab\there', year: 0, genre: 'a\\b', albumartist: 'Various', serverfolder: `${'y'.repeat(260)}/z` },
  { artist: 'Björk', album: '音楽 / ロック', year: 1997, genre: 'Électro', albumartist: null, serverfolder: '音楽\\ロック' },
  // a "~" or a "$HOME" in a tag is a name: folded, never a refused path
  { artist: '~Ana', album: '$HOME Sessions', year: null, genre: '${HOME}', albumartist: 'Tilde~Town', serverfolder: '~Ana/$HOME Sessions' },
  // a peer's folder that tries to climb, or doubles its separators: the empty ones drop
  { artist: 'Ana', album: 'Up', year: null, genre: null, albumartist: null, serverfolder: '../../etc//./ Ana : B /..' },
];
const LAYOUTS = [
  '{{ARTIST}}/{{ALBUM}}', '{{ALBUMARTIST}}/{{ALBUM}} ({{YEAR}})', '{{PEER}}/{{ARTIST}}/{{ALBUM}}', '{{ artist }}\\{{Album}}',
  'From peers/{{GENRE}}/{{ARTIST}} - {{ALBUM}}', '{{YEAR}}', 'literal only', '{{ARTIST}}//{{ALBUM}}/', '{{GENRE}}/{{YEAR}}/{{PEER}}',
  '{{SERVERFOLDER}}', 'From friends/{{SERVERFOLDER}}', 'Copy of {{SERVERFOLDER}} ({{YEAR}})', '{{PEER}}/{{serverfolder}}/{{ALBUM}}',
];
const BAD_LAYOUTS = [
  '', '/{{ARTIST}}', '\\{{ARTIST}}', '{{ARTIST}}/{{TRACK}}', '{{ARTIST}/{{ALBUM}}', '{ARTIST}', '{{ARTIST}}/../{{ALBUM}}', '~/{{ARTIST}}',
  '$HOME/{{ARTIST}}', 'C:/{{ARTIST}}', '{{ARTIST}}/D:stuff', 'a\u0001b/{{ARTIST}}', 'x'.repeat(501), '{{YEAR}}{{GENRE}}',
  '{{SERVERFOLDER}}/../x', '/{{SERVERFOLDER}}', '{{SERVER_FOLDER}}',
];
const BASES = ['', 'From peers', ' From peers / Sam ', 'a\\b\\c', '/lead/and/trail/', '..', 'ok/../up', '~home', 'C:/x', 'x'.repeat(600), 'tab\tin'];

describe('the layout preview agrees with the server engine', () => {
  test('sanitizeSegment and resolveLayout, value for value', () => {
    for (const raw of [null, undefined, '', 'AC/DC', ' . dots . ', 'a:b*c?d<e>f|g"h', 'multi   space', 'x'.repeat(300), 42, 'new\nline',
      '~', '~/music', '~Ana~', '$HOME', '${HOME}', '$HOME/x', 'a $HOME b', '$HOMEx', '$ {HOME}']) {
      assert.equal(J.sanitizeSegment(raw), pathTemplate.sanitizeSegment(raw), `sanitize ${JSON.stringify(raw)}`);
    }
    assert.deepEqual(['~Ana', '$HOME Sessions', '${HOME}'].map(J.sanitizeSegment), ['-Ana', '- Sessions', '-'], 'folded as the server folds them');
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
            tags, peerName: "Sam's server", serverFolder: tags.serverfolder, fileName: destination.safeFileName('shared/03 Paper Lanterns.flac'),
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

  test('a song the peer refused (its key may not copy): stopped and said so, like an album\'s — no Retry, it would refuse again', () => {
    const refused = J.jobRowState(job({ plugin: 'federation-copy', state: 'done', result: { stopped: 'refused', peer: { id: 1, name: 'Stage Peer B' }, destination: null } }));
    assert.deepEqual([refused.state, refused.tag, refused.tagCls, refused.icon, refused.iconCls, refused.actions, refused.filepath],
      ['stopped', 'discover.job.stopped', 'err', 'warn', 'err', [], null]);
    assert.deepEqual(refused.sub, { key: 'discover.job.stoppedRefused', params: { peer: 'Stage Peer B' } });
    assert.equal(J.trayRows([job({ plugin: 'federation-copy', state: 'done', result: { stopped: 'refused', peer: { name: 'P' } } })]).length, 0, 'over: not the strip\'s, as an album\'s refusal is not');
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

describe('a lookup answer indexed by plug-in, per scope', () => {
  test('jobsByPlugin: the song rows see song jobs, the album rows album jobs', () => {
    const jobs = [
      { id: 1, plugin: 'federation-copy', params: { scope: 'album' } },
      { id: 2, plugin: 'federation-copy', params: null },
      { id: 3, plugin: 'youtube', params: { choice: { url: 'x' } } },
    ];
    const ids = (index) => Object.fromEntries(Object.entries(index).map(([k, v]) => [k, v.id]));
    assert.deepEqual(ids(J.jobsByPlugin(jobs)), { 'federation-copy': 2, youtube: 3 });
    assert.deepEqual(ids(J.jobsByPlugin(jobs, 'album')), { 'federation-copy': 1 });
    assert.deepEqual(J.jobsByPlugin(jobs, 'artist'), {});
    assert.deepEqual(J.jobsByPlugin(null), {});
  });
});

describe('album and artist jobs as rows', () => {
  const many = (over) => ({ scope: 'album', album: { name: 'Night Ferry', artist: 'Nova' }, songs: { total: 4, copied: [{ from: 'a' }, { from: 'b' }], skipped: [{ from: 'c', why: 'owned' }], failed: [] }, bytes: 10, stopped: null, peer: { id: 1, name: "Sam's server" }, ...over });
  const copyJob = (over) => job({ plugin: 'federation-copy', ...over });

  test('scope, slot and the index by slot', () => {
    assert.deepEqual(J.JOB_SCOPES, ['song', 'album', 'artist', 'artist-missing']);
    assert.equal(J.jobScope(job({})), 'song');
    assert.equal(J.jobScope(job({ params: { scope: 'album' } })), 'album');
    assert.equal(J.jobSlot('federation-copy', 'song'), 'federation-copy');
    assert.equal(J.jobSlot('federation-copy'), 'federation-copy');
    assert.equal(J.jobSlot('federation-copy', 'album'), 'federation-copy@album');
    const jobs = [copyJob({ id: 1, params: { scope: 'album' } }), copyJob({ id: 2 }), copyJob({ id: 3, params: { scope: 'artist-missing' } }), copyJob({ id: 4 })];
    assert.deepEqual(Object.fromEntries(Object.entries(J.jobsBySlot(jobs)).map(([k, v]) => [k, v.id])), { 'federation-copy@album': 1, 'federation-copy': 2, 'federation-copy@artist-missing': 3 }, 'the first seen per slot');
    assert.deepEqual(J.jobsBySlot(null), {});
  });

  test('done: in your collection with the counts; nothing copied reads as already yours; an artist job counts its albums', () => {
    const done = J.jobRowState(copyJob({ state: 'done', params: { scope: 'album' }, result: many() }));
    assert.deepEqual([done.state, done.tag, done.tagCls, done.icon, done.actions], ['copiedMany', 'discover.job.inCollection', 'ok', 'check', ['start']], 'done, and startable again for the gaps');
    assert.deepEqual(done.sub, { parts: [{ key: 'discover.job.copiedCount', params: { count: 2 } }, { key: 'discover.job.ownedCount', params: { count: 1 } }] });
    const owned = J.jobRowState(copyJob({ state: 'done', params: { scope: 'album' }, result: many({ songs: { total: 2, copied: [], skipped: [{}, {}], failed: [] } }) }));
    assert.deepEqual([owned.state, owned.tag, owned.tagCls, owned.sub], ['owned', 'discover.job.owned', 'ok', { parts: [{ key: 'discover.job.ownedCount', params: { count: 2 } }] }]);
    const artist = J.jobRowState(copyJob({ state: 'done', params: { scope: 'artist' }, result: many({ scope: 'artist', albums: [{ name: 'A' }, { name: 'B' }], skippedAlbums: [{ name: 'C', why: 'appearance' }], songs: { total: 3, copied: [{}, {}, {}], skipped: [], failed: [{ from: 'x', error: 'gone' }] } }) }));
    assert.deepEqual(artist.sub.parts.map((p) => [p.key, p.params.count]), [['discover.job.albumsCount', 2], ['discover.job.copiedCount', 3], ['discover.job.failedCount', 1], ['discover.job.albumsLeftOut', 1]]);
    const single = J.jobRowState(copyJob({ state: 'done', result: { copied: { vpath: 'music', filepath: 'music/x/y.flac' } } }));
    assert.equal(single.state, 'copied', 'a single copy reads as before');
  });

  // "done" is not "kept": a many-song job ends done however it went.
  test('done with nothing copied and a song failed is a failure (Retry), never "already yours"', () => {
    const failed = J.jobRowState(copyJob({ state: 'done', params: { scope: 'album' }, result: many({ songs: { total: 1, copied: [], skipped: [], failed: [{ from: 'a', error: 'gone' }] }, counts: { total: 1, copied: 0, skipped: 0, failed: 1 }, stopped: null }) }));
    assert.deepEqual([failed.state, failed.tag, failed.tagCls, failed.icon, failed.iconCls, failed.actions], ['failed', 'discover.job.failed', 'err', 'warn', 'err', ['retry']]);
    assert.deepEqual(failed.sub, { parts: [{ key: 'discover.job.failedCount', params: { count: 1 } }] });
    // one song already here, one failed: still a failure — nothing landed
    const mixed = J.jobRowState(copyJob({ state: 'done', params: { scope: 'album' }, result: many({ songs: { total: 2, copied: [], skipped: [{}], failed: [{}] } }) }));
    assert.equal(mixed.state, 'failed');
    // an artist job whose album listings failed copied nothing either
    const listings = J.jobRowState(copyJob({ state: 'done', params: { scope: 'artist' }, result: many({ scope: 'artist', albums: [{ name: 'A', error: 'peer said 500' }], skippedAlbums: [], songs: { total: 0, copied: [], skipped: [], failed: [] } }) }));
    assert.deepEqual([listings.state, listings.sub.parts.map((p) => p.key)], ['failed', ['discover.job.albumsFailed']]);
    // a failure is a failure toast and counts in the strip's line, as a failed job does
    assert.equal(J.jobRowState(copyJob({ state: 'done', params: { scope: 'album' }, result: many({ songs: { total: 1, copied: [], skipped: [], failed: [{}] } }) })).live, false);
  });

  test('the counts come from result.counts — the lists stop at 500 entries', () => {
    const capped = Array.from({ length: 500 }, () => ({}));
    const big = J.jobRowState(copyJob({ state: 'done', params: { scope: 'artist' }, result: many({ scope: 'artist', songs: { total: 1200, copied: capped, skipped: [], failed: capped }, counts: { total: 1200, copied: 700, skipped: 0, failed: 500 }, truncated: true }) }));
    assert.deepEqual(big.sub.parts.map((p) => [p.key, p.params.count]), [['discover.job.copiedCount', 700], ['discover.job.failedCount', 500]]);
    // counts says nothing was copied though a list (an old shape) is not empty: counts wins
    const zero = J.jobRowState(copyJob({ state: 'done', params: { scope: 'album' }, result: many({ counts: { total: 3, copied: 0, skipped: 3, failed: 0 } }) }));
    assert.equal(zero.state, 'owned');
    // a result with counts alone (no lists) is still a many-song result
    const bare = J.jobRowState(copyJob({ state: 'done', params: { scope: 'album' }, result: { scope: 'album', counts: { total: 2, copied: 2, skipped: 0, failed: 0 }, stopped: null, peer: { id: 1, name: 'S' } } }));
    assert.deepEqual([bare.state, bare.sub.parts], ['copiedMany', [{ key: 'discover.job.copiedCount', params: { count: 2 } }]]);
  });

  test('nothing at all: "nothing to copy" — an artist who only appears on the peer\'s albums says so; all their albums already here is "already yours"', () => {
    const guest = J.jobRowState(copyJob({ state: 'done', params: { scope: 'artist' }, result: many({ scope: 'artist', albums: [], skippedAlbums: [{ name: 'Comp', why: 'appearance' }, { name: 'Feat', why: 'appearance' }], songs: { total: 0, copied: [], skipped: [], failed: [] }, counts: { total: 0, copied: 0, skipped: 0, failed: 0 } }) }));
    assert.deepEqual([guest.state, guest.tag, guest.tagCls, guest.muted, guest.actions], ['nothing', 'discover.job.nothing', '', true, ['start']]);
    assert.deepEqual(guest.sub, { parts: [{ key: 'discover.job.onlyAppearances', params: { count: 2 } }] });
    const none = J.jobRowState(copyJob({ state: 'done', params: { scope: 'artist-missing' }, result: many({ scope: 'artist-missing', albums: [], skippedAlbums: [], songs: { total: 0, copied: [], skipped: [], failed: [] } }) }));
    assert.deepEqual([none.state, none.tag, none.sub], ['nothing', 'discover.job.nothing', { parts: [{ key: 'discover.job.nothingToCopy' }] }]);
    const have = J.jobRowState(copyJob({ state: 'done', params: { scope: 'artist-missing' }, result: many({ scope: 'artist-missing', albums: [], skippedAlbums: [{ name: 'A', why: 'owned' }, { name: 'B', why: 'owned' }], songs: { total: 0, copied: [], skipped: [], failed: [] } }) }));
    assert.deepEqual([have.state, have.tag, have.sub.parts.map((p) => p.key)], ['owned', 'discover.job.owned', ['discover.job.albumsLeftOut']]);
  });

  test('stopped by the peer\'s limit or the peer going away: a warning with the counts and Retry; refused has no Retry; a cancel keeps its counts', () => {
    const quota = J.jobRowState(copyJob({ state: 'done', params: { scope: 'album' }, result: many({ stopped: 'quota', songs: { total: 4, copied: [{}], skipped: [], failed: [{ from: 'b', error: 'limit' }] } }) }));
    assert.deepEqual([quota.state, quota.tag, quota.tagCls, quota.icon, quota.iconCls, quota.actions], ['stopped', 'discover.job.stopped', 'err', 'warn', 'err', ['retry']]);
    assert.deepEqual(quota.sub.parts[0], { key: 'discover.job.stoppedQuota', params: { peer: "Sam's server" } });
    assert.deepEqual(quota.sub.parts.slice(1).map((p) => p.key), ['discover.job.copiedCount', 'discover.job.failedCount']);
    const peer = J.jobRowState(copyJob({ state: 'done', params: { scope: 'album' }, result: many({ stopped: 'peer' }) }));
    assert.deepEqual([peer.sub.parts[0].key, peer.actions], ['discover.job.stoppedPeer', ['retry']]);
    const busy = J.jobRowState(copyJob({ state: 'done', params: { scope: 'album' }, result: many({ stopped: 'busy', songs: { total: 3, copied: [{}, {}, {}], skipped: [], failed: [] } }) }));
    assert.equal(busy.state, 'stopped', 'stopped early wins over what landed: never "in your collection"');
    // A peer with copies off refuses again: Retry would meet the same refusal.
    const refused = J.jobRowState(copyJob({ state: 'done', params: { scope: 'album' }, result: many({ stopped: 'refused', songs: { total: 1, copied: [], skipped: [], failed: [{}] }, counts: { total: 1, copied: 0, skipped: 0, failed: 1 } }) }));
    assert.deepEqual([refused.state, refused.tag, refused.sub.parts[0], refused.actions], ['stopped', 'discover.job.stopped', { key: 'discover.job.stoppedRefused', params: { peer: "Sam's server" } }, []]);
    const cancelled = J.jobRowState(copyJob({ state: 'cancelled', params: { scope: 'album' }, result: many({ stopped: 'cancelled', songs: { total: 4, copied: [{}], skipped: [], failed: [] } }) }));
    assert.deepEqual([cancelled.state, cancelled.muted, cancelled.actions], ['cancelled', true, ['start']]);
    assert.deepEqual(cancelled.sub.parts.map((p) => p.key), ['discover.job.cancelledMany', 'discover.job.copiedCount']);
    const early = J.jobRowState(copyJob({ state: 'cancelled', params: { scope: 'album' }, result: many({ stopped: 'cancelled', songs: { total: 4, copied: [], skipped: [], failed: [] } }) }));
    assert.deepEqual(early.sub, { parts: [{ key: 'discover.job.cancelledMany' }] }, 'cancelled before anything landed: just "Stopped"');
    const plain = J.jobRowState(copyJob({ state: 'cancelled' }));
    assert.equal(plain.sub.key, 'discover.job.cancelledCopySub', 'a single copy reads as before');
  });

  test('every key a many-song row emits has an English value, plural where counted', () => {
    const EN = require('../../webapp/locales/en.json');
    const results = [
      many(), many({ stopped: 'refused' }), many({ songs: { total: 1, copied: [], skipped: [], failed: [{}] } }),
      many({ albums: [{ name: 'A', error: 'x' }, { name: 'B' }], skippedAlbums: [{ why: 'owned' }], songs: { total: 0, copied: [], skipped: [], failed: [] } }),
      many({ albums: [], skippedAlbums: [{ why: 'appearance' }], songs: { total: 0, copied: [], skipped: [], failed: [] } }),
      many({ albums: [], skippedAlbums: [], songs: { total: 0, copied: [], skipped: [], failed: [] } }),
    ];
    for (const result of results) {
      const row = J.jobRowState(copyJob({ state: 'done', params: { scope: 'artist' }, result }));
      for (const p of [{ key: row.tag }, ...row.sub.parts]) {
        const val = EN[p.key];
        assert.ok(val !== undefined, `${p.key} missing from en.json`);
        if (typeof val === 'object') { assert.equal(typeof (p.params && p.params.count), 'number', `${p.key} is plural`); }
      }
    }
    assert.ok(!/you have it all/i.test(EN['discover.job.nothingToCopy']), 'nothing came back is not "you have it all"');
  });

  test('the strip names an album job by its album and an artist job by its artist, with the kind beside it', () => {
    const rec = { title: 'Departure', artist: 'Marlowe Vale', album: 'Night Ferry' };
    assert.equal(J.jobTitle(job({ recommendation: rec })), 'Departure — Marlowe Vale');
    assert.equal(J.jobTitle(job({ recommendation: rec, params: { scope: 'album' } })), 'Night Ferry — Marlowe Vale');
    assert.equal(J.jobTitle(job({ recommendation: rec, params: { scope: 'artist' } })), 'Marlowe Vale');
    assert.equal(J.jobTitle(job({ recommendation: rec, params: { scope: 'artist-missing' } })), 'Marlowe Vale');
    assert.deepEqual([J.jobKind(job({})), J.jobKind(job({ params: { scope: 'album' } })), J.jobKind(job({ params: { scope: 'artist' } })), J.jobKind(job({ params: { scope: 'artist-missing' } }))],
      [null, 'discover.tray.kindAlbum', 'discover.tray.kindArtist', 'discover.tray.kindMissing']);
  });

  test('an album job names the album\'s own credit when its recommendation carries one: a compilation copied whole is "Various Artists"', () => {
    const rec = { title: 'Wind One', artist: 'Ana', album: 'Mixtape Vol 1', albumArtist: 'Various Artists' };
    assert.equal(J.jobTitle(job({ recommendation: rec, params: { scope: 'album' } })), 'Mixtape Vol 1 — Various Artists');
    assert.equal(J.jobTitle(job({ recommendation: rec })), 'Wind One — Ana', 'a song job keeps its artist');
    assert.equal(J.jobTitle(job({ recommendation: rec, params: { scope: 'artist' } })), 'Ana', 'an artist job keeps its artist');
    assert.equal(J.jobTitle(job({ recommendation: { ...rec, albumArtist: '  ' }, params: { scope: 'album' } })), 'Mixtape Vol 1 — Ana', 'a blank credit is none');
    assert.equal(J.jobTitle(job({ recommendation: { album: 'Mixtape Vol 1', albumArtist: 'Various Artists' }, params: { scope: 'album' } })), 'Mixtape Vol 1 — Various Artists', 'a card\'s album job (no track artist)');
  });
});

// ── where a copy of one scope lands (the path bar, the editor's preview,
// a running copy's "Into") and where a finished one's files are ("In") ──
describe('scopeTarget: the destination drawn for what the scope copies', () => {
  const DEST = { vpath: 'copies', base: '', layout: '{{ALBUMARTIST}}/{{ALBUM}}' };
  const SONG = { artist: 'Boukmanflow', album: 'Borrowed Tapes', year: 2019, genre: 'Hip-Hop', albumartist: null };
  const ARTIST = { artist: 'Boukmanflow', albumartist: 'Boukmanflow', album: null, year: null, genre: 'Hip-Hop' };
  const FILE = 'peerlib/Boukmanflow/Borrowed Tapes/02 - Late Train Verse.mp3';
  const at = (over) => J.scopeTarget({ ...DEST, tags: SONG, peerName: 'Stage Peer B', fileName: FILE, ...over });
  const crumbs = (p) => p.crumbs.map((c) => c.text || c.key);
  const kinds = (p) => p.crumbs.map((c) => c.kind);

  test('the song: its own folder and its file on a line of its own; the album: the same folder, no file', () => {
    const song = at({ scope: 'song' });
    assert.deepEqual([song.valid, song.library, crumbs(song), kinds(song), song.file, song.title],
      [true, 'copies', ['Boukmanflow', 'Borrowed Tapes'], ['rendered', 'rendered'], '02 - Late Train Verse.mp3', 'copies/Boukmanflow/Borrowed Tapes']);
    const album = at({ scope: 'album' });
    assert.deepEqual([crumbs(album), album.file], [['Boukmanflow', 'Borrowed Tapes'], null]);
    assert.equal(at({ scope: undefined }).file, '02 - Late Train Verse.mp3', 'no scope is the song');
    // the album's credit is the caller's ALBUMARTIST: a compilation stays together
    const comp = at({ scope: 'album', tags: { ...SONG, artist: 'Ana', album: 'Night Market Sampler', albumartist: 'Various Artists' } });
    assert.deepEqual(crumbs(comp), ['Various Artists', 'Night Market Sampler']);
  });

  test('the artist: the folder that names an album, and every one after it, is "one folder per album"; a layout without one adds nothing', () => {
    const artist = at({ scope: 'artist', tags: ARTIST });
    assert.deepEqual([crumbs(artist), kinds(artist), artist.perAlbum, artist.file, artist.title],
      [['Boukmanflow', 'discover.modal.dest.perAlbum'], ['rendered', 'note'], true, null, 'copies/Boukmanflow']);
    assert.equal(artist.relDir, 'Boukmanflow');
    const shared = at({ scope: 'artist', tags: ARTIST, layout: '{{ALBUMARTIST}}' });
    assert.deepEqual([crumbs(shared), shared.perAlbum], [['Boukmanflow'], false], 'every album shares the artist\'s folder');
    // {{YEAR}} is each album's own too; what follows it is cut with it
    const byYear = at({ scope: 'artist', tags: ARTIST, layout: '{{ARTIST}}/Year {{YEAR}}/{{ALBUM}}' });
    assert.deepEqual(crumbs(byYear), ['Boukmanflow', 'discover.modal.dest.perAlbum']);
    assert.deepEqual(byYear.missingVars, [], 'what each album fills in is not "missing"');
    const onlyAlbum = at({ scope: 'artist', tags: ARTIST, layout: '{{ALBUM}}' });
    assert.deepEqual([onlyAlbum.valid, crumbs(onlyAlbum)], [true, ['discover.modal.dest.perAlbum']]);
    const genre = at({ scope: 'artist', tags: { ...ARTIST, genre: null }, layout: '{{GENRE}}/{{ARTIST}}/{{ALBUM}}' });
    assert.deepEqual([crumbs(genre), genre.missingVars], [['Boukmanflow', 'discover.modal.dest.perAlbum'], ['GENRE']]);
  });

  test('only the missing: the one album named when it is the one, else one folder per album', () => {
    const one = at({ scope: 'artist-missing', tags: ARTIST, oneAlbum: { name: 'Second Shift', year: 2021 } });
    assert.deepEqual([crumbs(one), one.perAlbum], [['Boukmanflow', 'Second Shift'], false]);
    const dated = at({ scope: 'artist-missing', tags: ARTIST, oneAlbum: { name: 'Second Shift', year: 2021 }, layout: '{{ARTIST}}/{{ALBUM}} ({{YEAR}})' });
    assert.deepEqual(crumbs(dated), ['Boukmanflow', 'Second Shift (2021)']);
    const several = at({ scope: 'artist-missing', tags: ARTIST, oneAlbum: null });
    assert.deepEqual(crumbs(several), ['Boukmanflow', 'discover.modal.dest.perAlbum']);
  });

  test('a base folder follows the library, {{PEER}} renders the server\'s name; the engine\'s refusals come through', () => {
    const peer = at({ scope: 'song', base: ' from-peers/ ', layout: '{{PEER}}/{{ALBUMARTIST}}/{{ALBUM}}' });
    assert.deepEqual([crumbs(peer), kinds(peer), peer.title],
      [['from-peers', 'Stage Peer B', 'Boukmanflow', 'Borrowed Tapes'], ['base', 'rendered', 'rendered', 'rendered'], 'copies/from-peers/Stage Peer B/Boukmanflow/Borrowed Tapes']);
    const artist = at({ scope: 'artist', tags: ARTIST, base: 'from-peers', layout: '{{PEER}}/{{ALBUMARTIST}}/{{ALBUM}}' });
    assert.deepEqual(crumbs(artist), ['from-peers', 'Stage Peer B', 'Boukmanflow', 'discover.modal.dest.perAlbum']);
    const badLayout = at({ scope: 'artist', tags: ARTIST, layout: '{{ARTST}}/{{ALBUM}}' });
    assert.deepEqual([badLayout.valid, badLayout.field, badLayout.error, badLayout.variable, badLayout.crumbs], [false, 'layout', 'unknown_variable', 'ARTST', []]);
    const badBase = at({ scope: 'album', base: '~/x' });
    assert.deepEqual([badBase.valid, badBase.field, badBase.error], [false, 'base', 'home_string']);
    // the long names wrap whole: one crumb per folder, never cut
    const long = at({ scope: 'song', base: 'from-peers', tags: { artist: 'The Boukmanflow Collective & Friends', album: 'Free Instrumentals Vol. 9 (Deluxe Remastered Edition)' },
      fileName: 'x/07 - A Very Long Track Title That Keeps Going (Live at the Harbour).flac' });
    assert.deepEqual([crumbs(long), long.file], [['from-peers', 'The Boukmanflow Collective & Friends', 'Free Instrumentals Vol. 9 (Deluxe Remastered Edition)'],
      '07 - A Very Long Track Title That Keeps Going (Live at the Harbour).flac']);
  });

  test('the song\'s and the album\'s folder is the server\'s renderTarget folder', () => {
    for (const layout of LAYOUTS) {
      for (const tags of TAGS) {
        const theirs = destination.renderTarget({ destination: { vpath: 'music', base: 'From peers', layout }, tags, peerName: "Sam's server", serverFolder: tags.serverfolder, fileName: 'a.mp3' });
        for (const scope of ['song', 'album']) {
          const mine = J.scopeTarget({ vpath: 'music', base: 'From peers', layout, scope, tags, peerName: "Sam's server", fileName: 'x/a.mp3' });
          assert.equal(mine.relDir, theirs.relDir, `${scope}: ${layout}`);
          assert.equal(mine.title, ['music', theirs.relDir].filter(Boolean).join('/'));
        }
      }
    }
  });
});

// ── what varies per song: the server files each song of a copy by ITS OWN
// tags (destination.js tagsForLayout + renderTarget, per song) — {{ARTIST}},
// {{YEAR}}, {{GENRE}} are each song's; where the client cannot promise the
// one value, a slot (found live 2026-10-22: "From friends/{{ARTIST}}" on a
// compilation promised one folder, and the songs landed in three) ──────
describe('slots: a variable each song files by its own tag is never one folder the client cannot promise', () => {
  const ROW = { artist: 'Boukmanflow', album: 'Night Market Sampler', year: 2020, genre: null, albumartist: 'Various Artists' };
  const listed = (artists, over) => artists.map((artist) => ({ artist, year: 2020, genre: null, ...over }));
  const SAMPLER = listed(['Color Out', 'Boukmanflow', 'ALM']);
  const at = (scope, rule, layout, over) => {
    const st = J.scopeTags({ scope, ...rule });
    return J.scopeTarget({ vpath: 'copies', base: '', layout, scope, tags: st.tags, slots: st.slots, peerName: 'Stage Peer B', fileName: 'x/02 - a.mp3', ...over });
  };
  // a folder as drawn: a slot as ‹NAME›, the note by its key
  const drawn = (p) => p.crumbs.map((c) => (c.parts ? c.parts.map((x) => (x.slot ? `‹${x.slot}›` : x.text)).join('') : c.text || c.key));

  test('the bug: an album copy of a compilation under "From friends/{{ARTIST}}" draws ‹artist›, never the row\'s artist', () => {
    const p = at('album', { tags: ROW, songs: SAMPLER, compilation: true }, 'From friends/{{ARTIST}}');
    assert.deepEqual([p.valid, drawn(p), p.slots, p.missingVars], [true, ['From friends', '‹ARTIST›'], ['ARTIST'], []]);
    assert.deepEqual(p.crumbs[1], { text: '{{ARTIST}}', kind: 'rendered', parts: [{ slot: 'ARTIST', key: 'discover.modal.dest.slot.artist' }] });
    assert.deepEqual([p.rendered, p.relDir, p.title], ['From friends/{{ARTIST}}', 'From friends/{{ARTIST}}', 'copies/From friends/{{ARTIST}}'], 'the plain path writes a slot as its variable');
    // before the listing answers: a compilation is a slot, an album of one artist its own
    assert.deepEqual(drawn(at('album', { tags: ROW, songs: null, compilation: true }, 'From friends/{{ARTIST}}')), ['From friends', '‹ARTIST›']);
    assert.deepEqual(drawn(at('album', { tags: { ...ROW, albumartist: null }, songs: null, compilation: false }, 'From friends/{{ARTIST}}')), ['From friends', 'Boukmanflow']);
    assert.deepEqual(drawn(at('album', { tags: ROW, songs: [], compilation: true }, 'From friends/{{ARTIST}}')), ['From friends', '‹ARTIST›'], 'an empty listing is no answer');
  });

  test('album: {{ARTIST}} and {{YEAR}} the value every song agrees on — the folder name the server writes — else a slot', () => {
    const agree = at('album', { tags: { ...ROW, albumartist: null }, songs: listed(['Boukmanflow', 'Boukmanflow ']), compilation: false }, '{{ARTIST}}/{{ALBUM}} ({{YEAR}})');
    assert.deepEqual([drawn(agree), agree.slots], [['Boukmanflow', 'Night Market Sampler (2020)'], []]);
    // a compilation whose every song is one artist's lands in one folder
    assert.deepEqual(drawn(at('album', { tags: ROW, songs: listed(['Ana', 'Ana']), compilation: true }, '{{ARTIST}}')), ['Ana']);
    // a feature on an artist's own album files apart
    const feature = at('album', { tags: { ...ROW, albumartist: null }, songs: listed(['Boukmanflow', 'Boukmanflow feat. ALM']), compilation: false }, '{{ARTIST}}/{{ALBUM}}');
    assert.deepEqual(drawn(feature), ['‹ARTIST›', 'Night Market Sampler']);
    const years = at('album', { tags: ROW, songs: [...listed(['Ana'], { year: 2019 }), ...listed(['Ben'])], compilation: true }, '{{ALBUMARTIST}}/{{ALBUM}} ({{YEAR}})');
    assert.deepEqual([drawn(years), years.slots], [['Various Artists', 'Night Market Sampler (‹YEAR›)'], ['YEAR']]);
    assert.deepEqual(years.crumbs[1].parts, [{ text: 'Night Market Sampler (' }, { slot: 'YEAR', key: 'discover.modal.dest.slot.year' }, { text: ')' }], 'the folder keeps its own text');
    // no song has a year: none is the value they share — the folder's year drops out for every one
    const none = at('album', { tags: ROW, songs: listed(['Ana', 'Ben'], { year: null }), compilation: true }, '{{ALBUMARTIST}}/{{ALBUM}} ({{YEAR}})');
    assert.deepEqual([drawn(none), none.missingVars], [['Various Artists', 'Night Market Sampler ()'], ['YEAR']]);
  });

  test('album: {{ALBUMARTIST}} is the album\'s credit — its own, else the row\'s artist — never a slot; {{GENRE}} a slot unless every song\'s is known and agrees', () => {
    const comp = at('album', { tags: ROW, songs: SAMPLER, compilation: true }, '{{ALBUMARTIST}}/{{ARTIST}}');
    assert.deepEqual(drawn(comp), ['Various Artists', '‹ARTIST›']);
    const plain = at('album', { tags: { ...ROW, albumartist: null }, songs: listed(['Boukmanflow', 'Boukmanflow feat. ALM']), compilation: false }, '{{ALBUMARTIST}}/{{ARTIST}}');
    assert.deepEqual(drawn(plain), ['Boukmanflow', '‹ARTIST›'], 'the credit falls back to the row\'s artist, not to the slot');
    assert.deepEqual(drawn(at('album', { tags: { ...ROW, genre: 'Hip-Hop' }, songs: SAMPLER, compilation: true }, '{{GENRE}}/{{ALBUM}}')), ['‹GENRE›', 'Night Market Sampler'], 'the listing names each song\'s genres — these name none: the row\'s is not the album\'s');
    assert.deepEqual(drawn(at('album', { tags: ROW, songs: null, compilation: false }, '{{GENRE}}/{{ALBUM}}')), ['‹GENRE›', 'Night Market Sampler']);
    assert.deepEqual(drawn(at('album', { tags: ROW, songs: listed(['Ana', 'Ben'], { genre: 'Funk' }), compilation: true }, '{{GENRE}}/{{ALBUM}}')), ['Funk', 'Night Market Sampler']);
    assert.deepEqual(drawn(at('album', { tags: ROW, songs: [...listed(['Ana'], { genre: 'Funk' }), ...listed(['Ben'])], compilation: true }, '{{GENRE}}/{{ALBUM}}')), ['‹GENRE›', 'Night Market Sampler']);
  });

  test('song: its own values; {{GENRE}} only when the caller has the song\'s — a slot keeps its folder and its place', () => {
    const SONG = { artist: 'Boukmanflow', album: 'Borrowed Tapes', year: 2019, genre: 'Hip-Hop', albumartist: null };
    assert.deepEqual(J.scopeTags({ scope: 'song', tags: SONG }).slots, []);
    assert.deepEqual(J.scopeTags({ scope: 'song', tags: { ...SONG, genre: ' ' } }).slots, ['GENRE']);
    const known = at('song', { tags: SONG }, '{{GENRE}}/{{ARTIST}} - {{YEAR}}');
    assert.deepEqual([drawn(known), known.file], [['Hip-Hop', 'Boukmanflow - 2019'], '02 - a.mp3']);
    const unknown = at('song', { tags: { ...SONG, genre: null } }, '{{GENRE}}/{{ARTIST}} - {{YEAR}}');
    assert.deepEqual([drawn(unknown), unknown.slots, unknown.missingVars, unknown.relPath], [['‹GENRE›', 'Boukmanflow - 2019'], ['GENRE'], [], '{{GENRE}}/Boukmanflow - 2019/02 - a.mp3']);
    // the slots in the path's order; a name that is not each song's is not a slot
    const order = J.scopeTarget({ vpath: 'copies', base: 'in', layout: '{{GENRE}}/{{ARTIST}} - {{YEAR}}/{{ALBUM}}', scope: 'album', tags: SONG, slots: ['YEAR', 'ARTIST', 'GENRE', 'ALBUM', 'PEER'], fileName: 'a.mp3' });
    assert.deepEqual([drawn(order), order.slots], [['in', '‹GENRE›', '‹ARTIST› - ‹YEAR›', 'Borrowed Tapes'], ['GENRE', 'ARTIST', 'YEAR']]);
    // {{ALBUMARTIST}} falls back to the artist's VALUE, never to its slot
    const credit = J.scopeTarget({ vpath: 'copies', base: '', layout: '{{ALBUMARTIST}}/{{ARTIST}}', scope: 'album', tags: SONG, slots: ['ARTIST'], fileName: 'a.mp3' });
    assert.deepEqual(drawn(credit), ['Boukmanflow', '‹ARTIST›']);
  });

  test('the artist scopes: today\'s path — the artist, "one folder per album" — with {{GENRE}} before the cut a slot', () => {
    const ARTIST = { artist: 'Boukmanflow', albumartist: 'Boukmanflow', album: null, year: null, genre: 'Hip-Hop' };
    const walk = at('artist', { tags: ARTIST }, '{{GENRE}}/{{ARTIST}}/{{ALBUM}}');
    assert.deepEqual([drawn(walk), walk.slots, walk.perAlbum, walk.missingVars], [['‹GENRE›', 'Boukmanflow', 'discover.modal.dest.perAlbum'], ['GENRE'], true, []]);
    const after = at('artist-missing', { tags: ARTIST }, '{{ARTIST}}/{{ALBUM}}/{{GENRE}}');
    assert.deepEqual([drawn(after), after.slots], [['Boukmanflow', 'discover.modal.dest.perAlbum'], []], 'cut with the album\'s folder: no slot to show');
    const one = at('artist-missing', { tags: ARTIST }, '{{ARTIST}}/{{GENRE}}/{{ALBUM}} ({{YEAR}})', { oneAlbum: { name: 'Second Shift', year: 2021 } });
    assert.deepEqual(drawn(one), ['Boukmanflow', '‹GENRE›', 'Second Shift (2021)']);
  });

  test('listedSongTags: a listed song as the album copy files it', () => {
    const song = (metadata) => ({ filepath: 'p/a.mp3', metadata });
    assert.deepEqual(J.listedSongTags(song({ artist: 'Ana', 'artist-display': 'Ana feat. Ben', year: 2019, genres: ['Funk'] }), 'Various Artists'),
      { artist: 'Ana feat. Ben', year: 2019, genre: 'Funk', serverfolder: '' }, 'the tag as written; a file at the peer library\'s root sits in no folder');
    assert.equal(J.listedSongTags(song({ artist: 'Ana', genres: ['Funk', 'Soul'] }), null).genre, null, 'two genres: a tag the library split, unknown');
    assert.deepEqual(J.listedSongTags(song({ artist: 'Ana', year: null, genres: [] }), 'Various Artists'), { artist: 'Ana', year: null, genre: null, serverfolder: '' });
    assert.deepEqual(J.listedSongTags(song({ title: 'untagged' }), 'Various Artists'), { artist: 'Various Artists', year: null, genre: null, serverfolder: '' }, 'no artist tag: the credit the listing was asked by');
    assert.deepEqual(J.listedSongTags(null, null), { artist: null, year: null, genre: null, serverfolder: '' });
    assert.equal(J.listedSongTags({ filepath: 'peerlib/VA/Night Market Sampler/01.mp3', metadata: {} }, null).serverfolder, 'VA/Night Market Sampler', 'where its file sits on the server');
  });

  // the 2026-10-22 review: a genre tag the library split is not the folder
  // the copy writes; a compilation's year before the listing answers; a
  // listing where only some songs have a year
  test('songGenre: the one genre a song\'s metadata names — a tag the library split ("Hip-Hop/Rap" lists as two, lands in "Hip-Hop-Rap") is unknown', () => {
    assert.deepEqual([{ genres: ['Hip-Hop'] }, { genres: [' ', 'Funk'] }, { genres: ['Hip-Hop', 'Rap'] }, { genres: [] }, {}, null].map(J.songGenre),
      ['Hip-Hop', 'Funk', null, null, null, null]);
    const split = ['Color Out', 'ALM'].map((artist) => J.listedSongTags({ metadata: { artist, year: 2020, genres: ['Hip-Hop', 'Rap'] } }, 'Various Artists'));
    assert.deepEqual(drawn(at('album', { tags: ROW, songs: split, compilation: true }, '{{GENRE}}/{{ALBUM}}')), ['‹GENRE›', 'Night Market Sampler'], 'every song agrees on a split tag: still no one folder');
  });

  test('album: before the listing answers a compilation\'s {{YEAR}} is a slot too; a listing where only some songs have a year draws ‹year›', () => {
    const before = at('album', { tags: ROW, songs: null, compilation: true }, '{{ALBUMARTIST}}/{{ALBUM}} ({{YEAR}})');
    assert.deepEqual([drawn(before), before.slots], [['Various Artists', 'Night Market Sampler (‹YEAR›)'], ['YEAR']]);
    const some = at('album', { tags: ROW, songs: [...listed(['Ana'], { year: 2019 }), ...listed(['Ben'], { year: null })], compilation: true }, '{{ALBUMARTIST}}/{{ALBUM}} ({{YEAR}})');
    assert.deepEqual([drawn(some), some.slots, some.missingVars], [['Various Artists', 'Night Market Sampler (‹YEAR›)'], ['YEAR'], []], 'the song with none files without it');
  });
});

// ── {{SERVERFOLDER}} (asked for 2026-10-22: "copy the server's filepath"):
// the folder a copied song sits in on the connected server, its library's
// name dropped — several folders, each made safe; '' at the library's
// root, which drops it like any empty variable ─────────────────────────
describe('{{SERVERFOLDER}}: where the song sits on the server, as folders', () => {
  const FILE = 'peerlib/Boukmanflow/Borrowed Tapes/02 - Late Train Verse.mp3';
  const PATHS = [FILE, 'peerlib/02.mp3', 'peerlib/AC:DC?/Back*In|Black/x.mp3', 'peerlib/../..//./etc/ ~Ana /x.mp3', 'peerlib\\Win\\Dir\\x.mp3',
    ' / peerlib / A / x.mp3', 'peerlib//A//B/', 'x.mp3', '', null, undefined, 'peerlib/ .. /$HOME/x.mp3', `peerlib/${'d'.repeat(300)}/x.mp3`,
    // a '.' before the library's name is no segment: the library is still the first
    './peerlib/A/x.mp3', ' . /peerlib/A/x.mp3', '.\\peerlib\\A\\x.mp3'];

  test('serverFolderOf: the directory, its library dropped, each folder made safe — the server\'s own value for every path', () => {
    assert.deepEqual([FILE, 'peerlib/02.mp3', 'peerlib/AC:DC?/Back*In|Black/x.mp3', 'peerlib/../..//./etc/ ~Ana /x.mp3', 'peerlib\\Win\\Dir\\x.mp3', null].map(J.serverFolderOf),
      ['Boukmanflow/Borrowed Tapes', '', 'AC-DC-/Back-In-Black', 'etc/-Ana', 'Win/Dir', '']);
    assert.deepEqual(['./peerlib/A/x.mp3', ' . /peerlib/A/x.mp3'].map(J.serverFolderOf), ['A', 'A'], 'a leading "." is not the library');
    assert.equal(typeof federationCopy.serverFolderOf, 'function', 'federation-copy fills {{SERVERFOLDER}} with serverFolderOf — update this test');
    for (const p of PATHS) { assert.equal(J.serverFolderOf(p), federationCopy.serverFolderOf(p), `serverFolderOf ${JSON.stringify(p)}`); }
    for (const raw of [null, '', 'A/B', 'a\\b\\c', '../x/./y//', ' . / ~ / $HOME', 'AC:DC/x', `${'z'.repeat(300)}/y`]) {
      assert.equal(J.sanitizeFolders(raw), pathTemplate.sanitizeFolders(raw), `sanitizeFolders ${JSON.stringify(raw)}`);
    }
  });

  test('rendered: one folder per folder of the value, inside literal text too; empty drops its folder; never out of the library', () => {
    const at = (layout, serverfolder) => J.resolveLayout(layout, { artist: 'Boukmanflow', album: 'Borrowed Tapes', serverfolder });
    assert.deepEqual(at('{{SERVERFOLDER}}', 'Boukmanflow/Borrowed Tapes'), { path: 'Boukmanflow/Borrowed Tapes', missingVars: [] });
    assert.equal(at('From friends/{{SERVERFOLDER}}', 'Boukmanflow/Borrowed Tapes').path, 'From friends/Boukmanflow/Borrowed Tapes');
    assert.equal(at('Copy of {{SERVERFOLDER}}', 'Boukmanflow/Borrowed Tapes').path, 'Copy of Boukmanflow/Borrowed Tapes', 'the literal joins the first folder, the rest follow');
    assert.deepEqual(at('From friends/{{SERVERFOLDER}}/{{ALBUM}}', ''), { path: 'From friends/Borrowed Tapes', missingVars: ['SERVERFOLDER'] }, 'a song at the root: the folder drops out');
    assert.equal(at('{{SERVERFOLDER}}', '../../etc/./x').path, 'etc/x', 'a ".." in the peer\'s word is dropped, not followed');
    const p = J.previewTarget({ vpath: 'copies', base: 'Inbox', layout: '{{SERVERFOLDER}}', tags: { serverfolder: J.serverFolderOf(FILE) }, fileName: FILE });
    assert.deepEqual([p.valid, p.relPath], [true, 'Inbox/Boukmanflow/Borrowed Tapes/02 - Late Train Verse.mp3']);
    // Get it has no peer path: the file lands in the base folder itself
    assert.equal(J.previewTarget({ vpath: 'copies', base: 'Inbox', layout: '{{SERVERFOLDER}}', tags: {}, fileName: 'a.mp3' }).relPath, 'Inbox/a.mp3');
    // past the cap: refused whole, as renderTarget refuses it — never shown cut
    const deep = `peerlib/${'a'.repeat(200)}/${'b'.repeat(200)}/${'c'.repeat(200)}/x.mp3`;
    const tooLong = J.previewTarget({ vpath: 'copies', base: '', layout: '{{SERVERFOLDER}}', tags: { serverfolder: J.serverFolderOf(deep) }, fileName: deep });
    assert.deepEqual([tooLong.valid, tooLong.error], [false, 'path_too_long']);
    assert.throws(() => destination.renderTarget({ destination: { vpath: 'copies', base: '', layout: '{{SERVERFOLDER}}' }, tags: {}, serverFolder: federationCopy.serverFolderOf(deep), fileName: 'x.mp3' }),
      /exceeds 500 characters/, 'the server refuses it too');
  });

  test('validateLayout: a known variable, two folders in the sample — a layout of just {{SERVERFOLDER}} validates', () => {
    assert.ok(J.LAYOUT_VARS.includes('SERVERFOLDER'));
    for (const layout of ['{{SERVERFOLDER}}', '{{ serverfolder }}', 'From friends/{{SERVERFOLDER}}', 'Copy of {{SERVERFOLDER}}']) {
      assert.deepEqual(J.validateLayout(layout), { valid: true }, layout);
      assert.equal(destination.validateLayout(layout).valid, true, `the server agrees: ${layout}`);
    }
    assert.equal(J.resolveLayout('{{SERVERFOLDER}}', { serverfolder: J.SAMPLE_SERVERFOLDER }).path.split('/').length, 2);
    assert.deepEqual(J.validateLayout('{{SERVERFOLDER}}/../x'), { valid: false, error: 'traversal' });
    assert.equal(J.SERVERFOLDER_LAYOUT, '{{SERVERFOLDER}}', '"Same folders as the server"');
  });

  // the per-song slot rule: the song its own folder; the album the one every
  // listed song shares, else ‹server folder›; the artist scopes cut there
  const SONG = { artist: 'Boukmanflow', album: 'Borrowed Tapes', year: 2019, genre: 'Hip-Hop', albumartist: null, serverfolder: 'Boukmanflow/Borrowed Tapes' };
  const listed = (folders) => folders.map((f, i) => J.listedSongTags({ filepath: `peerlib/${f}/0${i}.mp3`, metadata: { artist: 'Boukmanflow', year: 2019, genres: ['Hip-Hop'] } }, null));
  const at = (scope, rule, layout, over) => {
    const st = J.scopeTags({ scope, ...rule });
    return J.scopeTarget({ vpath: 'copies', base: '', layout, scope, tags: st.tags, slots: st.slots, peerName: 'Stage Peer B', fileName: FILE, ...over });
  };
  const drawn = (p) => p.crumbs.map((c) => (c.parts ? c.parts.map((x) => (x.slot ? `‹${x.slot}›` : x.text)).join('') : c.text || c.key));

  test('the song: its own folder on the server, never a slot', () => {
    const p = at('song', { tags: SONG }, '{{SERVERFOLDER}}');
    assert.deepEqual([drawn(p), p.slots, p.file], [['Boukmanflow', 'Borrowed Tapes'], [], '02 - Late Train Verse.mp3']);
    assert.deepEqual(drawn(at('song', { tags: SONG }, 'Copy of {{SERVERFOLDER}}')), ['Copy of Boukmanflow', 'Borrowed Tapes']);
    const root = at('song', { tags: { ...SONG, serverfolder: '' } }, 'From friends/{{SERVERFOLDER}}');
    assert.deepEqual([drawn(root), root.missingVars, root.slots], [['From friends'], ['SERVERFOLDER'], []], 'a song at the root: the folder drops out');
  });

  test('the album: the folder every listed song shares; songs in more than one folder draw ‹server folder›; before the listing, the row\'s', () => {
    const one = at('album', { tags: SONG, songs: listed(['Boukmanflow/Borrowed Tapes', 'Boukmanflow/Borrowed Tapes']) }, 'From friends/{{SERVERFOLDER}}');
    assert.deepEqual([drawn(one), one.slots], [['From friends', 'Boukmanflow', 'Borrowed Tapes'], []]);
    const discs = at('album', { tags: SONG, songs: listed(['Boukmanflow/Borrowed Tapes/CD1', 'Boukmanflow/Borrowed Tapes/CD2']) }, 'From friends/{{SERVERFOLDER}}');
    assert.deepEqual([drawn(discs), discs.slots, discs.rendered], [['From friends', '‹SERVERFOLDER›'], ['SERVERFOLDER'], 'From friends/{{SERVERFOLDER}}']);
    assert.deepEqual(discs.crumbs[1].parts, [{ slot: 'SERVERFOLDER', key: 'discover.modal.dest.slot.serverfolder' }]);
    assert.deepEqual(drawn(at('album', { tags: SONG, songs: listed(['A/B', 'A-B']) }, '{{SERVERFOLDER}}')), ['‹SERVERFOLDER›'], 'folders compared whole: "A/B" is not "A-B"');
    assert.deepEqual(drawn(at('album', { tags: SONG, songs: listed(['CD1', 'CD2']) }, 'Copy of {{SERVERFOLDER}}')), ['Copy of ‹SERVERFOLDER›'], 'the slot keeps its folder\'s text');
    assert.deepEqual(drawn(at('album', { tags: SONG, songs: null, compilation: true }, '{{SERVERFOLDER}}')), ['Boukmanflow', 'Borrowed Tapes'], 'no listing yet: the row\'s folder, a compilation too');
    const both = at('album', { tags: { ...SONG, albumartist: 'Various Artists' }, songs: [...listed(['VA/Sampler']), { ...listed(['VA/Sampler'])[0], artist: 'ALM' }], compilation: true },
      '{{ARTIST}}/{{SERVERFOLDER}}');
    assert.deepEqual([drawn(both), both.slots], [['‹ARTIST›', 'VA', 'Sampler'], ['ARTIST']]);
  });

  test('the artist scopes: the folder naming {{SERVERFOLDER}} and every one after it is "one folder per album"; the one missing album its slot', () => {
    const ARTIST = { artist: 'Boukmanflow', albumartist: 'Boukmanflow', album: null, year: null, genre: null, serverfolder: 'Boukmanflow/Borrowed Tapes' };
    const walk = at('artist', { tags: ARTIST }, 'From friends/{{SERVERFOLDER}}/{{ALBUM}}');
    assert.deepEqual([drawn(walk), walk.perAlbum, walk.slots, walk.missingVars], [['From friends', 'discover.modal.dest.perAlbum'], true, [], []], 'never the seed song\'s own folder');
    assert.deepEqual(drawn(at('artist-missing', { tags: ARTIST }, '{{ARTIST}}/Copy of {{SERVERFOLDER}}')), ['Boukmanflow', 'discover.modal.dest.perAlbum']);
    const one = at('artist-missing', { tags: ARTIST }, '{{SERVERFOLDER}}', { oneAlbum: { name: 'Second Shift', year: 2021 } });
    assert.deepEqual([drawn(one), one.slots], [['‹SERVERFOLDER›'], ['SERVERFOLDER']], 'its folder on the server is not known here');
  });
});

describe('sameDestination: the jobs route\'s "destination_changed" test', () => {
  test('the library, the base folder as normalised, the layout as typed — never the source — as destination.js has it', () => {
    const d = { vpath: 'copies', base: 'from-peers', layout: '{{ALBUMARTIST}}/{{ALBUM}}' };
    const cases = [
      [d, { ...d, source: 'user' }],
      [d, { ...d, base: ' from-peers/ ' }],
      [d, { ...d, base: 'from-peers\\' }],
      [d, { ...d, vpath: 'music' }],
      [d, { ...d, base: 'From-peers' }],
      [d, { ...d, layout: '{{ ALBUMARTIST }}/{{ALBUM}}' }],
      [{ ...d, base: '..' }, { ...d, base: '..' }],
      [{ ...d, base: '' }, { ...d, base: null }],
      [null, null], [d, null], [null, d], [undefined, null],
    ];
    for (const [a, b] of cases) {
      assert.equal(J.sameDestination(a, b), destination.sameDestination(a, b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    }
    assert.deepEqual(cases.slice(0, 6).map(([a, b]) => J.sameDestination(a, b)), [true, true, true, false, false, false]);
  });
});

describe('landedPath: where a finished copy\'s files are', () => {
  const many = (songs, over) => ({ songs: { total: 3, copied: [], skipped: [], failed: [], ...songs }, stopped: null, destination: { vpath: 'copies', base: '', layout: '{{ALBUMARTIST}}/{{ALBUM}}' }, ...over });
  test('a song: its file, where it was copied, found already here, or found at the target', () => {
    assert.deepEqual(J.landedPath({ copied: { vpath: 'copies', filepath: 'copies/Boukmanflow/Borrowed Tapes/02 - Late Train Verse.mp3' } }),
      { vpath: 'copies', dirs: ['Boukmanflow', 'Borrowed Tapes'], file: '02 - Late Train Verse.mp3' });
    assert.deepEqual(J.landedPath({ skipped: 'owned', existing: { filepath: 'music/Old Rip/Late Train.flac' } }), { vpath: 'music', dirs: ['Old Rip'], file: 'Late Train.flac' });
    assert.equal(J.landedPath({ skipped: 'owned', existing: null }), null, 'already yours, no location: no path');
    assert.deepEqual(J.landedPath({ skipped: 'exists', filepath: 'copies/a.mp3' }), { vpath: 'copies', dirs: [], file: 'a.mp3' });
    assert.equal(J.landedPath(null), null);
    assert.equal(J.landedPath({}), null);
  });
  test('an album or an artist: the folder the copied files share; already yours: the folder of what was found; failed, refused or cancelled before a song: nothing', () => {
    const tapes = (n) => ({ filepath: `copies/Boukmanflow/Borrowed Tapes/0${n}.mp3` });
    assert.deepEqual(J.landedPath(many({ copied: [tapes(1), tapes(2)], failed: [{}] })), { vpath: 'copies', dirs: ['Boukmanflow', 'Borrowed Tapes'], file: null });
    assert.deepEqual(J.landedPath(many({ copied: [tapes(1), { filepath: 'copies/Boukmanflow/Second Shift/01.mp3' }] })), { vpath: 'copies', dirs: ['Boukmanflow'], file: null });
    assert.deepEqual(J.landedPath(many({ copied: [tapes(1)] }, { stopped: 'quota' })), { vpath: 'copies', dirs: ['Boukmanflow', 'Borrowed Tapes'], file: null }, 'stopped after one: where that one is');
    assert.deepEqual(J.landedPath(many({ skipped: [{ why: 'owned', at: 'music/Boukmanflow/Borrowed Tapes/1.mp3' }, { why: 'owned', at: 'music/Boukmanflow/Borrowed Tapes/2.mp3' }] })),
      { vpath: 'music', dirs: ['Boukmanflow', 'Borrowed Tapes'], file: null });
    assert.equal(J.landedPath(many({ skipped: [{ why: 'owned', at: 'music/a/1.mp3' }], failed: [{}, {}] })), null, 'copied nothing, some failed: a failure, no path');
    assert.equal(J.landedPath(many({ failed: [{}] }, { stopped: 'refused' })), null);
    assert.equal(J.landedPath(many({}, { stopped: 'cancelled' })), null);
    assert.equal(J.landedPath(many({ skipped: [{ why: 'owned', at: 'music/a/1.mp3' }, { why: 'owned', at: 'copies/b/2.mp3' }] })), null, 'no library in common');
    assert.equal(J.landedPath(many({}, { skippedAlbums: [{ why: 'owned' }] })), null, 'albums left out whole: nothing to point at');
  });
  test('copied songs the result does not list (an older server: counts alone) → the caller draws the destination it ran with', () => {
    assert.deepEqual(J.landedPath({ counts: { total: 3, copied: 2, skipped: 1, failed: 0 } }), { vpath: null, dirs: [], file: null });
    assert.equal(J.landedPath({ counts: { total: 3, copied: 0, skipped: 3, failed: 0 } }), null);
  });
});
