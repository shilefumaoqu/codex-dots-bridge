[CmdletBinding()]
param(
  [string]$PackageRoot,
  [string]$ArchivePath,
  [switch]$SourceArchive,
  [string]$ValidatorNode,
  [switch]$RequireEvidence,
  [string]$Evidence,
  [string]$SourceCommit,
  [string]$SourceZip,
  [string]$WindowsZip,
  [string]$SetupExe,
  [switch]$RequireSetup,
  [string]$ReleaseNotes
)
$ErrorActionPreference = 'Stop'
if (-not $PackageRoot) { $PackageRoot = Split-Path -Parent $PSScriptRoot }
if ($ArchivePath) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($ArchivePath))
  $seenEntries = @{}
  try {
    foreach ($entry in $archive.Entries) {
      if ($entry.FullName -match '(^|[/\\])\.\.([/\\]|$)|^[A-Za-z]:|^[/\\]' -or $entry.FullName.Contains('\')) { throw 'Unsafe archive entry.' }
      if ($seenEntries.ContainsKey($entry.FullName)) { throw 'Duplicate archive entry.' }
      $seenEntries[$entry.FullName]=$true
      if (($entry.ExternalAttributes -shr 16 -band 61440) -eq 40960) { throw 'Archive symlink is not supported.' }
      if ($entry.Length -gt 268435456) { throw 'Archive entry exceeds inspection limit.' }
    }
  } finally { $archive.Dispose() }
  $scratchParent = [IO.Path]::GetFullPath($(if ($env:BRIDGE_RELEASE_INSPECTION_TMP) { $env:BRIDGE_RELEASE_INSPECTION_TMP } else { [IO.Path]::GetTempPath() })).TrimEnd([char[]]@('\','/'))
  if (-not (Test-Path -LiteralPath $scratchParent)) { New-Item -ItemType Directory -Force -Path $scratchParent | Out-Null }
  $scratch = Join-Path $scratchParent ('bridge-release-inspect-'+[Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $scratch | Out-Null
  try {
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $scratch
    $children = @(Get-ChildItem -LiteralPath $scratch)
    if ($children.Count -eq 1 -and $children[0].PSIsContainer) { $archiveRoot=$children[0].FullName } else { $archiveRoot=$scratch }
    $options=@{PackageRoot=$archiveRoot;ValidatorNode=$ValidatorNode}
    if ($SourceArchive) { $options.SourceArchive=$true }
    if ($RequireEvidence) {
      $options.RequireEvidence=$true; $options.Evidence=$Evidence; $options.SourceCommit=$SourceCommit
      $options.SourceZip=$SourceZip; $options.WindowsZip=$WindowsZip; $options.ReleaseNotes=$ReleaseNotes
      $options.SetupExe=$SetupExe; $options.RequireSetup=$RequireSetup
    }
    & $PSCommandPath @options
  } finally {
    $resolvedScratch = [IO.Path]::GetFullPath($scratch)
    if (-not $resolvedScratch.StartsWith($scratchParent+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Inspection cleanup path outside temp.' }
    Remove-Item -LiteralPath $resolvedScratch -Recurse -Force
  }
  return
}
$PackageRoot = [IO.Path]::GetFullPath($PackageRoot).TrimEnd([char[]]@('\','/'))
if (-not $ValidatorNode) {
  $ValidatorNode=Join-Path (Split-Path -Parent $PSScriptRoot) '.runtime\node-v24.21.0-win-x64\node.exe'
  if (-not (Test-Path -LiteralPath $ValidatorNode)) { $ValidatorNode=Join-Path $PackageRoot 'runtime\node-v24.21.0-win-x64\node.exe' }
}
if (-not (Test-Path -LiteralPath $ValidatorNode)) { throw 'A trusted Node runtime is required to inspect release content.' }
$package = Get-Content -LiteralPath (Join-Path $PackageRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$contentArguments=@((Join-Path $PSScriptRoot 'check-public-content.mjs'),'--root',$PackageRoot)
if ($ReleaseNotes) { $contentArguments+=@('--notes',$ReleaseNotes) }
if ($RequireEvidence) {
  $contentArguments+=@('--require-evidence','--version',$package.version,'--commit',$SourceCommit,'--source-zip',$SourceZip,'--windows-zip',$WindowsZip)
  if ($Evidence) { $contentArguments+=@('--evidence',$Evidence) }
  if ($SetupExe) { $contentArguments+=@('--setup-exe',$SetupExe) }
  if ($RequireSetup) { $contentArguments+='--require-setup' }
}
& $ValidatorNode @contentArguments
if ($LASTEXITCODE -ne 0) { throw 'Public content or release evidence checks failed.' }
if ($SourceArchive) { Write-Output "Verified public source content: $($package.version)."; return }
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
if ($seen.ContainsKey('dist/desktop-warm-load.js') -and -not $seen.ContainsKey('scripts/desktop-warm-load.ps1')) { throw 'Warm-load runtime requires its packaged PowerShell helper.' }
if ($seen.ContainsKey('dist/reboot-recovery.js') -and -not $seen.ContainsKey('scripts/recover-reboot-locks.ps1')) { throw 'Reboot recovery requires its packaged PowerShell helper.' }
if ($seen.ContainsKey('dist/windows-background.js') -and -not $seen.ContainsKey('scripts/launch-background.ps1')) { throw 'Windows background launch requires its packaged PowerShell helper.' }
if ($seen.ContainsKey('dist/tray-status.js') -and (-not $seen.ContainsKey('CodexDotsBridge.Tray.exe') -or -not $seen.ContainsKey('CodexDotsBridge.ico'))) { throw 'Tray runtime requires the matching Windows executable and icon.' }
$inventory = Get-Content -LiteralPath (Join-Path $PackageRoot 'licenses/npm-inventory.json') -Raw | ConvertFrom-Json
foreach ($dependency in $inventory.packages) { foreach ($notice in $dependency.notices) { if (-not $seen.ContainsKey($notice)) { throw "Dependency notice missing: $($dependency.name)" } } }
if ($manifest.tunnel) { foreach ($notice in @('LICENSE','NOTICE','tunnel-client-v0.0.16-windows-amd64-licenses.txt','tunnel-client-v0.0.16-windows-amd64.spdx.json')) { if (-not $seen.ContainsKey('vendor/tunnel-client-v0.0.16-windows-amd64/'+$notice)) { throw "Tunnel notice missing: $notice" } } }
$node = Join-Path $PackageRoot 'runtime\node-v24.21.0-win-x64\node.exe'
$actual = (& $node (Join-Path $PackageRoot 'dist\main.js') --version) -join ''
if ($LASTEXITCODE -ne 0 -or ($actual | ConvertFrom-Json).version -ne $package.version) { throw 'Compiled runtime version mismatch.' }
if ($seen.ContainsKey('CodexDotsBridge.Tray.exe')) {
  $trayVersion=[Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $PackageRoot 'CodexDotsBridge.Tray.exe')).ProductVersion
  if ($trayVersion -cne $package.version) { throw 'Compiled tray version mismatch.' }
}
if ($seen.ContainsKey('dist/startup-link.js')) {
  if(-not $seen.ContainsKey('CodexDotsBridge.Launcher.exe') -or -not $seen.ContainsKey('launcher-build.json')){throw 'Stable startup requires its native Launcher and build identity.'}
  $launcherBuild=Get-Content -LiteralPath (Join-Path $PackageRoot 'launcher-build.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if($launcherBuild.protocol -ne 1 -or $launcherBuild.source_sha256 -notmatch '^[a-f0-9]{64}$' -or $launcherBuild.binary_sha256 -cne (Get-FileHash -LiteralPath (Join-Path $PackageRoot 'CodexDotsBridge.Launcher.exe') -Algorithm SHA256).Hash.ToLowerInvariant()){throw 'Stable Launcher build identity mismatch.'}
  if([Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $PackageRoot 'CodexDotsBridge.Launcher.exe')).ProductVersion -cne 'launcher-1'){throw 'Unsupported Launcher protocol.'}
}
Write-Output "Verified release $($package.version): $($seen.Count) files, $($inventory.packages.Count) npm licenses."
