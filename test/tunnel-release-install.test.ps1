[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$SetupExecutable,
  [string]$UpgradeSetupExecutable,
  [Parameter(Mandatory=$true)][string]$CodexCommand,
  [Parameter(Mandatory=$true)][string]$TestDirectory
)
$ErrorActionPreference='Stop'
$testInstance=[Guid]::NewGuid().ToString();$appId='CodexDotsBridgeSetup.Test.'+$testInstance
$parent=[IO.Path]::GetFullPath($TestDirectory)
$work=Join-Path $parent ("release 中文 O'Brien `$literal "+$testInstance)
$app=Join-Path $work 'program';$data=Join-Path $work 'data';$codexDir=Join-Path $work 'Codex home';$appData=Join-Path $work 'AppData'
New-Item -ItemType Directory -Path $work -Force|Out-Null
$commands=[Collections.Generic.List[object]]::new();$checks=[Collections.Generic.List[string]]::new()
$installed=$false;$priorAppData=$env:APPDATA;$env:APPDATA=$appData
function Check([bool]$Value,[string]$Message){if(-not $Value){throw $Message}}
function Registry-Snapshot {
  $path='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexDotsBridgeSetup_is1'
  if(-not(Test-Path -LiteralPath $path)){return 'absent'}
  $key=Get-Item -LiteralPath $path
  try{$values=[ordered]@{};foreach($name in @($key.GetValueNames()|Sort-Object)){$values[$name]=[ordered]@{kind=$key.GetValueKind($name).ToString();value=$key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}};return ($values|ConvertTo-Json -Depth 5 -Compress)}finally{$key.Close()}
}
function Receipt([string]$Executable){
  $receipt=Get-Content -LiteralPath (Join-Path (Split-Path -Parent ([IO.Path]::GetFullPath($Executable))) 'setup-build.json') -Raw -Encoding UTF8|ConvertFrom-Json
  Check ((Get-FileHash -LiteralPath $Executable).Hash.ToLowerInvariant() -ceq $receipt.setup_sha256) 'Installer does not match its receipt.'
  return $receipt
}
function Run-Installer([string]$Executable,[bool]$Uninstall=$false){
  $arguments=@('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART')
  if(-not $Uninstall){$arguments+=@('/TASKS=autostart',('/TESTINSTANCE='+$testInstance),('/DIR='+$app),('/DATADIR='+$data),('/CODEXHOME='+$codexDir),('/CODEXCOMMAND='+$CodexCommand),('/APPDATADIR='+$appData))}
  $log=Join-Path $work ('installer-'+$commands.Count+'.log');$arguments+=('/LOG='+$log)
  $info=[Diagnostics.ProcessStartInfo]::new([IO.Path]::GetFullPath($Executable));$info.UseShellExecute=$false;$info.CreateNoWindow=$true
  $info.Arguments=($arguments|ForEach-Object{'"'+$_.Replace('"','\"')+'"'}) -join ' '
  $watch=[Diagnostics.Stopwatch]::StartNew();$process=[Diagnostics.Process]::Start($info)
  try{Check ($process.WaitForExit(180000)) 'Installer test timed out; retain the running operation and evidence before doing anything else.';$entry=[ordered]@{executable=[IO.Path]::GetFileName($Executable);exit_code=$process.ExitCode;elapsed_ms=$watch.ElapsedMilliseconds;log=$log};$commands.Add($entry);$commands|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $work 'commands.json') -Encoding utf8;Check ($process.ExitCode -eq 0) ('Installer failed: '+$process.ExitCode)}finally{$process.Dispose()}
}
function State {Get-Content -LiteralPath (Join-Path $app 'installation-state.json') -Raw -Encoding UTF8|ConvertFrom-Json}
function Bridge([string[]]$Arguments){
  $s=State;$node=Join-Path $s.payload_root 'runtime/node-v24.21.0-win-x64/node.exe';$main=Join-Path $s.payload_root 'dist/main.js'
  $output=@(& $node $main @Arguments --data-dir $data);Check ($LASTEXITCODE -eq 0) 'Isolated Bridge command failed.'
  return (($output -join [Environment]::NewLine)|ConvertFrom-Json)
}
function Test-Registry-Key {return @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'|Where-Object{$_.Name -like '*CodexDotsBridgeSetup.Test.*'}|Where-Object{try{(Get-ItemProperty -LiteralPath $_.PSPath).InstallLocation.TrimEnd('\') -ieq $app.TrimEnd('\')}catch{$false}})}
$productionBefore=Registry-Snapshot
try{
  $initialReceipt=Receipt $SetupExecutable;$finalReceipt=if($UpgradeSetupExecutable){Receipt $UpgradeSetupExecutable}else{$initialReceipt}
  if($UpgradeSetupExecutable){Check ($initialReceipt.version -cne $finalReceipt.version) 'Upgrade requires two different real versions.'}
  [ordered]@{app_id=$appId;work=$work;setup_sha256=$initialReceipt.setup_sha256;upgrade_sha256=$finalReceipt.setup_sha256}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $work 'request.json') -Encoding utf8
  Run-Installer $SetupExecutable;$installed=$true;$state=State
  Check ($state.installer_app_id -ceq $appId -and $state.data_dir -ieq $data -and $state.codex_home -ieq $codexDir -and $state.app_data -ieq $appData) 'Installer escaped its explicit test identity or paths.'
  Check ((Get-FileHash -LiteralPath (Join-Path $state.payload_root 'release-manifest.json')).Hash.ToLowerInvariant() -ceq $initialReceipt.package_manifest_sha256 -and $state.package_fingerprint -ceq $initialReceipt.package_manifest_sha256) 'Installed payload is not bound to this exact Setup receipt.'
  Check (@(Test-Registry-Key).Count -eq 1) 'Distinct test uninstall registration is missing.'
  & (Join-Path $state.payload_root 'scripts/check-package.ps1') -PackageRoot $state.payload_root|Out-Null
  Check ($LASTEXITCODE -eq 0) 'Installed payload verification failed.'
  $checks.Add('real_setup_isolated_identity_paths_and_complete_payload')
  # One actual local start, with no Tunnel configured; observe the same attempt
  # becoming ready rather than treating a starting receipt as completion.
  Check (-not (Get-Content -LiteralPath (Join-Path $data 'config.json') -Raw|ConvertFrom-Json).tunnel) 'The isolated startup unexpectedly has Tunnel configuration.'
  $start=Bridge @('run');$watch=[Diagnostics.Stopwatch]::StartNew()
  do{$ready=Bridge @('status');if($ready.supervisor -eq 'running' -and $ready.service -eq 'running'){break};Start-Sleep -Milliseconds 500}while($watch.ElapsedMilliseconds -lt 30000)
  Check ($ready.supervisor -eq 'running' -and $ready.service -eq 'running') 'Isolated runtime did not become ready.'
  [ordered]@{start=$start;ready=$ready}|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $work 'runtime-readiness.json') -Encoding utf8
  $protected=@((Join-Path $data 'config.json'),(Join-Path $data 'installation.json'),(Join-Path $codexDir 'config.toml'));$before=@{};foreach($file in $protected){$before[$file]=[IO.File]::ReadAllText($file)}
  foreach($action in @('Connect','PreflightUninstall')){& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $app 'setup-lifecycle.ps1') -Action $action -InstallDirectory $app|Out-Null;Check ($LASTEXITCODE -eq 0) 'Read-only installed entry failed.';foreach($file in $protected){Check ([IO.File]::ReadAllText($file) -ceq $before[$file]) 'Read-only installed entry changed configuration.'}}
  Bridge @('run','--stop')|Out-Null;$checks.Add('same_start_reaches_ready_readonly_entries_preserve_exact_configuration_then_stops')
  Bridge @('setup','--no-register','--codex-home',$codexDir,'--desktop-access','read')|Out-Null
  $identity=Get-Content -LiteralPath (Join-Path $data 'config.json') -Raw|ConvertFrom-Json
  $caller=[IO.File]::ReadAllText((Join-Path $data 'caller.key'));$worker=[IO.File]::ReadAllText((Join-Path $data 'worker.key'));$desktop=[IO.File]::ReadAllText((Join-Path $data 'desktop-conversations.json'))
  Add-Content -LiteralPath (Join-Path $codexDir 'config.toml') -Encoding utf8 -Value ([Environment]::NewLine+"[mcp_servers.synthetic_unrelated]"+[Environment]::NewLine+"command = 'preserve-command'")
  $node=Join-Path $state.payload_root 'runtime/node-v24.21.0-win-x64/node.exe'
  Push-Location $state.payload_root
  try{& $node --input-type=module -e "import Database from 'better-sqlite3';const d=new Database(process.argv[1]);d.exec('CREATE TABLE release_preserved(value TEXT)');d.prepare('INSERT INTO release_preserved VALUES (?)').run('synthetic retained value');d.close();" (Join-Path $data 'tasks.sqlite');Check ($LASTEXITCODE -eq 0) 'SQLite fixture failed.'}finally{Pop-Location}
  if($UpgradeSetupExecutable){
    $oldClient=Join-Path $state.payload_root 'vendor/tunnel-client-v0.0.16-windows-amd64/tunnel-client.exe';$oldHash=(Get-FileHash -LiteralPath $oldClient).Hash
    $tunnel=[pscustomobject]@{tunnel_id='tunnel_synthetic_release';organization_id='org_synthetic';key_file=(Join-Path $work 'missing synthetic runtime key.env');client_path=$oldClient}
    $identity|Add-Member -Force -NotePropertyName tunnel -NotePropertyValue $tunnel
    [IO.File]::WriteAllText((Join-Path $data 'config.json'),($identity|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
    Run-Installer $UpgradeSetupExecutable;$state=State
    Check ((Get-FileHash -LiteralPath (Join-Path $state.payload_root 'release-manifest.json')).Hash.ToLowerInvariant() -ceq $finalReceipt.package_manifest_sha256 -and $state.package_fingerprint -ceq $finalReceipt.package_manifest_sha256) 'Upgraded payload is not bound to this exact Setup receipt.'
    $config=Get-Content -LiteralPath (Join-Path $data 'config.json') -Raw|ConvertFrom-Json;$manifest=Get-Content -LiteralPath (Join-Path $state.payload_root 'release-manifest.json') -Raw|ConvertFrom-Json
    $newClient=Join-Path $state.payload_root $manifest.tunnel_client.path
    Check ($state.version -ceq $finalReceipt.version -and $config.tunnel.client_path -ieq $newClient -and $manifest.tunnel -ceq '0.0.17-local-refusal.1') 'Upgrade did not bind the patched payload.'
    Check ((Get-FileHash -LiteralPath $newClient).Hash.ToLowerInvariant() -ceq $manifest.tunnel_client.sha256 -and (Get-FileHash -LiteralPath $oldClient).Hash -ceq $oldHash) 'Upgrade changed old bytes or selected unverified new bytes.'
    foreach($field in @('tunnel_id','organization_id','key_file')){Check ($config.tunnel.$field -ceq $tunnel.$field) 'Upgrade changed an account or key reference.'}
    $checks.Add('real_alpha30_owned_v16_upgrades_to_authenticated_patched_vendor_old_bytes_and_account_preserved')
  }
  $config=Get-Content -LiteralPath (Join-Path $data 'config.json') -Raw|ConvertFrom-Json
  Check ($config.instance_id -ceq $identity.instance_id -and [IO.File]::ReadAllText((Join-Path $data 'caller.key')) -ceq $caller -and [IO.File]::ReadAllText((Join-Path $data 'worker.key')) -ceq $worker -and [IO.File]::ReadAllText((Join-Path $data 'desktop-conversations.json')) -ceq $desktop) 'Installation changed identity, credentials or access settings.'
  $node=Join-Path $state.payload_root 'runtime/node-v24.21.0-win-x64/node.exe'
  Push-Location $state.payload_root
  try{$value=& $node --input-type=module -e "import Database from 'better-sqlite3';const d=new Database(process.argv[1],{readonly:true});console.log(d.prepare('SELECT value FROM release_preserved').get().value);d.close();" (Join-Path $data 'tasks.sqlite');Check ($LASTEXITCODE -eq 0 -and $value -ceq 'synthetic retained value') 'SQLite data changed.'}finally{Pop-Location}
  $checks.Add('identity_credentials_desktop_access_and_real_sqlite_retained')
  $uninstaller=Get-ChildItem -LiteralPath $app -Filter 'unins*.exe' -File|Select-Object -First 1
  Run-Installer $uninstaller.FullName $true;$installed=$false
  Check (@(Test-Registry-Key).Count -eq 0 -and -not(Test-Path -LiteralPath (Join-Path $state.payload_root 'dist/main.js'))) 'Uninstall retained owned registration or program files.'
  Check ((Test-Path -LiteralPath (Join-Path $data 'tasks.sqlite')) -and [IO.File]::ReadAllText((Join-Path $data 'caller.key')) -ceq $caller -and [IO.File]::ReadAllText((Join-Path $data 'desktop-conversations.json')) -ceq $desktop) 'Uninstall changed retained data.'
  $toml=[IO.File]::ReadAllText((Join-Path $codexDir 'config.toml'));Check ($toml.Contains('preserve-command') -and -not $toml.Contains('[mcp_servers.codex-dots-bridge]')) 'Uninstall changed unrelated MCP or kept owned MCP.'
  Check (-not(Test-Path -LiteralPath (Join-Path $appData 'Microsoft/Windows/Start Menu/Programs/Startup/CodexDotsBridge.vbs')) -and -not(Test-Path -LiteralPath (Join-Path $codexDir 'skills/codex-dots-bridge'))) 'Uninstall retained owned startup or Skill.'
  Check ((Registry-Snapshot) -ceq $productionBefore) 'Production uninstall registration changed.'
  $exitWatch=[Diagnostics.Stopwatch]::StartNew()
  do{$remaining=@(Get-CimInstance Win32_Process|Where-Object{$_.CommandLine -and $_.CommandLine.Contains($work)});if($remaining.Count -eq 0){break};Start-Sleep -Milliseconds 500}while($exitWatch.ElapsedMilliseconds -lt 10000)
  Check ($remaining.Count -eq 0) 'Test process remains after uninstall.'
  $checks.Add('real_uninstall_removes_owned_resources_retains_data_and_unrelated_mcp_no_test_processes')
  $result=[ordered]@{mode='real_focused_release_install';setupSha256=$finalReceipt.setup_sha256;fromVersion=$(if($UpgradeSetupExecutable){$initialReceipt.version}else{$null});toVersion=$finalReceipt.version;installed=$true;upgraded=[bool]$UpgradeSetupExecutable;uninstalled=$true;uninstallPreservedData=$true;passed=$checks.Count;failed=0;checks=@($checks);test_directory=$work;production_registry='unchanged';tunnel_cloud_acceptance='not_tested'}
  $result|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $work 'acceptance-result.json') -Encoding utf8
  $result|ConvertTo-Json -Depth 6
}finally{if($null -eq $priorAppData){Remove-Item Env:APPDATA -ErrorAction SilentlyContinue}else{$env:APPDATA=$priorAppData};if($installed){Write-Warning ('Retained this isolated test installation for diagnosis: '+$work)}}
