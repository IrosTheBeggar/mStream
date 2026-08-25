# Boot-probe smoke under REAL Windows PowerShell 5.1 (manual): validates
# install.ps1's --boot-probe handling on the `irm | iex` floor that CI
# cannot cover (its windows legs run pwsh 7).
#
#   Case 1 (refusal): an upgrade bundle that EXECS (-V answers) but fails
#     --boot-probe with the "boot-probe:" sentinel must be refused - a
#     thrown 'would not BOOT' message carrying the sentinel text, and the
#     `current` junction left on the working install.
#   Case 2 (pass): a probe-ok upgrade must proceed with NO stray error
#     records surfacing from the probe's stderr capture - the local
#     ErrorActionPreference='Continue' window in install.ps1 is exactly
#     what is under test here.
#
# Why 5.1 specifically: under EAP=Stop, 5.1 turns ANY native stderr line
# into a terminating NativeCommandError - even through a `2>` file
# redirect (this harness hit that on release-manifest.sh's stderr SUCCESS
# line while being built). Without install.ps1's capture window, any
# stderr line from the probe would kill every 5.1 install.
#
# Needs: rustc on PATH (stub servers compiled on the spot), git-bash (for
# scripts/release-manifest.sh; found via git.exe - bare `bash` from
# PowerShell resolves to WSL's System32\bash.exe, never use it), and a
# real python (the Microsoft Store stub is detected and refused).
# Scratch-scoped: MSTREAM_INSTALL_DIR under %TEMP%, no registry, no real
# data. Run: npm run test:smoke:boot-probe:win51
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($PSVersionTable.PSEdition -ne 'Desktop') {
    Write-Warning "running under $($PSVersionTable.PSEdition) $($PSVersionTable.PSVersion) - the point of this smoke is Windows PowerShell 5.1 (Desktop); results are not the floor's"
}
"powershell edition/version: $($PSVersionTable.PSEdition) $($PSVersionTable.PSVersion)"

$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if (-not (Get-Command rustc -ErrorAction SilentlyContinue)) { throw 'rustc not on PATH (install the cargo toolchain)' }
# A real python: the WindowsApps Store stub answers `python` but cannot run
# code. Probe it before trusting it with the zip + feed duties.
& python -c "import zipfile, http.server" 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'python on PATH is missing or is the Microsoft Store stub - install real Python' }
# git-bash, located via git.exe (layouts: <root>\cmd\git.exe or <root>\bin\git.exe).
$gitBash = $null
$git = Get-Command git -ErrorAction SilentlyContinue
if ($git) {
    $gitRoot = Split-Path (Split-Path $git.Source -Parent) -Parent
    foreach ($cand in @((Join-Path $gitRoot 'bin\bash.exe'), (Join-Path (Split-Path $git.Source -Parent) 'bash.exe'))) {
        if (Test-Path $cand) { $gitBash = $cand; break }
    }
}
if (-not $gitBash) { $gitBash = 'C:\Program Files\Git\bin\bash.exe' }
if (-not (Test-Path $gitBash)) { throw 'git-bash not found (needed for scripts/release-manifest.sh)' }

$smoke = Join-Path $env:TEMP "mstream-probe51-$PID"
$rel = Join-Path $smoke 'rel'
$app = Join-Path $smoke 'app'
if (Test-Path $smoke) { Remove-Item -Recurse -Force $smoke }
New-Item -ItemType Directory -Force $rel | Out-Null
$fail = 0

function Make-Stub([string]$ver, [string]$probeBody) {
    $b = Join-Path $rel "mStream-$ver-win-x64"
    New-Item -ItemType Directory -Force $b | Out-Null
    $src = Join-Path $smoke "stub$($ver -replace '[^0-9]','').rs"
    $code = 'fn main(){let a=std::env::args().nth(1);if a.as_deref()==Some("-V"){println!("' + $ver + '");return;}if a.as_deref()==Some("--boot-probe"){' + $probeBody + '}}'
    Set-Content -Path $src -Value $code -Encoding ASCII
    # --crate-name: rustc derives it from the file name otherwise; stderr to
    # a file, never 2>&1 (the 5.1 NativeCommandError trap).
    $errf = "$src.err"
    & rustc -O --crate-name ('s' + ($ver -replace '[^0-9]','')) $src -o (Join-Path $b 'mstream-server.exe') 2>$errf | Out-Null
    if ($LASTEXITCODE -ne 0) { Get-Content $errf; throw "rustc failed for $ver" }
    Set-Content (Join-Path $b 'README.txt') 'stub'
    Push-Location $rel
    & python -m zipfile -c "mStream-$ver-win-x64.zip" "mStream-$ver-win-x64" 2>$null
    Pop-Location
    if ($LASTEXITCODE -ne 0) { throw "zip failed for $ver" }
    Remove-Item -Recurse -Force $b
}

