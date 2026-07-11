// Fault-injection preload for backup-worker tests. Reverses the results
// of fs.promises.readdir for any path under REVERSE_READDIR_DIR —
// simulating a destination filesystem whose enumeration order differs
// from the source's (legal and real: ext4 orders readdir by per-
// directory hash seeds, so two directories with identical names can
// enumerate in different orders; NTFS is upcase-ordinal and always
// agrees, which is why this shim is needed to exercise order-divergence
// on the CI hosts at all). The CJS `fs.promises` object is the same
// object `import fs from 'fs/promises'` resolves to, so the patch is
// visible to the worker's ESM imports.
const fs = require('fs');
const path = require('path');

const target = process.env.REVERSE_READDIR_DIR
  ? path.resolve(process.env.REVERSE_READDIR_DIR)
  : null;

const orig = fs.promises.readdir;
fs.promises.readdir = async function patchedReaddir(p, opts) {
  const res = await orig.call(this, p, opts);
  if (target && path.resolve(String(p)).startsWith(target)) {
    return res.slice().reverse();
  }
  return res;
};
