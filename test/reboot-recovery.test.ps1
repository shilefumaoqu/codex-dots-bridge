param([string]$NodePath=(Join-Path (Split-Path -Parent $PSScriptRoot) '.runtime/node-v24.21.0-win-x64/node.exe'))
$ErrorActionPreference = 'Stop'
if (-not [IO.File]::Exists($NodePath)) { throw 'Node24 test executable missing' }
$machineTemp=Join-Path $env:WINDIR 'Temp'
$env:TEMP=$machineTemp; $env:TMP=$machineTemp
. (Join-Path $PSScriptRoot '../scripts/recover-reboot-locks.ps1')
if ($PSVersionTable.PSVersion.Major -ne 5) { throw 'Windows PowerShell 5 required for CodeDom regression' }
$knownTemp=[IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData),'Temp')
if ($env:TEMP -cne $knownTemp -or $env:TMP -cne $knownTemp -or -not ('DotsRebootFile' -as [type])) { throw 'recovery did not normalize inherited machine TEMP before CodeDom' }
$script:checks = 0
$script:fakeProcesses = @()
$script:secondProcesses = $null
function Get-DotsProcesses { return $script:fakeProcesses }
function Get-DotsProcessInfos([int[]]$ProcessNumbers) {
    if ($null -ne $script:secondProcesses) { return @($script:secondProcesses | Where-Object { $ProcessNumbers -contains $_.ProcessId }) }
    return @($script:fakeProcesses | Where-Object { $ProcessNumbers -contains $_.ProcessId })
}
function Assert($Value,[string]$Message) { if (-not $Value) { throw "assertion: $Message" }; $script:checks++ }
$root = Join-Path ([IO.Path]::GetTempPath()) ('Dots reboot 中文 O''Brien '+[Guid]::NewGuid())
[IO.Directory]::CreateDirectory($root) | Out-Null
$boot = Get-DotsBootUtc
$old = $boot.AddMinutes(-5)
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
$listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop()
function Fixture([string]$Name, [int]$SchemaVersion=1) {
    $dir = Join-Path $root $Name
    [IO.Directory]::CreateDirectory($dir) | Out-Null
    $owner = [Guid]::NewGuid().ToString()
    $files = @{
        'config.json' = @{owner='codex-dots-bridge';schema_version=$SchemaVersion;instance_id=[Guid]::NewGuid().ToString();endpoint="http://127.0.0.1:$port/"}
        'supervisor-state.json' = @{owner=$owner;pid=2147483000;bridge_pid=2147483001;phase='running'}
        'supervisor.lock' = @{owner=$owner;pid=2147483000}
        'service.lock' = @{owner=[Guid]::NewGuid().ToString();pid=2147483001}
    }
    if ($SchemaVersion -eq 2) { $files['config.json'].storage = @{database_version=2;migration_id=[Guid]::NewGuid().ToString();phase='ready'} }
    foreach ($name in $files.Keys) {
        $file = Join-Path $dir $name
        [IO.File]::WriteAllText($file,($files[$name] | ConvertTo-Json -Compress))
        [IO.File]::SetCreationTimeUtc($file,$old)
        [IO.File]::SetLastWriteTimeUtc($file,$old)
    }
    # These must never be read, altered, or copied by recovery.
    [IO.File]::WriteAllText((Join-Path $dir 'tasks.sqlite'),'do not open task content')
    [IO.File]::WriteAllText((Join-Path $dir 'worker.key'),'do not open credential')
    return $dir
}
function SameBootFixture([string]$Name, [int]$SchemaVersion=1) {
    $dir = Fixture $Name $SchemaVersion
    $dated = [DateTime]::UtcNow.AddSeconds(-15)
    foreach ($name in @('supervisor-state.json','service.lock','supervisor.lock')) {
        [IO.File]::SetCreationTimeUtc((Join-Path $dir $name),$dated)
        [IO.File]::SetLastWriteTimeUtc((Join-Path $dir $name),$dated)
    }
    return $dir
}
try {
    foreach ($sameBoot in @($false,$true)) {
        $dir = if ($sameBoot) { SameBootFixture 'schema2-same-boot' 2 } else { Fixture 'schema2-prior-boot' 2 }
        $retained = @{}
        foreach ($name in @('config.json','supervisor-state.json','tasks.sqlite','worker.key')) { $retained[$name] = [IO.File]::ReadAllText((Join-Path $dir $name)) }
        $result = Invoke-DotsRebootRecovery $dir
        $expected = if ($sameBoot) { 'same_boot_locks_recovered' } else { 'prior_boot_locks_recovered' }
        Assert ($result.recovered -and $result.clearPreviousState -and $result.reason -eq $expected -and $result.removed.Count -eq 2) ('schema 2 recovers exact old locks: '+$result.reason)
        Assert (-not [IO.File]::Exists((Join-Path $dir 'service.lock')) -and -not [IO.File]::Exists((Join-Path $dir 'supervisor.lock'))) 'schema 2 removes both proven stale locks'
        foreach ($name in $retained.Keys) { Assert ([IO.File]::ReadAllText((Join-Path $dir $name)) -ceq $retained[$name]) ('schema 2 preserves '+$name) }
    }
    foreach ($invalid in @(
        @{name='unknown-schema';version=3;field='schema_version';value=3},
        @{name='owner-v1';version=1;field='owner';value='foreign-owner'},
        @{name='owner-v2';version=2;field='owner';value='foreign-owner'},
        @{name='uuid-v1';version=1;field='instance_id';value='not-a-guid'},
        @{name='uuid-v2';version=2;field='instance_id';value='not-a-guid'}
    )) {
        $dir = Fixture $invalid.name $invalid.version
        $configPath = Join-Path $dir 'config.json'
        $config = [IO.File]::ReadAllText($configPath) | ConvertFrom-Json
        $config.($invalid.field) = $invalid.value
        [IO.File]::WriteAllText($configPath,($config | ConvertTo-Json -Depth 4 -Compress))
        $retained = @{}
        foreach ($name in @('config.json','supervisor-state.json','service.lock','supervisor.lock','tasks.sqlite','worker.key')) { $retained[$name] = [IO.File]::ReadAllText((Join-Path $dir $name)) }
        $result = Invoke-DotsRebootRecovery $dir
        Assert (-not $result.recovered -and -not $result.clearPreviousState -and $result.reason -eq 'unowned_data' -and $result.removed.Count -eq 0) ('invalid config is still refused: '+$invalid.name)
        foreach ($name in $retained.Keys) { Assert ([IO.File]::Exists((Join-Path $dir $name)) -and [IO.File]::ReadAllText((Join-Path $dir $name)) -ceq $retained[$name]) ('invalid config preserves '+$name) }
    }
    $dir = Fixture 'complete'
    $state = [IO.File]::ReadAllText((Join-Path $dir 'supervisor-state.json'))
    $result = Invoke-DotsRebootRecovery $dir
    Assert $result.recovered ('both proven old locks recover: '+$result.reason)
    Assert $result.clearPreviousState 'ignore old state PID'
    Assert ($result.removed.Count -eq 2) 'two locks reported'
    Assert (-not [IO.File]::Exists((Join-Path $dir 'service.lock'))) 'service removed'
    Assert (-not [IO.File]::Exists((Join-Path $dir 'supervisor.lock'))) 'supervisor removed'
    Assert ([IO.File]::ReadAllText((Join-Path $dir 'supervisor-state.json')) -ceq $state) 'state retained byte-for-byte'
    Assert ([IO.File]::ReadAllText((Join-Path $dir 'tasks.sqlite')) -ceq 'do not open task content') 'database unchanged'
    Assert ([IO.File]::ReadAllText((Join-Path $dir 'worker.key')) -ceq 'do not open credential') 'key unchanged'
    Assert ((Get-ChildItem -LiteralPath $dir).Count -eq 4) 'no archive or other data entries'
    $repeat = Invoke-DotsRebootRecovery $dir
    Assert (-not $repeat.recovered -and $repeat.clearPreviousState -and $repeat.reason -eq 'prior_boot_state_only') 'second caller sees retained old state'

    foreach ($missing in @('service.lock','supervisor.lock')) {
        $dir = Fixture ('missing-'+$missing)
        [IO.File]::Delete((Join-Path $dir $missing))
        $result = Invoke-DotsRebootRecovery $dir
        Assert (-not $result.recovered -and -not $result.clearPreviousState -and $result.reason -eq 'requires_manual_recovery') 'single residual lock retained'
        Assert ((Get-ChildItem -LiteralPath $dir -Filter '*.lock').Count -eq 1) 'remaining lock preserved'
    }
    $dir = Fixture 'same-boot'
    [IO.File]::SetLastWriteTimeUtc((Join-Path $dir 'service.lock'),[DateTime]::UtcNow)
    $result = Invoke-DotsRebootRecovery $dir
    Assert ($result.reason -eq 'same_boot_or_unknown' -and -not $result.recovered) 'same boot lock retained'
    Assert ([IO.File]::Exists((Join-Path $dir 'supervisor.lock'))) 'same boot preserves both'

    $dir = SameBootFixture 'same-boot-dead'
    $retained = [IO.File]::ReadAllText((Join-Path $dir 'supervisor-state.json'))
    $result = Invoke-DotsRebootRecovery $dir
    Assert ($result.recovered -and $result.clearPreviousState -and $result.reason -eq 'same_boot_locks_recovered') 'same-boot proven exited records recover'
    Assert ([IO.File]::ReadAllText((Join-Path $dir 'supervisor-state.json')) -ceq $retained) 'same-boot state retained'
    Assert ((Invoke-DotsRebootRecovery $dir).reason -eq 'same_boot_state_only') 'same-boot retained state supports repeat caller'
    foreach ($missing in @('service.lock','supervisor.lock')) {
        $dir = SameBootFixture ('same-boot-missing-'+$missing)
        [IO.File]::Delete((Join-Path $dir $missing))
        $result = Invoke-DotsRebootRecovery $dir
        Assert ($result.recovered -and $result.clearPreviousState -and $result.removed.Count -eq 1) 'same-boot singly owned lock recovers only with all recorded processes gone'
        Assert ((Get-ChildItem -LiteralPath $dir -Filter '*.lock').Count -eq 0) 'single old exact lock removed'
    }
    foreach ($field in @('pid','bridge_pid','guardian_pid','tunnel_pid')) {
        $dir = SameBootFixture ('same-boot-record-'+$field)
        $path = Join-Path $dir 'supervisor-state.json'
        $dated = [IO.File]::GetLastWriteTimeUtc($path)
        $record = [IO.File]::ReadAllText($path) | ConvertFrom-Json
        if ($field -in @('guardian_pid','tunnel_pid')) { $record | Add-Member NoteProperty $field 2147483002 }
        [IO.File]::WriteAllText($path,($record | ConvertTo-Json -Compress))
        [IO.File]::SetCreationTimeUtc($path,$dated);[IO.File]::SetLastWriteTimeUtc($path,$dated)
        $script:fakeProcesses = @([PSCustomObject]@{ProcessId=$record.$field;Name='unrelated.exe';CommandLine='C:\unrelated.exe';CreationDate=$dated.AddSeconds(-5)})
        Assert ((Invoke-DotsRebootRecovery $dir).reason -eq 'recorded_process_active') ('existing '+$field+' not identified by numeric PID alone')
        Assert ([IO.File]::Exists((Join-Path $dir 'service.lock'))) 'active recorded process preserves locks'
        $script:fakeProcesses[0].CreationDate = $null
        Assert ((Invoke-DotsRebootRecovery $dir).reason -eq 'recorded_process_unknown') 'unknown CIM creation fails closed'
        $script:fakeProcesses[0].CreationDate = [DateTime]::UtcNow
        Assert ((Invoke-DotsRebootRecovery $dir).recovered) ('proven reused '+$field+' is not killed or adopted')
    }
    $script:fakeProcesses = @()
    $dir = SameBootFixture 'same-boot-live-owner'
    $script:fakeProcesses = @([PSCustomObject]@{ProcessId=123456;Name='node.exe';CommandLine='"C:\node.exe" "C:\bridge\dist\main.js" run --supervisor --data-dir "'+$dir+'"';CreationDate=[DateTime]::UtcNow})
    Assert ((Invoke-DotsRebootRecovery $dir).reason -eq 'same_data_process_active') 'live same-dir supervisor blocks even with different PID'
    $script:fakeProcesses = @()
    $dir = SameBootFixture 'same-boot-owner-mismatch'
    $path = Join-Path $dir 'supervisor.lock'
    [IO.File]::WriteAllText($path,(@{owner=[Guid]::NewGuid().ToString();pid=2147483000} | ConvertTo-Json -Compress))
    $dated = [IO.File]::GetLastWriteTimeUtc((Join-Path $dir 'supervisor-state.json'))
    [IO.File]::SetCreationTimeUtc($path,$dated);[IO.File]::SetLastWriteTimeUtc($path,$dated)
    Assert ((Invoke-DotsRebootRecovery $dir).reason -eq 'ownership_mismatch') 'same-boot still requires exact owner association'
    $dir = SameBootFixture 'same-boot-record-invalid'
    $path = Join-Path $dir 'supervisor-state.json'
    $text = [IO.File]::ReadAllText($path)
    [IO.File]::WriteAllText($path,$text.Replace('"phase":','"tunnel_pid":1.5,"phase":'))
    Assert ((Invoke-DotsRebootRecovery $dir).reason -eq 'invalid_pid') 'invalid child pid fails closed'

    $dir = Fixture 'mismatch'
    $file = Join-Path $dir 'supervisor.lock'
    [IO.File]::WriteAllText($file,(@{owner=[Guid]::NewGuid().ToString();pid=2147483000} | ConvertTo-Json -Compress))
    [IO.File]::SetCreationTimeUtc($file,$old);[IO.File]::SetLastWriteTimeUtc($file,$old)
    Assert ((Invoke-DotsRebootRecovery $dir).reason -eq 'ownership_mismatch') 'owner association required'
    Assert ([IO.File]::Exists((Join-Path $dir 'service.lock'))) 'mismatch preserves service'

    $dir = Fixture 'reused-pid'
    $script:fakeProcesses = @([PSCustomObject]@{ProcessId=2147483000;Name='unrelated.exe';CommandLine='"C:\unrelated.exe"'})
    Assert ((Invoke-DotsRebootRecovery $dir).recovered) 'unrelated reused PID does not block prior boot proof'

    $dir = Fixture 'active-process'
    $script:fakeProcesses = @([PSCustomObject]@{ProcessId=2147483000;Name='node.exe';CommandLine='"C:\node.exe" "C:\bridge\dist\main.js" run --foreground --data-dir "'+$dir+'"'})
    Assert ((Invoke-DotsRebootRecovery $dir).reason -eq 'same_data_process_active') 'same data foreground blocks'
    Assert ([IO.File]::Exists((Join-Path $dir 'service.lock'))) 'active process locks retained'
    $script:fakeProcesses = @([PSCustomObject]@{ProcessId=2147483000;Name='node.exe';CommandLine=$null})
    Assert ((Invoke-DotsRebootRecovery $dir).reason -eq 'unknown_process_command') 'unknown node process fails closed'
    Assert ([IO.File]::Exists((Join-Path $dir 'service.lock'))) 'live unknown retains locks'
    $dir = Fixture 'exited-blank-node'
    $script:secondProcesses = @()
    Assert ((Invoke-DotsRebootRecovery $dir).recovered) 'confirmed exited blank node does not block recovery'
    $dir = Fixture 'pid-reused-current-entry'
    $script:secondProcesses = @([PSCustomObject]@{ProcessId=2147483000;Name='node.exe';CreationDate=[DateTime]::UtcNow;CommandLine='"C:\node.exe" "C:\bridge\dist\main.js" run --foreground --data-dir "'+$dir+'"'})
    Assert ((Invoke-DotsRebootRecovery $dir).reason -eq 'same_data_process_active') 'new full current entry assessed after PID reuse'
    Assert ([IO.File]::Exists((Join-Path $dir 'service.lock'))) 'reused live same-data owner retains locks'
    $script:secondProcesses = $null
    $script:fakeProcesses = @()

    foreach ($entry in @('stdio','run --start','run')) {
        $dir = Fixture ('caller-'+($entry.Replace(' ','-')))
        $script:fakeProcesses = @([PSCustomObject]@{ProcessId=2147483000;Name='node.exe';CommandLine='"C:\node.exe" "C:\bridge\dist\main.js" '+$entry+' --data-dir "'+$dir+'"'})
        Assert ((Invoke-DotsRebootRecovery $dir).recovered) 'same data lightweight caller does not block'
    }
    $script:fakeProcesses = @()

    $dir = Fixture 'endpoint-active'
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$port)
    $listener.Start()
    try { Assert ((Invoke-DotsRebootRecovery $dir).reason -eq 'endpoint_active_or_unknown') 'listener blocks recovery' }
    finally { $listener.Stop() }
    Assert ([IO.File]::Exists((Join-Path $dir 'supervisor.lock'))) 'endpoint preserves locks'

    $dir = Fixture 'held-lock'
    $held = [IO.File]::Open((Join-Path $dir 'service.lock'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try { Assert (-not (Invoke-DotsRebootRecovery $dir).recovered) 'another exclusive handle blocks recovery' }
    finally { $held.Dispose() }
    Assert ([IO.File]::Exists((Join-Path $dir 'supervisor.lock'))) 'held lock preserves both'

    $dir = Fixture 'exact-handle'
    $file = Join-Path $dir 'service.lock'
    $held = [DotsRebootFile]::new($file,$true)
    try {
        $nodeReader = Join-Path $root 'read-file.cjs'
        [IO.File]::WriteAllText($nodeReader,'const fs=require("fs");process.stdout.write(fs.readFileSync(process.argv[2],"utf8"));')
        $readResult = & $NodePath $nodeReader $file
        Assert ($LASTEXITCODE -eq 0 -and ($readResult | ConvertFrom-Json).pid -eq 2147483001) 'Node can read held lock'
        $renameBlocked = $false
        try { [IO.File]::Move($file,($file+'.replacement')) } catch { $renameBlocked = $true }
        Assert $renameBlocked 'exclusive handle rejects pathname replacement'
        $writeBlocked = $false
        try { [IO.File]::WriteAllText($file,'new owner') } catch { $writeBlocked = $true }
        Assert $writeBlocked 'exclusive handle rejects rewriting owner'
        $held.MarkDelete()
    } finally { $held.Dispose() }
    Assert (-not [IO.File]::Exists($file)) 'handle deletion removes exact file'
    Assert ([IO.File]::Exists((Join-Path $dir 'supervisor.lock'))) 'handle deletion does not affect other file'

    $nodeRenamer = Join-Path $root 'replace-file.cjs'
    [IO.File]::WriteAllText($nodeRenamer,'const fs=require("fs");const p=process.argv[2];fs.writeFileSync(p+".fixture.tmp",fs.readFileSync(p));fs.renameSync(p+".fixture.tmp",p);')
    foreach ($name in @('config.json','supervisor-state.json')) {
        $dir = Fixture ('metadata-'+$name)
        $file = Join-Path $dir $name
        $held = [DotsRebootFile]::new($file,$false)
        try {
            $snapshot = $held.Read()
            $held.Dispose()
            Assert ($held.MatchesPath($file)) 'released metadata snapshot initially matches path'
            $readResult = & $NodePath $nodeReader $file
            Assert ($LASTEXITCODE -eq 0 -and $readResult) 'Node can read snapshotted metadata'
            & $NodePath $nodeRenamer $file
            Assert ($LASTEXITCODE -eq 0) 'Node atomic metadata replacement is allowed'
            Assert (-not $held.MatchesPath($file)) 'replacement identity detected'
        }finally { $held.Dispose() }
    }
    $dir = Fixture 'metadata-inplace'
    $file = Join-Path $dir 'supervisor-state.json'
    $held = [DotsRebootFile]::new($file,$false)
    try {
        $before = $held.Read()
        $held.Dispose()
        [IO.File]::WriteAllText($file,$before.Replace('running','stopped'))
        [IO.File]::SetLastWriteTimeUtc($file,$old)
        Assert (-not $held.MatchesPath($file)) 'same identity, size and timestamp still detect changed contents'
    }finally { $held.Dispose() }
    $originalEndpointProbe = (Get-Item Function:\Test-DotsEndpointRefused).ScriptBlock
    foreach ($name in @('config.json','supervisor-state.json')) {
        $dir = Fixture ('replace-during-probe-'+$name)
        $script:replaceTarget = Join-Path $dir $name
        $script:replaceCount = 0
        function Test-DotsEndpointRefused([string]$Endpoint) {
            if ($script:replaceCount++ -eq 0) {
                & $NodePath $nodeRenamer $script:replaceTarget
                if ($LASTEXITCODE -ne 0) { throw 'fixture_replace_failed' }
            }
            return $true
        }
        try {
            $result = Invoke-DotsRebootRecovery $dir
            Assert (-not $result.recovered -and $result.reason -eq 'metadata_changed') 'concurrent metadata replacement aborts recovery'
            Assert ([IO.File]::Exists((Join-Path $dir 'service.lock')) -and [IO.File]::Exists((Join-Path $dir 'supervisor.lock'))) 'metadata race keeps both locks'
        }finally { Set-Item Function:\Test-DotsEndpointRefused $originalEndpointProbe }
    }

    $dir = Fixture 'hardlink'
    $file = Join-Path $dir 'service.lock'
    New-Item -ItemType HardLink -Path (Join-Path $root 'linked-lock') -Target $file | Out-Null
    Assert (-not (Invoke-DotsRebootRecovery $dir).recovered) 'hardlinked lock rejected'
    Assert ([IO.File]::Exists($file)) 'hardlinked lock retained'
    Write-Output "$script:checks reboot recovery checks passed (Windows PowerShell, real file sharing, atomic replacement and TCP)"
} finally {
    # One native shell, exact resolved fixture root under the system temporary directory.
    $resolved = [IO.Path]::GetFullPath($root)
    if (-not $resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase)) { throw 'unsafe_cleanup' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
