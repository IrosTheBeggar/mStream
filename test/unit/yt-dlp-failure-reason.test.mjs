/**
 * src/util/yt-dlp.js failureReason — yt-dlp's own words to the Youtube DL
 * route's reason codes (exists | too-big | too-long | live | unavailable),
 * or null when no code fits and the words are the answer. The lines are
 * the real ones: the refusals checked offline against yt-dlp 2026.08.19,
 * the YouTube texts as its extractor raises them.
 *
 * The bot check, an out-of-date yt-dlp and YouTube rate-limiting the server
 * are null ON PURPOSE: they are the server's problem, not the video's, and
 * "unavailable" would blame the video — the client quotes the server's
 * words instead.
 *
 * errorLineReason — which line of a failed download is read at all: an
 * extractor's own refusal only, never a line that carries a file name.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as ytdlp from '../../src/util/yt-dlp.js';

const CASES = [
  // The video itself is not there for this server.
  ['[youtube] dQw4w9WgXcQ: Video unavailable. This video is no longer available because the YouTube account associated with this video has been terminated.', 'unavailable'],
  ['[youtube] dQw4w9WgXcQ: Video unavailable', 'unavailable'],
  ['[youtube] dQw4w9WgXcQ: Private video. Sign in if you\'ve been granted access to this video', 'unavailable'],
  ['[youtube] dQw4w9WgXcQ: Sign in to confirm your age. This video may be inappropriate for some users.', 'unavailable'],
  ['[youtube] dQw4w9WgXcQ: The uploader has not made this video available in your country', 'unavailable'],
  ['[youtube] dQw4w9WgXcQ: Video unavailable. This video is not available in your country', 'unavailable'],
  ['[youtube] dQw4w9WgXcQ: Join this channel to get access to members-only content like this video, and other exclusive perks.', 'unavailable'],
  ['[youtube] dQw4w9WgXcQ: Video unavailable. This video has been removed for violating YouTube\'s Terms of Service', 'unavailable'],
  ['[youtube] dQw4w9WgXcQ: Video unavailable. This video contains content from SME, who has blocked it on copyright grounds', 'unavailable'],
  ['[youtube] dQw4w9WgXcQ: This video is available to this channel\'s members on level: Tier 1 (or any higher level). Join this channel to get access to members-only content and other exclusive perks.', 'unavailable'],
  ['[youtube] dQw4w9WgXcQ: This video is only available to Music Premium members', 'unavailable'],
  ['[youtube] dQw4w9WgXcQ: This video requires payment to watch', 'unavailable'],
  ['[youtube] dQw4w9WgXcQ: This video is DRM protected', 'unavailable'],
  // A stream: on air, or not yet.
  ['[youtube] dQw4w9WgXcQ: This live event will begin in 3 hours.', 'live'],
  ['[youtube] dQw4w9WgXcQ: Premieres in 2 days', 'live'],
  ['[download] Radio 24/7 does not pass filter (!is_live), skipping ..', 'live'],
  // The caps.
  ['[download] File is larger than max-filesize (16526 bytes > 1024 bytes). Aborting.', 'too-big'],
  ['the download passed the 500 MB size cap and was stopped', 'too-big'],
  ['the download took longer than 60 minutes and was stopped', 'too-long'],
  // The never-replace checks.
  ['a file named Remote_Hit.mp3 already exists in inbox — nothing was replaced', 'exists'],
  ['a file with that name already exists in this folder (Remote_Hit.mp3)', 'exists'],
  // The server's problem: the words are the answer.
  ['[youtube] dQw4w9WgXcQ: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.', null],
  ['[youtube] dQw4w9WgXcQ: Sign in to confirm you\'re not a bot', null],
  ['[youtube] dQw4w9WgXcQ: Requested format is not available. Use --list-formats for a list of available formats', null],
  ['unable to download video data: HTTP Error 403: Forbidden', null],
  ['[youtube] dQw4w9WgXcQ: nsig extraction failed: Some formats may be missing', null],
  ['[youtube] dQw4w9WgXcQ: Unable to extract uploader id; please report this issue on https://github.com/yt-dlp/yt-dlp/issues', null],
  ['[youtube] dQw4w9WgXcQ: No video formats found!', null],
  // YouTube rate-limiting the server opens like a removed video.
  ['[youtube] dQw4w9WgXcQ: Video unavailable. This content isn’t available, try again later. The current session has been rate-limited by YouTube for up to an hour. It is recommended to use `-t sleep` to add a delay between video requests to avoid exceeding the rate limit.', null],
  ['[youtube] dQw4w9WgXcQ: Video unavailable. This content isn\'t available, try again later.', null],
  // Everything else: no code.
  ['yt-dlp finished but no output file was found', null],
  ['ffmpeg exited with code 1: Conversion failed!', null],
  ['Unable to download webpage: <urlopen error [Errno 8] nodename nor servname provided, or not known>', null],
  ['', null],
];

describe('yt-dlp failureReason', () => {
  for (const [line, want] of CASES) {
    test(`${want === null ? 'null' : want} ← ${line.slice(0, 70) || '(empty)'}`, () => {
      assert.equal(ytdlp.failureReason(line), want);
    });
  }

  test('nothing at all reads as no reason', () => {
    assert.equal(ytdlp.failureReason(undefined), null);
    assert.equal(ytdlp.failureReason(null), null);
  });
});

// The line a failed download ended on: read for a reason only when it is an
// extractor's own refusal ("[youtube] <id>: …"). Every other line can carry
// the file name — the video's title — and a title is not a reason.
const LINES = [
  ['ERROR: [youtube] dQw4w9WgXcQ: Video unavailable. This video has been removed by the uploader', 'unavailable'],
  ['[youtube] dQw4w9WgXcQ: Private video. Sign in if you\'ve been granted access to this video', 'unavailable'],
  ['[youtube:tab] UCuAXFkgsw1L7xaCfnd5JJOw: Join this channel to get access to members-only content and other exclusive perks.', 'unavailable'],
  ['[youtube] dQw4w9WgXcQ: This live event will begin in 3 hours.', 'live'],
  ['[youtube] dQw4w9WgXcQ: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.', null],
  ['[youtube] dQw4w9WgXcQ: Video unavailable. This content isn’t available, try again later.', null],
  // Titles in paths: "No Copyright Music", "… Premieres in May", "Terminated".
  ['unable to write data: [Errno 28] No space left on device: \'/srv/stage/job-ytdl-x/No_Copyright_Music Premieres in May.webm.part\'', null],
  ['Unable to rename file: [Errno 2] No such file or directory: \'/srv/stage/job-ytdl-x/Terminated - Video unavailable.webm.part\'', null],
  ['[download] Got error: HTTP Error 403: Forbidden', null],
  ['Postprocessing: Conversion failed!', null],
  ['', null],
];

describe('yt-dlp errorLineReason', () => {
  for (const [line, want] of LINES) {
    test(`${want === null ? 'null' : want} ← ${line.slice(0, 70) || '(empty)'}`, () => {
      assert.equal(ytdlp.errorLineReason(line), want);
    });
  }

  test('nothing at all reads as no reason', () => {
    assert.equal(ytdlp.errorLineReason(undefined), null);
    assert.equal(ytdlp.errorLineReason(null), null);
  });
});
