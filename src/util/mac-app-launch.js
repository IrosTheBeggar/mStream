// Desktop affordances for the macOS .app bundle (#802).
//
// The darwin release wraps the server binary in mStream.app so Finder shows
// an icon — but the binary is a faceless CLI process. Launched by a
// double-click, it gets no terminal: stdout goes to /dev/null, cwd is /, and
// nothing the CLI prints can reach the user. Historically the launch LOOKED
// dead (Dock bounce → "Application Not Responding") while the server was in
// fact up and serving. The Info.plist now marks the bundle LSUIElement so
// macOS expects no window; this module supplies the feedback instead:
//
//   - detachForFinderLaunch — hop out of LaunchServices' running-app
//     registry so every double-click acts, instead of only the first
//   - announceReady    — open the web UI in the default browser
//   - announceBootFailure — native alert instead of a silent exit
//   - handleListenError   — port taken by an existing mStream (the
//     double-clicked-it-again case) → reopen the browser at it; anything
//     else → alert
//
// This module ships start, restart-feedback, and error affordances but no STOP
// one: as an LSUIElement agent the server has no Dock presence and no Quit, so
// stopping a Finder-launched instance today means Activity Monitor or `kill`
// (re-clicking only reopens the browser via handleListenError). A user-facing
// Quit is deferred to the planned macOS menu-bar status item (tray/autostart
// work), which will drive a graceful-shutdown path rather than a bare kill.
//
// Every hook is a no-op unless the process was launched AS the bundle.
// LaunchServices stamps the launched app's own bundle id into
// __CFBundleIdentifier; a terminal run inherits the terminal's id (e.g.
// com.apple.Terminal) and a service manager sets none, so those keep pure
// CLI behavior. The id must match CFBundleIdentifier in the Info.plist
// staged by scripts/build-bun.mjs.
import { spawn } from 'child_process';
import winston from 'winston';
import { isBunStandalone } from './esm-helpers.js';
import { CHALLENGE_HEADER, PROOF_HEADER, newChallenge, verifyProof } from './instance-proof.js';

export const MAC_BUNDLE_ID = 'io.mstream.server';

// Exported for tests; the runtime flag below binds it to the real process.
export function detectMacAppLaunch(platform, env) {
  return platform === 'darwin' && env.__CFBundleIdentifier === MAC_BUNDLE_ID;
}

export const isMacAppLaunch = detectMacAppLaunch(process.platform, process.env);

// LaunchServices keeps a launched app in its running-application registry
// and routes every later double-click to the EXISTING process as a reopen
// Apple Event — which a faceless server (no event loop) can never receive,
// so re-clicks would visibly do nothing. Instead the LS-launched process
// hands off: re-spawn itself detached (with a guard so the copy doesn't
// recurse) and exit at once. LS unregisters on exit, so every double-click
// starts a fresh process that either becomes the server (announceReady
// opens the UI) or finds the port already served and refocuses the browser
// (handleListenError). Returns true when the caller should exit now.
export function detachForFinderLaunch() {
  if (!isMacAppLaunch || process.env.MSTREAM_MAC_APP_DETACHED) { return false; }
  // User args: a standalone binary's argv is [exe, embedded-entry, ...args];
  // a source run's is [runtime, script, ...args] and must keep the script.
  const args = isBunStandalone ? process.argv.slice(2) : process.argv.slice(1);
  let child;
  try {
    child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, MSTREAM_MAC_APP_DETACHED: '1' },
    });
  } catch (err) {
    winston.warn(`[launch] could not detach (${err.message}) — booting in this process instead`);
    return false;
  }
  // A spawn failure surfaces asynchronously as 'error'; unhandled, that kills
  // this process. It also means no server: we are about to exit on the
  // assumption a child took over. There is no pid in that case, so fall
  // through to booting in-process rather than exiting into silence.
  child.on('error', (err) => {
    winston.warn(`[launch] detached copy failed to start: ${err.message}`);
  });
  if (!child.pid) {
    winston.warn('[launch] detach produced no child — booting in this process instead');
    return false;
  }
  child.unref();
  return true;
}

// Browser-reachable host for a listen address: wildcard binds → localhost,
// an explicit bind → that address (localhost may not be bound at all there).
// Exported for tests.
export function urlHost(address) {
  if (!address || address === '::' || address === '0.0.0.0') { return 'localhost'; }
  return address.includes(':') ? `[${address}]` : address;
}

