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
// installed before any other module can write (covers Bun self-dispatched
// workers too, which re-enter the wrapper).

function guard(stream) {
  if (stream && typeof stream.on === 'function') {
    stream.on('error', () => { /* see above — console loss is never fatal */ });
  }
}

guard(process.stdout);
guard(process.stderr);
