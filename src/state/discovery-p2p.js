// Node-side client for the p2p-sidecar — the Rust companion process that
// gives the music-discovery network its iroh-blobs transport (and, next
// phase, its iroh-gossip catalog).
//
// WHY A SIDECAR (and not @number0/iroh): the NAPI binding exposes only the
// connection layer — no iroh-blobs, no iroh-gossip — and n0 has deprioritized
// FFI parity. n0's guidance is an app-specific Rust wrapper; ours lives in
// its own repo (IrosTheBeggar/mstream-p2p-sidecar) and ships as versioned
// release assets there, pinned by the committed bin/p2p-sidecar manifests
// and fetched on first use (src/util/p2p-sidecar-bootstrap.js) — no
// binaries in git on either side.
//
// SHAPE: the sidecar is a LONG-RUNNING child (unlike the run-and-exit
// rust-parser) speaking line-delimited JSON-RPC over stdio; see the sidecar
// repo's src/main.rs for the protocol. It exits on stdin EOF, so this
// process dying can never leave an orphan. Its identity keypair lives at
// {dbDirectory}/discovery-p2p/identity.key — deliberately SEPARATE from the
// remote-access tunnel's key (config.program.iroh.secretKey) so the public
// discovery persona is unlinkable to the private paired-access endpoint.
//
// GRACEFUL DEGRADATION: importing this module never throws and never spawns.
// start() resolves the binary lazily (prebuilt → local cargo build) and
// fails with an actionable error when neither exists — callers surface that
// to the admin instead of crashing the server.

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import winston from 'winston';
import { appRoot } from '../util/esm-helpers.js';
import * as sidecarBootstrap from '../util/p2p-sidecar-bootstrap.js';
import * as config from './config.js';

// Unsolicited sidecar events surface here:
//   'announcement' → { from, payload }   a peer's signed catalog announcement
//                                        (signature already verified in Rust)
//   'neighbor'     → { up, id }          gossip mesh membership changes
// The catalog module (discovery-catalog.js) is the main subscriber.
export const events = new EventEmitter();

// Unexpected-death hook, set by the stack (discovery-p2p-stack.js).
//
// The sidecar is a child process, so an OOM kill, a panic, or an operator's
// `kill` takes it down with nobody asking — and NOTHING used to put it back:
// start() has exactly one real caller (the stack's boot), and the two
// periodic passes that could have noticed (the mesh-health watch, the
// catalog prune) both return early on `!isRunning()`. A server therefore sat
// off the network, config still saying "enabled", until someone restarted it
// by hand.
//
// Deliberately NOT routed through `events` above: that emitter re-emits
// whatever the child names in its `event` field, so a buggy sidecar could
// synthesize its own resurrection. This is a private channel the child
// cannot reach.
//
// The handler gets the whole stack replayed, not a bare respawn — the topic
// subscription, the announce payload and the holds beacon all live in the
// sidecar's memory and die with it. A respawn without them yields the worst
// state of all: a process that reports `running: true` while being just as
// invisible to the network as no process at all.
let unexpectedExitHandler = null;
export function setUnexpectedExitHandler(fn) { unexpectedExitHandler = fn; }

const ext = process.platform === 'win32' ? '.exe' : '';
// musl detection mirrors task-queue.js's rust-parser resolution.
const isMusl = process.platform === 'linux' && !process.report?.getReport()?.header?.glibcVersionRuntime;
const libcSuffix = isMusl ? '-musl' : '';

const RPC_TIMEOUT_MS = 30000;
const FETCH_TIMEOUT_MS = 10 * 60 * 1000; // cross-network blob pulls can be slow
const READY_TIMEOUT_MS = 30000;
const SHUTDOWN_GRACE_MS = 5000;

