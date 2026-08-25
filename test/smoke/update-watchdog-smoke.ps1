# Boot-watchdog rollback smoke, Windows edition (manual): proves the
# launcher rolls a managed install.ps1-style layout back when the version
# behind the `current` junction crashes at boot.
#
#   1. Fabricates a managed root: `current` (a junction, like install.ps1
#      makes) -> a bundle whose mstream-server.exe answers -V (it "passed"
#      the installers' exec probe) but exits 1 on a real boot, beside a
#      previous version whose server idles forever. The REAL launcher
#      binary rides in both bundles; the stub servers are compiled on the
#      spot with rustc (find_server_bin wants a real .exe sibling).
#   2. Pre-writes the stale armed update-status.json a real bad apply
#      leaves behind.
#   3. Starts the launcher behind `current` under a scratch LOCALAPPDATA
#      and expects: one retry, then rollback - `current` re-pointed at the
#      previous version (remove_dir + mklink /J + canonicalize verify, the
#      code path this smoke exists to execute on real Windows), the failed
#      version recorded in update-hold.json, the stale status file deleted,
#      a takeover launcher running from `current`, and the failed-version
#      launcher gone.
#
# Needs: a built launcher (cd rust-launcher; cargo build --release - or
# MSTREAM_LAUNCHER_BIN pointing at one) and rustc on PATH (comes with the
# cargo toolchain). Run in an interactive session if possible (the tray
# face degrades gracefully without one, but that is the realistic shape).
# The scratch LOCALAPPDATA plus MSTREAM_LAUNCHER_SKIP_AUTOSTART keep real
# login items and data untouched. If the watchdog DECLINES or the rollback
# fails, the launcher shows a message box - close it; the assertions below
# will report the failure either way.
$ErrorActionPreference = 'Stop'

$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$launcher = if ($env:MSTREAM_LAUNCHER_BIN) { $env:MSTREAM_LAUNCHER_BIN }
    else { Join-Path $repo 'rust-launcher\target\release\mstream-launcher.exe' }
if (-not (Test-Path $launcher)) {
    throw "no launcher at $launcher - build it (cd rust-launcher; cargo build --release) or set MSTREAM_LAUNCHER_BIN"
}
if (-not (Get-Command rustc -ErrorAction SilentlyContinue)) {
    throw 'rustc not on PATH - the stub servers are compiled on the spot (install the cargo toolchain)'
}
# The version baked into the launcher (build.rs reads package.json) - the
# fabricated `current` bundle must carry it or the watchdog rightly declines.
$pkgver = [string](Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
$key = 'win-x64'

$tag = "mstream-watchdog-smoke-$PID"
$smoke = Join-Path $env:TEMP $tag
$fakeLocal = Join-Path $smoke 'localappdata'
$root = Join-Path $smoke 'root'
$data = Join-Path $fakeLocal 'mStream'
if (Test-Path $smoke) { Remove-Item -Recurse -Force $smoke }
New-Item -ItemType Directory -Force $root, $data | Out-Null

# strip the \\?\ extended-length prefix the launcher's canonicalized paths
# carry, so junction targets compare cleanly.
function DePrefix([string]$p) { if ($p) { return ($p -replace '^\\\\\?\\', '') } else { return '' } }
function CurrentTarget {
    $item = Get-Item (Join-Path $root 'current') -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        return DePrefix (($item.Target | Select-Object -First 1))
    }
    return ''
}
function SmokeProcs {
    @(Get-Process mstream-launcher, mStream, mstream-server -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path -like "*$tag*" })
}

function Make-Bundle([string]$ver, [string]$stubBody) {
    $b = Join-Path $root "mStream-$ver-$key"
    New-Item -ItemType Directory -Force $b | Out-Null
    Copy-Item $launcher (Join-Path $b 'mStream.exe')
    $src = Join-Path $smoke "stub-$ver.rs"
    Set-Content -Path $src -Value $stubBody -Encoding ASCII
    & rustc -O $src -o (Join-Path $b 'mstream-server.exe') 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "rustc failed for the $ver stub" }
    return $b
}

