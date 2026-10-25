import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { z } from 'zod';
import { TaskStore } from '../src/task-store.js';
import { chatSchemas } from '../src/chat.js';
import { ProbeEvents } from '../src/events.js';
import { callerInstructions, callerSchemas, createProductionService, workerSchemas } from '../src/bridge.js';

const subId = (letter='a') => `sub_${letter.repeat(40)}`;
function subscribe(store: TaskStore, id=subId(), expires=store.now()+3600000) {
  const old=store.subscriptions().find(row=>row.id===id);
  store.saveSubscription({id,url:'https://example.test/callback/'+id,secret:'s'.repeat(32),active:true,expires_at:expires,verified_until:store.now()+300000,generation:(old?.generation??0)+1});
}
function reply(store:TaskStore, text:string) {
  const task=store.list({status:'queued'},{worker:true})[0]!;
  const claim=store.claim({task_id:task.task_id,claim_key:randomUUID()});
  store.checkpoint({task_id:task.task_id,claim_token:claim.claim_token,input_revision:1});
  store.complete({task_id:task.task_id,claim_token:claim.claim_token,input_revision:1,completion_key:randomUUID(),result:{text}});
  return task;
}
const counts=(store:TaskStore) => ['tasks','task_events','task_deliveries','bridge_chats','bridge_chat_messages'].map(table=>(store.db.prepare(`SELECT count(*) n FROM ${table}`).get() as {n:number}).n);

test('chat sends only exact current text; source and handle never pretend to be a native or Codex identity',async()=>{
  const store=new TaskStore(':memory:');
  try {
    subscribe(store); const request_id=randomUUID(), first=store.chats.send({request_id,text:'Remember only in the existing host chat: violet.'});
    assert.equal(first.status,'queued'); assert.ok(first.chat_id);
    const task=store.list()[0]!;
    assert.deepEqual(task.input,{text:'Remember only in the existing host chat: violet.'});
    assert.equal(task.parent_task_id,undefined); assert.equal(task.parent_context,undefined); assert.equal(task.logical_session_id,undefined);
    assert.deepEqual(task.messages,[]); assert.equal(task.safe_to_retry,false);
    assert.equal(store.dispatch.workerContext(task.task_id,task.deadline).dispatch_context.submission.source_kind,'legacy_unknown');
    const source=store.chats.workerContext(task.task_id)!.dispatch_context.submission;
    assert.equal(source.source_kind,'shared_worker_connection_chat'); assert.equal(source.scope,'reply_to_current_chat_message_only');
    assert.equal(source.human_identity_verified,false); assert.equal(source.native_approval_granted,false);
    reply(store,'Stored exact reply.');
    assert.deepEqual(await store.chats.status({request_id}),{...first,status:'reply',text:'Stored exact reply.'});
    const second=store.chats.send({request_id:randomUUID(),chat_id:first.chat_id,text:'What was the color?'});
    assert.equal(second.chat_id,first.chat_id);
    const next=store.list({status:'queued'})[0]!;
    assert.deepEqual(next.input,{text:'What was the color?'}); assert.equal(next.parent_context,undefined); assert.deepEqual(next.messages,[]);
    assert.ok(!JSON.stringify(second).includes('conversation_id')); assert.ok(!JSON.stringify(second).includes('task_id'));
    assert.equal(chatSchemas.dots_chat_send.safeParse({request_id:randomUUID(),text:'x',source_kind:'human'}).success,false);
  } finally {store.close();}
});

test('same ID replays only its original record offline; changed text/route conflicts without writes',async()=>{
  const store=new TaskStore(':memory:');
  try {
    subscribe(store); const args={request_id:randomUUID(),text:'Exact whitespace\n is retained.'}, initial=store.chats.send(args);
    reply(store,'ONLY_THIS_REPLY'); const before=counts(store);
    store.unsubscribe(subId());
    assert.deepEqual(store.chats.send(args),{...initial,status:'reply',text:'ONLY_THIS_REPLY'});
    assert.deepEqual(counts(store),before);
    assert.throws(()=>store.chats.send({...args,text:'changed'}),/chat_idempotency_conflict/);
    assert.throws(()=>store.chats.send({...args,chat_id:randomUUID()}),/chat_idempotency_conflict/);
    assert.deepEqual(counts(store),before);
    const unknown=randomUUID(); assert.deepEqual(await store.chats.status({request_id:unknown}),{request_id:unknown,status:'unknown'});
  } finally {store.close();}
});

