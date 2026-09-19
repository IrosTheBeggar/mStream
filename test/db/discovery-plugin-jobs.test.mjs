/**
 * discovery_plugin_jobs data access (src/db/discovery-plugin-jobs.js), the
 * per-user settings store (src/db/user-settings.js) and the job runner
 * (src/discovery-plugins/jobs.js), in-process against a real mstream.db in a
 * temp dir — the DB-backed suite pattern (config.setup + manager.initDB).
 *
 * The runner is driven by hand (tick()) with throwaway plug-ins registered
 * for the test: a finishing one, a failing one, and a slow one that honours
 * cancellation between steps.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let config;
let manager;
let jobsDb;
let settings;
let runner;
let registry;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeoutMs = 5000, everyMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) { return v; }
    if (Date.now() > deadline) { throw new Error('timed out'); }
    await sleep(everyMs);
  }
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-plugin-jobs-'));
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    port: 3000,
    storage: { dbDirectory: tmpDir },
    discoveryPlugins: { 'unit-done': { enabled: true }, 'unit-fail': { enabled: true }, 'unit-slow': { enabled: true } },
    discoveryJobs: { maxConcurrent: 2 },
  }));
  config = await import('../../src/state/config.js');
  await config.setup(path.join(tmpDir, 'config.json'));
  config.program.storage = { ...(config.program.storage || {}), dbDirectory: tmpDir };
  manager = await import('../../src/db/manager.js');
  manager.initDB();
  jobsDb = await import('../../src/db/discovery-plugin-jobs.js');
  settings = await import('../../src/db/user-settings.js');
  registry = await import('../../src/discovery-plugins/registry.js');
  runner = await import('../../src/discovery-plugins/jobs.js');

  registry.registerPlugin({ name: 'unit-done', title: 'Done', capabilities: ['acquire'], scope: 'server',
    async run(ctx) { ctx.progress(0.5, 'halfway'); return { got: ctx.recommendation.title }; } });
  registry.registerPlugin({ name: 'unit-fail', title: 'Fail', capabilities: ['handoff'], scope: 'user',
    async run() { throw new Error('nope'); } });
  registry.registerPlugin({ name: 'unit-slow', title: 'Slow', capabilities: ['acquire'], scope: 'server', concurrency: 1,
    async run(ctx) {
      for (let i = 0; i < 100; i++) {
        if (ctx.isCancelled()) { return { stoppedAt: i }; }
        ctx.progress(i / 100, `step ${i}`);
        await sleep(20);
      }
      return { finished: true };
    } });
});

after(() => {
  runner.stop();
  try { manager.close(); } catch { /* already closed */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* windows locks */ }
  setImmediate(() => process.exit(0)); // module-level timers, like the other DB-backed suites
});

const rec = (title) => ({ artist: 'A', title, album: null, year: null, isrc: null, releaseGroupMbid: null, recordingMbid: null, duration: null, exportId: null, filepath: null, source: 'p2p', peer: null });

