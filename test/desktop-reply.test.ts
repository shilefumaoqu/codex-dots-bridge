import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReply } from '../src/desktop-conversations-transport.js';
import { DesktopConversationsService, type DesktopConversationSendInput, type DesktopConversationsTransport } from '../src/desktop-conversations.js';
import { replyBindingSchema, type DesktopReplyBinding, type DesktopReplyResult } from '../src/desktop-reply.js';

const noRead: DesktopConversationsTransport['runRead'] = async () => assert.fail('unexpected source read');
const noSend: DesktopConversationsTransport['runSend'] = async () => assert.fail('recovery must never send');
const turnComplete = (turnId: string, time: number, reply = '准确回合的迟到回复🌟') => JSON.stringify({ type:'event_msg', payload:{type:'task_complete',turn_id:turnId,started_at:new Date(time).toISOString(),completed_at:new Date(time).toISOString(),duration_ms:0,last_agent_message:reply} }) + '\n';

async function until(predicate:()=>boolean): Promise<void> {
  for(let i=0;i<200;i++) { if(predicate())return; await new Promise(resolve=>setTimeout(resolve,5)); }
  assert.fail('observer did not settle within test budget');
}
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'reply-recovery-')),thread=randomUUID(),turn=randomUUID(),request=randomUUID(),path=join(root,'rollout.jsonl');
  writeFileSync(path,JSON.stringify({type:'session_meta',payload:{id:thread}})+'\n');
  const stat=statSync(path,{bigint:true}),now=Date.now();
  const binding: DesktopReplyBinding={version:2,path,thread_id:thread,device:stat.dev.toString(),inode:stat.ino.toString(),birthtime_ns:stat.birthtimeNs.toString(),offset:Number(stat.size),sent_at_ms:now};
  const db=new Database(':memory:'),config={enabled:true,targets:[{thread_id:thread,rollout_path:path}]};
  const accept=(input:DesktopConversationSendInput)=>{input.onReplyBinding?.(binding);input.beforeSend();input.onAccepted(turn);};
  return {root,thread,turn,request,path,binding,db,config,now,accept,cleanup(){db.close();rmSync(root,{recursive:true,force:true});}};
}

test('durable bindings preserve adjacent 64-bit file IDs without accepting rounded legacy evidence',()=>{
  const f=fixture();
  try {
    const first=replyBindingSchema.parse({...f.binding,inode:'18446744073709551614'});
    const second=replyBindingSchema.parse({...f.binding,inode:'18446744073709551615'});
    const restored=JSON.parse(JSON.stringify([first,second]));
    assert.notEqual(restored[0].inode,restored[1].inode);
    assert.equal(restored[1].inode,'18446744073709551615');
    const legacy={version:1,path:f.path,thread_id:f.thread,device:1,inode:Number(second.inode),birthtime_ms:1,offset:f.binding.offset,sent_at_ms:f.now};
    assert.equal(replyBindingSchema.safeParse(legacy).success,false);
  }finally{f.cleanup();}
});

test('exact legacy file bindings remain readable and changed new-format identities are refused',async()=>{
  const f=fixture(),controller=new AbortController();
  try {
    appendFileSync(f.path,turnComplete(f.turn,f.now));
    const stat=statSync(f.path);
    const legacy={version:1 as const,path:f.path,thread_id:f.thread,device:stat.dev,inode:stat.ino,birthtime_ms:stat.birthtimeMs,offset:f.binding.offset,sent_at_ms:f.now};
    const input={turnId:f.turn,signal:controller.signal,deadline:Date.now()+1000};
    const result=await runReply({...input,binding:legacy});
    assert.equal(result.status,Number.isSafeInteger(stat.dev)&&Number.isSafeInteger(stat.ino)?'completed':'unavailable');
    const changed=await runReply({...input,binding:{...f.binding,inode:(BigInt(f.binding.inode)+1n).toString()} as DesktopReplyBinding});
    assert.deepEqual(changed,{status:'unavailable',reason:'log_changed'});
  }finally{f.cleanup();}
});

test('read-only recovery advances complete log lines, retains partial UTF-8 and matches only the accepted turn',async()=>{
  const f=fixture(),controller=new AbortController();
  const read=(binding=f.binding)=>runReply({binding,turnId:f.turn,signal:controller.signal,deadline:Date.now()+1000});
  try {
    appendFileSync(f.path,turnComplete(randomUUID(),f.now,'other turn'));
    const line=Buffer.from(turnComplete(f.turn,f.now)),split=line.indexOf(Buffer.from('🌟'))+1;
    appendFileSync(f.path,line.subarray(0,split));
    const first=await read();assert.equal(first.status,'pending');if(first.status!=='pending')return;
    assert(first.next_offset>f.binding.offset);assert(first.next_offset<statSync(f.path).size);
    appendFileSync(f.path,line.subarray(split));
    const result=await read({...f.binding,offset:first.next_offset});
    assert.deepEqual(result,{status:'completed',turn_id:f.turn,reply:'准确回合的迟到回复🌟'});
  }finally{f.cleanup();}
});

