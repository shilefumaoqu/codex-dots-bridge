[CmdletBinding()]
param([string]$LegacyRoot,[string]$TestDirectory)
$ErrorActionPreference='Stop'
$project=Split-Path -Parent $PSScriptRoot
if(-not $LegacyRoot){$LegacyRoot=$project}
$LegacyRoot=[IO.Path]::GetFullPath($LegacyRoot)
if(-not $TestDirectory){$TestDirectory=Join-Path (Split-Path -Parent $project) '.it'}
$work=Join-Path ([IO.Path]::GetFullPath($TestDirectory)) ('installer-runtime-'+[Guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $work -Force|Out-Null
$data=Join-Path $work (([string][char]0x6570)+[char]0x636e+" '$ "+[char]0x7a7a+[char]0x683c);New-Item -ItemType Directory -Path $data|Out-Null
$node=Join-Path $LegacyRoot 'runtime\node-v24.21.0-win-x64\node.exe'
if(-not (Test-Path -LiteralPath $node)){$node=Join-Path $LegacyRoot '.runtime\node-v24.21.0-win-x64\node.exe'}
$checks=[Collections.Generic.List[string]]::new()
function Assert($Condition,[string]$Message){if(-not $Condition){throw $Message};$checks.Add($Message)}
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $project 'scripts\setup-lifecycle.ps1'),[ref]$null,[ref]$null)
$functions=foreach($name in @('Assert-SafePath','Read-Json','Write-Json','Runtime-Node','Invoke-Bridge','Assert-RuntimeLocksReleased','Assert-NoInFlightTasks','Get-UpgradeRuntimeStatus','Quote-InstallerArgument','Invoke-InstallerHelper','Invoke-InstallerRecovery','Test-InstallerRuntimeReady','Prepare-UpgradeRuntime','Start-InstallerSupervisor','Resolve-OldRuntimeRoot','Rollback-Transaction')) {
  $ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true).Extent.Text
}
foreach($name in @('launch-background.ps1','recover-reboot-locks.ps1')){Copy-Item -LiteralPath (Join-Path $project ('scripts\'+$name)) -Destination (Join-Path $work $name)}
$prefix=@'
param([string]$Root,[string]$Directory,[string]$Operation,[switch]$StatusUnavailable)
$ErrorActionPreference='Stop'
'@
$body=@'
if($StatusUnavailable){function Invoke-Bridge {throw 'synthetic_legacy_status_unavailable'}}
switch($Operation) {
 'Prepare' { @{resume=(Prepare-UpgradeRuntime $Root $Directory)}|ConvertTo-Json -Compress }
 'Ready' { @{ready=(Test-InstallerRuntimeReady $Root $Directory)}|ConvertTo-Json -Compress }
 'RecoveryDeadline' { Invoke-InstallerRecovery $Directory 800|ConvertTo-Json -Compress }
 'BrokerDeadline' { Invoke-InstallerHelper -Kind Supervisor -Directory $Directory -Root $Root -TimeoutMs 800|ConvertTo-Json -Compress }
 'Rollback' {
   $transactionPath=Join-Path $PSScriptRoot 'rollback-transaction.json'
   $config=Read-Json (Join-Path $Directory 'config.json')
   $transaction=[pscustomobject]@{was_running=$true;old_root=$Root;old_runtime_root=$Root;old_config=$config;data_dir=$Directory;app_data=$env:APPDATA;registration_changed=$false;was_tray_running=$false}
   Write-Json $transactionPath $transaction
   Rollback-Transaction $transaction
   @{ready=(Test-InstallerRuntimeReady $Root $Directory);transaction_removed=(-not (Test-Path -LiteralPath $transactionPath))}|ConvertTo-Json -Compress
 }
}
'@
$runner=Join-Path $work 'runner.ps1'
[IO.File]::WriteAllText($runner,($prefix+"`n"+($functions -join "`n")+"`n"+$body),[Text.UTF8Encoding]::new($false))
$listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$listener.Start();$port=$listener.LocalEndpoint.Port;$listener.Stop()
$seed=@'
import {pathToFileURL} from 'node:url';import {join} from 'node:path';
const r=JSON.parse(process.env.BRIDGE_INSTALLER_TEST_SEED);
const {initProduction,readProductionConfig,writeProductionConfig}=await import(pathToFileURL(join(r.root,'dist/runtime.js')));
const {TaskStore}=await import(pathToFileURL(join(r.root,'dist/task-store.js')));
if(r.action==='seed'){initProduction(r.data);const c=readProductionConfig(r.data);c.endpoint=r.endpoint;writeProductionConfig(r.data,c);}
const s=new TaskStore(join(r.data,'tasks.sqlite'));
if(r.action==='seed'){const t=s.submit({idempotency_key:'installer-retained',title:'synthetic retained task',input:{text:'synthetic'}});s.cancel({task_id:t.task_id,request_key:'cancel-retained',reason:'fixture'});s.submit({idempotency_key:'installer-inflight',title:'synthetic queued',input:{text:'synthetic'}});}
else {const t=s.list({}).find(t=>t.idempotency_key==='installer-inflight');if(t)s.cancel({task_id:t.task_id,request_key:'cancel-inflight',reason:'fixture'});}
s.close();
'@
function Seed([string]$Action){$env:BRIDGE_INSTALLER_TEST_SEED=(@{root=$LegacyRoot;data=$data;action=$Action;endpoint=('http://127.0.0.1:'+$port+'/')}|ConvertTo-Json -Compress);try{& $node --input-type=module -e $seed;if($LASTEXITCODE -ne 0){throw 'seed_failed'}}finally{Remove-Item Env:BRIDGE_INSTALLER_TEST_SEED -ErrorAction SilentlyContinue}}
function Run([string]$Operation,[switch]$Unavailable){$arguments=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$runner,'-Root',$LegacyRoot,'-Directory',$data,'-Operation',$Operation);if($Unavailable){$arguments+='-StatusUnavailable'};$out=@(& powershell.exe @arguments);if($LASTEXITCODE -ne 0){throw ($out -join "`n")};return (($out -join "`n")|ConvertFrom-Json)}
$started=$false
try {
  Seed 'seed'
  $owner=[Guid]::NewGuid().ToString();$serviceOwner=[Guid]::NewGuid().ToString()
  foreach($pair in @(@('supervisor.lock',@{owner=$owner;pid=2147483000}),@('service.lock',@{owner=$serviceOwner;pid=2147483001}))){[IO.File]::WriteAllText((Join-Path $data $pair[0]),($pair[1]|ConvertTo-Json -Compress))}
  [IO.File]::WriteAllText((Join-Path $data 'supervisor-state.json'),(@{owner=$owner;pid=2147483000;bridge_pid=2147483001;phase='running'}|ConvertTo-Json -Compress))
  $ErrorActionPreference='Continue'
  try {$gate=@(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $runner -Root $LegacyRoot -Directory $data -Operation Prepare -StatusUnavailable 2>&1)}finally{$ErrorActionPreference='Stop'}
  Assert ($LASTEXITCODE -ne 0 -and ($gate -join ' ') -match 'inflight_tasks_block_upgrade') 'Queued task blocks recovery before lock deletion despite unavailable legacy status'
  Assert ((Test-Path -LiteralPath (Join-Path $data 'supervisor.lock')) -and (Test-Path -LiteralPath (Join-Path $data 'service.lock'))) 'Task refusal preserves both exact old locks'
  Seed 'cancel'
  foreach($name in @('supervisor.lock','service.lock')){Remove-Item -LiteralPath (Join-Path $data $name)}
  $statePath=Join-Path $data 'supervisor-state.json'
  $liveState=@{owner=$owner;pid=2147483000;bridge_pid=2147483001;guardian_pid=$PID;phase='failed';cleanup_complete=$false}|ConvertTo-Json -Compress
  [IO.File]::WriteAllText($statePath,$liveState)
  $ErrorActionPreference='Continue'
  try{$stateOnly=@(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $runner -Root $LegacyRoot -Directory $data -Operation Prepare -StatusUnavailable 2>&1)}finally{$ErrorActionPreference='Stop'}
  Assert ($LASTEXITCODE -ne 0 -and ($stateOnly -join ' ') -match 'stale_lock_requires_recovery' -and [IO.File]::ReadAllText($statePath) -ceq $liveState) 'No-lock state-only active recorded PID is preserved and refused'
  $ErrorActionPreference='Continue'
  try{$blockedRollback=@(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $runner -Root $LegacyRoot -Directory $data -Operation Rollback 2>&1)}finally{$ErrorActionPreference='Stop'}
  Assert ($LASTEXITCODE -ne 0 -and ($blockedRollback -join ' ') -match 'rollback_runtime_requires_recovery' -and [IO.File]::ReadAllText($statePath) -ceq $liveState -and (-not (Test-Path -LiteralPath (Join-Path $data 'supervisor.lock'))) -and (Test-Path -LiteralPath (Join-Path $work 'rollback-transaction.json'))) 'Rollback blocks broker Create when a recorded child is alive despite absent locks and retains transaction'
  foreach($case in @(@('RecoveryDeadline','recover-reboot-locks.ps1'),@('BrokerDeadline','launch-background.ps1'))) {
    $helper=Join-Path $work $case[1];$original=[IO.File]::ReadAllBytes($helper)
    $marker=$case[0]+'.attempt.txt'
    $hang='param([string]$DataDir,[string]$NodeExecutable,[string]$EntryPath);[IO.File]::AppendAllText((Join-Path $PSScriptRoot '''+$marker+'''),''one attempt'');Start-Sleep -Seconds 5;''{"clearPreviousState":true,"pid":1}'''
    [IO.File]::WriteAllText($helper,$hang,[Text.UTF8Encoding]::new($false))
    $clock=[Diagnostics.Stopwatch]::StartNew();$ErrorActionPreference='Continue'
    try{$hung=@(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $runner -Root $LegacyRoot -Directory $data -Operation $case[0] 2>&1)}finally{$ErrorActionPreference='Stop';[IO.File]::WriteAllBytes($helper,$original)}
    Assert ($LASTEXITCODE -ne 0 -and ($hung -join ' ') -match 'installer_helper_timeout' -and $clock.ElapsedMilliseconds -lt 2500) ($case[0]+' returns within subprocess deadline rather than waiting for helper')
    Assert ([IO.File]::ReadAllText((Join-Path $work $marker)) -ceq 'one attempt') ($case[0]+' does not retry an unknown helper result')
  }
  foreach($pair in @(@('supervisor.lock',@{owner=$owner;pid=2147483000}),@('service.lock',@{owner=$serviceOwner;pid=2147483001}))){[IO.File]::WriteAllText((Join-Path $data $pair[0]),($pair[1]|ConvertTo-Json -Compress))}
  [IO.File]::WriteAllText($statePath,(@{owner=$owner;pid=2147483000;bridge_pid=2147483001;phase='running'}|ConvertTo-Json -Compress))
  $prepared=Run 'Prepare' -Unavailable
  Assert ($prepared.resume -eq $true) 'Strict same-boot recovery preserves crashed running intent'
  Assert ((-not (Test-Path -LiteralPath (Join-Path $data 'supervisor.lock'))) -and (-not (Test-Path -LiteralPath (Join-Path $data 'service.lock')))) 'Installer runner clears proven stale alpha20 locks without legacy run-start'
  Assert ((Run 'Prepare' -Unavailable).resume -eq $true) 'No-lock state-only dead owners still require strict recovery and retain running intent'
  $rollback=Run 'Rollback';$started=$true
  Assert ($rollback.ready -eq $true -and $rollback.transaction_removed -eq $true) 'Rollback launches bound old runtime with new broker and confirmed owner locks health'
  Start-Sleep -Milliseconds 700
  Assert ((Run 'Ready').ready -eq $true) 'Legacy supervisor and bridge remain ready after rollback PowerShell host exited'
  $status=@(& $node (Join-Path $LegacyRoot 'dist\main.js') status --data-dir $data)|ConvertFrom-Json
  Assert ($status.tasks.cancelled -eq 2) 'Upgrade preparation and rollback preserve both existing terminal tasks'
  $state=Get-Content -LiteralPath (Join-Path $data 'supervisor-state.json') -Raw|ConvertFrom-Json
  $parent=Get-CimInstance Win32_Process -Filter ('ProcessId='+$state.pid)
  $broker=Get-CimInstance Win32_Process -Filter ('ProcessId='+$parent.ParentProcessId)
  Assert ($broker.Name -ieq 'WmiPrvSE.exe' -and $parent.SessionId -eq [Diagnostics.Process]::GetCurrentProcess().SessionId) 'Restored legacy runtime is broker-created in caller session'
  $receipt=@{checks=$checks;passed=$checks.Count;legacy_version=(Get-Content -LiteralPath (Join-Path $LegacyRoot 'package.json') -Raw|ConvertFrom-Json).version;data=$data;work=$work;pid=$state.pid;bridge_pid=$state.bridge_pid;result='passed'}
  [IO.File]::WriteAllText((Join-Path $work 'evidence.json'),($receipt|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
  $receipt|ConvertTo-Json -Depth 8
}finally {
  if($started -or (Test-Path -LiteralPath (Join-Path $data 'supervisor.lock'))){& $node (Join-Path $LegacyRoot 'dist\main.js') run --stop --data-dir $data|Out-Null}
}
