// The deep pre-flip probe (`--boot-probe`, src/util/boot-probe.js) as the
// installers run it: a real wrapper child process, judged only by its exit
// code and its "boot-probe:" sentinel lines. The full staging-refusal path
// (server -> install.sh -> probe -> refusal) lives in update-check.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { attemptsFilePath } from '../../src/util/boot-watchdog.js';
import { SCHEMA_VERSION } from '../../src/db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function dataHomeOf(home) {
  return process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'mStream')
    : process.platform === 'win32'
      ? path.join(home, 'localappdata', 'mStream')
      : path.join(home, '.local', 'share', 'mstream');
}

function runProbe(home, extraArgs = []) {
  return spawnSync(process.execPath, ['cli-boot-wrapper.js', '--boot-probe', ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: path.join(home, 'localappdata'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
    },
  });
}

async function makeDb(dir, userVersion) {
  const { DatabaseSync } = await import('../../src/db/sqlite-driver.js');
  await fs.mkdir(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'mstream.db'));
  db.exec(`PRAGMA user_version = ${userVersion}`);
  db.close();
}

test('a probeable machine passes, and the probe creates NOTHING', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-probe-fresh-'));
  try {
    const r = runProbe(home);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^boot-probe: ok /m);
    // Purity is the whole contract: the probe runs while the OLD server is
    // live, and it must never generate a config, open a db read-write, or
    // count a boot attempt (same rule as -V).
    assert.deepEqual(await fs.readdir(home), [], 'the probe must create nothing');
  } finally {
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }
});

test('a config this build cannot parse or validate fails the probe with the sentinel', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-probe-cfg-'));
  try {
    const bad = path.join(home, 'bad.json');
    await fs.writeFile(bad, 'not json at all{');
    let r = runProbe(home, ['-j', bad]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^boot-probe: FAIL config .* did not parse/m);

    const badSchema = path.join(home, 'bad-schema.json');
    await fs.writeFile(badSchema, JSON.stringify({ port: 'nope' }));
    r = runProbe(home, ['-j', badSchema]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^boot-probe: FAIL config .* fails this build's schema/m);
    assert.equal(await fs.stat(attemptsFilePath(dataHomeOf(home))).catch(() => null), null,
      'a probe failure is not a boot attempt');
  } finally {
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }
});

test('a BOM\'d config parses — the probe must agree with the boot on PowerShell-written files', async () => {
  // PowerShell 5.1's `Set-Content -Encoding UTF8` prepends a UTF-8 BOM
  // (mStream#908's Windows smoke). The boot strips it (util/atomic-json.js
  // stripBom); the probe must too, or a config the real boot accepts would
  // block staging as "a config this build refuses".
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-probe-bom-'));
  try {
    const conf = path.join(home, 'bom.json');
    await fs.writeFile(conf, '﻿' + JSON.stringify({ port: 3999 }), 'utf8');
    const r = runProbe(home, ['-j', conf]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^boot-probe: ok /m);
    // Purity holds: the probe reads tolerantly but never rewrites the file.
    assert.equal((await fs.readFile(conf, 'utf8')).charCodeAt(0), 0xFEFF);
  } finally {
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }
});

test('a database from this build\'s future fails the probe; a current one passes', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-probe-db-'));
  try {
    const dbDir = path.join(home, 'db');
    const conf = path.join(home, 'conf.json');
    await fs.writeFile(conf, JSON.stringify({ storage: { dbDirectory: dbDir } }));

    await makeDb(dbDir, SCHEMA_VERSION + 50);
    let r = runProbe(home, ['-j', conf]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^boot-probe: FAIL this build's database schema .* predates the existing database/m);

    await makeDb(dbDir, SCHEMA_VERSION);
    r = runProbe(home, ['-j', conf]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`db schema v${SCHEMA_VERSION}<=v${SCHEMA_VERSION}`));
  } finally {
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }
});
