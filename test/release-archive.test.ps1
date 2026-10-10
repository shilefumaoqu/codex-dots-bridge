[CmdletBinding()]
param([string]$TestDirectory = $env:BRIDGE_RELEASE_TEST_TMP, [string]$PreviouslyPublishedSourceZip, [string]$PreviouslyPublishedWindowsZip)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$projectRoot = Split-Path -Parent $PSScriptRoot
$node = Join-Path $projectRoot '.runtime\node-v24.21.0-win-x64\node.exe'
$validator = Join-Path $projectRoot 'scripts\check-package.ps1'
if (-not $TestDirectory) { $TestDirectory = [IO.Path]::GetTempPath() }
$testParent = [IO.Path]::GetFullPath($TestDirectory).TrimEnd([char[]]@('\','/'))
New-Item -ItemType Directory -Force -Path $testParent | Out-Null
$work = Join-Path $testParent ('bridge-archive-tests-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$env:BRIDGE_RELEASE_INSPECTION_TMP = $testParent
$shell = (Get-Process -Id $PID).Path
$results = [Collections.Generic.List[object]]::new()
function WriteFixture([string]$path, [string]$content) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
  [IO.File]::WriteAllText($path, $content, [Text.UTF8Encoding]::new($false))
}
function CreateFixtureArchive([string]$root, [string]$zip) {
  # .NET Framework CreateFromDirectory can emit backslash entry names; fixtures use ZIP '/' paths.
  $archive = [IO.Compression.ZipFile]::Open($zip,[IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($file in Get-ChildItem -LiteralPath $root -Recurse -File) {
      $entryName=$file.FullName.Substring($root.Length+1).Replace('\','/')
      [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,$file.FullName,$entryName,[IO.Compression.CompressionLevel]::Optimal)
    }
  } finally { $archive.Dispose() }
}
function CheckArchive([string]$name, [string]$zip, [string]$expectedRule) {
  $previousErrorPreference = $ErrorActionPreference
  try {
    # PS5.1 turns redirected native stderr into ErrorRecord; negative fixtures must still be observed.
    $ErrorActionPreference = 'Continue'
    $output = (& $shell -NoProfile -ExecutionPolicy Bypass -File $validator -ArchivePath $zip -SourceArchive -ValidatorNode $node 2>&1 | Out-String)
    $exit = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previousErrorPreference }
  $pass = if ($expectedRule) { $exit -ne 0 -and $output.Contains($expectedRule) } else { $exit -eq 0 }
  $results.Add([pscustomobject]@{name=$name;passed=$pass;exit_code=$exit;expected_rule=$expectedRule;diagnostic=$(if (-not $pass) { $output.Substring(0,[Math]::Min(1200,$output.Length)) } else { $null })})
}
try {
  foreach ($kind in @('clean','private-report','text-secret')) {
    $root=Join-Path $work $kind
    WriteFixture (Join-Path $root 'package.json') '{"name":"synthetic-release-fixture","version":"0.1.0-test"}'
    WriteFixture (Join-Path $root 'docs\快速开始.md') 'Synthetic technical instructions only.'
    WriteFixture (Join-Path $root 'test\fixtures\accounts.csv') 'synthetic@example.invalid,example-only'
    if ($kind -eq 'private-report') { WriteFixture (Join-Path $root 'docs\候选包验收.md') 'Synthetic personal deployment and conversation diary. No secret value.' }
    if ($kind -eq 'text-secret') { WriteFixture (Join-Path $root 'extra.txt') ('ghp_' + ('A' * 36)) }
    $zip=Join-Path $work ($kind+'.zip')
    CreateFixtureArchive $root $zip
    $rule=switch($kind){'clean' {''}; 'private-report' {'unapproved-public-document'}; 'text-secret' {'credential'}}
    CheckArchive $kind $zip $rule
  }
  foreach ($kind in @('traversal','duplicate')) {
    $zip=Join-Path $work ($kind+'.zip')
    $archive=[IO.Compression.ZipFile]::Open($zip,[IO.Compression.ZipArchiveMode]::Create)
    try {
      if ($kind -eq 'traversal') { [void]$archive.CreateEntry('../outside.txt') }
      else { [void]$archive.CreateEntry('same.txt'); [void]$archive.CreateEntry('same.txt') }
    } finally { $archive.Dispose() }
    $rule=if($kind -eq 'traversal') {'Unsafe archive entry.'} else {'Duplicate archive entry.'}
    CheckArchive $kind $zip $rule
  }
  if ($PreviouslyPublishedSourceZip) { CheckArchive 'previously-published-personal-documents' $PreviouslyPublishedSourceZip 'unapproved-public-document' }
  if ($PreviouslyPublishedWindowsZip) { CheckArchive 'previously-published-windows-personal-documents' $PreviouslyPublishedWindowsZip 'unapproved-public-document' }
  $results | ConvertTo-Json -Depth 4
  if (@($results | Where-Object { -not $_.passed }).Count) { throw 'Archive regression failed.' }
} finally {
  if (-not [IO.Path]::GetFullPath($work).StartsWith($testParent+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Test cleanup outside assigned directory.' }
  Remove-Item -LiteralPath $work -Recurse -Force
}
exit 0
