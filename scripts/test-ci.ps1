[CmdletBinding()]
param([switch]$CheckOnly)
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
$probe = Join-Path ([IO.Path]::GetTempPath()) ('dots-ci-owner-' + [Guid]::NewGuid().ToString('N'))
try {
    [DotsCiTokenOwner]::SetOwner($user)
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
    if (-not $CheckOnly) { & (Join-Path $PSScriptRoot 'dev.ps1') test }
} finally {
    [DotsCiTokenOwner]::SetOwner($originalOwner)
    $identity.Dispose()
    Remove-Item Env:CODEX_DOTS_CI_OWNER_PROBE -ErrorAction SilentlyContinue
    # The probe is a unique empty directory. Never recursively delete a computed target.
    if (Test-Path -LiteralPath $probe) { [IO.Directory]::Delete($probe, $false) }
}
