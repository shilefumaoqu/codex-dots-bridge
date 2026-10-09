import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TaskStore } from '../src/task-store.js';
import { ProbeStore } from '../src/store.js';

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'dots-task-store-')); let time=Date.parse('2026-10-09T00:00:00Z');
  const path=join(dir,'tasks.sqlite'); let store=new TaskStore(path,()=>time);
  return {get store(){return store;},advance(ms:number){time+=ms;},restart(){store.close();store=new TaskStore(path,()=>time);return store;},close(){store.close();rmSync(dir,{recursive:true,force:true});},path,now:()=>time};
}
function submit(store:TaskStore,key:string,extra:Record<string,unknown>={}) { return store.submit({idempotency_key:key,title:key,input:{text:'Read the supplied text and summarize it.'},...extra}); }
function err(code:string) { return (e:unknown)=>(e as {code:string}).code===code; }

test('FIFO, slot isolation and read/ACK/acceptance persist independently across restart',()=>{
  const f=fixture(); try {
    const first=submit(f.store,'first'),second=submit(f.store,'second');
    assert.throws(()=>f.store.claim({task_id:second.task_id,claim_key:'skip'}),err('not_queue_head'));
    const c=f.store.claim({task_id:first.task_id,claim_key:'claim-first'});
    assert.equal(f.store.claim({task_id:first.task_id,claim_key:'claim-first'}).claim_token,c.claim_token);
    assert.throws(()=>f.store.claim({task_id:second.task_id,claim_key:'claim-second'}),err('execution_slot_occupied'));
    f.store.checkpoint({task_id:first.task_id,claim_token:c.claim_token,input_revision:1});
    const done=f.store.complete({task_id:first.task_id,claim_token:c.claim_token,completion_key:'done',input_revision:1,result:{text:'Summary',data:{items:2},links:[{url:'https://example.com/report'}]}});
    assert.equal(done.accepted_as_final,true); assert.equal(done.result_read_at,undefined); assert.equal(done.codex_ack_at,undefined);assert.equal(done.user_accepted,undefined);
    assert.equal(f.restart().get(first.task_id).result_read_at,undefined);
    assert.throws(()=>f.store.ack({task_id:first.task_id,result_id:done.result_id!}),err('result_not_read'));
    assert.throws(()=>f.store.ack({task_id:first.task_id,result_id:done.result_id!,user_accepted:true}),err('result_not_read'));
    const read=f.store.get(first.task_id,{record_read:true}); assert.ok(read.result_read_at); assert.equal(read.codex_ack_at,undefined);
    const ack=f.store.ack({task_id:first.task_id,result_id:done.result_id!}); assert.ok(ack.codex_ack_at);assert.equal(ack.user_accepted,undefined);
    const accepted=f.store.ack({task_id:first.task_id,result_id:done.result_id!,user_accepted:true});assert.equal(accepted.user_accepted,true);
    assert.throws(()=>f.store.ack({task_id:first.task_id,result_id:done.result_id!,user_accepted:false}),err('acceptance_conflict'));
    const safe=JSON.stringify(f.store.get(first.task_id)); assert.ok(!safe.includes(c.claim_token));assert.ok(!safe.includes('claim-first'));assert.ok(!safe.includes('claim_token'));
    assert.equal(f.store.claim({task_id:second.task_id,claim_key:'claim-second'}).status,'running');
    assert.ok(f.restart().get(first.task_id).change_sequence>done.change_sequence);
  } finally {f.close();}
});

test('failure of an older or unadopted revision remains evidence after corrected input',()=>{
  const f=fixture();try {
    const t=submit(f.store,'failure-race'),claim=f.store.claim({task_id:t.task_id,claim_key:'claim'});
    const owned={task_id:t.task_id,claim_token:claim.claim_token};
    f.store.checkpoint({...owned,input_revision:1});
    f.store.message({task_id:t.task_id,message_key:'correction',text:'The missing value is now provided.'});
    const old={...owned,input_revision:1,failure_key:'old',error:{code:'missing_input',message:'Old failure'}};
    const stale=f.store.fail(old);assert.equal(stale.status,'running');assert.equal(stale.accepted_as_final,false);assert.equal(stale.failure_disposition,'stale_revision');assert.equal(stale.error,undefined);
    assert.equal(f.store.fail(old).change_sequence,stale.change_sequence);
    const unadopted=f.store.fail({...old,input_revision:2,failure_key:'unadopted'});assert.equal(unadopted.accepted_as_final,false);assert.equal(unadopted.failure_disposition,'unacknowledged_revision');
    f.store.checkpoint({...owned,input_revision:2});
    const current=f.store.fail({...old,input_revision:2,failure_key:'current',error:{code:'different_failure',message:'Still cannot finish after considering the correction.'}});
    assert.equal(current.status,'failed');assert.equal(current.accepted_as_final,true);assert.equal(current.failure_disposition,'final');assert.equal(current.error?.code,'different_failure');
    assert.equal(f.restart().get(t.task_id).error?.code,'different_failure');
  }finally{f.close();}
});

