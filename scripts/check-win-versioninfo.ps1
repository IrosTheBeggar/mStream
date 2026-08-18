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
# -Strict (tag builds): every mismatch fails. Without it (PR builds), a
# version mismatch on mStream.exe ALONE is a warning: a PR that bumps
# package.json builds against the committed launcher, which was baked for the
# previous version by design - the release ritual (docs/deploy.md) rebuilds it
# before the tag, and the tag build asserts strictly. Everything else is
# produced in this very build and must match regardless.
#
# Any PE in the bundle that this script does not know is a FAILURE: a new
# binary must be added here (and given metadata) rather than ship blank -
# and later unsigned - by omission. bin/iroh/*.node is @number0/iroh's own
# prebuilt (upstream, not ours to relabel): listed, never checked.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$BundleDir,
  [switch]$Strict,
  [string]$PackageJson = (Join-Path (Split-Path -Parent $PSScriptRoot) 'package.json')
)
$ErrorActionPreference = 'Stop'
$inCi = [bool]$env:GITHUB_ACTIONS

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
  @{ path = 'bin\rust-server-audio\rust-server-audio-win32-x64.exe'; lenient = $false; optional = $false }
)
$upstream = @('bin\iroh\iroh.win32-x64-msvc.node')

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
  # Launcher leniency: ONLY version fields, ONLY when not strict, ONLY if
  # nothing else is wrong - a blank ProductName or company is a real bug even
  # on a PR build.
  $versionOnly = @($problems | Where-Object { $_ -notmatch '^(ProductVersion|FileVersion|FileVersionRaw|ProductVersionRaw)=' }).Count -eq 0
  if ($k.lenient -and -not $Strict -and $versionOnly) {
    Report 'warning' ("{0}: baked version differs from package.json ({1}) - expected on a PR that bumps the version; the committed launcher is rebuilt for the release before tagging and the tag build asserts strictly" -f $k.path, ($problems -join '; '))
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
