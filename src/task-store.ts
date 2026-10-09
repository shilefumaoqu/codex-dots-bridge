import Database from 'better-sqlite3';
import { randomBytes, randomUUID } from 'node:crypto';
import { ProbeError, type Delivery, type Subscription } from './store.js';

export type TaskStatus = 'queued'|'running'|'waiting_input'|'cancel_requested'|'reconciliation_required'|'completed'|'failed'|'cancelled'|'expired';
export interface Link { url: string; label?: string }
export interface TaskInput { text: string; links?: Link[] }
export interface TaskResult { text?: string; data?: unknown; links?: Link[] }
export interface SubmitInput { idempotency_key: string; title: string; input: TaskInput; safe_to_retry?: boolean; deadline_hours?: number; logical_session_id?: string }
export interface MessageInput { task_id: string; message_key: string; text: string; question_id?: string; deadline_hours?: number }
export interface ClaimInput { task_id: string; claim_key: string }
export interface OwnedInput { task_id: string; claim_token: string }
export interface CheckpointInput extends OwnedInput { input_revision: number; summary?: string }
export interface QuestionInput extends OwnedInput { question_key: string; question: string; options?: string[]; checkpoint?: string; requires_platform_action?: boolean; action_url?: string }
export interface CompleteInput extends OwnedInput { completion_key: string; input_revision: number; result: TaskResult }
export interface FailInput extends OwnedInput { failure_key: string; input_revision: number; error: { code: string; message: string } }
export interface CancelInput { task_id: string; request_key: string; reason?: string }
export interface AckCancelInput extends OwnedInput { ack_key: string; note?: string }
export interface AckInput { task_id: string; result_id: string; user_accepted?: boolean }
export interface ResolveInput { task_id: string; resolution_key: string; decision: 'complete'|'fail'|'retry'; basis: string; result?: TaskResult }
interface Attempt { number: number; claim_key: string; claim_token: string; started_at: string; lease_until: string; status: string; acknowledged_revision: number; checkpoints: { at: string; input_revision: number; acknowledged: boolean; summary?: string }[] }
interface Question { question_id: string; question_key: string; question: string; options?: string[]; checkpoint?: string; requires_platform_action: boolean; action_url?: string; input_revision: number; created_at: string; answer?: { text: string; at: string; message_key: string } }
interface ResultRecord { result_id: string; attempt?: number; input_revision: number; result: TaskResult; at: string; accepted_as_final: boolean; disposition: string; result_read_at?: string; codex_ack_at?: string; user_accepted?: boolean; user_accepted_at?: string }
interface StoredTask { task_id: string; idempotency_key: string; title: string; input: TaskInput; logical_session_id?: string; parent_task_id?: string; parent_context?: unknown; status: TaskStatus; safe_to_retry: boolean; input_revision: number; change_sequence: number; created_at: string; updated_at: string; deadline: string; queued_order: number; attempt: number; retry_count: number; attempts: Attempt[]; messages: { message_key: string; text: string; question_id?: string; input_revision: number; at: string }[]; questions: Question[]; results: ResultRecord[]; active_question_id?: string; result_id?: string; cancel_request?: { request_key: string; reason?: string; at: string }; cancellation_ack?: { at: string; note?: string }; error?: { code: string; message: string }; reconciliation_reason?: string }
const LEASE_MS = 1_800_000;
const iso = (n: number) => new Date(n).toISOString();
const terminal = (s: TaskStatus) => ['completed','failed','cancelled','expired'].includes(s);
const occupies = (s: TaskStatus) => ['running','cancel_requested','reconciliation_required'].includes(s);
// Sorted JSON gives object arguments stable idempotency without treating property order as a changed request.
function canonical(value: unknown): string {
  const normal = (v: unknown): unknown => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') { if (!Number.isFinite(v)) throw new ProbeError('invalid_json'); return v; }
    if (Array.isArray(v)) return v.map(normal);
    if (typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string,unknown>).filter(([,x])=>x!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,normal(x)]));
    throw new ProbeError('invalid_json');
  };
  try { return JSON.stringify(normal(value)); } catch (error) { if (error instanceof ProbeError) throw error; throw new ProbeError('invalid_json'); }
}
function required(v: unknown) { if (typeof v !== 'string' || !v.trim()) throw new ProbeError('invalid_argument'); }
function deadlineHours(n: number | undefined) { if (n !== undefined && (!Number.isFinite(n) || n <= 0 || n > 720)) throw new ProbeError('invalid_deadline'); return n ?? 24; }
function links(value: Link[] | undefined) { if (value === undefined) return; if (!Array.isArray(value)) throw new ProbeError('invalid_links'); for (const link of value) { required(link.url); let url: URL; try { url=new URL(link.url); } catch { throw new ProbeError('invalid_link'); } if (!['http:','https:'].includes(url.protocol)) throw new ProbeError('invalid_link'); if (link.label!==undefined && typeof link.label!=='string') throw new ProbeError('invalid_link'); } }
function resultValid(result: TaskResult) { if (!result || typeof result!=='object' || Array.isArray(result) || (result.text===undefined && result.data===undefined && !result.links?.length)) throw new ProbeError('invalid_result'); if (result.text!==undefined && (typeof result.text!=='string'||!result.text.trim())) throw new ProbeError('invalid_result'); links(result.links); canonical(result); }

