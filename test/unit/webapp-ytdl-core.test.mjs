/**
 * webapp/alpha/ytdl-core.js — Add from YouTube's pure half, on node, with
 * the phone's own fixtures (mstream_music test/util/ytdl_*_test.dart):
 *
 * What is pinned:
 * - links: every LinkStates case — the first link in what was pasted, the
 *   short forms rewritten to a watch link, only `v` kept — and each URL
 *   sent is one the route takes and its sanitizeYoutubeUrl leaves as it is
 *   (so a job's `url` and a record's `origin` match it by string equality);
 * - the four title readers, value for value against the server's own
 *   (src/discovery-plugins/plugins/youtube.js), and the guess: tiers,
 *   fragments, putting them back, YouTube's artist and its strips, the
 *   year, the phone's deliberate differences; the card's reading of it
 *   (fields, chips, source line, the focused field's help line);
 * - the request body: only what the route's schema takes;
 * - where a song lands: the presets, Same as Discover's base folders, the
 *   bracket traps, the Custom layout's three errors and the engine's own,
 *   never-variables, the explorer window under the folder on screen
 *   (either path spelling), the new-folder walk, the Where window's radios
 *   and the remembered choice;
 * - formats from supportedAudioFiles; the file name held to the server's
 *   (src/util/yt-dlp.js fileNameFor) and "letters dropped" held to 95 names
 *   the real yt-dlp produced; the clash, ignoring case;
 * - failures: the phone's add / lookup / mkdir tables in the browser's
 *   error shapes, the new 409 and job reason codes (held to
 *   src/api/ytdl-jobs.js REASONS), and each failure's words and ways on;
 * - why Add is off, in the phone's order;
 * - i18n: every label is a key, every key is in KEYS, every key in KEYS is
 *   emitted by some case here, and the module's source names no key
 *   outside KEYS.
 *
 * webapp/ has no browser test harness and is eslint-ignored, so the module
 * is loaded as the CommonJS it is (createRequire), the way
 * webapp-discover-jobs.test.mjs loads discover-jobs.js.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import Joi from 'joi';
import * as youtube from '../../src/discovery-plugins/plugins/youtube.js';
import * as ytdlp from '../../src/util/yt-dlp.js';
import * as serverJobs from '../../src/api/ytdl-jobs.js';

const require = createRequire(import.meta.url);
const RAW = require('../../webapp/alpha/ytdl-core.js');
const J = require('../../webapp/alpha/discover-jobs.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = fs.readFileSync(path.join(ROOT, 'webapp/alpha/ytdl-core.js'), 'utf8').replace(/\r\n/g, '\n');

// Every label any call returns, for the i18n checks at the end.
const EMITTED = new Map();   // key → params seen
function collect(v, depth = 0) {
  if (!v || typeof v !== 'object' || depth > 6) { return; }
  if (Array.isArray(v)) { v.forEach((x) => collect(x, depth + 1)); return; }
  if (typeof v.key === 'string' && v.key.startsWith('ytdl.')) {
    if (!EMITTED.has(v.key)) { EMITTED.set(v.key, []); }
    EMITTED.get(v.key).push(v.params || null);
  }
  for (const k of Object.keys(v)) { collect(v[k], depth + 1); }
}
const Y = {};
for (const [name, value] of Object.entries(RAW)) {
  if (typeof value !== 'function') { Y[name] = value; continue; }
  Y[name] = (...args) => {
    const out = value(...args);
    if (out && typeof out.then === 'function') { return out.then((r) => { collect(r); return r; }); }
    collect(out);
    return out;
  };
}
// Constants that are labels themselves.
collect(RAW.FOLDER_SORTS);

// ── the server's URL rules, as src/api/ytdl.js has them (not exported) ────
// The route's host rule (youtubeUrlSchema) and sanitizeYoutubeUrl.
function serverTakesHost(url) {
  const host = new URL(url).hostname;
  return host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be';
}
function sanitize(url) {
  const parsed = new URL(url);
  const v = parsed.searchParams.get('v');
  if (!v) { throw new Error('Invalid YouTube URL - missing video ID'); }
  parsed.search = '';
  parsed.hash = '';
  parsed.searchParams.set('v', v);
  return parsed.toString();
}
// The POST's schema (src/api/ytdl.js), with the server's default formats.
const SERVER_FORMATS = ['mp3', 'flac', 'wav', 'ogg', 'aac', 'm4a', 'm4b', 'opus'];
const ADD_SCHEMA = Joi.object({
  directory: Joi.string().required(),
  url: Joi.string().uri({ scheme: ['http', 'https'] }).required().custom((value) => {
    if (!serverTakesHost(value)) { throw new Error('URL must be a YouTube link'); }
    return value;
  }),
  outputCodec: Joi.string().valid(...SERVER_FORMATS).default('mp3'),
  metadata: Joi.object({
    title: Joi.string().allow('').optional(),
    artist: Joi.string().allow('').optional(),
    album: Joi.string().allow('').optional(),
    year: Joi.string().allow('').optional(),
  }).optional().default({}),
});

function expectVideo(input, { url, id, shortForm = false, schemeAdded = false, live = false, inPlaylist = false }) {
  const link = Y.parseLink(input);
  assert.equal(link.kind, 'video', input);
  assert.equal(link.url, url, input);
  assert.equal(link.videoId, id, input);
  assert.equal(link.shortForm, shortForm, `${input} shortForm`);
  assert.equal(link.schemeAdded, schemeAdded, `${input} schemeAdded`);
  assert.equal(link.live, live, `${input} live`);
  assert.equal(link.inPlaylist, inPlaylist, `${input} inPlaylist`);
  assert.ok(serverTakesHost(url), `${url} passes the route`);
  assert.equal(sanitize(url), url, `${url} is what the server records`);
}

describe('links: what was pasted, and the one URL the server gets', () => {
  test('empty and whitespace are empty', () => {
    assert.equal(Y.parseLink('').kind, 'empty');
    assert.equal(Y.parseLink('   \n\t').kind, 'empty');
    assert.equal(Y.parseLink(null).kind, 'empty');
    assert.equal(Y.parseLink('').url, null);
    assert.equal(Y.parseLink('').shown, '');
  });

  test('LinkStates 1: another site is not a YouTube link', () => {
    const link = Y.parseLink('https://vimeo.com/76979871');
    assert.equal(link.kind, 'notYoutube');
    assert.equal(link.url, null);
    assert.equal(link.videoId, null);
    assert.equal(Y.parseLink('just some words').kind, 'notYoutube');
  });

  test('a look-alike host is not YouTube', () => {
    for (const input of [
      'https://notyoutube.com/watch?v=FGBhQbmPwH8',
      'https://youtube.com.evil.example/watch?v=FGBhQbmPwH8',
      'https://evil.example/youtube.com/watch?v=FGBhQbmPwH8',
      'https://youtube.co/watch?v=FGBhQbmPwH8',
      'me@youtube.com/watch?v=FGBhQbmPwH8',
    ]) {
      assert.equal(Y.parseLink(input).kind, 'notYoutube', input);
    }
  });

  test('a YouTube page that names no video is notYoutube', () => {
    for (const input of ['https://www.youtube.com/', 'https://www.youtube.com/@daftpunk', 'https://www.youtube.com/channel/UCx', 'https://youtu.be/', 'youtube.com']) {
      assert.equal(Y.parseLink(input).kind, 'notYoutube', input);
    }
  });

  test('a video id must be six or more of A–Z a–z 0–9 _ -', () => {
    assert.equal(Y.parseLink('https://www.youtube.com/watch?v=abc').kind, 'notYoutube');
    assert.equal(Y.parseLink('https://www.youtube.com/watch?v=FGBh%20QbmPwH8').kind, 'notYoutube');
    assert.equal(Y.parseLink('https://youtu.be/ab*cdef').kind, 'notYoutube');
    assert.equal(Y.parseLink('https://www.youtube.com/watch?v=').kind, 'notYoutube');
    assert.equal(Y.parseLink('https://youtube.com:99999/watch?v=FGBhQbmPwH8').kind, 'notYoutube', 'a port new URL refuses');
    expectVideo('https://www.youtube.com/watch?v=abc_-1', { url: 'https://www.youtube.com/watch?v=abc_-1', id: 'abc_-1' });
  });

  test('LinkStates 4: a playlist with no video is a playlist', () => {
    const link = Y.parseLink('https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG');
    assert.equal(link.kind, 'playlist');
    assert.equal(link.url, null);
    assert.equal(link.shown, '');
    assert.equal(Y.parseLink('https://www.youtube.com/watch?list=PLx0sYbCqOb8T').kind, 'playlist');
    assert.equal(Y.parseLink('https://music.youtube.com/playlist?list=OLAK5uy_k').kind, 'playlist');
    assert.equal(Y.parseLink('https://www.youtube.com/playlist').kind, 'notYoutube');
    // An embedded playlist: "videoseries" is not a video id.
    assert.equal(Y.parseLink('https://www.youtube.com/embed/videoseries?list=PLx0sYbCqOb8T').kind, 'playlist');
    assert.equal(Y.parseLink('https://www.youtube.com/embed/videoseries').kind, 'notYoutube');
  });

  test('a plain watch link goes as it is; music. and m. keep their host and lose si=', () => {
    expectVideo('https://www.youtube.com/watch?v=FGBhQbmPwH8', { url: 'https://www.youtube.com/watch?v=FGBhQbmPwH8', id: 'FGBhQbmPwH8' });
    expectVideo('https://music.youtube.com/watch?v=FGBhQbmPwH8&si=Rk3vT0', { url: 'https://music.youtube.com/watch?v=FGBhQbmPwH8', id: 'FGBhQbmPwH8' });
    expectVideo('https://m.youtube.com/watch?v=HyHNuVaZJ-k', { url: 'https://m.youtube.com/watch?v=HyHNuVaZJ-k', id: 'HyHNuVaZJ-k' });
  });

  test('http stays http; the host is lower-cased and a default port dropped, as new URL() does', () => {
    expectVideo('http://www.youtube.com/watch?v=FGBhQbmPwH8', { url: 'http://www.youtube.com/watch?v=FGBhQbmPwH8', id: 'FGBhQbmPwH8' });
    expectVideo('https://WWW.YouTube.com:443/watch?v=FGBhQbmPwH8&t=42s#frag', { url: 'https://www.youtube.com/watch?v=FGBhQbmPwH8', id: 'FGBhQbmPwH8' });
    expectVideo('http://youtube.com:80/watch?v=FGBhQbmPwH8', { url: 'http://youtube.com/watch?v=FGBhQbmPwH8', id: 'FGBhQbmPwH8' });
    expectVideo('https://youtube.com:8443/watch?v=FGBhQbmPwH8', { url: 'https://youtube.com:8443/watch?v=FGBhQbmPwH8', id: 'FGBhQbmPwH8' });
  });

  test('only v is kept, the first one, wherever it stands; /watch/ goes as /watch', () => {
    expectVideo('https://www.youtube.com/watch?feature=share&v=FGBhQbmPwH8&t=1', { url: 'https://www.youtube.com/watch?v=FGBhQbmPwH8', id: 'FGBhQbmPwH8' });
    expectVideo('https://www.youtube.com/watch?v=FGBhQbmPwH8&v=other12345', { url: 'https://www.youtube.com/watch?v=FGBhQbmPwH8', id: 'FGBhQbmPwH8' });
    expectVideo('https://www.youtube.com/watch/?v=HyHNuVaZJ-k', { url: 'https://www.youtube.com/watch?v=HyHNuVaZJ-k', id: 'HyHNuVaZJ-k' });
  });

  test('a watch link the server would take as typed comes out as the server makes it', () => {
    for (const input of [
      'https://www.youtube.com/watch?v=FGBhQbmPwH8',
      'https://music.youtube.com/watch?v=FGBhQbmPwH8&si=Rk3vT0',
      'http://www.youtube.com/watch?v=FGBhQbmPwH8',
      'http://youtube.com:80/watch?v=FGBhQbmPwH8',
      'https://youtube.com:8443/watch?v=FGBhQbmPwH8',
      'https://www.youtube.com/watch?feature=share&v=FGBhQbmPwH8&list=PL123',
      'https://www.youtube.com/watch?v=FGBhQbmPwH8&v=other12345',
      'https://m.youtube.com/watch?v=HyHNuVaZJ-k',
    ]) {
      assert.equal(Y.parseLink(input).url, sanitize(input), input);
    }
  });

  test('LinkStates 5: a video in a playlist is just the video', () => {
    expectVideo('https://www.youtube.com/watch?v=FGBhQbmPwH8&list=OLAK5uy_kVQ2', { url: 'https://www.youtube.com/watch?v=FGBhQbmPwH8', id: 'FGBhQbmPwH8', inPlaylist: true });
    expectVideo('https://youtu.be/FGBhQbmPwH8?list=OLAK5uy_kVQ2', { url: 'https://www.youtube.com/watch?v=FGBhQbmPwH8', id: 'FGBhQbmPwH8', shortForm: true, inPlaylist: true });
  });

  test('LinkStates 2: youtu.be/ID (si= and all) → www.youtube.com/watch?v=ID, http too', () => {
    expectVideo('https://youtu.be/FGBhQbmPwH8?si=Rk3vT0', { url: 'https://www.youtube.com/watch?v=FGBhQbmPwH8', id: 'FGBhQbmPwH8', shortForm: true });
    assert.equal(Y.parseLink('https://youtu.be/FGBhQbmPwH8?si=Rk3vT0').shown, 'youtube.com/watch?v=FGBhQbmPwH8');
    expectVideo('https://youtu.be/HyHNuVaZJ-k?si=a81Bq', { url: 'https://www.youtube.com/watch?v=HyHNuVaZJ-k', id: 'HyHNuVaZJ-k', shortForm: true });
    expectVideo('http://youtu.be/kN0gRuPpa01', { url: 'https://www.youtube.com/watch?v=kN0gRuPpa01', id: 'kN0gRuPpa01', shortForm: true });
  });

  test('/shorts/, /live/ (a live link), /embed/ and youtube-nocookie.com are rewritten', () => {
    expectVideo('https://www.youtube.com/shorts/FGBhQbmPwH8?feature=share', { url: 'https://www.youtube.com/watch?v=FGBhQbmPwH8', id: 'FGBhQbmPwH8', shortForm: true });
    expectVideo('https://m.youtube.com/shorts/FGBhQbmPwH8', { url: 'https://www.youtube.com/watch?v=FGBhQbmPwH8', id: 'FGBhQbmPwH8', shortForm: true });
    expectVideo('https://www.youtube.com/live/jfKfPfyJRdk', { url: 'https://www.youtube.com/watch?v=jfKfPfyJRdk', id: 'jfKfPfyJRdk', shortForm: true, live: true });
    expectVideo('https://www.youtube.com/live/jfKfPfyJRdk?si=x', { url: 'https://www.youtube.com/watch?v=jfKfPfyJRdk', id: 'jfKfPfyJRdk', shortForm: true, live: true });
    expectVideo('https://www.youtube.com/embed/FGBhQbmPwH8?start=10', { url: 'https://www.youtube.com/watch?v=FGBhQbmPwH8', id: 'FGBhQbmPwH8', shortForm: true });
    expectVideo('https://www.youtube-nocookie.com/embed/FGBhQbmPwH8', { url: 'https://www.youtube.com/watch?v=FGBhQbmPwH8', id: 'FGBhQbmPwH8', shortForm: true });
    assert.equal(serverTakesHost('https://www.youtube-nocookie.com/embed/x'), false, 'the server refuses the nocookie host, so the link must change');
  });

  test('LinkStates 3: typed without https → scheme added, host lower-cased', () => {
    expectVideo('YouTube.com/watch?v=FGBhQbmPwH8', { url: 'https://youtube.com/watch?v=FGBhQbmPwH8', id: 'FGBhQbmPwH8', schemeAdded: true });
    assert.equal(Y.parseLink('YouTube.com/watch?v=FGBhQbmPwH8').shown, 'youtube.com/watch?v=FGBhQbmPwH8');
    expectVideo('youtu.be/FGBhQbmPwH8', { url: 'https://www.youtube.com/watch?v=FGBhQbmPwH8', id: 'FGBhQbmPwH8', shortForm: true, schemeAdded: true });
    expectVideo('www.youtube.com/watch?v=FGBhQbmPwH8', { url: 'https://www.youtube.com/watch?v=FGBhQbmPwH8', id: 'FGBhQbmPwH8', schemeAdded: true });
  });

  test('a share message: the link is found, the full stop after it is not part of it', () => {
    expectVideo('Check this out https://youtu.be/HyHNuVaZJ-k?si=a81Bq. so good', { url: 'https://www.youtube.com/watch?v=HyHNuVaZJ-k', id: 'HyHNuVaZJ-k', shortForm: true });
    expectVideo('(https://www.youtube.com/watch?v=FGBhQbmPwH8)', { url: 'https://www.youtube.com/watch?v=FGBhQbmPwH8', id: 'FGBhQbmPwH8' });
    expectVideo('  https://youtu.be/FGBhQbmPwH8  \n', { url: 'https://www.youtube.com/watch?v=FGBhQbmPwH8', id: 'FGBhQbmPwH8', shortForm: true });
  });

  test('a link run straight into text or full-width punctuation ends where the text starts', () => {
    for (const text of ['https://youtu.be/FGBhQbmPwH8。', '看看https://youtu.be/FGBhQbmPwH8，很好听', '「https://youtu.be/FGBhQbmPwH8」', 'https://youtu.be/FGBhQbmPwH8”']) {
      expectVideo(text, { url: 'https://www.youtube.com/watch?v=FGBhQbmPwH8', id: 'FGBhQbmPwH8', shortForm: true });
    }
  });

  test('the first YouTube link wins, past a link to another site and a look-alike', () => {
    expectVideo('https://vimeo.com/1 then https://youtu.be/FGBhQbmPwH8 and https://youtu.be/HyHNuVaZJ-k', { url: 'https://www.youtube.com/watch?v=FGBhQbmPwH8', id: 'FGBhQbmPwH8', shortForm: true });
    expectVideo('notyoutube.com/watch?v=aaaaaaaa or youtu.be/FGBhQbmPwH8', { url: 'https://www.youtube.com/watch?v=FGBhQbmPwH8', id: 'FGBhQbmPwH8', shortForm: true, schemeAdded: true });
  });

  // What the phone's own parser (lib/util/ytdl_link.dart) answered for each,
  // run on the Dart VM on 2026-11-03 — a differential check that matched on
  // every case but the one marked: [input, kind, url, flags set].
  const PHONE_LINKS = [
    ['https://music.youtube.com/watch?v=FGBhQbmPwH8&feature=share', 'video', 'https://music.youtube.com/watch?v=FGBhQbmPwH8', []],
    ['music.youtube.com/watch?v=FGBhQbmPwH8', 'video', 'https://music.youtube.com/watch?v=FGBhQbmPwH8', ['schemeAdded']],
    ['http://music.youtube.com/watch?v=FGBhQbmPwH8', 'video', 'http://music.youtube.com/watch?v=FGBhQbmPwH8', []],
    ['gaming.youtube.com/watch?v=FGBhQbmPwH8', 'video', 'https://gaming.youtube.com/watch?v=FGBhQbmPwH8', ['schemeAdded']],
    ['https://m.youtube.com/watch?app=desktop&v=FGBhQbmPwH8', 'video', 'https://m.youtube.com/watch?v=FGBhQbmPwH8', []],
    ['https://youtu.be/FGBhQbmPwH8?t=42', 'video', 'https://www.youtube.com/watch?v=FGBhQbmPwH8', ['shortForm']],
    ['youtu.be/FGBhQbmPwH8?t=1m2s#x', 'video', 'https://www.youtube.com/watch?v=FGBhQbmPwH8', ['shortForm', 'schemeAdded']],
    ['https://www.youtu.be/FGBhQbmPwH8', 'video', 'https://www.youtube.com/watch?v=FGBhQbmPwH8', ['shortForm']],
    ['https://m.youtu.be/FGBhQbmPwH8', 'notYoutube', null, []],
    ['YOUTU.BE/FGBhQbmPwH8', 'video', 'https://www.youtube.com/watch?v=FGBhQbmPwH8', ['shortForm', 'schemeAdded']],
    ['https://youtu.be/FGBhQb', 'video', 'https://www.youtube.com/watch?v=FGBhQb', ['shortForm']],
    ['https://youtube.com/shorts/FGBhQbmPwH8?si=x', 'video', 'https://www.youtube.com/watch?v=FGBhQbmPwH8', ['shortForm']],
    ['https://www.youtube.com/shorts/FGBhQbmPwH8/extra', 'video', 'https://www.youtube.com/watch?v=FGBhQbmPwH8', ['shortForm']],
    ['https://youtube.com:8080/shorts/FGBhQbmPwH8', 'video', 'https://www.youtube.com/watch?v=FGBhQbmPwH8', ['shortForm']],
    ['https://www.youtube.com/shorts/', 'notYoutube', null, []],
    ['https://www.youtube.com/live/', 'notYoutube', null, []],
    ['https://www.youtube.com/embed/FGBhQbmPwH8?list=PLx', 'video', 'https://www.youtube.com/watch?v=FGBhQbmPwH8', ['shortForm', 'inPlaylist']],
    ['https://www.youtube-nocookie.com/watch?v=FGBhQbmPwH8', 'video', 'https://www.youtube.com/watch?v=FGBhQbmPwH8', ['shortForm']],
    // The one difference, on purpose: the phone reads this as a video whose
    // id is "videoseries" (its nocookie branch comes first).
    ['https://www.youtube-nocookie.com/embed/videoseries?list=PLx', 'playlist', null, []],
    ['https://www.youtube.com/playlist?list=', 'notYoutube', null, []],
    ['https://www.youtube.com/watch?list=PLx&v=FGBhQbmPwH8', 'video', 'https://www.youtube.com/watch?v=FGBhQbmPwH8', ['inPlaylist']],
    ['https://www.youtube.com/watch?v=&list=PLx', 'notYoutube', null, []],
    ['two: https://www.youtube.com/playlist?list=PLx and https://youtu.be/FGBhQbmPwH8', 'playlist', null, []],
    ['HTTPS://WWW.YOUTUBE.COM/watch?v=FGBhQbmPwH8', 'video', 'https://www.youtube.com/watch?v=FGBhQbmPwH8', []],
    ['https://www.YouTube.com/WATCH?v=FGBhQbmPwH8', 'notYoutube', null, []],
    ['https://www.youtube.com/watch?V=FGBhQbmPwH8', 'notYoutube', null, []],
    [' https://youtu.be/FGBhQbmPwH8 ', 'video', 'https://www.youtube.com/watch?v=FGBhQbmPwH8', ['shortForm']],
    ['youtube.com.evil.com/watch?v=FGBhQbmPwH8', 'notYoutube', null, []],
    ['https://youtube.comx/watch?v=FGBhQbmPwH8', 'notYoutube', null, []],
    ['https://youtube.com@evil.com/watch?v=FGBhQbmPwH8', 'notYoutube', null, []],
    ['https://user@youtube.com/watch?v=FGBhQbmPwH8', 'notYoutube', null, []],
    ['https://www.youtube.com./watch?v=FGBhQbmPwH8', 'notYoutube', null, []],
    ['foo@youtu.be/FGBhQbmPwH8', 'notYoutube', null, []],
    ['_youtu.be/FGBhQbmPwH8', 'notYoutube', null, []],
    ['ftp://youtube.com/watch?v=FGBhQbmPwH8', 'notYoutube', null, []],
    ['//youtube.com/watch?v=FGBhQbmPwH8', 'notYoutube', null, []],
    // A YouTube link inside another link's query is still the link.
    ['https://evil.com/?u=youtube.com/watch?v=FGBhQbmPwH8', 'video', 'https://youtube.com/watch?v=FGBhQbmPwH8', ['schemeAdded']],
    ['https:youtube.com/watch?v=FGBhQbmPwH8', 'video', 'https://youtube.com/watch?v=FGBhQbmPwH8', ['schemeAdded']],
    ['日本youtu.be/FGBhQbmPwH8', 'video', 'https://www.youtube.com/watch?v=FGBhQbmPwH8', ['shortForm', 'schemeAdded']],
    ['https://youtu.be/FGBhQbmPwH8…', 'video', 'https://www.youtube.com/watch?v=FGBhQbmPwH8', ['shortForm']],
    ['https://www.youtube.com:0443/watch?v=FGBhQbmPwH8', 'video', 'https://www.youtube.com/watch?v=FGBhQbmPwH8', []],
    ['https://www.youtube.com/watch?v=FGBh%51bmPwH8', 'video', 'https://www.youtube.com/watch?v=FGBhQbmPwH8', []],
    ['https://www.youtube.com/watch#v=FGBhQbmPwH8', 'notYoutube', null, []],
    ['https://www.youtube.com/watch?v=FGBhQbmPwH8+extra', 'notYoutube', null, []],
    ["https://www.youtube.com/watch?v=FGBhQbmPwH8'", 'video', 'https://www.youtube.com/watch?v=FGBhQbmPwH8', []],
    ['[link](https://www.youtube.com/watch?v=FGBhQbmPwH8)', 'video', 'https://www.youtube.com/watch?v=FGBhQbmPwH8', []],
    ['https://www.youtube.com/watch?v=FGBhQbmPwH8&amp;list=x', 'video', 'https://www.youtube.com/watch?v=FGBhQbmPwH8', []],
    ['https://www.youtube.com/foo/../watch?v=FGBhQbmPwH8', 'video', 'https://www.youtube.com/watch?v=FGBhQbmPwH8', []],
    ['https://www.youtube.com//watch?v=FGBhQbmPwH8', 'video', 'https://www.youtube.com/watch?v=FGBhQbmPwH8', []],
    ['https://www.youtube.com/watch/FGBhQbmPwH8', 'notYoutube', null, []],
    ['https://www.youtube.com/v/FGBhQbmPwH8', 'notYoutube', null, []],
    ['https://youtube.com/?v=FGBhQbmPwH8', 'notYoutube', null, []],
  ];

  test("adversarial links read as the phone's parser reads them", () => {
    const FLAGS = ['shortForm', 'schemeAdded', 'live', 'inPlaylist'];
    for (const [input, kind, url, flags] of PHONE_LINKS) {
      const link = Y.parseLink(input);
      assert.equal(link.kind, kind, input);
      assert.equal(link.url, url, input);
      assert.deepEqual(FLAGS.filter((k) => link[k]), flags, input);
      if (url) {
        assert.ok(serverTakesHost(url), `${url} passes the route`);
        assert.equal(sanitize(url), url, `${url} is what the server records`);
      }
    }
    assert.equal(Y.parseLink('https://www.youtube-nocookie.com/embed/videoseries').kind, 'notYoutube');
  });

  test('shown, for a helper line: host minus www., no scheme', () => {
    assert.equal(Y.parseLink('https://www.youtube.com/watch?v=FGBhQbmPwH8').shown, 'youtube.com/watch?v=FGBhQbmPwH8');
    assert.equal(Y.parseLink('https://music.youtube.com/watch?v=FGBhQbmPwH8').shown, 'music.youtube.com/watch?v=FGBhQbmPwH8');
    assert.equal(Y.parseLink('https://youtube.com:8443/watch?v=FGBhQbmPwH8').shown, 'youtube.com:8443/watch?v=FGBhQbmPwH8');
    assert.equal(Y.parseLink('https://www.youtube.com/live/jfKfPfyJRdk').shown, 'youtube.com/watch?v=jfKfPfyJRdk');
    assert.equal(Y.parseLink('https://vimeo.com/76979871').shown, '');
  });

  test('the parser has no lookbehind: an older Safari would refuse to load the module', () => {
    assert.doesNotMatch(SRC.replace(/\/\/[^\n]*/g, ''), /\(\?<[!=]/);
  });

  test('the lines under the field: a refusal, the playlist note, the live warning (link or lookup)', () => {
    const keys = (notes) => notes.map((n) => `${n.tone}:${n.label.key}`);
    assert.deepEqual(keys(Y.linkNotes(Y.parseLink('https://vimeo.com/1'))), ['err:ytdl.link.notYoutube']);
    assert.deepEqual(keys(Y.linkNotes(Y.parseLink('https://www.youtube.com/playlist?list=PLx'))), ['err:ytdl.link.playlist']);
    assert.deepEqual(keys(Y.linkNotes(Y.parseLink(''))), []);
    assert.deepEqual(keys(Y.linkNotes(Y.parseLink('https://youtu.be/FGBhQbmPwH8'))), [], 'a rewritten link is just sent');
    assert.deepEqual(keys(Y.linkNotes(Y.parseLink('https://youtu.be/FGBhQbmPwH8?list=PLx'))), ['note:ytdl.link.inPlaylist']);
    assert.deepEqual(keys(Y.linkNotes(Y.parseLink('https://www.youtube.com/live/jfKfPfyJRdk?list=PLx'))), ['note:ytdl.link.inPlaylist', 'warn:ytdl.link.live']);
    const watch = Y.parseLink('https://www.youtube.com/watch?v=jfKfPfyJRdk');
    for (const meta of [{ isLive: true }, { liveStatus: 'is_live' }, { liveStatus: 'is_upcoming' }, { liveStatus: 'post_live' }]) {
      assert.deepEqual(keys(Y.linkNotes(watch, meta)), ['warn:ytdl.link.live'], JSON.stringify(meta));
      assert.equal(Y.isLiveMeta(meta), youtube.isLiveEntry(meta), 'the server reads a stream the same way');
    }
    assert.deepEqual(keys(Y.linkNotes(watch, { isLive: false, liveStatus: 'was_live' })), []);
    assert.equal(Y.isLiveMeta({ liveStatus: 'was_live' }), youtube.isLiveEntry({ liveStatus: 'was_live' }));
  });
});

