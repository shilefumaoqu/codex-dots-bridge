import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { TaskStore } from '../src/task-store.js';
import { ProbeEvents } from '../src/events.js';
import { createProductionService, VERSION, type RuntimeStatusProvider } from '../src/bridge.js';
import { writeProductionConfig, acquireLock } from '../src/runtime.js';

const tokens={caller:'a'.repeat(64),worker:'b'.repeat(64)};
const meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}};
const delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
function removeOwnTemp(dir:string) {
  const rel=relative(resolve(tmpdir()),resolve(dir));
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel) && rel.startsWith('codex dots production '));
  rmSync(dir,{recursive:true,force:true});
}
function unpack(response:any) {
  assert.ok(!response.error,JSON.stringify(response));
  assert.ok(!response.result?.isError,JSON.stringify(response));
  return JSON.parse(response.result.content[0].text);
}
function toolError(response:any,code:string) {
  assert.equal(response.result?.isError,true,JSON.stringify(response));
  assert.equal(JSON.parse(response.result.content[0].text).error,code);
}
async function fixture(runtimeStatus?:RuntimeStatusProvider) {
  const dir=mkdtempSync(join(tmpdir(),'codex dots production '));
  const store=new TaskStore(join(dir,'tasks.sqlite'));
  const deliveries:any[]=[];
  const events=new ProbeEvents(store,async(_url,_secret,_sub,_id,payload)=>{
    deliveries.push(payload);return {status:200,body:JSON.stringify(payload)};
  },'tasks');
  const service=createProductionService(store,events,tokens,runtimeStatus);
  const endpoint=await service.start();
  writeProductionConfig(dir,{owner:'codex-dots-bridge',schema_version:1,instance_id:randomUUID(),endpoint});
  writeFileSync(join(dir,'caller.key'),tokens.caller);
  writeFileSync(join(dir,'worker.key'),tokens.worker);
  const releaseLock=acquireLock(dir);
  let closed=false;
  async function closeService(){if(!closed){closed=true;await service.close();releaseLock();}}
  const control=async(name:string,args:unknown,keepAlive=false)=>{
    const response=await fetch(new URL(`control/${name}`,endpoint),{method:'POST',headers:{'content-type':'application/json',...(!keepAlive?{connection:'close'}:{}),authorization:`Bearer ${tokens.caller}`},body:JSON.stringify(args),signal:AbortSignal.timeout(5000)});
    return {status:response.status,body:await response.json() as any};
  };
  const rpc=async(method:string,params:Record<string,unknown>={})=>{
    const response=await fetch(new URL('mcp/dot',endpoint),{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','X-Codex-Dots-Worker-Token':tokens.worker,'MCP-Protocol-Version':'2026-07-28','Mcp-Method':method,...(method==='tools/call'?{'Mcp-Name':params.name as string}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,_meta:meta}}),signal:AbortSignal.timeout(5000)});
    return {status:response.status,body:await response.json() as any};
  };
  return {dir,store,events,deliveries,endpoint,control,rpc,closeService,closeIdleConnections:()=>service.app.server.closeIdleConnections(),
    worker:async(name:string,args:unknown)=>unpack((await rpc('tools/call',{name,arguments:args})).body),
    async close(){await closeService();store.close();removeOwnTemp(dir);}};
}
test('dots_status adds bounded diagnostics and retains task state when diagnostics are absent or fail',async()=>{
  const observed={tunnel_configured:true,tunnel_health:'ready',supervisor:'running',bridge:'running',tunnel:'running',guardian:'running'};
  const cases:[RuntimeStatusProvider|undefined,string][]=[
    [()=>({...observed,private_path:'PRIVATE_PATH',secret:'PRIVATE_SECRET',error:'PRIVATE_ERROR'}),'ready'],
    [()=>({...observed,tunnel_health:'unreachable'}),'unreachable'],
    [()=>({...observed,tunnel_configured:false,tunnel_health:'not_configured',supervisor:'stopped',tunnel:'stopped',guardian:'stopped'}),'not_configured'],
    [undefined,'unknown'],[()=>{throw new Error('PRIVATE_ERROR');},'unknown'],
    [()=>({...observed,tunnel_health:'PRIVATE_INVALID'}),'unknown'],
  ];
  for(const [provider,expected] of cases) {
    const f=await fixture(provider);
    try {
      f.store.submit({idempotency_key:'status-test',title:'Status sample',input:{text:'PRIVATE_BODY'}});
      const response=await f.control('dots_status',{}),status=response.body;
      assert.equal(response.status,200);assert.equal(status.version,VERSION);assert.equal(status.service_reachable,true);
      assert.equal(status.tunnel_health,expected);assert.equal(status.diagnostics,expected==='unknown'?'unavailable':'available');
      assert.deepEqual(status.task_counts,{queued:1});assert.equal(status.active_subscription_count,0);
      assert.equal(status.tasks.length,1);assert.equal(status.phase,'P1');assert.equal(status.production_ready,false);
      assert.ok(Array.isArray(status.subscriptions));assert.ok(Array.isArray(status.deliveries));
      if(expected==='unknown') {assert.equal(status.tunnel_configured,null);assert.equal(status.supervisor,'unknown');}
      for(const secret of ['PRIVATE_BODY','PRIVATE_PATH','PRIVATE_SECRET','PRIVATE_ERROR','PRIVATE_INVALID']) assert.ok(!JSON.stringify(status).includes(secret));
    }finally{await f.close();}
  }
});
test('a never-settling status provider times out without losing durable task state',async()=>{
  const f=await fixture(()=>new Promise(()=>{}));
  try {
    const task=f.store.submit({idempotency_key:'diagnostic-timeout',title:'Status timeout sample',input:{text:'PRIVATE_TIMEOUT_BODY'}});
    const started=performance.now();const response=await f.control('dots_status',{});const elapsed=performance.now()-started;
    assert.equal(response.status,200);assert.ok(elapsed>=1800&&elapsed<3500,'provider wait must have a two-second bound');
    assert.equal(response.body.diagnostics,'unavailable');assert.equal(response.body.tunnel_health,'unknown');
    assert.equal(response.body.tasks[0].task_id,task.task_id);assert.deepEqual(response.body.task_counts,{queued:1});
    assert.equal(f.store.get(task.task_id).attempt,0);assert.ok(!JSON.stringify(response.body).includes('PRIVATE_TIMEOUT_BODY'));
  }finally{await f.close();}
});

test('service shutdown interrupts an active status provider and handles its later rejection',async()=>{
  let providerStarted:()=>void=()=>{};const started=new Promise<void>(resolve=>{providerStarted=resolve;});
  let rejectProvider:(error:Error)=>void=()=>{};
  const f=await fixture(()=>{providerStarted();return new Promise((_resolve,reject)=>{rejectProvider=reject;});});
  try {
    const task=f.store.submit({idempotency_key:'diagnostic-shutdown',title:'Status shutdown sample',input:{text:'PRIVATE_SHUTDOWN_BODY'}});
    const pending=f.control('dots_status',{},true);await started;
    const closedAt=performance.now();const closing=f.closeService();
    const bounded=await Promise.race([closing.then(()=>true),delay(1200).then(()=>false)]);
    const response=await pending;await closing;
    assert.equal(bounded,true,'shutdown must interrupt diagnostics before their timeout');assert.ok(performance.now()-closedAt<1500);
    assert.equal(response.status,200);assert.equal(response.body.diagnostics,'unavailable');assert.equal(response.body.tunnel_health,'unknown');
    assert.equal(response.body.tasks[0].task_id,task.task_id);assert.equal(f.store.get(task.task_id).status,'queued');
    rejectProvider(new Error('PRIVATE_LATE_DIAGNOSTIC_FAILURE'));await delay(30);
    assert.ok(!JSON.stringify(response.body).includes('PRIVATE_'));
  }finally{await f.close();}
});
function stdio(dir:string) {
  const child=spawn(process.execPath,['--import','tsx','src/main.ts','stdio','--data-dir',dir],{cwd:process.cwd(),stdio:['pipe','pipe','pipe'],windowsHide:true});
  let buffer='',sequence=0,stdout='',stderr='';const parseErrors:string[]=[];
  const pending=new Map<number,{resolve:(v:any)=>void,reject:(e:Error)=>void,timer:NodeJS.Timeout}>();
  child.stderr.on('data',c=>stderr+=c.toString());
  child.stdout.on('data',c=>{
    stdout+=c.toString();buffer+=c.toString();
    while(buffer.includes('\n')) {
      const at=buffer.indexOf('\n'),line=buffer.slice(0,at);buffer=buffer.slice(at+1);
      try {const value=JSON.parse(line);if(value.id!==undefined){const p=pending.get(value.id);if(p){clearTimeout(p.timer);pending.delete(value.id);p.resolve(value);}}}
      catch {parseErrors.push(line);}
    }
  });
  const exit=new Promise<void>(r=>child.once('exit',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('stdio child exited'));}pending.clear();r();}));
  const call=(method:string,params:unknown={})=>new Promise<any>((resolve,reject)=>{
    const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`stdio timeout for ${method}`));},10_000);
    pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
  return {call,tool:async(name:string,args:unknown)=>unpack(await call('tools/call',{name,arguments:args})),
    async initialize(){const response=await call('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'synthetic-codex',version:'1'}});assert.equal(response.result.protocolVersion,'2025-11-25');child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');},
    async close(){child.stdin.end();await Promise.race([exit,delay(3000)]);if(child.exitCode===null&&child.signalCode===null){child.kill();await exit;}assert.deepEqual(parseErrors,[],'stdio stdout must contain only JSON messages');assert.equal(buffer,'');for(const token of Object.values(tokens)){assert.ok(!stdout.includes(token));assert.ok(!stderr.includes(token));}},
    output:()=>stdout+stderr};
}

