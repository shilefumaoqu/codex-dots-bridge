import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TaskStore,migrateTaskStorage } from '../src/task-store.js';

const submit=(store:TaskStore,key:string,response_mode?:'full'|'compact')=>store.submit({idempotency_key:key,title:key,input:{text:'original input 中文'},response_mode});
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'dots-storage-v2-')),path=join(dir,'db.sqlite');let now=Date.now(),store=new TaskStore(path,()=>now);
  return {get store(){return store;},advance:(ms:number)=>{now+=ms;},restart:()=>{store.close();store=new TaskStore(path,()=>now);},migrate:()=>{migrateTaskStorage(store.db);store.close();store=new TaskStore(path,()=>now);},close:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}
function complete(store:TaskStore,id:string) {const owned={task_id:id,claim_token:store.claim({task_id:id,claim_key:'claim-'+id}).claim_token};store.checkpoint({...owned,input_revision:1});return store.complete({...owned,input_revision:1,completion_key:'done-'+id,result:{text:'saved result'}});}

test('normalized migration preserves old receipts, frozen parent references and live lease expiry',()=>{
  const f=fixture();try {
    const parent=submit(f.store,'parent'),done=complete(f.store,parent.task_id);
    const child=f.store.followup({idempotency_key:'child',parent_task_id:parent.task_id,title:'child',input:{text:'next'}});
    const claimed=f.store.claim({task_id:child.task_id,claim_key:'child-claim'}),before=f.store.get(child.task_id);
    const operations=f.store.db.prepare('SELECT * FROM task_operations ORDER BY scope,key').all();
    f.migrate();
    assert.deepEqual(f.store.get(child.task_id),before);
    assert.deepEqual(f.store.db.prepare('SELECT * FROM task_operations ORDER BY scope,key').all(),operations);
    assert.deepEqual(submit(f.store,'parent'),JSON.parse(JSON.stringify(parent)));
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM task_components WHERE kind='parent_context_ref'").get()?.n,1);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM task_components WHERE kind='parent_context'").get()?.n,0);
    assert.ok(!JSON.stringify(f.store.db.prepare('SELECT data FROM tasks WHERE id=?').get(child.task_id)).includes('original input'));
    assert.equal(f.store.get(parent.task_id).result_id,done.result_id);
    assert.equal((f.store.db.prepare('SELECT lease_until FROM tasks WHERE id=?').get(child.task_id) as {lease_until:string}).lease_until,claimed.lease_until);
    f.advance(1_800_001);assert.equal(f.store.get(child.task_id).status,'reconciliation_required');
  }finally{f.close();}
});

test('compact receipts bind response mode, preserve replay revision and append one normalized body',()=>{
  const f=fixture();try {
    f.migrate();const initial=submit(f.store,'compact','compact');
    assert.equal(initial.input,undefined);assert.equal(initial.messages,undefined);
    assert.match((initial as any).operation_id,/^[a-f0-9]{64}$/);
    assert.deepEqual(submit(f.store,'compact','compact'),initial);
    assert.throws(()=>submit(f.store,'compact','full'),/idempotency_conflict/);
    const claim=f.store.claim({task_id:initial.task_id,claim_key:'claim',response_mode:'compact'});
    assert.equal(claim.input.text,'original input 中文');assert.ok(claim.deadline);assert.deepEqual(claim.messages,[]);
    for(let i=0;i<100;i++)f.store.message({task_id:initial.task_id,message_key:`m${i}`,text:`正文-${i}`,response_mode:'compact'});
    const replay=f.store.claim({task_id:initial.task_id,claim_key:'claim',response_mode:'compact'});assert.deepEqual(replay,claim);
    const current=f.store.get(initial.task_id);assert.equal(current.messages.length,100);assert.equal(current.input_revision,101);
    const receipt=f.store.db.prepare("SELECT response FROM task_operations WHERE scope=? AND key='m99'").get('message:'+initial.task_id) as {response:string};
    assert.ok(receipt.response.length<500);assert.ok(!receipt.response.includes('正文'));
    assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM task_components WHERE task_id=? AND kind='messages'").get(initial.task_id) as {n:number}).n,100);
    f.store.checkpoint({task_id:initial.task_id,claim_token:claim.claim_token,input_revision:101,response_mode:'compact'});
    assert.equal(f.store.complete({task_id:initial.task_id,claim_token:claim.claim_token,input_revision:101,completion_key:'final',result:{text:'complete'},response_mode:'compact'}).status,'completed');
  }finally{f.close();}
});

