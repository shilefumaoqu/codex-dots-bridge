import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ProbeStore, ProbeError } from '../src/store.js';
import { ProbeEvents } from '../src/events.js';
import { CallbackError, type postSigned } from '../src/webhook.js';

const secret = `whsec_${Buffer.alloc(32, 53).toString('base64')}`;
const rotatedSecret = `whsec_${Buffer.alloc(32, 71).toString('base64')}`;
const url = 'https://callback.example/events';
const initialTime = Date.parse('2026-10-08T12:00:00Z');
type SendCall = { url: string; secret: string; subscriptionId: string; eventId: string; payload: unknown; previousSecret?: string };
const probeError = (code: string) => (error: unknown) => error instanceof ProbeError && error.code === code;

function fixture(t: TestContext) {
  let now = initialTime;
  const store = new ProbeStore(':memory:', () => now);
  t.after(() => store.close());
  return { store, advance: (milliseconds: number) => { now += milliseconds; }, now: () => now };
}

function sender(handler?: (call: SendCall) => Promise<{ status: number; body: string }>) {
  const calls: SendCall[] = [];
  const send: typeof postSigned = async (callbackUrl, signingSecret, subscriptionId, eventId, payload, previousSecret) => {
    const call = { url: callbackUrl, secret: signingSecret, subscriptionId, eventId, payload, previousSecret };
    calls.push(call);
    if (handler) return handler(call);
    const data = payload as { type?: string; challenge?: string };
    return { status: 200, body: data.type === 'verification' ? JSON.stringify({ challenge: data.challenge }) : 'ok' };
  };
  return {
    send, calls,
    challenges: () => calls.filter(call => (call.payload as { type?: string }).type === 'verification'),
    deliveries: () => calls.filter(call => (call.payload as { type?: string }).type !== 'verification'),
  };
}

const subscribe = (overrides: { url?: string; secret?: string; ttlMs?: number } = {}) => ({
  name: 'task.available' as const, arguments: { queue: 'p0' as const },
  delivery: { mode: 'webhook' as const, url: overrides.url ?? url, secret: overrides.secret ?? secret },
  ttlMs: overrides.ttlMs ?? 60_000,
});
const unsubscribe = () => ({
  name: 'task.available' as const, arguments: { queue: 'p0' as const },
  delivery: { mode: 'webhook' as const, url },
});
function rows(store: ProbeStore, table: 'events' | 'deliveries' | 'evidence') {
  return store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[];
}

test('releasing the slot wakes the next task after its earlier event was already received',async t=>{
  for(const action of ['complete','fail','clarify'] as const) await t.test(action,async t=>{
    const {store}=fixture(t);const fake=sender();const events=new ProbeEvents(store,fake.send);
    await events.subscribe(subscribe());
    const a=store.submit(action==='clarify'?'clarify':'echo','a');const b=store.submit('echo','b');
    const claim=store.claim(a.task_id,'claim-a');await events.pump();
    assert.equal(store.pending().length,0);
    assert.throws(()=>store.claim(b.task_id,'claim-b'),probeError('execution_slot_occupied'));
    if(action==='complete') store.complete(a.task_id,claim.claim_token!,1,'complete-a',{nonce:a.nonce});
    else if(action==='fail') store.fail(a.task_id,claim.claim_token!);
    else store.requestInput(a.task_id,claim.claim_token!);
    assert.equal(store.pending().length,1);
    assert.equal(JSON.parse(store.pending()[0]!.payload).data.task_id,b.task_id);
    await events.pump();assert.equal(store.claim(b.task_id,'claim-b').status,'running');
  });
});

