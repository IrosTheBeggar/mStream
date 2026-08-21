# Assert the Windows VersionInfo of every PE the win-x64 bundle ships, as
# WINDOWS reads it (Get-Item ... .VersionInfo goes through the Win32 version
# API - the same view Explorer's Details tab, Task Manager, and code-signing
# metadata restrictions get). Runs on the win-x64 CI leg right after bundling
# and works locally against any staged bundle:
#
#   pwsh scripts/check-win-versioninfo.ps1 -BundleDir dist/stage/mStream-6.20.2-win-x64 [-Strict]
#
# The contract (one block for every PE - see scripts/win-versioninfo.mjs):
#   ProductName "mStream" | ProductVersion = FileVersion = package version as
#   four numeric parts, in the string table AND the fixed-info numbers |
#   CompanyName = package author | LegalCopyright "<author> (<license>)" |
#   FileDescription non-empty (per file). Where each file's block comes from:
#   mstream-server.exe <- Bun --windows-* flags; mStream.exe <- the launcher's
#   build.rs (baked at its CI build; the tag build proves that build matches
#   the tag); the rust sidecars <- stamped by the bundler.
#
# -Strict (tag builds, and PR builds whose launcher was rebuilt from the same
# tree - build-bun.yml passes it then): every mismatch fails. Without it, a
# mismatch on mStream.exe ALONE, confined to the fields its build.rs bakes
# FROM package.json (the version strings/numbers, CompanyName,
# LegalCopyright), is a warning: a PR that edits package.json builds against
# the COMMITTED launcher, which was baked from the previous package.json by
# design - build-rust-launcher recommits it on merge (package.json is one of
# its triggers) and the tag build asserts strictly. Blank fields, a wrong
# ProductName/FileDescription, or a mismatch on any OTHER file are never
# lenient: those are produced in this very build and must match regardless.
#
# Any PE in the bundle that this script does not know is a FAILURE: a new
# binary must be added here (and given metadata) rather than ship blank -
# and later unsigned - by omission. bin/iroh/*.node is @number0/iroh's own
# prebuilt (upstream, not ours to relabel): listed, never checked. If you
# stage another sidecar in scripts/build-bun.mjs, add it to the stamper's
# description map there AND to $known here in the same change.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$BundleDir,
  [switch]$Strict,
  [string]$PackageJson
)
$ErrorActionPreference = 'Stop'
$inCi = [bool]$env:GITHUB_ACTIONS
# Default computed here, not in the param block: under Windows PowerShell 5.1
# `powershell -File` binds parameters before $PSScriptRoot is populated, and a
# default that reads it dies with "Split-Path: cannot bind ... empty string".
if (-not $PackageJson) { $PackageJson = Join-Path (Split-Path -Parent (Split-Path -Parent $PSCommandPath)) 'package.json' }

$BundleDir = (Resolve-Path -LiteralPath $BundleDir).Path
$pkg = Get-Content -LiteralPath $PackageJson -Raw | ConvertFrom-Json
# "6.21.0-beta.1" -> "6.21.0.0" (same rule as win-versioninfo.mjs / Bun's --windows-version)
$parts = @(([string]$pkg.version).Split('-')[0].Split('.') | ForEach-Object { $n = 0; [void][int]::TryParse($_, [ref]$n); $n })
while ($parts.Count -lt 4) { $parts += 0 }
$expectVersion = ($parts[0..3] -join '.')
$expectAuthor = [string]$pkg.author.name
$expect = @{
  ProductName    = 'mStream'
  ProductVersion = $expectVersion
  FileVersion    = $expectVersion
  CompanyName    = $expectAuthor
  LegalCopyright = ('{0} ({1})' -f $expectAuthor, [string]$pkg.license)
}

# Known PEs, relative to the bundle root. `lenient` = the launcher rule above.
$known = @(
  @{ path = 'mStream.exe';                                          lenient = $true;  optional = $true  }  # absent in a local server-only bundle
  @{ path = 'mstream-server.exe';                                   lenient = $false; optional = $false }
  @{ path = 'bin\rust-parser\rust-parser-win32-x64.exe';            lenient = $false; optional = $false }
  # optional: fetched from the pinned mstream-terminal-player release at
  # bundle time — a local/offline build legitimately ships without it (the
  # bundler is already fatal in CI when the fetch fails).
  @{ path = 'bin\mstream-player\mstream-player-win32-x64.exe'; lenient = $false; optional = $true }
  # Fetched from the pinned release assets at bundle time and stamped like
  # the other sidecars (build-bun.mjs). optional: a local/offline build
  # legitimately ships without it (runtime fetch is the fallback); in CI
  # the bundler itself is fatal on a missing asset, so absence here can
  # only mean a deliberate MSTREAM_ALLOW_MISSING_SIDECAR build.
  @{ path = 'bin\p2p-sidecar\p2p-sidecar-win32-x64.exe';            lenient = $false; optional = $true  }
)
$upstream = @('bin\iroh\iroh.win32-x64-msvc.node')
# The server's ffmpeg-bootstrap downloads ffmpeg/ffprobe into <appRoot>/bin/ffmpeg
# at RUNTIME. They are never in the zip (the bundler cuts it before anything
# runs), but a staged bundle that has been booted locally carries them -
# upstream binaries, not ours: listed, never checked.
$runtimeUpstreamPrefix = 'bin\ffmpeg\'

