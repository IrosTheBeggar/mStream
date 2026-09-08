/**
 * src/state/server-audio.js — the server-audio backend lifecycle, driven
 * through createController() with a fake spawner and a fake CLI registry so
 * no real player is needed.
 *
 * These pin the guarantees the split was made for. The old home of this
 * code (the route module) had none of them:
 *
 *   - concurrent boot() calls share ONE spawn (a boot racing an admin toggle
 *     used to double-spawn on the same port)
 *   - an engine that dies inside its settle window rolls over to a CLI
 *     player exactly once, even though a failed spawn emits both 'error'
 *     and 'close'
 *   - an engine that dies AFTER settling is a runtime crash, not a start
 *     failure: no CLI fallback
 *   - a death that stop() asked for is never a start failure
 *   - a stale generation exiting after a restart cannot touch the new
 *     engine (the old close handler used to null the NEW handle and start
 *     a CLI player beside a live engine)
 *   - stop() landing while a boot is still acquiring the binary wins: that
 *     boot never spawns
 *   - proxy() prefers the engine, then the CLI adapter, then rejects
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { createController } from '../../src/state/server-audio.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in for child_process.spawn's return value: the two stdio emitters
// the controller attaches to, plus 'close' / 'error' which the tests fire by
// hand. kill() records the signal and, unless told otherwise, exits on the
// next tick the way a cooperative process would.
class FakeChild extends EventEmitter {
  constructor({ exitsOnKill = true } = {}) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
    this.exitsOnKill = exitsOnKill;
  }
  kill() {
    this.killed = true;
    if (this.exitsOnKill) { setImmediate(() => this.emit('close', null)); }
    return true;
  }
  // A failed spawn: Node emits 'error' and then 'close'.
  failToSpawn(message) {
    this.emit('error', new Error(message));
    this.emit('close', -2);
  }
}

// Fake dependencies with a recording spawner and an in-memory CLI registry.
// Defaults: a binary exists at the first candidate, CLI detection finds mpv,
// autoBoot is on, the settle window is short.
function makeDeps(overrides = {}) {
  const spawned = [];
  const cli = { active: false, name: null, boots: [], kills: 0 };
  const log = [];
  const deps = {
    spawn: (bin, args, opts) => {
      const child = new FakeChild(overrides.child);
      spawned.push({ bin, args, opts, child });
      log.push(`spawn:${bin}`);
      return child;
    },
    exists: () => true,
    chmod: () => {},
    platform: 'linux',
    appRoot: '/app',
    playerKey: () => 'mstream-player-linux-x64',
    managedPlayerPath: () => '/data/bin/mstream-player/mstream-player-linux-x64',
    ensurePlayer: async () => '/data/bin/mstream-player/mstream-player-linux-x64',
    canAutoFetch: () => false,
    detectCliPlayers: async () => ['mpv'],
    bootCliPlayer: async (preferred) => {
      cli.boots.push(preferred);
      cli.active = true;
      cli.name = preferred || 'mpv';
      log.push(`cli-boot:${cli.name}`);
      return cli.name;
    },
    killCliPlayer: async () => {
      cli.kills += 1;
      if (cli.active) { log.push(`cli-kill:${cli.name}`); }
      cli.active = false;
      cli.name = null;
    },
    isCliActive: () => cli.active,
    cliPlayerName: () => cli.name,
    proxyToCli: async (method, rustPath, body) => ({ status: 200, data: { via: 'cli', method, rustPath, body } }),
    autoBoot: () => true,
    port: () => 0,
    settleMs: 40,
    stopWaitMs: 150,
    ...overrides,
  };
  delete deps.child;
  return { deps, spawned, cli, log };
}

describe('server-audio lifecycle', () => {
  test('concurrent boot() calls share one spawn; later calls are no-ops while the engine is up', async () => {
    const { deps, spawned } = makeDeps();
    const c = createController(deps);

    await Promise.all([c.boot(), c.boot(), c.boot()]);
    assert.equal(spawned.length, 1, 'three boots, one spawn');
    assert.deepEqual(spawned[0].args, ['--port', '0']);
    assert.equal(c.getActiveBackend().backend, 'rust');

    await c.boot();
    assert.equal(spawned.length, 1, 'boot() with a live engine spawns nothing');
  });

  test('an engine that dies inside the settle window rolls over to a CLI player, once', async () => {
    const { deps, spawned, cli } = makeDeps();
    const c = createController(deps);

    await c.boot();
    spawned[0].child.failToSpawn('EACCES');   // 'error' AND 'close'
    await sleep(10);

    assert.equal(cli.boots.length, 1, 'error+close must start exactly one CLI player');
    assert.equal(cli.boots[0], null, 'the crash fallback has no MPD preference');
    assert.deepEqual(c.getActiveBackend(), { backend: 'cli', player: 'mpv' });
  });

  test('an engine that dies after settling is a runtime crash: no CLI fallback', async () => {
    const { deps, spawned, cli } = makeDeps();
    const c = createController(deps);

    await c.boot();
    await sleep(deps.settleMs + 20);
    spawned[0].child.emit('close', 1);
    await sleep(10);

    assert.equal(cli.boots.length, 0);
    assert.deepEqual(c.getActiveBackend(), { backend: null, player: null });
  });

  test('stop() during the settle window is deliberate: no fallback, and it waits for the exit', async () => {
    const { deps, spawned, cli } = makeDeps();
    const c = createController(deps);

    await c.boot();
    let exited = false;
    spawned[0].child.once('close', () => { exited = true; });
    await c.stop();

    assert.equal(spawned[0].child.killed, true);
    assert.equal(exited, true, 'stop() resolves after the engine has closed');
    assert.equal(cli.boots.length, 0, 'a death we asked for is not a start failure');
    assert.deepEqual(c.getActiveBackend(), { backend: null, player: null });
    assert.equal(cli.kills, 1, 'the CLI adapter is stopped too');
  });

  test('stop() gives up waiting after stopWaitMs when the engine ignores the kill', async () => {
    const { deps, spawned } = makeDeps({ child: { exitsOnKill: false } });
    const c = createController(deps);

    await c.boot();
    const t0 = Date.now();
    await c.stop();
    const waited = Date.now() - t0;

    assert.equal(spawned[0].child.killed, true, 'the kill was still sent');
    assert.ok(waited >= deps.stopWaitMs - 5 && waited < deps.stopWaitMs + 500, `waited ${waited}ms`);
    assert.deepEqual(c.getActiveBackend(), { backend: null, player: null });
  });

  test('a stale generation exiting after a restart leaves the new engine alone', async () => {
    // The old engine does not exit on kill, so restart() times out its wait
    // and spawns the successor while the old process is still "alive". Its
    // close then arrives late — inside the successor's settle window.
    const { deps, spawned, cli } = makeDeps({ child: { exitsOnKill: false } });
    const c = createController(deps);

    await c.boot();
    await c.restart();
    assert.equal(spawned.length, 2, 'restart spawned a successor');
    assert.equal(spawned[0].child.killed, true);
    assert.equal(spawned[1].child.killed, false);

    spawned[0].child.emit('close', null);   // the late exit of generation 1
    await sleep(10);

    assert.deepEqual(c.getActiveBackend(), { backend: 'rust', player: 'mstream-player' }, 'generation 2 is untouched');
    assert.equal(cli.boots.length, 0, 'no CLI player beside a live engine');
  });

  test('restart() stops the old engine before spawning the new one', async () => {
    const { deps, spawned, log } = makeDeps();
    const c = createController(deps);

    await c.boot();
    await c.restart();

    assert.equal(spawned.length, 2);
    assert.equal(spawned[0].child.killed, true);
    const devBuild = `spawn:${path.join('/app', 'mstream-terminal-player/target/release/mstream-player')}`;
    assert.deepEqual(log, [devBuild, devBuild]);
    assert.equal(c.getActiveBackend().backend, 'rust');
  });

  test('autoBootServerAudio=false skips the engine and prefers MPD', async () => {
    const { deps, spawned, cli } = makeDeps({ autoBoot: () => false, detectCliPlayers: async () => ['mpv', 'mpd'] });
    const c = createController(deps);

    await c.boot();

    assert.equal(spawned.length, 0);
    assert.deepEqual(cli.boots, ['mpd']);
    assert.deepEqual(c.getActiveBackend(), { backend: 'cli', player: 'mpd' });
    assert.deepEqual(c.getDetectedCliPlayers(), ['mpv', 'mpd'], 'boot refreshes the detection snapshot');
  });

  test('a missing binary is fetched when the manifest allows it', async () => {
    const fetched = '/data/bin/mstream-player/mstream-player-linux-x64';
    const { deps, spawned } = makeDeps({ exists: () => false, canAutoFetch: () => true, ensurePlayer: async () => fetched });
    const c = createController(deps);

    await c.boot();

    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].bin, fetched);
  });

  test('a failed fetch rolls over to a CLI player', async () => {
    const { deps, spawned, cli } = makeDeps({
      exists: () => false,
      canAutoFetch: () => true,
      ensurePlayer: async () => { throw new Error('checksum mismatch'); },
    });
    const c = createController(deps);

    await c.boot();

    assert.equal(spawned.length, 0);
    assert.equal(cli.boots.length, 1);
    assert.equal(c.getActiveBackend().backend, 'cli');
  });

  test('nothing available: no engine, no CLI player, backend null', async () => {
    const { deps, spawned, cli } = makeDeps({ exists: () => false, canAutoFetch: () => false, detectCliPlayers: async () => [] });
    const c = createController(deps);

    await c.boot();

    assert.equal(spawned.length, 0);
    assert.equal(cli.boots.length, 0);
    assert.deepEqual(c.getActiveBackend(), { backend: null, player: null });
  });

  test('stop() landing while a boot is still acquiring the binary wins: that boot never spawns', async () => {
    let releaseFetch;
    const fetch = new Promise((resolve) => { releaseFetch = resolve; });
    const { deps, spawned } = makeDeps({ exists: () => false, canAutoFetch: () => true, ensurePlayer: () => fetch });
    const c = createController(deps);

    const flight = c.boot();            // parks inside ensurePlayer
    await sleep(5);
    await c.stop();                     // overtakes the download
    releaseFetch('/data/bin/mstream-player/mstream-player-linux-x64');
    await flight;

    assert.equal(spawned.length, 0, 'the overtaken boot must not spawn');
    assert.deepEqual(c.getActiveBackend(), { backend: null, player: null });

    // A fresh boot() after the stop starts a new chain and does spawn.
    await c.boot();
    assert.equal(spawned.length, 1);
  });

  test('proxy() prefers the engine, then the CLI adapter, then rejects', async () => {
    // A loopback server plays the engine's HTTP API.
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ via: 'rust', method: req.method, path: req.url }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const { deps, cli } = makeDeps({ port: () => port });
      const c = createController(deps);

      await assert.rejects(() => c.proxy('GET', '/status'), /not running/, 'nothing up: rejects');

      await c.boot();
      const viaRust = await c.proxy('POST', '/play', { file: '/x.mp3' });
      assert.deepEqual(viaRust, { status: 200, data: { via: 'rust', method: 'POST', path: '/play' } });

      await c.stop();
      cli.active = true; cli.name = 'mpv';
      const viaCli = await c.proxy('GET', '/status');
      assert.equal(viaCli.data.via, 'cli');

      cli.active = false;
      await assert.rejects(() => c.proxy('GET', '/status'), /not running/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('killSync() tears everything down synchronously without a fallback', async () => {
    const { deps, spawned, cli } = makeDeps();
    const c = createController(deps);

    await c.boot();
    c.killSync();

    assert.equal(spawned[0].child.killed, true, 'the kill is sent before any await');
    assert.equal(cli.kills, 1, 'the CLI kill is invoked synchronously');
    assert.deepEqual(c.getActiveBackend(), { backend: null, player: null });
    await sleep(10);
    assert.equal(cli.boots.length, 0);
  });

  test('findRustBinary(): dev build, then bundled, then managed; chmod is best-effort', () => {
    const managed = '/data/bin/mstream-player/mstream-player-linux-x64';
    const present = new Set();
    const chmodded = [];
    const { deps } = makeDeps({
      exists: (p) => present.has(p),
      chmod: (p) => { chmodded.push(p); throw new Error('EROFS'); },
    });
    const c = createController(deps);

    assert.equal(c.findRustBinary(), null);
    present.add(managed);
    assert.equal(c.findRustBinary(), managed);
    // Candidates are built with the platform path module (backslashes on
    // Windows), so the expectations are too; the managed path is used as-is.
    const bundled = path.join('/app', 'bin', 'mstream-player', 'mstream-player-linux-x64');
    const devBuild = path.join('/app', 'mstream-terminal-player/target/release/mstream-player');
    present.add(bundled);
    assert.equal(c.findRustBinary(), bundled);
    present.add(devBuild);
    assert.equal(c.findRustBinary(), devBuild);
    assert.equal(chmodded.length, 3, 'a failing chmod never hides a found binary');
  });
});