test('an in-flight old 410 cannot deactivate a stopped and re-created subscription',async t=>{
  const {store}=fixture(t);
  let entered!:()=>void,finish!:(r:{status:number;body:string})=>void,first=true;
  const began=new Promise<void>(r=>entered=r);
  const deferred=new Promise<{status:number;body:string}>(r=>finish=r);
  const fake=sender(async call=>{
    const payload=call.payload as {type?:string;challenge?:string};
    if(payload.type==='verification')return {status:200,body:JSON.stringify({challenge:payload.challenge})};
    if(first){first=false;entered();return deferred;}return {status:200,body:'ok'};
  });
  const events=new ProbeEvents(store,fake.send);const original=await events.subscribe(subscribe());
  store.submit('echo','a');const pumping=events.pump();await began;
  await events.unsubscribe(unsubscribe());const replacement=await events.subscribe(subscribe());
  assert.equal(original.id,replacement.id);finish({status:410,body:''});await pumping;
  assert.equal(store.subscriptions()[0]!.active,true);assert.equal(store.pending().length,1);
  await events.pump();assert.equal(store.pending().length,0);assert.equal(store.subscriptions()[0]!.active,true);
});

test('a refresh during an old delivery retries the same event with the new generation',async t=>{
  const {store}=fixture(t);let entered!:()=>void,finish!:(r:{status:number;body:string})=>void,first=true;
  const began=new Promise<void>(r=>entered=r),deferred=new Promise<{status:number;body:string}>(r=>finish=r);
  const fake=sender(async call=>{
    const payload=call.payload as {type?:string;challenge?:string};
    if(payload.type==='verification')return {status:200,body:JSON.stringify({challenge:payload.challenge})};
    if(first){first=false;entered();return deferred;}return {status:200,body:'ok'};
  });
  const events=new ProbeEvents(store,fake.send);await events.subscribe(subscribe());store.submit('echo','a');
  const pumping=events.pump();await began;await events.subscribe(subscribe({secret:rotatedSecret}));
  finish({status:410,body:''});await pumping;
  assert.equal(store.pending().length,1);assert.equal(store.subscriptions()[0]!.active,true);
  await events.pump();assert.equal(fake.deliveries().length,2);
  assert.equal(fake.deliveries()[0]!.eventId,fake.deliveries()[1]!.eventId);
  assert.equal(fake.deliveries()[1]!.secret,rotatedSecret);assert.equal(store.pending().length,0);
});

test('stopped later deliveries in a batch snapshot are not sent after re-subscription',async t=>{
  const {store}=fixture(t);let entered!:()=>void,finish!:(r:{status:number;body:string})=>void,first=true;
  const began=new Promise<void>(r=>entered=r),deferred=new Promise<{status:number;body:string}>(r=>finish=r);
  const fake=sender(async call=>{
    const payload=call.payload as {type?:string;challenge?:string};
    if(payload.type==='verification')return {status:200,body:JSON.stringify({challenge:payload.challenge})};
    if(first){first=false;entered();return deferred;}return {status:200,body:'ok'};
  });
  const events=new ProbeEvents(store,fake.send);await events.subscribe(subscribe());
  store.submit('echo','a');store.submit('echo','b');const oldB=store.pending()[1]!.event_id;
  const pumping=events.pump();await began;await events.unsubscribe(unsubscribe());await events.subscribe(subscribe());
  finish({status:410,body:''});await pumping;
  assert.ok(!fake.deliveries().some(c=>c.eventId===oldB));assert.equal(fake.deliveries().length,1);
  await events.pump();assert.equal(fake.deliveries().length,3);assert.equal(store.pending().length,0);
  assert.ok(!fake.deliveries().some(c=>c.eventId===oldB));
});

test('evidence independently links two task events to subscription receipts without secrets',async t=>{
  const {store}=fixture(t);const fake=sender(),events=new ProbeEvents(store,fake.send);
  const sub=await events.subscribe(subscribe());const a=store.submit('echo','a'),b=store.submit('clarify','b');
  await events.pump();
  const audit=rows(store,'evidence');
  for(const task of [a,b]) {
    const receipt=audit.find(r=>r.kind==='event_receipt' && r.task_id===task.task_id);assert.ok(receipt);
    const details=JSON.parse(receipt.detail as string);assert.equal(details.subscription_id,sub.id);
    assert.ok(audit.some(r=>r.kind==='event_created' && r.task_id===task.task_id && JSON.parse(r.detail as string).event_id===details.event_id));
    assert.ok(audit.some(r=>r.kind==='event_scheduled' && r.task_id===task.task_id && JSON.parse(r.detail as string).subscription_id===sub.id));
  }
  const serialized=JSON.stringify(audit);assert.ok(!serialized.includes(secret));assert.ok(!serialized.includes(url));
});

