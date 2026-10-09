import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export class ProbeError extends Error {
  constructor(public code: string) { super(code); }
}
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export type ProbeCase = 'echo' | 'clarify';
export type ProbeStatus = 'queued' | 'running' | 'waiting_input' | 'completed' | 'failed' | 'reconciliation_required' | 'expired';
export interface ProbeTask {
  task_id: string; idempotency_key: string; case: ProbeCase; nonce: string;
  status: ProbeStatus; input_revision: number; created_at: string; deadline: string; queued_order: number;
  attempt: number; claim_key?: string; claim_token?: string; lease_until?: string;
  question_id?: string; answer?: 'blue' | 'green'; result?: Record<string, unknown>;
  completion_key?: string; result_id?: string; codex_ack_at?: string;
}
export interface Subscription {
  id: string; url: string; secret: string; previous_secret?: string; rotation_until?: number;
  expires_at: number; verified_until: number; active: boolean; generation: number;
}
export interface Delivery {
  id: number; event_id: string; subscription_id: string; payload: string; attempts: number;
}
const iso = (time: number) => new Date(time).toISOString();
const LEASE_MS = 30 * 60 * 1000;

/** P0 only: fixed, harmless test tasks. Not the general-purpose P1 task engine. */
export class ProbeStore {
  readonly db: Database.Database;
  constructor(path: string, readonly now: () => number = Date.now) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS probe_tasks (id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (
        id INTEGER PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id),
        subscription_id TEXT NOT NULL REFERENCES subscriptions(id), attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', last_status INTEGER,
        UNIQUE(event_id,subscription_id));
      CREATE TABLE IF NOT EXISTS evidence (
        id INTEGER PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, task_id TEXT, detail TEXT NOT NULL);
    `);
  }
  close() { this.db.close(); }
  audit(kind: string, taskId: string | null = null, detail: Record<string, unknown> = {}) {
    this.db.prepare('INSERT INTO evidence(at,kind,task_id,detail) VALUES(?,?,?,?)')
      .run(iso(this.now()), kind, taskId, JSON.stringify(detail));
  }
  evidence() { return this.db.prepare('SELECT * FROM evidence ORDER BY id').all(); }
  private save(task: ProbeTask) {
    this.db.prepare('INSERT INTO probe_tasks(id,request_key,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(task.task_id, task.idempotency_key, JSON.stringify(task));
  }
  private raw(id: string): ProbeTask {
    const row = this.db.prepare('SELECT data FROM probe_tasks WHERE id=?').get(id) as {data: string} | undefined;
    if (!row) throw new ProbeError('task_not_found');
    return JSON.parse(row.data) as ProbeTask;
  }
  private all(): ProbeTask[] {
    return (this.db.prepare('SELECT data FROM probe_tasks ORDER BY rowid').all() as {data:string}[]).map(r => JSON.parse(r.data));
  }
  private publicTask(task: ProbeTask) {
    const { claim_token: _secret, claim_key: _claimKey, completion_key: _completeKey, ...safe } = task;
    return { ...safe, instruction: task.case === 'echo'
      ? 'Return structured result {nonce: <this task nonce>}. Do not use external tools, links, files, or send messages.'
      : 'Before completing, call request_input to ask the user to choose blue or green. After the answer, reclaim this SAME task and return {nonce: <this task nonce>, color: <answer>}. Do not use external tools.' };
  }
  get(id: string) { this.sweep(); return this.publicTask(this.raw(id)); }
  list() { this.sweep(); return this.all().map(t => this.publicTask(t)); }
  submit(kind: ProbeCase, key: string) {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT data FROM probe_tasks WHERE request_key=?').get(key) as {data:string} | undefined;
      if (row) {
        const previous = JSON.parse(row.data) as ProbeTask;
        if (previous.case !== kind) throw new ProbeError('idempotency_conflict');
        return this.publicTask(previous);
      }
      const task: ProbeTask = {task_id: randomUUID(), idempotency_key:key, case:kind,
        nonce:randomBytes(16).toString('hex'), status:'queued', input_revision:1,
        created_at:iso(this.now()), deadline:iso(this.now()+86_400_000), attempt:0,
        queued_order:Math.max(0,...this.all().map(t=>t.queued_order))+1};
      this.save(task); this.audit('enqueued',task.task_id); this.enqueue(task.task_id);
      return this.publicTask(task);
    })();
  }
  private enqueue(taskId: string) {
    const eventId = `evt_${randomUUID()}`;
    const payload = JSON.stringify({eventId, name:'task.available', timestamp:iso(this.now()),
      data:{task_id:taskId, queue:'p0'}, cursor:null});
    this.db.prepare('INSERT INTO events(id,payload) VALUES(?,?)').run(eventId,payload);
    this.audit('event_created',taskId,{event_id:eventId,revision:this.raw(taskId).input_revision});
    for (const sub of this.subscriptions().filter(s => s.active && s.expires_at > this.now())) {
      this.db.prepare('INSERT INTO deliveries(event_id,subscription_id,next_at) VALUES(?,?,?)').run(eventId,sub.id,this.now());
      this.audit('event_scheduled',taskId,{event_id:eventId,subscription_id:sub.id,generation:sub.generation});
    }
  }
  private wakeQueueHead() {
    const next=this.all().filter(t=>t.status==='queued').sort((a,b)=>a.queued_order-b.queued_order)[0];
    if(next) this.enqueue(next.task_id);
  }
  sweep() {
    this.db.transaction(() => {
      for (const task of this.all()) {
        const timeout = Date.parse(task.deadline) <= this.now();
        if (task.status === 'running' && (timeout || Date.parse(task.lease_until!) <= this.now())) {
          task.status='reconciliation_required'; this.save(task); this.audit('reconciliation_required',task.task_id);
        } else if (timeout && ['queued','waiting_input'].includes(task.status)) {
          task.status='expired'; this.save(task); this.audit('expired',task.task_id);
        }
      }
    })();
  }
  claim(id: string, claimKey: string) {
    this.sweep();
    return this.db.transaction(() => {
      const task=this.raw(id);
      if (task.claim_key===claimKey && task.status==='running') return {...this.publicTask(task),claim_token:task.claim_token};
      if (task.status!=='queued') throw new ProbeError('not_queued');
      if (task.claim_key===claimKey) throw new ProbeError('reuse_claim_key_after_resume');
      if (this.all().some(t => ['running','reconciliation_required'].includes(t.status))) throw new ProbeError('execution_slot_occupied');
      const first=this.all().filter(t=>t.status==='queued').sort((a,b)=>a.queued_order-b.queued_order)[0];
      if (first?.task_id!==id) throw new ProbeError('not_queue_head');
      task.status='running'; task.claim_key=claimKey; task.claim_token=randomBytes(32).toString('base64url');
      task.lease_until=iso(this.now()+LEASE_MS); task.attempt++;
      this.save(task); this.audit('claimed',id,{attempt:task.attempt,revision:task.input_revision});
      return {...this.publicTask(task),claim_token:task.claim_token};
    })();
  }
  private owned(id: string, token: string) {
    const task=this.raw(id);
    if (!task.claim_token || hash(task.claim_token)!==hash(token)) throw new ProbeError('invalid_claim_token');
    return task;
  }
  checkpoint(id: string, token: string, revision: number) {
    this.sweep();
    return this.db.transaction(()=>{
      const task=this.owned(id,token);
      if (task.status!=='running') throw new ProbeError('not_running');
      if (task.input_revision!==revision) throw new ProbeError('stale_revision');
      task.lease_until=iso(this.now()+LEASE_MS); this.save(task); this.audit('checkpoint',id,{revision});
      return this.publicTask(task);
    })();
  }
  requestInput(id: string, token: string) {
    this.sweep();
    return this.db.transaction(()=>{
      const task=this.owned(id,token);
      if (task.status==='waiting_input') return this.publicTask(task);
      if (task.status!=='running' || task.case!=='clarify' || task.answer) throw new ProbeError('question_not_allowed');
      task.status='waiting_input'; task.question_id=randomUUID(); delete task.lease_until;
      this.save(task); this.audit('question_saved',id,{question_id:task.question_id});
      this.wakeQueueHead();
      return {...this.publicTask(task),question:'Choose blue or green.'};
    })();
  }
  answer(id: string, questionId: string, answer: 'blue' | 'green') {
    this.sweep();
    return this.db.transaction(()=>{
      const task=this.raw(id);
      if (task.question_id!==questionId) throw new ProbeError('question_not_found');
      if (task.answer===answer && ['queued','running','completed'].includes(task.status)) return this.publicTask(task);
      if (task.answer) throw new ProbeError('answer_conflict');
      if (task.status!=='waiting_input') throw new ProbeError('not_waiting_input');
      task.answer=answer; task.input_revision++; task.status='queued';
      task.queued_order=Math.max(0,...this.all().map(t=>t.queued_order))+1;
      this.save(task); this.audit('answer_saved',id,{revision:task.input_revision}); this.enqueue(id);
      return this.publicTask(task);
    })();
  }
  complete(id: string, token: string, revision: number, key: string, result: {nonce:string;color?:'blue'|'green'}) {
    this.sweep();
    return this.db.transaction(()=>{
      const task=this.owned(id,token);
      if (task.status==='completed' && task.completion_key===key && task.input_revision===revision &&
        task.result?.nonce===result.nonce && task.result?.color===result.color) return this.publicTask(task);
      if (task.status==='reconciliation_required') {
        this.audit('late_result_evidence',id,{revision,result}); return {status:'reconciliation_required',accepted_as_final:false};
      }
      if (task.status!=='running') throw new ProbeError('not_running');
      if (task.input_revision!==revision) throw new ProbeError('stale_revision');
      if (result.nonce!==task.nonce || (task.case==='clarify' && (!task.answer || result.color!==task.answer)) ||
        (task.case==='echo' && result.color!==undefined)) throw new ProbeError('incorrect_probe_result');
      task.status='completed'; task.result=result; task.completion_key=key; task.result_id=randomUUID();
      delete task.lease_until; this.save(task); this.audit('result_saved',id,{result_id:task.result_id,revision});
      this.wakeQueueHead();
      return this.publicTask(task);
    })();
  }
  fail(id: string, token: string) {
    this.sweep();
    return this.db.transaction(()=>{
      const task=this.owned(id,token);
      if (task.status==='failed') return this.publicTask(task);
      if (task.status!=='running') throw new ProbeError('not_running');
      task.status='failed'; delete task.lease_until; this.save(task); this.audit('failed',id);
      this.wakeQueueHead();
      return this.publicTask(task);
    })();
  }
  ack(id: string, resultId: string) {
    return this.db.transaction(()=>{
      const task=this.raw(id);
      if (task.status!=='completed' || task.result_id!==resultId) throw new ProbeError('result_not_found');
      if (!task.codex_ack_at) { task.codex_ack_at=iso(this.now()); this.save(task); this.audit('codex_result_ack',id,{result_id:resultId}); }
      return this.publicTask(task);
    })();
  }
  subscriptions(): Subscription[] {
    return (this.db.prepare('SELECT data FROM subscriptions').all() as {data:string}[]).map(r=>{
      const sub=JSON.parse(r.data) as Subscription; return {...sub,generation:sub.generation??0};
    });
  }
  saveSubscription(sub: Subscription) {
    this.db.transaction(()=>{
      const previous=this.subscriptions().find(s=>s.id===sub.id);
      if (this.subscriptions().some(s=>s.active && s.expires_at>this.now() && s.id!==sub.id)) throw new ProbeError('another_subscription_active');
      this.db.prepare('INSERT INTO subscriptions(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(sub.id,JSON.stringify(sub));
      this.audit('subscription_active',null,{id:sub.id,generation:sub.generation,expires_at:iso(sub.expires_at)});
      // Events has no replay. A fresh queue hint explicitly reconciles pending tasks.
      if (!previous?.active || previous.expires_at<=this.now()) {
        for (const task of this.all().filter(t=>t.status==='queued')) this.enqueue(task.task_id);
      }
    })();
  }
  unsubscribe(id: string, expectedGeneration?:number) {
    this.db.transaction(()=>{
      const sub=this.subscriptions().find(s=>s.id===id);
      if(expectedGeneration!==undefined && sub?.generation!==expectedGeneration) return;
      if (sub) {
        sub.active=false; sub.generation++; this.db.prepare('UPDATE subscriptions SET data=? WHERE id=?').run(JSON.stringify(sub),id);
        this.db.prepare("UPDATE deliveries SET status='stopped' WHERE subscription_id=? AND status='pending'").run(id);
      }
      this.audit('subscription_stopped',null,{id});
    })();
  }
  pending(): Delivery[] {
    return this.db.prepare("SELECT d.id,d.event_id,d.subscription_id,d.attempts,e.payload FROM deliveries d JOIN events e ON e.id=d.event_id WHERE d.status='pending' AND d.next_at<=? ORDER BY d.id LIMIT 10").all(this.now()) as Delivery[];
  }
  isDeliveryPending(id:number) {
    return this.db.prepare("SELECT 1 FROM deliveries WHERE id=? AND status='pending' AND next_at<=?").get(id,this.now())!==undefined;
  }
  deliveryResult(item: Delivery, status: number) {
    this.db.transaction(()=>{
      const attempts=item.attempts+1;
      const accepted=status>=200 && status<300;
      const terminal=[410,413].includes(status) || (status>=400 && status<500 && status!==408 && status!==429);
      const state=accepted?'received':terminal || attempts>=6?'failed':'pending';
      const updated=this.db.prepare('UPDATE deliveries SET attempts=?,status=?,last_status=?,next_at=? WHERE id=? AND status=\'pending\'')
        .run(attempts,state,status,this.now()+Math.min(60_000,1000*2**attempts),item.id);
      if(updated.changes) {
        const taskId=(JSON.parse(item.payload) as {data:{task_id:string}}).data.task_id;
        this.audit(accepted?'event_receipt':state==='failed'?'event_delivery_failed':'event_retry',taskId,
          {event_id:item.event_id,subscription_id:item.subscription_id,status,attempts});
      }
    })();
  }
  status() {
    this.sweep();
    return {phase:'P0', production_ready:false, tasks:this.list().map(t=>({task_id:t.task_id,case:t.case,status:t.status})),
      subscriptions:this.subscriptions().map(s=>({id:s.id,active:s.active && s.expires_at>this.now(),expires_at:iso(s.expires_at)})),
      deliveries:this.db.prepare('SELECT status,COUNT(*) AS count FROM deliveries GROUP BY status').all()};
  }
}
