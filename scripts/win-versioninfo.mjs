// Windows VersionInfo stamping for the PE files the win-x64 bundle ships.
//
// The bundle carries three kinds of Windows binaries and each gets its
// VersionInfo (the Explorer "Details" tab / Task Manager name / what code
// signing later vouches for) a different way:
//   - mstream-server.exe: Bun writes it at compile time (--windows-* flags in
//     build-bun.mjs).
//   - mStream.exe (the launcher): rust-launcher/build.rs bakes it via
//     winresource, and the tag build asserts the baked version matches the
//     tag (build-bun.yml's provenance check).
//   - the Rust sidecars (rust-parser, rust-server-audio): CI-committed,
//     version-agnostic tools that were shipping with NO VersionInfo at all.
//     They are stamped HERE, at bundle time, from the bundle's package.json —
//     a release property applied at release-packaging time, so a version
//     bump can never leave them stale (the way it could a build-time bake in
//     a CI-committed binary) and no sidecar workflow has to rebuild+commit
//     five targets just to change a Windows string.
//
// One canonical block for all of them (asserted by
// scripts/check-win-versioninfo.ps1 on the win-x64 CI leg): ProductName
// "mStream", ProductVersion = FileVersion = the package version as four
// numeric parts, CompanyName = package author, LegalCopyright =
// "<author> (<license>)". FileDescription is per file (Task Manager shows it
// as the process name). Uniform metadata across every shipped PE is also a
// code-signing precondition (SignPath's artifact-configuration restrictions
// enforce product name/version on each signed file).
//
// resedit (pure JS, MIT) does the PE surgery — it is the same approach Bun
// uses internally for its --windows-* flags. It is a devDependency; CI's
// prod-only install adds it under scripts/node_modules (see build-bun.yml).
// Loaded lazily so non-Windows targets never need it.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// "6.21.0-beta.1" -> "6.21.0.0": Windows wants four numeric parts; prerelease
// tags don't fit and are dropped (same rule as Bun's --windows-version above).
export function windowsVersion(pkgVersion) {
  const parts = String(pkgVersion).split('-')[0].split('.').map((n) => String(parseInt(n, 10) || 0));
  while (parts.length < 4) { parts.push('0'); }
  return parts.slice(0, 4).join('.');
}

// The shared strings every stamped/baked/compiled PE must agree on.
export function canonicalFields(pkg) {
  const author = pkg.author?.name ?? '';
  return {
    productName: 'mStream',
    version: windowsVersion(pkg.version),
    companyName: author,
    legalCopyright: `${author} (${pkg.license ?? ''})`,
  };
}

let resedit = null;
async function loadResedit() {
  if (resedit) { return resedit; }
  try {
    resedit = await import('resedit');
  } catch (err) {
    const e = new Error(
      'resedit is not installed — Windows VersionInfo cannot be stamped. ' +
      'Dev checkouts get it from devDependencies (npm install); CI installs it ' +
      'with `npm install --prefix scripts --no-save resedit@<pinned>`. ' +
      `(${err.message})`,
    );
    e.code = 'RESEDIT_MISSING';
    throw e;
  }
  return resedit;
}

// Write ONE English (US, Unicode) string table carrying `fields` into `file`,
// replacing whatever VersionInfo it had (a PE with none gets a resource
// section created; a PE with tables in other languages loses them, so
// exactly one canonical block ships and Windows can't pick a stale one).
// Any other resources (icons, manifests) are preserved.
export async function stampWindowsVersionInfo(file, fields) {
  const R = await loadResedit();
  const buf = readFileSync(file);
  const exe = R.NtExecutable.from(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), { ignoreCert: true });
  const res = R.NtExecutableResource.from(exe, true);
  const existing = R.Resource.VersionInfo.fromEntries(res.entries);
  const vi = existing[0] ?? R.Resource.VersionInfo.createEmpty();
  for (const lang of vi.getAvailableLanguages()) {
    for (const key of Object.keys(vi.getStringValues(lang))) { vi.removeStringValue(lang, key, true); }
  }
  const [maj, min, mic, rev] = fields.version.split('.').map(Number);
  vi.setFileVersion(maj, min, mic, rev, 1033);
  vi.setProductVersion(maj, min, mic, rev, 1033);
  const name = basename(file);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, {
    ProductName: fields.productName,
    ProductVersion: fields.version,
    FileVersion: fields.version,
    FileDescription: fields.fileDescription,
    CompanyName: fields.companyName,
    LegalCopyright: fields.legalCopyright,
    OriginalFilename: name,
    InternalName: name.slice(0, name.length - extname(name).length),
  });
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  writeFileSync(file, Buffer.from(exe.generate()));
}

// Read back what a PE carries (resedit's view; check-win-versioninfo.ps1 is
// the Win32-API truth on Windows). Returns null when the file has no
// VersionInfo. Throws for PEs pe-library refuses to parse — notably Bun's
// compiled mstream-server.exe, whose `.bun` section sits after `.rsrc`
// ("After Resource section, sections except for relocation are not
// supported"): read that one with PowerShell. Handy for a quick look from
// any host:
//   bun scripts/win-versioninfo.mjs <file.exe> [...]
export async function readWindowsVersionInfo(file) {
  const R = await loadResedit();
  const buf = readFileSync(file);
  const exe = R.NtExecutable.from(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), { ignoreCert: true });
  const res = R.NtExecutableResource.from(exe, true);
  const [vi] = R.Resource.VersionInfo.fromEntries(res.entries);
  if (!vi) { return null; }
  const langs = vi.getAvailableLanguages();
  const strings = langs.length ? vi.getStringValues(langs[0]) : {};
  const fx = vi.fixedInfo;
  const fixed = (ms, ls) => `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`;
  return {
    languages: langs.map((l) => `${l.lang}/${l.codepage}`),
    fileVersionRaw: fixed(fx.fileVersionMS, fx.fileVersionLS),
    productVersionRaw: fixed(fx.productVersionMS, fx.productVersionLS),
    ...strings,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('usage: bun scripts/win-versioninfo.mjs <file.exe|.dll|.node> ...'); process.exit(2); }
  let failed = 0;
  for (const f of files) {
    console.log(f);
    try {
      console.log(await readWindowsVersionInfo(f) ?? '  (no VersionInfo)');
    } catch (err) {
      failed += 1;
      console.log(`  (unreadable by resedit: ${err.message} — on Windows use (Get-Item <file>).VersionInfo or scripts/check-win-versioninfo.ps1)`);
    }
  }
  process.exit(failed ? 1 : 0);
}
