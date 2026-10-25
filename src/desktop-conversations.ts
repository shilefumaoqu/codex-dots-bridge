import type Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { DESKTOP_IPC_DIAGNOSTIC_CODES, DESKTOP_IPC_FAILURE_REASONS, DESKTOP_TIMING_STAGES, type DesktopIpcDiagnostic, type DesktopTimingStage, type DesktopIdleSnapshot, type DesktopBusySnapshot } from './desktop-echo-ipc.js';
import { initDesktopSnapshotStorage, saveDesktopSnapshot, readDesktopSnapshotPage } from './desktop-snapshot-storage.js';
import { historyReadScheduler, type ReadReservation } from './read-scheduler.js';
import { replyBindingSchema, type DesktopReplyBinding, type DesktopReplyInput, type DesktopReplyResult } from './desktop-reply.js';
import { DESKTOP_WARM_LOAD_REASONS } from './desktop-warm-load.js';

const uuid = z.string().uuid();
const targetSchema = z.object({ thread_id: uuid, rollout_path: z.string().refine(path => isAbsolute(path) && !path.includes('\0')), title: z.string().min(1).max(512).optional() }).strict();
const narrowConfigSchema = z.object({ enabled: z.literal(true), targets: z.array(targetSchema).min(1).max(16) }).strict();
const localConfigSchema = z.object({ enabled: z.boolean(), mode: z.literal('local'),
  codex_home: z.string().refine(path => isAbsolute(path) && !path.includes('\0')),
  read: z.boolean(), send: z.boolean(), legacy_targets: z.array(targetSchema).max(16).optional(),
}).strict().refine(value => value.enabled ? value.read || value.send : !value.read && !value.send);
export const desktopConversationsConfigSchema = z.union([narrowConfigSchema, localConfigSchema]);
export type DesktopConversationsConfig = z.infer<typeof desktopConversationsConfigSchema>;
export class DesktopConversationsError extends Error { readonly accepted = false; constructor(public readonly code: string) { super(code); } }
export type DesktopConversationStatus = 'pending' | 'waiting_next_turn' | 'awaiting_delivery_choice' | 'completed' | 'skipped_busy' | 'skipped_unknown' | 'skipped_unreachable' | 'uncertain' | 'reconciliation_required';
export interface DesktopConversationResult {
  request_id: string; operation: 'read' | 'send'; thread_id: string; status: DesktopConversationStatus;
  verification: 'not_verified' | 'native_history_snapshot' | 'native_stored_history' | 'exact_turn_reply';
  title?: string; context_chunk?: string; context_offset?: number; next_offset?: number | null; total_chars?: number; source_complete?: boolean; context_sha256?: string;
  desktop_state?: DesktopIdleSnapshot;
  history_source?: 'codex_app_server'; stored_history_complete?: boolean;
  read_scope?: 'full_stored_history' | 'full_history_snapshot'; continuation_required?: boolean;
  turn_id?: string; reply?: string; receipt_nonce?: string; reason?: string;
  delivery_state?: 'not_sent' | 'outcome_unknown' | 'accepted';
  reply_state?: 'not_expected' | 'pending' | 'available' | 'unavailable';
  watch_state?: 'active' | 'expired' | 'unavailable' | 'completed';
  watch_expires_at?: string;
  busy_state?: DesktopBusySnapshot; delivery_mode?: 'current_turn' | 'next_turn';
  delivery_options?: { mode: 'current_turn' | 'next_turn'; supported: boolean }[];
  timing: { started_at: string; finished_at?: string; elapsed_ms?: number; stages_ms?: Partial<Record<DesktopTimingStage, number>> };
}
export type DesktopConversationSkip = { status: 'skipped_busy' | 'skipped_unknown' | 'skipped_unreachable'; reason: string; busy_state?: DesktopBusySnapshot; busy_owner?: string };
export interface DesktopConversationResolvedTarget { thread_id: string; rollout_path: string }
export interface DesktopConversationReadInput { threadId: string; rolloutPath?: string; codexHome?: string; onResolvedTarget?: (target: DesktopConversationResolvedTarget) => void; signal: AbortSignal; deadline: number }
export interface DesktopConversationSendInput extends DesktopConversationReadInput { requestId: string; text: string; beforeSend: () => void; onAccepted: (turnId: string) => number | void; onStageTiming?: (stage: DesktopTimingStage, elapsedMs: number) => void; onDiagnostic?: (event: DesktopIpcDiagnostic) => void; afterTurn?: { id: string; startedAtMs: number; ownerHash: string }; onWaiting?: () => void; onReplyBinding?: (binding: DesktopReplyBinding) => void }
export interface DesktopConversationsTransport {
  runReply?(input: DesktopReplyInput): Promise<DesktopReplyResult>;
  runRead(input: DesktopConversationReadInput): Promise<{ status: 'completed'; title?: string; context_json: string; source_complete: boolean; desktop_state?: DesktopIdleSnapshot; verification?: 'native_stored_history'; history_source?: 'codex_app_server'; stored_history_complete?: true } | DesktopConversationSkip>;
  runSend(input: DesktopConversationSendInput): Promise<{ status: 'completed'; turn_id: string; reply: string } | DesktopConversationSkip | { status: 'uncertain'; reason: string }>;
}
export interface DesktopConversationsOptions { normalizedStorage?: boolean; transport?: DesktopConversationsTransport; now?: () => number; timeoutMs?: number; readCacheMaxBytes?: number; readCacheIdleMs?: number; onIpcDiagnostic?: (requestId: string, event: DesktopIpcDiagnostic) => void }
/** Internal authenticated-caller trial guard, never supplied through worker tool arguments. */
export type DesktopSendGuard = () => {remaining_ms:number} | undefined;
interface Stored { snapshot_storage_version?: 2; reply_binding?: DesktopReplyBinding; watch?: {state:'active'|'expired'|'unavailable'|'completed';expires_at:number;next_at:number}; binding: string; fingerprint: string; scope?: { mode: 'local'; codex_home: string }; resolved_target?: DesktopConversationResolvedTarget; sent: boolean; sent_at?: string; accepted_turn_id?: string; accepted_at?: string; context_json?: string; delivery_mode?: 'next_turn'; busy_owner?: string; result: DesktopConversationResult }
const activeDatabases = new WeakSet<Database.Database>();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fail(code: string): never { throw new DesktopConversationsError(code); }
const readSchema = z.object({ request_id: uuid, thread_id: uuid }).strict();
const sendSchema = z.object({ request_id: uuid, thread_id: uuid, text: z.string().min(1).max(8000), delivery_mode: z.enum(['current_turn', 'next_turn']).optional() }).strict();
const MAX_CONTEXT_BYTES = 32 * 1024 * 1024, PAGE_CHARS = 32000;
const READ_CACHE_MAX_BYTES = 128 * 1024 * 1024, READ_CACHE_IDLE_MS = 10 * 60 * 1000;
// Estimate retained UTF-16 strings, including metadata and keys. This is a
// cache budget, not a hard limit on total JavaScript/SQLite process memory.
function stringBytes(value: unknown): number {
  if (typeof value === 'string') return value.length * 2;
  if (!value || typeof value !== 'object') return 0;
  return Object.entries(value).reduce((bytes, [key, entry]) => bytes + key.length * 2 + stringBytes(entry), 0);
}
const getSchema = z.object({ request_id: uuid, wait_seconds: z.number().min(0).max(20).optional(), offset: z.number().int().min(0).max(MAX_CONTEXT_BYTES).optional() }).strict();
const desktopIdleSnapshotSchema = z.object({
  status: z.literal('idle'),
  observed_at: z.string().datetime({ precision: 3 }).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value),
  checked_by: z.literal('native_desktop_owner'), scope: z.literal('observation_snapshot'),
}).strict();
const desktopBusySnapshotSchema = z.object({ status: z.literal('busy'), observed_at: z.string().datetime({ precision: 3 }), checked_by: z.literal('native_desktop_owner'), scope: z.literal('observation_snapshot'), active_turn_id: uuid.optional(), active_turn_started_at_ms: z.number().finite().nonnegative().optional() }).strict().refine(value => (value.active_turn_id === undefined) === (value.active_turn_started_at_ms === undefined));
const legacyReadResultSchema = z.object({ status: z.literal('completed'), title: z.string().max(512).optional(), context_json: z.string(), source_complete: z.boolean(), desktop_state: desktopIdleSnapshotSchema.optional() }).strict();
const storedReadResultSchema = z.object({ status: z.literal('completed'), title: z.string().max(512).optional(), context_json: z.string(), source_complete: z.literal(false), verification: z.literal('native_stored_history'), history_source: z.literal('codex_app_server'), stored_history_complete: z.literal(true) }).strict();
const readResultSchema = z.union([legacyReadResultSchema, storedReadResultSchema]);
const sendResultSchema = z.object({ status: z.literal('completed'), turn_id: uuid, reply: z.string().max(32000) }).strict();
const replyResultSchema = z.union([sendResultSchema, z.object({status:z.literal('pending'),next_offset:z.number().int().nonnegative()}).strict(), z.object({status:z.literal('unavailable'),reason:z.string()}).strict()]);
const ipcDiagnosticSchema = z.object({ phase: z.enum([...DESKTOP_IPC_FAILURE_REASONS, 'send_ack']), diagnostic_code: z.enum(DESKTOP_IPC_DIAGNOSTIC_CODES), received_frames: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), state_frames: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), matched_state_frames: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), largest_frame_bytes: z.number().int().nonnegative().max(0xffffffff) }).strict();
const safeReasons = new Set([...DESKTOP_IPC_FAILURE_REASONS, 'native_reader_unavailable', 'official_read_requires_local_mode', 'native_reader_closed', 'native_reader_protocol_invalid', 'native_reader_identity_invalid', 'native_reader_request_failed', 'native_reader_cleanup_failed', 'operation_failed', 'thread_send_in_progress', 'restart_requires_reconciliation', 'closed', 'timeout', 'ipc_unavailable', 'send_outcome_unknown', 'native_path_missing', 'target_path_invalid', 'log_unavailable', 'log_binding_invalid', 'log_eof_invalid', 'log_changed', 'log_invalid', 'log_line_too_large', 'echo_timeout', 'echo_failed', 'reply_timeout', 'reply_failed', 'reply_invalid', 'reply_too_large', 'context_too_large', 'context_invalid', 'invalid_transport_result', 'invalid_state_identity', 'unknown_submissions', 'unconfirmed_submission', 'turn_in_progress', 'unknown_turn_history', 'resume_state', 'runtime_not_idle', 'unknown_canonical_history', 'unknown_turn', 'state_changed_after_snapshot', 'unknown_state']);
for (const reason of ['awaiting_reply','reply_watch_expired','reply_recovery_unavailable']) safeReasons.add(reason);
for (const reason of DESKTOP_WARM_LOAD_REASONS) safeReasons.add(reason);
for (const reason of ['next_turn_changed', 'next_turn_owner_changed', 'next_turn_identity_unavailable', 'current_turn_delivery_unsupported', 'waiting_for_current_turn', 'next_turn_wait_expired']) safeReasons.add(reason);
for (const reason of ['delivery_window_expired', 'delivery_window_interrupted', 'delivery_window_input_mismatch', 'delivery_task_not_running', 'delivery_input_not_acknowledged', 'delivery_attempt_changed']) safeReasons.add(reason);
const safeReason = (value: unknown) => typeof value === 'string' && safeReasons.has(value) ? value : 'operation_failed';

