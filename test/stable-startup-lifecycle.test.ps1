[CmdletBinding()]
param([string]$TestDirectory)
$ErrorActionPreference='Stop'
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -Global -Force
$projectRoot=Split-Path -Parent $PSScriptRoot
if(-not $TestDirectory){$TestDirectory=Join-Path $env:TEMP ('dots-stable-'+[Guid]::NewGuid().ToString('N'))}
$work=[IO.Path]::GetFullPath($TestDirectory);New-Item -ItemType Directory -Path $work -Force | Out-Null
$parseErrors=$null;$tokens=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $projectRoot 'scripts\setup-lifecycle.ps1'),[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw 'Lifecycle syntax errors.'}
foreach($definition in $ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)){. ([ScriptBlock]::Create($definition.Extent.Text))}
$main=@($ast.EndBlock.Statements | Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]})[-1]
$body=(@($main.Body.Statements | Where-Object {$_ -isnot [Management.Automation.Language.ExitStatementAst]} | ForEach-Object {$_.Extent.Text}) -join "`n")
$catchBody=(@($main.CatchClauses[0].Body.Statements | Where-Object {$_ -isnot [Management.Automation.Language.ExitStatementAst]} | ForEach-Object {$_.Extent.Text}) -join "`n")
$lifecycle=[ScriptBlock]::Create("try {`n$body`n} catch {`n$catchBody`n}")
$results=[Collections.Generic.List[object]]::new()
function Case([string]$Name,[scriptblock]$Test){& $Test;$results.Add([pscustomobject]@{name=$Name;passed=$true})}
function Fixture([string]$Name){
  $script:InstallDirectory=Join-Path $work $Name;$script:DataDir=Join-Path $work ($Name+'-data');$script:CodexHome=Join-Path $work ($Name+'-home');$script:AppDataDirectory=Join-Path $work ($Name+'-appdata')
  $script:oldRoot=Join-Path $InstallDirectory 'payload\0.2.0-alpha.22';$script:newRoot=Join-Path $InstallDirectory 'payload\0.2.0-alpha.24'
  New-Item -ItemType Directory -Path $oldRoot,$DataDir -Force | Out-Null
  $script:statePath=Join-Path $InstallDirectory 'installation-state.json';$script:transactionPath=Join-Path $InstallDirectory '.setup-transaction.json';$script:resultPath=Join-Path $InstallDirectory '.setup-result.txt'
  $script:CodexCommand=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe';$script:InstallerIdentity='CodexDotsBridgeSetup';$script:NewVersion='0.2.0-alpha.24';$script:PackageFingerprint='0'*64
  $script:oldConfig=[pscustomobject]@{owner='codex-dots-bridge';installation=[pscustomobject]@{root=$oldRoot;node_path='synthetic-original-node'}}
  Write-Json (Join-Path $DataDir 'config.json') $oldConfig
  Write-Json $statePath ([pscustomobject]@{owner='codex-dots-bridge-setup';schema=1;install_directory=$InstallDirectory;installer_app_id=$InstallerIdentity;version='0.2.0-alpha.22';payload_root=$oldRoot;data_dir=$DataDir;codex_home=$CodexHome;codex_command=$CodexCommand;app_data=$AppDataDirectory})
  Write-Json (Join-Path $DataDir 'installation.json') ([pscustomobject]@{owner='codex-dots-bridge';codex_command=$CodexCommand;mcp=[pscustomobject]@{args=@((Join-Path $oldRoot 'dist\main.js'))};autostart=[pscustomobject]@{path=(Join-Path $AppDataDirectory 'Microsoft\Windows\Start Menu\Programs\Startup\CodexDotsBridge.vbs');content='synthetic old startup'}})
  $script:oldConfigText=[IO.File]::ReadAllText((Join-Path $DataDir 'config.json'))
  $script:stopCount=0;$script:removeCount=0;$script:restartCount=0;$script:shortcutCount=0;$script:trayCount=0
}
function Resolve-SetupDataDirectory{return $DataDir}
function Assert-OwnedRegistration{return [pscustomobject]@{autostart=$true;mcp_present=$true;skill_complete=$true}}
function Test-CodexCommand{return $true}
function Resolve-OldRuntimeRoot{return $oldRoot}
function Prepare-UpgradeRuntime{return $true}
function Tray-Running{return $true}
function Test-InstallerRuntimeReady{return $true}
function Test-OriginalEndpointAuthentication{return $true}
function Stop-Tray{$script:stopCount++}
function Invoke-Bridge{$script:stopCount++;throw 'unexpected_stop_or_runtime_mutation'}
function Remove-Registration{$script:removeCount++;throw 'unexpected_uninstall'}
function Start-Tray{$script:trayCount++}
function Restore-TrayShortcut{$script:shortcutCount++}
function Rollback-CodexCommand{return $CodexCommand}
function Start-InstallerSupervisor{$script:restartCount++}

