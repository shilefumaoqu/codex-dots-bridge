import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore } from '../src/task-store.js';
import { ProbeEvents } from '../src/events.js';
import { createProductionService } from '../src/bridge.js';

test('caller status exposes local capabilities without environment paths or caller-supplied extras', async () => {
  const store=new TaskStore(':memory:');
  const access={enabled:true,mode:'local',read:true,send:false};
  const runtime={tunnel_configured:false,tunnel_health:'not_configured',supervisor:'running',bridge:'running',tunnel:'stopped',guardian:'stopped'};
  const service=createProductionService(store,new ProbeEvents(store,async()=>({status:200,body:'{}'}),'tasks'),{caller:'a'.repeat(64),worker:'b'.repeat(64)},
    ()=>({...runtime,desktop_conversations:{...access,codex_home:'PRIVATE_PATH_SENTINEL',targets:['PRIVATE_ID']}}));
  try {
    const reply=await service.app.inject({method:'POST',url:'/control/dots_status',headers:{host:'127.0.0.1',authorization:'Bearer '+'a'.repeat(64)},payload:{}});
    assert.equal(reply.statusCode,200); const body=reply.json();
    assert.equal(body.diagnostics,'available'); assert.deepEqual(body.desktop_conversations,access);
    assert.ok(!reply.body.includes('PRIVATE_'));
    assert.deepEqual(body.task_counts,{});
  } finally { await service.close(); store.close(); }
});
