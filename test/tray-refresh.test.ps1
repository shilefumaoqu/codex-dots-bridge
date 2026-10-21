[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$TrayExecutable)
$ErrorActionPreference='Stop'
$TrayExecutable=[IO.Path]::GetFullPath($TrayExecutable)
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('CodexDotsTrayRefresh-'+[guid]::NewGuid().ToString('N'))
$nodeRoot=Join-Path $testRoot 'runtime\node-v24.21.0-win-x64'
New-Item -ItemType Directory -Path $nodeRoot,(Join-Path $testRoot 'dist') -Force | Out-Null
Copy-Item -LiteralPath $TrayExecutable -Destination (Join-Path $testRoot 'CodexDotsBridge.Tray.exe')
[IO.File]::WriteAllText((Join-Path $testRoot 'dist\main.js'),'isolated C# fixture; never production JS')
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$fixture=Join-Path (Split-Path -Parent $PSScriptRoot) 'windows\tray\test\RefreshFixture.cs'
$references=@('/nologo','/target:exe','/platform:x64','/langversion:5','/codepage:65001','/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.Web.Extensions.dll')
& $compiler @references '/main:RefreshFixture' ('/out:'+(Join-Path $nodeRoot 'node.exe')) $fixture
if($LASTEXITCODE -ne 0){throw 'Fixture compilation failed.'}
$harness=Join-Path $testRoot 'RefreshHarness.exe'
& $compiler @references '/main:RefreshHarness' ('/out:'+$harness) $fixture
if($LASTEXITCODE -ne 0){throw 'Harness compilation failed.'}
$info=[Diagnostics.ProcessStartInfo]::new($harness);$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
$process=[Diagnostics.Process]::Start($info)
try {
  $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
  if(-not $process.WaitForExit(60000)){throw 'Refresh harness exceeded 60 seconds.'}
  $output=$stdout.GetAwaiter().GetResult();$errorText=$stderr.GetAwaiter().GetResult()
  [IO.File]::WriteAllText((Join-Path $testRoot 'result.json'),$output,[Text.UTF8Encoding]::new($false))
  Write-Output $output
  if($process.ExitCode -ne 0){throw ('Refresh fixture test failed: '+$errorText)}
} finally {if(-not $process.HasExited){$process.Kill();$null=$process.WaitForExit(2000)};$process.Dispose()}
