[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$TrayExecutable)
$ErrorActionPreference='Stop'
$TrayExecutable=[IO.Path]::GetFullPath($TrayExecutable)
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('CodexDotsTrayHttp-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
Copy-Item -LiteralPath $TrayExecutable -Destination (Join-Path $testRoot 'CodexDotsBridge.Tray.exe')
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$fixture=Join-Path (Split-Path -Parent $PSScriptRoot) 'windows\tray\test\StatusFixture.cs'
$harness=Join-Path $testRoot 'StatusHarness.exe'
& $compiler '/nologo' '/target:exe' '/platform:x64' '/langversion:5' '/codepage:65001' '/reference:System.Web.Extensions.dll' ('/out:'+$harness) $fixture
if($LASTEXITCODE -ne 0){throw 'Status transport fixture compilation failed.'}
$info=[Diagnostics.ProcessStartInfo]::new($harness);$info.UseShellExecute=$false;$info.CreateNoWindow=$true
$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
$process=[Diagnostics.Process]::Start($info)
try {
  $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
  if(-not $process.WaitForExit(45000)){throw 'Status transport harness exceeded 45 seconds.'}
  $output=$stdout.GetAwaiter().GetResult();$errorText=$stderr.GetAwaiter().GetResult()
  [IO.File]::WriteAllText((Join-Path $testRoot 'result.json'),$output,[Text.UTF8Encoding]::new($false))
  Write-Output $output
  if($process.ExitCode -ne 0){throw ('Status transport fixture failed: '+$errorText)}
} finally {if(-not $process.HasExited){$process.Kill();$null=$process.WaitForExit(2000)};$process.Dispose()}