describe('jobs data access', () => {
  test('createJob dedupes on a live (plugin, key); finished history does not block', () => {
    const a = jobsDb.createJob({ plugin: 'unit-done', userId: null, key: 'text:one', recommendation: rec('One') });
    assert.equal(a.created, true);
    assert.equal(a.job.state, 'queued');
    assert.deepEqual(a.job.recommendation, rec('One'));
    const b = jobsDb.createJob({ plugin: 'unit-done', userId: null, key: 'text:one', recommendation: rec('One') });
    assert.equal(b.created, false);
    assert.equal(b.job.id, a.job.id, 'the existing live job comes back');
    // Take it through the state machine by hand.
    const claimed = jobsDb.claimNextQueued('unit-done');
    assert.equal(claimed.id, a.job.id);
    assert.equal(claimed.state, 'running');
    assert.equal(claimed.attempts, 1);
    assert.equal(jobsDb.claimNextQueued('unit-done'), null, 'nothing else queued');
    jobsDb.updateProgress(a.job.id, 0.25, 'quarter');
    assert.equal(jobsDb.getJob(a.job.id).progress, 0.25);
    jobsDb.finishJob(a.job.id, { ok: 1 });
    const done = jobsDb.getJob(a.job.id);
    assert.equal(done.state, 'done');
    assert.deepEqual(done.result, { ok: 1 });
    assert.equal(done.progress, 1);
    assert.ok(done.finishedAt >= done.startedAt);
    const c = jobsDb.createJob({ plugin: 'unit-done', userId: null, key: 'text:one', recommendation: rec('One') });
    assert.equal(c.created, true, 'a finished job no longer blocks');
    jobsDb.requestCancel(c.job.id);
  });

  test('requestCancel: queued → cancelled now, running → flagged, finished → null', () => {
    const q = jobsDb.createJob({ plugin: 'unit-done', key: 'text:cq', recommendation: rec('CQ') }).job;
    assert.equal(jobsDb.requestCancel(q.id), 'cancelled');
    assert.equal(jobsDb.getJob(q.id).state, 'cancelled');
    assert.equal(jobsDb.requestCancel(q.id), null);

    const r = jobsDb.createJob({ plugin: 'unit-done', key: 'text:cr', recommendation: rec('CR') }).job;
    jobsDb.claimNextQueued('unit-done');
    assert.equal(jobsDb.requestCancel(r.id), 'requested');
    assert.equal(jobsDb.isCancelRequested(r.id), true);
    jobsDb.cancelJob(r.id);
    assert.equal(jobsDb.getJob(r.id).state, 'cancelled');
  });

  test('listJobs filters by owner and state; requeueInterrupted and pruneFinished', () => {
    // user_id is a real foreign key (V74): owners must exist.
    const ins = manager.getDB().prepare('INSERT INTO users (username, password, salt) VALUES (?, ?, ?)');
    const u1 = Number(ins.run('owner-one', 'h', 's').lastInsertRowid);
    const u2 = Number(ins.run('owner-two', 'h', 's').lastInsertRowid);
    const mine = jobsDb.createJob({ plugin: 'unit-done', userId: u1, key: 'text:mine', recommendation: rec('Mine') }).job;
    jobsDb.createJob({ plugin: 'unit-done', userId: u2, key: 'text:theirs', recommendation: rec('Theirs') });
    assert.deepEqual(jobsDb.listJobs({ userId: u1 }).map((j) => j.id), [mine.id]);
    assert.ok(jobsDb.listJobs({ states: ['queued'] }).length >= 2);
    jobsDb.claimNextQueued('unit-done');   // one of them is now 'running'
    assert.equal(jobsDb.requeueInterrupted(), 1, 'the running job goes back to the queue on boot');
    assert.equal(jobsDb.listJobs({ states: ['running'] }).length, 0);
    for (const j of jobsDb.listJobs({ states: ['queued'] })) { jobsDb.requestCancel(j.id); }
    assert.ok(jobsDb.pruneFinished(-1) >= 2, 'a cut-off in the future prunes everything finished');
  });
});

describe('user settings', () => {
  test('round-trips JSON, hides secrets in the client view, deletes', () => {
    const uid = Number(manager.getDB().prepare("INSERT INTO users (username, password, salt) VALUES ('carol', 'h', 's')").run().lastInsertRowid);
    settings.setUserSetting(uid, 'discovery-plugin:listenbrainz', 'username', 'carol_lb');
    settings.setUserSetting(uid, 'discovery-plugin:listenbrainz', 'token', 'lb-secret-token', { secret: true });
    settings.setUserSetting(uid, 'discovery-plugin:listenbrainz', 'opts', { love: true, n: 3 });
    assert.equal(settings.getUserSetting(uid, 'discovery-plugin:listenbrainz', 'token'), 'lb-secret-token', 'server-side read sees the secret');
    assert.deepEqual(settings.getUserSettings(uid, 'discovery-plugin:listenbrainz'), { username: 'carol_lb', token: 'lb-secret-token', opts: { love: true, n: 3 } });
    const described = settings.describeUserSettings(uid, 'discovery-plugin:listenbrainz');
    const token = described.find((s) => s.key === 'token');
    assert.equal(token.secret, true);
    assert.equal(token.set, true);
    assert.ok(!('value' in token), 'a secret never leaves with its value');
    assert.deepEqual(described.find((s) => s.key === 'opts').value, { love: true, n: 3 });
    assert.equal(settings.getUserSetting(uid, 'discovery-plugin:listenbrainz', 'missing'), undefined);
    assert.equal(settings.deleteUserSetting(uid, 'discovery-plugin:listenbrainz', 'token'), true);
    assert.equal(settings.getUserSetting(uid, 'discovery-plugin:listenbrainz', 'token'), undefined);
    assert.throws(() => settings.setUserSetting(uid, 'Bad Namespace!', 'k', 1), /invalid namespace/);
    assert.throws(() => settings.setUserSetting(uid, 'ns', 'bad key!', 1), /invalid key/);
  });
});

