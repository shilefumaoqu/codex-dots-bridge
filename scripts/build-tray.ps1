[CmdletBinding()]
param([string]$OutputDirectory)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$version=(Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if($version -notmatch '^(\d+)\.(\d+)\.(\d+)(?:-alpha\.(\d+))?$') { throw 'Tray build requires the project alpha version.' }
$fileVersion='{0}.{1}.{2}.{3}' -f $Matches[1],$Matches[2],$Matches[3],$(if($Matches[4]){$Matches[4]}else{'0'})
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if(-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw '.NET Framework 4.8 Windows build tools are required.' }
if(-not $OutputDirectory) { $OutputDirectory=Join-Path $projectRoot ('artifacts\private\tray-build\'+$version) }
$OutputDirectory=[IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$assemblyPath=Join-Path $OutputDirectory 'TrayAssemblyInfo.cs'
$metadata=@"
using System.Reflection;
[assembly: AssemblyTitle("Codex Dots Bridge")]
[assembly: AssemblyProduct("Codex Dots Bridge")]
[assembly: AssemblyVersion("$fileVersion")]
[assembly: AssemblyFileVersion("$fileVersion")]
[assembly: AssemblyInformationalVersion("$version")]
"@
[IO.File]::WriteAllText($assemblyPath,$metadata,[Text.UTF8Encoding]::new($false))
$brand=Join-Path $projectRoot 'docs\素材\星渡\星渡-应用-128.png'
Add-Type -AssemblyName System.Drawing
$bitmap=[Drawing.Image]::FromFile($brand)
$frames=[Collections.Generic.List[byte[]]]::new()
try {
  foreach($size in @(16,20,24,32,48)) {
    $resized=New-Object Drawing.Bitmap $size,$size
    $graphics=[Drawing.Graphics]::FromImage($resized)
    $stream=New-Object IO.MemoryStream
    try {
      $graphics.InterpolationMode=[Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.DrawImage($bitmap,0,0,$size,$size)
      $resized.Save($stream,[Drawing.Imaging.ImageFormat]::Png)
      $frames.Add($stream.ToArray())
    } finally { $graphics.Dispose();$resized.Dispose();$stream.Dispose() }
  }
} finally { $bitmap.Dispose() }
$icon=Join-Path $OutputDirectory 'CodexDotsBridge.ico'
$iconStream=[IO.File]::Create($icon);$writer=New-Object IO.BinaryWriter $iconStream
try {
  $writer.Write([uint16]0);$writer.Write([uint16]1);$writer.Write([uint16]$frames.Count)
  $offset=6+16*$frames.Count;$index=0
  foreach($frame in $frames) {
    $size=@(16,20,24,32,48)[$index++]
    $writer.Write([byte]$size);$writer.Write([byte]$size);$writer.Write([byte]0);$writer.Write([byte]0)
    $writer.Write([uint16]1);$writer.Write([uint16]32);$writer.Write([uint32]$frame.Length);$writer.Write([uint32]$offset)
    $offset+=$frame.Length
  }
  foreach($frame in $frames) { $writer.Write($frame) }
} finally { $writer.Dispose();$iconStream.Dispose() }
$exe=Join-Path $OutputDirectory 'CodexDotsBridge.Tray.exe'
$arguments=@('/nologo','/target:winexe','/platform:x64','/optimize+','/langversion:5','/codepage:65001',('/out:'+$exe),('/win32icon:'+$icon),('/win32manifest:'+(Join-Path $projectRoot 'windows\tray\app.manifest')),
  '/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.Web.Extensions.dll',('/resource:'+$brand+',Xingdu.png'),$assemblyPath,(Join-Path $projectRoot 'windows\tray\Program.cs'))
& $compiler @arguments
if($LASTEXITCODE -ne 0) { throw 'Tray compilation failed.' }
$actual=[Diagnostics.FileVersionInfo]::GetVersionInfo($exe).ProductVersion
if($actual -cne $version) { throw 'Tray binary version differs from package.' }
Remove-Item -LiteralPath $assemblyPath
Write-Output $exe
