[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -Global -Force -ErrorAction Stop
$projectRoot=Split-Path -Parent $PSScriptRoot
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$OutputDirectory=[IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$exe=Join-Path $OutputDirectory 'CodexDotsBridge.Launcher.exe'
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /langversion:5 /codepage:65001 ('/out:'+$exe) /reference:System.Web.Extensions.dll (Join-Path $projectRoot 'windows\launcher\Program.cs')
if($LASTEXITCODE -ne 0){throw 'Launcher compilation failed.'}
$probe=[Diagnostics.ProcessStartInfo]::new($exe,'--version');$probe.UseShellExecute=$false;$probe.CreateNoWindow=$true;$probe.RedirectStandardOutput=$true
$process=[Diagnostics.Process]::Start($probe)
try{$text=$process.StandardOutput.ReadToEnd();$process.WaitForExit();$version=$text | ConvertFrom-Json;if($process.ExitCode -ne 0 -or $version.protocol -ne 1){throw 'Launcher protocol mismatch.'}}finally{$process.Dispose()}
$receipt=[ordered]@{protocol=1;source_sha256=(Get-FileHash -LiteralPath (Join-Path $projectRoot 'windows\launcher\Program.cs') -Algorithm SHA256).Hash.ToLowerInvariant();binary_sha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()}
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'launcher-build.json'),($receipt | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
Write-Output $exe