/** Persistent P1 queue. All business changes and their Events hints commit in the same transaction. */
export class TaskStore {
  readonly db: Database.Database;
  constructor(path: string, readonly now: () => number = Date.now) {
    this.db=new Database(path); this.db.pragma('journal_mode = WAL'); this.db.pragma('foreign_keys = ON'); this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,request_key TEXT UNIQUE NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_operations(scope TEXT NOT NULL,key TEXT NOT NULL,body TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(scope,key));
      CREATE TABLE IF NOT EXISTS task_subscriptions(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_events(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_deliveries(id INTEGER PRIMARY KEY,event_id TEXT NOT NULL REFERENCES task_events(id),subscription_id TEXT NOT NULL REFERENCES task_subscriptions(id),attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',last_status INTEGER,UNIQUE(event_id,subscription_id));
      CREATE TABLE IF NOT EXISTS task_evidence(id INTEGER PRIMARY KEY,at TEXT NOT NULL,kind TEXT NOT NULL,task_id TEXT,detail TEXT NOT NULL);`);
  }
  close() { this.db.close(); }
  audit(kind: string, taskId: string|null=null, detail: Record<string,unknown>={}) { this.db.prepare('INSERT INTO task_evidence(at,kind,task_id,detail) VALUES(?,?,?,?)').run(iso(this.now()),kind,taskId,canonical(detail)); }
  evidence() {
    // Full evidence remains in the private database; diagnostics expose only approved metadata.
    const allowed=new Set(['event_id','subscription_id','generation','id','expires_at','revision','input_revision','attempt','retry_count','change_sequence','acknowledged','status','attempts','parent_task_id','safe_to_retry','accepted_as_final','result_id','question_id','decision','user_accepted','disposition','method']);
    return (this.db.prepare('SELECT * FROM task_evidence ORDER BY id').all() as {id:number;at:string;kind:string;task_id:string|null;detail:string}[]).map(row=>{
      const detail=JSON.parse(row.detail) as Record<string,unknown>;
      return {...row,detail:canonical(Object.fromEntries(Object.entries(detail).filter(([key,value])=>allowed.has(key)&&(value===null||['string','number','boolean'].includes(typeof value)))))};
    });
  }
  private raw(id: string): StoredTask { const row=this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id) as {data:string}|undefined; if(!row) throw new ProbeError('task_not_found'); return JSON.parse(row.data); }
  private all(): StoredTask[] { return (this.db.prepare('SELECT data FROM tasks ORDER BY rowid').all() as {data:string}[]).map(r=>JSON.parse(r.data)); }
  private save(t: StoredTask) { this.db.prepare('INSERT INTO tasks(id,request_key,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(t.task_id,t.idempotency_key,canonical(t)); }
  private changed(t: StoredTask,kind: string,detail: Record<string,unknown>={}) { t.change_sequence++; t.updated_at=iso(this.now()); this.save(t); this.audit(kind,t.task_id,{...detail,change_sequence:t.change_sequence}); }
  private publicTask(t: StoredTask) {
    const attempts=t.attempts.map(({claim_token:_token,claim_key:_key,...safe})=>safe);
    const current=t.results.find(r=>r.result_id===t.result_id);
    return {...t,attempts, result:current?.result, result_read_at:current?.result_read_at,codex_ack_at:current?.codex_ack_at,user_accepted:current?.user_accepted,user_accepted_at:current?.user_accepted_at};
  }
  private operation<T>(scope: string,key: string,body: unknown,fn:()=>T): T {
    required(key); const serialized=canonical(body);
    const old=this.db.prepare('SELECT body,response FROM task_operations WHERE scope=? AND key=?').get(scope,key) as {body:string;response:string}|undefined;
    if(old) { if(old.body!==serialized) throw new ProbeError('idempotency_conflict'); return JSON.parse(old.response) as T; }
    const response=fn(); this.db.prepare('INSERT INTO task_operations(scope,key,body,response) VALUES(?,?,?,?)').run(scope,key,serialized,canonical(response)); return response;
  }
  private order() { return Math.max(0,...this.all().map(t=>t.queued_order))+1; }
  private enqueue(taskId: string) {
    const eventId=`evt_${randomUUID()}`; const t=this.raw(taskId);
    const payload=canonical({eventId,name:'task.available',timestamp:iso(this.now()),data:{task_id:taskId,queue:'tasks'},cursor:null});
    this.db.prepare('INSERT INTO task_events(id,payload) VALUES(?,?)').run(eventId,payload); this.audit('event_created',taskId,{event_id:eventId,revision:t.input_revision});
    for(const sub of this.subscriptions().filter(s=>s.active && s.expires_at>this.now())) { this.db.prepare('INSERT INTO task_deliveries(event_id,subscription_id,next_at) VALUES(?,?,?)').run(eventId,sub.id,this.now()); this.audit('event_scheduled',taskId,{event_id:eventId,subscription_id:sub.id,generation:sub.generation}); }
  }
  private wake() { if(this.all().some(t=>occupies(t.status))) return; const next=this.all().filter(t=>t.status==='queued').sort((a,b)=>a.queued_order-b.queued_order)[0]; if(next) this.enqueue(next.task_id); }
  private owned(args: OwnedInput) { const t=this.raw(args.task_id); const a=t.attempts.find(a=>a.claim_token===args.claim_token); if(!a) throw new ProbeError('invalid_claim_token'); return {t,a,current:a.number===t.attempt && a.status==='running' && ['running','cancel_requested'].includes(t.status)}; }
  private create(args: SubmitInput,parent?: StoredTask) {
    required(args.idempotency_key); required(args.title); required(args.input?.text); links(args.input.links); const hours=deadlineHours(args.deadline_hours);
    if(args.safe_to_retry!==undefined && typeof args.safe_to_retry!=='boolean') throw new ProbeError('invalid_argument'); if(args.logical_session_id!==undefined) required(args.logical_session_id);
    const t: StoredTask={task_id:randomUUID(),idempotency_key:args.idempotency_key,title:args.title,input:JSON.parse(canonical(args.input)),status:'queued',safe_to_retry:args.safe_to_retry??false,input_revision:1,change_sequence:1,created_at:iso(this.now()),updated_at:iso(this.now()),deadline:iso(this.now()+hours*3_600_000),queued_order:this.order(),attempt:0,retry_count:0,attempts:[],messages:[],questions:[],results:[],logical_session_id:args.logical_session_id};
    if(parent) { t.parent_task_id=parent.task_id; t.logical_session_id ??= parent.logical_session_id; t.parent_context={task_id:parent.task_id,title:parent.title,input:parent.input,messages:parent.messages,result_id:parent.result_id,result:parent.results.find(r=>r.result_id===parent.result_id)?.result,status:parent.status,input_revision:parent.input_revision}; }
    this.save(t); this.audit('enqueued',t.task_id,{safe_to_retry:t.safe_to_retry,parent_task_id:t.parent_task_id}); this.enqueue(t.task_id); return this.publicTask(t);
  }
  submit(args: SubmitInput) { this.sweep(); return this.db.transaction(()=>this.operation('submit',args.idempotency_key,args,()=>this.create(args)))(); }
  followup(args: SubmitInput & {parent_task_id:string}) { this.sweep(); return this.db.transaction(()=>this.operation('submit',args.idempotency_key,args,()=>{ const parent=this.raw(args.parent_task_id); if(parent.status!=='completed') throw new ProbeError('parent_not_completed'); return this.create(args,parent); }))(); }
  get(task_id: string, options: {record_read?:boolean} = {}) { this.sweep(); return this.db.transaction(()=>{ const t=this.raw(task_id); const result=t.results.find(r=>r.result_id===t.result_id); if(options.record_read && result && !result.result_read_at) { result.result_read_at=iso(this.now()); this.changed(t,'result_read',{result_id:result.result_id}); } return this.publicTask(t); })(); }
  markRead(task_id: string) { return this.get(task_id,{record_read:true}); }
  list(filter?: {status?: TaskStatus;logical_session_id?:string;parent_task_id?:string;limit?:number}) { this.sweep(); if(filter?.limit!==undefined && (!Number.isInteger(filter.limit)||filter.limit<1||filter.limit>1000)) throw new ProbeError('invalid_limit'); return this.all().filter(t=>(!filter?.status||t.status===filter.status)&&(!filter?.logical_session_id||t.logical_session_id===filter.logical_session_id)&&(!filter?.parent_task_id||t.parent_task_id===filter.parent_task_id)).sort((a,b)=>filter?.status==='queued'?a.queued_order-b.queued_order:b.updated_at.localeCompare(a.updated_at)||b.queued_order-a.queued_order).slice(0,filter?.limit??1000).map(t=>this.publicTask(t)); }
  claim(args: ClaimInput) { this.sweep(); return this.db.transaction(()=>this.operation(`claim:${args.task_id}`,args.claim_key,args,()=>{
    const t=this.raw(args.task_id); if(t.status!=='queued') throw new ProbeError('not_queued'); if(this.all().some(t=>occupies(t.status))) throw new ProbeError('execution_slot_occupied'); const first=this.all().filter(t=>t.status==='queued').sort((a,b)=>a.queued_order-b.queued_order)[0]; if(first?.task_id!==t.task_id) throw new ProbeError('not_queue_head');
    t.status='running'; t.attempt++; const a: Attempt={number:t.attempt,claim_key:args.claim_key,claim_token:randomBytes(32).toString('base64url'),started_at:iso(this.now()),lease_until:iso(this.now()+LEASE_MS),status:'running',acknowledged_revision:0,checkpoints:[]}; t.attempts.push(a); this.changed(t,'claimed',{attempt:t.attempt,revision:t.input_revision}); return {...this.publicTask(t),claim_token:a.claim_token,lease_until:a.lease_until};
  }))(); }
  message(args: MessageInput) { this.sweep(); return this.db.transaction(()=>this.operation(`message:${args.task_id}`,args.message_key,args,()=>{
    required(args.text); const t=this.raw(args.task_id); if(terminal(t.status)||t.cancel_request) throw new ProbeError('task_not_editable'); if(args.deadline_hours!==undefined) t.deadline=iso(this.now()+deadlineHours(args.deadline_hours)*3_600_000);
    if(args.question_id) { const q=t.questions.find(q=>q.question_id===args.question_id); if(!q) throw new ProbeError('question_not_found'); if(q.answer) throw new ProbeError('answer_conflict'); if(t.status!=='waiting_input'||t.active_question_id!==q.question_id) throw new ProbeError('old_question'); q.answer={text:args.text,at:iso(this.now()),message_key:args.message_key}; t.status='queued'; delete t.active_question_id; t.queued_order=this.order(); }
    else if(t.status==='waiting_input') throw new ProbeError('question_id_required');
    t.input_revision++; t.messages.push({message_key:args.message_key,text:args.text,question_id:args.question_id,input_revision:t.input_revision,at:iso(this.now())}); this.changed(t,'message_saved',{revision:t.input_revision,question_id:args.question_id}); if(t.status==='queued') this.enqueue(t.task_id); return this.publicTask(t);
  }))(); }
  checkpoint(args: CheckpointInput) { this.sweep(); return this.db.transaction(()=>{
    const {t,a,current}=this.owned(args); if(!current) throw new ProbeError('attempt_not_current'); if(!Number.isInteger(args.input_revision)||args.input_revision<1||args.input_revision>t.input_revision) throw new ProbeError('invalid_revision'); const acknowledged=args.input_revision===t.input_revision; if(acknowledged) a.acknowledged_revision=args.input_revision; a.lease_until=iso(this.now()+LEASE_MS); a.checkpoints.push({at:iso(this.now()),input_revision:args.input_revision,acknowledged,summary:args.summary}); this.changed(t,'checkpoint',{attempt:a.number,revision:args.input_revision,acknowledged}); return {...this.publicTask(t),acknowledged,lease_until:a.lease_until};
  })(); }
  requestInput(args: QuestionInput) { this.sweep(); return this.db.transaction(()=>this.operation(`question:${args.task_id}`,args.question_key,args,()=>{
    required(args.question); if(args.options!==undefined && (!Array.isArray(args.options)||args.options.some(x=>typeof x!=='string'||!x.trim()))) throw new ProbeError('invalid_options'); if(args.requires_platform_action && !args.action_url) throw new ProbeError('platform_action_url_required'); if(args.action_url) links([{url:args.action_url}]);
    const {t,a,current}=this.owned(args); if(!current||t.status!=='running'||t.cancel_request) throw new ProbeError('not_running'); const q: Question={question_id:randomUUID(),question_key:args.question_key,question:args.question,options:args.options,checkpoint:args.checkpoint,requires_platform_action:args.requires_platform_action??false,action_url:args.action_url,input_revision:t.input_revision,created_at:iso(this.now())}; t.questions.push(q); t.active_question_id=q.question_id; t.status='waiting_input'; a.status='waiting_input'; this.changed(t,'question_saved',{question_id:q.question_id,attempt:a.number}); this.wake(); return this.publicTask(t);
  }))(); }
  complete(args: CompleteInput) { this.sweep(); return this.db.transaction(()=>this.operation(`complete:${args.task_id}`,args.completion_key,args,()=>{
    resultValid(args.result); const {t,a,current}=this.owned(args); if(!Number.isInteger(args.input_revision)||args.input_revision<1||args.input_revision>t.input_revision) throw new ProbeError('invalid_revision');
    const accepted=current && t.status==='running' && !t.cancel_request && args.input_revision===t.input_revision && a.acknowledged_revision===args.input_revision;
    const disposition=accepted?'final':t.cancel_request?'during_cancellation':!current?'late_attempt':args.input_revision!==t.input_revision?'stale_revision':'unacknowledged_revision'; const r: ResultRecord={result_id:randomUUID(),attempt:a.number,input_revision:args.input_revision,result:JSON.parse(canonical(args.result)),at:iso(this.now()),accepted_as_final:accepted,disposition}; t.results.push(r);
    if(accepted) { t.status='completed'; t.result_id=r.result_id; a.status='completed'; } this.changed(t,accepted?'result_saved':'result_evidence',{result_id:r.result_id,attempt:a.number,revision:args.input_revision,disposition}); if(accepted) this.wake(); return {...this.publicTask(t),submitted_result_id:r.result_id,accepted_as_final:accepted};
  }))(); }
  fail(args: FailInput) { this.sweep(); return this.db.transaction(()=>this.operation(`fail:${args.task_id}`,args.failure_key,args,()=>{
    required(args.error?.code); required(args.error?.message); const {t,a,current}=this.owned(args);
    if(!Number.isInteger(args.input_revision)||args.input_revision<1||args.input_revision>t.input_revision) throw new ProbeError('invalid_revision');
    const accepted=current && t.status==='running' && !t.cancel_request && args.input_revision===t.input_revision && a.acknowledged_revision===args.input_revision;
    const disposition=accepted?'final':t.cancel_request?'during_cancellation':!current?'late_attempt':args.input_revision!==t.input_revision?'stale_revision':'unacknowledged_revision';
    if(accepted) { t.status='failed'; t.error=args.error; a.status='failed'; }
    this.changed(t,accepted?'failed':'late_failure_evidence',{attempt:a.number,revision:args.input_revision,error:args.error,accepted_as_final:accepted,disposition});
    if(accepted) this.wake(); return {...this.publicTask(t),accepted_as_final:accepted,failure_disposition:disposition};
  }))(); }
  cancel(args: CancelInput) { this.sweep(); return this.db.transaction(()=>this.operation(`cancel:${args.task_id}`,args.request_key,args,()=>{
    const t=this.raw(args.task_id); if(terminal(t.status)) throw new ProbeError('task_terminal'); if(t.cancel_request) throw new ProbeError('cancel_already_requested'); t.cancel_request={request_key:args.request_key,reason:args.reason,at:iso(this.now())}; if(['queued','waiting_input'].includes(t.status)) { t.status='cancelled'; delete t.active_question_id; } else t.status='cancel_requested'; this.changed(t,t.status==='cancelled'?'cancelled_unclaimed':'cancel_requested'); if(t.status==='cancelled') this.wake(); return this.publicTask(t);
  }))(); }
  ackCancel(args: AckCancelInput) { this.sweep(); return this.db.transaction(()=>this.operation(`ack_cancel:${args.task_id}`,args.ack_key,args,()=>{
    const {t,a}=this.owned(args); if(!t.cancel_request || terminal(t.status) || a.number!==t.attempt) throw new ProbeError('cancellation_not_pending'); t.status='cancelled'; a.status='cancelled'; t.cancellation_ack={at:iso(this.now()),note:args.note}; this.changed(t,'cancellation_ack',{attempt:a.number,note:args.note}); this.wake(); return this.publicTask(t);
  }))(); }
  ack(args: AckInput) { return this.db.transaction(()=>{ const t=this.raw(args.task_id); const r=t.results.find(r=>r.result_id===args.result_id); if(t.status!=='completed'||t.result_id!==args.result_id||!r) throw new ProbeError('result_not_found'); if(!r.result_read_at) throw new ProbeError('result_not_read'); if(args.user_accepted!==undefined && typeof args.user_accepted!=='boolean') throw new ProbeError('invalid_argument'); if(r.user_accepted!==undefined && args.user_accepted!==undefined && r.user_accepted!==args.user_accepted) throw new ProbeError('acceptance_conflict'); if(!r.codex_ack_at) { r.codex_ack_at=iso(this.now()); this.changed(t,'codex_result_ack',{result_id:r.result_id}); } if(args.user_accepted!==undefined && r.user_accepted===undefined) { r.user_accepted=args.user_accepted; r.user_accepted_at=iso(this.now()); this.changed(t,'user_acceptance',{result_id:r.result_id,user_accepted:args.user_accepted}); } return this.publicTask(t); })(); }
  resolve(args: ResolveInput) { this.sweep(); return this.db.transaction(()=>this.operation(`resolve:${args.task_id}`,args.resolution_key,args,()=>{
    required(args.basis); const t=this.raw(args.task_id); if(t.status!=='reconciliation_required' && !(t.status==='cancel_requested' && t.reconciliation_reason)) throw new ProbeError('resolution_not_required'); const a=t.attempts.at(-1);
    if(args.decision==='complete') { if(t.cancel_request) throw new ProbeError('cancellation_pending'); resultValid(args.result!); const r:ResultRecord={result_id:randomUUID(),input_revision:t.input_revision,result:JSON.parse(canonical(args.result)),at:iso(this.now()),accepted_as_final:true,disposition:'manual_resolution'}; t.results.push(r); t.result_id=r.result_id; t.status='completed'; }
    else if(args.decision==='fail') { t.status='failed'; t.error={code:'manually_resolved',message:args.basis}; }
    else if(args.decision==='retry') { if(t.cancel_request) throw new ProbeError('cancellation_pending'); if(Date.parse(t.deadline)<=this.now()) throw new ProbeError('deadline_expired'); t.status='queued'; t.queued_order=this.order(); }
    else throw new ProbeError('invalid_resolution'); if(a) a.status='resolved'; delete t.reconciliation_reason; this.changed(t,'manually_resolved',{decision:args.decision,basis:args.basis}); this.wake(); return this.publicTask(t);
  }))(); }
  sweep() { this.db.transaction(()=>{ let released=false; for(const t of this.all()) {
    const timeout=Date.parse(t.deadline)<=this.now(); const a=t.attempts.at(-1);
    if(['running','cancel_requested'].includes(t.status) && a && (timeout||Date.parse(a.lease_until)<=this.now())) {
      a.status=timeout?'deadline_expired':'lease_expired'; if(!timeout && !t.cancel_request && t.safe_to_retry && t.retry_count<2) { t.retry_count++; t.status='queued'; t.queued_order=this.order(); this.changed(t,'automatic_retry',{retry_count:t.retry_count,attempt:a.number}); released=true; }
      else { t.status='reconciliation_required'; t.reconciliation_reason=timeout?'deadline_expired':'lease_expired'; this.changed(t,'reconciliation_required',{reason:t.reconciliation_reason,attempt:a.number}); }
    } else if(timeout && ['queued','waiting_input'].includes(t.status)) { t.status='expired'; delete t.active_question_id; this.changed(t,'expired'); released=true; }
    } if(released) this.wake(); })(); }
  subscriptions(): Subscription[] { return (this.db.prepare('SELECT data FROM task_subscriptions').all() as {data:string}[]).map(r=>{const s=JSON.parse(r.data) as Subscription; return {...s,generation:s.generation??0};}); }
  saveSubscription(sub: Subscription) { this.db.transaction(()=>{const previous=this.subscriptions().find(s=>s.id===sub.id); if(this.subscriptions().some(s=>s.active && s.expires_at>this.now() && s.id!==sub.id)) throw new ProbeError('another_subscription_active'); this.db.prepare('INSERT INTO task_subscriptions(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(sub.id,canonical(sub)); this.audit('subscription_active',null,{id:sub.id,generation:sub.generation,expires_at:iso(sub.expires_at)}); if(sub.active && (!previous?.active||previous.expires_at<=this.now())) for(const t of this.all().filter(t=>t.status==='queued')) this.enqueue(t.task_id); })(); }
  unsubscribe(id:string,expectedGeneration?:number) { this.db.transaction(()=>{const sub=this.subscriptions().find(s=>s.id===id); if(expectedGeneration!==undefined && sub?.generation!==expectedGeneration) return; if(sub) {sub.active=false;sub.generation++;this.db.prepare('UPDATE task_subscriptions SET data=? WHERE id=?').run(canonical(sub),id);this.db.prepare("UPDATE task_deliveries SET status='stopped' WHERE subscription_id=? AND status='pending'").run(id);} this.audit('subscription_stopped',null,{id});})(); }
  pending(): Delivery[] { return this.db.prepare("SELECT d.id,d.event_id,d.subscription_id,d.attempts,e.payload FROM task_deliveries d JOIN task_events e ON e.id=d.event_id WHERE d.status='pending' AND d.next_at<=? ORDER BY d.id LIMIT 10").all(this.now()) as Delivery[]; }
  isDeliveryPending(id:number) {return this.db.prepare("SELECT 1 FROM task_deliveries WHERE id=? AND status='pending' AND next_at<=?").get(id,this.now())!==undefined;}
  deliveryResult(item:Delivery,status:number) {this.db.transaction(()=>{const attempts=item.attempts+1,accepted=status>=200&&status<300,terminal=[410,413].includes(status)||(status>=400&&status<500&&status!==408&&status!==429),state=accepted?'received':terminal||attempts>=6?'failed':'pending';const updated=this.db.prepare("UPDATE task_deliveries SET attempts=?,status=?,last_status=?,next_at=? WHERE id=? AND status='pending' AND attempts=?").run(attempts,state,status,this.now()+Math.min(60_000,1000*2**attempts),item.id,item.attempts);if(updated.changes){const taskId=(JSON.parse(item.payload) as {data:{task_id:string}}).data.task_id;this.audit(accepted?'event_receipt':state==='failed'?'event_delivery_failed':'event_retry',taskId,{event_id:item.event_id,subscription_id:item.subscription_id,status,attempts});}})();}
  status() {this.sweep();return {phase:'P1',production_ready:false,tasks:this.all().map(t=>({task_id:t.task_id,status:t.status,input_revision:t.input_revision,change_sequence:t.change_sequence})),execution_slot:this.all().find(t=>occupies(t.status))?.task_id,subscriptions:this.subscriptions().map(s=>({id:s.id,active:s.active&&s.expires_at>this.now(),expires_at:iso(s.expires_at)})),deliveries:this.db.prepare('SELECT status,COUNT(*) AS count FROM task_deliveries GROUP BY status').all()};}
}