test('same-key changed bodies conflict for submit, completion, answer, question, cancellation and resolution',()=>{
  const f=fixture(); try {
    const a=submit(f.store,'a'); assert.equal(submit(f.store,'a').task_id,a.task_id);
    assert.throws(()=>submit(f.store,'a',{title:'changed'}),err('idempotency_conflict'));
    const claim=f.store.claim({task_id:a.task_id,claim_key:'claim'});
    const question={task_id:a.task_id,claim_token:claim.claim_token,question_key:'question',question:'Which color?',options:['blue','green']};
    const waiting=f.store.requestInput(question); assert.equal(f.store.requestInput(question).active_question_id,waiting.active_question_id);
    assert.throws(()=>f.store.requestInput({...question,question:'Different?'}),err('idempotency_conflict'));
    const answer={task_id:a.task_id,message_key:'answer',question_id:waiting.active_question_id,text:'blue'};
    f.store.message(answer); assert.equal(f.store.message(answer).input_revision,2);
    assert.throws(()=>f.store.message({...answer,text:'green'}),err('idempotency_conflict'));
    assert.throws(()=>f.store.message({...answer,message_key:'answer2'}),err('answer_conflict'));
    const resumed=f.store.claim({task_id:a.task_id,claim_key:'resume'});
    f.store.checkpoint({task_id:a.task_id,claim_token:resumed.claim_token,input_revision:2});
    const complete={task_id:a.task_id,claim_token:resumed.claim_token,completion_key:'done',input_revision:2,result:{text:'blue'}};
    const done=f.store.complete(complete);assert.equal(f.store.complete(complete).submitted_result_id,done.submitted_result_id);
    assert.throws(()=>f.store.complete({...complete,result:{text:'green'}}),err('idempotency_conflict'));
    const b=submit(f.store,'b');const cancelled=f.store.cancel({task_id:b.task_id,request_key:'cancel',reason:'changed plan'});
    assert.equal(f.store.cancel({task_id:b.task_id,request_key:'cancel',reason:'changed plan'}).status,cancelled.status);
    assert.throws(()=>f.store.cancel({task_id:b.task_id,request_key:'cancel',reason:'other'}),err('idempotency_conflict'));
  } finally {f.close();}
});

test('clarification releases slot and resumes same task with new attempt and separate retry budget',()=>{
  const f=fixture();try {
    const a=submit(f.store,'a',{safe_to_retry:true}),b=submit(f.store,'b');
    let claim=f.store.claim({task_id:a.task_id,claim_key:'initial'});
    const q=f.store.requestInput({task_id:a.task_id,claim_token:claim.claim_token,question_key:'q1',question:'What should I use?',checkpoint:'Read source.'});
    const bc=f.store.claim({task_id:b.task_id,claim_key:'b'});
    f.store.message({task_id:a.task_id,message_key:'answer1',question_id:q.active_question_id,text:'Use blue'});
    assert.throws(()=>f.store.claim({task_id:a.task_id,claim_key:'second'}),err('execution_slot_occupied'));
    f.store.checkpoint({task_id:b.task_id,claim_token:bc.claim_token,input_revision:1});
    f.store.complete({task_id:b.task_id,claim_token:bc.claim_token,completion_key:'b-done',input_revision:1,result:{text:'done'}});
    const old=claim.claim_token; claim=f.store.claim({task_id:a.task_id,claim_key:'second'}); assert.notEqual(claim.claim_token,old);assert.equal(claim.task_id,a.task_id);assert.equal(claim.retry_count,0);
    const q2=f.store.requestInput({task_id:a.task_id,claim_token:claim.claim_token,question_key:'q2',question:'Another detail?'});
    assert.throws(()=>f.store.message({task_id:a.task_id,message_key:'old',question_id:q.active_question_id,text:'other'}),err('answer_conflict'));
    f.store.message({task_id:a.task_id,message_key:'answer2',question_id:q2.active_question_id,text:'Small'});
    claim=f.store.claim({task_id:a.task_id,claim_key:'third'});assert.equal(claim.attempt,3);assert.equal(claim.retry_count,0);
    f.advance(1_800_001);assert.equal(f.store.get(a.task_id).status,'queued');assert.equal(f.store.get(a.task_id).retry_count,1);
  } finally {f.close();}
});

