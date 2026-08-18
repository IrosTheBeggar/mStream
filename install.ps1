# Installs mStream on Windows.
#
#   irm https://raw.githubusercontent.com/IrosTheBeggar/mStream/master/install.ps1 | iex
#
# Fetches the Windows bundle from the release, checks its sha256 against
# the release's manifest.json, extracts it into a versioned folder under
# %LOCALAPPDATA%\Programs\mStream, points a `current` junction at it, adds
# a Start Menu shortcut, and puts the folder on the user PATH so
# `mstream-server` works in any terminal. Configuration, all optional, via
# environment variables (the pipe-to-iex form cannot take parameters):
#
#   MSTREAM_VERSION       a tag like v6.20.0 (default: latest)
#   MSTREAM_INSTALL_DIR   root for the app folders
#   MSTREAM_NO_PATH       set to 1 to leave PATH alone
#   MSTREAM_NO_DESKTOP    set to 1 to skip the Start Menu shortcut
#   MSTREAM_RELEASE_BASE  URL serving manifest.json + the zips (default: the
#                         GitHub release) - for internal mirrors and testing
#
# The bundle is a folder (mStream.exe tray launcher + mstream-server.exe +
# webapp\ + bin\ sidecars). Data lives in %LOCALAPPDATA%\mStream, outside
# the app folder, so re-running this to upgrade never touches your library.
#
# Windows PowerShell 5.1 is the floor. That is why TLS 1.2 is asked for by
# hand (5.1 predates it being the default), and why this file is pure
# ASCII: without a BOM, 5.1 reads UTF-8 as the ANSI codepage, where the
# last byte of an em dash turns into a curly quote that PowerShell will
# happily treat as a string terminator.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072

$repo = 'IrosTheBeggar/mStream'
$key = 'win-x64'
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
    throw "no prebuilt bundle for $env:PROCESSOR_ARCHITECTURE - x64 only for now"
}

$version = if ($env:MSTREAM_VERSION) { $env:MSTREAM_VERSION } else { 'latest' }
$root = if ($env:MSTREAM_INSTALL_DIR) {
    $env:MSTREAM_INSTALL_DIR
} else {
    Join-Path $env:LOCALAPPDATA 'Programs\mStream'
}
$base = if ($env:MSTREAM_RELEASE_BASE) {
    $env:MSTREAM_RELEASE_BASE.TrimEnd('/')
} elseif ($version -eq 'latest') {
    "https://github.com/$repo/releases/latest/download"
} else {
    "https://github.com/$repo/releases/download/$version"
}

$tmp = Join-Path $env:TEMP "mstream-install-$PID"
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
    # The manifest first: it names the exact zip for this version, so the
    # script never guesses the version number embedded in the filename.
    Write-Host "fetching manifest ($version)..."
    Invoke-WebRequest -UseBasicParsing -Uri "$base/manifest.json" -OutFile (Join-Path $tmp 'manifest.json')
    $manifest = Get-Content (Join-Path $tmp 'manifest.json') -Raw | ConvertFrom-Json
    if (-not $manifest.version) { throw 'manifest.json is missing a version - refusing to install' }
    $ver = $manifest.version
    $bundle = "mStream-$ver-$key"
    $asset = "$bundle.zip"
    $expected = ($manifest.assets | Where-Object file -eq $asset).sha256
    if (-not $expected) {
        throw "manifest.json has no entry for $asset - this release has no Windows bundle"
    }

    Write-Host "fetching $asset..."
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile (Join-Path $tmp $asset)
    $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $asset)).Hash.ToLower()
    if ($actual -ne $expected) {
        throw "sha256 mismatch for $asset - download corrupted, not installing (expected $expected, got $actual)"
    }

    # Extract beside the final location, then rename into place: a killed
    # install leaves a stray .partial folder, never a half-written `current`.
    New-Item -ItemType Directory -Force $root | Out-Null
    $partial = Join-Path $root "$bundle.partial"
    $final = Join-Path $root $bundle
    if (Test-Path $partial) { Remove-Item -Recurse -Force $partial }
    Expand-Archive -Path (Join-Path $tmp $asset) -DestinationPath $partial -Force
    if (Test-Path $final) {
        # A running launcher holds files open; stopping it is the user's
        # call (tray > Quit), so say why instead of a cryptic access error.
        try { Remove-Item -Recurse -Force $final } catch {
            throw "could not replace $final - if mStream is running, Quit it from the tray icon and re-run"
        }
    }
    Move-Item (Join-Path $partial $bundle) $final
    Remove-Item -Recurse -Force $partial

    # `current` as a junction (no admin needed, unlike a symlink), so a
    # shortcut and the PATH entry keep working across upgrades.
    $current = Join-Path $root 'current'
    if (Test-Path $current) { (Get-Item $current).Delete() }
    New-Item -ItemType Junction -Path $current -Target $final | Out-Null

    Write-Host "installed mStream $ver to $final"
    # Proof the binary execs here: commander's -V is instant and boots nothing.
    try {
        $v = & (Join-Path $final 'mstream-server.exe') -V 2>&1
        if ($LASTEXITCODE -eq 0 -and $v) { Write-Host "  mstream-server $v runs" }
        else { Write-Warning "the server did not run cleanly ($v) - see $final\README.txt" }
    } catch { Write-Warning "the server did not run: $($_.Exception.Message)" }

    if (-not $env:MSTREAM_NO_DESKTOP) {
        # Start Menu shortcut to the tray launcher (mStream.exe), which is
        # the double-click experience: background server + tray + browser.
        $programs = [Environment]::GetFolderPath('Programs')
        $shell = New-Object -ComObject WScript.Shell
        $lnk = $shell.CreateShortcut((Join-Path $programs 'mStream.lnk'))
        $lnk.TargetPath = Join-Path $current 'mStream.exe'
        $lnk.WorkingDirectory = $current
        $lnk.Description = 'mStream music server'
        $lnk.Save()
        Write-Host "  Start Menu: mStream (tray icon; Quick Connect on)"
    }
    Write-Host "  headless: mstream-server   (data lives in $env:LOCALAPPDATA\mStream, not the app folder)"

    if (-not $env:MSTREAM_NO_PATH) {
        # The user PATH in the registry, not this session's: an installer
        # that edits $env:PATH improves exactly one window's life.
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        if (($userPath -split ';') -notcontains $current) {
            [Environment]::SetEnvironmentVariable('Path', "$userPath;$current", 'User')
            Write-Host "  added $current to your user PATH - new terminals will see mstream-server"
        }
    }

    $others = Get-ChildItem $root -Directory | Where-Object { $_.Name -like "mStream-*-$key" -and $_.Name -ne $bundle }
    if ($others) {
        Write-Host "  older versions kept under $root - safe to delete any that aren't 'current'"
    }
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
