import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every role passed to launchWorker() must have a matching case in
// maybeRunWorker(). Under Node the two never meet — child.fork() runs the
// script path directly and the switch is bypassed entirely — so a missing
// case is invisible to every other test while silently killing the feature
// in every shipped Bun standalone binary, where the role string IS the
// dispatch (the binary re-invokes itself with --mstream-worker=<role>).
// That is exactly how the acoustid backfill shipped dead.

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { out.push(...jsFiles(full)); }
    else if (/\.(js|mjs)$/.test(entry)) { out.push(full); }
  }
  return out;
}

const files = jsFiles(SRC);

const launchedRoles = new Set();
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/launchWorker\(\s*['"]([\w-]+)['"]/g)) {
    launchedRoles.add(m[1]);
  }
}

const dispatcher = readFileSync(join(SRC, 'util', 'worker-process.js'), 'utf8');
const dispatchedRoles = new Set(
  [...dispatcher.matchAll(/case\s+['"]([\w-]+)['"]\s*:/g)].map(m => m[1])
);

test('every launchWorker role has a self-dispatch case (Bun standalone contract)', () => {
  assert.ok(launchedRoles.size >= 7, `expected to find the worker call sites, found ${launchedRoles.size}`);
  const missing = [...launchedRoles].filter(r => !dispatchedRoles.has(r));
  assert.deepEqual(missing, [],
    `roles launched but not dispatched in maybeRunWorker(): ${missing.join(', ')} — these die with "Unknown mStream worker role" in every Bun standalone binary`);
});

test('every dispatched role points at a worker module that exists on disk', () => {
  const cases = [...dispatcher.matchAll(/case\s+['"]([\w-]+)['"]\s*:\s*await import\('([^']+)'\)/g)];
  assert.ok(cases.length >= 7, `expected the dispatch switch to be found, got ${cases.length} cases`);
  for (const [, role, spec] of cases) {
    // Existence check, not an import: worker modules run their job ON import
    // (each reads its payload from argv), so importing one here would execute
    // it. The specifier must also be a static literal — that is the only form
    // Bun's bundler can see and embed into the standalone binary.
    const resolved = fileURLToPath(new URL(spec, new URL('../../src/util/', import.meta.url)));
    assert.doesNotThrow(() => statSync(resolved),
      `role '${role}' dispatches to ${spec}, which does not exist at ${resolved}`);
  }
});