test('running updates expose new revision; stale completion is evidence and never final',()=>{
  const f=fixture();try {
    const a=submit(f.store,'a'),c=f.store.claim({task_id:a.task_id,claim_key:'claim'});
    f.store.message({task_id:a.task_id,message_key:'edit',text:'Use the corrected title.'});
    const checkpoint=f.store.checkpoint({task_id:a.task_id,claim_token:c.claim_token,input_revision:1,summary:'Old source read'});
    assert.equal(checkpoint.acknowledged,false);assert.equal(checkpoint.input_revision,2);assert.equal(checkpoint.attempts[0]?.acknowledged_revision,0);
    const stale=f.store.complete({task_id:a.task_id,claim_token:c.claim_token,input_revision:1,completion_key:'stale',result:{text:'old'}});
    assert.equal(stale.accepted_as_final,false);assert.equal(stale.status,'running');assert.equal(stale.result_id,undefined);assert.equal(stale.results[0]?.disposition,'stale_revision');
    const unadopted=f.store.complete({task_id:a.task_id,claim_token:c.claim_token,input_revision:2,completion_key:'unadopted',result:{text:'current revision asserted only'}});
    assert.equal(unadopted.accepted_as_final,false);assert.equal(unadopted.status,'running');assert.equal(unadopted.results.at(-1)?.disposition,'unacknowledged_revision');
    const fresh=f.store.checkpoint({task_id:a.task_id,claim_token:c.claim_token,input_revision:2});assert.equal(fresh.acknowledged,true);
    const done=f.store.complete({task_id:a.task_id,claim_token:c.claim_token,input_revision:2,completion_key:'fresh',result:{text:'corrected'}});assert.equal(done.result?.text,'corrected');assert.equal(done.results.length,3);
    const late=f.store.complete({task_id:a.task_id,claim_token:c.claim_token,input_revision:2,completion_key:'after-final',result:{text:'must not replace'}});
    assert.equal(late.accepted_as_final,false);assert.equal(late.result_id,done.result_id);assert.equal(late.result?.text,'corrected');
  } finally {f.close();}
});

test('each initial or resumed claim requires explicit current-revision checkpoint before completion',()=>{
  const f=fixture();try {
    const a=submit(f.store,'a'),c=f.store.claim({task_id:a.task_id,claim_key:'first'});
    assert.equal(c.attempts[0]?.acknowledged_revision,0);
    const premature=f.store.complete({task_id:a.task_id,claim_token:c.claim_token,input_revision:1,completion_key:'premature',result:{text:'not adopted'}});
    assert.equal(premature.accepted_as_final,false);assert.equal(premature.status,'running');assert.equal(premature.results[0]?.disposition,'unacknowledged_revision');
    f.store.checkpoint({task_id:a.task_id,claim_token:c.claim_token,input_revision:1});
    const q=f.store.requestInput({task_id:a.task_id,claim_token:c.claim_token,question_key:'q',question:'Which detail?'});
    f.store.message({task_id:a.task_id,message_key:'answer',question_id:q.active_question_id,text:'New detail'});
    const resumed=f.store.claim({task_id:a.task_id,claim_key:'resume'});assert.equal(resumed.attempts.at(-1)?.acknowledged_revision,0);
    const prematureResume=f.store.complete({task_id:a.task_id,claim_token:resumed.claim_token,input_revision:2,completion_key:'premature-resume',result:{text:'not explicitly adopted'}});
    assert.equal(prematureResume.accepted_as_final,false);assert.equal(prematureResume.result_id,undefined);
    f.store.checkpoint({task_id:a.task_id,claim_token:resumed.claim_token,input_revision:2});
    const done=f.store.complete({task_id:a.task_id,claim_token:resumed.claim_token,input_revision:2,completion_key:'done',result:{text:'adopted'}});assert.equal(done.accepted_as_final,true);
  } finally {f.close();}
});