describe('the lookup answer', () => {
  test('readMetadata: empty strings are null, the year its digits, the new fields typed', () => {
    assert.deepEqual(Y.readMetadata({ title: 'One More Time', artist: 'Daft Punk', album: '', year: 2001, thumbnail: 'https://i.ytimg.com/x.jpg', fileStem: 'One_More_Time', isLive: false, liveStatus: 'not_live', durationSec: 321, channel: 'Daft Punk' }), {
      title: 'One More Time', artist: 'Daft Punk', album: null, year: '2001', thumbnail: 'https://i.ytimg.com/x.jpg', fileStem: 'One_More_Time',
      isLive: false, liveStatus: 'not_live', durationSec: 321, channel: 'Daft Punk',
    });
    assert.equal(Y.readMetadata({ year: '2001' }).year, '2001');
    assert.equal(Y.readMetadata({ year: 2001.5 }).year, null);
    assert.equal(Y.readMetadata({ year: '' }).year, null);
    assert.deepEqual(Y.readMetadata(null), {
      title: null, artist: null, album: null, year: null, thumbnail: null, fileStem: null, isLive: false, liveStatus: null, durationSec: null, channel: null,
    });
  });

  test('the server\'s answer (yt-dlp.js metadataOf) reads back field for field', () => {
    const probed = { title: 'Кино – Группа крови', artist: 'Kino', album: null, year: '1988', thumbnail: 'https://i.ytimg.com/k.jpg', fileStem: '_', isLive: false, liveStatus: 'not_live', durationSec: 287, channel: 'Kino Official', bytes: 1 };
    const answer = JSON.parse(JSON.stringify(ytdlp.metadataOf(probed)));
    const read = Y.readMetadata(answer);
    for (const k of Object.keys(answer)) { assert.ok(k in read, `readMetadata keeps ${k}`); }
    assert.deepEqual(read, { ...answer, album: null });
  });
});

// What the server's own code made of each title: cleanTitle, then
// splitArtistTitle of that, isTopicChannel and channelArtist of the title.
const SERVER_ANSWERS = [
  ['Gorillaz - Feel Good Inc. (Official Video) [HD]', 'Gorillaz - Feel Good Inc.', ['Gorillaz', 'Feel Good Inc.'], false, 'Gorillaz - Feel Good Inc. (Official Video) [HD]'],
  ['Sweater Weather (Official Video)', 'Sweater Weather', null, false, 'Sweater Weather (Official Video)'],
  ['Кино – Группа крови', 'Кино – Группа крови', ['Кино', 'Группа крови'], false, 'Кино – Группа крови'],
  ['Daft Punk - Around the World (Official Audio)', 'Daft Punk - Around the World', ['Daft Punk', 'Around the World'], false, 'Daft Punk - Around the World (Official Audio)'],
  ['Song (Official Video (HD))', 'Song )', null, false, 'Song (Official Video (HD))'],
  ['Song (Official Video]', 'Song', null, false, 'Song (Official Video]'],
  ['Song [Lyrics] (Live)', 'Song (Live)', null, false, 'Song [Lyrics] (Live)'],
  ['Song - Official HD Music Video', 'Song', null, false, 'Song - Official HD Music Video'],
  ['Song : Audio Only', 'Song', null, false, 'Song : Audio Only'],
  ['Song — visualiser', 'Song', null, false, 'Song — visualiser'],
  ['Song (Full Song)', 'Song', null, false, 'Song (Full Song)'],
  ['Song [4K Remastered]', 'Song', null, false, 'Song [4K Remastered]'],
  ['Artist: Song Name', 'Artist: Song Name', null, false, 'Artist: Song Name'],
  ['A - B - C', 'A - B - C', ['A', 'B - C'], false, 'A - B - C'],
  ['Artist -Song', 'Artist -Song', null, false, 'Artist -Song'],
  ['  Spaced   -   Out  (Audio)  ', 'Spaced - Out', ['Spaced', 'Out'], false, 'Spaced   -   Out  (Audio)'],
  ['Neon Harbor - Topic', 'Neon Harbor - Topic', ['Neon Harbor', 'Topic'], true, 'Neon Harbor'],
  ['Neon Harbor-Topic', 'Neon Harbor-Topic', null, true, 'Neon Harbor'],
  ['Neon Harbor - topic ', 'Neon Harbor - topic', ['Neon Harbor', 'topic'], true, 'Neon Harbor - topic'],
  ['- Topic', '- Topic', null, true, null],
  ['Song\u0085(Official Audio)', 'Song\u0085', null, false, 'Song\u0085(Official Audio)'],
  ['Videogame (Lyric)', 'Videogame', null, false, 'Videogame (Lyric)'],
  ['Song (Explicit)', 'Song', null, false, 'Song (Explicit)'],
  ['Song (Clean)', 'Song', null, false, 'Song (Clean)'],
  ['Song (Official Live Video)', 'Song', null, false, 'Song (Official Live Video)'],
  ['Song (Live)', 'Song (Live)', null, false, 'Song (Live)'],
  ['【MV】米津玄師 - Lemon', '【MV】米津玄師 - Lemon', ['【MV】米津玄師', 'Lemon'], false, '【MV】米津玄師 - Lemon'],
  ['Song (MV)', 'Song (MV)', null, false, 'Song (MV)'],
  ['Artist - Song ft. Other (Official Video)', 'Artist - Song ft. Other', ['Artist', 'Song ft. Other'], false, 'Artist - Song ft. Other (Official Video)'],
  ['Song (Official Video) - Lyrics', 'Song', null, false, 'Song (Official Video) - Lyrics'],
  ['Song | HD Video', 'Song', null, false, 'Song | HD Video'],
  ['Song (HQ Audio) [1080p]', 'Song', null, false, 'Song (HQ Audio) [1080p]'],
];
// Titles the phone (and so the web) reads differently on purpose:
// (Official Live Video) keeps "(Live)" and [4K Remastered] "[Remastered]",
// 【MV】 and (MV) are noise, "ft." becomes "(feat. …)".
const PHONE_DIFFERS = new Set(['Song (Official Live Video)', 'Song [4K Remastered]', '【MV】米津玄師 - Lemon', 'Song (MV)', 'Artist - Song ft. Other (Official Video)']);
const splitPair = (s) => (s == null ? null : [s.artist, s.title]);
const all = (g) => g.fragments.map((_, i) => i);

describe("the title readers are the server's", () => {
  test('value for value against src/discovery-plugins/plugins/youtube.js, and the phone\'s table', () => {
    for (const [title, cleaned, split, topic, artist] of SERVER_ANSWERS) {
      assert.equal(Y.cleanTitle(title), cleaned, title);
      assert.equal(Y.cleanTitle(title), youtube.cleanTitle(title), `cleanTitle ${title}`);
      assert.deepEqual(splitPair(Y.splitArtistTitle(cleaned)), split, title);
      assert.deepEqual(Y.splitArtistTitle(cleaned), youtube.splitArtistTitle(cleaned), `splitArtistTitle ${title}`);
      assert.equal(Y.isTopicChannel(title), topic, title);
      assert.equal(Y.isTopicChannel(title), youtube.isTopicChannel(title), `isTopicChannel ${title}`);
      assert.equal(Y.channelArtist(title), artist, title);
      assert.equal(Y.channelArtist(title), youtube.channelArtist(title), `channelArtist ${title}`);
    }
  });

  test("the server's own test values, and blanks read as String(x || '') does", () => {
    for (const raw of ['Neon Harbor - Salt & Static (Official Audio)', 'Salt & Static [Official Music Video] (HD)', 'Salt & Static | Official Lyric Video',
      'Salt & Static - Lyrics', 'Salt & Static (2019 Remaster)', null, undefined, '', 0, false, 42]) {
      assert.equal(Y.cleanTitle(raw), youtube.cleanTitle(raw), String(raw));
      assert.deepEqual(Y.splitArtistTitle(raw), youtube.splitArtistTitle(raw), String(raw));
      assert.equal(Y.isTopicChannel(raw), youtube.isTopicChannel(raw), String(raw));
      assert.equal(Y.channelArtist(raw), youtube.channelArtist(raw), String(raw));
    }
    assert.equal(Y.cleanTitle('Salt & Static (2019 Remaster)'), 'Salt & Static (2019 Remaster)', "remaster is the scorer's business, not noise");
    assert.deepEqual(Y.splitArtistTitle('Neon Harbor – Salt & Static'), { artist: 'Neon Harbor', title: 'Salt & Static' });
    assert.equal(Y.channelArtist(''), null);
  });

  test("the guess cleans and splits as the server does where it makes no change of its own", () => {
    for (const [title, cleaned, split] of SERVER_ANSWERS) {
      if (PHONE_DIFFERS.has(title)) { continue; }
      const g = Y.guess({ title, artist: 'Uploader' });
      if (split == null) {
        assert.equal(g.tier, 'youtubeArtist', title);
        assert.equal(g.title, cleaned, title);
      } else {
        assert.equal(g.tier, 'split', title);
        assert.deepEqual([g.artist, g.title], split, title);
      }
    }
  });
});

