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
; lzma2/fast: the server exe is ~120 MB; max squeezes a few MB more for
; minutes of every CI win-leg's time.
Compression=lzma2/fast
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

[Code]
const
  RunKey = 'Software\Microsoft\Windows\CurrentVersion\Run';

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

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  { The legacy Electron-era desktop app (mStream Express 5.x) used this very
    folder as ITS electron-builder default (Programs\mStream) — a machine
    with the old app gets a silent tree-mix unless we refuse. Chromium
    payload present without our server exe = that app lives here, not a
    prior copy of us. Returning non-empty aborts with this message (silent
    installs exit non-zero with it in the log). }
  if FileExists(ExpandConstant('{app}\chrome_100_percent.pak')) and
     not FileExists(ExpandConstant('{app}\mstream-server.exe')) then
  begin
    Result := 'This folder contains the old mStream desktop app (Electron). Uninstall it first (Settings > Apps > Installed apps), or choose a different install folder.';
    exit;
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
