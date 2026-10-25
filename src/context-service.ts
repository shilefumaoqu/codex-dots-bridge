import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, lstatSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { desktopConversationsConfigSchema } from './desktop-conversations.js';
import { ContextError, contextGetSchema, contextUpdateSchema, contextForgetSchema, type ContextGetArgs,
  type ContextState, type ContextGetResult, type ContextMutationResult, type ContextOwnerObservation,
  type ContextCoverage, type ContextEvidence } from './context-contract.js';
export { ContextError as ContextServiceError } from './context-contract.js';
import { readContextBatch, type ContextReadInput, type ContextReadBatch, type ContextWatermark, type ContextReadContinuation } from './context-reader.js';
import { historyReadScheduler, type ReadReservation } from './read-scheduler.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).filter(([,x]) => x !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,x]) => [k,normalize(x)])) : v;
  return JSON.stringify(normalize(value));
}
const fail = (code: string): never => { throw new ContextError(code); };
interface Current { epoch: number; revision: number; state: ContextState | null; verified_refs: string[];
  coverage?: ContextCoverage; watermark?: ContextWatermark; identity?: unknown }
interface Receipt { id: string; scope: string; thread: string; epoch: number; revision: number;
  storage_version?: 2; page_refs?: string[][];
  evidence: ContextEvidence[]; fragments: ContextEvidence[][]; delivered_pages: number[];
  base_refs: string[]; coverage: ContextCoverage; watermark?: ContextWatermark; identity?: unknown; basis_valid: boolean; prior_refs: string[]; prior_receipts: string[]; processed?: boolean }
interface Job { request: ContextGetArgs; scope: string; fingerprint: string; epoch: number; revision: number;
  base: Current; status: ContextGetResult['status']; receipt_id?: string; reason?: string;
  continuation?: ContextReadContinuation; continuation_token?: string; owner: ContextOwnerObservation; prior_refs?: string[]; prior_gaps?: string[]; prior_receipts?:string[] }
export interface ContextServiceOptions {
  reader?: (input: ContextReadInput) => Promise<ContextReadBatch>;
  observeOwner?: (input: {threadId: string; signal: AbortSignal; deadline: number}) => Promise<ContextOwnerObservation>;
  now?: () => number; timeoutMs?: number; pageChars?: number; normalizedStorage?: boolean;
}