describe('the guess', () => {
  // What the phone's own guess (lib/util/ytdl_guess.dart ytdlGuess) answered,
  // run on the Dart VM on 2026-11-03 — a differential check over 3,660
  // answers (and every put-back subset of each) that matched on all:
  // [title, artist, tier, title out, artist out, fragments, artistStrip].
  const PHONE_GUESSES = [
    ['Artist - Title (Official Video) [HD]', 'ArtistVEVO', 'split', 'Title', 'Artist', ['-', '(Official Video)', '[HD]'], 'VEVO'],
    ['AC/DC - Thunderstruck (Official Video)', 'acdcVEVO', 'split', 'Thunderstruck', 'AC/DC', ['-', '(Official Video)'], 'VEVO'],
    ['Кино - Группа крови (Official Audio)', 'Кино - Topic', 'split', 'Группа крови', 'Кино', ['-', '(Official Audio)'], '- Topic'],
    ['Song', 'Daft Punk - Topic', 'youtubeArtist', 'Song', 'Daft Punk', [], '- Topic'],
    ['Song', 'Gorillaz - Official', 'youtubeArtist', 'Song', 'Gorillaz', [], 'Official'],
    ['Song', 'Official髭男dism', 'youtubeArtist', 'Song', 'Official髭男dism', [], null],
    ['Song', 'VEVO', 'youtubeArtist', 'Song', 'VEVO', [], null],
    ['Song', '- Topic', 'youtubeArtist', 'Song', '- Topic', [], null],
    ['Artist - Title ft. Someone (Official Video)', null, 'split', 'Title (feat. Someone)', 'Artist', ['-', '(Official Video)'], null],
    ['Artist feat. Other - Title', null, 'split', 'Title', 'Artist feat. Other', ['-'], null],
    ['Artist - Title (feat. Other) [Official Video]', null, 'split', 'Title (feat. Other)', 'Artist', ['-', '[Official Video]'], null],
    ['Artist - Title featuring A & B', null, 'split', 'Title (feat. A & B)', 'Artist', ['-'], null],
    ['Artist - 6 ft under', null, 'split', '6 ft under', 'Artist', ['-'], null],
    ['Artist - A Feat of Strength', null, 'split', 'A Feat of Strength', 'Artist', ['-'], null],
    ['Artist - Title | Official Lyric Video', null, 'split', 'Title', 'Artist', ['-', '| Official Lyric Video'], null],
    ['Artist — Title (Live at Wembley) [Official Video]', null, 'split', 'Title (Live at Wembley)', 'Artist', ['—', '[Official Video]'], null],
    ['Artist - Title (Remix) [Official Audio]', null, 'split', 'Title (Remix)', 'Artist', ['-', '[Official Audio]'], null],
    ['Artist - Title (Official Remix Video)', null, 'split', 'Title (Remix)', 'Artist', ['-', '(Official Remix Video)'], null],
    ['Artist - Title (Official Video · Live)', null, 'split', 'Title (Live)', 'Artist', ['-', '(Official Video · Live)'], null],
    ['Artist - Title (Live | Official Video)', null, 'split', 'Title (Live)', 'Artist', ['-', '(Live | Official Video)'], null],
    ['Artist - Title [Official Video] (Remastered 2009)', null, 'split', 'Title (Remastered 2009)', 'Artist', ['-', '[Official Video]'], null],
    ['a-ha - Take On Me (Official Video) [Remastered in 4K]', 'a-ha', 'split', 'Take On Me [Remastered in]', 'a-ha', ['-', '(Official Video)', '[Remastered in 4K]'], null],
    ['Artist - Title (Clean Version)', null, 'split', 'Title', 'Artist', ['-', '(Clean Version)'], null],
    ['Artist - Title (Acoustic Version) (Official Video)', null, 'split', 'Title (Acoustic Version)', 'Artist', ['-', '(Official Video)'], null],
    ['Artist - Title 【Official Music Video】', null, 'split', 'Title', 'Artist', ['-', '【Official Music Video】'], null],
    ['【MV】Artist - Title', null, 'split', 'Title', 'Artist', ['【MV】', '-'], null],
    ['Artist - Title M/V', null, 'split', 'Title M/V', 'Artist', ['-'], null],
    ['Artist「Title」MV', null, 'youtubeArtist', 'Artist「Title」MV', '', [], null],
    ['米津玄師 MV「Lemon」', 'Kenshi Yonezu 米津玄師', 'youtubeArtist', '米津玄師 MV「Lemon」', 'Kenshi Yonezu 米津玄師', [], null],
    ['YOASOBI「夜に駆ける」Official Music Video', 'Ayase / YOASOBI', 'youtubeArtist', 'YOASOBI「夜に駆ける」Official Music Video', 'Ayase / YOASOBI', [], null],
    ["BTS (방탄소년단) 'Dynamite' Official MV", 'HYBE LABELS', 'youtubeArtist', "BTS (방탄소년단) 'Dynamite' Official MV", 'HYBE LABELS', [], null],
    ['周杰倫 Jay Chou【告白氣球 Love Confession】Official MV', '周杰倫 Jay Chou', 'youtubeArtist', '周杰倫 Jay Chou【告白氣球 Love Confession】Official MV', '周杰倫 Jay Chou', [], null],
    ['Björk : Army of Me', null, 'split', 'Army of Me', 'Björk', [':'], null],
    ['Artist - Title', null, 'split', 'Title', 'Artist', ['-'], null],
    ['A'.repeat(81) + ' - Title', null, 'youtubeArtist', 'A'.repeat(81) + ' - Title', '', [], null],
    ['Title ((Official Video))', null, 'youtubeArtist', 'Title )', '', ['((Official Video)'], null],
    ['(Official Video)', 'Uploader', 'youtubeArtist', '', 'Uploader', ['(Official Video)'], null],
    ['   ', 'Uploader', 'youtubeArtist', '', 'Uploader', [], null],
    ['', '', 'none', '', '', [], null],
    [null, null, 'none', '', '', [], null],
  ];

  test("adversarial titles and artists read as the phone's guess reads them", () => {
    for (const [title, artist, tier, outTitle, outArtist, fragments, strip] of PHONE_GUESSES) {
      const g = Y.guess({ title, artist });
      const at = `${title} / ${artist}`;
      assert.equal(g.tier, tier, at);
      assert.equal(g.title, outTitle, at);
      assert.equal(g.artist, outArtist, at);
      assert.deepEqual(g.fragments.map((f) => f.text), fragments, at);
      assert.equal(g.artistStrip, strip, at);
      assert.equal(Y.titleWith(g, all(g)), (title || '').replace(/\s+/g, ' ').trim(), `${at}: Undo all is the raw title`);
    }
  });

  test('music tier: "One More Time", tags as given, nothing to clean', () => {
    const g = Y.guess({ title: 'One More Time', artist: 'Daft Punk', album: 'Discovery', year: 2001 });
    assert.equal(g.tier, 'music');
    assert.deepEqual([g.title, g.artist, g.album, g.year], ['One More Time', 'Daft Punk', 'Discovery', '2001']);
    assert.deepEqual(g.fragments, []);
    assert.equal(g.cleaned, false);
    assert.equal(g.rawTitle, 'One More Time');
    assert.equal(g.youtubeArtistRaw, 'Daft Punk');
    assert.equal(g.youtubeArtist, 'Daft Punk');
    assert.equal(g.artistStrip, null);
    assert.equal(g.artistAgrees, false);
    assert.equal(Y.titleWith(g, []), 'One More Time');
    assert.equal(Y.artistWith(g, []), 'Daft Punk');
  });

  test('a music track never splits, and its title is still cleaned', () => {
    const g = Y.guess({ title: 'Daft Punk - One More Time (Official Audio)', artist: 'Daft Punk', album: 'Discovery' });
    assert.equal(g.tier, 'music');
    assert.equal(g.title, 'Daft Punk - One More Time');
    assert.equal(g.artist, 'Daft Punk');
    assert.deepEqual(g.fragments, [{ text: '(Official Audio)', kind: 'noise' }]);
  });

  test('split tier: "Gorillaz - Feel Good Inc. (Official Video) [HD]" (FoundCleaned)', () => {
    const g = Y.guess({ title: 'Gorillaz - Feel Good Inc. (Official Video) [HD]', artist: 'Gorillaz' });
    assert.equal(g.tier, 'split');
    assert.deepEqual([g.title, g.artist, g.album, g.year], ['Feel Good Inc.', 'Gorillaz', '', '']);
    assert.equal(g.artistAgrees, true, 'matches the artist YouTube lists');
    assert.equal(g.cleaned, true);
    assert.deepEqual(g.fragments, [{ text: '-', kind: 'split' }, { text: '(Official Video)', kind: 'noise' }, { text: '[HD]', kind: 'noise' }]);
  });

  test('"Кино – Группа крови": the en dash splits, the separator is the chip', () => {
    const g = Y.guess({ title: 'Кино – Группа крови', artist: 'Кино' });
    assert.equal(g.tier, 'split');
    assert.equal(g.artist, 'Кино');
    assert.equal(g.title, 'Группа крови');
    assert.deepEqual(g.fragments, [{ text: '–', kind: 'split' }]);
    assert.equal(g.artistAgrees, true);
  });

  test('"matches the artist YouTube lists" ignores case, needs an artist, compares the stripped one', () => {
    assert.equal(Y.guess({ title: 'GORILLAZ - Feel Good Inc.', artist: 'gorillaz' }).artistAgrees, true);
    assert.equal(Y.guess({ title: 'Gorillaz - Feel Good Inc.', artist: 'Some Uploader' }).artistAgrees, false);
    assert.equal(Y.guess({ title: 'Gorillaz - Feel Good Inc.' }).artistAgrees, false);
    assert.equal(Y.guess({ title: 'Gorillaz - Feel Good Inc.', artist: 'GorillazVEVO' }).artistAgrees, true);
  });

  test('several artists stay one string; a spaced colon splits, an unspaced dash does not', () => {
    const g = Y.guess({ title: 'Daft Punk, Pharrell Williams - Get Lucky', artist: 'Daft Punk' });
    assert.equal(g.artist, 'Daft Punk, Pharrell Williams');
    assert.equal(g.title, 'Get Lucky');
    assert.equal(Y.guess({ title: "Lily Allen & Giggs - Something's Not Right" }).artist, 'Lily Allen & Giggs');
    assert.equal(Y.guess({ title: 'Björk : Army of Me' }).artist, 'Björk');
    assert.equal(Y.guess({ title: 'Artist -Song' }).tier, 'youtubeArtist');
  });

  test('YouTube-artist tier: "Sweater Weather (Official Video)" by "TheNeighbourhoodVEVO" (ChannelGuess)', () => {
    const g = Y.guess({ title: 'Sweater Weather (Official Video)', artist: 'TheNeighbourhoodVEVO' });
    assert.equal(g.tier, 'youtubeArtist');
    assert.equal(g.title, 'Sweater Weather');
    assert.equal(g.artist, 'TheNeighbourhood');
    assert.equal(g.youtubeArtistRaw, 'TheNeighbourhoodVEVO');
    assert.equal(g.youtubeArtist, 'TheNeighbourhood');
    assert.equal(g.artistStrip, 'VEVO');
    assert.deepEqual(g.fragments, [{ text: '(Official Video)', kind: 'noise' }]);
    assert.equal(g.artistAgrees, false);
  });

  test('"X - Topic" loses " - Topic"; a trailing VEVO or word Official goes, a leading Official never', () => {
    for (const raw of ['Daft Punk - Topic', 'Daft Punk-Topic', 'Daft Punk -  topic']) {
      const g = Y.guess({ title: 'One More Time', artist: raw });
      assert.equal(g.artist, 'Daft Punk', raw);
      assert.equal(g.artistStrip, '- Topic', raw);
    }
    assert.equal(Y.guess({ title: 'Song', artist: 'Taylor Swift VEVO' }).artist, 'Taylor Swift');
    assert.equal(Y.guess({ title: 'Song', artist: 'TaylorSwiftVevo' }).artist, 'TaylorSwift');
    assert.equal(Y.guess({ title: 'Song', artist: 'VEVO' }).artistStrip, null, 'nothing would be left');
    const g = Y.guess({ title: 'Pretender', artist: 'Official髭男dism' });
    assert.equal(g.artist, 'Official髭男dism');
    assert.equal(g.artistStrip, null);
    const h = Y.guess({ title: 'Song', artist: 'Daft Punk Official' });
    assert.equal(h.artist, 'Daft Punk');
    assert.equal(h.artistStrip, 'Official');
    assert.equal(Y.guess({ title: 'Song', artist: 'BLACKPINK - Official' }).artist, 'BLACKPINK');
    assert.equal(Y.guess({ title: 'Song', artist: 'Unofficial' }).artistStrip, null);
    assert.equal(Y.guess({ title: 'Song', artist: 'Official' }).artist, 'Official');
  });

  test('no artist at all is still the YouTube-artist tier, with the artist empty', () => {
    const g = Y.guess({ title: 'Sweater Weather (Official Video)' });
    assert.equal(g.tier, 'youtubeArtist');
    assert.equal(g.artist, '');
    assert.equal(g.youtubeArtistRaw, '');
  });

  test('no lookup: GUESS_NONE is empty, and an empty answer is it', () => {
    const g = Y.GUESS_NONE;
    assert.equal(g.tier, 'none');
    for (const v of [g.rawTitle, g.title, g.artist, g.album, g.year, g.youtubeArtist]) { assert.equal(v, ''); }
    assert.deepEqual(g.fragments, []);
    assert.equal(g.cleaned, false);
    assert.equal(Y.titleWith(g, [0]), '');
    assert.equal(Y.artistWith(g, [0]), '');
    assert.equal(Y.guess(), Y.GUESS_NONE);
    assert.equal(Y.guess({ title: '  ', artist: '', album: null }).tier, 'none');
    assert.equal(Y.guess({ year: 2001 }).year, '2001');
    assert.equal(Y.guess({ year: 2001 }).tier, 'none');
  });

  test('the year: four digits or nothing', () => {
    assert.equal(Y.guess({ title: 'x', album: 'A', year: 2001 }).year, '2001');
    assert.equal(Y.guess({ title: 'x', album: 'A', year: '2001' }).year, '2001');
    assert.equal(Y.guess({ title: 'x', album: 'A', year: ' 2001 ' }).year, '2001');
    for (const y of [null, '', '01', '20011', '2001-03-12', 'MMI', 2001.5, 12, '٢٠٠١']) {
      assert.equal(Y.guess({ title: 'x', album: 'A', year: y }).year, '', String(y));
    }
  });

  test("the phone's own cleaning: keep words, Version alone goes, groups with no noise stay", () => {
    const g = Y.guess({ title: 'Sweater Weather (Official Live Video)', artist: 'X' });
    assert.equal(g.title, 'Sweater Weather (Live)');
    assert.deepEqual(g.fragments, [{ text: '(Official Live Video)', kind: 'noise' }]);
    assert.equal(Y.titleWith(g, [0]), 'Sweater Weather (Official Live Video)');
    assert.equal(Y.guess({ title: 'Song (Official Remix Video)' }).title, 'Song (Remix)');
    assert.equal(Y.guess({ title: 'Song (Remastered 2009 - Official Audio)' }).title, 'Song (Remastered 2009)');
    assert.equal(Y.guess({ title: 'Song [Live at Wembley | Official Music Video]' }).title, 'Song [Live at Wembley]');
    assert.equal(Y.guess({ title: 'Song (Extended Version) (Official Audio)' }).title, 'Song (Extended Version)');
    assert.equal(Y.guess({ title: 'Song (Live - Acoustic Version - Official Video)' }).title, 'Song (Live - Acoustic Version)');
    assert.equal(Y.guess({ title: 'Song [4K Remastered]' }).title, 'Song [Remastered]');
    const c = Y.guess({ title: 'Song (Clean Version)' });
    assert.equal(c.title, 'Song');
    assert.deepEqual(c.fragments, [{ text: '(Clean Version)', kind: 'noise' }]);
    assert.equal(Y.guess({ title: 'Song [Live]' }).title, 'Song [Live]');
    assert.equal(Y.guess({ title: 'Song [2011 Remaster]' }).title, 'Song [2011 Remaster]');
    assert.deepEqual(Y.guess({ title: 'Song [2011 Remaster]' }).fragments, []);
    assert.equal(Y.guess({ title: 'Song (Radio Edit)' }).title, 'Song (Radio Edit)');
  });

  test('【…】 groups follow the bracket rule, and MV is noise', () => {
    const g = Y.guess({ title: '【MV】米津玄師 - Lemon', artist: '米津玄師' });
    assert.equal(g.tier, 'split');
    assert.equal(g.artist, '米津玄師');
    assert.equal(g.title, 'Lemon');
    assert.deepEqual(g.fragments, [{ text: '【MV】', kind: 'noise' }, { text: '-', kind: 'split' }]);
    assert.equal(Y.guess({ title: 'Lemon【公式MV】' }).title, 'Lemon');
    assert.equal(Y.guess({ title: 'Lemon【初音ミク】' }).title, 'Lemon【初音ミク】');
    assert.equal(Y.guess({ title: 'Song (MV)' }).title, 'Song');
    assert.equal(Y.guess({ title: 'Song [M/V]' }).title, 'Song');
    assert.equal(Y.guess({ title: 'Song - Official MV' }).title, 'Song');
    assert.equal(Y.guess({ title: 'Mvula (Live)' }).title, 'Mvula (Live)', 'MV is a word');
  });

  test('a trailing "feat." / "ft." / "featuring" credit becomes "(feat. X)"; anywhere else it is left alone', () => {
    assert.equal(Y.guess({ title: 'Get Lucky feat. Pharrell Williams' }).title, 'Get Lucky (feat. Pharrell Williams)');
    assert.equal(Y.guess({ title: 'Get Lucky ft. Pharrell Williams' }).title, 'Get Lucky (feat. Pharrell Williams)');
    assert.equal(Y.guess({ title: 'Get Lucky Featuring Pharrell Williams, Nile Rodgers' }).title, 'Get Lucky (feat. Pharrell Williams, Nile Rodgers)');
    const g = Y.guess({ title: 'Daft Punk - Get Lucky ft. Pharrell Williams (Official Audio)', artist: 'Daft Punk' });
    assert.equal(g.artist, 'Daft Punk');
    assert.equal(g.title, 'Get Lucky (feat. Pharrell Williams)');
    assert.equal(Y.guess({ title: 'Get Lucky (feat. Pharrell)' }).title, 'Get Lucky (feat. Pharrell)');
    assert.equal(Y.guess({ title: 'Get Lucky feat. Pharrell (Radio Edit)' }).title, 'Get Lucky feat. Pharrell (Radio Edit)');
    const h = Y.guess({ title: 'Daft Punk ft. Pharrell - Get Lucky' });
    assert.equal(h.artist, 'Daft Punk ft. Pharrell');
    assert.equal(h.title, 'Get Lucky');
    assert.equal(Y.guess({ title: '6 ft under' }).title, '6 ft under', '"ft" needs its dot');
    assert.equal(Y.guess({ title: 'A Feat of Strength' }).title, 'A Feat of Strength', '"feat" needs its dot too');
    assert.equal(Y.guess({ title: 'Get Lucky feat Pharrell' }).title, 'Get Lucky feat Pharrell');
    assert.equal(Y.guess({ title: 'Feat. Nobody' }).title, 'Feat. Nobody');
  });

  test('putting fragments back: each in place, the split gives the artist back, Undo all is the raw title', () => {
    const gorillaz = Y.guess({ title: 'Gorillaz - Feel Good Inc. (Official Video) [HD]', artist: 'Gorillaz' });
    assert.equal(Y.titleWith(gorillaz, [1]), 'Feel Good Inc. (Official Video)');
    assert.equal(Y.titleWith(gorillaz, new Set([2])), 'Feel Good Inc. [HD]');
    assert.equal(Y.titleWith(gorillaz, [1, 2]), 'Feel Good Inc. (Official Video) [HD]');
    assert.equal(Y.titleWith(gorillaz, [0]), 'Gorillaz - Feel Good Inc.');
    assert.equal(Y.artistWith(gorillaz, [0]), 'Gorillaz');
    assert.equal(Y.artistWith(gorillaz, []), 'Gorillaz');
    const kino = Y.guess({ title: 'Кино – Группа крови', artist: 'Kino Official' });
    assert.equal(Y.artistWith(kino, []), 'Кино');
    assert.equal(Y.artistWith(kino, [0]), 'Kino', "YouTube's artist, stripped");
    assert.equal(Y.titleWith(kino, [0]), 'Кино – Группа крови');
    assert.equal(Y.titleWith(gorillaz, all(gorillaz)), 'Gorillaz - Feel Good Inc. (Official Video) [HD]');
    const feat = Y.guess({ title: 'Daft Punk - Get Lucky ft. Pharrell', artist: 'Daft Punk' });
    assert.equal(feat.title, 'Get Lucky (feat. Pharrell)');
    assert.equal(Y.titleWith(feat, all(feat)), 'Daft Punk - Get Lucky ft. Pharrell');
    const mv = Y.guess({ title: '【MV】米津玄師 - Lemon', artist: '米津玄師' });
    assert.equal(Y.artistWith(mv, [0]), '【MV】米津玄師', 'a fragment on the artist side goes back into the artist');
    assert.equal(Y.titleWith(mv, [0]), 'Lemon');
    assert.equal(Y.titleWith(mv, [1]), '米津玄師 - Lemon');
    assert.equal(Y.titleWith(gorillaz, [7]), 'Feel Good Inc.', 'indexes that are not fragments change nothing');
    assert.equal(Y.titleWith(Y.guess({ title: 'One More Time', album: 'Discovery' }), [0]), 'One More Time');
    assert.equal(Y.artistWith(Y.guess({ title: 'Sweater Weather (Official Video)', artist: 'TheNeighbourhoodVEVO' }), [0]), 'TheNeighbourhood');
  });

  test('a trailing "- Official Video" is one fragment, even around a removed group', () => {
    const g = Y.guess({ title: 'Song - Official Video (HD)' });
    assert.equal(g.title, 'Song');
    assert.deepEqual(g.fragments, [{ text: '- Official Video', kind: 'noise' }, { text: '(HD)', kind: 'noise' }]);
    assert.equal(Y.titleWith(g, [0]), 'Song - Official Video');
    assert.equal(Y.titleWith(g, [1]), 'Song (HD)');
    const h = Y.guess({ title: 'Song - (HD) Official Video' });
    assert.equal(h.title, 'Song');
    assert.equal(Y.titleWith(h, [1]), 'Song (HD)');
    assert.equal(Y.titleWith(h, all(h)), 'Song - (HD) Official Video');
  });

  test('two readings of the same answer are equal; a different answer is not; a guess is plain frozen data', () => {
    const read = () => Y.guess({ title: 'Gorillaz - Feel Good Inc. (Official Video) [HD]', artist: 'GorillazVEVO' });
    assert.ok(Y.sameGuess(read(), read()));
    assert.deepEqual(read(), read());
    assert.ok(!Y.sameGuess(read(), Y.guess({ title: 'Gorillaz - Feel Good Inc. (Official Video)', artist: 'GorillazVEVO' })));
    assert.ok(!Y.sameGuess(read(), Y.guess({ title: 'Gorillaz - Feel Good Inc. (Official Video) [HD]', artist: 'Gorillaz' })));
    assert.ok(Y.sameGuess(Y.guess(), Y.GUESS_NONE));
    assert.ok(Object.isFrozen(read()));
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(read()))).sort(), Object.keys(read()).sort(), 'the rebuild pieces stay out of sight');
  });
});

