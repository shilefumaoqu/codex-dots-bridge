import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ProbeStore } from '../src/store.js';
import { ProbeEvents } from '../src/events.js';
import { createService } from '../src/service.js';
import { writeConfig } from '../src/runtime.js';

const tokens={caller:'a'.repeat(64),worker:'b'.repeat(64)};
const meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}};
async function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'codex dots p0 '));
  const store=new ProbeStore(join(dir,'probe.sqlite'));
  const events=new ProbeEvents(store,async(_url,_secret,_sub,_id,payload)=>({status:200,body:JSON.stringify(payload)}));
  const service=createService(store,events,tokens);
  const endpoint=await service.start();
  writeConfig(dir,{owner:'codex-dots-bridge-p0',instance_id:randomUUID(),endpoint});
  writeFileSync(join(dir,'caller.key'),tokens.caller);
  return {dir,store,events,endpoint,
    async close(){await service.close();store.close();rmSync(dir,{recursive:true,force:true});},
    async rpc(method:string,params:Record<string,unknown>={}) {
      const response=await fetch(new URL('mcp/dot',endpoint),{method:'POST',headers:{
        'Content-Type':'application/json','Accept':'application/json, text/event-stream',
        'X-Codex-Dots-Worker-Token':tokens.worker,'MCP-Protocol-Version':'2026-07-28','Mcp-Method':method,
        ...(method==='tools/call'?{'Mcp-Name':params.name as string}:{})},
        body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,_meta:meta}})});
      return {status:response.status,body:await response.json() as any};
    },
  };
}

