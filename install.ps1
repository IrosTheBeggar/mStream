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
#   MSTREAM_NO_PATH       set to 1 to leave PATH alone. Persisted: scheduled
#                         re-runs (the in-app updater) keep the choice; set 0
#                         to re-enable and clear the persisted opt-out
#   MSTREAM_NO_DESKTOP    set to 1 to skip the Start Menu shortcut (persisted
#                         the same way; 0 re-enables)
#   MSTREAM_RELEASE_BASE  URL serving manifest.json + the zips (default: the
#                         GitHub release) - for internal mirrors and testing
#   MSTREAM_FORCE         set to 1 to replace an already-installed copy of
#                         the same version (the old one is moved aside)
#   MSTREAM_UNINSTALL     set to 1 to remove everything this script installed
#                         (app folders, PATH entry, Start Menu shortcut,
#                         login item). Your data is left in place.
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

# Where the login item points right now, if anywhere. The launcher registers
# ONE per-user login item by app name (HKCU\...\Run\mStream), so a second
# copy of mStream on the machine - one the user extracted by hand, a
# developer's checkout - shares the slot. This script only ever re-points
# or removes a login item that points at a copy IT manages (under $root);
# anything else is the user's and is left alone, and they are told so.
function Get-LoginItemTarget {
    $v = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name mStream -ErrorAction SilentlyContinue).mStream
    if (-not $v) { return $null }
    # The value is `"C:\path\mStream.exe" --autostarted`; take the quoted path.
    if ($v -match '^"([^"]+)"') { return $Matches[1] } else { return ($v -split ' ')[0] }
}
function Test-LoginItemIsOurs([string]$root) {
    $t = Get-LoginItemTarget
    return [bool]($t -and $t.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase))
}

