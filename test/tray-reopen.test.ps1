[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$TrayExecutable,
  [Parameter(Mandatory=$true)][string]$BaselineTrayExecutable,
  [string]$RejectedTrayExecutable,
  [string]$EvidenceDirectory
)
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
$allowed=[IO.Path]::GetFullPath((Join-Path $repo 'artifacts\private\tray-reopen-evidence'))
if(-not $EvidenceDirectory){$EvidenceDirectory=Join-Path $allowed ([guid]::NewGuid().ToString('N'))}
$work=[IO.Path]::GetFullPath($EvidenceDirectory)
if(-not $work.StartsWith($allowed+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Evidence must stay inside private tray-reopen-evidence.'}
if(Test-Path -LiteralPath $work){throw 'Evidence directory must be fresh.'}
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$refs=@('/nologo','/target:exe','/platform:x64','/langversion:5','/codepage:65001','/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.Web.Extensions.dll')
$results=@()
$cases=@(@{name='baseline';exe=$BaselineTrayExecutable;args='--baseline'},@{name='candidate';exe=$TrayExecutable;args=''})
if($RejectedTrayExecutable){$cases+=@{name='rejected-mainform';exe=$RejectedTrayExecutable;args=''}}
foreach($case in $cases){
  $root=Join-Path $work $case.name
  $runtime=Join-Path $root 'runtime\node-v24.21.0-win-x64'
  New-Item -ItemType Directory -Path $runtime,(Join-Path $root 'dist') -Force | Out-Null
  Copy-Item -LiteralPath ([IO.Path]::GetFullPath($case.exe)) -Destination (Join-Path $root 'CodexDotsBridge.Tray.exe')
  [IO.File]::WriteAllText((Join-Path $root 'dist\main.js'),'Isolated C# fixture; never production JS.')
  & $compiler @refs '/main:RefreshFixture' ('/out:'+(Join-Path $runtime 'node.exe')) (Join-Path $repo 'windows\tray\test\RefreshFixture.cs')
  if($LASTEXITCODE -ne 0){throw 'Fake CLI compilation failed.'}
  $harness=Join-Path $root 'ReopenFixture.exe'
  & $compiler @refs ('/out:'+$harness) (Join-Path $repo 'windows\tray\test\ReopenFixture.cs')
  if($LASTEXITCODE -ne 0){throw 'Lifecycle harness compilation failed.'}
  $info=[Diagnostics.ProcessStartInfo]::new($harness,$case.args)
  $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
  $info.WorkingDirectory=$root;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  $process=[Diagnostics.Process]::Start($info)
  try{
    $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
    if(-not $process.WaitForExit(60000)){throw 'Isolated lifecycle harness exceeded 60 seconds.'}
    $output=$stdout.GetAwaiter().GetResult();$errorText=$stderr.GetAwaiter().GetResult()
    [IO.File]::WriteAllText((Join-Path $root 'result.json'),$output,[Text.UTF8Encoding]::new($false))
    $result=$output|ConvertFrom-Json
    if($case.name -eq 'rejected-mainform'){
      if($process.ExitCode -eq 0 -or $result.status -ne 'failed' -or $result.failure -notmatch 'background_showed_after_pump'){throw 'Rejected MainForm candidate did not reproduce its background regression.'}
    }elseif($process.ExitCode -ne 0){throw ($case.name+' lifecycle failed: '+$output+$errorText)}
    if($case.name -eq 'baseline' -and $result.status -ne 'baseline_failure_reproduced'){throw 'Old EXE did not reproduce the expected orphan.'}
    if($case.name -eq 'candidate' -and $result.status -ne 'passed'){throw 'New EXE did not pass.'}
    $results+=@{case=$case.name;result=$result}
  }finally{
    if(-not $process.HasExited){$process.Kill();$null=$process.WaitForExit(2000)}
    $process.Dispose()
  }
}
$summary=[ordered]@{status='passed';baseline='original EXE reproduces failure';candidate='new EXE passes';results=$results;production='not_touched';cloud='not_connected';desktop_manual='not_tested';evidence_directory=$work}
$json=$summary|ConvertTo-Json -Depth 20
[IO.File]::WriteAllText((Join-Path $work 'result.json'),$json,[Text.UTF8Encoding]::new($false))
$json
