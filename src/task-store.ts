import { TaskDiagnostics } from './task-diagnostics.js';
import Database from 'better-sqlite3';
import { normalizedTaskStorage, readStoredTask, writeStoredTask } from './task-persistence.js';
export { migrateTaskStorage } from './task-persistence.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ProbeError, type Delivery, type Subscription } from './store.js';
import { observeDatabase } from './observe.js';
import { CallerDispatchStore, DispatchContextError, type DeliveryWindow } from './caller-dispatch.js';
import { ChatStore } from './chat.js';
import { z } from 'zod';
import { DESKTOP_IPC_DIAGNOSTIC_CODES, DESKTOP_IPC_FAILURE_REASONS } from './desktop-echo-ipc.js';
import { diagnosticUuid, workerDiagnosticField } from './worker-diagnostics.js';

export type TaskStatus = 'queued'|'running'|'waiting_input'|'cancel_requested'|'reconciliation_required'|'completed'|'failed'|'cancelled'|'expired';
export interface Link { url: string; label?: string }
export interface TaskInput { text: string; links?: Link[] }
export interface TaskResult { text?: string; data?: unknown; links?: Link[] }
export interface ResponseOptions { response_mode?: 'full' | 'compact' }
export interface SubmitInput extends ResponseOptions { idempotency_key: string; title: string; input: TaskInput; safe_to_retry?: boolean; deadline_hours?: number; logical_session_id?: string }
export interface MessageInput extends ResponseOptions { task_id: string; message_key: string; text: string; question_id?: string; deadline_hours?: number }
export interface ClaimInput extends ResponseOptions { task_id: string; claim_key: string }
export interface OwnedInput extends ResponseOptions { task_id: string; claim_token: string }
export interface CheckpointInput extends OwnedInput { input_revision: number; summary?: string }
export interface QuestionInput extends OwnedInput { question_key: string; question: string; options?: string[]; checkpoint?: string; requires_platform_action?: boolean; action_url?: string }
export interface CompleteInput extends OwnedInput { completion_key: string; input_revision: number; result: TaskResult }
export interface FailInput extends OwnedInput { failure_key: string; input_revision: number; error: { code: string; message: string } }
export interface CancelInput extends ResponseOptions { task_id: string; request_key: string; reason?: string }
export interface AckCancelInput extends OwnedInput { ack_key: string; note?: string }
export interface AckInput extends ResponseOptions { task_id: string; result_id: string; user_accepted?: boolean }
export interface ResolveInput extends ResponseOptions { task_id: string; resolution_key: string; decision: 'complete'|'fail'|'retry'; basis: string; result?: TaskResult }
interface Attempt { number: number; claim_key: string; claim_token: string; started_at: string; lease_until: string; status: string; acknowledged_revision: number; checkpoints: { at: string; input_revision: number; acknowledged: boolean; summary?: string }[] }
interface Question { question_id: string; question_key: string; question: string; options?: string[]; checkpoint?: string; requires_platform_action: boolean; action_url?: string; input_revision: number; created_at: string; answer?: { text: string; at: string; message_key: string } }
interface ResultRecord { result_id: string; attempt?: number; input_revision: number; result: TaskResult; at: string; accepted_as_final: boolean; disposition: string; result_read_at?: string; codex_ack_at?: string; user_accepted?: boolean; user_accepted_at?: string }
export interface StoredTask { bridge_chat_id?: string; reply_binding_key?: string; reply_subscription_id?: string; task_id: string; idempotency_key: string; title: string; input: TaskInput; logical_session_id?: string; parent_task_id?: string; parent_context?: unknown; status: TaskStatus; safe_to_retry: boolean; input_revision: number; change_sequence: number; created_at: string; updated_at: string; deadline: string; queued_order: number; attempt: number; retry_count: number; attempts: Attempt[]; messages: { message_key: string; text: string; question_id?: string; input_revision: number; at: string }[]; questions: Question[]; results: ResultRecord[]; active_question_id?: string; result_id?: string; cancel_request?: { request_key: string; reason?: string; at: string }; cancellation_ack?: { at: string; note?: string }; error?: { code: string; message: string }; reconciliation_reason?: string }
type TaskMetadata = Pick<StoredTask,'task_id'|'title'|'status'|'input_revision'|'change_sequence'|'parent_task_id'|'logical_session_id'|'created_at'|'updated_at'|'deadline'|'active_question_id'|'result_id'|'bridge_chat_id'|'reply_subscription_id'|'reply_binding_key'|'queued_order'>;
const metadataColumns='id AS task_id,title,status,input_revision,change_sequence,parent_task_id,logical_session_id,created_at,updated_at,deadline,active_question_id,result_id,bridge_chat_id,reply_subscription_id,reply_binding_key,queued_order';
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
  private readonly statements=new Map<string,Database.Statement>();
  private prepare(sql:string) {let statement=this.statements.get(sql);if(!statement){statement=this.db.prepare(sql);this.statements.set(sql,statement);}return statement;}
  readonly dispatch: CallerDispatchStore;
  readonly chats: ChatStore;
  private readonly normalized: boolean;
  private readonly diagnostics: TaskDiagnostics;
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly workListeners = new Set<() => void>();
  private readonly changedIds = new Set<string>();
  private workChanged = false;
  private maintenanceEnabled = false;
  private maintenanceTimer?: NodeJS.Timeout;
  private closed = false;
  private replySubscriptionGuard?: (subscriptionId: string, bindingKey: string) => boolean;
  setReplySubscriptionGuard(guard: (subscriptionId: string, bindingKey: string) => boolean) { this.replySubscriptionGuard=guard; this.transaction(()=>this.wake())(); }
  subscriptionCurrent(id: string) { return this.subscriptions().some(s=>s.id===id && s.active && s.expires_at>this.now()); }
  private workerTargetCurrent(t: Pick<TaskMetadata,'task_id'|'status'|'deadline'|'bridge_chat_id'|'reply_subscription_id'|'reply_binding_key'>) { if (t.bridge_chat_id) return this.chats.taskCurrent(t.task_id,t.bridge_chat_id,t.deadline,t.status); return !t.reply_subscription_id || (!!t.reply_binding_key && /^[a-f0-9]{64}$/.test(t.reply_binding_key) && this.subscriptionCurrent(t.reply_subscription_id) && (this.replySubscriptionGuard?.(t.reply_subscription_id,t.reply_binding_key) ?? false)); }
  private assertWorkerTarget(id: string) { if(!this.workerTargetCurrent(this.raw(id))) throw new ProbeError('reply_subscription_unavailable'); }
  submitNotificationReply(args: SubmitInput, subscriptionId: string, bindingKey: string) {
    if(!/^sub_[a-f0-9]{40}$/.test(subscriptionId) || !/^[a-f0-9]{64}$/.test(bindingKey) || !this.subscriptionCurrent(subscriptionId) || !(this.replySubscriptionGuard?.(subscriptionId,bindingKey) ?? false)) throw new ProbeError('reply_subscription_unavailable');
    this.sweep(); return this.transaction(()=>{const task=this.operation('notification_reply',args.idempotency_key,{args,subscriptionId,bindingKey},()=>this.create(args,undefined,subscriptionId,bindingKey));this.assertWorkerTarget(task.task_id);return task;})();
  }
  constructor(path: string, readonly now: () => number = Date.now) {
    this.db=new Database(path); this.db.pragma('journal_mode = WAL'); this.db.pragma('foreign_keys = ON'); this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,request_key TEXT UNIQUE NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_operations(scope TEXT NOT NULL,key TEXT NOT NULL,body TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(scope,key));
      CREATE TABLE IF NOT EXISTS task_subscriptions(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_events(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_deliveries(id INTEGER PRIMARY KEY,event_id TEXT NOT NULL REFERENCES task_events(id),subscription_id TEXT NOT NULL REFERENCES task_subscriptions(id),attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',last_status INTEGER,UNIQUE(event_id,subscription_id));
      CREATE TABLE IF NOT EXISTS task_evidence(id INTEGER PRIMARY KEY,at TEXT NOT NULL,kind TEXT NOT NULL,task_id TEXT,detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_queue_observations(task_id TEXT PRIMARY KEY,input_revision INTEGER NOT NULL,ready_at INTEGER NOT NULL,received_at INTEGER);`);
    // Additive projections remain correct when an older runtime writes legacy JSON.
    this.db.transaction(() => {
      const columns = new Set((this.db.pragma('table_xinfo(tasks)') as {name:string}[]).map(row => row.name));
      const projections: Record<string,string> = {
        status: "json_extract(data,'$.status')", queued_order: "json_extract(data,'$.queued_order')",
        deadline: "json_extract(data,'$.deadline')", lease_until: "coalesce(json_extract(data,'$.__lease_until'),json_extract(data,'$.attempts[#-1].lease_until'))",
        updated_at: "json_extract(data,'$.updated_at')", logical_session_id: "json_extract(data,'$.logical_session_id')",
        parent_task_id: "json_extract(data,'$.parent_task_id')", input_revision: "json_extract(data,'$.input_revision')",
        change_sequence: "json_extract(data,'$.change_sequence')",
        ...Object.fromEntries(['title','created_at','active_question_id','result_id','bridge_chat_id','reply_subscription_id','reply_binding_key'].map(key=>[key,`json_extract(data,'$.${key}')`])),
        next_due: "CASE WHEN json_extract(data,'$.status') IN ('queued','waiting_input') THEN json_extract(data,'$.deadline') WHEN json_extract(data,'$.status') IN ('running','cancel_requested') THEN min(json_extract(data,'$.deadline'),coalesce(json_extract(data,'$.__lease_until'),json_extract(data,'$.attempts[#-1].lease_until'),json_extract(data,'$.deadline'))) END",
      };
      for (const [name, expression] of Object.entries(projections)) if (!columns.has(name)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} GENERATED ALWAYS AS (${expression}) VIRTUAL`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS tasks_state_order ON tasks(status,queued_order);
        CREATE INDEX IF NOT EXISTS tasks_due ON tasks(next_due) WHERE next_due IS NOT NULL;
        CREATE INDEX IF NOT EXISTS tasks_order ON tasks(queued_order);
        CREATE INDEX IF NOT EXISTS tasks_recent ON tasks(updated_at DESC,queued_order DESC);
        CREATE INDEX IF NOT EXISTS tasks_session_recent ON tasks(logical_session_id,updated_at DESC,queued_order DESC);
        CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_task_id);
        CREATE INDEX IF NOT EXISTS tasks_summary ON tasks(status,id,input_revision,change_sequence);
        CREATE INDEX IF NOT EXISTS tasks_list_recent ON tasks(updated_at DESC,queued_order DESC,id,title,status,input_revision,change_sequence,parent_task_id,logical_session_id,created_at,deadline,active_question_id,result_id,bridge_chat_id,reply_subscription_id,reply_binding_key);
        CREATE INDEX IF NOT EXISTS tasks_list_queue ON tasks(status,queued_order,id,title,input_revision,change_sequence,parent_task_id,logical_session_id,created_at,updated_at,deadline,active_question_id,result_id,bridge_chat_id,reply_subscription_id,reply_binding_key);
        CREATE INDEX IF NOT EXISTS deliveries_due ON task_deliveries(status,next_at,id);
        CREATE INDEX IF NOT EXISTS evidence_task_kind ON task_evidence(task_id,kind,id);
        CREATE INDEX IF NOT EXISTS evidence_kind_sequence ON task_evidence(kind,id);
        CREATE INDEX IF NOT EXISTS evidence_event_reference ON task_evidence(kind,json_extract(detail,'$.event_id'));
        CREATE INDEX IF NOT EXISTS events_task ON task_events(json_extract(payload,'$.data.task_id'));`);
    })();
    const eventColumns=new Set((this.db.pragma('table_info(task_events)') as {name:string}[]).map(row=>row.name));
    if(!eventColumns.has('input_revision'))this.db.exec('ALTER TABLE task_events ADD COLUMN input_revision INTEGER');
    if(!eventColumns.has('queue_order'))this.db.exec('ALTER TABLE task_events ADD COLUMN queue_order INTEGER');
    if(!eventColumns.has('input_revision')||!eventColumns.has('queue_order'))this.db.transaction(()=>{
      // Revision comes from immutable event creation evidence. Queue order is the upgrade
      // baseline; future explicit retries allocate a fresh order and cannot reuse this hint.
      this.db.exec(`UPDATE task_events SET input_revision=(SELECT json_extract(detail,'$.revision') FROM task_evidence WHERE kind='event_created' AND json_extract(detail,'$.event_id')=task_events.id ORDER BY id LIMIT 1) WHERE input_revision IS NULL;
        UPDATE task_events SET queue_order=(SELECT queued_order FROM tasks WHERE id=json_extract(task_events.payload,'$.data.task_id')) WHERE queue_order IS NULL;`);
    })();
    if(!(this.db.pragma('table_info(task_queue_observations)') as {name:string}[]).some(column=>column.name==='queue_order'))this.db.exec('ALTER TABLE task_queue_observations ADD COLUMN queue_order INTEGER');
    this.normalized = normalizedTaskStorage(this.db);
    this.diagnostics = new TaskDiagnostics(this.db,this.now);
    this.dispatch = new CallerDispatchStore(this.db, this.now);
    this.chats = new ChatStore(this);
  }
  transaction<T>(operation: () => T) {
    return () => {
      const before = new Set(this.changedIds), workBefore = this.workChanged;
      try { return this.db.transaction(operation)(); }
      catch (error) { this.changedIds.clear(); for (const id of before) this.changedIds.add(id); this.workChanged=workBefore; throw error; }
      finally { this.chats.flushLifecycleObservations(); this.flushNotifications(); }
    };
  }
  notifyCommitted() { this.flushNotifications(); }

  close() { this.stopMaintenance(); this.closed = true; for (const listeners of this.waiters.values()) for (const done of [...listeners]) done(); this.chats.flushLifecycleObservations(); this.db.close(); }
  private flushNotifications() {
    if (this.db.inTransaction) return;
    const ids = [...this.changedIds]; this.changedIds.clear();
    for (const id of ids) for (const done of [...(this.waiters.get(id) ?? [])]) done();
    if (this.workChanged) { this.workChanged = false; for (const listener of this.workListeners) { try { listener(); } catch {} } }
    if (this.maintenanceEnabled) this.scheduleMaintenance();
  }
  onWorkAvailable(listener: () => void) { this.workListeners.add(listener); return () => { this.workListeners.delete(listener); }; }
  nextDeliveryAt(): number | undefined { return (this.prepare("SELECT min(next_at) AS at FROM task_deliveries WHERE status='pending'").get() as {at:number|null}).at ?? undefined; }
  startMaintenance() { this.maintenanceEnabled = true; this.sweep(); this.transaction(()=>this.wake())(); this.scheduleMaintenance(); }
  stopMaintenance() { this.maintenanceEnabled = false; if (this.maintenanceTimer) clearTimeout(this.maintenanceTimer); this.maintenanceTimer = undefined; }
  private scheduleMaintenance(minimumDelay=1) {
    if (this.maintenanceTimer) clearTimeout(this.maintenanceTimer);
    const next = this.prepare('SELECT next_due FROM tasks WHERE next_due IS NOT NULL ORDER BY next_due LIMIT 1').get() as {next_due:string}|undefined;
    if (!next) { this.maintenanceTimer = undefined; return; }
    this.maintenanceTimer = setTimeout(() => {
      this.maintenanceTimer = undefined;
      let failed=false;
      try { this.sweep(); } catch { failed=true;try { this.audit('maintenance_error'); } catch {} }
      if (this.maintenanceEnabled) this.scheduleMaintenance(failed?1000:1);
    }, Math.max(minimumDelay, Math.min(2147483647, Date.parse(next.next_due) - this.now())));
    this.maintenanceTimer.unref();
  }
  waitForChange(taskId: string, afterSequence: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const changed = () => {
      const row = this.prepare('SELECT change_sequence,status FROM tasks WHERE id=?').get(taskId) as {change_sequence:number;status:TaskStatus}|undefined;
      if (!row) throw new ProbeError('task_not_found');
      return row.change_sequence !== afterSequence || ['waiting_input','reconciliation_required','completed','failed','cancelled','expired'].includes(row.status);
    };
    if (this.closed || signal?.aborted || timeoutMs <= 0 || changed()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const cleanup = () => { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', done); const listeners = this.waiters.get(taskId); listeners?.delete(done); if (!listeners?.size) this.waiters.delete(taskId); };
      const done = () => {cleanup();resolve();};
      const listeners = this.waiters.get(taskId) ?? new Set(); listeners.add(done); this.waiters.set(taskId, listeners);
      timer = setTimeout(done, Math.min(2147483647, timeoutMs)); signal?.addEventListener('abort', done, {once:true});
      try { if (signal?.aborted || changed()) done(); } catch (error) { cleanup(); reject(error); }
    });
  }
  observe(request: unknown, instanceId: string) { return observeDatabase(this.db, request, instanceId, this.now); }
  audit(kind: string, taskId: string|null=null, detail: Record<string,unknown>={}) { this.diagnostics.append(kind,taskId,canonical(detail)); }
  rotateDiagnostics() {this.diagnostics.rotate();}
  evidence() {
    // Full evidence remains in the private database; diagnostics expose only approved metadata.
    const allowed=new Set(['event_id','subscription_id','generation','id','expires_at','revision','input_revision','attempt','retry_count','change_sequence','acknowledged','status','attempts','parent_task_id','safe_to_retry','accepted_as_final','result_id','question_id','decision','user_accepted','disposition','method']);
    return (this.prepare('SELECT id,at,kind,task_id,detail FROM task_evidence UNION ALL SELECT id,at,kind,task_id,detail FROM task_diagnostics ORDER BY id').all() as {id:number;at:string;kind:string;task_id:string|null;detail:string}[]).map(row=>{
      const detail=JSON.parse(row.detail) as Record<string,unknown>;
      const workerDiagnostic = ['worker_ingress','worker_protocol_request','worker_protocol_response'].includes(row.kind);
      const transportField=(key:string,value:unknown)=>row.kind==='event_transport' && (key==='stage' && typeof value==='string' && ['attempt','response','transport_failure','superseded'].includes(value) || key==='duration_ms' && typeof value==='number' && Number.isFinite(value) && value>=0);
      const ipcField=(key:string,value:unknown) => row.kind==='desktop_ipc_failure' && (
        key==='request_id' && z.string().uuid().safeParse(value).success
        || key==='phase' && typeof value==='string' && ([...DESKTOP_IPC_FAILURE_REASONS,'send_ack'] as readonly string[]).includes(value)
        || key==='diagnostic_code' && typeof value==='string' && (DESKTOP_IPC_DIAGNOSTIC_CODES as readonly string[]).includes(value)
        || ['received_frames','state_frames','matched_state_frames','largest_frame_bytes'].includes(key) && typeof value==='number' && Number.isSafeInteger(value) && value>=0
      );
      return {...row,...(workerDiagnostic ? {task_id:diagnosticUuid(row.task_id)?row.task_id:null} : {}),detail:canonical(Object.fromEntries(Object.entries(detail).filter(([key,value])=>workerDiagnostic ? workerDiagnosticField(row.kind,key,value) : (allowed.has(key)&&(value===null||['string','number','boolean'].includes(typeof value)))||ipcField(key,value)||transportField(key,value))))};
    });
  }
  private raw(id: string): StoredTask { const row=this.prepare('SELECT data FROM tasks WHERE id=?').get(id) as {data:string}|undefined; if(!row) throw new ProbeError('task_not_found'); return readStoredTask(this.db,row.data); }
  private selected(sql: string, ...args: (string|number)[]): StoredTask[] { return (this.prepare(sql).all(...args) as {data:string}[]).map(row=>readStoredTask(this.db,row.data)); }
  private occupied() { return this.prepare("SELECT id FROM tasks WHERE status IN ('running','cancel_requested','reconciliation_required') LIMIT 1").get() as {id:string}|undefined; }
  private queueHead(): TaskMetadata | undefined {
    for(let offset=0;;offset+=64) {
      const rows=this.prepare(`SELECT ${metadataColumns} FROM tasks INDEXED BY tasks_list_queue WHERE status='queued' ORDER BY queued_order LIMIT 64 OFFSET ?`).all(offset) as TaskMetadata[];
      for(const task of rows) if(this.workerTargetCurrent(task))return task;
      if(rows.length<64)return;
    }
  }

  private save(t: StoredTask) { writeStoredTask(this.db,t,this.normalized); }
  private changed(t: StoredTask,kind: string,detail: Record<string,unknown>={}) { t.change_sequence++; t.updated_at=iso(this.now()); this.save(t); this.audit(kind,t.task_id,{...detail,change_sequence:t.change_sequence}); this.changedIds.add(t.task_id); }
  private publicTask(t: StoredTask) {
    const attempts=t.attempts.map(({claim_token:_token,claim_key:_key,...safe})=>safe);
    const current=t.results.find(r=>r.result_id===t.result_id);
    return {...t,attempts, result:current?.result, result_read_at:current?.result_read_at,codex_ack_at:current?.codex_ack_at,user_accepted:current?.user_accepted,user_accepted_at:current?.user_accepted_at};
  }
  private operation<T>(scope: string,key: string,body: unknown,fn:()=>T): T {
    required(key);
    const params = body as {response_mode?:string};
    if (params?.response_mode !== undefined && !['full','compact'].includes(params.response_mode)) throw new ProbeError('invalid_response_mode');
    const normalized = params?.response_mode === 'full' ? Object.fromEntries(Object.entries(body as object).filter(([key]) => key !== 'response_mode')) : body;
    const serialized=canonical(normalized),compactBody='sha256:'+createHash('sha256').update(serialized).digest('hex');
    const old=this.prepare('SELECT body,response FROM task_operations WHERE scope=? AND key=?').get(scope,key) as {body:string;response:string}|undefined;
    if(old) { if(old.body!==serialized && (params?.response_mode!=='compact'||old.body!==compactBody)) throw new ProbeError('idempotency_conflict'); return JSON.parse(old.response) as T; }
    const value=fn(); const response = params?.response_mode === 'compact' ? {...this.compact(value),operation_id:createHash('sha256').update(scope+'\0'+key).digest('hex')} as T : value; this.prepare('INSERT INTO task_operations(scope,key,body,response) VALUES(?,?,?,?)').run(scope,key,params?.response_mode==='compact'?compactBody:serialized,canonical(response)); return response;
  }
  private compact<T>(value:T): Partial<T> {
    const fields = new Set(['task_id','status','deadline','attempt','input_revision','change_sequence','active_question_id','result_id','submitted_result_id','accepted_as_final','failure_disposition','claim_token','lease_until','acknowledged','result_read_at','codex_ack_at','user_accepted','user_accepted_at']);
    return Object.fromEntries(Object.entries(value as object).filter(([key,value]) => fields.has(key) && value!==undefined)) as Partial<T>;
  }
  private order() { return ((this.prepare('SELECT queued_order FROM tasks ORDER BY queued_order DESC LIMIT 1').get() as {queued_order:number}|undefined)?.queued_order ?? 0)+1; }
  private enqueue(taskId: string) {
    const eventId=`evt_${randomUUID()}`; const t=this.prepare(`SELECT ${metadataColumns} FROM tasks WHERE id=?`).get(taskId) as TaskMetadata;
    if(t.status !== 'queued' || !this.workerTargetCurrent(t) || this.occupied() || this.queueHead()?.task_id!==taskId) return;
    if(!this.occupied() && this.queueHead()?.task_id===taskId) this.prepare('INSERT INTO task_queue_observations(task_id,input_revision,ready_at,queue_order) VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET input_revision=excluded.input_revision,ready_at=excluded.ready_at,queue_order=excluded.queue_order,received_at=NULL WHERE task_queue_observations.input_revision<>excluded.input_revision OR task_queue_observations.queue_order IS NOT excluded.queue_order').run(taskId,t.input_revision,this.now(),t.queued_order);
    // A pending notification for the same revision already wakes the same task.
    if (this.prepare("SELECT 1 FROM task_deliveries d JOIN task_events e ON e.id=d.event_id WHERE json_extract(e.payload,'$.data.task_id')=? AND e.input_revision=? AND e.queue_order=? AND d.status IN ('pending','received','failed') LIMIT 1").get(taskId,t.input_revision,t.queued_order)) return;
    const payload=canonical({eventId,name:'task.available',timestamp:iso(this.now()),data:{task_id:taskId,queue:'tasks'},cursor:null});
    this.prepare('INSERT INTO task_events(id,payload,input_revision,queue_order) VALUES(?,?,?,?)').run(eventId,payload,t.input_revision,t.queued_order); this.workChanged=true; this.audit('event_created',taskId,{event_id:eventId,revision:t.input_revision});
    for(const sub of this.subscriptions().filter(s=>s.active && s.expires_at>this.now() && (!t.reply_subscription_id || t.reply_subscription_id===s.id) && (!t.bridge_chat_id || this.chats.subscriptionId(t.bridge_chat_id)===s.id))) { this.prepare('INSERT INTO task_deliveries(event_id,subscription_id,next_at) VALUES(?,?,?)').run(eventId,sub.id,this.now()); this.audit('event_scheduled',taskId,{event_id:eventId,subscription_id:sub.id,generation:sub.generation}); }
  }
  private wake() { if(this.occupied()) return; const next=this.queueHead(); if(next) this.enqueue(next.task_id); }
  private owned(args: OwnedInput) { this.assertWorkerTarget(args.task_id); const t=this.raw(args.task_id); const a=t.attempts.find(a=>a.claim_token===args.claim_token); if(!a) throw new ProbeError('invalid_claim_token'); return {t,a,current:a.number===t.attempt && a.status==='running' && ['running','cancel_requested'].includes(t.status)}; }
  private create(args: SubmitInput,parent?: StoredTask,replySubscriptionId?: string,replyBindingKey?: string,chatId?: string) {
    required(args.idempotency_key); required(args.title); required(args.input?.text); links(args.input.links); const hours=deadlineHours(args.deadline_hours);
    if(args.safe_to_retry!==undefined && typeof args.safe_to_retry!=='boolean') throw new ProbeError('invalid_argument'); if(args.logical_session_id!==undefined) required(args.logical_session_id);
    const t: StoredTask={task_id:randomUUID(),idempotency_key:args.idempotency_key,title:args.title,input:JSON.parse(canonical(args.input)),status:'queued',safe_to_retry:args.safe_to_retry??false,input_revision:1,change_sequence:1,created_at:iso(this.now()),updated_at:iso(this.now()),deadline:iso(this.now()+hours*3_600_000),queued_order:this.order(),attempt:0,retry_count:0,attempts:[],messages:[],questions:[],results:[],logical_session_id:args.logical_session_id};
    if(chatId) t.bridge_chat_id=chatId;
    if(replySubscriptionId || parent?.reply_subscription_id) t.reply_subscription_id=replySubscriptionId ?? parent?.reply_subscription_id;
    if(t.reply_subscription_id) t.reply_binding_key=replyBindingKey ?? parent?.reply_binding_key;
    if(parent) { t.parent_task_id=parent.task_id; t.logical_session_id ??= parent.logical_session_id; t.parent_context={task_id:parent.task_id,title:parent.title,input:parent.input,messages:parent.messages,result_id:parent.result_id,result:parent.results.find(r=>r.result_id===parent.result_id)?.result,status:parent.status,input_revision:parent.input_revision}; }
    this.save(t); this.changedIds.add(t.task_id); this.audit('enqueued',t.task_id,{safe_to_retry:t.safe_to_retry,parent_task_id:t.parent_task_id}); this.enqueue(t.task_id); return this.publicTask(t);
  }
  submitChatText(text: string, chatId: string) {
    if (!this.chats.routeCurrent(chatId)) throw new ProbeError('chat_route_unavailable');
    return this.create({idempotency_key:randomUUID(),title:'Chat message',input:{text},safe_to_retry:false,deadline_hours:1/12},undefined,undefined,undefined,chatId);
  }
  inspectChatTask(taskId: string) { return this.publicTask(this.raw(taskId)); }
  submit(args: SubmitInput) { this.sweep(); return this.transaction(()=>this.operation('submit',args.idempotency_key,args,()=>this.create(args)))(); }
  /** Called only after authenticating the local Codex caller. Provenance and enqueue commit together. */
  submitFromCaller(args: SubmitInput & {delivery_window?: DeliveryWindow}) {
    const {delivery_window, ...input} = args;
    this.sweep(); return this.transaction(() => {
      const existing = this.prepare('SELECT 1 FROM task_operations WHERE scope=? AND key=?').get('submit', input.idempotency_key);
      const task = this.submit(input);
      this.dispatch.recordSubmission({taskId:task.task_id, method:'dots_submit', inputRevision:task.input_revision, deliveryWindow:delivery_window, isNewSubmission:!existing});
      return task;
    })();
  }
  followup(args: SubmitInput & {parent_task_id:string}) { this.sweep(); return this.transaction(()=>this.operation('submit',args.idempotency_key,args,()=>{ const parent=this.raw(args.parent_task_id); if(parent.status!=='completed') throw new ProbeError('parent_not_completed'); return this.create(args,parent); }))(); }
  followupFromCaller(args: SubmitInput & {parent_task_id:string; delivery_window?:DeliveryWindow}) {
    const {delivery_window, ...input} = args;
    this.sweep(); return this.transaction(() => {
      const existing = this.prepare('SELECT 1 FROM task_operations WHERE scope=? AND key=?').get('submit', input.idempotency_key);
      const task = this.followup(input);
      this.dispatch.recordSubmission({taskId:task.task_id, method:'dots_followup', inputRevision:task.input_revision, deliveryWindow:delivery_window, isNewSubmission:!existing});
      return task;
    })();
  }
  messageFromCaller(args: MessageInput) {
    this.sweep(); return this.transaction(() => {
      const existing = this.prepare('SELECT 1 FROM task_operations WHERE scope=? AND key=?').get(`message:${args.task_id}`, args.message_key);
      const task = this.message(args);
      const message=this.normalized?JSON.parse((this.prepare("SELECT data FROM task_components WHERE task_id=? AND kind='messages' AND parent=0 AND position=?").get(args.task_id,task.input_revision-2) as {data:string}).data) as StoredTask['messages'][number]:this.raw(args.task_id).messages.find(message=>message.message_key===args.message_key)!;
      this.dispatch.recordMessage({taskId:task.task_id, messageKey:args.message_key, inputRevision:message.input_revision, receivedAt:message.at, isNewMessage:!existing});
      return task;
    })();
  }
  guardDesktopDispatch(args: {request_id:string; thread_id:string; text:string}, expected?:{task_id:string;attempt:number}) {
    const context = this.dispatch.guardSend({request_id:args.request_id, thread_id:args.thread_id, text:args.text});
    if (!context) return undefined;
    this.sweep(); const task = this.get(context.task_id), attempt = task.attempts.find(attempt => attempt.number === task.attempt);
    if (expected && (expected.task_id !== task.task_id || expected.attempt !== task.attempt)) throw new DispatchContextError('delivery_attempt_changed');
    if (task.status !== 'running' || attempt?.status !== 'running') throw new DispatchContextError('delivery_task_not_running');
    if (attempt.acknowledged_revision !== task.input_revision) throw new DispatchContextError('delivery_input_not_acknowledged');
    return {...context,attempt:task.attempt};
  }
  get(task_id: string, options: {record_read?:boolean;worker?:boolean} = {}) { this.sweep(task_id); if(options.worker) this.assertWorkerTarget(task_id); return this.transaction(()=>{ const t=this.raw(task_id); const result=t.results.find(r=>r.result_id===t.result_id); if(options.record_read && result && !result.result_read_at) { result.result_read_at=iso(this.now()); this.changed(t,'result_read',{result_id:result.result_id}); } return this.publicTask(t); })(); }
  markRead(task_id: string) { return this.get(task_id,{record_read:true}); }
  list(filter?: {status?: TaskStatus;logical_session_id?:string;parent_task_id?:string;limit?:number}, options: {worker?:boolean} = {}) {
    if(filter?.limit!==undefined && (!Number.isInteger(filter.limit)||filter.limit<1||filter.limit>1000)) throw new ProbeError('invalid_limit');
    const where:string[] = [], args:(string|number)[]=[];
    for (const key of ['status','logical_session_id','parent_task_id'] as const) if (filter?.[key] !== undefined) { where.push(`${key}=?`); args.push(filter[key]!); }
    const sql=`SELECT data FROM tasks ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY ${filter?.status==='queued'?'queued_order':'updated_at DESC,queued_order DESC'}`;
    const result:ReturnType<TaskStore['publicTask']>[]=[];
    const limit=filter?.limit??1000;
    for(let offset=0;result.length<limit;offset+=limit) {
      const rows=this.prepare(sql+' LIMIT ? OFFSET ?').all(...args,limit,offset) as {data:string}[];
      for(const row of rows) {const task=readStoredTask(this.db,row.data);if(!options.worker||this.workerTargetCurrent(task))result.push(this.publicTask(task));if(result.length>=limit)break;}
      if(rows.length<limit)break;
    }
    return result;
  }
  listSummaries(filter?:{status?:TaskStatus;logical_session_id?:string;parent_task_id?:string;limit?:number},options:{worker?:boolean}={}) {
    const where:string[]=[],args:(string|number)[]=[];
    for(const key of ['status','logical_session_id','parent_task_id'] as const)if(filter?.[key]!==undefined){where.push(`${key}=?`);args.push(filter[key]!);}
    const queued=filter?.status==='queued',limit=filter?.limit??50;
    const sql=`SELECT ${metadataColumns} FROM tasks INDEXED BY ${queued?'tasks_list_queue':'tasks_list_recent'} ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY ${queued?'queued_order':'updated_at DESC,queued_order DESC'} LIMIT ? OFFSET ?`;
    const result:Omit<TaskMetadata,'bridge_chat_id'|'reply_subscription_id'|'reply_binding_key'>[]=[];
    for(let offset=0;result.length<limit;offset+=limit){
      const rows=this.prepare(sql).all(...args,limit,offset) as TaskMetadata[];
      for(const row of rows){if(options.worker&&!this.workerTargetCurrent(row))continue;const {bridge_chat_id:_chat,reply_subscription_id:_sub,reply_binding_key:_binding,...safe}=row;result.push(Object.fromEntries(Object.entries(safe).filter(([,value])=>value!==null)) as typeof safe);if(result.length>=limit)break;}
      if(rows.length<limit)break;
    }
    return result;
  }
  claim(args: ClaimInput) { this.sweep(); this.assertWorkerTarget(args.task_id); const receipt=this.transaction(()=>this.operation(`claim:${args.task_id}`,args.claim_key,args,()=>{
    const t=this.raw(args.task_id); if(t.status!=='queued') throw new ProbeError('not_queued'); if(this.occupied()) throw new ProbeError('execution_slot_occupied'); const first=this.queueHead(); if(first?.task_id!==t.task_id) throw new ProbeError('not_queue_head');
    t.status='running'; t.attempt++; const a: Attempt={number:t.attempt,claim_key:args.claim_key,claim_token:randomBytes(32).toString('base64url'),started_at:iso(this.now()),lease_until:iso(this.now()+LEASE_MS),status:'running',acknowledged_revision:0,checkpoints:[]}; t.attempts.push(a); this.changed(t,'claimed',{attempt:t.attempt,revision:t.input_revision}); return {...this.publicTask(t),claim_token:a.claim_token,lease_until:a.lease_until};
  }))();
    if(args.response_mode!=='compact') return receipt;
    const task=this.raw(args.task_id);
    return {...receipt,title:task.title,input:task.input,messages:task.messages.filter(message=>message.input_revision<=receipt.input_revision),parent_context:task.parent_context};
  }
  message(args: MessageInput) { this.sweep(); return this.transaction(()=>this.operation(`message:${args.task_id}`,args.message_key,args,()=>{
    required(args.text);
    if(this.normalized && args.response_mode==='compact' && !args.question_id) {
      const row=this.prepare('SELECT data FROM tasks WHERE id=?').get(args.task_id) as {data:string}|undefined;
      if(!row)throw new ProbeError('task_not_found');
      const t=JSON.parse(row.data) as StoredTask;
      if(terminal(t.status)||t.cancel_request)throw new ProbeError('task_not_editable');
      if(t.status==='waiting_input')throw new ProbeError('question_id_required');
      if(args.deadline_hours!==undefined)t.deadline=iso(this.now()+deadlineHours(args.deadline_hours)*3_600_000);
      t.input_revision++;t.change_sequence++;t.updated_at=iso(this.now());
      const message={message_key:args.message_key,text:args.text,input_revision:t.input_revision,at:t.updated_at};
      this.prepare("INSERT INTO task_components(task_id,kind,parent,position,data) VALUES(?,'messages',0,?,?)").run(t.task_id,t.input_revision-2,canonical(message));
      this.prepare('UPDATE tasks SET data=? WHERE id=?').run(canonical(t),t.task_id);
      this.audit('message_saved',t.task_id,{revision:t.input_revision,change_sequence:t.change_sequence});this.changedIds.add(t.task_id);
      if(t.status==='queued')this.enqueue(t.task_id);
      return this.compact(t) as unknown as ReturnType<TaskStore['publicTask']>;
    }
     const t=this.raw(args.task_id); if(terminal(t.status)||t.cancel_request) throw new ProbeError('task_not_editable'); if(args.deadline_hours!==undefined) t.deadline=iso(this.now()+deadlineHours(args.deadline_hours)*3_600_000);
    if(args.question_id) { const q=t.questions.find(q=>q.question_id===args.question_id); if(!q) throw new ProbeError('question_not_found'); if(q.answer) throw new ProbeError('answer_conflict'); if(t.status!=='waiting_input'||t.active_question_id!==q.question_id) throw new ProbeError('old_question'); q.answer={text:args.text,at:iso(this.now()),message_key:args.message_key}; t.status='queued'; delete t.active_question_id; t.queued_order=this.order(); }
    else if(t.status==='waiting_input') throw new ProbeError('question_id_required');
    t.input_revision++; t.messages.push({message_key:args.message_key,text:args.text,question_id:args.question_id,input_revision:t.input_revision,at:iso(this.now())}); this.changed(t,'message_saved',{revision:t.input_revision,question_id:args.question_id}); if(t.status==='queued') this.enqueue(t.task_id); return this.publicTask(t);
  }))(); }
  checkpoint(args: CheckpointInput) { this.sweep(); return this.transaction(()=>{
    const {t,a,current}=this.owned(args); if(!current) throw new ProbeError('attempt_not_current'); if(!Number.isInteger(args.input_revision)||args.input_revision<1||args.input_revision>t.input_revision) throw new ProbeError('invalid_revision'); const acknowledged=args.input_revision===t.input_revision; if(acknowledged) a.acknowledged_revision=args.input_revision; a.lease_until=iso(this.now()+LEASE_MS); a.checkpoints.push({at:iso(this.now()),input_revision:args.input_revision,acknowledged,summary:args.summary}); this.changed(t,'checkpoint',{attempt:a.number,revision:args.input_revision,acknowledged}); const value={...this.publicTask(t),acknowledged,lease_until:a.lease_until}; return args.response_mode==='compact'?this.compact(value) as typeof value:value;
  })(); }
  requestInput(args: QuestionInput) { this.sweep(); this.assertWorkerTarget(args.task_id); return this.transaction(()=>this.operation(`question:${args.task_id}`,args.question_key,args,()=>{
    required(args.question); if(args.options!==undefined && (!Array.isArray(args.options)||args.options.some(x=>typeof x!=='string'||!x.trim()))) throw new ProbeError('invalid_options'); if(args.requires_platform_action && !args.action_url) throw new ProbeError('platform_action_url_required'); if(args.action_url) links([{url:args.action_url}]);
    const {t,a,current}=this.owned(args); if(t.bridge_chat_id) throw new ProbeError('chat_text_reply_required'); if(!current||t.status!=='running'||t.cancel_request) throw new ProbeError('not_running'); const q: Question={question_id:randomUUID(),question_key:args.question_key,question:args.question,options:args.options,checkpoint:args.checkpoint,requires_platform_action:args.requires_platform_action??false,action_url:args.action_url,input_revision:t.input_revision,created_at:iso(this.now())}; t.questions.push(q); t.active_question_id=q.question_id; t.status='waiting_input'; a.status='waiting_input'; this.changed(t,'question_saved',{question_id:q.question_id,attempt:a.number}); this.wake(); return this.publicTask(t);
  }))(); }
  complete(args: CompleteInput) { this.sweep(); this.assertWorkerTarget(args.task_id); return this.transaction(()=>this.operation(`complete:${args.task_id}`,args.completion_key,args,()=>{
    resultValid(args.result); const {t,a,current}=this.owned(args); if(!Number.isInteger(args.input_revision)||args.input_revision<1||args.input_revision>t.input_revision) throw new ProbeError('invalid_revision');
    const accepted=current && t.status==='running' && !t.cancel_request && args.input_revision===t.input_revision && a.acknowledged_revision===args.input_revision;
    const disposition=accepted?'final':t.cancel_request?'during_cancellation':!current?'late_attempt':args.input_revision!==t.input_revision?'stale_revision':'unacknowledged_revision'; const r: ResultRecord={result_id:randomUUID(),attempt:a.number,input_revision:args.input_revision,result:JSON.parse(canonical(args.result)),at:iso(this.now()),accepted_as_final:accepted,disposition}; t.results.push(r);
    if(accepted) { t.status='completed'; t.result_id=r.result_id; a.status='completed'; } this.changed(t,accepted?'result_saved':'result_evidence',{result_id:r.result_id,attempt:a.number,revision:args.input_revision,disposition}); if(accepted) this.wake(); return {...this.publicTask(t),submitted_result_id:r.result_id,accepted_as_final:accepted};
  }))(); }
  fail(args: FailInput) { this.sweep(); this.assertWorkerTarget(args.task_id); return this.transaction(()=>this.operation(`fail:${args.task_id}`,args.failure_key,args,()=>{
    required(args.error?.code); required(args.error?.message); const {t,a,current}=this.owned(args);
    if(!Number.isInteger(args.input_revision)||args.input_revision<1||args.input_revision>t.input_revision) throw new ProbeError('invalid_revision');
    const accepted=current && t.status==='running' && !t.cancel_request && args.input_revision===t.input_revision && a.acknowledged_revision===args.input_revision;
    const disposition=accepted?'final':t.cancel_request?'during_cancellation':!current?'late_attempt':args.input_revision!==t.input_revision?'stale_revision':'unacknowledged_revision';
    if(accepted) { t.status='failed'; t.error=args.error; a.status='failed'; }
    this.changed(t,accepted?'failed':'late_failure_evidence',{attempt:a.number,revision:args.input_revision,error:args.error,accepted_as_final:accepted,disposition});
    if(accepted) this.wake(); return {...this.publicTask(t),accepted_as_final:accepted,failure_disposition:disposition};
  }))(); }
  cancel(args: CancelInput) { this.sweep(); return this.transaction(()=>this.operation(`cancel:${args.task_id}`,args.request_key,args,()=>{
    const t=this.raw(args.task_id); if(terminal(t.status)) throw new ProbeError('task_terminal'); if(t.cancel_request) throw new ProbeError('cancel_already_requested'); t.cancel_request={request_key:args.request_key,reason:args.reason,at:iso(this.now())}; if(['queued','waiting_input'].includes(t.status)) { t.status='cancelled'; delete t.active_question_id; } else t.status='cancel_requested'; this.changed(t,t.status==='cancelled'?'cancelled_unclaimed':'cancel_requested'); if(t.status==='cancelled') this.wake(); return this.publicTask(t);
  }))(); }
  ackCancel(args: AckCancelInput) { this.sweep(); this.assertWorkerTarget(args.task_id); return this.transaction(()=>this.operation(`ack_cancel:${args.task_id}`,args.ack_key,args,()=>{
    const {t,a}=this.owned(args); if(!t.cancel_request || terminal(t.status) || a.number!==t.attempt) throw new ProbeError('cancellation_not_pending'); t.status='cancelled'; a.status='cancelled'; t.cancellation_ack={at:iso(this.now()),note:args.note}; this.changed(t,'cancellation_ack',{attempt:a.number,note:args.note}); this.wake(); return this.publicTask(t);
  }))(); }
  ack(args: AckInput) { return this.transaction(()=>{ const t=this.raw(args.task_id); const r=t.results.find(r=>r.result_id===args.result_id); if(t.status!=='completed'||t.result_id!==args.result_id||!r) throw new ProbeError('result_not_found'); if(!r.result_read_at) throw new ProbeError('result_not_read'); if(args.user_accepted!==undefined && typeof args.user_accepted!=='boolean') throw new ProbeError('invalid_argument'); if(r.user_accepted!==undefined && args.user_accepted!==undefined && r.user_accepted!==args.user_accepted) throw new ProbeError('acceptance_conflict'); if(!r.codex_ack_at) { r.codex_ack_at=iso(this.now()); this.changed(t,'codex_result_ack',{result_id:r.result_id}); } if(args.user_accepted!==undefined && r.user_accepted===undefined) { r.user_accepted=args.user_accepted; r.user_accepted_at=iso(this.now()); this.changed(t,'user_acceptance',{result_id:r.result_id,user_accepted:args.user_accepted}); } const value=this.publicTask(t);return args.response_mode==='compact'?this.compact(value) as typeof value:value; })(); }
  resolve(args: ResolveInput) { this.sweep(); return this.transaction(()=>this.operation(`resolve:${args.task_id}`,args.resolution_key,args,()=>{
    required(args.basis); const t=this.raw(args.task_id); if(t.status!=='reconciliation_required' && !(t.status==='cancel_requested' && t.reconciliation_reason)) throw new ProbeError('resolution_not_required'); const a=t.attempts.at(-1);
    if(args.decision==='complete') { if(t.cancel_request) throw new ProbeError('cancellation_pending'); resultValid(args.result!); const r:ResultRecord={result_id:randomUUID(),input_revision:t.input_revision,result:JSON.parse(canonical(args.result)),at:iso(this.now()),accepted_as_final:true,disposition:'manual_resolution'}; t.results.push(r); t.result_id=r.result_id; t.status='completed'; }
    else if(args.decision==='fail') { t.status='failed'; t.error={code:'manually_resolved',message:args.basis}; }
    else if(args.decision==='retry') { if(t.cancel_request) throw new ProbeError('cancellation_pending'); if(Date.parse(t.deadline)<=this.now()) throw new ProbeError('deadline_expired'); t.status='queued'; t.queued_order=this.order(); }
    else throw new ProbeError('invalid_resolution'); if(a) a.status='resolved'; delete t.reconciliation_reason; this.changed(t,'manually_resolved',{decision:args.decision,basis:args.basis}); this.wake(); return this.publicTask(t);
  }))(); }
  sweep(taskId?:string) { this.transaction(()=>{ let released=false; for(const t of taskId ? this.selected('SELECT data FROM tasks WHERE id=? AND next_due<=?',taskId,iso(this.now())) : this.selected('SELECT data FROM tasks WHERE next_due IS NOT NULL AND next_due<=? ORDER BY next_due',iso(this.now()))) {
    const timeout=Date.parse(t.deadline)<=this.now(); const a=t.attempts.at(-1);
    if(['running','cancel_requested'].includes(t.status) && a && (timeout||Date.parse(a.lease_until)<=this.now())) {
      a.status=timeout?'deadline_expired':'lease_expired'; if(!timeout && !t.cancel_request && t.safe_to_retry && t.retry_count<2) { t.retry_count++; t.status='queued'; t.queued_order=this.order(); this.changed(t,'automatic_retry',{retry_count:t.retry_count,attempt:a.number}); released=true; }
      else { t.status='reconciliation_required'; t.reconciliation_reason=timeout?'deadline_expired':'lease_expired'; this.changed(t,'reconciliation_required',{reason:t.reconciliation_reason,attempt:a.number}); }
    } else if(timeout && ['queued','waiting_input'].includes(t.status)) { t.status='expired'; delete t.active_question_id; this.changed(t,'expired'); released=true; }
    } if(released) this.wake(); })(); }
  subscriptions(): Subscription[] { return (this.prepare('SELECT data FROM task_subscriptions').all() as {data:string}[]).map(r=>{const s=JSON.parse(r.data) as Subscription; return {...s,generation:s.generation??0};}); }
  saveSubscription(sub: Subscription) { this.transaction(()=>{const previous=this.subscriptions().find(s=>s.id===sub.id); if(this.subscriptions().some(s=>s.active && s.expires_at>this.now() && s.id!==sub.id)) throw new ProbeError('another_subscription_active'); this.prepare('INSERT INTO task_subscriptions(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(sub.id,canonical(sub)); this.chats.subscriptionSaved(previous,sub); this.audit('subscription_active',null,{id:sub.id,generation:sub.generation,expires_at:iso(sub.expires_at)}); if(sub.active && (!previous?.active||previous.expires_at<=this.now())) for(const t of this.selected("SELECT data FROM tasks WHERE status='queued' ORDER BY queued_order")) this.enqueue(t.task_id); })(); }
  unsubscribe(id:string,expectedGeneration?:number) { this.transaction(()=>{const sub=this.subscriptions().find(s=>s.id===id); if(expectedGeneration!==undefined && sub?.generation!==expectedGeneration) return; if(sub) {this.chats.subscriptionStopped(id);sub.active=false;sub.generation++;this.prepare('UPDATE task_subscriptions SET data=? WHERE id=?').run(canonical(sub),id);this.prepare("UPDATE task_deliveries SET status='stopped' WHERE subscription_id=? AND status='pending'").run(id);} this.audit('subscription_stopped',null,{id});})(); }
  private deliveryTargetCurrent(item: {payload:string;subscription_id:string;event_revision?:number|null;event_queue_order?:number|null}) { const task=this.raw((JSON.parse(item.payload) as {data:{task_id:string}}).data.task_id),current=this.workerTargetCurrent(task);return (item.event_queue_order==null||item.event_queue_order===task.queued_order) && (item.event_revision==null || item.event_revision===task.input_revision) && task.status === 'queued' && Date.parse(task.deadline)>this.now() && current && (!task.reply_subscription_id || task.reply_subscription_id===item.subscription_id) && (!task.bridge_chat_id || this.chats.subscriptionId(task.bridge_chat_id)===item.subscription_id); }
  pending(): Delivery[] { return this.transaction(() => { const ready:Delivery[]=[];let suppressed=false;for(const row of this.prepare("SELECT d.id,d.event_id,d.subscription_id,d.attempts,e.payload,e.input_revision AS event_revision,e.queue_order AS event_queue_order FROM task_deliveries d JOIN task_events e ON e.id=d.event_id WHERE d.status='pending' AND d.next_at<=? ORDER BY d.id LIMIT 100").all(this.now())) {const item=row as Delivery;if(this.deliveryTargetCurrent(item))ready.push(item);else {this.prepare("UPDATE task_deliveries SET status='stopped' WHERE id=? AND status='pending'").run(item.id);suppressed=true;}if(ready.length===10)break;}if(suppressed)this.wake();return ready; })(); }
  isDeliveryPending(id:number) {const item=this.prepare("SELECT d.subscription_id,e.payload,e.input_revision AS event_revision,e.queue_order AS event_queue_order FROM task_deliveries d JOIN task_events e ON e.id=d.event_id WHERE d.id=? AND d.status='pending' AND d.next_at<=?").get(id,this.now()) as {payload:string;subscription_id:string;event_revision?:number|null;event_queue_order?:number|null}|undefined;return !!item && this.deliveryTargetCurrent(item);}
  deliveryResult(item:Delivery,status:number) {this.transaction(()=>{const attempts=item.attempts+1,accepted=status>=200&&status<300,terminal=[410,413].includes(status)||(status>=400&&status<500&&status!==408&&status!==429),state=accepted?'received':terminal||attempts>=6?'failed':'pending';const updated=this.prepare("UPDATE task_deliveries SET attempts=?,status=?,last_status=?,next_at=? WHERE id=? AND status='pending' AND attempts=?").run(attempts,state,status,this.now()+Math.min(60_000,1000*2**attempts),item.id,item.attempts);if(updated.changes){const taskId=(JSON.parse(item.payload) as {data:{task_id:string}}).data.task_id;if(accepted && !this.occupied() && this.queueHead()?.task_id===taskId)this.prepare('UPDATE task_queue_observations SET received_at=COALESCE(received_at,?) WHERE task_id=? AND input_revision=(SELECT input_revision FROM task_events WHERE id=?) AND queue_order=(SELECT queue_order FROM task_events WHERE id=?)').run(this.now(),taskId,item.event_id,item.event_id);this.audit(accepted?'event_receipt':state==='failed'?'event_delivery_failed':'event_retry',taskId,{event_id:item.event_id,subscription_id:item.subscription_id,status,attempts});}})();}
  pickupDiagnostic() {
    const occupied=this.occupied();
    if(occupied) return {phase:'execution_slot_occupied',task_id:occupied.id,observed_at:iso(this.now()),next_action:'wait_or_reconcile'};
    const head=this.queueHead();
    if(!head) return {phase:'idle',observed_at:iso(this.now()),next_action:'none'};
    const timing=this.prepare('SELECT received_at FROM task_queue_observations WHERE task_id=? AND input_revision=? AND queue_order=?').get(head.task_id,head.input_revision,head.queued_order) as {received_at:number|null}|undefined;
    const elapsed=timing?.received_at==null?undefined:Math.max(0,this.now()-timing.received_at);
    return {phase:elapsed===undefined?'awaiting_delivery':elapsed>=300000?'pickup_stalled':elapsed>=60000?'pickup_delayed':'awaiting_pickup',task_id:head.task_id,observed_at:iso(this.now()),...(elapsed===undefined?{}:{waiting_ms:elapsed}),next_action:elapsed!==undefined&&elapsed>=300000?'check_dot_route':'wait'};
  }
  status(options: {summary?:boolean} = {}) {
    const counts = this.prepare('SELECT status,COUNT(*) AS count FROM tasks GROUP BY status').all() as {status:TaskStatus;count:number}[];
    const pickup=this.pickupDiagnostic();
    const recent=['enqueued','claimed','question_saved','result_saved','result_read','codex_result_ack'].map(kind=>this.prepare('SELECT id,at FROM task_evidence WHERE kind=? ORDER BY id DESC LIMIT 1').get(kind) as {id:number;at:string}|undefined);
    const last=recent.filter(row=>row!==undefined).sort((a,b)=>b.id-a.id)[0]?.at??null;
    return {phase:'P1',production_ready:false,waiting_reason:pickup.phase==='idle'?null:pickup.phase,last_business_at:last,
      tasks: options.summary ? [] : this.prepare('SELECT id AS task_id,status,input_revision,change_sequence FROM tasks INDEXED BY tasks_summary').all() as {task_id:string;status:TaskStatus;input_revision:number;change_sequence:number}[],
      task_counts:Object.fromEntries(counts.map(row=>[row.status,row.count])),pickup,execution_slot:this.occupied()?.id,
      subscriptions:this.subscriptions().map(s=>({id:s.id,active:s.active&&s.expires_at>this.now(),expires_at:iso(s.expires_at)})),
      deliveries:this.prepare('SELECT status,COUNT(*) AS count FROM task_deliveries GROUP BY status').all()};
  }
}