test('one message per route is in flight even if chat_id is omitted or calls run concurrently',async()=>{
  const store=new TaskStore(':memory:');
  try {
    subscribe(store);
    const results=await Promise.allSettled([Promise.resolve().then(()=>store.chats.send({request_id:randomUUID(),text:'one'})),Promise.resolve().then(()=>store.chats.send({request_id:randomUUID(),text:'two'}))]);
    assert.equal(results.filter(row=>row.status==='fulfilled').length,1);
    assert.match((results.find(row=>row.status==='rejected') as PromiseRejectedResult).reason.message,/chat_previous_unresolved/);
    assert.equal(store.list().length,1);
    const first=store.list()[0]!; const claim=store.claim({task_id:first.task_id,claim_key:'working'});
    assert.throws(()=>store.chats.send({request_id:randomUUID(),text:'third'}),/chat_previous_unresolved/);
    store.checkpoint({task_id:first.task_id,claim_token:claim.claim_token,input_revision:1});
    store.fail({task_id:first.task_id,claim_token:claim.claim_token,input_revision:1,failure_key:'fail',error:{code:'synthetic',message:'Stopped'}});
    assert.equal(store.chats.send({request_id:randomUUID(),text:'Explicit new message after final failure'}).status,'queued');
  } finally {store.close();}
});

test('no route and ambiguous route reject transactionally; status never returns unrelated task bodies',async()=>{
  const store=new TaskStore(':memory:');
  try {
    assert.throws(()=>store.chats.send({request_id:randomUUID(),text:'no route'}),/chat_route_unavailable/);
    subscribe(store); store.db.prepare('INSERT INTO task_subscriptions(id,data) VALUES(?,?)').run(subId('b'),JSON.stringify({...store.subscriptions()[0],id:subId('b')}));
    assert.throws(()=>store.chats.send({request_id:randomUUID(),text:'ambiguous'}),/chat_route_ambiguous/);
    assert.equal(store.list().length,0);
    store.db.prepare('DELETE FROM task_subscriptions WHERE id=?').run(subId('b'));
    store.submit({idempotency_key:'unrelated',title:'Private other task',input:{text:'UNRELATED_SECRET'}});
    const id=randomUUID(); assert.deepEqual(await store.chats.status({request_id:id}),{request_id:id,status:'unknown'});
    assert.equal(JSON.stringify(await store.chats.status({request_id:id})).includes('SECRET'),false);
  } finally {store.close();}
});

test('same-ID refresh retains route, while expiry/unsubscribe/replacement never transfer or replay queued chat',async()=>{
  let now=Date.now(); const store=new TaskStore(':memory:',()=>now);
  try {
    subscribe(store,subId(),now+60000); const sent=store.chats.send({request_id:randomUUID(),text:'bound'}),task=store.list()[0]!;
    now+=30000; subscribe(store,subId(),now+60000); now+=31000;
    assert.equal(store.chats.routeCurrent(sent.chat_id!),true); assert.equal((await store.chats.status({request_id:sent.request_id})).status,'queued');
    const deliveryCount=counts(store)[2];
    store.unsubscribe(subId()); subscribe(store,subId());
    assert.equal(store.chats.routeCurrent(sent.chat_id!),false);
    assert.equal(store.pending().length,0); assert.equal(store.list(undefined,{worker:true}).length,0);
    assert.throws(()=>store.get(task.task_id,{worker:true}),/reply_subscription_unavailable/);
    assert.throws(()=>store.claim({task_id:task.task_id,claim_key:'claim'}),/reply_subscription_unavailable/);
    assert.throws(()=>store.chats.send({request_id:randomUUID(),chat_id:sent.chat_id,text:'later'}),/chat_route_unavailable/);
    assert.equal(counts(store)[2],deliveryCount);
    store.unsubscribe(subId()); subscribe(store,subId('b'));
    assert.equal(store.pending().length,0); assert.equal(counts(store)[2],deliveryCount);
    assert.throws(()=>store.chats.send({request_id:randomUUID(),chat_id:sent.chat_id,text:'transfer'}),/chat_route_unavailable/);
    assert.throws(()=>store.chats.send({request_id:randomUUID(),text:'Implicit new route'}),/chat_route_changed/);
    assert.equal(store.chats.send({request_id:sent.request_id,text:'bound'}).status,'unknown');
  } finally {store.close();}
  const expired=new TaskStore(':memory:',()=>now);
  try {
    subscribe(expired,subId(),now+1000); const sent=expired.chats.send({request_id:randomUUID(),text:'expire'});
    now+=1001; subscribe(expired,subId(),now+60000);
    assert.equal(expired.chats.routeCurrent(sent.chat_id!),false); assert.equal(expired.pending().length,0);
  } finally {expired.close();}
});