describe("the card's reading of a guess", () => {
  const gorillaz = Y.guess({ title: 'Gorillaz - Feel Good Inc. (Official Video) [HD]', artist: 'GorillazVEVO' });
  const vevo = Y.guess({ title: 'Sweater Weather (Official Video)', artist: 'TheNeighbourhoodVEVO' });
  const music = Y.guess({ title: 'One More Time', artist: 'Daft Punk', album: 'Discovery', year: 2001 });

  test('guessFields: restores, the strip and the swap', () => {
    assert.deepEqual(Y.guessFields(gorillaz), { title: 'Feel Good Inc.', artist: 'Gorillaz' });
    assert.deepEqual(Y.guessFields(gorillaz, { restored: [0] }), { title: 'Gorillaz - Feel Good Inc.', artist: 'Gorillaz' }, "the split undone: YouTube's artist");
    assert.deepEqual(Y.guessFields(gorillaz, { restored: [0], stripRestored: true }), { title: 'Gorillaz - Feel Good Inc.', artist: 'GorillazVEVO' });
    assert.deepEqual(Y.guessFields(gorillaz, { swapped: true }), { title: 'Gorillaz', artist: 'Feel Good Inc.' });
    assert.deepEqual(Y.guessFields(vevo, { stripRestored: true }), { title: 'Sweater Weather', artist: 'TheNeighbourhoodVEVO' });
    assert.deepEqual(Y.guessFields(music), { title: 'One More Time', artist: 'Daft Punk' });
    assert.deepEqual(Y.guessFields(Y.GUESS_NONE), { title: '', artist: '' });
  });

  test('guessView: the chips still out (noise first), Undo all, the swap, the strip, "Or YouTube\'s artist"', () => {
    const v = Y.guessView(gorillaz);
    assert.deepEqual(v.chips, [{ index: 1, kind: 'noise', text: '(Official Video)' }, { index: 2, kind: 'noise', text: '[HD]' }, { index: 0, kind: 'split', text: '-' }]);
    assert.equal(v.splitOut, true);
    assert.equal(v.canSwap, true);
    assert.equal(v.canUndoAll, true);
    assert.equal(v.cleaned, true);
    assert.equal(v.canRestoreStrip, false, 'the strip shows once the split is undone');
    assert.equal(v.orYoutubeArtist, null, 'the split agrees with YouTube');
    assert.deepEqual(Y.guessView(gorillaz, { swapped: true }).chips, [], 'none while swapped');
    const undone = Y.guessView(gorillaz, { restored: [0] });
    assert.equal(undone.canRestoreStrip, true);
    assert.equal(undone.canSwap, false);
    assert.equal(Y.guessView(gorillaz, { restored: [0] }, true).canRestoreStrip, false, 'not over an edited artist');
    const everything = Y.guessView(gorillaz, { restored: [0, 1, 2] });
    assert.equal(everything.canUndoAll, false);
    assert.equal(everything.cleaned, false);
    assert.equal(everything.noiseOut, false);
    const kino = Y.guessView(Y.guess({ title: 'Кино – Группа крови', artist: 'Kino Official' }));
    assert.equal(kino.cleaned, false, 'a split alone has its chip, not the cleaned line');
    assert.equal(kino.orYoutubeArtist, 'Kino');
    assert.equal(Y.guessView(Y.guess({ title: 'Кино – Группа крови', artist: 'Kino Official' }), {}, true).orYoutubeArtist, null);
    assert.equal(Y.guessView(vevo).canRestoreStrip, true);
    assert.equal(Y.guessView(vevo, { stripRestored: true }).canRestoreStrip, false);
    assert.deepEqual(Y.cleanedLabel(gorillaz), { key: 'ytdl.source.cleaned', params: { title: 'Gorillaz - Feel Good Inc. (Official Video) [HD]' } });
  });

  test('the source line: YouTube Music ✓, the video title while split, "check it" otherwise', () => {
    assert.deepEqual(Y.sourceLine(music), { tone: 'ok', label: { key: 'ytdl.source.ytMusic' } });
    // The phone's two split lines (ytdl_result_card.dart _source): "· matches
    // the artist YouTube lists" when YouTube's artist (stripped) agrees.
    assert.equal(gorillaz.artistAgrees, true);
    assert.deepEqual(Y.sourceLine(gorillaz), { tone: 'auto', label: { key: 'ytdl.source.videoTitleAgrees' } });
    assert.deepEqual(Y.sourceLine(gorillaz, { swapped: true }), { tone: 'auto', label: { key: 'ytdl.source.videoTitleAgrees' } }, 'swapping keeps the split');
    const kino = Y.guess({ title: 'Кино – Группа крови', artist: 'Kino Official' });
    assert.equal(kino.artistAgrees, false);
    assert.deepEqual(Y.sourceLine(kino), { tone: 'auto', label: { key: 'ytdl.source.videoTitle' } });
    assert.deepEqual(Y.sourceLine(Y.guess({ title: 'Gorillaz - Feel Good Inc.' })), { tone: 'auto', label: { key: 'ytdl.source.videoTitle' } }, 'no YouTube artist to agree with');
    assert.deepEqual(Y.sourceLine(gorillaz, { restored: [0] }), { tone: 'warn', label: { key: 'ytdl.source.channel' } });
    assert.deepEqual(Y.sourceLine(vevo), { tone: 'warn', label: { key: 'ytdl.source.channel' } });
    assert.equal(Y.sourceLine(Y.GUESS_NONE), null);
  });

  test("the focused field's help line: its source, Edited, or what a blank does", () => {
    const help = (field, ctx) => Y.fieldHelp(field, ctx);
    assert.deepEqual(help('title', { guess: music, value: 'One More Time' }), { key: 'ytdl.help.music' });
    assert.deepEqual(help('title', { guess: gorillaz, value: 'Feel Good Inc.' }), { key: 'ytdl.help.videoTitleCleaned' });
    assert.deepEqual(help('title', { guess: gorillaz, state: { restored: [1, 2] }, value: 'x' }), { key: 'ytdl.help.videoTitle' });
    assert.deepEqual(help('title', { guess: gorillaz, state: { swapped: true }, value: 'x' }), { key: 'ytdl.help.videoTitle' });
    assert.deepEqual(help('title', { guess: gorillaz, edited: ['title'], value: 'Mine' }), { key: 'ytdl.help.edited' });
    assert.deepEqual(help('title', { guess: gorillaz, edited: ['title'], value: ' ' }), { key: 'ytdl.blank.title' }, 'emptied: the blank line wins');
    assert.deepEqual(help('artist', { guess: music, value: 'Daft Punk' }), { key: 'ytdl.help.music' });
    assert.deepEqual(help('artist', { guess: gorillaz, value: 'Gorillaz' }), { key: 'ytdl.help.videoTitle' });
    assert.deepEqual(help('artist', { guess: gorillaz, state: { swapped: true }, value: 'x' }), { key: 'ytdl.help.videoTitleCleaned' });
    assert.deepEqual(help('artist', { guess: gorillaz, state: { restored: [0] }, value: 'Gorillaz' }), { key: 'ytdl.help.youtubeArtistStripped', params: { removed: 'VEVO' } });
    assert.deepEqual(help('artist', { guess: gorillaz, state: { restored: [0], stripRestored: true }, value: 'x' }), { key: 'ytdl.help.youtubeArtist' });
    assert.deepEqual(help('artist', { guess: Y.guess({ title: 'Song', artist: 'Some Uploader' }), value: 'x' }), { key: 'ytdl.help.youtubeArtistCheck' });
    assert.deepEqual(help('artist', { guess: music, value: '' }), { key: 'ytdl.blank.artistMusic' });
    assert.deepEqual(help('artist', { guess: vevo, value: '' }), { key: 'ytdl.blank.artistGuess', params: { name: 'TheNeighbourhoodVEVO' } });
    assert.deepEqual(help('artist', { guess: Y.guess({ title: 'Song' }), value: '' }), { key: 'ytdl.blank.artistGuessUnnamed' });
    assert.deepEqual(help('album', { guess: music, value: 'Discovery' }), { key: 'ytdl.help.music' });
    assert.deepEqual(help('album', { guess: music, value: '' }), { key: 'ytdl.blank.albumKeeps' });
    assert.deepEqual(help('album', { guess: vevo, value: '', lookupAlbum: 'Wiped Out!' }), { key: 'ytdl.blank.albumKeeps' });
    assert.deepEqual(help('album', { guess: vevo, value: '' }), { key: 'ytdl.blank.albumSingle' });
    assert.deepEqual(help('year', { guess: music, value: '2001' }), { key: 'ytdl.help.music' });
    assert.deepEqual(help('year', { guess: vevo, value: '2013' }), { key: 'ytdl.help.videoRelease' });
    assert.deepEqual(help('year', { guess: vevo, value: '' }), { key: 'ytdl.blank.year' });
    assert.equal(help('genre', { guess: vevo, value: 'x' }), null);
    assert.deepEqual(Y.FIELDS, ['title', 'artist', 'album', 'year']);
  });

  test('the year check, and the tags as the layout reads them', () => {
    for (const y of ['', '  ', '2001', ' 2001 ']) { assert.equal(Y.yearInvalid(y), false, JSON.stringify(y)); }
    for (const y of ['01', '20011', '2001-03', 'MMI', '٢٠٠١']) { assert.equal(Y.yearInvalid(y), true, y); }
    assert.deepEqual(Y.tagsOf({ title: 'x', artist: ' Daft Punk ', album: 'Discovery ', year: 2001 }), { artist: 'Daft Punk', album: 'Discovery', year: '2001' });
    assert.deepEqual(Y.tagsOf(), { artist: '', album: '', year: '' });
  });

  test('the add request: only the non-blank tags, the year only as four digits, no metadata key when none is left — and the route takes it', () => {
    const url = Y.parseLink('https://youtu.be/FGBhQbmPwH8').url;
    const full = Y.addRequest({ url, directory: '/Music/Daft Punk/Discovery/', codec: 'mp3', fields: { title: ' One More Time ', artist: 'Daft Punk', album: 'Discovery', year: '2001' } });
    assert.deepEqual(full, { directory: '/Music/Daft Punk/Discovery/', url, outputCodec: 'mp3', metadata: { title: 'One More Time', artist: 'Daft Punk', album: 'Discovery', year: '2001' } });
    const some = Y.addRequest({ url, directory: '/Music/', codec: 'opus', fields: { title: '', artist: 'Daft Punk', album: '  ', year: '01' } });
    assert.deepEqual(some.metadata, { artist: 'Daft Punk' });
    const none = Y.addRequest({ url, directory: '/Music/', codec: 'flac', fields: { title: ' ', year: 'MMI' } });
    assert.equal('metadata' in none, false);
    for (const body of [full, some, none]) {
      const { error, value } = ADD_SCHEMA.validate(body);
      assert.equal(error, undefined, JSON.stringify(body));
      assert.equal(sanitize(value.url), body.url, 'the server keeps the link as sent');
    }
  });
});

const DAFT_PUNK = { artist: 'Daft Punk', album: 'Discovery', year: '2001' };
const GORILLAZ = { artist: 'Gorillaz' };
const LIBRARY_LAYOUT = '{{ARTIST}}/{{ALBUM}} ({{YEAR}})';

function expectTarget(t, { crumbs, directory, missing = [], never = [], trap = null }) {
  assert.equal(t.valid, true, JSON.stringify(t));
  assert.equal(t.error, null);
  assert.deepEqual(t.crumbs, crumbs);
  assert.equal(t.library, crumbs[0]);
  assert.deepEqual(t.segments, crumbs.slice(1));
  assert.equal(t.relDir, crumbs.slice(1).join('/'));
  assert.equal(t.directory, directory);
  assert.deepEqual(t.missingVars, missing);
  assert.deepEqual(t.neverVars, never);
  assert.deepEqual(t.trap, trap);
}

