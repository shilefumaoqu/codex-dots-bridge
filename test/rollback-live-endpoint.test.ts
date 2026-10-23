import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { initProduction, readProductionConfig, writeProductionConfig } from '../src/runtime.js';
import { startSupervisor, stopSupervisor } from '../src/supervisor.js';
import { TaskStore } from '../src/task-store.js';

test('real restarted endpoint survives repeated failed rollback and explicit recovery without restarting its owner',{skip:process.platform!=='win32',timeout:120000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'dots live endpoint ')),dir=join(root,'data'),app=join(root,'app'),source=resolve('.'),runtime={nodePath:process.execPath,entryPath:resolve('dist/main.js')};let running=false;
  try{
    const config=initProduction(dir);writeProductionConfig(dir,{...config,installation:{root:source,node_path:process.execPath}});
    const store=new TaskStore(join(dir,'tasks.sqlite'));let taskId:string;try{taskId=store.submit({idempotency_key:randomUUID(),title:'isolated recovery identity',input:{text:'preserve queued record'},safe_to_retry:false}).task_id;}finally{store.close();}
    await startSupervisor(dir,runtime);running=true;const originalText=readFileSync(join(dir,'config.json'),'utf8'),originalEndpoint=readProductionConfig(dir).endpoint;
    await stopSupervisor(dir);running=false;await startSupervisor(dir,runtime);running=true;
    const currentText=readFileSync(join(dir,'config.json'),'utf8'),current=readProductionConfig(dir);assert.notEqual(current.endpoint,originalEndpoint,'real foreground restart selected a new dynamic endpoint');
    const before=JSON.parse(readFileSync(join(dir,'supervisor-state.json'),'utf8'));
    mkdirSync(app);const state={owner:'codex-dots-bridge-setup',schema:1,install_directory:app,installer_app_id:'CodexDotsBridgeSetup',version:'0.2.0-alpha.22',payload_root:source,data_dir:dir,codex_home:join(root,'home'),codex_command:process.execPath,app_data:join(root,'appdata')};
    writeFileSync(join(app,'installation-state.json'),JSON.stringify(state));
    const transaction={schema:1,owner:'codex-dots-bridge-setup',install_directory:app,installer_app_id:state.installer_app_id,version:'0.2.0-alpha.24',new_root:join(app,'payload','0.2.0-alpha.24'),old_root:source,old_runtime_root:source,data_dir:dir,codex_home:state.codex_home,codex_command:process.execPath,old_codex_command:process.execPath,app_data:state.app_data,old_config:JSON.parse(originalText),old_config_text:originalText,was_running:true,was_tray_running:false,registration_changed:true,stable_startup:true,core_restored:false,startup_created:false,startup_creation_intent:false,legacy_removed:false,rollback_errors:[],shortcut_path:''};
    writeFileSync(join(app,'.setup-transaction.json'),JSON.stringify(transaction));writeFileSync(join(dir,'installation.json'),JSON.stringify({owner:'codex-dots-bridge',autostart:{path:join(root,'missing-old.vbs'),content:'synthetic'}}));
    for(const name of ['launch-background.ps1','recover-reboot-locks.ps1'])copyFileSync(resolve('scripts',name),join(root,name));
    const probe=String.raw`
$ErrorActionPreference='Stop';Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -Global -Force
$r=[Environment]::GetEnvironmentVariable('DOTS_TEST_REQUEST') | ConvertFrom-Json
$errors=$null;$tokens=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($r.lifecycle,[ref]$tokens,[ref]$errors)
# ScriptBlock.Create has no file origin. Bind only the helper location to its
# isolated Temp copy; otherwise its automatic PSScriptRoot would be empty.
$helperRoot="'"+$PSScriptRoot.Replace("'","''")+"'"
foreach($definition in $ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)){. ([ScriptBlock]::Create($definition.Extent.Text.Replace('$PSScriptRoot',$helperRoot)))}
$script:actualInstallerHelper=(Get-Command Invoke-InstallerHelper -CommandType Function).ScriptBlock
function Invoke-InstallerHelper([string]$Kind,[string]$Directory,[string]$Root='',[int]$TimeoutMs=20000,[int]$ExpectedPid=0,[string]$PreviousOwner=''){
  $clock=[Diagnostics.Stopwatch]::StartNew();[Console]::Error.WriteLine('fixture_helper_started:'+ $Kind)
  try{& $script:actualInstallerHelper @PSBoundParameters}
  finally{[Console]::Error.WriteLine('fixture_helper_finished:'+ $Kind+':'+$clock.ElapsedMilliseconds)}
}
$main=@($ast.EndBlock.Statements | Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]})[-1]
$nl=[Environment]::NewLine
$body=(@($main.Body.Statements | Where-Object {$_ -isnot [Management.Automation.Language.ExitStatementAst]} | ForEach-Object {$_.Extent.Text}) -join $nl)
$catchBody=(@($main.CatchClauses[0].Body.Statements | Where-Object {$_ -isnot [Management.Automation.Language.ExitStatementAst]} | ForEach-Object {$_.Extent.Text}) -join $nl)
$lifecycle=[ScriptBlock]::Create(('try {'+$nl+$body+$nl+'} catch {'+$nl+$catchBody+$nl+'}'))
$InstallDirectory=$r.app;$statePath=Join-Path $r.app 'installation-state.json';$transactionPath=Join-Path $r.app '.setup-transaction.json';$resultPath=Join-Path $r.app '.setup-result.txt'
# Only checkout layout and registration availability are adapters. PID/command binding,
# live HTTP caller authentication, dynamic config and all runtime processes stay real.
function Resolve-OldRuntimeRoot{return $r.source}
function Runtime-Node{return $r.node}
function Assert-State($State){if($State.owner -cne 'codex-dots-bridge-setup' -or $State.payload_root -cne $r.source){throw 'invalid_test_state'}}
function Rollback-CodexCommand{return $r.node}
$script:registrationComplete=$false;$script:setupCalls=0;$script:stopCalls=0
function Assert-OwnedRegistration{return [pscustomobject]@{mcp_present=$script:registrationComplete;skill_complete=$script:registrationComplete}}
function Setup-Registration{$script:setupCalls++;throw 'unexpected_registration_write_on_live_original'}
function Stop-Tray{$script:stopCalls++;throw 'unexpected_stop_on_live_original'}
function Start-InstallerSupervisor{throw 'unexpected_duplicate_original_start'}
[Console]::Error.WriteLine('fixture_initial_snapshot_started')
$initial=Read-Json $transactionPath;$snapshot=Read-OriginalRuntimeSnapshot $initial $r.source
[Console]::Error.WriteLine('fixture_initial_snapshot_finished')
if(-not $snapshot.ready){
  $helper=Invoke-InstallerHelper -Kind Ready -Directory $initial.data_dir -Root $r.source
  $auth=Test-OriginalEndpointAuthentication $initial.data_dir ((Read-Json (Join-Path $initial.data_dir 'config.json')).endpoint)
  throw ('initial_snapshot_probe:'+(@{persistent_match=$snapshot.persistent_match;locks=$snapshot.locks;ready=$helper.ready;auth=$auth}|ConvertTo-Json -Compress))
}
for($attempt=0;$attempt -lt 2;$attempt++){
  [Console]::Error.WriteLine('fixture_rollback_started:'+ $attempt)
  $transaction=Read-Json $transactionPath
  try{Rollback-Transaction $transaction;throw 'incomplete registration accepted'}catch{if($_.Exception.Message -cne 'rollback_registration_requires_stopped_runtime'){throw}}
  [Console]::Error.WriteLine('fixture_rollback_finished:'+ $attempt)
}
$script:registrationComplete=$true;$Action='RecoverRollback';$DeferAutostart=$true;$InstallerIdentity='CodexDotsBridgeSetup';$validatedDirectory=$false;$ownsTransaction=$false;$code=''
[Console]::Error.WriteLine('fixture_recovery_started')
. $lifecycle | Out-Null
[Console]::Error.WriteLine('fixture_recovery_finished')
if($code){throw $code}
$state=Read-Json $statePath
@{setup_calls=$script:setupCalls;stop_calls=$script:stopCalls;pending=(Test-Path -LiteralPath $transactionPath);record=$state.recovery_record;record_sha256=$state.recovery_sha256}|ConvertTo-Json -Compress
`;
    const script=join(root,'test.ps1');writeFileSync(script,probe);
    const result=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{encoding:'utf8',windowsHide:true,stdio:'pipe',timeout:65000,env:{...process.env,DOTS_TEST_REQUEST:JSON.stringify({lifecycle:resolve('scripts/setup-lifecycle.ps1'),app,source,node:process.execPath})}}));
    assert.equal(result.setup_calls,0);assert.equal(result.stop_calls,0);assert.equal(result.pending,false);assert.equal(existsSync(result.record),true);
    assert.equal(readFileSync(join(dir,'config.json'),'utf8'),currentText,'authenticated live endpoint is never overwritten by the old snapshot');
    const after=JSON.parse(readFileSync(join(dir,'supervisor-state.json'),'utf8'));assert.equal(after.pid,before.pid);assert.equal(after.bridge_pid,before.bridge_pid);assert.equal(after.owner,before.owner);
    const response=await fetch(new URL('control/dots_status',current.endpoint!),{method:'POST',headers:{authorization:'Bearer '+readFileSync(join(dir,'caller.key'),'utf8').trim(),'content-type':'application/json'},body:'{}'});assert.equal(response.status,200);
    const tasks=new TaskStore(join(dir,'tasks.sqlite'));try{assert.equal(tasks.get(taskId!).status,'queued');}finally{tasks.close();}
    const record=JSON.parse(readFileSync(result.record,'utf8'));assert.equal(record.old_config_text,originalText);assert.equal(record.recovery.core_restored,true);
    t.diagnostic('real endpoint changed across restart; two rollback attempts retained original supervisor/bridge PIDs, live caller auth and queued task identity');
  }finally{if(running)await stopSupervisor(dir);rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
