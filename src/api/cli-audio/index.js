/**
 * cli-audio/index.js — CLI-player fallback for server-side playback.
 *
 * When the Rust audio binary isn't available, this module probes the host for
 * a known CLI music player and boots an adapter that mimics the Rust binary's
 * HTTP API. `proxyToCli` is a drop-in replacement for `proxyToRust`.
 *
 * Priority order is defined in PLAYERS below — first installed wins. MPD is a
 * special case: there's no binary to spawn, we just TCP-probe localhost:6600
 * (overridable via MSTREAM_MPD_HOST).
 */

import child_process from 'child_process';
import winston from 'winston';
import { MpvAdapter } from './mpv.js';
import { VlcAdapter } from './vlc.js';
import { MplayerAdapter } from './mplayer.js';
import { MpdAdapter, probeMpd } from './mpd.js';

/**
 * Priority list. First available entry is used.
 *
 * Each entry defines how to detect and instantiate a player:
 *   kind: 'spawn' — requires a binary on PATH; detected by running `probeArgs`
 *   kind: 'daemon' — connects to a long-running daemon; detected by `probe()`
 */
export const PLAYERS = [
  { name: 'mpv',     kind: 'spawn',  binary: 'mpv',     probeArgs: ['--version'], AdapterClass: MpvAdapter,     label: 'mpv' },
  { name: 'mpd',     kind: 'daemon', probe: () => probeMpd(),                     AdapterClass: MpdAdapter,     label: 'MPD' },
  { name: 'vlc',     kind: 'spawn',  binary: 'vlc',     probeArgs: ['--version'], AdapterClass: VlcAdapter,     label: 'VLC' },
  { name: 'mplayer', kind: 'spawn',  binary: 'mplayer', probeArgs: ['-v'],        AdapterClass: MplayerAdapter, label: 'MPlayer' },
];

function probeBinary(binary, args) {
  // Async probe: we used to call spawnSync here, but that blocks the Node
  // event loop, which starves the MPD TCP probe's 'data' callback and makes
  // its short timeout misfire. Using spawn lets every probe run concurrently.
  return new Promise((resolve) => {
    let proc;
    try {
      proc = child_process.spawn(binary, args, { windowsHide: true });
    } catch (_e) {
      return resolve(false);
    }
    let gotOutput = false;
    const mark = () => { gotOutput = true; };
    const timer = setTimeout(() => {
      try { proc.kill(); } catch (_) { /* ignore */ }
      resolve(gotOutput);
    }, 3000);
    // Most players print a version banner on stdout or stderr. As long as
    // the binary resolved and produced output, count it as available —
    // exit codes vary (mplayer -v returns non-zero because it wants a file).
    if (proc.stdout) { proc.stdout.on('data', mark); }
    if (proc.stderr) { proc.stderr.on('data', mark); }
    // 'close' (not 'exit') so the stdout/stderr 'data' handlers above have
    // fired before we read gotOutput — on 'exit' a fast-printing player's
    // banner can still be buffered, making it look like it produced nothing
    // and be misdetected as unavailable. Exit codes are intentionally ignored
    // here, so output-presence is the only signal.
    proc.on('close', () => { clearTimeout(timer); resolve(gotOutput); });
    proc.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

async function isAvailable(player) {
  try {
    if (player.kind === 'daemon') { return await player.probe(); }
    return await probeBinary(player.binary, player.probeArgs);
  } catch (_e) {
    return false;
  }
}

/**
 * Returns the subset of PLAYERS that are actually installed / reachable, in
 * priority order. Probes TCP daemons concurrently so we don't serialize
 * connection timeouts.
 */
export async function detectAvailablePlayers() {
  const flags = await Promise.all(PLAYERS.map((p) => isAvailable(p)));
  return PLAYERS.filter((_, i) => flags[i]).map((p) => p.name);
}

// ── Active adapter state ───────────────────────────────────────────────────

let activeAdapter = null;
let activePlayerName = null;

export function getActivePlayerName() { return activePlayerName; }
export function getActiveAdapter() { return activeAdapter; }
export function isCliActive() { return activeAdapter !== null; }

/**
 * Detect + start the first available CLI player. Returns the player name if
 * started, or null if none could be started.
 *
 * If `preferredName` is provided and that player is available, it's tried
 * first regardless of registry position. Remaining players are attempted in
 * the default priority order if the preferred choice isn't installed or
 * fails to start.
 */
export async function bootCliPlayer(preferredName = null) {
  if (activeAdapter) { return activePlayerName; }

  const ordered = PLAYERS.slice();
  if (preferredName) {
    const idx = ordered.findIndex((p) => p.name === preferredName);
    if (idx > 0) { ordered.unshift(ordered.splice(idx, 1)[0]); }
  }

  for (const p of ordered) {
    const available = await isAvailable(p);
    if (!available) { continue; }
    const adapter = p.kind === 'spawn' ? new p.AdapterClass(p.binary) : new p.AdapterClass();
    try {
      await adapter.start();
      activeAdapter = adapter;
      activePlayerName = p.name;
      winston.info(`[cli-audio] started ${p.label} as fallback audio player`);
      return p.name;
    } catch (err) {
      winston.warn(`[cli-audio] ${p.label} detected but failed to start: ${err.message}`);
      try { await adapter.stop(); } catch (_) { /* ignore */ }
    }
  }
  return null;
}

export async function killCliPlayer() {
  if (!activeAdapter) { return; }
  try { await activeAdapter.stop(); } catch (_) { /* ignore */ }
  activeAdapter = null;
  activePlayerName = null;
}

/**
 * Drop-in counterpart to server-playback.js's proxyToRust. Takes the same
 * method/rustPath/body triple and returns `{ status, data }`.
 */
export function proxyToCli(method, rustPath, body) {
  if (!activeAdapter) {
    return Promise.reject(new Error('CLI audio player is not running'));
  }
  return activeAdapter.handleRequest(method, rustPath, body);
}
