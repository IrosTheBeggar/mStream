const killThese = [];

// Run the queue exactly once. The signal handlers below call process.exit(),
// which fires 'exit' — without the guard every registered kill function
// would run twice on a signal-driven shutdown.
let ran = false;
function runKillQueue() {
  if (ran) { return; }
  ran = true;
  killThese.forEach(func => {
    if (typeof func === 'function') {
      try {
        func();
      } catch (_err) {
        console.log('Error: Failed to run kill function');
      }
    }
  });
}

process.on('exit', _code => {
  // Kill them all
  runKillQueue();
});

// 'exit' alone is NOT enough: Node only emits it on clean exits
// (process.exit(), event-loop drain, or the default uncaught-exception
// path). A signal with default disposition terminates the process WITHOUT
// emitting 'exit' — `kill <pid>` / systemd SIGTERM, Ctrl+Break's SIGBREAK
// — so every child registered here (scanner, backup worker, server
// playback, syncthing) was orphaned by a signal-driven shutdown. An
// orphaned scanner keeps writing to the DB and lock-fights the next
// server instance, including its boot migrations.
//
// After draining the queue the handler re-raises the signal with default
// disposition rather than calling process.exit(128 + n): supervisors
// distinguish death-by-signal from a normal exit with a big code —
// systemd counts SIGTERM death as a clean stop but 'status=143' as a
// failure (and Restart=on-failure would then restart on every
// `systemctl stop`). The setImmediate exit is a backstop for platforms
// where the re-raise can't terminate (Windows signal emulation).
//
// SIGHUP is deliberately NOT handled: installing a listener would
// override the SIG_IGN disposition inherited from nohup, turning a closed
// terminal into a kill for `nohup mstream &` deployments. A SIGHUP-killed
// server orphans its scanner, but the boot-time reaper
// (src/db/scan-pidfile.js) picks that up — same as TerminateProcess /
// `taskkill /F`, where no JS can run at all.
//
// Windows notes: SIGINT (Ctrl+C) and SIGBREAK are deliverable; a SIGTERM
// listener is accepted but never fires (registering is harmless).
const SIGNAL_EXIT_CODES = { SIGINT: 2, SIGTERM: 15, SIGBREAK: 21 };
for (const [sig, num] of Object.entries(SIGNAL_EXIT_CODES)) {
  try {
    process.on(sig, () => {
      runKillQueue();
      process.removeAllListeners(sig);
      try { process.kill(process.pid, sig); } catch (_err) { /* fall through to backstop */ }
      setImmediate(() => process.exit(128 + num));
    });
  } catch (_err) { /* signal not supported on this platform */ }
}

export function addToKillQueue(func) {
  killThese.push(func);
}

export function removeFromKillQueue(func) {
  const idx = killThese.indexOf(func);
  if (idx !== -1) {
    killThese.splice(idx, 1);
  }
}
