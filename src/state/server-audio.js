// Lifecycle of the server-side audio backend — the process that plays music
// on the machine mStream itself runs on, driven by /api/v1/server-playback/*
// and the /server-remote page (src/api/server-playback.js owns those routes;
// this module owns the process).
//
// There is one backend: the mstream-player engine
// (IrosTheBeggar/mstream-terminal-player), spawned as `mstream-player --port N`
// and driven over loopback HTTP. It is resolved dev-build → bundle-staged →
// managed install, and fetched on first use where the committed manifest pins
// a build for this platform (src/util/mstream-player-bootstrap.js).
//
// autoBootServerAudio is the on/off switch: true boots the engine with the
// server, false starts nothing at all. Until the engine-only cut there were
// four more backends here — adapters for an installed mpv, VLC, MPlayer or a
// running MPD — and "false" meant "skip the engine and use one of those", so a
// default-config server spawned whichever player it found (or connected to a
// reachable MPD and cleared its queue) for a feature nobody had turned on. Two
// of the four never advanced the queue, none was covered by CI, and the one
// that could have reached speakers on another machine (MPD) only accepted
// paths from a same-host socket. If remote speakers or an existing audio
// chain ever matter, that is a feature to design on purpose — the engine
// already has --host and --auth-token — not a fallback to keep alive.
//
// SHAPE: mirrors discovery-p2p.js — module-level state, one in-flight boot
// shared by concurrent callers, a stop generation that aborts a boot still
// acquiring its binary, and per-spawn bookkeeping so a stale child's exit can
// never touch its successor. The previous home of this code (the route
// module) kept a single process handle across generations: a boot racing an
// admin toggle could double-spawn on one port, and an old engine exiting
// after a new spawn nulled the NEW handle.
//
// createController(deps) exists for the unit tests (fake spawner, short stop
// wait); production uses the default instance the named exports below are
// bound to.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import child_process from 'node:child_process';
import winston from 'winston';
import * as config from './config.js';
import * as killQueue from './kill-list.js';
import { appRoot } from '../util/esm-helpers.js';
import WebError from '../util/web-error.js';
import { playerKey, managedPlayerPath, ensurePlayer, canAutoFetch } from '../util/mstream-player-bootstrap.js';

// Every way the proxy can fail means the same thing to a caller: the engine
// did not answer. One typed 503 lets the routes tell "backend down" from "bad
// request" by type rather than by reading message text — the path-translating
// routes used to grep the message for "not running", so an engine timeout
// came back as a 400.
function unavailable(message) {
  return new WebError(message, 503);
}

// stop() waits this long for the engine to actually exit before giving up on
// the wait (the kill was still sent). Spawning a successor while the old
// engine still holds the port makes the successor fail to bind.
export const STOP_WAIT_MS = 3000;
export const RUST_REQUEST_TIMEOUT_MS = 5000;

const defaultDeps = {
  spawn: (bin, args, opts) => child_process.spawn(bin, args, opts),
  exists: (p) => fs.existsSync(p),
  chmod: (p, mode) => fs.chmodSync(p, mode),
  platform: process.platform,
  appRoot,
  playerKey,
  managedPlayerPath,
  ensurePlayer,
  canAutoFetch,
  autoBoot: () => !!config.program.autoBootServerAudio,
  port: () => config.program.rustPlayerPort || 3333,
  stopWaitMs: STOP_WAIT_MS,
};

