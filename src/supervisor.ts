import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, lstatSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readProductionConfig, protectProductionDirectory } from './runtime.js';
import { isolatedEnvironment, launchWindowsTunnel } from './tunnel-runner.js';
export { isolatedEnvironment } from './tunnel-runner.js';
import { processIsAlive } from './maintenance.js';
import { ProbeError } from './store.js';
import { recoverRebootLocks } from './reboot-recovery.js';
import { launchWindowsSupervisor } from './windows-background.js';
import { createStartupDiagnostic, startupErrorCode, writeStartupDiagnostic } from './startup-diagnostics.js';

export interface SupervisorOptions {nodePath:string;entryPath:string}
interface LifecycleEvent {at:string;event:'child_exit'|'child_error'|'uncaught_exception';child?:'bridge'|'guardian';pid?:number;exit_code?:number|null;signal?:string|null}
interface SupervisorState {owner:string;pid:number;bridge_pid?:number;tunnel_pid?:number;guardian_pid?:number;phase:'starting'|'running'|'stopping'|'failed';error?:string;cleanup_complete?:boolean;lifecycle?:LifecycleEvent[]}
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
export function parseTunnelEnvironment(contents:string) {
  if(contents.length>16384)throw new ProbeError('invalid_tunnel_key_file');
  const lines=contents.replace(/^\uFEFF/,'').split(/\r?\n/).filter(line=>line.trim()&&!line.trim().startsWith('#'));
  if(lines.length!==1)throw new ProbeError('invalid_tunnel_key_file');
  const match=/^CONTROL_PLANE_API_KEY=(.+)$/.exec(lines[0]!);if(!match)throw new ProbeError('invalid_tunnel_key_file');
  const key=match[1]!.trim().replace(/^(?:"(.*)"|'(.*)')$/,'$1$2');if(!key||/\s/.test(key))throw new ProbeError('invalid_tunnel_key_file');return {CONTROL_PLANE_API_KEY:key};
}
function readState(dir:string):SupervisorState|undefined {
  const path=join(dir,'supervisor-state.json');if(!existsSync(path))return;
  if(lstatSync(path).isSymbolicLink())throw new ProbeError('symlink_supervisor_state');
  const state=JSON.parse(readFileSync(path,'utf8')) as SupervisorState;
  if(!state.owner||!Number.isSafeInteger(state.pid)||state.pid<1)throw new ProbeError('invalid_supervisor_state');return state;
}
export function supervisorStatus(dir:string) {
  readProductionConfig(dir);const state=readState(dir);
  // Completed cleanup is authoritative after the owner releases its lock; old PIDs can be reused.
  if(state?.cleanup_complete===true){
    const stopped={supervisor:'stopped',bridge:'stopped',tunnel:'stopped',guardian:'stopped',error:state.error??null};
    try{
      const lock=JSON.parse(readFileSync(join(dir,'supervisor.lock'),'utf8')) as {owner:string;pid:number};
      return {...stopped,supervisor:lock.owner===state.owner&&lock.pid===state.pid?'stopping':'unknown',error:lock.owner===state.owner&&lock.pid===state.pid?state.error??null:'supervisor_ownership_mismatch'};
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return stopped;throw error;}
  }
  const bridge=state?.bridge_pid&&processIsAlive(state.bridge_pid)?'running':'stopped',tunnel=state?.tunnel_pid&&processIsAlive(state.tunnel_pid)?'running':'stopped',guardian=state?.guardian_pid&&processIsAlive(state.guardian_pid)?'running':'stopped';
  return {supervisor:state&&processIsAlive(state.pid)?state.phase:(bridge==='running'||tunnel==='running'||guardian==='running'?'orphaned_children':'stopped'),bridge,tunnel,guardian,error:state?.error??null};
}
export async function startSupervisor(dir:string,options:SupervisorOptions,settings:{autostart?:boolean}={}) {
  const trace=createStartupDiagnostic(settings.autostart===true);
  try {
    const result=await startSupervisorAttempt(dir,options,trace.record,settings.autostart===true);
    trace.diagnostic.outcome=result.supervisor==='running'?'running':'starting';
    trace.record('finished',trace.diagnostic.outcome);
    return result;
  }catch(error) {trace.record('finished',startupErrorCode(error));throw error;}
  finally {writeStartupDiagnostic(dir,trace.diagnostic);}
}
async function startSupervisorAttempt(dir:string,options:SupervisorOptions,record:ReturnType<typeof createStartupDiagnostic>['record'],autostart:boolean) {
  record('preflight','started');
  protectProductionDirectory(dir);
  let recovery:Awaited<ReturnType<typeof recoverRebootLocks>>,previous:SupervisorState|undefined;
  for(let attempt=0;;attempt++) {
    record('recovery','started');recovery=await recoverRebootLocks(dir);record('recovery',recovery.reason);
    previous=readState(dir);
    // No supervisor launch has been attempted here. Retry only transient probe
    // uncertainty at login, once; ownership refusals and launch-unknown never retry.
    const transient=new Set(['recovery_probe_failed','unknown_boot','endpoint_unknown','unknown_process_command','recorded_process_unknown']);
    if(autostart&&attempt===0&&!recovery.clearPreviousState&&previous&&!previous.cleanup_complete&&transient.has(recovery.reason)) {
      record('retry_wait','recovery_probe_retry');await delay(1500);continue;
    }
    break;
  }
  if(!recovery.clearPreviousState&&previous&&!previous.cleanup_complete) {
    // Windows recovery proves ownership/liveness using CIM, endpoint and exact
    // metadata. A live numeric PID alone may belong to a later stdio caller.
    if(process.platform==='win32')throw new ProbeError('supervisor_recovery_'+(/^[a-z][a-z0-9_]{0,79}$/.test(recovery.reason)?recovery.reason:'probe_failed'));
    if(processIsAlive(previous.pid))throw new ProbeError('supervisor_already_running');
  }
  if(existsSync(join(dir,'supervisor.lock')))throw new ProbeError('stale_supervisor_lock');
  record('launch','started');
  let launchedPid:number|undefined,failed=false;
  if(process.platform==='win32') {
    // detached Node processes still inherit a caller's kill-on-close Job. The
    // Windows broker creates the supervisor independently in the same session.
    launchedPid=(await launchWindowsSupervisor({nodePath:options.nodePath,entryPath:options.entryPath,dataDir:dir})).pid;
  } else {
    const child=spawn(resolve(options.nodePath),[resolve(options.entryPath),'run','--supervisor','--data-dir',resolve(dir)],{detached:true,stdio:'ignore',windowsHide:true,env:isolatedEnvironment()});
    launchedPid=child.pid;child.once('error',()=>{failed=true;});child.unref();
  }
  record('readiness','started');
  for(let i=0;i<100;i++) {
    await delay(100);if(failed)throw new ProbeError('supervisor_spawn_failed');const current=readState(dir);
    if(current&&current.pid===launchedPid&&current.owner!==previous?.owner&&current.phase==='running') {
      // Readiness belongs to the newly launched owner and both of its locks.
      // A leftover running-state PID, later reused, is not a startup receipt.
      try {
        const lock=JSON.parse(readFileSync(join(dir,'supervisor.lock'),'utf8')) as {owner:string;pid:number};
        const service=JSON.parse(readFileSync(join(dir,'service.lock'),'utf8')) as {owner:string;pid:number};
        if(lock.owner===current.owner&&lock.pid===current.pid&&service.owner!==current.owner&&service.pid===current.bridge_pid&&current.bridge_pid&&processIsAlive(current.bridge_pid))return supervisorStatus(dir);
      }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    if(current&&current.pid===launchedPid&&current.owner!==previous?.owner&&current.phase==='failed')throw new ProbeError(current.error??'supervisor_start_failed');
  }
  return {supervisor:'starting',tools:'not_yet_verified'};
}
export async function stopSupervisor(dir:string) {
  readProductionConfig(dir);const state=readState(dir);
  if(!state||state.cleanup_complete===true||!processIsAlive(state.pid)) {
    for(let i=0;i<50;i++){if(supervisorStatus(dir).supervisor==='stopped')return {supervisor:'stopped',dot_tasks:'not_cancelled'};await delay(100);}
    throw new ProbeError('orphaned_children_require_recovery');
  }
  const lock=JSON.parse(readFileSync(join(dir,'supervisor.lock'),'utf8')) as {owner:string;pid:number};
  if(lock.owner!==state.owner||lock.pid!==state.pid)throw new ProbeError('supervisor_ownership_mismatch');
  writeFileSync(join(dir,'supervisor.stop'),JSON.stringify({owner:state.owner}),{mode:0o600});
  const completedStop=()=>{
    const current=readState(dir);
    if(!current||current.owner!==state.owner||current.pid!==state.pid)throw new ProbeError('supervisor_ownership_mismatch');
    let currentLock:{owner:string;pid:number}|undefined;
    try{currentLock=JSON.parse(readFileSync(join(dir,'supervisor.lock'),'utf8')) as {owner:string;pid:number};}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(currentLock&&(currentLock.owner!==state.owner||currentLock.pid!==state.pid))throw new ProbeError('supervisor_ownership_mismatch');
    if(current.cleanup_complete===true&&!currentLock)return {supervisor:'stopped',dot_tasks:'not_cancelled',...(current.error?{error:current.error}:{})};
  };
  for(let i=0;i<300;i++){
    await delay(100);
    const completed=completedStop();if(completed)return completed;
    if(!processIsAlive(state.pid)){
      // Exit can follow the previous reads: observe its final receipt again.
      const final=completedStop();if(final)return final;
      throw new ProbeError('supervisor_cleanup_unconfirmed');
    }
  }
  throw new ProbeError('supervisor_stop_pending');
}
async function terminate(child:ChildProcess|undefined,graceful=false) {
  if(!child||!child.pid||child.exitCode!==null||child.signalCode!==null)return;
  if(graceful&&child.connected){try{child.send({type:'shutdown'},()=>{});}catch{/* child disconnected after the check */}}
  if(graceful)for(let i=0;i<200&&child.exitCode===null&&child.signalCode===null;i++)await delay(100);
  if(child.exitCode!==null||child.signalCode!==null)return;
  if(process.platform==='win32'&&child.pid) {try{execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});}catch{/* child may have exited */}}
  else child.kill('SIGTERM');
  for(let i=0;i<50&&child.exitCode===null&&child.signalCode===null;i++)await delay(100);
}
function protectExternalKey(path:string) {
  for(let current=resolve(path);;current=resolve(current,'..')) {if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw new ProbeError('symlink_tunnel_key');if(resolve(current,'..')===current)break;}
  if(!lstatSync(path).isFile())throw new ProbeError('invalid_tunnel_key_file');
  if(process.platform==='win32') {
    const script=String.raw`$ErrorActionPreference='Stop'
$p=[Environment]::GetEnvironmentVariable('CODEX_DOTS_KEY_PATH')
$acl=Get-Acl -LiteralPath $p
$user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
if($owner -notin @($user,'S-1-5-18')) {throw 'owner'}
$rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))
foreach($rule in $rules){if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($user,'S-1-5-18')){throw 'broad_acl'}}
if(-not ($rules | Where-Object {$_.IdentityReference.Value -eq $user -and $_.AccessControlType -eq 'Allow'})){throw 'missing_user'}`;
    try{execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env:{...isolatedEnvironment(),CODEX_DOTS_KEY_PATH:path},stdio:'pipe',windowsHide:true});}catch{throw new ProbeError('tunnel_key_not_private');}
  }
}
export async function runSupervisor(dir:string,options:SupervisorOptions) {
  protectProductionDirectory(dir);const config=readProductionConfig(dir),owner=randomUUID(),lockPath=join(dir,'supervisor.lock');
  try{writeFileSync(lockPath,JSON.stringify({owner,pid:process.pid}),{flag:'wx',mode:0o600});}catch{throw new ProbeError('supervisor_already_running_or_stale');}
  let bridge:ChildProcess|undefined,guardian:ChildProcess|undefined,tunnelPid:number|undefined,stopping=false;let lastError:string|undefined;
  const lifecycle:LifecycleEvent[]=[];
  const observeChild=(child:ChildProcess,name:'bridge'|'guardian')=>{
    const record=(event:LifecycleEvent)=>{lifecycle.push(event);if(lifecycle.length>16)lifecycle.shift();};
    child.once('exit',(code,signal)=>record({at:new Date().toISOString(),event:'child_exit',child:name,pid:child.pid,exit_code:code,signal}));
    child.once('error',()=>record({at:new Date().toISOString(),event:'child_error',child:name,pid:child.pid}));
  };
  const recordError=(error:unknown)=>{
    if(lastError)return;
    const code=(error as NodeJS.ErrnoException).code;
    lastError=error instanceof ProbeError?error.code:(typeof code==='string'&&/^[A-Z_]+$/.test(code)?`supervisor_io_${code}`:'supervisor_operation_failed');
  };
  let resourceCleanupFailed=false;
  const cleanupStep=async(action:()=>void|Promise<void>,resource=true)=>{try{await action();}catch(error){if(resource)resourceCleanupFailed=true;recordError(error);}};
  const assertOwner=()=>{
    const lock=JSON.parse(readFileSync(lockPath,'utf8')) as {owner:string;pid:number};
    if(lock.owner!==owner||lock.pid!==process.pid)throw new ProbeError('supervisor_ownership_mismatch');
  };
  const prepareState=(phase:SupervisorState['phase'],error?:string,cleanupComplete=false)=>{
    const path=join(dir,`supervisor-state.${randomUUID()}.tmp`);
    writeFileSync(path,JSON.stringify({owner,pid:process.pid,...(!cleanupComplete?{bridge_pid:bridge?.pid,tunnel_pid:tunnelPid,guardian_pid:guardian?.pid}:{cleanup_complete:true}),phase,...(error?{error}:{}),...(lifecycle.length?{lifecycle}:{})}),{mode:0o600,flag:'wx'});
    return path;
  };
  const state=async(phase:SupervisorState['phase'],error?:string,cleanupComplete=false)=>{
    // A Windows reader may block replacement even with FILE_SHARE_DELETE.
    // Keep one immutable temporary and the owner lock throughout bounded retry.
    const path=prepareState(phase,error,cleanupComplete),deadline=performance.now()+1000;
    for(;;){
      assertOwner();
      try{renameSync(path,join(dir,'supervisor-state.json'));return;}
      catch(caught){
        const code=(caught as NodeJS.ErrnoException).code,remaining=deadline-performance.now();
        if(process.platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(code??'')||remaining<=0)throw caught;
        await delay(Math.min(25,remaining));
        if(performance.now()>=deadline)throw caught;
      }
    }
  };
  const stop=()=>{stopping=true;};process.once('SIGINT',stop);process.once('SIGTERM',stop);
  const uncaught=()=>{
    // Best effort only: no exception text, command lines or credentials are
    // persisted, and diagnostic I/O never throws or terminates children.
    try {
      const lock=JSON.parse(readFileSync(lockPath,'utf8')) as {owner:string;pid:number};
      if(lock.owner!==owner||lock.pid!==process.pid)return;
      lifecycle.push({at:new Date().toISOString(),event:'uncaught_exception'});if(lifecycle.length>16)lifecycle.shift();
      // Fatal exception observation stays synchronous and best effort.
      const path=prepareState('failed','supervisor_uncaught_exception');assertOwner();renameSync(path,join(dir,'supervisor-state.json'));
    }catch{/* retain the original fatal exception and runtime behavior */}
  };
  process.on('uncaughtExceptionMonitor',uncaught);
  try {
    await state('starting');
    for(let attempt=0;!stopping;attempt++) {
      bridge=spawn(resolve(options.nodePath),[resolve(options.entryPath),'run','--foreground','--data-dir',resolve(dir)],{env:isolatedEnvironment(),windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
      observeChild(bridge,'bridge');
      let childError=false;bridge.once('error',()=>{childError=true;});
      let endpoint:string|undefined;
      bridge.on('message',(message:unknown)=>{
        if(message&&typeof message==='object'&&(message as {type?:unknown}).type==='bridge_ready') {
          const candidate=(message as {endpoint?:unknown}).endpoint;
          if(typeof candidate!=='string')return;
          try{const url=new URL(candidate);if(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&url.port&&url.pathname==='/'&&!url.username&&!url.password&&!url.search&&!url.hash)endpoint=candidate;}catch{/* reject malformed readiness */}
        }
      });
      for(let i=0;i<100&&!stopping;i++){await delay(100);if(childError||bridge.exitCode!==null)break;if(endpoint)break;}
      if(!endpoint||childError||bridge.exitCode!==null)throw new ProbeError('bridge_start_failed');
      if(config.tunnel) {
        protectExternalKey(config.tunnel.key_file);
        if(existsSync(join(dir,'tunnel-health.url')))unlinkSync(join(dir,'tunnel-health.url'));
        const launched=launchWindowsTunnel(config.tunnel.client_path,['run','--control-plane.tunnel-id',config.tunnel.tunnel_id,'--control-plane.api-key','env:CONTROL_PLANE_API_KEY','--control-plane.organization-id',config.tunnel.organization_id,'--mcp.server-url',`url=${new URL('mcp/dot',endpoint).href},channel=main`,'--mcp.extra-headers',`X-Codex-Dots-Worker-Token: file:${join(resolve(dir),'worker.key')}`,'--health.listen-addr','127.0.0.1:0','--health.url-file',join(resolve(dir),'tunnel-health.url'),'--log.level','warn','--log.format','json'],config.tunnel.key_file);
        // State publication can yield while the guardian fails. Observe readiness
        // immediately, but await the original promise below to preserve failure.
        void launched.ready.catch(()=>{});
        guardian=launched.process;observeChild(guardian,'guardian');guardian.once('error',()=>{childError=true;});await state('starting');tunnelPid=await launched.ready;
      }
      await state('running');
      while(!stopping&&!childError&&bridge.exitCode===null&&(!guardian||guardian.exitCode===null)) {
        if(existsSync(join(dir,'supervisor.stop'))){const request=JSON.parse(readFileSync(join(dir,'supervisor.stop'),'utf8')) as {owner:string};if(request.owner===owner)stopping=true;}
        await delay(250);
      }
      if(stopping)break; // Normal shutdown belongs to the protected final cleanup below.
      guardian?.stdin?.end();await terminate(guardian,true);await terminate(bridge,true);
      // Only remove a child lock after this supervisor observed its own child exit.
      const serviceLock=join(dir,'service.lock');
      if(existsSync(serviceLock)&&bridge.pid&&bridge.exitCode!==null){const childLock=JSON.parse(readFileSync(serviceLock,'utf8')) as {pid:number};if(childLock.pid===bridge.pid)unlinkSync(serviceLock);}
      if(!stopping){if(attempt>=2)throw new ProbeError('child_restart_limit');await state('starting');await delay(1000);}
    }
  }catch(error){recordError(error);}
  finally {
    if(!lastError)await cleanupStep(()=>state('stopping'),false);
    // State I/O is advisory. Each resource cleanup runs even if an earlier step fails.
    await cleanupStep(()=>{guardian?.stdin?.end();});
    await cleanupStep(()=>terminate(guardian,true));
    await cleanupStep(()=>terminate(bridge,true));
    await cleanupStep(()=>{
      const serviceLock=join(dir,'service.lock');
      if(existsSync(serviceLock)&&bridge?.pid&&bridge.exitCode!==null){const childLock=JSON.parse(readFileSync(serviceLock,'utf8')) as {pid:number};if(childLock.pid===bridge.pid)unlinkSync(serviceLock);}
    });
    await cleanupStep(()=>{
      if(existsSync(join(dir,'supervisor.stop'))){try{const stop=JSON.parse(readFileSync(join(dir,'supervisor.stop'),'utf8')) as {owner:string};if(stop.owner===owner)unlinkSync(join(dir,'supervisor.stop'));}catch{/* preserve unknown */}}
    });
    await cleanupStep(async()=>{
      const exited=(child:ChildProcess|undefined)=>!child?.pid||child.exitCode!==null||child.signalCode!==null;
      // The Windows Job may finish terminating the Tunnel shortly after its guardian exits.
      for(let i=0;tunnelPid&&processIsAlive(tunnelPid)&&i<200;i++)await delay(25);
      const cleanupComplete=!resourceCleanupFailed&&exited(bridge)&&exited(guardian)&&(!tunnelPid||!processIsAlive(tunnelPid));
      if(!cleanupComplete)recordError(new ProbeError('supervisor_children_stop_pending'));
      const lock=JSON.parse(readFileSync(lockPath,'utf8')) as {owner:string;pid:number};
      if(lock.owner!==owner||lock.pid!==process.pid)throw new ProbeError('supervisor_ownership_mismatch');
      // Publish before unlocking: a later instance must never be overwritten by this one.
      await state(lastError?'failed':'stopping',lastError,cleanupComplete);
    },false);
    await cleanupStep(()=>{
      if(existsSync(lockPath)){const lock=JSON.parse(readFileSync(lockPath,'utf8')) as {owner:string};if(lock.owner===owner)unlinkSync(lockPath);}
    });
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
    process.removeListener('uncaughtExceptionMonitor',uncaught);
  }
  if(lastError)throw new ProbeError(lastError);
}