let proc = null;          // live child process (null when stopped)
let endpointId = null;    // from the sidecar's ready event
let endpointTicket = null; // full dialable address (relay + direct), from ready
let nextId = 1;
let readyPromise = null;  // in-flight start() so concurrent callers share one spawn
// Bumped by stop(). start() used to spawn synchronously, so a stop() always
// found `proc` set and could kill it; now that acquiring the binary can
// involve a DOWNLOAD, a stop() landing inside that window would find
// proc=null, no-op, and the child would spawn seconds later into a stack
// that believes it's stopped (config off, sidecar running — the B1
// reboot-review bug class). A start chain must therefore re-check its
// generation right before spawning and abort if a stop overtook it.
let startGen = 0;
const pending = new Map(); // id -> { resolve, reject, timer }

// A binary already on disk — a nested-clone cargo build (see below), an
// operator-placed prebuilt in bin/p2p-sidecar/, or a previously fetched
// managed install (see p2p-sidecar-bootstrap.js; the binaries left git in
// favor of sha256-pinned GitHub release assets). Returns null when none
// exists — deliberately NO implicit `cargo build` fallback here (unlike the
// scanner): this resolves inside admin HTTP requests, and a surprise
// 10-minute compile inside a request is worse than a clear error. The
// DOWNLOAD lives in start()'s async path, never here — status routes call
// this synchronously and must stay side-effect free.
export function resolveSidecarBinary() {
  const name = `p2p-sidecar-${process.platform}-${process.arch}${libcSuffix}${ext}`;
  const prebuilt = path.join(appRoot, 'bin', 'p2p-sidecar', name);
  const localBuild = path.join(appRoot, 'p2p-sidecar', 'target', 'release', `p2p-sidecar${ext}`);
  // Local build first: the crate lives in its own repo now
  // (IrosTheBeggar/mstream-p2p-sidecar), and the dev loop is cloning it into
  // this checkout as p2p-sidecar/ (gitignored) and `cargo build --release`
  // — that build may be newer than anything prebuilt or fetched.
  if (fs.existsSync(localBuild)) { return localBuild; }
  if (fs.existsSync(prebuilt)) {
    try { fs.chmodSync(prebuilt, 0o755); } catch (_err) { /* zip extraction can strip +x; spawn will surface real failures */ }
    return prebuilt;
  }
  // The managed (fetched) install — same path as `prebuilt` for a plain
  // checkout, but a distinct writable dir when appRoot is read-only (a
  // translocated .app, a system-prefix install).
  const managed = sidecarBootstrap.managedSidecarPath();
  if (managed !== prebuilt && fs.existsSync(managed)) { return managed; }
  return null;
}

export function dataDir() {
  return path.join(config.program.storage.dbDirectory, 'discovery-p2p');
}

export function isRunning() { return proc !== null && endpointId !== null; }

export function getEndpointId() { return endpointId; }

// The sidecar's own endpoint ticket — what another operator pastes into
// their bootstrapPeers to befriend this server.
export function getEndpointTicket() { return endpointTicket; }

// Acquire a binary to spawn. A dev build or an operator-placed prebuilt wins
// untouched; otherwise the bootstrap fetches (or refreshes) the managed
// install from the manifest-pinned release assets — so the first start on a
// fresh checkout downloads ~20 MB once, with every byte sha256-verified
// against the committed manifest, instead of every clone carrying all nine
// platforms' binaries forever. Failures reject with the bootstrap's own
// actionable cause (checksum refused, no build published, download failed).
async function acquireSidecarBinary() {
  const bin = resolveSidecarBinary();
  // Local build / operator prebuilt: theirs to manage, never second-guessed.
  // Only the MANAGED path flows through ensureSidecar(), which also picks up
  // pinned updates for installs it made itself (receipt-gated).
  if (bin && bin !== sidecarBootstrap.managedSidecarPath()) { return bin; }
  const ensured = await sidecarBootstrap.ensureSidecar();
  if (ensured) { return ensured; }
  if (bin) { return bin; } // on disk but unmanaged coverage — still spawnable
  throw new Error(
    'p2p-sidecar binary not found and no downloadable build is pinned for this platform — ' +
    'place a prebuilt at bin/p2p-sidecar/, or clone+build the sidecar repo into this checkout ' +
    '(see bin/p2p-sidecar/README.md)');
}