test('submit replays the same task and nonce without creating events; changed case conflicts', t => {
  const { store } = fixture(t);
  const first = store.submit('echo', 'submit-1');
  const replay = store.submit('echo', 'submit-1');
  assert.deepEqual(replay, first);
  assert.equal(store.list().length, 1);
  assert.equal(rows(store, 'events').length, 1);
  assert.throws(() => store.submit('clarify', 'submit-1'), probeError('idempotency_conflict'));
  assert.equal(store.get(first.task_id).case, 'echo');
});

test('two tasks share one execution slot and can only be claimed FIFO', t => {
  const { store } = fixture(t);
  const first = store.submit('echo', 'submit-1');
  const second = store.submit('echo', 'submit-2');
  assert.throws(() => store.claim(second.task_id, 'claim-2'), probeError('not_queue_head'));
  const claimed = store.claim(first.task_id, 'claim-1');
  assert.throws(() => store.claim(second.task_id, 'claim-2'), probeError('execution_slot_occupied'));
  store.complete(first.task_id, claimed.claim_token!, 1, 'complete-1', { nonce: first.nonce });
  assert.equal(store.claim(second.task_id, 'claim-2').status, 'running');
});

test('lost claim response replays the same token/attempt and does not add a second claim', t => {
  const { store, advance } = fixture(t);
  const task = store.submit('echo', 'submit-1');
  const first = store.claim(task.task_id, 'claim-1');
  advance(5000);
  const replay = store.claim(task.task_id, 'claim-1');
  assert.equal(replay.claim_token, first.claim_token);
  assert.equal(replay.attempt, 1);
  assert.equal(replay.lease_until, first.lease_until);
  assert.equal(rows(store, 'evidence').filter(row => row.kind === 'claimed').length, 1);
  assert.throws(() => store.claim(task.task_id, 'claim-other'), probeError('not_queued'));
  assert.equal('claim_token' in store.get(task.task_id), false);
  assert.equal('claim_key' in store.get(task.task_id), false);
});

test('clarification releases the slot, preserves question/task IDs and resumes at a new revision', t => {
  const { store } = fixture(t);
  const task = store.submit('clarify', 'clarify-1');
  const second = store.submit('echo', 'echo-2');
  const originalClaim = store.claim(task.task_id, 'claim-clarify-1');
  const question = store.requestInput(task.task_id, originalClaim.claim_token!);
  assert.equal(question.status, 'waiting_input');
  assert.equal(question.lease_until, undefined);
  assert.equal(store.requestInput(task.task_id, originalClaim.claim_token!).question_id, question.question_id);
  const otherClaim = store.claim(second.task_id, 'claim-echo-2');
  store.complete(second.task_id, otherClaim.claim_token!, 1, 'complete-echo-2', { nonce: second.nonce });
  const eventsBeforeAnswer = rows(store, 'events').length;
  const answered = store.answer(task.task_id, question.question_id!, 'blue');
  assert.equal(answered.task_id, task.task_id);
  assert.equal(answered.nonce, task.nonce);
  assert.equal(answered.question_id, question.question_id);
  assert.equal(answered.input_revision, 2);
  assert.equal(answered.status, 'queued');
  assert.equal(rows(store, 'events').length, eventsBeforeAnswer + 1);
  assert.throws(() => store.claim(task.task_id, 'claim-clarify-1'), probeError('reuse_claim_key_after_resume'));
  const resumed = store.claim(task.task_id, 'claim-clarify-2');
  assert.equal(resumed.attempt, 2);
  assert.notEqual(resumed.claim_token, originalClaim.claim_token);
  assert.throws(() => store.complete(task.task_id, originalClaim.claim_token!, 1, 'old-complete', { nonce: task.nonce }), probeError('invalid_claim_token'));
  assert.throws(() => store.complete(task.task_id, resumed.claim_token!, 1, 'new-complete', { nonce: task.nonce, color: 'blue' }), probeError('stale_revision'));
  assert.throws(() => store.complete(task.task_id, resumed.claim_token!, 2, 'new-complete', { nonce: task.nonce, color: 'green' }), probeError('incorrect_probe_result'));
  assert.equal(store.complete(task.task_id, resumed.claim_token!, 2, 'new-complete', { nonce: task.nonce, color: 'blue' }).status, 'completed');
});