# The BAD current version: -V answers, a real boot crashes.
$badBundle = Make-Bundle $pkgver @"
fn main() {
    if std::env::args().nth(1).as_deref() == Some("-V") { println!("$pkgver"); return; }
    eprintln!("boom: simulated boot crash");
    std::process::exit(1);
}
"@
# The previous version: -V answers, a real boot idles forever (the identity
# probe gives up into Unverified after 60s; this smoke never waits that long).
$prevBundle = Make-Bundle '0.0.1' @'
fn main() {
    if std::env::args().nth(1).as_deref() == Some("-V") { println!("0.0.1"); return; }
    loop { std::thread::sleep(std::time::Duration::from_secs(3600)); }
}
'@
New-Item -ItemType Junction -Path (Join-Path $root 'current') -Target $badBundle | Out-Null

# The stale armed status file a real bad apply leaves behind.
Set-Content -Path (Join-Path $data 'update-status.json') -Encoding ASCII -Value (
    '{"applyRequested":true,"applyRequestedAt":"2026-01-01T00:00:00.000Z",' +
    "`"staged`":true,`"stagedVersion`":`"$pkgver`",`"method`":`"managed`"}")

$savedLocal = $env:LOCALAPPDATA
$savedProfile = $env:USERPROFILE
$savedSkip = $env:MSTREAM_LAUNCHER_SKIP_AUTOSTART
$fail = 1
try {
    $env:LOCALAPPDATA = $fakeLocal
    $env:USERPROFILE = $smoke
    $env:MSTREAM_LAUNCHER_SKIP_AUTOSTART = '1'
    Write-Host "starting launcher (bad current: $pkgver, previous: 0.0.1)..."
    # --tray: launched from a console this exe would otherwise become the
    # transparent pass-through server face and never run the watchdog.
    $bad = Start-Process -FilePath (Join-Path $root 'current\mStream.exe') `
        -ArgumentList '--tray', '--no-open' -PassThru

    # Two instant crashes + the rollback land within a few seconds; poll 60.
    $prevDeprefixed = DePrefix $prevBundle
    for ($i = 0; $i -lt 60; $i++) {
        if ((CurrentTarget) -eq $prevDeprefixed) { break }
        Start-Sleep -Seconds 1
    }

    Write-Host "== launcher.log =="
    Get-Content (Join-Path $data 'logs\launcher.log') -ErrorAction SilentlyContinue
    Write-Host "== assertions =="
    $fail = 0
    if ((CurrentTarget) -eq $prevDeprefixed) {
        Write-Host 'PASS current re-pointed at 0.0.1'
    } else {
        Write-Host "FAIL current -> $(CurrentTarget)"; $fail = 1
    }
    $hold = Join-Path $data 'update-hold.json'
    if ((Test-Path $hold) -and (Select-String -Path $hold -Pattern "`"version`": `"$pkgver`"" -Quiet)) {
        Write-Host "PASS hold recorded for $pkgver"
    } else {
        Write-Host "FAIL no hold for $pkgver"; $fail = 1
    }
    if (Test-Path (Join-Path $data 'update-status.json')) {
        Write-Host 'FAIL stale update-status.json survived'; $fail = 1
    } else {
        Write-Host 'PASS stale update-status.json deleted'
    }
    Start-Sleep -Seconds 3   # give the takeover a beat past its lock retry
    $takeover = @(SmokeProcs | Where-Object { $_.Name -ne 'mstream-server' -and $_.Id -ne $bad.Id })
    if ($takeover.Count -gt 0) {
        Write-Host 'PASS a takeover launcher is running from the rolled-back layout'
    } else {
        Write-Host 'FAIL no takeover launcher running'; $fail = 1
    }
    if ($bad.HasExited) {
        Write-Host 'PASS the failed-version launcher exited'
    } else {
        Write-Host 'FAIL the failed-version launcher is still alive'; $fail = 1
    }
} finally {
    $env:LOCALAPPDATA = $savedLocal
    $env:USERPROFILE = $savedProfile
    $env:MSTREAM_LAUNCHER_SKIP_AUTOSTART = $savedSkip
    SmokeProcs | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    $cur = Get-Item (Join-Path $root 'current') -Force -ErrorAction SilentlyContinue
    if ($cur -and ($cur.Attributes -band [IO.FileAttributes]::ReparsePoint)) { $cur.Delete() }
    Remove-Item -Recurse -Force $smoke -ErrorAction SilentlyContinue
}
exit $fail
