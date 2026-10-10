[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$SetupExecutable,
  [string]$UpgradeSetupExecutable,
  [string]$LegacyPackageRoot,
  [Parameter(Mandatory=$true)][string]$InstallerAppId,
  [Parameter(Mandatory=$true)][string]$CodexCommand,
  [Parameter(Mandatory=$true)][string]$TestDirectory
)
$ErrorActionPreference='Stop'
if($InstallerAppId -notmatch '^CodexDotsBridgeSetup\.Test\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$') { throw 'Real installer tests require a distinct strict-GUID test AppId.' }
$testInstance=$Matches[1]
$buildReceipt=Get-Content -LiteralPath (Join-Path (Split-Path -Parent ([IO.Path]::GetFullPath($SetupExecutable))) 'setup-build.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if((Get-FileHash -LiteralPath $SetupExecutable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $buildReceipt.setup_sha256) { throw 'Installer differs from its build receipt.' }
$fromVersion=$null
$upgradeReceipt=$null
if($UpgradeSetupExecutable) {
  $upgradeReceipt=Get-Content -LiteralPath (Join-Path (Split-Path -Parent ([IO.Path]::GetFullPath($UpgradeSetupExecutable))) 'setup-build.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if((Get-FileHash -LiteralPath $UpgradeSetupExecutable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $upgradeReceipt.setup_sha256 -or $upgradeReceipt.version -eq $buildReceipt.version) { throw 'Cross-version upgrade requires a different verified installer version.' }
  $fromVersion=$buildReceipt.version
}
$testParent=[IO.Path]::GetFullPath($TestDirectory).TrimEnd('\')
$work=Join-Path $testParent ('验收 O''Brien $literal '+[Guid]::NewGuid().ToString('N').Substring(0,8))
$app=Join-Path $work '程序 安装'; $data=Join-Path $work '数据'; $CodexDirectory=Join-Path $work 'Codex home'; $startup=Join-Path $work '用户 AppData'
$registryRoot='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
$registryPath=$null
New-Item -ItemType Directory -Path $work -Force | Out-Null
$priorAppData=$env:APPDATA; $env:APPDATA=$startup
$checks=[Collections.Generic.List[string]]::new()
$installed=$false
$productionKey='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexDotsBridgeSetup_is1'
$productionKeyBefore=if(Test-Path -LiteralPath $productionKey){Get-ItemProperty -LiteralPath $productionKey | ConvertTo-Json -Depth 10 -Compress}else{'absent'}
function Assert-Condition([bool]$Condition,[string]$Message) { if(-not $Condition) { throw $Message } }
function Run-Executable([string]$Path,[string[]]$Arguments,[bool]$Success=$true) {
  $info=New-Object Diagnostics.ProcessStartInfo
  $info.FileName=[IO.Path]::GetFullPath($Path); $info.UseShellExecute=$false; $info.CreateNoWindow=$true
  # Filesystem paths cannot contain double quotes. Each argument reaches Inno directly, without a shell.
  $info.Arguments=($Arguments | ForEach-Object { '"'+$_.Replace('"','\"')+'"' }) -join ' '
  $process=[Diagnostics.Process]::Start($info)
  try {
    if(-not $process.WaitForExit(180000)) { throw 'Installer test timed out; retaining test workspace for diagnosis.' }
    if($Success) { Assert-Condition ($process.ExitCode -eq 0) ('Expected installer success, exit='+$process.ExitCode) }
    else { Assert-Condition ($process.ExitCode -ne 0) 'Expected ownership blocker to reject installation.' }
    $script:lastInstallerExitCode=$process.ExitCode
  } finally { $process.Dispose() }
}
function Read-State { Get-Content -LiteralPath (Join-Path $app 'installation-state.json') -Raw -Encoding UTF8 | ConvertFrom-Json }
function Find-TestUninstallKey([switch]$RequireState) {
  # Inno 7 truncates long AppId key names and appends a hash; discover our exact installation.
  $matches=@(foreach($key in Get-ChildItem -LiteralPath $registryRoot -ErrorAction SilentlyContinue) {
    $entry=Get-ItemProperty -LiteralPath $key.PSPath
    if(-not $entry.InstallLocation) { continue }
    try { $location=[IO.Path]::GetFullPath($entry.InstallLocation).TrimEnd('\') } catch { continue }
    if($location -ine $app.TrimEnd('\')) { continue }
    Assert-Condition ($entry.DisplayName -ceq 'Codex Dots Bridge' -and $entry.DisplayVersion -ceq $buildReceipt.version) 'Unexpected application identity at the isolated installation path.'
    $key.PSPath
  })
  Assert-Condition ($matches.Count -le 1) 'Multiple uninstall keys match the isolated installation path.'
  if($matches.Count -eq 1) {
    if($RequireState) {
      $registeredState=Read-State
      Assert-Condition ($registeredState.installer_app_id -ceq $InstallerAppId -and $registeredState.install_directory -ieq $app -and $registeredState.version -ceq $buildReceipt.version) 'Isolated registry entry does not match this test AppId and state.'
    }
    return $matches[0]
  }
  return $null
}
function Bridge([string[]]$BridgeArguments) {
  $state=Read-State
  $installedManifestHash=(Get-FileHash -LiteralPath (Join-Path $state.payload_root 'release-manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()
  Assert-Condition ($installedManifestHash -eq $buildReceipt.package_manifest_sha256 -and $state.package_fingerprint -eq $installedManifestHash) 'Installed payload differs from the package compiled into this installer.'
  $node=Join-Path $state.payload_root 'runtime\node-v24.21.0-win-x64\node.exe'
  $output=@(& $node (Join-Path $state.payload_root 'dist\main.js') @BridgeArguments)
  if($LASTEXITCODE -ne 0) {
    $code='bridge_operation_failed'
    try { $reported=($output -join "`n") | ConvertFrom-Json; if($reported.error -match '^[a-z][a-z0-9_]*$') { $code=$reported.error } } catch { }
    $operation=$BridgeArguments[0]
    if($operation -notmatch '^[a-z][a-z0-9_]*$') { $operation='unknown' }
    if($operation -eq 'run' -and $BridgeArguments -contains '--stop') { $operation='run_stop' }
    throw ('Isolated bridge operation failed: '+$operation+' ('+$code+').')
  }
  ($output -join "`n") | ConvertFrom-Json
}
function Installer-Arguments {
  @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/TASKS=autostart',('/TESTINSTANCE='+$testInstance),('/DIR='+$app),('/DATADIR='+$data),('/CODEXHOME='+$CodexDirectory),('/CODEXCOMMAND='+$CodexCommand),('/APPDATADIR='+$startup))
}
try {
  Assert-Condition (-not (Find-TestUninstallKey)) 'Test uninstall key already exists; refusing to replace it.'
  $validArguments=Installer-Arguments
  foreach($parameter in @('DIR','DATADIR','CODEXHOME','APPDATADIR')) {
    $incomplete=@($validArguments | Where-Object {$_ -notlike ('/'+$parameter+'=*')})
    Run-Executable $SetupExecutable $incomplete $false
    Assert-Condition (-not (Find-TestUninstallKey)) 'Incomplete isolation created an uninstall key.'
  }
  foreach($bad in @('/TESTINSTANCE=not-a-guid','/TESTINSTANCE=',('/TESTINSTNCE='+$testInstance))) {
    $invalid=@($validArguments | Where-Object {$_ -notlike '/TESTINSTANCE=*'}) + @($bad)
    Run-Executable $SetupExecutable $invalid $false
    Assert-Condition (-not (Find-TestUninstallKey)) 'Invalid isolation created an uninstall key.'
  }
  Assert-Condition (-not (Test-Path -LiteralPath $app)) 'Invalid test parameters created program files.'
  $checks.Add('same_executable_rejects_missing_invalid_empty_or_misspelled_test_isolation')
  New-Item -ItemType Directory -Path $app -Force | Out-Null
  $missingCliArgs=@(Installer-Arguments | Where-Object {$_ -notlike '/CODEXCOMMAND=*'}) + @('/CODEXCOMMAND='+(Join-Path $work 'missing.exe'))
  Run-Executable $SetupExecutable $missingCliArgs $false
  Assert-Condition (@(Get-ChildItem -LiteralPath $app -Force).Count -eq 0) 'Missing prerequisite left unowned installer diagnostics that block retry.'
  Assert-Condition (-not (Find-TestUninstallKey)) 'Failed prerequisite registered an uninstall key.'
  $checks.Add('prepare_failure_preserves_empty_directory_for_retry')
  $legacyIdentity=$null
  if($LegacyPackageRoot) {
    $LegacyPackageRoot=[IO.Path]::GetFullPath($LegacyPackageRoot)
    $fromVersion=(Get-Content -LiteralPath (Join-Path $LegacyPackageRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
    if($fromVersion -eq $buildReceipt.version) { throw 'Legacy upgrade must use an actual different version.' }
    $legacyNode=Join-Path $LegacyPackageRoot 'runtime\node-v24.21.0-win-x64\node.exe'
    $legacyMain=Join-Path $LegacyPackageRoot 'dist\main.js'
    New-Item -ItemType Directory -Path $CodexDirectory -Force | Out-Null
    foreach($legacyArgs in @(
      @('setup','--data-dir',$data,'--codex-home',$CodexDirectory,'--codex-command',$CodexCommand,'--autostart'),
      @('run','--data-dir',$data),
      @('run','--stop','--data-dir',$data),
      @('setup','--data-dir',$data,'--codex-home',$CodexDirectory,'--codex-command',$CodexCommand,'--desktop-access','read')
    )) {
      & $legacyNode $legacyMain @legacyArgs | Out-Null
      Assert-Condition ($LASTEXITCODE -eq 0) 'Legacy isolated setup/start/stop failed.'
    }
    $legacyIdentity=Get-Content -LiteralPath (Join-Path $data 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $legacyCaller=[IO.File]::ReadAllText((Join-Path $data 'caller.key'))
    $legacyWorker=[IO.File]::ReadAllText((Join-Path $data 'worker.key'))
    $legacyDesktop=[IO.File]::ReadAllText((Join-Path $data 'desktop-conversations.json'))
    Push-Location $LegacyPackageRoot
    try {
      & $legacyNode --input-type=module -e "import Database from 'better-sqlite3';const db=new Database(process.argv[1]);db.exec('CREATE TABLE legacy_preserved(value TEXT)');db.prepare('INSERT INTO legacy_preserved VALUES (?)').run('actual old payload');db.close();" (Join-Path $data 'tasks.sqlite')
      Assert-Condition ($LASTEXITCODE -eq 0) 'Legacy SQLite seed failed.'
    } finally { Pop-Location }
  }
  Run-Executable $SetupExecutable (Installer-Arguments)
  $installed=$true
  $state=Read-State
  # Inno evaluates file Check callbacks repeatedly: copying the manifest must not skip later directories.
  & (Join-Path $state.payload_root 'scripts\check-package.ps1') -PackageRoot $state.payload_root | Out-Null
  $checks.Add('complete_installed_payload_after_manifest_copy')
  Assert-Condition ($state.data_dir -eq $data -and $state.codex_home -eq $CodexDirectory -and $state.app_data -eq $startup) 'Isolation parameters did not survive installation.'
  $registryPath=Find-TestUninstallKey -RequireState
  Assert-Condition ([bool]$registryPath) 'Inno test uninstall registration missing.'
  Assert-Condition ($state.connection -eq 'pending_official_account_setup') 'Fresh installation must keep account connection pending.'
  $configPath=Join-Path $data 'config.json'; $config=Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $instance=$config.instance_id; $caller=[IO.File]::ReadAllText((Join-Path $data 'caller.key')); $worker=[IO.File]::ReadAllText((Join-Path $data 'worker.key'))
  if($legacyIdentity) {
    Assert-Condition ($instance -eq $legacyIdentity.instance_id -and $caller -ceq $legacyCaller -and $worker -ceq $legacyWorker) 'Legacy upgrade changed identity or credentials.'
    Assert-Condition ([IO.File]::ReadAllText((Join-Path $data 'desktop-conversations.json')) -ceq $legacyDesktop) 'Legacy upgrade changed access settings.'
    $newNode=Join-Path $state.payload_root 'runtime\node-v24.21.0-win-x64\node.exe'
    Push-Location $state.payload_root
    try {
      $legacyValue=& $newNode --input-type=module -e "import Database from 'better-sqlite3';const db=new Database(process.argv[1],{readonly:true});console.log(db.prepare('SELECT value FROM legacy_preserved').get().value);db.close();" (Join-Path $data 'tasks.sqlite')
      Assert-Condition ($LASTEXITCODE -eq 0 -and $legacyValue -eq 'actual old payload') 'Legacy upgrade changed SQLite contents.'
    } finally { Pop-Location }
    $checks.Add('actual_legacy_payload_upgrade_preserves_identity_keys_database_and_access_settings')
  }
  $checks.Add('real_setup_per_user_isolated_paths_and_pending_connection')
  # Start the real compiled local control service in this isolated data-dir, without any Tunnel configuration.
  Bridge @('run','--data-dir',$data) | Out-Null
  $runningConfig=[IO.File]::ReadAllText((Join-Path $data 'config.json'))
  $runningManifest=[IO.File]::ReadAllText((Join-Path $data 'installation.json'))
  $runningToml=[IO.File]::ReadAllText((Join-Path $CodexDirectory 'config.toml'))
  foreach($readOnlyAction in @('Connect','PreflightUninstall')) {
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $app 'setup-lifecycle.ps1') -Action $readOnlyAction -InstallDirectory $app | Out-Null
    Assert-Condition ($LASTEXITCODE -eq 0) ('Running instance read-only entry failed: '+$readOnlyAction)
    Assert-Condition ([IO.File]::ReadAllText((Join-Path $data 'config.json')) -ceq $runningConfig -and [IO.File]::ReadAllText((Join-Path $data 'installation.json')) -ceq $runningManifest -and [IO.File]::ReadAllText((Join-Path $CodexDirectory 'config.toml')) -ceq $runningToml) 'Read-only maintenance or uninstall initialization changed owned configuration.'
    $runningStatus=Bridge @('status','--data-dir',$data)
    Assert-Condition ($runningStatus.supervisor -eq 'running' -and $runningStatus.service -eq 'running') 'Read-only maintenance or uninstall initialization stopped the running instance.'
  }
  $checks.Add('running_owned_maintenance_and_uninstall_preflight_remain_read_only')
  Bridge @('run','--stop','--data-dir',$data) | Out-Null
  Bridge @('setup','--data-dir',$data,'--codex-home',$CodexDirectory,'--codex-command',$CodexCommand,'--desktop-access','read') | Out-Null
  $desktopPath=Join-Path $data 'desktop-conversations.json'; $desktop=[IO.File]::ReadAllText($desktopPath)
  $node=Join-Path $state.payload_root 'runtime\node-v24.21.0-win-x64\node.exe'
  $seed=@'
import Database from 'better-sqlite3';const db=new Database(process.argv[1]);db.exec(`CREATE TABLE setup_preservation(value TEXT); INSERT INTO setup_preservation VALUES ('synthetic retained value');`);db.close();
'@
  Push-Location $state.payload_root
  try { & $node --input-type=module -e $seed (Join-Path $data 'tasks.sqlite'); Assert-Condition ($LASTEXITCODE -eq 0) 'Synthetic database fixture failed.' } finally { Pop-Location }
  $configToml=Join-Path $CodexDirectory 'config.toml'
  Add-Content -LiteralPath $configToml -Encoding UTF8 -Value "`n[mcp_servers.synthetic_unrelated]`ncommand = 'preserve-command'`nargs = ['literal space']"
  Run-Executable $SetupExecutable (Installer-Arguments)
  $checks.Add('same_version_reinstall_and_owned_startup')
  # A native test-only CLI forwards exact argv to the real CLI, failing just the first add.
  # This reaches Commit after the old owned registration is removed; rollback's add succeeds.
  $failureCli=Join-Path $work 'one-add-failure.exe'
  $failureMarker=Join-Path $work 'one-add-failure.marker'
  $fixtureSource=@'
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;
public static class OneAddFailure {
  static string Quote(string value) {
    var result=new StringBuilder("\""); int slashes=0;
    foreach(char c in value) {
      if(c=='\\') { slashes++; continue; }
      if(c=='"') { result.Append('\\',slashes*2+1); result.Append(c); }
      else { result.Append('\\',slashes); result.Append(c); }
      slashes=0;
    }
    result.Append('\\',slashes*2); result.Append('"'); return result.ToString();
  }
  public static int Main(string[] args) {
    const string command=__COMMAND__; const string marker=__MARKER__;
    if(args.Length>=2 && args[0]=="mcp" && args[1]=="add" && !File.Exists(marker)) {
      File.WriteAllText(marker,"synthetic one-time CLI failure"); return 23;
    }
    var encoded=new string[args.Length]; for(int i=0;i<args.Length;i++) encoded[i]=Quote(args[i]);
    var start=new ProcessStartInfo(command,String.Join(" ",encoded));
    start.UseShellExecute=false; start.CreateNoWindow=true;
    start.RedirectStandardOutput=true; start.RedirectStandardError=true;
    using(var child=Process.Start(start)) {
      // Codex's JSON must reach the outer execFileSync pipe without decoding or re-encoding.
      // Drain both streams concurrently so neither pipe can block the native child.
      var stdout=child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
      var stderr=child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
      child.WaitForExit(); Task.WaitAll(stdout,stderr); return child.ExitCode;
    }
  }
}
'@
  $fixtureSource=$fixtureSource.Replace('__COMMAND__',('"'+$CodexCommand.Replace('\','\\').Replace('"','\"')+'"')).Replace('__MARKER__',('"'+$failureMarker.Replace('\','\\').Replace('"','\"')+'"'))
  $fixtureFile=Join-Path $work 'one-add-failure.cs'
  [IO.File]::WriteAllText($fixtureFile,$fixtureSource,[Text.UTF8Encoding]::new($false))
  $fixtureCompiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  & $fixtureCompiler /nologo /codepage:65001 ('/out:'+$failureCli) $fixtureFile | Out-Null
  Assert-Condition ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $failureCli)) 'Native one-time CLI failure fixture did not compile.'
  $installationPath=Join-Path $data 'installation.json'
  $originalInstallation=[IO.File]::ReadAllText($installationPath)
  $identityState=[IO.File]::ReadAllText((Join-Path $app 'installation-state.json'))
  $identityConfig=[IO.File]::ReadAllText($configPath)
  try {
    $tamperedInstallation=$originalInstallation | ConvertFrom-Json
    $tamperedInstallation.codex_command=$failureCli
    $tamperedText=$tamperedInstallation | ConvertTo-Json -Depth 30
    [IO.File]::WriteAllText($installationPath,$tamperedText,[Text.UTF8Encoding]::new($false))
    Run-Executable $SetupExecutable (Installer-Arguments) $false
    Assert-Condition ($lastInstallerExitCode -ne 0) 'Installer accepted a manifest CLI inconsistent with its prior state.'
    Assert-Condition ([IO.File]::ReadAllText($installationPath) -ceq $tamperedText -and [IO.File]::ReadAllText((Join-Path $app 'installation-state.json')) -ceq $identityState -and [IO.File]::ReadAllText($configPath) -ceq $identityConfig -and -not (Test-Path -LiteralPath $failureMarker)) 'Identity rejection changed registration/state/config or invoked the untrusted replacement.'
  } finally { [IO.File]::WriteAllText($installationPath,$originalInstallation,[Text.UTF8Encoding]::new($false)) }
  $checks.Add('prior_state_manifest_cli_identity_mismatch_rejected_before_changes')
  $rollbackState=[IO.File]::ReadAllText((Join-Path $app 'installation-state.json'))
  $rollbackConfig=[IO.File]::ReadAllText($configPath)
  $rollbackSkill=[IO.File]::ReadAllBytes((Join-Path $CodexDirectory 'skills\codex-dots-bridge\SKILL.md'))
  $startupFile=Join-Path $startup 'Microsoft\Windows\Start Menu\Programs\Startup\CodexDotsBridge.vbs'
  $rollbackStartup=[IO.File]::ReadAllText($startupFile)
  $failureArgs=@(Installer-Arguments | Where-Object {$_ -notlike '/CODEXCOMMAND=*'}) + @('/CODEXCOMMAND='+$failureCli)
  Run-Executable $SetupExecutable $failureArgs $false
  Assert-Condition ($lastInstallerExitCode -eq 20 -and (Test-Path -LiteralPath $failureMarker)) 'Commit failure did not propagate its custom nonzero exit code.'
  Assert-Condition ([IO.File]::ReadAllText((Join-Path $app 'installation-state.json')) -ceq $rollbackState) 'Rollback changed prior installer state.'
  Assert-Condition ([IO.File]::ReadAllText($configPath) -ceq $rollbackConfig) 'Rollback did not restore original configuration bytes.'
  Assert-Condition ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $CodexDirectory 'skills\codex-dots-bridge\SKILL.md'))) -ceq [Convert]::ToBase64String($rollbackSkill)) 'Rollback did not restore the owned Skill.'
  Assert-Condition ([IO.File]::ReadAllText($startupFile) -ceq $rollbackStartup) 'Rollback did not restore owned startup.'
  Assert-Condition (-not (Test-Path -LiteralPath (Join-Path $app '.setup-transaction.json'))) 'Rollback retained an unresolved transaction.'
  $rollbackManifest=Get-Content -LiteralPath (Join-Path $data 'installation.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $rollbackStateData=Read-State
  Assert-Condition ($rollbackManifest.codex_command -ceq $CodexCommand -and $rollbackManifest.codex_command -ceq $rollbackStateData.codex_command) 'Rollback changed the original owned CLI identity or left it inconsistent with installer state.'
  $priorCodexDirectory=$env:CODEX_HOME
  try {
    $env:CODEX_HOME=$CodexDirectory
    $restoredEntries=(& $CodexCommand mcp list --json) -join "`n" | ConvertFrom-Json
    Assert-Condition ($LASTEXITCODE -eq 0) 'Real CLI could not inspect restored MCP registration.'
  } finally { if($null -eq $priorCodexDirectory){Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue}else{$env:CODEX_HOME=$priorCodexDirectory} }
  $restoredEntry=@($restoredEntries | Where-Object {$_.name -eq 'codex-dots-bridge'})
  Assert-Condition ($restoredEntry.Count -eq 1 -and $restoredEntry[0].transport.command -ceq $rollbackManifest.mcp.command -and ($restoredEntry[0].transport.args | ConvertTo-Json -Compress) -ceq ($rollbackManifest.mcp.args | ConvertTo-Json -Compress)) 'Rollback did not restore the exact owned MCP registration.'
  # The real CLI and unchanged state must still support normal setup after the synthetic failure.
  Bridge @('setup','--data-dir',$data,'--codex-home',$CodexDirectory,'--codex-command',$CodexCommand,'--autostart') | Out-Null
  Assert-Condition ([IO.File]::ReadAllText($configToml).Contains('preserve-command')) 'Rollback changed unrelated MCP.'
  $checks.Add('real_commit_failure_exit20_and_owned_registration_rollback')
  # Promote our now-successful forwarder to the owned CLI, then remove only that test
  # executable. A separately compiled replacement fails once during Commit and must
  # be used for recovery without leaving installer state and owned manifest divergent.
  Run-Executable $SetupExecutable $failureArgs
  $fallbackStateText=[IO.File]::ReadAllText((Join-Path $app 'installation-state.json'))
  $fallbackState=$fallbackStateText | ConvertFrom-Json
  $fallbackConfig=[IO.File]::ReadAllText($configPath)
  $fallbackCli=Join-Path $work 'replacement-one-add-failure.exe'
  $fallbackMarker=Join-Path $work 'replacement-one-add-failure.marker'
  $fallbackSource=$fixtureSource.Replace($failureMarker.Replace('\','\\').Replace('"','\"'),$fallbackMarker.Replace('\','\\').Replace('"','\"'))
  $fallbackFile=Join-Path $work 'replacement-one-add-failure.cs'
  [IO.File]::WriteAllText($fallbackFile,$fallbackSource,[Text.UTF8Encoding]::new($false))
  & $fixtureCompiler /nologo /codepage:65001 ('/out:'+$fallbackCli) $fallbackFile | Out-Null
  Assert-Condition ($LASTEXITCODE -eq 0) 'Fallback CLI fixture did not compile.'
  $removedOwnedCli=$failureCli+'.removed'
  Move-Item -LiteralPath $failureCli -Destination $removedOwnedCli
  try {
    $fallbackArgs=@(Installer-Arguments | Where-Object {$_ -notlike '/CODEXCOMMAND=*'}) + @('/CODEXCOMMAND='+$fallbackCli)
    Run-Executable $SetupExecutable $fallbackArgs $false
    Assert-Condition ($lastInstallerExitCode -eq 20 -and (Test-Path -LiteralPath $fallbackMarker)) 'Removed-owned-CLI recovery did not reach the injected Commit failure.'
    $recoveredState=Read-State
    $recoveredManifest=Get-Content -LiteralPath $installationPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-Condition ($recoveredState.codex_command -ceq $fallbackCli -and $recoveredManifest.codex_command -ceq $fallbackCli) 'Fallback left prior state and restored manifest CLI identities inconsistent.'
    foreach($property in $fallbackState.PSObject.Properties) {
      if($property.Name -ne 'codex_command') { Assert-Condition (($property.Value | ConvertTo-Json -Depth 30 -Compress) -ceq ($recoveredState.($property.Name) | ConvertTo-Json -Depth 30 -Compress)) ('Fallback changed installer state field: '+$property.Name) }
    }
    Assert-Condition ([IO.File]::ReadAllText($configPath) -ceq $fallbackConfig -and [IO.File]::ReadAllText($startupFile) -ceq $rollbackStartup -and [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $CodexDirectory 'skills\codex-dots-bridge\SKILL.md'))) -ceq [Convert]::ToBase64String($rollbackSkill)) 'Fallback changed preserved configuration, Skill or startup.'
    Assert-Condition (-not (Test-Path -LiteralPath (Join-Path $app '.setup-transaction.json'))) 'Fallback retained an unresolved transaction.'
    Run-Executable $SetupExecutable (Installer-Arguments)
    $followingState=Read-State
    $followingManifest=Get-Content -LiteralPath $installationPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-Condition ($followingState.codex_command -ceq $CodexCommand -and $followingManifest.codex_command -ceq $CodexCommand) 'Normal subsequent Prepare/setup did not accept the recovered CLI identity.'
  } finally { Move-Item -LiteralPath $removedOwnedCli -Destination $failureCli }
  $checks.Add('real_removed_owned_cli_fallback_state_manifest_consistency_and_subsequent_setup')
  $skillPath=Join-Path $CodexDirectory 'skills\codex-dots-bridge\SKILL.md'; $skill=[IO.File]::ReadAllBytes($skillPath)
  [IO.File]::WriteAllText($skillPath,'user modified',[Text.UTF8Encoding]::new($false))
  $beforeState=[IO.File]::ReadAllText((Join-Path $app 'installation-state.json'))
  $beforeToml=[IO.File]::ReadAllText($configToml)
  $next=if($UpgradeSetupExecutable){$UpgradeSetupExecutable}else{$SetupExecutable}
  Run-Executable $next (Installer-Arguments) $false
  Assert-Condition ([IO.File]::ReadAllText((Join-Path $app 'installation-state.json')) -ceq $beforeState) 'Blocked upgrade changed installer state.'
  Assert-Condition ([IO.File]::ReadAllText($configToml) -ceq $beforeToml) 'Blocked upgrade changed MCP configuration.'
  Assert-Condition (Test-Path -LiteralPath (Join-Path $state.payload_root 'dist\main.js')) 'Blocked upgrade deleted old program.'
  $uninstaller=(Get-ChildItem -LiteralPath $app -Filter 'unins*.exe' -File | Select-Object -First 1).FullName
  Run-Executable $uninstaller @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART') $false
  Assert-Condition ((Find-TestUninstallKey -RequireState) -ceq $registryPath) 'Blocked uninstall removed or changed Inno registry entry.'
  Assert-Condition ([IO.File]::ReadAllText($configToml) -ceq $beforeToml) 'Blocked uninstall removed owned MCP before checking changed Skill.'
  [IO.File]::WriteAllBytes($skillPath,$skill)
  $checks.Add('modified_skill_blocks_upgrade_and_uninstall_before_removal')
  if($UpgradeSetupExecutable) { Run-Executable $UpgradeSetupExecutable (Installer-Arguments); $buildReceipt=$upgradeReceipt; $registryPath=Find-TestUninstallKey -RequireState; Assert-Condition ([bool]$registryPath) 'Upgraded Inno registration missing.'; $checks.Add('real_cross_version_upgrade') }
  $after=Read-State
  $config=Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert-Condition ($config.instance_id -eq $instance) 'Instance identity changed.'
  Assert-Condition ([IO.File]::ReadAllText((Join-Path $data 'caller.key')) -ceq $caller) 'Caller key changed.'
  Assert-Condition ([IO.File]::ReadAllText((Join-Path $data 'worker.key')) -ceq $worker) 'Worker key changed.'
  Assert-Condition ([IO.File]::ReadAllText($desktopPath) -ceq $desktop) 'Desktop access configuration changed.'
  Assert-Condition ([IO.File]::ReadAllText($configToml).Contains('preserve-command')) 'Unrelated MCP changed.'
  $startupFile=Join-Path $startup 'Microsoft\Windows\Start Menu\Programs\Startup\CodexDotsBridge.vbs'
  Assert-Condition ([IO.File]::ReadAllText($startupFile).Contains($after.payload_root)) 'Startup points to old payload.'
  $node=Join-Path $after.payload_root 'runtime\node-v24.21.0-win-x64\node.exe'
  Push-Location $after.payload_root
  try {
    $value=& $node --input-type=module -e "import Database from 'better-sqlite3';const db=new Database(process.argv[1],{readonly:true});console.log(db.prepare('SELECT value FROM setup_preservation').get().value);db.close();" (Join-Path $data 'tasks.sqlite')
    Assert-Condition ($LASTEXITCODE -eq 0 -and $value -eq 'synthetic retained value') 'SQLite content was not preserved.'
  } finally { Pop-Location }
  $checks.Add('identity_credentials_database_desktop_settings_and_unrelated_mcp_preserved')
  $uninstaller=(Get-ChildItem -LiteralPath $app -Filter 'unins*.exe' -File | Select-Object -First 1).FullName
  Run-Executable $uninstaller @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART')
  $installed=$false
  Assert-Condition (-not (Test-Path -LiteralPath $registryPath) -and -not (Find-TestUninstallKey)) 'Test uninstall entry retained.'
  Assert-Condition (-not (Test-Path -LiteralPath (Join-Path $after.payload_root 'dist\main.js'))) 'Uninstall retained owned program files.'
  Assert-Condition (-not (Test-Path -LiteralPath $startupFile)) 'Owned startup retained.'
  Assert-Condition (-not (Test-Path -LiteralPath (Join-Path $CodexDirectory 'skills\codex-dots-bridge'))) 'Owned Skill retained.'
  Assert-Condition ([IO.File]::ReadAllText($configToml).Contains('preserve-command') -and -not [IO.File]::ReadAllText($configToml).Contains('[mcp_servers.codex-dots-bridge]')) 'Uninstall changed unrelated MCP or kept owned MCP.'
  Assert-Condition (Test-Path -LiteralPath (Join-Path $data 'tasks.sqlite')) 'Uninstall deleted SQLite data.'
  Assert-Condition ([IO.File]::ReadAllText($desktopPath) -ceq $desktop) 'Uninstall changed desktop settings.'
  Assert-Condition ([IO.File]::ReadAllText((Join-Path $data 'caller.key')) -ceq $caller) 'Uninstall changed credentials.'
  $productionKeyAfter=if(Test-Path -LiteralPath $productionKey){Get-ItemProperty -LiteralPath $productionKey | ConvertTo-Json -Depth 10 -Compress}else{'absent'}
  Assert-Condition ($productionKeyBefore -ceq $productionKeyAfter) 'Production Inno uninstall key changed.'
  $checks.Add('real_uninstall_owned_entries_program_registration_and_data_retention')
  $acceptance=[ordered]@{mode='real';setupSha256=$buildReceipt.setup_sha256;fromVersion=$fromVersion;toVersion=$buildReceipt.version;installed=$true;upgraded=[bool]($LegacyPackageRoot -or $UpgradeSetupExecutable);uninstalled=$true;uninstallPreservedData=$true;checks=@($checks);production_registry='not_touched';tunnel_cloud_acceptance='not_tested';cancel_confirmation_ui='not_tested'}
  $acceptancePath=Join-Path $work 'acceptance-result.json'
  [IO.File]::WriteAllText($acceptancePath,($acceptance | ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
  $proof=[ordered]@{status='passed';mode='real';setupSha256=$buildReceipt.setup_sha256;fromVersion=$fromVersion;toVersion=$buildReceipt.version;installed=$true;upgraded=$acceptance.upgraded;uninstalled=$true;uninstallPreservedData=$true;evidence=@{path=$acceptancePath;sha256=(Get-FileHash -LiteralPath $acceptancePath -Algorithm SHA256).Hash.ToLowerInvariant()}}
  [pscustomobject]@{mode='real';setupSha256=$buildReceipt.setup_sha256;passed=$checks;test_directory=$work;installUpgradeUninstall=$proof;production_registry='not_touched';tunnel_cloud_acceptance='not_tested';cancel_confirmation_ui='not_tested'} | ConvertTo-Json -Depth 6
} finally {
  if($null -eq $priorAppData){Remove-Item Env:APPDATA -ErrorAction SilentlyContinue}else{$env:APPDATA=$priorAppData}
  # Keep evidence and failed installs for diagnosis. Cleanup must be explicitly restricted to this work path.
  if($installed) { Write-Warning ('Test installation retained for diagnosis: '+$work) }
}