test('restart and status reads never enqueue, resend or recover an unresolved message',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'dots-chat-test-')),path=join(dir,'test.sqlite'); let store=new TaskStore(path); let now=Date.now();
  try {
    subscribe(store); const args={request_id:randomUUID(),text:'One persisted message'},sent=store.chats.send(args),task=store.list()[0]!;
    store.claim({task_id:task.task_id,claim_key:'claim'}); const before=counts(store);
    store.close(); store=new TaskStore(path,()=>now);
    assert.equal((await store.chats.status({request_id:sent.request_id})).status,'working');
    assert.equal(store.chats.send(args).status,'working'); assert.deepEqual(counts(store),before);
    now+=1800001;
    assert.equal((await store.chats.status({request_id:sent.request_id})).status,'unknown');
    assert.throws(()=>store.chats.send({request_id:randomUUID(),text:'No retry'}),/chat_previous_unresolved/);
    assert.deepEqual(counts(store),before);
  } finally {
    store.close(); const relativeDir=relative(resolve(tmpdir()),resolve(dir)); assert.ok(relativeDir.startsWith('dots-chat-test-')&&!relativeDir.includes('..')); rmSync(dir,{recursive:true,force:true});
  }
});

test('observed route expiry survives clock rollback and refresh without changing tasks or creating deliveries',async()=>{
  const start=Date.now(); let now=start; const store=new TaskStore(':memory:',()=>now);
  try {
    subscribe(store,subId(),start+1000); const args={request_id:randomUUID(),text:'Do not revive'},sent=store.chats.send(args),before=counts(store);
    const taskRows=()=>store.db.prepare('SELECT * FROM tasks').all(); const tasks=taskRows();
    now=start+1001;
    assert.equal((await store.chats.status({request_id:sent.request_id})).status,'unknown');
    assert.equal((store.db.prepare('SELECT invalidated FROM bridge_chats WHERE chat_id=?').get(sent.chat_id) as {invalidated:number}).invalidated,1);
    assert.deepEqual(taskRows(),tasks); assert.deepEqual(counts(store),before);
    now=start;
    assert.equal((await store.chats.status({request_id:sent.request_id})).status,'unknown'); assert.equal(store.pending().length,0);
    assert.equal(store.chats.send(args).status,'unknown'); assert.deepEqual(counts(store),before);
    subscribe(store,subId(),start+60000);
    assert.equal(store.chats.routeCurrent(sent.chat_id!),false); assert.equal(store.pending().length,0);
    assert.throws(()=>store.chats.send({request_id:randomUUID(),chat_id:sent.chat_id,text:'Do not revive old handle'}),/chat_route_unavailable/);
    assert.deepEqual(taskRows(),tasks); assert.deepEqual(counts(store),before);
  } finally {store.close();}
});

test('pending expiry observation is durable across restart and rollback, while original request replay never sends',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'dots-chat-test-')),path=join(dir,'route.sqlite'),start=Date.now(); let now=start,store=new TaskStore(path,()=>now);
  try {
    subscribe(store,subId(),start+1000); const args={request_id:randomUUID(),text:'Persist expiry'},sent=store.chats.send(args),before=counts(store);
    const tasks=store.db.prepare('SELECT * FROM tasks').all();
    now=start+1001; assert.equal(store.pending().length,0);
    store.close(); now=start; store=new TaskStore(path,()=>now);
    assert.equal(store.chats.routeCurrent(sent.chat_id!),false); assert.equal(store.pending().length,0);
    assert.equal(store.chats.send(args).status,'unknown'); assert.equal((await store.chats.status({request_id:args.request_id})).status,'unknown');
    assert.deepEqual(store.db.prepare('SELECT * FROM tasks').all(),tasks); assert.deepEqual(counts(store),before);
  } finally {
    store.close(); const owned=relative(resolve(tmpdir()),resolve(dir)); assert.ok(owned.startsWith('dots-chat-test-')&&!owned.includes('..')); rmSync(dir,{recursive:true,force:true});
  }
});