test('read-only recovery refuses replaced files, mismatched sessions and offsets inside a line',async()=>{
  for(const mode of ['replacement','session','offset'] as const) {
    const f=fixture();
    try {
      let binding=f.binding;
      if(mode==='replacement') {renameSync(f.path,f.path+'.old');writeFileSync(f.path,JSON.stringify({type:'session_meta',payload:{id:f.thread}})+'\n'+turnComplete(f.turn,f.now));}
      if(mode==='session') binding={...binding,thread_id:randomUUID()};
      if(mode==='offset') binding={...binding,offset:binding.offset-1};
      const result=await runReply({binding,turnId:f.turn,signal:new AbortController().signal,deadline:Date.now()+1000});
      assert.equal(result.status,'unavailable',mode);
    }finally{f.cleanup();}
  }
});

test('70-second and multi-minute replies use one accepted request and status coalesces the existing observer',async()=>{
  for(const age of [70_000,240_000]) {
    const f=fixture();let now=f.now,sends=0,reads=0,release:((value:DesktopReplyResult)=>void)|undefined;
    const service=new DesktopConversationsService(f.db,f.config,{now:()=>now,transport:{runRead:noRead,runSend:async input=>{sends++;f.accept(input);now+=age;return {status:'uncertain',reason:'reply_timeout'};},runReply:async input=>{
      reads++;assert.equal(input.turnId,f.turn);assert.equal(input.binding.offset,f.binding.offset);return new Promise(resolve=>{release=resolve;});
    }}});
    try {
      const args={request_id:f.request,thread_id:f.thread,text:'one text'};service.send(args);
      const accepted=await service.get({request_id:f.request,wait_seconds:1});
      assert.equal(accepted.delivery_state,'accepted');assert.equal(accepted.reply_state,'pending');assert.equal(accepted.watch_state,'active');assert.equal(accepted.turn_id,f.turn);
      await until(()=>reads===1);
      await Promise.all(Array.from({length:10},()=>service.get({request_id:f.request})));
      assert.equal(service.send(args).watch_state,'active');assert.equal(reads,1);assert.equal(sends,1);
      release!({status:'completed',turn_id:f.turn,reply:'late original result'});
      const done=await service.get({request_id:f.request,wait_seconds:1});
      assert.equal(done.status,'completed');assert.equal(done.reply,'late original result');assert.equal(done.watch_state,'completed');assert.equal(sends,1);
    }finally{release?.({status:'pending',next_offset:f.binding.offset});await service.close();f.cleanup();}
  }
});

test('restart resumes only a durable matching ACK and source binding, using its last complete read offset',async()=>{
  const f=fixture();let sends=0,reads=0;
  const first=new DesktopConversationsService(f.db,f.config,{transport:{runRead:noRead,runSend:async input=>{sends++;f.accept(input);return {status:'uncertain',reason:'reply_timeout'};},runReply:async input=>{reads++;return {status:'pending',next_offset:input.binding.offset+17};}}});
  let reopened:DesktopConversationsService|undefined;
  try {
    first.send({request_id:f.request,thread_id:f.thread,text:'once'});await first.get({request_id:f.request,wait_seconds:1});await until(()=>reads===1);await first.close();
    reopened=new DesktopConversationsService(f.db,f.config,{transport:{runRead:noRead,runSend:noSend,runReply:async input=>{reads++;assert.equal(input.binding.offset,f.binding.offset+17);return {status:'completed',turn_id:f.turn,reply:'recovered after restart'};}}});
    await until(()=>reads===2);const done=await reopened.get({request_id:f.request,wait_seconds:1});
    assert.equal(done.reply,'recovered after restart');assert.equal(done.request_id,f.request);assert.equal(sends,1);
  }finally{await first.close();await reopened?.close();f.cleanup();}
});

test('after 24 hours a query makes one bounded read, without extending the watch or retransmitting',async()=>{
  const f=fixture();let now=f.now,sends=0,reads=0;
  const first=new DesktopConversationsService(f.db,f.config,{now:()=>now,transport:{runRead:noRead,runSend:async input=>{sends++;f.accept(input);return {status:'uncertain',reason:'reply_timeout'};},runReply:async input=>{reads++;return {status:'pending',next_offset:input.binding.offset};}}});
  let reopened:DesktopConversationsService|undefined;
  try {
    first.send({request_id:f.request,thread_id:f.thread,text:'once'});await first.get({request_id:f.request,wait_seconds:1});await first.close();now+=86_400_001;
    reopened=new DesktopConversationsService(f.db,f.config,{now:()=>now,transport:{runRead:noRead,runSend:noSend,runReply:async input=>{reads++;assert(input.deadline-Date.now()<=5000);return {status:'pending',next_offset:input.binding.offset};}}});
    const before=reads,expired=await reopened.get({request_id:f.request,wait_seconds:1});
    assert.equal(expired.watch_state,'expired');assert.equal(expired.reason,'reply_watch_expired');assert.equal(reads,before+1);assert.equal(sends,1);
    await new Promise(resolve=>setTimeout(resolve,20));assert.equal(reads,before+1);
  }finally{await first.close();await reopened?.close();f.cleanup();}
});

