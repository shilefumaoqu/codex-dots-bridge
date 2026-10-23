[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Destination, [string]$ClientExecutable)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$payload=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'tunnel-payload.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if(-not $ClientExecutable) { $ClientExecutable=Join-Path $projectRoot ('.runtime/'+$payload.directory+'/tunnel-client.exe') }
$ClientExecutable=[IO.Path]::GetFullPath($ClientExecutable)
if(-not (Test-Path -LiteralPath $ClientExecutable -PathType Leaf)) { throw 'Build the patched client with third-party/tunnel-client/build.ps1 or supply -ClientExecutable with the verified release binary.' }
if((Get-FileHash -LiteralPath $ClientExecutable -Algorithm SHA256).Hash.ToLowerInvariant() -cne $payload.clientSha256) { throw 'Patched Tunnel executable identity mismatch.' }
$archive=Join-Path $projectRoot ('.runtime/'+$payload.archiveName)
if(-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $archive) -Force | Out-Null
  Invoke-WebRequest -UseBasicParsing $payload.archiveUrl -OutFile $archive
}
if((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $payload.archiveSha256) { throw 'Official Tunnel companion archive checksum mismatch.' }
$Destination=[IO.Path]::GetFullPath($Destination)
if(Test-Path -LiteralPath $Destination) { throw 'Tunnel destination already exists; previous payloads are never overwritten.' }
New-Item -ItemType Directory -Path $Destination -Force | Out-Null
Expand-Archive -LiteralPath $archive -DestinationPath $Destination
foreach($notice in $payload.notices) { if(-not (Test-Path -LiteralPath (Join-Path $Destination $notice) -PathType Leaf)) { throw ('Tunnel notice missing: '+$notice) } }
if((Get-FileHash -LiteralPath (Join-Path $Destination 'cloudflared.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -cne $payload.cloudflaredSha256) { throw 'Cloudflared companion identity mismatch.' }
Copy-Item -LiteralPath $ClientExecutable -Destination (Join-Path $Destination 'tunnel-client.exe') -Force
$provenance=[ordered]@{schema=1;distribution='locally_modified_not_official';version=$payload.version;upstream_version=$payload.upstreamVersion;upstream_commit=$payload.upstreamCommit;upstream_archive_sha256=$payload.archiveSha256;patch_sha256=$payload.patchSha256;client_sha256=$payload.clientSha256;cloudflared_sha256=$payload.cloudflaredSha256;upstream_spdx='Describes unchanged upstream dependencies; the executable contains the separately identified local patch.'}
[IO.File]::WriteAllText((Join-Path $Destination 'local-patch.json'),($provenance|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
Write-Output ('Verified patched Tunnel payload: '+$Destination)
