[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet('Prepare','Commit','Rollback','PreflightUninstall','Uninstall','Connect','Tray')][string]$Action,
  [Parameter(Mandatory=$true)][string]$InstallDirectory,
  [string]$NewVersion,
  [string]$PackageFingerprint,
  [string]$InstallerIdentity,
  [string]$DataDir,
  [string]$CodexHome,
  [string]$CodexCommand,
  [string]$AppDataDirectory,
  [string]$ShortcutDirectory,
  [switch]$Autostart
)
$ErrorActionPreference='Stop'
# Inno's PS5 process may inherit PS7 module paths. Load its own built-in hash commands.
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -Global -Force -ErrorAction Stop
try { [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false) } catch { }
$OutputEncoding=[Text.UTF8Encoding]::new($false)
$InstallDirectory=[IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
$statePath=Join-Path $InstallDirectory 'installation-state.json'
$transactionPath=Join-Path $InstallDirectory '.setup-transaction.json'
$resultPath=Join-Path $InstallDirectory '.setup-result.txt'
$validatedDirectory=$false
$ownsTransaction=$false

function Assert-SafePath([string]$Path) {
  $full=[IO.Path]::GetFullPath($Path)
  for($cursor=$full; $cursor; $cursor=Split-Path -Parent $cursor) {
    if(Test-Path -LiteralPath $cursor) {
      $item=Get-Item -LiteralPath $cursor -Force
      if($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'unsafe_reparse_path' }
    }
    if($cursor -eq [IO.Path]::GetPathRoot($cursor)) { break }
  }
}
function Write-Json([string]$Path,$Value) {
  Assert-SafePath $Path
  [IO.File]::WriteAllText($Path,($Value | ConvertTo-Json -Depth 30),[Text.UTF8Encoding]::new($false))
}
function Read-Json([string]$Path) { Assert-SafePath $Path; Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json }
function Select-TunnelClientForUpgrade($Settings) {
  if(-not $Settings.old_config -or -not $Settings.old_config.tunnel -or -not $Settings.old_root) { return '' }
  $relative='vendor/tunnel-client-v0.0.16-windows-amd64/tunnel-client.exe'
  $next=Join-Path $Settings.new_root $relative
  if(-not (Test-Path -LiteralPath $next -PathType Leaf)) { return '' }
  Assert-SafePath $next
  # Commit calls this only after check-package and the transaction fingerprint
  # have authenticated the new payload; bind the selected executable again.
  $entries=@((Read-Json (Join-Path $Settings.new_root 'release-manifest.json')).files | Where-Object { $_.path -ceq $relative })
  if($entries.Count -ne 1 -or $entries[0].sha256 -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $next -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entries[0].sha256) { throw 'bundled_tunnel_identity_mismatch' }
  $previous=$Settings.old_config.tunnel.client_path
  $owned=Join-Path $Settings.old_root $relative
  if($previous -ieq $owned) { return $next }
  if(-not $previous -or -not (Test-Path -LiteralPath $previous -PathType Leaf)) { return '' }
  Assert-SafePath $previous
  try { $previousHash=(Get-FileHash -LiteralPath $previous -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() } catch { throw 'tunnel_client_identity_unreadable' }
  # A legacy external official binary can move without changing behavior.
  # Unknown/custom binaries keep their explicit path and are never deleted.
  if($previousHash -ceq $entries[0].sha256) { return $next }
  return ''
}
function Assert-RuntimeLocksReleased([string]$Directory) {
  foreach($name in @('service.lock','supervisor.lock')) {
    $path=Join-Path $Directory $name
    Assert-SafePath $path
    if(Test-Path -LiteralPath $path) { throw 'stale_lock_requires_recovery' }
  }
}
function Runtime-Node([string]$Root) {
  $normal=Join-Path $Root 'runtime\node-v24.21.0-win-x64\node.exe'
  if(Test-Path -LiteralPath $normal -PathType Leaf) { return $normal }
  Join-Path $Root '.runtime\node-v24.21.0-win-x64\node.exe'
}
function Invoke-Bridge([string]$Root,[string[]]$BridgeArgs) {
  $node=Runtime-Node $Root
  $text=@(& $node (Join-Path $Root 'dist\main.js') @BridgeArgs)
  if($LASTEXITCODE -ne 0) {
    $code='bridge_operation_failed'
    try { $errorResult=($text -join "`n") | ConvertFrom-Json; if($errorResult.error -match '^[a-z][a-z0-9_]*$') { $code=$errorResult.error } } catch { }
    throw $code
  }
  ($text -join "`n") | ConvertFrom-Json
}
function Tray-Path([string]$Root) {
  if(-not $Root) { return '' }
  $path=Join-Path $Root 'CodexDotsBridge.Tray.exe'
  if(-not (Test-Path -LiteralPath $path -PathType Leaf)) { return '' }
  Assert-SafePath $path
  $manifest=Read-Json (Join-Path $Root 'release-manifest.json')
  $entry=@($manifest.files | Where-Object { $_.path -ceq 'CodexDotsBridge.Tray.exe' })
  if($entry.Count -ne 1 -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry[0].sha256) { throw 'tray_binary_identity_mismatch' }
  return $path
}
function Tray-Running([string]$Root,[string]$Directory) {
  $exe=Tray-Path $Root
  if(-not $exe) { return $false }
  $code=Invoke-TrayCommand $exe @('--running','--data-dir',$Directory)
  if($code -eq 0) { return $true }
  if($code -ne 1) { throw 'tray_status_unavailable' }
  return $false
}
function Stop-Tray([string]$Root,[string]$Directory) {
  $exe=Tray-Path $Root
  if(-not $exe) { return }
  $code=Invoke-TrayCommand $exe @('--exit','--data-dir',$Directory)
  if($code -ne 0 -or (Tray-Running $Root $Directory)) { throw 'tray_stop_unconfirmed' }
}
function Invoke-TrayCommand([string]$Executable,[string[]]$Arguments) {
  $info=New-Object Diagnostics.ProcessStartInfo
  $info.FileName=$Executable;$info.UseShellExecute=$false;$info.CreateNoWindow=$true
  $info.Arguments=($Arguments | ForEach-Object { '"'+$_+'"' }) -join ' '
  $process=[Diagnostics.Process]::Start($info)
  try {
    if(-not $process.WaitForExit(12000)) { throw 'tray_control_timeout' }
    return $process.ExitCode
  } finally { $process.Dispose() }
}
function Start-Tray([string]$Root,[string]$Directory,[switch]$Show) {
  $exe=Tray-Path $Root
  if(-not $exe) { return }
  if(Tray-Running $Root $Directory) {
    if($Show -and (Invoke-TrayCommand $exe @('--show','--data-dir',$Directory)) -ne 0) { throw 'tray_show_unconfirmed' }
    return
  }
  $mode=if($Show){'--show'}else{'--background'}
  # The runner owns this helper, including rollback to an older payload that has
  # no helper. Inno extracts it beside the temporary runner before Prepare.
  $receipt=@(& (Join-Path $PSScriptRoot 'launch-background.ps1') -TrayExecutable $exe -DataDir $Directory -TrayMode $mode)
  if($LASTEXITCODE -ne 0) { throw 'tray_background_launch_unconfirmed' }
  try { $launch=($receipt -join "`n") | ConvertFrom-Json; if(-not $launch.pid) { throw 'invalid_receipt' } } catch { throw 'tray_background_launch_unconfirmed' }
  for($attempt=0;$attempt -lt 30;$attempt++) {
    Start-Sleep -Milliseconds 100
    if(Tray-Running $Root $Directory) { return }
  }
  throw 'tray_start_unconfirmed'
}
function Assert-NoInFlightTasks($Status) {
  if(-not $Status.tasks) { throw 'task_state_unavailable' }
  foreach($name in @('queued','running','waiting_input','cancel_requested','reconciliation_required')) {
    $count=$Status.tasks.$name
    if($null -ne $count -and ([int]$count -gt 0)) { throw 'inflight_tasks_block_upgrade' }
  }
}
function Get-UpgradeRuntimeStatus([string]$Root,[string]$Directory) {
  try { return (Invoke-Bridge $Root @('status','--data-dir',$Directory)) } catch {
    # An unreachable legacy status path cannot skip the task gate. Load only the
    # already authenticated old runtime's SQLite library, in read-only mode.
    $previous=$env:BRIDGE_SETUP_TASK_PROBE
    $env:BRIDGE_SETUP_TASK_PROBE=(@{root=$Root;dir=$Directory}|ConvertTo-Json -Compress)
    $probe=@'
import {createRequire} from 'node:module';
import {existsSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
const r=JSON.parse(process.env.BRIDGE_SETUP_TASK_PROBE),counts={};
const require=createRequire(join(r.root,'package.json')),Database=require('better-sqlite3');
const p=join(r.dir,'tasks.sqlite');
if(existsSync(p)) {
 if(!lstatSync(p).isFile()||lstatSync(p).isSymbolicLink())throw new Error('unsafe_database');
 const db=new Database(p,{readonly:true,fileMustExist:true});
 try {for(const row of db.prepare('SELECT data FROM tasks').all()){const t=JSON.parse(row.data);if(typeof t.status!=='string')throw new Error('invalid_task');counts[t.status]=(counts[t.status]??0)+1;}}finally{db.close();}
}
console.log(JSON.stringify({supervisor:'unknown',service:'unknown',tasks:counts}));
'@
    try {
      $text=@(& (Runtime-Node $Root) --input-type=module -e $probe 2>$null)
      if($LASTEXITCODE -ne 0){throw 'task_state_unavailable'}
      return (($text -join "`n")|ConvertFrom-Json)
    } catch {throw 'task_state_unavailable'}
    finally {if($null -eq $previous){Remove-Item Env:BRIDGE_SETUP_TASK_PROBE -ErrorAction SilentlyContinue}else{$env:BRIDGE_SETUP_TASK_PROBE=$previous}}
  }
}
function Quote-InstallerArgument([string]$Value) {
  $b=[Text.StringBuilder]::new('"');$slashes=0
  foreach($c in $Value.ToCharArray()) {
    if($c -eq '\'){$slashes++;continue}
    if($c -eq '"'){$null=$b.Append('\',$slashes*2+1);$null=$b.Append($c)}else{$null=$b.Append('\',$slashes);$null=$b.Append($c)}
    $slashes=0
  }
  $null=$b.Append('\',$slashes*2);$null=$b.Append('"');return $b.ToString()
}
function Invoke-InstallerHelper([ValidateSet('Recovery','Supervisor','Ready')][string]$Kind,[string]$Directory,[string]$Root='',[int]$TimeoutMs=20000,[int]$ExpectedPid=0,[string]$PreviousOwner='') {
  if($TimeoutMs -lt 1){throw 'installer_helper_timeout'}
  $deadline=[Diagnostics.Stopwatch]::StartNew()
  $script=if($Kind -eq 'Recovery'){'recover-reboot-locks.ps1'}else{'launch-background.ps1'}
  $arguments=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot $script),'-DataDir',$Directory)
  if($Kind -ne 'Recovery'){$arguments+=@('-NodeExecutable',(Runtime-Node $Root),'-EntryPath',(Join-Path $Root 'dist\main.js'))}
  if($Kind -eq 'Ready'){$arguments+=@('-CheckReady','-ExpectedPid',[string]$ExpectedPid);if($PreviousOwner){$arguments+=@('-PreviousOwner',$PreviousOwner)}}
  $info=[Diagnostics.ProcessStartInfo]::new()
  $info.FileName=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $info.Arguments=($arguments|ForEach-Object{Quote-InstallerArgument $_}) -join ' '
  $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
  $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true;$info.StandardOutputEncoding=[Text.UTF8Encoding]::new($false)
  $info.EnvironmentVariables.Clear()
  foreach($name in @('SystemRoot','WINDIR','ComSpec','PATH','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','PROGRAMFILES','PROGRAMDATA','HOME')){$value=[Environment]::GetEnvironmentVariable($name);if($null -ne $value){$info.EnvironmentVariables[$name]=$value}}
  $process=[Diagnostics.Process]::new();$process.StartInfo=$info
  try {
    if(-not $process.Start()){throw 'installer_helper_unavailable'}
    $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
    $remaining=[Math]::Max(0,$TimeoutMs-$deadline.ElapsedMilliseconds)
    if(-not $process.WaitForExit($remaining)) {
      # Stop only this helper. WMI may already have created a background owner;
      # its outcome stays unknown and the transaction remains for reconciliation.
      try{$process.Kill()}catch{}
      throw 'installer_helper_timeout'
    }
    foreach($stream in @($stdout,$stderr)) {
      $remaining=[Math]::Max(0,$TimeoutMs-$deadline.ElapsedMilliseconds)
      if(-not $stream.Wait($remaining)){throw 'installer_helper_unconfirmed'}
    }
    $text=$stdout.GetAwaiter().GetResult();$null=$stderr.GetAwaiter().GetResult()
    if($process.ExitCode -ne 0 -or $text.Length -gt 65536){throw 'installer_helper_unconfirmed'}
    return ($text.TrimStart([char]0xFEFF)|ConvertFrom-Json)
  } finally {$process.Dispose()}
}
function Invoke-InstallerRecovery([string]$Directory,[int]$TimeoutMs=20000) {
  return (Invoke-InstallerHelper -Kind Recovery -Directory $Directory -TimeoutMs $TimeoutMs)
}
function Test-InstallerRuntimeReady([string]$Root,[string]$Directory,[int]$ExpectedPid=0,[string]$PreviousOwner='',[Diagnostics.Stopwatch]$Budget=$null) {
  $remaining=if($Budget){20000-$Budget.ElapsedMilliseconds}else{20000}
  if($remaining -le 0){return $false}
  try{return (Invoke-InstallerHelper -Kind Ready -Directory $Directory -Root $Root -TimeoutMs $remaining -ExpectedPid $ExpectedPid -PreviousOwner $PreviousOwner).ready -eq $true}catch{return $false}
}
function Prepare-UpgradeRuntime([string]$Root,[string]$Directory) {
  $status=Get-UpgradeRuntimeStatus $Root $Directory
  Assert-NoInFlightTasks $status
  $locks=(Test-Path -LiteralPath (Join-Path $Directory 'supervisor.lock')) -or (Test-Path -LiteralPath (Join-Path $Directory 'service.lock'))
  $statePath=Join-Path $Directory 'supervisor-state.json'
  $priorState=if(Test-Path -LiteralPath $statePath){Read-Json $statePath}else{$null}
  if($locks -or ($priorState -and $priorState.cleanup_complete -ne $true)) {
    $recovery=Invoke-InstallerRecovery $Directory
    if($recovery.clearPreviousState) {
      Assert-RuntimeLocksReleased $Directory
      # A proven crashed running instance should resume after upgrade/rollback;
      # completed shutdown and failure states retain their stopped intent.
      return ($priorState.phase -cin @('running','starting') -and $priorState.cleanup_complete -ne $true)
    }
    if(Test-InstallerRuntimeReady $Root $Directory){return $true}
    throw 'stale_lock_requires_recovery'
  }
  if($status.supervisor -eq 'stopped' -and $status.service -eq 'stopped'){return $false}
  # No locks but a possibly live legacy owner is not silently stopped or restarted.
  throw 'runtime_state_requires_recovery'
}
function Start-InstallerSupervisor([string]$Root,[string]$Directory) {
  $budget=[Diagnostics.Stopwatch]::StartNew()
  Assert-RuntimeLocksReleased $Directory
  $statePath=Join-Path $Directory 'supervisor-state.json'
  $previousOwner=if(Test-Path -LiteralPath $statePath){(Read-Json $statePath).owner}else{''}
  # Absence of locks does not prove the old guardian or Tunnel tree stopped.
  # The current strict helper must exclude all recorded children and endpoint.
  $recovery=Invoke-InstallerRecovery $Directory (20000-$budget.ElapsedMilliseconds)
  if(-not $recovery.clearPreviousState){throw 'rollback_runtime_requires_recovery'}
  Assert-RuntimeLocksReleased $Directory
  $receipt=Invoke-InstallerHelper -Kind Supervisor -Directory $Directory -Root $Root -TimeoutMs (20000-$budget.ElapsedMilliseconds)
  if(-not $receipt.pid){throw 'rollback_background_launch_unconfirmed'}
  while($budget.ElapsedMilliseconds -lt 19000) {
    if(Test-InstallerRuntimeReady $Root $Directory $receipt.pid $previousOwner $budget){return}
    Start-Sleep -Milliseconds 100
  }
  throw 'rollback_supervisor_start_unconfirmed'
}
function Find-Codex {
  $found=Get-Command codex.exe -ErrorAction SilentlyContinue
  if($found) { return $found.Source }
  $base=Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
  if(Test-Path -LiteralPath $base) {
    foreach($dir in Get-ChildItem -LiteralPath $base -Directory | Sort-Object LastWriteTimeUtc -Descending) {
      $candidate=Join-Path $dir.FullName 'codex.exe'
      if(Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
  }
  $shim=Get-Command codex.cmd -ErrorAction SilentlyContinue
  if($shim) {
    $prefix=Split-Path -Parent $shim.Source
    foreach($relative in @('node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe','node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe','node_modules\@openai\codex\vendor\x86_64-pc-windows-msvc\bin\codex.exe','node_modules\@openai\codex\vendor\x86_64-pc-windows-msvc\codex\codex.exe')) {
      $candidate=Join-Path $prefix $relative
      if(Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
  }
  throw 'official_codex_cli_missing'
}
function Assert-State($State) {
  if($State.owner -ne 'codex-dots-bridge-setup' -or $State.schema -ne 1) { throw 'foreign_installer_state' }
  if([IO.Path]::GetFullPath($State.install_directory).TrimEnd('\') -ine $InstallDirectory) { throw 'installer_directory_mismatch' }
  if($State.version -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$') { throw 'invalid_installer_version' }
  $expected=Join-Path $InstallDirectory ('payload\'+$State.version)
  if($State.payload_root -ine $expected) { throw 'invalid_payload_root' }
  Assert-SafePath $State.payload_root
  Assert-SafePath $State.data_dir
  Assert-SafePath $State.codex_home
  Assert-SafePath $State.app_data
}
function Resolve-SetupDataDirectory($Prior,[string]$Requested,[string]$CodexDirectory,[string]$Command) {
  if($Prior) { return $Prior.data_dir }
  if($Requested) { return [IO.Path]::GetFullPath($Requested) }
  # Query only the selected Codex home. A named entry is a candidate, never proof of ownership.
  Assert-SafePath $CodexDirectory
  if((Test-Path -LiteralPath $CodexDirectory) -and -not (Test-Path -LiteralPath $CodexDirectory -PathType Container)) { throw 'invalid_codex_home' }
  New-Item -ItemType Directory -Path $CodexDirectory -Force | Out-Null
  Assert-SafePath $CodexDirectory
  $process=[Diagnostics.Process]::new()
  try {
    $start=[Diagnostics.ProcessStartInfo]::new($Command,'mcp list --json')
    $start.UseShellExecute=$false;$start.CreateNoWindow=$true
    $start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
    $start.StandardOutputEncoding=[Text.UTF8Encoding]::new($false)
    $start.EnvironmentVariables['CODEX_HOME']=$CodexDirectory
    $process.StartInfo=$start
    if(-not $process.Start()) { throw 'codex_cli_operation_failed' }
    $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
    if(-not $process.WaitForExit(10000)) { $process.Kill();throw 'codex_cli_operation_failed' }
    $text=$stdout.GetAwaiter().GetResult();$null=$stderr.GetAwaiter().GetResult()
    if($process.ExitCode -ne 0) { throw 'codex_cli_operation_failed' }
    if($text.TrimStart() -notmatch '^\[') { throw 'invalid_codex_mcp_list' }
    try { $entries=$text | ConvertFrom-Json } catch { throw 'invalid_codex_mcp_list' }
  } catch {
    if($_.Exception.Message -eq 'invalid_codex_mcp_list') { throw 'invalid_codex_mcp_list' }
    throw 'codex_cli_operation_failed'
  } finally { $process.Dispose() }
  $namedEntries=@($entries | Where-Object {$_.name -ceq 'codex-dots-bridge'})
  if(-not $namedEntries.Count) { return (Join-Path $env:LOCALAPPDATA 'CodexDotsBridge\data') }
  if($namedEntries.Count -ne 1) { throw 'ambiguous_registered_bridge_entry' }
  $entry=$namedEntries[0];$args=@($entry.transport.args)
  if($entry.transport.type -cne 'stdio' -or $args.Count -ne 4 -or $args[1] -cne 'stdio' -or $args[2] -cne '--data-dir' -or $args[0] -isnot [string] -or $args[3] -isnot [string] -or -not [IO.Path]::IsPathRooted($args[0]) -or -not [IO.Path]::IsPathRooted($args[3])) { throw 'foreign_registered_bridge_entry' }
  $root=[IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $args[0])))
  $candidate=[IO.Path]::GetFullPath($args[3])
  if($args[0] -cne (Join-Path $root 'dist\main.js')) { throw 'foreign_registered_bridge_entry' }
  Assert-SafePath $candidate;Assert-SafePath $root
  $manifestPath=Join-Path $candidate 'installation.json'
  if(-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'installation_missing_owned_registration' }
  $manifest=Read-Json $manifestPath
  if($manifest.owner -cne 'codex-dots-bridge' -or $manifest.codex_home -cne $CodexDirectory -or $manifest.mcp.name -cne 'codex-dots-bridge' -or $manifest.mcp.command -cne $entry.transport.command -or ($manifest.mcp.args | ConvertTo-Json -Compress) -cne ($args | ConvertTo-Json -Compress)) { throw 'foreign_installation_manifest' }
  Assert-OldCliIdentity $null $manifest
  Assert-OwnedRegistration $root $candidate $CodexDirectory $Command | Out-Null
  return $candidate
}
function Assert-OwnedRegistration([string]$Root,[string]$Directory,[string]$CodexDirectory,[string]$Command) {
  # Use the original runtime's schema and the native CLI. This is a read-only ownership gate.
  $request=@{root=$Root;dir=$Directory;home=$CodexDirectory;command=$Command;node=(Runtime-Node $Root)} | ConvertTo-Json -Compress
  $env:BRIDGE_SETUP_REQUEST=$request
  $probe=@'
import {existsSync,readFileSync,readdirSync,lstatSync} from 'node:fs';
import {join,resolve,dirname,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const r=JSON.parse(process.env.BRIDGE_SETUP_REQUEST);
function fail(code){throw new Error(code)}
function safe(p){for(let c=resolve(p);;c=dirname(c)){if(existsSync(c)&&lstatSync(c).isSymbolicLink())fail('unsafe_reparse_path');if(c===dirname(c))break;}}
function tree(root,prefix=''){safe(root);const out={};for(const n of readdirSync(root)){const p=join(root,n),key=prefix?prefix+'/'+n:n,s=lstatSync(p);if(s.isSymbolicLink())fail('unsafe_skill');if(s.isDirectory())Object.assign(out,tree(p,key));else if(s.isFile())out[key]=createHash('sha256').update(readFileSync(p)).digest('hex');else fail('unsafe_skill');}return out;}
try {
  safe(r.root);safe(r.dir);safe(r.home);
  const {readProductionConfig}=await import(pathToFileURL(join(r.root,'dist/runtime.js')).href);
  const config=readProductionConfig(r.dir),manifestPath=join(r.dir,'installation.json');
  if(!existsSync(manifestPath))fail('installation_missing_owned_registration');
  safe(manifestPath);const m=JSON.parse(readFileSync(manifestPath,'utf8'));
  if(m.owner!=='codex-dots-bridge'||m.instance_id!==config.instance_id||m.codex_home!==resolve(r.home)||m.mcp.name!=='codex-dots-bridge'||m.skill.path!==join(m.codex_home,'skills','codex-dots-bridge')||m.mcp.command!==resolve(r.node)||JSON.stringify(m.mcp.args)!==JSON.stringify([resolve(join(r.root,'dist/main.js')),'stdio','--data-dir',resolve(r.dir)]))fail('foreign_installation_manifest');
  const entries=JSON.parse(execFileSync(r.command,['mcp','list','--json'],{env:{...process.env,CODEX_HOME:r.home},encoding:'utf8',windowsHide:true,stdio:'pipe',timeout:30000}));
  const e=entries.find(e=>e.name===m.mcp.name);
  if(e&&(e.transport.type!=='stdio'||e.transport.command!==m.mcp.command||JSON.stringify(e.transport.args??[])!==JSON.stringify(m.mcp.args)||(m.mcp_registration!==undefined&&JSON.stringify(e)!==JSON.stringify(m.mcp_registration))))fail('modified_or_foreign_mcp');
  if(existsSync(m.skill.path))for(const [name,hash] of Object.entries(tree(m.skill.path)))if(m.skill.files[name]!==hash)fail('modified_or_foreign_skill');
  if(m.autostart){const expected=join(process.env.APPDATA,'Microsoft/Windows/Start Menu/Programs/Startup/CodexDotsBridge.vbs');if(m.autostart.path!==expected)fail('invalid_autostart_path');safe(expected);if(existsSync(expected)&&readFileSync(expected,'utf8')!==m.autostart.content)fail('modified_or_foreign_autostart');}
  console.log(JSON.stringify({owned:true,autostart:!!m.autostart}));
}catch(e){console.log(JSON.stringify({error:/^[a-z][a-z0-9_]*$/.test(e.message)?e.message:'ownership_check_failed'}));process.exitCode=1;}
'@
  try {
    $text=@(& (Runtime-Node $Root) --input-type=module -e $probe)
    $exitCode=$LASTEXITCODE
    $result=($text -join "`n") | ConvertFrom-Json
    if($exitCode -ne 0) { throw $result.error }
    return $result
  } finally { Remove-Item Env:BRIDGE_SETUP_REQUEST -ErrorAction SilentlyContinue }
}
function Assert-FreshRegistration([string]$CodexDirectory,[string]$Command,[bool]$EnableAutostart) {
  Assert-SafePath $CodexDirectory
  if(Test-Path -LiteralPath (Join-Path $CodexDirectory 'skills\codex-dots-bridge')) { throw 'foreign_or_modified_skill_collision' }
  if(Test-Path -LiteralPath $CodexDirectory) {
    $priorHome=$env:CODEX_HOME
    try {
      $env:CODEX_HOME=$CodexDirectory
      $text=@(& $Command mcp list --json)
      if($LASTEXITCODE -ne 0) { throw 'codex_cli_operation_failed' }
      $entries=($text -join "`n") | ConvertFrom-Json
      if(@($entries | Where-Object {$_.name -eq 'codex-dots-bridge'}).Count) { throw 'foreign_mcp_collision' }
    } finally { if($null -eq $priorHome){Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue}else{$env:CODEX_HOME=$priorHome} }
  }
  if($EnableAutostart) {
    $startup=Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\CodexDotsBridge.vbs'
    Assert-SafePath $startup
    if(Test-Path -LiteralPath $startup) { throw 'foreign_autostart_collision' }
  }
}
function Setup-Registration([string]$Root,$Settings,[bool]$EnableAutostart,[string]$TunnelClient,[string]$Command='') {
  if(-not $Command) { $Command=$Settings.codex_command }
  $args=@('setup','--data-dir',$Settings.data_dir,'--codex-home',$Settings.codex_home,'--codex-command',$Command)
  if($EnableAutostart) { $args+='--autostart' }
  if($TunnelClient) {
    $config=Read-Json (Join-Path $Settings.data_dir 'config.json')
    $args+=@('--tunnel-id',$config.tunnel.tunnel_id,'--organization-id',$config.tunnel.organization_id,'--tunnel-env',$config.tunnel.key_file,'--tunnel-client',$TunnelClient)
  }
  Invoke-Bridge $Root $args | Out-Null
}
function Assert-OldCliIdentity($Prior,$Manifest) {
  if(-not $Manifest.codex_command -or -not [IO.Path]::IsPathRooted($Manifest.codex_command) -or [IO.Path]::GetExtension($Manifest.codex_command) -ine '.exe') { throw 'invalid_old_codex_cli_identity' }
  if($Prior -and $Manifest.codex_command -cne $Prior.codex_command) { throw 'installer_cli_identity_mismatch' }
}
function Test-CodexCommand([string]$Command,[string]$CodexDirectory,[string]$Root) {
  try {
    if(-not $Command -or [IO.Path]::GetExtension($Command) -ine '.exe' -or -not (Test-Path -LiteralPath $Command -PathType Leaf)) { return $false }
    Assert-SafePath $Command
    $node=Runtime-Node $Root
    if(-not (Test-Path -LiteralPath $node -PathType Leaf)) { return $false }
    $request=@{command=$Command;home=$CodexDirectory} | ConvertTo-Json -Compress
    $previousRequest=$env:BRIDGE_SETUP_CLI_REQUEST
    $env:BRIDGE_SETUP_CLI_REQUEST=$request
    $probe=@'
import {execFileSync} from 'node:child_process';
try {
 const r=JSON.parse(process.env.BRIDGE_SETUP_CLI_REQUEST);
 const entries=JSON.parse(execFileSync(r.command,['mcp','list','--json'],{env:{...process.env,CODEX_HOME:r.home},encoding:'utf8',windowsHide:true,stdio:'pipe',timeout:10000}));
 const usable=Array.isArray(entries)&&entries.every(e=>e&&typeof e==='object'&&typeof e.name==='string'&&e.name.length>0&&e.transport&&typeof e.transport==='object'&&typeof e.transport.type==='string');
 console.log(JSON.stringify({usable}));
}catch{console.log(JSON.stringify({usable:false}));}
'@
    try {
      $output=@(& $node --input-type=module -e $probe)
      if($LASTEXITCODE -ne 0) { return $false }
      return (($output -join "`n") | ConvertFrom-Json).usable -eq $true
    } finally { if($null -eq $previousRequest){Remove-Item Env:BRIDGE_SETUP_CLI_REQUEST -ErrorAction SilentlyContinue}else{$env:BRIDGE_SETUP_CLI_REQUEST=$previousRequest} }
  } catch { return $false }
}
function Rollback-CodexCommand($Transaction) {
  # Probe before changing any registration. Prefer the old owned CLI only while it still
  # implements the read-only MCP list operation; otherwise use the verified replacement.
  $probeRoot=if($Transaction.old_root){$Transaction.old_root}else{$Transaction.new_root}
  foreach($command in @($Transaction.old_codex_command,$Transaction.codex_command)) {
    if(Test-CodexCommand $command $Transaction.codex_home $probeRoot) { return [IO.Path]::GetFullPath($command) }
  }
  throw 'no_usable_codex_cli_for_rollback'
}
function Read-FallbackState($Transaction,[string]$Command) {
  if($Command -ceq $Transaction.old_codex_command -or -not $Transaction.old_installer_state) { return $null }
  $state=Read-Json $statePath; Assert-State $state
  if($state.payload_root -ine $Transaction.old_root -or $state.codex_command -cne $Transaction.old_codex_command -or $state.installer_app_id -cne $Transaction.installer_app_id) { throw 'rollback_installer_state_changed' }
  return $state
}
function Resolve-OldRuntimeRoot($Config,[string]$RegistrationRoot) {
  if(-not $Config.installation) { return $RegistrationRoot }
  try {
    $binding=$Config.installation
    if(-not [IO.Path]::IsPathRooted($binding.root) -or -not [IO.Path]::IsPathRooted($binding.node_path)) { throw 'invalid_old_runtime_metadata' }
    $root=[IO.Path]::GetFullPath($binding.root);$node=Runtime-Node $root
    if([IO.Path]::GetFullPath($binding.node_path) -cne $node) { throw 'invalid_old_runtime_metadata' }
    foreach($path in @($root,$node,(Join-Path $root 'package.json'),(Join-Path $root 'dist\main.js'))) { Assert-SafePath $path }
    foreach($path in @($node,(Join-Path $root 'package.json'),(Join-Path $root 'dist\main.js'))) { if(-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'invalid_old_runtime_metadata' } }
    $package=Read-Json (Join-Path $root 'package.json')
    if($package.name -cne 'codex-dots-bridge' -or $package.version -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$') { throw 'invalid_old_runtime_metadata' }
    return $root
  } catch { throw 'invalid_old_runtime_metadata' }
}
function Remove-Registration([string]$Root,$Settings) {
  $removed=Invoke-Bridge $Root @('uninstall','--data-dir',$Settings.data_dir,'--codex-command',$Settings.codex_command)
  if(@($removed.retained | Where-Object { $_ -like 'modified_*' }).Count) { throw 'modified_registration_retained' }
}
function Restore-TrayShortcut($Transaction) {
  # Old contents are a byte snapshot only; never launch or trust their target.
  if(-not $Transaction.shortcut_path) { return }
  $path=$Transaction.shortcut_path; Assert-SafePath $path
  $exists=Test-Path -LiteralPath $path
  $actual=if($exists){[Convert]::ToBase64String([IO.File]::ReadAllBytes($path))}else{''}
  if($exists -and $Transaction.old_shortcut_exists -and $actual -ceq $Transaction.old_shortcut_bytes) { return }
  if($exists) {
    $shell=$null;$shortcut=$null
    try {
      $shell=New-Object -ComObject WScript.Shell;$shortcut=$shell.CreateShortcut($path)
      $expectedArguments='--show --data-dir "'+($Transaction.data_dir -replace '(\\+)$','$1$1')+'"'
      if($shortcut.TargetPath -ine (Join-Path $Transaction.new_root 'CodexDotsBridge.Tray.exe') -or $shortcut.Arguments -cne $expectedArguments -or $shortcut.WorkingDirectory -ine $Transaction.new_root) { throw 'shortcut_changed_during_install' }
    } finally {
      if($shortcut) { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) | Out-Null }
      if($shell) { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null }
    }
    if([Convert]::ToBase64String([IO.File]::ReadAllBytes($path)) -cne $actual) { throw 'shortcut_changed_during_install' }
  }
  if($Transaction.old_shortcut_exists) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
    [IO.File]::WriteAllBytes($path,[Convert]::FromBase64String($Transaction.old_shortcut_bytes))
  } elseif($exists) { Remove-Item -LiteralPath $path }
}
function Rollback-Transaction($Transaction) {
  $env:APPDATA=$Transaction.app_data
  $runtimeRoot=''
  if($Transaction.was_running) {
    $runtimeRoot=Resolve-OldRuntimeRoot $Transaction.old_config $Transaction.old_root
    if(-not $runtimeRoot) { throw 'invalid_old_runtime_metadata' }
    if($Transaction.old_runtime_root -and $Transaction.old_runtime_root -cne $runtimeRoot) { throw 'old_runtime_binding_changed' }
  }
  if($Transaction.registration_changed) {
    Stop-Tray $Transaction.new_root $Transaction.data_dir
    $rollbackCommand=Rollback-CodexCommand $Transaction
    $fallbackState=Read-FallbackState $Transaction $rollbackCommand
    $fallbackStateText=if($fallbackState){[IO.File]::ReadAllText($statePath)}else{''}
    $cleanupSettings=[pscustomobject]@{data_dir=$Transaction.data_dir;codex_command=$rollbackCommand}
    if(Test-Path -LiteralPath (Join-Path $Transaction.data_dir 'installation.json')) {
      $registrationRoot=$Transaction.current_registration_root
      Assert-OwnedRegistration $registrationRoot $Transaction.data_dir $Transaction.codex_home $rollbackCommand | Out-Null
      if($registrationRoot -ceq $Transaction.new_root) {
        Invoke-Bridge $registrationRoot @('run','--stop','--data-dir',$Transaction.data_dir) | Out-Null
        Assert-RuntimeLocksReleased $Transaction.data_dir
      }
      Remove-Registration $registrationRoot $cleanupSettings
    }
    if($Transaction.old_config_text) {
      $configPath=Join-Path $Transaction.data_dir 'config.json'; Assert-SafePath $configPath
      [IO.File]::WriteAllText($configPath,$Transaction.old_config_text,[Text.UTF8Encoding]::new($false))
    }
    if($Transaction.old_root) {
      # Persist the attempted owner before setup can partially write its manifest.
      # A later explicit recovery must inspect this root even if setup then fails.
      $Transaction.current_registration_root=$Transaction.old_root
      if(Test-Path -LiteralPath $transactionPath) { Write-Json $transactionPath $Transaction }
      Setup-Registration $Transaction.old_root $Transaction $Transaction.old_autostart '' $rollbackCommand
    }
    # setup restores the old caller registration but writes its own runtime binding.
    # Restore the original config again before restarting the independently bound runtime.
    if($Transaction.old_config_text) { [IO.File]::WriteAllText($configPath,$Transaction.old_config_text,[Text.UTF8Encoding]::new($false)) }
    if($fallbackState) {
      $currentState=Read-FallbackState $Transaction $rollbackCommand
      if([IO.File]::ReadAllText($statePath) -cne $fallbackStateText) { throw 'rollback_installer_state_changed' }
      $currentState.codex_command=$rollbackCommand
      Assert-OldCliIdentity $currentState (Read-Json (Join-Path $Transaction.data_dir 'installation.json'))
      Write-Json $statePath $currentState
    }
  }
  if($Transaction.was_running -and $runtimeRoot) {
    if(-not (Test-InstallerRuntimeReady $runtimeRoot $Transaction.data_dir)) {
      Assert-RuntimeLocksReleased $Transaction.data_dir
      Start-InstallerSupervisor $runtimeRoot $Transaction.data_dir
    }
  }
  if($Transaction.was_tray_running -and $Transaction.old_root) { Start-Tray $Transaction.old_root $Transaction.data_dir }
  if($Transaction.shortcut_path) { Restore-TrayShortcut $Transaction }
  Remove-Item -LiteralPath $transactionPath -ErrorAction SilentlyContinue
}

try {
  Assert-SafePath $InstallDirectory
  if($InstallDirectory -eq [IO.Path]::GetPathRoot($InstallDirectory).TrimEnd('\')) { throw 'unsafe_install_directory' }
  if($Action -eq 'Prepare') {
    if(-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { throw 'windows_x64_required' }
    if($NewVersion -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$' -or $PackageFingerprint -notmatch '^[a-f0-9]{64}$') { throw 'invalid_release_identity' }
    if($InstallerIdentity -notmatch '^CodexDotsBridgeSetup(?:\.Test\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$') { throw 'invalid_installer_identity' }
    $prior=$null
    if(Test-Path -LiteralPath $statePath) { $prior=Read-Json $statePath; Assert-State $prior }
    if(Test-Path -LiteralPath $transactionPath) { throw 'previous_installation_requires_recovery' }
    if(Test-Path -LiteralPath $InstallDirectory) {
      foreach($item in Get-ChildItem -LiteralPath $InstallDirectory -Force) {
        if($item.Name -notmatch '^(payload|setup-lifecycle\.ps1|launch-background\.ps1|recover-reboot-locks\.ps1|installation-state\.json|\.setup-result\.txt|unins\d+\.(exe|dat|msg))$') { throw 'foreign_install_directory_entry' }
      }
      if(-not $prior -and @(Get-ChildItem -LiteralPath $InstallDirectory -Force).Count) { throw 'unowned_install_directory' }
    }
    $validatedDirectory=$true
    if($prior) {
      if($prior.installer_app_id -ne $InstallerIdentity) { throw 'installer_identity_mismatch' }
      if($DataDir -and [IO.Path]::GetFullPath($DataDir) -ine $prior.data_dir) { throw 'data_directory_change_not_supported' }
      if($CodexHome -and [IO.Path]::GetFullPath($CodexHome) -ine $prior.codex_home) { throw 'codex_home_change_not_supported' }
      if($AppDataDirectory -and [IO.Path]::GetFullPath($AppDataDirectory) -ine $prior.app_data) { throw 'startup_directory_change_not_supported' }
      $DataDir=$prior.data_dir; $CodexHome=$prior.codex_home; $AppDataDirectory=$prior.app_data
      if($prior.version -eq $NewVersion -and $prior.package_fingerprint -ne $PackageFingerprint) { throw 'same_version_payload_changed' }
    }
    if(-not $CodexHome) { $CodexHome=if($env:CODEX_HOME){$env:CODEX_HOME}else{Join-Path $env:USERPROFILE '.codex'} }
    if(-not $AppDataDirectory) { $AppDataDirectory=$env:APPDATA }
    $CodexHome=[IO.Path]::GetFullPath($CodexHome); $AppDataDirectory=[IO.Path]::GetFullPath($AppDataDirectory)
    foreach($path in @($CodexHome,$AppDataDirectory)) { Assert-SafePath $path }
    $env:APPDATA=$AppDataDirectory
    if(-not $CodexCommand) { $CodexCommand=Find-Codex }
    $CodexCommand=[IO.Path]::GetFullPath($CodexCommand); Assert-SafePath $CodexCommand
    if(-not (Test-Path -LiteralPath $CodexCommand -PathType Leaf) -or [IO.Path]::GetExtension($CodexCommand) -ine '.exe') { throw 'official_codex_cli_missing' }
    $DataDir=Resolve-SetupDataDirectory $prior $DataDir $CodexHome $CodexCommand
    Assert-SafePath $DataDir
    if($DataDir -ieq $InstallDirectory -or $DataDir.StartsWith($InstallDirectory+'\',[StringComparison]::OrdinalIgnoreCase) -or $InstallDirectory.StartsWith($DataDir.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'data_program_path_overlap' }
    $oldRoot=''; $oldRuntimeRoot=''; $oldCodexCommand=''; $oldConfig=$null; $oldConfigText=''; $oldAutostart=$false; $wasRunning=$false; $wasTrayRunning=$false
    if(Test-Path -LiteralPath (Join-Path $DataDir 'config.json')) {
      $oldConfig=Read-Json (Join-Path $DataDir 'config.json')
      $oldConfigText=[IO.File]::ReadAllText((Join-Path $DataDir 'config.json'))
      if($oldConfig.owner -ne 'codex-dots-bridge') { throw 'unowned_data_directory' }
      if(Test-Path -LiteralPath (Join-Path $DataDir 'installation.json')) {
        $manifest=Read-Json (Join-Path $DataDir 'installation.json')
        Assert-OldCliIdentity $prior $manifest
        $oldRoot=[IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $manifest.mcp.args[0])))
        if($prior -and $oldRoot -ine $prior.payload_root) { throw 'registered_payload_mismatch' }
        $ownership=Assert-OwnedRegistration $oldRoot $DataDir $CodexHome $CodexCommand
        $oldCodexCommand=$manifest.codex_command
        if(-not (Test-CodexCommand $oldCodexCommand $CodexHome $oldRoot) -and -not (Test-CodexCommand $CodexCommand $CodexHome $oldRoot)) { throw 'no_usable_codex_cli_for_rollback' }
        $oldAutostart=[bool]$ownership.autostart
        $oldRuntimeRoot=Resolve-OldRuntimeRoot $oldConfig $oldRoot
        $wasRunning=Prepare-UpgradeRuntime $oldRuntimeRoot $DataDir
        $wasTrayRunning=Tray-Running $oldRoot $DataDir
      } else {
        if((Test-Path -LiteralPath (Join-Path $DataDir 'supervisor.lock')) -or (Test-Path -LiteralPath (Join-Path $DataDir 'service.lock'))) { throw 'unregistered_running_instance' }
        Assert-FreshRegistration $CodexHome $CodexCommand ([bool]$Autostart)
      }
    } else {
      if((Test-Path -LiteralPath $DataDir) -and @(Get-ChildItem -LiteralPath $DataDir -Force).Count) { throw 'unowned_data_directory' }
      Assert-FreshRegistration $CodexHome $CodexCommand ([bool]$Autostart)
    }
    New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
    $newRoot=Join-Path $InstallDirectory ('payload\'+$NewVersion)
    Assert-SafePath $newRoot
    if(Test-Path -LiteralPath $newRoot) {
      if(-not $prior -or $prior.version -ne $NewVersion) { throw 'unowned_payload_directory' }
      if((Get-FileHash -LiteralPath (Join-Path $newRoot 'release-manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $PackageFingerprint) { throw 'installed_payload_manifest_changed' }
      & (Join-Path $newRoot 'scripts\check-package.ps1') -PackageRoot $newRoot | Out-Null
    }
    $shortcutPath='';$oldShortcutExists=$false;$oldShortcutBytes=''
    if($ShortcutDirectory) {
      $shortcutPath=Join-Path ([IO.Path]::GetFullPath($ShortcutDirectory)) 'Codex Dots Bridge.lnk';Assert-SafePath $shortcutPath
      $oldShortcutExists=Test-Path -LiteralPath $shortcutPath
      if($oldShortcutExists) { $oldShortcutBytes=[Convert]::ToBase64String([IO.File]::ReadAllBytes($shortcutPath)) }
    }
    $transaction=[ordered]@{schema=1;owner='codex-dots-bridge-setup';install_directory=$InstallDirectory;installer_app_id=$InstallerIdentity;version=$NewVersion;package_fingerprint=$PackageFingerprint;new_root=$newRoot;data_dir=$DataDir;codex_home=$CodexHome;codex_command=$CodexCommand;app_data=$AppDataDirectory;autostart=([bool]$Autostart -or $oldAutostart);old_root=$oldRoot;old_runtime_root=$oldRuntimeRoot;old_codex_command=$oldCodexCommand;old_installer_state=([bool]$prior);old_config=$oldConfig;old_config_text=$oldConfigText;old_autostart=$oldAutostart;was_running=$wasRunning;was_tray_running=$wasTrayRunning;registration_changed=$false;current_registration_root=$oldRoot;shortcut_path=$shortcutPath;old_shortcut_exists=$oldShortcutExists;old_shortcut_bytes=$oldShortcutBytes}
    Write-Json $transactionPath $transaction
    $ownsTransaction=$true
    if($oldRoot) { Stop-Tray $oldRoot $DataDir }
    if($oldRuntimeRoot -and ((Test-Path -LiteralPath (Join-Path $DataDir 'supervisor.lock')) -or (Test-Path -LiteralPath (Join-Path $DataDir 'service.lock')))) { Invoke-Bridge $oldRuntimeRoot @('run','--stop','--data-dir',$DataDir) | Out-Null }
    Assert-RuntimeLocksReleased $DataDir
    # Inno caches the resolved instance for the direct Tray shortcut before Commit replaces this result.
    [IO.File]::WriteAllText($resultPath,$DataDir,[Text.UTF8Encoding]::new($false))
  } elseif($Action -eq 'Commit') {
    $transaction=Read-Json $transactionPath; $env:APPDATA=$transaction.app_data
    if($transaction.install_directory -ine $InstallDirectory -or $transaction.owner -ne 'codex-dots-bridge-setup') { throw 'foreign_installation_transaction' }
    $validatedDirectory=$true
    Assert-SafePath $transaction.new_root
    & (Join-Path $transaction.new_root 'scripts\check-package.ps1') -PackageRoot $transaction.new_root | Out-Null
    if((Get-FileHash -LiteralPath (Join-Path $transaction.new_root 'release-manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $transaction.package_fingerprint) { throw 'payload_manifest_changed' }
    if($transaction.old_root) {
      Assert-OwnedRegistration $transaction.old_root $transaction.data_dir $transaction.codex_home $transaction.codex_command | Out-Null
      $oldRuntimeRoot=Resolve-OldRuntimeRoot $transaction.old_config $transaction.old_root
      if($transaction.old_runtime_root -and $transaction.old_runtime_root -cne $oldRuntimeRoot) { throw 'old_runtime_binding_changed' }
      Stop-Tray $transaction.old_root $transaction.data_dir
      if((Test-Path -LiteralPath (Join-Path $transaction.data_dir 'supervisor.lock')) -or (Test-Path -LiteralPath (Join-Path $transaction.data_dir 'service.lock'))) { Invoke-Bridge $oldRuntimeRoot @('run','--stop','--data-dir',$transaction.data_dir) | Out-Null }
    } else { Assert-FreshRegistration $transaction.codex_home $transaction.codex_command $transaction.autostart }
    Assert-RuntimeLocksReleased $transaction.data_dir
    $client=Select-TunnelClientForUpgrade $transaction
    $transaction.registration_changed=$true; Write-Json $transactionPath $transaction
    if($transaction.old_root) { Remove-Registration $transaction.old_root $transaction }
    $transaction.current_registration_root=$transaction.new_root; Write-Json $transactionPath $transaction
    Setup-Registration $transaction.new_root $transaction $transaction.autostart $client
    $config=Read-Json (Join-Path $transaction.data_dir 'config.json')
    $connection='pending_official_account_setup'
    if($transaction.old_root -and -not $transaction.was_running -and $config.tunnel) { $connection='stopped_preserved' }
    elseif($transaction.old_root -and $transaction.was_running) {
      try {
        Invoke-Bridge $transaction.new_root @('run','--data-dir',$transaction.data_dir) | Out-Null
        $connection=if($config.tunnel){'started_requires_real_acceptance'}else{'local_started_pending_official_account_setup'}
      } catch { $connection='pending_connection_diagnostics' }
    }
    elseif($config.tunnel -and (Test-Path -LiteralPath $config.tunnel.key_file -PathType Leaf) -and (Test-Path -LiteralPath $config.tunnel.client_path -PathType Leaf)) {
      # Registration and data preservation define installation success. A connection failure remains pending.
      try { Invoke-Bridge $transaction.new_root @('run','--data-dir',$transaction.data_dir) | Out-Null; $connection='started_requires_real_acceptance' } catch { $connection='pending_connection_diagnostics' }
    }
    $state=[ordered]@{owner='codex-dots-bridge-setup';schema=1;install_directory=$InstallDirectory;installer_app_id=$transaction.installer_app_id;version=$transaction.version;package_fingerprint=$transaction.package_fingerprint;payload_root=$transaction.new_root;data_dir=$transaction.data_dir;codex_home=$transaction.codex_home;codex_command=$transaction.codex_command;app_data=$transaction.app_data;autostart=$transaction.autostart;connection=$connection}
    Start-Tray $transaction.new_root $transaction.data_dir
    Write-Json $statePath $state
    Remove-Item -LiteralPath $transactionPath
    [IO.File]::WriteAllText($resultPath,$connection,[Text.UTF8Encoding]::new($false))
  } elseif($Action -eq 'Rollback') {
    if(Test-Path -LiteralPath $transactionPath) { Rollback-Transaction (Read-Json $transactionPath) }
  } else {
    $state=Read-Json $statePath; Assert-State $state; $env:APPDATA=$state.app_data
    $validatedDirectory=$true
    $currentCommand=$state.codex_command
    if($CodexCommand) { $currentCommand=$CodexCommand } elseif(-not (Test-Path -LiteralPath $currentCommand -PathType Leaf)) { $currentCommand=Find-Codex }
    $state.codex_command=$currentCommand
    if($Action -eq 'Uninstall' -or $Action -eq 'PreflightUninstall') {
      if(Test-Path -LiteralPath $transactionPath) { throw 'previous_installation_requires_recovery' }
      Assert-OwnedRegistration $state.payload_root $state.data_dir $state.codex_home $currentCommand | Out-Null
      if($Action -eq 'Uninstall') {
        Stop-Tray $state.payload_root $state.data_dir
        Invoke-Bridge $state.payload_root @('run','--stop','--data-dir',$state.data_dir) | Out-Null
        Remove-Registration $state.payload_root $state
      }
    } elseif($Action -eq 'Tray') {
      Assert-OwnedRegistration $state.payload_root $state.data_dir $state.codex_home $currentCommand | Out-Null
      if(-not (Tray-Path $state.payload_root)) { throw 'tray_not_installed' }
      Start-Tray $state.payload_root $state.data_dir -Show
    } else {
      Assert-OwnedRegistration $state.payload_root $state.data_dir $state.codex_home $currentCommand | Out-Null
      $status=Invoke-Bridge $state.payload_root @('status','--data-dir',$state.data_dir)
      if($status.supervisor -ne 'stopped' -or $status.service -ne 'stopped') {
        $doctor=Invoke-Bridge $state.payload_root @('doctor','--data-dir',$state.data_dir)
        Write-Output ('本实例正在运行；诊断：service={0}; supervisor={1}; tunnel={2}; tunnel_health={3}' -f $doctor.service,$doctor.supervisor,$doctor.tunnel,$doctor.tunnel_health)
        $stopCommand="& '"+(Runtime-Node $state.payload_root).Replace("'","''")+"' '"+(Join-Path $state.payload_root 'dist\main.js').Replace("'","''")+"' run --stop --data-dir '"+$state.data_dir.Replace("'","''")+"'"
        Write-Output '需要配置或重新连接时，先执行以下命令停止本实例，再重开本入口：'
        Write-Output $stopCommand
        Write-Output '云端工具加载和 Dot 任务结果仍需实际验收。'
      } else {
        $ownership=Assert-OwnedRegistration $state.payload_root $state.data_dir $state.codex_home $currentCommand
        $options=@{DataDir=$state.data_dir;CodexHome=$state.codex_home;CodexCommand=$currentCommand;Autostart=[bool]$ownership.autostart}
        & (Join-Path $state.payload_root 'scripts\install.ps1') @options
      }
    }
  }
  exit 0
} catch {
  $code=$_.Exception.Message
  if($code -notmatch '^[a-z][a-z0-9_]*$') { $code='installer_operation_failed' }
  if(($Action -eq 'Commit' -or $ownsTransaction) -and (Test-Path -LiteralPath $transactionPath)) {
    try { Rollback-Transaction (Read-Json $transactionPath) } catch { $code+='; rollback_requires_manual_recovery' }
  }
  if($Action -ne 'PreflightUninstall' -and ($Action -ne 'Prepare' -or (Test-Path -LiteralPath $statePath)) -and $validatedDirectory -and (Test-Path -LiteralPath $InstallDirectory -PathType Container)) {
    try { Assert-SafePath $resultPath; [IO.File]::WriteAllText($resultPath,$code,[Text.UTF8Encoding]::new($false)) } catch { }
  }
  Write-Output $code
  exit 1
}
