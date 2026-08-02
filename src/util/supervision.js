// The server must not outlive its supervision.
//
// When another process spawns mStream as a managed child (the desktop app, a
// wrapper script), the server's stdout/stderr are pipes into that parent. If
// the parent dies abruptly — crash, force-kill — nothing on Unix or Windows
// cleans the child up: the server lives on as an orphan the supervisor no
// longer knows about, holding the port the supervisor will try to reuse when
// it relaunches. Today that orphan doesn't even fail cleanly: its first
// console write after the parent's death raises EPIPE on the raw stream,
// which no one listens for, so the runtime kills it with an uncaught
// exception — at some arbitrary later moment, mid-request, with the crash
// report lost down the same dead pipe. (logger.js's `exitOnError: false`
// doesn't cover this: the error fires on the stream, outside winston.)
//
// An unowned server squatting the supervisor's port is a liability, not a
// feature — so both mechanisms here resolve lost supervision the same way:
// log the reason, then shut down cleanly. process.exit() fires the
// kill-queue 'exit' hook (src/state/kill-list.js), which reaps the scanner /
// backup / playback children, so this rides the same teardown path as a
// signal-driven stop.
//
//  1. Console loss (always on): an 'error' on stdout/stderr — EPIPE from a
//     dead reader is the canonical case — triggers shutdown with a distinct
//     exit code instead of an uncaught crash. Lazy by nature: it only fires
//     when the server next writes. Installed via this module's import side
//     effect, which is why it must be the FIRST import of
//     cli-boot-wrapper.js — armed before any other module can write.
//  2. `--supervised` (opt-in): the server watches stdin and shuts down the
//     moment it hits EOF — which is exactly what the spawning parent's death
//     produces. Event-driven and immediate: no waiting for the next log
//     line, no PID polling, portable everywhere. Supervisors that pass the
//     flag MUST hold a live stdin pipe open; it is opt-in because a
//     standalone daemonized server (`mstream < /dev/null`, nohup) sees EOF
//     instantly and would self-terminate at boot.
//
// Workers are exempt from both: their stdout is the line-protocol IPC
// channel to the server that spawned them, that pipe can only die with the
// server itself, and their EPIPE crash-death is the existing, correct
// teardown (Node-mode workers fork loose scripts and never load this module;
// the argv check below keeps Bun self-dispatched workers — which re-enter
// the wrapper — identical). The flag literal mirrors WORKER_FLAG_PREFIX in
// worker-process.js; kept inline because this module must import nothing.

// sysexits EX_IOERR. Deliberately nonzero: an uncaught EPIPE crash exits 1
// today, and a supervisor configured to restart on failure (systemd
// Restart=on-failure after a journald bounce broke the log stream) should
// keep doing so — a restart is exactly what re-establishes logging.
const EXIT_CONSOLE_LOST = 74;

let shuttingDown = false;

// Log why, give the file transport a beat to flush, then exit. The
// winston.warn is safe even when the console is the thing that broke: the
// stream watcher below is already attached, so the Console transport's
// failing write surfaces as a guarded 'error' event, while the ring buffer
// and file transports still record the entry. Dynamic import keeps this
// module dependency-free at load time (and is a cached no-op by the time
// anything can fail).
function shutdown(reason, code) {
  if (shuttingDown) { return; }
  shuttingDown = true;
  import('winston')
    .then(w => (w.default || w).warn(reason))
    .catch(() => { /* shutting down regardless */ })
    .finally(() => {
      setTimeout(() => process.exit(code), 400);
    });
}

function watchStream(stream, name) {
  if (!stream || typeof stream.on !== 'function') { return; }
  stream.on('error', err => {
    const cause = (err && err.code) || 'stream error';
    shutdown(`[supervision] ${name} write failed (${cause}) — console lost, shutting down`,
      EXIT_CONSOLE_LOST);
  });
}

// `--supervised`: treat stdin EOF as "the supervisor is gone". Exit code 0 —
// from the server's perspective this is an orderly, expected stop.
export function watchSupervisorStdin() {
  const done = () => shutdown('[supervision] supervisor closed stdin — shutting down', 0);
  process.stdin.on('end', done);
  process.stdin.on('error', done);
  process.stdin.resume();
}

const isWorker = process.argv.some(a => a.startsWith('--mstream-worker='));

if (!isWorker) {
  watchStream(process.stdout, 'stdout');
  watchStream(process.stderr, 'stderr');
}