test('default lease expiration holds FIFO slot, late results stay evidence; explicit resolution survives restart',()=>{
  const f=fixture();try {
    const a=submit(f.store,'a'),b=submit(f.store,'b'),c=f.store.claim({task_id:a.task_id,claim_key:'a'});
    f.advance(1_800_001);assert.equal(f.restart().get(a.task_id).status,'reconciliation_required');
    assert.throws(()=>f.store.claim({task_id:b.task_id,claim_key:'b'}),err('execution_slot_occupied'));
    const late=f.store.complete({task_id:a.task_id,claim_token:c.claim_token,completion_key:'late',input_revision:1,result:{text:'late'}});assert.equal(late.accepted_as_final,false);assert.equal(late.result_id,undefined);
    assert.throws(()=>f.store.resolve({task_id:a.task_id,resolution_key:'resolve',decision:'complete',basis:'',result:{text:'late'}}),err('invalid_argument'));
    const resolved=f.store.resolve({task_id:a.task_id,resolution_key:'resolve',decision:'complete',basis:'Operator checked the execution log.',result:{text:'verified'}});assert.equal(resolved.result?.text,'verified');
    assert.equal(f.store.resolve({task_id:a.task_id,resolution_key:'resolve',decision:'complete',basis:'Operator checked the execution log.',result:{text:'verified'}}).result_id,resolved.result_id);
    assert.throws(()=>f.store.resolve({task_id:a.task_id,resolution_key:'resolve',decision:'fail',basis:'Different evidence'}),err('idempotency_conflict'));
    f.store.complete({task_id:a.task_id,claim_token:c.claim_token,completion_key:'even-later',input_revision:1,result:{text:'do not replace'}});assert.equal(f.store.get(a.task_id).result?.text,'verified');assert.equal(f.store.get(a.task_id).results.length,3);
    assert.equal(f.store.claim({task_id:b.task_id,claim_key:'b'}).status,'running');
  } finally {f.close();}
});

test('opt-in lease retries cap at three automatic executions; old token never overwrites new attempt',()=>{
  const f=fixture();try {
    const a=submit(f.store,'a',{safe_to_retry:true});let claim=f.store.claim({task_id:a.task_id,claim_key:'c1'});const old=claim.claim_token;
    for(let i=2;i<=3;i++) {f.advance(1_800_001);assert.equal(f.store.get(a.task_id).status,'queued');claim=f.store.claim({task_id:a.task_id,claim_key:`c${i}`});}
    const late=f.store.complete({task_id:a.task_id,claim_token:old,completion_key:'old',input_revision:1,result:{text:'old'}});assert.equal(late.accepted_as_final,false);assert.equal(late.status,'running');
    assert.throws(()=>f.store.checkpoint({task_id:a.task_id,claim_token:old,input_revision:1}),err('attempt_not_current'));
    f.advance(1_800_001);const stopped=f.store.get(a.task_id);assert.equal(stopped.status,'reconciliation_required');assert.equal(stopped.attempt,3);assert.equal(stopped.retry_count,2);
    const expired=submit(f.store,'deadline',{safe_to_retry:true,deadline_hours:0.25}); // Held head prevents claiming until resolution.
    f.store.resolve({task_id:a.task_id,resolution_key:'fail',decision:'fail',basis:'Attempts verified unsuccessful.'});const ec=f.store.claim({task_id:expired.task_id,claim_key:'deadline'});f.advance(900_001);
    assert.equal(f.store.get(expired.task_id).status,'reconciliation_required');assert.equal(f.store.get(expired.task_id).retry_count,0);assert.equal(ec.status,'running');
    assert.throws(()=>f.store.resolve({task_id:expired.task_id,resolution_key:'retry',decision:'retry',basis:'Retry considered'}),err('deadline_expired'));
  } finally {f.close();}
});

