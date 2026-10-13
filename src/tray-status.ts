import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { productionCall } from './bridge.js';
import { readProductionConfig } from './runtime.js';
import { safePath } from './maintenance.js';
import { ProbeError } from './store.js';
import { readTrayAutostart, type AutostartState } from './tray-autostart.js';

export type TrayState='ready'|'starting'|'stopping'|'stop_unconfirmed'|'stopped'|'setup'|'disconnected'|'unknown'|'failed'|'mismatch';
export interface TrayStatus {
  schema:1;installed_version:string;service_version:string|null;state:TrayState;tone:'green'|'amber'|'red'|'gray';
  title:string;reason:string;service:string;cloud:string;dot:string;control:'start'|'stop'|'disabled';
  autostart:AutostartState;checked_at:string;task_counts:Record<string,number>;inflight_count:number|null;error:string|null;
}
export interface TrayStatusOptions {
  call?:(dir:string,name:'dots_status',args:unknown,options:{timeoutMs:number})=>Promise<unknown>;
  now?:()=>number;
}
const taskStates=['queued','running','waiting_input','cancel_requested','reconciliation_required','completed','failed','cancelled','expired'];
const inflight=['queued','running','waiting_input','cancel_requested','reconciliation_required'];
const labels:Record<TrayState,[TrayStatus['tone'],string,string]>={
  ready:['green','连接就绪','服务、云端连接与 Dot 订阅已核验'],
  starting:['amber','正在启动','服务正在启动，请稍候'],stopping:['amber','正在停止','正在等待服务完成清理'],
  stop_unconfirmed:['amber','停止尚未确认','停止请求已发出，清理结果尚未确认'],
  stopped:['gray','后台已停止','后台已停止，可随时启动'],setup:['amber','等待连接设置','请完成连接配置'],
  disconnected:['amber','连接待恢复','云端连接或 Dot 订阅尚未就绪'],
  unknown:['amber','状态未知','暂时无法核验当前服务状态'],failed:['red','后台故障','后台报告故障，需要检查'],
  mismatch:['amber','版本未同步','运行服务版本与当前托盘版本不一致'],
};
function object(value:unknown):Record<string,unknown> {return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}
function localJson(dir:string,name:string) {
  const path=join(dir,name);safePath(path);
  if(!existsSync(path))return;
  if(!lstatSync(path).isFile())throw new ProbeError('tray_local_state_invalid');
  return object(JSON.parse(readFileSync(path,'utf8')));
}
function version(value:unknown):string|null {return typeof value==='string'&&/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?$/.test(value)&&value.length<80?value:null;}
function safeError(error:unknown):string {return error instanceof ProbeError&&/^[a-z][a-z0-9_]{0,79}$/.test(error.code)?error.code:'tray_status_unavailable';}
export async function getTrayStatus(dir:string,installedVersion:string,options:TrayStatusOptions={}):Promise<TrayStatus> {
  const now=options.now??Date.now;
  const result:TrayStatus={schema:1,installed_version:version(installedVersion)??'unknown',service_version:null,state:'unknown',tone:'amber',title:'状态未知',reason:'暂时无法核验当前服务状态',
    service:'待确认',cloud:'待确认',dot:'待确认',control:'disabled',autostart:readTrayAutostart(dir),checked_at:new Date(now()).toISOString(),task_counts:{},inflight_count:null,error:null};
  function state(next:TrayState,control:TrayStatus['control']='disabled') {result.state=next;[result.tone,result.title,result.reason]=labels[next];result.control=control;return result;}
  let config:ReturnType<typeof readProductionConfig>;
  let hint:Record<string,unknown>|undefined,lock:Record<string,unknown>|undefined,serviceLock:Record<string,unknown>|undefined,stop:Record<string,unknown>|undefined;
  let oldStop=false;
  try {
    safePath(dir);safePath(join(dir,'config.json'));config=readProductionConfig(dir);
    hint=localJson(dir,'supervisor-state.json');lock=localJson(dir,'supervisor.lock');serviceLock=localJson(dir,'service.lock');
    stop=localJson(dir,'supervisor.stop');oldStop=!!stop&&now()-lstatSync(join(dir,'supervisor.stop')).mtimeMs>35000;
    if(hint&&(typeof hint.owner!=='string'||!Number.isSafeInteger(hint.pid)||Number(hint.pid)<1))throw new ProbeError('tray_local_state_invalid');
    if(lock&&(!hint||lock.owner!==hint.owner||lock.pid!==hint.pid))throw new ProbeError('supervisor_ownership_mismatch');
    if(hint?.cleanup_complete===true&&!lock&&!serviceLock) {
      result.service='已停止';result.cloud='未检查';result.dot='未检查';
      if(hint.error||hint.phase==='failed'){
        result.error='supervisor_failed';state('failed','start');
        if(hint.error==='bridge_start_failed'||hint.error==='supervisor_spawn_failed'){result.title='启动失败';result.reason='后台启动未成功，请检查连接设置';}
        return result;
      }
      return state('stopped','start');
    }
    if(!hint&&!lock&&!serviceLock&&!config.endpoint) {
      result.service='已停止';result.cloud='未检查';result.dot='未检查';return state(config.tunnel?'stopped':'setup','start');
    }
  }catch(error) {
    result.error=safeError(error);if(!existsSync(join(dir,'config.json')))return state('setup');return state('unknown');
  }
  // Local PIDs are lifecycle hints only; readiness always requires the authenticated request.
  let observed:Record<string,unknown>;
  try {observed=object(await (options.call??productionCall)(dir,'dots_status',{}, {timeoutMs:2500}));}
  catch(error) {
    result.error=safeError(error);
    if(lock&&hint?.phase==='starting'){result.service='正在启动';return state('starting');}
    if(lock&&hint?.phase==='stopping') {
      result.service='正在停止';return state(oldStop?'stop_unconfirmed':'stopping');
    }
    if(lock&&hint?.phase==='failed'){
      result.service='后台故障';state('failed');
      if(hint.error==='bridge_start_failed'||hint.error==='supervisor_spawn_failed'){result.title='启动失败';result.reason='后台启动未成功，请检查连接设置';}
      return result;
    }
    return state('unknown');
  }
  if(observed.service_reachable!==true){result.error='service_identity_unverified';return state('unknown');}
  result.service='响应正常';result.service_version=version(observed.version);
  const counts=object(observed.task_counts);
  for(const key of taskStates)if(Number.isSafeInteger(counts[key])&&Number(counts[key])>=0)result.task_counts[key]=Number(counts[key]);
  // Require every returned status/count to be understood before reporting a total.
  if(observed.task_counts&&typeof observed.task_counts==='object'&&!Array.isArray(observed.task_counts)&&Object.entries(counts).every(([key,count])=>taskStates.includes(key)&&Number.isSafeInteger(count)&&Number(count)>=0)) {
    const total=inflight.reduce((sum,key)=>sum+(result.task_counts[key]??0),0);if(Number.isSafeInteger(total))result.inflight_count=total;
  }
  if(!result.service_version){result.error='service_version_unavailable';return state('unknown');}
  if(result.service_version!==result.installed_version){result.error='service_version_mismatch';return state('mismatch');}
  if(!lock||!hint||hint.cleanup_complete===true){result.error='supervisor_identity_unverified';return state('unknown');}
  const control:TrayStatus['control']='stop';
  if(hint.phase==='starting'||observed.supervisor==='starting'){result.service='正在启动';return state('starting');}
  if(hint.phase==='stopping'||observed.supervisor==='stopping'||stop?.owner===hint.owner) {
    result.service='正在停止';return state(oldStop?'stop_unconfirmed':'stopping');
  }
  if(observed.supervisor==='failed'||hint.phase==='failed')return state('failed',control);
  if(observed.diagnostics!=='available'||observed.supervisor!=='running'||observed.bridge!=='running'){result.error='runtime_diagnostics_unavailable';return state('unknown');}
  if(observed.tunnel_configured===false){result.cloud='未配置';result.dot='未连接';return state('setup',control);}
  const cloudReady=observed.tunnel_configured===true&&observed.tunnel_health==='ready'&&observed.tunnel==='running';
  result.cloud=cloudReady?'已连接':observed.tunnel_health==='unknown'?'待确认':'未连接';
  const dotReady=Number.isSafeInteger(observed.active_subscription_count)&&Number(observed.active_subscription_count)>0;
  result.dot=dotReady?'订阅有效':'无有效订阅';
  return state(cloudReady&&dotReady?'ready':'disconnected',control);
}
