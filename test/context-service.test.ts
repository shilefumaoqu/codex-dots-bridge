import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { ContextService, migrateContextStorage } from '../src/context-service.js';
import { historyReadScheduler } from '../src/read-scheduler.js';
import { DesktopConversationsService } from '../src/desktop-conversations.js';
import type { ContextReadInput, ContextReadBatch } from '../src/context-reader.js';
import type { ContextGetResult, ContextState } from '../src/context-contract.js';

const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
const empty=():ContextState=>({task:[],requirements:[],completed:[],pending:[],execution:[],gaps:[]});
function fixture(custom?:(input:ContextReadInput)=>Promise<ContextReadBatch>, options={}) {
  const home=mkdtempSync(join(process.cwd(),'test','.context-service-fixture-')), db=new Database(':memory:'), thread=randomUUID(),turn=randomUUID();mkdirSync(join(home,'sessions'));
  const config={enabled:true,mode:'local',codex_home:home,read:true,send:false};let reads=0;
  const batch=(input:ContextReadInput,text='PUBLIC',count=1):ContextReadBatch=>{
    const identity={threadId:input.threadId,codexHome:home,rolloutPath:join(home,'sessions',`rollout-${input.threadId}.jsonl`),identityHash:digest(input.threadId)};
    const items=Array.from({length:count},(_,index)=>({id:`item-${index}`,type:'agentMessage',text:text+index,fingerprint:digest(text+index),source_ref:`${input.threadId}/${turn}/item-${index}/${digest(text+index)}`,truncated:false,textOffset:0,totalTextLength:text.length+String(index).length}));
    return {sourceIdentity:identity,observation:{startedAt:new Date().toISOString(),finishedAt:new Date().toISOString()},turns:[{turnId:turn,status:'completed',fingerprint:digest(text),items,itemIds:items.map(item=>item.id),complete:true,replaceItems:true}],gaps:[{code:'history_generation_unavailable'}],watermark:{version:1,sourceIdentity:identity,index:[{turnId:turn,status:'completed',fingerprint:digest(text)}],indexComplete:true,headTurnId:turn,unfinishedTurnIds:[],turnFingerprints:{[turn]:digest(text)},observedAt:new Date().toISOString()},coverage:{indexComplete:true,historyComplete:true,observedStable:true,historicalEditsDetectable:false},invalidated:false,metrics:{rpcCount:1,sourceBytes:text.length,evidenceBytes:text.length,indexTurns:1,excludedItems:0}};
  };
  const reader=async(input:ContextReadInput)=>{reads++;return custom?custom(input):batch(input);};
  const service=new ContextService(db,config,{reader,timeoutMs:1000,...options});
  const get=(request_id=randomUUID(),args={})=>service.get({request_id,thread_id:thread,wait_seconds:1,...args});
  const update=(result:ContextGetResult,state=empty(),args={})=>service.update({operation_id:randomUUID(),thread_id:thread,expected_epoch:result.epoch,expected_revision:result.revision,read_receipt_id:result.read_receipt_id,state,...args});
  return {home,db,thread,turn,config,service,get,update,batch,reader,reads:()=>reads,async cleanup(){await service.close();db.close();rmSync(home,{recursive:true,force:true});}};
}
test('fixed requests, receipts, semantic status and CAS remain distinct',async()=>{
  const f=fixture();try{
    const request=randomUUID(), result=await f.get(request);assert.equal(result.status,'ready');assert.equal(result.owner_observation.status,'unknown');assert.equal(f.reads(),1);
    assert.deepEqual(await f.get(request),result);assert.equal(f.reads(),1);
    await assert.rejects(f.get(request,{mode:'evidence'}),/request_binding_conflict/);
    const state=empty();state.completed.push({id:'done',text:'caller says complete',classification:'reported',source_refs:[result.evidence![0]!.ref]});
    const operation_id=randomUUID(),args={operation_id,processed_refs:[result.evidence![0]!.ref]};const first=f.update(result,state,args);
    assert.equal(first.revision,1);assert.equal(first.coverage!.continuous,true);assert.deepEqual(f.update(result,state,args),first);
    assert.throws(()=>f.update(result,empty(),{operation_id}),/operation_binding_conflict/);
    assert.throws(()=>f.update(result,state),/context_version_conflict/);
    const frozen=await f.get(request);assert.equal(frozen.revision,0);assert.equal(frozen.state,null);
    assert.equal((await f.get(randomUUID(),{mode:'view'})).revision,1);
  }finally{await f.cleanup();}
});
test('concurrent writers use CAS and receipts reject other thread and home',async()=>{
  const f=fixture();try{
    const a=await f.get(),b=await f.get();f.update(a);
    assert.throws(()=>f.update(b),/context_version_conflict/);
    const other=await f.get(randomUUID(),{thread_id:randomUUID()});
    assert.throws(()=>f.update({...other,revision:1}),/receipt_binding_conflict/);
    const home2=mkdtempSync(join(process.cwd(),'test','.context-service-other-'));
    const otherService=new ContextService(f.db,{...f.config,codex_home:home2},{reader:f.reader});
    try {assert.throws(()=>otherService.update({operation_id:randomUUID(),thread_id:f.thread,expected_epoch:0,expected_revision:0,read_receipt_id:b.read_receipt_id,state:empty()}),/receipt_binding_conflict/);}finally{await otherService.close();rmSync(home2,{recursive:true,force:true});}
  }finally{await f.cleanup();}
});
test('unseen pages cannot contribute refs or continuous watermark',async()=>{
  let f:ReturnType<typeof fixture>;f=fixture(async input=>f.batch(input,'X'.repeat(9000),3),{pageChars:4096});
  try{
    const request=randomUUID(), result=await f.get(request);assert(result.delivery_cursor);assert.equal(result.coverage!.delivered_refs.length,0);
    assert.throws(()=>f.update(result,empty(),{processed_refs:result.coverage!.fetched_refs}),/processed_ref_not_delivered/);
    const claimed=empty();claimed.completed.push({id:'claimed',text:'complete',classification:'reported',source_refs:[result.coverage!.fetched_refs[0]!]});assert.throws(()=>f.update(result,claimed),/source_ref_not_delivered/);
    let current=result;while(current.delivery_cursor)current=await f.get(request,{delivery_cursor:current.delivery_cursor});
    assert.equal(current.coverage!.delivery_complete,true);assert.equal(current.coverage!.delivered_refs.length,3);
    assert.equal(f.update(current,empty(),{processed_refs:current.coverage!.fetched_refs}).coverage!.continuous,true);
  }finally{await f.cleanup();}
});
test('partially fetched history never advances watermark despite caller complete claim',async()=>{
  let f:ReturnType<typeof fixture>;f=fixture(async input=>{const batch=f.batch(input);batch.coverage.historyComplete=false;batch.gaps.push({code:'batch_limit'});return batch;});
  try{const result=await f.get();assert.equal(result.status,'partial');const updated=f.update(result,empty(),{processed_refs:result.coverage!.fetched_refs});assert.equal(updated.coverage!.continuous,false);assert.equal(updated.coverage!.processed_watermark,undefined);}finally{await f.cleanup();}
});
test('restart marks unfinished jobs reconciliation_required',async()=>{
  const f=fixture(()=>new Promise(()=>{}));try{
    const request=randomUUID();assert.equal((await f.get(request,{wait_seconds:0})).status,'pending');await f.service.close();
    const restarted=new ContextService(f.db,f.config,{reader:f.reader});try{assert.equal((await restarted.get({request_id:request,thread_id:f.thread})).status,'reconciliation_required');}finally{await restarted.close();}
  }finally{await f.cleanup();}
});
for(const normalizedStorage of [false,true]) test(`forget persists epoch tombstone and late reader cannot resurrect body (normalized=${normalizedStorage})`,async()=>{
  let release!:(value:ContextReadBatch)=>void;let input!:ContextReadInput;
  const f=fixture(i=>{input=i;return new Promise(resolve=>{release=resolve;});},{normalizedStorage});try{
    const request=randomUUID(),pending=await f.get(request,{wait_seconds:0});
    const forgotten=f.service.forget({operation_id:randomUUID(),thread_id:f.thread,expected_epoch:0,expected_revision:0});assert.equal(forgotten.epoch,1);
    release(f.batch(input,'SECRET_LATE_BODY'));await new Promise(resolve=>setImmediate(resolve));assert.equal((await f.get(request)).status,'forgotten');
    const content=JSON.stringify(f.db.prepare('SELECT data FROM context_jobs').all());assert(!content.includes('SECRET_LATE_BODY'));
    if(normalizedStorage)assert.equal((f.db.prepare('SELECT count(*) AS n FROM context_receipt_pages').get() as {n:number}).n,0);
    assert.equal((await f.get(randomUUID(),{mode:'view'})).epoch,1);assert.equal(pending.epoch,0);
  }finally{await f.cleanup();}
});
test('read gate requires local+enabled+read, never send-only or legacy',async()=>{
  const f=fixture();try{
    for(const config of [undefined,{...f.config,enabled:false,read:false},{...f.config,read:false,send:true},{enabled:true,targets:[{thread_id:f.thread,rollout_path:join(f.home,'sessions','source.jsonl')}]}]){
      const service=new ContextService(f.db,config);try{assert.equal(service.enabled,false);await assert.rejects(service.get({request_id:randomUUID(),thread_id:f.thread}),/context_read_disabled/);}finally{await service.close();}
    }
  }finally{await f.cleanup();}
});
test('same item updates and complete replacement invalidate earlier content refs',async()=>{
  let text='first';let f:ReturnType<typeof fixture>;f=fixture(async input=>f.batch(input,text));try{
    const first=await f.get();const state=empty();state.task.push({id:'task',text:'first',classification:'reported',source_refs:[first.evidence![0]!.ref]});f.update(first,state);
    text='updated';const newer=await f.get();assert.notEqual(newer.evidence![0]!.ref,first.evidence![0]!.ref);assert.throws(()=>f.update(newer,state),/source_ref_not_delivered/);
    const valid=empty();valid.task.push({...state.task[0]!,source_refs:[newer.evidence![0]!.ref]});assert.equal(f.update(newer,valid).revision,2);
  }finally{await f.cleanup();}
});
test('source identity changes remove trusted basis refs',async()=>{
  let changed=false;let f:ReturnType<typeof fixture>;f=fixture(async input=>{const batch=f.batch(input);if(changed){batch.sourceIdentity.identityHash=digest('new_source');batch.invalidated=true;}return batch;});try{
    const first=await f.get();f.update(first,empty(),{processed_refs:first.coverage!.fetched_refs});changed=true;const next=await f.get();assert.equal(next.basis_valid,false);assert.equal(next.status,'ready');assert.equal(next.state,null);assert.equal(f.update(next,empty(),{processed_refs:next.coverage!.fetched_refs}).coverage!.continuous,true);
  }finally{await f.cleanup();}
});
test('timeout yields explicit partial and no arbitrary error content',async()=>{
  const f=fixture(()=>new Promise(()=>{}),{timeoutMs:10});try{const result=await f.get();assert.equal(result.status,'partial');assert.equal(result.reason,'read_timeout');}finally{await f.cleanup();}
});
test('multi-batch continuation advances only after every earlier batch was processed',async()=>{
  for(const processFirst of [false,true]) {
    let f:ReturnType<typeof fixture>;f=fixture(async input=>{
      const batch=f.batch(input,input.continuation?'last':'first');
      if(!input.continuation){batch.coverage.historyComplete=false;batch.gaps.push({code:'batch_limit'});batch.continuation={version:1,sourceIdentity:batch.sourceIdentity,index:batch.watermark.index,indexComplete:true,pendingTurnIds:[f.turn],startedAt:batch.observation.startedAt};}
      return batch;
    });
    try {
      const first=await f.get();if(!processFirst){await assert.rejects(f.get(randomUUID(),{continuation_token:first.continuation_token}),/continuation_requires_update/);continue;}f.update(first,empty(),{processed_refs:first.coverage!.fetched_refs});
      const last=await f.get(randomUUID(),{continuation_token:first.continuation_token});
      const updated=f.update(last,empty(),{processed_refs:last.coverage!.fetched_refs});
      assert.equal(updated.coverage!.continuous,processFirst);
      if(processFirst)assert(updated.coverage!.processed_watermark);
    }finally{await f.cleanup();}
  }
});