test('same clarification answer is idempotent queued/running/completed; conflicts do not change it', t => {
  const { store } = fixture(t);
  const task = store.submit('clarify', 'submit-1');
  const claimed = store.claim(task.task_id, 'claim-1');
  const question = store.requestInput(task.task_id, claimed.claim_token!);
  assert.throws(() => store.answer(task.task_id, 'wrong-question', 'blue'), probeError('question_not_found'));
  store.answer(task.task_id, question.question_id!, 'green');
  const eventCount = rows(store, 'events').length;
  assert.equal(store.answer(task.task_id, question.question_id!, 'green').input_revision, 2);
  assert.equal(rows(store, 'events').length, eventCount);
  assert.throws(() => store.answer(task.task_id, question.question_id!, 'blue'), probeError('answer_conflict'));
  const resumed = store.claim(task.task_id, 'claim-2');
  assert.equal(store.answer(task.task_id, question.question_id!, 'green').status, 'running');
  store.complete(task.task_id, resumed.claim_token!, 2, 'complete-1', { nonce: task.nonce, color: 'green' });
  assert.equal(store.answer(task.task_id, question.question_id!, 'green').status, 'completed');
  assert.equal(rows(store, 'events').length, eventCount);
});

test('answered clarification joins the queue tail behind tasks already waiting', t => {
  const { store } = fixture(t);
  const clarification = store.submit('clarify', 'clarify-1');
  const queued = store.submit('echo', 'echo-2');
  const claimed = store.claim(clarification.task_id, 'clarify-claim-1');
  const question = store.requestInput(clarification.task_id, claimed.claim_token!);
  store.answer(clarification.task_id, question.question_id!, 'blue');
  assert.throws(() => store.claim(clarification.task_id, 'clarify-claim-2'), probeError('not_queue_head'));
  const otherClaim = store.claim(queued.task_id, 'echo-claim-2');
  store.complete(queued.task_id, otherClaim.claim_token!, 1, 'echo-complete-2', { nonce: queued.nonce });
  assert.equal(store.claim(clarification.task_id, 'clarify-claim-2').status, 'running');
});

test('incorrect nonce leaves task running; lost complete response replays stable result without duplicate writes', t => {
  const { store } = fixture(t);
  const task = store.submit('echo', 'submit-1');
  const claimed = store.claim(task.task_id, 'claim-1');
  assert.throws(() => store.complete(task.task_id, claimed.claim_token!, 1, 'complete-1', { nonce: 'wrong' }), probeError('incorrect_probe_result'));
  assert.equal(store.get(task.task_id).status, 'running');
  const completed = store.complete(task.task_id, claimed.claim_token!, 1, 'complete-1', { nonce: task.nonce });
  const replay = store.complete(task.task_id, claimed.claim_token!, 1, 'complete-1', { nonce: task.nonce });
  assert.deepEqual(replay, completed);
  assert.equal(rows(store, 'evidence').filter(row => row.kind === 'result_saved').length, 1);
  assert.throws(() => store.complete(task.task_id, claimed.claim_token!, 1, 'complete-changed', { nonce: task.nonce }), probeError('not_running'));
  assert.throws(() => store.complete(task.task_id, claimed.claim_token!, 1, 'complete-1', { nonce: 'changed' }), probeError('not_running'));
  const ack = store.ack(task.task_id, completed.result_id!);
  assert.equal(store.ack(task.task_id, completed.result_id!).codex_ack_at, ack.codex_ack_at);
  assert.equal(rows(store, 'evidence').filter(row => row.kind === 'codex_result_ack').length, 1);
});

