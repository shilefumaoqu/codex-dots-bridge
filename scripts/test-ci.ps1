[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [string]$SetupExecutable,
    [string]$InstallerAppId,
    [string]$TestDirectory
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This harness is only for the disposable GitHub Actions Windows runner.' }
if (-not $IsWindows) { throw 'Windows CI is required.' }

# An elevated runner can default new objects to the Administrators group.
# Use the current user's SID for new test objects; production owner checks stay unchanged.
# https://learn.microsoft.com/windows/win32/api/winnt/ns-winnt-token_owner
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class DotsCiTokenOwner {
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError=true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] private static extern bool SetTokenInformation(IntPtr token, int informationClass, ref IntPtr information, int length);
    public static void SetOwner(SecurityIdentifier sid) {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), 0x88, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
        IntPtr sidPointer = IntPtr.Zero;
        try {
            byte[] bytes = new byte[sid.BinaryLength]; sid.GetBinaryForm(bytes, 0);
            sidPointer = Marshal.AllocHGlobal(bytes.Length); Marshal.Copy(bytes, 0, sidPointer, bytes.Length);
            if (!SetTokenInformation(token, 4, ref sidPointer, IntPtr.Size)) throw new Win32Exception(Marshal.GetLastWin32Error());
        } finally { if (sidPointer != IntPtr.Zero) Marshal.FreeHGlobal(sidPointer); CloseHandle(token); }
    }
}
'@
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$originalOwner = $identity.Owner
$user = $identity.User
Write-Output ('CI default owner: ' + $originalOwner.Value + '; expected user: ' + $user.Value)
$originalTemp = $env:TEMP
$originalTmp = $env:TMP
$probe = $null
try {
    [DotsCiTokenOwner]::SetOwner($user)
    # Inspect actual PS5/CIM/CodeDom prerequisites. The token change above only
    # affects new objects, so also report the pre-existing known user Temp owner.
    $environmentCheck = @'
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
if($env:GITHUB_ACTIONS -ne 'true' -or $PSVersionTable.PSVersion.Major -ne 5){throw 'Expected disposable Windows CI with Windows PowerShell 5.'}
$user=[Security.Principal.WindowsIdentity]::GetCurrent().User
$local=[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if(-not $local -or -not [IO.Path]::IsPathRooted($local)){throw 'CI known user Temp is unavailable.'}
$directory=[IO.Path]::GetFullPath([IO.Path]::Combine($local,'Temp'))
if(-not [IO.Directory]::Exists($directory)){throw 'CI known user Temp is missing.'}
$reparse=@()
for($cursor=$directory;$cursor;$cursor=[IO.Path]::GetDirectoryName($cursor)){
    if(([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0){$reparse+=$cursor}
}
$acl=[IO.Directory]::GetAccessControl($directory)
$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
$cim='passed'
try{
    foreach($command in @('Get-CimInstance','New-CimInstance','Invoke-CimMethod')){$null=Get-Command $command -ErrorAction Stop}
    $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID) -OperationTimeoutSec 5 -ErrorAction Stop
    if(-not $process -or $process.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId){throw 'CIM process/session mismatch.'}
}catch{$cim=$_.Exception.GetType().Name+': '+$_.Exception.Message}
$inheritedTemp=$env:TEMP;$env:TEMP=$directory;$env:TMP=$directory
$compile='passed'
try{Add-Type -TypeDefinition 'public static class DotsCiCompilerProbe { public static int Value() { return 1; } }' -ErrorAction Stop;if([DotsCiCompilerProbe]::Value() -ne 1){throw 'CodeDom result mismatch.'}}
catch{$compile=$_.Exception.GetType().Name+': '+$_.Exception.Message}
@{powershell=$PSVersionTable.PSVersion.ToString();edition=$PSVersionTable.PSEdition;temp=$inheritedTemp;knownTemp=$directory;owner=$owner;user=$user.Value;ownerTrusted=($owner -in @($user.Value,'S-1-5-18'));reparseAncestors=$reparse;cimProcessQuery=$cim;compilation=$compile}|ConvertTo-Json -Compress
'@
    $environmentOutput = @(& powershell.exe -NoProfile -NonInteractive -EncodedCommand ([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($environmentCheck))))
    $environmentExit = $LASTEXITCODE
    $environmentOutput | ForEach-Object { Write-Output ('CI native environment: ' + $_) }
    if ($environmentExit -ne 0) { throw 'CI native environment preflight failed.' }
    $environmentResult = $environmentOutput[-1] | ConvertFrom-Json
    if (-not $environmentResult.ownerTrusted -or @($environmentResult.reparseAncestors).Count) { throw 'CI known user Temp does not satisfy the unchanged production path/owner guard.' }
    if ($environmentResult.cimProcessQuery -ne 'passed' -or $environmentResult.compilation -ne 'passed') { throw 'CI native CIM/CodeDom prerequisite probe failed.' }
    # Avoid RUNNER~1 aliases in Node fixtures and native path receipts.
    $env:TEMP = $environmentResult.knownTemp
    $env:TMP = $environmentResult.knownTemp
    $probe = Join-Path ([IO.Path]::GetTempPath()) ('dots-ci-owner-' + [Guid]::NewGuid().ToString('N'))
    $env:CODEX_DOTS_CI_OWNER_PROBE = $probe
    # Verify the actual Node child creates current-user-owned objects before running unchanged tests.
    $node = Join-Path (Split-Path -Parent $PSScriptRoot) '.runtime\node-v24.21.0-win-x64\node.exe'
    & $node -e "require('node:fs').mkdirSync(process.env.CODEX_DOTS_CI_OWNER_PROBE)"
    if ($LASTEXITCODE -ne 0) { throw 'CI Node owner probe creation failed.' }
    $check = @'
$ErrorActionPreference='Stop'
$probe=[Environment]::GetEnvironmentVariable('CODEX_DOTS_CI_OWNER_PROBE')
$owner=[IO.Directory]::GetAccessControl($probe).GetOwner([Security.Principal.SecurityIdentifier]).Value
$user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if($owner -ne $user){throw 'CI child process did not inherit the current-user default owner'}
Write-Output ('CI child owner verified: '+$owner)
'@
    & powershell.exe -NoProfile -NonInteractive -EncodedCommand ([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($check)))
    if ($LASTEXITCODE -ne 0) { throw 'CI owner preflight failed.' }
    if (-not $CheckOnly) {
        if ($SetupExecutable) {
            if (-not $InstallerAppId -or -not $TestDirectory -or -not $env:CODEX_DOTS_TEST_CODEX) { throw 'Installer CI requires explicit isolated paths, test identity and official Codex.' }
            & (Join-Path (Split-Path -Parent $PSScriptRoot) 'test\windows-setup.test.ps1') -SetupExecutable $SetupExecutable -InstallerAppId $InstallerAppId -CodexCommand $env:CODEX_DOTS_TEST_CODEX -TestDirectory $TestDirectory
        } else {
            & (Join-Path $PSScriptRoot 'dev.ps1') test
            # Guard fixtures use the same current-user default owner as the core tests.
            # Restore the original token owner in the existing finally block below.
            foreach ($test in @('setup-lifecycle-guards','setup-data-discovery','setup-runtime-binding','tunnel-payload','tunnel-source-eol')) {
                foreach ($shell in @('powershell.exe', (Get-Process -Id $PID).Path)) {
                    & $shell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path (Split-Path -Parent $PSScriptRoot) "test/$test.test.ps1")
                    if ($LASTEXITCODE -ne 0) { throw "Installer guard failed: $test in $shell" }
                }
            }
        }
    }
} finally {
    [DotsCiTokenOwner]::SetOwner($originalOwner)
    $env:TEMP = $originalTemp
    $env:TMP = $originalTmp
    $identity.Dispose()
    Remove-Item Env:CODEX_DOTS_CI_OWNER_PROBE -ErrorAction SilentlyContinue
    # The probe is a unique empty directory. Never recursively delete a computed target.
    if ($probe -and (Test-Path -LiteralPath $probe)) { [IO.Directory]::Delete($probe, $false) }
}
