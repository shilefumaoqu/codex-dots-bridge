$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $projectRoot '.runtime'
$version = 'v24.21.0'
$archiveName = "node-$version-win-x64.zip"
$nodeDir = Join-Path $runtimeRoot "node-$version-win-x64"
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { throw 'P0 supports Windows x64 only.' }
if (Test-Path -LiteralPath (Join-Path $nodeDir 'node.exe')) {
    $found = & (Join-Path $nodeDir 'node.exe') --version
    if ($found -ne $version) { throw 'Private runtime version conflict.' }
    Write-Output "Private runtime ready: $version"
    exit 0
}
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
$zipPath = Join-Path $runtimeRoot $archiveName
$sumPath = Join-Path $runtimeRoot 'SHASUMS256.txt'
Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$version/$archiveName" -OutFile $zipPath
Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$version/SHASUMS256.txt" -OutFile $sumPath
$matchLine = Get-Content -LiteralPath $sumPath | Where-Object { $_ -match ('\s' + [regex]::Escape($archiveName) + '$') }
$expected = ($matchLine -split '\s+')[0]
if (-not $expected -or (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash -ne $expected) { throw 'Node archive checksum mismatch.' }
Expand-Archive -LiteralPath $zipPath -DestinationPath $runtimeRoot
Write-Output "Private runtime ready: $version"