$failures = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]
function Report([string]$kind, [string]$msg) {
  if ($kind -eq 'error') {
    if ($inCi) { Write-Host "::error::$msg" } else { Write-Host "ERROR: $msg" }
    $failures.Add($msg)
  } else {
    if ($inCi) { Write-Host "::warning::$msg" } else { Write-Host "WARNING: $msg" }
    $warnings.Add($msg)
  }
}

Write-Host "VersionInfo contract for $BundleDir"
Write-Host ("  expect ProductName='{0}' version='{1}' CompanyName='{2}' LegalCopyright='{3}'" -f $expect.ProductName, $expectVersion, $expect.CompanyName, $expect.LegalCopyright)
Write-Host ("  mode: {0}" -f $(if ($Strict) { 'STRICT (tag build: every mismatch fails)' } else { 'lenient on mStream.exe (PR build)' }))
Write-Host ''

$rows = @()
foreach ($k in $known) {
  $full = Join-Path $BundleDir $k.path
  if (-not (Test-Path -LiteralPath $full)) {
    if ($k.optional) { Write-Host ("  (absent, skipped) {0}" -f $k.path); continue }
    Report 'error' ("missing PE: {0}" -f $k.path); continue
  }
  $v = (Get-Item -LiteralPath $full).VersionInfo
  $raw = @{ FileVersionRaw = $v.FileVersionRaw.ToString(); ProductVersionRaw = $v.ProductVersionRaw.ToString() }
  $rows += [pscustomobject]@{
    File = $k.path; ProductName = $v.ProductName; ProductVersion = $v.ProductVersion; FileVersion = $v.FileVersion
    FileVersionRaw = $raw.FileVersionRaw; ProductVersionRaw = $raw.ProductVersionRaw
    CompanyName = $v.CompanyName; FileDescription = $v.FileDescription; LegalCopyright = $v.LegalCopyright
  }
  $problems = @()
  foreach ($field in @('ProductName', 'ProductVersion', 'FileVersion', 'CompanyName', 'LegalCopyright')) {
    $have = [string]$v.$field
    if ($have -ne $expect[$field]) { $problems += ("{0}='{1}' (want '{2}')" -f $field, $have, $expect[$field]) }
  }
  foreach ($field in @('FileVersionRaw', 'ProductVersionRaw')) {
    if ($raw[$field] -ne $expectVersion) { $problems += ("{0}={1} (want {2})" -f $field, $raw[$field], $expectVersion) }
  }
  if ([string]::IsNullOrWhiteSpace($v.FileDescription)) { $problems += 'FileDescription is empty' }
  if ($problems.Count -eq 0) { continue }
  # Launcher leniency: ONLY the fields build.rs bakes from package.json
  # (versions, CompanyName, LegalCopyright - blank included: a launcher
  # committed by an older build.rs simply lacks them, which is the same lag),
  # ONLY when not strict, ONLY if nothing else is wrong. A missing rc.exe or
  # a broken build.rs blanks ProductName/FileDescription too, and those are
  # never lenient; a launcher rebuilt from the PR itself runs strict.
  $pkgDerived = '^(ProductVersion|FileVersion|FileVersionRaw|ProductVersionRaw|CompanyName|LegalCopyright)='
  $lagOnly = @($problems | Where-Object { $_ -notmatch $pkgDerived }).Count -eq 0
  if ($k.lenient -and -not $Strict -and $lagOnly) {
    Report 'warning' ("{0}: package.json-derived fields lag ({1}) - expected on a PR that edits package.json (version/author/license) and stages the COMMITTED launcher; build-rust-launcher recommits it on merge and the tag build asserts strictly" -f $k.path, ($problems -join '; '))
  } else {
    Report 'error' ("{0}: {1}" -f $k.path, ($problems -join '; '))
  }
}

# Every other PE in the bundle must be accounted for.
$allPe = Get-ChildItem -LiteralPath $BundleDir -Recurse -File | Where-Object { $_.Extension -in '.exe', '.dll', '.node' }
foreach ($pe in $allPe) {
  $rel = $pe.FullName.Substring($BundleDir.Length).TrimStart('\', '/')
  if ($known.path -contains $rel) { continue }
  if ($upstream -contains $rel) { Write-Host ("  (upstream, not checked) {0}" -f $rel); continue }
  if ($rel.StartsWith($runtimeUpstreamPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { Write-Host ("  (upstream runtime download, not in the zip, not checked) {0}" -f $rel); continue }
  Report 'error' ("unknown PE in bundle: {0} - add it to scripts/check-win-versioninfo.ps1 (and give it VersionInfo) instead of shipping it blank" -f $rel)
}

Write-Host ''
$rows | Format-Table -AutoSize -Wrap | Out-String -Width 220 | Write-Host
if ($failures.Count -gt 0) {
  Write-Host ("VersionInfo check FAILED: {0} problem(s), {1} warning(s)" -f $failures.Count, $warnings.Count)
  exit 1
}
Write-Host ("VersionInfo check OK: {0} PE(s) match the contract, {1} warning(s)" -f $rows.Count, $warnings.Count)
exit 0
