import type Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { DESKTOP_IPC_FAILURE_REASONS, echoMarker, runDesktopEchoIpc, type DesktopIpcInput, type DesktopIpcResult } from './desktop-echo-ipc.js';

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/;
export const desktopEchoConfigSchema = z.object({
  enabled: z.literal(true), thread_id: z.string().regex(UUID), request_id: z.string().regex(UUID),
  rollout_path: z.string().refine(value => isAbsolute(value) && !value.includes('\0')),
  expires_at: z.string().regex(ISO).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value.replace(/(?<!\.\d{3})Z$/, '.000Z')),
}).strict();
export type DesktopEchoConfig = z.infer<typeof desktopEchoConfigSchema>;
export type DesktopEchoStatus = 'pending' | 'completed_match' | 'skipped_busy' | 'skipped_unknown' | 'skipped_unreachable' | 'uncertain' | 'reconciliation_required';
export interface DesktopEchoResult {
  request_id: string; status: DesktopEchoStatus; verification: 'not_verified' | 'exact_turn_echo';
  echo?: string; receipt_nonce?: string; reason?: string;
  timing: { started_at: string; finished_at?: string; elapsed_ms?: number };
}
interface Stored { binding: string; sent: boolean; sent_at?: string; turn_id?: string; acknowledged_at?: string; result: DesktopEchoResult }
export class DesktopEchoError extends Error { constructor(public readonly code: string) { super(code); } }
export interface DesktopEchoOptions {
  /** Test injection only. Must settle after signal abort and call beforeSend before transmission. */
  runIpc?: (input: DesktopIpcInput) => Promise<DesktopIpcResult>;
  now?: () => number; timeoutMs?: number; pollMs?: number;
}
const activeDatabases = new WeakSet<Database.Database>();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fail(code: string): never { throw new DesktopEchoError(code); }
function noSymlinks(path: string) {
  let cursor = path;
  while (true) { if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) fail('log_unavailable'); const parent = dirname(cursor); if (parent === cursor) return; cursor = parent; }
}
const MAX_LINE = 32 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
function completionStamp(value: unknown): { ms: number; quantization: number } | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value * 1000;
    if (Number.isFinite(new Date(ms).getTime())) return { ms, quantization: Number.isInteger(value) ? 1000 : 0 };
  }
  if (typeof value === 'string' && ISO.test(value)) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && new Date(ms).toISOString() === value.replace(/(?<!\.\d{3})Z$/, '.000Z')) return { ms, quantization: value.includes('.') ? 0 : 1000 };
  }
}
/** Only session identity at the head is read; completion evidence starts at future EOF. */
class EchoTail {
  readonly fd: number; private original: ReturnType<typeof fstatSync>;
  private offset: number; private maxSize: number; private bytes = Buffer.alloc(0); private closed = false;
  constructor(private path: string, threadId: string) {
    noSymlinks(path); this.fd = openSync(path, 'r'); this.original = fstatSync(this.fd);
    this.offset = this.maxSize = this.original.size;
    try {
      if (!this.original.isFile() || !this.offset) fail('log_unavailable');
      const first = Buffer.alloc(Math.min(65536, this.offset)); const count = readSync(this.fd, first, 0, first.length, 0);
      const newline = first.subarray(0, count).indexOf(10); if (newline < 0) fail('log_binding_invalid');
      let record: any; try { record = JSON.parse(utf8.decode(first.subarray(0, newline))); } catch { fail('log_binding_invalid'); }
      if (record?.type !== 'session_meta' || record.payload?.id !== threadId) fail('log_binding_invalid');
      const tail = Buffer.alloc(1); if (readSync(this.fd, tail, 0, 1, this.offset - 1) !== 1 || tail[0] !== 10) fail('log_eof_invalid');
      this.validate();
    } catch (error) { this.close(); throw error; }
  }
  validate() {
    noSymlinks(this.path); const state = statSync(this.path), opened = fstatSync(this.fd);
    if (state.ino !== this.original.ino || state.dev !== this.original.dev || state.birthtimeMs !== this.original.birthtimeMs || opened.ino !== state.ino || opened.dev !== state.dev) fail('log_changed');
    if (state.size < this.maxSize || opened.size < this.maxSize) fail('log_changed');
    this.maxSize = Math.max(this.maxSize, state.size, opened.size); return opened.size;
  }
  close() { if (!this.closed) { this.closed = true; closeSync(this.fd); this.bytes = Buffer.alloc(0); } }
  async wait(turnId: string, marker: string, sentAt: number, deadline: number, signal: AbortSignal, pollMs: number) {
    while (true) {
      if (signal.aborted) fail('closed'); if (Date.now() >= deadline) fail('echo_timeout');
      const size = this.validate();
      const newline = this.bytes.indexOf(10);
      if (newline >= 0) {
        if (newline > MAX_LINE) fail('log_invalid');
        const line = this.bytes.subarray(0, newline); this.bytes = this.bytes.subarray(newline + 1);
        if (!line.length) continue;
        let record: any; try { record = JSON.parse(utf8.decode(line)); } catch { fail('log_invalid'); }
        if (!record || typeof record !== 'object' || Array.isArray(record)) fail('log_invalid');
        if (record.type !== 'event_msg' || record.payload?.turn_id !== turnId) continue;
        const event = record.payload;
        if (['turn_aborted', 'task_failed'].includes(event.type)) fail('echo_failed');
        if (event.type !== 'task_complete') continue;
        const start = completionStamp(event.started_at), complete = completionStamp(event.completed_at), observedAt = Date.now();
        if (typeof event.last_agent_message !== 'string' || !start || !complete || !Number.isFinite(event.duration_ms) || event.duration_ms < 0) fail('echo_invalid');
        // A newly appended record alone is insufficient: its reported turn must
        // belong to this transmission window. Only second-precision timestamps
        // get a one-second allowance for official log timestamp quantization.
        if (complete.ms < start.ms || [start, complete].some(stamp => stamp.ms < sentAt - stamp.quantization || stamp.ms > observedAt + stamp.quantization)) fail('echo_invalid');
        if (event.last_agent_message !== marker) fail('echo_mismatch');
        return;
      }
      if (this.bytes.length > MAX_LINE) fail('log_invalid');
      if (size > this.offset) {
        const chunk = Buffer.alloc(Math.min(65536, size - this.offset)); const count = readSync(this.fd, chunk, 0, chunk.length, this.offset);
        if (!count) fail('log_unavailable'); this.offset += count; this.bytes = Buffer.concat([this.bytes, chunk.subarray(0, count)]); continue;
      }
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, Math.max(1, Math.min(pollMs, deadline - Date.now()))); signal.addEventListener('abort', done, { once: true });
      });
    }
  }
}
const safeReasons = new Set([...DESKTOP_IPC_FAILURE_REASONS, 'config_expired', 'log_unavailable', 'log_binding_invalid', 'log_eof_invalid', 'log_changed', 'log_invalid', 'echo_timeout', 'echo_failed', 'echo_invalid', 'echo_mismatch', 'closed', 'ipc_unavailable', 'send_outcome_unknown', 'invalid_ipc_result', 'invalid_state_identity', 'unknown_submissions', 'unconfirmed_submission', 'turn_in_progress', 'unknown_turn_history', 'resume_state', 'runtime_not_idle', 'unknown_canonical_history', 'unknown_turn', 'state_changed_after_snapshot', 'unknown_state']);
const sanitizeReason = (value: unknown) => typeof value === 'string' && safeReasons.has(value) ? value : 'operation_failed';