test('failed send commits only observed expiry after its business transaction rolls back and the clock already returns',()=>{
  const start=Date.now(); let expireInsideTransaction=false; let store:TaskStore;
  store=new TaskStore(':memory:',()=>start+(expireInsideTransaction&&store.db.inTransaction?1001:0));
  try {
    subscribe(store,subId(),start+1000); const args={request_id:randomUUID(),text:'original'},sent=store.chats.send(args),before=counts(store);
    const tasks=store.db.prepare('SELECT * FROM tasks').all();
    expireInsideTransaction=true;
    assert.throws(()=>store.chats.send({request_id:randomUUID(),chat_id:sent.chat_id,text:'Rejected new send'}),/chat_route_unavailable/);
    expireInsideTransaction=false;
    assert.equal((store.db.prepare('SELECT invalidated FROM bridge_chats WHERE chat_id=?').get(sent.chat_id) as {invalidated:number}).invalidated,1);
    assert.equal(store.chats.send(args).status,'unknown'); assert.equal(store.pending().length,0);
    assert.deepEqual(store.db.prepare('SELECT * FROM tasks').all(),tasks); assert.deepEqual(counts(store),before);
  } finally {store.close();}
});

test('worker transaction rollback also persists observed expiry without saving a checkpoint or reviving delivery',()=>{
  const start=Date.now(); let expireInsideTransaction=false; let store:TaskStore;
  store=new TaskStore(':memory:',()=>start+(expireInsideTransaction&&store.db.inTransaction?1001:0));
  try {
    subscribe(store,subId(),start+1000); const args={request_id:randomUUID(),text:'owned message'},sent=store.chats.send(args),task=store.list()[0]!,claim=store.claim({task_id:task.task_id,claim_key:'claim'}),before=counts(store);
    const tasks=store.db.prepare('SELECT * FROM tasks').all();
    expireInsideTransaction=true;
    assert.throws(()=>store.checkpoint({task_id:task.task_id,claim_token:claim.claim_token,input_revision:1}),/reply_subscription_unavailable/);
    expireInsideTransaction=false;
    assert.equal((store.db.prepare('SELECT invalidated FROM bridge_chats WHERE chat_id=?').get(sent.chat_id) as {invalidated:number}).invalidated,1);
    assert.equal(store.chats.send(args).status,'unknown'); assert.equal(store.pending().length,0);
    assert.deepEqual(store.db.prepare('SELECT * FROM tasks').all(),tasks); assert.deepEqual(counts(store),before);
  } finally {store.close();}
});

test('failed subscription refresh cannot roll back the expiry it already observed',()=>{
  const start=Date.now(); let now=start; const store=new TaskStore(':memory:',()=>now);
  try {
    subscribe(store,subId(),start+1000); const sent=store.chats.send({request_id:randomUUID(),text:'old route'}),before=counts(store),audit=store.audit.bind(store),oldSubscriptions=store.subscriptions();
    store.audit=(kind,task,detail)=>{if(kind==='subscription_active')throw Error('synthetic_subscription_failure');return audit(kind,task,detail);};
    now=start+1001;
    assert.throws(()=>subscribe(store,subId(),now+60000),/synthetic_subscription_failure/);
    store.audit=audit;now=start;
    assert.deepEqual(store.subscriptions(),oldSubscriptions);assert.equal(store.chats.routeCurrent(sent.chat_id!),false);assert.equal(store.pending().length,0);
    assert.deepEqual(counts(store),before);
  } finally {store.close();}
});

test('message deadline expiry stays durable after rollback and restart while the subscription remains valid',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'dots-chat-test-')),path=join(dir,'message.sqlite'),start=Date.now(); let now=start,store=new TaskStore(path,()=>now);
  try {
    subscribe(store); const args={request_id:randomUUID(),text:'Five minute message'},sent=store.chats.send(args),before=counts(store),tasks=store.db.prepare('SELECT * FROM tasks').all(),task=store.list()[0]!;
    now=start+300001;
    assert.equal(store.subscriptionCurrent(subId()),true); assert.equal(store.chats.routeCurrent(sent.chat_id!),true);
    assert.equal((await store.chats.status({request_id:args.request_id})).status,'unknown');
    assert.equal((store.db.prepare('SELECT expired FROM bridge_chat_messages WHERE request_id=?').get(args.request_id) as {expired:number}).expired,1);
    assert.deepEqual(store.db.prepare('SELECT * FROM tasks').all(),tasks); assert.deepEqual(counts(store),before);
    store.close();now=start;store=new TaskStore(path,()=>now);
    assert.equal(store.subscriptionCurrent(subId()),true);assert.equal(store.chats.routeCurrent(sent.chat_id!),true);
    assert.equal(store.chats.send(args).status,'unknown');assert.equal(store.pending().length,0);
    assert.throws(()=>store.get(task.task_id,{worker:true}),/reply_subscription_unavailable/);
    assert.deepEqual(store.db.prepare('SELECT * FROM tasks').all(),tasks);assert.deepEqual(counts(store),before);
  } finally {
    store.close();const owned=relative(resolve(tmpdir()),resolve(dir));assert.ok(owned.startsWith('dots-chat-test-')&&!owned.includes('..'));rmSync(dir,{recursive:true,force:true});
  }
});