// Start the sidecar (idempotent; concurrent callers await the same spawn).
// Resolves once the sidecar's ready event arrives. Rejects with an
// actionable message when the binary is missing/unfetchable or the process
// dies first.
export function start() {
  if (isRunning()) { return Promise.resolve({ endpointId }); }
  if (readyPromise) { return readyPromise; }

  const gen = startGen;
  const promise = acquireSidecarBinary().then((bin) => new Promise((resolve, reject) => {
    if (gen !== startGen) {
      // A stop() (or a stop/start cycle) overtook this chain while the
      // binary was downloading — spawning now would orphan a sidecar into a
      // stack that believes it's stopped. The download itself isn't wasted:
      // it landed in the managed dir, and the successor chain's ensure
      // found or joined it.
      reject(new Error('p2p-sidecar start aborted — stop() arrived while the binary was being acquired'));
      return;
    }
    fs.mkdirSync(dataDir(), { recursive: true });
    const child = spawn(bin, ['--data-dir', dataDir()], { stdio: ['pipe', 'pipe', 'pipe'] });
    proc = child;

    // Pipe errors must never be fatal. An rpc() that lands in the window
    // between the child dying and Node delivering its 'exit' event writes
    // into a broken pipe: EPIPE. The write callback in rpc() already turns
    // that into a rejected request — but a Writable ALSO emits 'error', and
    // an unhandled 'error' on a stream is an uncaught exception, i.e. the
    // whole music server going down because a status poll lost a race with
    // an OOM kill. The status route polls exactly there, so this is a
    // reachable crash, not a theoretical one. Same reasoning for the read
    // side, where a mid-line destroy surfaces on the readline source.
    child.stdin.on('error', (err) => {
      winston.debug(`[p2p-sidecar] stdin: ${err.message}`);
    });
    child.stdout.on('error', (err) => {
      winston.debug(`[p2p-sidecar] stdout: ${err.message}`);
    });
    child.stderr.on('error', (err) => {
      winston.debug(`[p2p-sidecar] stderr: ${err.message}`);
    });

    const readyTimer = setTimeout(() => {
      reject(new Error('p2p-sidecar did not become ready in time'));
      try { child.kill(); } catch (_err) { /* already gone */ }
    }, READY_TIMEOUT_MS);

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch (_err) {
        winston.warn(`[p2p-sidecar] unparseable output line: ${line.slice(0, 200)}`);
        return;
      }
      if (msg.event === 'ready') {
        clearTimeout(readyTimer);
        endpointId = msg.endpointId;
        endpointTicket = msg.ticket || null;
        winston.info(`[p2p-sidecar] ready — endpointId=${endpointId}`);
        resolve({ endpointId });
        return;
      }
      if (msg.event) {
        // Unsolicited event (announcement / neighbor) — hand off to listeners.
        events.emit(msg.event, msg);
        return;
      }
      const waiter = pending.get(msg.id);
      if (!waiter) { return; }
      pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.ok) { waiter.resolve(msg); } else { waiter.reject(new Error(msg.error || 'sidecar error')); }
    });

    readline.createInterface({ input: child.stderr }).on('line', (line) => {
      winston.debug(`[p2p-sidecar] ${line}`);
    });

    child.on('error', (err) => {
      clearTimeout(readyTimer);
      teardown(`spawn failed: ${err.message}`);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(readyTimer);
      const why = `exited (code=${code} signal=${signal})`;
      // Was this death ASKED FOR? stop() bumps startGen before it touches
      // anything else, so a generation mismatch means the shutdown is ours —
      // no warn, and above all no recovery racing the teardown. Computed
      // before teardown(), which clears endpointId.
      const unexpected = endpointId !== null && gen === startGen;
      if (unexpected) { winston.warn(`[p2p-sidecar] ${why}`); }
      teardown(why);
      reject(new Error(`p2p-sidecar ${why}`));
      // Last, so the module is already back to a clean stopped state by the
      // time the stack tries to start a replacement.
      if (unexpected && unexpectedExitHandler) {
        try { unexpectedExitHandler(why); } catch (err) {
          winston.warn(`[p2p-sidecar] unexpected-exit handler threw: ${err.message}`);
        }
      }
    });
  })).finally(() => {
    // Only OUR slot: stop() may already have detached this chain so a fresh
    // start() could begin — never null out the successor's promise.
    if (readyPromise === promise) { readyPromise = null; }
  });
  readyPromise = promise;

  return readyPromise;
}

