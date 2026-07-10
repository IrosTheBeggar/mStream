// Fault-injection preload for backup-worker tests: kills the worker
// process mid-way through a FRESH large-file streaming copy (the fourth
// 256KB write to a .mstream-partial-* file opened with 'w'), simulating
// a crash / power loss during a big copy. The partial left behind must
// contain exactly the bytes that were written — the sequential-write
// invariant the resume/finalise paths depend on.
const fs = require('fs');

const realOpen = fs.promises.open.bind(fs.promises);
let writes = 0;

fs.promises.open = async (p, flags, mode) => {
  const handle = await realOpen(p, flags, mode);
  if (String(p).includes('.mstream-partial-') && String(flags) === 'w') {
    const realWrite = handle.write.bind(handle);
    handle.write = (...args) => {
      writes++;
      if (writes > 3) { process.exit(137); }
      return realWrite(...args);
    };
  }
  return handle;
};