describe('job runner', () => {
  test('start re-queues interrupted work, runs jobs, records results, failures and cancels', async () => {
    const done = jobsDb.createJob({ plugin: 'unit-done', key: 'text:run-done', recommendation: rec('Runs') }).job;
    const fail = jobsDb.createJob({ plugin: 'unit-fail', key: 'text:run-fail', recommendation: rec('Fails') }).job;
    const slow = jobsDb.createJob({ plugin: 'unit-slow', key: 'text:run-slow', recommendation: rec('Slow') }).job;
    // Something the "previous process" left running.
    manager.getDB().prepare("UPDATE discovery_plugin_jobs SET state = 'running' WHERE id = ?").run(done.id);

    runner.start();
    assert.equal(runner.isRunning(), true);
    await until(() => jobsDb.getJob(done.id).state === 'done');
    assert.deepEqual(jobsDb.getJob(done.id).result, { got: 'Runs' });
    await until(() => jobsDb.getJob(fail.id).state === 'failed');
    assert.equal(jobsDb.getJob(fail.id).error, 'nope');

    await until(() => jobsDb.getJob(slow.id).state === 'running' && (jobsDb.getJob(slow.id).progress || 0) > 0.02);
    assert.equal(jobsDb.requestCancel(slow.id), 'requested');
    await until(() => jobsDb.getJob(slow.id).state === 'cancelled');
    const cancelled = jobsDb.getJob(slow.id);
    assert.equal(cancelled.cancelRequested, true);
    assert.equal(runner.runningCount(), 0);
  });

  test('a disabled plug-in is not run; the global cap holds', async () => {
    config.program.discoveryPlugins['unit-done'].enabled = false;
    const j = jobsDb.createJob({ plugin: 'unit-done', key: 'text:off', recommendation: rec('Off') }).job;
    runner.kick();
    await sleep(150);
    assert.equal(jobsDb.getJob(j.id).state, 'queued', 'left alone while the plug-in is off');
    config.program.discoveryPlugins['unit-done'].enabled = true;
    runner.kick();
    await until(() => jobsDb.getJob(j.id).state === 'done');

    config.program.discoveryJobs.maxConcurrent = 1;
    const s1 = jobsDb.createJob({ plugin: 'unit-slow', key: 'text:s1', recommendation: rec('Slow 1') }).job;
    const s2 = jobsDb.createJob({ plugin: 'unit-slow', key: 'text:s2', recommendation: rec('Slow 2') }).job;
    runner.kick();
    await until(() => jobsDb.getJob(s1.id).state === 'running');
    await sleep(100);
    assert.equal(jobsDb.getJob(s2.id).state, 'queued', 'second slow job waits for the cap');
    jobsDb.requestCancel(s1.id);
    await until(() => jobsDb.getJob(s2.id).state === 'running');
    jobsDb.requestCancel(s2.id);
    await until(() => jobsDb.getJob(s2.id).state === 'cancelled');
    runner.stop();
    assert.equal(runner.isRunning(), false);
  });
});

