/**
 * Routing smoke test for the CLI audio adapters.
 *
 * For each of mpv / vlc / mplayer this script:
 *   1. starts the adapter (spawns the process + connects its control channel)
 *   2. fires every route that server-playback.js proxies, through the
 *      adapter's `handleRequest` dispatcher (same path the Express layer uses)
 *   3. makes a handful of state-level assertions (play sets `file`, pause
 *      flips `paused`, queue/add grows `queue_length`, etc.)
 *   4. stops the adapter cleanly
 *
 * Intended to run inside the Dockerfile at test/cli-audio/Dockerfile which
 * has mpv, vlc (via cvlc), mplayer and ffmpeg installed and a short test tone
 * pre-generated at /tmp/test-tone.mp3.
 */

import { MpvAdapter } from '../../src/state/cli-audio/mpv.js';
import { VlcAdapter } from '../../src/state/cli-audio/vlc.js';
import { MplayerAdapter } from '../../src/state/cli-audio/mplayer.js';
import { MpdAdapter } from '../../src/state/cli-audio/mpd.js';
import {
  detectAvailablePlayers,
  bootCliPlayer,
  killCliPlayer,
} from '../../src/state/cli-audio/index.js';

const TEST_FILE = process.env.TEST_FILE || '/tmp/test-tone.mp3';

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

const ROUTES = [
  { name: 'POST /play',             method: 'POST', path: '/play',            body: () => ({ file: TEST_FILE }) },
  { name: 'POST /volume',           method: 'POST', path: '/volume',          body: () => ({ volume: 0.5 }) },
  { name: 'POST /pause',            method: 'POST', path: '/pause',           body: () => ({}) },
  { name: 'POST /resume',           method: 'POST', path: '/resume',          body: () => ({}) },
  { name: 'POST /seek',             method: 'POST', path: '/seek',            body: () => ({ position: 1 }) },
  { name: 'POST /queue/add',        method: 'POST', path: '/queue/add',       body: () => ({ file: TEST_FILE }) },
  { name: 'POST /queue/add-many',   method: 'POST', path: '/queue/add-many',  body: () => ({ files: [TEST_FILE, TEST_FILE] }) },
  { name: 'POST /shuffle',          method: 'POST', path: '/shuffle',         body: () => ({ value: true }) },
  { name: 'POST /loop',             method: 'POST', path: '/loop',            body: () => ({}) },
  { name: 'POST /queue/play-index', method: 'POST', path: '/queue/play-index',body: () => ({ index: 0 }) },
  { name: 'POST /queue/remove',     method: 'POST', path: '/queue/remove',    body: () => ({ index: 1 }) },
  { name: 'GET /status',            method: 'GET',  path: '/status',          body: () => ({}) },
  { name: 'GET /queue',             method: 'GET',  path: '/queue',           body: () => ({}) },
  { name: 'POST /next',             method: 'POST', path: '/next',            body: () => ({}) },
  { name: 'POST /previous',         method: 'POST', path: '/previous',        body: () => ({}) },
  { name: 'POST /queue/clear',      method: 'POST', path: '/queue/clear',     body: () => ({}) },
  { name: 'POST /stop',             method: 'POST', path: '/stop',            body: () => ({}) },
];

