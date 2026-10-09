[CmdletBinding()]
param([string]$OutputDirectory, [switch]$IncludeTunnel, [switch]$SkipTests)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { throw 'Packaging requires Windows x64.' }
$runtime = Join-Path $projectRoot '.runtime\node-v24.21.0-win-x64'
$nodeExe = Join-Path $runtime 'node.exe'
if (-not (Test-Path -LiteralPath $nodeExe)) { throw 'Run scripts\bootstrap.ps1 first.' }
if ((& $nodeExe --version) -ne 'v24.21.0') { throw 'Private runtime version mismatch.' }
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$') { throw 'Invalid package version.' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'artifacts\private\packages' }
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$packageName = "codex-dots-bridge-$version-windows-x64-" + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
$staging = Join-Path $OutputDirectory $packageName
$zip = Join-Path $OutputDirectory "$packageName.zip"
if ((Test-Path -LiteralPath $staging) -or (Test-Path -LiteralPath $zip)) { throw 'Package collision; existing artifacts are never overwritten.' }
Push-Location $projectRoot
try {
  & $nodeExe (Join-Path $PSScriptRoot 'check-release.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Public source checks failed.' }
  & (Join-Path $PSScriptRoot 'dev.ps1') build
  if (-not $SkipTests) { & (Join-Path $PSScriptRoot 'dev.ps1') test }
} finally { Pop-Location }
New-Item -ItemType Directory -Path $staging | Out-Null
foreach ($name in @('dist','skills','docs','licenses')) { Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination (Join-Path $staging $name) -Recurse }
foreach ($name in @('package.json','package-lock.json','LICENSE','THIRD_PARTY_NOTICES.md','README.md','README.en.md','CHANGELOG.md','CONTRIBUTING.md','SECURITY.md')) { Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination (Join-Path $staging $name) }
New-Item -ItemType Directory -Path (Join-Path $staging 'scripts') | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install.ps1') -Destination (Join-Path $staging 'scripts\install.ps1')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'check-package.ps1') -Destination (Join-Path $staging 'scripts\check-package.ps1')
$packagedRuntime = Join-Path $staging 'runtime\node-v24.21.0-win-x64'
New-Item -ItemType Directory -Path $packagedRuntime | Out-Null
foreach ($name in @('node.exe','LICENSE','README.md')) { Copy-Item -LiteralPath (Join-Path $runtime $name) -Destination (Join-Path $packagedRuntime $name) }
$previousPath = $env:PATH
Push-Location $staging
try {
  $env:PATH = "$runtime;$previousPath"
  # Install the lockfile exactly; better-sqlite3 13 includes its Windows N-API binaries.
  & $nodeExe (Join-Path $runtime 'node_modules\npm\bin\npm-cli.js') ci --omit=dev --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Production dependency installation failed.' }
  & $nodeExe --input-type=module -e "import Database from 'better-sqlite3'; const db=new Database(':memory:'); db.prepare('SELECT 1').get(); db.close();"
  if ($LASTEXITCODE -ne 0) { throw 'Packaged native SQLite module failed to load.' }
  & $nodeExe (Join-Path $PSScriptRoot 'collect-licenses.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Production license collection failed.' }
} finally { $env:PATH = $previousPath; Pop-Location }
if ($IncludeTunnel) {
  $archiveName = 'tunnel-client-v0.0.16-windows-amd64.zip'
  $archive = Join-Path $projectRoot ".runtime\$archiveName"
  if (-not (Test-Path -LiteralPath $archive)) { Invoke-WebRequest -UseBasicParsing "https://github.com/openai/tunnel-client/releases/download/v0.0.16/$archiveName" -OutFile $archive }
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'edef7241b0c647fcb30f1a80ff376b6b25c51927960f257a3f01e21b17c2aba6') { throw 'Official Tunnel archive checksum mismatch.' }
  $vendor = Join-Path $staging 'vendor\tunnel-client-v0.0.16-windows-amd64'
  New-Item -ItemType Directory -Path $vendor | Out-Null
  Expand-Archive -LiteralPath $archive -DestinationPath $vendor
  foreach ($name in @('LICENSE','NOTICE','tunnel-client-v0.0.16-windows-amd64-licenses.txt','tunnel-client-v0.0.16-windows-amd64.spdx.json')) { if (-not (Test-Path -LiteralPath (Join-Path $vendor $name))) { throw "Tunnel notice missing: $name" } }
}
$files = @(Get-ChildItem -LiteralPath $staging -Recurse -File | ForEach-Object { [ordered]@{path=$_.FullName.Substring($staging.Length+1).Replace('\','/');sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()} } | Sort-Object { $_.path })
$manifest = [ordered]@{schema=1;version=$version;platform='windows-x64';node='24.21.0';tunnel=$(if ($IncludeTunnel) {'0.0.16'} else {$null});files=$files}
[IO.File]::WriteAllText((Join-Path $staging 'release-manifest.json'), ($manifest | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
& (Join-Path $PSScriptRoot 'check-package.ps1') -PackageRoot $staging
# Explicit source allowlist; generated manifest verifies every extracted file.
Compress-Archive -LiteralPath $staging -DestinationPath $zip
$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText(($zip+'.sha256'), ($hash+'  '+[IO.Path]::GetFileName($zip)+"`n"), [Text.UTF8Encoding]::new($false))
Write-Output "Windows prerelease package prepared: $zip"
Write-Output 'Account authorization and real Dot acceptance remain separate. No GitHub publication was performed.'
