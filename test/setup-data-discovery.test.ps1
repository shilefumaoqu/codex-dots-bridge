[CmdletBinding()]
param([string]$TestDirectory)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
if(-not $TestDirectory) { $TestDirectory=Join-Path (Split-Path -Parent $projectRoot) '.it' }
$work=Join-Path ([IO.Path]::GetFullPath($TestDirectory)) ('discovery-'+[Guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $work -Force | Out-Null
$script=Join-Path $projectRoot 'scripts\setup-lifecycle.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($script,[ref]$tokens,[ref]$errors)
if($errors.Count) { throw 'Lifecycle parse failed.' }
foreach($name in @('Assert-SafePath','Read-Json','Runtime-Node','Assert-OldCliIdentity','Assert-OwnedRegistration','Resolve-SetupDataDirectory')) {
  $definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
  if(-not $definition) { throw ('Missing lifecycle function: '+$name) }
  . ([ScriptBlock]::Create($definition.Extent.Text))
}
$codexDirectory=Join-Path $work "Codex O'Brien `$literal 中文"
$data=Join-Path $work 'Packages\Synthetic.MSIX\LocalCache\Local\CodexDotsBridge\data'
$plain=Join-Path $work 'plain LocalAppData'
$skill=Join-Path $codexDirectory 'skills\codex-dots-bridge'
foreach($dir in @($codexDirectory,$data,$plain,$skill)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$cli=Join-Path $work 'current-cli.exe';$retired=Join-Path $work 'retired-cli.exe'
$source=Join-Path $work 'fixture.cs'
$fixture=@'
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
public static class Fixture {
 public static int Main(string[] args) {
  if(args.Length!=3 || args[0]!="mcp" || args[1]!="list" || args[2]!="--json") return 29;
  var home=Environment.GetEnvironmentVariable("CODEX_HOME");
  if(!Directory.Exists(home)) return 31;
  File.AppendAllText(Path.Combine(home,"invocations.fixture.txt"),Path.GetFileName(Process.GetCurrentProcess().MainModule.FileName)+"\n");
  Console.OutputEncoding=new UTF8Encoding(false);
  var list=Path.Combine(home,"mcp-list.fixture.json");
  Console.Write(File.Exists(list)?File.ReadAllText(list,Encoding.UTF8):"[]"); return 0;
 }
}
'@
[IO.File]::WriteAllText($source,$fixture,[Text.UTF8Encoding]::new($false))
& (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe') /nologo /codepage:65001 ('/out:'+$cli) $source | Out-Null
if($LASTEXITCODE -ne 0) { throw 'Discovery fixture did not compile.' }
Copy-Item -LiteralPath $cli -Destination $retired
function Json([string]$Path,$Value) { [IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 30),[Text.UTF8Encoding]::new($false)) }
$list=Join-Path $codexDirectory 'mcp-list.fixture.json';$manifestPath=Join-Path $data 'installation.json'
$config=[pscustomobject]@{owner='codex-dots-bridge';schema_version=1;instance_id=[Guid]::NewGuid().ToString()}
Json (Join-Path $data 'config.json') $config
[IO.File]::WriteAllText((Join-Path $skill 'SKILL.md'),'synthetic owned Skill',[Text.UTF8Encoding]::new($false))
$mcp=[pscustomobject]@{name='codex-dots-bridge';command=(Runtime-Node $projectRoot);args=@((Join-Path $projectRoot 'dist\main.js'),'stdio','--data-dir',$data)}
$entry=[pscustomobject]@{name=$mcp.name;transport=[pscustomobject]@{type='stdio';command=$mcp.command;args=$mcp.args}}
$manifest=[pscustomobject]@{owner='codex-dots-bridge';instance_id=$config.instance_id;codex_home=$codexDirectory;codex_command=$retired;mcp=$mcp;mcp_registration=$entry;skill=[pscustomobject]@{path=$skill;files=@{'SKILL.md'=(Get-FileHash -LiteralPath (Join-Path $skill 'SKILL.md')).Hash.ToLowerInvariant()}}}
Json $manifestPath $manifest
function Entries($Values) { [IO.File]::WriteAllText($list,(ConvertTo-Json -InputObject @($Values) -Depth 30),[Text.UTF8Encoding]::new($false)) }
Entries @($entry)
$checks=[Collections.Generic.List[string]]::new()
function Reject([string]$Name,[string]$Code) {
  try { Resolve-SetupDataDirectory $null '' $codexDirectory $cli | Out-Null;throw 'Expected discovery rejection.' } catch { if($_.Exception.Message -ne $Code) { throw } }
  $checks.Add($Name)
}
$previousLocal=$env:LOCALAPPDATA;$previousHome=$env:CODEX_HOME
try {
  $env:LOCALAPPDATA=$plain;$env:CODEX_HOME=Join-Path $work 'unselected-home'
  $nestedHome=Join-Path $work "fresh nested\O'Brien `$literal 中文\home"
  if(Test-Path -LiteralPath $nestedHome) { throw 'Fresh nested home fixture already exists.' }
  if((Resolve-SetupDataDirectory $null '' $nestedHome $cli) -cne (Join-Path $plain 'CodexDotsBridge\data') -or -not (Test-Path -LiteralPath (Join-Path $nestedHome 'invocations.fixture.txt'))) { throw 'Fresh native query did not receive an existing nested Codex home.' }
  $checks.Add('missing_nested_codex_home_created_safely_before_native_query')
  $fileHome=Join-Path $work 'file-not-home';[IO.File]::WriteAllText($fileHome,'preserve')
  try { Resolve-SetupDataDirectory $null '' $fileHome $cli | Out-Null;throw 'File accepted as Codex home.' } catch { if($_.Exception.Message -ne 'invalid_codex_home') { throw } }
  if([IO.File]::ReadAllText($fileHome) -cne 'preserve') { throw 'Rejected file-home changed.' }
  $checks.Add('file_codex_home_rejected_without_change')
  if((Resolve-SetupDataDirectory $null '' $codexDirectory $cli) -cne $data) { throw 'Registered MSIX data directory not discovered.' }
  if($env:CODEX_HOME -cne (Join-Path $work 'unselected-home')) { throw 'Discovery changed process Codex home.' }
  $checks.Add('registered_msix_data_dir_passes_existing_full_ownership_gate')
  if([IO.File]::ReadAllText((Join-Path $codexDirectory 'invocations.fixture.txt')).Contains('retired-cli.exe')) { throw 'Discovery invoked retired CLI.' }
  $checks.Add('updated_current_cli_used_with_selected_home')
  $explicit=Join-Path $work 'explicit data'
  if((Resolve-SetupDataDirectory $null $explicit $codexDirectory (Join-Path $work 'missing.exe')) -cne $explicit) { throw 'Explicit directory was overridden.' }
  if((Resolve-SetupDataDirectory ([pscustomobject]@{data_dir=$data}) '' $codexDirectory (Join-Path $work 'missing.exe')) -cne $data) { throw 'Prior state directory was overridden.' }
  $checks.Add('explicit_data_dir_and_prior_state_skip_discovery')
  New-Item -ItemType Directory -Path $explicit | Out-Null
  Json (Join-Path $explicit 'config.json') $config;Json (Join-Path $explicit 'installation.json') $manifest
  try { Assert-OwnedRegistration $projectRoot $explicit $codexDirectory $cli | Out-Null;throw 'Explicit alias directory bypassed original ownership identity.' } catch { if($_.Exception.Message -ne 'foreign_installation_manifest') { throw } }
  $checks.Add('explicit_other_directory_keeps_existing_strict_ownership_rejection')
  $app=Join-Path $work 'prior state app';New-Item -ItemType Directory -Path $app | Out-Null
  $priorState=[pscustomobject]@{owner='codex-dots-bridge-setup';schema=1;install_directory=$app;installer_app_id='CodexDotsBridgeSetup';version='0.2.0-alpha.7';payload_root=(Join-Path $app 'payload\0.2.0-alpha.7');data_dir=$data;codex_home=$codexDirectory;app_data=(Join-Path $work 'AppData');codex_command=$cli;package_fingerprint=('0'*64)}
  Json (Join-Path $app 'installation-state.json') $priorState
  $stateBefore=[IO.File]::ReadAllText((Join-Path $app 'installation-state.json'))
  $shell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $output=@(& $shell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script -Action Prepare -InstallDirectory $app -NewVersion 0.2.0-alpha.7 -PackageFingerprint ('0'*64) -InstallerIdentity CodexDotsBridgeSetup -DataDir $explicit -CodexHome $codexDirectory -CodexCommand $cli)
  if($LASTEXITCODE -eq 0 -or ($output -join '') -notmatch 'data_directory_change_not_supported' -or [IO.File]::ReadAllText((Join-Path $app 'installation-state.json')) -cne $stateBefore -or (Test-Path -LiteralPath (Join-Path $app '.setup-transaction.json'))) { throw 'Prior state accepted changed explicit data directory.' }
  $checks.Add('prior_state_explicit_directory_change_rejected_without_transaction')
  $foreign=[pscustomobject]@{name=$entry.name;transport=[pscustomobject]@{type='http';url='https://synthetic.invalid'}}
  Entries @($foreign);Reject 'foreign_same_name_transport_rejected' 'foreign_registered_bridge_entry'
  $invalid=$entry|ConvertTo-Json -Depth 30|ConvertFrom-Json;$invalid.transport.args+=@('--extra')
  Entries @($invalid);Reject 'extra_args_rejected' 'foreign_registered_bridge_entry'
  $invalid.transport.args=@('relative\dist\main.js','stdio','--data-dir',$data)
  Entries @($invalid);Reject 'relative_entry_path_rejected' 'foreign_registered_bridge_entry'
  Entries @($entry,$entry);Reject 'duplicate_named_entries_rejected' 'ambiguous_registered_bridge_entry'
  Entries @($entry)
  Move-Item -LiteralPath $manifestPath -Destination ($manifestPath+'.saved')
  try { Reject 'registered_data_without_manifest_rejected' 'installation_missing_owned_registration' } finally { Move-Item -LiteralPath ($manifestPath+'.saved') -Destination $manifestPath }
  $modified=$manifest|ConvertTo-Json -Depth 30|ConvertFrom-Json;$modified.instance_id=[Guid]::NewGuid().ToString();Json $manifestPath $modified
  Reject 'foreign_manifest_instance_rejected_by_original_gate' 'foreign_installation_manifest'
  Json $manifestPath $manifest
  [IO.File]::WriteAllText((Join-Path $skill 'SKILL.md'),'user modification',[Text.UTF8Encoding]::new($false))
  Reject 'modified_skill_rejected_by_original_gate' 'modified_or_foreign_skill'
  [IO.File]::WriteAllText((Join-Path $skill 'SKILL.md'),'synthetic owned Skill',[Text.UTF8Encoding]::new($false))
  $modified=$manifest|ConvertTo-Json -Depth 30|ConvertFrom-Json
  $modified.mcp_registration|Add-Member -NotePropertyName enabled -NotePropertyValue $false
  Json $manifestPath $modified
  Reject 'modified_exact_registration_snapshot_rejected' 'modified_or_foreign_mcp'
  Json $manifestPath $manifest
  [IO.File]::WriteAllText($list,'{}',[Text.UTF8Encoding]::new($false))
  Reject 'non_array_native_json_rejected' 'invalid_codex_mcp_list'
  [IO.File]::WriteAllText($list,'[invalid',[Text.UTF8Encoding]::new($false))
  Reject 'malformed_native_json_rejected' 'invalid_codex_mcp_list'
  Entries @()
  if((Resolve-SetupDataDirectory $null '' $codexDirectory $cli) -cne (Join-Path $plain 'CodexDotsBridge\data')) { throw 'Fresh default directory changed.' }
  $checks.Add('no_named_entry_keeps_fresh_default')
  Entries @($entry)
  if(Test-Path -LiteralPath (Join-Path $plain 'CodexDotsBridge\data')) { throw 'Discovery created a fallback data directory.' }
  if((Read-Json (Join-Path $data 'config.json')).instance_id -cne $config.instance_id -or [IO.File]::ReadAllText((Join-Path $skill 'SKILL.md')) -cne 'synthetic owned Skill') { throw 'Discovery changed owned configuration or Skill.' }
  $checks.Add('discovery_and_rejections_do_not_create_or_merge_data')
} finally {
  if($null -eq $previousLocal){Remove-Item Env:LOCALAPPDATA -ErrorAction SilentlyContinue}else{$env:LOCALAPPDATA=$previousLocal}
  if($null -eq $previousHome){Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue}else{$env:CODEX_HOME=$previousHome}
}
[pscustomobject]@{checks=$checks;passed=$checks.Count;test_directory=$work;native_cli='synthetic_fixture_only';ownership_gate='existing_actual_function';production='not_modified';service='not_started';registry='not_modified'} | ConvertTo-Json -Depth 5
