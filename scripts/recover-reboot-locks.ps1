param([string]$DataDir)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Resolve only the built-in modules this recovery probe uses.
Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1')) -Global -ErrorAction Stop
Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','CimCmdlets','CimCmdlets.psd1')) -Global -ErrorAction Stop

# CodeDom must use the current user's known folder, even when the launcher
# inherited the machine TEMP. Never change the user or machine environment.
function Set-DotsUserCompilationTemp {
    try {
        $local = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
        if (-not $local -or -not [IO.Path]::IsPathRooted($local)) { throw 'invalid_temp' }
        $directory = [IO.Path]::GetFullPath([IO.Path]::Combine($local,'Temp'))
        if (-not [IO.Directory]::Exists($directory)) { throw 'invalid_temp' }
        for ($cursor=$directory; $cursor; $cursor=[IO.Path]::GetDirectoryName($cursor)) {
            if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'invalid_temp' }
        }
        $user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $owner = [IO.Directory]::GetAccessControl($directory).GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($owner -notin @($user,'S-1-5-18')) { throw 'invalid_temp' }
        $env:TEMP=$directory; $env:TMP=$directory
        return $directory
    } catch { throw 'recovery_probe_failed' }
}
$null = Set-DotsUserCompilationTemp

# Metadata is read as a short-lived snapshot; no metadata handle spans a CIM or
# network probe. Lock handles permit readers but prevent writes/replacement.
# Deletion targets the exact opened old lock.
if (-not ('DotsRebootFile' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public sealed class DotsRebootFile : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct Info {
        public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation,Access,Write;
        public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
    }
    [StructLayout(LayoutKind.Sequential)] struct Disposition { [MarshalAs(UnmanagedType.Bool)] public bool Delete; }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint mode,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info info);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle h,int kind,ref Disposition disposition,uint size);
    [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(SafeFileHandle h,int type,uint information,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertSidToStringSid(IntPtr sid,out IntPtr text);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("shell32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CommandLineToArgvW(string command,out int count);
    readonly SafeFileHandle handle;
    readonly uint volume,indexHigh,indexLow;
    readonly uint size;
    string contents;
    public DateTime CreationUtc { get; private set; }
    public DateTime WriteUtc { get; private set; }
    public string Owner { get; private set; }
    static DateTime Time(System.Runtime.InteropServices.ComTypes.FILETIME t) { return DateTime.FromFileTimeUtc(((long)t.dwHighDateTime<<32)|(uint)t.dwLowDateTime); }
    public DotsRebootFile(string path,bool deletable) {
        handle=CreateFile(path,0x80000000u|(deletable?0x10000u:0u),deletable?1u:7u,IntPtr.Zero,3,0x00200000u,IntPtr.Zero);
        if(handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
        try {
            Info info;if(!GetFileInformationByHandle(handle,out info))throw new Win32Exception(Marshal.GetLastWin32Error());
            if((info.Attributes&0x410u)!=0||info.Links!=1||info.SizeHigh!=0||info.SizeLow>65536)throw new InvalidDataException("unsafe_file");
            volume=info.Volume;indexHigh=info.IndexHigh;indexLow=info.IndexLow;size=info.SizeLow;
            CreationUtc=Time(info.Creation);WriteUtc=Time(info.Write);
            IntPtr owner,group,dacl,sacl,descriptor;
            uint code=GetSecurityInfo(handle,1,1,out owner,out group,out dacl,out sacl,out descriptor);
            if(code!=0)throw new Win32Exception((int)code);
            try { IntPtr text;if(!ConvertSidToStringSid(owner,out text))throw new Win32Exception(Marshal.GetLastWin32Error());try {Owner=Marshal.PtrToStringUni(text);}finally {LocalFree(text);} }
            finally {LocalFree(descriptor);}
        }catch {handle.Dispose();throw;}
    }
    public string Read() {
        var value=ReadHandle(handle);if(contents==null)contents=value;return value;
    }
    static string ReadHandle(SafeFileHandle source) {
        // A borrowed handle lets the stream close without releasing the held file.
        using(var borrowed=new SafeFileHandle(source.DangerousGetHandle(),false))
        using(var stream=new FileStream(borrowed,FileAccess.Read)) {
            stream.Seek(0,SeekOrigin.Begin);
            using(var reader=new StreamReader(stream,new UTF8Encoding(false,true),true)) {
                return reader.ReadToEnd();
            }
        }
    }
    public bool MatchesPath(string path) {
        using(var current=CreateFile(path,0x80000000u,7,IntPtr.Zero,3,0x00200000u,IntPtr.Zero)) {
            if(current.IsInvalid)return false;
            Info info;if(!GetFileInformationByHandle(current,out info))return false;
            if(!Unchanged(info))return false;
            if(contents!=null&&ReadHandle(current)!=contents)return false;
            return GetFileInformationByHandle(current,out info)&&Unchanged(info);
        }
    }
    bool Unchanged(Info info) {
        return (info.Attributes&0x410u)==0&&info.Links==1&&info.Volume==volume&&info.IndexHigh==indexHigh&&info.IndexLow==indexLow&&info.SizeHigh==0&&info.SizeLow==size&&Time(info.Creation)==CreationUtc&&Time(info.Write)==WriteUtc;
    }
    public void MarkDelete() { var disposition=new Disposition {Delete=true};if(!SetFileInformationByHandle(handle,4,ref disposition,(uint)Marshal.SizeOf(typeof(Disposition))))throw new Win32Exception(Marshal.GetLastWin32Error()); }
    public void CancelDelete() { var disposition=new Disposition {Delete=false};if(!SetFileInformationByHandle(handle,4,ref disposition,(uint)Marshal.SizeOf(typeof(Disposition))))throw new Win32Exception(Marshal.GetLastWin32Error()); }
    public void Dispose() {handle.Dispose();}
    public static string[] Arguments(string command) {
        int count;IntPtr argv=CommandLineToArgvW(command,out count);if(argv==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
        try {var result=new string[count];for(int i=0;i<count;i++)result[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv,i*IntPtr.Size));return result;}finally {LocalFree(argv);}
    }
}
'@
}

function Get-DotsBootUtc {
    $os = Get-CimInstance -ClassName Win32_OperatingSystem -Property LastBootUpTime -ErrorAction Stop
    if ($null -eq $os.LastBootUpTime) { throw 'unknown_boot' }
    return $os.LastBootUpTime.ToUniversalTime()
}
function Get-DotsProcesses {
    return @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,Name,CommandLine,CreationDate -ErrorAction Stop)
}
function Get-DotsProcessInfos([int[]]$ProcessNumbers) {
    $numbers = @($ProcessNumbers | Sort-Object -Unique)
    if ($numbers.Count -eq 0) { return @() }
    foreach ($number in $numbers) { if ($number -le 0) { throw 'invalid_pid' } }
    $filter = ($numbers | ForEach-Object { 'ProcessId='+$_ }) -join ' OR '
    return @(Get-CimInstance -ClassName Win32_Process -Filter $filter -Property ProcessId,Name,CommandLine,CreationDate -ErrorAction Stop)
}
function Test-DotsSameDataProcess($Processes, [string]$Directory, $Config, $Refreshed) {
    foreach ($processInfo in $Processes) {
        if ($processInfo.ProcessId -eq $PID) { continue }
        if ([string]::IsNullOrWhiteSpace($processInfo.CommandLine) -and $processInfo.Name -match '^(node|codex-dots-bridge)(\.exe)?$') {
            # CIM can retain an already-exited process in its initial snapshot.
            # Refresh this PID once; a reused PID is assessed as its current entry.
            $current = @($Refreshed | Where-Object { $_.ProcessId -eq $processInfo.ProcessId })
            if ($current.Count -eq 0) { continue }
            if ($current.Count -ne 1 -or $current[0].ProcessId -ne $processInfo.ProcessId) { throw 'unknown_process_command' }
            $processInfo = $current[0]
        }
        if ([string]::IsNullOrWhiteSpace($processInfo.CommandLine)) {
            if ($processInfo.Name -match '^(node|codex-dots-bridge)(\.exe)?$') { throw 'unknown_process_command' }
            continue
        }
        $arguments = [DotsRebootFile]::Arguments($processInfo.CommandLine)
        # stdio MCP callers and `run --start` parents are not service owners.
        # Recovery itself is invoked by such a parent with the same --data-dir.
        $hasMain = @($arguments | Where-Object { $_ -match '[\\/]main\.(js|ts)$' }).Count -gt 0
        if (-not $hasMain -or $arguments -notcontains 'run' -or ($arguments -notcontains '--foreground' -and $arguments -notcontains '--supervisor')) { continue }
        for ($i=1; $i -lt $arguments.Count; $i++) {
            $candidate = $null
            if ($arguments[$i] -eq '--data-dir') {
                if ($i+1 -ge $arguments.Count) { throw 'invalid_process_command' }
                $candidate = $arguments[$i+1]
            } elseif ($arguments[$i].StartsWith('--data-dir=')) { $candidate = $arguments[$i].Substring(11) }
            if ($candidate -and [IO.Path]::GetFullPath($candidate).TrimEnd('\') -ieq $Directory.TrimEnd('\')) { return $true }
        }
        # The built-in CLI can select its default data directory without a flag.
        $default = [IO.Path]::Combine($env:LOCALAPPDATA,'CodexDotsBridge','data')
        if ($Directory.TrimEnd('\') -ieq $default.TrimEnd('\') -and $arguments -contains 'run') {
            foreach ($argument in $arguments) {
                if ($Config.installation -and $argument -ieq [IO.Path]::Combine($Config.installation.root,'dist','main.js')) { return $true }
                if ($argument -match '[\\/]codex-dots-bridge[\\/].*[\\/]main\.(js|ts)$') { return $true }
            }
        }
    }
    return $false
}
function Test-DotsEndpointRefused([string]$Endpoint) {
    $uri = [Uri]$Endpoint
    if (-not $uri.IsAbsoluteUri -or $uri.Scheme -ne 'http' -or $uri.Host -ne '127.0.0.1' -or $uri.Port -lt 1 -or $uri.AbsolutePath -ne '/' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) { throw 'invalid_endpoint' }
    $client = New-Object Net.Sockets.TcpClient
    try {
        $task = $client.ConnectAsync('127.0.0.1',$uri.Port)
        try { if (-not $task.Wait(3000)) { throw 'endpoint_unknown' }; return $false }
        catch {
            $failure = $_.Exception
            while ($failure.InnerException) { $failure = $failure.InnerException }
            if ($failure -is [Net.Sockets.SocketException] -and $failure.SocketErrorCode -eq [Net.Sockets.SocketError]::ConnectionRefused) { return $true }
            throw 'endpoint_unknown'
        }
    } finally { $client.Dispose() }
}
function Assert-DotsIdentity($Record) {
    $parsed = [Guid]::Empty
    if (-not [Guid]::TryParse([string]$Record.owner,[ref]$parsed) -or $parsed -eq [Guid]::Empty) { throw 'invalid_owner' }
    if ($Record.pid -isnot [ValueType] -or $Record.pid -le 0 -or $Record.pid -gt [int]::MaxValue -or [Math]::Truncate([double]$Record.pid) -ne $Record.pid) { throw 'invalid_pid' }
}
function Get-DotsRecordedPids($State) {
    $numbers = [Collections.Generic.List[int]]::new()
    foreach ($field in @('pid','bridge_pid','guardian_pid','tunnel_pid')) {
        $number = $State.$field
        if ($null -eq $number) { continue }
        if ($number -isnot [ValueType] -or $number -le 0 -or $number -gt [int]::MaxValue -or [Math]::Truncate([double]$number) -ne $number) { throw 'invalid_pid' }
        $numbers.Add([int]$number)
    }
    return @($numbers | Sort-Object -Unique)
}
function Assert-DotsRecordedProcessesGone($State, [DateTime]$StateWriteUtc, $Refreshed) {
    # A numeric PID is not an identity. For same-boot recovery an extant PID is
    # accepted only when CIM proves it was created after this exact old state.
    foreach ($number in @(Get-DotsRecordedPids $State)) {
        $current = @($Refreshed | Where-Object { $_.ProcessId -eq $number })
        if ($current.Count -eq 0) { continue }
        if ($current.Count -ne 1 -or $current[0].ProcessId -ne $number -or $current[0].CreationDate -isnot [DateTime]) { throw 'recorded_process_unknown' }
        $created = $current[0].CreationDate.ToUniversalTime()
        if ($created -gt [DateTime]::UtcNow.AddSeconds(2)) { throw 'recorded_process_unknown' }
        if ($created -le $StateWriteUtc.AddSeconds(2)) { throw 'recorded_process_active' }
    }
}
function Assert-DotsProcessStage([string]$Directory, $Config, $State, [DateTime]$StateWriteUtc, [bool]$CheckRecorded) {
    # Each stage independently samples all processes, then refreshes the relevant
    # identities in one new CIM query. Never reuse this result across the lock gate.
    $processes = @(Get-DotsProcesses)
    $numbers = [Collections.Generic.List[int]]::new()
    foreach ($processInfo in $processes) {
        if ($processInfo.ProcessId -ne $PID -and [string]::IsNullOrWhiteSpace($processInfo.CommandLine) -and $processInfo.Name -match '^(node|codex-dots-bridge)(\.exe)?$') {
            $number = $processInfo.ProcessId
            if ($number -isnot [ValueType] -or $number -le 0 -or $number -gt [int]::MaxValue -or [Math]::Truncate([double]$number) -ne $number) { throw 'unknown_process_command' }
            $numbers.Add([int]$number)
        }
    }
    if ($CheckRecorded) { foreach ($number in @(Get-DotsRecordedPids $State)) { $numbers.Add($number) } }
    $wanted = @($numbers | Sort-Object -Unique)
    $refreshed = @(Get-DotsProcessInfos $wanted)
    $seen = @{}
    foreach ($processInfo in $refreshed) {
        $number = $processInfo.ProcessId
        if ($number -isnot [ValueType] -or $number -le 0 -or $number -gt [int]::MaxValue -or [Math]::Truncate([double]$number) -ne $number -or $wanted -notcontains $number -or $seen.ContainsKey([int]$number)) { throw 'recorded_process_unknown' }
        $seen[[int]$number] = $true
    }
    if (Test-DotsSameDataProcess $processes $Directory $Config $refreshed) { throw 'same_data_process_active' }
    if ($CheckRecorded) { Assert-DotsRecordedProcessesGone $State $StateWriteUtc $refreshed }
}
function Invoke-DotsRebootRecovery([string]$Directory) {
    $result = @{recovered=$false;clearPreviousState=$false;reason='preserved';removed=@()}
    $opened = @{}
    try {
        $directory = [IO.Path]::GetFullPath($Directory)
        $cursor = $directory
        while ($cursor) {
            if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe_directory' }
            $cursor = [IO.Path]::GetDirectoryName($cursor)
        }
        $user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $allowed = @($user,'S-1-5-18')
        if ([IO.Directory]::GetAccessControl($directory).GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed) { throw 'untrusted_owner' }
        $boot = Get-DotsBootUtc
        $result.bootUtc = $boot.ToString('o')
        if ($boot -gt [DateTime]::UtcNow.AddSeconds(2)) { throw 'unknown_boot' }
        $cutoff = $boot.AddSeconds(-2)
        $statePath = [IO.Path]::Combine($directory,'supervisor-state.json')
        $names = @('config.json','supervisor-state.json')
        foreach ($name in $names) {
            $path = [IO.Path]::Combine($directory,$name)
            if ([IO.File]::Exists($path)) {
                $opened[$name] = [DotsRebootFile]::new($path,$name.EndsWith('.lock'))
                if ($opened[$name].Owner -notin $allowed) { throw 'untrusted_owner' }
            } elseif ([IO.Directory]::Exists($path)) { throw 'unsafe_file' }
        }
        if (-not $opened['config.json']) { throw 'missing_config' }
        $configText = $opened['config.json'].Read()
        $opened['config.json'].Dispose()
        $config = $configText | ConvertFrom-Json
        $instance = [Guid]::Empty
        if ($config.owner -ne 'codex-dots-bridge' -or $config.schema_version -notin @(1,2) -or -not [Guid]::TryParse([string]$config.instance_id,[ref]$instance)) { throw 'unowned_data' }
        if (-not $opened['supervisor-state.json']) { throw 'requires_manual_recovery' }
        $stateText = $opened['supervisor-state.json'].Read()
        $opened['supervisor-state.json'].Dispose()
        $state = $stateText | ConvertFrom-Json
        Assert-DotsIdentity $state
        if ($state.phase -notin @('starting','running','stopping','failed')) { throw 'invalid_state' }
        $stateFile = $opened['supervisor-state.json']
        $priorBoot = $stateFile.CreationUtc -lt $cutoff -and $stateFile.WriteUtc -lt $cutoff
        if (-not $priorBoot -and ($stateFile.CreationUtc -lt $boot -or $stateFile.WriteUtc -lt $boot -or $stateFile.CreationUtc -gt [DateTime]::UtcNow.AddSeconds(2) -or $stateFile.WriteUtc -gt [DateTime]::UtcNow.AddSeconds(2))) { throw 'same_boot_or_unknown' }
        $hasService = [IO.File]::Exists([IO.Path]::Combine($directory,'service.lock'))
        $hasSupervisor = [IO.File]::Exists([IO.Path]::Combine($directory,'supervisor.lock'))
        if ($priorBoot -and $hasService -ne $hasSupervisor) { throw 'requires_manual_recovery' }
        # Live/current-boot instances must retain unrestricted stop/unlink behavior.
        # Do not acquire deletion-blocking lock handles until liveness is excluded.
        if (-not $config.endpoint -or -not (Test-DotsEndpointRefused $config.endpoint)) { throw 'endpoint_active_or_unknown' }
        Assert-DotsProcessStage $directory $config $state $stateFile.WriteUtc (-not $priorBoot)
        foreach ($name in @('service.lock','supervisor.lock')) {
            $path = [IO.Path]::Combine($directory,$name)
            if ([IO.File]::Exists($path)) {
                $opened[$name] = [DotsRebootFile]::new($path,$true)
                if ($opened[$name].Owner -notin $allowed) { throw 'untrusted_owner' }
            } elseif ([IO.Directory]::Exists($path)) { throw 'unsafe_file' }
        }
        if ([bool]$opened['service.lock'] -ne $hasService -or [bool]$opened['supervisor.lock'] -ne $hasSupervisor) { throw 'lock_set_changed' }
        foreach ($name in @('service.lock','supervisor.lock')) {
            if (-not $opened[$name]) { continue }
            $file = $opened[$name]
            if ($priorBoot) {
                if ($file.CreationUtc -ge $cutoff -or $file.WriteUtc -ge $cutoff) { throw 'same_boot_or_unknown' }
            } elseif ($file.CreationUtc -lt $boot -or $file.WriteUtc -lt $boot -or $file.CreationUtc -gt $stateFile.WriteUtc.AddSeconds(2) -or $file.WriteUtc -gt $stateFile.WriteUtc.AddSeconds(2)) { throw 'same_boot_or_unknown' }
        }
        $service = $opened['service.lock']; $supervisor = $opened['supervisor.lock']
        if ($priorBoot -and [bool]$service -ne [bool]$supervisor) { throw 'requires_manual_recovery' }
        if ($supervisor) {
            $supervisorRecord = $supervisor.Read() | ConvertFrom-Json
            Assert-DotsIdentity $supervisorRecord
            if ($supervisorRecord.owner -cne $state.owner -or $supervisorRecord.pid -ne $state.pid) { throw 'ownership_mismatch' }
        }
        if ($service) {
            $serviceRecord = $service.Read() | ConvertFrom-Json
            Assert-DotsIdentity $serviceRecord
            if ($serviceRecord.pid -ne $state.bridge_pid -or $serviceRecord.owner -ceq $state.owner) { throw 'ownership_mismatch' }
        }
        if (-not $config.endpoint -or -not (Test-DotsEndpointRefused $config.endpoint)) { throw 'endpoint_active_or_unknown' }
        Assert-DotsProcessStage $directory $config $state $stateFile.WriteUtc (-not $priorBoot)
        # Recheck after the process snapshot while both exact old locks remain held.
        if (-not (Test-DotsEndpointRefused $config.endpoint)) { throw 'endpoint_active_or_unknown' }
        foreach ($name in @('service.lock','supervisor.lock')) {
            if ([IO.File]::Exists([IO.Path]::Combine($directory,$name)) -ne [bool]$opened[$name]) { throw 'lock_set_changed' }
        }
        foreach ($name in @('config.json','supervisor-state.json')) {
            if (-not $opened[$name].MatchesPath([IO.Path]::Combine($directory,$name))) { throw 'metadata_changed' }
        }
        if ($service -or $supervisor) {
            if ($service) { $service.MarkDelete() }
            try { if ($supervisor) { $supervisor.MarkDelete() } } catch { if ($service) { $service.CancelDelete() }; throw }
            $result.removed = @(@('service.lock','supervisor.lock') | Where-Object { $opened[$_] })
            $result.recovered = $true
            $result.reason = if ($priorBoot) { 'prior_boot_locks_recovered' } else { 'same_boot_locks_recovered' }
        } else { $result.reason = if ($priorBoot) { 'prior_boot_state_only' } else { 'same_boot_state_only' } }
        $result.clearPreviousState = $true
    } catch {
        # Do not serialize exceptions: metadata files and command lines stay local.
        $reason = $_.Exception.Message
        $safeReasons = @('unsafe_directory','unsafe_file','untrusted_owner','missing_config','unowned_data','requires_manual_recovery','invalid_owner','invalid_pid','invalid_state','unknown_boot','same_boot_or_unknown','ownership_mismatch','endpoint_active_or_unknown','same_data_process_active','lock_set_changed','metadata_changed','invalid_endpoint','endpoint_unknown','unknown_process_command','invalid_process_command','recorded_process_active','recorded_process_unknown')
        $result.reason = if ($reason -in $safeReasons) { $reason } else { 'recovery_probe_failed' }
    } finally { foreach ($file in $opened.Values) { $file.Dispose() } }
    return $result
}

if ($MyInvocation.InvocationName -ne '.') {
    Invoke-DotsRebootRecovery $DataDir | ConvertTo-Json -Compress
}