test('compact checkpoints append without reading message or checkpoint history and preserve ownership/revision/rollback',()=>{
  const f=fixture();try {
    f.migrate();
    let componentScans=0;
    const prepare=f.store.db.prepare.bind(f.store.db);
    (f.store.db as any).prepare=(sql:string)=>{
      const statement=prepare(sql);
      if(sql.startsWith('SELECT kind,parent,position,data FROM task_components')) {
        const all=statement.all.bind(statement);
        (statement as any).all=(...args:unknown[])=>{componentScans++;return all(...args);};
      }
      return statement;
    };
    const task=submit(f.store,'checkpoint-growth','compact');
    const owned={task_id:task.task_id,claim_token:f.store.claim({task_id:task.task_id,claim_key:'claim',response_mode:'compact'}).claim_token};
    for(let i=0;i<1000;i++) f.store.message({task_id:task.task_id,message_key:'m'+i,text:'x'.repeat(1024),response_mode:'compact'});
    componentScans=0;
    const stale=f.store.checkpoint({...owned,input_revision:1000,response_mode:'compact',summary:'not yet adopted'});
    assert.equal(stale.acknowledged,false);
    const current=f.store.checkpoint({...owned,input_revision:1001,response_mode:'compact',summary:'adopted'});
    assert.equal(current.acknowledged,true);assert.equal(componentScans,0);
    assert.ok(JSON.stringify(current).length<500);assert.equal(current.messages,undefined);
    const components=()=>f.store.db.prepare('SELECT kind,parent,position,data FROM task_components WHERE task_id=? ORDER BY kind,parent,position').all(task.task_id);
    const before=components(),header=f.store.db.prepare('SELECT data,lease_until FROM tasks WHERE id=?').get(task.task_id);
    assert.throws(()=>f.store.checkpoint({...owned,claim_token:'wrong',input_revision:1001,response_mode:'compact'}),/invalid_claim_token/);
    assert.throws(()=>f.store.checkpoint({...owned,input_revision:1002,response_mode:'compact'}),/invalid_revision/);
    assert.throws(()=>f.store.transaction(()=>{f.store.checkpoint({...owned,input_revision:1001,response_mode:'compact'});throw Error('rollback');})(),/rollback/);
    assert.deepEqual(components(),before);assert.deepEqual(f.store.db.prepare('SELECT data,lease_until FROM tasks WHERE id=?').get(task.task_id),header);
    f.restart();
    const restored=f.store.get(task.task_id);
    assert.equal(restored.messages.length,1000);assert.equal(restored.attempts[0]!.acknowledged_revision,1001);
    assert.deepEqual(restored.attempts[0]!.checkpoints.map(c=>[c.input_revision,c.acknowledged,c.summary]),[[1000,false,'not yet adopted'],[1001,true,'adopted']]);
    f.store.cancel({task_id:task.task_id,request_key:'cancel'});
    assert.equal(f.store.checkpoint({...owned,input_revision:1001,response_mode:'compact'}).status,'cancel_requested');
    f.advance(1_800_001);
    assert.throws(()=>f.store.checkpoint({...owned,input_revision:1001,response_mode:'compact'}),/attempt_not_current/);
  }finally{f.close();}
});