test('legacy continuation tokens are indexed on open and one matching job is read across restart and forget',async()=>{
  let f:ReturnType<typeof fixture>;
  f=fixture(async input=>{
    const batch=f.batch(input,input.continuation?'last':'first');
    if(!input.continuation){batch.coverage.historyComplete=false;batch.gaps.push({code:'batch_limit'});batch.continuation={version:1,sourceIdentity:batch.sourceIdentity,index:batch.watermark.index,indexComplete:true,pendingTurnIds:[f.turn],startedAt:batch.observation.startedAt};}
    return batch;
  });
  let reopened:ContextService|undefined;
  try {
    const firstId=randomUUID(),first=await f.get(firstId);f.update(first,empty(),{processed_refs:first.coverage!.fetched_refs});
    const source=f.db.prepare('SELECT scope,thread,data FROM context_jobs WHERE id=?').get(firstId) as {scope:string;thread:string;data:string};
    const history=JSON.parse(source.data);delete history.continuation_token;
    const insert=f.db.prepare('INSERT INTO context_jobs(id,scope,thread,data) VALUES(?,?,?,?)');
    f.db.transaction(()=>{for(let i=0;i<2000;i++)insert.run(randomUUID(),source.scope,source.thread,JSON.stringify(history));})();
    await f.service.close();
    f.db.exec('DROP INDEX context_jobs_continuation; ALTER TABLE context_jobs DROP COLUMN continuation_token');
    reopened=new ContextService(f.db,f.config,{reader:f.reader,timeoutMs:1000});
    assert.equal((f.db.prepare('SELECT data FROM context_jobs WHERE id=?').get(firstId) as {data:string}).data,source.data);
    const sql='SELECT data FROM context_jobs WHERE scope=? AND thread=? AND continuation_token=? LIMIT 1';
    assert.match(JSON.stringify(f.db.prepare('EXPLAIN QUERY PLAN '+sql).all(source.scope,f.thread,first.continuation_token)),/SEARCH.*context_jobs_continuation/);
    let selected=0;
    const prepare=f.db.prepare.bind(f.db);
    (f.db as any).prepare=(query:string)=>{
      const statement=prepare(query);
      if(query===sql){const get=statement.get.bind(statement);(statement as any).get=(...args:unknown[])=>{const row=get(...args);if(row)selected++;return row;};}
      return statement;
    };
    const last=await reopened.get({request_id:randomUUID(),thread_id:f.thread,continuation_token:first.continuation_token,wait_seconds:1});
    assert.equal(last.status,'ready');assert.equal(selected,1);
    await assert.rejects(reopened.get({request_id:randomUUID(),thread_id:randomUUID(),continuation_token:first.continuation_token}),/continuation_invalid/);
    reopened.forget({operation_id:randomUUID(),thread_id:f.thread,expected_epoch:0,expected_revision:1});
    await assert.rejects(reopened.get({request_id:randomUUID(),thread_id:f.thread,continuation_token:first.continuation_token}),/continuation_invalid/);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM context_jobs WHERE continuation_token IS NOT NULL').get() as {n:number}).n,0);
  }finally{await reopened?.close();await f.cleanup();}
});
test('forget removes derived, receipt, operation and job-snapshot bodies and rejects stale update',async()=>{
  const f=fixture();try{
    const first=await f.get();const state=empty();state.task.push({id:'task',text:'SECRET_DERIVED_BODY',classification:'reported',source_refs:[first.evidence![0]!.ref]});
    const operation_id=randomUUID();f.update(first,state,{operation_id});
    await f.get(randomUUID(),{mode:'view'});
    const forget={operation_id:randomUUID(),thread_id:f.thread,expected_epoch:0,expected_revision:1};const result=f.service.forget(forget);assert.deepEqual(f.service.forget(forget),result);
    for(const table of ['context_current','context_jobs','context_receipts','context_operations']){assert(!JSON.stringify(f.db.prepare(`SELECT * FROM ${table}`).all()).includes('SECRET_DERIVED_BODY'));}
    assert.throws(()=>f.update(first,state,{operation_id}),/context_version_conflict/);
    const newResult=await f.get();assert.equal(newResult.epoch,1);assert.equal(newResult.revision,0);assert.equal(f.update(newResult).revision,1);
  }finally{await f.cleanup();}
});
test('evidence offsets are bound to fixed request and sent only to exact target item',async()=>{
  let seen:ContextReadInput|undefined;let f:ReturnType<typeof fixture>;f=fixture(async input=>{seen=input;return f.batch(input);});try{
    const base=await f.get(),request=randomUUID();await f.get(request,{mode:'evidence',refs:[base.evidence![0]!.ref],evidence_offset:4096});assert.equal(seen?.evidence?.offset,4096);
    await assert.rejects(f.get(request,{mode:'evidence',refs:[base.evidence![0]!.ref],evidence_offset:8192}),/request_binding_conflict/);
  }finally{await f.cleanup();}
});
test('UTF-16 delivery fragments preserve surrogate pairs exactly',async()=>{
  let f:ReturnType<typeof fixture>;const text='汉'.repeat(2047)+'🌟'.repeat(6000);f=fixture(async input=>f.batch(input,text),{pageChars:4096});try{
    const request=randomUUID();let result=await f.get(request),collected=result.evidence![0]!.text;
    while(result.delivery_cursor){result=await f.get(request,{delivery_cursor:result.delivery_cursor});collected+=result.evidence!.map(item=>item.text).join('');}
    assert.equal(collected,text+'0');assert.equal(result.coverage!.delivered_refs.length,1);
  }finally{await f.cleanup();}
});
test('later continuation cannot erase earlier missing-content gap',async()=>{
  let f:ReturnType<typeof fixture>;f=fixture(async input=>{const batch=f.batch(input,input.continuation?'last':'first');if(!input.continuation){batch.coverage.historyComplete=false;batch.gaps.push({code:'attachment_unavailable'});batch.continuation={version:1,sourceIdentity:batch.sourceIdentity,index:batch.watermark.index,indexComplete:true,pendingTurnIds:[f.turn],startedAt:batch.observation.startedAt};}return batch;});
  try{const first=await f.get();f.update(first,empty(),{processed_refs:first.coverage!.fetched_refs});const final=await f.get(randomUUID(),{continuation_token:first.continuation_token});assert(final.coverage!.gaps.includes('attachment_unavailable'));assert.equal(f.update(final,empty(),{processed_refs:final.coverage!.fetched_refs}).coverage!.continuous,false);}finally{await f.cleanup();}
});
test('completed business receipts remain retrievable beyond the former cache retention limit',async()=>{
  const f=fixture();try{const id=randomUUID(), first=await f.get(id);for(let n=0;n<17;n++)await f.get();assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM context_receipts').get() as {n:number}).n,18);assert.deepEqual(await f.get(id),first);assert.equal(f.reads(),18);}finally{await f.cleanup();}
});
test('known compaction and image exclusions retain limited reusable coverage and reduce later reads',async()=>{
  let f:ReturnType<typeof fixture>,coldItems=0,warmItems=0;f=fixture(async input=>{
    const batch=f.batch(input,input.previous?'latest':'full',input.previous?1:30);
    batch.coverage.historyComplete=false;batch.coverage.projectionComplete=true;
    if(!input.previous){batch.gaps.push({code:'compaction_body_unavailable'},{code:'attachment_body_unavailable'});coldItems=batch.turns[0]!.items.length;}else warmItems=batch.turns[0]!.items.length;
    return batch;
  });try{
    const first=await f.get();assert.equal(first.coverage!.source_complete,false);assert.equal(first.coverage!.public_history_complete,false);assert.equal(first.coverage!.public_projection_complete,true);
    const updated=f.update(first,empty(),{processed_refs:first.coverage!.fetched_refs});assert.equal(updated.coverage!.continuous,true);assert.equal(updated.coverage!.limited,true);
    const next=await f.get();assert.equal(next.coverage!.limited,true);assert(next.coverage!.gaps.includes('compaction_body_unavailable'));assert(next.coverage!.gaps.includes('attachment_body_unavailable'));assert(warmItems<coldItems);
  }finally{await f.cleanup();}
});
test('missing items invalidate refs only after a complete replaceable turn snapshot',async()=>{
  for(const replace of [false,true]){let omit=false;let f:ReturnType<typeof fixture>;f=fixture(async input=>{const batch=f.batch(input);if(omit){batch.turns[0]!.items=[];batch.turns[0]!.itemIds=[];batch.turns[0]!.replaceItems=replace;}return batch;});try{
    const first=await f.get();const state=empty();state.task.push({id:'task',text:'keep until verified absent',classification:'reported',source_refs:[first.evidence![0]!.ref]});f.update(first,state);omit=true;const next=await f.get();
    if(replace)assert.throws(()=>f.update(next,state),/source_ref_not_delivered/);else assert.equal(f.update(next,state).status,'updated');
  }finally{await f.cleanup();}}
});
test('same-ref text continuation checks each batch processing and resolves truncation at final fragment',async()=>{
  for(const processMiddle of [false,true]){
    let f:ReturnType<typeof fixture>,n=0;f=fixture(async input=>{const batch=f.batch(input,'whole-text');const item=batch.turns[0]!.items[0]!;const part=n++;item.text=['first','middle','last'][part]!;item.textOffset=part*5;item.totalTextLength=15;item.truncated=true;batch.turns[0]!.replaceItems=false;
      batch.coverage.historyComplete=part===2;batch.coverage.projectionComplete=part===2;if(part<2){batch.gaps.push({code:'item_text_truncated'});batch.continuation={version:1,sourceIdentity:batch.sourceIdentity,index:batch.watermark.index,indexComplete:true,pendingTurnIds:[f.turn],startedAt:batch.observation.startedAt,currentItem:{turnId:f.turn,itemId:item.id,fingerprint:item.fingerprint,nextOffset:(part+1)*5}};}return batch;});
    try{const first=await f.get();f.update(first,empty(),{processed_refs:first.coverage!.fetched_refs});const middle=await f.get(randomUUID(),{continuation_token:first.continuation_token});if(!processMiddle){await assert.rejects(f.get(randomUUID(),{continuation_token:middle.continuation_token}),/continuation_requires_update/);continue;}f.update(middle,empty(),{processed_refs:middle.coverage!.fetched_refs});const last=await f.get(randomUUID(),{continuation_token:middle.continuation_token});assert(!last.coverage!.gaps.includes('item_text_truncated'));assert.equal(f.update(last,empty(),{processed_refs:last.coverage!.fetched_refs}).coverage!.continuous,processMiddle);}finally{await f.cleanup();}
  }
});
test('consumer progress must target its actual thread and provenance never redirects writes',async()=>{
  const f=fixture();try{
    const result=await f.get(),newConsumer=randomUUID();const state=empty();state.consumer_thread_id=newConsumer;state.derived_from=f.thread;
    assert.throws(()=>f.update(result,state),/consumer_thread_mismatch/);
    state.consumer_thread_id=f.thread;state.derived_from=newConsumer;assert.equal(f.update(result,state).thread_id,f.thread);
    assert.equal((await f.get(randomUUID(),{thread_id:newConsumer,mode:'view'})).state,null);
  }finally{await f.cleanup();}
});
test('review regression: a continuation requires delivered and committed preceding evidence',async()=>{
  let f:ReturnType<typeof fixture>;f=fixture(async input=>{const batch=f.batch(input,input.continuation?'last':'first',input.continuation?1:3);if(!input.continuation){batch.coverage.projectionComplete=false;batch.coverage.historyComplete=false;batch.continuation={version:1,sourceIdentity:batch.sourceIdentity,index:batch.watermark.index,indexComplete:true,pendingTurnIds:[f.turn],startedAt:batch.observation.startedAt};}return batch;});try{
    const first=await f.get();assert.equal(first.coverage!.delivery_complete,true);
    await assert.rejects(f.get(randomUUID(),{continuation_token:first.continuation_token}),/continuation_requires_update/);
    f.update(first,empty(),{processed_refs:first.coverage!.fetched_refs});const next=await f.get(randomUUID(),{continuation_token:first.continuation_token});assert.equal(next.revision,1);
  }finally{await f.cleanup();}
});
test('review regression: resolved time or observation gaps allow a warm verified watermark',async()=>{
  for(const code of ['context_time_budget','source_changed_during_read','turn_changed_during_read','continuation_turn_changed','observation_boundary_unverified']){let sawWarm=false;let f:ReturnType<typeof fixture>;f=fixture(async input=>{if(input.previous)sawWarm=true;const batch=f.batch(input);if(!input.continuation&&!input.previous){batch.coverage.historyComplete=false;batch.coverage.projectionComplete=false;batch.gaps.push({code});batch.continuation={version:1,sourceIdentity:batch.sourceIdentity,index:batch.watermark.index,indexComplete:true,pendingTurnIds:[f.turn],startedAt:batch.observation.startedAt};}return batch;});try{
    const first=await f.get();f.update(first,empty(),{processed_refs:first.coverage!.fetched_refs});const final=await f.get(randomUUID(),{continuation_token:first.continuation_token});assert(!final.coverage!.gaps.includes(code));assert.equal(f.update(final,empty(),{processed_refs:final.coverage!.fetched_refs}).coverage!.continuous,true);await f.get();assert.equal(sawWarm,true);
  }finally{await f.cleanup();}}
});
test('review regression: sequential committed batches retain earlier requirements in cumulative state',async()=>{
  let f:ReturnType<typeof fixture>;f=fixture(async input=>{const batch=f.batch(input,input.continuation?'later evidence':'earlier requirement');if(!input.continuation){batch.coverage.historyComplete=false;batch.coverage.projectionComplete=false;batch.continuation={version:1,sourceIdentity:batch.sourceIdentity,index:batch.watermark.index,indexComplete:true,pendingTurnIds:[f.turn],startedAt:batch.observation.startedAt};}else{const item=batch.turns[0]!.items[0]!;item.id='later-item';item.source_ref=`${input.threadId}/${f.turn}/${item.id}/${item.fingerprint}`;batch.turns[0]!.itemIds=[item.id];batch.turns[0]!.replaceItems=false;}return batch;});try{
    const first=await f.get();const state=empty();state.requirements.push({id:'requirement',text:'earlier required constraint',classification:'reported',source_refs:[first.evidence![0]!.ref]});f.update(first,state,{processed_refs:first.coverage!.fetched_refs});
    const last=await f.get(randomUUID(),{continuation_token:first.continuation_token});state.pending.push({id:'next',text:'later next step',classification:'reported',source_refs:[last.evidence![0]!.ref]});const saved=f.update(last,state,{processed_refs:last.coverage!.fetched_refs});assert.equal(saved.coverage!.continuous,true);assert.equal((await f.get(randomUUID(),{mode:'view'})).state!.requirements[0]!.text,'earlier required constraint');
  }finally{await f.cleanup();}
});
test('review regression: item collection metadata invalidates deleted refs during text splitting',async()=>{
  let split=false;let f:ReturnType<typeof fixture>;f=fixture(async input=>{const batch=f.batch(input);if(split){batch.turns[0]!.items=[];batch.turns[0]!.itemIds=['remaining-new-item'];batch.turns[0]!.replaceItems=false;batch.turns[0]!.complete=false;batch.turns[0]!.itemSetVerified=true;batch.turns[0]!.itemFingerprints={'remaining-new-item':digest('remaining')};}return batch;});try{
    const first=await f.get();const state=empty();state.requirements.push({id:'old',text:'deleted requirement',classification:'reported',source_refs:[first.evidence![0]!.ref]});f.update(first,state);split=true;const last=await f.get();assert.throws(()=>f.update(last,state),/source_ref_not_delivered/);
  }finally{await f.cleanup();}
});
test('review regression: source continuation is denied before all delivery pages arrive',async()=>{
  let f:ReturnType<typeof fixture>;f=fixture(async input=>{const batch=f.batch(input,'X'.repeat(9000));batch.coverage.historyComplete=false;batch.coverage.projectionComplete=false;batch.continuation={version:1,sourceIdentity:batch.sourceIdentity,index:batch.watermark.index,indexComplete:true,pendingTurnIds:[f.turn],startedAt:batch.observation.startedAt};return batch;},{pageChars:4096});try{
    const first=await f.get();assert.equal(first.coverage!.delivery_complete,false);await assert.rejects(f.get(randomUUID(),{continuation_token:first.continuation_token}),/continuation_requires_delivery/);
  }finally{await f.cleanup();}
});
test('review regression: complete stable source rebuild resolves obsolete basis notices',async()=>{
  let rebuild=false;let f:ReturnType<typeof fixture>;f=fixture(async input=>{const batch=f.batch(input,rebuild?'rebuilt':'original');if(rebuild){batch.invalidated=true;batch.sourceIdentity.identityHash=digest('replacement-source');batch.gaps.push({code:'source_identity_changed'},{code:'history_anchor_missing_or_rollback'});}return batch;});try{
    const first=await f.get();f.update(first,empty(),{processed_refs:first.coverage!.fetched_refs});rebuild=true;const next=await f.get();assert.equal(next.basis_valid,false);assert.equal(next.state,null);assert(next.coverage!.resolved_gaps!.includes('basis_invalidated'));assert.equal(f.update(next,empty(),{processed_refs:next.coverage!.fetched_refs}).coverage!.continuous,true);
  }finally{await f.cleanup();}
});





test('normalized delivery stores body once and never rewrites immutable pages or receipt metadata',async()=>{
  let f:ReturnType<typeof fixture>;f=fixture(async input=>f.batch(input,'X'.repeat(11000)+'🌟',2),{pageChars:4096,normalizedStorage:true});
  try{
    const id=randomUUID();let result=await f.get(id);assert(result.delivery_cursor);
    const metadata=f.db.prepare('SELECT data FROM context_receipts WHERE id=?').get(result.read_receipt_id) as {data:string};
    assert(!metadata.data.includes('X'.repeat(100)));
    const pages=f.db.prepare('SELECT page,data FROM context_receipt_pages WHERE receipt_id=? ORDER BY page').all(result.read_receipt_id);
    const immutable=JSON.stringify(pages);let received=result.evidence!.map(item=>item.text).join('');
    while(result.delivery_cursor){result=await f.get(id,{delivery_cursor:result.delivery_cursor});received+=result.evidence!.map(item=>item.text).join('');}
    assert.equal(received,('X'.repeat(11000)+'🌟0')+('X'.repeat(11000)+'🌟1'));
    assert.equal(result.coverage!.delivery_complete,true);assert.equal(result.coverage!.delivered_refs.length,2);
    assert.equal((f.db.prepare('SELECT data FROM context_receipts WHERE id=?').get(result.read_receipt_id) as {data:string}).data,metadata.data);
    assert.equal(JSON.stringify(f.db.prepare('SELECT page,data FROM context_receipt_pages WHERE receipt_id=? ORDER BY page').all(result.read_receipt_id)),immutable);
    assert.equal(f.update(result,empty(),{processed_refs:result.coverage!.fetched_refs}).coverage!.continuous,true);
    assert.equal((f.db.prepare('SELECT processed FROM context_receipt_progress WHERE receipt_id=?').get(result.read_receipt_id) as {processed:number}).processed,1);
    f.service.forget({operation_id:randomUUID(),thread_id:f.thread,expected_epoch:0,expected_revision:1});
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM context_receipt_pages').get() as {n:number}).n,0);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM context_receipt_progress').get() as {n:number}).n,0);
  }finally{await f.cleanup();}
});

