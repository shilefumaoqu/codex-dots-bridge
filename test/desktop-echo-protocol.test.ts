import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { TaskStore } from '../src/task-store.js';
import { ProbeEvents } from '../src/events.js';
import { createProductionService } from '../src/bridge.js';
import type { DesktopEchoService } from '../src/desktop-echo.js';

test('shutdown aborts desktop work before waiting for HTTP clients to drain',async()=>{
  const store=new TaskStore(':memory:');
  let aborted=false,release:()=>void=()=>{};
  let signalCloseEntered:()=>void=()=>{};
  const closeEntered=new Promise<void>(done=>{signalCloseEntered=done;});
  const desktop={enabled:false,close:async()=>{aborted=true;}} as unknown as DesktopEchoService;
  const service=createProductionService(store,new ProbeEvents(store,async()=>({status:200,body:'{}'}),'tasks'),{caller:'a'.repeat(64),worker:'b'.repeat(64)},undefined,undefined,undefined,desktop);
  const originalClose=service.app.close.bind(service.app);
  service.app.close=(()=>new Promise<void>(done=>{release=done;signalCloseEntered();})) as typeof service.app.close;
  try {
    const closing=service.close();await closeEntered;
    assert.equal(aborted,true);release();await closing;
  } finally {await originalClose();store.close();}
});

test('optional desktop tools are worker-only, strict and isolated from the forward queue', async()=>{
  for(const enabled of [false,true]) {
    const dir=mkdtempSync(join(tmpdir(),'cdb-echo-protocol-'));
    const store=new TaskStore(join(dir,'tasks.sqlite'));
    const events=new ProbeEvents(store,async()=>({status:200,body:'{}'}),'tasks');
    let sends=0,reads=0,closed=0;
    const requestId=randomUUID();
    const desktop={enabled,start:({request_id}:{request_id:string})=>{sends++;return {request_id,status:'pending'};},
      get:({request_id}:{request_id:string})=>{reads++;return {request_id,status:'skipped_busy'};},
      close:async()=>{closed++;}} as unknown as DesktopEchoService;
    const service=createProductionService(store,events,{caller:'a'.repeat(64),worker:'b'.repeat(64)},undefined,undefined,undefined,desktop);
    const endpoint=await service.start();
    const rpc=async(method:string,params:Record<string,unknown>={},token='b'.repeat(64))=>{
      const response=await fetch(new URL('mcp/dot',endpoint),{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Connection:'close','X-Codex-Dots-Worker-Token':token,'MCP-Protocol-Version':'2026-07-28','Mcp-Method':method,...(method==='tools/call'?{'Mcp-Name':String(params.name)}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}}}),signal:AbortSignal.timeout(5000)});
      return {status:response.status,body:await response.json() as any};
    };
    try {
      const tools=(await rpc('tools/list')).body.result.tools;
      assert.equal(tools.some((t:any)=>t.name==='codex_desktop_echo'),enabled);
      assert.equal(tools.some((t:any)=>t.name==='codex_desktop_echo_status'),enabled);
      assert.ok(tools.some((t:any)=>t.name==='claim_task'));
      assert.equal((await rpc('tools/call',{name:'codex_desktop_echo',arguments:{request_id:requestId}},'a'.repeat(64))).status,401);
      if(enabled) {
        const write=tools.find((t:any)=>t.name==='codex_desktop_echo');
        const read=tools.find((t:any)=>t.name==='codex_desktop_echo_status');
        assert.equal(write.annotations.readOnlyHint,false);assert.equal(read.annotations.readOnlyHint,true);
        assert.deepEqual(Object.keys(write.inputSchema.properties),['request_id']);
        for(const args of [{request_id:requestId,text:'arbitrary'}, {request_id:requestId,thread_id:randomUUID()}, {request_id:'invalid'}]) {
          const bad=(await rpc('tools/call',{name:'codex_desktop_echo',arguments:args})).body;
          assert.ok(bad.error || bad.result?.isError);
        }
        assert.equal(sends,0);
        const start=(await rpc('tools/call',{name:'codex_desktop_echo',arguments:{request_id:requestId}})).body;
        assert.equal(JSON.parse(start.result.content[0].text).status,'pending');
        const status=(await rpc('tools/call',{name:'codex_desktop_echo_status',arguments:{request_id:requestId}})).body;
        assert.equal(JSON.parse(status.result.content[0].text).status,'skipped_busy');
        assert.equal(sends,1);assert.equal(reads,1);
      }
      const response=await fetch(new URL('control/dots_submit',endpoint),{method:'POST',headers:{'content-type':'application/json',Connection:'close',authorization:`Bearer ${'a'.repeat(64)}`},body:JSON.stringify({idempotency_key:randomUUID(),title:'independent forward task',input:{text:'synthetic'}}),signal:AbortSignal.timeout(5000)});
      assert.equal(response.status,200);assert.equal((await response.json() as any).status,'queued');
      assert.equal(store.status().tasks.length,1);
      const caller=await fetch(new URL('control/codex_desktop_echo',endpoint),{method:'POST',headers:{'content-type':'application/json',Connection:'close',authorization:`Bearer ${'a'.repeat(64)}`},body:JSON.stringify({request_id:requestId}),signal:AbortSignal.timeout(5000)});
      assert.notEqual(caller.status,200);
    } finally {
      await service.close();assert.equal(closed,1);store.close();
      const rel=relative(resolve(tmpdir()),resolve(dir));assert.ok(rel.startsWith('cdb-echo-protocol-')&&!rel.startsWith('..')&&!isAbsolute(rel));rmSync(dir,{recursive:true,force:true});
    }
  }
});
