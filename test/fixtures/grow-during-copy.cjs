// Fault-injection preload for backup-worker tests: simulates a source
// file being WRITTEN while the worker copies it. Wraps fs.promises
// .copyFile — after the real copy of a source path containing
// env GROW_MATCH, it appends bytes to that SOURCE file, so the worker's
// post-copy re-stat (assertSrcUnchanged) sees a size that no longer
// matches the pre-copy stat. Models the torn-copy race deterministically
// (append-after-copy is indistinguishable to the re-stat from
// grew-during-copy).
const fs = require('fs');

const match = process.env.GROW_MATCH || '';
const real = fs.promises.copyFile.bind(fs.promises);

fs.promises.copyFile = async (src, dest, mode) => {
  const r = await real(src, dest, mode);
  if (match && String(src).includes(match)) {
    fs.appendFileSync(src, 'MORE-BYTES-APPENDED-MID-COPY');
  }
  return r;
};
