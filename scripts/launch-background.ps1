[CmdletBinding(DefaultParameterSetName='Supervisor')]
param(
  [Parameter(Mandatory=$true,ParameterSetName='Tray')][string]$TrayExecutable,
  [Parameter(Mandatory=$true,ParameterSetName='Ready')]
  [Parameter(Mandatory=$true,ParameterSetName='SupervisorPaths')][string]$NodeExecutable,
  [Parameter(Mandatory=$true,ParameterSetName='Ready')]
  [Parameter(Mandatory=$true,ParameterSetName='SupervisorPaths')][string]$EntryPath,
  [Parameter(Mandatory=$true,ParameterSetName='Ready')][switch]$CheckReady,
  [Parameter(ParameterSetName='Ready')][int]$ExpectedPid=0,
  [Parameter(ParameterSetName='Ready')][string]$PreviousOwner='',
  [Parameter(Mandatory=$true,ParameterSetName='Ready')]
  [Parameter(Mandatory=$true,ParameterSetName='SupervisorPaths')]
  [Parameter(Mandatory=$true,ParameterSetName='Tray')][string]$DataDir,
  [Parameter(ParameterSetName='Tray')][ValidateSet('--background','--show')][string]$TrayMode='--background'
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
try { [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false) } catch { }
try { [Console]::InputEncoding=[Text.UTF8Encoding]::new($false) } catch { }
# Isolated children must resolve JSON commands from this host's built-in module,
# without scanning inherited or machine-wide module paths on first use.
Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1')) -Global -ErrorAction Stop

function Set-DotsUserCompilationTemp {
  try {
    $local=[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    if(-not $local -or -not [IO.Path]::IsPathRooted($local)){throw 'invalid_temp'}
    $directory=[IO.Path]::GetFullPath([IO.Path]::Combine($local,'Temp'))
    if(-not [IO.Directory]::Exists($directory)){throw 'invalid_temp'}
    for($cursor=$directory;$cursor;$cursor=[IO.Path]::GetDirectoryName($cursor)) {
      if(([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'invalid_temp'}
    }
    $user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $owner=[IO.Directory]::GetAccessControl($directory).GetOwner([Security.Principal.SecurityIdentifier]).Value
    if($owner -notin @($user,'S-1-5-18')){throw 'invalid_temp'}
    $env:TEMP=$directory;$env:TMP=$directory
    return $directory
  } catch {throw 'background_broker_unavailable'}
}

function Quote-DotsWindowsArgument([string]$Value) {
  # Windows argv escaping; the result is passed to Create directly, never a shell.
  $b=[Text.StringBuilder]::new('"');$slashes=0
  foreach($c in $Value.ToCharArray()) {
    if($c -eq '\'){$slashes++;continue}
    if($c -eq '"'){$null=$b.Append('\',$slashes*2+1);$null=$b.Append($c)}else{$null=$b.Append('\',$slashes);$null=$b.Append($c)}
    $slashes=0
  }
  $null=$b.Append('\',$slashes*2);$null=$b.Append('"');$b.ToString()
}
function Get-DotsBackgroundEnvironment($Source) {
  $compilationTemp=Set-DotsUserCompilationTemp
  $allowed=@('SystemRoot','WINDIR','ComSpec','PATH','Path','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','PROGRAMFILES','PROGRAMDATA','HOME')
  $values=[Collections.Generic.SortedDictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach($name in $allowed) {
    $value=if($null -eq $Source){[Environment]::GetEnvironmentVariable($name)}else{$Source.$name}
    if($null -ne $value) {
      if($value -isnot [string] -or $value.Contains([char]0)){throw 'background_launch_invalid_request'}
      $values[$name]=$value
    }
  }
  # Reject extra fields rather than copying any credential-bearing variables.
  if($null -ne $Source){foreach($property in $Source.PSObject.Properties){if($property.Name -cnotin $allowed){throw 'background_launch_invalid_request'}}}
  # A request can carry the launcher's stale machine TEMP; do not propagate it
  # back into the new supervisor, bridge, or CodeDom-based Tunnel guardian.
  $values['TEMP']=$compilationTemp;$values['TMP']=$compilationTemp
  return [string[]]@($values.GetEnumerator()|ForEach-Object{$_.Key+'='+$_.Value})
}
function Assert-DotsLaunchPath([string]$Path,[string]$Leaf) {
  if(-not $Path -or $Path.Contains([char]0) -or -not [IO.Path]::IsPathRooted($Path)){throw 'background_launch_invalid_request'}
  $full=[IO.Path]::GetFullPath($Path)
  if($Leaf -and [IO.Path]::GetFileName($full) -ine $Leaf){throw 'background_launch_invalid_request'}
  if($Leaf -and -not (Test-Path -LiteralPath $full -PathType Leaf)){throw 'background_launch_invalid_request'}
  return $full
}
function New-DotsProcessStartup([string[]]$Environment) {
  return New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0;CreateFlags=[uint32]0x08000400;EnvironmentVariables=$Environment} -ErrorAction Stop
}
function Invoke-DotsProcessCreate([string]$Command,[string]$Directory,$Startup) {
  return Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$Command;CurrentDirectory=$Directory;ProcessStartupInformation=$Startup} -OperationTimeoutSec 5 -ErrorAction Stop
}
function Get-DotsCreatedProcess([uint32]$ProcessNumber) {
  return Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId='+$ProcessNumber) -OperationTimeoutSec 2 -ErrorAction Stop
}
function Get-DotsCreatedOwner($ProcessInfo) { return Invoke-CimMethod -InputObject $ProcessInfo -MethodName GetOwnerSid -OperationTimeoutSec 2 -ErrorAction Stop }
function Read-DotsReadyJson([string]$Directory,[string]$Name) {
  $path=Join-Path $Directory $Name
  $file=Get-Item -LiteralPath $path -Force -ErrorAction Stop
  if($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $file.Length -gt 65536){throw 'invalid_ready_metadata'}
  return (Get-Content -LiteralPath $path -Raw -Encoding UTF8|ConvertFrom-Json)
}
function Test-DotsBackgroundReady([string]$Node,[string]$Entry,[string]$Directory,[int]$ProcessNumber,[string]$OldOwner) {
  try {
    $null=Set-DotsUserCompilationTemp
    $node=Assert-DotsLaunchPath $Node 'node.exe';$entry=Assert-DotsLaunchPath $Entry ''; $directory=Assert-DotsLaunchPath $Directory ''
    $state=Read-DotsReadyJson $directory 'supervisor-state.json';$supervisor=Read-DotsReadyJson $directory 'supervisor.lock';$service=Read-DotsReadyJson $directory 'service.lock'
    if($state.phase -cne 'running' -or $state.cleanup_complete -eq $true -or -not $state.owner -or $state.owner -ceq $OldOwner -or ($ProcessNumber -and $state.pid -ne $ProcessNumber)){return $false}
    if($supervisor.owner -cne $state.owner -or $supervisor.pid -ne $state.pid -or $service.pid -ne $state.bridge_pid -or -not $service.owner -or $service.owner -ceq $state.owner){return $false}
    if(-not ('DotsBackgroundArguments' -as [type])) {
      Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class DotsBackgroundArguments {
 [DllImport("shell32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CommandLineToArgvW(string command,out int count);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
 public static string[] Parse(string command){int count;IntPtr value=CommandLineToArgvW(command,out count);if(value==IntPtr.Zero)throw new Exception("invalid_arguments");try{var result=new string[count];for(int i=0;i<count;i++)result[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(value,i*IntPtr.Size));return result;}finally{LocalFree(value);}}
}
'@
    }
    foreach($check in @(@{pid=$state.pid;mode='--supervisor'},@{pid=$state.bridge_pid;mode='--foreground'})) {
      if(-not $check.pid -or $check.pid -lt 1){return $false}
      $p=Get-DotsCreatedProcess ([uint32]$check.pid)
      if(-not $p -or $p.ExecutablePath -ine $node){return $false}
      $actual=[DotsBackgroundArguments]::Parse($p.CommandLine);$expected=@($node,$entry,'run',$check.mode,'--data-dir',$directory)
      if($actual.Count -ne $expected.Count){return $false}
      for($i=0;$i -lt $actual.Count;$i++){if($actual[$i] -cne $expected[$i]){return $false}}
    }
    $config=Read-DotsReadyJson $directory 'config.json';$endpoint=[Uri]$config.endpoint
    if($endpoint.Scheme -cne 'http' -or $endpoint.Host -cne '127.0.0.1' -or $endpoint.Port -le 0 -or $endpoint.AbsolutePath -cne '/' -or $endpoint.Query -or $endpoint.Fragment -or $endpoint.UserInfo){return $false}
    $health=Invoke-WebRequest -Uri ([Uri]::new($endpoint,'health')) -UseBasicParsing -TimeoutSec 2 -MaximumRedirection 0 -ErrorAction Stop
    if($health.StatusCode -ne 200 -or (($health.Content|ConvertFrom-Json).service -cne 'codex-dots-bridge')){return $false}
    $fresh=Read-DotsReadyJson $directory 'supervisor-state.json';$freshSupervisor=Read-DotsReadyJson $directory 'supervisor.lock';$freshService=Read-DotsReadyJson $directory 'service.lock'
    return $fresh.owner -ceq $state.owner -and $fresh.pid -eq $state.pid -and $fresh.bridge_pid -eq $state.bridge_pid -and $fresh.phase -ceq 'running' -and $freshSupervisor.owner -ceq $supervisor.owner -and $freshSupervisor.pid -eq $supervisor.pid -and $freshService.owner -ceq $service.owner -and $freshService.pid -eq $service.pid
  }catch{return $false}
}
function Start-DotsBackgroundProcess($Request) {
  $directory=Assert-DotsLaunchPath $Request.dataDir ''
  if($Request.kind -ceq 'supervisor') {
    $exe=Assert-DotsLaunchPath $Request.nodePath 'node.exe'
    $entry=Assert-DotsLaunchPath $Request.entryPath ''
    if(-not (Test-Path -LiteralPath $entry -PathType Leaf) -or [IO.Path]::GetExtension($entry) -cnotin @('.js','.mjs','.ts')){throw 'background_launch_invalid_request'}
    $arguments=@($entry,'run','--supervisor','--data-dir',$directory)
  } elseif($Request.kind -ceq 'tray' -and $Request.mode -cin @('--background','--show')) {
    $exe=Assert-DotsLaunchPath $Request.executable 'CodexDotsBridge.Tray.exe'
    $arguments=@($Request.mode,'--data-dir',$directory)
  } else {throw 'background_launch_invalid_request'}
  $environment=Get-DotsBackgroundEnvironment $Request.environment
  $command=(@($exe)+$arguments|ForEach-Object{Quote-DotsWindowsArgument $_}) -join ' '
  $submitted=$false
  try {
    $session=[Diagnostics.Process]::GetCurrentProcess().SessionId
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $startup=New-DotsProcessStartup $environment
    $submitted=$true
    $result=Invoke-DotsProcessCreate $command (Split-Path -Parent $exe) $startup
    if($result.ReturnValue -ne 0){throw 'background_launch_rejected'}
    if(-not $result.ProcessId){throw 'background_launch_unknown'}
    $created=Get-DotsCreatedProcess ([uint32]$result.ProcessId)
    if($null -eq $created -or $created.SessionId -ne $session){throw 'background_launch_unknown'}
    $owner=Get-DotsCreatedOwner $created
    if($owner.ReturnValue -ne 0 -or $owner.Sid -cne $sid){throw 'background_launch_unknown'}
    # No process handles, locks or service-ready claims; no kill or retry on failure.
    return @{pid=[int]$result.ProcessId;sessionId=[int]$session}
  } catch {
    if($_.Exception.Message -in @('background_launch_rejected','background_launch_unknown')){throw $_.Exception.Message}
    if($submitted){throw 'background_launch_unknown'}
    throw 'background_broker_unavailable'
  }
}
# Dot-source is used only by isolated regression tests; normal entry is fixed.
if($MyInvocation.InvocationName -eq '.'){return}
try {
  if($PSCmdlet.ParameterSetName -eq 'Ready') {@{ready=(Test-DotsBackgroundReady $NodeExecutable $EntryPath $DataDir $ExpectedPid $PreviousOwner)}|ConvertTo-Json -Compress;exit 0}
  if($PSCmdlet.ParameterSetName -eq 'Tray'){$request=[pscustomobject]@{kind='tray';executable=$TrayExecutable;dataDir=$DataDir;mode=$TrayMode;environment=$null}}
  elseif($PSCmdlet.ParameterSetName -eq 'SupervisorPaths'){$request=[pscustomobject]@{kind='supervisor';nodePath=$NodeExecutable;entryPath=$EntryPath;dataDir=$DataDir;environment=$null}}
  else {
    $text=[Console]::In.ReadToEnd()
    if($text.Length -gt 65536){throw 'background_launch_invalid_request'}
    try{$request=$text|ConvertFrom-Json}catch{throw 'background_launch_invalid_request'}
    if($request.kind -cne 'supervisor'){throw 'background_launch_invalid_request'}
  }
  Start-DotsBackgroundProcess $request | ConvertTo-Json -Compress
  exit 0
} catch {
  $code=$_.Exception.Message
  if($code -notin @('background_launch_rejected','background_broker_unavailable','background_launch_unknown','background_launch_invalid_request')){$code='background_launch_invalid_request'}
  @{error=$code}|ConvertTo-Json -Compress
  exit 1
}
