import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { TaskStore } from '../src/task-store.js';
import { ProbeEvents } from '../src/events.js';
import { createProductionService, VERSION } from '../src/bridge.js';
import { DesktopConversationsService } from '../src/desktop-conversations.js';
import { ContextService } from '../src/context-service.js';

const tokens = {caller:'PRIVATE_CALLER_TOKEN',worker:'PRIVATE_WORKER_TOKEN'};
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_,reject)=>{
    const abort=()=>reject(Object.assign(new Error('read_cancelled'),{code:'read_cancelled'}));
    if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
  });
}
function fixture(reads=false,identified=true) {
  const home=mkdtempSync(join(tmpdir(),'dots-runtime-resources-')), store=new TaskStore(':memory:');
  const instance=identified?randomUUID():undefined;
  const config={enabled:true,mode:'local',codex_home:home,read:true,send:true};
  let sources=0;
  const desktop=reads?new DesktopConversationsService(store.db,config,{transport:{
    async runRead(input) {sources++;return untilAborted(input.signal);},
    async runSend() {assert.fail('resource queries must not send');},
  }}):undefined;
  const context=reads?new ContextService(store.db,config,{reader:async input=>{sources++;return untilAborted(input.signal);}}):undefined;
  const events=new ProbeEvents(store,async()=>assert.fail('resource queries must not deliver events'),'tasks');
  const service=createProductionService(store,events,tokens,()=>assert.fail('resource queries must not probe runtime'),undefined,instance,undefined,desktop,context);
  const query=(payload:unknown={},headers:Record<string,string>={})=>service.app.inject({method:'POST',url:'/control/resources',
    headers:{host:'localhost',authorization:'Bearer '+tokens.caller,...headers},payload});
  return {home,store,instance,desktop,context,query,sources:()=>sources,async close(){
    await service.close();store.close();
    const name=relative(tmpdir(),home);assert(name.startsWith('dots-runtime-resources-')&&!isAbsolute(name)&&!name.startsWith('..'));
    rmSync(home,{recursive:true,force:true});
  }};
}

test('resource projection requires caller authentication and reports absent components explicitly',async()=>{
  const f=fixture(),unidentified=fixture(false,false);
  try {
    const before=f.store.db.prepare('SELECT total_changes() AS n').get();
    const response=await f.query();assert.equal(response.statusCode,200);
    const body=response.json();assert.equal(body.schema_version,1);assert.equal(body.instance_id,f.instance);
    assert.equal(body.version,VERSION);assert.equal(body.process_id,process.pid);assert.equal(body.shutting_down,false);
    assert(Number.isFinite(Date.parse(body.observed_at)));
    assert.deepEqual(body.task_waiters,{groups:0,callbacks:0});
    assert.deepEqual(body.history_reads,{active:0,queued:0,capacity:18,active_limit:2,queued_limit:16});
    assert.equal(body.desktop.available,false);assert.equal(body.context.available,false);
    assert.equal(body.desktop.read_cache_limit_bytes,0);
    assert.equal((await f.query({}, {authorization:'Bearer '+tokens.worker})).statusCode,401);
    assert.equal((await f.query({}, {origin:'http://localhost'})).statusCode,403);
    assert.equal((await f.query({}, {host:'external.example'})).statusCode,403);
    assert.equal((await f.query({thread_id:randomUUID()})).statusCode,400);
    const missing=await unidentified.query();assert.equal(missing.statusCode,503);
    assert.equal(missing.json().error,'observer_identity_unconfigured');
    assert.deepEqual(f.store.db.prepare('SELECT total_changes() AS n').get(),before);
    for(const value of [tokens.caller,tokens.worker,f.home])assert(!response.body.includes(value));
  }finally{await f.close();await unidentified.close();}
});

test('live resource counts follow shared read admission and wait cancellation without querying history',async()=>{
  const f=fixture(true), controllers=Array.from({length:3},()=>new AbortController());
  const waits:Promise<void>[]=[];
  try {
    const task=f.store.submit({idempotency_key:'resource-waits',title:'PRIVATE_TITLE',input:{text:'PRIVATE_INPUT'}});
    for(const controller of controllers)waits.push(f.store.waitForChange(task.task_id,task.change_sequence,60000,controller.signal));
    const thread=randomUUID(),request=randomUUID();
    f.desktop!.read({request_id:request,thread_id:thread});
    await f.context!.get({request_id:randomUUID(),thread_id:thread,wait_seconds:0});
    await f.context!.get({request_id:randomUUID(),thread_id:thread,wait_seconds:0});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.sources(),2);
    const changes=f.store.db.prepare('SELECT total_changes() AS n').get();
    const prepare=f.store.db.prepare;
    let body:any;
    try {
      f.store.db.prepare=(()=>assert.fail('resource sampling must not query the business database')) as typeof prepare;
      for(let i=0;i<3;i++) {
        const response=await f.query();assert.equal(response.statusCode,200);body=response.json();
        assert.deepEqual(body.task_waiters,{groups:1,callbacks:3});
        assert.deepEqual(body.history_reads,{active:2,queued:1,capacity:18,active_limit:2,queued_limit:16});
        assert.equal(body.desktop.available,true);assert.equal(body.desktop.inflight_operations,1);
        assert.equal(body.desktop.read_cache_limit_bytes,128*1024*1024);
        assert.equal(body.context.available,true);assert.equal(body.context.inflight_jobs,2);
        for(const secret of [task.task_id,thread,request,'PRIVATE_TITLE','PRIVATE_INPUT',f.home,tokens.caller,tokens.worker])
          assert(!response.body.includes(secret),secret);
      }
    }finally{f.store.db.prepare=prepare;}
    assert.deepEqual(f.store.db.prepare('SELECT total_changes() AS n').get(),changes);
    assert.equal(f.sources(),2);
    controllers.forEach(controller=>controller.abort());await Promise.all(waits);
    await f.context!.close();await f.desktop!.close();
    body=(await f.query()).json();
    assert.deepEqual(body.task_waiters,{groups:0,callbacks:0});
    assert.equal(body.history_reads.active,0);assert.equal(body.history_reads.queued,0);
    assert.equal(body.desktop.inflight_operations,0);assert.equal(body.desktop.reply_observer_timers,0);
    assert.equal(body.desktop.sending_targets,0);assert.equal(body.desktop.read_cache_entries,0);
    assert.equal(body.desktop.read_cache_estimated_bytes,0);assert.equal(body.context.inflight_jobs,0);
    assert.equal(f.sources(),2,'cancelled queued reads must not start');
  }finally{controllers.forEach(controller=>controller.abort());await Promise.all(waits);await f.close();}
});
