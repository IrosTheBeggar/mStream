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
// emitting 'exit' — `kill <pid>` / systemd SIGTERM, a closed terminal's
// SIGHUP, Ctrl+Break's SIGBREAK — so every child registered here (scanner,
// backup worker, server playback) was orphaned by a
// signal-driven shutdown. An orphaned scanner keeps writing to the DB and
// lock-fights the next server instance, including its boot migrations.
//
// After draining the queue the handler re-raises the signal with default
// disposition rather than calling process.exit(128 + n): supervisors
// distinguish death-by-signal from a normal exit with a big code —
// systemd counts SIGTERM death as a clean stop but 'status=143' as a
// failure (and Restart=on-failure would then restart on every
// `systemctl stop`). The setImmediate exit is a backstop for platforms
// where the re-raise can't terminate (Windows signal emulation).
//
// SIGHUP gets a handler too. The obvious objection — "a listener would
// override the SIG_IGN that nohup set, killing `nohup mstream &` on
// terminal close" — turns out to be moot: Node itself resets inherited
// signal dispositions at startup (verified empirically on v22.5 and v24,
// the whole supported engine range — a nohup'd `node -e setInterval(...)`
// dies on SIGHUP with zero listeners installed, while a nohup'd `sleep`
// survives). nohup'd servers die on terminal close either way; with the
// handler they at least take their scanner with them instead of leaving
// an orphan for the next boot's reaper.
//
// Windows notes: SIGINT (Ctrl+C) and SIGBREAK are deliverable; SIGTERM
// and SIGHUP listeners are accepted but never fire (registering is
// harmless). Task Manager / `taskkill /F` is TerminateProcess — no JS
// runs at all — which is the boot reaper's territory.
const SIGNAL_EXIT_CODES = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGBREAK: 21 };
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
