// Fault-injection preload for backup-worker tests: fs.copyFile throws
// ENOSPC for any source path containing 'FAILCOPY', simulating a
// destination running out of space mid-run. Used to assert the
// trash-after-staging ordering: a failed replacement copy must leave
// the OLD dest copy live and untouched.
const fs = require('fs');

const real = fs.promises.copyFile.bind(fs.promises);

fs.promises.copyFile = (src, dest, mode) => {
  if (String(src).includes('FAILCOPY')) {
    const err = new Error('ENOSPC: no space left on device (fault injection: fail-copyfile.cjs)');
    err.code = 'ENOSPC';
    return Promise.reject(err);
  }
  return real(src, dest, mode);
};