export function createController(overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };

  // The live engine generation, or null. Every spawn gets its own record and
  // its handlers close over it, so an exit from generation N can only clear
  // `engine` while `engine` still IS generation N.
  let engine = null;
  // The boot in flight, shared by concurrent boot() callers. stop() detaches
  // it (the chain aborts at its next generation check) so the next boot()
  // starts fresh instead of joining a chain that will refuse to spawn.
  let bootInFlight = null;
  // Bumped by every stop. A boot chain re-checks it right before spawning —
  // acquiring the binary can involve a download, and a stop() landing in that
  // window must win.
  let stopGen = 0;
  // The exit of the engine most recently told to stop, until it lands (or
  // STOP_WAIT_MS gives up on it). Whoever is about to spawn waits for it, not
  // just the stop() that sent the kill: a second stop() arriving meanwhile
  // finds no engine of its own to wait on, and reboot() fires stop() without
  // awaiting it — either way a successor spawned too early would find the
  // port still held and die of a bind failure.
  let pendingExit = null;
  // Did the engine answer its last request? Lets a wedged or unreachable
  // engine be logged when it STOPS answering, with the real socket error,
  // instead of on every request: the remote page polls /status twice a second,
  // and the callers only ever see the generic 503.
  let engineAnswering = true;

  // ── Binary resolution ─────────────────────────────────────────────────────

  // Sync, side-effect-free-ish resolver (mirrors discovery-p2p's
  // resolveSidecarBinary). Rungs, in trust order:
  //   1. dev cargo build of the player repo cloned into this checkout
  //   2. bundle-staged / operator-placed copy under appRoot
  //   3. the managed dataRoot home where the runtime fetch installs
  // The manifest key IS the filename, so there is no mapping to drift.
  function findRustBinary() {
    const ext = deps.platform === 'win32' ? '.exe' : '';
    const candidates = [
      path.join(deps.appRoot, `mstream-terminal-player/target/release/mstream-player${ext}`),
      path.join(deps.appRoot, 'bin', 'mstream-player', deps.playerKey()),
    ];
    const managed = deps.managedPlayerPath();
    if (!candidates.includes(managed)) { candidates.push(managed); }

    for (const bin of candidates) {
      if (deps.exists(bin)) {
        // Docker image builds / tarball extraction / zip commonly strip the
        // execute bit — without this, spawn fails with EACCES on every boot.
        // No-op on Windows. `chmod` fails silently on read-only volumes; the
        // downstream spawn will surface the real error if exec is truly
        // blocked (noexec mount, SELinux). Matches the rust-parser's fix in
        // src/db/task-queue.js.
        try { deps.chmod(bin, 0o755); } catch (_err) { /* read-only volume: the spawn surfaces the real error */ }
        return bin;
      }
    }
    return null;
  }

  // The API's name for what is running. `backend` keeps its historical value
  // — 'rust' — because /server-playback/status and the admin info endpoint
  // have always reported it that way.
  function getActiveBackend() {
    if (engine) { return { backend: 'rust', player: 'mstream-player' }; }
    return { backend: null, player: null };
  }

  // ── Engine ────────────────────────────────────────────────────────────────

  function spawnEngine(bin) {
    const port = deps.port();
    winston.info(`Starting mstream-player (server audio) on port ${port}`);

    let proc;
    try {
      proc = deps.spawn(bin, ['--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      // Windows throws synchronously ("spawn UNKNOWN") for a corrupt image
      // instead of emitting the async 'error' event.
      winston.error(`Failed to start mstream-player: ${err.message} — server audio is unavailable`);
      return;
    }

    const gen = { proc, startedAt: Date.now(), stopping: false, ended: false, onEnd: [] };
    engine = gen;
    engineAnswering = true;   // a new generation's first failure is worth a line

    if (proc.stdout) {
      proc.stdout.on('data', (data) => { winston.info(`[mstream-player] ${String(data).trim()}`); });
      proc.stdout.on('error', (err) => { winston.debug(`[mstream-player] stdout: ${err.message}`); });
    }
    if (proc.stderr) {
      proc.stderr.on('data', (data) => { winston.error(`[mstream-player] ${String(data).trim()}`); });
      proc.stderr.on('error', (err) => { winston.debug(`[mstream-player] stderr: ${err.message}`); });
    }

    // A failed spawn emits 'error' AND 'close'; whichever lands first ends the
    // generation, the other is a no-op. Only this generation's own record is
    // touched — never `engine` if a successor has already taken it.
    const ended = () => {
      if (gen.ended) { return false; }
      gen.ended = true;
      if (engine === gen) { engine = null; }
      for (const fn of gen.onEnd) { fn(); }
      return true;
    };
    proc.on('close', (code) => {
      if (!ended()) { return; }
      if (gen.stopping) {
        winston.info(`mstream-player exited with code ${code}`);
        return;
      }
      // Nobody asked for this. There is no supervisor to bring it back — the
      // engine returns with the next server boot or autoBoot toggle — so say
      // so, and say how long it lived: an exit in the first second or two is
      // almost always a start failure (the port is taken, no audio device),
      // and the engine's own stderr line above says which.
      const lived = ((Date.now() - gen.startedAt) / 1000).toFixed(1);
      winston.warn(`mstream-player exited with code ${code} after ${lived} s — server audio is down until the next boot or autoBoot toggle`);
    });
    proc.on('error', (err) => {
      if (!ended()) { return; }
      winston.error(`Failed to start mstream-player: ${err.message} — server audio is unavailable`);
    });
  }

  async function doBoot() {
    const gen = stopGen;
    if (engine) { return; }

    // Off means off: nothing is probed, fetched or spawned.
    if (!deps.autoBoot()) { return; }

    let bin = findRustBinary();
    if (!bin && deps.canAutoFetch()) {
      // npm/source/Docker installs: the binary left git — fetch the pinned
      // release build on first use (bundles ship it staged, so they never
      // land here). The bootstrap has already logged WHY a fetch failed; this
      // adds what it means.
      try {
        bin = await deps.ensurePlayer();
      } catch (err) {
        if (gen === stopGen) {
          winston.warn(`[server-audio] the mstream-player engine could not be fetched (${err.message}) — server audio is unavailable`);
        }
        return;
      }
    }
    if (gen !== stopGen) {
      winston.info('[server-audio] boot aborted — stop() arrived while the player binary was being acquired');
      return;
    }
    if (!bin) {
      winston.warn(`[server-audio] no mstream-player engine is available for this platform (${deps.playerKey()}) — server audio is unavailable (bin/mstream-player/README.md has the manual options)`);
      return;
    }
    // Let a predecessor finish dying before taking its port (see pendingExit).
    if (pendingExit) {
      await pendingExit;
      if (gen !== stopGen) { return; }
    }
    spawnEngine(bin);
  }

  /**
   * Boot the engine if autoBootServerAudio asks for it (see the module
   * header). Idempotent and single-flight: while a boot is in progress every
   * caller awaits the same chain, and once an engine is up further calls
   * return at once. Resolves when the engine has been spawned (not when it is
   * ready to answer) or when there is nothing to start. Never rejects for an
   * engine that merely failed to start; that is logged.
   */
  function boot() {
    if (engine) { return Promise.resolve(); }
    if (bootInFlight) { return bootInFlight; }
    const flight = doBoot().finally(() => {
      // Only OUR slot: stop() may already have detached this chain so a
      // fresh boot() could begin — never null out the successor's promise.
      if (bootInFlight === flight) { bootInFlight = null; }
    });
    bootInFlight = flight;
    return flight;
  }

  // The synchronous half of stopping: bump the generation, detach the boot in
  // flight, send the kill. Split out so the process-exit hook can run it
  // without awaiting anything (trackExit=false: see below).
  function beginStop(trackExit = true) {
    stopGen += 1;
    bootInFlight = null;
    const gen = engine;
    engine = null;
    if (gen && !gen.ended) {
      gen.stopping = true;
      try { gen.proc.kill(); } catch (_err) { /* already gone */ }
      // The process-exit hook has nobody left to wait, and a timer there
      // would only hold the dying process open.
      if (!trackExit) { return; }
      const exit = new Promise((resolve) => {
        const timer = setTimeout(resolve, deps.stopWaitMs);
        gen.onEnd.push(() => { clearTimeout(timer); resolve(); });
      }).finally(() => { if (pendingExit === exit) { pendingExit = null; } });
      pendingExit = exit;
    }
  }

  /**
   * Stop the engine. Resolves once it has exited (or STOP_WAIT_MS has passed
   * with the kill still sent) — including an engine that an EARLIER stop()
   * killed and that is still on its way out — so a restart() that follows
   * spawns into a free port. Never rejects.
   */
  async function stop() {
    beginStop();
    if (pendingExit) { await pendingExit; }
  }

  // Stop, then boot against the current config — the admin's autoBoot toggle.
  async function restart() {
    await stop();
    await boot();
  }

  // Process-exit hook: everything stop() does before its first await.
  function killSync() {
    beginStop(false);
  }

  // ── Proxy ─────────────────────────────────────────────────────────────────

  // Proxy one request to the engine's loopback HTTP API.
  function proxyToRust(method, rustPath, body) {
    return new Promise((resolve, reject) => {
      const postData = body ? JSON.stringify(body) : '';
      const headers = { 'Content-Type': 'application/json' };
      // Declare the body's length. Without it Node frames the body as
      // Transfer-Encoding: chunked, and the engine refuses a body it cannot
      // account for with 411 "Length required" (mstream-terminal-player
      // src/serve/mod.rs, every release since v0.1.0). The in-tree engine this
      // proxy was written against accepted chunked bodies, so every POST —
      // play, pause, queue, volume — had been bouncing since the pin moved to
      // the external engine, while the GETs kept working.
      if (postData) { headers['Content-Length'] = Buffer.byteLength(postData); }
      const options = {
        hostname: '127.0.0.1',
        port: deps.port(),
        path: rustPath,
        method: method,
        headers,
        timeout: RUST_REQUEST_TIMEOUT_MS
      };

      // The caller gets a generic 503; the real reason (ECONNREFUSED, a reset,
      // a timeout) is logged here, once per outage. A timeout destroys the
      // request, which then also emits 'error' — by then the flag is down, so
      // the pair logs a single line. Only the LIVE generation's silence is
      // news: a poll that was in flight when stop() took its engine down fails
      // too, and that is a restart, not an outage — nor may a stale request
      // touch the flag of the engine that replaced it.
      const gen = engine;
      const failed = (why, message) => {
        if (engine === gen) {
          if (engineAnswering) {
            winston.warn(`[server-audio] mstream-player stopped answering on port ${options.port}: ${why}`);
          }
          engineAnswering = false;
        }
        reject(unavailable(message));
      };

      const req = http.request(options, (res) => {
        if (engine === gen) { engineAnswering = true; }
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(data) });
          } catch (_e) {
            resolve({ status: res.statusCode, data: { raw: data } });
          }
        });
      });

      req.on('error', (err) => {
        failed(err.code || err.message, 'Server audio player is not running');
      });

      req.on('timeout', () => {
        req.destroy();
        failed(`no response within ${RUST_REQUEST_TIMEOUT_MS} ms`, 'Server audio player timed out');
      });

      req.end(postData || undefined);
    });
  }

  // Proxy to the engine, or reject with a 503 WebError when none is up — see
  // unavailable() at the top of this file.
  function proxy(method, rustPath, body) {
    if (engine) { return proxyToRust(method, rustPath, body); }
    return Promise.reject(unavailable('Server audio player is not running'));
  }

  return {
    boot,
    stop,
    restart,
    killSync,
    proxy,
    getActiveBackend,
    findRustBinary,
  };
}

// ── Default instance ──────────────────────────────────────────────────────────

const controller = createController();

killQueue.addToKillQueue(() => { controller.killSync(); });

export const boot = () => controller.boot();
export const stop = () => controller.stop();
export const restart = () => controller.restart();
export const proxy = (method, rustPath, body) => controller.proxy(method, rustPath, body);
export const getActiveBackend = () => controller.getActiveBackend();