test('failed new send preserves observed message expiry even when its task sweep and send roll back',async()=>{
  const start=Date.now();let now=start;const store=new TaskStore(':memory:',()=>now);
  try {
    subscribe(store);const args={request_id:randomUUID(),text:'original message'},sent=store.chats.send(args),before=counts(store),tasks=store.db.prepare('SELECT * FROM tasks').all();
    now=start+300001;
    assert.throws(()=>store.chats.send({request_id:randomUUID(),chat_id:randomUUID(),text:'unknown handle'}),/chat_not_found/);
    now=start;
    assert.equal((store.db.prepare('SELECT expired FROM bridge_chat_messages WHERE request_id=?').get(args.request_id) as {expired:number}).expired,1);
    assert.equal((await store.chats.status({request_id:sent.request_id})).status,'unknown');assert.equal(store.chats.send(args).status,'unknown');assert.equal(store.pending().length,0);
    assert.equal(store.chats.routeCurrent(sent.chat_id!),true);assert.deepEqual(store.db.prepare('SELECT * FROM tasks').all(),tasks);assert.deepEqual(counts(store),before);
  }finally{store.close();}
});

test('real Events pump sweeps an unclaimed chat before pending and never sends its expired hint',async()=>{
  const start=Date.now();let now=start,sends=0;const store=new TaskStore(':memory:',()=>now);
  try {
    subscribe(store);const args={request_id:randomUUID(),text:'Do not deliver after five minutes'};store.chats.send(args);
    const task=store.list()[0]!,snapshot=store.pending()[0]!;assert.ok(snapshot);
    const events=new ProbeEvents(store,async()=>{sends++;return {status:200,body:'{}'};},'tasks');
    now=start+300001;assert.equal(store.subscriptionCurrent(subId()),true);
    await events.pump();
    assert.equal(store.inspectChatTask(task.task_id).status,'expired');assert.equal(sends,0);
    assert.equal((store.db.prepare('SELECT expired FROM bridge_chat_messages WHERE request_id=?').get(args.request_id) as {expired:number}).expired,1);
    assert.equal(store.pending().length,0);assert.equal(store.isDeliveryPending(snapshot.id),false);
  }finally{store.close();}
});

test('sweep-first pending expiry stays durable through clock rollback and restart without expiring a saved reply',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'dots-chat-test-')),path=join(dir,'swept.sqlite'),start=Date.now();let now=start,store=new TaskStore(path,()=>now);
  try {
    subscribe(store);const args={request_id:randomUUID(),text:'Keep swept expiry'},sent=store.chats.send(args),snapshot=store.pending()[0]!,task=store.list()[0]!;
    now=start+300001;store.sweep();
    assert.equal(store.inspectChatTask(task.task_id).status,'expired');
    assert.equal((store.db.prepare('SELECT expired FROM bridge_chat_messages WHERE request_id=?').get(args.request_id) as {expired:number}).expired,0);
    assert.equal(store.pending().length,0);
    assert.equal((store.db.prepare('SELECT expired FROM bridge_chat_messages WHERE request_id=?').get(args.request_id) as {expired:number}).expired,1);
    const before=counts(store);store.close();now=start;store=new TaskStore(path,()=>now);
    assert.equal(store.subscriptionCurrent(subId()),true);assert.equal(store.chats.routeCurrent(sent.chat_id!),true);
    assert.equal(store.pending().length,0);assert.equal(store.isDeliveryPending(snapshot.id),false);
    let sends=0;await new ProbeEvents(store,async()=>{sends++;return {status:200,body:'{}'};},'tasks').pump();assert.equal(sends,0);
    assert.equal(store.chats.send(args).status,'expired');assert.deepEqual(counts(store),before);
    // A final exact reply remains readable after its deadline; only expired tasks latch expiry.
    const next={request_id:randomUUID(),chat_id:sent.chat_id,text:'New explicit message'};store.chats.send(next);const completed=reply(store,'EXACT_SAVED_REPLY');
    now=start+600001;store.sweep();store.pending();
    assert.equal(store.inspectChatTask(completed.task_id).status,'completed');
    assert.equal((await store.chats.status({request_id:next.request_id})).text,'EXACT_SAVED_REPLY');
    assert.equal((store.db.prepare('SELECT expired FROM bridge_chat_messages WHERE request_id=?').get(next.request_id) as {expired:number}).expired,0);
  }finally{
    store.close();const owned=relative(resolve(tmpdir()),resolve(dir));assert.ok(owned.startsWith('dots-chat-test-')&&!owned.includes('..'));rmSync(dir,{recursive:true,force:true});
  }
});