/** Explicit local capabilities or legacy allowlist; requests stay bound once reserved. */
export class DesktopConversationsService {
  readonly enabled: boolean; readonly readEnabled: boolean; readonly sendEnabled: boolean;
  private readonly targets = new Map<string, z.infer<typeof targetSchema>>();
  private readonly legacyTargets = new Map<string, z.infer<typeof targetSchema>>();
  private readonly localConfig?: z.infer<typeof localConfigSchema>;
  private readonly normalizedStorage: boolean;
  private readonly now: () => number; private readonly timeoutMs: number; private readonly injectedTransport?: DesktopConversationsTransport;
  private readonly onIpcDiagnostic?: DesktopConversationsOptions['onIpcDiagnostic'];
  private transport?: Promise<DesktopConversationsTransport>;
  private readonly readCache = new Map<string, { item: Stored; bytes: number; usedAt: number }>();
  private readonly readCacheMaxBytes: number; private readonly readCacheIdleMs: number;
  private readCacheBytes = 0; private readCacheTimer?: NodeJS.Timeout;
  private readonly inflight = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private readonly watchTimers = new Map<string, NodeJS.Timeout>();
  private readonly sending = new Map<string,string>(); private closed = false; private closing?: Promise<void>;
  get accessStatus(): { enabled: boolean; mode: 'local' | 'targets' | 'disabled'; read: boolean; send: boolean; target_count?: number } {
    return { enabled: this.enabled, mode: !this.enabled ? 'disabled' : this.localConfig ? 'local' : 'targets', read: this.readEnabled, send: this.sendEnabled, ...(!this.localConfig && this.enabled ? { target_count: this.targets.size } : {}) };
  }
  constructor(private readonly db: Database.Database, config?: unknown, options: DesktopConversationsOptions = {}) {
    this.normalizedStorage = options.normalizedStorage ?? false;
    this.now = options.now ?? Date.now; this.timeoutMs = options.timeoutMs ?? 60000; this.injectedTransport = options.transport;
    this.onIpcDiagnostic = options.onIpcDiagnostic;
    this.readCacheMaxBytes = options.readCacheMaxBytes ?? READ_CACHE_MAX_BYTES; this.readCacheIdleMs = options.readCacheIdleMs ?? READ_CACHE_IDLE_MS;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60000) fail('invalid_options');
    if (!Number.isSafeInteger(this.readCacheMaxBytes) || this.readCacheMaxBytes < 0 || !Number.isSafeInteger(this.readCacheIdleMs) || this.readCacheIdleMs < 1 || this.readCacheIdleMs > READ_CACHE_IDLE_MS) fail('invalid_options');
    if (config !== undefined) {
      const parsed = desktopConversationsConfigSchema.safeParse(config); if (!parsed.success) fail('invalid_config');
      const data = parsed.data, local = 'mode' in data;
      if (local) this.localConfig = { ...data, codex_home: resolve(data.codex_home) };
      const map = local ? this.legacyTargets : this.targets;
      for (const target of local ? data.legacy_targets ?? [] : data.targets) { const id = target.thread_id.toLowerCase(); if (map.has(id)) fail('invalid_config'); map.set(id, { ...target, thread_id: id }); }
    }
    this.enabled = this.localConfig ? this.localConfig.enabled : this.targets.size > 0;
    this.readEnabled = this.enabled && (this.localConfig?.read ?? true); this.sendEnabled = this.enabled && (this.localConfig?.send ?? true);
    if (activeDatabases.has(db)) fail('desktop_conversations_already_open');
    db.exec('CREATE TABLE IF NOT EXISTS desktop_conversation_requests (request_id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    if (this.normalizedStorage) initDesktopSnapshotStorage(db);
    const resume: string[] = [];
    db.transaction(() => {
      for (const row of db.prepare('SELECT request_id,data FROM desktop_conversation_requests').all() as {request_id: string; data: string}[]) {
        const item = JSON.parse(row.data) as Stored;
        if (item.result.status === 'awaiting_delivery_choice' && (!item.result.busy_state?.active_turn_id || item.result.busy_state.active_turn_started_at_ms === undefined || !item.busy_owner)) {
          item.result.status = 'skipped_busy'; item.result.reason = 'next_turn_identity_unavailable'; this.save(row.request_id,item);
        }
        if (this.sendEnabled && item.watch?.state === 'active' && this.canRecover(item)) {
          try {
            this.validateBinding(item);
            item.result.status = 'pending'; item.result.reason = 'awaiting_reply';
            if (item.watch.expires_at <= this.now()) { item.watch.state = 'expired'; item.result.status = 'uncertain'; item.result.reason = 'reply_watch_expired'; }
            else { resume.push(row.request_id); this.sending.set(item.result.thread_id,row.request_id); }
            this.save(row.request_id,item); continue;
          } catch { /* A changed capability/binding never resumes old source reads. */ }
        }
        if (item.result.status === 'pending' || item.result.status === 'waiting_next_turn') {
          item.result.status = 'reconciliation_required'; item.result.reason = 'restart_requires_reconciliation';
          if (item.watch) item.watch.state = 'unavailable';
          item.result.timing.finished_at = new Date(this.now()).toISOString(); this.save(row.request_id, item);
        }
      }
    })();
    activeDatabases.add(db);
    for (const id of resume) this.scheduleWatch(id,0);
  }
  private target(id: string) { if (!this.enabled) fail('desktop_conversations_disabled'); const target = this.targets.get(id); if (!target) fail('thread_not_allowed'); return target; }
  private binding(target: z.infer<typeof targetSchema>) { return hash(JSON.stringify({ thread_id: target.thread_id, rollout_path: target.rollout_path })); }
  private localBinding(item: Stored) { return hash(JSON.stringify({ scope: item.scope, thread_id: item.result.thread_id, resolved_target: item.resolved_target ?? null })); }
  private validLocalTarget(target: DesktopConversationResolvedTarget, threadId: string): boolean {
    if (!this.localConfig || target.thread_id !== threadId || !uuid.safeParse(target.thread_id).success || typeof target.rollout_path !== 'string' || !isAbsolute(target.rollout_path) || target.rollout_path.includes('\0')) return false;
    return ['sessions', 'archived_sessions'].some(folder => {
      const subpath = relative(resolve(this.localConfig!.codex_home, folder), target.rollout_path);
      return !!subpath && !isAbsolute(subpath) && subpath !== '..' && !subpath.startsWith('..' + sep);
    });
  }
  private load(id: string): Stored | undefined {
    this.expireReads();
    const cached = this.readCache.get(id);
    if (cached) {
      this.validateBinding(cached.item);
      this.readCache.delete(id); cached.usedAt = this.now(); this.readCache.set(id, cached);
      return cached.item;
    }
    const row = this.db.prepare('SELECT data FROM desktop_conversation_requests WHERE request_id=?').get(id) as {data: string} | undefined;
    if (!row) return; const item = JSON.parse(row.data) as Stored;
    this.validateBinding(item); this.cacheRead(id, item); return item;
  }
  private validateBinding(item: Stored): void {
    if (item.scope !== undefined) {
      if (!this.localConfig || item.scope.mode !== 'local' || item.scope.codex_home !== this.localConfig.codex_home || (item.resolved_target !== undefined && !this.validLocalTarget(item.resolved_target, item.result.thread_id)) || item.binding !== this.localBinding(item)) fail('request_binding_conflict');
    } else {
      const target = this.localConfig ? this.legacyTargets.get(item.result.thread_id) : this.target(item.result.thread_id);
      if (!target || item.binding !== this.binding(target)) fail('request_binding_conflict');
    }
  }
  private save(id: string, item: Stored) {
    if (this.db.prepare('UPDATE desktop_conversation_requests SET data=? WHERE request_id=?').run(JSON.stringify(item), id).changes !== 1) fail('operation_failed');
  }
  private removeRead(id: string): void {
    const entry = this.readCache.get(id); if (entry) { this.readCacheBytes -= entry.bytes; this.readCache.delete(id); }
  }
  private expireReads(): void {
    const now = this.now();
    for (const [id, entry] of this.readCache) { if (now - entry.usedAt < this.readCacheIdleMs) break; this.removeRead(id); }
  }
  private scheduleReadExpiry(): void {
    if (this.readCacheTimer || this.closed || !this.readCache.size) return;
    const oldest = this.readCache.values().next().value!;
    this.readCacheTimer = setTimeout(() => {
      this.readCacheTimer = undefined; this.expireReads(); this.scheduleReadExpiry();
    }, Math.max(1, Math.min(this.readCacheIdleMs, oldest.usedAt + this.readCacheIdleMs - this.now())));
    this.readCacheTimer.unref();
  }
  private cacheRead(id: string, item: Stored): void {
    if (this.closed || item.result.status !== 'completed' || item.result.operation !== 'read' || typeof item.context_json !== 'string') return;
    const bytes = stringBytes(item); if (bytes > this.readCacheMaxBytes) return;
    this.expireReads(); this.removeRead(id);
    while (this.readCacheBytes + bytes > this.readCacheMaxBytes) this.removeRead(this.readCache.keys().next().value!);
    // Completed rows are immutable within this service. Never share a mutable
    // execution object before the final SQLite save has succeeded.
    Object.freeze(item.scope); Object.freeze(item.resolved_target);
    Object.freeze(item.result.desktop_state); Object.freeze(item.result.timing); Object.freeze(item.result); Object.freeze(item);
    this.readCache.set(id, { item, bytes, usedAt: this.now() }); this.readCacheBytes += bytes; this.scheduleReadExpiry();
  }
  private public(item: Stored, offset?: number): DesktopConversationResult {
    const value = item.result;
    let page: Partial<DesktopConversationResult> = {};
    if (value.status === 'completed' && value.operation === 'read') {
      let content: {context_chunk:string;context_offset:number;next_offset:number|null;total_chars:number};
      if (item.snapshot_storage_version === 2) {
        try { content = readDesktopSnapshotPage(this.db,value.request_id,offset ?? 0); }
        catch (error) { fail((error as {code?:string})?.code ?? 'context_invalid'); }
      } else {
        const context = item.context_json; if (typeof context !== 'string') fail('context_invalid');
        const start = offset ?? 0; if (start > context.length) fail('invalid_offset');
        const splitsPair = (at: number) => at > 0 && at < context.length && /[\uD800-\uDBFF]/.test(context[at - 1]!) && /[\uDC00-\uDFFF]/.test(context[at]!);
        if (splitsPair(start)) fail('invalid_offset');
        let end = Math.min(context.length, start + PAGE_CHARS); if (splitsPair(end)) end--;
        content = {context_chunk:context.slice(start,end),context_offset:start,next_offset:end<context.length?end:null,total_chars:context.length};
      }
      page = { ...(value.title !== undefined ? { title: value.title } : {}), ...(value.desktop_state !== undefined ? { desktop_state: { ...value.desktop_state } } : {}), ...(value.history_source !== undefined ? { history_source: value.history_source, stored_history_complete: value.stored_history_complete } : {}), ...content, read_scope: value.verification === 'native_stored_history' ? 'full_stored_history' : 'full_history_snapshot', continuation_required: content.next_offset !== null, source_complete: value.source_complete, context_sha256: value.context_sha256, receipt_nonce: value.receipt_nonce };
    } else if (offset !== undefined) fail('offset_not_available');
    return { request_id: value.request_id, operation: value.operation, thread_id: value.thread_id, status: value.status, verification: value.verification,
      timing: { started_at: value.timing.started_at, ...(value.timing.finished_at ? { finished_at: value.timing.finished_at } : {}), ...(value.timing.elapsed_ms !== undefined ? { elapsed_ms: value.timing.elapsed_ms } : {}), ...(value.timing.stages_ms ? { stages_ms: Object.fromEntries(DESKTOP_TIMING_STAGES.filter(stage => Number.isFinite(value.timing.stages_ms?.[stage]) && value.timing.stages_ms![stage]! >= 0).map(stage => [stage, value.timing.stages_ms![stage]!])) } : {}) },
      ...(value.reason ? { reason: safeReason(value.reason) } : {}),
      ...(value.busy_state && (value.status === 'awaiting_delivery_choice' || value.status === 'waiting_next_turn') ? { busy_state: { ...value.busy_state } } : {}),
      ...(value.delivery_mode ? { delivery_mode: value.delivery_mode } : {}),
      ...(value.status === 'awaiting_delivery_choice' ? { delivery_options: [{ mode: 'current_turn' as const, supported: false }, { mode: 'next_turn' as const, supported: !!value.busy_state?.active_turn_id && !!item.busy_owner }] } : {}),
      ...page,
      ...(value.operation === 'send' ? {
        delivery_state: item.accepted_turn_id ? 'accepted' as const : item.sent ? 'outcome_unknown' as const : 'not_sent' as const,
        reply_state: value.status === 'completed' ? 'available' as const : item.watch?.state === 'active' ? 'pending' as const : item.accepted_turn_id ? 'unavailable' as const : 'not_expected' as const,
        ...(item.accepted_turn_id ? {turn_id:item.accepted_turn_id} : {}),
        ...(item.watch ? {watch_state:item.watch.state,watch_expires_at:new Date(item.watch.expires_at).toISOString()} : {}),
      } : {}),
      ...(value.status === 'completed' && value.operation === 'send' ? { turn_id: value.turn_id, reply: value.reply, receipt_nonce: value.receipt_nonce } : {}),
    };
  }
  private getTransport(): Promise<DesktopConversationsTransport> {
    if (this.injectedTransport) return Promise.resolve(this.injectedTransport);
    if (!this.transport) this.transport = (async () => { const modulePath = './desktop-conversations-transport.js'; const module = await import(modulePath); if (typeof module.runRead !== 'function' || typeof module.runSend !== 'function') fail('transport_unavailable'); return { runRead: module.runRead, runSend: module.runSend, runReply: module.runReply }; })();
    return this.transport;
  }
  read(input: { request_id: string; thread_id: string }): DesktopConversationResult {
    const parsed = readSchema.safeParse(input); if (!parsed.success) fail('invalid_request');
    const id = parsed.data.request_id.toLowerCase(), threadId = parsed.data.thread_id.toLowerCase();
    return this.start(id, threadId, 'read', {});
  }
  send(input: { request_id: string; thread_id: string; text: string; delivery_mode?: 'current_turn' | 'next_turn' }, guard?:DesktopSendGuard): DesktopConversationResult {
    const parsed = sendSchema.safeParse(input); if (!parsed.success) fail('invalid_request');
    return this.start(parsed.data.request_id.toLowerCase(), parsed.data.thread_id.toLowerCase(), 'send', { text: parsed.data.text }, parsed.data.delivery_mode, guard);
  }
  private start(id: string, threadId: string, operation: 'read' | 'send', payload: { text?: string }, deliveryMode?: 'current_turn' | 'next_turn', guard?:DesktopSendGuard): DesktopConversationResult {
    if (!this.enabled) fail('desktop_conversations_disabled');
    if (operation === 'read' ? !this.readEnabled : !this.sendEnabled) fail(operation === 'read' ? 'desktop_conversations_read_disabled' : 'desktop_conversations_send_disabled');
    const fingerprint = hash(JSON.stringify({ operation, thread_id: threadId, ...payload }));
    const previous = this.load(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail('idempotency_conflict');
      if (previous.delivery_mode && deliveryMode && previous.delivery_mode !== deliveryMode) fail('delivery_choice_conflict');
      if (!deliveryMode || previous.result.status !== 'awaiting_delivery_choice' || previous.sent || this.inflight.has(id)) return this.public(previous);
      guard?.();
      if (this.closed) fail('desktop_conversations_closed');
      if (deliveryMode === 'current_turn') { previous.result.reason = 'current_turn_delivery_unsupported'; this.save(id, previous); return this.public(previous); }
      const busy = previous.result.busy_state;
      if (!busy?.active_turn_id || busy.active_turn_started_at_ms === undefined || !previous.busy_owner) { previous.result.status = 'skipped_busy'; previous.result.reason = 'next_turn_identity_unavailable'; this.save(id, previous); return this.public(previous); }
      if (this.sending.has(threadId)) return this.public(previous);
      const started = this.now(); previous.delivery_mode = 'next_turn'; previous.result.delivery_mode = 'next_turn';
      previous.result.status = 'pending'; delete previous.result.reason; previous.result.timing = { started_at: new Date(started).toISOString() };
      this.save(id, previous);
      return this.launch(id, previous, this.localConfig ? undefined : this.target(threadId), payload, started, guard);
    }
    if (deliveryMode) fail('delivery_choice_required');
    if (this.closed) fail('desktop_conversations_closed');
    if (operation === 'send') { guard?.(); if (this.sending.has(threadId)) fail('thread_send_in_progress'); }
    const target = this.localConfig ? undefined : this.target(threadId);
    const started = this.now(); const item: Stored = { binding: target ? this.binding(target) : '', fingerprint, sent: false, ...(this.localConfig ? { scope: { mode: 'local' as const, codex_home: this.localConfig.codex_home } } : {}), result: { request_id: id, thread_id: threadId, operation, status: 'pending', verification: 'not_verified', timing: { started_at: new Date(started).toISOString() } } };
    if (item.scope) item.binding = this.localBinding(item);
    const reservation = operation === 'read' ? historyReadScheduler(this.db).reserve() : undefined;
    try {
      const inserted = this.db.prepare('INSERT OR IGNORE INTO desktop_conversation_requests(request_id,data) VALUES(?,?)').run(id, JSON.stringify(item));
      if (!inserted.changes) { reservation?.cancel(); const original = this.load(id)!; if (original.fingerprint !== fingerprint) fail('idempotency_conflict'); return this.public(original); }
      return this.launch(id, item, target, payload, started, guard, reservation);
    } catch (error) { reservation?.cancel(); throw error; }
  }
  private launch(id: string, item: Stored, target: z.infer<typeof targetSchema> | undefined, payload: { text?: string }, started: number, guard?:DesktopSendGuard, reservation?: ReadReservation): DesktopConversationResult {
    const operation = item.result.operation, threadId = item.result.thread_id;
    if (operation === 'send') this.sending.set(threadId,id);
    const controller = new AbortController();
    const execute = () => this.execute(id, item, target, payload, started, controller.signal, guard);
    const promise = Promise.resolve().then(() => reservation ? reservation.run(controller.signal,execute) : execute()).catch(() => {
      // A failed database write leaves the durable pending reservation. No
      // in-memory completion is returned, and no retry can send it again.
    }).finally(() => {
      this.inflight.delete(id);
      if (operation === 'send') {
        // Schedule only after the matching ACK and binding have actually survived storage.
        let durable: Stored | undefined; try { durable = this.load(id); } catch {}
        if (durable?.watch?.state === 'active' && this.canRecover(durable)) this.scheduleWatch(id,0);
        else this.releaseSending(threadId,id);
      }
    });
    this.inflight.set(id, { controller, promise }); return this.public(item);
  }
  private async execute(id: string, item: Stored, target: z.infer<typeof targetSchema> | undefined, payload: { text?: string }, started: number, signal: AbortSignal, guard?:DesktopSendGuard) {
    let timedOut = false, windowLimited = false, timer:NodeJS.Timeout|undefined, guardFailure:unknown, deadline = 0;
    const beginPhase = (budget?: number): number => {
      if (signal.aborted || this.closed) fail('closed');
      if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0)) fail('delivery_window_expired');
      windowLimited = budget !== undefined && budget <= this.timeoutMs;
      const timeoutMs = Math.min(this.timeoutMs, budget ?? this.timeoutMs);
      if (timer) clearTimeout(timer);
      deadline = Date.now() + timeoutMs;
      timer = setTimeout(() => { if (signal.aborted) return; timedOut = true; this.inflight.get(id)?.controller.abort(); }, timeoutMs);
      return deadline;
    };
    const onResolvedTarget = item.scope ? (resolved: DesktopConversationResolvedTarget) => {
      if (signal.aborted || this.closed) fail('closed');
      const parsed = targetSchema.omit({ title: true }).safeParse(resolved);
      if (!parsed.success || !this.validLocalTarget(parsed.data, item.result.thread_id)) fail('invalid_transport_result');
      if (item.resolved_target) { if (JSON.stringify(item.resolved_target) !== JSON.stringify(parsed.data)) fail('invalid_transport_result'); return; }
      if (item.sent) fail('invalid_transport_result');
      item.resolved_target = parsed.data; item.binding = this.localBinding(item); this.save(id, item);
    } : undefined;
    try {
      const budget = item.result.operation === 'send' ? guard?.()?.remaining_ms : undefined;
      beginPhase(budget);
      const transportInput: DesktopConversationReadInput = { threadId: item.result.thread_id, ...(target ? { rolloutPath: target.rollout_path } : { codexHome: item.scope!.codex_home, onResolvedTarget }), signal, deadline };
      if (signal.aborted) fail('closed'); const transport = await this.getTransport(); if (signal.aborted) fail('closed');
      if (item.result.operation === 'read') {
        const output = await transport.runRead(transportInput);
        if (signal.aborted) fail('closed');
        if (output.status === 'completed') {
          const parsed = readResultSchema.safeParse(output); if (!parsed.success) fail('invalid_transport_result');
          const data = parsed.data;
          const stored = 'verification' in data;
          if (stored ? !item.scope : item.scope && !item.resolved_target) fail('invalid_transport_result');
          if (Buffer.byteLength(data.context_json, 'utf8') > MAX_CONTEXT_BYTES) fail('context_too_large');
          // SQLite stores UTF-8; reject lone UTF-16 surrogates rather than let
          // encoding replace them and change the persisted native snapshot.
          if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(data.context_json)) fail('context_invalid');
          try {
            const context = JSON.parse(data.context_json); if (!context || typeof context !== 'object' || Array.isArray(context)) fail('context_invalid');
            if (stored && (!context.thread || typeof context.thread !== 'object' || Array.isArray(context.thread) || context.thread.id !== item.result.thread_id || !Array.isArray(context.thread.turns) || context.turns_source !== 'thread/turns/list:full')) fail('context_invalid');
          } catch { fail('context_invalid'); }
          item.context_json = data.context_json;
          item.result.status = 'completed'; item.result.verification = stored ? data.verification : 'native_history_snapshot'; item.result.source_complete = data.source_complete; item.result.context_sha256 = hash(data.context_json);
          if (stored) { item.result.history_source = data.history_source; item.result.stored_history_complete = data.stored_history_complete; }
          else if (data.desktop_state !== undefined) item.result.desktop_state = data.desktop_state;
          const title = data.title ?? target?.title; if (title !== undefined) item.result.title = title;
          item.result.receipt_nonce = randomBytes(32).toString('hex');
        } else this.skip(item, output);
      } else {
        const output = await transport.runSend({ ...transportInput, requestId: id, text: payload.text!,
          onReplyBinding: binding => {
            if (signal.aborted || this.closed || item.sent) fail('closed');
            const parsed = replyBindingSchema.safeParse(binding);
            const expectedPath = item.resolved_target?.rollout_path ?? target?.rollout_path;
            if (!parsed.success || parsed.data.thread_id !== item.result.thread_id || parsed.data.path !== expectedPath) fail('invalid_transport_result');
            item.reply_binding = parsed.data; this.save(id,item);
          },
          onDiagnostic: event => {
            try {
              const parsed = ipcDiagnosticSchema.safeParse({phase:event.phase,diagnostic_code:event.diagnostic_code,received_frames:event.received_frames,state_frames:event.state_frames,matched_state_frames:event.matched_state_frames,largest_frame_bytes:event.largest_frame_bytes});
              if (parsed.success) this.onIpcDiagnostic?.(id, parsed.data);
            } catch { /* Advisory diagnostics cannot change a send or its reply. */ }
          },
          onStageTiming: (stage, elapsedMs) => {
            if (!DESKTOP_TIMING_STAGES.includes(stage) || !Number.isFinite(elapsedMs) || elapsedMs < 0) return;
            const stages = item.result.timing.stages_ms ??= {};
            stages[stage] = (stages[stage] ?? 0) + elapsedMs;
          },
          ...(item.delivery_mode === 'next_turn' ? { afterTurn: { id: item.result.busy_state!.active_turn_id!, startedAtMs: item.result.busy_state!.active_turn_started_at_ms!, ownerHash: item.busy_owner! }, onWaiting: () => {
            if (signal.aborted || this.closed || item.sent) fail('closed');
            if (item.result.status !== 'waiting_next_turn') { item.result.status = 'waiting_next_turn'; item.result.reason = 'waiting_for_current_turn'; this.save(id, item); }
          } } : {}),
          beforeSend: () => { if (signal.aborted || this.closed) fail('closed'); try {guard?.();} catch(error) {guardFailure=error;throw error;} if (item.sent || (item.scope && !item.resolved_target)) fail('invalid_transport_result'); item.sent = true; item.sent_at = new Date(this.now()).toISOString(); item.result.status = 'pending'; delete item.result.reason; this.save(id, item); },
          onAccepted: turnId => {
            const preSendDeadline = deadline;
            if (signal.aborted || this.closed || Date.now() >= preSendDeadline) fail('closed');
            if (!item.sent || !uuid.safeParse(turnId).success || item.accepted_turn_id !== undefined) fail('invalid_transport_result');
            const acceptedAt = this.now();
            item.accepted_turn_id = turnId; item.accepted_at = new Date(acceptedAt).toISOString();
            if (item.reply_binding) item.watch = {state:'active',expires_at:acceptedAt+86_400_000,next_at:acceptedAt};
            this.save(id, item);
            // Durable matching ACK is the only boundary that opens reply time.
            // The caller's original delivery window continues to cap both phases.
            try {
              const budget = guard?.()?.remaining_ms;
              // Synchronous persistence or guard work can cross the deadline
              // before Node can run the old timer. Keep the ACK evidence, but
              // never clear that expired phase to grant new reply time.
              if (Date.now() >= preSendDeadline) { timedOut = true; fail('timeout'); }
              return beginPhase(budget);
            } catch (error) { guardFailure = error; throw error; }
          },
        });
        // IPC transports sanitize callback failures. Preserve our known local
        // guard refusal so it cannot masquerade as a native/log failure.
        if (guardFailure) throw guardFailure;
        if (signal.aborted) fail('closed');
        if (output.status === 'completed') {
          if (typeof output.reply === 'string' && output.reply.length > 32000) fail('reply_too_large');
          const parsed = sendResultSchema.safeParse(output); if (!parsed.success || !item.sent || !item.accepted_turn_id || parsed.data.turn_id !== item.accepted_turn_id) fail('invalid_transport_result');
          item.result.status = 'completed'; delete item.result.reason; item.result.verification = 'exact_turn_reply'; item.result.turn_id = parsed.data.turn_id; item.result.reply = parsed.data.reply; item.result.receipt_nonce = randomBytes(32).toString('hex');
          if (item.watch) item.watch.state = 'completed';
        } else this.skip(item, output);
      }
    } catch (error) { item.result.status = item.sent ? 'uncertain' : 'skipped_unknown'; item.result.reason = safeReason(timedOut && windowLimited ? 'delivery_window_expired' : timedOut ? item.delivery_mode === 'next_turn' && !item.sent ? 'next_turn_wait_expired' : item.result.operation === 'read' ? 'timeout' : (error as {code?: unknown}).code : (error as {code?: unknown}).code); }
    finally {
      if(timer)clearTimeout(timer);
      if (item.watch?.state === 'active' && this.canRecover(item) && item.result.status !== 'completed') {
        if (['reply_failed','reply_invalid','reply_too_large','log_changed','log_binding_invalid'].includes(item.result.reason ?? '')) item.watch.state = 'unavailable';
        else { item.result.status = 'pending'; item.result.reason = 'awaiting_reply'; }
      }
      if (item.watch?.state === 'active') delete item.result.timing.finished_at;
      else item.result.timing.finished_at = new Date(this.now()).toISOString();
      item.result.timing.elapsed_ms = Math.max(0, this.now() - started);
      this.db.transaction(() => {
        if (this.normalizedStorage && item.result.operation === 'read' && item.result.status === 'completed' && typeof item.context_json === 'string') {
          saveDesktopSnapshot(this.db,id,item.context_json); delete item.context_json; item.snapshot_storage_version = 2;
        }
        this.save(id,item);
      })();
      this.cacheRead(id, item);
    }
  }
  private skip(item: Stored, output: unknown) {
    const parsed = z.object({ status: z.enum(['skipped_busy', 'skipped_unknown', 'skipped_unreachable', 'uncertain']), reason: z.string(), busy_state: desktopBusySnapshotSchema.optional(), busy_owner: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict().safeParse(output);
    if (!parsed.success || (item.result.operation === 'read' && parsed.data.status === 'uncertain')) fail('invalid_transport_result');
    item.result.status = item.sent ? 'uncertain' : parsed.data.status; item.result.reason = safeReason(parsed.data.reason);
    if (item.result.operation === 'send' && item.scope && !item.sent && parsed.data.status === 'skipped_busy' && parsed.data.busy_state?.active_turn_id && parsed.data.busy_state.active_turn_started_at_ms !== undefined && parsed.data.busy_owner) { item.result.status = 'awaiting_delivery_choice'; if (parsed.data.busy_state) item.result.busy_state = parsed.data.busy_state; if (parsed.data.busy_owner) item.busy_owner = parsed.data.busy_owner; }
  }
  private canRecover(item: Stored): boolean {
    const binding = replyBindingSchema.safeParse(item.reply_binding);
    const expectedPath = item.resolved_target?.rollout_path ?? this.targets.get(item.result.thread_id)?.rollout_path ?? this.legacyTargets.get(item.result.thread_id)?.rollout_path;
    return item.result.operation === 'send' && item.sent && uuid.safeParse(item.accepted_turn_id).success
      && Number.isFinite(Date.parse(item.accepted_at ?? '')) && !!binding.success
      && (!item.watch || Number.isFinite(item.watch.expires_at) && item.watch.expires_at <= Date.parse(item.accepted_at!) + 86_400_000)
      && binding.data.thread_id === item.result.thread_id && binding.data.path === expectedPath;
  }
  private scheduleWatch(id: string, delay: number): void {
    if (this.closed || this.watchTimers.has(id)) return;
    const timer = setTimeout(() => { this.watchTimers.delete(id); this.startWatch(id); },delay);
    timer.unref(); this.watchTimers.set(id,timer);
  }
  private startWatch(id: string, onDemand = false): void {
    if (this.closed || !this.sendEnabled || this.inflight.has(id)) return;
    let item: Stored | undefined;
    try { item = this.load(id); } catch { return; }
    if (!item || !this.canRecover(item) || !item.watch || !['active',...(onDemand ? ['expired'] : [])].includes(item.watch.state)) return;
    const controller = new AbortController();
    const promise = this.pollReply(id,item,controller.signal,onDemand).catch(() => {
      // Durable state remains authoritative after storage failures; never send here.
    }).finally(() => this.inflight.delete(id));
    this.inflight.set(id,{controller,promise});
  }
  private async pollReply(id: string, item: Stored, signal: AbortSignal, onDemand: boolean) {
    const watch = item.watch!;
    if (!onDemand && this.now() >= watch.expires_at) {
      watch.state = 'expired'; item.result.status = 'uncertain'; item.result.reason = 'reply_watch_expired';
      this.save(id,item); this.releaseSending(item.result.thread_id,id); return;
    }
    let output: DesktopReplyResult;
    try {
      const transport = await this.getTransport();
      if (!transport.runReply) output = {status:'unavailable',reason:'reply_recovery_unavailable'};
      else {
        const budget = onDemand ? 5000 : Math.max(1,Math.min(5000,watch.expires_at-this.now()));
        const result = await transport.runReply({binding:item.reply_binding!,turnId:item.accepted_turn_id!,signal,deadline:Date.now()+budget});
        const parsed = replyResultSchema.safeParse(result);
        output = parsed.success ? parsed.data : {status:'unavailable',reason:'invalid_transport_result'};
      }
    } catch (error) { output = {status:'unavailable',reason:safeReason((error as {code?:unknown})?.code)}; }
    if (signal.aborted || this.closed) return;
    if (!onDemand && this.now() >= watch.expires_at && output.status !== 'completed') {
      watch.state = 'expired'; item.result.status = 'uncertain'; item.result.reason = 'reply_watch_expired';
      this.save(id,item); this.releaseSending(item.result.thread_id,id); return;
    }
    if (output.status === 'completed') {
      const parsed = sendResultSchema.safeParse(output);
      if (!parsed.success || parsed.data.turn_id !== item.accepted_turn_id) { this.stopWatch(id,item,'invalid_transport_result'); return; }
      watch.state = 'completed'; item.result.status = 'completed'; item.result.verification = 'exact_turn_reply';
      item.result.turn_id = parsed.data.turn_id; item.result.reply = parsed.data.reply; item.result.receipt_nonce = randomBytes(32).toString('hex'); delete item.result.reason;
    } else if (output.status === 'pending') {
      if (!Number.isSafeInteger(output.next_offset) || output.next_offset < item.reply_binding!.offset) { this.stopWatch(id,item,'invalid_transport_result'); return; }
      item.reply_binding!.offset = output.next_offset;
      if (!onDemand) {
        const age = this.now() - Date.parse(item.accepted_at!);
        const delay = age < 60000 ? 1000 : age < 600000 ? 5000 : 30000;
        watch.next_at = Math.min(watch.expires_at,this.now()+delay);
        this.save(id,item); this.scheduleWatch(id,Math.max(1,watch.next_at-this.now())); return;
      }
    } else {
      watch.state = 'unavailable'; item.result.status = 'uncertain'; item.result.reason = safeReason(output.reason);
    }
    item.result.timing.finished_at = new Date(this.now()).toISOString();
    item.result.timing.elapsed_ms = Math.max(0,this.now()-Date.parse(item.result.timing.started_at));
    this.save(id,item); this.releaseSending(item.result.thread_id,id);
  }
  private releaseSending(threadId: string, id: string): void {
    if (this.sending.get(threadId) === id) this.sending.delete(threadId);
  }
  private stopWatch(id: string, item: Stored, reason: string): void {
    item.watch!.state = 'unavailable'; item.result.status = 'uncertain'; item.result.reason = reason;
    this.save(id,item); this.releaseSending(item.result.thread_id,id);
  }
  async get(input: { request_id: string; wait_seconds?: number; offset?: number }): Promise<DesktopConversationResult> {
    const parsed = getSchema.safeParse(input); if (!parsed.success) fail('invalid_request'); if (!this.enabled) fail('desktop_conversations_disabled');
    const id = parsed.data.request_id.toLowerCase(); const item = this.load(id); if (!item) fail('request_not_found');
    if (this.sendEnabled && this.canRecover(item) && !this.inflight.has(id)) {
      if(item.watch?.state === 'expired') this.startWatch(id,true);
      else if(item.watch?.state === 'active' && !this.watchTimers.has(id)) this.startWatch(id);
    }
    const wait = parsed.data.wait_seconds ?? 0, active = this.inflight.get(id);
    if (wait > 0 && (item.result.status === 'pending' || item.result.status === 'waiting_next_turn' || item.watch?.state === 'expired') && active) {
      let timer: NodeJS.Timeout | undefined;
      try { await Promise.race([active.promise, new Promise<void>(resolve => { timer = setTimeout(resolve, wait * 1000); })]); } finally { if (timer) clearTimeout(timer); }
      const current = this.load(id); if (!current) fail('request_not_found');
      return this.public(current, parsed.data.offset);
    }
    return this.public(item, parsed.data.offset);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; for (const timer of this.watchTimers.values()) clearTimeout(timer); this.watchTimers.clear();
    for (const active of this.inflight.values()) active.controller.abort();
    if (this.readCacheTimer) clearTimeout(this.readCacheTimer); this.readCacheTimer = undefined; this.readCache.clear(); this.readCacheBytes = 0;
    return this.closing = (async () => { try { await Promise.allSettled([...this.inflight.values()].map(active => active.promise)); } finally { activeDatabases.delete(this.db); } })();
  }
}
