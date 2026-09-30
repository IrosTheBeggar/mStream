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
 *   - THE DESKTOP PLAYER IS THE ENGINE WHILE IT IS OPEN (the second describe):
 *     a live claim in the data home — the sidecar the player writes beside
 *     the launcher's instance lock, naming a living pid and the port of its
 *     control face — is taken up in place of the headless engine, with the
 *     token on every proxied request; the headless engine it stops is a stop
 *     we asked for; the player going away brings the headless engine back;
 *     a claim whose port never answers as the gui face is refused once and
 *     left alone; stop() lets go without killing the person's player; and
 *     off still means off — the claim is not even looked at
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import winston from 'winston';

import { createController, parseClaim } from '../../src/state/server-audio.js';
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
    // No desktop player's claim unless a test plants one: a data home that
    // does not exist (never the real one — a player open on the developer's
    // machine would be adopted by the unit suite).
    dataHome: () => path.join(os.tmpdir(), 'mstream-no-claim-here', String(process.pid)),
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

const NONE = { backend: null, player: null, engine: null };
const ENGINE = { backend: 'rust', player: 'mstream-player', engine: 'headless' };
const DESKTOP = { backend: 'rust', player: 'mstream-player', engine: 'desktop' };
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

// ── The desktop player as the engine ────────────────────────────────────────

// A stand-in for the desktop player's control face: a loopback server that
// answers GET /version as the face it is told to be, and every other route
// with what it received — the token header included — so a test can see the
// proxy reach it. Its port is what the claim names.
async function fakeFace({ face = 'gui' } = {}) {
  const seen = [];
  const state = { face };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/version') {
        res.end(JSON.stringify({ name: 'mstream-player', version: '0.9.0', apiVersion: 1, face: state.face }));
        return;
      }
      seen.push({ method: req.method, path: req.url, token: req.headers['x-auth-token'] ?? null, body });
      res.end(JSON.stringify({ ok: true, via: 'gui' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const close = async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  };
  return { port: server.address().port, seen, state, close };
}

// A data home of its own, and the sidecar the player would write there.
function claimHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-claim-'));
  const file = path.join(dir, 'desktop-player.json');
  const write = (fields) => fs.writeFileSync(file, JSON.stringify({
    schema: 1, pid: process.pid, face: 'gui', host: 'ghostty', startedAt: 1_760_000_000, ...fields,
  }));
  const remove = () => { try { fs.unlinkSync(file); } catch (_err) { /* already gone */ } };
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return { dir, file, write, remove, cleanup };
}

// Deps for the desktop tests: the data home above, quick ticks, a short
// adoption wait.
function makeDesktopDeps(home, overrides = {}) {
  return makeDeps({
    dataHome: () => home.dir,
    claimPollMs: 15,
    adoptRetryMs: 10,
    adoptWaitMs: 120,
    ...overrides,
  });
}

async function until(cond, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) { throw new Error('the condition never held'); }
    await sleep(5);
  }
}

const TOKEN = 'tok-'.repeat(8);

