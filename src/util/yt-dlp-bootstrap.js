/**
 * yt-dlp-bootstrap.js
 *
 * yt-dlp, fetched on first use and KEPT CURRENT. YouTube changes often and
 * an old yt-dlp stops working within weeks — "Requested format is not
 * available", "unable to extract", HTTP 403 — so a copy an operator
 * installed once and forgot is the usual reason a YouTube download fails.
 * This module gives the youtube plug-in (src/discovery-plugins/plugins/
 * youtube.js) and the Youtube DL route (src/api/ytdl.js) a yt-dlp that is
 * never more than a day behind the newest release, without asking the
 * operator to install anything.
 *
 * The mechanics — token-validated pins, a derived URL, the size cap, the
 * hash check, the execution probe, the rename-aside swap, the receipt, the
 * single-flight download — are pinned-binary.js, shared with the sidecar and
 * the player. What is particular to yt-dlp:
 *
 *   - Two sources of truth, one floor and one ceiling. bin/yt-dlp/
 *     manifest.json (manifest-musl.json for Alpine) pins ONE release —
 *     {repo, tag} plus {file, sha256, size} per platform — and is committed,
 *     reviewed text: a FRESH install gets exactly that build, verified
 *     against a hash that lives in this repo. Then the daily check moves the
 *     managed copy past the pin to whatever yt-dlp's newest release is,
 *     verified against that release's own SHA2-256SUMS (the same integrity
 *     check yt-dlp's built-in updater and ffmpeg-bootstrap's pruned-pin
 *     fallback make: it proves the bytes are the ones the release lists, not
 *     that a human here reviewed them). The pin is refreshed monthly by
 *     scripts/update-yt-dlp-manifest.mjs so a fresh install never starts far
 *     behind; nothing ever moves BELOW the pin.
 *   - ON-DISK POLICY 'receipt-is-law': the managed copy stays whatever build
 *     the last check left it at, as long as it still hashes to its receipt;
 *     a damaged one is replaced with the pin; a file someone placed at the
 *     managed path themselves is left alone.
 *   - Which yt-dlp RUNS is decided by locate(), the one resolver both callers
 *     use. MSTREAM_YTDLP_BIN (tests) beats everything. A `binary` the
 *     operator set to anything but the default name is theirs and runs as
 *     is. The default — `yt-dlp` — means: use the one installed on this
 *     server when it is no more than SYSTEM_STALE_DAYS behind the newest
 *     release we know of, otherwise mStream's own managed copy, fetched on
 *     the spot when there is none yet. Between two usable copies the newer
 *     one wins, the server's own on a tie. A server with a current yt-dlp
 *     therefore never downloads anything, and one with Debian's years-old
 *     package gets a working copy the first time someone presses Get it.
 *   - The daily check (startAutoUpdate — once the youtube plug-in is enabled,
 *     or lazily on the first use by the route) learns the newest release
 *     from ONE request that carries no body: GitHub's releases/latest
 *     redirect names the tag. Only when that is newer than the managed copy
 *     are the release's SHA2-256SUMS and this platform's asset fetched. On a
 *     mirror (MSTREAM_YTDLP_BASE, a flat namespace with no redirect) the
 *     check reads <base>/latest/SHA2-256SUMS and installs
 *     <base>/latest/<file> when its hash differs from the managed copy's.
 *   - The probe is `--version`, which yt-dlp answers with its release date
 *     ("2026.08.19"); for a live update it doubles as the downgrade guard —
 *     a build that reports an older version than the one installed, or one
 *     below the pin, never replaces anything.
 *   - discoveryPlugins.youtube.autoUpdate: false freezes the managed copy
 *     (air-gapped hosts, a release that regressed); the system copy is then
 *     measured against the pin alone.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import commandExists from 'command-exists';
import winston from 'winston';
import * as config from '../state/config.js';
import { createPinnedBinary, deriveAssetUrl, receiptSha } from './pinned-binary.js';
import { downloadToFile } from './ffmpeg-bootstrap.js';
import * as ytdlp from './yt-dlp.js';

// The config default for `binary`; anything else is the operator's choice.
export const DEFAULT_BINARY = 'yt-dlp';

// A yt-dlp installed on the server is used only while it is at most this many
// days behind the newest release we know of. yt-dlp releases every few weeks
// and YouTube breaks the older ones about as often; a month behind is the
// point where "installed here" stops being an advantage.
export const SYSTEM_STALE_DAYS = 30;

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
// The post-boot check waits for the boot to settle; a smoke can pull it in
// (MSTREAM_YTDLP_CHECK_DELAY_MS) instead of sleeping through it.
const BOOT_CHECK_DELAY_MS = Math.max(1000, Number(process.env.MSTREAM_YTDLP_CHECK_DELAY_MS) || 45_000);
// How long a decision about which copy runs stands before the disk is asked
// again (a pip upgrade, a managed refresh).
const LOCATE_TTL_MS = 10 * 60 * 1000;
const SUMS_FILE = 'SHA2-256SUMS';
const SUMS_MAX_BYTES = 64 * 1024;
// A live download comes from a release the manifest does not describe, so
// its cap is a fixed figure: the largest published binary is ~40 MB.
export const LIVE_MAX_BYTES = 128 * 1024 * 1024;
const TOKEN_RE = /^[A-Za-z0-9._-]+$/;
const TAG = '[yt-dlp]';

const family = createPinnedBinary({
  family: 'yt-dlp',
  baseEnv: 'MSTREAM_YTDLP_BASE',
  onDiskPolicy: 'receipt-is-law',
  probe: {
    flag: '--version',
    args: () => ['--version'],
    accept: /^\d{4}\.\d{2}\.\d{2}/,
    scratchDir: false,
  },
  noun: 'yt-dlp build',
  unpublishedMeans: 'install yt-dlp on this server yourself, or point discoveryPlugins.youtube.binary at one',
  pinReceipt: (entry) => ({ version: entry.tag, source: 'pin', at: new Date().toISOString() }),
});

export const ytDlpKey = family.key;
export const defaultManifestDir = family.defaultManifestDir;
export const managedYtDlpDir = family.managedDir;
export const managedYtDlpPath = family.managedPath;
export const manifestEntry = family.manifestEntry;
export const canAutoFetch = family.canAutoFetch;
export { deriveAssetUrl };

// Make sure the managed copy exists — the manifest pin on a fresh install,
// whatever the last check left there otherwise. See pinned-binary.js
// ('receipt-is-law'). Resolves with the path, null when no build is pinned
// for this platform, and throws when the fetch failed.
export const ensureYtDlp = family.ensure;

// ── Versions ───────────────────────────────────────────────────────────────

// yt-dlp's versions are dates: "2026.08.19", and a nightly adds the build
// time ("2026.08.19.232000"). Zero-padded, so they sort as text too, but
// compare them as numbers anyway.
const VERSION_RE = /^(\d{4})\.(\d{2})\.(\d{2})(?:\.(\d+))?$/;

export function parseVersion(text) {
  const m = VERSION_RE.exec(String(text || '').trim());
  if (!m) { return null; }
  const date = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(date)) { return null; }
  return { text: m[0], date, build: m[4] ? Number(m[4]) : 0 };
}

// -1 / 0 / 1; a version that does not parse sorts below every one that does.
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) { return 0; }
  if (!pa) { return -1; }
  if (!pb) { return 1; }
  if (pa.date !== pb.date) { return pa.date < pb.date ? -1 : 1; }
  if (pa.build !== pb.build) { return pa.build < pb.build ? -1 : 1; }
  return 0;
}

// Whole days `version` lies behind `newest` (negative when ahead); null when
// either does not parse.
export function daysBehind(version, newest) {
  const pv = parseVersion(version);
  const pn = parseVersion(newest);
  if (!pv || !pn) { return null; }
  return Math.round((pn.date - pv.date) / 86400000);
}

// Is a copy too far behind `newest` to be the one that runs? A version that
// cannot be read counts as too old: nothing vouches for it.
export function isMuchOlder(version, newest, days = SYSTEM_STALE_DAYS) {
  const behind = daysBehind(version, newest);
  return behind === null || behind > days;
}

// yt-dlp's SHA2-256SUMS: one "<sha256>  <file>" per line.
export function parseSums(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    if (m) { out[m[2]] = m[1].toLowerCase(); }
  }
  return out;
}

// ── Settings ───────────────────────────────────────────────────────────────

function settings() {
  const c = config.program && config.program.discoveryPlugins && config.program.discoveryPlugins.youtube;
  return { enabled: false, binary: DEFAULT_BINARY, autoUpdate: true, ...(c || {}) };
}

function autoUpdateOn() {
  return settings().autoUpdate !== false;
}

// ── The newest release ─────────────────────────────────────────────────────

let latestSeen = null;   // { version, at } — learned by the daily check
let lastCheck = null;    // { at, error }

// The newest release tag, from the one request that carries no body:
// GitHub's releases/latest answers with a redirect to the tag page. Null on
// a mirror (a flat namespace has no such redirect) and on any failure —
// the caller then measures against the pin. `fetchImpl` is injectable for
// the unit tests.
export async function latestVersion({ entry = manifestEntry(), fetchImpl = fetch } = {}) {
  if (!entry || family.mirrorBase()) { return null; }
  const url = `https://github.com/${entry.repo}/releases/latest`;
  let res;
  try {
    res = await fetchImpl(url, { method: 'HEAD', redirect: 'manual', headers: { 'User-Agent': 'mstream-yt-dlp-bootstrap/1.0' } });
  } catch (err) {
    winston.warn(`${TAG} could not ask ${entry.repo} for its newest release: ${err.message}`);
    return null;
  }
  try { await res.body?.cancel(); } catch (_err) { /* no body on a HEAD */ }
  const location = res.headers.get('location') || '';
  const m = /\/releases\/tag\/([^/?#]+)\s*$/.exec(location);
  const tag = m ? decodeURIComponent(m[1]) : null;
  if (!tag || !TOKEN_RE.test(tag) || !parseVersion(tag)) {
    winston.warn(`${TAG} ${entry.repo}'s newest release could not be read (HTTP ${res.status}${location ? `, ${location}` : ''})`);
    return null;
  }
  latestSeen = { version: tag, at: Date.now() };
  return tag;
}

// The newest version we know of: the daily check's answer, the managed
// copy, or the pin — whichever is highest.
export function newestKnown({ entry = manifestEntry(), managed = family.receiptEntry() } = {}) {
  const candidates = [entry && entry.tag, latestSeen && latestSeen.version, managed && managed.version].filter(Boolean);
  return candidates.sort(compareVersions).pop() || null;
}

// ── The live update ────────────────────────────────────────────────────────

async function readText(url, maxBytes, scratchDir) {
  await fsp.mkdir(scratchDir, { recursive: true });
  const tmp = path.join(scratchDir, `.sums-${process.pid}`);
  try {
    await downloadToFile(url, tmp, { maxBytes });
    return await fsp.readFile(tmp, 'utf8');
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

// Move the managed copy to the newest release when there is one. Resolves
// with { updated, version, latest, skipped? }; throws when the check itself
// failed (no network, a release with no build for this platform). Never
// touches a copy we did not install, and never runs when nothing is
// installed yet — ensureYtDlp() owns the first install.
//
//   latest    the tag the caller already resolved (the daily check does)
//   probe     injectable: (stagedPath) => Promise<version string | null>
export async function refresh({ latest = null, probe = null, installDir = managedYtDlpDir(), entry = manifestEntry(), key = ytDlpKey() } = {}) {
  if (!entry) { return { updated: false, skipped: 'no build is pinned for this platform', version: null, latest: null }; }
  const dest = path.join(installDir, key);
  const receipt = family.receiptEntry({ installDir, key });
  if (!fs.existsSync(dest)) { return { updated: false, skipped: 'not installed', version: null, latest }; }
  if (!receipt) { return { updated: false, skipped: 'not installed by mStream', version: null, latest }; }
  const installed = (receipt && typeof receipt === 'object' && receipt.version) || null;

  const base = family.mirrorBase();
  let sumsUrl;
  let assetUrl;
  let describe;
  if (base) {
    sumsUrl = `${base}/latest/${SUMS_FILE}`;
    assetUrl = `${base}/latest/${entry.file}`;
    describe = `downloading ${entry.file} (the mirror's latest) from ${base}/latest...`;
  } else {
    const tag = latest || await latestVersion({ entry });
    if (!tag) { throw new Error('could not learn the newest release'); }
    if (installed && compareVersions(tag, installed) <= 0) {
      lastCheck = { at: Date.now(), error: null };
      return { updated: false, version: installed, latest: tag };
    }
    latest = tag;
    sumsUrl = deriveAssetUrl({ repo: entry.repo, tag, file: SUMS_FILE });
    assetUrl = deriveAssetUrl({ repo: entry.repo, tag, file: entry.file });
    describe = `downloading ${entry.file} (release ${tag}) from ${entry.repo} release assets...`;
  }

  const sums = parseSums(await readText(sumsUrl, SUMS_MAX_BYTES, installDir));
  const want = sums[entry.file];
  if (!want) { throw new Error(`the newest release${latest ? ` (${latest})` : ''} lists no ${entry.file} in its ${SUMS_FILE}`); }
  if (want === receiptSha(receipt)) {
    lastCheck = { at: Date.now(), error: null };
    return { updated: false, version: installed, latest: latest || installed };
  }

  // The probe learns the version, and refuses a build that would move the
  // copy backwards — below what is installed, or below the pin.
  let seen = null;
  const versionProbe = probe || (async (staged) => {
    try { return await ytdlp.version({ cmd: staged, prefix: [] }); } catch (err) { winston.warn(`${TAG} the downloaded build did not answer --version: ${err.message}`); return null; }
  });
  const guard = async (staged) => {
    const v = await versionProbe(staged);
    if (!v || !parseVersion(v)) { return false; }
    if (installed && compareVersions(v, installed) < 0) {
      winston.warn(`${TAG} the newest release reports version ${v}, older than the installed ${installed} — refusing the downgrade`);
      return false;
    }
    if (compareVersions(v, entry.tag) < 0) {
      winston.warn(`${TAG} the newest release reports version ${v}, older than the pinned ${entry.tag} — refusing it`);
      return false;
    }
    seen = v;
    return true;
  };

  winston.info(`${TAG} ${describe}`);
  await family.install({
    installDir, key, url: assetUrl, sha256: want, maxBytes: LIVE_MAX_BYTES, label: entry.file, probe: guard,
    receiptMeta: () => ({ version: seen, source: base ? 'mirror-latest' : 'latest', at: new Date().toISOString() }),
  });
  if (seen) { latestSeen = { version: seen, at: Date.now() }; }
  lastCheck = { at: Date.now(), error: null };
  invalidate();
  winston.info(`${TAG} now at ${seen}${installed ? ` (was ${installed})` : ''}`);
  return { updated: true, version: seen, latest: latest || seen };
}

// ── Which copy runs ────────────────────────────────────────────────────────

let decision = null;   // the last locate() answer for the default binary, with decidedAt
let deciding = null;   // its in-flight promise

// Forget the last decision (after an install, or for a test).
export function invalidate() {
  decision = null;
}

// The yt-dlp on PATH, if any: { cmd, version } (version null with `error`
// when it exists but cannot be run). Injectable for the tests.
async function findSystemCopy() {
  try { await commandExists(DEFAULT_BINARY); } catch (_err) { return null; }
  try {
    return { cmd: DEFAULT_BINARY, version: await ytdlp.version({ cmd: DEFAULT_BINARY, prefix: [] }) };
  } catch (err) {
    return { cmd: DEFAULT_BINARY, version: null, error: err.message };
  }
}

// The managed copy on disk, if we installed it: { path, version, at }.
function findManagedCopy({ installDir = managedYtDlpDir(), key = ytDlpKey() } = {}) {
  const p = path.join(installDir, key);
  const receipt = family.receiptEntry({ installDir, key });
  if (!receipt || !fs.existsSync(p)) { return null; }
  return { path: p, version: (typeof receipt === 'object' && receipt.version) || null, at: (typeof receipt === 'object' && receipt.at) || null };
}

function answer(fields) {
  return { bin: null, source: null, version: null, path: null, label: null, note: null, reason: null, ...fields };
}

/**
 * Which yt-dlp runs. Resolves with
 *   { bin, source, version, path, label, note, reason }
 * where `bin` is what spawnYtDlp() takes ({ cmd, prefix }) or null when
 * there is none, `source` is 'env' | 'config' | 'system' | 'managed',
 * `version` is known for the copies this module measured (null for env /
 * config until the caller probes), `note` is a sentence worth showing an
 * admin ("…the newer build could not be fetched…"), and `reason` says why
 * `bin` is null.
 *
 *   configured   discoveryPlugins.youtube.binary
 *   fresh        ignore the cached decision
 *   findSystem / ensure / update / installDir / entry / key / now
 *                injectable for the unit tests
 */
export async function locate(configured, {
  fresh = false, findSystem = findSystemCopy, ensure = ensureYtDlp, update = refresh, now = Date.now,
  installDir = managedYtDlpDir(), entry = manifestEntry(), key = ytDlpKey(),
} = {}) {
  // The test hook and an explicit choice are used as they are — but checked
  // for existence, as they always were, so a missing one is named.
  const hook = typeof process.env.MSTREAM_YTDLP_BIN === 'string' ? process.env.MSTREAM_YTDLP_BIN.trim() : '';
  const name = typeof configured === 'string' && configured.trim() ? configured.trim() : DEFAULT_BINARY;
  if (hook || name !== DEFAULT_BINARY) {
    const bin = ytdlp.resolveBinary(name);
    const label = bin.script || bin.cmd;
    const source = hook ? 'env' : 'config';
    if (!(await ytdlp.isAvailable(bin))) { return answer({ source, label, reason: `yt-dlp not found (${label})` }); }
    return answer({ bin, source, label, path: path.isAbsolute(label) ? label : null });
  }

  if (decision && !fresh && now() - decision.decidedAt < LOCATE_TTL_MS) { return decision; }
  if (deciding) { return deciding; }
  deciding = decide({ findSystem, ensure, update, now, installDir, entry, key }).finally(() => { deciding = null; });
  return deciding;
}

async function decide({ findSystem, ensure, update, now, installDir, entry, key }) {
  const system = await findSystem();
  const managedBefore = findManagedCopy({ installDir, key });
  const newest = newestKnown({ entry, managed: managedBefore ? { version: managedBefore.version } : null });

  const usable = [];
  if (system && system.version) { usable.push({ source: 'system', cmd: system.cmd, version: system.version, path: null }); }
  if (managedBefore && managedBefore.version) { usable.push({ source: 'managed', cmd: managedBefore.path, version: managedBefore.version, path: managedBefore.path }); }
  const current = usable.filter((c) => !isMuchOlder(c.version, newest));
  if (current.length) {
    // The newer copy; the server's own on a tie.
    current.sort((a, b) => compareVersions(b.version, a.version) || (a.source === 'system' ? -1 : 1));
    const pick = current[0];
    return remember(answer({ bin: { cmd: pick.cmd, prefix: [] }, source: pick.source, version: pick.version, path: pick.path, label: pick.cmd }), now);
  }

  // Nothing current enough (or nothing at all): get our own. The pin first
  // — that is what a fresh install is promised — then the newest release
  // when updates are on, so the first Get it does not run a month behind.
  const why = system
    ? (system.version
      ? `yt-dlp on this server (${system.version}) is ${daysBehind(system.version, newest)} days behind ${newest}`
      : `yt-dlp on this server cannot be run (${system.error})`)
    : 'yt-dlp is not installed on this server';
  let failure = null;
  try {
    winston.info(`${TAG} ${why} — fetching mStream's own copy`);
    const installed = await ensure();
    if (installed && autoUpdateOn()) {
      await update().catch((err) => winston.warn(`${TAG} update check after the install failed: ${err.message}`));
    }
  } catch (err) {
    failure = err;
  }
  const managed = findManagedCopy({ installDir, key });
  if (managed) {
    return remember(answer({ bin: { cmd: managed.path, prefix: [] }, source: 'managed', version: managed.version, path: managed.path, label: managed.path }), now);
  }

  // No managed copy came of it: the old or broken copy on the server, with a
  // note that says so, or nothing.
  const fetchNote = failure ? `the download failed (${failure.message})` : 'no build is pinned for this platform';
  if (system && system.version) {
    return remember(answer({
      bin: { cmd: system.cmd, prefix: [] }, source: 'system', version: system.version, label: system.cmd,
      note: `${why} and ${fetchNote} — using it anyway`,
    }), now);
  }
  return remember(answer({ source: null, reason: `yt-dlp not found (${why}; ${fetchNote})` }), now);
}

function remember(a, now) {
  decision = { ...a, decidedAt: now() };
  return decision;
}

// What the plug-in's probe reports to an admin next to the version.
export function status() {
  const managed = findManagedCopy();
  return {
    source: decision ? decision.source : null,
    note: decision ? decision.note : null,
    latest: latestSeen ? latestSeen.version : null,
    checkedAt: lastCheck ? new Date(lastCheck.at).toISOString() : null,
    managed: managed ? { version: managed.version, at: managed.at } : null,
    autoUpdate: autoUpdateOn(),
  };
}

// ── The daily check ────────────────────────────────────────────────────────

let bootTimer = null;
let checkTimer = null;

// One check: learn the newest release, move the managed copy to it, then
// decide afresh which copy runs — a server copy that fell behind is
// superseded here, before anyone presses Get it. A no-op with updates off,
// under the test hook, and for an operator's explicit binary.
//   fetchImpl / findSystem / ensure / update / installDir / entry / key
//                injectable for the unit tests
export async function checkForUpdate({ fetchImpl, findSystem, ensure, update, installDir, entry, key } = {}) {
  if (!autoUpdateOn()) { return { skipped: 'updates are off' }; }
  if (process.env.MSTREAM_YTDLP_BIN) { return { skipped: 'MSTREAM_YTDLP_BIN' }; }
  if (settings().binary && settings().binary !== DEFAULT_BINARY) { return { skipped: 'an explicit binary is configured' }; }
  const locateOpts = { fresh: true };
  for (const [k, v] of Object.entries({ findSystem, ensure, update, installDir, entry, key })) { if (v !== undefined) { locateOpts[k] = v; } }
  const refreshOpts = {};
  for (const [k, v] of Object.entries({ installDir, entry, key })) { if (v !== undefined) { refreshOpts[k] = v; } }
  let result;
  try {
    // The newest release first, whether or not a managed copy exists: the
    // 30-days rule measures the server's own copy against it (newestKnown),
    // and a server that runs its own yt-dlp has no managed copy for
    // refresh() to compare — it would never have asked.
    const latest = family.mirrorBase() ? null : await latestVersion({ ...(entry !== undefined ? { entry } : {}), ...(fetchImpl ? { fetchImpl } : {}) });
    result = await refresh({ latest, ...refreshOpts });
    // The check ran, whether or not there was a managed copy to move: the
    // admin's probe shows when.
    lastCheck = { at: Date.now(), error: null };
  } catch (err) {
    lastCheck = { at: Date.now(), error: err.message };
    winston.warn(`${TAG} update check failed: ${err.message}`);
    result = { updated: false, error: err.message };
  }
  await locate(DEFAULT_BINARY, locateOpts).catch((err) => winston.warn(`${TAG} could not decide which copy runs: ${err.message}`));
  return result;
}

// Arm the check: shortly after boot, then daily. Idempotent. Started by the
// server when the youtube plug-in is enabled at boot, by the admin route
// that enables it later, and by the youtube plug-in and the Youtube DL
// route the first time they run yt-dlp.
export function startAutoUpdate() {
  if (checkTimer) { return; }
  bootTimer = setTimeout(() => {
    bootTimer = null;
    checkForUpdate().catch((err) => winston.warn(`${TAG} update check failed: ${err.message}`));
  }, BOOT_CHECK_DELAY_MS);
  if (bootTimer.unref) { bootTimer.unref(); }
  checkTimer = setInterval(() => {
    checkForUpdate().catch((err) => winston.warn(`${TAG} update check failed: ${err.message}`));
  }, CHECK_INTERVAL_MS);
  if (checkTimer.unref) { checkTimer.unref(); }
}

export function stopAutoUpdate() {
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
  if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
}

// Test hook: forget every decision and in-flight download.
export function reset() {
  stopAutoUpdate();
  decision = null;
  deciding = null;
  latestSeen = null;
  lastCheck = null;
  family.reset();
}