test('running cancellation holds slot; completion and failure do not prove cancellation, executor ACK does',()=>{
  const f=fixture();try {
    const a=submit(f.store,'a'),b=submit(f.store,'b'),c=f.store.claim({task_id:a.task_id,claim_key:'a'});
    assert.equal(f.store.cancel({task_id:a.task_id,request_key:'cancel'}).status,'cancel_requested');
    assert.throws(()=>f.store.message({task_id:a.task_id,message_key:'late-edit',text:'new'}),err('task_not_editable'));
    assert.equal(f.store.checkpoint({task_id:a.task_id,claim_token:c.claim_token,input_revision:1}).cancel_request?.request_key,'cancel');
    assert.equal(f.store.complete({task_id:a.task_id,claim_token:c.claim_token,input_revision:1,completion_key:'done',result:{text:'completed during cancel'}}).accepted_as_final,false);
    assert.equal(f.store.fail({task_id:a.task_id,claim_token:c.claim_token,failure_key:'fail',input_revision:1,error:{code:'stopped',message:'not proof'}}).status,'cancel_requested');
    assert.throws(()=>f.store.claim({task_id:b.task_id,claim_key:'b'}),err('execution_slot_occupied'));
    f.advance(1_800_001);assert.equal(f.store.get(a.task_id).status,'reconciliation_required');
    assert.equal(f.store.ackCancel({task_id:a.task_id,claim_token:c.claim_token,ack_key:'stopped',note:'External execution stopped.'}).status,'cancelled');
    assert.equal(f.store.claim({task_id:b.task_id,claim_key:'b'}).status,'running');assert.ok(f.store.get(a.task_id).cancellation_ack);
  } finally {f.close();}
});

test('queued/waiting expiry, followup frozen parent context and platform questions are distinct',()=>{
  const f=fixture();try {
    const a=submit(f.store,'a',{logical_session_id:'session'}),c=f.store.claim({task_id:a.task_id,claim_key:'a'});
    const q=f.store.requestInput({task_id:a.task_id,claim_token:c.claim_token,question_key:'auth',question:'Finish the official account login then report completion.',requires_platform_action:true,action_url:'https://chatgpt.com/'});
    assert.equal(q.questions[0]?.requires_platform_action,true);
    assert.throws(()=>f.store.message({task_id:a.task_id,message_key:'no-q',text:'done'}),err('question_id_required'));
    f.store.message({task_id:a.task_id,message_key:'login-status',question_id:q.active_question_id,text:'Official login finished.'});const resumed=f.store.claim({task_id:a.task_id,claim_key:'resume'});f.store.checkpoint({task_id:a.task_id,claim_token:resumed.claim_token,input_revision:2});f.store.complete({task_id:a.task_id,claim_token:resumed.claim_token,input_revision:2,completion_key:'done',result:{text:'report'}});
    const follow=f.store.followup({parent_task_id:a.task_id,idempotency_key:'follow',title:'Followup',input:{text:'Explain the report'}});assert.equal(follow.logical_session_id,'session');assert.equal(follow.parent_task_id,a.task_id);assert.equal((follow.parent_context as {result:{text:string}}).result.text,'report');
    const waiting=submit(f.store,'waiting',{deadline_hours:0.01}); f.store.cancel({task_id:follow.task_id,request_key:'skip'});const wc=f.store.claim({task_id:waiting.task_id,claim_key:'waiting'});f.store.requestInput({task_id:waiting.task_id,claim_token:wc.claim_token,question_key:'q',question:'Missing source?'});f.advance(36_001);assert.equal(f.store.get(waiting.task_id).status,'expired');
    assert.equal(f.store.list({logical_session_id:'session'}).length,2);assert.equal(f.store.status().execution_slot,undefined);
  } finally {f.close();}
});

