[CmdletBinding(DefaultParameterSetName = 'Bound')]
param(
    [ValidateSet('Probe', 'Navigate')][string]$Mode = 'Probe',
    [Parameter(Mandatory = $true, ParameterSetName = 'Auto')][switch]$AutoDiscover,
    [Parameter(Mandatory = $true, ParameterSetName = 'Bound')][int]$ExpectedProcessId,
    [Parameter(Mandatory = $true, ParameterSetName = 'Bound')][string]$ExpectedStartTimeUtc,
    [Parameter(Mandatory = $true, ParameterSetName = 'Bound')][string]$ExpectedExePath,
    [Parameter(Mandatory = $true, ParameterSetName = 'Bound')][string]$UserDataDir,
    [string]$ThreadId,
    [string]$WorkingDirectory,
    [ValidateRange(100, 5000)][int]$TimeoutMs = 1500
)
# Windows PowerShell 5.1. Probe never sends a window message. Navigate sends once.
# This helper does not launch, stop, retry, request foreground, or send chat input.
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
$receipt = [ordered]@{
    schema = 'native-window-autoload/v1'; mode = $Mode; status = 'not_sent'
    reason = 'validation_failed'; message_attempted = $false
    navigation_state = 'not_attempted'; target_ready_verified = $false
    pid = $ExpectedProcessId; window_match_count = 0; win32_error = $null
    receiver_ack = $null; requires_target_owner_verification = $true
}
try {
    # Resolve the omitted default after entering the script body. Keep explicit
    # invalid values subject to the existing strict path validation.
    if (-not $PSBoundParameters.ContainsKey('WorkingDirectory')) {
        $WorkingDirectory = $PSScriptRoot
    }
    if (-not ('NativeWindowAutoloadV1' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
public static class NativeWindowAutoloadV1 {
    [StructLayout(LayoutKind.Sequential)] public struct COPYDATASTRUCT {
        public UIntPtr dwData; public uint cbData; public IntPtr lpData;
    }
    public sealed class Result {
        public string reason; public int matches; public bool attempted;
        public bool apiSuccess; public ulong ack; public int error;
    }
    public sealed class Binding {
        public string reason,exe,profile; public int pid,profiles; public long ticks;
    }
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
    [DllImport("user32.dll", SetLastError=true)]
    static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    static extern int GetClassName(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr SendMessageTimeout(IntPtr window, uint msg, IntPtr wp,
        ref COPYDATASTRUCT data, uint flags, uint timeout, out UIntPtr result);
    static bool Identity(Process process, int pid, long ticks, string exe) {
        try {
            process.Refresh();
            return !process.HasExited && process.Id == pid &&
                process.StartTime.ToUniversalTime().Ticks == ticks &&
                String.Equals(process.MainModule.FileName, exe, StringComparison.OrdinalIgnoreCase);
        } catch { return false; }
    }
    static bool WindowMatches(IntPtr window, int pid, string title) {
        uint owner; var cls = new StringBuilder(128); var text = new StringBuilder(32768);
        return IsWindow(window) && GetWindowThreadProcessId(window, out owner) != 0 && owner == pid &&
            GetClassName(window, cls, cls.Capacity) > 0 && cls.ToString() == "Chrome_MessageWindow" &&
            GetWindowText(window, text, text.Capacity) > 0 &&
            String.Equals(text.ToString(), title, StringComparison.Ordinal);
    }
    static List<IntPtr> Windows(int pid, string title) {
        var windows = new List<IntPtr>(); var last = IntPtr.Zero;
        // Message-only windows only; no desktop window titles or chat contents.
        for (int n=0; n<4096; n++) {
            var window = FindWindowEx(new IntPtr(-3), last, "Chrome_MessageWindow", title);
            if (window == IntPtr.Zero) break;
            if (WindowMatches(window, pid, title)) windows.Add(window);
            last = window;
        }
        return windows;
    }
    public static Binding Discover() {
        var candidates = new List<Process>(); bool unreadable=false;
        foreach (var process in Process.GetProcessesByName("ChatGPT")) {
            try {
                string path=process.MainModule.FileName;
                // Current Store/MSIX product identity only; never other app identities.
                if (IsPackageExe(path))
                    candidates.Add(process);
                else process.Dispose();
            } catch { unreadable=true; process.Dispose(); }
        }
        try {
            var binding=DiscoverCandidates(candidates.ToArray());
            if(unreadable && binding.reason!="endpoint_ambiguous") binding.reason="process_identity_unreadable";
            return binding;
        } finally { foreach(var process in candidates) process.Dispose(); }
    }
    public static bool IsPackageExe(string path) {
        return Regex.IsMatch(path,@"^[A-Za-z]:\\Program Files\\WindowsApps\\OpenAI\.Codex_[^\\]+__2p2nqsd0c76g0\\app\\ChatGPT\.exe$",RegexOptions.IgnoreCase);
    }
    // Tests pass only isolated fixture Process objects to this discovery core.
    // The production script exposes no switch to bypass the package filter.
    public static Binding DiscoverCandidates(Process[] candidates) {
        var identities = new Dictionary<int,Binding>(); bool unreadable=false;
        foreach(var process in candidates) {
            try { identities.Add(process.Id,new Binding {pid=process.Id,exe=process.MainModule.FileName,
                ticks=process.StartTime.ToUniversalTime().Ticks}); }
            catch { unreadable=true; }
        }
        var matches = new List<Binding>(); var last=IntPtr.Zero;
        for(int n=0;n<4096;n++) {
            var window=FindWindowEx(new IntPtr(-3),last,"Chrome_MessageWindow",null);
            if(window==IntPtr.Zero) break;
            last=window; uint owner; Binding identity;
            if(GetWindowThreadProcessId(window,out owner)==0 || !identities.TryGetValue((int)owner,out identity)) continue;
            // Read matching candidate metadata only; never titles from other apps.
            var text=new StringBuilder(32768);
            if(GetWindowText(window,text,text.Capacity)<=0) continue;
            string profile=text.ToString();
            if(!Path.IsPathRooted(profile) || !Directory.Exists(profile)) continue;
            // ProcessSingleton CreateNamed uses the exact user_data_dir as title.
            matches.Add(new Binding {pid=identity.pid,exe=identity.exe,ticks=identity.ticks,profile=profile});
        }
        if(unreadable) return new Binding {reason="process_identity_unreadable"};
        if(matches.Count==0) return new Binding {reason=identities.Count==0 ? "offline" : "endpoint_missing"};
        if(matches.Count!=1) return new Binding {reason="endpoint_ambiguous",profiles=matches.Count};
        matches[0].reason="endpoint_ready"; matches[0].profiles=1; return matches[0];
    }
    public static Result Run(int pid, long ticks, string exe, string title,
                             string cwd, string uri, bool navigate, uint timeout) {
        var r = new Result();
        Process process;
        try { process = Process.GetProcessById(pid); }
        catch { r.reason="process_unavailable"; return r; }
        using (process) {
            // Retain a handle to the original process; never launch a replacement.
            try { var handle = process.Handle; }
            catch { r.reason="process_identity_unreadable"; return r; }
            if (!Identity(process,pid,ticks,exe)) { r.reason="process_identity_mismatch"; return r; }
            var windows = Windows(pid,title); r.matches=windows.Count;
            if (windows.Count != 1) {
                r.reason=windows.Count==0 ? "endpoint_missing" : "endpoint_ambiguous"; return r;
            }
            if (!navigate) { r.reason="endpoint_ready"; return r; }
            // Recheck exact process and exact endpoint immediately before the one send.
            var current = Windows(pid,title);
            if (!Identity(process,pid,ticks,exe) || current.Count!=1 ||
                current[0]!=windows[0] || !WindowMatches(windows[0],pid,title)) {
                r.reason="identity_changed_before_send"; return r;
            }
            string command = "\"" + exe + "\" \"" + uri + "\"";
            // Match Chromium: payload ends NUL, then c_str() adds a final NUL.
            byte[] payload = Encoding.Unicode.GetBytes("START\0"+cwd+"\0"+command+"\0\0");
            IntPtr memory = Marshal.AllocHGlobal(payload.Length);
            try {
                Marshal.Copy(payload,0,memory,payload.Length);
                var cds = new COPYDATASTRUCT { dwData=UIntPtr.Zero, cbData=(uint)payload.Length, lpData=memory };
                UIntPtr ack; SetLastError(0); r.attempted=true;
                r.apiSuccess=SendMessageTimeout(windows[0],0x004A,IntPtr.Zero,ref cds,
                    0x0002 | 0x0020,timeout,out ack)!=IntPtr.Zero;
                r.error=Marshal.GetLastWin32Error(); r.ack=ack.ToUInt64();
                r.reason=r.apiSuccess ? (r.ack!=0 ? "receiver_accepted" : "receiver_rejected") :
                    (r.error==0 || r.error==1460 ? "timeout_or_unconfirmed" : "send_failed_unconfirmed");
                return r;
            } catch {
                r.reason=r.attempted ? "send_failed_unconfirmed" : "payload_prepare_failed";
                return r;
            } finally { Marshal.FreeHGlobal(memory); }
        }
    }
}
'@
    }
    if ($AutoDiscover) {
        $binding = [NativeWindowAutoloadV1]::Discover()
        if ($binding.reason -ne 'endpoint_ready') {
            $receipt.reason = $binding.reason
            $receipt.status = if ($binding.reason -eq 'offline') { 'offline' } elseif ($binding.reason -eq 'endpoint_ambiguous') { 'ambiguous' } else { 'not_sent' }
            $receipt.window_match_count = $binding.profiles
            $receipt | ConvertTo-Json -Compress
            return
        }
        $ExpectedProcessId = $binding.pid
        $ExpectedStartTimeUtc = ([DateTime]::new($binding.ticks, [DateTimeKind]::Utc)).ToString('o')
        $ExpectedExePath = $binding.exe
        $UserDataDir = $binding.profile
        $receipt.pid = $ExpectedProcessId
    }
    if ($ExpectedProcessId -le 0) { throw 'invalid_pid' }
    $start = [DateTimeOffset]::Parse($ExpectedStartTimeUtc, [Globalization.CultureInfo]::InvariantCulture)
    foreach ($pathValue in @($ExpectedExePath, $UserDataDir, $WorkingDirectory)) {
        if ([string]::IsNullOrWhiteSpace($pathValue) -or $pathValue.IndexOf([char]0) -ge 0 -or
            $pathValue.Contains('"') -or $pathValue.Contains("`r") -or $pathValue.Contains("`n") -or
            -not [IO.Path]::IsPathRooted($pathValue)) { throw 'invalid_path' }
    }
    $exe = [IO.Path]::GetFullPath($ExpectedExePath)
    $cwd = [IO.Path]::GetFullPath($WorkingDirectory)
    if (-not [IO.Directory]::Exists($cwd)) { throw 'invalid_cwd' }
    if ($Mode -eq 'Navigate') {
        if ($ThreadId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
            throw 'invalid_thread_id'
        }
        $ThreadId = ([Guid]::Parse($ThreadId)).ToString('D')
        if ($ThreadId -eq [Guid]::Empty.ToString('D')) { throw 'invalid_thread_id' }
    }
    $uri = if ($Mode -eq 'Navigate') { "codex://threads/$ThreadId`?hostId=local" } else { '' }
    $result = [NativeWindowAutoloadV1]::Run($ExpectedProcessId, $start.UtcDateTime.Ticks,
        $exe, $UserDataDir, $cwd, $uri, ($Mode -eq 'Navigate'), [uint32]$TimeoutMs)
    $receipt.reason = $result.reason
    $receipt.window_match_count = $result.matches
    $receipt.message_attempted = $result.attempted
    if ($result.attempted) {
        $receipt.navigation_state = 'possibly_navigated'
        $receipt.win32_error = $result.error
        if ($result.apiSuccess) { $receipt.receiver_ack = ($result.ack -ne 0) }
        $receipt.status = if ($result.apiSuccess -and $result.ack -ne 0) { 'protocol_accepted' } else { 'navigation_unconfirmed' }
    } elseif ($result.reason -eq 'endpoint_ready') { $receipt.status = 'probe_ready' }
} catch {
    # Exception text can contain private paths. Only emit a fixed reason.
    $receipt.reason = 'validation_or_probe_error'
}
$receipt | ConvertTo-Json -Compress