function teardown(why) {
  proc = null;
  endpointId = null;
  endpointTicket = null;
  for (const [, waiter] of pending) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error(`p2p-sidecar ${why}`));
  }
  pending.clear();
}

// Send one request; resolves with the sidecar's response object.
export function rpc(cmd, params = {}, timeoutMs = RPC_TIMEOUT_MS) {
  if (!proc) { return Promise.reject(new Error('p2p-sidecar is not running')); }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`p2p-sidecar request timed out (${cmd})`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    proc.stdin.write(JSON.stringify({ id, cmd, ...params }) + '\n', (err) => {
      if (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

// Publish a file as a content-addressed blob. Returns { hash, size, ticket }.
export async function publish(filePath) {
  await start();
  return rpc('publish', { path: filePath });
}

// Fetch a blob into outDir. Returns { hash, size, path }. Addressing is
// either { ticket } (full self-contained address) or { hash, provider }
// (the catalog flow — provider resolves via the sidecar's address book /
// discovery).
export async function fetch(addressing, outDir) {
  await start();
  return rpc('fetch', { ...addressing, outDir }, FETCH_TIMEOUT_MS);
}

export async function status() {
  await start();
  return rpc('status');
}

// Join the well-known catalog topic. bootstrap = endpoint tickets (dialable
// with zero external discovery) and/or bare endpoint ids (resolved via n0
// discovery). Idempotent — later calls feed extra peers into the mesh.
export async function join(bootstrap = []) {
  await start();
  return rpc('join', { bootstrap });
}

// Sign + broadcast our snapshot announcement; the sidecar re-broadcasts it
// every ~15s (gossip has no history — late joiners rely on re-announces).
export async function announce(payload) {
  await start();
  return rpc('announce', { payload });
}

// Replace this node's advertised hold-set (own snapshot + fetched shelf).
// Lenient when the sidecar isn't running — holds are re-pushed on the next
// publish/fetch anyway, and beacons are periodic, not precious.
export function setHolds(hashes) {
  if (!isRunning()) { return Promise.resolve({ set: false, offline: true }); }
  return rpc('setHolds', { hashes });
}

// Unpin a blob so the sidecar store's GC reclaims it. Lenient offline for
// the same reason — a missed forget costs disk until the next one, not
// correctness.
export function forget(hash) {
  if (!isRunning()) { return Promise.resolve({ forgotten: false, offline: true }); }
  return rpc('forget', { hash });
}

// The blob hash of our own currently-published snapshot (null before the
// first publish). Included in the holds beacon; superseded hashes are
// forgotten so re-publishes don't accumulate in the store.
let ownSnapshotHash = null;
export function getOwnSnapshotHash() { return ownSnapshotHash; }

// Publish the current export snapshot as a blob and broadcast its signed
// announcement — the one code path shared by server boot and the admin
// announce route. Throws when no export snapshot exists (callers turn that
// into a 404 / boot no-op as appropriate). Dynamic imports keep this module
// import-light for the paths that never announce.
export async function announceCurrentSnapshot() {
  const discoveryExport = await import('../db/discovery-export.js');
  const manifest = discoveryExport.readManifest();
  if (!manifest || !discoveryExport.snapshotExists()) {
    throw new Error('no discovery export snapshot to announce');
  }
  // Re-adding the blob is idempotent and guarantees the announced hash
  // matches the file on disk even if the export was rebuilt while the
  // sidecar was down.
  const pub = await publish(discoveryExport.snapshotPath());
  const discoveryDb = await import('../db/discovery-db.js');
  const snapshotSeq = discoveryDb.openDiscoveryDbIfExists()
    ? Number(discoveryDb.getMeta('row_seq') || 0) : 0;
  const payload = {
    hash: pub.hash,
    size: pub.size,
    rowCount: manifest.rowCount || 0,
    modelId: (manifest.model && manifest.model.id) || '',
    modelVersion: (manifest.model && manifest.model.version) || '',
    snapshotSeq,
    name: config.program.discoveryP2p.serverName,
    description: config.program.discoveryP2p.serverDescription,
  };
  const result = await announce(payload);

  // GC the superseded snapshot blob and refresh the holds beacon — a
  // re-publish must not leave the old bytes pinned in the sidecar store,
  // and the network should hear about the new hash promptly.
  if (ownSnapshotHash && ownSnapshotHash !== pub.hash) {
    forget(ownSnapshotHash).catch((err) => winston.debug(`[discovery-p2p] forget old snapshot: ${err.message}`));
  }
  ownSnapshotHash = pub.hash;
  import('./discovery-peer-dbs.js')
    .then((peerDbs) => peerDbs.pushHolds())
    .catch((err) => winston.debug(`[discovery-p2p] holds push after announce failed: ${err.message}`));

  return { ...pub, announced: true, broadcast: !!result.broadcast, payload };
}

// Auto-publish: rebuild the export snapshot and announce it whenever the
// collected dataset has advanced past what the network last saw. This is
// what makes a fresh server APPEAR on the network with zero admin steps
// (scan → embed → here → announced) — before it existed, a server stayed
// invisible until an operator manually curl'd export + announce. Cheap to
// call often: it compares discovery_meta.row_seq against the manifest's
// sourceRowSeq watermark and no-ops when the published snapshot is
// current. announceEvenIfFresh re-broadcasts an up-to-date snapshot (the
// boot path — a restarted sidecar needs its announce payload back).
let autoPublishInFlight = false;
export async function maybeAutoPublishSnapshot({ announceEvenIfFresh = false } = {}) {
  if (config.program.discoveryP2p.enabled !== true) { return { published: false }; }
  if (autoPublishInFlight) { return { published: false }; }
  autoPublishInFlight = true;
  try {
    const discoveryExport = await import('../db/discovery-export.js');
    const discoveryDb = await import('../db/discovery-db.js');
    if (!discoveryDb.openDiscoveryDbIfExists()) { return { published: false }; }
    const rowSeq = Number(discoveryDb.getMeta('row_seq') || 0);
    const manifest = discoveryExport.readManifest();
    const stale = !manifest || !discoveryExport.snapshotExists()
      || Number(manifest.sourceRowSeq || 0) < rowSeq;
    if (stale) {
      if (rowSeq === 0) { return { published: false }; } // nothing collected yet
      const built = await discoveryExport.exportDiscoverySnapshot();
      winston.info(`[discovery-p2p] dataset advanced (seq ${rowSeq}) — rebuilt export `
        + `(${built.rowCount} tracks) for announcement`);
    } else if (!announceEvenIfFresh) {
      return { published: false };
    }
    const r = await announceCurrentSnapshot();
    winston.info(`[discovery-p2p] announced snapshot ${r.hash.slice(0, 12)}… `
      + `(${r.payload.rowCount} tracks, seq ${r.payload.snapshotSeq})`);
    return { published: true, hash: r.hash, rebuilt: stale };
  } finally {
    autoPublishInFlight = false;
  }
}

// Graceful stop: ask politely, then close stdin (the sidecar's EOF exit
// path), then SIGKILL as the last resort.
export async function stop() {
  // Abort any start chain still acquiring its binary (see startGen), and
  // detach it so a subsequent start() begins fresh instead of joining the
  // doomed chain. Its ensure-download keeps running harmlessly — the fresh
  // chain's ensure joins it via the bootstrap's single-flight.
  startGen++;
  readyPromise = null;
  if (!proc) { return; }
  const child = proc;
  try { await rpc('shutdown', {}, SHUTDOWN_GRACE_MS); } catch (_err) { /* it may already be gone */ }
  try { child.stdin.end(); } catch (_err) { /* noop */ }
  await new Promise((resolve) => {
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_err) { /* noop */ }
      resolve();
    }, SHUTDOWN_GRACE_MS);
    child.once('exit', () => { clearTimeout(killTimer); resolve(); });
  });
  teardown('stopped');
}
