/**
 * `pretest` guard — runs once before `npm test`.
 *
 *   1. Builds the shared fixture library serially, up front. The runner then
 *      executes test files concurrently; without this each cold-checkout run
 *      would have many processes racing to encode the same fixtures. (The
 *      generator is also race-safe on its own — see fixtures.mjs — but doing
 *      it once here avoids the redundant work and surfaces problems early.)
 *   2. Fails fast with an actionable message when ffmpeg is missing, instead
 *      of a cryptic spawn error deep into the suite.
 *   3. Soft-warns when the optional rust-parser binary is absent — scanner
 *      parity tests fall back to the JS scanner / skip, so it isn't fatal.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureFixtures, FIXTURE_SUMMARY } from './fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

try {
  const dir = await ensureFixtures();
  console.log(`✓ fixtures ready — ${FIXTURE_SUMMARY.trackCount} tracks at ${dir}`);
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}

const ext  = process.platform === 'win32' ? '.exe' : '';
const libc = process.platform === 'linux' ? '-musl' : '';
const rustParser = [
  path.join(REPO_ROOT, 'rust-parser', 'target', 'release', `rust-parser${ext}`),
  path.join(REPO_ROOT, 'bin', 'rust-parser',
    `rust-parser-${process.platform}-${process.arch}${libc}${ext}`),
].find(p => existsSync(p));

if (rustParser) {
  console.log(`✓ rust-parser — ${rustParser}`);
} else {
  console.log('• rust-parser binary not found — scanner tests use the JS fallback (some may skip).');
}