describe('where a song lands', () => {
  test('the presets, and every one passes the check', () => {
    assert.deepEqual([...Y.YTDL_VARS], ['ARTIST', 'ALBUMARTIST', 'ALBUM', 'YEAR']);
    assert.deepEqual([...Y.NEVER_VARS], ['GENRE', 'PEER', 'SERVERFOLDER']);
    assert.equal(Y.LAYOUT_ARTIST_ALBUM, '{{ALBUMARTIST}}/{{ALBUM}}');
    assert.equal(Y.LAYOUT_ARTIST, '{{ALBUMARTIST}}');
    assert.equal(Y.LAYOUT_ALBUM, '{{ALBUM}}');
    assert.equal(Y.LAYOUT_TOP, '');
    assert.equal(Y.LAYOUT_ARTIST_ALBUM, J.DEFAULT_LAYOUT, "the server's own default");
    for (const l of [Y.LAYOUT_ARTIST_ALBUM, Y.LAYOUT_ARTIST, Y.LAYOUT_ALBUM, Y.LAYOUT_TOP]) { assert.equal(Y.layoutCheck(l).valid, true, l); }
    assert.deepEqual([...Y.YTDL_VARS, ...Y.NEVER_VARS].sort(), [...J.LAYOUT_VARS].sort(), "between them, every variable the engine knows");
  });

  test('FoundMusic, FoundCleaned, ChannelGuess, LinkStates 7 and 10, Artist, Top of the library', () => {
    expectTarget(Y.target({ vpath: 'Music', layout: Y.LAYOUT_ARTIST_ALBUM, tags: DAFT_PUNK }), { crumbs: ['Music', 'Daft Punk', 'Discovery'], directory: '/Music/Daft Punk/Discovery/' });
    expectTarget(Y.target({ vpath: 'Music', layout: Y.LAYOUT_ARTIST_ALBUM, tags: GORILLAZ }), { crumbs: ['Music', 'Gorillaz'], directory: '/Music/Gorillaz/', missing: ['ALBUM'] });
    expectTarget(Y.target({ vpath: 'Music', layout: Y.LAYOUT_ARTIST_ALBUM, tags: { artist: 'TheNeighbourhood' } }), { crumbs: ['Music', 'TheNeighbourhood'], directory: '/Music/TheNeighbourhood/', missing: ['ALBUM'] });
    expectTarget(Y.target({ vpath: 'Music', layout: Y.LAYOUT_ARTIST_ALBUM, tags: { artist: 'Кино' } }), { crumbs: ['Music', 'Кино'], directory: '/Music/Кино/', missing: ['ALBUM'] });
    expectTarget(Y.target({ vpath: 'Music', layout: Y.LAYOUT_ARTIST_ALBUM, tags: {} }), { crumbs: ['Music'], directory: '/Music/', missing: ['ALBUMARTIST', 'ALBUM'] });
    expectTarget(Y.target({ vpath: 'Mixes', layout: Y.LAYOUT_ARTIST, tags: DAFT_PUNK }), { crumbs: ['Mixes', 'Daft Punk'], directory: '/Mixes/Daft Punk/' });
    expectTarget(Y.target({ vpath: 'Music', layout: Y.LAYOUT_TOP, tags: DAFT_PUNK }), { crumbs: ['Music'], directory: '/Music/' });
    expectTarget(Y.target({ vpath: 'Music', tags: DAFT_PUNK }), { crumbs: ['Music'], directory: '/Music/' });
  });

  test('a tag that cannot be a folder name is folded, as the server folds it', () => {
    expectTarget(Y.target({ vpath: 'Music', layout: Y.LAYOUT_ARTIST_ALBUM, tags: { artist: 'AC/DC', album: 'Back In Black?' } }),
      { crumbs: ['Music', 'AC-DC', 'Back In Black-'], directory: '/Music/AC-DC/Back In Black-/' });
  });

  test("Same as Discover: the account's base folders come first, either separator; a refused base makes no target", () => {
    expectTarget(Y.target({ vpath: 'Music', base: 'From Discover', layout: Y.LAYOUT_ARTIST_ALBUM, tags: DAFT_PUNK }),
      { crumbs: ['Music', 'From Discover', 'Daft Punk', 'Discovery'], directory: '/Music/From Discover/Daft Punk/Discovery/' });
    expectTarget(Y.target({ vpath: 'Music', base: 'Added\\ From Discover /', layout: Y.LAYOUT_ALBUM, tags: DAFT_PUNK }),
      { crumbs: ['Music', 'Added', 'From Discover', 'Discovery'], directory: '/Music/Added/From Discover/Discovery/' });
    expectTarget(Y.target({ vpath: 'Music', base: 'From Discover', layout: '', tags: DAFT_PUNK }), { crumbs: ['Music', 'From Discover'], directory: '/Music/From Discover/' });
    const t = Y.target({ vpath: 'Music', base: '..', layout: '', tags: DAFT_PUNK });
    assert.equal(t.valid, false);
    assert.equal(t.error, 'traversal');
    assert.equal(t.directory, '');
    assert.deepEqual(t.crumbs, ['Music']);
    assert.equal(Y.target({ vpath: 'Music', base: '..', layout: Y.LAYOUT_ARTIST, tags: DAFT_PUNK }).error, 'traversal');
  });

  test('YearTrap: folders an empty variable leaves as brackets', () => {
    expectTarget(Y.target({ vpath: 'Music', layout: LIBRARY_LAYOUT, tags: GORILLAZ }),
      { crumbs: ['Music', 'Gorillaz', '()'], directory: '/Music/Gorillaz/()/', missing: ['ALBUM', 'YEAR'], trap: { kind: 'emptyFolder', folder: '()' } });
    expectTarget(Y.target({ vpath: 'Music', layout: LIBRARY_LAYOUT, tags: { artist: 'Daft Punk', album: 'Discovery' } }),
      { crumbs: ['Music', 'Daft Punk', 'Discovery ()'], directory: '/Music/Daft Punk/Discovery ()/', missing: ['YEAR'], trap: { kind: 'missingYear', folder: 'Discovery ()' } });
    expectTarget(Y.target({ vpath: 'Music', layout: LIBRARY_LAYOUT, tags: DAFT_PUNK }), { crumbs: ['Music', 'Daft Punk', 'Discovery (2001)'], directory: '/Music/Daft Punk/Discovery (2001)/' });
    expectTarget(Y.target({ vpath: 'Music', layout: '{{ARTIST}} - {{ALBUM}}', tags: GORILLAZ }),
      { crumbs: ['Music', 'Gorillaz -'], directory: '/Music/Gorillaz -/', missing: ['ALBUM'], trap: { kind: 'other', folder: 'Gorillaz -' } });
    assert.deepEqual(Y.target({ vpath: 'Music', layout: '{{ARTIST}}/[{{YEAR}}]', tags: GORILLAZ }).trap, { kind: 'emptyFolder', folder: '[]' });
    assert.deepEqual(Y.target({ vpath: 'Music', layout: '{{ALBUM}} - {{ARTIST}}', tags: GORILLAZ }).trap, { kind: 'other', folder: '- Gorillaz' });
    assert.deepEqual(Y.target({ vpath: 'Music', layout: '{{ALBUM}} - {{YEAR}}', tags: { album: 'Discovery' } }).trap, { kind: 'missingYear', folder: 'Discovery -' });
    assert.deepEqual(Y.target({ vpath: 'Music', layout: '{{ARTIST}} - {{ALBUM}}', tags: {} }).trap, { kind: 'emptyFolder', folder: '-' });
    const genre = Y.target({ vpath: 'Music', layout: '{{ALBUM}} ({{GENRE}})', tags: DAFT_PUNK });
    assert.deepEqual(genre.trap, { kind: 'other', folder: 'Discovery ()' }, 'a never-variable that empties a folder is a trap too');
    assert.deepEqual(genre.neverVars, ['GENRE']);
    assert.equal(Y.target({ vpath: 'Music', layout: '{{ARTIST}}/Singles ()', tags: GORILLAZ }).trap, null, "brackets typed as text are the user's own");
    assert.equal(Y.target({ vpath: 'Music', layout: '{{ARTIST}}/{{ALBUM}}', tags: GORILLAZ }).trap, null, 'an emptied folder is dropped, not a trap');
  });

  test('the bracket warning, and how a flagged folder is read aloud', () => {
    assert.deepEqual(Y.trapLabel({ kind: 'emptyFolder', folder: '()' }), {
      label: { key: 'ytdl.where.trap.empty', params: { folder: '()' } }, link: { label: { key: 'ytdl.where.trap.editTags' }, focus: 'album' },
    });
    assert.deepEqual(Y.trapLabel({ kind: 'missingYear', folder: 'Discovery ()' }), {
      label: { key: 'ytdl.where.trap.year', params: { folder: 'Discovery ()' } }, link: { label: { key: 'ytdl.where.trap.addYear' }, focus: 'year' },
    });
    assert.deepEqual(Y.trapLabel({ kind: 'other', folder: 'Gorillaz -' }), { label: { key: 'ytdl.where.trap.other', params: { folder: 'Gorillaz -' } }, link: null });
    assert.equal(Y.trapLabel(null), null);
    for (const f of ['()', '【】', '-', ' [ ] ', '()-()']) { assert.equal(Y.onlyBrackets(f), true, f); }
    for (const f of ['', '  ', 'Discovery ()', 'a']) { assert.equal(Y.onlyBrackets(f), false, f); }
    assert.equal(Y.withoutEmptyPairs('Discovery ()'), 'Discovery');
    assert.equal(Y.withoutEmptyPairs('() Discovery 【 】'), 'Discovery');
    assert.equal(Y.withoutEmptyPairs('Discovery (2001)'), null);
  });

  test('the crumbs as drawn: NEW pills on the folders to be made, the trap folder marked', () => {
    const t = Y.target({ vpath: 'Music', layout: LIBRARY_LAYOUT, tags: { artist: 'Daft Punk', album: 'Discovery' } });
    assert.deepEqual(Y.crumbItems(t, [1]), [
      { text: 'Music', isNew: false, trap: false },
      { text: 'Daft Punk', isNew: false, trap: false },
      { text: 'Discovery ()', isNew: true, trap: true },
    ]);
    assert.deepEqual(Y.crumbItems(Y.target({ vpath: 'Music', layout: '', tags: {} })), [{ text: 'Music', isNew: false, trap: false }]);
    assert.deepEqual(Y.crumbItems(null), []);
  });

  test('WhereCustom: a layout typed by hand, and its three errors', () => {
    assert.equal(Y.layoutCheck('{{ARTIST}}/Singles').valid, true);
    expectTarget(Y.target({ vpath: 'Music', layout: '{{ARTIST}}/Singles', tags: DAFT_PUNK }), { crumbs: ['Music', 'Daft Punk', 'Singles'], directory: '/Music/Daft Punk/Singles/' });

    const unknown = Y.layoutCheck('{{ARTIST}}/{{TITLE}}');
    assert.deepEqual(unknown, { valid: false, issue: 'unknownVariable', token: '{{TITLE}}', engine: null });
    assert.equal(Y.layoutCheck('{{artist}}/{{ title }}').token, '{{ title }}', 'the token as typed');
    assert.deepEqual(Y.layoutProblem(unknown), { key: 'ytdl.where.err.unknownVar', params: { token: '{{TITLE}}', vars: 'ARTIST, ALBUMARTIST, ALBUM, YEAR' } });
    const t = Y.target({ vpath: 'Music', layout: '{{ARTIST}}/{{TITLE}}', tags: DAFT_PUNK });
    assert.equal(t.valid, false);
    assert.equal(t.error, 'unknown_variable');
    assert.equal(t.directory, '');

    const never = Y.layoutCheck('{{GENRE}}/{{ARTIST}}');
    assert.equal(never.issue, 'neverVariable');
    assert.equal(never.token, '{{GENRE}}');
    assert.equal(Y.layoutCheck('{{ARTIST}}/{{ peer }}').token, '{{ peer }}');
    assert.equal(Y.layoutCheck('{{SERVERFOLDER}}').issue, 'neverVariable');
    assert.deepEqual(Y.layoutProblem(never), { key: 'ytdl.where.err.neverVar', params: { token: '{{GENRE}}', vars: 'ARTIST, ALBUMARTIST, ALBUM, YEAR' } });

    const bad = Y.layoutCheck('Singles: 2024');
    assert.equal(bad.issue, 'badChars');
    assert.equal(bad.token, ':');
    for (const l of ['a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', '{{ARTIST}} | Live']) { assert.equal(Y.layoutCheck(l).issue, 'badChars', l); }
    assert.deepEqual(Y.layoutProblem(bad), { key: 'ytdl.where.err.badChar' });
    const tb = Y.target({ vpath: 'Music', layout: 'Singles: 2024', tags: DAFT_PUNK });
    assert.equal(tb.valid, false);
    assert.equal(tb.error, 'bad_chars');

    assert.equal(Y.layoutCheck('{{TITLE}}/{{GENRE}}').issue, 'unknownVariable', 'the allow-list runs after validateLayout');
    assert.equal(Y.layoutCheck('{{GENRE}}: x').issue, 'neverVariable', 'the literal check last');
    assert.equal(Y.layoutProblem(Y.layoutCheck('{{ARTIST}}')), null);
    assert.deepEqual(Y.layoutCheck(''), { valid: true, issue: 'none', token: null, engine: null }, 'callers treat it as Top of the library');
  });

  test("the engine's own refusals come back as engine, each worded", () => {
    for (const [layout, code, key] of [
      ['{ARTIST}', 'unbalanced_braces', 'ytdl.where.err.braces'],
      ['/{{ARTIST}}', 'absolute_template', 'ytdl.where.err.absolute'],
      ['C:', 'drive_letter', 'ytdl.where.err.drive'],
      ['{{ARTIST}}/D:x', 'drive_letter_segment', 'ytdl.where.err.drive'],
      ['../{{ARTIST}}', 'traversal', 'ytdl.where.err.traversal'],
      ['~/{{ARTIST}}', 'home_string', 'ytdl.where.err.home'],
      [' ', 'empty_path', 'ytdl.where.err.empty'],
      ['x'.repeat(501), 'template_too_long', 'ytdl.where.err.tooLong'],
      ['a\u0001b', 'invalid_chars', 'ytdl.where.err.control'],
    ]) {
      const c = Y.layoutCheck(layout);
      assert.equal(c.issue, 'engine', layout);
      assert.equal(c.engine.error, code, layout);
      assert.deepEqual(Y.layoutProblem(c), { key, params: { example: '{{ARTIST}}', max: 500 } }, layout);
    }
    assert.deepEqual(Y.layoutProblem(Y.layoutCheck(null)), { key: 'ytdl.where.err.generic' }, 'a code with no words of its own');
    assert.equal(Y.target({ vpath: 'Music', layout: 42, tags: {} }).error, 'invalid_type');
  });

  test('a library layout that names a never-variable still renders, the variable listed apart', () => {
    expectTarget(Y.target({ vpath: 'Music', layout: '{{GENRE}}/{{ARTIST}}', tags: DAFT_PUNK }), { crumbs: ['Music', 'Daft Punk'], directory: '/Music/Daft Punk/', never: ['GENRE'] });
    expectTarget(Y.target({ vpath: 'Music', layout: '{{PEER}}/{{ALBUMARTIST}}/{{ALBUM}}', tags: GORILLAZ }),
      { crumbs: ['Music', 'Gorillaz'], directory: '/Music/Gorillaz/', missing: ['ALBUM'], never: ['PEER'] });
    expectTarget(Y.target({ vpath: 'Music', layout: '{{SERVERFOLDER}}', tags: DAFT_PUNK }), { crumbs: ['Music'], directory: '/Music/', never: ['SERVERFOLDER'] });
  });

  test('every target names the folder previewTarget renders', () => {
    for (const layout of [Y.LAYOUT_ARTIST_ALBUM, Y.LAYOUT_ARTIST, Y.LAYOUT_ALBUM, LIBRARY_LAYOUT, '{{ARTIST}}/Singles', '{{GENRE}}/{{ARTIST}}']) {
      for (const tags of [DAFT_PUNK, GORILLAZ, {}, { artist: 'AC/DC', album: '..', year: '1980' }]) {
        for (const base of ['', 'From Discover']) {
          const mine = Y.target({ vpath: 'Music', base, layout, tags });
          const p = J.previewTarget({ vpath: 'Music', base, layout, tags: { ...tags, albumartist: tags.artist } });
          assert.equal(mine.valid, p.valid, layout);
          if (p.valid) { assert.equal(mine.relDir, p.relDir, `${layout} ${JSON.stringify(tags)} ${base}`); }
        }
      }
    }
  });

  test('the explorer window: under the folder on screen, either spelling of its path', () => {
    for (const here of ['/Music/Daft Punk/', 'Music/Daft Punk/', 'Music/Daft Punk']) {
      expectTarget(Y.folderTarget({ currentPath: here, layout: Y.LAYOUT_TOP, tags: DAFT_PUNK }), { crumbs: ['Music', 'Daft Punk'], directory: '/Music/Daft Punk/' });
      expectTarget(Y.folderTarget({ currentPath: here, layout: Y.LAYOUT_ALBUM, tags: DAFT_PUNK }), { crumbs: ['Music', 'Daft Punk', 'Discovery'], directory: '/Music/Daft Punk/Discovery/' });
      expectTarget(Y.folderTarget({ currentPath: here, layout: Y.LAYOUT_ARTIST_ALBUM, tags: DAFT_PUNK }),
        { crumbs: ['Music', 'Daft Punk', 'Daft Punk', 'Discovery'], directory: '/Music/Daft Punk/Daft Punk/Discovery/' });
      expectTarget(Y.folderTarget({ currentPath: here, layout: Y.LAYOUT_ALBUM, tags: GORILLAZ }), { crumbs: ['Music', 'Daft Punk'], directory: '/Music/Daft Punk/', missing: ['ALBUM'] });
    }
    expectTarget(Y.folderTarget({ currentPath: '/Music/', layout: '', tags: DAFT_PUNK }), { crumbs: ['Music'], directory: '/Music/' });
    expectTarget(Y.folderTarget({ currentPath: '/Music/~Odd C: Folder/', layout: Y.LAYOUT_ALBUM, tags: DAFT_PUNK }),
      { crumbs: ['Music', '~Odd C: Folder', 'Discovery'], directory: '/Music/~Odd C: Folder/Discovery/' });
    const bad = Y.folderTarget({ currentPath: '/Music/', layout: 'Singles: 2024', tags: DAFT_PUNK });
    assert.equal(bad.valid, false);
    assert.equal(bad.error, 'bad_chars');
    assert.equal(Y.folderTarget({ currentPath: '/Music/', layout: '{{TITLE}}', tags: DAFT_PUNK }).error, 'unknown_variable');
    const trap = Y.folderTarget({ currentPath: '/Music/Daft Punk/', layout: '{{ALBUM}} ({{YEAR}})', tags: { album: 'Discovery' } });
    assert.equal(trap.directory, '/Music/Daft Punk/Discovery ()/');
    assert.deepEqual(trap.trap, { kind: 'missingYear', folder: 'Discovery ()' });
    assert.equal(Y.folderTarget({ currentPath: '', layout: '', tags: {} }).valid, false, 'the root names no library');
    assert.equal(Y.folderTarget({ currentPath: '/', layout: '', tags: {} }).error, 'no_library');
    assert.deepEqual(Y.FOLDER_SORTS.map((s) => [s.kind, s.layout]), [['here', ''], ['album', '{{ALBUM}}'], ['artistAlbum', '{{ALBUMARTIST}}/{{ALBUM}}'], ['custom', null]]);
  });
});

// A library as MSTREAMAPI.dirparser answers it: directory → { directories, files }.
function fakeLibrary(tree) {
  const asked = [];
  const list = (dir) => {
    asked.push(dir);
    const entry = tree[dir];
    if (!entry) { return Promise.reject(Object.assign(new Error('POST api/v1/file-explorer failed: 404'), { status: 404, body: { error: 'Folder not found' } })); }
    return Promise.resolve({ directories: entry.dirs.map((name) => ({ name })), files: entry.files.map((name) => ({ name, type: 'mp3' })) });
  };
  return { list, asked };
}

describe('the new-folder check', () => {
  const tree = {
    '/Music/': { dirs: ['Daft Punk', 'Gorillaz'], files: ['loose.mp3'] },
    '/Music/Daft Punk/': { dirs: ['Homework'], files: ['One_More_Time.mp3', 'Discovery'] },
    '/Music/Gorillaz/': { dirs: [], files: ['Feel_Good_Inc.mp3'] },
  };

  test('a target that lists: known, nothing new, its files for the name check', async () => {
    const lib = fakeLibrary(tree);
    const t = Y.target({ vpath: 'Music', layout: Y.LAYOUT_ARTIST, tags: GORILLAZ });
    assert.deepEqual(await Y.checkFolders({ target: t, list: lib.list }), { state: 'known', newSegments: [], deepest: '/Music/Gorillaz/', files: ['Feel_Good_Inc.mp3'] });
    assert.deepEqual(lib.asked, ['/Music/Gorillaz/']);
  });

  test('walks up to the folder that lists: the one below it and every one after are new', async () => {
    const lib = fakeLibrary(tree);
    const t = Y.target({ vpath: 'Music', layout: '{{ARTIST}}/{{ALBUM}}/{{YEAR}}', tags: { artist: 'Gorillaz', album: 'Demon Days', year: '2005' } });
    assert.deepEqual(await Y.checkFolders({ target: t, list: lib.list }), { state: 'known', newSegments: [1, 2], deepest: '/Music/Gorillaz/', files: null });
    assert.deepEqual(lib.asked, ['/Music/Gorillaz/Demon Days/2005/', '/Music/Gorillaz/Demon Days/', '/Music/Gorillaz/']);
    const fresh = Y.target({ vpath: 'Music', layout: Y.LAYOUT_ARTIST_ALBUM, tags: { artist: 'Air', album: 'Moon Safari' } });
    assert.deepEqual(await Y.checkFolders({ target: fresh, list: fakeLibrary(tree).list }), { state: 'known', newSegments: [0, 1], deepest: '/Music/', files: null });
  });

  test("a folder there in another case is not new (the listing is read ignoring case); a file of its name is unknown", async () => {
    const lower = Y.target({ vpath: 'Music', layout: '{{ARTIST}}/x', tags: { artist: 'daft punk' } });
    const tree2 = { ...tree };
    delete tree2['/Music/Daft Punk/'];
    assert.deepEqual(await Y.checkFolders({ target: lower, list: fakeLibrary(tree2).list }), { state: 'unknown', newSegments: [], deepest: '/Music/', files: null });
    const blocked = Y.target({ vpath: 'Music', layout: Y.LAYOUT_ARTIST_ALBUM, tags: DAFT_PUNK });
    assert.deepEqual(await Y.checkFolders({ target: blocked, list: fakeLibrary(tree).list }), { state: 'unknown', newSegments: [], deepest: '/Music/Daft Punk/', files: null });
  });

  test('nothing lists: unknown; the rows on screen stand in for a target that will not list; a stale answer is dropped', async () => {
    const t = Y.target({ vpath: 'Music', layout: Y.LAYOUT_ARTIST, tags: DAFT_PUNK });
    assert.deepEqual(await Y.checkFolders({ target: t, list: fakeLibrary({}).list }), { state: 'unknown', newSegments: [], deepest: null, files: null });
    const shown = (dir) => (dir === '/Music/Daft Punk/' ? ['One_More_Time.mp3'] : null);
    assert.deepEqual(await Y.checkFolders({ target: t, list: fakeLibrary({}).list, shown }), { state: 'known', newSegments: [], deepest: '/Music/Daft Punk/', files: ['One_More_Time.mp3'] });
    assert.equal(await Y.checkFolders({ target: t, list: fakeLibrary(tree).list, stale: () => true }), null);
    assert.equal(await Y.checkFolders({ target: t, list: fakeLibrary({}).list, stale: () => true }), null);
    assert.deepEqual(await Y.checkFolders({ target: Y.target({ vpath: 'Music', layout: '{{TITLE}}', tags: {} }), list: fakeLibrary(tree).list }), { state: 'unknown', newSegments: [], deepest: null, files: null });
  });
});

