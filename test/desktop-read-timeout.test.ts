import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { DesktopConversationsService } from '../src/desktop-conversations.js';

for (const shutdown of [false, true]) test(shutdown ? 'close stays closed rather than timeout' : 'read deadline reports timeout rather than closed and never delivers late success', async () => {
 const db=new Database(':memory:');const thread=randomUUID(),request=randomUUID();let started!:()=>void;
 const ready=new Promise<void>(resolve=>{started=resolve;});
 const service=new DesktopConversationsService(db,{enabled:true,mode:'local',codex_home:tmpdir(),read:true,send:false},{timeoutMs:shutdown?1000:10,transport:{
  runRead:async input=>{
   await new Promise<void>(resolve=>{input.signal.addEventListener('abort',()=>resolve(),{once:true});started();});
   // Even a transport returning success after abort must not be delivered.
   return {status:'completed',verification:'native_stored_history',history_source:'codex_app_server',stored_history_complete:true,source_complete:false,context_json:JSON.stringify({thread:{id:thread,turns:[]},turns_source:'thread/turns/list:full'})};
  },runSend:async()=>{throw Error('unexpected_send');}
 }});
 try{
  service.read({request_id:request,thread_id:thread});await ready;
  if(shutdown)await service.close();
  const receipt=await service.get({request_id:request,wait_seconds:1});
  assert.equal(receipt.status,'skipped_unknown');assert.equal(receipt.reason,shutdown?'closed':'timeout');
  assert.equal(receipt.context_chunk,undefined);assert.equal((service as any).readCache.size,0);
 }finally{await service.close();db.close();}
});