test('ACK loss and legacy records without source identity never start automatic recovery',async()=>{
  for(const missing of ['binding','ack'] as const){
    const f=fixture();let reads=0,sends=0;
    const service=new DesktopConversationsService(f.db,f.config,{transport:{runRead:noRead,runSend:async input=>{sends++;if(missing!=='binding')input.onReplyBinding?.(f.binding);input.beforeSend();if(missing!=='ack')input.onAccepted(f.turn);return {status:'uncertain',reason:'send_outcome_unknown'};},runReply:async()=>{reads++;assert.fail('incomplete evidence must not recover');}}});
    let reopened:DesktopConversationsService|undefined;
    try {
      const args={request_id:f.request,thread_id:f.thread,text:'once'};service.send(args);await service.get({request_id:f.request,wait_seconds:1});await service.close();
      reopened=new DesktopConversationsService(f.db,f.config,{transport:{runRead:noRead,runSend:noSend,runReply:async()=>{reads++;assert.fail('no guessed recovery');}}});
      assert.equal((await reopened.get({request_id:f.request})).status,'uncertain');assert.equal(reopened.send(args).status,'uncertain');assert.equal(sends,1);assert.equal(reads,0);
    }finally{await service.close();await reopened?.close();f.cleanup();}
  }
});

test('an expired old-request lookup cannot release a newer send reservation on the same thread',async()=>{
  const f=fixture();let now=f.now,release:(()=>void)|undefined;
  const first=new DesktopConversationsService(f.db,f.config,{now:()=>now,transport:{runRead:noRead,runSend:async input=>{f.accept(input);return {status:'uncertain',reason:'reply_timeout'};}}});
  let reopened:DesktopConversationsService|undefined;
  try {
    first.send({request_id:f.request,thread_id:f.thread,text:'old'});await first.get({request_id:f.request,wait_seconds:1});await first.close();now+=86_400_001;
    const newTurn=randomUUID(),newRequest=randomUUID();
    reopened=new DesktopConversationsService(f.db,f.config,{now:()=>now,transport:{runRead:noRead,runSend:async input=>{
      input.beforeSend();input.onAccepted(newTurn);await new Promise<void>(resolve=>{release=resolve;});return {status:'completed',turn_id:newTurn,reply:'new'};
    },runReply:async()=>({status:'completed',turn_id:f.turn,reply:'old late reply'})}});
    reopened.send({request_id:newRequest,thread_id:f.thread,text:'new'});await until(()=>!!release);
    assert.equal((await reopened.get({request_id:f.request,wait_seconds:1})).reply,'old late reply');
    assert.throws(()=>reopened!.send({request_id:randomUUID(),thread_id:f.thread,text:'third'}),/thread_send_in_progress/);
    release!();assert.equal((await reopened.get({request_id:newRequest,wait_seconds:1})).reply,'new');
  }finally{release?.();await first.close();await reopened?.close();f.cleanup();}
});

test('missing turn or owner evidence never offers an unusable delivery choice',async()=>{
  for(const evidence of ['none','turn','owner'] as const) {
    const f=fixture();const home=join(f.root,'home');
    const service=new DesktopConversationsService(f.db,{enabled:true,mode:'local',codex_home:home,read:false,send:true},{transport:{runRead:noRead,runSend:async()=>({
      status:'skipped_busy',reason:'turn_in_progress',
      ...(evidence==='owner'?{busy_owner:'a'.repeat(64)}:{}),
      ...(evidence==='turn'?{busy_state:{status:'busy',observed_at:new Date().toISOString(),checked_by:'native_desktop_owner',scope:'observation_snapshot',active_turn_id:f.turn,active_turn_started_at_ms:f.now}}:{}),
    })}});
    try{
      service.send({request_id:f.request,thread_id:f.thread,text:'text'});const receipt=await service.get({request_id:f.request,wait_seconds:1});
      assert.equal(receipt.status,'skipped_busy');assert.equal(receipt.delivery_options,undefined);
    }finally{await service.close();f.cleanup();}
  }
});

test('log identity failure stops automatic recovery and keeps its accepted-send evidence',async()=>{
  const f=fixture();let reads=0;
  const service=new DesktopConversationsService(f.db,f.config,{transport:{runRead:noRead,runSend:async input=>{f.accept(input);return {status:'uncertain',reason:'reply_timeout'};},runReply:async()=>{reads++;return {status:'unavailable',reason:'log_changed'};}}});
  try{
    service.send({request_id:f.request,thread_id:f.thread,text:'once'});await service.get({request_id:f.request,wait_seconds:1});await until(()=>reads===1);
    const result=await service.get({request_id:f.request,wait_seconds:1});
    assert.equal(result.delivery_state,'accepted');assert.equal(result.reply_state,'unavailable');assert.equal(result.watch_state,'unavailable');assert.equal(result.reason,'log_changed');
    for(let i=0;i<3;i++)await service.get({request_id:f.request});assert.equal(reads,1);
  }finally{await service.close();f.cleanup();}
});
