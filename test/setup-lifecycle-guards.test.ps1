[CmdletBinding()]
param([string]$TestDirectory)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'shell-link-fixture.ps1')
$projectRoot=Split-Path -Parent $PSScriptRoot
if(-not $TestDirectory) { $TestDirectory=Join-Path $projectRoot 'artifacts\private\lifecycle-guards' }
$work=Join-Path ([IO.Path]::GetFullPath($TestDirectory)) ([Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force | Out-Null
$script=Join-Path $projectRoot 'scripts\setup-lifecycle.ps1'
$shell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$results=[Collections.Generic.List[object]]::new()
function Rejected([string]$Name,[string]$Expected,[string]$App,[string]$Data,[string]$CodexDirectory,[string]$Command=$shell) {
  $output=@(& $shell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script -Action Prepare -InstallDirectory $App -NewVersion 0.2.0-alpha.7 -PackageFingerprint ('0'*64) -InstallerIdentity CodexDotsBridgeSetup -DataDir $Data -CodexHome $CodexDirectory -CodexCommand $Command -AppDataDirectory (Join-Path $work '隔离 AppData'))
  if($LASTEXITCODE -eq 0 -or ($output -join '') -notmatch [regex]::Escape($Expected)) { throw ('Unexpected guard result: '+$Name) }
  $results.Add([pscustomobject]@{name=$Name;passed=$true;error=$Expected})
}
$foreignApp=Join-Path $work 'foreign 程序';New-Item -ItemType Directory -Path $foreignApp | Out-Null
$file=Join-Path $foreignApp 'preserve.txt';[IO.File]::WriteAllText($file,'keep')
Rejected 'foreign_program_directory' 'foreign_install_directory_entry' $foreignApp (Join-Path $work 'unused-data') (Join-Path $work 'unused-home')
if(@(Get-ChildItem -LiteralPath $foreignApp -Force).Count -ne 1 -or [IO.File]::ReadAllText($file) -cne 'keep') { throw 'Foreign program directory was changed.' }
$foreignData=Join-Path $work 'foreign 数据';New-Item -ItemType Directory -Path $foreignData | Out-Null
$configPath=Join-Path $foreignData 'config.json';$foreignConfig='{"owner":"synthetic_foreign"}';[IO.File]::WriteAllText($configPath,$foreignConfig)
Rejected 'foreign_data_directory' 'unowned_data_directory' (Join-Path $work 'new app') $foreignData (Join-Path $work 'fresh-home')
if([IO.File]::ReadAllText($configPath) -cne $foreignConfig -or @(Get-ChildItem -LiteralPath $foreignData -Force).Count -ne 1) { throw 'Foreign data was changed.' }
$CodexDirectory=Join-Path $work "Codex O'Brien `$literal";$skill=Join-Path $CodexDirectory 'skills\codex-dots-bridge';New-Item -ItemType Directory -Path $skill -Force | Out-Null
$skillPath=Join-Path $skill 'SKILL.md';[IO.File]::WriteAllText($skillPath,'user-owned')
Rejected 'foreign_skill_directory' 'foreign_or_modified_skill_collision' (Join-Path $work 'skill app') (Join-Path $work 'skill data') $CodexDirectory
if([IO.File]::ReadAllText($skillPath) -cne 'user-owned') { throw 'Foreign Skill changed.' }
$emptyApp=Join-Path $work 'existing empty app';New-Item -ItemType Directory -Path $emptyApp | Out-Null
Rejected 'missing_cli_keeps_existing_empty_directory_retryable' 'official_codex_cli_missing' $emptyApp (Join-Path $work 'retry data') $CodexDirectory (Join-Path $work 'missing.exe')
if(@(Get-ChildItem -LiteralPath $emptyApp -Force).Count) { throw 'Prepare failure changed an existing empty directory.' }
Rejected 'fixed_prerequisite_reaches_next_guard' 'foreign_or_modified_skill_collision' $emptyApp (Join-Path $work 'retry data') $CodexDirectory
$overlap=Join-Path $work 'overlap'
Rejected 'data_inside_program_directory' 'data_program_path_overlap' $overlap (Join-Path $overlap 'data') (Join-Path $work 'overlap-home')
Rejected 'program_inside_data_directory' 'data_program_path_overlap' (Join-Path $overlap 'program') $overlap (Join-Path $work 'overlap-home')
# Exercise the exact lifecycle functions against locally compiled, synthetic native CLIs.
$selectionErrors=$null;$selectionTokens=$null
$selectionAst=[Management.Automation.Language.Parser]::ParseFile($script,[ref]$selectionTokens,[ref]$selectionErrors)
foreach($name in @('Assert-SafePath','Select-TunnelClientForUpgrade','Assert-RuntimeLocksReleased','Runtime-Node','Write-Json','Read-Json','Tray-Path','Tray-Running','Stop-Tray','Invoke-TrayCommand','Start-Tray','Assert-NoInFlightTasks','Get-UpgradeRuntimeStatus','Prepare-UpgradeRuntime','Assert-State','Assert-OldCliIdentity','Test-CodexCommand','Rollback-CodexCommand','Read-FallbackState','Resolve-OldRuntimeRoot','Restore-TrayShortcut','Rollback-Transaction','Prepare-StableStartup','Invoke-StableLauncher','Complete-StableStartupMigration','Assert-Transaction','Test-JsonEquivalent','Read-OriginalRuntimeSnapshot','Test-OriginalEndpointAuthentication','Set-TransactionProperty','Assert-StableLauncherIdentity')) {
  $definition=$selectionAst.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
  if(-not $definition) { throw ('Lifecycle function missing: '+$name) }
  . ([ScriptBlock]::Create($definition.Extent.Text))
}
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
function Test-OriginalEndpointAuthentication {return $true} # Synthetic readiness adapters above do not bind HTTP ports.
function Fixture([string]$Name,[string]$Body) {
  $source=Join-Path $work ($Name+'.cs');$exe=Join-Path $work ($Name+'.exe')
  [IO.File]::WriteAllText($source,('using System; public static class Fixture { public static int Main(string[] args) { if(args.Length!=3 || args[0]!="mcp" || args[1]!="list" || args[2]!="--json") return 19; '+$Body+' } }'),[Text.UTF8Encoding]::new($false))
  & $compiler /nologo /codepage:65001 ('/out:'+$exe) $source | Out-Null
  if($LASTEXITCODE -ne 0) { throw 'Synthetic CLI fixture compilation failed.' }
  return $exe
}
$originalCli=Fixture 'original owned CLI' 'Console.WriteLine("[]"); return 0;'
$replacementCli=Fixture 'verified replacement CLI' 'Console.WriteLine("[]"); return 0;'
$failedCli=Fixture 'nonfunctional old CLI' 'return 11;'
$invalidCli=Fixture 'invalid list CLI' 'Console.WriteLine("[{}]"); return 0;'
$malformedCli=Fixture 'malformed JSON CLI' 'Console.WriteLine("[{broken"); return 0;'
$slowCli=Fixture 'timeout CLI' 'System.Threading.Thread.Sleep(20000); Console.WriteLine("[]"); return 0;'
$corruptCli=Join-Path $work 'corrupt old CLI.exe';[IO.File]::WriteAllText($corruptCli,'synthetic invalid executable')
function Selection([string]$Old,[string]$Replacement=$replacementCli) {
  Rollback-CodexCommand ([pscustomobject]@{old_codex_command=$Old;codex_command=$Replacement;old_root=$projectRoot;codex_home=(Join-Path $work 'synthetic home')})
}
if((Selection $originalCli) -cne $originalCli) { throw 'Rollback did not prefer the usable original owned CLI.' }
$results.Add([pscustomobject]@{name='rollback_prefers_original_owned_cli';passed=$true})
$removedCli=Join-Path $work 'removed original CLI.exe'
foreach($case in @(@('removed',$removedCli),@('nonfunctional',$failedCli),@('corrupt',$corruptCli),@('invalid_schema',$invalidCli),@('malformed_json',$malformedCli),@('timeout',$slowCli))) {
  $clock=[Diagnostics.Stopwatch]::StartNew()
  if((Selection $case[1]) -cne $replacementCli) { throw ('Rollback accepted unusable old CLI: '+$case[0]) }
  if($case[0] -eq 'timeout' -and $clock.Elapsed.TotalSeconds -gt 16) { throw 'CLI probe did not respect its timeout.' }
  $results.Add([pscustomobject]@{name=('rollback_'+$case[0]+'_uses_verified_replacement');passed=$true})
}
try { Selection $removedCli (Join-Path $work 'removed replacement.exe') | Out-Null; throw 'Missing rollback CLIs accepted.' } catch { if($_.Exception.Message -ne 'no_usable_codex_cli_for_rollback') { throw } }
$results.Add([pscustomobject]@{name='rollback_requires_an_available_verified_cli';passed=$true})
Assert-OldCliIdentity ([pscustomobject]@{codex_command=$originalCli}) ([pscustomobject]@{codex_command=$originalCli})
Assert-OldCliIdentity $null ([pscustomobject]@{codex_command=$originalCli})
try { Assert-OldCliIdentity ([pscustomobject]@{codex_command=$originalCli}) ([pscustomobject]@{codex_command=$replacementCli}); throw 'Mismatched old CLI identity accepted.' } catch { if($_.Exception.Message -ne 'installer_cli_identity_mismatch') { throw } }
$results.Add([pscustomobject]@{name='old_cli_identity_matches_prior_state_or_explicit_legacy_manifest';passed=$true})
# Synthetic registration adapters isolate state recovery from real Codex, services and registry.
$InstallDirectory=Join-Path $work 'state app';New-Item -ItemType Directory -Path $InstallDirectory | Out-Null
$statePath=Join-Path $InstallDirectory 'installation-state.json';$transactionPath=Join-Path $InstallDirectory '.setup-transaction.json'
$data=Join-Path $work 'state data';New-Item -ItemType Directory -Path $data | Out-Null
$oldRoot=Join-Path $InstallDirectory 'payload\0.2.0-alpha.5'
$fixtureNode=Runtime-Node $projectRoot
function Runtime-Node([string]$Root) { return $fixtureNode }
function Assert-OwnedRegistration { }
function Remove-Registration { $script:registrationChanges++ }
function Setup-Registration([string]$Root,$Settings,[bool]$EnableAutostart,[string]$TunnelClient,[string]$Command) { $script:registrationChanges++;Write-Json (Join-Path $Settings.data_dir 'installation.json') ([pscustomobject]@{codex_command=$Command}) }
$priorState=[pscustomobject]@{owner='codex-dots-bridge-setup';schema=1;install_directory=$InstallDirectory;installer_app_id='CodexDotsBridgeSetup';version='0.2.0-alpha.5';payload_root=$oldRoot;codex_command=$failedCli;data_dir=$data;codex_home=(Join-Path $work 'state home');app_data=(Join-Path $work 'state AppData');retained_field='unchanged'}
$transaction=[pscustomobject]@{old_codex_command=$failedCli;codex_command=$replacementCli;old_installer_state=$true;old_root=$oldRoot;codex_home=$priorState.codex_home;installer_app_id=$priorState.installer_app_id;data_dir=$data;app_data=$priorState.app_data;registration_changed=$true;old_config_text='';old_autostart=$false;was_running=$false;current_registration_root=$oldRoot}
Write-Json $statePath $priorState;$script:registrationChanges=0
Rollback-Transaction $transaction
$restored=Read-Json $statePath;$manifest=Read-Json (Join-Path $data 'installation.json')
Assert-OldCliIdentity $restored $manifest
if($restored.codex_command -cne $replacementCli -or $script:registrationChanges -ne 1) { throw 'Fallback did not synchronize restored CLI identity.' }
foreach($property in $priorState.PSObject.Properties) { if($property.Name -ne 'codex_command' -and $property.Value -cne $restored.($property.Name)) { throw 'Fallback changed another installer state field.' } }
$results.Add([pscustomobject]@{name='fallback_preserves_other_state_and_next_prepare_identity_gate';passed=$true})
Write-Json $statePath $priorState;$changed=Read-Json $statePath;$changed.codex_command=$originalCli;Write-Json $statePath $changed;$script:registrationChanges=0
try { Rollback-Transaction $transaction; throw 'Changed prior state accepted.' } catch { if($_.Exception.Message -ne 'rollback_installer_state_changed') { throw } }
if($script:registrationChanges -ne 0) { throw 'Changed state rejected after registration mutation.' }
$results.Add([pscustomobject]@{name='fallback_rejects_changed_state_before_registration_mutation';passed=$true})
$priorState.codex_command=$originalCli;Write-Json $statePath $priorState
$normalStateText=[IO.File]::ReadAllText($statePath);$transaction.old_codex_command=$originalCli
Rollback-Transaction $transaction
if([IO.File]::ReadAllText($statePath) -cne $normalStateText) { throw 'Usable original CLI rollback changed prior state bytes.' }
$results.Add([pscustomobject]@{name='usable_original_cli_rollback_preserves_exact_state_bytes';passed=$true})
$transaction.old_codex_command=$removedCli;$transaction.codex_command=(Join-Path $work 'missing fallback.exe')
[IO.File]::WriteAllText($transactionPath,'synthetic pending transaction');$script:registrationChanges=0
try { Rollback-Transaction $transaction; throw 'Rollback without usable CLI accepted.' } catch { if($_.Exception.Message -ne 'no_usable_codex_cli_for_rollback') { throw } }
if($script:registrationChanges -ne 0 -or -not (Test-Path -LiteralPath $transactionPath)) { throw 'Missing CLI rollback changed registrations or cleared pending transaction.' }
$results.Add([pscustomobject]@{name='no_usable_cli_preserves_pending_transaction_and_registrations';passed=$true})
$transaction.old_codex_command=$failedCli;$transaction.codex_command=$replacementCli;$priorState.codex_command=$failedCli;Write-Json $statePath $priorState
$beforeFailedRestore=[IO.File]::ReadAllText($statePath)
function Setup-Registration { throw 'synthetic_registration_restore_failed' }
try { Rollback-Transaction $transaction; throw 'Failed registration restore accepted.' } catch { if($_.Exception.Message -ne 'synthetic_registration_restore_failed') { throw } }
if([IO.File]::ReadAllText($statePath) -cne $beforeFailedRestore -or -not (Test-Path -LiteralPath $transactionPath)) { throw 'Failed registration restore wrote fallback state or cleared transaction.' }
$results.Add([pscustomobject]@{name='failed_registration_restore_preserves_state_and_pending_transaction';passed=$true})
function Setup-Registration([string]$Root,$Settings,[bool]$EnableAutostart,[string]$TunnelClient,[string]$Command) { $script:registrationChanges++;Write-Json (Join-Path $Settings.data_dir 'installation.json') ([pscustomobject]@{codex_command=$Command});[IO.File]::AppendAllText($statePath,"`n") }
try { Rollback-Transaction $transaction; throw 'Concurrent state change accepted.' } catch { if($_.Exception.Message -ne 'rollback_installer_state_changed') { throw } }
if(-not (Test-Path -LiteralPath $transactionPath) -or (Read-Json $statePath).codex_command -cne $failedCli) { throw 'Concurrent state change was overwritten or transaction cleared.' }
$results.Add([pscustomobject]@{name='fallback_rechecks_concurrent_state_before_write';passed=$true})
function Setup-Registration([string]$Root,$Settings,[bool]$EnableAutostart,[string]$TunnelClient,[string]$Command) { $script:registrationChanges++;Write-Json (Join-Path $Settings.data_dir 'installation.json') ([pscustomobject]@{codex_command=$Command}) }
Remove-Item -LiteralPath $statePath;$transaction.old_installer_state=$false;$script:registrationChanges=0
Rollback-Transaction $transaction
if(Test-Path -LiteralPath $statePath) { throw 'Legacy fallback invented installer state.' }
$results.Add([pscustomobject]@{name='legacy_fallback_does_not_create_prior_installer_state';passed=$true})
# Run the actual Prepare/Commit/catch blocks with synthetic registration/runtime adapters.
# The old runtime deliberately reports stop success while retaining locks, matching alpha.8.
$lifecycleTry=@($selectionAst.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })[-1]
$body=(@($lifecycleTry.Body.Statements | Where-Object { $_ -isnot [Management.Automation.Language.ExitStatementAst] } | ForEach-Object { $_.Extent.Text }) -join "`n")
$catchBody=(@($lifecycleTry.CatchClauses[0].Body.Statements | Where-Object { $_ -isnot [Management.Automation.Language.ExitStatementAst] } | ForEach-Object { $_.Extent.Text }) -join "`n")
$lifecycleBody=[ScriptBlock]::Create("try {`n$body`n} catch {`n$catchBody`n}")
function Assert-State { }
function Resolve-SetupDataDirectory { return $DataDir }
function Assert-OwnedRegistration { return [pscustomobject]@{autostart=$false} }
function Assert-FreshRegistration { }
function Test-CodexCommand { return $true }
function Resolve-OldRuntimeRoot { return $script:fixtureOldRoot }
function Rollback-CodexCommand { return $originalCli }
function Read-FallbackState { return $null }
function Invoke-InstallerRecovery { return @{clearPreviousState=$false;reason='requires_manual_recovery'} }
function Test-InstallerRuntimeReady { return $script:fixtureStatus.supervisor -eq 'running' -and $script:fixtureStatus.service -eq 'running' }
function Start-InstallerSupervisor([string]$Root,[string]$Directory) {Invoke-Bridge $Root @('run','--supervisor','--data-dir',$Directory)|Out-Null}
function Invoke-Bridge([string]$Root,[string[]]$BridgeArgs) {
  if($BridgeArgs[0] -eq 'status') { return $script:fixtureStatus }
  if($BridgeArgs -contains '--stop') {
    $script:stopCalls++
    if($script:releaseLocks) {
      foreach($name in @('service.lock','supervisor.lock')) { Remove-Item -LiteralPath (Join-Path $DataDir $name) -ErrorAction SilentlyContinue }
      $script:fixtureStatus=[pscustomobject]@{supervisor='stopped';service='stopped'}
    }
    return [pscustomobject]@{supervisor='stopped'}
  }
  throw 'unexpected_synthetic_runtime_operation'
}
function Remove-Registration {
  $script:registrationChanges++;Remove-Item -LiteralPath (Join-Path $DataDir 'installation.json')
  if($script:failPartialUninstall) { throw 'synthetic_partial_uninstall_failed' }
}
function Setup-Registration([string]$Root,$Settings) {
  $script:registrationChanges++
  if($script:failNewRegistration -and $Root -cne $script:fixtureOldRoot) { throw 'synthetic_registration_restore_failed' }
  Write-Json (Join-Path $DataDir 'installation.json') ([pscustomobject]@{codex_command=$originalCli;mcp=[pscustomobject]@{args=@((Join-Path $Root 'dist\main.js'))}})
}
function Lifecycle-LockCase([string]$Name,[string]$Stage,[string]$LockName,[bool]$Running=$false,[bool]$FailNewRegistration=$false,[bool]$FailPartialUninstall=$false) {
  $InstallDirectory=Join-Path $work $Name;$DataDir=Join-Path $work ($Name+' data')
  $CodexHome=Join-Path $work ($Name+' home');$CodexCommand=$originalCli;$AppDataDirectory=Join-Path $work ($Name+' AppData')
  $InstallerIdentity='CodexDotsBridgeSetup';$NewVersion='0.2.0-alpha.9';$Autostart=$false
  $statePath=Join-Path $InstallDirectory 'installation-state.json';$transactionPath=Join-Path $InstallDirectory '.setup-transaction.json';$resultPath=Join-Path $InstallDirectory '.setup-result.txt'
  $script:fixtureOldRoot=Join-Path $InstallDirectory 'payload\0.2.0-alpha.8'
  New-Item -ItemType Directory -Path $script:fixtureOldRoot,$DataDir -Force | Out-Null
  $newRoot=Join-Path $InstallDirectory ('payload\'+$NewVersion)
  # Hash matching remains real; only package validation and external runtime/registration are synthetic.
  $manifestText='{"synthetic":"package identity"}'
  $sha=[Security.Cryptography.SHA256]::Create();try { $PackageFingerprint=([BitConverter]::ToString($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($manifestText)))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
  Write-Json $statePath ([pscustomobject]@{owner='codex-dots-bridge-setup';schema=1;installer_app_id=$InstallerIdentity;version='0.2.0-alpha.8';payload_root=$script:fixtureOldRoot;data_dir=$DataDir;codex_home=$CodexHome;app_data=$AppDataDirectory;codex_command=$originalCli})
  Write-Json (Join-Path $DataDir 'config.json') ([pscustomobject]@{owner='codex-dots-bridge';synthetic_retained='keep'})
  Setup-Registration $script:fixtureOldRoot $null
  $fixtureStateText=[IO.File]::ReadAllText($statePath);$fixtureConfigText=[IO.File]::ReadAllText((Join-Path $DataDir 'config.json'));$fixtureManifestText=[IO.File]::ReadAllText((Join-Path $DataDir 'installation.json'))
  $script:registrationChanges=0;$script:stopCalls=0;$script:releaseLocks=$Stage -eq 'normal';$script:failNewRegistration=$FailNewRegistration;$script:failPartialUninstall=$FailPartialUninstall
  $script:fixtureStatus=[pscustomobject]@{supervisor=$(if($Running){'running'}else{'stopped'});service=$(if($Running){'running'}elseif($LockName -eq 'service.lock' -and $Stage -eq 'initial'){'stale_lock'}else{'stopped'});tasks=[pscustomobject]@{}}
  $lockText='synthetic unknown lock retained verbatim'
  if($Stage -ne 'commit' -and $LockName) { [IO.File]::WriteAllText((Join-Path $DataDir $LockName),$lockText) }
  if($Stage -eq 'normal' -and $Running) { [IO.File]::WriteAllText((Join-Path $DataDir 'supervisor.lock'),$lockText) }
  $Action='Prepare';$validatedDirectory=$false;$ownsTransaction=$false;$code=''
  . $lifecycleBody | Out-Null
  if($Stage -eq 'commit' -or $Stage -eq 'normal') {
    if($code -or -not (Test-Path -LiteralPath $transactionPath)) { throw ('Synthetic Prepare failed: '+$Name) }
    $preparedData=[IO.File]::ReadAllBytes($resultPath)
    if([Text.Encoding]::UTF8.GetString($preparedData) -cne $DataDir -or [Convert]::ToBase64String($preparedData) -cne [Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes($DataDir))) { throw ('Prepare shortcut result did not preserve the resolved UTF-8 data directory: '+$Name) }
    New-Item -ItemType Directory -Path (Join-Path $newRoot 'scripts') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $newRoot 'release-manifest.json'),$manifestText,[Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $newRoot 'scripts\check-package.ps1'),'# synthetic package check')
    if($Stage -eq 'commit') { [IO.File]::WriteAllText((Join-Path $DataDir $LockName),$lockText) }
    $Action='Commit';$validatedDirectory=$false;$ownsTransaction=$false;$code=''
    . $lifecycleBody | Out-Null
  }
  if($Stage -eq 'normal' -and -not $FailNewRegistration -and -not $FailPartialUninstall) {
    if($code -or $script:registrationChanges -ne 2 -or (Read-Json $statePath).version -cne $NewVersion) { throw ('Normal upgrade failed: '+$Name) }
    if((Test-Path -LiteralPath (Join-Path $DataDir 'service.lock')) -or (Test-Path -LiteralPath (Join-Path $DataDir 'supervisor.lock'))) { throw ('Normal upgrade retained a runtime lock: '+$Name) }
    if([IO.File]::ReadAllText($resultPath) -cne (Read-Json $statePath).connection) { throw ('Commit did not replace the Prepare shortcut result with its connection outcome: '+$Name) }
  } else {
    $expected=if($FailPartialUninstall){'synthetic_partial_uninstall_failed'}elseif($FailNewRegistration){'synthetic_registration_restore_failed'}else{'stale_lock_requires_recovery'}
    if($code -cne $expected) { throw ('Unexpected lifecycle lock result: '+$Name+' '+$code) }
    if($script:registrationChanges -ne $(if($FailPartialUninstall){2}elseif($FailNewRegistration){3}else{0})) { throw ('Incorrect registration changes: '+$Name) }
    if([IO.File]::ReadAllText($statePath) -cne $fixtureStateText -or [IO.File]::ReadAllText((Join-Path $DataDir 'config.json')) -cne $fixtureConfigText -or [IO.File]::ReadAllText((Join-Path $DataDir 'installation.json')) -cne $fixtureManifestText) { throw ('Guard/rollback changed original registration or data: '+$Name) }
    if($LockName -and [IO.File]::ReadAllText((Join-Path $DataDir $LockName)) -cne $lockText) { throw ('Unknown lock was changed: '+$Name) }
    if($Stage -eq 'initial' -and $script:stopCalls -ne 0) { throw ('Initial stale lock reached stop: '+$Name) }
  }
  if(Test-Path -LiteralPath $transactionPath) { throw ('Resolved lifecycle retained transaction: '+$Name) }
  $results.Add([pscustomobject]@{name=$Name;passed=$true;runtime='synthetic_old_stop_adapter'})
}
Lifecycle-LockCase 'initial_stale_service_blocks_before_transaction' 'initial' 'service.lock'
Lifecycle-LockCase 'initial_stale_supervisor_blocks_before_transaction' 'initial' 'supervisor.lock'
Lifecycle-LockCase 'prepare_stop_success_with_service_lock_blocks_before_copy' 'post_stop' 'service.lock' $true
Lifecycle-LockCase 'prepare_stop_success_with_supervisor_lock_blocks_before_copy' 'post_stop' 'supervisor.lock' $true
Lifecycle-LockCase 'commit_new_service_lock_blocks_before_registration' 'commit' 'service.lock'
Lifecycle-LockCase 'commit_new_supervisor_lock_blocks_before_registration' 'commit' 'supervisor.lock'
Lifecycle-LockCase 'normal_running_upgrade_releases_locks' 'normal' 'service.lock' $true
Lifecycle-LockCase "shortcut 中文 O'Brien `$literal" 'normal' ''
Lifecycle-LockCase 'new_registration_failure_still_rolls_back' 'normal' '' $false $true
Lifecycle-LockCase 'partial_uninstall_failure_still_rolls_back' 'normal' '' $false $false $true

# A failed UI launch can occur after the new backend has started. Exercise
# rollback with live-lock fixtures so uninstall cannot silently skip that stop.
function Tray-RollbackCase([bool]$ReleaseLocks) {
  $case=if($ReleaseLocks){'tray_failure_stops_new_backend_before_restore'}else{'tray_failure_unreleased_backend_preserves_recovery_transaction'}
  $DataDir=Join-Path $work ($case+' data');$InstallDirectory=Join-Path $work $case
  New-Item -ItemType Directory -Path $DataDir,$InstallDirectory -Force | Out-Null
  $transactionPath=Join-Path $InstallDirectory '.setup-transaction.json';$statePath=Join-Path $InstallDirectory 'installation-state.json'
  $old=Join-Path $InstallDirectory 'payload\old';$new=Join-Path $InstallDirectory 'payload\new'
  $oldConfigText='{"owner":"codex-dots-bridge","synthetic_binding":"old"}'
  Write-Json $transactionPath ([pscustomobject]@{synthetic_pending='retained'})
  Write-Json $statePath ([pscustomobject]@{synthetic_version='old'})
  Write-Json (Join-Path $DataDir 'config.json') ([pscustomobject]@{synthetic_binding='new'})
  Write-Json (Join-Path $DataDir 'installation.json') ([pscustomobject]@{synthetic_binding='new'})
  foreach($name in @('service.lock','supervisor.lock')) { [IO.File]::WriteAllText((Join-Path $DataDir $name),'synthetic new backend lock') }
  $calls=[Collections.Generic.List[string]]::new()
  function Stop-Tray { $calls.Add('tray_stop') }
  function Test-InstallerRuntimeReady { return $false }
  function Resolve-OldRuntimeRoot { return $old }
  function Invoke-Bridge([string]$Root,[string[]]$BridgeArgs) {
    if($BridgeArgs -contains '--stop') {
      if($Root -cne $new) { throw 'wrong_backend_stopped' }
      $calls.Add('new_backend_stop')
      if($ReleaseLocks) { foreach($name in @('service.lock','supervisor.lock')) { Remove-Item -LiteralPath (Join-Path $DataDir $name) } }
      return [pscustomobject]@{supervisor='stopped'}
    }
    if($BridgeArgs[0] -eq 'status') { return [pscustomobject]@{supervisor='stopped';service='stopped'} }
    if($BridgeArgs[0] -eq 'run' -and $Root -ceq $old) { $calls.Add('old_backend_restart');return [pscustomobject]@{supervisor='running'} }
    throw 'unexpected_rollback_backend_operation'
  }
  function Remove-Registration { Assert-RuntimeLocksReleased $DataDir; $calls.Add('new_registration_remove') }
  function Setup-Registration { $calls.Add('old_registration_restore') }
  $settings=[pscustomobject]@{old_root=$old;new_root=$new;old_runtime_root=$old;old_config=[pscustomobject]@{};old_config_text=$oldConfigText;old_autostart=$false;was_running=$true;was_tray_running=$false;registration_changed=$true;current_registration_root=$new;data_dir=$DataDir;app_data=(Join-Path $work 'synthetic AppData');codex_home=(Join-Path $work 'synthetic home');codex_command=$originalCli}
  if($ReleaseLocks) {
    Rollback-Transaction $settings
    if(($calls -join ',') -cne 'tray_stop,new_backend_stop,new_registration_remove,old_registration_restore,old_backend_restart') { throw 'Rollback did not stop the new backend before restoring and restarting old components.' }
    if([IO.File]::ReadAllText((Join-Path $DataDir 'config.json')) -cne $oldConfigText -or (Test-Path -LiteralPath $transactionPath)) { throw 'Successful UI failure rollback did not restore original configuration and close its transaction.' }
  } else {
    try { Rollback-Transaction $settings;throw 'Unreleased new backend accepted during rollback.' } catch { if($_.Exception.Message -cne 'stale_lock_requires_recovery'){throw} }
    if(($calls -join ',') -cne 'tray_stop,new_backend_stop' -or -not (Test-Path -LiteralPath $transactionPath)) { throw 'Failed new backend stop changed registrations or erased the recovery transaction.' }
  }
  $results.Add([pscustomobject]@{name=$case;passed=$true;runtime='synthetic_started_new_backend'})
}
Tray-RollbackCase $true
Tray-RollbackCase $false
# Real file hashes with synthetic bytes: no executable is run and no account
# key is read. The selected manifest is trusted by the actual Commit gate.
$tunnelRoot=Join-Path $work "Tunnel O'Brien `$literal"
$tunnelNew=Join-Path $tunnelRoot 'new payload'
$tunnelOld=Join-Path $tunnelRoot 'old payload'
$tunnelRelative='vendor/tunnel-client-v0.0.16-windows-amd64/tunnel-client.exe'
$tunnelNext=Join-Path $tunnelNew $tunnelRelative
New-Item -ItemType Directory -Path (Split-Path -Parent $tunnelNext) -Force | Out-Null
$externalClient=Join-Path $tunnelRoot 'external official.exe'
$customClient=Join-Path $tunnelRoot 'tunnel-client.exe'
[IO.File]::WriteAllText($tunnelNext,'synthetic official binary identity')
Copy-Item -LiteralPath $tunnelNext -Destination $externalClient
[IO.File]::WriteAllText($customClient,'synthetic custom binary identity')
$tunnelDigest=(Get-FileHash -LiteralPath $tunnelNext -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Json (Join-Path $tunnelNew 'release-manifest.json') ([pscustomobject]@{files=@([pscustomobject]@{path=$tunnelRelative;sha256=$tunnelDigest})})
$tunnelSettings=[pscustomobject]@{new_root=$tunnelNew;old_root=$tunnelOld;old_config=[pscustomobject]@{tunnel=[pscustomobject]@{client_path=$externalClient;tunnel_id='synthetic';organization_id='synthetic';key_file='synthetic-private-key-reference'}}}
$tunnelBefore=$tunnelSettings|ConvertTo-Json -Depth 8
if((Select-TunnelClientForUpgrade $tunnelSettings) -cne $tunnelNext -or ($tunnelSettings|ConvertTo-Json -Depth 8) -cne $tunnelBefore -or -not (Test-Path -LiteralPath $externalClient)){throw 'External official migration mutated original config or executable'}
$results.Add([pscustomobject]@{name='external_official_hash_migrates_without_mutating_original';passed=$true})
$tunnelSettings.old_config.tunnel.client_path=$customClient
if((Select-TunnelClientForUpgrade $tunnelSettings) -cne '' -or [IO.File]::ReadAllText($customClient) -cne 'synthetic custom binary identity'){throw 'Custom client replaced based on filename'}
$results.Add([pscustomobject]@{name='different_custom_binary_keeps_explicit_path';passed=$true})
$tunnelSettings.old_config.tunnel.client_path=Join-Path $tunnelOld $tunnelRelative
if((Select-TunnelClientForUpgrade $tunnelSettings) -cne $tunnelNext){throw 'Owned vendor migration regressed'}
$results.Add([pscustomobject]@{name='owned_vendor_path_migrates_to_new_payload';passed=$true})
$tunnelSettings.old_config.tunnel.client_path=Join-Path $tunnelRoot 'missing external.exe'
if((Select-TunnelClientForUpgrade $tunnelSettings) -cne ''){throw 'Unverified missing external binary was replaced'}
$results.Add([pscustomobject]@{name='missing_external_binary_remains_unverified';passed=$true})
$tunnelSettings.old_config.tunnel.client_path=$externalClient
[IO.File]::AppendAllText($tunnelNext,'tampered')
try{Select-TunnelClientForUpgrade $tunnelSettings|Out-Null;throw 'Changed bundled binary accepted'}catch{if($_.Exception.Message -cne 'bundled_tunnel_identity_mismatch'){throw}}
$results.Add([pscustomobject]@{name='selected_vendor_is_bound_to_manifest_hash';passed=$true})
Copy-Item -LiteralPath $externalClient -Destination $tunnelNext -Force
function Get-FileHash {param([string]$LiteralPath,[string]$Algorithm) if($LiteralPath -ceq $externalClient){throw 'synthetic external read denied'};Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $LiteralPath -Algorithm $Algorithm}
try{Select-TunnelClientForUpgrade $tunnelSettings|Out-Null;throw 'Unreadable external identity accepted'}catch{if($_.Exception.Message -cne 'tunnel_client_identity_unreadable'){throw}}
Remove-Item -LiteralPath Function:\Get-FileHash
$results.Add([pscustomobject]@{name='external_read_failure_is_controlled_before_registration';passed=$true})
if((Select-TunnelClientForUpgrade ([pscustomobject]@{old_config=$null;old_root=$null;new_root=$tunnelNew})) -cne ''){throw 'Fresh install invented a prior Tunnel'}
$results.Add([pscustomobject]@{name='fresh_install_without_tunnel_is_unchanged';passed=$true})
# Cross-version migration follows the owned old vendor path, even when the
# new executable intentionally differs. An external pinned binary is preserved.
$patchedRelative='vendor/tunnel-client-v0.0.17-local-refusal.1-windows-amd64/tunnel-client.exe'
$patchedNext=Join-Path $tunnelNew $patchedRelative
New-Item -ItemType Directory -Path (Split-Path -Parent $patchedNext),(Split-Path -Parent (Join-Path $tunnelOld $tunnelRelative)) -Force | Out-Null
[IO.File]::WriteAllText($patchedNext,'synthetic patched binary identity')
[IO.File]::WriteAllText((Join-Path $tunnelOld $tunnelRelative),'synthetic old official binary identity')
$patchedDigest=(Get-FileHash -LiteralPath $patchedNext -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Json (Join-Path $tunnelNew 'release-manifest.json') ([pscustomobject]@{tunnel_client=[pscustomobject]@{path=$patchedRelative};files=@([pscustomobject]@{path=$patchedRelative;sha256=$patchedDigest})})
$tunnelSettings.old_config.tunnel.client_path=Join-Path $tunnelOld $tunnelRelative
$beforeMigration=$tunnelSettings|ConvertTo-Json -Depth 8
if((Select-TunnelClientForUpgrade $tunnelSettings) -cne $patchedNext -or ($tunnelSettings|ConvertTo-Json -Depth 8) -cne $beforeMigration -or [IO.File]::ReadAllText((Join-Path $tunnelOld $tunnelRelative)) -cne 'synthetic old official binary identity'){throw 'Owned v16 did not migrate to the distinct patched vendor without mutating original state'}
$results.Add([pscustomobject]@{name='owned_v16_migrates_to_distinct_patched_vendor';passed=$true})
$tunnelSettings.old_config.tunnel.client_path=$customClient
if((Select-TunnelClientForUpgrade $tunnelSettings) -cne ''){throw 'Cross-version upgrade replaced a custom external client'}
$tunnelSettings.old_config.tunnel.client_path=$externalClient
if((Select-TunnelClientForUpgrade $tunnelSettings) -cne ''){throw 'Cross-version upgrade replaced an explicitly pinned external old binary'}
$results.Add([pscustomobject]@{name='cross_version_preserves_custom_and_different_external_clients';passed=$true})
Write-Json (Join-Path $tunnelOld 'release-manifest.json') ([pscustomobject]@{tunnel_client=[pscustomobject]@{path=$patchedRelative}})
$tunnelSettings.old_config.tunnel.client_path=Join-Path $tunnelOld $patchedRelative
if((Select-TunnelClientForUpgrade $tunnelSettings) -cne $patchedNext){throw 'Subsequent patched vendor upgrade did not follow the recorded old path'}
$results.Add([pscustomobject]@{name='patched_owned_vendor_path_migrates_on_subsequent_upgrade';passed=$true})
$tunnelSettings.old_config.tunnel.client_path=Join-Path $tunnelRoot 'matching patched external.exe'
Copy-Item -LiteralPath $patchedNext -Destination $tunnelSettings.old_config.tunnel.client_path
if((Select-TunnelClientForUpgrade $tunnelSettings) -cne $patchedNext){throw 'Same-byte external migration regressed for patched clients'}
$results.Add([pscustomobject]@{name='matching_patched_external_migrates_by_exact_hash';passed=$true})
Write-Json (Join-Path $tunnelNew 'release-manifest.json') ([pscustomobject]@{tunnel_client=[pscustomobject]@{path='../outside.exe'};files=@()})
try{Select-TunnelClientForUpgrade $tunnelSettings|Out-Null;throw 'Unsafe manifest Tunnel path accepted'}catch{if($_.Exception.Message -cne 'bundled_tunnel_identity_mismatch'){throw}}
$results.Add([pscustomobject]@{name='unsafe_tunnel_manifest_path_rejected';passed=$true})
# Exercise the actual rollback with real Shell links in a custom Unicode group.
# Prior bytes are intentionally opaque: restoring them must never execute them.

function Shortcut-RollbackCase([string]$Name,[bool]$OldExists,[bool]$NewExists,[bool]$Modified=$false,[bool]$PreviousRestored=$false) {
  $InstallDirectory=Join-Path $work ('shortcut rollback '+$Name)
  $group=Join-Path $InstallDirectory "custom 中文 😀 group O'Brien `$literal"
  New-Item -ItemType Directory -Path $group -Force | Out-Null
  $transactionPath=Join-Path $InstallDirectory '.setup-transaction.json'
  $statePath=Join-Path $InstallDirectory 'installation-state.json'
  $path=Join-Path $group 'Codex Dots Bridge.lnk'
  $oldBytes=[Text.Encoding]::UTF8.GetBytes('opaque previous shortcut; never execute')
  $settings=[pscustomobject]@{shortcut_path=$path;old_shortcut_exists=$OldExists;old_shortcut_bytes=$(if($OldExists){[Convert]::ToBase64String($oldBytes)}else{''});new_root=(Join-Path $InstallDirectory 'payload\0.2.0-alpha.20');old_root=(Join-Path $InstallDirectory 'payload\0.2.0-alpha.19');data_dir=(Join-Path $work 'custom 中文 😀 data');was_running=$false;was_tray_running=$false;registration_changed=$false;app_data=(Join-Path $InstallDirectory 'isolated AppData')}
  if($NewExists) {
    $arguments=if($Modified){'user modified arguments'}else{'--show --data-dir "'+$settings.data_dir+'"'}
    [SetupShortcutFixture]::Write($path,(Join-Path $settings.new_root 'CodexDotsBridge.Tray.exe'),$arguments,$settings.new_root)
  }
  if($PreviousRestored) { [IO.File]::WriteAllBytes($path,$oldBytes) }
  $newBytes=if($NewExists){[IO.File]::ReadAllBytes($path)}else{$null}
  if($NewExists) {
    $modifiedAt=[IO.File]::GetLastWriteTimeUtc($path)
    $details=Read-TestShellLink $path
    if($details.TargetPath -cne (Join-Path $settings.new_root 'CodexDotsBridge.Tray.exe') -or $details.Arguments -cne $arguments -or $details.WorkingDirectory -cne $settings.new_root) { throw 'Unicode shortcut fixture lost target, arguments or working directory.' }
    if([Convert]::ToBase64String([IO.File]::ReadAllBytes($path)) -cne [Convert]::ToBase64String($newBytes) -or [IO.File]::GetLastWriteTimeUtc($path) -ne $modifiedAt) { throw 'Unicode shortcut inspection saved the link.' }
  }
  Write-Json $statePath ([pscustomobject]@{version='0.2.0-alpha.19'})
  Write-Json $transactionPath $settings
  if($Modified) {
    try { Rollback-Transaction $settings;throw 'Modified shortcut was overwritten.' } catch { if($_.Exception.Message -ne 'shortcut_changed_during_install') { throw } }
    if(-not (Test-Path -LiteralPath $transactionPath) -or [Convert]::ToBase64String([IO.File]::ReadAllBytes($path)) -cne [Convert]::ToBase64String($newBytes)) { throw 'Modified shortcut or pending transaction changed.' }
  } else {
    Rollback-Transaction $settings
    if(Test-Path -LiteralPath $transactionPath) { throw 'Resolved shortcut rollback retained transaction.' }
    if($OldExists) { if([Convert]::ToBase64String([IO.File]::ReadAllBytes($path)) -cne [Convert]::ToBase64String($oldBytes)) { throw 'Old shortcut bytes were not restored after cross-version failure.' } }
    elseif(Test-Path -LiteralPath $path) { throw 'Previously absent shortcut retained the failed-version entry.' }
  }
  if((Read-Json $statePath).version -cne '0.2.0-alpha.19') { throw 'Shortcut rollback changed old installer state.' }
  $results.Add([pscustomobject]@{name=$Name;passed=$true;shortcut='real_com_fixture';runtime='not_started'})
}
Shortcut-RollbackCase 'cross_version_failure_restores_previous_shortcut_bytes' $true $true
Shortcut-RollbackCase 'cross_version_failure_removes_new_link_when_previously_absent' $false $true
Shortcut-RollbackCase 'missing_new_shortcut_restores_previous_bytes' $true $false
Shortcut-RollbackCase 'missing_new_shortcut_and_no_previous_remain_absent' $false $false
Shortcut-RollbackCase 'modified_new_shortcut_is_preserved_with_pending_transaction' $true $true $true
Shortcut-RollbackCase 'unchanged_previous_shortcut_bytes_bypass_parser' $true $false $false $true
[pscustomobject]@{checks=$results;test_directory=$work;native_cli='synthetic_fixture_only';registration='synthetic_adapters_only';service='not_started';registry='not_modified'} | ConvertTo-Json -Depth 5
