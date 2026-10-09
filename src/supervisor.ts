import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, lstatSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readProductionConfig, protectProductionDirectory } from './runtime.js';
import { isolatedEnvironment, launchWindowsTunnel } from './tunnel-runner.js';
export { isolatedEnvironment } from './tunnel-runner.js';
import { processIsAlive } from './maintenance.js';
import { ProbeError } from './store.js';

export interface SupervisorOptions {nodePath:string;entryPath:string}
interface SupervisorState {owner:string;pid:number;bridge_pid?:number;tunnel_pid?:number;guardian_pid?:number;phase:'starting'|'running'|'stopping'|'failed';error?:string}
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
  const bridge=state?.bridge_pid&&processIsAlive(state.bridge_pid)?'running':'stopped',tunnel=state?.tunnel_pid&&processIsAlive(state.tunnel_pid)?'running':'stopped',guardian=state?.guardian_pid&&processIsAlive(state.guardian_pid)?'running':'stopped';
  return {supervisor:state&&processIsAlive(state.pid)?state.phase:(bridge==='running'||tunnel==='running'||guardian==='running'?'orphaned_children':'stopped'),bridge,tunnel,guardian,error:state?.error??null};
}
export async function startSupervisor(dir:string,options:SupervisorOptions) {
  protectProductionDirectory(dir);
  const previous=readState(dir);if(previous&&processIsAlive(previous.pid))throw new ProbeError('supervisor_already_running');
  if(existsSync(join(dir,'supervisor.lock')))throw new ProbeError('stale_supervisor_lock');
  const child=spawn(resolve(options.nodePath),[resolve(options.entryPath),'run','--supervisor','--data-dir',resolve(dir)],{detached:true,stdio:'ignore',windowsHide:true,env:isolatedEnvironment()});
  let failed=false;child.once('error',()=>{failed=true;});child.unref();
  for(let i=0;i<100;i++) {
    await delay(100);if(failed)throw new ProbeError('supervisor_spawn_failed');const current=readState(dir);
    if(current&&current.pid===child.pid&&current.phase==='running')return supervisorStatus(dir);
    if(current&&current.pid===child.pid&&current.phase==='failed')throw new ProbeError(current.error??'supervisor_start_failed');
  }
  return {supervisor:'starting',tools:'not_yet_verified'};
}
export async function stopSupervisor(dir:string) {
  readProductionConfig(dir);const state=readState(dir);
  if(!state||!processIsAlive(state.pid)) {
    for(let i=0;i<50;i++){if(supervisorStatus(dir).supervisor==='stopped')return {supervisor:'stopped',dot_tasks:'not_cancelled'};await delay(100);}
    throw new ProbeError('orphaned_children_require_recovery');
  }
  const lock=JSON.parse(readFileSync(join(dir,'supervisor.lock'),'utf8')) as {owner:string;pid:number};
  if(lock.owner!==state.owner||lock.pid!==state.pid)throw new ProbeError('supervisor_ownership_mismatch');
  writeFileSync(join(dir,'supervisor.stop'),JSON.stringify({owner:state.owner}),{mode:0o600});
  for(let i=0;i<300;i++){await delay(100);if(!processIsAlive(state.pid)&&supervisorStatus(dir).supervisor==='stopped')return {supervisor:'stopped',dot_tasks:'not_cancelled'};}
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
  const recordError=(error:unknown)=>{
    if(lastError)return;
    const code=(error as NodeJS.ErrnoException).code;
    lastError=error instanceof ProbeError?error.code:(typeof code==='string'&&/^[A-Z_]+$/.test(code)?`supervisor_io_${code}`:'supervisor_operation_failed');
  };
  const cleanupStep=async(action:()=>void|Promise<void>)=>{try{await action();}catch(error){recordError(error);}};
  const state=(phase:SupervisorState['phase'],error?:string)=>{
    const path=join(dir,`supervisor-state.${randomUUID()}.tmp`);
    writeFileSync(path,JSON.stringify({owner,pid:process.pid,bridge_pid:bridge?.pid,tunnel_pid:tunnelPid,guardian_pid:guardian?.pid,phase,...(error?{error}:{})}),{mode:0o600,flag:'wx'});
    renameSync(path,join(dir,'supervisor-state.json'));
  };
  const stop=()=>{stopping=true;};process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try {
    state('starting');
    for(let attempt=0;!stopping;attempt++) {
      bridge=spawn(resolve(options.nodePath),[resolve(options.entryPath),'run','--foreground','--data-dir',resolve(dir)],{env:isolatedEnvironment(),windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
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
        guardian=launched.process;guardian.once('error',()=>{childError=true;});state('starting');tunnelPid=await launched.ready;
      }
      state('running');
      while(!stopping&&!childError&&bridge.exitCode===null&&(!guardian||guardian.exitCode===null)) {
        if(existsSync(join(dir,'supervisor.stop'))){const request=JSON.parse(readFileSync(join(dir,'supervisor.stop'),'utf8')) as {owner:string};if(request.owner===owner)stopping=true;}
        await delay(250);
      }
      if(stopping)break; // Normal shutdown belongs to the protected final cleanup below.
      guardian?.stdin?.end();await terminate(guardian,true);await terminate(bridge,true);
      // Only remove a child lock after this supervisor observed its own child exit.
      const serviceLock=join(dir,'service.lock');
      if(existsSync(serviceLock)&&bridge.pid&&bridge.exitCode!==null){const childLock=JSON.parse(readFileSync(serviceLock,'utf8')) as {pid:number};if(childLock.pid===bridge.pid)unlinkSync(serviceLock);}
      if(!stopping){if(attempt>=2)throw new ProbeError('child_restart_limit');state('starting');await delay(1000);}
    }
  }catch(error){recordError(error);}
  finally {
    if(!lastError)await cleanupStep(()=>state('stopping'));
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
    await cleanupStep(()=>{
      if(existsSync(lockPath)){const lock=JSON.parse(readFileSync(lockPath,'utf8')) as {owner:string};if(lock.owner===owner)unlinkSync(lockPath);}
    });
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  }
  if(lastError){try{state('failed',lastError);}catch{/* Cleanup is complete; keep the original safe diagnostic. */}throw new ProbeError(lastError);}
}