test('production modern worker advertises its eight tools/tasks Events and authenticates every route variant',async()=>{
  const f=await fixture();try {
    const discovered=await f.rpc('server/discover');assert.equal(discovered.status,200);assert.equal(discovered.body.result.resultType,'complete');assert.deepEqual(discovered.body.result.capabilities.events,{});
    const tools=(await f.rpc('tools/list')).body.result.tools;
    assert.deepEqual(tools.map((t:any)=>t.name).sort(),['list_tasks','get_task','claim_task','checkpoint_task','request_input','complete_task','fail_task','ack_cancel'].sort());
    assert.ok(tools.find((t:any)=>t.name==='fail_task').inputSchema.required.includes('input_revision'));
    const catalog=(await f.rpc('events/list')).body.result.events;assert.equal(catalog.length,1);assert.equal(catalog[0].inputSchema.properties.queue.const,'tasks');assert.equal(catalog[0].payloadSchema.properties.queue.const,'tasks');
    for(const route of ['mcp/dot','mcp/dot?bypass=1','mcp/dot?','control/dots_status','control/dots_status?bypass=1']) {
      const denied=await fetch(new URL(route,f.endpoint),{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(denied.status,401,route);
    }
    for(const headers of [{authorization:`Bearer ${tokens.caller}`},{'X-Codex-Dots-Worker-Token':'c'.repeat(64)}]) {
      const denied=await fetch(new URL('mcp/dot',f.endpoint),{method:'POST',headers:{'content-type':'application/json',...headers},body:'{}'});assert.equal(denied.status,401);
    }
    const crossed=await fetch(new URL('control/dots_status',f.endpoint),{method:'POST',headers:{'content-type':'application/json','X-Codex-Dots-Worker-Token':tokens.worker},body:'{}'});assert.equal(crossed.status,401);
    for(const route of ['mcp/dot','control/dots_status']) for(const extra of [{origin:'https://example.com'}]) {
      const denied=await fetch(new URL(route,f.endpoint),{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${tokens.caller}`,'X-Codex-Dots-Worker-Token':tokens.worker,...extra},body:'{}'});assert.ok(denied.status>=400&&denied.status<500,`${route} ${JSON.stringify(extra)} must reject browser/foreign-host traffic`);await denied.arrayBuffer();
    }
    // fetch owns its Host header; use the actual Node HTTP wire to send a foreign host.
    for(const route of ['mcp/dot','control/dots_status']) {
      const status=await new Promise<number>((resolve,reject)=>{
        const request=httpRequest(new URL(route,f.endpoint),{method:'POST',headers:{host:'evil.example:1234','content-type':'application/json',authorization:`Bearer ${tokens.caller}`,'X-Codex-Dots-Worker-Token':tokens.worker}},response=>{response.resume();response.once('end',()=>resolve(response.statusCode!));});
        request.on('error',reject);request.end('{}');
      });assert.equal(status,403,route);
    }
    const legacy=await fetch(new URL('mcp/dot',f.endpoint),{method:'POST',headers:{'content-type':'application/json','X-Codex-Dots-Worker-Token':tokens.worker},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'legacy',version:'1'}}})});assert.ok((await legacy.json() as any).error);
    const subscription={name:'task.available',arguments:{queue:'tasks'},delivery:{mode:'webhook',url:'https://synthetic.example/callback',secret:`whsec_${Buffer.alloc(32,5).toString('base64')}`},cursor:null,ttlMs:120_000};
    const wrong=await f.rpc('events/subscribe',{...subscription,arguments:{queue:'p0'}});assert.equal(wrong.body.error.code,-32602);assert.equal(f.deliveries.length,0);
    const subscribed=await f.rpc('events/subscribe',subscription);assert.ok(!subscribed.body.error,JSON.stringify(subscribed.body));assert.ok(subscribed.body.result.id);
    const task=(await f.control('dots_submit',{idempotency_key:'event-task',title:'Synthetic only',input:{text:'Body must not travel in the event'}})).body;
    await f.events.pump();const event=f.deliveries.find(p=>p.name==='task.available');assert.deepEqual(event.data,{task_id:task.task_id,queue:'tasks'});assert.ok(!JSON.stringify(event).includes(task.input.text));assert.equal(f.store.get(task.task_id).status,'queued');
    const stopped=await f.rpc('events/unsubscribe',{name:subscription.name,arguments:subscription.arguments,delivery:{mode:'webhook',url:subscription.delivery.url}});assert.ok(!stopped.body.error);assert.equal(f.store.status().subscriptions[0]?.active,false);
    assert.ok(!JSON.stringify(f.store.evidence()).includes(subscription.delivery.secret));
  }finally{await f.close();}
});

test('actual stdio caller submits text, binds a saved answer, resumes the same task and distinguishes retrieval/ACK/acceptance',async()=>{
  const f=await fixture(),caller=stdio(f.dir);try {
    await caller.initialize();const tools=(await caller.call('tools/list')).result.tools;
    assert.deepEqual(tools.map((t:any)=>t.name).sort(),['dots_submit','dots_list','dots_get','dots_wait','dots_message','dots_followup','dots_cancel','dots_status','dots_ack_result'].sort());
    assert.equal(tools.find((t:any)=>t.name==='dots_wait').inputSchema.properties.timeout_seconds.maximum,20);
    const submission={idempotency_key:'actual-text',title:'Summarize supplied text',input:{text:'A blue box holds two synthetic items.',links:[{url:'https://example.com/reference',label:'reference only'}]},logical_session_id:'synthetic-session'};
    const task=await caller.tool('dots_submit',submission);assert.equal((await caller.tool('dots_submit',submission)).task_id,task.task_id);
    const index=await caller.tool('dots_list',{});assert.equal(index[0].task_id,task.task_id);assert.equal(index[0].input,undefined);assert.ok(!JSON.stringify(index).includes(submission.input.text));
    const workerIndex=await f.worker('list_tasks',{});assert.equal(workerIndex[0].task_id,task.task_id);assert.equal(workerIndex[0].input,undefined);assert.equal((await f.worker('get_task',{task_id:task.task_id})).input.text,submission.input.text);
    assert.equal(task.safe_to_retry,false);const owned={task_id:task.task_id};
    const first=await f.worker('claim_task',{...owned,claim_key:'first'});assert.equal((await f.worker('checkpoint_task',{...owned,claim_token:first.claim_token,input_revision:1})).acknowledged,true);
    const waiting=await f.worker('request_input',{...owned,claim_token:first.claim_token,question_key:'format',question:'Which output format?',options:['plain text','structured'],checkpoint:'Read the provided sentence'});
    assert.equal(waiting.status,'waiting_input');const question=await caller.tool('dots_wait',{...owned,after_sequence:first.change_sequence,timeout_seconds:0});assert.equal(question.task.active_question_id,waiting.active_question_id);assert.equal(question.task.questions[0].question,'Which output format?');
    toolError(await caller.call('tools/call',{name:'dots_message',arguments:{...owned,message_key:'unbound',text:'structured'}}),'question_id_required');
    toolError(await caller.call('tools/call',{name:'dots_message',arguments:{...owned,message_key:'wrong-question',question_id:randomUUID(),text:'structured'}}),'question_not_found');
    const answer={...owned,message_key:'answer',question_id:waiting.active_question_id,text:'structured'};
    const queued=await caller.tool('dots_message',answer);assert.equal(queued.task_id,task.task_id);assert.equal(queued.input_revision,2);assert.equal((await caller.tool('dots_message',answer)).input_revision,2);
    const resumed=await f.worker('claim_task',{...owned,claim_key:'resumed'});assert.notEqual(resumed.claim_token,first.claim_token);assert.equal(resumed.attempt,2);assert.equal(resumed.input_revision,2);
    assert.equal(resumed.questions[0].answer.text,'structured');
    toolError((await f.rpc('tools/call',{name:'checkpoint_task',arguments:{...owned,claim_token:first.claim_token,input_revision:2}})).body,'attempt_not_current');
    assert.equal((await f.worker('checkpoint_task',{...owned,claim_token:resumed.claim_token,input_revision:2})).acknowledged,true);
    const result={text:'The blue box contains two items.',data:{color:'blue',items:2},links:[{url:'https://example.com/report',label:'synthetic reference'}]};
    const completeArgs={...owned,claim_token:resumed.claim_token,input_revision:2,completion_key:'complete',result};const completed=await f.worker('complete_task',completeArgs);
    assert.equal(completed.status,'completed');assert.equal(completed.accepted_as_final,true);assert.equal((await f.worker('complete_task',completeArgs)).result_id,completed.result_id);
    assert.equal(completed.result_read_at,undefined);assert.equal(completed.codex_ack_at,undefined);assert.equal(completed.user_accepted,undefined);
    const workerRead=await f.worker('get_task',owned);assert.equal(workerRead.result_read_at,undefined);
    toolError(await caller.call('tools/call',{name:'dots_ack_result',arguments:{...owned,result_id:completed.result_id}}),'result_not_read');
    const retrieved=await caller.tool('dots_get',owned);assert.deepEqual(retrieved.result,result);assert.ok(retrieved.result_read_at);assert.equal(retrieved.codex_ack_at,undefined);assert.equal(retrieved.user_accepted,undefined);
    toolError(await caller.call('tools/call',{name:'dots_ack_result',arguments:{...owned,result_id:randomUUID()}}),'result_not_found');
    const ack=await caller.tool('dots_ack_result',{...owned,result_id:retrieved.result_id});assert.ok(ack.codex_ack_at);assert.equal(ack.user_accepted,undefined);
    assert.equal((await caller.tool('dots_ack_result',{...owned,result_id:retrieved.result_id,user_accepted:true})).user_accepted,true);
    const follow=await caller.tool('dots_followup',{parent_task_id:task.task_id,idempotency_key:'follow',title:'Explain summary',input:{text:'Explain the item count.'}});assert.equal(follow.parent_task_id,task.task_id);assert.deepEqual(follow.parent_context.result,result);
    const fc=await f.worker('claim_task',{task_id:follow.task_id,claim_key:'follow-claim'});await f.worker('checkpoint_task',{task_id:follow.task_id,claim_token:fc.claim_token,input_revision:1});const fd=await f.worker('complete_task',{task_id:follow.task_id,claim_token:fc.claim_token,input_revision:1,completion_key:'follow-done',result:{text:'There are two items.'}});
    await caller.tool('dots_get',{task_id:follow.task_id});assert.equal((await caller.tool('dots_ack_result',{task_id:follow.task_id,result_id:fd.result_id,user_accepted:false})).user_accepted,false);
    for(const token of [first.claim_token,resumed.claim_token,tokens.caller,tokens.worker])assert.ok(!JSON.stringify(retrieved).includes(token));
    const status=await caller.tool('dots_status',{});assert.ok(!JSON.stringify(status).includes(submission.input.text));assert.equal((await caller.tool('dots_list',{logical_session_id:'synthetic-session'})).length,2);
    assert.ok(!caller.output().includes(first.claim_token));assert.ok(!caller.output().includes(resumed.claim_token));
    await f.closeService();
    toolError(await caller.call('tools/call',{name:'dots_status',arguments:{}}),'service_not_running');
  }finally{await caller.close();await f.close();}
});

test('bounded HTTP wait does not resubmit/cancel, wakes for concurrent input and closes promptly',async()=>{
  const f=await fixture();try {
    const task=(await f.control('dots_submit',{idempotency_key:'wait',title:'Wait specimen',input:{text:'Synthetic wait input'}})).body;
    const owned={task_id:task.task_id};const tooLong=await f.control('dots_wait',{...owned,timeout_seconds:21});assert.equal(tooLong.status,400);assert.equal(tooLong.body.error,'invalid_parameters');
    const started=performance.now();const timeout=await f.control('dots_wait',{...owned,after_sequence:task.change_sequence,timeout_seconds:0.08});assert.equal(timeout.body.timed_out,true);assert.equal(timeout.body.changed,false);assert.equal(timeout.body.task.status,'queued');assert.ok(performance.now()-started<1500);
    assert.equal(f.store.list().length,1);assert.equal(f.store.get(task.task_id).attempt,0);assert.equal(f.store.get(task.task_id).cancel_request,undefined);
    const pending=f.control('dots_wait',{...owned,after_sequence:task.change_sequence,timeout_seconds:4});await delay(50);await f.control('dots_message',{...owned,message_key:'update',text:'New actual requirement'});const changed=await pending;assert.equal(changed.body.changed,true);assert.equal(changed.body.timed_out,false);assert.equal(changed.body.task.input_revision,2);
    const current=f.store.get(task.task_id);const closing=f.control('dots_wait',{...owned,after_sequence:current.change_sequence,timeout_seconds:20});await delay(60);const closeAt=performance.now();await f.closeService();const interrupted=await closing;assert.equal(interrupted.body.interrupted,true);assert.equal(interrupted.body.timed_out,false);assert.ok(performance.now()-closeAt<2000,'shutdown must interrupt the 20-second wait');assert.equal(f.store.get(task.task_id).status,'queued');
  }finally{await f.close();}
});

test('running input changes reject premature completion; cancellation remains pending until owned stop ACK',async()=>{
  const f=await fixture();try {
    const task=(await f.control('dots_submit',{idempotency_key:'cancel',title:'Synthetic running task',input:{text:'Prepare a result'}})).body;
    const claim=await f.worker('claim_task',{task_id:task.task_id,claim_key:'claim'});const owned={task_id:task.task_id,claim_token:claim.claim_token};await f.worker('checkpoint_task',{...owned,input_revision:1});
    await f.control('dots_message',{task_id:task.task_id,message_key:'correction',text:'Use the corrected input'});
    const staleFailure=await f.worker('fail_task',{...owned,input_revision:1,failure_key:'old-failure',error:{code:'old_input',message:'Failure only applies to the previous input'}});assert.equal(staleFailure.accepted_as_final,false);assert.equal(staleFailure.status,'running');
    const stale=await f.worker('complete_task',{...owned,input_revision:1,completion_key:'stale',result:{text:'Old result'}});assert.equal(stale.accepted_as_final,false);assert.equal(stale.status,'running');assert.equal(stale.result_id,undefined);
    const unadopted=await f.worker('complete_task',{...owned,input_revision:2,completion_key:'unadopted',result:{text:'No checkpoint yet'}});assert.equal(unadopted.accepted_as_final,false);
    await f.worker('checkpoint_task',{...owned,input_revision:2});const cancelled=await f.control('dots_cancel',{task_id:task.task_id,request_key:'stop',reason:'Synthetic user stop'});assert.equal(cancelled.body.status,'cancel_requested');
    const checkpoint=await f.worker('checkpoint_task',{...owned,input_revision:2});assert.equal(checkpoint.cancel_request.request_key,'stop');
    const late=await f.worker('complete_task',{...owned,input_revision:2,completion_key:'after-stop',result:{text:'Racing result'}});assert.equal(late.accepted_as_final,false);assert.equal(late.status,'cancel_requested');
    assert.equal((await f.worker('ack_cancel',{...owned,ack_key:'stopped',note:'Synthetic execution has stopped'})).status,'cancelled');assert.equal((await f.control('dots_get',{task_id:task.task_id})).body.result_id,undefined);
  }finally{await f.close();}
});

test('default fetch keepalive and an active wait allow bounded service shutdown',async()=>{
  const f=await fixture();try {
    const task=(await f.control('dots_submit',{idempotency_key:'keepalive-shutdown',title:'Synthetic shutdown specimen',input:{text:'Keep this queued'}},true)).body;
    // A normal long-lived caller first leaves an idle connection, then starts an active wait.
    await f.control('dots_status',{},true);
    const wait=f.control('dots_wait',{task_id:task.task_id,after_sequence:task.change_sequence,timeout_seconds:20},true);
    await delay(60);const started=performance.now();const closing=f.closeService();
    const bounded=await Promise.race([closing.then(()=>true),delay(2000).then(()=>false)]);
    const elapsed=performance.now()-started;
    if(!bounded) {
      // Only fixture teardown: isolate whether idle connections are holding production shutdown.
      f.closeIdleConnections();await closing;
    }
    const response=await wait;assert.equal(response.body.interrupted,true);assert.equal(response.body.timed_out,false);
    assert.equal(bounded,true,`default keepalive shutdown exceeded 2000 ms (${Math.round(elapsed)} ms before fixture idle-connection cleanup)`);
    assert.equal(f.store.get(task.task_id).status,'queued');
  }finally{f.closeIdleConnections();await f.close();}
});