describe('"Where new songs land": the presets and the remembered choice', () => {
  const view = (over) => ({
    destination: { vpath: 'Music', base: 'From Discover', layout: '{{ALBUMARTIST}}/{{ALBUM}}', source: 'user' },
    saved: { vpath: 'Music', base: 'From Discover', layout: '{{ALBUMARTIST}}/{{ALBUM}}' },
    libraries: [{ vpath: 'Music', template: '{{ARTIST}}/{{ALBUM}} ({{YEAR}})' }, { vpath: 'Mixes', template: null }],
    defaultLayout: '{{ALBUMARTIST}}/{{ALBUM}}', variables: [...J.LAYOUT_VARS],
    ...over,
  });
  const kinds = (choices) => choices.map((c) => c.kind);

  test('the radios: the three presets, Same as Discover (the account\'s own only), Library layout (its own only), Custom', () => {
    const c = Y.layoutChoices({ view: view(), library: 'Music' });
    assert.deepEqual(kinds(c), ['artistAlbum', 'artist', 'top', 'discover', 'library', 'custom']);
    assert.deepEqual(c.map((x) => x.label.key), ['ytdl.where.preset.artistAlbum', 'ytdl.where.preset.artist', 'ytdl.where.preset.top', 'ytdl.where.preset.discover', 'ytdl.where.preset.library', 'ytdl.where.preset.custom']);
    assert.deepEqual(c[3], { kind: 'discover', layout: '{{ALBUMARTIST}}/{{ALBUM}}', base: 'From Discover', library: 'Music', label: { key: 'ytdl.where.preset.discover' } });
    assert.equal(c[4].layout, LIBRARY_LAYOUT);
    assert.equal(c[5].layout, null, "Custom's layout is the field's");
    assert.deepEqual(kinds(Y.layoutChoices({ view: view(), library: 'Mixes' })), ['artistAlbum', 'artist', 'top', 'discover', 'custom']);
    assert.deepEqual(kinds(Y.layoutChoices({ view: view({ destination: { vpath: 'Music', base: '', layout: '{{ALBUMARTIST}}/{{ALBUM}}', source: 'default' }, saved: null }), library: 'Music' })),
      ['artistAlbum', 'artist', 'top', 'library', 'custom'], 'the default destination is no "Same as Discover"');
    assert.deepEqual(kinds(Y.layoutChoices({ view: null, library: 'Music' })), ['artistAlbum', 'artist', 'top', 'custom']);
  });

  test('a library template that is one of the presets is not offered twice — except on the library it was saved for', () => {
    const v = view({ libraries: [{ vpath: 'Music', template: '{{ALBUMARTIST}}/{{ALBUM}}' }, { vpath: 'Mixes', template: '  ' }] });
    assert.equal(Y.libraryTemplate(v, 'Music'), null);
    assert.equal(Y.libraryTemplate(v, 'Music', { kind: 'library', library: 'Music' }), '{{ALBUMARTIST}}/{{ALBUM}}');
    assert.equal(Y.libraryTemplate(v, 'Music', { kind: 'library', library: 'Mixes' }), null);
    assert.equal(Y.libraryTemplate(v, 'Mixes'), null, 'a blank template is none');
    assert.equal(Y.libraryTemplate(view(), 'Nope'), null);
    assert.deepEqual(Y.discoverPreset(view()), { vpath: 'Music', base: 'From Discover', layout: '{{ALBUMARTIST}}/{{ALBUM}}' });
    assert.equal(Y.discoverPreset(view({ destination: null })), null);
  });

  test('first use: Discover\'s library when its destination is the user\'s own, else the first; always Artist / Album', () => {
    assert.deepEqual(Y.rememberedChoice({ view: view(), saved: null }), { library: 'Music', layout: '{{ALBUMARTIST}}/{{ALBUM}}', kind: 'artistAlbum', base: '' });
    const mixesFirst = view({ libraries: [{ vpath: 'Mixes' }, { vpath: 'Music' }] });
    assert.equal(Y.rememberedChoice({ view: mixesFirst }).library, 'Music', "Discover's");
    assert.equal(Y.rememberedChoice({ view: view({ destination: { vpath: 'Music', base: '', layout: 'x', source: 'default' }, libraries: [{ vpath: 'Mixes' }, { vpath: 'Music' }] }) }).library, 'Mixes');
    assert.deepEqual(Y.rememberedChoice({ view: null, libraries: [] }), { library: '', layout: '{{ALBUMARTIST}}/{{ALBUM}}', kind: 'artistAlbum', base: '' });
  });

  test('a remembered choice: kept while the account has the library; Same as Discover and Library layout follow their preset, or read Custom once it is gone', () => {
    assert.deepEqual(Y.rememberedChoice({ view: view(), saved: { library: 'Mixes', layout: '', kind: 'top' } }), { library: 'Mixes', layout: '', kind: 'top', base: '' });
    assert.equal(Y.rememberedChoice({ view: view(), saved: { library: 'Gone', layout: '', kind: 'top' } }).library, 'Music', 'a library the account no longer has falls back');
    assert.deepEqual(Y.rememberedChoice({ view: view(), saved: { library: 'Music', layout: 'From Discover/{{ALBUMARTIST}}/{{ALBUM}}', kind: 'discover' } }),
      { library: 'Music', layout: '{{ALBUMARTIST}}/{{ALBUM}}', kind: 'discover', base: 'From Discover' });
    assert.deepEqual(Y.rememberedChoice({ view: view({ destination: null }), saved: { library: 'Music', layout: 'From Discover/{{ALBUMARTIST}}/{{ALBUM}}', kind: 'discover' } }),
      { library: 'Music', layout: 'From Discover/{{ALBUMARTIST}}/{{ALBUM}}', kind: 'custom', base: '' }, 'the folded copy lives on in Custom');
    assert.deepEqual(Y.rememberedChoice({ view: null, libraries: ['Music'], saved: { library: 'Music', layout: 'From Discover/{{ALBUMARTIST}}/{{ALBUM}}', kind: 'discover' } }),
      { library: 'Music', layout: 'From Discover/{{ALBUMARTIST}}/{{ALBUM}}', kind: 'discover', base: '' }, 'until the view answers, the copy');
    assert.deepEqual(Y.rememberedChoice({ view: view(), saved: { library: 'Music', layout: 'old', kind: 'library' } }), { library: 'Music', layout: LIBRARY_LAYOUT, kind: 'library', base: '' });
    assert.equal(Y.rememberedChoice({ view: view(), saved: { library: 'Mixes', layout: 'old', kind: 'library' } }).kind, 'custom');
    assert.equal(Y.rememberedChoice({ view: view(), saved: { library: 'Music', layout: '{{ALBUMARTIST}}' } }).kind, 'artist', 'no kind: read off the layout');
    assert.equal(Y.rememberedChoice({ view: view(), saved: { library: 'Music', layout: 'Singles' } }).kind, 'custom');
  });

  test('Save keeps a Same as Discover choice\'s base folders in front of its layout; a choice lands where its target says', () => {
    const d = { library: 'Music', layout: '{{ALBUMARTIST}}/{{ALBUM}}', kind: 'discover', base: 'From Discover' };
    assert.deepEqual(Y.choiceToSave(d), { library: 'Music', layout: 'From Discover/{{ALBUMARTIST}}/{{ALBUM}}', kind: 'discover' });
    assert.deepEqual(Y.choiceToSave({ library: 'Mixes', layout: '', kind: 'top' }), { library: 'Mixes', layout: '', kind: 'top' });
    assert.equal(Y.choiceTarget(d, DAFT_PUNK).directory, '/Music/From Discover/Daft Punk/Discovery/');
    assert.equal(Y.choiceTarget(Y.rememberedChoice({ view: null, libraries: ['Music'], saved: Y.choiceToSave(d) }), DAFT_PUNK).directory,
      '/Music/From Discover/Daft Punk/Discovery/', 'the remembered copy lands in the same place');
    assert.equal(Y.choiceTarget({ library: 'Music', layout: '{{ALBUM}}', kind: 'album', base: 'ignored' }, DAFT_PUNK).directory, '/Music/Discovery/', 'only Same as Discover has base folders');
  });
});

// The server's default map (src/state/config.js), `true` keys only.
const SERVER_DEFAULT = ['mp3', 'flac', 'wav', 'ogg', 'aac', 'm4a', 'm4b', 'opus'];

describe('formats', () => {
  test('formatOptions: the menu\'s order, aac only in m4a\'s place, never m4b or m3u, mp3 when nothing usable', () => {
    assert.deepEqual(Y.formatOptions(SERVER_DEFAULT), ['mp3', 'm4a', 'opus', 'ogg', 'flac', 'wav']);
    assert.deepEqual(Y.formatOptions(SERVER_DEFAULT), [...Y.FORMAT_ORDER]);
    assert.deepEqual(Y.formatOptions(['wav', 'opus', 'mp3']), ['mp3', 'opus', 'wav']);
    assert.deepEqual(Y.formatOptions(['flac', 'aac', 'mp3']), ['mp3', 'aac', 'flac']);
    assert.deepEqual(Y.formatOptions(['aac', 'm4a']), ['m4a']);
    assert.deepEqual(Y.formatOptions(['aac']), ['aac']);
    assert.deepEqual(Y.formatOptions(['m4b', 'mp3', 'm3u', 'wma']), ['mp3']);
    for (const bad of [null, undefined, [], ['m4b', 'm3u'], 'mp3', 7]) { assert.deepEqual(Y.formatOptions(bad), ['mp3'], JSON.stringify(bad)); }
  });

  test('from the ping\'s supportedAudioFiles map: its true keys', () => {
    const map = { mp3: true, flac: true, wav: false, ogg: true, aac: true, m4a: false, m4b: true, opus: true, m3u: false };
    assert.deepEqual(Y.enabledFormats(map), ['mp3', 'flac', 'ogg', 'aac', 'm4b', 'opus']);
    assert.deepEqual(Y.formatOptions(map), ['mp3', 'aac', 'opus', 'ogg', 'flac']);
    assert.equal(Y.enabledFormats(null), null);
  });

  test('the default: mp3 when on, else the first option; a remembered one while it is still offered', () => {
    assert.equal(Y.defaultFormat(SERVER_DEFAULT), 'mp3');
    assert.equal(Y.defaultFormat(['wav', 'mp3']), 'mp3');
    assert.equal(Y.defaultFormat(['wav', 'flac', 'opus']), 'opus');
    assert.equal(Y.defaultFormat(['aac', 'wav']), 'aac');
    assert.equal(Y.defaultFormat(null), 'mp3');
    assert.equal(Y.defaultFormat(['m3u']), 'mp3');
    assert.equal(Y.effectiveFormat('opus', SERVER_DEFAULT), 'opus');
    assert.equal(Y.effectiveFormat('aac', ['aac', 'mp3']), 'aac');
    assert.equal(Y.effectiveFormat('opus', ['mp3', 'flac']), 'mp3');
    assert.equal(Y.effectiveFormat('opus', ['wav', 'flac']), 'flac');
    assert.equal(Y.effectiveFormat('aac', SERVER_DEFAULT), 'mp3', 'aac while m4a is on is not an option');
    assert.equal(Y.effectiveFormat('m4b', SERVER_DEFAULT), 'mp3');
    assert.equal(Y.effectiveFormat(null, SERVER_DEFAULT), 'mp3');
    assert.equal(Y.effectiveFormat(null, ['ogg', 'wav']), 'ogg');
    assert.equal(Y.effectiveFormat(null, null), 'mp3');
  });

  test('names are not translated; the help words are keys, none for OGG Vorbis and AAC', () => {
    assert.deepEqual(['mp3', 'm4a', 'opus', 'ogg', 'flac', 'wav', 'aac', 'WMA'].map(Y.formatName), ['MP3', 'M4A', 'Opus', 'OGG Vorbis', 'FLAC', 'WAV', 'AAC', 'WMA']);
    assert.deepEqual(['mp3', 'm4a', 'opus', 'flac', 'wav'].map((c) => Y.formatHelp(c).key), ['ytdl.format.mp3', 'ytdl.format.m4a', 'ytdl.format.opus', 'ytdl.format.flac', 'ytdl.format.wav']);
    assert.equal(Y.formatHelp('ogg'), null);
    assert.equal(Y.formatHelp('aac'), null);
  });
});

// Names the real yt-dlp (2026.08.19) gave titles under -o '%(title)s.%(ext)s'
// --restrict-filenames: the phone's ytdl_filename_test.dart `fixtures`
// (real), `oracle` (real) and `derived` (from the algorithm) tables.
const YTDLP_NAMES = {
  fixtures: [
    ["One More Time", "One_More_Time"],
    ["Gorillaz - Feel Good Inc. (Official Video) [HD]", "Gorillaz_-_Feel_Good_Inc._Official_Video_HD"],
    ["\u041a\u0438\u043d\u043e \u2013 \u0413\u0440\u0443\u043f\u043f\u0430 \u043a\u0440\u043e\u0432\u0438", "_"],
    ["Sweater Weather (Official Video)", "Sweater_Weather_Official_Video"],
    ["Daft Punk - Around the World (Official Audio)", "Daft_Punk_-_Around_the_World_Official_Audio"],
    ["Beyonc\u00e9 - D\u00e9j\u00e0 Vu", "Beyonce_-_Deja_Vu"],
    ["M\u00f6tley Cr\u00fce \u2013 Kickstart My Heart", "Motley_Crue_Kickstart_My_Heart"],
    ["Bj\u00f6rk: Army of Me", "Bjork_-_Army_of_Me"],
    ["Live at 12:34:56 - full set", "Live_at_12_34_56_-_full_set"],
    ["Track 1:23", "Track_1_23"],
    ["-Leading dash", "-Leading_dash"],
    ["--Double leading", "--Double_leading"],
    ["Foo - _Bar", "Foo_-__Bar"],
    ["  spaced  out  ", "spaced_out"],
    ["AC/DC - Back In Black", "AC_DC_-_Back_In_Black"],
    ["What?! Why?", "What_Why"],
    ["\"Quoted\" title", "Quoted_title"],
    ["A|B*C<D>E", "A_B_C_D_E"],
    ["\uff26\uff55\uff4c\uff4c\uff57\uff49\uff44\uff54\uff48 \uff21\uff22\uff23", "Fullwidth_ABC"],
    ["\ufb01ligree ligature", "filigree_ligature"],
    ["\u00c6on Flux \u0152uvre \u00df", "AEon_Flux_OEuvre_ss"],
    ["Sigur R\u00f3s \u2013 Hopp\u00edpolla", "Sigur_Ros_Hoppipolla"],
    ["\u7c73\u6d25\u7384\u5e2b - Lemon", "Lemon"],
    ["Lemon / \u7c73\u6d25\u7384\u5e2b", "Lemon"],
    ["official\u9aed\u7537dism - Pretender", "official_dism_-_Pretender"],
    ["\u0395\u03bb\u03bb\u03b7\u03bd\u03b9\u03ba\u03ac - \u03c4\u03c1\u03b1\u03b3\u03bf\u03cd\u03b4\u03b9", "_"],
    ["Rock & Roll (feat. Someone) [2011 Remaster]", "Rock_Roll_feat._Someone_2011_Remaster"],
    ["..dots.at.start", "..dots.at.start"],
    ["_underscores_", "_underscores_"],
    ["100% Pure #1 $hit {x} `y` ^z ;w ,v", "100%_Pure_1_hit_x_y_z_w_v"],
    ["Tab\there", "Tabhere"],
    ["emoji \ud83c\udfb5 song", "emoji_song"],
    ["Caf\u00e9 del Mar \u2013 Energy 52", "Cafe_del_Mar_Energy_52"],
    ["Na\u00efve fa\u00e7ade", "Naive_facade"],
    ["\u00d8 \u00d0 \u00de \u00f0 \u00fe", "O_D_TH_o_th"],
    ["\u0130stanbul \u0131", "stanbul"],
    ["a  -  b", "a_-_b"],
    ["x \u2014 y \u2013 z", "x_y_z"],
    ["\u00d1and\u00fa", "Nandu"],
    ["\u00dcber \u00c4rger \u00d6l", "Uber_Arger_Ol"],
    ["\u0645\u0631\u062d\u0628\u0627 - \u0639\u0645\u0631\u0648 \u062f\u064a\u0627\u0628", "_"],
    ["\u05e9\u05dc\u05d5\u05dd - \u05e9\u05d9\u05e8", "_"],
    ["Song (Lyrics) | Artist", "Song_Lyrics_Artist"],
    ["Hello: World: Again", "Hello_-_World_-_Again"],
    ["2:00 AM", "2_00_AM"],
  ],
  oracle: [
    ["Cafe\u0301 au lait", "Cafe_au_lait"],
    ["Ma\u0304ori", "M_ori"],
    ["Vie\u0323\u0302t Nam", "Vi_t_Nam"],
    ["Vi\u00ea\u0323t", "Vi_t"],
    ["\u0645\u064e\u0631\u0652\u062d\u064e\u0628\u064b\u0627 Hi", "Hi"],
    ["A\u064eB", "AB"],
    ["\u0928\u092e\u0938\u094d\u0924\u0947 Namaste", "Namaste"],
    ["\uc548\ub155 Hello \u1100\u1161", "Hello"],
    ["No\u00a0Break", "No_Break"],
    ["Zero\u200dWidth", "ZeroWidth"],
    ["Heart \u2764\ufe0f Song", "Heart_Song"],
    ["\u2764\ufe0f", "_"],
    ["Wait\u2026 What", "Wait..._What"],
    ["Brand\u2122 Song", "BrandTM_Song"],
    ["\ud835\udc01\ud835\udc28\ud835\udc25\ud835\udc1d Text", "Bold_Text"],
    ["Final Fantasy \u2166", "Final_Fantasy_VII"],
    ["\u2460 First", "1_First"],
    ["\uff11\uff12\uff1a\uff13\uff14 \uff2c\uff49\uff56\uff45", "12_34_Live"],
    ["x\u00b2 + y\u00b2", "x2_+_y2"],
    ["\u00bd Price", "1_2_Price"],
    ["\u0e2a\u0e27\u0e31\u0e2a\u0e14\u0e35 Thai", "Thai"],
    ["A\ufe0fB \u2139\ufe0f Info", "AB_i_Info"],
    ["\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67 Family", "Family"],
    ["Ae\u0303\u0301 Pho\u031b\u0309 o\u0302\u0301", "A_Ph"],
  ],
  derived: [
    ["Absolute \u212a zero", "Absolute_K_zero"],
    ["\u212bngstr\u00f6m", "Angstrom"],
    ["\u24c2usic \u2460\u2461\u2462", "Music_123"],
    ["\u2474 \u2488 \u249c", "1_1._a"],
    ["xa\u0336\u0304y", "x_y"],
    ["a\u017f\u0307b", "a_b"],
    ["a\ud800b", "ab"],
    ["a\ud835\udc55b", "ab"],
    ["\ud835\udfce\ud835\udfd8 \ud835\udd38", "00_A"],
    ["\ud83c\udd30\ud83c\udd31 \ud83c\udd10", "AB_A"],
    ["No. \u2116 1 \u2122 \u2120", "No._No_1_TM_SM"],
    ["Room 10\u00bd", "Room_101_2"],
    ["\ufb00\ufb03\ufb04\ufb05", "ffffifflst"],
    ["Na\u0308\u0304ive", "N_ive"],
    ["Song ~ 100% @ home = +1", "Song_~_100%_@_home_=_+1"],
    ["trailing -_ :", "trailing"],
    [": leading colon", "leading_colon"],
    ["Ellipsis\u2026", "Ellipsis..."],
    ["\uff33\uff4f\uff4e\uff47\uff08\uff2c\uff49\uff56\uff45\uff09", "Song_Live"],
    ["Vertical\ufe19 forms\ufe30", "Vertical..._forms.."],
    ["\u0132sselmeer \u01c5", "IJsselmeer_D"],
    ["\u1d40\u1d34\u1d31 small caps", "THE_small_caps"],
    ["H\u2082O x\u00b2", "H2O_x2"],
    ["Pin\u0303a n\u0341", "Pina"],
    ["Ste\u0340le Ange\u0341lique", "Stele_Angelique"],
    ["u\u0344", "_"],
  ],
};

