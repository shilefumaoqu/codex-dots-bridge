$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../scripts/recover-reboot-locks.ps1')
$script:checks=0;$script:queries=[Collections.Generic.List[string]]::new();$script:snapshots=0;$script:rows=@();$script:snapshot=@()
function Assert($Value,[string]$Message){if(-not $Value){throw ('assertion: '+$Message)};$script:checks++}
function Get-DotsProcesses{$script:snapshots++;return $script:snapshot}
function Get-CimInstance([string]$ClassName,[string]$Filter,[string[]]$Property,[string]$ErrorAction){
  Assert ($ClassName -eq 'Win32_Process') 'batch queries only process identities'
  Assert (($Property -join ',') -ceq 'ProcessId,Name,CommandLine,CreationDate') 'batch keeps all identity fields'
  $script:queries.Add($Filter)
  return $script:rows
}
function Refused([scriptblock]$Operation,[string]$Expected){
  $failure='';try{& $Operation}catch{$failure=$_.Exception.Message}
  Assert ($failure -ceq $Expected) ('safe refusal: '+$Expected)
}
$dated=[DateTime]::UtcNow.AddSeconds(-30)
$state=[pscustomobject]@{pid=11;bridge_pid=22;guardian_pid=22;tunnel_pid=33}
$config=[pscustomobject]@{installation=$null}
$directory=Join-Path ([IO.Path]::GetTempPath()) 'synthetic-batch-directory'
$script:snapshot=@([pscustomobject]@{ProcessId=11;Name='node.exe';CommandLine=$null},[pscustomobject]@{ProcessId=11;Name='node.exe';CommandLine=$null})
$script:rows=@([pscustomobject]@{ProcessId=11;Name='node.exe';CommandLine='"C:\node.exe" "C:\bridge\dist\main.js" stdio --data-dir "'+$directory+'"';CreationDate=[DateTime]::UtcNow})
Assert-DotsProcessStage $directory $config $state $dated $true
Assert ($queries.Count -eq 1 -and $queries[0] -ceq 'ProcessId=11 OR ProcessId=22 OR ProcessId=33') 'blank-command refresh and recorded identities share one deduplicated query'
Assert ($snapshots -eq 1) 'first phase has its own whole-process sample'

# A PID absent/reused during phase one becomes an original live owner in phase two.
$script:rows=@([pscustomobject]@{ProcessId=22;Name='unrelated.exe';CommandLine='C:\unrelated.exe';CreationDate=$dated.AddSeconds(-1)})
Refused {Assert-DotsProcessStage $directory $config $state $dated $true} 'recorded_process_active'
Assert ($queries.Count -eq 2 -and $snapshots -eq 2) 'second phase does a new full and filtered sample without a cache'

$script:snapshot=@();$script:rows=@([pscustomobject]@{ProcessId=11;Name='other.exe';CommandLine='other';CreationDate=$null})
Refused {Assert-DotsProcessStage $directory $config $state $dated $true} 'recorded_process_unknown'
$script:rows[0].CreationDate=[DateTime]::UtcNow.AddSeconds(10)
Refused {Assert-DotsProcessStage $directory $config $state $dated $true} 'recorded_process_unknown'
$script:rows=@([pscustomobject]@{ProcessId=11;Name='other.exe';CommandLine='other';CreationDate=[DateTime]::UtcNow})
$script:rows+= $script:rows[0]
Refused {Assert-DotsProcessStage $directory $config $state $dated $true} 'recorded_process_unknown'
$script:rows=@([pscustomobject]@{ProcessId=44;Name='other.exe';CommandLine='other';CreationDate=[DateTime]::UtcNow})
Refused {Assert-DotsProcessStage $directory $config $state $dated $true} 'recorded_process_unknown'

$count=$queries.Count
Refused {Assert-DotsProcessStage $directory $config ([pscustomobject]@{pid=11;bridge_pid=1.5}) $dated $true} 'invalid_pid'
Assert ($queries.Count -eq $count) 'invalid recorded PID fails before the query'
$script:snapshot=@([pscustomobject]@{ProcessId=11;Name='node.exe';CommandLine=$null})
$script:rows=@([pscustomobject]@{ProcessId=11;Name='node.exe';CommandLine=$null;CreationDate=[DateTime]::UtcNow})
Refused {Assert-DotsProcessStage $directory $config $state $dated $true} 'unknown_process_command'
$script:rows[0].CommandLine='"C:\node.exe" "C:\bridge\dist\main.js" run --foreground --data-dir "'+$directory+'"'
Refused {Assert-DotsProcessStage $directory $config $state $dated $true} 'same_data_process_active'

# Prior-boot proof still does not adopt or terminate unrelated reused recorded PIDs.
$script:snapshot=@();$script:rows=@();$count=$queries.Count
Assert-DotsProcessStage $directory $config $state $dated $false
Assert ($queries.Count -eq $count) 'no filtered query when prior-boot proof needs no refresh'
Write-Output "$checks batch recovery checks passed (synthetic CIM receipts; no process, registry, task or credential mutation)"