test('expired lease requires reconciliation; late result is evidence, never final, and keeps slot blocked', t => {
  const { store, advance } = fixture(t);
  const task = store.submit('echo', 'submit-1');
  const next = store.submit('echo', 'submit-2');
  const claimed = store.claim(task.task_id, 'claim-1');
  advance(30 * 60_000);
  assert.equal(store.get(task.task_id).status, 'reconciliation_required');
  const late = store.complete(task.task_id, claimed.claim_token!, 1, 'complete-late', { nonce: task.nonce });
  assert.deepEqual(late, { status: 'reconciliation_required', accepted_as_final: false });
  assert.equal(store.get(task.task_id).result, undefined);
  assert.equal(rows(store, 'evidence').filter(row => row.kind === 'late_result_evidence').length, 1);
  assert.throws(() => store.claim(next.task_id, 'claim-2'), probeError('execution_slot_occupied'));
});

test('SQLite restart retains tasks, claim replay, subscription, stable outbox payload and attempts', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-dots-store-test-'));
  const databasePath = join(directory, 'state.sqlite');
  let store = new ProbeStore(databasePath, () => initialTime);
  t.after(() => {
    if (store.db.open) store.close();
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(databasePath + suffix)) unlinkSync(databasePath + suffix);
    rmdirSync(directory);
  });
  const fake = sender();
  const subscribed = await new ProbeEvents(store, fake.send).subscribe(subscribe());
  const task = store.submit('echo', 'submit-1');
  const claimed = store.claim(task.task_id, 'claim-1');
  const delivery = store.pending()[0]!;
  store.deliveryResult(delivery, 503);
  const before = rows(store, 'deliveries');
  store.close();
  store = new ProbeStore(databasePath, () => initialTime);
  assert.equal(store.get(task.task_id).status, 'running');
  assert.equal(store.claim(task.task_id, 'claim-1').claim_token, claimed.claim_token);
  assert.equal(store.subscriptions()[0]!.id, subscribed.id);
  assert.deepEqual(rows(store, 'deliveries'), before);
  assert.equal((rows(store, 'events')[0]!.payload as string), delivery.payload);
  assert.equal(rows(store, 'deliveries')[0]!.attempts, 1);
});

test('subscription challenge persists only verified callbacks; wrong challenge and bad status reject', async t => {
  const { store } = fixture(t);
  for (const response of [
    { status: 200, body: '{}' }, { status: 200, body: 'not-json' }, { status: 500, body: '{}' },
  ]) {
    const fake = sender(async () => response);
    await assert.rejects(new ProbeEvents(store, fake.send).subscribe(subscribe()), error =>
      error instanceof CallbackError && error.reason === 'challenge_failed');
    assert.equal(store.subscriptions().length, 0);
  }
  const fake = sender();
  const result = await new ProbeEvents(store, fake.send).subscribe(subscribe());
  assert.equal(result.cursor, null);
  assert.equal(result.truncated, false);
  assert.match(fake.challenges()[0]!.eventId, /^verification_/);
  assert.equal(fake.challenges()[0]!.subscriptionId, result.id);
  assert.equal(store.subscriptions()[0]!.active, true);
});

test('subscription replay/renewal uses stable ID and TTL without another challenge inside verification window', async t => {
  const { store, advance, now } = fixture(t);
  const fake = sender();
  const events = new ProbeEvents(store, fake.send);
  const first = await events.subscribe(subscribe());
  const replay = await events.subscribe(subscribe());
  assert.deepEqual(replay, first);
  advance(10_000);
  const renewed = await events.subscribe(subscribe({ ttlMs: 120_000 }));
  assert.equal(renewed.id, first.id);
  assert.equal(Date.parse(renewed.refreshBefore), now() + 120_000);
  assert.equal(fake.challenges().length, 1);
  assert.equal(store.subscriptions().length, 1);
});