function createPageTables(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS context_receipt_pages(receipt_id TEXT NOT NULL,page INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(receipt_id,page));
    CREATE TABLE IF NOT EXISTS context_receipt_progress(receipt_id TEXT PRIMARY KEY,delivered_pages TEXT NOT NULL,processed INTEGER NOT NULL DEFAULT 0);`);
}

function storeReceiptPages(db: Database.Database, receipt: Receipt, insert: boolean) {
  const pages = receipt.fragments;
  const metadata: Receipt = {...receipt, storage_version:2,
    evidence:receipt.evidence.map(item => ({ref:item.ref,text:''})),
    fragments:pages.map(() => []), page_refs:pages.map(page => [...new Set(page.map(item => item.ref))]),
    delivered_pages:[], processed:undefined,
    coverage:{...receipt.coverage, delivered_refs:[], delivery_complete:false}};
  const pageStatement = db.prepare('INSERT INTO context_receipt_pages(receipt_id,page,data) VALUES(?,?,?)');
  pages.forEach((page,index) => pageStatement.run(receipt.id,index,JSON.stringify(page)));
  db.prepare('INSERT INTO context_receipt_progress(receipt_id,delivered_pages,processed) VALUES(?,?,?)').run(receipt.id,JSON.stringify(receipt.delivered_pages),receipt.processed ? 1 : 0);
  if(insert) db.prepare('INSERT INTO context_receipts(id,scope,thread,data) VALUES(?,?,?,?)').run(receipt.id,receipt.scope,receipt.thread,JSON.stringify(metadata));
  else db.prepare('UPDATE context_receipts SET data=? WHERE id=?').run(JSON.stringify(metadata),receipt.id);
}

/** Explicit schema-2 migration hook. Caller owns maintenance mode and configuration gate. */
export function migrateContextStorage(db: Database.Database) {
  createPageTables(db);
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='context_receipts'").get()) return;
  db.transaction(() => {
    for(const {id} of db.prepare('SELECT id FROM context_receipts').all() as {id:string}[]) {
      const row=db.prepare('SELECT data FROM context_receipts WHERE id=?').get(id) as {data:string};
      const receipt = JSON.parse(row.data) as Receipt;
      if(receipt.storage_version !== 2) storeReceiptPages(db,receipt,false);
    }
  })();
}
/** Derived context only. Never sends, resumes, navigates, decrypts, or writes the source thread. */
export class ContextService {
  readonly enabled: boolean; readonly readEnabled: boolean;
  private readonly home?: string; private readonly scope: string;
  private readonly now: () => number; private readonly timeoutMs: number; private readonly pageChars: number;
  private readonly reader: (input: ContextReadInput) => Promise<ContextReadBatch>;
  private readonly observer?: ContextServiceOptions['observeOwner'];
  private readonly normalizedStorage: boolean;
  private readonly running = new Map<string, {promise: Promise<void>; controller: AbortController}>();
  private closed = false;
  constructor(private readonly db: Database.Database, config?: unknown, options: ContextServiceOptions = {}) {
    const parsed = config === undefined ? undefined : desktopConversationsConfigSchema.safeParse(config);
    if (parsed && !parsed.success) fail('invalid_config');
    const data = parsed?.success ? parsed.data : undefined;
    this.enabled = !!data && 'mode' in data && data.mode === 'local' && data.enabled && data.read;
    this.readEnabled = this.enabled;
    if (this.enabled && data && 'codex_home' in data) {
      // Canonical configuration, never a caller-supplied filesystem path.
      try { if (!lstatSync(data.codex_home).isDirectory() || lstatSync(data.codex_home).isSymbolicLink()) fail('codex_home_unavailable');
        this.home = realpathSync(data.codex_home); } catch { fail('codex_home_unavailable'); }
    }
    this.scope = hash(process.platform === 'win32' ? (this.home ?? '').toLowerCase() : this.home ?? '');
    this.now = options.now ?? Date.now; this.timeoutMs = options.timeoutMs ?? 60000; this.pageChars = options.pageChars ?? 32000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60000 || !Number.isInteger(this.pageChars) || this.pageChars < 4096 || this.pageChars > 32000) fail('invalid_options');
    this.reader = options.reader ?? readContextBatch; this.observer = options.observeOwner;
    this.normalizedStorage = options.normalizedStorage ?? false;
    db.exec(`CREATE TABLE IF NOT EXISTS context_current(scope TEXT NOT NULL,thread TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(scope,thread));
      CREATE TABLE IF NOT EXISTS context_jobs(id TEXT PRIMARY KEY,scope TEXT NOT NULL,thread TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS context_receipts(id TEXT PRIMARY KEY,scope TEXT NOT NULL,thread TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS context_operations(id TEXT PRIMARY KEY,scope TEXT NOT NULL,thread TEXT NOT NULL,fingerprint TEXT NOT NULL,response TEXT NOT NULL);`);
    if(this.normalizedStorage) createPageTables(db);
    db.transaction(() => {
      for (const row of db.prepare('SELECT id,data FROM context_jobs WHERE scope=?').all(this.scope) as {id:string;data:string}[]) {
        const job = JSON.parse(row.data) as Job;
        if (job.status === 'pending') { job.status = 'reconciliation_required'; job.reason = 'restart_requires_reconciliation'; this.saveJob(row.id,job); }
      }
    })();
  }
  private guard() { if (!this.enabled) fail('context_read_disabled'); if (this.closed) fail('context_service_closed'); }
  private unknown(): ContextOwnerObservation { return {status:'unknown',observed_at:new Date(this.now()).toISOString(),checked_by:'unavailable'}; }
  private current(thread: string): Current {
    const row = this.db.prepare('SELECT data FROM context_current WHERE scope=? AND thread=?').get(this.scope,thread) as {data:string}|undefined;
    return row ? JSON.parse(row.data) as Current : {epoch:0,revision:0,state:null,verified_refs:[]};
  }
  private saveCurrent(thread: string, value: Current) { this.db.prepare('INSERT INTO context_current(scope,thread,data) VALUES(?,?,?) ON CONFLICT(scope,thread) DO UPDATE SET data=excluded.data').run(this.scope,thread,JSON.stringify(value)); }
  private job(id: string): Job | undefined {
    const row = this.db.prepare('SELECT data FROM context_jobs WHERE id=?').get(id) as {data:string}|undefined;
    return row ? JSON.parse(row.data) as Job : undefined;
  }
  private saveJob(id: string, job: Job) { this.db.prepare('UPDATE context_jobs SET data=? WHERE id=?').run(JSON.stringify(job),id); }
  private receipt(id: string): Receipt {
    const row = this.db.prepare('SELECT data FROM context_receipts WHERE id=?').get(id) as {data:string}|undefined;
    if (!row) return fail('receipt_unavailable');
    const receipt=JSON.parse(row.data) as Receipt;
    if(receipt.storage_version===2) {
      if(!this.normalizedStorage) fail('context_storage_upgrade_required');
      const progress=this.db.prepare('SELECT delivered_pages,processed FROM context_receipt_progress WHERE receipt_id=?').get(id) as {delivered_pages:string;processed:number}|undefined;
      if(!progress) fail('receipt_unavailable');
      receipt.delivered_pages=JSON.parse(progress!.delivered_pages);receipt.processed=progress!.processed===1;
      this.deliveryCoverage(receipt);
    }
    return receipt;
  }
  private saveReceipt(receipt: Receipt) {
    if(receipt.storage_version===2) this.db.prepare('UPDATE context_receipt_progress SET delivered_pages=?,processed=? WHERE receipt_id=?').run(JSON.stringify(receipt.delivered_pages),receipt.processed ? 1 : 0,receipt.id);
    else this.db.prepare('UPDATE context_receipts SET data=? WHERE id=?').run(JSON.stringify(receipt),receipt.id);
  }
  private insertReceipt(receipt:Receipt) {
    if(this.normalizedStorage) storeReceiptPages(this.db,receipt,true);
    else this.db.prepare('INSERT INTO context_receipts(id,scope,thread,data) VALUES(?,?,?,?)').run(receipt.id,this.scope,receipt.thread,JSON.stringify(receipt));
  }
  private deliveryCoverage(receipt:Receipt) {
    const refs=receipt.page_refs??receipt.fragments.map(page=>page.map(fragment=>fragment.ref));
    const delivered=new Set(receipt.delivered_pages);
    const missing=new Set(refs.flatMap((page,index)=>delivered.has(index)?[]:page));
    receipt.coverage.delivered_refs=receipt.evidence.filter(item=>!missing.has(item.ref)).map(item=>item.ref);
    receipt.coverage.delivery_complete=delivered.size===receipt.fragments.length;
  }
  private fingerprint(args: ContextGetArgs) { return hash(canonical({thread_id:args.thread_id,mode:args.mode,refs:args.refs,evidence_offset:args.evidence_offset,continuation_token:args.continuation_token})); }
  async get(raw: unknown): Promise<ContextGetResult> {
    this.guard(); const args = contextGetSchema.parse(raw); const fingerprint = this.fingerprint(args);
    let job = this.job(args.request_id);
    if (job) { if (job.scope !== this.scope || job.fingerprint !== fingerprint) fail('request_binding_conflict'); }
    else {
      if (args.delivery_cursor) fail('delivery_cursor_invalid');
      const base = this.current(args.thread_id);
      let continuation: ContextReadContinuation | undefined; let prior_refs: string[] = []; let prior_gaps: string[]=[];let prior_receipts:string[]=[];
      if (args.continuation_token) {
        const rows = this.db.prepare('SELECT data FROM context_jobs WHERE scope=? AND thread=?').all(this.scope,args.thread_id) as {data:string}[];
        const prior = rows.map(row=>JSON.parse(row.data) as Job).find(item=>item.continuation_token===args.continuation_token);
        if (!prior || prior.epoch !== base.epoch || !prior.continuation || prior.status === 'forgotten') fail('continuation_invalid');
        continuation = prior!.continuation;
        const previousReceipt = prior!.receipt_id ? this.receipt(prior!.receipt_id) : undefined;
        if(!previousReceipt?.coverage.delivery_complete)fail('continuation_requires_delivery');
        if(previousReceipt!.processed!==true)fail('continuation_requires_update');
        prior_refs = [...new Set([...(prior!.prior_refs??[]),...(previousReceipt?.coverage.fetched_refs??[])])];
        // Snapshot only unresolved receipt obligations; processed batches already
        // contribute to the durable cumulative watermark.
        prior_receipts=[...new Set([...(prior!.prior_receipts??[]),...(previousReceipt?[previousReceipt.id]:[])])].filter(id=>{try{return this.receipt(id).processed!==true;}catch{return true;}});
        // Resource stops are resolved by the next batch. Missing public content is not.
        prior_gaps=[...new Set([...(prior!.prior_gaps??[]),...(previousReceipt?.coverage.gaps??[])])].filter(gap=>!['pending_turns','index_resource_limit','unfinished_turns_outside_index_unknown','context_resource_limit','batch_limit','item_text_truncated'].includes(gap));
      }
      const reservation=args.mode==='view'?undefined:historyReadScheduler(this.db).reserve();
      job = {request:{...args,wait_seconds:undefined,delivery_cursor:undefined},scope:this.scope,fingerprint,epoch:base.epoch,revision:base.revision,base,status:args.mode==='view'?'ready':'pending',owner:this.unknown(),prior_refs,prior_gaps,prior_receipts};
      try {this.db.prepare('INSERT INTO context_jobs(id,scope,thread,data) VALUES(?,?,?,?)').run(args.request_id,this.scope,args.thread_id,JSON.stringify(job));}
      catch(error){reservation?.cancel();throw error;}
      if (args.mode === 'view') {
        if(!base.identity){job.reason='no_verified_context';this.saveJob(args.request_id,job);return this.deliver(args,job);}
        const receipt: Receipt = {id:randomUUID(),scope:this.scope,thread:args.thread_id,epoch:base.epoch,revision:base.revision,evidence:[],fragments:[[]],delivered_pages:[],base_refs:base.verified_refs,
          coverage:{fetched_refs:[],delivered_refs:[],processed_refs:[],source_complete:false,public_history_complete:false,public_projection_complete:false,limited:true,delivery_complete:true,continuous:false,gaps:['view_does_not_refresh_source']},basis_valid:true,prior_refs:[],prior_receipts:[],identity:base.identity};
        this.db.transaction(()=>this.insertReceipt(receipt))();
        job.receipt_id=receipt.id; this.saveJob(args.request_id,job);
      } else this.start(args.request_id,job,reservation!,continuation);
    }
    const active = this.running.get(args.request_id);
    if (active && args.wait_seconds) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([active.promise,new Promise<void>(done=>{timer=setTimeout(done,args.wait_seconds!*1000);})]);
      if (timer) clearTimeout(timer);
    }
    return this.deliver(args,this.job(args.request_id)!);
  }
  private start(id: string, job: Job, reservation:ReadReservation, continuation?: ContextReadContinuation) {
    const controller = new AbortController();
    const promise = reservation.run(controller.signal,()=>this.run(id,job,controller,continuation)).catch(()=>{
      if(this.current(job.request.thread_id).epoch===job.epoch&&this.job(id)?.status==='pending'){
        job.status=this.closed?'reconciliation_required':'failed';job.reason=this.closed?'restart_requires_reconciliation':'read_cancelled';this.saveJob(id,job);
      }
    }).finally(()=>this.running.delete(id));
    this.running.set(id,{promise,controller});
  }
  private async run(id: string, job: Job, controller: AbortController, continuation?: ContextReadContinuation) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sourceRead: Promise<ContextReadBatch> | undefined, onAbort: (() => void) | undefined;
    const deadline=this.now()+this.timeoutMs;
    try {
      const input: ContextReadInput={threadId:job.request.thread_id,codexHome:this.home!,signal:controller.signal,deadline,
        ...(job.base.watermark?{previous:job.base.watermark}:{}),...(continuation?{continuation}:{}),
        ...(job.request.mode==='evidence'&&job.request.refs?{turnIds:[...new Set(job.request.refs.map(ref=>ref.split('/')[1]).filter((x):x is string=>!!x))]}:{}),
        ...(job.request.mode==='evidence'&&job.request.refs?.length===1?{evidence:{turnId:job.request.refs[0]!.split('/')[1]!,itemId:job.request.refs[0]!.split('/')[2]!,offset:job.request.evidence_offset}}:{})};
      if(job.request.refs?.some(ref=>ref.split('/')[0]!==job.request.thread_id||ref.split('/').length!==4))fail('source_ref_invalid');
      sourceRead=this.reader(input);
      const work=Promise.all([sourceRead,this.observer ? this.observer({threadId:input.threadId,signal:controller.signal,deadline}).catch(()=>this.unknown()) : Promise.resolve(this.unknown())]);
      const [batch,owner]=await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{reject(new ContextError('read_timeout'));controller.abort();},this.timeoutMs);onAbort=()=>reject(new ContextError('read_cancelled'));controller.signal.addEventListener('abort',onAbort,{once:true});})]);
      if (controller.signal.aborted || this.closed || this.current(job.request.thread_id).epoch!==job.epoch || this.job(id)?.status!=='pending') return;
      const normalized=this.project(batch,job);
      const receipt: Receipt={id:randomUUID(),scope:this.scope,thread:job.request.thread_id,epoch:job.epoch,revision:job.revision,
        evidence:normalized.evidence,fragments:this.pages(normalized.evidence),delivered_pages:[],base_refs:normalized.basis_valid?job.base.verified_refs:[],
        coverage:normalized.coverage,watermark:batch.watermark,identity:batch.sourceIdentity,basis_valid:normalized.basis_valid,prior_refs:job.prior_refs??[],prior_receipts:job.prior_receipts??[]};
      receipt.base_refs=this.validBaseRefs(batch,receipt.base_refs);
      job.owner=owner; job.receipt_id=receipt.id; job.status=normalized.coverage.public_projection_complete&&this.blockingGaps(normalized.coverage.gaps,normalized.coverage.resolved_gaps).length===0?'ready':'partial';
      if (batch.continuation) { job.continuation=batch.continuation; job.continuation_token=randomUUID(); }
      this.db.transaction(()=>{this.insertReceipt(receipt);this.saveJob(id,job);})();
    } catch (error) {
      if (this.current(job.request.thread_id).epoch!==job.epoch || this.job(id)?.status!=='pending') return;
      if(this.closed){job.status='reconciliation_required';job.reason='restart_requires_reconciliation';this.saveJob(id,job);return;}
      job.status=error instanceof ContextError&&error.code==='read_timeout'?'partial':'failed';
      // Never log or persist arbitrary reader errors: they can contain source content.
      job.reason=error instanceof ContextError?error.code:'context_read_failed';this.saveJob(id,job);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) controller.signal.removeEventListener('abort',onAbort);
      // The native reader settles only after child cleanup. Keep its scheduler
      // slot until then, even when the caller's deadline has already expired.
      // Injected test readers may deliberately never settle after cancellation.
      if (this.reader === readContextBatch && sourceRead) await sourceRead.catch(()=>{});
    }
  }
  private project(batch: ContextReadBatch, job: Job): {evidence:ContextEvidence[];coverage:ContextCoverage;basis_valid:boolean} {
    // The adapter's stable item hashes bind every external reference to the observed content version.
    const identity=batch.sourceIdentity;
    if (!identity || identity.threadId!==job.request.thread_id || resolve(identity.codexHome)!==this.home || !/^[a-f0-9]{64}$/.test(identity.identityHash)) fail('source_identity_invalid');
    const pathname=identity.rolloutPath;
    if (pathname!==undefined && (typeof pathname!=='string' || !['sessions','archived_sessions'].some(folder=>{
      const rel=relative(resolve(this.home!,folder),resolve(pathname));return !!rel&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep);
    }))) fail('source_identity_invalid');
    const evidence:ContextEvidence[]=[];
    for (const turn of batch.turns) for (const item of turn.items) {
      const turnId=turn.turnId, itemId=item.id;
      if (!turnId||!itemId) fail('source_item_invalid');
      const text=item.text, ref=`${job.request.thread_id}/${turnId}/${itemId}/${item.fingerprint}`;
      if(item.source_ref!==ref)fail('source_item_invalid');
      evidence.push({ref,text,turn_id:turnId,item_id:itemId,type:item.type,truncated:item.truncated,text_offset:item.textOffset,total_text_length:item.totalTextLength});
    }
    if (evidence.length>8192||JSON.stringify(evidence).length>8*1024*1024) fail('context_batch_too_large');
    const remembered=!batch.invalidated?(job.base.coverage?.gaps??[]).filter(gap=>this.knownExclusion(gap)):[];
    const source_complete=batch.coverage.historyComplete&&batch.coverage.observedStable;
    const projection_complete=(batch.coverage.projectionComplete??batch.coverage.historyComplete)&&batch.coverage.observedStable;
    const currentGapCodes=new Set(batch.gaps.map(gap=>gap.code));
    // A stable finished traversal resolves earlier time/observation failures. Keep
    // any gap still present in this fresh result, and all known unavailable content.
    const priorGaps=(job.prior_gaps??[]).filter(gap=>!(projection_complete&&this.recheckableGap(gap)&&!currentGapCodes.has(gap)));
    const gaps=[...new Set([...remembered,...priorGaps,...currentGapCodes])];
    const basis_valid=!batch.invalidated&&(!job.base.identity||canonical(job.base.identity)===canonical(identity));
    if (!basis_valid) gaps.push('basis_invalidated');
    const resolved_gaps=projection_complete?gaps.filter(gap=>['basis_invalidated','source_identity_changed','history_anchor_missing_or_rollback'].includes(gap)):[];
    return {evidence,basis_valid,coverage:{fetched_refs:evidence.map(item=>item.ref),delivered_refs:[],processed_refs:[],source_complete:false,public_history_complete:source_complete,public_projection_complete:projection_complete,limited:gaps.some(gap=>this.knownExclusion(gap)),delivery_complete:false,continuous:false,gaps,
      resolved_gaps,observed_at:batch.observation.finishedAt,source_watermark:batch.watermark}};
  }
  private knownExclusion(gap:string){return ['history_generation_unavailable','attachment_body_unavailable','compaction_body_unavailable','structured_tool_body_not_projected'].includes(gap);}
  private recheckableGap(gap:string){return ['context_time_budget','context_resource_limit','index_resource_limit','unfinished_turns_outside_index_unknown','pending_turns','batch_limit','item_text_truncated','source_changed_during_read','turn_changed_during_read','turn_changed_between_batches','continuation_turn_changed','observation_boundary_unverified','source_identity_changed_during_read'].includes(gap);}
  private blockingGaps(gaps:string[],resolved:string[]=[]) { return gaps.filter(gap=>!this.knownExclusion(gap)&&!resolved.includes(gap)); }
  private validBaseRefs(batch:ContextReadBatch, refs:string[]):string[] {
    if(batch.invalidated)return [];
    return refs.filter(ref=>{
      const [,turnId,itemId]=ref.split('/'); const turn=batch.turns.find(turn=>turn.turnId===turnId);if(!turn)return true;
      if(turn.itemSetVerified){if(!turn.itemIds.includes(itemId!))return false;const fingerprint=turn.itemFingerprints?.[itemId!];if(fingerprint!==undefined)return ref.split('/')[3]===fingerprint;}
      const item=turn.items.find(item=>item.id===itemId);if(item)return ref===item.source_ref;
      return !turn.replaceItems||turn.itemIds.includes(itemId!);
    });
  }
  private pages(evidence:ContextEvidence[]):ContextEvidence[][] {
    const pages:ContextEvidence[][]=[[]]; let used=0;
    for (const item of evidence) {
      // Split long public items without claiming they were delivered until every fragment was delivered.
      const chars=this.pageChars-2048;
      for(let offset=0;offset<item.text.length||offset===0;offset+=chars) {
        let end=Math.min(offset+chars,item.text.length); if(end<item.text.length&&/[\uD800-\uDBFF]/.test(item.text[end-1]!)) end--;
        const fragment={...item,text:item.text.slice(offset,end),part_offset:offset,part_end:end,total_chars:item.text.length};
        const size=canonical(fragment).length;
        if(used+size>this.pageChars&&pages[pages.length-1]!.length){pages.push([]);used=0;}
        pages[pages.length-1]!.push(fragment);used+=size;
        // Preserve the code point split adjustment when advancing.
        if(end!==Math.min(offset+chars,item.text.length)) offset--;
      }
    }
    return pages;
  }
  private cursor(receipt:Receipt,page:number) { return `${receipt.id}:${page}:${hash(`${this.scope}/${receipt.thread}/${receipt.epoch}/${receipt.id}/${page}`)}`; }
  private deliver(args:ContextGetArgs, job:Job):ContextGetResult {
    const current=this.current(args.thread_id);
    if(job.epoch!==current.epoch||job.status==='forgotten') return {request_id:args.request_id,thread_id:args.thread_id,status:'forgotten',epoch:current.epoch,revision:current.revision,state:null,owner_observation:this.unknown(),reason:'epoch_changed'};
    const result:ContextGetResult={request_id:args.request_id,thread_id:args.thread_id,status:job.status,epoch:job.epoch,revision:job.revision,state:job.base.state,owner_observation:job.owner,...(job.reason?{reason:job.reason}:{})};
    if(!job.receipt_id) {if(args.delivery_cursor)fail('delivery_cursor_invalid');return result;}
    const receipt=this.receipt(job.receipt_id);let page=0;
    if(args.delivery_cursor){page=Number(args.delivery_cursor.split(':')[1]);if(!Number.isInteger(page)||page<0||page>=receipt.fragments.length||args.delivery_cursor!==this.cursor(receipt,page))fail('delivery_cursor_invalid');}
    if(!receipt.delivered_pages.includes(page))receipt.delivered_pages.push(page);
    this.deliveryCoverage(receipt);this.saveReceipt(receipt);
    result.read_receipt_id=receipt.id;
    if(receipt.storage_version===2){
      const row=this.db.prepare('SELECT data FROM context_receipt_pages WHERE receipt_id=? AND page=?').get(receipt.id,page) as {data:string}|undefined;
      if(!row)fail('receipt_unavailable');result.evidence=JSON.parse(row!.data);
    }else result.evidence=receipt.fragments[page];
    result.coverage=receipt.coverage;result.basis_valid=receipt.basis_valid;
    if(!receipt.basis_valid)result.state=null;
    if(page+1<receipt.fragments.length)result.delivery_cursor=this.cursor(receipt,page+1);
    if(job.continuation_token)result.continuation_token=job.continuation_token;
    return result;
  }
  private operation(id:string,thread:string,fingerprint:string):ContextMutationResult|undefined {
    const row=this.db.prepare('SELECT scope,thread,fingerprint,response FROM context_operations WHERE id=?').get(id) as {scope:string;thread:string;fingerprint:string;response:string}|undefined;
    if(!row)return;
    if(row.scope!==this.scope||row.thread!==thread||row.fingerprint!==fingerprint)fail('operation_binding_conflict');
    return JSON.parse(row.response) as ContextMutationResult;
  }
  private saveOperation(id:string,thread:string,fingerprint:string,result:ContextMutationResult){this.db.prepare('INSERT INTO context_operations(id,scope,thread,fingerprint,response) VALUES(?,?,?,?,?)').run(id,this.scope,thread,fingerprint,JSON.stringify(result));}
  update(raw:unknown):ContextMutationResult {
    this.guard();const args=contextUpdateSchema.parse(raw), fingerprint=hash(canonical({kind:'update',args}));
    // Consumer progress belongs to the actual destination thread. derived_from is
    // provenance only; it neither chooses another record nor grants source access.
    if(args.state.consumer_thread_id!==undefined&&args.state.consumer_thread_id!==args.thread_id)fail('consumer_thread_mismatch');
    return this.db.transaction(()=>{
      const repeated=this.operation(args.operation_id,args.thread_id,fingerprint);if(repeated)return repeated;
      const current=this.current(args.thread_id);
      if(current.epoch!==args.expected_epoch||current.revision!==args.expected_revision)fail('context_version_conflict');
      const receipt=this.receipt(args.read_receipt_id);
      if(receipt.scope!==this.scope||receipt.thread!==args.thread_id||receipt.epoch!==current.epoch||receipt.revision!==current.revision)fail('receipt_binding_conflict');
      const allowed=new Set([...receipt.base_refs,...receipt.coverage.delivered_refs]);
      const facts=[...args.state.task,...args.state.requirements,...args.state.completed,...args.state.pending,...args.state.execution,...args.state.gaps];
      if(new Set(facts.map(f=>f.id)).size!==facts.length)fail('duplicate_fact_id');
      const referenced=facts.flatMap(f=>f.source_refs);if(referenced.some(ref=>!allowed.has(ref)))fail('source_ref_not_delivered');
      const processed=[...new Set(args.processed_refs??referenced.filter(ref=>receipt.coverage.fetched_refs.includes(ref)))];
      if(processed.some(ref=>!receipt.coverage.delivered_refs.includes(ref)))fail('processed_ref_not_delivered');
      const coverage={...receipt.coverage,processed_refs:processed};
      const priorProcessed=receipt.prior_receipts.every(id=>{try{return this.receipt(id).processed===true;}catch{return false;}});
      receipt.processed=coverage.delivery_complete&&coverage.fetched_refs.every(ref=>processed.includes(ref));this.saveReceipt(receipt);
      coverage.continuous=coverage.public_projection_complete&&receipt.processed&&priorProcessed&&this.blockingGaps(coverage.gaps,coverage.resolved_gaps).length===0;
      if(coverage.continuous)coverage.processed_watermark=receipt.watermark;
      const verified_refs=[...new Set([...receipt.base_refs,...processed])];
      const next:Current={epoch:current.epoch,revision:current.revision+1,state:args.state,verified_refs,coverage,identity:receipt.identity??current.identity,
        ...(coverage.continuous?{watermark:receipt.watermark}:current.watermark&&receipt.basis_valid?{watermark:current.watermark}:{})};
      this.saveCurrent(args.thread_id,next);
      const result:ContextMutationResult={thread_id:args.thread_id,epoch:next.epoch,revision:next.revision,status:'updated',coverage};
      this.saveOperation(args.operation_id,args.thread_id,fingerprint,result);return result;
    })();
  }
  forget(raw:unknown):ContextMutationResult {
    this.guard();const args=contextForgetSchema.parse(raw),fingerprint=hash(canonical({kind:'forget',args}));
    const result=this.db.transaction(()=>{
      const repeated=this.operation(args.operation_id,args.thread_id,fingerprint);if(repeated)return repeated;
      const current=this.current(args.thread_id);if(current.epoch!==args.expected_epoch||current.revision!==args.expected_revision)fail('context_version_conflict');
      const next:Current={epoch:current.epoch+1,revision:0,state:null,verified_refs:[]};this.saveCurrent(args.thread_id,next);
      if(this.normalizedStorage){
        this.db.prepare('DELETE FROM context_receipt_pages WHERE receipt_id IN (SELECT id FROM context_receipts WHERE scope=? AND thread=?)').run(this.scope,args.thread_id);
        this.db.prepare('DELETE FROM context_receipt_progress WHERE receipt_id IN (SELECT id FROM context_receipts WHERE scope=? AND thread=?)').run(this.scope,args.thread_id);
      }
      this.db.prepare('DELETE FROM context_receipts WHERE scope=? AND thread=?').run(this.scope,args.thread_id);
      this.db.prepare('DELETE FROM context_operations WHERE scope=? AND thread=?').run(this.scope,args.thread_id);
      for(const row of this.db.prepare('SELECT id,data FROM context_jobs WHERE scope=? AND thread=?').all(this.scope,args.thread_id) as {id:string;data:string}[]){
        const job=JSON.parse(row.data) as Job;job.status='forgotten';job.base={epoch:job.epoch,revision:job.revision,state:null,verified_refs:[]};delete job.receipt_id;delete job.continuation;delete job.continuation_token;delete job.request.refs;this.saveJob(row.id,job);
      }
      const response:ContextMutationResult={thread_id:args.thread_id,epoch:next.epoch,revision:0,status:'forgotten'};this.saveOperation(args.operation_id,args.thread_id,fingerprint,response);return response;
    })();
    for(const [id,active] of this.running)if(this.job(id)?.request.thread_id===args.thread_id)active.controller.abort();return result;
  }
  async close():Promise<void> { this.closed=true;for(const active of this.running.values())active.controller.abort();await Promise.allSettled([...this.running.values()].map(active=>active.promise)); }
}





