import type net from 'node:net';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { replyBindingSchema, type DesktopReplyBinding, type DesktopReplyInput, type DesktopReplyResult } from './desktop-reply.js';
import { closeSync, fstatSync, lstatSync, openSync, readSync, statSync, type Stats } from 'node:fs';
import { dirname } from 'node:path';
import { runDesktopMessageIpc, type DesktopIpcDiagnostic, type DesktopTimingStage, type DesktopIdleSnapshot, type DesktopBusySnapshot } from './desktop-echo-ipc.js';
import { resolveConversationPath } from './desktop-conversation-path.js';
import { readNativeStoredHistory, type NativeReaderTesting, type NativeStoredHistory } from './desktop-conversation-reader.js';
import { warmLoadDesktopThread, type DesktopWarmLoadInput, type DesktopWarmLoadResult } from './desktop-warm-load.js';

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const MAX_TEXT = 32000, MAX_LINE = 32 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
type Skip = { status: 'skipped_busy' | 'skipped_unknown' | 'skipped_unreachable'; reason: string; busy_state?: DesktopBusySnapshot; busy_owner?: string };
export interface ConversationResolvedTarget { thread_id: string; rollout_path: string }
export interface ConversationTransportInput { threadId: string; rolloutPath?: string; codexHome?: string; onResolvedTarget?: (target: ConversationResolvedTarget) => void; signal: AbortSignal; deadline: number }
export interface ConversationReadInput extends ConversationTransportInput {}
export interface ConversationSendInput extends ConversationTransportInput { requestId: string; text: string; beforeSend: () => void; onAccepted: (turnId: string) => number | void; onStageTiming?: (stage: DesktopTimingStage, elapsedMs: number) => void; onDiagnostic?: (event: DesktopIpcDiagnostic) => void; afterTurn?: { id: string; startedAtMs: number; ownerHash: string }; onWaiting?: () => void; onReplyBinding?: (binding: DesktopReplyBinding) => void }
export type ConversationReadResult = { status: 'completed'; title?: string; context_json: string; source_complete: boolean; desktop_state: DesktopIdleSnapshot } | ({ status: 'completed' } & NativeStoredHistory) | Skip;
export type ConversationSendResult = { status: 'completed'; turn_id: string; reply: string } | Skip | { status: 'uncertain'; reason: string };
export interface ConversationTransportTesting { connect: () => net.Socket; pollMs?: number; nativeReader?: NativeReaderTesting; warmLoad?: (input: DesktopWarmLoadInput) => Promise<DesktopWarmLoadResult> }
const failure = (code: string) => Object.assign(new Error(code), { code });
const codes = new Set(['invalid_input', 'closed', 'timeout', 'log_unavailable', 'log_binding_invalid', 'log_eof_invalid', 'log_changed', 'log_invalid', 'reply_timeout', 'reply_failed', 'reply_invalid', 'reply_too_large', 'acceptance_not_persisted', 'context_too_large', 'native_path_missing', 'target_path_invalid', 'native_reader_unavailable', 'native_reader_closed', 'native_reader_protocol_invalid', 'native_reader_identity_invalid', 'native_reader_request_failed', 'native_reader_cleanup_failed']);
const reason = (error: unknown) => codes.has((error as { code?: string })?.code ?? '') ? (error as { code: string }).code : 'log_unavailable';
function check(input: ConversationTransportInput) {
  if (!UUID.test(input.threadId) || !Number.isFinite(input.deadline)) throw failure('invalid_input');
  if (input.signal.aborted || Date.now() >= input.deadline) throw failure('closed');
}
function resolvedPath(input: ConversationTransportInput, meta?: { threadId: string; rolloutPath?: string }): string {
  if (input.rolloutPath !== undefined && input.codexHome !== undefined) throw failure('invalid_input');
  if (input.codexHome !== undefined) {
    if (meta?.threadId !== input.threadId) throw failure('log_binding_invalid');
    if (typeof meta.rolloutPath !== 'string' || !meta.rolloutPath) throw failure('native_path_missing');
    return resolveConversationPath(meta.rolloutPath, input.codexHome);
  }
  if (typeof input.rolloutPath !== 'string') throw failure('invalid_input');
  return resolveConversationPath(input.rolloutPath);
}
function noSymlinks(path: string) {
  for (let cursor = path;;) { if (lstatSync(cursor).isSymbolicLink()) throw failure('log_unavailable'); const parent = dirname(cursor); if (parent === cursor) break; cursor = parent; }
}
function stamp(value: unknown): { ms: number; quantization: number } | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && Number.isFinite(new Date(value * 1000).getTime())) return { ms: value * 1000, quantization: Number.isInteger(value) ? 1000 : 0 };
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) return;
  const ms = Date.parse(value); if (Number.isFinite(ms) && new Date(ms).toISOString() === value.replace(/(?<!\.\d{3})Z$/, '.000Z')) return { ms, quantization: value.includes('.') ? 0 : 1000 };
}
function parse(line: Buffer): any {
  try { const item = JSON.parse(utf8.decode(line)); if (item && typeof item === 'object' && !Array.isArray(item)) return item; } catch {}
  throw failure('log_invalid');
}

