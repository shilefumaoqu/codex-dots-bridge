[CmdletBinding()]
param([string]$TestDirectory)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
if(-not $TestDirectory) { $TestDirectory=Join-Path (Split-Path -Parent $projectRoot) '.it' }
$work=Join-Path ([IO.Path]::GetFullPath($TestDirectory)) ('runtime-'+[Guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $work -Force | Out-Null
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $projectRoot 'scripts\setup-lifecycle.ps1'),[ref]$tokens,[ref]$errors)
foreach($name in @('Assert-SafePath','Read-Json','Write-Json','Runtime-Node','Resolve-OldRuntimeRoot','Rollback-Transaction')) {
  $definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
  if(-not $definition) { throw ('Missing lifecycle function: '+$name) }
  . ([ScriptBlock]::Create($definition.Extent.Text))
}
$checks=[Collections.Generic.List[string]]::new()
$callerRoot=Join-Path $work 'caller-alpha5'
$runtimeRoot=Join-Path $work 'runtime-alpha7'
New-Item -ItemType Directory -Path (Join-Path $runtimeRoot 'runtime\node-v24.21.0-win-x64'),(Join-Path $runtimeRoot 'dist') -Force | Out-Null
$node=Join-Path $runtimeRoot 'runtime\node-v24.21.0-win-x64\node.exe'
[IO.File]::WriteAllText($node,'synthetic never-executed node')
[IO.File]::WriteAllText((Join-Path $runtimeRoot 'dist\main.js'),'synthetic never-executed entry')
Write-Json (Join-Path $runtimeRoot 'package.json') ([pscustomobject]@{name='codex-dots-bridge';version='0.2.0-alpha.7'})
$binding=[pscustomobject]@{installation=[pscustomobject]@{root=$runtimeRoot;node_path=$node};retained='original config'}
if((Resolve-OldRuntimeRoot $binding $callerRoot) -cne $runtimeRoot) { throw 'Runtime binding incorrectly used caller root.' }
if((Resolve-OldRuntimeRoot ([pscustomobject]@{}) $callerRoot) -cne $callerRoot) { throw 'Legacy runtime fallback changed.' }
$checks.Add('caller_and_runtime_roots_are_distinct_with_legacy_fallback')
function Reject($Config,[string]$Name) {
  try { Resolve-OldRuntimeRoot $Config $callerRoot | Out-Null;throw 'Invalid runtime binding accepted.' } catch { if($_.Exception.Message -ne 'invalid_old_runtime_metadata') { throw } }
  $checks.Add($Name)
}
Reject ([pscustomobject]@{installation=@{root='relative';node_path=$node}}) 'relative_runtime_root_rejected'
Reject ([pscustomobject]@{installation=@{root=$runtimeRoot;node_path=(Join-Path $work 'other-node.exe')}}) 'runtime_node_identity_mismatch_rejected'
Write-Json (Join-Path $runtimeRoot 'package.json') ([pscustomobject]@{name='foreign-program';version='0.2.0-alpha.7'})
Reject $binding 'foreign_runtime_package_name_rejected'
Write-Json (Join-Path $runtimeRoot 'package.json') ([pscustomobject]@{name='codex-dots-bridge';version='invalid'})
Reject $binding 'invalid_runtime_package_version_rejected'
Write-Json (Join-Path $runtimeRoot 'package.json') ([pscustomobject]@{name='codex-dots-bridge';version='0.2.0-alpha.7'})
Move-Item -LiteralPath (Join-Path $runtimeRoot 'dist\main.js') -Destination (Join-Path $runtimeRoot 'dist\main.saved')
Reject $binding 'missing_runtime_entry_rejected'
Move-Item -LiteralPath (Join-Path $runtimeRoot 'dist\main.saved') -Destination (Join-Path $runtimeRoot 'dist\main.js')
# Registration and process adapters record dispatch only; synthetic executable files are never run.
$data=Join-Path $work 'data';New-Item -ItemType Directory -Path $data | Out-Null
$configPath=Join-Path $data 'config.json';Write-Json $configPath $binding
$originalConfig=[IO.File]::ReadAllText($configPath)
$transactionPath=Join-Path $work '.setup-transaction.json'
$calls=[Collections.Generic.List[object]]::new()
$script:failRuntimeRun=$false
$script:failOldRegistration=$false
function Rollback-CodexCommand { return (Join-Path $work 'synthetic-cli.exe') }
function Read-FallbackState { return $null }
function Assert-OwnedRegistration { }
function Remove-Registration {
  $calls.Add([pscustomobject]@{operation='cleanup'})
  Remove-Item -LiteralPath (Join-Path $data 'installation.json')
}
function Setup-Registration([string]$Root,$Settings,[bool]$EnableAutostart,[string]$TunnelClient,[string]$Command) {
  $calls.Add([pscustomobject]@{operation='registration';root=$Root})
  if($script:failOldRegistration) {
    if((Read-Json $transactionPath).current_registration_root -cne $Root) {throw 'old_owner_not_persisted_before_registration'}
    Write-Json (Join-Path $data 'installation.json') ([pscustomobject]@{synthetic_partial_old_registration=$Root})
    throw 'synthetic_old_registration_partial_failure'
  }
  Write-Json $configPath ([pscustomobject]@{installation=@{root=$Root;node_path=(Runtime-Node $Root)}})
}
function Invoke-Bridge([string]$Root,[string[]]$BridgeArgs) {
  if([IO.File]::ReadAllText($configPath) -cne $originalConfig) { throw 'Runtime resumed before exact config restoration.' }
  $package=Read-Json (Join-Path $Root 'package.json')
  $calls.Add([pscustomobject]@{operation=$BridgeArgs[0];root=$Root;node=(Runtime-Node $Root);version=$package.version;arguments=$BridgeArgs})
  if($BridgeArgs[0] -ceq 'run' -and $script:failRuntimeRun) { throw 'synthetic_resume_failed' }
  return [pscustomobject]@{supervisor='stopped';service='stopped'}
}
function Test-InstallerRuntimeReady([string]$Root,[string]$Directory) {Invoke-Bridge $Root @('status','--data-dir',$Directory)|Out-Null;return $false}
function Assert-RuntimeLocksReleased([string]$Directory) {}
function Stop-Tray([string]$Root,[string]$Directory) {}
function Start-InstallerSupervisor([string]$Root,[string]$Directory) {Invoke-Bridge $Root @('run','--supervisor','--data-dir',$Directory)|Out-Null}
$transaction=[pscustomobject]@{old_root=$callerRoot;old_runtime_root=$runtimeRoot;old_config=$binding;old_config_text=$originalConfig;data_dir=$data;app_data=(Join-Path $work 'AppData');was_running=$true;registration_changed=$true;old_autostart=$false;current_registration_root=(Join-Path $work 'new caller')}
Write-Json $transactionPath $transaction
Rollback-Transaction $transaction
if($calls.Count -ne 3 -or $calls[0].root -cne $callerRoot -or $calls[1].root -cne $runtimeRoot -or $calls[2].root -cne $runtimeRoot -or $calls[2].version -cne '0.2.0-alpha.7' -or $calls[2].node -cne $node -or ($calls[2].arguments -join '|') -cne ('run|--supervisor|--data-dir|'+$data)) { throw 'Rollback dispatched wrong caller/runtime/version/arguments.' }
if([IO.File]::ReadAllText($configPath) -cne $originalConfig -or (Test-Path -LiteralPath $transactionPath)) { throw 'Rollback did not preserve config and finish transaction.' }
$checks.Add('restores_caller_registration_then_exact_config_then_original_runtime_dispatch')
$materials=@{'caller.key'='synthetic caller unchanged';'worker.key'='synthetic worker unchanged';'tasks.sqlite'='synthetic task data unchanged'}
foreach($name in $materials.Keys){[IO.File]::WriteAllText((Join-Path $data $name),$materials[$name])}
$transaction.current_registration_root=Join-Path $work 'new caller'
Write-Json (Join-Path $data 'installation.json') ([pscustomobject]@{synthetic_new_registration='owned fixture'})
Write-Json $transactionPath $transaction;$calls.Clear();$script:failOldRegistration=$true
try {Rollback-Transaction $transaction;throw 'Partial old registration failure was accepted.'}catch{if($_.Exception.Message -cne 'synthetic_old_registration_partial_failure'){throw}}
$partial=Read-Json $transactionPath
if($partial.current_registration_root -cne $callerRoot -or $partial.registration_changed -ne $true -or (Read-Json (Join-Path $data 'installation.json')).synthetic_partial_old_registration -cne $callerRoot) {throw 'Partial old registration lost its persisted owner or pending transaction.'}
if(@($calls|Where-Object{$_.operation -ceq 'registration'}).Count -ne 1 -or @($calls|Where-Object{$_.operation -cin @('run','status')}).Count -ne 0) {throw 'Unknown old registration result retried setup or started background work.'}
if([IO.File]::ReadAllText($configPath) -cne $originalConfig){throw 'Partial old registration changed original config.'}
foreach($name in $materials.Keys){if([IO.File]::ReadAllText((Join-Path $data $name)) -cne $materials[$name]){throw 'Partial old registration changed protected fixture data.'}}
$checks.Add('partial_old_registration_failure_persists_old_owner_before_write_and_keeps_transaction')
$checks.Add('partial_old_registration_failure_preserves_config_tasks_keys_without_retry_or_start')
$script:failOldRegistration=$false
$calls.Clear();$transaction.registration_changed=$false
Write-Json $transactionPath $transaction
Rollback-Transaction $transaction
if($calls.Count -ne 2 -or $calls[1].root -cne $runtimeRoot) { throw 'Pre-Commit rollback failed to resume original runtime.' }
$checks.Add('stopped_before_registration_change_resumes_original_runtime')
$transaction.registration_changed=$true;$script:failRuntimeRun=$true
Write-Json $transactionPath $transaction
try { Rollback-Transaction $transaction;throw 'Failed resume cleared transaction.' } catch { if($_.Exception.Message -ne 'synthetic_resume_failed') { throw } }
$pending=Read-Json $transactionPath
if($pending.current_registration_root -cne $callerRoot -or [IO.File]::ReadAllText($configPath) -cne $originalConfig) { throw 'Resume failure lost restored registration root/config for retry.' }
$script:failRuntimeRun=$false
Rollback-Transaction $pending
if(Test-Path -LiteralPath $transactionPath) { throw 'Rollback retry did not finish.' }
$checks.Add('failed_resume_retains_restored_registration_root_and_config_for_retry')
$transaction.old_runtime_root=$callerRoot
Write-Json $transactionPath $transaction;$calls.Clear()
try { Rollback-Transaction $transaction;throw 'Changed transaction runtime binding accepted.' } catch { if($_.Exception.Message -ne 'old_runtime_binding_changed') { throw } }
if($calls.Count -ne 0 -or -not (Test-Path -LiteralPath $transactionPath)) { throw 'Invalid binding changed registrations or cleared transaction.' }
$checks.Add('changed_transaction_binding_rejected_before_dispatch')
$deletedRoot=Join-Path $work 'already deleted old program'
$retainedConfig=[pscustomobject]@{installation=@{root=$deletedRoot;node_path=(Join-Path $deletedRoot 'runtime\node-v24.21.0-win-x64\node.exe')};retained='uninstalled data'}
Write-Json $configPath $retainedConfig;$retainedText=[IO.File]::ReadAllText($configPath)
foreach($name in @('caller.key','worker.key','tasks.sqlite')) { [IO.File]::WriteAllText((Join-Path $data $name),('synthetic preserved '+$name)) }
$retainedTransaction=[pscustomobject]@{old_root='';old_runtime_root='';old_config=$retainedConfig;old_config_text=$retainedText;data_dir=$data;app_data=(Join-Path $work 'AppData');was_running=$false;registration_changed=$true;old_autostart=$false;current_registration_root=$runtimeRoot}
Write-Json (Join-Path $data 'installation.json') ([pscustomobject]@{owner='synthetic partial registration'})
Write-Json $transactionPath $retainedTransaction;$calls.Clear()
Rollback-Transaction $retainedTransaction
if($calls.Count -ne 1 -or $calls[0].operation -cne 'cleanup' -or (Test-Path -LiteralPath (Join-Path $data 'installation.json')) -or (Test-Path -LiteralPath $transactionPath) -or [IO.File]::ReadAllText($configPath) -cne $retainedText) { throw 'Retained-data reinstall rollback failed to clean partial registration and preserve config.' }
foreach($name in @('caller.key','worker.key','tasks.sqlite')) { if([IO.File]::ReadAllText((Join-Path $data $name)) -cne ('synthetic preserved '+$name)) { throw 'Retained user data changed during rollback.' } }
$checks.Add('retained_data_reinstall_rollback_cleans_partial_registration_without_deleted_runtime')
$retainedTransaction.registration_changed=$false
Write-Json $transactionPath $retainedTransaction;$calls.Clear()
Rollback-Transaction $retainedTransaction
if($calls.Count -ne 0 -or (Test-Path -LiteralPath $transactionPath) -or [IO.File]::ReadAllText($configPath) -cne $retainedText) { throw 'No-change retained-data rollback required deleted runtime.' }
$checks.Add('retained_data_no_registration_change_rollback_clears_transaction_without_runtime')
$retainedTransaction.was_running=$true
Write-Json $transactionPath $retainedTransaction;$calls.Clear()
try { Rollback-Transaction $retainedTransaction;throw 'Running old service accepted deleted runtime.' } catch { if($_.Exception.Message -ne 'invalid_old_runtime_metadata') { throw } }
if($calls.Count -ne 0 -or -not (Test-Path -LiteralPath $transactionPath)) { throw 'Unavailable required runtime dispatched or cleared transaction.' }
$checks.Add('was_running_keeps_strict_old_runtime_validation_and_pending_transaction')
[pscustomobject]@{checks=$checks;passed=$checks.Count;test_directory=$work;runtime_dispatch='synthetic_adapters_only';native_cli='not_invoked';service='not_started';production='not_modified';registry='not_modified'} | ConvertTo-Json -Depth 5
