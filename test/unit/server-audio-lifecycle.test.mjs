/**
 * src/state/server-audio.js — the server-audio engine lifecycle, driven
 * through createController() with a fake spawner so no real player is needed.
 *
 * What these pin:
 *
 *   - OFF MEANS OFF. autoBootServerAudio=false starts, fetches and probes
 *     nothing. It used to mean "skip the engine and use an installed mpv /
 *     VLC / MPlayer, or a reachable MPD", so a default-config server spawned
 *     a player (or cleared an MPD queue) for a feature nobody had enabled.
 *   - concurrent boot() calls share ONE spawn (a boot racing an admin toggle
 *     used to double-spawn on the same port)
 *   - an engine that fails to start or dies on its own is REPORTED — once,
 *     with what it means — and nothing else is started in its place
 *   - a death that stop() asked for is not reported as a failure
 *   - a stale generation exiting after a restart cannot touch the new engine
 *     (the old close handler used to null the NEW handle)
 *   - stop() landing while a boot is still acquiring the binary wins: that
 *     boot never spawns
 *   - every way the proxy fails is one typed 503, and the real socket error
 *     is logged once per outage, not once per polled request
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import winston from 'winston';

import { createController } from '../../src/state/server-audio.js';
import WebError from '../../src/util/web-error.js';

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

// Fake dependencies with a recording spawner. Defaults: a binary exists at
// the first candidate, autoBoot is on, the stop wait is short.
function makeDeps(overrides = {}) {
  const spawned = [];
  const deps = {
    spawn: (bin, args, opts) => {
      const child = new FakeChild(overrides.child);
      spawned.push({ bin, args, opts, child });
      return child;
    },
    exists: () => true,
    chmod: () => {},
    platform: 'linux',
    appRoot: '/app',
    playerKey: () => 'mstream-player-linux-x64',
    managedPlayerPath: () => '/data/bin/mstream-player/mstream-player-linux-x64',
    ensurePlayer: () => Promise.resolve('/data/bin/mstream-player/mstream-player-linux-x64'),
    canAutoFetch: () => false,
    autoBoot: () => true,
    port: () => 0,
    stopWaitMs: 150,
    ...overrides,
  };
  delete deps.child;
  return { deps, spawned };
}

// Capture winston output for the duration of `fn`. The module calls
// winston.<level>() at call time, so swapping the methods is enough.
async function withLogs(fn) {
  const lines = { info: [], warn: [], error: [] };
  const real = { info: winston.info, warn: winston.warn, error: winston.error };
  for (const level of Object.keys(lines)) { winston[level] = (line) => { lines[level].push(String(line)); }; }
  try { await fn(lines); } finally { Object.assign(winston, real); }
  return lines;
}

const NONE = { backend: null, player: null };
const ENGINE = { backend: 'rust', player: 'mstream-player' };
const is503 = (err) => err instanceof WebError && err.status === 503;

describe('server-audio lifecycle', () => {
  test('off means off: autoBootServerAudio=false starts, fetches and probes nothing', async () => {
    let looked = 0;
    let fetched = 0;
    const { deps, spawned } = makeDeps({
      autoBoot: () => false,
      exists: () => { looked += 1; return true; },          // a binary IS installed
      canAutoFetch: () => true,                              // and one COULD be fetched
      ensurePlayer: () => { fetched += 1; return Promise.resolve('/x'); },
    });
    const c = createController(deps);

    const logs = await withLogs(() => c.boot());

    assert.equal(spawned.length, 0, 'nothing may be spawned for a feature that is off');
    assert.equal(looked, 0, 'not even a look for the binary');
    assert.equal(fetched, 0, 'and certainly no download');
    assert.deepEqual(c.getActiveBackend(), NONE);
    assert.deepEqual(logs, { info: [], warn: [], error: [] }, 'off is not worth a log line');
    await assert.rejects(() => c.proxy('GET', '/status'), is503);
  });

  test('concurrent boot() calls share one spawn; later calls are no-ops while the engine is up', async () => {
    const { deps, spawned } = makeDeps();
    const c = createController(deps);

    await Promise.all([c.boot(), c.boot(), c.boot()]);
    assert.equal(spawned.length, 1, 'three boots, one spawn');
    assert.deepEqual(spawned[0].args, ['--port', '0']);
    assert.deepEqual(c.getActiveBackend(), ENGINE);

    await c.boot();
    assert.equal(spawned.length, 1, 'boot() with a live engine spawns nothing');
  });

  test('an engine that dies on its own is reported once, with what it means — and nothing replaces it', async () => {
    const { deps, spawned } = makeDeps();
    const c = createController(deps);

    const logs = await withLogs(async () => {
      await c.boot();
      spawned[0].child.emit('close', 1);
      await sleep(10);
    });

    assert.deepEqual(c.getActiveBackend(), NONE);
    assert.equal(spawned.length, 1, 'there is no supervisor and no second backend: nothing is started in its place');
    assert.equal(logs.warn.length, 1);
    assert.match(logs.warn[0], /^mstream-player exited with code 1 after \d+\.\d s — server audio is down until the next boot or autoBoot toggle$/);
  });

  test('a spawn that fails emits error AND close: reported once, as a start failure', async () => {
    const { deps, spawned } = makeDeps();
    const c = createController(deps);

    const logs = await withLogs(async () => {
      await c.boot();
      spawned[0].child.failToSpawn('spawn EACCES');
      await sleep(10);
    });

    assert.deepEqual(c.getActiveBackend(), NONE);
    assert.deepEqual(logs.error, ['Failed to start mstream-player: spawn EACCES — server audio is unavailable']);
    assert.deepEqual(logs.warn, [], 'the close that follows the error is the same death, not a second one');
  });

  test('a spawn that throws synchronously (Windows, corrupt image) is reported and boot() still resolves', async () => {
    const { deps } = makeDeps({ spawn: () => { throw new Error('spawn UNKNOWN'); } });
    const c = createController(deps);

    const logs = await withLogs(() => c.boot());

    assert.deepEqual(c.getActiveBackend(), NONE);
    assert.deepEqual(logs.error, ['Failed to start mstream-player: spawn UNKNOWN — server audio is unavailable']);
  });

  test('stop() is deliberate: it waits for the exit and the death is not reported as a failure', async () => {
    const { deps, spawned } = makeDeps();
    const c = createController(deps);

    let exited = false;
    const logs = await withLogs(async () => {
      await c.boot();
      spawned[0].child.once('close', () => { exited = true; });
      await c.stop();
    });

    assert.equal(spawned[0].child.killed, true);
    assert.equal(exited, true, 'stop() resolves after the engine has closed');
    assert.deepEqual(c.getActiveBackend(), NONE);
    assert.deepEqual(logs.warn, [], 'a death we asked for is not an outage');
    assert.deepEqual(logs.error, []);
    assert.ok(logs.info.includes('mstream-player exited with code null'));
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
    assert.deepEqual(c.getActiveBackend(), NONE);
  });

  test('a stale generation exiting after a restart leaves the new engine alone', async () => {
    // The old engine does not exit on kill, so restart() times out its wait
    // and spawns the successor while the old process is still "alive". Its
    // close then arrives late.
    const { deps, spawned } = makeDeps({ child: { exitsOnKill: false } });
    const c = createController(deps);

    await c.boot();
    await c.restart();
    assert.equal(spawned.length, 2, 'restart spawned a successor');
    assert.equal(spawned[0].child.killed, true);
    assert.equal(spawned[1].child.killed, false);

    const logs = await withLogs(async () => {
      spawned[0].child.emit('close', null);   // the late exit of generation 1
      await sleep(10);
    });

    assert.deepEqual(c.getActiveBackend(), ENGINE, 'generation 2 is untouched');
    assert.deepEqual(logs.warn, [], 'and the old engine’s exit is the stop we asked for, not a crash');
  });

  test('nobody spawns while an engine is still on its way out — not a second stop(), not an un-awaited one', async () => {
    // reboot() fires stop() without awaiting it and boots later, and a second
    // toggle can arrive while the first one's engine is still dying: that
    // second stop() finds no engine of its own to wait on. A successor spawned
    // into a port that is still held dies of a bind failure. (The old CLI
    // detection probe used to delay every boot by about a second, which hid
    // this.)
    const { deps, spawned } = makeDeps({ child: { exitsOnKill: false }, stopWaitMs: 2000 });
    const c = createController(deps);

    await c.boot();
    const first = spawned[0].child;

    c.stop();                          // not awaited, like reboot()
    const booting = c.boot();          // the very next thing that happens
    const secondStopThenBoot = c.restart();   // and a second toggle on top

    await sleep(40);
    assert.equal(first.killed, true);
    assert.equal(spawned.length, 1, 'the old engine still holds the port: nothing may spawn yet');

    first.emit('close', null);         // now it is really gone
    await Promise.all([booting, secondStopThenBoot]);

    assert.equal(spawned.length, 2, 'one successor, spawned only after the exit');
    assert.deepEqual(c.getActiveBackend(), ENGINE);
  });

  test('restart() stops the old engine before spawning the new one', async () => {
    const { deps, spawned } = makeDeps();
    const c = createController(deps);

    await c.boot();
    await c.restart();

    assert.equal(spawned.length, 2);
    assert.equal(spawned[0].child.killed, true);
    const devBuild = path.join('/app', 'mstream-terminal-player/target/release/mstream-player');
    assert.deepEqual(spawned.map((s) => s.bin), [devBuild, devBuild]);
    assert.deepEqual(c.getActiveBackend(), ENGINE);
  });

  test('restart() with the flag now off is the admin’s "disable": the engine stops and nothing starts', async () => {
    let on = true;
    const { deps, spawned } = makeDeps({ autoBoot: () => on });
    const c = createController(deps);

    await c.boot();
    on = false;
    await c.restart();

    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].child.killed, true);
    assert.deepEqual(c.getActiveBackend(), NONE);

    on = true;
    await c.restart();
    assert.equal(spawned.length, 2, 'and turning it back on brings the engine back');
    assert.deepEqual(c.getActiveBackend(), ENGINE);
  });

  test('a missing binary is fetched when the manifest allows it', async () => {
    const fetched = '/data/bin/mstream-player/mstream-player-linux-x64';
    const { deps, spawned } = makeDeps({ exists: () => false, canAutoFetch: () => true, ensurePlayer: () => Promise.resolve(fetched) });
    const c = createController(deps);

    await c.boot();

    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].bin, fetched);
  });

  test('a failed fetch leaves server audio off, says why, and boot() still resolves', async () => {
    const { deps, spawned } = makeDeps({
      exists: () => false,
      canAutoFetch: () => true,
      ensurePlayer: () => Promise.reject(new Error('checksum mismatch')),
    });
    const c = createController(deps);

    const logs = await withLogs(() => c.boot());

    assert.equal(spawned.length, 0);
    assert.deepEqual(c.getActiveBackend(), NONE);
    assert.deepEqual(logs.warn, ['[server-audio] the mstream-player engine could not be fetched (checksum mismatch) — server audio is unavailable']);
  });

  test('no engine build for this platform: said once, naming the platform', async () => {
    const { deps, spawned } = makeDeps({ exists: () => false, canAutoFetch: () => false, playerKey: () => 'mstream-player-linux-x64-musl' });
    const c = createController(deps);

    const logs = await withLogs(() => c.boot());

    assert.equal(spawned.length, 0);
    assert.deepEqual(c.getActiveBackend(), NONE);
    assert.equal(logs.warn.length, 1);
    assert.match(logs.warn[0], /no mstream-player engine is available for this platform \(mstream-player-linux-x64-musl\)/);
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
    assert.deepEqual(c.getActiveBackend(), NONE);

    // A fresh boot() after the stop starts a new chain and does spawn.
    await c.boot();
    assert.equal(spawned.length, 1);
  });

  test('proxy() reaches the engine, framed the way the engine accepts; with no engine it rejects', async () => {
    // A loopback server plays the engine's HTTP API — including its one hard
    // rule about framing: a body with no declared length is refused with 411
    // (mstream-terminal-player src/serve/mod.rs). The proxy used to write its
    // body before ending the request, which makes Node send it chunked, and
    // every POST to the real engine bounced while the GETs kept working.
    const server = http.createServer((req, res) => {
      req.resume();
      if (req.headers['transfer-encoding'] && !req.headers['content-length']) {
        res.writeHead(411, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Length required' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ via: 'rust', method: req.method, path: req.url }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const { deps } = makeDeps({ port: () => port });
      const c = createController(deps);

      await assert.rejects(() => c.proxy('GET', '/status'), /not running/, 'nothing up: rejects');

      await c.boot();
      const viaRust = await c.proxy('POST', '/play', { file: '/x.mp3' });
      assert.deepEqual(viaRust, { status: 200, data: { via: 'rust', method: 'POST', path: '/play' } });

      await c.stop();
      await assert.rejects(() => c.proxy('GET', '/status'), /not running/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('every way the proxy fails is one typed 503, and the real cause is logged once per outage', async () => {
    // The routes tell "the engine did not answer" from "bad request" by TYPE.
    // They used to grep the message for "not running", so an engine timeout on
    // /play came back as a 400. The callers only ever see the generic 503, so
    // the socket error has to be logged here — but once, not per request: the
    // remote page polls /status twice a second.
    let broken = false;
    const server = http.createServer((req, res) => {
      if (broken) { req.socket.destroy(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const { deps } = makeDeps({ port: () => port });
      const c = createController(deps);

      const logs = await withLogs(async (lines) => {
        await assert.rejects(() => c.proxy('GET', '/status'), is503, 'nothing up');
        assert.deepEqual(lines.warn, [], 'no engine at all is a state the lifecycle already explained');

        await c.boot();
        assert.equal((await c.proxy('GET', '/status')).status, 200);

        broken = true;
        await assert.rejects(() => c.proxy('GET', '/status'), is503, 'engine stopped answering');
        await assert.rejects(() => c.proxy('GET', '/status'), is503);
        await assert.rejects(() => c.proxy('POST', '/play', { file: '/x.mp3' }), is503);
        const outage = lines.warn.filter((l) => /stopped answering/.test(l));
        assert.equal(outage.length, 1, `three failed requests, one line: ${JSON.stringify(lines.warn)}`);
        assert.match(outage[0], new RegExp(`port ${port}: \\S+`), 'the line carries the real socket error');

        broken = false;
        assert.equal((await c.proxy('GET', '/status')).status, 200, 'recovered');
        broken = true;
        await assert.rejects(() => c.proxy('GET', '/status'), is503);
      });
      assert.equal(logs.warn.filter((l) => /stopped answering/.test(l)).length, 2, 'a NEW outage after a recovery is logged again');
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('a request in flight when stop() takes the engine down fails quietly — a restart is not an outage', async () => {
    // The remote page polls twice a second, so a toggle or a soft reboot
    // routinely lands mid-request. That request fails like any other, but the
    // "stopped answering" line is for an engine that went quiet on its own.
    const held = [];
    const server = http.createServer((req) => { held.push(req.socket); });   // never answers
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const { deps } = makeDeps({ port: () => port });
      const c = createController(deps);
      await c.boot();

      const logs = await withLogs(async () => {
        const inFlight = c.proxy('GET', '/status');
        const settled = assert.rejects(() => inFlight, is503);
        while (held.length === 0) { await sleep(5); }   // the request has reached the "engine"

        await c.stop();
        for (const s of held) { s.destroy(); }          // its connection dies with the engine
        await settled;
      });

      assert.deepEqual(logs.warn.filter((l) => /stopped answering/.test(l)), [], 'a death we asked for is not reported as the engine going quiet');
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('killSync() sends the kill synchronously, for the process-exit hook', async () => {
    const { deps, spawned } = makeDeps();
    const c = createController(deps);

    await c.boot();
    c.killSync();

    assert.equal(spawned[0].child.killed, true, 'the kill is sent before any await');
    assert.deepEqual(c.getActiveBackend(), NONE);
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