// Every helper below is spawned on a path where the server is otherwise
// healthy, so a spawn failure must degrade to a log line, never to an
// unhandled 'error' event — that would turn a stripped image with no
// /usr/bin/open into a crash immediately after a successful boot.
function spawnHelper(bin, args, what) {
  try {
    const child = spawn(bin, args, { stdio: 'ignore', detached: true });
    child.on('error', (err) => winston.warn(`[launch] ${what} failed: ${err.message}`));
    child.unref();
  } catch (err) {
    winston.warn(`[launch] ${what} could not be started: ${err.message}`);
  }
}

function openInBrowser(url) {
  // /usr/bin/open resolves the user's default browser. Detached so the
  // helper never ties to our lifetime.
  spawnHelper('/usr/bin/open', [url], 'opening the browser');
}

// Native dialog via osascript — the only channel a Finder launch has for
// fatal errors. The text rides in as argv (not spliced into the script), so
// no quoting/injection concerns. Detached: the dialog must outlive the
// exiting server process.
function alert(message) {
  spawnHelper('/usr/bin/osascript', [
    '-e', 'on run argv',
    '-e', 'display alert "mStream" message (item 1 of argv) as critical',
    '-e', 'end run',
    message,
  ], 'showing the error dialog');
}

// Open the UI once the server is listening. Once per process: reboot()
// re-runs serveIt, and an admin-panel reboot must not pop a second tab.
let announced = false;
export function announceReady(protocol, port, address) {
  if (!isMacAppLaunch || announced) { return; }
  announced = true;
  openInBrowser(`${protocol}://${urlHost(address)}:${port}`);
}

export function announceBootFailure(message) {
  if (!isMacAppLaunch) { return; }
  alert(message);
}

// Ask whatever is already on the port whether it is OUR mStream.
//
// A marker header can't answer that — any local process can set one — and
// getting it wrong matters: a "yes" makes us open the user's browser at that
// port and exit 0, handing a squatter the real UI's origin, where the web
// client keeps its token in localStorage. So we challenge and make the server
// prove it: send fresh random bytes, require back HMAC(nonce, challenge) where
// the nonce is the per-boot secret mirrored into a 0600 file only our own user
// can read (written by server.js). No nonce on disk, no proof, or a mismatch
// all mean "not provably ours" → the caller alerts instead of redirecting.
//
// The nonce never leaves this process, so nothing an impostor observes helps it
// answer, and a stale nonce file from a previous boot can't be replayed by a
// squatter that never saw it. TLS verification stays off: a self-signed cert is
// normal for a home server, and the proof — not the cert — is the identity.
function probeExistingServer(protocol, port, address, expectedNonce) {
  return new Promise((resolve) => {
    if (!expectedNonce) { resolve(false); return; }
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const challenge = newChallenge();
    import(protocol === 'https' ? 'https' : 'http').then(({ default: mod }) => {
      const req = mod.get({
        host: urlHost(address).replace(/^\[|\]$/g, ''),
        port,
        path: '/',
        timeout: 2000,
        rejectUnauthorized: false,
        headers: { [CHALLENGE_HEADER]: challenge },
      }, (res) => {
        res.resume();
        done(verifyProof(expectedNonce, challenge, res.headers[PROOF_HEADER]));
      });
      req.on('timeout', () => { req.destroy(); });
      // 'close' is the only settle signal Bun guarantees here: its
      // ClientRequest.destroy(err) emits no 'error', so a squatter that
      // accepts the connection and then stalls would hang this promise
      // forever — and with it the caller's exit path, leaving a
      // double-click with no browser, no alert, and no exit at all.
      req.on('close', () => done(false));
      req.on('error', () => done(false));
    }).catch(() => done(false));
  });
}

// EADDRINUSE on an app launch is almost always "the user double-clicked
// mStream again while the first one is still running" — the right outcome is
// their music in a browser tab, not an error. Returns true when it handled
// the situation that way (caller should exit 0 — this process is redundant,
// not failed); false means the caller should treat it as the fatal error it
// is (an alert has been shown when app-launched).
export async function handleListenError(err, protocol, port, address, expectedNonce) {
  if (!isMacAppLaunch) { return false; }
  if (err.code === 'EADDRINUSE' && await probeExistingServer(protocol, port, address, expectedNonce)) {
    winston.info(`mStream already running on port ${port} — opening the browser at the existing instance`);
    openInBrowser(`${protocol}://${urlHost(address)}:${port}`);
    return true;
  }
  alert(err.code === 'EADDRINUSE'
    ? `mStream could not start: port ${port} is already in use by another application.`
    : `mStream could not start: ${err.message}`);
  return false;
}
