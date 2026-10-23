[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$GoCompiler, [string]$Repository='https://github.com/openai/tunnel-client.git', [string]$WorkDirectory, [string]$OutputDirectory)
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$payload=Get-Content -LiteralPath (Join-Path $projectRoot 'scripts/tunnel-payload.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$patch=Join-Path $PSScriptRoot 'refusal-recovery.patch'
if((Get-FileHash -LiteralPath $patch -Algorithm SHA256).Hash.ToLowerInvariant() -cne $payload.patchSha256) { throw 'Tunnel source patch identity mismatch.' }
$GoCompiler=[IO.Path]::GetFullPath($GoCompiler)
if((& $GoCompiler version) -notmatch '^go version go1\.27\.0 ') { throw 'Reproduction requires Go 1.27.0.' }
if(-not $WorkDirectory) { $WorkDirectory=Join-Path $projectRoot ('.runtime/tunnel-build-'+[Guid]::NewGuid().ToString('N')) }
$WorkDirectory=[IO.Path]::GetFullPath($WorkDirectory)
if(Test-Path -LiteralPath $WorkDirectory) { throw 'Build directory must be new.' }
$source=Join-Path $WorkDirectory 'source'
# The accepted Windows build used CRLF upstream working files. Override the
# caller's global setting so checkout and patching reproduce those exact bytes.
& git clone --no-hardlinks --no-checkout --config core.autocrlf=true -- $Repository $source
if($LASTEXITCODE -ne 0) { throw 'Upstream clone failed.' }
& git -C $source checkout --detach $payload.upstreamCommit
if($LASTEXITCODE -ne 0) { throw 'Fixed upstream checkout failed.' }
& git -C $source apply --check $patch
if($LASTEXITCODE -ne 0) { throw 'Tunnel patch does not apply to the fixed upstream.' }
& git -C $source apply $patch
if($LASTEXITCODE -ne 0) { throw 'Tunnel patch application failed.' }
if(-not $OutputDirectory) { $OutputDirectory=Join-Path $projectRoot ('.runtime/'+$payload.directory) }
$output=Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) 'tunnel-client.exe'
if(Test-Path -LiteralPath $output) { throw 'Reproduction output already exists; previous binaries are never overwritten.' }
New-Item -ItemType Directory -Path (Split-Path -Parent $output) -Force | Out-Null
$names=@('GOCACHE','GOTMPDIR','GOPATH','TEMP','TMP','GOENV','GOTOOLCHAIN','GOMAXPROCS','CGO_ENABLED','GOOS','GOARCH')
$prior=@{};foreach($name in $names){$prior[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
try {
  $env:GOCACHE=Join-Path $WorkDirectory 'cache';$env:GOTMPDIR=Join-Path $WorkDirectory 'tmp';$env:GOPATH=Join-Path $WorkDirectory 'go-path'
  New-Item -ItemType Directory -Path $env:GOCACHE,$env:GOTMPDIR,$env:GOPATH -Force | Out-Null
  $env:TEMP=$env:GOTMPDIR;$env:TMP=$env:GOTMPDIR;$env:GOENV='off';$env:GOTOOLCHAIN='local';$env:GOMAXPROCS='2';$env:CGO_ENABLED='0';$env:GOOS='windows';$env:GOARCH='amd64'
  Push-Location $source
  try {
    & $GoCompiler build -p 2 -trimpath -ldflags '-X github.com/openai/tunnel-client/pkg/version.semanticVersion=0.0.17-local-refusal.1 -X github.com/openai/tunnel-client/pkg/version.GitSHA=a248b7f-local-refusal' -o $output ./cmd/client
    if($LASTEXITCODE -ne 0) { throw 'Patched Windows Tunnel build failed.' }
  } finally { Pop-Location }
} finally {foreach($name in $names){[Environment]::SetEnvironmentVariable($name,$prior[$name],'Process')}}
$hash=(Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
if($hash -cne $payload.clientSha256) { throw 'Rebuilt binary differs from the accepted release binary; do not substitute it without new acceptance.' }
Write-Output ('Reproduced accepted Tunnel binary: '+$output)
