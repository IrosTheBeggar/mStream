// Fixture for test/integration/harness-orphan-cleanup.test.mjs — NOT a test
// file itself (no .test.mjs suffix, so `npm test` never collects it; the
// outer test runs it with `node --test <this file>`).
//
// Models the failure that hung `node --test` on Windows: a before() hook that
// starts a server and then throws (in the real suites, the sibling startServer
// of a Promise.all pair failing its 90 s scan window under load). The
// variable the suite's after() would stop is never assigned, so only the
// harness itself can clean the server up.
import fs from 'node:fs';
import { describe, before, test } from 'node:test';
import { startServer } from '../../helpers/server.mjs';

describe('a before() that orphans its server', () => {
  before(async () => {
    const server = await startServer({ dlnaMode: 'disabled', waitForScan: false });
    fs.writeFileSync(process.env.ORPHAN_PID_FILE, String(server.proc.pid));
    throw new Error('sibling boot failed (simulated)');
  });

  test('never runs', () => {});
});
