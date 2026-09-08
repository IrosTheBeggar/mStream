// Lifecycle of the server-side audio backend — the process that plays music
// on the machine mStream itself runs on, driven by /api/v1/server-playback/*
// and the /server-remote page (src/api/server-playback.js owns those routes;
// this module owns the process).
//
// Two kinds of backend, one at a time:
//   rust  the mstream-player engine (IrosTheBeggar/mstream-terminal-player),
//         spawned as `mstream-player --port N` and driven over loopback HTTP.
//         Resolved dev-build → bundle-staged → managed install, fetched on
//         first use where the committed manifest pins a build
//         (src/util/mstream-player-bootstrap.js).
//   cli   an installed mpv / MPD / VLC / MPlayer behind an adapter that
//         answers the same HTTP-shaped requests in-process (./cli-audio/).
//
// Which one runs is a preference, not a switch. autoBootServerAudio=true
// prefers the engine and rolls over to a CLI player when the binary is
// missing, the spawn fails, or the engine dies inside its settle window;
// false skips the engine and takes a CLI player, MPD first — the option most
// often already running on self-hosted / NAS setups.
//
// SHAPE: mirrors discovery-p2p.js — module-level state, one in-flight boot
// shared by concurrent callers, a stop generation that aborts a boot still
// acquiring its binary, and per-spawn bookkeeping so a stale child's exit can
// never touch its successor. The previous home of this code (the route
// module) kept a single settle flag and a single process handle across
// generations: a boot racing an admin toggle could double-spawn on one port,
// and an old engine exiting after a new spawn nulled the NEW handle and
// started a CLI player beside a live engine.
//
// createController(deps) exists for the unit tests (fake spawner, fake CLI
// registry, short settle timer); production uses the default instance the
// named exports below are bound to.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import child_process from 'node:child_process';
import winston from 'winston';
import * as config from './config.js';
import * as killQueue from './kill-list.js';
import * as cliAudio from './cli-audio/index.js';
import { appRoot } from '../util/esm-helpers.js';
import { playerKey, managedPlayerPath, ensurePlayer, canAutoFetch } from '../util/mstream-player-bootstrap.js';

// A freshly spawned engine must stay up this long before an exit counts as a
// runtime crash (no fallback) rather than a failed start (roll over to CLI).
export const RUST_SETTLE_MS = 2000;
// stop() waits this long for the engine to actually exit before giving up on
// the wait (the kill was still sent). Spawning a successor while the old
// engine still holds the port makes the successor fail to bind, which looks
// exactly like a failed start and would trip the CLI fallback.
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
  detectCliPlayers: () => cliAudio.detectAvailablePlayers(),
  bootCliPlayer: (preferred) => cliAudio.bootCliPlayer(preferred),
  killCliPlayer: () => cliAudio.killCliPlayer(),
  isCliActive: () => cliAudio.isCliActive(),
  cliPlayerName: () => cliAudio.getActivePlayerName(),
  proxyToCli: (method, rustPath, body) => cliAudio.proxyToCli(method, rustPath, body),
  autoBoot: () => !!config.program.autoBootServerAudio,
  port: () => config.program.rustPlayerPort || 3333,
  settleMs: RUST_SETTLE_MS,
  stopWaitMs: STOP_WAIT_MS,
};