test('renewals cannot extend a cached challenge beyond five minutes without re-verification', async t => {
  const { store, advance } = fixture(t);
  const fake = sender();
  const events = new ProbeEvents(store, fake.send);
  await events.subscribe(subscribe({ ttlMs: 600_000 }));
  advance(240_000);
  await events.subscribe(subscribe({ ttlMs: 600_000 }));
  assert.equal(fake.challenges().length, 1);
  advance(61_000);
  await events.subscribe(subscribe({ ttlMs: 600_000 }));
  assert.equal(fake.challenges().length, 2, '5-minute cache is anchored to the actual challenge, not unverified renewal');
});

test('active refresh/replay creates no queue hints; new, inactive or expired subscriptions reconcile once', async t => {
  const { store, advance } = fixture(t);
  const task = store.submit('echo', 'submit-before-subscription');
  const fake = sender();
  const events = new ProbeEvents(store, fake.send);
  assert.equal(rows(store, 'events').length, 1);
  await events.subscribe(subscribe({ ttlMs: 600_000 }));
  assert.equal(rows(store, 'events').length, 2, 'first subscription gets one queued snapshot hint');
  await events.subscribe(subscribe({ ttlMs: 600_000 }));
  advance(1000);
  await events.subscribe(subscribe({ ttlMs: 600_000 }));
  assert.equal(rows(store, 'events').length, 2, 'active replay/refresh must not amplify queue events');
  assert.equal(rows(store, 'deliveries').length, 1);
  await events.unsubscribe(unsubscribe());
  await events.subscribe(subscribe({ ttlMs: 600_000 }));
  assert.equal(rows(store, 'events').length, 3, 'inactive restoration gets one fresh hint');
  assert.equal(fake.challenges().length, 2);
  advance(600_000);
  await events.subscribe(subscribe({ ttlMs: 600_000 }));
  assert.equal(rows(store, 'events').length, 4, 'expired restoration gets one fresh hint');
  assert.equal(fake.challenges().length, 3, 'expired restoration must verify callback again');
  assert.equal(store.get(task.task_id).status, 'queued');
});

test('second active subscription conflicts and original subscription remains usable', async t => {
  const { store } = fixture(t);
  const fake = sender();
  const events = new ProbeEvents(store, fake.send);
  const first = await events.subscribe(subscribe());
  await assert.rejects(events.subscribe(subscribe({ url: 'https://other.example/events' })), probeError('another_subscription_active'));
  assert.equal(store.subscriptions().length, 1);
  assert.equal(store.subscriptions()[0]!.id, first.id);
  store.submit('echo', 'submit-1');
  await events.pump();
  assert.equal(fake.deliveries().length, 1);
  assert.equal(fake.deliveries()[0]!.subscriptionId, first.id);
});

test('secret rotation verifies the new secret and uses old secret only during the short overlap', async t => {
  const { store, advance } = fixture(t);
  const fake = sender();
  const events = new ProbeEvents(store, fake.send);
  const first = await events.subscribe(subscribe({ ttlMs: 600_000 }));
  const rotated = await events.subscribe(subscribe({ secret: rotatedSecret, ttlMs: 600_000 }));
  assert.equal(rotated.id, first.id);
  assert.equal(fake.challenges().length, 2);
  assert.equal(fake.challenges()[1]!.secret, rotatedSecret);
  store.submit('echo', 'submit-1');
  await events.pump();
  assert.equal(fake.deliveries()[0]!.secret, rotatedSecret);
  assert.equal(fake.deliveries()[0]!.previousSecret, secret);
  advance(300_001);
  store.submit('echo', 'submit-2');
  await events.pump();
  assert.equal(fake.deliveries()[1]!.previousSecret, undefined);
});

test('expiry stops pending delivery and emits no further callbacks', async t => {
  const { store, advance } = fixture(t);
  const fake = sender();
  const events = new ProbeEvents(store, fake.send);
  await events.subscribe(subscribe());
  store.submit('echo', 'submit-1');
  advance(60_000);
  await events.pump();
  assert.equal(fake.deliveries().length, 0);
  assert.equal(store.pending().length, 0);
  assert.equal(rows(store, 'deliveries')[0]!.status, 'failed');
  assert.equal(store.status().subscriptions[0]!.active, false);
});

