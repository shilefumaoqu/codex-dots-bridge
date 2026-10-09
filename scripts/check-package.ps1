[CmdletBinding()]
param([string]$PackageRoot = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$PackageRoot = [IO.Path]::GetFullPath($PackageRoot).TrimEnd([char[]]@('\','/'))
$manifestPath = Join-Path $PackageRoot 'release-manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$package = Get-Content -LiteralPath (Join-Path $PackageRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.schema -ne 1 -or $manifest.version -ne $package.version -or $manifest.platform -ne 'windows-x64') { throw 'Release metadata mismatch.' }
$seen = @{}
foreach ($entry in $manifest.files) {
  if ($seen.ContainsKey($entry.path) -or $entry.path -match '(^|/)\.\.?(/|$)|^[A-Za-z]:|^[/\\]' -or $entry.path.Contains('\')) { throw 'Invalid manifest path.' }
  $seen[$entry.path]=$true
  $path = [IO.Path]::GetFullPath((Join-Path $PackageRoot $entry.path))
  if (-not $path.StartsWith($PackageRoot.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Manifest path outside package.' }
  if ($entry.path -match '(^|/)(\.cache|\.runtime|secrets|backups)(/|$)|\.(env|key|pem|pfx|sqlite|db|log)$') { throw 'Private file in package.' }
  if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) { throw "Package hash mismatch: $($entry.path)" }
}
foreach ($file in Get-ChildItem -LiteralPath $PackageRoot -Recurse -File) {
  $relative = $file.FullName.Substring($PackageRoot.Length+1).Replace('\','/')
  if ($relative -ne 'release-manifest.json' -and -not $seen.ContainsKey($relative)) { throw "Unlisted package file: $relative" }
}
foreach ($required in @('runtime/node-v24.21.0-win-x64/LICENSE','scripts/install.ps1','dist/main.js','skills/codex-dots-bridge/SKILL.md','LICENSE','THIRD_PARTY_NOTICES.md','licenses/npm-inventory.json')) { if (-not $seen.ContainsKey($required)) { throw "Required file missing: $required" } }
$inventory = Get-Content -LiteralPath (Join-Path $PackageRoot 'licenses/npm-inventory.json') -Raw | ConvertFrom-Json
foreach ($dependency in $inventory.packages) { foreach ($notice in $dependency.notices) { if (-not $seen.ContainsKey($notice)) { throw "Dependency notice missing: $($dependency.name)" } } }
if ($manifest.tunnel) { foreach ($notice in @('LICENSE','NOTICE','tunnel-client-v0.0.16-windows-amd64-licenses.txt','tunnel-client-v0.0.16-windows-amd64.spdx.json')) { if (-not $seen.ContainsKey('vendor/tunnel-client-v0.0.16-windows-amd64/'+$notice)) { throw "Tunnel notice missing: $notice" } } }
$node = Join-Path $PackageRoot 'runtime\node-v24.21.0-win-x64\node.exe'
$actual = (& $node (Join-Path $PackageRoot 'dist\main.js') --version) -join ''
if ($LASTEXITCODE -ne 0 -or ($actual | ConvertFrom-Json).version -ne $package.version) { throw 'Compiled runtime version mismatch.' }
Write-Output "Verified release $($package.version): $($seen.Count) files, $($inventory.packages.Count) npm licenses."
