// Assemble bin/ffmpeg/manifest.json — the committed pin set the ffmpeg
// bootstrap downloads against (see src/util/ffmpeg-bootstrap.js).
//
// Usage:
//   node scripts/update-ffmpeg-manifest.mjs [autobuild-YYYY-MM-DD-HH-MM]
//
// With no argument, pins the newest dated BtbN autobuild. NEVER pins the
// rolling "latest" tag — its assets are replaced in place, which would break
// both the sha256 pins and the Smart-App-Control-reputation goal (a stable
// hash accrues reputation; a rolling one resets weekly).
//
// Sources:
//   - BtbN/FFmpeg-Builds (linux x64/arm64, win x64): the release's own
//     checksums.sha256 provides the digests; asset sizes come from the
//     GitHub API. Dated releases are retained in bulk but NOT forever —
//     re-run this and ship the small manifest PR a few times a year so
//     fresh installs never chase a pruned tag.
//   - ffmpeg.martin-riedl.de (macOS x64/arm64): /redirect/latest/... 307s
//     to a versioned /download/... path where a sibling .sha256 lives; the
//     manifest pins that resolved path + digest so installs never depend on
//     where "latest" points later.
//
// The result is plain reviewed text: eyeball the diff (tag bump + hash
// churn) like any dependency bump.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'bin', 'ffmpeg', 'manifest.json');
const BTBN_REPO = 'BtbN/FFmpeg-Builds';
const MR_HOST = 'https://ffmpeg.martin-riedl.de';

// GitHub API results can be rate-limited anonymously; a token is optional.
const ghHeaders = { 'User-Agent': 'mstream-ffmpeg-manifest', Accept: 'application/vnd.github+json' };
if (process.env.GITHUB_TOKEN) { ghHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`; }

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers: ghHeaders });
  if (!res.ok) { throw new Error(`GitHub API ${path} -> HTTP ${res.status}`); }
  return res.json();
}

async function resolveTag(argTag) {
  if (argTag) {
    if (!/^autobuild-[0-9-]+$/.test(argTag)) {
      throw new Error(`refusing tag '${argTag}' — pin a dated autobuild-* tag, never 'latest'`);
    }
    return argTag;
  }
  const releases = await gh(`/repos/${BTBN_REPO}/releases?per_page=10`);
  const dated = releases.find((r) => /^autobuild-/.test(r.tag_name));
  if (!dated) { throw new Error('no dated autobuild release found'); }
  return dated.tag_name;
}

// The exact build-flavor selector the bootstrap has always used: plain -gpl
// static builds (not -shared, not -lgpl, no version-pinned ffmpeg-7.x flavor).
const BTBN_WANT = {
  'linux-x64': /^ffmpeg-N-[0-9]+-g[0-9a-f]+-linux64-gpl\.tar\.xz$/,
  'linux-arm64': /^ffmpeg-N-[0-9]+-g[0-9a-f]+-linuxarm64-gpl\.tar\.xz$/,
  'win32-x64': /^ffmpeg-N-[0-9]+-g[0-9a-f]+-win64-gpl\.zip$/,
};

async function btbnEntries(tag) {
  const rel = await gh(`/repos/${BTBN_REPO}/releases/tags/${tag}`);
  const sums = rel.assets.find((a) => a.name === 'checksums.sha256');
  if (!sums) { throw new Error(`${tag} has no checksums.sha256`); }
  const sumsText = await (await fetch(sums.browser_download_url, { headers: { 'User-Agent': ghHeaders['User-Agent'] } })).text();
  const digestOf = {};
  for (const line of sumsText.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) { digestOf[parts[1]] = parts[0].toLowerCase(); }
  }
  const entries = {};
  for (const [key, re] of Object.entries(BTBN_WANT)) {
    const asset = rel.assets.find((a) => re.test(a.name));
    if (!asset) { throw new Error(`${tag}: no asset matching ${re} (looked for ${key})`); }
    const sha256 = digestOf[asset.name];
    if (!/^[0-9a-f]{64}$/.test(sha256 || '')) { throw new Error(`${tag}: checksums.sha256 has no digest for ${asset.name}`); }
    entries[key] = { source: 'btbn', file: asset.name, sha256, size: asset.size };
  }
  return entries;
}

// Follow martin-riedl's /redirect/ chain by hand so we capture the FINAL
// versioned path — that's the pin (redirect targets move; download paths
// don't, and each hosts its own sibling .sha256).
async function resolveFinal(url, hops = 0) {
  if (hops > 5) { throw new Error(`too many redirects for ${url}`); }
  const res = await fetch(url, { method: 'HEAD', redirect: 'manual', headers: { 'User-Agent': ghHeaders['User-Agent'] } });
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
    return resolveFinal(new URL(res.headers.get('location'), url).toString(), hops + 1);
  }
  if (!res.ok) { throw new Error(`HTTP ${res.status} resolving ${url}`); }
  const size = Number(res.headers.get('content-length'));
  return { finalUrl: url, size };
}

async function mrEntry(arch) {
  const files = {};
  for (const member of ['ffmpeg', 'ffprobe']) {
    const { finalUrl, size } = await resolveFinal(`${MR_HOST}/redirect/latest/macos/${arch}/release/${member}.zip`);
    const u = new URL(finalUrl);
    if (u.origin !== MR_HOST) { throw new Error(`redirect left ${MR_HOST}: ${finalUrl}`); }
    const shaText = await (await fetch(`${finalUrl}.sha256`, { headers: { 'User-Agent': ghHeaders['User-Agent'] } })).text();
    const sha256 = shaText.trim().split(/\s+/)[0].toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) { throw new Error(`no valid .sha256 beside ${finalUrl}`); }
    if (!Number.isInteger(size) || size <= 0) { throw new Error(`no content-length for ${finalUrl}`); }
    files[member] = { path: u.pathname.replace(/^\//, ''), sha256, size };
  }
  return { source: 'martinriedl', files };
}

const tag = await resolveTag(process.argv[2]);
console.log(`pinning BtbN ${tag} + martin-riedl current release builds...`);
const [btbn, macX64, macArm64] = await Promise.all([
  btbnEntries(tag),
  mrEntry('amd64'),
  mrEntry('arm64'),
]);

const manifest = {
  family: 'ffmpeg',
  schema: 1,
  btbn: { repo: BTBN_REPO, tag },
  assets: {
    'linux-x64': btbn['linux-x64'],
    'linux-arm64': btbn['linux-arm64'],
    'win32-x64': btbn['win32-x64'],
    'darwin-x64': macX64,
    'darwin-arm64': macArm64,
  },
};

const before = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null;
const after = JSON.stringify(manifest, null, 2) + '\n';
writeFileSync(OUT, after);
console.log(`wrote ${OUT}`);
if (before === after) {
  console.log('no changes — pins already current');
} else {
  for (const [key, e] of Object.entries(manifest.assets)) {
    if (e.source === 'btbn') { console.log(`  ${key}: ${e.file} (${(e.size / 1e6).toFixed(1)} MB, ${e.sha256.slice(0, 12)}...)`); }
    else { console.log(`  ${key}: ${e.files.ffmpeg.path} (+ ffprobe, ${e.files.ffmpeg.sha256.slice(0, 12)}...)`); }
  }
  console.log('review the diff and ship it as a manifest-bump PR.');
}