describe('the file name', () => {
  test('the extension follows the format, as the server names the file (src/util/yt-dlp.js)', () => {
    assert.equal(Y.outputExtension('aac'), 'm4a');
    assert.equal(Y.outputExtension('m4b'), 'm4a');
    for (const codec of ['mp3', 'm4a', 'opus', 'ogg', 'flac', 'wav', 'aac', 'm4b']) {
      assert.equal(Y.outputExtension(codec), ytdlp.outputExtension(codec), codec);
      assert.equal(Y.fileNameFor('One_More_Time', codec) || null, ytdlp.fileNameFor('One_More_Time', codec), codec);
    }
    assert.equal(Y.fileNameFor('One_More_Time', 'mp3'), 'One_More_Time.mp3');
    assert.equal(Y.fileNameFor('Gorillaz_-_Feel_Good_Inc._Official_Video_HD', 'aac'), 'Gorillaz_-_Feel_Good_Inc._Official_Video_HD.m4a');
    assert.equal(Y.fileNameFor('', 'mp3'), '');
    assert.equal(Y.fileNameFor(null, 'mp3'), '');
    assert.equal(ytdlp.fileNameFor(null, 'mp3'), null);
  });

  test('letters dropped, held to every name the real yt-dlp gave: the stem decides, the title alone agrees', () => {
    let n = 0;
    let dropped = 0;
    for (const rows of Object.values(YTDLP_NAMES)) {
      for (const [title, stem] of rows) {
        n += 1;
        const byStem = Y.lettersDropped(title, stem);
        assert.equal(byStem, Y.lettersDropped(title, null), `${JSON.stringify(title)} → ${JSON.stringify(stem)}`);
        if (byStem) { dropped += 1; }
      }
    }
    assert.equal(n, 95, 'every fixture read');
    assert.ok(dropped > 10 && dropped < n, `some drop letters and some don't (${dropped})`);
    assert.equal(Y.lettersDropped('Кино – Группа крови', '_'), true);
    assert.equal(Y.lettersDropped('Beyoncé - Déjà Vu', 'Beyonce_-_Deja_Vu'), false);
    assert.equal(Y.lettersDropped('Ø Ð Þ ð þ ß Æ Œ', 'O_D_TH_o_th_ss_AE_OE'), false, 'two-letter spellings count as kept');
  });

  test("the phone's letters cases, on the title alone (no stem: an older answer, or a failed probe)", () => {
    for (const title of ['Кино – Группа крови', '米津玄師 - Lemon', 'official髭男dism - Pretender', 'İstanbul', 'Māori', 'Ma\u0304ori', 'Viê\u0323t', '안녕 Hello', 'Ελληνικά']) {
      assert.equal(Y.lettersDropped(title), true, title);
    }
    for (const title of ['One More Time', 'Beyoncé - Déjà Vu', 'Cafe\u0301 au lait', 'Ø Ð Þ ð þ ß Æ Œ', 'ﬁligree', '𝐁𝐨𝐥𝐝 Text', 'Ｆｕｌｌｗｉｄｔｈ', 'Nº ª', 'Heart \u2764\uFE0F \u{1F3B5}', '12:34 — ½ ™', '']) {
      assert.equal(Y.lettersDropped(title), false, title);
    }
  });

  test('a letter a newer yt-dlp learns to spell is kept by the stem, whatever the table says', () => {
    assert.equal(Y.lettersDropped('Łódź'), true, 'the table has no Ł or ź');
    assert.equal(Y.lettersDropped('Łódź', 'Lodz'), false, 'the stem kept every letter');
    assert.equal(Y.lettersDropped('Łódź', '_od_'), true);
  });

  test('the clash: the stem and the extension in the listing, ignoring case', () => {
    const files = [{ name: 'one_more_time.MP3' }, 'Feel_Good_Inc.opus'];
    assert.equal(Y.clashes({ fileStem: 'One_More_Time', codec: 'mp3', files }), true);
    assert.equal(Y.clashes({ fileStem: 'One_More_Time', codec: 'opus', files }), false, 'a different format makes a different file');
    assert.equal(Y.clashes({ fileStem: 'Feel_Good_Inc', codec: 'opus', files }), true);
    assert.equal(Y.clashes({ fileStem: 'One_More_Time', codec: 'aac', files: ['One_More_Time.m4a'] }), true, 'AAC lands as .m4a');
    assert.equal(Y.clashes({ fileStem: 'One_More_Time', codec: 'm4b', files: ['One_More_Time.m4a'] }), true);
    assert.equal(Y.clashes({ fileStem: 'One_More_Time', codec: 'mp3', files: null }), false, 'a folder that did not list');
    assert.equal(Y.clashes({ fileStem: null, codec: 'mp3', files: ['.mp3'] }), false, 'no stem, no name');
  });

  test("the card's file line: the clash names the file, else the letters line, else nothing", () => {
    assert.deepEqual(Y.nameCheck({ title: 'One More Time', fileStem: 'One_More_Time', codec: 'mp3', files: ['One_More_Time.mp3'] }), {
      name: 'One_More_Time.mp3', clash: true, lettersDropped: false,
      line: { tone: 'warn', label: { key: 'ytdl.clash', params: { name: 'One_More_Time.mp3' } }, link: { label: { key: 'ytdl.changeFormat' }, action: 'changeFormat' } },
    });
    assert.deepEqual(Y.nameCheck({ title: 'Кино – Группа крови', fileStem: '_', codec: 'mp3', files: [] }), {
      name: '_.mp3', clash: false, lettersDropped: true, line: { tone: 'note', label: { key: 'ytdl.file.lettersDropped', params: { name: '_.mp3' } }, link: null },
    });
    assert.equal(Y.nameCheck({ title: 'Кино – Группа крови', fileStem: '_', codec: 'mp3', files: ['_.MP3'] }).line.label.key, 'ytdl.clash');
    assert.equal(Y.nameCheck({ title: 'One More Time', fileStem: 'One_More_Time', codec: 'mp3', files: [] }).line, null);
    assert.equal(Y.nameCheck({ title: 'Кино', fileStem: null, codec: 'mp3', files: [] }).line, null, 'no name to show');
  });

  test('the middle ellipsis keeps the start, the extension and eight before it, by code point', () => {
    const gorillaz = 'Gorillaz_-_Feel_Good_Inc._Official_Video_HD.mp3';
    assert.equal(Y.middleEllipsis(gorillaz, 33), 'Gorillaz_-_Feel_Good…Video_HD.mp3');
    assert.equal(Y.middleEllipsis(gorillaz, gorillaz.length), gorillaz);
    assert.equal(Y.middleEllipsis(gorillaz, 100), gorillaz);
    assert.equal(Y.middleEllipsis('_.mp3', 5), '_.mp3');
    for (let max = 8; max < gorillaz.length; max++) {
      const cut = Y.middleEllipsis(gorillaz, max);
      assert.equal(cut.length, max, String(max));
      assert.ok(cut.endsWith('.mp3') && cut.includes('…') && cut.startsWith('G'), cut);
    }
    assert.equal(Y.middleEllipsis(gorillaz, 15), 'Gorilla…_HD.mp3');
    assert.equal(Y.middleEllipsis(gorillaz, 3), '…p3');
    assert.equal(Y.middleEllipsis(gorillaz, 1), '…');
    assert.equal(Y.middleEllipsis(gorillaz, 0), '');
    assert.equal(Y.middleEllipsis('abcdefghijklmnopqrstuvwxyz', 10), 'abcde…wxyz');
    assert.equal(Y.middleEllipsis('Mr.Brightside_The_Killers_Official', 12), 'Mr.Bri…icial');
    const emoji = Y.middleEllipsis('\u{1F3B5}'.repeat(12), 7);
    assert.equal(Array.from(emoji).length, 7);
    assert.equal(emoji, '\u{1F3B5}\u{1F3B5}\u{1F3B5}…\u{1F3B5}\u{1F3B5}\u{1F3B5}');
  });
});

// What MSTREAMAPI's req() throws: the server's answer with its words, one
// with no `{error}` (an HTML page, an empty body), and no answer at all.
const said = (status, words, extra) => Object.assign(new Error(`POST x failed: ${status}`), { status, body: { error: words, ...extra } });
const bare = (status) => Object.assign(new Error(`POST x failed: ${status}`), { status, body: null });
const aborted = () => new DOMException('This operation was aborted', 'AbortError');
const timedOut = () => new DOMException('The operation timed out.', 'TimeoutError');
const noAnswer = () => new TypeError('Failed to fetch');
const unreadable = () => new SyntaxError('Unexpected token < in JSON at position 0');
const pick = (f) => [f.problem, f.detail];

describe('failures: the add', () => {
  const rows = [
    // yt-dlp: 6.30+ wording and the older one.
    [said(500, 'yt-dlp is not installed'), ['ytdlpMissing', null]],
    [said(500, 'Error - failed to find yt-dlp'), ['ytdlpMissing', null]],
    [said(500, 'YT-DLP is not installed'), ['ytdlpMissing', null]],
    // The stale-flag fallback.
    [said(500, 'FFmpeg is not available yet'), ['ffmpegNotReady', null]],
    // Uploads off: the two gates, the federation wall, a jukebox session.
    [said(403, 'Uploading Disabled'), ['uploadsOff', null]],
    [said(403, 'Forbidden'), ['uploadsOff', null]],
    [said(403, 'not available in a jukebox session'), ['uploadsOff', null]],
    [bare(403), ['uploadsOff', null]],
    // A 404 naming the library (vpath.js), the name pulled out.
    [said(404, "Library 'Music' not found"), ['libraryGone', 'Music']],
    [said(404, 'User does not have access to path Music'), ['libraryGone', 'Music']],
    [said(404, "Library 'Old Vinyl' not found"), ['libraryGone', 'Old Vinyl']],
    // Any other 404 with words is quoted (the phone read it as a lost
    // library; this server also says "Folder not found").
    [said(404, 'Folder not found'), ['other', 'Folder not found']],
    [said(404, 'something else not found'), ['other', 'something else not found']],
    // Express's own 404: no such route.
    [bare(404), ['noRoute', null]],
    // A format the server turned off: Joi names the field.
    [said(400, '"outputCodec" must be one of [mp3, flac, wav, ogg, aac, m4a, m4b, opus]'), ['badFormat', null]],
    // Every other validation 400, and the sanitizer's.
    [said(400, '"url" must be a valid uri with a scheme matching the http|https pattern'), ['badRequest', null]],
    [said(400, '"url" failed custom validation because URL must be a YouTube link'), ['badRequest', null]],
    [said(400, '"url" is required'), ['badRequest', null]],
    [said(400, '"metadata.year" must be a string'), ['badRequest', null]],
    [said(400, '"foo" is not allowed'), ['badRequest', null]],
    [said(400, 'Invalid YouTube URL - missing video ID'), ['badRequest', null]],
    [bare(400), ['badRequest', null]],
    // A 400 that is not about the request's shape is quoted.
    [said(400, 'Not A Directory'), ['other', 'Not A Directory']],
    // The name check, before anything downloaded.
    [said(409, '“One_More_Time.mp3” is already in this folder, so nothing was added.', { reason: 'exists', fileName: 'One_More_Time.mp3' }), ['exists', 'One_More_Time.mp3']],
    [said(409, 'busy'), ['other', 'busy']],
    // The catch-all.
    [said(500, 'Server Error'), ['serverError', null]],
    [said(500, '  Server Error  '), ['serverError', null]],
    [bare(500), ['serverError', null]],
    // Anything else is quoted — the server's words, or the status.
    [said(500, 'Server Error: boom'), ['other', 'Server Error: boom']],
    [said(500, 'disk full'), ['other', 'disk full']],
    [said(429, 'slow down'), ['other', 'slow down']],
    [bare(502), ['other', 'HTTP 502']],
    // An `error` of only spaces is no words (the phone's YtdlApi._decode):
    // each reads as its bare status, never as an empty quote.
    [said(400, ''), ['badRequest', null]],
    [said(404, '  '), ['noRoute', null]],
    [said(500, ''), ['serverError', null]],
    [said(401, ' '), ['other', 'HTTP 401']],
    [said(409, '', { reason: 'exists', fileName: 'One_More_Time.mp3' }), ['exists', 'One_More_Time.mp3']],
    // No answer: the add may have started — a browser can't tell refused
    // from dropped, a client timeout doesn't stop the job, and a 2xx that
    // would not parse did start.
    [noAnswer(), ['startUnsure', null]],
    [aborted(), ['startUnsure', null]],
    [timedOut(), ['startUnsure', null]],
    [Object.assign(new Error('x'), { timedOut: true }), ['startUnsure', null]],
    [unreadable(), ['startUnsure', null]],
    [{ status: 0 }, ['startUnsure', null]],
    // Not a request failure at all: nothing to quote.
    [new RangeError('bug'), ['other', null]],
    [null, ['other', null]],
  ];
  for (const [err, want] of rows) {
    test(`${err && err.status !== undefined ? err.status : (err && err.name) || err} “${(err && err.body && err.body.error) || ''}” → ${want.join(' ')}`, () => {
      const f = Y.classifyAdd(err);
      assert.deepEqual(pick(f), want);
      assert.equal(f.phase, 'start');
    });
  }

  test('the 409 carries its reason and the server\'s words; a lost library is named from the folder when the words do not', () => {
    const f = Y.classifyAdd(said(409, '“One_More_Time.mp3” is already in this folder, so nothing was added.', { reason: 'exists', fileName: 'One_More_Time.mp3' }));
    assert.equal(f.reason, 'exists');
    assert.equal(f.text, '“One_More_Time.mp3” is already in this folder, so nothing was added.');
    assert.deepEqual(pick(Y.classifyAdd(said(409, 'x', { fileName: 'a.mp3' }))), ['exists', 'a.mp3']);
    assert.deepEqual(pick(Y.classifyAdd(said(404, 'User does not have access to path Music'), { directory: '/Mixes/x/' })), ['libraryGone', 'Music']);
  });
});

describe('failures: the lookup', () => {
  const rows = [
    [said(500, 'yt-dlp is not installed'), ['ytdlpMissing', null]],
    [said(500, 'Error - failed to find yt-dlp'), ['ytdlpMissing', null]],
    // yt-dlp exited non-zero: the route keeps the reason.
    [said(500, 'Server Error'), ['lookupFailed', null]],
    [bare(500), ['lookupFailed', null]],
    // A 200 this client could not read.
    [bare(200), ['lookupFailed', null]],
    [unreadable(), ['lookupFailed', null]],
    // Any 400 is about the link.
    [said(400, 'Invalid YouTube URL - missing video ID'), ['badRequest', null]],
    [said(400, '"url" is required'), ['badRequest', null]],
    [said(400, '"url" failed custom validation because URL must be a YouTube link'), ['badRequest', null]],
    [bare(400), ['badRequest', null]],
    [bare(404), ['noRoute', null]],
    // The lookup has no upload gate and names no library: quoted.
    [said(403, 'Forbidden'), ['other', 'Forbidden']],
    [said(404, "Library 'Music' not found"), ['other', "Library 'Music' not found"]],
    [said(500, 'FFmpeg is not available yet'), ['other', 'FFmpeg is not available yet']],
    [bare(503), ['other', 'HTTP 503']],
    // Blank words are no words.
    [said(500, '   '), ['lookupFailed', null]],
    [said(404, ''), ['noRoute', null]],
    [said(403, ' '), ['other', 'HTTP 403']],
    [aborted(), ['timedOut', null]],
    [timedOut(), ['timedOut', null]],
    [new RangeError('bug'), ['other', null]],
  ];
  for (const [err, want] of rows) {
    test(`${err.status !== undefined ? err.status : err.name} “${(err.body && err.body.error) || ''}” → ${want.join(' ')}`, () => {
      const f = Y.classifyLookup(err, { online: true });
      assert.deepEqual(pick(f), want);
      assert.equal(f.phase, 'lookup');
    });
  }

  test("no connection: navigator.onLine says whose — not knowing reads as the server", () => {
    assert.equal(Y.classifyLookup(noAnswer(), { online: false }).problem, 'offline');
    assert.equal(Y.classifyLookup(noAnswer(), { online: true }).problem, 'unreachable');
    assert.equal(Y.classifyLookup(noAnswer()).problem, 'unreachable');
  });

  test('where the lookup stands after a failure', () => {
    for (const [p, state] of [['ytdlpMissing', 'ytdlpMissing'], ['timedOut', 'timedOut'], ['offline', 'offline'], ['unreachable', 'unreachable'],
      ['lookupFailed', 'failed'], ['badRequest', 'failed'], ['noRoute', 'failed'], ['other', 'failed']]) {
      assert.equal(Y.lookupStateOf({ problem: p }), state, p);
    }
    assert.equal(Y.lookupStateOf(null), 'failed');
  });
});

describe('failures: mkdir', () => {
  const rows = [
    [said(403, 'Create Folder Disabled'), ['mkdirOff', null]],
    [said(404, "Library 'Music' not found"), ['libraryGone', 'Music']],
    [said(404, 'User does not have access to path Music'), ['libraryGone', 'Music']],
    [bare(404), ['noRoute', null]],
    // A file in the way of the folder.
    [said(500, 'Server Error'), ['serverError', null]],
    [bare(500), ['serverError', null]],
    [said(400, '"directory" is required'), ['badRequest', null]],
    [said(500, 'EACCES'), ['other', 'EACCES']],
    [said(500, ' '), ['serverError', null]],
    [said(400, ''), ['badRequest', null]],
    [aborted(), ['timedOut', null]],
    [noAnswer(), ['unreachable', null]],
  ];
  for (const [err, want] of rows) {
    test(`${err.status !== undefined ? err.status : err.name} “${(err.body && err.body.error) || ''}” → ${want.join(' ')}`, () => {
      assert.deepEqual(pick(Y.classifyMkdir(err)), want);
    });
  }

  test('as the add shows it: refused, a lost library or no connection stay; anything else names the folder', () => {
    const at = { folder: 'Discovery', directory: '/Music/Daft Punk/Discovery/', online: true };
    assert.deepEqual(pick(Y.mkdirFailure(said(403, 'Create Folder Disabled'), at)), ['mkdirOff', 'Discovery']);
    assert.deepEqual(pick(Y.mkdirFailure(said(404, "Library 'Music' not found"), at)), ['libraryGone', 'Music']);
    assert.deepEqual(pick(Y.mkdirFailure(noAnswer(), at)), ['unreachable', null]);
    assert.deepEqual(pick(Y.mkdirFailure(noAnswer(), { ...at, online: false })), ['offline', null]);
    for (const err of [said(500, 'Server Error'), said(500, 'EACCES'), aborted(), bare(404), said(400, '"directory" is required')]) {
      assert.deepEqual(pick(Y.mkdirFailure(err, at)), ['mkdirFailed', 'Discovery'], String(err.status || err.name));
    }
    assert.deepEqual(pick(Y.mkdirFailure(bare(500), { directory: '/Music/Daft Punk/Discovery/' })), ['mkdirFailed', 'Discovery'], "the path's last folder");
  });

  test('a 2xx whose body would not parse is no failure: the folder is there (the phone: any 2xx)', () => {
    const at = { folder: 'Discovery', directory: '/Music/Daft Punk/Discovery/', online: true };
    assert.equal(Y.mkdirFailure(unreadable(), at), null);
    assert.equal(Y.failureLabel(Y.mkdirFailure(unreadable(), at)), null);
    assert.deepEqual(Y.failureActions(Y.mkdirFailure(unreadable(), at)), []);
    // A thrown bug is still a failure.
    assert.deepEqual(pick(Y.mkdirFailure(new RangeError('bug'), at)), ['mkdirFailed', 'Discovery']);
  });
});

