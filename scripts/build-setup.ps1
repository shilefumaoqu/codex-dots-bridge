[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Compiler,
  [string]$PackageRoot,
  [string]$OutputDirectory,
  [switch]$SkipTests
)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$Compiler=[IO.Path]::GetFullPath($Compiler)
if(-not (Test-Path -LiteralPath $Compiler -PathType Leaf)) { throw 'Inno Setup compiler not found.' }
$InstallerAppId='CodexDotsBridgeSetup'
if(-not $OutputDirectory) { $OutputDirectory=Join-Path $projectRoot ('artifacts\private\setup-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')) }
$OutputDirectory=[IO.Path]::GetFullPath($OutputDirectory)
if(Test-Path -LiteralPath (Join-Path $OutputDirectory 'Setup.exe')) { throw 'Existing installers are never overwritten.' }
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
if(-not $PackageRoot) {
  $packageOutput=Join-Path $OutputDirectory 'package'
  $options=@{OutputDirectory=$packageOutput;IncludeTunnel=$true;SkipTests=[bool]$SkipTests}
  & (Join-Path $PSScriptRoot 'package.ps1') @options
  $roots=@(Get-ChildItem -LiteralPath $packageOutput -Directory)
  if($roots.Count -ne 1) { throw 'Expected exactly one prepared package.' }
  $PackageRoot=$roots[0].FullName
}
$PackageRoot=[IO.Path]::GetFullPath($PackageRoot)
& (Join-Path $PSScriptRoot 'check-package.ps1') -PackageRoot $PackageRoot
$manifest=Get-Content -LiteralPath (Join-Path $PackageRoot 'release-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if(@($manifest.files | Where-Object {$_.path -ceq 'scripts/launch-background.ps1'}).Count -ne 1) { throw 'Setup requires its authenticated background-launch helper.' }
if(@($manifest.files | Where-Object {$_.path -ceq 'scripts/recover-reboot-locks.ps1'}).Count -ne 1) { throw 'Setup requires its authenticated lock-recovery helper.' }
if($manifest.node -ne '24.21.0' -or $manifest.tunnel -ne '0.0.16') { throw 'Setup requires the complete Node 24 and official Tunnel payload.' }
$fingerprint=(Get-FileHash -LiteralPath (Join-Path $PackageRoot 'release-manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()
$arguments=@(('/DPackageRoot='+$PackageRoot),('/DInstallerVersion='+$manifest.version),('/DInstallerAppId='+$InstallerAppId),('/DPackageFingerprint='+$fingerprint),('/DSetupOutput='+$OutputDirectory),(Join-Path $PSScriptRoot 'windows-setup.iss'))
& $Compiler /Q @arguments
if($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $OutputDirectory 'Setup.exe'))) { throw 'Inno Setup compilation failed.' }
$exe=Join-Path $OutputDirectory 'Setup.exe'
$hash=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText(($exe+'.sha256'),($hash+'  Setup.exe'+"`n"),[Text.UTF8Encoding]::new($false))
$compilerVersionText=(& $Compiler --version 2>&1 | Out-String)
$compilerVersion=if($compilerVersionText -match '(\d+\.\d+\.\d+(?:\.\d+)?)'){$Matches[1]}else{'not_exposed'}
$receipt=[ordered]@{schema=1;version=$manifest.version;installer_app_id=$InstallerAppId;compiler_version=$compilerVersion;package_manifest_sha256=$fingerprint;setup_sha256=$hash;publication='not_performed';installation_acceptance='pending'}
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'setup-build.json'),($receipt | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
Write-Output ('Windows installer prepared: '+$exe)
