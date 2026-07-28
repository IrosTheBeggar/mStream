// Fault-injection preload for backup-worker tests. Loaded into the
// worker child process via NODE_OPTIONS=--require so every
// fs.promises.utimes call fails the way a root-squash NFS / attribute-
// denying SMB / ENOSYS FUSE destination would. The CJS `fs.promises`
// object is the same object `import fs from 'fs/promises'` resolves to,
// so patching it here is visible to the worker's ESM imports.
const fs = require('fs');

fs.promises.utimes = () => {
  const err = new Error('EPERM: operation not permitted (fault injection: fail-utimes.cjs)');
  err.code = 'EPERM';
  return Promise.reject(err);
};