export function createController(overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };

  // The live engine generation, or null. Every spawn gets its own record and
  // its handlers close over it, so an exit from generation N can only clear
  // `engine` while `engine` still IS generation N.
  let engine = null;
  // CLI detection snapshot: names in fallback priority order. Refreshed at
  // every boot and by the admin's redetect endpoint; read by the admin info
  // endpoint without re-probing.
  let detected = [];
  // The boot in flight, shared by concurrent boot() callers. stop() detaches
  // it (the chain aborts at its next generation check) so the next boot()
  // starts fresh instead of joining a chain that will refuse to spawn.
  let bootInFlight = null;
  let cliBootInFlight = null;
  // Bumped by every stop. A boot chain re-checks it right before spawning and
  // after starting a CLI player — acquiring the binary can involve a download,
  // and a stop() landing in that window must win.
  let stopGen = 0;

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

  // ── Detection snapshot ────────────────────────────────────────────────────

  async function refreshDetectedCliPlayers() {
    detected = await deps.detectCliPlayers();
    return detected;
  }

  function getDetectedCliPlayers() {
    return detected;
  }

  function getActiveBackend() {
    if (engine) { return { backend: 'rust', player: 'mstream-player' }; }
    if (deps.isCliActive()) { return { backend: 'cli', player: deps.cliPlayerName() }; }
    return { backend: null, player: null };
  }

  // ── CLI fallback ──────────────────────────────────────────────────────────

  // Single-flight on purpose: a failed spawn emits BOTH 'error' and 'close',
  // and each used to start a CLI player of its own.
  function bootCliFallback(reason, preferredPlayer = null) {
    if (cliBootInFlight) { return cliBootInFlight; }
    const gen = stopGen;
    cliBootInFlight = (async () => {
      if (deps.isCliActive()) { return; }
      if (detected.length === 0) {
        winston.warn(`[server-audio] ${reason}; no CLI audio players detected — server audio unavailable`);
        return;
      }
      let name;
      try {
        name = await deps.bootCliPlayer(preferredPlayer);
      } catch (err) {
        winston.error(`[server-audio] CLI fallback failed: ${err.message}`);
        return;
      }
      if (!name) {
        winston.warn(`[server-audio] ${reason}; CLI players detected but none would start`);
        return;
      }
      if (gen !== stopGen) {
        // A stop() overtook the adapter's startup; it found nothing to kill
        // then, so the player that just came up is ours to put down.
        winston.info(`[server-audio] ${name} started after a stop() — shutting it down again`);
        await deps.killCliPlayer().catch(() => {});
        return;
      }
      winston.info(`[server-audio] ${reason}; using CLI fallback: ${name}`);
    })().finally(() => { cliBootInFlight = null; });
    return cliBootInFlight;
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
      winston.error(`Failed to start mstream-player: ${err.message}`);
      return bootCliFallback(`mstream-player spawn failed: ${err.message}`);
    }

    const gen = { proc, settled: false, stopping: false, ended: false, timer: null, onEnd: [] };
    engine = gen;
    gen.timer = setTimeout(() => { gen.settled = true; }, deps.settleMs);

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
    // touched — never `engine` if a successor has already taken it — and a
    // death that stop() asked for is not a start failure.
    const ended = (reason) => {
      if (gen.ended) { return; }
      gen.ended = true;
      clearTimeout(gen.timer);
      if (engine === gen) { engine = null; }
      for (const fn of gen.onEnd) { fn(); }
      if (!gen.settled && !gen.stopping) {
        bootCliFallback(reason).catch(() => {});
      }
    };
    proc.on('close', (code) => {
      winston.info(`mstream-player exited with code ${code}`);
      ended(`mstream-player exited early (code ${code})`);
    });
    proc.on('error', (err) => {
      winston.error(`Failed to start mstream-player: ${err.message}`);
      ended(`mstream-player spawn failed: ${err.message}`);
    });
    return Promise.resolve();
  }

  async function doBoot() {
    const gen = stopGen;

    // Refresh the CLI detection snapshot so the fallback decision (and the
    // admin /info endpoint) have current data.
    await refreshDetectedCliPlayers();
    if (gen !== stopGen) { return; }
    if (engine) { return; }

    if (!deps.autoBoot()) {
      await bootCliFallback('autoBootServerAudio=false', 'mpd');
      return;
    }

    let bin = findRustBinary();
    if (!bin && deps.canAutoFetch()) {
      // npm/source/Docker installs: the binary left git — fetch the pinned
      // release build on first use (bundles ship it staged, so they never
      // land here). A failed fetch degrades to the CLI players like any
      // other miss; the cause is already logged by the bootstrap.
      try {
        bin = await deps.ensurePlayer();
      } catch (err) {
        if (gen !== stopGen) { return; }
        await bootCliFallback(`mstream-player fetch failed: ${err.message}`);
        return;
      }
    }
    if (gen !== stopGen) {
      winston.info('[server-audio] boot aborted — stop() arrived while the player binary was being acquired');
      return;
    }
    if (!bin) {
      await bootCliFallback('mstream-player binary not found');
      return;
    }
    await spawnEngine(bin);
  }

  /**
   * Boot whichever backend applies (see the module header). Idempotent and
   * single-flight: while a boot is in progress every caller awaits the same
   * chain, and once an engine is up further calls return at once. Resolves
   * when the engine has been spawned (not when it is ready — the settle
   * window decides that) or the CLI fallback attempt has finished. Never
   * rejects for a backend that merely failed to start; that is logged.
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
  // without awaiting anything.
  function beginStop() {
    stopGen += 1;
    bootInFlight = null;
    const gen = engine;
    engine = null;
    if (gen && !gen.ended) {
      gen.stopping = true;
      clearTimeout(gen.timer);
      try { gen.proc.kill(); } catch (_err) { /* already gone */ }
    }
    return gen;
  }

  /**
   * Stop whatever is running. Resolves once the engine has exited (or
   * STOP_WAIT_MS has passed with the kill still sent) and the CLI adapter has
   * stopped, so a restart() that follows spawns into a free port. Never
   * rejects.
   */
  async function stop() {
    const gen = beginStop();
    // Invoked synchronously on purpose: the adapters send their kill before
    // their first await, which is what the process-exit path relies on.
    const cliStopped = deps.killCliPlayer().catch((err) => {
      winston.warn(`[server-audio] CLI player did not stop cleanly: ${err.message}`);
    });
    if (gen && !gen.ended) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, deps.stopWaitMs);
        gen.onEnd.push(() => { clearTimeout(timer); resolve(); });
      });
    }
    await cliStopped;
  }

  // Stop, then boot against the current config — the admin's autoBoot toggle.
  async function restart() {
    await stop();
    await boot();
  }

  // Process-exit hook: everything stop() does before its first await.
  function killSync() {
    beginStop();
    deps.killCliPlayer().catch(() => {});
  }

  // ── Proxy ─────────────────────────────────────────────────────────────────

  // Proxy one request to the engine's loopback HTTP API. cli-audio's
  // proxyToCli answers the same {status, data} shape in-process.
  function proxyToRust(method, rustPath, body) {
    return new Promise((resolve, reject) => {
      const postData = body ? JSON.stringify(body) : '';
      const options = {
        hostname: '127.0.0.1',
        port: deps.port(),
        path: rustPath,
        method: method,
        headers: { 'Content-Type': 'application/json' },
        timeout: RUST_REQUEST_TIMEOUT_MS
      };

      const req = http.request(options, (res) => {
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

      req.on('error', (_e) => {
        reject(new Error('Server audio player is not running'));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Server audio player timed out'));
      });

      if (postData) { req.write(postData); }
      req.end();
    });
  }

  // Dispatch to whichever backend is active: the engine first, then a CLI
  // adapter. Rejects when neither is up.
  function proxy(method, rustPath, body) {
    if (engine) { return proxyToRust(method, rustPath, body); }
    if (deps.isCliActive()) { return deps.proxyToCli(method, rustPath, body); }
    return Promise.reject(new Error('Server audio player is not running'));
  }

  return {
    boot,
    stop,
    restart,
    killSync,
    proxy,
    getActiveBackend,
    refreshDetectedCliPlayers,
    getDetectedCliPlayers,
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
export const refreshDetectedCliPlayers = () => controller.refreshDetectedCliPlayers();
export const getDetectedCliPlayers = () => controller.getDetectedCliPlayers();
