[CmdletBinding()]
param([string]$TestDirectory)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
if(-not $TestDirectory){$TestDirectory=Join-Path $projectRoot 'artifacts/private/tunnel-payload-tests'}
$work=Join-Path ([IO.Path]::GetFullPath($TestDirectory)) ([Guid]::NewGuid().ToString('N'))
$scripts=Join-Path $work 'scripts';$runtime=Join-Path $work '.runtime';$official=Join-Path $work 'official'
New-Item -ItemType Directory -Path $scripts,$runtime,$official -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'scripts/prepare-tunnel.ps1') -Destination $scripts
$client=Join-Path $work 'accepted patched.exe'
[IO.File]::WriteAllText($client,'synthetic accepted patched client')
foreach($name in @('LICENSE','NOTICE','licenses.txt','spdx.json','cloudflared-manifest.json')){[IO.File]::WriteAllText((Join-Path $official $name),('synthetic preserved '+$name))}
[IO.File]::WriteAllText((Join-Path $official 'tunnel-client.exe'),'synthetic upstream unpatched client')
[IO.File]::WriteAllText((Join-Path $official 'cloudflared.exe'),'synthetic cloudflared companion')
$archive=Join-Path $runtime 'official.zip'
Compress-Archive -Path (Join-Path $official '*') -DestinationPath $archive
$payload=[pscustomobject]@{schema=1;version='synthetic-local';directory='synthetic-vendor';clientSha256=(Get-FileHash -LiteralPath $client).Hash.ToLowerInvariant();cloudflaredSha256=(Get-FileHash -LiteralPath (Join-Path $official 'cloudflared.exe')).Hash.ToLowerInvariant();upstreamVersion='synthetic-upstream';upstreamCommit=('a'*40);archiveName='official.zip';archiveUrl='https://example.invalid/never-used';archiveSha256=(Get-FileHash -LiteralPath $archive).Hash.ToLowerInvariant();patchSha256=('b'*64);notices=@('LICENSE','NOTICE','licenses.txt','spdx.json')}
$descriptor=Join-Path $scripts 'tunnel-payload.json'
function Save-Descriptor{[IO.File]::WriteAllText($descriptor,($payload|ConvertTo-Json),[Text.UTF8Encoding]::new($false))}
Save-Descriptor
$prepare=Join-Path $scripts 'prepare-tunnel.ps1';$destination=Join-Path $work 'prepared'
& $prepare -Destination $destination -ClientExecutable $client | Out-Null
if([IO.File]::ReadAllText((Join-Path $destination 'tunnel-client.exe')) -cne 'synthetic accepted patched client'){throw 'Prepared payload kept the upstream executable'}
foreach($name in $payload.notices){if([IO.File]::ReadAllText((Join-Path $destination $name)) -cne ('synthetic preserved '+$name)){throw 'Upstream notice changed'}}
$receipt=Get-Content -LiteralPath (Join-Path $destination 'local-patch.json') -Raw|ConvertFrom-Json
if($receipt.distribution -cne 'locally_modified_not_official' -or $receipt.client_sha256 -cne $payload.clientSha256 -or $receipt.upstream_commit -cne $payload.upstreamCommit){throw 'Patched provenance is incomplete'}
$checks=[Collections.Generic.List[string]]::new();$checks.Add('frozen_client_replaces_only_upstream_client_and_preserves_notices_and_companion')
try{& $prepare -Destination $destination -ClientExecutable $client|Out-Null;throw 'Existing destination accepted'}catch{if($_.Exception.Message -cne 'Tunnel destination already exists; previous payloads are never overwritten.'){throw}}
$checks.Add('existing_payload_not_overwritten')
$unknown=Join-Path $work 'unknown.exe';[IO.File]::WriteAllText($unknown,'unaccepted binary')
try{& $prepare -Destination (Join-Path $work 'bad-client') -ClientExecutable $unknown|Out-Null;throw 'Unknown client accepted'}catch{if($_.Exception.Message -cne 'Patched Tunnel executable identity mismatch.'){throw}}
if(Test-Path -LiteralPath (Join-Path $work 'bad-client')){throw 'Unverified client produced payload files'}
$checks.Add('unaccepted_client_rejected_before_extracting')
$payload.archiveSha256='0'*64;Save-Descriptor
try{& $prepare -Destination (Join-Path $work 'bad-archive') -ClientExecutable $client|Out-Null;throw 'Unknown archive accepted'}catch{if($_.Exception.Message -cne 'Official Tunnel companion archive checksum mismatch.'){throw}}
$checks.Add('unaccepted_companion_archive_rejected')
$payload.archiveSha256=(Get-FileHash -LiteralPath $archive).Hash.ToLowerInvariant();$payload.cloudflaredSha256='0'*64;Save-Descriptor
try{& $prepare -Destination (Join-Path $work 'bad-companion') -ClientExecutable $client|Out-Null;throw 'Unknown cloudflared accepted'}catch{if($_.Exception.Message -cne 'Cloudflared companion identity mismatch.'){throw}}
$checks.Add('unaccepted_cloudflared_rejected')
$result=[ordered]@{mode='synthetic';checks=@($checks);passed=$checks.Count;failed=0}
[IO.File]::WriteAllText((Join-Path $work 'result.json'),($result|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
Write-Output ($result|ConvertTo-Json -Compress)
