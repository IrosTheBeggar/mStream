/**
 * The web player's shuffle (webapp/assets/js/mstream.player.js): the cycle
 * Next pops songs from (shuffleCache) and the history Previous walks back
 * through (shufflePrevious).
 *
 * A song that started under shuffle without a Next popping it, from a
 * queue row's click or as the first row of an empty queue (it plays as it
 * is added), stayed in the cycle. So it came round again before the rest of
 * the queue had played, and it never joined the history, so Previous could
 * not go back to it, nor to a song started by Play now. The song playing
 * when shuffle was turned on stayed in the cycle too. Such a song now
 * leaves the cycle and joins the history, as a popped one does. Turning
 * shuffle on leaves the playing song out of the first cycle, and a cycle
 * emptied that way starts over at the next Next.
 *
 * What did not change is pinned beside it. A queue of one plays its song
 * again. With shuffle off, Next, Previous and a row click walk the queue in
 * order. Turning shuffle off forgets the cycle and the history. Repeat
 * wraps a queue played in order, and a shuffle never reads it. A removed
 * row never plays and Previous never goes back to it. The Auto DJ turns
 * shuffle off, so its rows play in order.
 *
 * The whole player runs in a vm context (as in webapp-replaygain), with
 * stub audio elements and a seeded Math.random. Each property is checked
 * over many seeds.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLAYER_PATH = path.resolve(__dirname, '..', '..', 'webapp', 'assets', 'js', 'mstream.player.js');
const PLAYER = new vm.Script(
  `${fs.readFileSync(PLAYER_PATH, 'utf8')}\nglobalThis.MSTREAMPLAYER = MSTREAMPLAYER;`,
  { filename: PLAYER_PATH },
);
const SEEDS = 40;

// A small deterministic PRNG (mulberry32): the player's Math.random.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A fresh player: its shuffle lives in the module's closure.
function loadPlayer(seed) {
  class Audio {
    constructor() { this.playbackRate = 1; this.currentTime = 0; this.paused = true; this.volume = 1; this.src = ''; }
    addEventListener() {}
    load() {}
    pause() { this.paused = true; }
    play() { this.paused = false; return Promise.resolve(); }
  }
  const ctx = vm.createContext({
    Audio,
    navigator: {},
    // The shuffle logs 'DUPEEEEE' when a new cycle would start on the song playing.
    console: { ...console, log() {} },
    document: { title: '' },
    // The player arms a next-song cache timer on every song change; a real
    // one would hold the test runner open.
    setTimeout: () => 0,
    clearTimeout: () => {},
    // The Auto DJ's pick (no server here) fails quietly into a toast.
    AbortController,
    iziToast: { warning() {}, info() {}, error() {} },
    __random: prng(seed),
  });
  vm.runInContext('Math.random = __random;', ctx);
  PLAYER.runInContext(ctx);
  return ctx.MSTREAMPLAYER;
}

const song = (name) => ({ url: `media/${name}.mp3?`, filepath: `${name}.mp3`, rawFilePath: `${name}.mp3`, metadata: {} });
const rows = (prefix, n) => Array.from({ length: n }, (_, i) => song(`${prefix}${i}`));
const names = (songs) => songs.map((s) => (s ? s.filepath : String(s)));
const cur = (p) => p.getCurrentSong();
// Rows added as the add verbs add them: the first plays if the queue was empty.
const queue = (p, songs) => songs.forEach((s, i) => p.addSong(s, i > 0));
// `count` Nexts; the songs they played.
function nexts(p, count) {
  const played = [];
  for (let i = 0; i < count; i++) {
    p.nextSong();
    played.push(cur(p));
  }
  return played;
}
// Whether `act` left the song playing untouched: a song change (a restart
// too) starts it from 0.
function leavesSong(p, act) {
  const before = cur(p);
  p.playerStats.currentTime = 42;
  act();
  return cur(p) === before && p.playerStats.currentTime === 42;
}
const sorted = (songs) => names(songs).sort();

describe('shuffle: a song that starts without a Next', () => {
  test('a queue row clicked under shuffle does not come round again before the rest have played, and Previous goes back to it', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const p = loadPlayer(seed);
      const list = rows('r', 12);
      queue(p, list);
      p.toggleShuffle();
      const heard = new Set([cur(p), ...nexts(p, 2)]);
      const clicked = list.find((s) => !heard.has(s));
      p.goToSongAtPosition(list.indexOf(clicked));
      assert.equal(cur(p), clicked);
      const rest = list.filter((s) => !heard.has(s) && s !== clicked);

      p.nextSong();
      const next = cur(p);
      p.previousSong();
      assert.equal(cur(p), clicked, `seed ${seed}: Previous goes back to the clicked row`);
      p.nextSong();
      assert.equal(cur(p), next, `seed ${seed}: and Next to where it was`);
      const played = [next, ...nexts(p, rest.length - 1)];
      assert.deepEqual(sorted(played), sorted(rest), `seed ${seed}: the rest of the cycle, each once, without the clicked row`);
    }
  });

  test('the first row of an empty queue, which plays as it is added, does not come round again before the rest, and Previous goes back to it', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const p = loadPlayer(seed);
      p.toggleShuffle();
      const list = rows('m', 10);
      queue(p, list);
      assert.equal(cur(p), list[0]);

      p.nextSong();
      const next = cur(p);
      p.previousSong();
      assert.equal(cur(p), list[0], `seed ${seed}: Previous goes back to row 1`);
      assert.equal(p.positionCache.val, 0);
      p.nextSong();
      assert.equal(cur(p), next);
      const played = [next, ...nexts(p, list.length - 2)];
      assert.deepEqual(sorted(played), sorted(list.slice(1)), `seed ${seed}: every other row once, before row 1 comes round`);
    }
  });

  test('turning shuffle on leaves the song playing out of the first cycle (toggleShuffle and setShuffle)', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      for (const turnOn of [(p) => p.toggleShuffle(), (p) => p.setShuffle(true)]) {
        const p = loadPlayer(seed);
        const list = rows('s', 8);
        queue(p, list);
        p.goToSongAtPosition(3);
        turnOn(p);
        assert.equal(p.playerStats.shuffle, true);
        const played = nexts(p, list.length - 1);
        assert.deepEqual(sorted(played), sorted(list.filter((s) => s !== list[3])), `seed ${seed}: every other row once, before the one playing comes round`);
      }
    }
  });

  test('a Play now under shuffle joins the history: Previous goes back to it and on to the song before, and it waits for the next cycle', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const p = loadPlayer(seed);
      const list = rows('p', 8);
      queue(p, list);
      p.toggleShuffle();
      const heard = nexts(p, 2);
      // Play now (a folder row's, a search hit's): inserted after the song
      // playing, and played (VUEPLAYERCORE.addSongWizard with a position)
      const now = song('now');
      p.insertSongAt(now, p.positionCache.val + 1, true);
      assert.equal(cur(p), now);

      p.nextSong();
      const next = cur(p);
      assert.notEqual(next, now);
      p.previousSong();
      assert.equal(cur(p), now, `seed ${seed}: Previous goes back to the Play now song`);
      p.previousSong();
      assert.equal(cur(p), heard[1], `seed ${seed}: and on to the song before it`);
      p.nextSong();
      assert.equal(cur(p), now, `seed ${seed}: Next walks forward again`);
      p.nextSong();
      assert.equal(cur(p), next, `seed ${seed}`);
      const rest = list.filter((s) => s !== list[0] && !heard.includes(s));
      const played = [next, ...nexts(p, rest.length - 1)];
      assert.deepEqual(sorted(played), sorted(rest), `seed ${seed}: the rest of the cycle, without the Play now song`);
    }
  });

  test('a click on the last song a cycle had left: the next Next starts a new cycle with another song, not that one again', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const p = loadPlayer(seed);
      const list = rows('t', 6);
      queue(p, list);
      p.toggleShuffle();
      const heard = new Set([cur(p), ...nexts(p, 4)]);
      const last = list.find((s) => !heard.has(s));
      p.goToSongAtPosition(list.indexOf(last));
      assert.equal(leavesSong(p, () => p.nextSong()), false, `seed ${seed}: Next moves on`);
      assert.notEqual(cur(p), last, `seed ${seed}: to another song`);
      const cycle = [cur(p), ...nexts(p, list.length - 1)];
      assert.deepEqual(sorted(cycle), sorted(list), `seed ${seed}: the new cycle plays every row once`);
    }
  });
});

describe('shuffle: what did not change', () => {
  test('a queue of one under shuffle: Next plays it again from the start, and Previous does nothing', () => {
    const p = loadPlayer(1);
    p.toggleShuffle();
    const [only] = rows('o', 1);
    p.addSong(only);
    assert.equal(leavesSong(p, () => p.nextSong()), false);
    assert.equal(cur(p), only);
    assert.equal(leavesSong(p, () => p.previousSong()), true);
    assert.equal(leavesSong(p, () => p.nextSong()), false);
    assert.equal(cur(p), only);
  });

  test('with shuffle off, Next, Previous and a row click walk the queue in order, and a cleared queue starts at its first row', () => {
    const p = loadPlayer(1);
    const list = rows('q', 5);
    queue(p, list);
    assert.equal(cur(p), list[0]);
    assert.deepEqual(names(nexts(p, 2)), ['q1.mp3', 'q2.mp3']);
    p.previousSong();
    assert.equal(cur(p), list[1]);
    p.goToSongAtPosition(3);
    assert.deepEqual(names(nexts(p, 1)), ['q4.mp3']);
    assert.equal(leavesSong(p, () => p.nextSong()), true, 'the end of the queue: Next stays');
    p.previousSong();
    assert.equal(cur(p), list[3]);

    p.clearPlaylist();
    const next = rows('n', 3);
    queue(p, next);
    assert.equal(cur(p), next[0]);
    assert.deepEqual(names(nexts(p, 2)), ['n1.mp3', 'n2.mp3']);
    p.previousSong();
    assert.equal(cur(p), next[1]);
  });

  test('turning shuffle off forgets the cycle and the history, and turning it on again starts both over', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const p = loadPlayer(seed);
      const list = rows('g', 6);
      queue(p, list);
      assert.equal(p.toggleShuffle(), true);
      nexts(p, 3);
      assert.equal(p.toggleShuffle(), false);
      // In order again: Previous and Next by position.
      const at = p.positionCache.val;
      if (at > 0) {
        p.previousSong();
        assert.equal(cur(p), list[at - 1]);
        p.nextSong();
      } else {
        p.nextSong();
        assert.equal(cur(p), list[1]);
        p.previousSong();
      }
      assert.equal(cur(p), list[at]);
      assert.equal(p.toggleShuffle(), true);
      // No history from before: Previous has nothing to go back to until a
      // second shuffled song has played.
      p.nextSong();
      assert.equal(leavesSong(p, () => p.previousSong()), true, `seed ${seed}`);
    }
  });

  test('repeat wraps a queue played in order; under shuffle Next never reads it', () => {
    const p = loadPlayer(1);
    const list = rows('w', 3);
    queue(p, list);
    p.goToSongAtPosition(2);
    p.toggleRepeat();
    assert.equal(p.playerStats.shouldLoop, true);
    p.nextSong();
    assert.equal(cur(p), list[0], 'repeat all: the last row goes on to the first');
    p.goToSongAtPosition(2);
    p.toggleRepeat();
    assert.equal(p.playerStats.shouldLoopOne, true);
    assert.equal(leavesSong(p, () => p.nextSong()), true, 'repeat one: Next at the end stays');
    p.toggleRepeat();
    assert.equal(leavesSong(p, () => p.nextSong()), true, 'repeat off: Next at the end stays');

    for (let seed = 1; seed <= SEEDS; seed++) {
      const runs = [0, 1, 2].map((presses) => {
        const s = loadPlayer(seed);
        queue(s, rows('w', 5));
        s.toggleShuffle();
        for (let i = 0; i < presses; i++) { s.toggleRepeat(); }
        return names(nexts(s, 15));
      });
      assert.deepEqual(runs[1], runs[0], `seed ${seed}: repeat all changes no shuffled Next`);
      assert.deepEqual(runs[2], runs[0], `seed ${seed}: nor does repeat one`);
    }
  });

  test('under shuffle a removed row never plays, and Previous never goes back to it', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const p = loadPlayer(seed);
      const list = rows('x', 8);
      queue(p, list);
      p.toggleShuffle();
      const [first] = nexts(p, 1);
      // A clicked row, removed while it plays: a shuffled row follows.
      const clicked = list.find((s) => s !== first && s !== list[0]);
      p.goToSongAtPosition(list.indexOf(clicked));
      p.removeSongAtPosition(p.positionCache.val);
      assert.ok(cur(p) !== clicked && p.playlist.includes(cur(p)), `seed ${seed}: the next shuffled row plays`);
      p.previousSong();
      assert.equal(cur(p), first, `seed ${seed}: Previous skips the removed row`);
      // A row not played yet, removed: never played after.
      const gone = p.playlist.find((s) => s !== cur(p));
      p.removeSongAtPosition(p.playlist.indexOf(gone));
      const played = nexts(p, 3 * p.playlist.length);
      assert.ok(!played.includes(gone) && !played.includes(clicked), `seed ${seed}: ${names(played)}`);
      assert.ok(played.every((s) => p.playlist.includes(s)));
    }
  });

  test("the Auto DJ turns shuffle off and keeps it off; the rows it adds play in order", async () => {
    const p = loadPlayer(1);
    queue(p, rows('a', 3));
    p.toggleShuffle();
    p.nextSong();
    p.toggleAutoDJ();
    assert.equal(p.playerStats.autoDJ, true);
    assert.equal(p.playerStats.shuffle, false);
    assert.equal(p.toggleShuffle(), undefined, 'shuffle is refused while the Auto DJ is on');
    p.setShuffle(true);
    assert.equal(p.playerStats.shuffle, false);
    p.clearPlaylist();
    // The DJ's picks land as plain adds (VUEPLAYERCORE.addSongWizard).
    const picks = rows('dj', 4);
    picks.forEach((s) => p.addSong(s));
    assert.equal(cur(p), picks[0]);
    assert.deepEqual(names(nexts(p, 3)), ['dj1.mp3', 'dj2.mp3', 'dj3.mp3']);
    p.previousSong();
    assert.equal(cur(p), picks[2]);
    // Let the DJ's own picks (no server here) settle.
    await new Promise((resolve) => setImmediate(resolve));
  });
});
