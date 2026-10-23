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
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') { throw 'Only GitHub-hosted Windows runners are supported.' }
if (-not ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'The hosted runner must have an elevated administrator token.' }

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
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] private static extern uint SetNamedSecurityInfo(string path, int objectType, uint information, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    public static void SetDirectoryOwner(string path, SecurityIdentifier sid) {
        byte[] bytes = new byte[sid.BinaryLength]; sid.GetBinaryForm(bytes, 0);
        IntPtr pointer = Marshal.AllocHGlobal(bytes.Length);
        try {
            Marshal.Copy(bytes, 0, pointer, bytes.Length);
            // SE_FILE_OBJECT and OWNER_SECURITY_INFORMATION only. Never set a DACL or recurse.
            uint status = SetNamedSecurityInfo(path, 1, 1, pointer, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
            if (status != 0) throw new Win32Exception((int)status);
        } finally { Marshal.FreeHGlobal(pointer); }
    }
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
function Get-DotsCiDirectoryOwner([string]$Directory) {
    for ($cursor=$Directory;$cursor;$cursor=[IO.Path]::GetDirectoryName($cursor)) {
        if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'CI owner target has a reparse ancestor.' }
    }
    $acl=Get-Acl -LiteralPath $Directory
    return @{path=$Directory;owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;dacl=$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)}
}
function Set-DotsCiDirectoryOwner($Snapshot,[Security.Principal.SecurityIdentifier]$User) {
    $before=Get-DotsCiDirectoryOwner $Snapshot.path
    if ($Snapshot.owner -ne 'S-1-5-32-544' -or $before.owner -cne $Snapshot.owner -or $before.dacl -cne $Snapshot.dacl) { throw 'CI owner target changed or was not owned by Administrators.' }
    [DotsCiTokenOwner]::SetDirectoryOwner($Snapshot.path,$User)
    $after=Get-DotsCiDirectoryOwner $Snapshot.path
    if ($after.owner -cne $User.Value -or $after.dacl -cne $Snapshot.dacl) { throw 'CI directory owner update did not preserve the DACL.' }
}
function Restore-DotsCiDirectoryOwner($Snapshot,[Security.Principal.SecurityIdentifier]$User) {
    $before=Get-DotsCiDirectoryOwner $Snapshot.path
    if ($before.owner -notin @($Snapshot.owner,$User.Value)) { throw 'CI directory acquired an unexpected owner; refusing to overwrite it.' }
    if ($before.owner -cne $Snapshot.owner) { [DotsCiTokenOwner]::SetDirectoryOwner($Snapshot.path,[Security.Principal.SecurityIdentifier]::new($Snapshot.owner)) }
    $after=Get-DotsCiDirectoryOwner $Snapshot.path
    if ($after.owner -cne $Snapshot.owner -or $after.dacl -cne $Snapshot.dacl) { throw 'CI directory owner restoration or DACL verification failed.' }
    Write-Output ('CI directory owner restored: '+$after.owner)
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$originalOwner = $identity.Owner
$user = $identity.User
Write-Output ('CI default owner: ' + $originalOwner.Value + '; expected user: ' + $user.Value)
$originalTemp = $env:TEMP
$originalTmp = $env:TMP
$probe = $null
$tempOwnerSnapshot = $null
try {
    [DotsCiTokenOwner]::SetOwner($user)
    # Inspect actual PS5/CIM/CodeDom prerequisites. The token change above only
    # affects new objects, so also report the pre-existing known user Temp owner.
    $environmentCheck = @'
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows' -or $PSVersionTable.PSVersion.Major -ne 5){throw 'Expected GitHub-hosted Windows CI with Windows PowerShell 5.'}
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
    if (@($environmentResult.reparseAncestors).Count) { throw 'CI known user Temp has a reparse ancestor.' }
    if ($environmentResult.cimProcessQuery -ne 'passed' -or $environmentResult.compilation -ne 'passed') { throw 'CI native CIM/CodeDom prerequisite probe failed.' }
    if (-not $environmentResult.ownerTrusted) {
        if ($environmentResult.owner -ne 'S-1-5-32-544' -or $originalOwner.Value -ne 'S-1-5-32-544') { throw 'CI known user Temp has an unexpected owner.' }
        # Exercise real owner changes and failure cleanup in an empty, isolated fixture first.
        $fixture=Join-Path $environmentResult.knownTemp ('dots-ci-temp-owner-'+[Guid]::NewGuid().ToString('N'))
        $fixtureSnapshot=$null
        try {
            try { [DotsCiTokenOwner]::SetOwner($originalOwner);$null=[IO.Directory]::CreateDirectory($fixture) }
            finally { [DotsCiTokenOwner]::SetOwner($user) }
            $fixtureSnapshot=Get-DotsCiDirectoryOwner $fixture
            $sentinel=Join-Path $fixture 'sentinel.txt';[IO.File]::WriteAllText($sentinel,'synthetic owner preservation fixture')
            $childBefore=Get-Acl -LiteralPath $sentinel
            try { Set-DotsCiDirectoryOwner $fixtureSnapshot $user;throw 'synthetic_ci_owner_test_failure' }
            catch { if ($_.Exception.Message -ne 'synthetic_ci_owner_test_failure') { throw } }
            finally { Restore-DotsCiDirectoryOwner $fixtureSnapshot $user }
            if ([IO.File]::ReadAllText($sentinel) -cne 'synthetic owner preservation fixture' -or (Get-Acl -LiteralPath $sentinel).Sddl -cne $childBefore.Sddl) { throw 'CI owner test modified a child or its contents.' }
            Write-Output 'CI isolated owner change/restore passed; DACL and child unchanged.'
        } finally {
            if ([IO.File]::Exists((Join-Path $fixture 'sentinel.txt'))) { [IO.File]::Delete((Join-Path $fixture 'sentinel.txt')) }
            if ([IO.Directory]::Exists($fixture)) { [IO.Directory]::Delete($fixture,$false) }
        }
        # Store the original owner before the write so every failure path can restore it.
        $candidateSnapshot=Get-DotsCiDirectoryOwner $environmentResult.knownTemp
        if ($candidateSnapshot.owner -ne 'S-1-5-32-544') { throw 'CI known user Temp owner changed after preflight.' }
        $tempOwnerSnapshot=$candidateSnapshot
        Set-DotsCiDirectoryOwner $tempOwnerSnapshot $user
        Write-Output ('CI known user Temp owner temporarily changed: '+$tempOwnerSnapshot.owner+' -> '+$user.Value)
    }
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
    try {
        if ($tempOwnerSnapshot) { Restore-DotsCiDirectoryOwner $tempOwnerSnapshot $user }
    } finally {
        [DotsCiTokenOwner]::SetOwner($originalOwner)
        $env:TEMP = $originalTemp
        $env:TMP = $originalTmp
        $identity.Dispose()
        Remove-Item Env:CODEX_DOTS_CI_OWNER_PROBE -ErrorAction SilentlyContinue
        # The probe is a unique empty directory. Never recursively delete a computed target.
        if ($probe -and (Test-Path -LiteralPath $probe)) { [IO.Directory]::Delete($probe, $false) }
    }
}
