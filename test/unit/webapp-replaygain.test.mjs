/**
 * ReplayGain in the web player (webapp/assets/js/mstream.player.js).
 *
 * With ReplayGain on, the player scales each song's volume by its track gain:
 * amp = 10^((gain dB + pre-gain dB) / 20), and a song with no gain gets a
 * fixed -10 dB (0.316). The server sends the gain as `replaygain-track`
 * (renderMetadataObj); the player read `replaygain-track-db`, a spelling the
 * server has not sent since the SQLite rewrite, so every song fell into the
 * "no ReplayGain info" branch and played at -10 dB whatever its tag said. A
 * 0 dB gain was also treated as missing (`if (rgainDb)`).
 *
 * webapp/ has no browser test harness, and the player is one IIFE, so this
 * evaluates the real file in a vm context with stub browser globals and
 * reads the volume the player sets on its two audio elements.
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLAYER_PATH = path.resolve(__dirname, '..', '..', 'webapp', 'assets', 'js', 'mstream.player.js');
const SRC = fs.readFileSync(PLAYER_PATH, 'utf8');

const NO_GAIN_AMP = 0.316; // the player's -10 dB for songs without ReplayGain info
const ampOf = (db) => Math.pow(10, db / 20);

// A fresh player per test: the module keeps its ReplayGain amp in a closure.
function loadPlayer() {
  const audios = [];
  class Audio {
    constructor() { this.volume = 1; this.playbackRate = 1; this.currentTime = 0; audios.push(this); }
    addEventListener() {}
    load() {}
    pause() {}
    play() { return Promise.resolve(); }
  }
  const ctx = vm.createContext({
    Audio,
    navigator: {},
    console,
    document: { title: '' },
    // The player arms a 30 s next-song cache timer on every song change;
    // a real one would hold the test runner open.
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  vm.runInContext(`${SRC}\nglobalThis.MSTREAMPLAYER = MSTREAMPLAYER;`, ctx, { filename: PLAYER_PATH });
  const player = ctx.MSTREAMPLAYER;
  // Both elements always get the same volume (changeVolume sets the pair).
  const volume = () => {
    assert.equal(audios.length, 2);
    assert.equal(audios[0].volume, audios[1].volume);
    return audios[0].volume;
  };
  return { player, volume };
}

describe('web player ReplayGain', () => {
  let player, volume;
  beforeEach(() => {
    ({ player, volume } = loadPlayer());
    player.playerStats.replayGain = true;
    player.playerStats.replayGainPreGainDb = 0;
  });

  test('applies the gain the server sends as replaygain-track', () => {
    player.updateReplayGainFromSong({ metadata: { 'replaygain-track': -6 } });
    assert.ok(Math.abs(volume() - ampOf(-6)) < 1e-9, `expected ${ampOf(-6)}, got ${volume()}`);
  });

  test('adds the pre-gain and scales with the volume setting', () => {
    player.playerStats.replayGainPreGainDb = 3;
    player.playerStats.volume = 50;
    player.updateReplayGainFromSong({ metadata: { 'replaygain-track': -9.5 } });
    assert.ok(Math.abs(volume() - 0.5 * ampOf(-6.5)) < 1e-9);
  });

  test('a 0 dB gain plays as is, not as a missing gain', () => {
    player.updateReplayGainFromSong({ metadata: { 'replaygain-track': 0 } });
    assert.equal(volume(), 1);
  });

  test('still reads the pre-SQLite replaygain-track-db spelling (old peers)', () => {
    player.updateReplayGainFromSong({ metadata: { 'replaygain-track-db': -6 } });
    assert.ok(Math.abs(volume() - ampOf(-6)) < 1e-9);
  });

  test('replaygain-track wins when a song carries both spellings', () => {
    player.updateReplayGainFromSong({ metadata: { 'replaygain-track': -3, 'replaygain-track-db': -12 } });
    assert.ok(Math.abs(volume() - ampOf(-3)) < 1e-9);
  });

  test('no usable gain falls back to -10 dB', () => {
    for (const metadata of [{}, { 'replaygain-track': null }, { 'replaygain-track': 'loud' }, undefined]) {
      player.updateReplayGainFromSong({ metadata });
      assert.equal(volume(), NO_GAIN_AMP, `metadata ${JSON.stringify(metadata)}`);
    }
  });

  test('ReplayGain off ignores the gain', () => {
    player.playerStats.replayGain = false;
    player.updateReplayGainFromSong({ metadata: { 'replaygain-track': -6 } });
    assert.equal(volume(), 1);
  });

  test('a song change copies the gain to the now-playing stats and applies it', () => {
    player.addSong({ url: 'media/a.flac', filepath: 'a.flac', metadata: { title: 'A', 'replaygain-track': -6 } }, true);
    player.addSong({ url: 'media/b.flac', filepath: 'b.flac', metadata: { title: 'B', 'replaygain-track': 0 } }, true);

    player.goToSongAtPosition(0);
    assert.equal(player.playerStats.metadata['replaygain-track-db'], -6);
    assert.ok(Math.abs(volume() - ampOf(-6)) < 1e-9);

    player.goToSongAtPosition(1);
    assert.equal(player.playerStats.metadata['replaygain-track-db'], 0);
    assert.equal(volume(), 1);
  });
});
