// Child half of the file-lock probe (src/db/journal-mode.js). The parent
// holds an EXCLUSIVE SQLite lock on each database in the payload; a lock this
// process can see makes its read fail with SQLITE_BUSY. One verdict line on
// stdout, in payload order:
//
//   {"results":["locked","readable"]}
//
// 'locked' = the parent's lock is visible here (correct), 'readable' = it is
// not, anything else = the read failed for another reason.
//
// Payload = the LAST argv element, JSON: { paths: [...] } — the worker-script
// convention (src/util/worker-process.js).
import { DatabaseSync } from './sqlite-driver.js';

function finish(verdict, code) {
  // Exit from the write callback: pipe writes are asynchronous on macOS.
  process.stdout.write(`${JSON.stringify(verdict)}\n`, () => process.exit(code));
}

let paths = null;
try {
  ({ paths } = JSON.parse(process.argv[process.argv.length - 1]));
} catch (_err) {
  finish({ error: 'probe payload is not JSON' }, 2);
}

if (Array.isArray(paths)) {
  const results = paths.map((dbPath) => {
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      db.exec('PRAGMA busy_timeout = 0');
      db.prepare('SELECT count(*) AS n FROM sqlite_master').get();
      return 'readable';
    } catch (err) {
      return (err.errcode & 0xff) === 5 ? 'locked' : `error: ${err.message}`;
    } finally {
      try { db?.close(); } catch (_err) { /* never opened */ }
    }
  });
  finish({ results }, 0);
}