test('unsubscribe is idempotent and pending outbox work cannot send afterward', async t => {
  const { store } = fixture(t);
  const fake = sender();
  const events = new ProbeEvents(store, fake.send);
  await events.subscribe(subscribe());
  store.submit('echo', 'submit-1');
  assert.deepEqual(await events.unsubscribe(unsubscribe()), {});
  assert.deepEqual(await events.unsubscribe(unsubscribe()), {});
  await events.pump();
  assert.equal(fake.deliveries().length, 0);
  assert.equal(rows(store, 'deliveries')[0]!.status, 'stopped');
});

test('410 stops subscription and later pending events; 413 terminates only that delivery', async t => {
  for (const status of [410, 413]) {
    const store = new ProbeStore(':memory:', () => initialTime);
    try {
      const fake = sender(async call => {
        const data = call.payload as { type?: string; challenge?: string };
        return data.type === 'verification'
          ? { status: 200, body: JSON.stringify({ challenge: data.challenge }) }
          : { status, body: 'terminal' };
      });
      const events = new ProbeEvents(store, fake.send);
      await events.subscribe(subscribe());
      store.submit('echo', 'submit-1');
      store.submit('echo', 'submit-2');
      await events.pump();
      await events.pump();
      assert.equal(store.pending().length, 0);
      assert.equal(store.subscriptions()[0]!.active, status !== 410);
      assert.equal(fake.deliveries().length, status === 410 ? 1 : 2);
      assert.equal(rows(store, 'deliveries')[0]!.attempts, 1);
    } finally { store.close(); }
  }
});

test('retry preserves event ID and payload, applies backoff, and stops at six attempts', async t => {
  const { store, advance } = fixture(t);
  const fake = sender(async call => {
    const data = call.payload as { type?: string; challenge?: string };
    return data.type === 'verification'
      ? { status: 200, body: JSON.stringify({ challenge: data.challenge }) }
      : { status: 503, body: 'retry' };
  });
  const events = new ProbeEvents(store, fake.send);
  await events.subscribe(subscribe({ ttlMs: 600_000 }));
  store.submit('echo', 'submit-1');
  for (let attempt = 1; attempt <= 6; attempt++) {
    await events.pump();
    assert.equal(fake.deliveries().length, attempt);
    await events.pump();
    assert.equal(fake.deliveries().length, attempt, 'backoff prevents immediate repeat');
    advance(Math.min(60_000, 1000 * 2 ** attempt));
  }
  await events.pump();
  const delivered = fake.deliveries();
  assert.equal(delivered.length, 6);
  assert.equal(new Set(delivered.map(call => call.eventId)).size, 1);
  for (const call of delivered) assert.deepEqual(call.payload, delivered[0]!.payload);
  assert.equal((delivered[0]!.payload as { eventId: string }).eventId, delivered[0]!.eventId);
  assert.equal(rows(store, 'deliveries')[0]!.attempts, 6);
  assert.equal(rows(store, 'deliveries')[0]!.status, 'failed');
});

test('408, 429 and transport failure retry while an eventual 2xx ends delivery', async t => {
  const { store, advance } = fixture(t);
  const statuses = [408, 429, 0, 204];
  const fake = sender(async call => {
    const data = call.payload as { type?: string; challenge?: string };
    if (data.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: data.challenge }) };
    const status = statuses.shift()!;
    if (status === 0) throw new CallbackError('timeout');
    return { status, body: '' };
  });
  const events = new ProbeEvents(store, fake.send);
  await events.subscribe(subscribe({ ttlMs: 600_000 }));
  store.submit('echo', 'submit-1');
  for (let attempt = 1; attempt <= 4; attempt++) {
    await events.pump();
    advance(1000 * 2 ** attempt);
  }
  await events.pump();
  assert.equal(fake.deliveries().length, 4);
  assert.equal(rows(store, 'deliveries')[0]!.status, 'received');
  assert.equal(rows(store, 'deliveries')[0]!.last_status, 204);
});