function matchedReply(record: any, turnId: string, sentAt: number): string | undefined {
  if (record.type !== 'event_msg' || record.payload?.turn_id !== turnId) return;
  const event = record.payload;
  if (['turn_aborted', 'task_failed'].includes(event.type)) throw failure('reply_failed');
  if (event.type !== 'task_complete') return;
  const start = stamp(event.started_at), complete = stamp(event.completed_at), now = Date.now();
  if (typeof event.last_agent_message !== 'string' || !start || !complete || !Number.isFinite(event.duration_ms) || event.duration_ms < 0 || complete.ms < start.ms || [start, complete].some(time => time.ms < sentAt - time.quantization || time.ms > now + time.quantization)) throw failure('reply_invalid');
  if (event.last_agent_message.length > MAX_TEXT) throw failure('reply_too_large');
  return event.last_agent_message;
}

/** One bounded read-only pass. This function has no IPC, navigation or send capability. */
export async function runReply(input: DesktopReplyInput): Promise<DesktopReplyResult> {
  let fd: number | undefined;
  try {
    const binding = replyBindingSchema.parse(input.binding);
    if (!UUID.test(input.turnId) || !Number.isFinite(input.deadline)) throw failure('invalid_input');
    const checkBudget = () => { if (input.signal.aborted || Date.now() >= input.deadline) throw failure('closed'); };
    checkBudget();
    noSymlinks(binding.path); fd = openSync(binding.path, 'r');
    const validate = () => {
      noSymlinks(binding.path);
      const path = statSync(binding.path), opened = fstatSync(fd!);
      for (const state of [path, opened]) if (!state.isFile() || state.dev !== binding.device || state.ino !== binding.inode || state.birthtimeMs !== binding.birthtime_ms || state.size < binding.offset) throw failure('log_changed');
      return opened.size;
    };
    const size = validate();
    const first = Buffer.alloc(Math.min(65536, size));
    const n = readSync(fd, first, 0, first.length, 0), newline = first.subarray(0,n).indexOf(10);
    if (newline < 0) throw failure('log_binding_invalid');
    const meta = parse(first.subarray(0,newline));
    if (meta.type !== 'session_meta' || meta.payload?.id !== binding.thread_id || binding.offset < newline + 1) throw failure('log_binding_invalid');
    const tail = Buffer.alloc(1);
    if (readSync(fd, tail, 0, 1, binding.offset - 1) !== 1 || tail[0] !== 10) throw failure('log_eof_invalid');
    let offset = binding.offset, committed = offset, parts: Buffer[] = [], bytes = 0, chunks = 0;
    while (offset < size) {
      checkBudget();
      if (offset - binding.offset >= 8 * 1024 * 1024 && !bytes) break;
      const chunk = Buffer.alloc(Math.min(65536, size - offset));
      const count = readSync(fd, chunk, 0, chunk.length, offset);
      if (!count) throw failure('log_unavailable');
      for (let at = 0; at < count;) {
        const end = chunk.subarray(0,count).indexOf(10,at), after = end < 0 ? count : end;
        const part = chunk.subarray(at,after); parts.push(part); bytes += part.length;
        if (bytes > MAX_LINE) throw failure('log_invalid');
        if (end < 0) break;
        const line = Buffer.concat(parts,bytes); parts = []; bytes = 0;
        committed = offset + end + 1;
        if (line.length) {
          const reply = matchedReply(parse(line),input.turnId,binding.sent_at_ms);
          if (reply !== undefined) { validate(); checkBudget(); return {status:'completed',turn_id:input.turnId,reply}; }
        }
        at = end + 1;
      }
      offset += count;
      if (++chunks % 16 === 0) await yieldImmediate();
    }
    validate(); checkBudget();
    return {status:'pending',next_offset:committed};
  } catch (error) { return {status:'unavailable',reason:reason(error)}; }
  finally { if (fd !== undefined) closeSync(fd); }
}
/** Fixed handle bound to the exact native or explicitly configured path. */
class ConversationLog {
  private fd: number; private original: Stats; private offset: number; private maxSize: number; private bytes = Buffer.alloc(0);
  constructor(private path: string, threadId: string) {
    noSymlinks(path); this.fd = openSync(path, 'r'); this.original = fstatSync(this.fd); this.offset = this.maxSize = this.original.size;
    try {
      if (!this.original.isFile() || !this.offset) throw failure('log_unavailable');
      const first = Buffer.alloc(Math.min(65536, this.offset)); const count = readSync(this.fd, first, 0, first.length, 0); const newline = first.subarray(0, count).indexOf(10);
      if (newline < 0) throw failure('log_binding_invalid'); const meta = parse(first.subarray(0, newline));
      if (meta.type !== 'session_meta' || meta.payload?.id !== threadId) throw failure('log_binding_invalid');
      this.captureEof();
    } catch (error) { closeSync(this.fd); throw error; }
  }
  validate() {
    noSymlinks(this.path); const state = statSync(this.path), opened = fstatSync(this.fd);
    if (state.dev !== this.original.dev || state.ino !== this.original.ino || state.birthtimeMs !== this.original.birthtimeMs || opened.dev !== state.dev || opened.ino !== state.ino || state.size < this.maxSize || opened.size < this.maxSize) throw failure('log_changed');
    this.maxSize = Math.max(this.maxSize, state.size, opened.size); return opened.size;
  }
  captureEof() {
    const size = this.validate(), tail = Buffer.alloc(1);
    if (!size || readSync(this.fd, tail, 0, 1, size - 1) !== 1 || tail[0] !== 10) throw failure('log_eof_invalid');
    this.offset = size; this.bytes = Buffer.alloc(0); return Date.now();
  }
  binding(threadId: string, sentAt: number): DesktopReplyBinding {
    return {version:1,path:this.path,thread_id:threadId,device:this.original.dev,inode:this.original.ino,birthtime_ms:this.original.birthtimeMs,offset:this.offset,sent_at_ms:sentAt};
  }
  close() { closeSync(this.fd); this.bytes = Buffer.alloc(0); }
  async reply(turnId: string, sentAt: number, input: ConversationTransportInput, pollMs: number): Promise<string> {
    while (true) {
      if (input.signal.aborted) throw failure('closed'); if (Date.now() >= input.deadline) throw failure('reply_timeout'); const size = this.validate(); const newline = this.bytes.indexOf(10);
      if (newline >= 0) {
        if (newline > MAX_LINE) throw failure('log_invalid'); const line = this.bytes.subarray(0, newline); this.bytes = this.bytes.subarray(newline + 1); if (!line.length) continue;
        const reply = matchedReply(parse(line), turnId, sentAt);
        if (reply !== undefined) return reply;
      }
      if (this.bytes.length > MAX_LINE) throw failure('log_invalid');
      if (size > this.offset) { const chunk = Buffer.alloc(Math.min(65536, size - this.offset)); const n = readSync(this.fd, chunk, 0, chunk.length, this.offset); if (!n) throw failure('log_unavailable'); this.offset += n; this.bytes = Buffer.concat([this.bytes, chunk.subarray(0, n)]); continue; }
      await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); input.signal.removeEventListener('abort', done); resolve(); }; const timer = setTimeout(done, Math.max(1, Math.min(pollMs, input.deadline - Date.now()))); input.signal.addEventListener('abort', done, { once: true }); });
    }
  }
}
/** Historical reads have one source: the official local App Server. */
export async function runRead(input: ConversationReadInput, testing?: ConversationTransportTesting): Promise<ConversationReadResult> {
  try {
    check(input);
    // Legacy target records remain retrievable; new reads require the explicit
    // local-home configuration rather than a private desktop history fallback.
    if (input.codexHome === undefined) return { status: 'skipped_unknown', reason: 'official_read_requires_local_mode' };
    if (input.rolloutPath !== undefined) throw failure('invalid_input');
    const result = await readNativeStoredHistory({ ...input, codexHome: input.codexHome }, testing?.nativeReader); check(input);
    return { status: 'completed', ...result };
  } catch (error) { return { status: 'skipped_unknown', reason: reason(error) }; }
}
export async function runSend(input: ConversationSendInput, testing?: ConversationTransportTesting): Promise<ConversationSendResult> {
  let log: ConversationLog | undefined, sentAt: number | undefined, sent = false, preflightError: unknown;
  const measure = async <T>(stage: DesktopTimingStage, action: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    try { return await action(); } finally { input.onStageTiming?.(stage, Math.max(0, performance.now() - started)); }
  };
  try {
    check(input); if (!UUID.test(input.requestId) || typeof input.text !== 'string' || !input.text.length || input.text.length > MAX_TEXT) throw failure('invalid_input');
    const sendOnce = () => runDesktopMessageIpc({ ...input, beforeSend: (meta?: { threadId: string; rolloutPath?: string }) => {
      try {
        check(input); const path = resolvedPath(input, meta); log = new ConversationLog(path, input.threadId); sentAt = log.captureEof();
        input.onResolvedTarget?.({ thread_id: input.threadId, rollout_path: path });
        input.onReplyBinding?.(log.binding(input.threadId, sentAt)); input.beforeSend(); check(input); log.validate(); sent = true;
      } catch (error) { preflightError = error; throw error; }
    } }, testing);
    // Only definitive owner absence before any chat write enables one warm load.
    // Never retry an uncertain message or replace the original desktop executor.
    let ipc = await sendOnce();
    if (ipc.status === 'skipped_unknown' && ipc.reason === 'native_owner_unavailable' && !input.afterTurn && !sent && !preflightError && input.codexHome !== undefined && (!testing || testing.warmLoad)) {
      check(input);
      const loaded = await measure('autoload', () => (testing?.warmLoad ?? warmLoadDesktopThread)(input));
      if (loaded.status !== 'accepted') return loaded;
      check(input); ipc = await sendOnce();
      // Discovery snapshots its candidate clients once. A thread that becomes
      // owned during that request needs a new discovery, not another navigation.
      while (ipc.status === 'skipped_unknown' && ipc.reason === 'native_owner_unavailable' && !sent && !preflightError) {
        await measure('owner_lookup', () => new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); input.signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, Math.max(1, Math.min(250, input.deadline - Date.now())));
          input.signal.addEventListener('abort', done, { once: true });
          if (input.signal.aborted) done();
        }));
        if (input.signal.aborted) throw failure('closed');
        if (Date.now() >= input.deadline) return { status: 'skipped_unknown', reason: 'native_owner_unavailable_after_load' };
        check(input); ipc = await sendOnce();
      }
    }
    while (ipc.status === 'skipped_busy' && input.afterTurn && !sent && !preflightError) {
      if (ipc.busy_state?.active_turn_id !== input.afterTurn.id || ipc.busy_state?.active_turn_started_at_ms !== input.afterTurn.startedAtMs) return { status: 'skipped_unknown', reason: 'next_turn_changed' };
      input.onWaiting?.();
      await measure('busy_wait', () => new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); input.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, Math.max(1, Math.min(testing?.pollMs ?? 500, input.deadline - Date.now())));
        input.signal.addEventListener('abort', done, { once: true });
        if (input.signal.aborted) done();
      }));
      check(input); ipc = await sendOnce();
      // A disconnected/lost owner terminates waiting; never navigate/replay it.
    }
    if (ipc.status !== 'accepted') return preflightError ? { status: 'skipped_unknown', reason: reason(preflightError) } : ipc;
    if (!sent || sentAt === undefined) throw failure('reply_invalid');
    let replyDeadline: number | void;
    try { replyDeadline = input.onAccepted(ipc.turnId); } catch { throw failure('acceptance_not_persisted'); }
    if (replyDeadline !== undefined && !Number.isFinite(replyDeadline)) throw failure('acceptance_not_persisted');
    // Void callbacks retain the old transport contract. Service callbacks only
    // return a fresh deadline after the validated ACK has been saved.
    const replyInput = replyDeadline === undefined ? input : { ...input, deadline: replyDeadline };
    const reply = await measure('reply_wait', () => log!.reply(ipc.turnId, sentAt!, replyInput, testing?.pollMs ?? 1000));
    return { status: 'completed', turn_id: ipc.turnId, reply };
  } catch (error) { return { status: sent ? 'uncertain' : 'skipped_unknown', reason: reason(error) }; }
  finally { log?.close(); }
}
