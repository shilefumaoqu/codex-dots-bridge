[CmdletBinding()]
param([string]$TestDirectory)
$ErrorActionPreference='Stop'
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
foreach($name in @('Assert-SafePath','Runtime-Node','Write-Json','Read-Json','Assert-State','Assert-OldCliIdentity','Test-CodexCommand','Rollback-CodexCommand','Read-FallbackState','Resolve-OldRuntimeRoot','Rollback-Transaction')) {
  $definition=$selectionAst.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
  if(-not $definition) { throw ('Lifecycle function missing: '+$name) }
  . ([ScriptBlock]::Create($definition.Extent.Text))
}
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
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
[pscustomobject]@{checks=$results;test_directory=$work;native_cli='synthetic_fixture_only';registration='synthetic_adapters_only';service='not_started';registry='not_modified'} | ConvertTo-Json -Depth 5
