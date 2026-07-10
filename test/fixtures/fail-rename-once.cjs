// Fault-injection preload for backup-worker tests: the FIRST rename onto
// a destination path containing 'FAILRENAME' throws EACCES, later ones
// succeed. Simulates a transient finalise failure after a large file's
// partial is fully staged — the next run must finalise the surviving
// complete partial without re-copying any bytes.
const fs = require('fs');

const real = fs.promises.rename.bind(fs.promises);
let fired = false;

fs.promises.rename = (a, b) => {
  if (!fired && String(b).includes('FAILRENAME')) {
    fired = true;
    const err = new Error('EACCES: permission denied (fault injection: fail-rename-once.cjs)');
    err.code = 'EACCES';
    return Promise.reject(err);
  }
  return real(a, b);
};