test('data-only completed results are not a successful text reply',async()=>{
  const store=new TaskStore(':memory:');
  try {
    subscribe(store); const sent=store.chats.send({request_id:randomUUID(),text:'data only'}),task=store.list()[0]!,claim=store.claim({task_id:task.task_id,claim_key:'claim'});
    store.checkpoint({task_id:task.task_id,claim_token:claim.claim_token,input_revision:1});
    store.complete({task_id:task.task_id,claim_token:claim.claim_token,input_revision:1,completion_key:'data',result:{data:{text:'not a text reply'}}});
    assert.equal((await store.chats.status({request_id:sent.request_id})).status,'error');
    assert.equal(store.chats.send({request_id:randomUUID(),text:'An explicitly requested new message'}).status,'queued');
  } finally {store.close();}
});

test('definite failed/cancelled/expired messages allow explicit new messages but original IDs never resend',async()=>{
  for (const mode of ['failed','cancelled','expired'] as const) {
    let now=Date.now(); const store=new TaskStore(':memory:',()=>now);
    try {
      subscribe(store); const args={request_id:randomUUID(),text:'initial'},sent=store.chats.send(args),task=store.list()[0]!;
      if (mode==='failed') {
        const claim=store.claim({task_id:task.task_id,claim_key:'claim'}); store.checkpoint({task_id:task.task_id,claim_token:claim.claim_token,input_revision:1});
        store.fail({task_id:task.task_id,claim_token:claim.claim_token,input_revision:1,failure_key:'fail',error:{code:'failed',message:'definite final'}});
      } else if (mode==='cancelled') store.cancel({task_id:task.task_id,request_key:'cancel'});
      else {now+=300001;store.sweep();}
      const before=counts(store),old=await store.chats.status({request_id:args.request_id}); assert.notEqual(old.status,'reply');
      assert.deepEqual(store.chats.send(args),old); assert.deepEqual(counts(store),before);
      const next=store.chats.send({request_id:randomUUID(),chat_id:sent.chat_id,text:'Explicit new scope'});
      assert.equal(next.status,'queued'); assert.equal(next.chat_id,sent.chat_id);
      assert.deepEqual(store.chats.send(args),old); assert.equal(store.list().length,2);
    } finally {store.close();}
  }
});

test('only a new first message on the same restored subscription gets a fresh handle and a continuity warning',async()=>{
  let now=Date.now(); const store=new TaskStore(':memory:',()=>now);
  try {
    subscribe(store,subId(),now+60000); const oldArgs={request_id:randomUUID(),text:'first'},first=store.chats.send(oldArgs); reply(store,'first reply');
    const oldReceipt=await store.chats.status({request_id:first.request_id});
    now+=60001; subscribe(store,subId(),now+60000);
    assert.throws(()=>store.chats.send({request_id:randomUUID(),chat_id:first.chat_id,text:'old handle cannot revive'}),/chat_route_unavailable/);
    const nextArgs={request_id:randomUUID(),text:'Explicit new first message'},next=store.chats.send(nextArgs);
    assert.notEqual(next.chat_id,first.chat_id); assert.equal(next.continuity,'route_rebound_context_unverified');
    assert.deepEqual(store.chats.send(oldArgs),oldReceipt);
    assert.deepEqual(store.chats.send(nextArgs),next);
    assert.throws(()=>store.chats.send({request_id:randomUUID(),chat_id:first.chat_id,text:'still invalid'}),/chat_route_unavailable/);
    reply(store,'second reply'); const third=store.chats.send({request_id:randomUUID(),chat_id:next.chat_id,text:'continue new handle'});
    assert.equal(third.chat_id,next.chat_id); assert.equal(third.continuity,undefined);
  } finally {store.close();}
});

test('an unknown old execution blocks route rebind; callback failure alone is not a terminal message',async()=>{
  let now=Date.now(); const store=new TaskStore(':memory:',()=>now),events=new ProbeEvents(store,async()=>({status:413,body:''}),'tasks');
  try {
    subscribe(store); const args={request_id:randomUUID(),text:'first'},first=store.chats.send(args);
    await events.pump(); assert.equal((await store.chats.status({request_id:first.request_id})).status,'queued');
    assert.throws(()=>store.chats.send({request_id:randomUUID(),text:'do not assume HTTP failure is stopped'}),/chat_previous_unresolved/);
    const task=store.list()[0]!;store.claim({task_id:task.task_id,claim_key:'claim'});
    store.unsubscribe(subId()); subscribe(store,subId());
    assert.throws(()=>store.chats.send({request_id:randomUUID(),text:'do not rebind running'}),/chat_previous_unresolved/);
    now+=300001;
    assert.throws(()=>store.chats.send({request_id:randomUUID(),text:'do not rebind unknown'}),/chat_previous_unresolved/);
    assert.equal(store.chats.send(args).status,'unknown'); assert.equal(store.list().length,1);
  } finally {store.close();}
});