export class DesktopEchoService {
  readonly enabled: boolean; private config?: DesktopEchoConfig; private binding = '';
  private readonly now: () => number; private readonly runIpc: NonNullable<DesktopEchoOptions['runIpc']>;
  private readonly timeoutMs: number; private readonly pollMs: number;
  private controller?: AbortController; private executor?: Promise<void>; private closed = false; private closing?: Promise<void>;
  constructor(private readonly db: Database.Database, config?: unknown, options: DesktopEchoOptions = {}) {
    this.now = options.now ?? Date.now; this.runIpc = options.runIpc ?? runDesktopEchoIpc;
    this.timeoutMs = options.timeoutMs ?? 60000; this.pollMs = options.pollMs ?? 100;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60000 || !Number.isInteger(this.pollMs) || this.pollMs < 1 || this.pollMs > 1000) fail('invalid_options');
    if (config !== undefined) {
      const parsed = desktopEchoConfigSchema.safeParse(config); if (!parsed.success) fail('invalid_config');
      this.config = { ...parsed.data, request_id: parsed.data.request_id.toLowerCase() };
      if (Date.parse(this.config.expires_at) - this.now() > 300000) fail('invalid_config');
      this.binding = hash(JSON.stringify(this.config));
    }
    this.enabled = !!this.config;
    if (activeDatabases.has(db)) fail('desktop_echo_already_open');
    db.exec('CREATE TABLE IF NOT EXISTS desktop_echo_requests (request_id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    // Recovered reservations never cause another connection or transmission.
    db.transaction(() => {
      for (const row of db.prepare('SELECT request_id,data FROM desktop_echo_requests').all() as {request_id: string; data: string}[]) {
        const item = JSON.parse(row.data) as Stored;
        if (item.result.status === 'pending') { item.result.status = 'reconciliation_required'; item.result.reason = 'restart_requires_reconciliation'; item.result.timing.finished_at = new Date(this.now()).toISOString(); this.save(row.request_id, item); }
      }
    })();
    activeDatabases.add(db);
  }
  private save(requestId: string, item: Stored) { this.db.prepare('UPDATE desktop_echo_requests SET data=? WHERE request_id=?').run(JSON.stringify(item), requestId); }
  private identity(input: unknown): string {
    const parsed = z.object({ request_id: z.string().regex(UUID) }).strict().safeParse(input);
    if (!parsed.success) fail('invalid_request'); if (!this.config) fail('desktop_echo_disabled');
    const id = parsed.data.request_id.toLowerCase(); if (id !== this.config.request_id) fail('request_not_configured'); return id;
  }
  private read(id: string): Stored | undefined {
    const row = this.db.prepare('SELECT data FROM desktop_echo_requests WHERE request_id=?').get(id) as { data: string } | undefined;
    if (!row) return; const item = JSON.parse(row.data) as Stored; if (item.binding !== this.binding) fail('request_binding_conflict'); return item;
  }
  private public(item: Stored): DesktopEchoResult {
    const result = item.result;
    return { request_id: result.request_id, status: result.status, verification: result.verification,
      ...(result.status === 'completed_match' ? { echo: result.echo, receipt_nonce: result.receipt_nonce } : {}),
      ...(result.reason ? { reason: result.reason === 'restart_requires_reconciliation' ? result.reason : sanitizeReason(result.reason) } : {}), timing: { ...result.timing } };
  }
  get(input: { request_id: string }): DesktopEchoResult {
    const id = this.identity(input); const item = this.read(id); if (!item) fail('request_not_found'); return this.public(item);
  }
  start(input: { request_id: string }): DesktopEchoResult {
    const id = this.identity(input); const prior = this.read(id); if (prior) return this.public(prior);
    if (this.closed) fail('desktop_echo_closed');
    const started = this.now();
    const item: Stored = { binding: this.binding, sent: false, result: { request_id: id, status: 'pending', verification: 'not_verified', timing: { started_at: new Date(started).toISOString() } } };
    const inserted = this.db.prepare('INSERT OR IGNORE INTO desktop_echo_requests(request_id,data) VALUES(?,?)').run(id, JSON.stringify(item));
    if (!inserted.changes) return this.public(this.read(id)!);
    this.controller = new AbortController();
    // Return the durable reservation before invoking any asynchronous executor.
    this.executor = Promise.resolve().then(() => this.execute(id, item, started, this.controller!.signal)).catch(() => {
      // A failed durable write leaves the reservation in place for reconciliation.
      // Never retry an executor or leak a database/transport error into RPC output.
    });
    return this.public(item);
  }
  private async execute(id: string, item: Stored, started: number, signal: AbortSignal) {
    let reader: EchoTail | undefined, sentAt: number | undefined;
    const config = this.config!; const deadline = Date.now() + this.timeoutMs;
    const timer = setTimeout(() => this.controller?.abort(), this.timeoutMs);
    try {
      if (signal.aborted) fail('closed'); if (Date.parse(config.expires_at) <= this.now()) fail('config_expired');
      reader = new EchoTail(config.rollout_path, config.thread_id);
      const ipc = await this.runIpc({ threadId: config.thread_id, requestId: id, signal, deadline, beforeSend: () => {
        if (signal.aborted || this.closed) fail('closed'); if (Date.parse(config.expires_at) <= this.now()) fail('config_expired'); reader!.validate();
        if (item.sent) fail('invalid_ipc_result'); sentAt = Date.now(); item.sent = true; item.sent_at = new Date(sentAt).toISOString(); this.save(id, item);
      } });
      if (ipc.status !== 'accepted') {
        if (signal.aborted) fail('closed');
        if (!['skipped_busy', 'skipped_unknown', 'skipped_unreachable', 'uncertain'].includes(ipc.status)) fail('invalid_ipc_result');
        item.result.status = item.sent ? 'uncertain' : ipc.status; item.result.reason = sanitizeReason(ipc.reason);
      } else {
        if (!item.sent || sentAt === undefined || !UUID.test(ipc.turnId)) fail('invalid_ipc_result');
        item.turn_id = ipc.turnId; item.acknowledged_at = new Date(this.now()).toISOString(); this.save(id, item);
        if (signal.aborted) fail('closed');
        await reader.wait(ipc.turnId, echoMarker(id), sentAt, deadline, signal, this.pollMs);
        item.result.status = 'completed_match'; item.result.verification = 'exact_turn_echo'; item.result.echo = echoMarker(id); item.result.receipt_nonce = randomBytes(32).toString('hex');
      }
    } catch (error) { item.result.status = item.sent ? 'uncertain' : 'skipped_unknown'; item.result.reason = sanitizeReason((error as { code?: unknown }).code); }
    finally {
      clearTimeout(timer); reader?.close();
      item.result.timing.finished_at = new Date(this.now()).toISOString(); item.result.timing.elapsed_ms = Math.max(0, this.now() - started);
      this.save(id, item);
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.controller?.abort();
    return this.closing = (async () => { try { await this.executor; } finally { activeDatabases.delete(this.db); } })();
  }
}