test('explicit context migration preserves old cursor, partial delivery, fixed identity and processed state',async()=>{
  let f:ReturnType<typeof fixture>;f=fixture(async input=>f.batch(input,'Y'.repeat(11000)),{pageChars:4096});
  try{
    const id=randomUUID(),first=await f.get(id);assert(first.delivery_cursor);await f.service.close();
    f.db.transaction(()=>migrateContextStorage(f.db))();migrateContextStorage(f.db);
    const restarted=new ContextService(f.db,f.config,{reader:f.reader,normalizedStorage:true,pageChars:4096});
    try{
      assert.deepEqual(await restarted.get({request_id:id,thread_id:f.thread}),first);
      let result=first;
      while(result.delivery_cursor)result=await restarted.get({request_id:id,thread_id:f.thread,delivery_cursor:result.delivery_cursor});
      assert.equal(result.coverage!.delivery_complete,true);assert.equal(f.reads(),1);
      const saved=restarted.update({operation_id:randomUUID(),thread_id:f.thread,expected_epoch:0,expected_revision:0,read_receipt_id:result.read_receipt_id,state:empty(),processed_refs:result.coverage!.fetched_refs});
      assert.equal(saved.coverage!.continuous,true);
    }finally{await restarted.close();}
  }finally{await f.cleanup();}
});

