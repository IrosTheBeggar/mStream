// Keep console breakage from killing the server.
//
// stdout/stderr are pipes whenever a supervisor spawned us — the desktop app,
// Docker, npm, a service manager. If that parent dies without reaping us
// (crash, force-kill, double-launch cleanup), the pipes lose their reader and
// the next console write raises EPIPE. winston's Console transport writes to
// process.stdout with no 'error' listener, so the runtime escalates that to an
// uncaught exception: an orphaned-but-healthy server drops dead the moment it
// logs anything — often mid-request, and observed in the field when a mere
// ping or an admin call made an orphan log itself to death. Its crash report
// goes down the same dead pipe, so nothing is ever captured. (logger.js's
// `exitOnError: false` doesn't cover this: the error fires on the raw stream,
// outside winston.)
//
// mStream is a daemon, not a shell filter — losing the console must never
// take the server down. Swallow write errors on the two std streams; the
// file and in-memory ring transports keep logging either way. Imported for
// its side effect as the FIRST import of cli-boot-wrapper.js, so the guard is
// installed before any other module can write.

// One breadcrumb per process: the first failed write drops a note into the
// live-log ring so the admin viewer records that console output stopped.
let noted = false;

function guard(stream, name) {
  if (!stream || typeof stream.on !== 'function') { return; }
  stream.on('error', err => {
    // Console loss is never fatal (see header). The note is routed straight
    // into the ring — NOT through winston, whose Console transport would
    // write to the very stream that just broke. Lazy import keeps this
    // module dependency-free at load time; by the time a write can fail,
    // logger.js is long since cached.
    if (noted) { return; }
    noted = true;
    import('../logger.js')
      .then(l => l.noteStreamFailure(name, err && err.code))
      .catch(() => { /* logging must never throw */ });
  });
}

// Workers keep fail-fast stdio. A worker's stdout is not a console — it's the
// line-protocol IPC channel to the server that spawned it, and that pipe's
// read end can only die with the server itself. EPIPE there means "your
// consumer is gone", and dying on it is the correct teardown (it also matches
// Node-mode workers, which fork loose scripts and never load this module —
// only Bun self-dispatched workers re-enter the wrapper). The flag literal
// mirrors WORKER_FLAG_PREFIX in worker-process.js; kept inline because this
// module must import nothing.
const isWorker = process.argv.some(a => a.startsWith('--mstream-worker='));

if (!isWorker) {
  guard(process.stdout, 'stdout');
  guard(process.stderr, 'stderr');
}
