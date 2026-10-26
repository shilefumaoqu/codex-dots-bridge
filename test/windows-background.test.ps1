$ErrorActionPreference='Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\launch-background.ps1')
$machineTemp=Join-Path $env:WINDIR 'Temp'
$env:TEMP=$machineTemp;$env:TMP=$machineTemp
$knownTemp=[IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData),'Temp')
$normalized=Get-DotsBackgroundEnvironment ([pscustomobject]@{TEMP=$machineTemp;TMP=$machineTemp})
if($PSVersionTable.PSVersion.Major -ne 5 -or $env:TEMP -cne $knownTemp -or $env:TMP -cne $knownTemp -or $normalized -cnotcontains ('TEMP='+$knownTemp) -or $normalized -cnotcontains ('TMP='+$knownTemp)){throw 'broker did not normalize inherited/request machine TEMP'}
$work=Join-Path ([IO.Path]::GetTempPath()) ('dots-launch-unit-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force|Out-Null
$checks=0
function Assert($Condition,[string]$Message){if(-not $Condition){throw $Message};$script:checks++}
try {
  $node=Join-Path $work 'node.exe';$entry=Join-Path $work 'main.js';$tray=Join-Path $work 'CodexDotsBridge.Tray.exe'
  foreach($path in @($node,$entry,$tray)){[IO.File]::WriteAllText($path,'not executable')}
  $request=[pscustomobject]@{kind='supervisor';nodePath=$node;entryPath=$entry;dataDir=$work;environment=[pscustomobject]@{SystemRoot=$env:SystemRoot;PATH=$env:PATH;TEMP=$machineTemp;TMP=$machineTemp}}
  $script:createCalls=0;$script:deny=$false;$script:unavailable=$false;$script:unknown=$false;$script:ownerFailure=$false
  function New-CimInstance {param($ClassName,$Property,[switch]$ClientOnly,$ErrorAction)if($script:unavailable){throw 'probe unavailable'};$script:startup=$Property;return [pscustomobject]$Property}
  function Get-DotsCreatedProcess {param($ProcessNumber)if($script:processMissing){return $null};return [pscustomobject]@{SessionId=([Diagnostics.Process]::GetCurrentProcess().SessionId+$(if($script:sessionMismatch){1}else{0}))}}
  function Get-DotsCreatedOwner {param($ProcessInfo)if($script:ownerFailure){throw [InvalidOperationException]::new('synthetic sensitive error text')};return @{ReturnValue=0;Sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value}}
  function Invoke-DotsProcessCreate {param($Command,$Directory,$Startup)
    $script:createCalls++;$script:createArguments=@{CommandLine=$Command;CurrentDirectory=$Directory;ProcessStartupInformation=$Startup}
    if($script:unknown){throw 'broker reply lost'}
    return @{ReturnValue=$(if($script:deny){2}else{0});ProcessId=123}
  }
  $r=Start-DotsBackgroundProcess $request
  Assert ($r.pid -eq 123) 'Receipt did not report PID.'
  Assert ($script:dotsLaunchObservation.actual_session_id -eq $r.sessionId -and $script:dotsLaunchObservation.expected_session_id -eq $r.sessionId -and $script:dotsLaunchObservation.created_process_observed -eq $true -and $script:dotsLaunchObservation.owner_sid_matches -eq $true) 'Successful receipt must distinguish observed session and matching owner.'
  Assert ($script:startup.CreateFlags -eq 0x08000400 -and $script:startup.ShowWindow -eq 0) 'Incorrect Unicode/background flags.'
  Assert ($script:startup.EnvironmentVariables -cnotcontains 'CONTROL_PLANE_API_KEY=secret') 'Environment key leak.'
  Assert ($script:startup.EnvironmentVariables -ccontains ('TEMP='+$knownTemp) -and $script:startup.EnvironmentVariables -ccontains ('TMP='+$knownTemp)) 'Broker propagated stale request TEMP to supervisor/guardian.'
  Assert ($script:createArguments.CommandLine -ceq ((@($node,$entry,'run','--supervisor','--data-dir',$work)|ForEach-Object{Quote-DotsWindowsArgument $_}) -join ' ')) 'Supervisor argv changed.'
  $trayRequest=[pscustomobject]@{kind='tray';executable=$tray;mode='--show';dataDir=$work;environment=$null}
  Start-DotsBackgroundProcess $trayRequest|Out-Null
  Assert ($script:createArguments.CommandLine -ceq ((@($tray,'--show','--data-dir',$work)|ForEach-Object{Quote-DotsWindowsArgument $_}) -join ' ')) 'Tray argv changed.'
  foreach($case in @('deny','unavailable','unknown')) {
    $script:deny=$case -eq 'deny';$script:unavailable=$case -eq 'unavailable';$script:unknown=$case -eq 'unknown';$before=$script:createCalls
    $expected=switch($case){'deny'{'background_launch_rejected'}'unavailable'{'background_broker_unavailable'}'unknown'{'background_launch_unknown'}}
    try{Start-DotsBackgroundProcess $request|Out-Null;throw 'Unexpected successful launch'}catch{Assert ($_.Exception.Message -ceq $expected) ('Wrong error '+$_.Exception.Message)}
    Assert (($script:createCalls-$before) -eq $(if($case -eq 'unavailable'){0}else{1})) 'Broker retried a refused/unknown create.'
    $phase=if($case -eq 'unavailable'){'startup'}else{'create'}
    Assert ($script:dotsLaunchObservation.stage -ceq $phase -and $script:dotsLaunchObservation.exception_type -and $null -ne $script:dotsLaunchObservation.hresult) 'Broker lost the original failing phase or exception identity.'
  }
  $script:deny=$false;$script:unavailable=$false;$script:unknown=$false;$script:ownerFailure=$true;$before=$script:createCalls
  try{Start-DotsBackgroundProcess $trayRequest|Out-Null;throw 'Unexpected owner success'}catch{Assert ($_.Exception.Message -ceq 'background_launch_unknown') 'Owner exception must keep the send outcome unknown.'}
  Assert ($script:createCalls-$before -eq 1) 'Owner exception retried process creation.'
  $observation=$script:dotsLaunchObservation
  Assert ($observation.stage -ceq 'get_owner_sid' -and $observation.pid -eq 123 -and $observation.create_return_code -eq 0 -and $observation.exception_type -ceq 'System.InvalidOperationException') 'Owner exception lost its phase, created PID or original type.'
  Assert (($observation|ConvertTo-Json -Compress) -notmatch 'synthetic sensitive|CommandLine|environment|"Sid"|executable') 'Launch diagnostic retained sensitive values.'
  $script:ownerFailure=$false
  foreach($missing in @($false,$true)) {
    $script:processMissing=$missing;$script:sessionMismatch=-not $missing;$before=$script:createCalls
    try{Start-DotsBackgroundProcess $request|Out-Null;throw 'Unexpected session success'}catch{Assert ($_.Exception.Message -ceq 'background_launch_unknown') 'Unconfirmed session must remain unknown.'}
    Assert ($script:createCalls-$before -eq 1) 'Session refusal retried process creation.'
    Assert ($script:dotsLaunchObservation.stage -ceq 'verify_session' -and $script:dotsLaunchObservation.created_process_observed -eq (-not $missing)) 'Missing process and mismatching session became indistinguishable.'
    Assert (($null -eq $script:dotsLaunchObservation.actual_session_id) -eq $missing) 'Expected session was reported as actual session.'
    Assert ($null -eq $script:dotsLaunchObservation.owner_sid_matches) 'Unobserved owner must not be reported as matching.'
  }
  $script:processMissing=$false;$script:sessionMismatch=$false
  $request.environment=[pscustomobject]@{CONTROL_PLANE_API_KEY='synthetic'}
  try{Start-DotsBackgroundProcess $request|Out-Null;throw 'Accepted credential environment'}catch{Assert ($_.Exception.Message -ceq 'background_launch_invalid_request') 'Did not reject extra env variable.'}
  Assert ((Quote-DotsWindowsArgument 'x\') -ceq '"x\\"') 'Trailing slash quote broken.'
  Assert ((Quote-DotsWindowsArgument 'a"b') -ceq '"a\"b"') 'Embedded quote broken.'
  foreach($record in @(@{name='supervisor-state.json';value=@{phase='running';owner='new-owner';pid=123;bridge_pid=124}},@{name='supervisor.lock';value=@{owner='new-owner';pid=123}},@{name='service.lock';value=@{owner='service-owner';pid=124}})){
    [IO.File]::WriteAllText((Join-Path $work $record.name),($record.value|ConvertTo-Json -Compress))
  }
  $env:TEMP=$machineTemp;$env:TMP=$machineTemp
  Assert (-not (Test-DotsBackgroundReady $node $entry $work 123 'old-owner')) 'Synthetic non-process became ready.'
  Assert (($null -ne ('DotsBackgroundArguments' -as [type])) -and $env:TEMP -ceq $knownTemp -and $env:TMP -ceq $knownTemp) 'CheckReady CodeDom did not compile after normalizing machine TEMP.'
  # Extract the real lifecycle entry into an isolated runner; the old payload
  # deliberately lacks its own helper, as alpha.20 rollback does.
  $project=Split-Path -Parent $PSScriptRoot
  $tokens=$null;$errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $project 'scripts\setup-lifecycle.ps1'),[ref]$tokens,[ref]$errors)
  $startTray=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Start-Tray'},$true).Extent.Text
  $old=Join-Path $work 'alpha20-payload';New-Item -ItemType Directory -Path $old|Out-Null
  $runnerPrefix=@'
param([string]$Root,[switch]$Show)
$ErrorActionPreference='Stop'
function Tray-Path([string]$Root){Join-Path $Root 'CodexDotsBridge.Tray.exe'}
function Tray-Running([string]$Root,[string]$Directory){Test-Path -LiteralPath (Join-Path $PSScriptRoot 'seen.json')}
function Invoke-TrayCommand([string]$Executable,[string[]]$Arguments){[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'shown.json'),($Arguments|ConvertTo-Json));return 0}
'@
  $runner=Join-Path $work 'lifecycle-runner.ps1'
  [IO.File]::WriteAllText($runner,($runnerPrefix+"`n"+$startTray+"`ntry {Start-Tray -Root `$Root -Directory `$Root -Show:`$Show} finally {`$script:trayStartObservation|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path `$PSScriptRoot 'observation.json')}"),[Text.UTF8Encoding]::new($false))
  $stub=@'
param([string]$TrayExecutable,[string]$DataDir,[string]$TrayMode)
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'seen.json'),(@{exe=$TrayExecutable;data=$DataDir;mode=$TrayMode}|ConvertTo-Json))
@{pid=123;sessionId=1}|ConvertTo-Json -Compress
exit 0
'@
  [IO.File]::WriteAllText((Join-Path $work 'launch-background.ps1'),$stub,[Text.UTF8Encoding]::new($false))
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $runner -Root $old
  Assert ($LASTEXITCODE -eq 0) 'Alpha20 rollback tray did not use runner helper.'
  $seen=Get-Content -LiteralPath (Join-Path $work 'seen.json') -Raw|ConvertFrom-Json
  Assert ($seen.exe -ceq (Join-Path $old 'CodexDotsBridge.Tray.exe') -and $seen.data -ceq $old -and $seen.mode -ceq '--background') 'Rollback tray binding changed.'
  Assert (-not (Test-Path -LiteralPath (Join-Path $old 'scripts\launch-background.ps1'))) 'Fixture unexpectedly owns payload helper.'
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $runner -Root $old -Show
  Assert ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath (Join-Path $work 'shown.json'))) 'Already-running tray show must use its short-lived control command.'
  Remove-Item -LiteralPath (Join-Path $work 'seen.json')
  $failureStub=@'
