// Locate a bun executable for a suite's bun legs.
//
// MSTREAM_TEST_BUN_BIN points at a bun executable when `bun` on PATH is not
// spawnable without a shell (npm's bun.ps1/bun.cmd shim on Windows). `noBun`
// is a skip reason when no bun runs here, so a Node-only machine still passes:
// use it as describe('bun', { skip: noBun }, ...).
import { spawnSync } from 'node:child_process';

export const BUN_BIN = process.env.MSTREAM_TEST_BUN_BIN || 'bun';
const probe = spawnSync(BUN_BIN, ['--version'], { encoding: 'utf8', windowsHide: true });
export const noBun = (!probe.error && probe.status === 0) ? false : 'bun is not installed on this machine';
// CI must not let a broken setup-bun turn every bun leg into a silent green skip.
if (noBun && process.env.GITHUB_ACTIONS) {
  throw new Error(`bun was not found in CI (MSTREAM_TEST_BUN_BIN=${process.env.MSTREAM_TEST_BUN_BIN ?? ''}): test.yml installs it on every job, so this is a broken install, not a skip`);
}
export const bunVersion = noBun ? null : probe.stdout.trim();