function Publish([string]$ver) {
    Get-ChildItem $rel -Filter 'manifest.json' -ErrorAction SilentlyContinue | Remove-Item -Force
    # The generator logs its SUCCESS line to stderr; under EAP=Stop, 5.1
    # terminates on that record even with a 2> redirect - the same local
    # EAP=Continue window install.ps1 uses around --boot-probe.
    $eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $null = (& $gitBash (($repo -replace '\\','/') + '/scripts/release-manifest.sh') $ver ($rel -replace '\\','/') 2>&1 | Out-String)
    $ErrorActionPreference = $eap
    if (-not (Test-Path (Join-Path $rel 'manifest.json'))) { throw "manifest generation failed for $ver" }
}

function CurrentTarget {
    $i = Get-Item (Join-Path $app 'current') -Force -ErrorAction SilentlyContinue
    if ($i -and ($i.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return ($i.Target | Select-Object -First 1) }
    return ''
}

$feed = Start-Process -FilePath python -ArgumentList '-m','http.server','8766','--bind','127.0.0.1','--directory',$rel -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2

$saved = @{}
foreach ($k in 'MSTREAM_RELEASE_BASE','MSTREAM_INSTALL_DIR','MSTREAM_NO_DESKTOP','MSTREAM_NO_PATH') { $saved[$k] = [Environment]::GetEnvironmentVariable($k) }
$env:MSTREAM_RELEASE_BASE = 'http://127.0.0.1:8766'
$env:MSTREAM_INSTALL_DIR = $app
$env:MSTREAM_NO_DESKTOP = '1'
$env:MSTREAM_NO_PATH = '1'
try {
    Push-Location $repo

    Make-Stub '9.9.9' 'println!("boot-probe: ok");std::process::exit(0);'
    Publish '9.9.9'
    & .\install.ps1 *>&1 | Out-Null
    if ((CurrentTarget) -notmatch 'mStream-9\.9\.9-win-x64$') { throw "baseline install failed: current -> $(CurrentTarget)" }
    Write-Host 'baseline 9.9.9 installed (probe-ok path exercised on first install)'

    # Case 1: refusal - execs but cannot boot
    Get-ChildItem $rel -Filter 'mStream-*.zip' | Remove-Item -Force
    Make-Stub '9.9.11' 'println!("boot-probe: FAIL simulated boot regression");std::process::exit(1);'
    Publish '9.9.11'
    $threw = $null
    $Error.Clear()
    try { & .\install.ps1 *>&1 | Out-Null } catch { $threw = "$_" }
    if ($threw -and $threw -match 'would not BOOT' -and $threw -match 'boot-probe: FAIL simulated boot regression') {
        Write-Host 'PASS refusal thrown with would-not-BOOT + sentinel text'
    } else {
        Write-Host "FAIL refusal message wrong or absent: [$threw]"; $fail = 1
    }
    if ((CurrentTarget) -match 'mStream-9\.9\.9-win-x64$') {
        Write-Host 'PASS current unchanged after refusal (still 9.9.9)'
    } else {
        Write-Host "FAIL current moved: $(CurrentTarget)"; $fail = 1
    }

    # Case 2: pass path - probe-ok upgrade, no stray 5.1 error records
    Get-ChildItem $rel -Filter 'mStream-*.zip' | Remove-Item -Force
    Make-Stub '9.9.12' 'println!("boot-probe: ok");std::process::exit(0);'
    Publish '9.9.12'
    $Error.Clear()
    $out = & .\install.ps1 *>&1 | Out-String
    if ((CurrentTarget) -match 'mStream-9\.9\.12-win-x64$') {
        Write-Host 'PASS pass-path upgrade flipped current to 9.9.12'
    } else {
        Write-Host "FAIL pass-path: current -> $(CurrentTarget)"; $fail = 1
    }
    $strays = @($Error | Where-Object { "$_" -match 'NativeCommandError|boot-probe' })
    if ($strays.Count -eq 0 -and $out -notmatch 'NativeCommandError') {
        Write-Host 'PASS no stray error records from the probe capture'
    } else {
        Write-Host "FAIL stray error records: $($strays.Count)"; $fail = 1
    }
} finally {
    Pop-Location -ErrorAction SilentlyContinue
    foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
    Stop-Process -Id $feed.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Remove-Item -Recurse -Force $smoke -ErrorAction SilentlyContinue
}
if ($fail -eq 0) { Write-Host 'BOOT-PROBE 5.1 SMOKE: ALL PASS' } else { Write-Host 'BOOT-PROBE 5.1 SMOKE: FAILURES' }
exit $fail
