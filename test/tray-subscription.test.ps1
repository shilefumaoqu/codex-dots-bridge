[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$TrayExecutable)
$ErrorActionPreference='Stop'
$TrayExecutable=[IO.Path]::GetFullPath($TrayExecutable)
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('CodexDotsTraySubscription-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
# This newly created fixture alone gets a private inheritable DACL. Default TEMP
# and every pre-existing directory keep their owner and permissions.
$user=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($user);$acl.SetAccessRuleProtection($true,$false)
$inheritance=[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
foreach($sid in @($user,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inheritance,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
}
Set-Acl -LiteralPath $testRoot -AclObject $acl
$actualAcl=Get-Acl -LiteralPath $testRoot
if($actualAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $user.Value -or -not $actualAcl.AreAccessRulesProtected){throw 'Private subscription fixture ACL preparation failed.'}
Copy-Item -LiteralPath $TrayExecutable -Destination (Join-Path $testRoot 'CodexDotsBridge.Tray.exe')
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$fixture=Join-Path (Split-Path -Parent $PSScriptRoot) 'windows\tray\test\SubscriptionFixture.cs'
$harness=Join-Path $testRoot 'SubscriptionHarness.exe'
& $compiler '/nologo' '/target:exe' '/platform:x64' '/langversion:5' '/codepage:65001' '/reference:System.Windows.Forms.dll' '/reference:System.Drawing.dll' '/reference:System.Web.Extensions.dll' ('/out:'+$harness) $fixture
if($LASTEXITCODE -ne 0){throw 'Subscription fixture compilation failed.'}
$info=[Diagnostics.ProcessStartInfo]::new($harness);$info.UseShellExecute=$false;$info.CreateNoWindow=$true
$info.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
$process=[Diagnostics.Process]::Start($info)
try {
  $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
  if(-not $process.WaitForExit(30000)){throw 'Subscription fixture exceeded 30 seconds.'}
  $output=$stdout.GetAwaiter().GetResult();$errorText=$stderr.GetAwaiter().GetResult()
  [IO.File]::WriteAllText((Join-Path $testRoot 'result.json'),$output,[Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $testRoot 'stderr.log'),$errorText,[Text.UTF8Encoding]::new($false))
  Write-Output $output
  if($process.ExitCode -ne 0){throw ('Subscription fixture failed in '+$testRoot+': '+$errorText)}
} finally {
  # Only the process object created above belongs to this synthetic fixture.
  if(-not $process.HasExited){$process.Kill();$null=$process.WaitForExit(2000)}
  $exited=$process.HasExited;$exitCode=if($exited){$process.ExitCode}else{$null};$pidValue=$process.Id
  $process.Dispose()
  @{pid=$pidValue;exited=$exited;exit_code=$exitCode;disposed=$true}|ConvertTo-Json -Compress|Set-Content -LiteralPath (Join-Path $testRoot 'process-lifecycle.json') -Encoding UTF8
}
