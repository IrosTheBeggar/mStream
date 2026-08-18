// Atomic, per-file-serialized JSON writes for state files other code READS
// concurrently — the config file above all.
//
// Why: `fs.writeFile` is open(O_TRUNC) followed by write(). A reader that
// lands between the two — and since the soft reboot re-reads the config
// file within microseconds of the admin save that triggered it (server.js
// reboot -> serveIt -> config.setup), a second admin save racing the first
// puts a reader exactly there — sees '' or a prefix, JSON.parse throws, and
// serveIt exits the process (measured on Windows: 0.2-0.4% of concurrent
// write/read pairs torn; 2.7-4% of concurrent admin-save pairs killing the
// server, under both node and bun). Writing to a sibling temp file and
// rename()ing it over the target makes every reader see either the old
// document or the new one, never a partial. Serializing writes to the same
// path keeps two saves from interleaving their temp+rename dance (and keeps
// the last-issued write the one that lands last).
//
// Windows: rename over an open file can fail transiently (EPERM/EBUSY —
// an AV scanner or an editor holding the target for a moment); a few short
// retries cover that. The temp file lives next to the target so the rename
// stays on one filesystem.
import fs from 'node:fs/promises';
import path from 'node:path';

const chains = new Map();   // absolute path -> tail of the write chain
const completed = new Map(); // absolute path -> number of writes that have landed
let seq = 0;

// How many writes to `file` have COMPLETED (rename done). A reader that
// captures this before reading and compares afterwards knows whether a write
// may have landed after its read — server.js's reboot uses it to decide
// whether a coalesced reboot request still needs a re-run.
export function completedWrites(file) {
  return completed.get(path.resolve(file)) || 0;
}

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function replaceFile(tmp, file) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (err) {
      if (!RETRY_CODES.has(err.code) || attempt >= 5) {
        try { await fs.unlink(tmp); } catch (_) { /* leave nothing behind, best effort */ }
        throw err;
      }
      await sleep(20 * (attempt + 1));
    }
  }
}

// Serialize `data` as pretty JSON and atomically replace `file` with it.
// Resolves when the new content is durably the file's content; concurrent
// calls for the same path run in call order.
export function writeJsonAtomic(file, data) {
  return updateJsonAtomic(file, () => data);
}

// Same, but `produce(current)` runs INSIDE the per-file chain — after every
// earlier write has landed and before any later one starts — with `current`
// = the file's document as it is at that moment (null when unreadable /
// absent). Whatever it returns is written. This is the primitive a
// read-modify-write needs to not clobber a concurrent writer's change: the
// read and the write are one serialized step.
export function updateJsonAtomic(file, produce) {
  const key = path.resolve(file);
  const prev = chains.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    let current;
    try { current = JSON.parse(await fs.readFile(key, 'utf8')); } catch (_) { current = null; }
    const data = await produce(current);
    const tmp = `${key}.${process.pid}.${++seq}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await replaceFile(tmp, key);
    completed.set(key, (completed.get(key) || 0) + 1);
  });
  chains.set(key, run);
  const forget = () => { if (chains.get(key) === run) { chains.delete(key); } };
  run.then(forget, forget);
  return run;
}