param([string]$TrayExecutable,[string]$DataDir,[string]$TrayMode)
@{error='background_launch_unknown';diagnostic=@{stage='get_owner_sid';pid=123;create_return_code=0;exception_type='System.InvalidOperationException';hresult=-2146233079}}|ConvertTo-Json -Depth 4 -Compress
exit 1
'@
  [IO.File]::WriteAllText((Join-Path $work 'launch-background.ps1'),$failureStub,[Text.UTF8Encoding]::new($false))
  $ErrorActionPreference='Continue'
  try {$failed=@(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $runner -Root $old 2>&1)}finally{$ErrorActionPreference='Stop'}
  Assert ($LASTEXITCODE -ne 0 -and ($failed -join ' ') -match 'tray_background_launch_unconfirmed') 'Failed helper was accepted as a running tray.'
  $observation=Get-Content -LiteralPath (Join-Path $work 'observation.json') -Raw|ConvertFrom-Json
  Assert ($observation.stage -ceq 'launch_helper' -and $observation.helper.stage -ceq 'get_owner_sid' -and $observation.helper.pid -eq 123) 'Installer lost the structured helper failure receipt.'
  Assert (-not (Test-Path -LiteralPath (Join-Path $work 'seen.json'))) 'Failed helper triggered a replacement launch.'
  $iss=Get-Content -LiteralPath (Join-Path $project 'scripts\windows-setup.iss') -Raw
  Assert ($iss.Contains('Source: "{#PackageRoot}\scripts\launch-background.ps1"; DestDir: "{app}"') -and $iss.Contains("ExtractTemporaryFile('launch-background.ps1')")) 'Setup did not install and extract authenticated helper.'
  @{checks=$checks;result='passed'}|ConvertTo-Json -Compress
}finally{if([IO.Path]::GetFullPath($work).StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase)){Remove-Item -LiteralPath $work -Recurse -Force}}
