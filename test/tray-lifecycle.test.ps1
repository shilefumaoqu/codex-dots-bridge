[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$SetupExecutable,
  [Parameter(Mandatory=$true)][string]$CodexCommand,
  [Parameter(Mandatory=$true)][string]$TestDirectory,
  [string]$LegacyPackageRoot,
  [string]$InstallerAppId=('CodexDotsBridgeSetup.Test.'+[Guid]::NewGuid().ToString())
)
$ErrorActionPreference='Stop'
if($InstallerAppId -notmatch '^CodexDotsBridgeSetup\.Test\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'){throw 'Distinct strict GUID AppId required.'}
$testInstance=$Matches[1]
$repo=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$allowed=Join-Path $repo 'artifacts\private\tray-lifecycle-evidence'
$parent=[IO.Path]::GetFullPath($TestDirectory).TrimEnd('\')
if($parent -ine $allowed -and -not $parent.StartsWith($allowed+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Evidence directory must remain within artifacts/private/tray-lifecycle-evidence.'}
$SetupExecutable=[IO.Path]::GetFullPath($SetupExecutable)
$receipt=Get-Content -LiteralPath (Join-Path (Split-Path -Parent $SetupExecutable) 'setup-build.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if((Get-FileHash -LiteralPath $SetupExecutable -Algorithm SHA256).Hash.ToLowerInvariant() -cne $receipt.setup_sha256){throw 'Setup hash differs from build receipt.'}
if(-not (Test-Path -LiteralPath $CodexCommand -PathType Leaf) -or [IO.Path]::GetExtension($CodexCommand) -ine '.exe'){throw 'Native official CLI required.'}
$work=Join-Path $parent ('隔离托盘 '+[Guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $work -Force | Out-Null
$app=Join-Path $work '程序';$data=Join-Path $work '数据';$codexDir=Join-Path $work 'Codex home';$appData=Join-Path $work 'AppData'
$priorAppData=$env:APPDATA;$priorCodexHome=$env:CODEX_HOME
$env:APPDATA=$appData;$env:CODEX_HOME=$codexDir
$watch=[Diagnostics.Stopwatch]::StartNew()
$checks=[Collections.Generic.List[string]]::new();$assertions=0;$installed=$false;$registryPath=$null;$fixtureId=$null;$cleanupErrors=[Collections.Generic.List[string]]::new()
$productionKey='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexDotsBridgeSetup_is1'
function Assert([bool]$Condition,[string]$Message){$script:assertions++;if(-not $Condition){throw $Message}}
function Json([string]$Path){Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json}
function Write-Json([string]$Path,$Value){[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))}
function Registry-Snapshot {
  if(-not (Test-Path -LiteralPath $productionKey)){return 'absent'}
  $key=Get-Item -LiteralPath $productionKey
  try{$values=[ordered]@{};foreach($name in @($key.GetValueNames()|Sort-Object)){$values[$name]=@{kind=$key.GetValueKind($name).ToString();value=$key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}};return ($values|ConvertTo-Json -Depth 4 -Compress)}finally{$key.Close()}
}
$productionBefore=Registry-Snapshot
function Quote([string]$Value){
  # CommandLineToArgvW quoting, without a shell or string interpolation.
  $b=[Text.StringBuilder]::new('"');$slashes=0
  foreach($c in $Value.ToCharArray()){
    if($c -eq '\'){$slashes++;continue}
    if($c -eq '"'){$null=$b.Append('\',$slashes*2+1);$null=$b.Append($c)}else{$null=$b.Append('\',$slashes);$null=$b.Append($c)}
    $slashes=0
  }
  $null=$b.Append('\',$slashes*2);$null=$b.Append('"');$b.ToString()
}
function Exec([string]$Exe,[string[]]$Arguments,[string]$Directory=$work,[int]$Timeout=40000){
  $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$Exe;$info.Arguments=($Arguments|ForEach-Object{Quote $_}) -join ' '
  $info.WorkingDirectory=$Directory;$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
  $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true;$info.StandardOutputEncoding=[Text.UTF8Encoding]::new($false)
  $p=[Diagnostics.Process]::Start($info)
  try{
    $stdout=$p.StandardOutput.ReadToEndAsync();$stderr=$p.StandardError.ReadToEndAsync()
    if(-not $p.WaitForExit($Timeout)){throw ('Isolated process timeout: '+[IO.Path]::GetFileName($Exe))}
    $out=$stdout.GetAwaiter().GetResult();$null=$stderr.GetAwaiter().GetResult()
    return [pscustomobject]@{code=$p.ExitCode;text=$out}
  }finally{$p.Dispose()}
}
function State {Json (Join-Path $app 'installation-state.json')}
function Node([string]$Root){Join-Path $Root 'runtime\node-v24.21.0-win-x64\node.exe'}
function Bridge([string[]]$Arguments){
  $s=State;$r=Exec (Node $s.payload_root) (@((Join-Path $s.payload_root 'dist\main.js'))+$Arguments+@('--data-dir',$data)) $s.payload_root
  Assert ($r.code -eq 0) ('Bridge failed: '+$Arguments[0]+' '+$r.text)
  $r.text|ConvertFrom-Json
}
function Tray([string[]]$Arguments){$s=State;Exec (Join-Path $s.payload_root 'CodexDotsBridge.Tray.exe') ($Arguments+@('--data-dir',$data)) $s.payload_root 15000}
function Start-Tray {
  $s=State
  Start-Process -FilePath (Join-Path $s.payload_root 'CodexDotsBridge.Tray.exe') -ArgumentList @('--background','--data-dir',(Quote $data)) -WindowStyle Hidden | Out-Null
  for($i=0;$i -lt 40;$i++){if((Tray @('--running')).code -eq 0){return};Start-Sleep -Milliseconds 100}
  throw 'Tray did not acquire its isolated instance.'
}
function Tray-Pids {
  $exe=Join-Path (State).payload_root 'CodexDotsBridge.Tray.exe'
  @(Get-Process -Name 'CodexDotsBridge.Tray' -ErrorAction SilentlyContinue|Where-Object{try{$_.Path -ieq $exe}catch{$false}}|ForEach-Object{$_.Id})
}
function Installer([bool]$Success=$true){
  Assert ((Get-FileHash -LiteralPath $SetupExecutable -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $receipt.setup_sha256) 'Installer changed during this evidence run.'
  $log=Join-Path $work ('setup-'+[Guid]::NewGuid().ToString('N').Substring(0,8)+'.log')
  $args=@('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/TASKS=',('/TESTINSTANCE='+$testInstance),('/DIR='+$app),('/DATADIR='+$data),('/CODEXHOME='+$codexDir),('/CODEXCOMMAND='+$CodexCommand),('/APPDATADIR='+$appData),('/LOG='+$log))
  $r=Exec $SetupExecutable $args $work 180000
  [IO.File]::AppendAllText((Join-Path $work 'installer-results.ndjson'),((@{code=$r.code;expected_success=$Success;log=[IO.Path]::GetFileName($log)}|ConvertTo-Json -Compress)+"`n"),[Text.UTF8Encoding]::new($false))
  if($Success){Assert ($r.code -eq 0) ('Installer failed: '+$r.code)}else{Assert ($r.code -ne 0) 'Installer should reject in-flight fixture.'}
}
function Find-Registry {
  $entries=@(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'|Where-Object{
    $entry=Get-ItemProperty -LiteralPath $_.PSPath
    try{$entry.InstallLocation -and [IO.Path]::GetFullPath($entry.InstallLocation).TrimEnd('\') -ieq $app}catch{$false}
  })
  Assert ($entries.Count -eq 1) 'Expected one isolated installer registration.'
  $entries[0].PSPath
}
function Task-Fixture([string]$Action){
  $s=State;$module=([uri](Join-Path $s.payload_root 'dist\task-store.js')).AbsoluteUri
  $code=@'
import {TaskStore} from __MODULE__;
const db=new TaskStore(process.argv[1]);
try {
 if(process.argv[2]==='seed') {
  const task=db.submit({idempotency_key:'isolated-tray-fixture',title:'Synthetic isolation fixture',input:{text:'No real task and no cloud execution'},deadline_hours:24});
  const owned=db.claim({task_id:task.task_id,claim_key:'isolated-fixture-claim'});
  db.requestInput({task_id:task.task_id,claim_token:owned.claim_token,question_key:'isolated-fixture-question',question:'Hold for local regression only'});
  console.log(JSON.stringify({task_id:task.task_id}));
 } else if(process.argv[2]==='cancel') console.log(JSON.stringify(db.cancel({task_id:process.argv[3],request_key:'isolated-fixture-cleanup'})));
 else {const row=db.db.prepare('SELECT data FROM tasks WHERE id=?').get(process.argv[3]);console.log(JSON.stringify({data:row?.data??null}));}
} finally {db.close();}
'@
  $code=$code.Replace('__MODULE__',($module|ConvertTo-Json -Compress))
  $r=Exec (Node $s.payload_root) @('--input-type=module','-e',$code,(Join-Path $data 'tasks.sqlite'),$Action,$fixtureId) $s.payload_root
  Assert ($r.code -eq 0) ('Synthetic task fixture operation failed: '+$Action+' '+$r.text)
  $r.text|ConvertFrom-Json
}
function Stable-Snapshot {
  $locks=[ordered]@{}
  foreach($name in @('supervisor.lock','service.lock')){$locks[$name]=[IO.File]::ReadAllText((Join-Path $data $name))}
  $hint=Json (Join-Path $data 'supervisor-state.json')
  [pscustomobject]@{locks=$locks;pids=@($hint.pid,$hint.bridge_pid,$hint.guardian_pid|Where-Object{$_});toml=[IO.File]::ReadAllText((Join-Path $codexDir 'config.toml'));task=(Task-Fixture 'read').data;config=[IO.File]::ReadAllText((Join-Path $data 'config.json'));caller=[IO.File]::ReadAllText((Join-Path $data 'caller.key'));worker=[IO.File]::ReadAllText((Join-Path $data 'worker.key'))}
}
function Assert-Stable($Before){
  $after=Stable-Snapshot
  Assert (($after.locks|ConvertTo-Json -Compress) -ceq ($Before.locks|ConvertTo-Json -Compress)) 'Runtime lock ownership changed.'
  Assert (($after.pids|ConvertTo-Json -Compress) -ceq ($Before.pids|ConvertTo-Json -Compress)) 'Background PIDs changed.'
  foreach($id in $Before.pids){Assert ([bool](Get-Process -Id $id -ErrorAction SilentlyContinue)) 'Owned runtime PID stopped.'}
  foreach($name in @('toml','task','config','caller','worker')){Assert ($after.$name -ceq $Before.$name) ('Preserved field changed: '+$name)}
  $status=Bridge @('status');Assert ($status.supervisor -eq 'running' -and $status.service -eq 'running') 'Background no longer running.'
}
$failure=$null;$legacyResult=$null
try {
  Installer;$installed=$true
  $s=State;$registryPath=Find-Registry
  $instance=(Json (Join-Path $data 'config.json')).instance_id
  Assert ($s.installer_app_id -ceq $InstallerAppId -and $s.data_dir -ceq $data -and $s.codex_home -ceq $codexDir -and $s.app_data -ceq $appData) 'Installer isolation not preserved.'
  Assert ($s.version -ceq $receipt.version -and $s.package_fingerprint -ceq $receipt.package_manifest_sha256) 'Installed version/package fingerprint differs.'
  Assert ((Tray @('--running')).code -eq 0) 'Installer did not start real tray.'
  $version=Tray @('--version');Assert ($version.code -eq 0 -and ($version.text|ConvertFrom-Json).tray_version -ceq $receipt.version) 'Compiled tray reports wrong version.'
  $checks.Add('real_install_isolated_paths_same_exe_and_compiled_version')
  Bridge @('run')|Out-Null
  $fixtureId=(Task-Fixture 'seed').task_id
  $before=Stable-Snapshot
  $projection=Bridge @('status','--tray');Write-Json (Join-Path $work 'running-projection.json') $projection
  Assert ($projection.installed_version -ceq $receipt.version -and $projection.service_version -ceq $receipt.version) 'Authenticated running version differs.'
  Assert ($projection.state -eq 'setup' -and $projection.tone -eq 'amber' -and $projection.cloud -eq '未配置' -and $projection.dot -eq '未连接' -and $projection.inflight_count -eq 1) 'Offline backend must report amber pending configuration and one in-flight task.'
  $checks.Add('authenticated_service_version_offline_amber_not_false_green')
  $startup=Join-Path $appData 'Microsoft\Windows\Start Menu\Programs\Startup\CodexDotsBridge.vbs'
  foreach($choice in @('disabled','enabled','disabled')){
    $setting=Bridge @('setup','--autostart-state',$choice)
    Assert ($setting.verified -eq $true -and $setting.autostart -eq $choice) 'Autostart update was not verified.'
    Assert ((Bridge @('status','--tray')).autostart -eq $choice) 'Projection lost autostart state.'
    Assert ((Test-Path -LiteralPath $startup) -eq ($choice -eq 'enabled')) 'Startup existence differs from choice.'
    if($choice -eq 'enabled'){Assert ([IO.File]::ReadAllText($startup).Contains('CodexDotsBridge.Tray.exe')) 'Enabled entry does not launch bundled tray.'}
    Assert-Stable $before
  }
  $checks.Add('live_autostart_disable_enable_disable_keeps_pids_locks_task_mcp_and_data')
  $trayIds=Tray-Pids;Assert ($trayIds.Count -eq 1) 'Expected one real tray PID.'
  Start-Tray;Start-Sleep -Milliseconds 250
  $again=Tray-Pids;Assert ($again.Count -eq 1 -and $again[0] -eq $trayIds[0]) 'Duplicate tray launch spawned a second owner.'
  $exit=Tray @('--exit');Assert ($exit.code -eq 0 -and (Tray @('--running')).code -eq 1) 'Tray exit not confirmed.'
  Assert-Stable $before
  Start-Tray;Assert ((Tray-Pids).Count -eq 1) 'Tray failed to restart as one instance.'
  $checks.Add('single_instance_exit_stops_only_tray_background_task_unchanged')
  $stateBytes=[IO.File]::ReadAllText((Join-Path $app 'installation-state.json'));$manifestBytes=[IO.File]::ReadAllText((Join-Path $data 'installation.json'));$trayBefore=Tray-Pids
  Installer $false
  Assert-Stable $before
  Assert ([IO.File]::ReadAllText((Join-Path $app 'installation-state.json')) -ceq $stateBytes -and [IO.File]::ReadAllText((Join-Path $data 'installation.json')) -ceq $manifestBytes) 'Rejected Prepare changed installation state/manifest.'
  Assert (-not (Test-Path -LiteralPath (Join-Path $app '.setup-transaction.json'))) 'Blocked Prepare retained a transaction.'
  Assert ([IO.File]::ReadAllText((Join-Path $app '.setup-result.txt')).Trim() -eq 'inflight_tasks_block_upgrade') 'Prepare did not report exact in-flight blocker.'
  Assert ((Tray-Pids|ConvertTo-Json -Compress) -ceq ($trayBefore|ConvertTo-Json -Compress)) 'Blocked Prepare stopped or replaced tray.'
  $checks.Add('real_prepare_rejects_inflight_before_stopping_tray_or_background_and_keeps_owned_state')
  Task-Fixture 'cancel'|Out-Null
  Installer
  Assert ((State).autostart -eq $false -and (Bridge @('status','--tray')).autostart -eq 'disabled' -and -not (Test-Path -LiteralPath $startup)) 'Unchecked repair re-enabled disabled autostart.'
  Assert ((Tray @('--running')).code -eq 0) 'Repair failed to switch/start installed tray.'
  $afterRepair=Bridge @('status','--tray');Write-Json (Join-Path $work 'repair-projection.json') $afterRepair
  # Repair must restore the previous local running state even without Tunnel/cloud configuration.
  Assert ($afterRepair.installed_version -ceq $receipt.version -and $afterRepair.service_version -ceq $receipt.version -and $afterRepair.autostart -eq 'disabled' -and $afterRepair.state -eq 'setup' -and $afterRepair.tone -eq 'amber') 'Repair did not automatically restore the pending-config local service with matched version.'
  $runtime=Bridge @('status');Assert ($runtime.supervisor -eq 'running' -and $runtime.service -eq 'running') 'Repair stopped the previously running local background.'
  Assert ((Json (Join-Path $data 'config.json')).instance_id -ceq $instance) 'Repair changed instance identity.'
  Assert ((State).connection -eq 'local_started_pending_official_account_setup') 'Repair running/pending connection state is unclear.'
  Assert (((Task-Fixture 'read').data|ConvertFrom-Json).status -eq 'cancelled') 'Repair lost or changed synthetic task record.'
  $checks.Add('disabled_setting_survives_real_same_version_repair')
  Bridge @('run','--stop')|Out-Null
  Assert ((Tray @('--exit')).code -eq 0) 'Test tray failed cleanup exit.'
  $uninstaller=(Get-ChildItem -LiteralPath $app -Filter 'unins*.exe' -File|Select-Object -First 1).FullName
  Assert ((State).install_directory -ceq $app -and (State).installer_app_id -ceq $InstallerAppId) 'Cleanup installation ownership changed.'
  $uninstall=Exec $uninstaller @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART') $work 180000
  Assert ($uninstall.code -eq 0 -and -not (Test-Path -LiteralPath $registryPath)) 'Isolated uninstall failed.'
  $installed=$false
  Assert (Test-Path -LiteralPath (Join-Path $data 'tasks.sqlite')) 'Uninstall deleted isolated task data.'
  $checks.Add('owned_test_tray_background_and_installer_cleanup_preserves_data')
  if($LegacyPackageRoot){
    # A separate actual alpha.19 registration with disabled Startup is upgraded by the same final EXE.
    # Production payload is only read/copied; executable tests always run our private copy.
    $legacySource=[IO.Path]::GetFullPath($LegacyPackageRoot)
    $legacyCopy=Join-Path $work '旧版本程序副本'
    Assert ($legacyCopy.StartsWith($work+'\',[StringComparison]::OrdinalIgnoreCase)) 'Legacy copy left test workspace.'
    Assert (-not ((Get-Item -LiteralPath $legacySource).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Legacy source is a reparse point.'
    Copy-Item -LiteralPath $legacySource -Destination $legacyCopy -Recurse
    $LegacyPackageRoot=$legacyCopy
    $app=Join-Path $work '升级程序';$data=Join-Path $work '升级数据';$codexDir=Join-Path $work '升级 Codex home';$appData=Join-Path $work '升级 AppData'
    $env:APPDATA=$appData;$env:CODEX_HOME=$codexDir;$fixtureId=$null
    $legacyVersion=(Json (Join-Path $LegacyPackageRoot 'package.json')).version
    Assert ($legacyVersion -cne $receipt.version) 'Legacy upgrade requires different actual version.'
    $r=Exec (Node $LegacyPackageRoot) @((Join-Path $LegacyPackageRoot 'dist\main.js'),'setup','--data-dir',$data,'--codex-home',$codexDir,'--codex-command',$CodexCommand) $LegacyPackageRoot
    Assert ($r.code -eq 0) 'Actual legacy payload setup failed.'
    $identity=(Json (Join-Path $data 'config.json')).instance_id;$caller=[IO.File]::ReadAllText((Join-Path $data 'caller.key'));$worker=[IO.File]::ReadAllText((Join-Path $data 'worker.key'))
    Installer;$installed=$true;$registryPath=Find-Registry
    Assert ((State).version -ceq $receipt.version -and (State).autostart -eq $false -and (Bridge @('status','--tray')).autostart -eq 'disabled') 'Legacy disabled choice did not survive actual upgrade.'
    Assert ((Json (Join-Path $data 'config.json')).instance_id -ceq $identity -and [IO.File]::ReadAllText((Join-Path $data 'caller.key')) -ceq $caller -and [IO.File]::ReadAllText((Join-Path $data 'worker.key')) -ceq $worker) 'Legacy identity/keys changed during upgrade.'
    Assert ((Tray @('--running')).code -eq 0) 'New version tray did not start after legacy upgrade.'
    $registration=Json (Join-Path $data 'installation.json');Assert ($registration.mcp.args[0] -ceq (Join-Path (State).payload_root 'dist\main.js')) 'MCP remains on prior payload.'
    $legacyResult=@{from=$legacyVersion;to=$receipt.version;autostart='disabled';cloud='not_connected'}
    $checks.Add('actual_legacy_cross_version_upgrade_keeps_disabled_identity_keys_and_switches_mcp_tray')
    Bridge @('run','--stop')|Out-Null;Tray @('--exit')|Out-Null
    $uninstaller=(Get-ChildItem -LiteralPath $app -Filter 'unins*.exe' -File|Select-Object -First 1).FullName
    Assert ((State).installer_app_id -ceq $InstallerAppId -and (State).install_directory -ceq $app) 'Legacy cleanup ownership changed.'
    $r=Exec $uninstaller @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART') $work 180000
    Assert ($r.code -eq 0 -and -not (Test-Path -LiteralPath $registryPath)) 'Legacy test uninstall failed.';$installed=$false
  }
  Assert ((Registry-Snapshot) -ceq $productionBefore) 'Production uninstall registry changed.'
  $checks.Add('production_registry_untouched')
}catch{$failure=$_.Exception.Message}finally{
  if($installed){
    # Never kill by global process name; only authenticated commands for this exact test state.
    $ownedCleanup=$false
    try{$s=State;if($s.installer_app_id -cne $InstallerAppId -or $s.install_directory -cne $app){throw 'Cleanup ownership mismatch'};$ownedCleanup=$true}catch{$cleanupErrors.Add($_.Exception.Message)}
    if($ownedCleanup){
      if($fixtureId){try{$task=(Task-Fixture 'read').data|ConvertFrom-Json;if($task.status -notin @('completed','failed','cancelled','expired')){Task-Fixture 'cancel'|Out-Null}}catch{$cleanupErrors.Add($_.Exception.Message)}}
      try{Bridge @('run','--stop')|Out-Null}catch{$cleanupErrors.Add($_.Exception.Message)}
      try{Tray @('--exit')|Out-Null}catch{$cleanupErrors.Add($_.Exception.Message)}
    }
  }
  if($null -eq $priorAppData){Remove-Item Env:APPDATA -ErrorAction SilentlyContinue}else{$env:APPDATA=$priorAppData}
  if($null -eq $priorCodexHome){Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue}else{$env:CODEX_HOME=$priorCodexHome}
  $result=[ordered]@{status=$(if($failure){'failed'}else{'passed'});setup_sha256=$receipt.setup_sha256;version=$receipt.version;installer_app_id=$InstallerAppId;checks=@($checks);check_count=$checks.Count;assertion_count=$assertions;elapsed_ms=$watch.ElapsedMilliseconds;legacy_upgrade=$legacyResult;production='not_touched';cloud='not_connected';desktop_reboot='not_tested';tray_right_click_ui='shared_cli_tested_ui_not_automated';failure=$failure;cleanup_errors=@($cleanupErrors);retained_installation=$installed;test_directory=$work}
  Write-Json (Join-Path $work 'acceptance-result.json') $result
  $result|ConvertTo-Json -Depth 6
}
if($failure){exit 1}
