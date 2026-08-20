; mStream Windows installer (Inno Setup 6) — wraps the staged win-x64 bundle
; (the exact tree the zip is cut from) into a per-user setup.exe.
;
; Compiled by build-bun.yml's win-x64 leg AFTER the bundle is staged, smoked,
; and VersionInfo-asserted:
;   ISCC.exe /DAppVersion=<x.y.z> /DAppVersion4=<x.y.z.w> /DStageDir=<abs dir> ^
;            /O<out dir> build\windows-installer.iss
;
; Design (matches the P3 install-script conventions from install.ps1 / #829):
;   - PER-USER: no UAC, installs under {localappdata}\Programs\mStream —
;     the same location install.ps1 uses, so the two methods never fork.
;   - The payload is {#StageDir}\* verbatim. Empty scaffold dirs are skipped
;     on purpose: the server self-creates missing dirs at boot (the #816
;     --portable ENOENT tests prove it), and an INSTALLED copy keeps its
;     data in the per-user data home (%LOCALAPPDATA%\mStream), not in {app}.
;   - Autostart is NOT written here: the launcher self-enables on its first
;     tray run (launcher.json marker) and the user's later toggle is
;     respected. The UNINSTALLER removes the HKCU Run value ONLY when it
;     points into {app} — the login item is one per-user registration by
;     app name, and uninstalling one copy must never disable another's
;     autostart (that footgun bit the install-script smokes once).
;   - User data (%LOCALAPPDATA%\mStream: config, db, caches) is never
;     touched by uninstall.
;   - Upgrades/uninstalls stop only processes RUNNING FROM {app} (WMI
;     ExecutablePath prefix match — never a name-wide taskkill, which would
;     kill unrelated mStream installs). Killing the launcher first lets the
;     supervision pipe take the server down with it; a second sweep catches
;     stragglers.
;   - SignPath-ready: the CI leg keeps the compile a discrete step so the
;     signing flow can later sign the bundle PEs before ISCC and the
;     setup.exe after it.

#ifndef AppVersion
  #error Pass /DAppVersion=x.y.z (the package.json version)
#endif
#ifndef AppVersion4
  #error Pass /DAppVersion4=x.y.z.w (the 4-part Windows version)
#endif
#ifndef StageDir
  #error Pass /DStageDir=<absolute path to the staged win-x64 bundle>
#endif

[Setup]
; Never change AppId: it keys upgrades and the uninstall registration.
AppId={{9C2E7C1A-63D4-4C0B-A0B4-52B6E5B0A9D3}
AppName=mStream
AppVersion={#AppVersion}
AppPublisher=Paul Sori
AppPublisherURL=https://mstream.io
AppSupportURL=https://github.com/IrosTheBeggar/mStream/issues
DefaultDirName={localappdata}\Programs\mStream
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputBaseFilename=mStream-{#AppVersion}-win-x64-setup
SetupIconFile={#SourcePath}\mstream-logo-cut.ico
UninstallDisplayIcon={app}\mStream.exe
UninstallDisplayName=mStream
LicenseFile={#SourcePath}\..\LICENSE
; lzma2/ultra64 (64 MB dictionary): measured on the real 6.20.x payload
; (~162 MB, dominated by the ~120 MB server exe), lzma2 max-class beats the
; old lzma2/fast by ~25% — 51 -> 38 MB in a same-payload 7z proxy, so the
; setup.exe drops from ~56 MB to the low-to-mid 40s. Two block threads keep
; the CI compile in check (each thread compresses an independent block:
; ~halves the wall time for a 1-2% ratio give-back, and bounds memory at
; ~1.4 GB on the 4-core runner).
Compression=lzma2/ultra64
LZMANumBlockThreads=2
SolidCompression=yes
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
; Our [Code] closes mStream processes deterministically; Restart Manager
; prompts are confusing for tray apps.
CloseApplications=no
WizardStyle=modern
; The same 4-part contract every shipped PE carries (check-win-versioninfo.ps1).
VersionInfoVersion={#AppVersion4}
VersionInfoCompany=Paul Sori
VersionInfoDescription=mStream Installer
VersionInfoCopyright=Paul Sori (GPL-3.0)
VersionInfoProductName=mStream
VersionInfoProductVersion={#AppVersion4}

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; Flags: unchecked

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{userprograms}\mStream"; Filename: "{app}\mStream.exe"
Name: "{userdesktop}\mStream"; Filename: "{app}\mStream.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\mStream.exe"; Description: "Launch mStream"; Flags: nowait postinstall skipifsilent
; The tray launcher's one-click update runs this installer /VERYSILENT with
; /MSTREAMRELAUNCH=1 after gracefully stopping mStream and exiting itself.
; skipifsilent above would leave the user trayless at the end of a silent
; update, so this param-gated twin relaunches exactly (and only) then.
Filename: "{app}\mStream.exe"; Flags: nowait; Check: WantsRelaunch

[Code]
const
  RunKey = 'Software\Microsoft\Windows\CurrentVersion\Run';

{ True only for the launcher-driven silent update (/MSTREAMRELAUNCH=1) —
  see the param-gated [Run] entry above. }
function WantsRelaunch(): Boolean;
begin
  Result := ExpandConstant('{param:MSTREAMRELAUNCH|0}') = '1';
end;

function AppPrefix(): string;
begin
  Result := Lowercase(AddBackslash(ExpandConstant('{app}')));
end;

{ Terminate mStream.exe / mstream-server.exe running FROM the install dir —
  and only from there. (No braces in these comments: Pascal brace comments
  do not nest, so a literal app-dir constant here would end the comment.)
  Launcher first: dropping its stdin pipe makes a supervised server exit on
  its own; the second pass catches anything left. }
procedure KillOneName(const name: string);
var
  locator, svc, procs, p: Variant;
  i: Integer;
  path: string;
begin
  locator := CreateOleObject('WbemScripting.SWbemLocator');
  svc := locator.ConnectServer('.', 'root\cimv2');
  procs := svc.ExecQuery(Format(
    'SELECT ProcessId, ExecutablePath FROM Win32_Process WHERE Name = ''%s''', [name]));
  for i := 0 to procs.Count - 1 do
  begin
    p := procs.ItemIndex(i);
    path := '';
    try
      { plain Variant->string assignment; a Null ExecutablePath (some
        system processes) raises here and is swallowed }
      path := p.ExecutablePath;
    except
    end;
    path := Lowercase(path);
    if (path <> '') and (Pos(AppPrefix(), path) = 1) then
    begin
      Log('terminating ' + name + ' (pid ' + IntToStr(p.ProcessId) + ') under the install dir');
      try
        p.Terminate(1);
      except
      end;
    end;
  end;
end;

procedure KillAppProcesses();
begin
  try
    KillOneName('mStream.exe');
    Sleep(1500); { supervision takes the server down with the launcher }
    KillOneName('mstream-server.exe');
    Sleep(300);
  except
    { WMI unavailable: proceed — locked files will surface as copy errors,
      which is louder than silently doing nothing. }
    Log('process sweep failed: ' + GetExceptionMessage);
  end;
end;

{ Stop EVERY process running from the given dir (the legacy Electron app's
  exe names are not ours, so the name-scoped sweep above can't reach them).
  No WQL path filter on purpose: WQL string literals treat backslash as an
  escape; enumerating and comparing in Pascal sidesteps the quoting trap. }
procedure KillAllUnder(const dir: string);
var
  locator, svc, procs, p: Variant;
  i: Integer;
  path, prefix: string;
begin
  prefix := Lowercase(AddBackslash(dir));
  try
    locator := CreateOleObject('WbemScripting.SWbemLocator');
    svc := locator.ConnectServer('.', 'root\cimv2');
    procs := svc.ExecQuery('SELECT ProcessId, ExecutablePath FROM Win32_Process WHERE ExecutablePath IS NOT NULL');
    for i := 0 to procs.Count - 1 do
    begin
      p := procs.ItemIndex(i);
      path := '';
      try
        path := p.ExecutablePath;
      except
      end;
      if (path <> '') and (Pos(prefix, Lowercase(path)) = 1) then
      begin
        Log('terminating pid ' + IntToStr(p.ProcessId) + ' (' + path + ') under the old app dir');
        try
          p.Terminate(1);
        except
        end;
      end;
    end;
  except
    Log('old-app process sweep failed: ' + GetExceptionMessage);
  end;
end;

{ "C:\path with spaces\un.exe" /args  ->  exe + params. Unquoted commands
  split at the first space. }
procedure SplitCommand(const cmd: string; var exe, params: string);
var
  rest: string;
  i: Integer;
begin
  exe := ''; params := '';
  rest := Trim(cmd);
  if rest = '' then exit;
  if rest[1] = '"' then
  begin
    rest := Copy(rest, 2, MaxInt);
    i := Pos('"', rest);
    if i = 0 then begin exe := rest; exit; end;
    exe := Copy(rest, 1, i - 1);
    params := Trim(Copy(rest, i + 1, MaxInt));
  end else begin
    i := Pos(' ', rest);
    if i = 0 then begin exe := rest; exit; end;
    exe := Copy(rest, 1, i - 1);
    params := Trim(Copy(rest, i + 1, MaxInt));
  end;
end;

{ Find the uninstall registration whose UNINSTALLER EXE lives under dir.
  The real legacy app registers with an EMPTY InstallLocation (verified
  live: HKCU\...\Uninstall\95ce77b3-..., "mStream Server 6.12.0"), so the
  quoted exe path inside Quiet/UninstallString is the only reliable link
  between a registration and the folder it owns. Prefers the quiet string;
  falls back to UninstallString + /S (NSIS silent switch). }
function FindOldAppUninstall(const dir: string; var exe, params: string): Boolean;
var
  roots: array of Integer;
  names: TArrayOfString;
  r, i: Integer;
  keyBase, cmd: string;
begin
  Result := False;
  keyBase := 'Software\Microsoft\Windows\CurrentVersion\Uninstall';
  SetArrayLength(roots, 3);
  roots[0] := HKCU; roots[1] := HKLM; roots[2] := HKLM64;
  for r := 0 to GetArrayLength(roots) - 1 do
  begin
    if (roots[r] = HKLM64) and not IsWin64 then continue;
    if not RegGetSubkeyNames(roots[r], keyBase, names) then continue;
    for i := 0 to GetArrayLength(names) - 1 do
    begin
      cmd := '';
      if not RegQueryStringValue(roots[r], keyBase + '\' + names[i], 'QuietUninstallString', cmd) then
        if RegQueryStringValue(roots[r], keyBase + '\' + names[i], 'UninstallString', cmd) then
          cmd := cmd + ' /S'
        else
          continue;
      SplitCommand(cmd, exe, params);
      if (exe <> '') and (Pos(Lowercase(AddBackslash(dir)), Lowercase(exe)) = 1) then
      begin
        Log('old-app uninstall registration: [' + names[i] + '] ' + cmd);
        Result := True;
        exit;
      end;
    end;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  wantRemove: Boolean;
  unExe, unParams: string;
  rc, i: Integer;
begin
  Result := '';
  { The legacy Electron-era desktop app (mStream Express 5.x) used this very
    folder as ITS electron-builder default (Programs\mStream) — a machine
    with the old app gets a silent tree-mix unless we intervene. Chromium
    payload present without our server exe = that app lives here, not a
    prior copy of us. Offer to run ITS OWN uninstaller and continue;
    declined or impossible = abort with instructions (silent installs exit
    non-zero with the message in the log). }
  if FileExists(ExpandConstant('{app}\chrome_100_percent.pak')) and
     not FileExists(ExpandConstant('{app}\mstream-server.exe')) then
  begin
    { /REMOVEOLDAPP=1 is the scripted opt-in; silent runs never remove
      another product without it. Interactive default is No. }
    wantRemove := ExpandConstant('{param:REMOVEOLDAPP|0}') = '1';
    if (not wantRemove) and (not WizardSilent) then
      wantRemove := MsgBox('This folder contains the old mStream desktop app (Electron).'#13#10#13#10
        + 'Setup can uninstall it now using its own uninstaller, then continue installing the new mStream. Your music files are not affected.'#13#10#13#10
        + 'Uninstall the old mStream app now?', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
    if not wantRemove then
    begin
      Result := 'This folder contains the old mStream desktop app (Electron). Uninstall it first (Settings > Apps > Installed apps), or choose a different install folder.';
      if WizardSilent then
        Result := Result + ' Silent installs can pass /REMOVEOLDAPP=1 to have Setup uninstall it automatically.';
      exit;
    end;
    { The old app must not be running while its uninstaller works. }
    KillAllUnder(ExpandConstant('{app}'));
    Sleep(1000);
    if not FindOldAppUninstall(ExpandConstant('{app}'), unExe, unParams) then
    begin
      Result := 'The old mStream desktop app is in this folder, but its uninstaller could not be found in the registry. Uninstall it manually (Settings > Apps > Installed apps), or choose a different install folder.';
      exit;
    end;
    if not Exec(unExe, unParams, '', SW_HIDE, ewWaitUntilTerminated, rc) then
    begin
      Result := 'The old mStream app''s uninstaller could not be started. Uninstall it manually (Settings > Apps > Installed apps), or choose a different install folder.';
      exit;
    end;
    { NSIS uninstallers copy themselves to TEMP and return early — the exit
      above only means "launched". The Chromium marker disappearing is the
      real completion signal; give it a minute. }
    for i := 1 to 60 do
    begin
      if not FileExists(ExpandConstant('{app}\chrome_100_percent.pak')) then break;
      Sleep(1000);
    end;
    if FileExists(ExpandConstant('{app}\chrome_100_percent.pak')) then
    begin
      Result := 'The old mStream app''s uninstaller ran but the folder still contains the old app. Uninstall it manually (Settings > Apps > Installed apps), then run Setup again.';
      exit;
    end;
    Log('old mStream desktop app removed; continuing with the install');
  end;
  { Upgrade over a running install: stop our processes so files aren't locked. }
  KillAppProcesses();
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  v: string;
begin
  if CurUninstallStep = usUninstall then
  begin
    KillAppProcesses();
    { Remove the login item ONLY if it is ours: the Run value is one
      per-user registration by app name; another copy's registration must
      survive this uninstall. }
    if RegQueryStringValue(HKCU, RunKey, 'mStream', v) then
      if Pos(AppPrefix(), Lowercase(v)) > 0 then
      begin
        Log('removing our autostart Run value: ' + v);
        RegDeleteValue(HKCU, RunKey, 'mStream');
      end;
  end;
end;