describe('the desktop player as the engine', () => {
  test('parseClaim(): the sidecar shape, strictly where it matters', () => {
    const good = JSON.stringify({ schema: 1, pid: 4242, face: 'gui', host: 'ghostty', startedAt: 1_760_000_000, port: 3333, token: 'a'.repeat(32) });
    assert.deepEqual(parseClaim(good), { pid: 4242, port: 3333, token: 'a'.repeat(32), host: 'ghostty', startedAt: 1_760_000_000 });
    // Unknown fields and a missing host or start time are tolerated; a host
    // that is not a plain token is not repeated into the log.
    assert.deepEqual(
      parseClaim(JSON.stringify({ schema: 1, pid: 1, face: 'gui', port: 1, token: 'x'.repeat(16), host: 'Bad Host!', extra: true })),
      { pid: 1, port: 1, token: 'x'.repeat(16), host: 'unknown', startedAt: 0 },
    );
    // Not a claim: a player without the face (no port, no token), the tui
    // face, another schema, and every malformed field.
    const base = { schema: 1, pid: 4242, face: 'gui', port: 3333, token: 'a'.repeat(32) };
    for (const [why, bad] of [
      ['no port or token', { schema: 1, pid: 4242, face: 'gui', host: 'ghostty' }],
      ['tui face', { ...base, face: 'tui' }],
      ['schema 2', { ...base, schema: 2 }],
      ['pid 0', { ...base, pid: 0 }],
      ['pid as text', { ...base, pid: '4242' }],
      ['port 0', { ...base, port: 0 }],
      ['port 70000', { ...base, port: 70000 }],
      ['short token', { ...base, token: 'short' }],
      ['token with a space', { ...base, token: 'a'.repeat(16) + ' b' }],
      ['an array', [base]],
    ]) {
      assert.equal(parseClaim(JSON.stringify(bad)), null, why);
    }
    assert.equal(parseClaim('not json'), null);
    assert.equal(parseClaim(''), null);
  });

  test('a claim already there when server audio boots is adopted: nothing is spawned, the proxy carries the token', async () => {
    const face = await fakeFace();
    const home = claimHome();
    try {
      home.write({ port: face.port, token: TOKEN });
      const { deps, spawned } = makeDesktopDeps(home);
      const c = createController(deps);

      const logs = await withLogs(() => c.boot());

      assert.equal(spawned.length, 0, 'the desktop player is the engine: no headless one');
      assert.deepEqual(c.getActiveBackend(), DESKTOP);
      assert.deepEqual(logs.warn, []);
      assert.ok(logs.info.some((l) => /is open \(pid \d+, in ghostty\) — adopting it as the engine on port \d+$/.test(l)), JSON.stringify(logs.info));
      assert.ok(logs.info.some((l) => /now plays through the desktop player/.test(l)), JSON.stringify(logs.info));

      const answer = await c.proxy('POST', '/play', { file: 'lib/song.mp3' });
      assert.deepEqual(answer, { status: 200, data: { ok: true, via: 'gui' } });
      assert.deepEqual(face.seen, [{ method: 'POST', path: '/play', token: TOKEN, body: '{"file":"lib/song.mp3"}' }]);

      await c.stop();
    } finally {
      await face.close();
      home.cleanup();
    }
  });

  test('a claim appearing while the headless engine runs: the engine is stopped for it, quietly, and the player adopted', async () => {
    const face = await fakeFace();
    const home = claimHome();
    try {
      const { deps, spawned } = makeDesktopDeps(home);
      const c = createController(deps);
      await c.boot();
      assert.equal(spawned.length, 1);
      assert.deepEqual(c.getActiveBackend(), ENGINE);

      const logs = await withLogs(async () => {
        home.write({ port: face.port, token: TOKEN });
        await until(() => c.getActiveBackend().engine === 'desktop');
      });

      assert.equal(spawned[0].child.killed, true, 'the headless engine let go of the port');
      assert.equal(spawned.length, 1, 'and nothing replaced it');
      assert.deepEqual(logs.warn, [], 'a stop we asked for is not an outage');
      assert.ok(logs.info.includes('mstream-player exited with code null'), JSON.stringify(logs.info));
      await c.stop();
    } finally {
      await face.close();
      home.cleanup();
    }
  });

  test('the player going away brings the headless engine back — and a fresh claim takes over again', async () => {
    const face = await fakeFace();
    const home = claimHome();
    try {
      home.write({ port: face.port, token: TOKEN });
      const { deps, spawned } = makeDesktopDeps(home);
      const c = createController(deps);
      await c.boot();
      assert.deepEqual(c.getActiveBackend(), DESKTOP);

      const logs = await withLogs(async () => {
        home.remove();   // the player quit: its sidecar went with it
        await until(() => c.getActiveBackend().engine === 'headless');
      });
      assert.equal(spawned.length, 1, 'the headless engine was spawned in its place');
      assert.ok(logs.info.some((l) => /the desktop player \(pid \d+\) is gone — the headless engine takes over/.test(l)), JSON.stringify(logs.info));

      // Opened again: a fresh run of the player (a new startedAt) is a fresh
      // claim, and the headless engine steps aside once more.
      home.write({ port: face.port, token: TOKEN, startedAt: 1_760_000_001 });
      await until(() => c.getActiveBackend().engine === 'desktop');
      assert.equal(spawned[0].child.killed, true);
      assert.equal(spawned.length, 1);
      await c.stop();
    } finally {
      await face.close();
      home.cleanup();
    }
  });

  test('a claim whose port never answers as the gui face is refused once; the headless engine returns and the claim is left alone', async () => {
    // The headless engine answers `serve` from that port until it lets go;
    // something else entirely answers nothing. Neither is the desktop player.
    const face = await fakeFace({ face: 'serve' });
    const home = claimHome();
    try {
      home.write({ port: face.port, token: TOKEN });
      const { deps, spawned } = makeDesktopDeps(home);
      const c = createController(deps);

      const logs = await withLogs(async () => {
        await c.boot();
        await sleep(200);   // several ticks' worth
      });

      assert.deepEqual(c.getActiveBackend(), ENGINE, 'the headless engine took over as if there were no claim');
      assert.equal(spawned.length, 1);
      assert.equal(spawned[0].child.killed, false);
      const refusals = logs.warn.filter((l) => /nothing answered there as the gui face/.test(l));
      assert.equal(refusals.length, 1, JSON.stringify(logs.warn));
      assert.equal(logs.info.filter((l) => /adopting it as the engine/.test(l)).length, 1, 'tried once, not every tick');

      // The face comes up after all — but the claim is unchanged, so it stays
      // refused until the player is opened again or the switch is toggled:
      // restart() forgets refusals.
      face.state.face = 'gui';
      await sleep(80);
      assert.deepEqual(c.getActiveBackend(), ENGINE);
      await c.restart();
      await until(() => c.getActiveBackend().engine === 'desktop');
      await c.stop();
    } finally {
      await face.close();
      home.cleanup();
    }
  });

  test('a refused claim going away is the headless engine’s way back after it died of the held port', async () => {
    // The port is held by something that is not the gui face (the serve
    // face here), so the claim is refused and the headless engine spawned —
    // which then dies of the very same held port (a bind failure, code 1).
    // Nothing is retried while the claim stands; once it goes, the port is
    // presumed free and the engine is started again.
    const face = await fakeFace({ face: 'serve' });
    const home = claimHome();
    try {
      home.write({ port: face.port, token: TOKEN });
      const { deps, spawned } = makeDesktopDeps(home);
      const c = createController(deps);

      await withLogs(async () => {
        await c.boot();
        assert.equal(spawned.length, 1, 'refused, then the headless engine');
        spawned[0].child.emit('close', 1);
        await sleep(30);
        assert.deepEqual(c.getActiveBackend(), NONE, 'and it died on its own');
        await sleep(100);
        assert.equal(spawned.length, 1, 'ticks pass, the refused claim stands: nothing is retried');
        home.remove();
        await until(() => spawned.length === 2);
      });

      assert.deepEqual(c.getActiveBackend(), ENGINE, 'the headless engine is back');
      await c.stop();
    } finally {
      await face.close();
      home.cleanup();
    }
  });

  test('stop() lets go of the desktop player without touching it; restart() takes it up again; off means off', async () => {
    const face = await fakeFace();
    const home = claimHome();
    try {
      home.write({ port: face.port, token: TOKEN });
      let on = true;
      let reads = 0;
      const { deps, spawned } = makeDesktopDeps(home, {
        autoBoot: () => on,
        readClaimFile: (p) => { reads += 1; return fs.readFileSync(p, 'utf8'); },
      });
      const c = createController(deps);
      await c.boot();
      assert.deepEqual(c.getActiveBackend(), DESKTOP);

      const logs = await withLogs(() => c.stop());
      assert.deepEqual(c.getActiveBackend(), NONE);
      assert.ok(logs.info.some((l) => /letting go of the desktop player/.test(l)), JSON.stringify(logs.info));
      assert.equal((await fetch(`http://127.0.0.1:${face.port}/version`)).status, 200, 'the player was not killed: it is the person’s');
      await assert.rejects(() => c.proxy('GET', '/status'), is503);
      const readsAfterStop = reads;
      await sleep(60);
      assert.equal(reads, readsAfterStop, 'nothing watches the claim while server audio is stopped');

      await c.restart();
      assert.deepEqual(c.getActiveBackend(), DESKTOP);
      assert.equal(spawned.length, 0);

      on = false;
      await c.restart();
      assert.deepEqual(c.getActiveBackend(), NONE);
      const readsOff = reads;
      await sleep(60);
      assert.equal(reads, readsOff, 'off: the claim is not even looked at');
    } finally {
      await face.close();
      home.cleanup();
    }
  });

  test('a stale sidecar — its pid is gone — is no claim: the headless engine boots as usual', async () => {
    const home = claimHome();
    try {
      home.write({ port: 3333, token: TOKEN });
      const { deps, spawned } = makeDesktopDeps(home, { pidAlive: () => false });
      const c = createController(deps);
      const logs = await withLogs(() => c.boot());
      assert.equal(spawned.length, 1);
      assert.deepEqual(c.getActiveBackend(), ENGINE);
      assert.deepEqual(logs.warn, []);
      assert.ok(!logs.info.some((l) => /adopting/.test(l)));
      await c.stop();
    } finally {
      home.cleanup();
    }
  });

  test('a claim landing while a boot is still acquiring the binary is taken up right after: one headless spawn, then the player', async () => {
    const face = await fakeFace();
    const home = claimHome();
    try {
      let releaseFetch;
      const acquiring = new Promise((resolve) => { releaseFetch = resolve; });
      const { deps, spawned } = makeDesktopDeps(home, { exists: () => false, canAutoFetch: () => true, ensurePlayer: () => acquiring });
      const c = createController(deps);

      const flight = c.boot();          // parks inside ensurePlayer
      await sleep(40);                  // ticks pass; the watcher stands aside for a boot in flight
      home.write({ port: face.port, token: TOKEN });
      await sleep(40);
      releaseFetch('/data/bin/mstream-player/mstream-player-linux-x64');
      await flight;
      assert.equal(spawned.length, 1, 'the chain spawned what it set out to');

      await until(() => c.getActiveBackend().engine === 'desktop');
      assert.equal(spawned[0].child.killed, true, 'and the next look handed the port to the player');
      await c.stop();
    } finally {
      await face.close();
      home.cleanup();
    }
  });
});
