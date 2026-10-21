#ifndef PackageRoot
  #error PackageRoot is required. Use build-setup.ps1.
#endif
#ifndef InstallerAppId
  #define InstallerAppId "CodexDotsBridgeSetup"
#endif
#ifndef InstallerVersion
  #error InstallerVersion is required.
#endif
#ifndef PackageFingerprint
  #error PackageFingerprint is required.
#endif
#ifndef SetupOutput
  #error SetupOutput is required.
#endif

[Setup]
AppId={code:GetInstallerAppId}
AppName=Codex Dots Bridge
AppVersion={#InstallerVersion}
AppPublisher=Codex Dots Bridge contributors
DefaultDirName={localappdata}\Programs\CodexDotsBridge\Setup
DefaultGroupName=Codex Dots Bridge
PrivilegesRequired=lowest
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
MinVersion=10.0
OutputDir={#SetupOutput}
OutputBaseFilename=Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
UsePreviousLanguage=no
CloseApplications=no
RestartApplications=no
UninstallDisplayIcon={app}\payload\{#InstallerVersion}\CodexDotsBridge.ico
SetupIconFile={#PackageRoot}\CodexDotsBridge.ico
UninstallDisplayName=Codex Dots Bridge
LicenseFile={#PackageRoot}\LICENSE
SetupLogging=yes

[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
Name: "autostart"; Description: "登录 Windows 时启动（升级保留既有设置）"; Flags: unchecked

[Files]
Source: "{#PackageRoot}\*"; DestDir: "{app}\payload\{#InstallerVersion}"; Flags: ignoreversion recursesubdirs createallsubdirs; Check: ShouldInstallPayload
Source: "setup-lifecycle.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "setup-lifecycle.ps1"; DestName: "setup-lifecycle-runner.ps1"; Flags: dontcopy
Source: "{#PackageRoot}\scripts\launch-background.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PackageRoot}\scripts\launch-background.ps1"; Flags: dontcopy
Source: "{#PackageRoot}\scripts\recover-reboot-locks.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PackageRoot}\scripts\recover-reboot-locks.ps1"; Flags: dontcopy
Source: "{#PackageRoot}\CodexDotsBridge.Launcher.exe"; DestName: "CodexDotsBridge.Launcher.exe"; Flags: dontcopy

[Icons]
Name: "{code:GetShortcutsDirectory}\Codex Dots Bridge"; Filename: "{app}\payload\{#InstallerVersion}\CodexDotsBridge.Tray.exe"; Parameters: "{code:GetTrayParameters}"; WorkingDir: "{app}\payload\{#InstallerVersion}"; IconFilename: "{app}\payload\{#InstallerVersion}\CodexDotsBridge.ico"
Name: "{code:GetShortcutsDirectory}\首次连接与维护"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -NoExit -ExecutionPolicy Bypass -File ""{app}\setup-lifecycle.ps1"" -Action Connect -InstallDirectory ""{app}"""; WorkingDir: "{app}"
Name: "{code:GetShortcutsDirectory}\卸载 Codex Dots Bridge"; Filename: "{uninstallexe}"

[UninstallDelete]
Type: files; Name: "{app}\installation-state.json"
Type: files; Name: "{app}\.setup-result.txt"
Type: files; Name: "{app}\.launcher-diagnostics.json"

[Code]
var
  Prepared, Committed, InstallPayload: Boolean;
  PreparedDataDirectory: String;

function IsStrictGuid(const Value: String): Boolean;
var
  I: Integer;
begin
  Result := Length(Value) = 36;
  if not Result then Exit;
  for I := 1 to 36 do begin
    if (I = 9) or (I = 14) or (I = 19) or (I = 24) then
      Result := Result and (Value[I] = '-')
    else
      Result := Result and (Pos(Lowercase(Value[I]), '0123456789abcdef') > 0);
  end;
end;

function TestIsolationValid: Boolean;
var
  Instance, Argument: String;
  I: Integer;
  Requested: Boolean;
begin
  Requested := False;
  for I := 1 to ParamCount do begin
    Argument := Lowercase(ParamStr(I));
    if Pos('/test', Argument) = 1 then begin
      Requested := True;
      if Pos('/testinstance=', Argument) <> 1 then begin
        Result := False;
        Exit;
      end;
    end;
  end;
  Instance := ExpandConstant('{param:TESTINSTANCE|}');
  Result := (not Requested) or (IsStrictGuid(Instance) and
    (ExpandConstant('{param:DIR|}') <> '') and
    (ExpandConstant('{param:DATADIR|}') <> '') and
    (ExpandConstant('{param:CODEXHOME|}') <> '') and
    (ExpandConstant('{param:APPDATADIR|}') <> ''));
end;

function GetShortcutsDirectory(Param: String): String;
begin
  if ExpandConstant('{param:TESTINSTANCE|}') <> '' then
    Result := ExpandConstant('{param:APPDATADIR|}') + '\Microsoft\Windows\Start Menu\Programs\Codex Dots Bridge'
  else
    Result := ExpandConstant('{group}');
end;

function GetInstallerAppId(Param: String): String;
var
  Instance: String;
begin
  if not TestIsolationValid then
    RaiseException('隔离验收需要合法 TESTINSTANCE GUID，并显式提供 DIR、DATADIR、CODEXHOME、APPDATADIR；未执行安装。');
  Result := '{#InstallerAppId}';
  Instance := ExpandConstant('{param:TESTINSTANCE|}');
  if Instance <> '' then Result := Result + '.Test.' + Lowercase(Instance);
end;

function InitializeSetup: Boolean;
var
  RuntimeRelease: Cardinal;
begin
  Result := TestIsolationValid;
  if not Result then SuppressibleMsgBox('隔离验收参数不完整或 TESTINSTANCE 不是标准 GUID；未执行安装。', mbError, MB_OK, IDOK);
  if Result then begin
    Result := RegQueryDWordValue(HKLM64, 'SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full', 'Release', RuntimeRelease) and (RuntimeRelease >= 528040);
    if not Result then SuppressibleMsgBox('托盘程序需要 Microsoft .NET Framework 4.8 或更高版本。请安装运行环境后重新运行安装器。', mbError, MB_OK, IDOK);
  end;
end;

function Quoted(const Value: String): String;
begin
  Result := '"' + Value + '"';
end;

function GetTrayParameters(Param: String): String;
var
  Value: String;
  I: Integer;
begin
  if PreparedDataDirectory = '' then RaiseException('prepared_data_directory_missing');
  Value := PreparedDataDirectory;
  { Windows argv quoting requires doubling trailing backslashes before the closing quote. }
  I := Length(Value);
  while (I > 0) and (Value[I] = '\') do begin
    Value := Value + '\';
    I := I - 1;
  end;
  Result := '--show --data-dir ' + Quoted(Value);
end;

function RunnerParameters(const Action: String): String;
begin
  Result := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' +
    Quoted(ExpandConstant('{tmp}\setup-lifecycle-runner.ps1')) +
    ' -Action ' + Action + ' -InstallDirectory ' + Quoted(ExpandConstant('{app}'));
end;

function RunLifecycle(const Params: String): Boolean;
var
  ExitCode: Integer;
begin
  Result := Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Params,
    '', SW_HIDE, ewWaitUntilTerminated, ExitCode) and (ExitCode = 0);
end;

function OperationError: String;
var
  Detail: AnsiString;
begin
  Result := '操作未完成，未清除数据。请保留当前目录并核对以下状态。';
  if LoadStringFromFile(ExpandConstant('{app}\.setup-result.txt'), Detail) then
    Result := Result + #13#10 + String(Detail);
end;

function ShouldInstallPayload: Boolean;
begin
  { Prepare checks an existing same-version payload in full before skipping locked files. }
  { Inno calls Check once per file. Cache the decision before copying the manifest. }
  Result := InstallPayload;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Params, Value: String;
  PreparedData: AnsiString;
begin
  Result := '';
  PreparedDataDirectory := '';
  ExtractTemporaryFile('setup-lifecycle-runner.ps1');
  ExtractTemporaryFile('launch-background.ps1');
  ExtractTemporaryFile('recover-reboot-locks.ps1');
  ExtractTemporaryFile('CodexDotsBridge.Launcher.exe');
  Params := RunnerParameters('Prepare') + ' -NewVersion ' + Quoted('{#InstallerVersion}') +
    ' -PackageFingerprint ' + Quoted('{#PackageFingerprint}') +
    ' -InstallerIdentity ' + Quoted(GetInstallerAppId('')) +
    ' -LauncherSource ' + Quoted(ExpandConstant('{tmp}\CodexDotsBridge.Launcher.exe')) +
    ' -LauncherFingerprint ' + Quoted('{#LauncherFingerprint}') +
    ' -LauncherSourceFingerprint ' + Quoted('{#LauncherSourceFingerprint}');
  Value := ExpandConstant('{param:DATADIR|}');
  if Value <> '' then Params := Params + ' -DataDir ' + Quoted(Value);
  Value := ExpandConstant('{param:CODEXHOME|}');
  if Value <> '' then Params := Params + ' -CodexHome ' + Quoted(Value);
  Value := ExpandConstant('{param:CODEXCOMMAND|}');
  if Value <> '' then Params := Params + ' -CodexCommand ' + Quoted(Value);
  Value := ExpandConstant('{param:APPDATADIR|}');
  if Value <> '' then Params := Params + ' -AppDataDirectory ' + Quoted(Value);
  Params := Params + ' -ShortcutDirectory ' + Quoted(GetShortcutsDirectory(''));
  if WizardIsTaskSelected('autostart') then Params := Params + ' -Autostart';
  Prepared := RunLifecycle(Params);
  if Prepared then begin
    if not LoadStringFromFile(ExpandConstant('{app}\.setup-result.txt'), PreparedData) then begin
      Result := 'prepared_data_directory_missing';
      Exit;
    end;
    PreparedDataDirectory := UTF8Decode(PreparedData);
    if PreparedDataDirectory = '' then begin
      Result := 'prepared_data_directory_missing';
      Exit;
    end;
    InstallPayload := not FileExists(ExpandConstant('{app}\payload\{#InstallerVersion}\release-manifest.json'));
  end;
  if not Prepared then Result := OperationError;
end;

function GetCustomSetupExitCode: Integer;
begin
  { Post-install script exceptions alone can leave Inno's normal exit code at zero. }
  Result := 0;
  if Prepared and not Committed then Result := 20;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then begin
    Committed := RunLifecycle(RunnerParameters('Commit'));
    if not Committed then RaiseException(OperationError);
    WizardForm.FinishedLabel.Caption := '本机组件已安装。首次账号连接仍需通过官方页面完成；可从开始菜单打开“首次连接与维护”。配置、任务与访问设置由原数据目录保留。实际工具加载和 Dot 任务结果仍需验收。';
  end;
end;

procedure DeinitializeSetup;
begin
  if Prepared and not Committed then RunLifecycle(RunnerParameters('Rollback'));
end;

function InitializeUninstall: Boolean;
var
  Params: String;
begin
  { Initialization precedes the confirmation dialog: it must remain read-only. }
  Params := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' +
    Quoted(ExpandConstant('{app}\setup-lifecycle.ps1')) +
    ' -Action PreflightUninstall -InstallDirectory ' + Quoted(ExpandConstant('{app}'));
  Result := RunLifecycle(Params);
  if not Result then SuppressibleMsgBox(OperationError, mbError, MB_OK, IDOK);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Params: String;
begin
  if CurUninstallStep = usUninstall then begin
    { Inno reaches this event after confirmation but before removing any logged files. }
    Params := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' +
      Quoted(ExpandConstant('{app}\setup-lifecycle.ps1')) +
      ' -Action Uninstall -InstallDirectory ' + Quoted(ExpandConstant('{app}'));
    if not RunLifecycle(Params) then RaiseException(OperationError);
  end;
end;
