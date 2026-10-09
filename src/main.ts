#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { TaskStore } from './task-store.js';
import { ProbeError } from './store.js';
import { ProbeEvents } from './events.js';
import { acquireLock, defaultProductionDataDir, initProduction, protectProductionDirectory, readProductionConfig, writeProductionConfig, readToken } from './runtime.js';
import { VERSION, callerSchemas, createProductionService, productionCall, resolveSchema, startProductionCaller, type CallerName } from './bridge.js';
import { installCodex, uninstallCodex, backupData, restoreData, statusData, doctorData, connectionDiagnosticsData } from './maintenance.js';
import { runSupervisor, startSupervisor, stopSupervisor, supervisorStatus } from './supervisor.js';

const {values,positionals}=parseArgs({allowPositionals:true,options:{
  'data-dir':{type:'string'},'request':{type:'string'},'task':{type:'string'},'title':{type:'string'},'text':{type:'string'},
  'idempotency-key':{type:'string'},'message-key':{type:'string'},'question':{type:'string'},'parent':{type:'string'},
  'result':{type:'string'},'request-key':{type:'string'},'reason':{type:'string'},'after':{type:'string'},'timeout':{type:'string'},
  'hours':{type:'string'},'safe-to-retry':{type:'boolean'},'user-accepted':{type:'boolean'},
  'status':{type:'string'},'logical-session':{type:'string'},'limit':{type:'string'},
  'tunnel-id':{type:'string'},'organization-id':{type:'string'},'tunnel-client':{type:'string'},'tunnel-env':{type:'string'},
  'codex-home':{type:'string'},'codex-command':{type:'string'},'autostart':{type:'boolean'},'no-register':{type:'boolean'},
  'foreground':{type:'boolean'},'supervisor':{type:'boolean'},'start':{type:'boolean'},'stop':{type:'boolean'},
  'to':{type:'string'},'from':{type:'string'},'help':{type:'boolean'},'version':{type:'boolean'},
}});
const dataDir=resolve(values['data-dir']??defaultProductionDataDir());
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const entry=join(root,'dist','main.js');
const runtime={nodePath:process.execPath,entryPath:entry};
const output=(value:unknown)=>process.stdout.write(JSON.stringify(value,null,2)+'\n');
const numeric=(name:'hours'|'after'|'timeout'|'limit')=>values[name]===undefined?undefined:Number(values[name]);
const fromRequest=()=>values.request?JSON.parse(readFileSync(resolve(values.request),'utf8')):undefined;
async function foreground() {
  protectProductionDirectory(dataDir);
  const config=readProductionConfig(dataDir),release=acquireLock(dataDir);
  let store:TaskStore|undefined;
  let service:ReturnType<typeof createProductionService>|undefined;
  try {
    store=new TaskStore(join(dataDir,'tasks.sqlite'));
    service=createProductionService(store,new ProbeEvents(store,undefined,'tasks'),{caller:readToken(dataDir,'caller'),worker:readToken(dataDir,'worker')},
      async()=>({...await connectionDiagnosticsData(dataDir),...supervisorStatus(dataDir),bridge:'running'}));
    const endpoint=await service.start();
    writeProductionConfig(dataDir,{...config,endpoint});
    process.stderr.write(JSON.stringify({service:'codex-dots-bridge',version:VERSION,endpoint})+'\n');
    await new Promise<void>((done,reject)=>{
      let stopping=false;
      const stop=()=>{
        if(stopping)return;stopping=true;
        process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
        process.removeListener('message',message);process.removeListener('disconnect',stop);
        done();
      };
      const message=(value:unknown)=>{if(value&&typeof value==='object'&&(value as {type?:unknown}).type==='shutdown')stop();};
      process.once('SIGINT',stop);process.once('SIGTERM',stop);process.on('message',message);
      if(typeof process.send==='function') {
        if(!process.connected){stop();return;}
        process.once('disconnect',stop);
        process.send({type:'bridge_ready',endpoint},error=>{if(error)stop();});
      }
    });
  } finally {
    try {await service?.close();} finally {store?.close();release();if(process.connected)process.disconnect();}
  }
}
async function setup() {
  if(dataDir===root || dataDir.toLowerCase().startsWith(root.toLowerCase()+'\\') || dataDir.startsWith(root+'/'))throw new ProbeError('data_must_be_outside_source');
  const config=initProduction(dataDir);
  const tunnelFlags=[values['tunnel-id'],values['organization-id'],values['tunnel-client'],values['tunnel-env']];
  if(tunnelFlags.some(Boolean)) {
    const prior=config.tunnel;
    const merged={tunnel_id:values['tunnel-id']??prior?.tunnel_id,organization_id:values['organization-id']??prior?.organization_id,
      client_path:values['tunnel-client']?resolve(values['tunnel-client']):prior?.client_path,key_file:values['tunnel-env']?resolve(values['tunnel-env']):prior?.key_file};
    if(Object.values(merged).some(v=>!v))throw new ProbeError('tunnel_configuration_incomplete');
    config.tunnel=merged as NonNullable<typeof config.tunnel>;
  }
  config.installation={root,node_path:process.execPath};writeProductionConfig(dataDir,config);
  const registration=values['no-register']?{mcp:'not_registered'}:installCodex(dataDir,{...runtime,skillSource:join(root,'skills','codex-dots-bridge'),
    codexHome:values['codex-home'],codexCommand:values['codex-command'],autostart:values.autostart});
  output({version:VERSION,data_dir:dataDir,...registration,tunnel:config.tunnel?'configured_not_yet_verified':'requires_official_tunnel_account_setup',
    next:'Run bridge, connect the private plugin to this Tunnel, subscribe queue=tasks in your Dot, then run one harmless task. A new Codex chat or app restart may be needed to load MCP.'});
}
async function tasks() {
  const operation=positionals[1]??'list';
  let name:CallerName,args:unknown;
  const requested=fromRequest();
  const submit={idempotency_key:values['idempotency-key'],title:values.title,input:{text:values.text},deadline_hours:numeric('hours'),
    safe_to_retry:values['safe-to-retry'],logical_session_id:values['logical-session']};
  switch(operation) {
    case 'list': name='dots_list';args=requested??{status:values.status,logical_session_id:values['logical-session'],limit:numeric('limit')};break;
    case 'get': name='dots_get';args=requested??{task_id:values.task};break;
    case 'submit': name='dots_submit';args=requested??submit;break;
    case 'message': name='dots_message';args=requested??{task_id:values.task,message_key:values['message-key'],text:values.text,question_id:values.question,deadline_hours:numeric('hours')};break;
    case 'followup': name='dots_followup';args=requested??{...submit,parent_task_id:values.parent};break;
    case 'cancel': name='dots_cancel';args=requested??{task_id:values.task,request_key:values['request-key'],reason:values.reason};break;
    case 'ack': name='dots_ack_result';args=requested??{task_id:values.task,result_id:values.result,user_accepted:values['user-accepted']};break;
    case 'wait': name='dots_wait';args=requested??{task_id:values.task,after_sequence:numeric('after'),timeout_seconds:numeric('timeout')};break;
    default:throw new ProbeError('unknown_tasks_operation');
  }
  args=callerSchemas[name].parse(args);
  const result=await productionCall(dataDir,name,args);
  // The default maintenance index omits task input, message and result bodies.
  output(name==='dots_list'?result.map((t:{task_id:string;title:string;status:string;input_revision:number;change_sequence:number})=>({task_id:t.task_id,title:t.title,status:t.status,input_revision:t.input_revision,change_sequence:t.change_sequence})):result);
}
try {
  if(values.version)output({name:'codex-dots-bridge',version:VERSION});
  else if(values.help||!positionals[0])process.stdout.write(`Codex Dots Bridge ${VERSION}\nWindows x64 prerelease; keep P0 evidence separate.\n\nsetup [--tunnel-id ID --organization-id ID --tunnel-client EXE --tunnel-env ENV_FILE] [--autostart]\nrun [--start | --stop | --foreground]\nstatus | doctor\ntasks list|get|submit|message|followup|cancel|ack|wait [--request JSON_FILE]\nresolve --request JSON_FILE\nbackup --to PROTECTED_DIRECTORY\nrestore --from BACKUP_DIRECTORY [--data-dir EMPTY_TARGET]\nuninstall [--codex-command NEW_NATIVE_EXE]\n\nAll commands accept --data-dir PATH. stdio and run --supervisor are managed entry points.\nNo command accepts a plaintext Tunnel key. Registration is not proof that Codex loaded the tools.\n`);
  else switch(positionals[0]) {
    case 'setup':await setup();break;
    case 'run':
      if([values.stop,values.foreground,values.supervisor].filter(Boolean).length>1)throw new ProbeError('conflicting_run_modes');
      if(values.stop)output(await stopSupervisor(dataDir));
      else if(values.foreground)await foreground();
      else if(values.supervisor)await runSupervisor(dataDir,runtime);
      else output(await startSupervisor(dataDir,runtime));break;
    case 'stdio':readProductionConfig(dataDir);startProductionCaller(dataDir);break;
    case 'status':output({...statusData(dataDir),...supervisorStatus(dataDir)});break;
    case 'doctor':output({...await doctorData(dataDir),...supervisorStatus(dataDir)});break;
    case 'tasks':await tasks();break;
    case 'resolve':output(await productionCall(dataDir,'resolve',resolveSchema.parse(fromRequest())));break;
    case 'backup':if(!values.to)throw new ProbeError('backup_destination_required');output(await backupData(dataDir,resolve(values.to)));break;
    case 'restore':if(!values.from)throw new ProbeError('backup_source_required');output(await restoreData(resolve(values.from),dataDir));break;
    case 'uninstall':await stopSupervisor(dataDir);output(uninstallCodex(dataDir,values['codex-command']));break;
    default:throw new ProbeError('unknown_command');
  }
} catch(e) {
  const error=e instanceof ProbeError?e.code:e instanceof z.ZodError?'invalid_parameters':(e as NodeJS.ErrnoException).code==='ENOENT'?'required_file_or_command_missing':'bridge_operation_failed';
  output({error,...(e instanceof z.ZodError?{fields:e.issues.map(i=>i.path.join('.'))}:{} )});process.exitCode=1;
}