test('questions, stale results and manual resolution never masquerade as accepted chat replies',async()=>{
  for (const mode of ['question','stale','manual'] as const) {
    let now=Date.now(); const store=new TaskStore(':memory:',()=>now);
    try {
      subscribe(store); const sent=store.chats.send({request_id:randomUUID(),text:'one exact message'}),task=store.list()[0]!,claim=store.claim({task_id:task.task_id,claim_key:'claim'});
      store.checkpoint({task_id:task.task_id,claim_token:claim.claim_token,input_revision:1});
      if (mode==='question') {assert.throws(()=>store.requestInput({task_id:task.task_id,claim_token:claim.claim_token,question_key:'question',question:'Can I do something else?'}),/chat_text_reply_required/);assert.equal(store.inspectChatTask(task.task_id).status,'running');}
      else if (mode==='stale') {
        store.message({task_id:task.task_id,message_key:'altered',text:'changed after claim'});
        store.complete({task_id:task.task_id,claim_token:claim.claim_token,input_revision:1,completion_key:'stale',result:{text:'stale reply'}});
      } else {
        now+=300001; store.sweep(); store.resolve({task_id:task.task_id,resolution_key:'manual',decision:'complete',basis:'synthetic manual record',result:{text:'manual is not the worker reply'}});
      }
      const result=await store.chats.status({request_id:sent.request_id});
      assert.notEqual(result.status,'reply'); assert.equal(result.text,undefined);
    } finally {store.close();}
  }
});

test('status wait is bounded, rejects over 20s, wakes for its reply, and never creates another message',async()=>{
  const store=new TaskStore(':memory:');
  try {
    subscribe(store); const sent=store.chats.send({request_id:randomUUID(),text:'wait'}),before=counts(store);
    assert.equal(chatSchemas.dots_chat_status.safeParse({request_id:sent.request_id,wait_seconds:21}).success,false);
    const timed=await store.chats.status({request_id:sent.request_id,wait_seconds:0.01}); assert.equal(timed.status,'queued'); assert.deepEqual(counts(store),before);
    const timer=setTimeout(()=>reply(store,'bounded reply'),20);
    try {assert.equal((await store.chats.status({request_id:sent.request_id,wait_seconds:1})).text,'bounded reply');} finally {clearTimeout(timer);}
    assert.deepEqual(counts(store),before);
  } finally {store.close();}
});

test('reading chat status does not sweep or wake a queued message behind an expired unrelated task',async()=>{
  let now=Date.now(); const store=new TaskStore(':memory:',()=>now);
  try {
    subscribe(store);
    store.submit({idempotency_key:'older',title:'older task',input:{text:'older'},deadline_hours:0.0001});
    const sent=store.chats.send({request_id:randomUUID(),text:'wait behind older'}),before=counts(store);
    now+=500;
    assert.equal((await store.chats.status({request_id:sent.request_id})).status,'queued');
    assert.deepEqual(counts(store),before);
    assert.equal((store.db.prepare("SELECT json_extract(data,'$.status') status FROM tasks WHERE request_key='older'").get() as {status:string}).status,'queued');
  } finally {store.close();}
});

test('unavailable callback and message expiry do not create another send or transfer to a fresh route',async()=>{
  let now=Date.now(); const store=new TaskStore(':memory:',()=>now),events=new ProbeEvents(store,async()=>({status:410,body:''}),'tasks');
  try {
    subscribe(store); const args={request_id:randomUUID(),text:'one'},sent=store.chats.send(args),before=counts(store);
    await events.pump(); assert.equal((await store.chats.status({request_id:sent.request_id})).status,'unknown');
    subscribe(store,subId('b')); assert.equal(store.pending().length,0); assert.deepEqual(counts(store),before);
    assert.equal(store.chats.send(args).status,'unknown'); assert.deepEqual(counts(store),before);
    now+=300001; assert.equal((await store.chats.status({request_id:sent.request_id})).status,'unknown');
  } finally {store.close();}
});