test('outbox and task transaction rollback together, delivery retry CAS and pending persistence',()=>{
  const f=fixture();try {
    f.store.saveSubscription({id:'s',url:'https://example.com/webhook',secret:'not-a-real-secret',active:true,generation:1,expires_at:f.now()+86_400_000,verified_until:f.now()+86_400_000});
    f.store.db.exec("CREATE TRIGGER test_fail_outbox BEFORE INSERT ON task_events BEGIN SELECT RAISE(ABORT,'outbox unavailable'); END;");
    assert.throws(()=>submit(f.store,'rollback'),/outbox unavailable/);assert.equal(f.store.list().length,0);assert.equal(f.store.pending().length,0);
    f.store.db.exec('DROP TRIGGER test_fail_outbox');const a=submit(f.store,'persist');const first=f.store.pending()[0]!;assert.deepEqual(JSON.parse(first.payload).data,{task_id:a.task_id,queue:'tasks'});
    assert.equal(f.restart().pending()[0]?.event_id,first.event_id);assert.equal(f.store.get(a.task_id).status,'queued');
    f.store.deliveryResult(first,500);f.store.deliveryResult(first,200); // stale response cannot clobber the retry state
    assert.equal((f.store.db.prepare('SELECT attempts,status FROM task_deliveries WHERE id=?').get(first.id) as {attempts:number;status:string}).status,'pending');
    f.advance(2001);const retry=f.store.pending()[0]!;assert.equal(retry.attempts,1);f.store.deliveryResult(retry,200);assert.equal(f.store.pending().length,0);
    const kinds=(f.store.evidence() as {kind:string}[]).map(x=>x.kind);assert.ok(kinds.includes('event_receipt'));assert.ok(!kinds.includes('claimed'));assert.equal(f.store.get(a.task_id).result_read_at,undefined);
    submit(f.store,'stop');f.store.unsubscribe('s',0);assert.ok(f.store.pending().length>0);f.store.unsubscribe('s',1);assert.equal(f.store.pending().length,0);
  } finally {f.close();}
});

test('production tables coexist with P0 without adopting probe tasks or subscriptions',()=>{
  const f=fixture();try {const probe=new ProbeStore(f.path,f.now);probe.submit('echo','p0');probe.close();assert.equal(f.store.list().length,0);const a=submit(f.store,'production');assert.equal(f.restart().get(a.task_id).title,'production');const reopened=new ProbeStore(f.path,f.now);assert.equal(reopened.list().length,1);reopened.close();}finally {f.close();}
});

test('task lists sort before limits: queued FIFO, other views recent first with stable same-time order',()=>{
  const f=fixture();try {
    const first=submit(f.store,'first'),second=submit(f.store,'second'),third=submit(f.store,'third');
    assert.deepEqual(f.store.list({limit:2}).map(t=>t.task_id),[third.task_id,second.task_id]);
    assert.deepEqual(f.store.list({status:'queued',limit:2}).map(t=>t.task_id),[first.task_id,second.task_id]);
    f.advance(1);f.store.message({task_id:first.task_id,message_key:'new',text:'Updated requirements'});
    assert.equal(f.store.list({limit:1})[0]?.task_id,first.task_id);
    const c=f.store.claim({task_id:first.task_id,claim_key:'first'});
    const q=f.store.requestInput({task_id:first.task_id,claim_token:c.claim_token,question_key:'q',question:'Detail?'});
    f.store.message({task_id:first.task_id,message_key:'answer',question_id:q.active_question_id,text:'Detail'});
    assert.deepEqual(f.store.list({status:'queued',limit:2}).map(t=>t.task_id),[second.task_id,third.task_id]);
  }finally{f.close();}
});

test('default evidence and status hide task content while the private database retains exact evidence',()=>{
  const f=fixture();try {
    const secret='private task body must not appear in diagnostics';
    const a=submit(f.store,'private',{title:secret,input:{text:secret}}),c=f.store.claim({task_id:a.task_id,claim_key:'private'});
    f.store.checkpoint({task_id:a.task_id,claim_token:c.claim_token,input_revision:1,summary:secret});
    f.store.fail({task_id:a.task_id,claim_token:c.claim_token,failure_key:'failed',input_revision:1,error:{code:'execution_failed',message:secret}});
    f.store.audit('diagnostic_sample',a.task_id,{attempt:1,input_revision:1,basis:secret,summary:secret,note:secret,error:{code:'private',message:secret},text:secret,token:secret});
    assert.ok(!JSON.stringify(f.store.evidence()).includes(secret));
    assert.ok(!JSON.stringify(f.store.status()).includes(secret));
    const evidence=f.store.evidence();assert.deepEqual(JSON.parse(evidence.at(-1)!.detail),{attempt:1,input_revision:1});
    const raw=f.store.db.prepare('SELECT detail FROM task_evidence WHERE kind=?').get('failed') as {detail:string};assert.ok(raw.detail.includes(secret));
    assert.equal(f.store.get(a.task_id).error?.message,secret);assert.equal(f.store.get(a.task_id).attempts[0]?.checkpoints[0]?.summary,secret);
  }finally{f.close();}
});