describe("failures: a job's entry", () => {
  test('every reason code the server sends reads as its own problem (src/api/ytdl-jobs.js REASONS)', () => {
    assert.deepEqual(Object.keys(Y.REASON_PROBLEMS).sort(), [...serverJobs.REASONS].sort());
    const entry = (over) => ({ id: 'a1', url: 'u', directory: '/Music/', outputCodec: 'mp3', status: 'error', startTime: 1, endTime: 2, fileName: null, filePath: null, downloadId: null, error: 'words', reason: null, ...over });
    assert.deepEqual(pick(Y.entryFailure(entry({ reason: 'exists', fileName: 'One_More_Time.mp3', error: 'a file named One_More_Time.mp3 already exists in Music — nothing was replaced' }))), ['exists', 'One_More_Time.mp3']);
    assert.deepEqual(pick(Y.entryFailure(entry({ reason: 'exists' }))), ['exists', null]);
    assert.deepEqual(pick(Y.entryFailure(entry({ reason: 'too-big' }))), ['tooBig', null]);
    assert.deepEqual(pick(Y.entryFailure(entry({ reason: 'too-long' }))), ['tooLong', null]);
    assert.deepEqual(pick(Y.entryFailure(entry({ reason: 'live' }))), ['live', null]);
    assert.deepEqual(pick(Y.entryFailure(entry({ reason: 'unavailable' }))), ['unavailable', null]);
    // The bot check and a stale yt-dlp are deliberately null: the words are the answer.
    assert.deepEqual(pick(Y.entryFailure(entry({ error: 'ERROR: [youtube] x: Sign in to confirm you’re not a bot.' }))), ['other', 'ERROR: [youtube] x: Sign in to confirm you’re not a bot.']);
    assert.deepEqual(pick(Y.entryFailure(entry({ reason: 'adding', error: 'a code from a newer server' }))), ['other', 'a code from a newer server']);
    assert.deepEqual(pick(Y.entryFailure(entry({ error: '  ' }))), ['unknown', null]);
    assert.deepEqual(pick(Y.entryFailure(entry({ error: null }))), ['unknown', null]);
    assert.equal(Y.entryFailure(entry({ status: 'downloading' })), null);
    assert.equal(Y.entryFailure(entry({ status: 'complete' })), null);
    assert.equal(Y.entryFailure(null), null);
    const f = Y.entryFailure(entry({ reason: 'too-long', error: 'yt-dlp took longer than 60 minutes — stopped' }));
    assert.equal(f.phase, 'download');
    assert.equal(f.reason, 'too-long');
    assert.equal(f.text, 'yt-dlp took longer than 60 minutes — stopped');
  });

  test("the server's own job entries, as ytdl-jobs.js writes them, read back", () => {
    const job = serverJobs.create({ userId: 7, pid: 123, url: 'https://www.youtube.com/watch?v=FGBhQbmPwH8', directory: '/Music/', outputCodec: 'mp3', fileName: 'One_More_Time.mp3', now: 1000 });
    serverJobs.fail(job, { error: 'a file named One_More_Time.mp3 already exists in Music — nothing was replaced', reason: 'exists', now: 2000 });
    const pub = JSON.parse(JSON.stringify(serverJobs.toPublic(job)));
    assert.deepEqual(pick(Y.entryFailure(pub)), ['exists', 'One_More_Time.mp3']);
    const other = serverJobs.create({ userId: 7, pid: 124, url: 'u', directory: '/Music/', outputCodec: 'mp3', now: 1000 });
    serverJobs.fail(other, { error: 'Sign in to confirm you’re not a bot.', reason: null, now: 2000 });
    assert.deepEqual(pick(Y.entryFailure(JSON.parse(JSON.stringify(serverJobs.toPublic(other))))), ['other', 'Sign in to confirm you’re not a bot.']);
  });

  test('the words to quote: the server\'s, never a bare status', () => {
    assert.equal(Y.serverWords({ problem: 'other', detail: 'Not A Directory' }), 'Not A Directory');
    assert.equal(Y.serverWords({ problem: 'other', detail: 'HTTP 502' }), null);
    assert.equal(Y.serverWords({ problem: 'other', detail: '  ' }), null);
    assert.equal(Y.serverWords({ problem: 'other', detail: null }), null);
    assert.equal(Y.serverWords({ problem: 'libraryGone', detail: 'Music' }), null);
    assert.equal(Y.serverWords(null), null);
  });
});

describe('failures in words, and their ways on', () => {
  const ctx = { server: 'Home server', codec: 'opus' };
  const add = (err, opts) => Y.classifyAdd(err, opts);

  test('inline above the panel\'s footer', () => {
    const rows = [
      [add(said(500, 'yt-dlp is not installed')), { key: 'ytdl.server.noYtdlp' }],
      [add(said(500, 'FFmpeg is not available yet')), { key: 'ytdl.err.ffmpeg' }],
      [add(said(403, 'Uploading Disabled')), { key: 'ytdl.err.uploadsOff' }],
      [Y.mkdirFailure(said(403, 'Create Folder Disabled'), { folder: 'Discovery' }), { key: 'ytdl.noMkdir.new', params: { folder: 'Discovery' } }],
      [Y.mkdirFailure(said(403, 'Create Folder Disabled'), {}), { key: 'ytdl.noMkdir.unchecked' }],
      [Y.mkdirFailure(bare(500), { folder: 'Discovery' }), { key: 'ytdl.err.mkdir', params: { folder: 'Discovery' } }],
      [add(said(404, "Library 'Music' not found")), { key: 'ytdl.err.libraryGone', params: { library: 'Music' } }],
      [add(bare(404)), { key: 'ytdl.err.noRoute' }],
      [add(said(400, '"outputCodec" must be one of [mp3]')), { key: 'ytdl.err.formatOff', params: { format: 'Opus' } }],
      [add(said(400, '"url" is required')), { key: 'ytdl.err.badRequest' }],
      [add(said(409, 'x', { reason: 'exists', fileName: 'One_More_Time.mp3' })), { key: 'ytdl.err.exists', params: { name: 'One_More_Time.mp3' } }],
      [add(said(409, '“x” is already in this folder', { reason: 'exists' })), { key: 'ytdl.err.said', params: { text: '“x” is already in this folder' } }],
      [Y.mkdirFailure(noAnswer(), { online: false }), { key: 'ytdl.err.addOffline' }],
      [Y.mkdirFailure(noAnswer(), { online: true }), { key: 'ytdl.err.addUnreachable', params: { server: 'Home server' } }],
      [add(noAnswer()), { key: 'ytdl.row.startUnsure' }],
      [add(said(400, 'Not A Directory')), { key: 'ytdl.err.said', params: { text: 'Not A Directory' } }],
      [add(bare(502)), { key: 'ytdl.err.server' }],
      [add(said(500, 'Server Error')), { key: 'ytdl.err.server' }],
      [add(new RangeError('bug')), { key: 'ytdl.err.server' }],
    ];
    for (const [f, want] of rows) { assert.deepEqual(Y.failureLabel(f, ctx), want, JSON.stringify(f)); }
  });

  test('the explorer window and a row: a lost library\'s first sentence; no connection is "Didn\'t start"', () => {
    const gone = add(said(404, "Library 'Music' not found"));
    assert.deepEqual(Y.failureLabel(gone, { ...ctx, surface: 'window' }), { key: 'ytdl.err.libraryGoneShort', params: { library: 'Music' } });
    assert.deepEqual(Y.failureLabel(gone, { ...ctx, surface: 'row' }), { key: 'ytdl.err.libraryGoneShort', params: { library: 'Music' } });
    assert.deepEqual(Y.failureLabel(Y.mkdirFailure(noAnswer(), { online: false }), { surface: 'row' }), { key: 'ytdl.row.didntStart' });
    assert.deepEqual(Y.failureLabel(Y.mkdirFailure(noAnswer(), { online: true }), { surface: 'row' }), { key: 'ytdl.row.didntStart' });
    assert.deepEqual(Y.failureLabel(add(said(400, 'Not A Directory')), { surface: 'row' }), { key: 'ytdl.err.said', params: { text: 'Not A Directory' } });
  });

  test("the lookup's line", () => {
    const look = (err, online = true) => Y.failureLabel(Y.classifyLookup(err, { online }), { surface: 'lookup', server: 'Home server' });
    assert.deepEqual(look(said(500, 'Server Error')), { key: 'ytdl.lookup.failed' });
    assert.deepEqual(look(aborted()), { key: 'ytdl.lookup.timedOut' });
    assert.deepEqual(look(said(500, 'yt-dlp is not installed')), { key: 'ytdl.server.noYtdlp' });
    assert.deepEqual(look(noAnswer(), false), { key: 'ytdl.server.offline' });
    assert.deepEqual(look(noAnswer(), true), { key: 'ytdl.server.unreachable', params: { server: 'Home server' } });
    assert.deepEqual(look(bare(404)), { key: 'ytdl.err.noRoute' });
    assert.deepEqual(look(said(400, '"url" is required')), { key: 'ytdl.err.badRequest' });
    assert.deepEqual(look(said(403, 'not available in a jukebox session')), { key: 'ytdl.err.said', params: { text: 'not available in a jukebox session' } });
    assert.deepEqual(look(bare(503)), { key: 'ytdl.err.server' });
    assert.deepEqual(Y.failureLabel(Y.classifyLookup(aborted()), { surface: 'panel' }), { key: 'ytdl.lookup.timedOut' }, 'a lookup failure reads as one anywhere');
  });

  test("a job's failure reads the same everywhere: its reason, the server's words, or the common causes", () => {
    const entry = (reason, error, fileName = null) => Y.entryFailure({ status: 'error', reason, error, fileName });
    const rows = [
      [entry('exists', 'x', 'One_More_Time.mp3'), { key: 'ytdl.reason.exists', params: { name: 'One_More_Time.mp3' } }],
      [entry('exists', 'x'), { key: 'ytdl.reason.existsUnnamed' }],
      [entry('too-big', 'x'), { key: 'ytdl.reason.tooBig' }],
      [entry('too-long', 'x'), { key: 'ytdl.reason.tooLong' }],
      [entry('live', 'x'), { key: 'ytdl.reason.live' }],
      [entry('unavailable', 'x'), { key: 'ytdl.reason.unavailable' }],
      [entry(null, 'Sign in to confirm you’re not a bot.'), { key: 'ytdl.row.failedSaid', params: { text: 'Sign in to confirm you’re not a bot.' } }],
      [entry(null, null), { key: 'ytdl.row.failedUnknown' }],
    ];
    for (const [f, want] of rows) {
      for (const surface of ['panel', 'window', 'row', 'lookup']) { assert.deepEqual(Y.failureLabel(f, { surface }), want, `${f.problem} ${surface}`); }
    }
    assert.equal(Y.failureLabel(null), null);
  });

  test('ways on: no retry that would fail the same way; Change format only with another format', () => {
    const formats = ['mp3', 'opus'];
    const acts = (f, c = { formats }) => Y.failureActions(f, c);
    const entry = (reason, error) => Y.entryFailure({ status: 'error', reason, error, fileName: null });
    assert.deepEqual(acts(entry('exists', 'x')), ['changeFormat', 'dismiss']);
    assert.deepEqual(acts(entry('exists', 'x'), { formats: ['mp3'] }), ['dismiss']);
    assert.deepEqual(acts(entry('too-big', 'x')), ['changeFormat', 'dismiss']);
    assert.deepEqual(acts(entry('unavailable', 'x')), ['dismiss']);
    assert.deepEqual(acts(entry('too-long', 'x')), ['retry', 'dismiss']);
    assert.deepEqual(acts(entry('live', 'x')), ['retry', 'dismiss']);
    assert.deepEqual(acts(entry(null, 'Sign in')), ['retry', 'dismiss']);
    assert.deepEqual(acts(entry(null, null)), ['retry', 'dismiss']);
    assert.deepEqual(acts(Y.mkdirFailure(bare(500), { folder: 'Discovery' })), ['retry', 'chooseFolder', 'dismiss']);
    assert.deepEqual(acts(Y.mkdirFailure(said(403, 'Create Folder Disabled'), { folder: 'Discovery' })), ['topOfLibrary', 'chooseFolder', 'dismiss']);
    for (const err of [said(403, 'Uploading Disabled'), said(404, "Library 'Music' not found"), bare(404)]) { assert.deepEqual(acts(add(err)), ['dismiss'], String(err.status)); }
    assert.deepEqual(acts(add(said(400, '"outputCodec" must be one of [mp3]'))), ['changeFormat', 'dismiss']);
    assert.deepEqual(acts(add(said(409, 'x', { reason: 'exists', fileName: 'a.mp3' }))), ['changeFormat', 'dismiss']);
    assert.deepEqual(acts(add(noAnswer())), ['checkAgain', 'dismiss']);
    assert.deepEqual(acts(Y.mkdirFailure(noAnswer(), {})), ['retry', 'dismiss']);
    assert.deepEqual(acts(add(said(500, 'disk full'))), ['retry', 'dismiss']);
    assert.deepEqual(Y.failureActions(add(said(409, 'x', { reason: 'exists', fileName: 'a.mp3' }))), ['changeFormat', 'dismiss'], 'formats unknown: offered');
    assert.deepEqual(Y.failureActions(null), []);
  });
});

describe('why Add is off', () => {
  const video = Y.parseLink('https://youtu.be/FGBhQbmPwH8');
  const ready = { link: video, lookup: 'found', targetValid: true, year: '2001' };

  test('nothing in the way: none', () => {
    assert.equal(Y.addBlock(ready), 'none');
    assert.equal(Y.addBlock({ ...ready, link: undefined, linkKind: 'video' }), 'none');
  });

  test("the phone's order: each reason wins over every one after it", () => {
    const order = [
      ['convertOff', { convertOff: true }],
      ['noLink', { link: Y.parseLink('https://vimeo.com/1') }],
      ['offline', { lookup: 'offline' }],
      ['unreachable', { lookup: 'unreachable' }],
      ['ytdlpMissing', { lookup: 'ytdlpMissing' }],
      ['lookingUp', { lookup: 'loading' }],
      ['uploadsOff', { uploadsOff: true }],
      ['alreadyAdding', { alreadyAdding: true }],
      ['invalidLayout', { targetValid: false }],
      ['yearInvalid', { year: '01' }],
      ['mkdirBlocked', { mkdirBlocked: true }],
    ];
    for (let i = 0; i < order.length; i++) {
      // This reason and every later one hold: this one is the answer.
      const s = { ...ready };
      // (Applied last to first, so of the four lookup states the one under
      // test is the one set.)
      for (let j = order.length - 1; j >= i; j--) { Object.assign(s, order[j][1]); }
      assert.equal(Y.addBlock(s), order[i][0], order[i][0]);
    }
  });

  test('looking up: until found, unless the details are entered by hand; idle, slow and unknown too', () => {
    for (const lookup of ['idle', 'loading', 'slow', undefined]) { assert.equal(Y.addBlock({ ...ready, lookup }), 'lookingUp', String(lookup)); }
    assert.equal(Y.addBlock({ ...ready, lookup: 'slow', manual: true }), 'none');
    assert.equal(Y.addBlock({ ...ready, lookup: 'failed' }), 'none', 'a failed lookup leaves Add on: the fields are open');
    assert.equal(Y.addBlock({ ...ready, lookup: 'timedOut' }), 'none');
    assert.equal(Y.addBlock({ ...ready, lookup: 'offline', manual: true }), 'offline', 'no connection blocks a hand-made add too');
  });

  test("this surface's own add starting is not 'already adding'; an explicit yearInvalid wins over the field", () => {
    assert.equal(Y.addBlock({ ...ready, alreadyAdding: true, starting: true }), 'none');
    assert.equal(Y.addBlock({ ...ready, year: '01', yearInvalid: false }), 'none');
    assert.equal(Y.addBlock({ ...ready, year: '2001', yearInvalid: true }), 'yearInvalid');
    assert.equal(Y.addBlock({ ...ready, year: '' }), 'none');
    assert.equal(Y.addBlock(), 'noLink');
  });

  test('a clash is never a block on the web: the server is its own release, so it is "Add anyway"', () => {
    assert.equal(Y.addBlock({ ...ready, clash: true, clashOlder: true }), 'none');
    assert.deepEqual(Y.addButtonLabel({ surface: 'panel', clash: true }), { key: 'ytdl.addAnyway' });
    assert.deepEqual(Y.addButtonLabel({ surface: 'window', clash: true }), { key: 'ytdl.addAnyway' });
  });

  test('the reason on screen, never only in a tooltip', () => {
    const rows = [
      ['convertOff', { key: 'ytdl.err.ffmpeg' }],
      ['offline', { key: 'ytdl.server.offline' }],
      ['unreachable', { key: 'ytdl.server.unreachable', params: { server: 'Home server' } }],
      ['ytdlpMissing', { key: 'ytdl.server.noYtdlp' }],
      ['uploadsOff', { key: 'ytdl.err.uploadsOff' }],
      ['alreadyAdding', { key: 'ytdl.alreadyAdding' }],
      ['invalidLayout', { key: 'ytdl.where.fixLayout' }],
      ['yearInvalid', { key: 'ytdl.yearInvalid' }],
      ['lookingUp', null], ['noLink', null], ['mkdirBlocked', null], ['none', null],
    ];
    for (const [block, want] of rows) { assert.deepEqual(Y.blockLabel(block, { server: 'Home server' }), want, block); }
  });

  test("the primary's words", () => {
    assert.deepEqual(Y.addButtonLabel({ surface: 'panel' }), { key: 'ytdl.add' });
    assert.deepEqual(Y.addButtonLabel({ surface: 'window' }), { key: 'ytdl.addHere' });
    assert.deepEqual(Y.addButtonLabel(), { key: 'ytdl.add' });
    assert.deepEqual(Y.addButtonLabel({ surface: 'window', clash: true, starting: true }), { key: 'ytdl.adding' });
  });
});

describe('the module itself', () => {
  test('a browser loads it as window.YTDLCORE, after discover-jobs.js or before it', () => {
    const fakeSelf = { DISCOVERJOBS: J };
    new Function('self', 'module', 'require', SRC)(fakeSelf, undefined, undefined);
    assert.equal(typeof fakeSelf.YTDLCORE.parseLink, 'function');
    assert.equal(fakeSelf.YTDLCORE.target({ vpath: 'Music', layout: '{{ALBUM}}', tags: DAFT_PUNK }).directory, '/Music/Discovery/');
    // Loaded first: the engine is read when it is needed.
    const early = {};
    new Function('self', 'module', 'require', SRC)(early, undefined, undefined);
    assert.throws(() => early.YTDLCORE.target({ vpath: 'Music', layout: '{{ALBUM}}', tags: DAFT_PUNK }), /discover-jobs\.js/);
    globalThis.DISCOVERJOBS = J;
    try {
      assert.equal(early.YTDLCORE.target({ vpath: 'Music', layout: '{{ALBUM}}', tags: DAFT_PUNK }).directory, '/Music/Discovery/');
    } finally {
      delete globalThis.DISCOVERJOBS;
    }
  });

  test('no DOM, no fetch, no storage, no timers', () => {
    // The code without its comments and its string literals (an error
    // message may name window.DISCOVERJOBS).
    const code = SRC.replace(/\/\/[^\n]*/g, '').replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
    for (const word of [/\bdocument\b/, /\bwindow\b/, /\blocalStorage\b/, /\bsessionStorage\b/, /\bfetch\s*\(/, /\bsetTimeout\b/, /\bsetInterval\b/, /\bnavigator\b/, /\bMSTREAMAPI\b/]) {
      assert.doesNotMatch(code, word, String(word));
    }
  });
});

describe('i18n: labels are keys', () => {
  test('KEYS is unique, and every key is a ytdl.* key', () => {
    assert.equal(new Set(RAW.KEYS).size, RAW.KEYS.length, 'no key twice');
    for (const k of RAW.KEYS) { assert.match(k, /^ytdl\.[a-zA-Z0-9.]+$/, k); }
  });

  test('every key the module names in its source is in KEYS, and nothing builds a key from parts', () => {
    const named = new Set([...SRC.matchAll(/'(ytdl\.[A-Za-z0-9.]+)'/g)].map((m) => m[1]));
    for (const k of named) { assert.ok(RAW.KEYS.includes(k), `${k} is in KEYS`); }
    for (const k of RAW.KEYS) { assert.ok(named.has(k), `${k} is named literally`); }
    assert.doesNotMatch(SRC, /'ytdl\.[A-Za-z0-9.]*\.'\s*\+/, 'no key is built by concatenation');
  });

  test('every key in KEYS was returned by some case above, and every label returned is in KEYS', () => {
    for (const k of EMITTED.keys()) { assert.ok(RAW.KEYS.includes(k), `${k} (returned) is in KEYS`); }
    const missing = RAW.KEYS.filter((k) => !EMITTED.has(k));
    assert.deepEqual(missing, [], 'keys no case returned');
  });

  test('params are strings or numbers, and every key always gets the same params', () => {
    for (const [key, seen] of EMITTED) {
      const shapes = new Set(seen.map((p) => (p ? Object.keys(p).sort().join(',') : '')));
      assert.equal(shapes.size, 1, `${key} params ${[...shapes].join(' | ')}`);
      for (const p of seen) {
        for (const v of Object.values(p || {})) { assert.ok(typeof v === 'string' || typeof v === 'number', `${key}: ${JSON.stringify(p)}`); }
      }
    }
  });
});