test('waiters wake after commit, ignore rollback, and release on abort/close',async()=>{
  const f=fixture();try {
    const task=submit(f.store,'wait');let wakes=0,work=0;const dispose=f.store.onWorkAvailable(()=>work++);
    const abort=new AbortController();const waiter=f.store.waitForChange(task.task_id,task.change_sequence,1000,abort.signal).then(()=>wakes++);
    assert.throws(()=>f.store.transaction(()=>{f.store.message({task_id:task.task_id,message_key:'rollback',text:'uncommitted'});throw new Error('rollback');})(),/rollback/);
    await Promise.resolve();assert.equal(wakes,0);assert.equal(work,0);assert.equal(f.store.get(task.task_id).input_revision,1);
    f.store.message({task_id:task.task_id,message_key:'committed',text:'committed'});await waiter;assert.equal(wakes,1);
    const next=f.store.waitForChange(task.task_id,f.store.get(task.task_id).change_sequence,1000,abort.signal);abort.abort();await next;
    assert.equal((f.store as any).waiters.size,0);dispose();
  }finally{f.close();}
});

test('diagnostic rotation never removes business evidence or rewinds observation cursor',()=>{
  const f=fixture();try {
    const task=submit(f.store,'history');f.store.audit('worker_ingress',task.task_id,{stage:'accepted'});
    const instance=randomUUID(),before=f.store.observe({mode:'snapshot'},instance);
    assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM task_diagnostics').get() as {n:number}).n,1);
    f.advance(31*86400000);f.store.rotateDiagnostics();
    assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM task_diagnostics').get() as {n:number}).n,0);
    const after=f.store.observe({mode:'changes',cursor:before.cursor},instance);assert.equal(after.cursor,before.cursor);assert.deepEqual(after.events,[]);
    assert.ok(f.store.evidence().some(event=>event.kind==='enqueued'));
    f.store.audit('worker_ingress',null,{});
    assert.equal(f.store.observe({mode:'changes',cursor:before.cursor},instance).cursor,before.cursor);
    f.store.db.prepare("INSERT INTO task_evidence(at,kind,task_id,detail) VALUES(?,'legacy_business',NULL,'{}')").run(new Date().toISOString());
    const legacy=f.store.observe({mode:'changes',cursor:before.cursor},instance);assert.ok(legacy.cursor>before.cursor);assert.equal(legacy.events.at(-1)?.kind,'legacy_business');
    // Exercise byte-budget enforcement without allocating hundreds of MiB in a unit test.
    f.store.db.prepare('UPDATE task_diagnostic_budget SET bytes=bytes+?').run(256*1024*1024);
    f.store.db.prepare('UPDATE task_diagnostics SET bytes=bytes+?').run(256*1024*1024);
    f.store.rotateDiagnostics();assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM task_diagnostics').get() as {n:number}).n,0);
    assert.ok(f.store.evidence().some(event=>event.kind==='enqueued'));
  }finally{f.close();}
});

test('pickup observations are queue-specific, terminal hints stop, explicit retries get a fresh event',()=>{
  const f=fixture();try {
    f.store.saveSubscription({id:'sub_test',url:'https://example.com/events',secret:'secret',expires_at:Date.now()+86400000,active:true,generation:1});
    const first=f.store.submit({idempotency_key:'first',title:'first',input:{text:'x'},safe_to_retry:true}),second=submit(f.store,'second');
    assert.equal(f.store.pending().length,1);const delivery=f.store.pending()[0]!;f.store.deliveryResult(delivery,200);
    f.advance(60_000);assert.equal(f.store.pickupDiagnostic().phase,'pickup_delayed');
    f.advance(240_000);assert.equal(f.store.pickupDiagnostic().phase,'pickup_stalled');
    f.store.claim({task_id:first.task_id,claim_key:'first'});f.advance(1_800_001);f.store.sweep();
    assert.equal(f.store.pending().length,1);assert.equal(f.store.pickupDiagnostic().task_id,second.task_id);assert.equal(f.store.pickupDiagnostic().phase,'awaiting_delivery');
    f.store.cancel({task_id:second.task_id,request_key:'cancel'});
    const retry=f.store.pending();assert.equal(retry.length,1);assert.notEqual(retry[0]!.event_id,delivery.event_id);assert.equal(f.store.pickupDiagnostic().task_id,first.task_id);
    f.store.cancel({task_id:first.task_id,request_key:'cancel-first'});assert.equal(f.store.pending().length,0);assert.equal(f.store.nextDeliveryAt(),undefined);
  }finally{f.close();}
});

