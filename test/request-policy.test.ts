import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore } from '../src/task-store.js';
import { ProbeEvents } from '../src/events.js';
import { createProductionService, callControl, workerSchemas } from '../src/bridge.js';
import { boundedArguments, BUSINESS_ARGUMENT_BYTES, PROTOCOL_ENVELOPE_BYTES, requestFailure } from '../src/request-policy.js';
import { ProbeError } from '../src/store.js';

test('refusal reasons are additive, typed and sanitized without changing legacy errors',()=>{
  const code='reply_subscription_unavailable',legacy={status:409,body:{error:code,category:'state',retryable:false}};
  assert.deepEqual(requestFailure(new ProbeError(code),code),legacy);
  for(const reason of ['chat_message_expired','chat_route_unavailable'] as const)
    assert.deepEqual(requestFailure(new ProbeError(code,reason),code),{...legacy,body:{...legacy.body,reason}});
  assert.deepEqual(requestFailure({code,reason:'PRIVATE_BODY'},code),legacy);
  assert.deepEqual(requestFailure(Object.assign(new ProbeError(code),{reason:'PRIVATE_BODY'}),code),legacy);
  assert.deepEqual(requestFailure(new ProbeError('other','chat_message_expired'),code),legacy);
});

test('UTF-8 business budget includes escaping and permits 100,000 Chinese characters', () => {
  assert.equal(boundedArguments({text:'中'.repeat(100000)}).text.length,100000);
  assert.throws(()=>boundedArguments({text:'中'.repeat(BUSINESS_ARGUMENT_BYTES/3)}),/arguments_too_large/);
  assert.throws(()=>boundedArguments({text:'\u0000'.repeat(180000)}),/arguments_too_large/);
});

test('production control accepts advertised Chinese input and rejects oversize envelopes before business writes', async()=>{
  const store=new TaskStore(':memory:');
  const service=createProductionService(store,new ProbeEvents(store,undefined,'tasks'),{caller:'a'.repeat(64),worker:'b'.repeat(64)});
  const headers={host:'localhost',authorization:'Bearer '+'a'.repeat(64),'content-type':'application/json'};
  try {
    const good=await service.app.inject({method:'POST',url:'/control/dots_submit',headers,payload:{idempotency_key:'large-cn',title:'Chinese',input:{text:'中'.repeat(100000)}}});
    assert.equal(good.statusCode,200);assert.equal(good.json().status,'queued');
    const count=store.db.prepare('SELECT count(*) AS n FROM tasks').get();
    const large=await service.app.inject({method:'POST',url:'/control/dots_submit',headers,payload:JSON.stringify({text:'x'.repeat(PROTOCOL_ENVELOPE_BYTES)})});
    assert.equal(large.statusCode,413);assert.equal(large.json().error,'arguments_too_large');
    const business=await service.app.inject({method:'POST',url:'/control/dots_submit',headers,payload:{text:'x'.repeat(BUSINESS_ARGUMENT_BYTES)}});
    assert.equal(business.statusCode,413);
    const invalid=await service.app.inject({method:'POST',url:'/control/dots_submit',headers,payload:'{'});
    assert.equal(invalid.statusCode,400);
    assert.deepEqual(store.db.prepare('SELECT count(*) AS n FROM tasks').get(),count);
    await assert.rejects(callControl(store,'dots_submit',{text:'x'.repeat(BUSINESS_ARGUMENT_BYTES)}),/arguments_too_large/);
  } finally {await service.close();store.close();}
});

test('new command response modes are explicit while legacy defaults remain absent',()=>{
  const input={task_id:'11111111-1111-4111-8111-111111111111',claim_key:'stable'};
  assert.equal(workerSchemas.claim_task.parse(input).response_mode,undefined);
  assert.equal(workerSchemas.claim_task.parse({...input,response_mode:'compact'}).response_mode,'compact');
});