test('modern MCP wire exposes Events and tools; rejects missing credentials and legacy traffic',async()=>{
  const f=await fixture();
  try {
    const discover=await f.rpc('server/discover');
    assert.equal(discover.status,200); assert.equal(discover.body.result.resultType,'complete');
    assert.deepEqual(discover.body.result.capabilities.events,{});
    const list=await f.rpc('events/list');
    assert.equal(list.body.result.events[0].name,'task.available');
    const tools=await f.rpc('tools/list'); assert.equal(tools.body.result.tools.length,7);
    const denied=await fetch(new URL('mcp/dot',f.endpoint),{method:'POST',headers:{'Content-Type':'application/json',authorization:`Bearer ${tokens.caller}`},body:'{}'});
    assert.equal(denied.status,401);
    for(const suffix of ['?bypass=1','?','?name=tools/list']) {
      const query=await fetch(new URL(`mcp/dot${suffix}`,f.endpoint),{method:'POST',headers:{'Content-Type':'application/json','MCP-Protocol-Version':'2026-07-28','Mcp-Method':'tools/list'},
        body:JSON.stringify({jsonrpc:'2.0',id:5,method:'tools/list',params:{_meta:meta}})});
      assert.equal(query.status,401,`worker query variant ${suffix} must authenticate`);
    }
    const crossed=await fetch(new URL('control/dots_status',f.endpoint),{method:'POST',headers:{'Content-Type':'application/json','X-Codex-Dots-Worker-Token':tokens.worker},body:'{}'});
    assert.equal(crossed.status,401);
    const queryControl=await fetch(new URL('control/dots_status?bypass=1',f.endpoint),{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(queryControl.status,401);
    const legacy=await fetch(new URL('mcp/dot',f.endpoint),{method:'POST',headers:{'Content-Type':'application/json','X-Codex-Dots-Worker-Token':tokens.worker},body:JSON.stringify({jsonrpc:'2.0',id:3,method:'initialize',params:{protocolVersion:'2025-11-25',clientInfo:{name:'probe',version:'1'},capabilities:{}}})});
    const body=await legacy.json() as any; assert.ok(body.error);
    const browser=await fetch(new URL('control/dots_status',f.endpoint),{method:'POST',headers:{'Content-Type':'application/json',authorization:`Bearer ${tokens.caller}`,origin:'https://example.com'},body:'{}'});
    assert.equal(browser.status,403);
  } finally {await f.close();}
});

test('real local stdio caller and HTTP worker complete one probe and acknowledge the persisted body',async()=>{
  const f=await fixture();
  const child=spawn(process.execPath,['--import','tsx','src/cli.ts','stdio','--data-dir',f.dir],{cwd:process.cwd(),stdio:['pipe','pipe','pipe'],windowsHide:true});
  const waiting=new Map<number,{resolve:(x:any)=>void,reject:(e:Error)=>void}>();
  let buffer='',sequence=0,stderr='';
  child.stderr.on('data',chunk=>stderr+=chunk.toString());
  child.stdout.on('data',chunk=>{
    buffer+=chunk.toString();
    while(buffer.includes('\n')) {
      const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);
      const value=JSON.parse(line); if(value.id!==undefined) {waiting.get(value.id)?.resolve(value);waiting.delete(value.id);}
    }
  });
  const call=(method:string,params:unknown={})=>new Promise<any>((resolve,reject)=>{
    const id=++sequence;
    const timer=setTimeout(()=>{waiting.delete(id);reject(new Error(`stdio timeout: ${stderr}`));},10_000);
    waiting.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
  const text=(r:any)=>{assert.ok(!r.error,JSON.stringify(r));assert.ok(!r.result.isError,JSON.stringify(r));return JSON.parse(r.result.content[0].text);};
  try {
    const opened=await call('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test-codex',version:'1'}});
    assert.equal(opened.result.protocolVersion,'2025-11-25');
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    const list=await call('tools/list');assert.equal(list.result.tools.length,6);
    const task=text(await call('tools/call',{name:'dots_submit',arguments:{case:'echo',idempotency_key:'p0-local-echo'}}));
    const claim=text((await f.rpc('tools/call',{name:'claim_task',arguments:{task_id:task.task_id,claim_key:'claim-1'}})).body);
    const complete=text((await f.rpc('tools/call',{name:'complete_task',arguments:{task_id:task.task_id,claim_token:claim.claim_token,input_revision:1,completion_key:'complete-1',result:{nonce:task.nonce}}})).body);
    assert.equal(complete.status,'completed');
    const retrieved=text(await call('tools/call',{name:'dots_get',arguments:{task_id:task.task_id}}));
    assert.deepEqual(retrieved.result,{nonce:task.nonce});assert.equal(retrieved.codex_ack_at,undefined);
    const ack=text(await call('tools/call',{name:'dots_ack_result',arguments:{task_id:task.task_id,result_id:retrieved.result_id}}));
    assert.ok(ack.codex_ack_at);
    assert.ok(!JSON.stringify(retrieved).includes(claim.claim_token));
    assert.ok(!JSON.stringify(f.store.evidence()).includes(tokens.worker));
  } finally {
    const closed=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.stdin.end();await closed;
    await f.close();
  }
});

test('Events custom methods validate challenge, expiration and unsubscribe on the actual modern wire',async()=>{
  const f=await fixture();
  try {
    const secret=`whsec_${Buffer.alloc(32,5).toString('base64')}`;
    const params={name:'task.available',arguments:{queue:'p0'},delivery:{mode:'webhook',url:'https://callback.example/mcp',secret},cursor:null,ttlMs:120_000};
    const subscribe=await f.rpc('events/subscribe',params);
    assert.ok(!subscribe.body.error,JSON.stringify(subscribe.body));
    assert.equal(subscribe.body.result.resultType,'complete');assert.ok(subscribe.body.result.id);
    const stopped=await f.rpc('events/unsubscribe',{...params,delivery:{mode:'webhook',url:params.delivery.url}});
    assert.ok(!stopped.body.error,JSON.stringify(stopped.body));
    assert.equal(stopped.body.result.resultType,'complete');
    assert.equal(f.store.status().subscriptions[0]?.active,false);
    const invalid=await f.rpc('events/subscribe',{...params,delivery:{...params.delivery,secret:'bad'}});
    assert.equal(invalid.body.error.code,-32015);
    assert.ok(!JSON.stringify(invalid.body).includes(secret));
  } finally {await f.close();}
});
