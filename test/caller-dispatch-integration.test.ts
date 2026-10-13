import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { callControl, callerSchemas } from '../src/bridge.js';
import { DispatchContextError } from '../src/caller-dispatch.js';
import { TaskStore } from '../src/task-store.js';
import { DesktopConversationsService, type DesktopConversationsTransport } from '../src/desktop-conversations.js';

const input = (key:string) => ({idempotency_key:key,title:'Synthetic delegated request',input:{text:'Synthetic request; no external actions.'}});
const windowFor = (text:string, now=Date.now(), request=randomUUID(), thread=randomUUID()) => ({request_id:request,thread_id:thread,text_sha256:createHash('sha256').update(text).digest('hex'),not_after_utc:new Date(now+120000).toISOString()});

test('caller provenance is transactional, separate from task JSON, and retries do not refresh it',async()=>{
  let now=Date.now(); const store=new TaskStore(':memory:',()=>now);
  try {
    const args=input('caller'); const task=await callControl(store,'dots_submit',args) as ReturnType<TaskStore['submit']>;
    const before=store.get(task.task_id), context=store.dispatch.workerContext(task.task_id,task.deadline);
    assert.equal(context.dispatch_context.submission.source_kind,'authenticated_codex_caller');
    assert.equal(context.dispatch_context.submission.native_approval_granted,false);
    assert.equal(context.dispatch_context.submission.human_identity_verified,false);
    assert.equal('dispatch_context' in before,false);
    now+=1000; assert.deepEqual(await callControl(store,'dots_submit',args),JSON.parse(JSON.stringify(task)));
    assert.deepEqual(store.dispatch.workerContext(task.task_id,task.deadline).dispatch_context,context.dispatch_context);
    const message={task_id:task.task_id,message_key:'human-answer',text:'The existing scope is unchanged.'};
    const updated=await callControl(store,'dots_message',message) as ReturnType<TaskStore['message']>;
    now+=1000; assert.deepEqual(await callControl(store,'dots_message',message),JSON.parse(JSON.stringify(updated)));
    const received=store.dispatch.workerContext(task.task_id,task.deadline);
    assert.equal(received.dispatch_context.messages.length,1);
    assert.equal(received.dispatch_context.messages[0].input_revision,2);
    assert.deepEqual(received.dispatch_context.submission,context.dispatch_context.submission);
    assert.equal(callerSchemas.dots_submit.safeParse({...input('spoof'),dispatch_context:{source_kind:'human'}}).success,false);
  } finally {store.close();}
});

test('invalid or duplicated delivery windows roll back task, operation and event writes',()=>{
  const store=new TaskStore(':memory:'); const now=Date.now(), window=windowFor('echo',now);
  try {
    const initial=store.submitFromCaller({...input('valid'),delivery_window:window});
    const counts=()=>['tasks','task_operations','task_events','caller_dispatch_context'].map(table=>(store.db.prepare(`SELECT count(*) n FROM ${table}`).get() as {n:number}).n);
    const before=counts();
    assert.throws(()=>store.submitFromCaller({...input('duplicate'),delivery_window:window}),/delivery_window_request_conflict/);
    assert.deepEqual(counts(),before);
    assert.throws(()=>store.submitFromCaller({...input('expired'),delivery_window:{...window,request_id:randomUUID(),not_after_utc:new Date(now-1).toISOString()}}),/delivery_window_expired/);
    assert.deepEqual(counts(),before);
    assert.throws(()=>store.submitFromCaller({...input('valid'),delivery_window:{...window,not_after_utc:new Date(now+130000).toISOString()}}),/dispatch_submission_conflict/);
    assert.deepEqual(counts(),before);
    assert.equal(store.get(initial.task_id).status,'queued');
  } finally {store.close();}
});

test('legacy input is never retroactively attested, while a newly received caller answer is identified',()=>{
  const store=new TaskStore(':memory:');
  try {
    const args=input('legacy'), task=store.submit(args);
    store.submitFromCaller(args);
    store.messageFromCaller({task_id:task.task_id,message_key:'answer',text:'Synthetic answer.'});
    const context=store.dispatch.workerContext(task.task_id,task.deadline);
    assert.equal(context.dispatch_context.submission.source_kind,'legacy_unknown');
    assert.equal(context.dispatch_context.messages[0].source_kind,'authenticated_codex_caller');
    assert.throws(()=>store.submitFromCaller({...args,delivery_window:windowFor('echo')}),/dispatch_submission_conflict/);
  } finally {store.close();}
});

