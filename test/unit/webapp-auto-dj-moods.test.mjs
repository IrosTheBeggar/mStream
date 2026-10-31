/**
 * Auto DJ's mood filter in the player (webapp/assets/js/mstream.player.js;
 * the state lives in webapp/alpha/auto-dj.js, the server half is
 * src/api/random.js + src/api/mood-filter.js).
 *
 * What is pinned:
 *   - the random-songs body carries `moods` only while the panel's toggle
 *     is on, something is set, and the ping says this server can filter —
 *     the route's schema is strict, so any other server would 400 every
 *     pick;
 *   - a cross-server pick drops an answer that came back without the
 *     filter's echo (a server with no mood scores picked unfiltered), even
 *     when its song is the closest match — and keeps it when nothing was
 *     asked of it, or when it did echo.
 *
 * The player's functions are sliced out of the file and run against the
 * real AUTODJ module and stub servers, the technique of the other webapp
 * sandbox tests.
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLAYER = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webapp', 'assets', 'js', 'mstream.player.js'), 'utf8');

// The module reads localStorage when it loads: a Map-backed shim first.
const _store = new Map();
globalThis.localStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _store.set(k, String(v)); },
  removeItem: (k) => { _store.delete(k); },
  clear: () => { _store.clear(); },
  get length() { return _store.size; },
  key: (i) => Array.from(_store.keys())[i] ?? null,
};
const AUTODJ = require('../../webapp/alpha/auto-dj.js');

beforeEach(() => {
  _store.clear();
  AUTODJ._internals.rehydrate();
  AUTODJ.reset();
});

// A function inside the player's module closure: two-space indent, ends at
// the first line that is exactly `  }`.
function sliceFn(name) {
  const lines = PLAYER.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`  function ${name}(`) || l.startsWith(`  async function ${name}(`));
  assert.ok(start >= 0, `mstream.player.js no longer defines ${name}() — update this test`);
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === '  }') return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`could not find the end of ${name}()`);
}

const FNS = ['_buildAutoDjBody', '_autoDjSongBlocked', '_federatedPeers', '_askPeerRandomSongs', '_autoDjFederatedPick'];

/** The player's Auto DJ functions over stub servers. `answers.local` and
 * `answers.peer` are what each server's random-songs returns. */
function makePlayer({ moodFilters = true, answers = {} } = {}) {
  const asked = [];
  const queued = [];
  const MSTREAMAPI = {
    currentServer: { vpaths: ['music'], moodFilters, discovery: true },
    federationPeers: async () => ({ peers: [{ id: 7, name: 'Peer' }] }),
    discoveryEmbeddings: async () => ({
      model: { id: 'm1' }, dim: 2, tracks: [{ embedding: AUTODJ.encodeWireVector([1, 0]) }],
    }),
    getRandomSong: async (body) => { asked.push({ to: 'local', body }); return answers.local; },
    peer: {
      health: async () => ({ discovery: { modelId: 'm1' } }),
      randomSongs: async (id, body) => { asked.push({ to: id, body }); return answers.peer; },
    },
  };
  const VUEPLAYERCORE = {
    addSongWizard: async (filepath) => { queued.push({ from: 'local', filepath }); },
    addFederationSongWizard: (peer, filepath) => { queued.push({ from: peer.id, filepath }); },
  };
  const globals = {
    AUTODJ,
    MSTREAMAPI,
    VUEPLAYERCORE,
    mstreamModule: { playerStats: { metadata: {} }, getCurrentSong: () => null },
    _fetchSimilarArtists: async () => [],
    t: (k) => k,
  };
  const body = `
    'use strict';
    let autoDjIgnoreArray = [];
    let _fedPeersCache = null;
    const FED_PEERS_TTL_MS = 5 * 60 * 1000;
    ${FNS.map(sliceFn).join('\n\n')}
    return { build: _buildAutoDjBody, federatedPick: _autoDjFederatedPick };
  `;
  const names = Object.keys(globals);
  const P = new Function(...names, body)(...names.map((n) => globals[n]));
  return { P, api: MSTREAMAPI, asked, queued };
}

const song = (title) => ({ filepath: `music/${title}.mp3`, metadata: { title, artist: `${title} band` } });
const relaxed = { energy: 'relaxed' };

describe('Auto DJ: the mood filter on the wire', () => {
  test('only while the toggle is on, something is set, and the server can filter', async () => {
    const { P, api } = makePlayer();
    AUTODJ.setState({ djMoodEnabled: true, djMoods: { voice: 'vocals', tags: ['party'] } });
    assert.deepEqual((await P.build()).body.moods, { voice: 'vocals', tags: ['party'] });

    api.currentServer.moodFilters = false;
    assert.equal('moods' in (await P.build()).body, false, 'a server without the flag would 400');
    api.currentServer.moodFilters = true;

    AUTODJ.setState({ djMoodEnabled: false });
    assert.equal('moods' in (await P.build()).body, false, 'toggled off: the filter is kept, not sent');
    assert.deepEqual(AUTODJ.state.djMoods, { voice: 'vocals', tags: ['party'] });

    AUTODJ.setState({ djMoodEnabled: true, djMoods: {} });
    assert.equal('moods' in (await P.build()).body, false, 'nothing set');
  });
});

describe('Auto DJ: a cross-server pick under a mood filter', () => {
  // The local pick is the weaker match; the peer's is the closest.
  const LOCAL = { songs: [song('Local')], ignoreList: [1], sonic: { similarities: [0.6] } };
  const PEER = { songs: [song('Peer')], ignoreList: [2], sonic: { similarities: [0.9] } };

  function session() {
    AUTODJ.setState({
      sonicEnabled: true,
      sonicSeed: { filepath: 'music/Seed.mp3', title: 'Seed' },
      djMoodEnabled: true,
      djMoods: relaxed,
    });
  }

  test('an answer without the echo is dropped, however close its song', async () => {
    session();
    const { P, asked, queued } = makePlayer({
      answers: { local: { ...LOCAL, moods: relaxed }, peer: PEER },
    });
    assert.equal(await P.federatedPick(), true);
    assert.deepEqual(asked.map((a) => a.body.moods), [relaxed, relaxed], 'both servers are asked under it');
    assert.deepEqual(queued, [{ from: 'local', filepath: 'music/Local.mp3' }]);
  });

  test('a server that echoes the filter competes as usual', async () => {
    session();
    const { P, queued } = makePlayer({
      answers: { local: { ...LOCAL, moods: relaxed }, peer: { ...PEER, moods: relaxed } },
    });
    await P.federatedPick();
    assert.deepEqual(queued, [{ from: 7, filepath: 'music/Peer.mp3' }]);
  });

  test('without a filter nothing is dropped', async () => {
    session();
    AUTODJ.setState({ djMoodEnabled: false });
    const { P, asked, queued } = makePlayer({ answers: { local: LOCAL, peer: PEER } });
    await P.federatedPick();
    assert.ok(asked.every((a) => !('moods' in a.body)));
    assert.deepEqual(queued, [{ from: 7, filepath: 'music/Peer.mp3' }]);
  });

  test('when no answer applied the filter, the pick is left to the single-server loop', async () => {
    session();
    const { P, queued } = makePlayer({ answers: { local: LOCAL, peer: PEER } });
    assert.equal(await P.federatedPick(), false);
    assert.deepEqual(queued, []);
  });
});
