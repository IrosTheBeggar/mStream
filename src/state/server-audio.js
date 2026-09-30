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
// THE DESKTOP PLAYER IS THE ENGINE WHILE IT IS OPEN. The same binary's GUI
// face — opened on this machine by the tray launcher ("Open mStream Player")
// — hosts the identical control API on loopback (`gui --serve-port`, the
// configured player port) and claims it in a sidecar beside the launcher's
// own files in userDataHome: desktop-player.json, naming its pid, port and a
// token. While that claim is live (the file names a living pid, and the port
// answers GET /version as the `gui` face) the GUI is the engine: the headless
// one is stopped so the machine has one player, the proxy talks to the GUI
// with the token in x-auth-token, and library paths ride through untranslated
// (the GUI streams from this server — server-playback.js). When the claim
// dies — the player closed, or was killed — the headless engine comes back,
// with an empty queue. autoBootServerAudio stays the one switch: off, nothing
// is watched, adopted or spawned. The GUI hosts its face whether or not this
// server wants it (the launcher always passes the port); the claim is an
// offer, and the switch decides whether it is taken up.
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
import { appRoot, userDataHome } from '../util/esm-helpers.js';
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

// The desktop player's claim: the sidecar the player writes beside the
// instance lock the launcher hands it (mstream-terminal-player
// src/instance.rs), in userDataHome next to launcher.lock, and removes when
// it exits cleanly.
export const CLAIM_FILE = 'desktop-player.json';
// How often the claim is looked at while server audio is on. One small file
// read — cheap enough to be prompt, and prompt matters: once the headless
// engine lets go of the port the GUI keeps trying to bind it for only so
// long (fifteen seconds in the player).
export const CLAIM_POLL_MS = 2000;
// How long an adoption waits for the claimed port to answer as the gui face:
// the headless engine's stop wait plus the GUI's own bind retry, with room.
export const ADOPT_WAIT_MS = 20000;
export const ADOPT_RETRY_MS = 500;
const PROBE_TIMEOUT_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Is this pid alive? Signal 0 asks without sending anything (Windows too);
// EPERM is "alive, and not ours to signal" — alive.
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/**
 * The desktop player's claim, as its sidecar states it: schema 1 with a
 * `gui` face, a pid, and the port and token of the control face it hosts.
 * Tolerant of what it does not use (extra fields, a missing host or start
 * time), strict about what it does: a player without a control face writes
 * no port and no token and is not a claim at all, the `tui` face never is,
 * and a malformed field is no claim rather than a guess. The host is
 * repeated into log lines, so only a plain token of one is. Pure, exported
 * for the unit tests. Null when the text is not a claim.
 */
