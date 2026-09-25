// Regenerate bin/yt-dlp/manifest.json and manifest-musl.json — the pinned
// yt-dlp release a FRESH install gets (src/util/yt-dlp-bootstrap.js) —
// from a published yt-dlp/yt-dlp release.
//
// Usage:
//   node scripts/update-yt-dlp-manifest.mjs [tag] [--verify]
//   e.g. node scripts/update-yt-dlp-manifest.mjs             (the newest release)
//        node scripts/update-yt-dlp-manifest.mjs 2026.08.19
//
// The release's own SHA2-256SUMS provides the digests and the GitHub API the
// asset sizes; the pins are the standalone binaries only (the PyInstaller
// builds that need no Python on the host — never the `yt-dlp` zipimport
// script, which does). Both files come from the same release: the musl
// builds are a separate manifest only because pinned-binary.js reads
// manifest-musl.json for a -musl key.
//
// --verify: DOWNLOAD every pinned asset (~230 MB) and hash it against its
// pin. The load-bearing check for the monthly auto-PR workflow
// (.github/workflows/update-yt-dlp-manifest.yml): a PR opened by
// GITHUB_TOKEN triggers no CI, so the generating run itself proves every
// pin is live and hash-true.
//
// The pin is a floor, not what installs run: the daily check moves a
// managed copy to the newest release regardless, so this refresh only keeps
// a fresh install's first fetch from starting far behind. Old pins stay
// valid forever (release assets are immutable).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = 'yt-dlp/yt-dlp';
const VERSION_RE = /^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/;
const SUMS_FILE = 'SHA2-256SUMS';

// Platform key (src/util/pinned-binary.js: <family>-<platform>-<arch>[-musl][.exe])
// → the release asset that runs there. macOS ships one universal2 binary.
const ASSETS = {
  'yt-dlp-win32-x64.exe': 'yt-dlp.exe',
  'yt-dlp-win32-arm64.exe': 'yt-dlp_arm64.exe',
  'yt-dlp-win32-ia32.exe': 'yt-dlp_x86.exe',
  'yt-dlp-linux-x64': 'yt-dlp_linux',
  'yt-dlp-linux-arm64': 'yt-dlp_linux_aarch64',
  'yt-dlp-darwin-x64': 'yt-dlp_macos',
  'yt-dlp-darwin-arm64': 'yt-dlp_macos',
};
const ASSETS_MUSL = {
  'yt-dlp-linux-x64-musl': 'yt-dlp_musllinux',
  'yt-dlp-linux-arm64-musl': 'yt-dlp_musllinux_aarch64',
};

const args = process.argv.slice(2);
const verify = args.includes('--verify');
const tagArg = args.find((a) => !a.startsWith('--'));
if (tagArg && !VERSION_RE.test(tagArg)) {
  console.error(`refusing tag '${tagArg}' — yt-dlp release tags look like 2026.08.19`);
  process.exit(1);
}

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'yt-dlp');
const ua = { 'User-Agent': 'mstream-yt-dlp-manifest' };
const ghHeaders = { ...ua, Accept: 'application/vnd.github+json' };
if (process.env.GITHUB_TOKEN) { ghHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`; }

async function withRetry(label, fn) {
  let lastErr;
  for (const delayMs of [0, 3000, 10000]) {
    if (delayMs) {
      console.warn(`  retrying ${label} in ${delayMs / 1000}s (${lastErr.message})`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
    try { return await fn(); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function gh(p) {
  return withRetry(`GitHub API ${p}`, async () => {
    const res = await fetch(`https://api.github.com${p}`, { headers: ghHeaders });
    if (!res.ok) { throw new Error(`GitHub API ${p} -> HTTP ${res.status}`); }
    return res.json();
  });
}

function fetchOk(url) {
  return withRetry(url, async () => {
    const res = await fetch(url, { headers: ua, redirect: 'follow' });
    if (!res.ok) { throw new Error(`HTTP ${res.status} for ${url}`); }
    return res;
  });
}

function parseSums(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    if (m) { out[m[2]] = m[1].toLowerCase(); }
  }
  return out;
}

function writeManifest(file, tag, release, entries) {
  const manifest = {
    family: 'yt-dlp',
    schema: 2,
    repo: REPO,
    tag,
    release: release.html_url,
    publishedAt: release.published_at,
    assets: entries,
  };
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, file);
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`wrote ${out} (${Object.keys(entries).length} platforms)`);
}

try {
  const release = tagArg
    ? await gh(`/repos/${REPO}/releases/tags/${tagArg}`)
    : await gh(`/repos/${REPO}/releases/latest`);
  const tag = release.tag_name;
  if (!VERSION_RE.test(tag || '')) { throw new Error(`unexpected release tag '${tag}'`); }
  if (release.draft || release.prerelease) { throw new Error(`${tag} is a draft or pre-release — pin a published stable release`); }
  console.log(`release ${tag} (${release.published_at})`);

  const byName = new Map((release.assets || []).map((a) => [a.name, a]));
  const sumsAsset = byName.get(SUMS_FILE);
  if (!sumsAsset) { throw new Error(`${tag} has no ${SUMS_FILE}`); }
  const sums = parseSums(await (await fetchOk(sumsAsset.browser_download_url)).text());

  function entriesFor(map) {
    const entries = {};
    for (const [key, file] of Object.entries(map)) {
      const asset = byName.get(file);
      const sha256 = sums[file];
      if (!asset || !sha256) {
        console.warn(`  WARNING: ${tag} ships no ${file} (for ${key}) — left unpinned`);
        continue;
      }
      if (!Number.isInteger(asset.size) || asset.size <= 0) { throw new Error(`no size for ${file}`); }
      entries[key] = { file, sha256, size: asset.size };
    }
    return entries;
  }
  const entries = entriesFor(ASSETS);
  const entriesMusl = entriesFor(ASSETS_MUSL);
  if (Object.keys(entries).length === 0) { throw new Error('nothing to pin'); }

  if (verify) {
    const base = (process.env.MSTREAM_YTDLP_BASE || '').replace(/\/+$/, '');
    const seen = new Map();
    for (const e of [...Object.values(entries), ...Object.values(entriesMusl)]) {
      if (seen.has(e.file)) { continue; }
      process.stdout.write(`verifying ${e.file}... `);
      const url = base ? `${base}/${e.file}` : `https://github.com/${REPO}/releases/download/${tag}/${e.file}`;
      const buf = Buffer.from(await (await fetchOk(url)).arrayBuffer());
      const actual = crypto.createHash('sha256').update(buf).digest('hex');
      if (actual !== e.sha256) { throw new Error(`sha256 mismatch for ${e.file}: ${SUMS_FILE} says ${e.sha256}, asset hashes to ${actual}`); }
      if (buf.length !== e.size) { throw new Error(`size mismatch for ${e.file}: API says ${e.size}, asset is ${buf.length} bytes`); }
      seen.set(e.file, true);
      console.log(`ok (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
    }
  }

  writeManifest('manifest.json', tag, release, entries);
  writeManifest('manifest-musl.json', tag, release, entriesMusl);
  console.log(`pinned ${REPO}@${tag}${verify ? ' (every asset downloaded and hash-verified)' : ' (digests from the release\'s SHA2-256SUMS; --verify downloads them)'}`);
  console.log('review the diff and open the manifest-update PR.');
} catch (err) {
  console.error(`update failed: ${err.message}`);
  process.exit(1);
}
