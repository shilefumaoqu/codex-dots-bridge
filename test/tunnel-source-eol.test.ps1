[CmdletBinding()]
param([string]$TestDirectory)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
if(-not $TestDirectory){$TestDirectory=Join-Path $projectRoot 'artifacts/private/tunnel-source-eol'}
$work=Join-Path ([IO.Path]::GetFullPath($TestDirectory)) ([Guid]::NewGuid().ToString('N'))
$source=Join-Path $work 'source';$checkout=Join-Path $work 'windows checkout';$archive=Join-Path $work 'source.zip';$extracted=Join-Path $work 'archive'
$relative='third-party/tunnel-client/refusal-recovery.patch'
New-Item -ItemType Directory -Path (Join-Path $source 'third-party/tunnel-client') -Force|Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot '.gitattributes') -Destination $source
Copy-Item -LiteralPath (Join-Path $projectRoot $relative) -Destination (Join-Path $source $relative)
$payload=Get-Content -LiteralPath (Join-Path $projectRoot 'scripts/tunnel-payload.json') -Raw|ConvertFrom-Json
& git -C $source init -b main|Out-Null;if($LASTEXITCODE -ne 0){throw 'Synthetic source init failed'}
& git -C $source -c core.autocrlf=true add .gitattributes $relative;if($LASTEXITCODE -ne 0){throw 'Synthetic source add failed'}
& git -C $source -c user.name='Synthetic EOL Test' -c user.email='synthetic@example.invalid' -c commit.gpgsign=false commit -m 'Synthetic source EOL fixture'|Out-Null;if($LASTEXITCODE -ne 0){throw 'Synthetic source commit failed'}
& git -c core.autocrlf=true clone --no-hardlinks -- $source $checkout|Out-Null;if($LASTEXITCODE -ne 0){throw 'Windows checkout failed'}
if((Get-FileHash -LiteralPath (Join-Path $checkout $relative)).Hash.ToLowerInvariant() -cne $payload.patchSha256){throw 'Windows autocrlf checkout changed the patch identity'}
& git -C $source archive --format=zip ('--output='+$archive) HEAD;if($LASTEXITCODE -ne 0){throw 'Source archive failed'}
Expand-Archive -LiteralPath $archive -DestinationPath $extracted
if((Get-FileHash -LiteralPath (Join-Path $extracted $relative)).Hash.ToLowerInvariant() -cne $payload.patchSha256){throw 'Git source archive changed the patch identity'}
$result=[ordered]@{mode='real_git_synthetic_repository';passed=2;failed=0;patch_sha256=$payload.patchSha256;windows_checkout_autocrlf='true';checkout='passed';git_archive='passed'}
[IO.File]::WriteAllText((Join-Path $work 'result.json'),($result|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
Write-Output ($result|ConvertTo-Json -Compress)