test('worker MCP exposes narrow chat tools on existing connection and server-generated provenance; old definitions stay stable',async()=>{
  const store=new TaskStore(':memory:'),tokens={caller:'a'.repeat(64),worker:'b'.repeat(64)},events=new ProbeEvents(store,async()=>({status:200,body:'{}'}),'tasks');
  const service=createProductionService(store,events,tokens),endpoint=await service.start();
  const rpc=async(name:string,args?:unknown,token=tokens.worker)=>{
    const method=name==='tools/list'?'tools/list':'tools/call';
    const res=await fetch(new URL('mcp/dot',endpoint),{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','X-Codex-Dots-Worker-Token':token,'MCP-Protocol-Version':'2026-07-28','Mcp-Method':method,...(method==='tools/call'?{'Mcp-Name':name}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...(method==='tools/call'?{name,arguments:args}:{}),_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}}})});
    return {status:res.status,body:await res.json() as any};
  };
  const unpack=(response:any)=>{assert.equal(response.status,200); assert.ok(!response.body.error,JSON.stringify(response)); assert.ok(!response.body.result.isError,JSON.stringify(response)); return JSON.parse(response.body.result.content[0].text);};
  try {
    const definitions=(await rpc('tools/list')).body.result.tools;
    assert.deepEqual(definitions.filter((t:any)=>t.name.startsWith('dots_chat_')).map((t:any)=>t.name).sort(),['dots_chat_send','dots_chat_status']);
    assert.equal((await rpc('dots_chat_status',{request_id:randomUUID()},tokens.caller)).status,401);
    assert.equal(Object.hasOwn(callerSchemas,'dots_chat_send'),false); assert.equal(Object.hasOwn(workerSchemas,'dots_chat_send'),false);
    subscribe(store); const sent=unpack(await rpc('dots_chat_send',{request_id:randomUUID(),text:'Hello'}));
    const task=store.list()[0]!,workerTask=unpack(await rpc('get_task',{task_id:task.task_id}));
    assert.equal(workerTask.dispatch_context.submission.source_kind,'shared_worker_connection_chat');
    assert.equal(workerTask.worker_rules.chat_scope,'single_text_reply'); assert.match(workerTask.worker_rules.instructions,/not an independently authenticated ChatGPT/);
    reply(store,'Hi'); assert.equal(unpack(await rpc('dots_chat_status',{request_id:sent.request_id})).text,'Hi');
    assert.deepEqual((await rpc('tools/list')).body.result.tools,definitions);
    const exported=JSON.stringify(store.evidence()); assert.ok(!exported.includes('Hello')); assert.ok(!exported.includes('"Hi"')); assert.ok(!exported.includes(tokens.caller));
  } finally {await service.close();store.close();}
});

test('all baseline caller schemas/instructions and pre-existing worker tool definitions remain identical', {skip:!process.env.CODEX_DOTS_CHAT_BASELINE}, async()=>{
  const baseline=await import(pathToFileURL(join(process.env.CODEX_DOTS_CHAT_BASELINE!,'src','bridge.ts')).href);
  assert.equal(callerInstructions,baseline.callerInstructions);
  const schemas=(values:Record<string,z.ZodType>)=>Object.fromEntries(Object.entries(values).map(([name,schema])=>[name,z.toJSONSchema(schema,{io:'input'})]));
  assert.deepEqual(schemas(callerSchemas),schemas(baseline.callerSchemas)); assert.deepEqual(schemas(workerSchemas),schemas(baseline.workerSchemas));
  async function directory(factory:typeof createProductionService) {
    const store=new TaskStore(':memory:'),tokens={caller:'a'.repeat(64),worker:'b'.repeat(64)},events=new ProbeEvents(store,async()=>({status:200,body:'{}'}),'tasks'),optional={enabled:true,close:async()=>{}} as any;
    const service=factory(store,events,tokens,undefined,undefined,undefined,optional,optional,optional),endpoint=await service.start();
    try {
      const response=await fetch(new URL('mcp/dot',endpoint),{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','X-Codex-Dots-Worker-Token':tokens.worker,'MCP-Protocol-Version':'2026-07-28','Mcp-Method':'tools/list'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}}})});
      const body=await response.json() as any; assert.equal(response.status,200); assert.ok(!body.error,JSON.stringify(body)); return body.result.tools as {name:string}[];
    } finally {await service.close();store.close();}
  }
  const old=await directory(baseline.createProductionService),current=await directory(createProductionService);
  assert.deepEqual(current.filter(tool=>!tool.name.startsWith('dots_chat_')),old);
  assert.equal(current.length,old.length+2);
});