async function runAdapterTests(name, adapter) {
  const result = { name, started: false, routesPassed: 0, routesTotal: ROUTES.length, assertions: [], errors: [] };

  try {
    await adapter.start();
    result.started = true;
  } catch (e) {
    result.errors.push(`start(): ${e.message}`);
    return result;
  }

  // Walk every route through the dispatcher. mpv needs a moment after
  // `loadfile` before seek/prev work, so we give each call a short breather.
  for (const r of ROUTES) {
    try {
      const res = await adapter.handleRequest(r.method, r.path, r.body());
      if (res.status === 200) {
        result.routesPassed += 1;
      } else {
        result.errors.push(`${r.name} → ${res.status}: ${JSON.stringify(res.data)}`);
      }
    } catch (e) {
      result.errors.push(`${r.name} → EXCEPTION: ${e.message}`);
    }
    await wait(150);
  }

  // State assertions — we reset + replay a few routes and check the
  // adapter's internal state reflects what the player should be doing.
  try {
    // Reset
    await adapter.handleRequest('POST', '/queue/clear', {});
    await wait(150);

    // /play should set file and clear stopped
    await adapter.handleRequest('POST', '/play', { file: TEST_FILE });
    await wait(300);
    let status = (await adapter.handleRequest('GET', '/status', {})).data;
    result.assertions.push({ name: 'play sets file',        pass: status.file === TEST_FILE });
    result.assertions.push({ name: 'play sets queue_length=1', pass: status.queue_length === 1 });

    // /pause → paused=true
    await adapter.handleRequest('POST', '/pause', {});
    await wait(100);
    status = (await adapter.handleRequest('GET', '/status', {})).data;
    result.assertions.push({ name: 'pause flips paused',    pass: status.paused === true });

    // /resume → paused=false
    await adapter.handleRequest('POST', '/resume', {});
    await wait(100);
    status = (await adapter.handleRequest('GET', '/status', {})).data;
    result.assertions.push({ name: 'resume clears paused',  pass: status.paused === false });

    // /volume 0.25 → status.volume ≈ 0.25
    await adapter.handleRequest('POST', '/volume', { volume: 0.25 });
    await wait(100);
    status = (await adapter.handleRequest('GET', '/status', {})).data;
    result.assertions.push({ name: 'volume round-trips',    pass: Math.abs(status.volume - 0.25) < 0.01 });

    // /queue/add grows queue
    await adapter.handleRequest('POST', '/queue/add', { file: TEST_FILE });
    await wait(100);
    status = (await adapter.handleRequest('GET', '/status', {})).data;
    result.assertions.push({ name: 'queue/add grows queue', pass: status.queue_length === 2 });

    // /shuffle true → shuffle reflects
    await adapter.handleRequest('POST', '/shuffle', { value: true });
    status = (await adapter.handleRequest('GET', '/status', {})).data;
    result.assertions.push({ name: 'shuffle round-trips',   pass: status.shuffle === true });

    // /loop cycles through three distinct modes. We don't assume the
    // adapter's starting loop_mode — just that three successive calls
    // return three different values from the set { none, one, all } that
    // eventually land back on the original.
    await adapter.handleRequest('POST', '/queue/clear', {});
    await adapter.handleRequest('POST', '/play', { file: TEST_FILE });
    await wait(100);
    const seenLoops = new Set();
    const startLoop = (await adapter.handleRequest('GET', '/status', {})).data.loop_mode;
    seenLoops.add(startLoop);
    for (let i = 0; i < 3; i++) {
      await adapter.handleRequest('POST', '/loop', {});
      seenLoops.add((await adapter.handleRequest('GET', '/status', {})).data.loop_mode);
    }
    const endLoop = (await adapter.handleRequest('GET', '/status', {})).data.loop_mode;
    result.assertions.push({ name: 'loop cycles 3 modes', pass: seenLoops.size === 3 });
    result.assertions.push({ name: 'loop returns to start', pass: endLoop === startLoop });

    // /queue (GET) returns array
    const q = (await adapter.handleRequest('GET', '/queue', {})).data;
    result.assertions.push({ name: 'queue returns array',   pass: Array.isArray(q.queue) && q.queue.length === 1 });
  } catch (e) {
    result.errors.push(`state assertions: ${e.message}`);
  }

  try { await adapter.stop(); } catch (_) { /* ignore */ }
  await wait(200);
  return result;
}

function formatResult(r) {
  const passedAssertions = r.assertions.filter((a) => a.pass).length;
  const totalAssertions = r.assertions.length;
  const routeLine = `routes: ${r.routesPassed}/${r.routesTotal}`;
  const stateLine = `state:  ${passedAssertions}/${totalAssertions}`;
  const startLine = `start:  ${r.started ? 'ok' : 'FAILED'}`;
  const lines = [
    `=== ${r.name} ===`,
    `  ${startLine}`,
    `  ${routeLine}`,
    `  ${stateLine}`,
  ];
  if (r.assertions.length) {
    for (const a of r.assertions) {
      lines.push(`    [${a.pass ? 'ok' : 'FAIL'}] ${a.name}`);
    }
  }
  if (r.errors.length) {
    lines.push('  errors:');
    for (const e of r.errors) { lines.push(`    - ${e}`); }
  }
  return lines.join('\n');
}

(async () => {
  console.log('Detected players:', (await detectAvailablePlayers()).join(', ') || '(none)');
  console.log('Test file:', TEST_FILE);

  const results = [];
  results.push(await runAdapterTests('mpv',     new MpvAdapter()));
  results.push(await runAdapterTests('vlc',     new VlcAdapter()));
  results.push(await runAdapterTests('mplayer', new MplayerAdapter()));
  results.push(await runAdapterTests('mpd',     new MpdAdapter()));

  console.log('');
  for (const r of results) { console.log(formatResult(r)); console.log(''); }

  // Preference test: with all four players installed, bootCliPlayer() (no
  // preference) should pick mpv (top of the default priority list), while
  // bootCliPlayer('mpd') should pick mpd.
  console.log('=== preference selection ===');
  let prefDefaultOk = false;
  let prefMpdOk = false;
  try {
    await killCliPlayer();
    const def = await bootCliPlayer();
    prefDefaultOk = def === 'mpv';
    console.log(`  [${prefDefaultOk ? 'ok' : 'FAIL'}] no preference → ${def} (expected mpv)`);
    await killCliPlayer();
    const pref = await bootCliPlayer('mpd');
    prefMpdOk = pref === 'mpd';
    console.log(`  [${prefMpdOk ? 'ok' : 'FAIL'}] preferred=mpd → ${pref} (expected mpd)`);
    await killCliPlayer();
  } catch (e) {
    console.log(`  [FAIL] preference test threw: ${e.message}`);
  }
  console.log('');

  const passed = results.every((r) => {
    if (!r.started || r.routesPassed < r.routesTotal) { return false; }
    const failedAssertions = r.assertions.filter((a) => !a.pass).length;
    return failedAssertions === 0;
  }) && prefDefaultOk && prefMpdOk;

  console.log(passed ? 'ALL GREEN' : 'SOME FAILURES');
  process.exit(passed ? 0 : 1);
})();
