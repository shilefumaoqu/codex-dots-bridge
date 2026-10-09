import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { init, readConfig, readToken, writeConfig, acquireLock, defaultDataDir } from './runtime.js';
import { ProbeStore, ProbeError } from './store.js';
import { ProbeEvents } from './events.js';
import { createService } from './service.js';
import { localCall, startCaller } from './caller.js';

const {values,positionals}=parseArgs({allowPositionals:true,options:{'data-dir':{type:'string'},case:{type:'string'},key:{type:'string'},task:{type:'string'},question:{type:'string'},answer:{type:'string'},result:{type:'string'},help:{type:'boolean'}}});
const dir=resolve(values['data-dir']??defaultDataDir());
const command=positionals[0];
const output=(value:unknown)=>process.stdout.write(JSON.stringify(value,null,2)+'\n');
try {
  if(values.help || !command) {
    process.stdout.write('Codex Dots Bridge P0 (not v1.0)\ninit | run | stdio | status | submit --case echo|clarify --key KEY | get --task ID | answer --task ID --question ID --answer blue|green | ack --task ID --result ID | evidence\nAll commands accept --data-dir PATH. No Platform key is read by this process.\n');
  } else if(command==='init') {
    const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
    if(dir===root || dir.toLowerCase().startsWith(root.toLowerCase()+'\\') || dir.startsWith(root+'/')) throw new ProbeError('data_must_be_outside_source');
    output({phase:'P0',data_dir:dir,instance:init(dir).instance_id,account_connection:'not_configured'});
  } else if(command==='run') {
    const config=readConfig(dir); const release=acquireLock(dir);
    let store:ProbeStore|undefined;
    try {
      store=new ProbeStore(join(dir,'probe.sqlite'));
      const service=createService(store,new ProbeEvents(store),{caller:readToken(dir,'caller'),worker:readToken(dir,'worker')});
      const endpoint=await service.start(); writeConfig(dir,{...config,endpoint});
      process.stderr.write(JSON.stringify({phase:'P0',endpoint,worker_endpoint:new URL('mcp/dot',endpoint).href})+'\n');
      let stopping=false;
      const stop=async()=>{if(stopping)return;stopping=true;await service.close();store!.close();release();};
      process.once('SIGINT',()=>{void stop();}); process.once('SIGTERM',()=>{void stop();});
    } catch(e) {store?.close();release();throw e;}
  } else if(command==='stdio') {
    readConfig(dir); startCaller(dir);
  } else if(command==='status') output(await localCall(dir,'dots_status',{}));
  else if(command==='submit') output(await localCall(dir,'dots_submit',{case:values.case,idempotency_key:values.key}));
  else if(command==='get') output(await localCall(dir,'dots_get',{task_id:values.task}));
  else if(command==='answer') output(await localCall(dir,'dots_message',{task_id:values.task,question_id:values.question,answer:values.answer}));
  else if(command==='ack') output(await localCall(dir,'dots_ack_result',{task_id:values.task,result_id:values.result}));
  else if(command==='evidence') output(await localCall(dir,'evidence',{}));
  else throw new ProbeError('unknown_command');
} catch(e) {
  process.stderr.write(JSON.stringify({error:e instanceof ProbeError?e.code:(e as NodeJS.ErrnoException).code==='ENOENT'?'run_init_first':'probe_operation_failed'})+'\n');
  process.exitCode=1;
}