export function parseClaim(text) {
  let v;
  try { v = JSON.parse(text); } catch (_err) { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) { return null; }
  if (v.schema !== 1 || v.face !== 'gui') { return null; }
  const { pid, port, token } = v;
  if (!Number.isInteger(pid) || pid <= 0) { return null; }
  if (!Number.isInteger(port) || port < 1 || port > 65535) { return null; }
  if (typeof token !== 'string' || !/^[\x21-\x7e]{16,256}$/.test(token)) { return null; }
  const host = typeof v.host === 'string' && /^[a-z0-9._-]{1,32}$/.test(v.host) ? v.host : 'unknown';
  const startedAt = Number.isInteger(v.startedAt) && v.startedAt >= 0 ? v.startedAt : 0;
  return { pid, port, token, host, startedAt };
}

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
  // The desktop player's claim: where it is, how it is read, and how a
  // living pid is told from a dead one.
  dataHome: () => userDataHome(),
  readClaimFile: (p) => fs.readFileSync(p, 'utf8'),
  pidAlive,
  claimPollMs: CLAIM_POLL_MS,
  adoptWaitMs: ADOPT_WAIT_MS,
  adoptRetryMs: ADOPT_RETRY_MS,
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
  // The desktop player adopted as the engine, or null: the claim it was
  // adopted under — pid plus startedAt name one run of the player, a pid
  // alone can be reused — with the port and token the proxy uses.
  let desktop = null;
  // The claim watcher: a timer while server audio is on, looking for a claim
  // to adopt and for the adopted player's death. Unref'd: it must never hold
  // the process open.
  let watcher = null;
  // The adoption in flight, so a tick never starts a second one beside it.
  let adopting = null;
  // A claim that was tried and never answered as the gui face — a stale
  // sidecar over a port something else holds, a GUI whose own bind failed —
  // remembered so it is not tried again every tick. Forgotten by stop() (a
  // toggle is a fresh try) and superseded by any change to the file.
  let refused = null;

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
  // have always reported it that way; `engine` says which face answers:
  // 'headless' for the engine spawned here, 'desktop' for the adopted player
  // (the routes translate paths by it), null when nothing is up.
  function getActiveBackend() {
    if (desktop) { return { backend: 'rust', player: 'mstream-player', engine: 'desktop' }; }
    if (engine) { return { backend: 'rust', player: 'mstream-player', engine: 'headless' }; }
    return { backend: null, player: null, engine: null };
  }

  // Whatever answers requests right now — the adopted player or the live
  // headless generation — for the "still answering" bookkeeping.
  const current = () => desktop || engine;

  // ── The desktop player's claim ────────────────────────────────────────────

  function claimPath() {
    return path.join(deps.dataHome(), CLAIM_FILE);
  }

  // The claim on disk, if a living player made it. Null — not an error — for
  // no file at all: no launcher ever opened a desktop player here.
  function liveClaim() {
    let text;
    try { text = deps.readClaimFile(claimPath()); } catch (_err) { return null; }
    const claim = parseClaim(text);
    if (!claim || !deps.pidAlive(claim.pid)) { return null; }
    return claim;
  }

  const sameRun = (a, b) => !!a && !!b && a.pid === b.pid && a.startedAt === b.startedAt;

  // GET /version on the claimed port, unauthenticated (the one route the
  // face spares): which face is listening there. Only `gui` is adoptable —
  // the headless engine just stopped answers `serve` from the same port
  // until it lets go, and anything else answers nothing of the kind.
  function probeFace(port) {
    return new Promise((resolve) => {
      const req = http.get({ hostname: '127.0.0.1', port, path: '/version', timeout: PROBE_TIMEOUT_MS }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(res.statusCode === 200 ? (JSON.parse(data).face ?? null) : null); } catch (_err) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }

  // Take a claim up: stop the headless engine if one is up (the GUI is
  // waiting to bind that very port), then wait for the port to answer as
  // the gui face. True once the desktop player is the engine. A stop()
  // landing meanwhile abandons the attempt at its next generation check; a
  // claim that never answers is refused, once, with a line.
  async function adopt(claim) {
    const gen = stopGen;
    winston.info(`[server-audio] the desktop player is open (pid ${claim.pid}, in ${claim.host}) — adopting it as the engine on port ${claim.port}`);
    if (engine) {
      // A stop we asked for, so its exit is not an outage.
      killEngine();
      if (pendingExit) { await pendingExit; }
      if (gen !== stopGen) { return false; }
    }
    const deadline = Date.now() + deps.adoptWaitMs;
    for (;;) {
      const face = await probeFace(claim.port);
      if (gen !== stopGen) { return false; }
      if (face === 'gui') {
        desktop = { ...claim };
        engineAnswering = true;
        refused = null;
        winston.info(`[server-audio] server audio now plays through the desktop player (pid ${claim.pid}, port ${claim.port})`);
        return true;
      }
      if (Date.now() >= deadline) { break; }
      await sleep(deps.adoptRetryMs);
      if (gen !== stopGen) { return false; }
    }
    refused = claim;
    winston.warn(`[server-audio] the desktop player (pid ${claim.pid}) claims port ${claim.port}, but nothing answered there as the gui face within ${deps.adoptWaitMs} ms — leaving it alone until its claim changes`);
    return false;
  }

  // One adoption at a time: a boot and a tick that both see the claim share
  // the attempt.
  function runAdoption(claim) {
    if (adopting) { return adopting; }
    const attempt = adopt(claim).finally(() => { if (adopting === attempt) { adopting = null; } });
    adopting = attempt;
    return attempt;
  }

  // One look, every claimPollMs while server audio is on: a claim that
  // appeared is taken up, an adopted player that is gone is replaced. Stands
  // aside for a boot in flight (that chain looks for itself) and for an
  // adoption in flight.
  function tick() {
    if (adopting || bootInFlight) { return; }
    if (!deps.autoBoot()) { stopWatching(); return; }
    const claim = liveClaim();
    if (desktop) {
      if (!sameRun(claim, desktop)) {
        winston.info(`[server-audio] the desktop player (pid ${desktop.pid}) is gone — the headless engine takes over`);
        desktop = null;
        engineAnswering = true;
        boot().catch(() => {});
      }
      return;
    }
    if (refused && !sameRun(claim, refused)) {
      // The refused claim is gone, or is a new one. Forget it — and when
      // the headless engine died meanwhile (of the port that claimant was
      // sitting on, most likely: a bind failure), this is its way back.
      refused = null;
      if (!engine) {
        boot().catch(() => {});
        return;
      }
    }
    if (!claim || sameRun(claim, refused)) { return; }
    const gen = stopGen;
    runAdoption(claim).then((ok) => {
      // Refused: the headless engine the attempt stopped comes back — and
      // finds its port free, or dies of the same conflict with a line of
      // its own.
      if (!ok && gen === stopGen) { return boot(); }
      return undefined;
    }).catch(() => {});
  }

  function startWatching() {
    if (watcher) { return; }
    watcher = setInterval(tick, deps.claimPollMs);
    watcher.unref?.();
  }

  function stopWatching() {
    if (watcher) { clearInterval(watcher); watcher = null; }
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
    if (engine || desktop) { return; }

    // Off means off: nothing is probed, fetched, spawned — or watched.
    if (!deps.autoBoot()) { return; }

    // On: the desktop player's claim is looked at from now on, and one that
    // is already there is taken up before anything is spawned — a server
    // starting beside an open player never spawns a headless engine only to
    // stop it a moment later.
    startWatching();
    const claim = liveClaim();
    if (claim && !sameRun(claim, refused)) {
      if (await runAdoption(claim)) { return; }
      if (gen !== stopGen) { return; }
    }

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
   * header) — taking the desktop player up on its claim when one is open,
   * spawning the headless engine otherwise. Idempotent and single-flight:
   * while a boot is in progress every caller awaits the same chain, and once
   * an engine is up further calls return at once. Resolves when the engine
   * has been spawned (not when it is ready to answer) or adopted, or when
   * there is nothing to start. Never rejects for an engine that merely
   * failed to start; that is logged.
   */
  function boot() {
    if (engine || desktop) { return Promise.resolve(); }
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
  // flight, stop watching the claim, let go of the desktop player, send the
  // kill. Split out so the process-exit hook can run it without awaiting
  // anything (trackExit=false: see below).
  function beginStop(trackExit = true) {
    stopGen += 1;
    bootInFlight = null;
    stopWatching();
    refused = null;
    if (desktop) {
      // Not ours to kill: the person is using it. The server merely stops
      // driving it.
      winston.info(`[server-audio] letting go of the desktop player (pid ${desktop.pid}) — it plays on by itself`);
      desktop = null;
    }
    killEngine(trackExit);
  }

  // Kill the headless engine's live generation and, unless told not to
  // wait, track its exit in pendingExit (see there). Only the process:
  // stopGen, the boot in flight and the desktop player are beginStop's.
  function killEngine(trackExit = true) {
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
   * Stop the engine — the headless one is killed, the desktop player merely
   * let go of. Resolves once a killed engine has exited (or STOP_WAIT_MS has
   * passed with the kill still sent) — including an engine that an EARLIER
   * stop() killed and that is still on its way out — so a restart() that
   * follows spawns into a free port. Never rejects.
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

  // Proxy one request to an engine's loopback HTTP API. `target` names the
  // port, the token (the desktop player's face wants it on every route but
  // GET /version; the headless engine, spawned without one, wants none), the
  // record whose silence counts, and what to call it in the log.
  function proxyToRust(target, method, rustPath, body) {
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
      if (target.token) { headers['x-auth-token'] = target.token; }
      const options = {
        hostname: '127.0.0.1',
        port: target.port,
        path: rustPath,
        method: method,
        headers,
        timeout: RUST_REQUEST_TIMEOUT_MS
      };

      // The caller gets a generic 503; the real reason (ECONNREFUSED, a reset,
      // a timeout) is logged here, once per outage. A timeout destroys the
      // request, which then also emits 'error' — by then the flag is down, so
      // the pair logs a single line. Only the LIVE engine's silence is news: a
      // poll that was in flight when stop() took its engine down fails too,
      // and that is a restart, not an outage — nor may a stale request touch
      // the flag of the engine that replaced it.
      const who = target.who;
      const failed = (why, message) => {
        if (current() === who) {
          if (engineAnswering) {
            winston.warn(`[server-audio] ${target.label} stopped answering on port ${options.port}: ${why}`);
          }
          engineAnswering = false;
        }
        reject(unavailable(message));
      };

      const req = http.request(options, (res) => {
        if (current() === who) { engineAnswering = true; }
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

  // Proxy to whichever engine is up — the desktop player first, since while
  // it is adopted no headless engine runs — or reject with a 503 WebError
  // when none is; see unavailable() at the top of this file.
  function proxy(method, rustPath, body) {
    if (desktop) {
      return proxyToRust({ who: desktop, port: desktop.port, token: desktop.token, label: 'the desktop player' }, method, rustPath, body);
    }
    if (engine) {
      return proxyToRust({ who: engine, port: deps.port(), token: null, label: 'mstream-player' }, method, rustPath, body);
    }
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