test('window sends require live ownership and latest checkpoint; ordinary direct sends stay unchanged',()=>{
  const store=new TaskStore(':memory:'), window=windowFor('echo');
  try {
    const task=store.submitFromCaller({...input('window'),delivery_window:window});
    const send={request_id:window.request_id,thread_id:window.thread_id,text:'echo',delivery_mode:'next_turn' as const};
    assert.throws(()=>store.guardDesktopDispatch(send),/delivery_task_not_running/);
    const claim=store.claim({task_id:task.task_id,claim_key:'claim'});
    assert.throws(()=>store.guardDesktopDispatch(send),/delivery_input_not_acknowledged/);
    store.checkpoint({task_id:task.task_id,claim_token:claim.claim_token,input_revision:1});
    assert.ok(store.guardDesktopDispatch(send)!.remaining_ms>0);
    store.messageFromCaller({task_id:task.task_id,message_key:'correction',text:'Retain the exact bounded echo.'});
    assert.throws(()=>store.guardDesktopDispatch(send),/delivery_input_not_acknowledged/);
    store.checkpoint({task_id:task.task_id,claim_token:claim.claim_token,input_revision:2});
    store.cancel({task_id:task.task_id,request_key:'cancel'});
    assert.throws(()=>store.guardDesktopDispatch(send),/delivery_task_not_running/);
    assert.equal(store.guardDesktopDispatch({...send,request_id:randomUUID()}),undefined);
  } finally {store.close();}
});

function desktopFixture(runSend:DesktopConversationsTransport['runSend']) {
  const store=new TaskStore(':memory:'), thread=randomUUID(), request=randomUUID(), turn=randomUUID(), home=join(tmpdir(),`synthetic-${randomUUID()}`);
  const service=new DesktopConversationsService(store.db,{enabled:true,mode:'local',read:true,send:true,codex_home:home},{timeoutMs:500,transport:{runRead:async()=>{throw Error('read must not run');},runSend}});
  return {store,service,thread,request,turn,resolved:{thread_id:thread,rollout_path:join(home,'sessions',`rollout-${thread}.jsonl`)},async close(){await service.close();store.close();}};
}

test('guard expires during target loading: beforeSend refuses and durable receipt confirms zero sends',async()=>{
  let f:ReturnType<typeof desktopFixture>, allowed=true, writes=0;
  f=desktopFixture(async transport=>{
    transport.onResolvedTarget?.(f.resolved); allowed=false;
    try {transport.beforeSend();} catch {return {status:'skipped_unknown',reason:'log_unavailable'};}
    writes++; throw Error('must not reach native send');
  });
  const guard=()=>{if(!allowed)throw new DispatchContextError('delivery_window_expired');return {remaining_ms:100};};
  try {
    f.service.send({request_id:f.request,thread_id:f.thread,text:'echo'},guard);
    const receipt=await f.service.get({request_id:f.request,wait_seconds:1});
    assert.equal(receipt.status,'skipped_unknown');assert.equal(receipt.reason,'delivery_window_expired');assert.equal(writes,0);
    const saved=JSON.parse((f.store.db.prepare('SELECT data FROM desktop_conversation_requests WHERE request_id=?').get(f.request) as {data:string}).data);
    assert.equal(saved.sent,false);
  }finally{await f.close();}
});

test('bound timer after send is uncertain; completed retries return exact original receipt even after scope ends',async()=>{
  let f:ReturnType<typeof desktopFixture>, sends=0, allowed=true;
  f=desktopFixture(async transport=>{
    transport.onResolvedTarget?.(f.resolved);transport.beforeSend();sends++;transport.onAccepted(f.turn);
    return {status:'completed',turn_id:f.turn,reply:'synthetic exact reply'};
  });
  const guard=()=>{if(!allowed)throw new DispatchContextError('delivery_task_not_running');return {remaining_ms:100};};
  try{
    const send={request_id:f.request,thread_id:f.thread,text:'echo'};
    f.service.send(send,guard);const result=await f.service.get({request_id:f.request,wait_seconds:1});
    assert.equal(result.verification,'exact_turn_reply');allowed=false;
    assert.deepEqual(f.service.send(send,guard),result);assert.equal(sends,1);
  }finally{await f.close();}
  f=desktopFixture(async transport=>{
    transport.onResolvedTarget?.(f.resolved);transport.beforeSend();
    await new Promise<void>(resolve=>transport.signal.addEventListener('abort',()=>resolve(),{once:true}));
    throw new DispatchContextError('delivery_window_expired');
  });
  try{
    f.service.send({request_id:f.request,thread_id:f.thread,text:'echo'},()=>({remaining_ms:10}));
    const receipt=await f.service.get({request_id:f.request,wait_seconds:1});
    assert.equal(receipt.status,'uncertain');assert.equal(receipt.reason,'delivery_window_expired');
  }finally{await f.close();}
});