test('context capacity rejects before persistence and queued cancellation never runs source',async()=>{
  const releases:Array<()=>void>=[];let f:ReturnType<typeof fixture>;
  f=fixture(async input=>{await new Promise<void>(resolve=>releases.push(resolve));return f.batch(input);});
  try{
    for(let i=0;i<18;i++)await f.get(randomUUID(),{wait_seconds:0});
    assert.equal(f.reads(),2);assert.equal(historyReadScheduler(f.db).status.queued,16);
    const rejected=randomUUID();await assert.rejects(f.get(rejected,{wait_seconds:0}),/history_read_capacity/);
    assert.equal(f.db.prepare('SELECT 1 FROM context_jobs WHERE id=?').get(rejected),undefined);
    const closing=f.service.close();releases.forEach(release=>release());await closing;
    assert.equal(f.reads(),2);assert.equal(historyReadScheduler(f.db).status.active,0);
    assert.equal(historyReadScheduler(f.db).status.queued,0);
  }finally{await f.cleanup();}
});

test('full history and context share two source slots and sixteen queued admissions',async()=>{
  let active=0,peak=0,started=0;
  const block=async(signal:AbortSignal)=>{
    started++;active++;peak=Math.max(peak,active);
    try{await new Promise<void>((_,reject)=>{if(signal.aborted)reject(Error('closed'));else signal.addEventListener('abort',()=>reject(Error('closed')),{once:true});});}
    finally{active--;}
  };
  const f=fixture(async input=>{await block(input.signal);return f.batch(input);});
  const desktop=new DesktopConversationsService(f.db,f.config,{transport:{runRead:async input=>{await block(input.signal);return {status:'completed',context_json:'{}',source_complete:false};},runSend:async()=>assert.fail('read admission must never send')}});
  try{
    await f.get(randomUUID(),{wait_seconds:0});
    desktop.read({request_id:randomUUID(),thread_id:f.thread});
    for(let i=0;i<16;i++) {
      if(i%2===0)await f.get(randomUUID(),{wait_seconds:0});
      else desktop.read({request_id:randomUUID(),thread_id:f.thread});
    }
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(started,2);assert.equal(peak,2);assert.deepEqual(historyReadScheduler(f.db).status,{active:2,queued:16,capacity:18});
    const contextRejected=randomUUID(),desktopRejected=randomUUID();
    await assert.rejects(f.get(contextRejected,{wait_seconds:0}),/history_read_capacity/);
    assert.throws(()=>desktop.read({request_id:desktopRejected,thread_id:f.thread}),/history_read_capacity/);
    assert.equal(f.db.prepare('SELECT 1 FROM context_jobs WHERE id=?').get(contextRejected),undefined);
    assert.equal(f.db.prepare('SELECT 1 FROM desktop_conversation_requests WHERE request_id=?').get(desktopRejected),undefined);
    await Promise.all([f.service.close(),desktop.close()]);
    assert.equal(started,2);assert.equal(active,0);assert.deepEqual(historyReadScheduler(f.db).status,{active:0,queued:0,capacity:18});
  }finally{await desktop.close();await f.cleanup();}
});