# Everything below runs from Main, called on the LAST line: PowerShell parses
# the whole function before executing any of it, so an `irm | iex` whose
# stream is cut short fails to parse instead of running half an install.
function Main {
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
# Choices persisted by an earlier run rule later ones: the in-app updater
# re-runs this script on a schedule with a bare environment, and "I opted
# out of the Start Menu shortcut / PATH edit" must survive that. Env wins
# when set; the literal '0' explicitly re-enables (and un-persists).
$optFile = Join-Path $root '.install-options'
if ((-not $env:MSTREAM_UNINSTALL) -and (Test-Path $optFile)) {
    foreach ($line in Get-Content $optFile -ErrorAction SilentlyContinue) {
        $k, $v = $line -split '=', 2
        if ($k -eq 'no_desktop' -and -not $env:MSTREAM_NO_DESKTOP) { $env:MSTREAM_NO_DESKTOP = '1' }
        if ($k -eq 'no_path' -and -not $env:MSTREAM_NO_PATH) { $env:MSTREAM_NO_PATH = '1' }
    }
}
if ($env:MSTREAM_NO_DESKTOP -eq '0') { $env:MSTREAM_NO_DESKTOP = '' }
if ($env:MSTREAM_NO_PATH -eq '0') { $env:MSTREAM_NO_PATH = '' }

$base = if ($env:MSTREAM_RELEASE_BASE) {
    $env:MSTREAM_RELEASE_BASE.TrimEnd('/')
} elseif ($version -eq 'latest') {
    "https://github.com/$repo/releases/latest/download"
} else {
    "https://github.com/$repo/releases/download/$version"
}

# -- Uninstall: MSTREAM_UNINSTALL=1 removes everything this script created -
# the app folders + junction, the PATH entry, the Start Menu shortcut, and
# the login item - and nothing else. Your library, config, and database in
# %LOCALAPPDATA%\mStream stay put; the last line says where.
if ($env:MSTREAM_UNINSTALL) {
    $running = @(Get-Process mStream, mstream-server -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$root\*" })
    if ($running) { throw "mStream is running from $root - Quit it from the tray icon first, then re-run" }
    $current = Join-Path $root 'current'
    $launcher = Join-Path $current 'mStream.exe'
    $rootAbs = if (Test-Path $root) { (Resolve-Path $root).Path } else { $root }
    if ((Test-Path $launcher) -and (Test-LoginItemIsOurs $rootAbs)) {
        # Login item first, while a launcher still exists to remove it -
        # only if it points at a copy this script manages. Best-effort: an
        # exe that cannot start must not block the uninstall.
        try {
            & $launcher --autostart=disable 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) { Write-Host "removed the login item" }
        } catch { Write-Warning "could not run the launcher to remove the login item ($($_.Exception.Message))" }
    } elseif (Get-LoginItemTarget) {
        Write-Host "left the login item alone - it points at $(Get-LoginItemTarget), which this script did not install"
    }
    $lnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'mStream.lnk'
    if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Host "removed the Start Menu shortcut" }
    $envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    try {
        $rawPath = [string]$envKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $parts = @($rawPath -split ';' | Where-Object { $_ -and $_ -ne $current })
        if (($rawPath -split ';') -contains $current) {
            $envKey.SetValue('Path', ($parts -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
            Write-Host "removed $current from your user PATH"
        }
    } finally { $envKey.Close() }
    if (Test-Path $current) {
        # A junction: delete the link only, never the target's contents.
        $item = Get-Item $current -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $item.Delete() }
    }
    if (Test-Path $root) { Remove-Item -Recurse -Force $root; Write-Host "removed $root" }
    Write-Host "mStream is uninstalled. Your library, config, and database were left in place:"
    Write-Host "  $env:LOCALAPPDATA\mStream"
    Write-Host "  (delete that folder yourself if you want them gone too)"
    return
}

$tmp = Join-Path $env:TEMP "mstream-install-$PID"
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
    # The manifest first: it names the exact zip for this version, so the
    # script never guesses the version number embedded in the filename.
    Write-Host "fetching manifest ($version)..."
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$base/manifest.json" -OutFile (Join-Path $tmp 'manifest.json')
    } catch {
        throw ("could not fetch $base/manifest.json ($($_.Exception.Message)). " +
               "Releases published before the installer existed have no manifest.json - " +
               "pick a newer MSTREAM_VERSION, or download a bundle by hand from " +
               "https://github.com/$repo/releases (see docs/install.md).")
    }
    $manifest = Get-Content (Join-Path $tmp 'manifest.json') -Raw | ConvertFrom-Json
    if (-not $manifest.version) { throw 'manifest.json is missing a version - refusing to install' }
    $ver = [string]$manifest.version
    # The version becomes a path component below: keep it to what a release
    # tag can contain, so a bad manifest can't steer Remove-Item anywhere.
    if ($ver -notmatch '^[0-9A-Za-z.\-]+$') { throw "manifest.json version '$ver' is not a plain version string - refusing" }
    # apiVersion gates the layout contract; this copy may be YEARS old when
    # it runs (it rides inside every bundle for the in-app updater). A bump
    # means: do not guess at a layout you predate.
    if ($manifest.apiVersion -and $manifest.apiVersion -ne 1) {
        throw "this release uses a newer install layout (apiVersion $($manifest.apiVersion)) than this script understands - re-run the current installer (see docs/install.md)"
    }
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

    New-Item -ItemType Directory -Force $root | Out-Null
    $root = (Resolve-Path $root).Path   # a relative MSTREAM_INSTALL_DIR would bake into the junction + PATH
    $optFile = Join-Path $root '.install-options'  # re-anchor now that $root is absolute
    $partial = Join-Path $root "$bundle.partial"
    $final = Join-Path $root $bundle
    $current = Join-Path $root 'current'

    # Which mStream is running right now, if any? Never stop it (that is the
    # user's call, tray > Quit) - but never delete files under it either:
    # Remove-Item -Recurse tears through bin\ and webapp\ before it reaches
    # the locked exe, leaving a live server without its UI or sidecars. And
    # after an upgrade, that instance keeps running the OLD version until
    # restarted, which the summary must say plainly.
    $runningFrom = @(Get-Process mStream, mstream-server -ErrorAction SilentlyContinue |
        Where-Object { $_.Path } | ForEach-Object { Split-Path $_.Path } | Sort-Object -Unique)

    $installedFresh = $false
    if ((Test-Path $final) -and -not $env:MSTREAM_FORCE) {
        # Same version already installed: leave it ALONE (it may be live,
        # and under --portable it holds the user's config and database).
        # Re-point the links and shortcuts, nothing more.
        Write-Host "mStream $ver is already installed at $final - keeping it (set MSTREAM_FORCE=1 to replace)"
    } else {
        if ($runningFrom -contains $final) {
            throw "mStream is running from $final - Quit it from the tray icon and re-run to replace this version"
        }
        # Extract beside the final location, then rename into place: a killed
        # install leaves a stray .partial folder, never a half-written `current`.
        if (Test-Path $partial) { Remove-Item -Recurse -Force $partial }
        Expand-Archive -Path (Join-Path $tmp $asset) -DestinationPath $partial -Force
        if (Test-Path $final) {
            # Forced replace: MOVE the old copy aside (never rm), so
            # whatever state it held survives at a findable name.
            $aside = "$final.replaced-$(Get-Date -Format yyyyMMddHHmmss)"
            Move-Item $final $aside
            Write-Host "  previous copy moved to $aside"
        }
        Move-Item (Join-Path $partial $bundle) $final
        Remove-Item -Recurse -Force $partial
        $installedFresh = $true
    }

    # Does the NEW binary actually exec here? Probe BEFORE `current` moves:
    # a bundle this host cannot run must never take over a working install -
    # the in-app updater drives this script on a schedule, and a silent flip
    # here IS the next restart's outage. With a working `current` pointing
    # at a DIFFERENT version, refuse and throw (nonzero exit = failed stage);
    # a first install or same-version re-run keeps the diagnostic-only path.
    $newServerV = $null
    try {
        $probeOut = & (Join-Path $final 'mstream-server.exe') -V 2>&1
        if ($LASTEXITCODE -eq 0 -and $probeOut) { $newServerV = ($probeOut | Out-String).Trim() }
    } catch { }
    if (-not $newServerV) {
        $curTarget = $null
        if (Test-Path $current) {
            $curItem = Get-Item $current -Force
            if ($curItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { $curTarget = $curItem.Target | Select-Object -First 1 }
        }
        if ($curTarget -and (Test-Path $curTarget) -and ((Resolve-Path $curTarget).Path -ne $final)) {
            throw ("the new mstream-server ($ver) does not run on this system - keeping the existing install " +
                   "(current stays at $curTarget; the new copy is at $final)")
        }
    }

    # The DEEP probe, for bundles that know it: --boot-probe loads the
    # module graph, runs the existing config through the new build's schema,
    # and opens the database read-only - the execs-but-cannot-boot classes
    # -V is blind to. Exit 0 = would boot; nonzero WITH a "boot-probe:"
    # sentinel = would not; nonzero with NO sentinel = a bundle that
    # predates the flag (unknown option), which counts as a pass (-V
    # vouched; manual rollbacks must keep installing old bundles). The
    # local EAP=Continue window keeps native stderr as captured output -
    # under Stop, PS 5.1 turns it into a terminating NativeCommandError.
    $probeFail = $false
    $probeLines = @()
    if ($newServerV) {
        $eap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $probeText = (& (Join-Path $final 'mstream-server.exe') --boot-probe 2>&1 | Out-String)
        $probeCode = $LASTEXITCODE
        $ErrorActionPreference = $eap
        if ($probeCode -ne 0 -and $probeText -match 'boot-probe:') {
            $probeFail = $true
            $probeLines = @($probeText -split "`r?`n" | Where-Object { $_ -match '^boot-probe:' })
        }
    }
    if ($probeFail) {
        $curTarget = $null
        if (Test-Path $current) {
            $curItem = Get-Item $current -Force
            if ($curItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { $curTarget = $curItem.Target | Select-Object -First 1 }
        }
        if ($curTarget -and (Test-Path $curTarget) -and ((Resolve-Path $curTarget).Path -ne $final)) {
            throw ("the new mstream-server ($ver) would not BOOT on this system - keeping the existing install " +
                   "($($probeLines -join '; '); current stays at $curTarget; the new copy is at $final)")
        }
        # First install / same-version re-run: nothing working is displaced.
        Write-Warning "the boot probe flagged a problem this install may hit at first start: $($probeLines -join '; ')"
    }

    # `current` as a junction (no admin needed, unlike a symlink), so a
    # shortcut and the PATH entry keep working across upgrades. A REAL
    # directory named current (older manual layout) is moved aside, not
    # nested into. Deleting a junction removes only the link, never the
    # target's contents.
    if (Test-Path $current) {
        $item = Get-Item $current -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $item.Delete() }
        else { Move-Item $current "$current.was-a-directory-$(Get-Date -Format yyyyMMddHHmmss)" }
    }
    New-Item -ItemType Junction -Path $current -Target $final | Out-Null

    if ($installedFresh) { Write-Host "installed mStream $ver to $final" }

    # The choices this run actually used, for the next (possibly scheduled
    # and env-bare) run - see the read side near the top.
    $opts = @()
    if ($env:MSTREAM_NO_DESKTOP) { $opts += 'no_desktop=1' }
    if ($env:MSTREAM_NO_PATH) { $opts += 'no_path=1' }
    Set-Content -Path $optFile -Value ($opts -join "`n") -ErrorAction SilentlyContinue

    # The launcher registers ITSELF as the login item (HKCU Run) by absolute
    # path - the VERSIONED folder, not current - so an upgrade would never
    # reach the login item: next boot silently starts the OLD version. Ask
    # the NEW launcher to re-register (its --autostart CLI runs with no
    # tray/window/server), only if the user has it enabled.
    # Best-effort from here on: the install already succeeded, so nothing
    # below may fail it. Under $ErrorActionPreference='Stop', a launcher that
    # cannot start at all ("not a valid application for this OS platform" -
    # a foreign-arch or corrupt exe) throws from `&` itself, not just a
    # nonzero exit; catch it and say what happened.
    $launcher = Join-Path $current 'mStream.exe'
    if ($installedFresh -and (Test-Path $launcher)) {
        try {
            $status = (& $launcher --autostart=status 2>$null | Out-String).Trim()
            if ($status -eq 'enabled') {
                if (Test-LoginItemIsOurs $root) {
                    & $launcher --autostart=enable 2>$null | Out-Null
                    if ($LASTEXITCODE -eq 0) { Write-Host "  login item re-pointed at $ver" }
                    else { Write-Warning "could not re-point the login item - open mStream once to fix it" }
                } else {
                    # Enabled, but for a copy we don't manage (hand-extracted, a
                    # dev checkout). Its owner decides; the launcher's own logic
                    # takes over the moment they open THIS copy and toggle it.
                    Write-Warning "the login item points at $(Get-LoginItemTarget) (not managed by this script) - left as is; open the new mStream and toggle 'Start at login' to move it"
                }
            }
        } catch {
            Write-Warning "could not run the launcher to re-point the login item ($($_.Exception.Message)) - open mStream once to fix it"
        }
    }
    # Report the exec probe taken BEFORE the junction flip. Empty here means
    # a first install or same-version re-run (nothing working was displaced),
    # so it stays a diagnostic.
    if ($newServerV) { Write-Host "  mstream-server $newServerV runs" }
    else { Write-Warning "the server did not run cleanly - see $final\README.txt" }

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
        # that edits $env:PATH improves exactly one window's life. Read the
        # RAW value and write it back as REG_EXPAND_SZ: the .NET
        # GetEnvironmentVariable/SetEnvironmentVariable pair returns the
        # EXPANDED string and writes REG_SZ, which would bake every %VAR%
        # entry other tools rely on (nvm's %NVM_HOME%, %JAVA_HOME%\bin) into
        # frozen literals.
        $envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
        try {
            $rawPath = [string]$envKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            if (($rawPath -split ';') -notcontains $current) {
                $newPath = if ($rawPath) { "$rawPath;$current" } else { $current }
                $envKey.SetValue('Path', $newPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
                Write-Host "  added $current to your user PATH - new terminals will see mstream-server"
            }
        } finally { $envKey.Close() }
    }

    # An instance running from somewhere else stays on its own version until
    # it is restarted - the script never kills a user's server. Say so, with
    # the exact path, instead of letting "installed" imply "upgraded".
    $elsewhere = @($runningFrom | Where-Object { $_ -ne $final -and $_ -ne $current })
    if ($elsewhere) {
        Write-Warning ("mStream is currently running from $($elsewhere -join ', ') - it keeps running that version " +
                       "until you Quit it (tray icon) and start the new one; the Start Menu entry now points at $ver.")
    }
    $others = Get-ChildItem $root -Directory | Where-Object { $_.Name -like "mStream-*-$key" -and $_.Name -ne $bundle }
    if ($others) {
        Write-Host "  older versions kept under $root - once mStream is not running from one, it is safe to delete"
    }
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
}

Main
