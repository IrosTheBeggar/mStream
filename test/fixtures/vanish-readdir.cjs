// Fault-injection preload for backup-worker tests: deletes the directory
// named by env VANISH_DIR immediately before its Nth readdir (default
// 2nd), so the readdir sees ENOENT — simulating a source directory that
// the parent listing saw but that unmounted/vanished before the child
// walk reached it. Call #1 is the worker's hasAnyFiles pre-flight pass;
// call #2 is the merge-walk's readSortedDir.
const fs = require('fs');
const path = require('path');

const target = process.env.VANISH_DIR ? path.resolve(process.env.VANISH_DIR) : '';
const fireOn = Number(process.env.VANISH_ON_CALL || 2);
const real = fs.promises.readdir.bind(fs.promises);
let calls = 0;

fs.promises.readdir = (p, opts) => {
  if (target && path.resolve(String(p)) === target) {
    calls++;
    if (calls === fireOn) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
  return real(p, opts);
};