describe('results after the fact, and the retention pass', () => {
  test('patchResult amends a finished job only; findByDownloadedFilepath finds the job behind a file', () => {
    const { job } = jobsDb.createJob({ plugin: 'unit-done', userId: null, key: 'text:patch-1', recommendation: { title: 'patch' } });
    assert.equal(jobsDb.patchResult(job.id, { kept: true }), null, 'a queued job has no result to amend');
    jobsDb.claimNextQueued('unit-done');
    jobsDb.finishJob(job.id, { downloaded: { filepath: 'discover-downloads/shared/patch.mp3' }, match: { score: 1 } });
    const patched = jobsDb.patchResult(job.id, { kept: { filepath: 'music/a/b/patch.mp3' } });
    assert.deepEqual(patched.result, {
      downloaded: { filepath: 'discover-downloads/shared/patch.mp3' }, match: { score: 1 }, kept: { filepath: 'music/a/b/patch.mp3' },
    });
    assert.deepEqual(jobsDb.findByDownloadedFilepath('discover-downloads/shared/patch.mp3').map((j) => j.id), [job.id]);
    assert.deepEqual(jobsDb.findByDownloadedFilepath('discover-downloads/shared/other.mp3'), []);
  });

  test('pruneFinished measures from the clock it is given', () => {
    const { job } = jobsDb.createJob({ plugin: 'unit-done', userId: null, key: 'text:prune-clock', recommendation: { title: 'prune' } });
    jobsDb.claimNextQueued('unit-done');
    jobsDb.finishJob(job.id, { ok: true });
    const day = 24 * 60 * 60 * 1000;
    assert.equal(jobsDb.pruneFinished(30 * day, Date.now() + 29 * day), 0, 'not old enough yet');
    assert.ok(jobsDb.getJob(job.id));
    assert.ok(jobsDb.pruneFinished(30 * day, Date.now() + 31 * day) >= 1);
    assert.equal(jobsDb.getJob(job.id), null);
  });

  test('sweep: expired downloads go with their rows and tell their job; partials after a day; 0 days = never', async () => {
    const day = 24 * 60 * 60 * 1000;
    const dlDir = path.join(tmpDir, 'discover-downloads');
    config.program.discoveryJobs = { ...(config.program.discoveryJobs || {}), retentionDays: 30, downloads: { dir: dlDir, retentionDays: 30 } };
    const downloads = await import('../../src/discovery-plugins/downloads.js');
    const retention = await import('../../src/discovery-plugins/retention.js');
    const { insertDownloadedTrack } = await import('../../src/db/insert-downloaded-track.js');
    await downloads.ensureLibrary(null);
    const userDir = await downloads.userDir(null);
    assert.equal(path.basename(userDir), 'shared');

    const land = async (name) => {
      const file = path.join(userDir, name);
      fs.writeFileSync(file, `not really audio: ${name}`);
      await insertDownloadedTrack({ filePath: file, vpath: downloads.LIBRARY_NAME, basePath: dlDir, source: 'plugin:unit', log: 'unit' });
      return file;
    };
    const oldFile = await land('old.mp3');
    const freshFile = await land('fresh.mp3');
    const stalePartial = path.join(userDir, 'killed.mp3.part');
    const livePartial = path.join(userDir, 'running.mp3.part');
    fs.writeFileSync(stalePartial, 'x');
    fs.writeFileSync(livePartial, 'x');
    const { job } = jobsDb.createJob({ plugin: 'unit-done', userId: null, key: 'text:sweep-old', recommendation: { title: 'old' } });
    jobsDb.claimNextQueued('unit-done');
    jobsDb.finishJob(job.id, { downloaded: { filepath: 'discover-downloads/shared/old.mp3' } });

    const now = Date.now();
    const past = (ms) => new Date(now - ms);
    fs.utimesSync(oldFile, past(31 * day), past(31 * day));
    fs.utimesSync(stalePartial, past(2 * day), past(2 * day));
    const rowFor = (rel) => manager.getDB().prepare(
      'SELECT t.id FROM tracks t JOIN libraries l ON l.id = t.library_id WHERE l.name = ? AND t.filepath = ?').get(downloads.LIBRARY_NAME, rel);
    assert.ok(rowFor('shared/old.mp3') && rowFor('shared/fresh.mp3'));

    // Retention off: nothing expires (stale partials still go).
    config.program.discoveryJobs.downloads.retentionDays = 0;
    assert.equal(downloads.expiresAt(now), null);
    const off = await retention.sweep({ now });
    assert.equal(off.removedFiles, 0);
    assert.equal(off.removedPartials, 1);
    assert.ok(fs.existsSync(oldFile) && !fs.existsSync(stalePartial) && fs.existsSync(livePartial));

    config.program.discoveryJobs.downloads.retentionDays = 30;
    assert.equal(downloads.expiresAt(now), now + 30 * day);
    const on = await retention.sweep({ now });
    assert.equal(on.removedFiles, 1);
    assert.ok(!fs.existsSync(oldFile) && fs.existsSync(freshFile) && fs.existsSync(livePartial));
    assert.equal(rowFor('shared/old.mp3'), undefined);
    assert.ok(rowFor('shared/fresh.mp3'));
    assert.equal(jobsDb.getJob(job.id).result.removed.at, now);

    // Much later everything has expired: the folder the pass empties goes
    // too, and the job rows past their own retention are pruned.
    const later = await retention.sweep({ now: now + 40 * day });
    assert.equal(later.removedFiles, 1);
    assert.equal(later.removedPartials, 1);
    assert.ok(later.prunedJobs >= 1);
    assert.ok(!fs.existsSync(userDir), 'the emptied user folder is removed');
    assert.ok(fs.existsSync(dlDir), 'never the library root');
    assert.equal(jobsDb.getJob(job.id), null);
  });
});