Case 'first_registration_rejected_before_any_stop_remove_or_data_change' {
  Fixture 'preflight';$stateText=[IO.File]::ReadAllText($statePath);$manifestText=[IO.File]::ReadAllText((Join-Path $DataDir 'installation.json'))
  [IO.File]::WriteAllText((Join-Path $DataDir 'service.lock'),'original pid 777');[IO.File]::WriteAllText((Join-Path $DataDir 'tasks.sqlite'),'original tasks and subscriptions sentinel')
  $LauncherSource=Join-Path $work 'incoming-launcher.exe';[IO.File]::WriteAllText($LauncherSource,'synthetic candidate executable')
  $LauncherFingerprint=(Get-FileHash -LiteralPath $LauncherSource -Algorithm SHA256).Hash.ToLowerInvariant();$LauncherSourceFingerprint='1'*64
  function Invoke-StableLauncher([string]$Action){if($Action -eq 'inspect'){return [pscustomobject]@{exists=$false;owned=$false;windows='enabled';legacy_windows='enabled'}};throw 'synthetic_startup_registration_denied'}
  $Action='Prepare';$Autostart=$true;$validatedDirectory=$false;$ownsTransaction=$false;$code=''
  . $lifecycle | Out-Null
  if($code -cne 'synthetic_startup_registration_denied' -or $stopCount -ne 0 -or $removeCount -ne 0 -or $restartCount -ne 0){throw 'Rejected registration reached service/registration mutation.'}
  if([IO.File]::ReadAllText($statePath) -cne $stateText -or [IO.File]::ReadAllText((Join-Path $DataDir 'installation.json')) -cne $manifestText -or [IO.File]::ReadAllText((Join-Path $DataDir 'service.lock')) -cne 'original pid 777' -or [IO.File]::ReadAllText((Join-Path $DataDir 'tasks.sqlite')) -cne 'original tasks and subscriptions sentinel'){throw 'Rejected registration changed original state.'}
  if(Test-Path -LiteralPath $transactionPath){throw 'Clean preflight failure retained a transaction.'}
}
Case 'same_launcher_source_keeps_authenticated_binary_and_same_link_without_save' {
  Fixture 'stable';$target=Join-Path $InstallDirectory 'CodexDotsBridge.Launcher.exe';[IO.File]::WriteAllText($target,'old authenticated executable with old PE timestamp')
  $oldHash=(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant();$oldTime=[IO.File]::GetLastWriteTimeUtc($target)
  $LauncherSource=Join-Path $work 'rebuilt-launcher.exe';[IO.File]::WriteAllText($LauncherSource,'same source new compiler PE timestamp');$LauncherFingerprint=(Get-FileHash -LiteralPath $LauncherSource -Algorithm SHA256).Hash.ToLowerInvariant();$LauncherSourceFingerprint='2'*64
  $prior=Read-Json $statePath;$prior | Add-Member launcher_sha256 $oldHash;$prior | Add-Member launcher_source_sha256 $LauncherSourceFingerprint
  $manifest=Read-Json (Join-Path $DataDir 'installation.json');$manifest.autostart | Add-Member kind 'startup-link';$manifest.autostart | Add-Member launcher $target;$manifest.autostart.path='synthetic.lnk';$manifest.autostart.content='exact-base64';Write-Json (Join-Path $DataDir 'installation.json') $manifest
  function Invoke-StableLauncher([string]$Action){if($Action -notin @('inspect','acknowledge')){throw 'Matching registration was rewritten.'};return [pscustomobject]@{exists=$true;owned=$true;content='exact-base64';path='synthetic.lnk';windows='disabled';legacy_windows='enabled'}}
  $transaction=[ordered]@{data_dir=$DataDir;autostart=$true};Prepare-StableStartup $transaction $prior
  if((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $oldHash -or [IO.File]::GetLastWriteTimeUtc($target) -ne $oldTime -or $transaction.prepared_autostart.content -cne 'exact-base64'){throw 'Stable source or disabled choice was changed.'}
}
function RecoveryOwnerFixture([string]$Name){
  Fixture $Name
  $script:target=Join-Path $InstallDirectory 'CodexDotsBridge.Launcher.exe';[IO.File]::WriteAllText($target,'authenticated launcher left by incomplete migration')
  $script:retainedHash=(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
  $script:LauncherSource=Join-Path $work ($Name+'-incoming.exe');[IO.File]::WriteAllText($LauncherSource,'same source rebuilt executable')
  $script:LauncherFingerprint=(Get-FileHash -LiteralPath $LauncherSource -Algorithm SHA256).Hash.ToLowerInvariant();$script:LauncherSourceFingerprint='3'*64
  $history=Join-Path $InstallDirectory 'recovery';New-Item -ItemType Directory -Path $history | Out-Null
  $script:recordPath=Join-Path $history 'exact-prior-transaction.json'
  $record=[pscustomobject]@{schema=1;owner='codex-dots-bridge-setup';installer_app_id=$InstallerIdentity;install_directory=$InstallDirectory;data_dir=$DataDir;old_root=$oldRoot;launcher_sha256=$retainedHash;launcher_source_sha256=$LauncherSourceFingerprint;prepared_autostart=[pscustomobject]@{kind='startup-link';path='inherited.lnk';launcher=$target;content='exact-prior-link'};recovery=[pscustomobject]@{core_restored=$true}}
  Write-Json $recordPath $record;$script:recordHash=(Get-FileHash -LiteralPath $recordPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $script:prior=Read-Json $statePath;$prior | Add-Member recovery_record $recordPath;$prior | Add-Member recovery_sha256 $recordHash;Write-Json $statePath $prior
  $script:inheritTransaction=[ordered]@{old_root=$oldRoot;data_dir=$DataDir;autostart=$true;previous_recovery=$recordPath;previous_recovery_sha256=$recordHash}
}
Case 'committed_recovery_reference_inherits_only_exact_launcher_and_link_without_rewriting' {
  RecoveryOwnerFixture 'inherit';$mtime=[IO.File]::GetLastWriteTimeUtc($target)
  function Invoke-StableLauncher([string]$Action){if($Action -notin @('inspect','acknowledge')){throw 'Inherited startup was rewritten.'};return [pscustomobject]@{exists=$true;owned=$true;content='exact-prior-link';path='inherited.lnk';windows='disabled';legacy_windows='enabled'}}
  Prepare-StableStartup $inheritTransaction $prior
  if($inheritTransaction.startup_inherited_from_recovery -cne $recordPath -or $inheritTransaction.prepared_autostart.content -cne 'exact-prior-link' -or [IO.File]::GetLastWriteTimeUtc($target) -ne $mtime -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $retainedHash){throw 'Recorded ownership was not transferred exactly.'}
}
Case 'modified_or_unbound_recovery_resources_fail_closed' {
  RecoveryOwnerFixture 'inherit-reject'
  function Invoke-StableLauncher([string]$Action){if($Action -ne 'inspect'){throw 'Foreign startup was mutated.'};return [pscustomobject]@{exists=$true;owned=$true;content='modified-link';path='inherited.lnk';windows='enabled';legacy_windows='enabled'}}
  try{Prepare-StableStartup $inheritTransaction $prior;throw 'Changed link was accepted.'}catch{if($_.Exception.Message -cne 'foreign_autostart_collision'){throw}}
  [IO.File]::AppendAllText($recordPath,"`n")
  try{Prepare-StableStartup $inheritTransaction $prior;throw 'Changed evidence was accepted.'}catch{if($_.Exception.Message -cne 'recovery_record_changed'){throw}}
  $state=Read-Json $statePath;$state.recovery_record='different-reference';Write-Json $statePath $state
  try{Prepare-StableStartup $inheritTransaction $prior;throw 'Unbound evidence was accepted.'}catch{if($_.Exception.Message -cne 'recovery_record_binding_mismatch'){throw}}
}
Case 'rollback_registration_failure_still_resumes_verified_backend_and_restores_shortcut' {
  Fixture 'rollback';$configPath=Join-Path $DataDir 'config.json';Write-Json $configPath ([pscustomobject]@{installation=[pscustomobject]@{root=$newRoot}})
  function Invoke-Bridge {return [pscustomobject]@{stopped=$true}}
  function Setup-Registration {throw 'synthetic_registration_restore_rejected'}
  function Test-InstallerRuntimeReady{return $false}
  $transaction=[pscustomobject]@{owner='codex-dots-bridge-setup';data_dir=$DataDir;app_data=$AppDataDirectory;old_root=$oldRoot;new_root=$newRoot;old_config=$oldConfig;old_config_text=$oldConfigText;was_running=$true;was_tray_running=$true;registration_changed=$true;stable_startup=$true;core_restored=$false;startup_created=$false;startup_creation_intent=$false;legacy_removed=$false;shortcut_path='synthetic shortcut';rollback_errors=@()}
  Write-Json $transactionPath $transaction
  try{Rollback-Transaction $transaction;throw 'Restore failure was accepted.'}catch{if($_.Exception.Message -cne 'synthetic_registration_restore_rejected'){throw}}
  if($restartCount -ne 1 -or $trayCount -ne 1 -or $shortcutCount -ne 1 -or -not (Test-Path -LiteralPath $transactionPath)){throw 'Independent rollback stages were skipped.'}
}
Case 'crash_after_legacy_delete_retains_new_startup_and_pending_intent' {
  Fixture 'delete-intent'
  $legacyPath=Join-Path $work 'synthetic-old.vbs';$nativePath=Join-Path $work 'synthetic-new.lnk';$launcherPath=Join-Path $InstallDirectory 'CodexDotsBridge.Launcher.exe'
  [IO.File]::WriteAllText($legacyPath,'owned legacy startup');[IO.File]::WriteAllText($nativePath,'owned replacement startup');[IO.File]::WriteAllText($launcherPath,'owned replacement launcher')
  $settings=[pscustomobject]@{data_dir=$DataDir;app_data=$AppDataDirectory;stable_startup=$true;old_manifest_text=(@{autostart=@{path=$legacyPath;content='owned legacy startup'}}|ConvertTo-Json -Depth 4);prepared_autostart=[pscustomobject]@{path=$nativePath;content='native-receipt'};legacy_removed=$false;startup_created=$true;startup_creation_intent=$false;was_running=$false;was_tray_running=$false;registration_changed=$false;rollback_errors=@()}
  Write-Json $transactionPath $settings
  $realWrite=(Get-Item Function:\Write-Json).ScriptBlock
  function Write-Json([string]$Path,$Value){if($Value.legacy_removed){throw 'synthetic_post_delete_crash'};& $realWrite $Path $Value}
  function Invoke-StableLauncher([string]$Action){if($Action -ne 'inspect'){throw 'Replacement startup was removed after an uncertain legacy delete.'};return [pscustomobject]@{exists=$true;owned=$true;content='native-receipt'}}
  try{Complete-StableStartupMigration $settings;throw 'Crash injection was not reached.'}catch{if($_.Exception.Message -cne 'synthetic_post_delete_crash'){throw}}
  $persisted=Read-Json $transactionPath
  if($persisted.legacy_removed -or -not $persisted.legacy_removal_intent -or (Test-Path -LiteralPath $legacyPath)){throw 'Delete intent was not durable before the deletion.'}
  try{Rollback-Transaction $persisted;throw 'Uncertain legacy deletion was silently accepted.'}catch{if($_.Exception.Message -cne 'rollback_legacy_autostart_requires_recovery'){throw}}
  if(-not (Test-Path -LiteralPath $transactionPath) -or [IO.File]::ReadAllText($nativePath) -cne 'owned replacement startup' -or [IO.File]::ReadAllText($launcherPath) -cne 'owned replacement launcher'){throw 'Interrupted migration lost its replacement or evidence.'}
}
Case 'uninstall_rejects_replaced_launcher_even_without_startup_registration' {
  Fixture 'uninstall-hash';$target=Join-Path $InstallDirectory 'CodexDotsBridge.Launcher.exe';[IO.File]::WriteAllText($target,'owned launcher')
  $state=Read-Json $statePath;$state | Add-Member launcher_sha256 ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant())
  Assert-StableLauncherIdentity $state
  [IO.File]::WriteAllText($target,'user replacement launcher')
  try{Assert-StableLauncherIdentity $state;throw 'Foreign launcher was accepted for uninstall.'}catch{if($_.Exception.Message -cne 'modified_or_foreign_launcher'){throw}}
  if([IO.File]::ReadAllText($target) -cne 'user replacement launcher'){throw 'Uninstall identity guard altered the foreign file.'}
}
Case 'explicit_recovery_keeps_evidence_and_does_not_stop_already_restored_old_runtime' {
  Fixture 'recovery'
  [IO.File]::WriteAllText((Join-Path $DataDir 'service.lock'),'synthetic authenticated original owner')
  $transaction=[pscustomobject]@{schema=1;owner='codex-dots-bridge-setup';install_directory=$InstallDirectory;installer_app_id=$InstallerIdentity;version='0.2.0-alpha.23';new_root=(Join-Path $InstallDirectory 'payload\0.2.0-alpha.23');old_root=$oldRoot;data_dir=$DataDir;codex_home=$CodexHome;app_data=$AppDataDirectory;old_config=$oldConfig;old_config_text=$oldConfigText;was_running=$true;was_tray_running=$true;shortcut_path=''}
  Write-Json $transactionPath $transaction;$Action='RecoverRollback';$DeferAutostart=$false;$validatedDirectory=$false;$ownsTransaction=$false;$code=''
  . $lifecycle | Out-Null
  if($code -cne 'recovery_verified_requires_explicit_defer' -or -not (Test-Path -LiteralPath $transactionPath)){throw 'Recovery silently cleared pending transaction.'}
  $DeferAutostart=$true;$code='';. $lifecycle | Out-Null
  $restored=Read-Json $statePath
  if($code -or (Test-Path -LiteralPath $transactionPath) -or -not (Test-Path -LiteralPath $restored.recovery_record) -or $restored.recovery_sha256 -cne (Get-FileHash -LiteralPath $restored.recovery_record -Algorithm SHA256).Hash.ToLowerInvariant() -or $stopCount -ne 0 -or $restartCount -ne 0 -or $removeCount -ne 0){throw 'Recovery evidence transfer or original runtime preservation failed.'}
  $record=Read-Json $restored.recovery_record;if(-not $record.recovery.core_restored -or -not $record.recovery.autostart_missing -or $record.old_config_text -cne $oldConfigText){throw 'Recovery discarded original transaction facts.'}
}
[pscustomobject]@{checks=$results;test_directory=$work;runtime='synthetic adapters';startup='isolated synthetic receipts';production='not_touched'} | ConvertTo-Json -Depth 5