test('summary list reads covering metadata without decoding old task bodies',()=>{
  const f=fixture();try {
    const task=submit(f.store,'summary');const summary=f.store.listSummaries({limit:1})[0]!;
    assert.equal(summary.task_id,task.task_id);assert.equal((summary as any).input,undefined);assert.equal((summary as any).messages,undefined);
    const plan=f.store.db.prepare('EXPLAIN QUERY PLAN SELECT id,title,status FROM tasks INDEXED BY tasks_list_recent ORDER BY updated_at DESC,queued_order DESC LIMIT 50').all();
    assert.match(JSON.stringify(plan),/tasks_list_recent/);
    assert.equal(f.store.status({summary:true}).tasks.length,0);
  }finally{f.close();}
});


test('stale event ACK cannot start the revised input pickup clock',()=>{
  const f=fixture();try {
    f.store.saveSubscription({id:'sub_test',url:'https://example.com/events',secret:'secret',expires_at:Date.now()+86400000,active:true,generation:1});
    const task=submit(f.store,'revision'),old=f.store.pending()[0]!;
    f.store.message({task_id:task.task_id,message_key:'revision2',text:'corrected'});
    f.store.deliveryResult(old,200);f.advance(300001);
    assert.equal(f.store.pickupDiagnostic().phase,'awaiting_delivery');
    const current=f.store.pending()[0]!;assert.notEqual(current.event_id,old.event_id);
    f.store.deliveryResult(current,200);assert.equal(f.store.pickupDiagnostic().phase,'awaiting_pickup');
  }finally{f.close();}
});

test('startup and guard changes wake eligible successor without replaying accepted work',()=>{
  const f=fixture();try {
    const id='sub_'+'a'.repeat(40),binding='b'.repeat(64);
    f.store.saveSubscription({id,url:'https://example.com/events',secret:'secret',expires_at:Date.now()+86400000,active:true,generation:1});
    f.store.setReplySubscriptionGuard(()=>true);
    f.store.submitNotificationReply({idempotency_key:'bound',title:'bound',input:{text:'x'}},id,binding);
    const next=submit(f.store,'ordinary');assert.equal(f.store.pending().length,1);
    f.restart();f.store.startMaintenance();
    const available=f.store.pending();assert.equal(available.length,1);assert.equal(JSON.parse(available[0]!.payload).data.task_id,next.task_id);
    f.store.deliveryResult(available[0]!,200);f.store.stopMaintenance();f.store.startMaintenance();assert.equal(f.store.pending().length,0);
    f.store.setReplySubscriptionGuard(()=>true);
    const restored=f.store.pending();assert.equal(restored.length,1);
    f.store.setReplySubscriptionGuard(()=>false);assert.equal(f.store.pending().length,0);
  }finally{f.close();}
});


test('legacy received notification remains received on upgrade and explicit retry gets fresh queue generation',()=>{
  const f=fixture();try {
    f.store.saveSubscription({id:'sub_test',url:'https://example.com/events',secret:'secret',expires_at:Date.now()+86400000,active:true,generation:1});
    const task=f.store.submit({idempotency_key:'legacy',title:'legacy',input:{text:'legacy'},safe_to_retry:true});
    const event=f.store.pending()[0]!;f.store.deliveryResult(event,200);
    f.store.db.exec('ALTER TABLE task_events DROP COLUMN input_revision; ALTER TABLE task_events DROP COLUMN queue_order;');
    f.restart();f.store.startMaintenance();assert.equal(f.store.pending().length,0);
    f.store.claim({task_id:task.task_id,claim_key:'claim'});f.advance(1_800_001);f.store.sweep();
    const retry=f.store.pending();assert.equal(retry.length,1);assert.notEqual(retry[0]!.event_id,event.event_id);
  }finally{f.close();}
});
