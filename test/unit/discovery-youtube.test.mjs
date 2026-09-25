/**
 * The youtube plug-in's pure parts (src/discovery-plugins/plugins/youtube.js)
 * and the yt-dlp helper's pure parts (src/util/yt-dlp.js): reading YouTube
 * titles, ranking results against a recommendation, the download argument
 * set, the progress parser and the binary resolution. No process is spawned.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as ytdlp from '../../src/util/yt-dlp.js';
import plugin, {
  TOPIC_BONUS, cleanTitle, blockedWord, splitArtistTitle, isTopicChannel, channelArtist,
  toCandidates, rankCandidates, pickBest, isYouTubeUrl, lookupCandidates, isUnavailableMessage,
  lookupCacheKey, acquireLookupSlot, lookupLoad, LOOKUP_CONCURRENCY, LOOKUP_QUEUE_MAX, isLiveEntry,
} from '../../src/discovery-plugins/plugins/youtube.js';
import { MIN_SCORE } from '../../src/discovery-plugins/match.js';
import { normalizeRecommendation } from '../../src/discovery-plugins/recommendation.js';

const REC = { artist: 'Neon Harbor', title: 'Salt & Static', album: 'Low Tide Recordings', duration: 253 };
const entry = (over) => ({ id: 'x', url: 'https://www.youtube.com/watch?v=x', title: '', durationSec: 253, channel: null, uploader: null, artist: null, album: null, ...over });

describe('youtube · plug-in shape', () => {
  test('an acquire plug-in with a lookup, server scope, one at a time, with a probe', () => {
    assert.equal(plugin.name, 'youtube');
    assert.deepEqual([...plugin.capabilities], ['acquire', 'lookup']);
    assert.equal(plugin.scope, 'server');
    assert.equal(plugin.concurrency, 1);
    assert.equal(typeof plugin.run, 'function');
    assert.equal(typeof plugin.probe, 'function');
    assert.equal(typeof plugin.resolve, 'function');
    assert.equal(typeof plugin.validateChoice, 'function');
  });
});

describe('youtube · a live stream is not a song', () => {
  test('entryToRecord keeps what yt-dlp says about a live stream; isLiveEntry reads it', () => {
    assert.deepEqual([ytdlp.entryToRecord({ id: 'a', is_live: true }).isLive, ytdlp.entryToRecord({ id: 'a', is_live: true }).liveStatus], [true, null]);
    assert.deepEqual([ytdlp.entryToRecord({ id: 'b', live_status: 'is_upcoming' }).isLive, ytdlp.entryToRecord({ id: 'b', live_status: 'is_upcoming' }).liveStatus], [false, 'is_upcoming']);
    assert.equal(ytdlp.entryToRecord({ id: 'c', live_status: 'not_live' }).isLive, false);
    assert.equal(isLiveEntry(ytdlp.entryToRecord({ id: 'a', is_live: true })), true);
    assert.equal(isLiveEntry(ytdlp.entryToRecord({ id: 'b', live_status: 'is_upcoming' })), true, 'not started yet');
    assert.equal(isLiveEntry(ytdlp.entryToRecord({ id: 'c', live_status: 'post_live' })), true, 'just ended, still being processed');
    assert.equal(isLiveEntry(ytdlp.entryToRecord({ id: 'd', live_status: 'was_live' })), false, 'a finished stream is an upload like any other');
    assert.equal(isLiveEntry(ytdlp.entryToRecord({ id: 'e', live_status: 'not_live' })), false);
    assert.equal(isLiveEntry(ytdlp.entryToRecord({ id: 'f' })), false);
    assert.equal(isLiveEntry(null), false);
  });

  test('rankCandidates never offers a live stream, however well its title matches', () => {
    const live = entry({ id: 'live', url: 'https://www.youtube.com/watch?v=live', title: 'Salt & Static', channel: 'Neon Harbor - Topic', isLive: true });
    const song = entry({ id: 'song', url: 'https://www.youtube.com/watch?v=song', title: 'Salt & Static', channel: 'Neon Harbor - Topic' });
    assert.deepEqual(rankCandidates(REC, [live, song]).map((r) => r.entry.id), ['song']);
    assert.deepEqual(rankCandidates(REC, [{ ...live, isLive: false, liveStatus: 'is_upcoming' }]), []);
  });

  test('the download arguments tell yt-dlp the same, as a backstop', () => {
    const args = ytdlp.downloadArgs({ url: 'https://www.youtube.com/watch?v=x', dir: '/tmp/x' });
    const at = args.indexOf('--match-filters');
    assert.ok(at > 0);
    assert.equal(args[at + 1], '!is_live');
  });
});

describe('youtube · the lookup cache key and its slots', () => {
  test('the key is what was searched and scored against, never the MBID alone: no planting an answer under a real recording id', () => {
    const real = normalizeRecommendation({ recordingMbid: 'b1a9c0de-0000-4000-8000-000000000001', artist: 'Nova', title: 'Remote Hit', album: 'Night Ferry', duration: 253 });
    const planted = normalizeRecommendation({ recordingMbid: 'b1a9c0de-0000-4000-8000-000000000001', artist: 'Prank Band', title: 'Not The Song' });
    const n = 8;
    assert.notEqual(lookupCacheKey(planted, 'Prank Band Not The Song', n), lookupCacheKey(real, 'Nova Remote Hit', n));
    assert.equal(lookupCacheKey(real, 'Nova Remote Hit', n), lookupCacheKey({ ...real }, 'nova remote hit!', n), 'the phrase is normalised');
    assert.notEqual(lookupCacheKey(real, 'Nova Remote Hit', n), lookupCacheKey({ ...real, album: 'Late Sessions' }, 'Nova Remote Hit', n), 'the album it is scored against counts');
    assert.notEqual(lookupCacheKey(real, 'Nova Remote Hit', n), lookupCacheKey({ ...real, duration: 400 }, 'Nova Remote Hit', n), 'so does the length');
    assert.notEqual(lookupCacheKey(real, 'Nova Remote Hit', n), lookupCacheKey(real, 'Nova Remote Hit', 5), 'and how many results were asked for');
    const kino = normalizeRecommendation({ artist: 'Кино', title: 'Группа крови' });
    const splean = normalizeRecommendation({ artist: 'Сплин', title: 'Выхода нет' });
    assert.notEqual(lookupCacheKey(kino, 'Кино Группа крови', n), lookupCacheKey(splean, 'Сплин Выхода нет', n), 'two non-Latin songs are two keys');
  });

  test('slots: two lookups run, six wait in line, the next is refused with a 429, and a release lets the next in', async () => {
    const releases = [];
    for (let i = 0; i < LOOKUP_CONCURRENCY; i++) { releases.push(await acquireLookupSlot()); }
    assert.deepEqual(lookupLoad(), { busy: LOOKUP_CONCURRENCY, waiting: 0 });
    const waiting = [];
    for (let i = 0; i < LOOKUP_QUEUE_MAX; i++) {
      let got = false;
      const p = acquireLookupSlot().then((release) => { got = true; return release; });
      waiting.push({ p, got: () => got });
    }
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(lookupLoad(), { busy: LOOKUP_CONCURRENCY, waiting: LOOKUP_QUEUE_MAX });
    assert.ok(waiting.every((w) => !w.got()), 'the line waits');
    await assert.rejects(acquireLookupSlot(), (err) => err.status === 429 && /too many lookups/.test(err.message));
    releases[0]();
    const next = await waiting[0].p;
    assert.equal(typeof next, 'function', 'the first in line got the freed slot');
    assert.deepEqual(lookupLoad(), { busy: LOOKUP_CONCURRENCY, waiting: LOOKUP_QUEUE_MAX - 1 });
    // Drain: every waiter is let through in order, then the slots empty.
    next();
    releases[1]();
    for (let i = 1; i < waiting.length; i++) { (await waiting[i].p)(); }
    assert.deepEqual(lookupLoad(), { busy: 0, waiting: 0 });
  });
});

describe('youtube · reading titles', () => {
  test('edition noise goes, the song stays', () => {
    assert.equal(cleanTitle('Neon Harbor - Salt & Static (Official Audio)'), 'Neon Harbor - Salt & Static');
    assert.equal(cleanTitle('Salt & Static [Official Music Video] (HD)'), 'Salt & Static');
    assert.equal(cleanTitle('Salt & Static | Official Lyric Video'), 'Salt & Static');
    assert.equal(cleanTitle('Salt & Static - Lyrics'), 'Salt & Static');
    assert.equal(cleanTitle('Salt & Static (2019 Remaster)'), 'Salt & Static (2019 Remaster)', 'remaster is the scorer\'s business, not noise');
  });

  test('blocked words: only when the recommendation does not carry them', () => {
    assert.equal(blockedWord('Salt & Static (Live at the Pier)', 'Salt & Static'), 'live');
    assert.equal(blockedWord('Salt & Static - Piano Cover', 'Salt & Static'), 'cover');
    assert.equal(blockedWord('Salt & Static (Karaoke Version)', 'Salt & Static'), 'karaoke');
    assert.equal(blockedWord('Salt & Static (Live)', 'Salt & Static (Live)'), null, 'the recommendation is the live take');
    assert.equal(blockedWord('Salt & Static', 'Salt & Static'), null);
  });

  test('"Artist - Title" splits; a title without a dash does not', () => {
    assert.deepEqual(splitArtistTitle('Neon Harbor - Salt & Static'), { artist: 'Neon Harbor', title: 'Salt & Static' });
    assert.deepEqual(splitArtistTitle('Neon Harbor – Salt & Static'), { artist: 'Neon Harbor', title: 'Salt & Static' });
    assert.equal(splitArtistTitle('Salt & Static'), null);
  });

  test('Topic channels are YouTube\'s own release audio', () => {
    assert.equal(isTopicChannel('Neon Harbor - Topic'), true);
    assert.equal(isTopicChannel('Neon Harbor'), false);
    assert.equal(channelArtist('Neon Harbor - Topic'), 'Neon Harbor');
    assert.equal(channelArtist(''), null);
  });

  test('toCandidates reads a result both as titled and split', () => {
    const cands = toCandidates(entry({ title: 'Neon Harbor - Salt & Static (Official Audio)', channel: 'Some Uploader', durationSec: 250 }));
    assert.equal(cands.length, 2);
    assert.equal(cands[0].title, 'Neon Harbor - Salt & Static');
    assert.equal(cands[0].artist, 'Some Uploader');
    assert.equal(cands[1].title, 'Salt & Static');
    assert.equal(cands[1].artist, 'Neon Harbor');
    assert.equal(cands[1].split, true);
    assert.equal(cands[0].durationSec, 250);
  });
});

describe('youtube · ranking', () => {
  test('the official audio wins over a lyric video, a live take is out, the wrong song is far behind', () => {
    const ranked = rankCandidates(REC, [
      entry({ id: 'lyric', url: 'https://www.youtube.com/watch?v=lyric', title: 'Neon Harbor - Salt & Static (Lyric Video)', channel: 'LyricsHub', durationSec: 254 }),
      entry({ id: 'live', url: 'https://www.youtube.com/watch?v=live', title: 'Neon Harbor - Salt & Static (Live at the Pier)', channel: 'Neon Harbor', durationSec: 300 }),
      entry({ id: 'topic', url: 'https://www.youtube.com/watch?v=topic', title: 'Salt & Static', channel: 'Neon Harbor - Topic', artist: 'Neon Harbor', album: 'Low Tide Recordings', durationSec: 253 }),
      entry({ id: 'other', url: 'https://www.youtube.com/watch?v=other', title: 'Glass Hours', channel: 'Ondine - Topic', durationSec: 250 }),
    ]);
    assert.deepEqual(ranked.map((r) => r.entry.id), ['topic', 'lyric', 'other'], 'live is dropped; topic first');
    assert.equal(ranked[0].score, 1, 'a full match plus the Topic bonus reports 1, never more');
    assert.ok(ranked[1].score >= MIN_SCORE && ranked[1].score <= 1, 'the lyric video is still the song');
    assert.ok(ranked[2].score < MIN_SCORE, 'a different song does not clear the bar');
    const best = pickBest(ranked);
    assert.equal(best.entry.id, 'topic');
    assert.equal(best.candidate.topic, true);
  });

  test('a length far off rules a result out; a Topic bonus is small and never invents a match', () => {
    const ranked = rankCandidates(REC, [
      entry({ id: 'long', url: 'https://www.youtube.com/watch?v=long', title: 'Neon Harbor - Salt & Static (Full Album)', channel: 'Neon Harbor - Topic', durationSec: 2600 }),
      entry({ id: 'wrong', url: 'https://www.youtube.com/watch?v=wrong', title: 'Something Else Entirely', channel: 'Neon Harbor - Topic', durationSec: 253 }),
    ]);
    assert.deepEqual(ranked.map((r) => r.entry.id), ['wrong']);
    assert.ok(ranked[0].score <= TOPIC_BONUS, 'title mismatch scores zero, plus the bonus at most');
    assert.equal(pickBest(ranked), null);
    assert.equal(pickBest([]), null);
  });

  test('entries without a url are skipped', () => {
    assert.deepEqual(rankCandidates(REC, [entry({ url: null, title: 'Salt & Static' })]), []);
  });
});

describe('yt-dlp helper · pure parts', () => {
  test('downloadArgs: the shared argument set, per codec', () => {
    const args = ytdlp.downloadArgs({ url: 'https://www.youtube.com/watch?v=x', dir: '/tmp/dl', codec: 'mp3', ffmpegPath: path.resolve('/opt/ffmpeg/ffmpeg'), maxFilesizeMb: 100 });
    // `ba/b`, not `ba`: YouTube often offers a yt-dlp without a JS runtime no
    // audio-only stream at all, and a bare `ba` then has nothing to pick.
    assert.deepEqual(args.slice(0, 5), ['-f', 'ba/b', '-x', '--no-playlist', 'https://www.youtube.com/watch?v=x']);
    assert.equal(args[args.indexOf('-o') + 1], path.join('/tmp/dl', '%(title)s.%(ext)s'));
    assert.ok(args.includes('--restrict-filenames') && args.includes('--no-overwrites'));
    assert.equal(args[args.indexOf('--audio-format') + 1], 'mp3');
    assert.equal(args[args.indexOf('--print') + 1], 'after_move:filepath');
    assert.equal(args[args.indexOf('--ffmpeg-location') + 1], path.resolve('/opt/ffmpeg/ffmpeg'));
    assert.equal(args[args.indexOf('--max-filesize') + 1], '100M');
    assert.ok(args.includes('--embed-thumbnail'), 'mp3 gets yt-dlp\'s thumbnail embed');

    const ogg = ytdlp.downloadArgs({ url: 'u', dir: 'd', codec: 'ogg', ffmpegPath: 'ffmpeg' });
    assert.equal(ogg[ogg.indexOf('--audio-format') + 1], 'vorbis');
    assert.ok(!ogg.includes('--embed-thumbnail'), 'ogg is embedded by our own pass');
    assert.ok(!ogg.includes('--ffmpeg-location'), 'a bare PATH name is not passed as a location');
    assert.ok(!ogg.includes('--max-filesize'));
  });

  test('parseProgressLine reads yt-dlp\'s download lines only', () => {
    assert.equal(ytdlp.parseProgressLine('[download]  43.2% of    5.10MiB at    1.20MiB/s ETA 00:03'), 0.432);
    assert.equal(ytdlp.parseProgressLine('[download] 100% of 5.10MiB in 00:04'), 1);
    assert.equal(ytdlp.parseProgressLine('[ExtractAudio] Destination: x.mp3'), null);
    assert.equal(ytdlp.parseProgressLine('/tmp/dl/x.mp3'), null);
  });

  test('outputExtension and the last meaningful line', () => {
    assert.equal(ytdlp.outputExtension('aac'), 'm4a');
    assert.equal(ytdlp.outputExtension('mp3'), 'mp3');
    assert.equal(ytdlp.lastMeaningfulLine('WARNING: x\nERROR: Sign in to confirm you’re not a bot\n\n'), 'Sign in to confirm you’re not a bot');
    assert.equal(ytdlp.lastMeaningfulLine(''), '');
  });

  test('entryToRecord normalises a flat entry and a full dump the same way', () => {
    const flat = ytdlp.entryToRecord({ id: 'x', title: 'T', duration: 253, channel: 'C - Topic', url: 'https://www.youtube.com/watch?v=x' });
    assert.deepEqual([flat.id, flat.title, flat.durationSec, flat.channel, flat.url], ['x', 'T', 253, 'C - Topic', 'https://www.youtube.com/watch?v=x']);
    const full = ytdlp.entryToRecord({ id: 'y', title: 'T', duration: '10', webpage_url: 'https://youtu.be/y', uploader: 'U', artist: 'A', album: 'B', release_date: '20190614', view_count: 7 });
    assert.equal(full.durationSec, 10);
    assert.equal(full.url, 'https://youtu.be/y');
    assert.equal(full.channel, 'U');
    assert.equal(full.year, 2019);
    assert.equal(full.viewCount, 7);
    assert.equal(ytdlp.entryToRecord({ id: 'z', duration: 0 }).durationSec, null);
    assert.equal(ytdlp.entryToRecord({ id: 'z' }).url, 'https://www.youtube.com/watch?v=z');
  });

  test('resolveBinary: the environment beats the configured name; a script runs under node', () => {
    const saved = process.env.MSTREAM_YTDLP_BIN;
    try {
      delete process.env.MSTREAM_YTDLP_BIN;
      assert.deepEqual(ytdlp.resolveBinary('yt-dlp'), { cmd: 'yt-dlp', prefix: [] });
      assert.deepEqual(ytdlp.resolveBinary('/usr/local/bin/yt-dlp'), { cmd: '/usr/local/bin/yt-dlp', prefix: [] });
      assert.deepEqual(ytdlp.resolveBinary(undefined), { cmd: 'yt-dlp', prefix: [] });
      process.env.MSTREAM_YTDLP_BIN = '/x/fake-yt-dlp.mjs';
      const script = ytdlp.resolveBinary('yt-dlp');
      assert.equal(script.cmd, process.execPath);
      assert.deepEqual(script.prefix, ['/x/fake-yt-dlp.mjs']);
      process.env.MSTREAM_YTDLP_BIN = '/x/yt-dlp.exe';
      assert.deepEqual(ytdlp.resolveBinary('yt-dlp'), { cmd: '/x/yt-dlp.exe', prefix: [] });
    } finally {
      if (saved === undefined) { delete process.env.MSTREAM_YTDLP_BIN; } else { process.env.MSTREAM_YTDLP_BIN = saved; }
    }
  });
});

describe('youtube · the lookup', () => {
  test('a chosen upload must be a YouTube link: watch pages, shorts, live pages, youtu.be — nothing else', () => {
    for (const ok of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtube.com/watch?v=abc123', 'https://m.youtube.com/watch?v=abc123&t=10',
      'https://music.youtube.com/watch?v=abc123', 'https://youtu.be/abc123', 'https://www.youtube.com/shorts/abc123', 'https://www.youtube.com/live/abc123',
    ]) {
      assert.equal(isYouTubeUrl(ok), true, ok);
    }
    for (const bad of [
      'https://example.com/watch?v=abc123', 'https://www.youtube.com/', 'https://www.youtube.com/watch', 'https://www.youtube.com/playlist?list=PL1',
      'ftp://www.youtube.com/watch?v=abc123', 'https://evil.youtube.com.example/watch?v=abc123', 'https://notyoutube.com/watch?v=abc123', 'not a url', '', null,
    ]) {
      assert.equal(isYouTubeUrl(bad), false, String(bad));
    }
    assert.throws(() => plugin.validateChoice({ url: 'https://example.com/x' }), /YouTube link/);
    assert.throws(() => plugin.validateChoice(null), /YouTube link/);
    plugin.validateChoice({ url: 'https://youtu.be/abc123' });
  });

  test('lookupCandidates: the ranked list as a window shows it — best first, capped, the upload\'s own title and link', () => {
    const entries = [
      entry({ id: 'topic', url: 'https://www.youtube.com/watch?v=topic1', title: 'Salt & Static', channel: 'Neon Harbor - Topic', thumbnail: 'https://i/t.jpg' }),
      entry({ id: 'lyric', url: 'https://www.youtube.com/watch?v=lyric1', title: 'Neon Harbor - Salt & Static (Lyric Video)', channel: 'LyricsHub' }),
      entry({ id: 'live', url: 'https://www.youtube.com/watch?v=live1', title: 'Neon Harbor - Salt & Static (Live)', channel: 'Neon Harbor' }),
    ];
    const ranked = rankCandidates(REC, entries);
    const out = lookupCandidates(ranked);
    assert.deepEqual(out.map((c) => c.id), ['topic', 'lyric'], 'the live take is not offered');
    assert.deepEqual(Object.keys(out[0]).sort(), ['channel', 'durationSec', 'id', 'score', 'thumbnail', 'title', 'topic', 'url']);
    assert.equal(out[0].title, 'Salt & Static');
    assert.equal(out[0].channel, 'Neon Harbor - Topic');
    assert.equal(out[0].topic, true);
    assert.equal(out[0].thumbnail, 'https://i/t.jpg');
    assert.equal(out[0].durationSec, 253);
    assert.ok(out[0].score >= out[1].score, `${out[0].score} > ${out[1].score}`);
    assert.equal(out[1].title, 'Neon Harbor - Salt & Static (Lyric Video)', 'as titled on YouTube, not cleaned');
    assert.equal(lookupCandidates(ranked, { max: 1 }).length, 1);
    assert.deepEqual(lookupCandidates([]), []);
  });
});

describe('youtube · what the search hands back', () => {
  test('a flat search entry lists its thumbnails; the record takes the largest, a full dump names one', () => {
    const flat = ytdlp.entryToRecord({ id: 'a', title: 'A', duration: 10, thumbnails: [{ url: 'https://i/small.jpg', height: 94 }, { url: 'https://i/large.jpg', height: 720 }] });
    assert.equal(flat.thumbnail, 'https://i/large.jpg');
    assert.equal(ytdlp.entryToRecord({ id: 'b', title: 'B', duration: 10, thumbnail: 'https://i/one.jpg', thumbnails: [{ url: 'https://i/x.jpg' }] }).thumbnail, 'https://i/one.jpg');
    assert.equal(ytdlp.entryToRecord({ id: 'c', title: 'C', duration: 10, thumbnails: [] }).thumbnail, null);
    assert.equal(ytdlp.entryToRecord({ id: 'd', title: 'D', duration: 10 }).thumbnail, null);
  });

  test('the words yt-dlp uses for an upload it cannot serve', () => {
    for (const m of ['[youtube] DvE7O3bLQgE: This video is not available', 'Video unavailable', 'Private video. Sign in if you\'ve been granted access', 'This video has been removed by the uploader', 'Sign in to confirm your age']) {
      assert.equal(isUnavailableMessage(m), true, m);
    }
    for (const m of ['HTTP Error 429: Too Many Requests', 'Unable to download webpage: timed out', '', null]) {
      assert.equal(isUnavailableMessage(m), false, String(m));
    }
  });
});
