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
  toCandidates, rankCandidates, pickBest,
} from '../../src/discovery-plugins/plugins/youtube.js';
import { MIN_SCORE } from '../../src/discovery-plugins/match.js';

const REC = { artist: 'Neon Harbor', title: 'Salt & Static', album: 'Low Tide Recordings', duration: 253 };
const entry = (over) => ({ id: 'x', url: 'https://www.youtube.com/watch?v=x', title: '', durationSec: 253, channel: null, uploader: null, artist: null, album: null, ...over });

describe('youtube · plug-in shape', () => {
  test('an acquire plug-in, server scope, one at a time, with a probe', () => {
    assert.equal(plugin.name, 'youtube');
    assert.deepEqual([...plugin.capabilities], ['acquire']);
    assert.equal(plugin.scope, 'server');
    assert.equal(plugin.concurrency, 1);
    assert.equal(typeof plugin.run, 'function');
    assert.equal(typeof plugin.probe, 'function');
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
    assert.deepEqual(args.slice(0, 5), ['-f', 'ba', '-x', '--no-playlist', 'https://www.youtube.com/watch?v=x']);
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
