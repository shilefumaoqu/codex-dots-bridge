import type net from 'node:net';
import { closeSync, fstatSync, lstatSync, openSync, readSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { runDesktopMessageIpc, type DesktopIdleSnapshot } from './desktop-echo-ipc.js';
import { resolveConversationPath } from './desktop-conversation-path.js';
import { readNativeStoredHistory, type NativeReaderTesting, type NativeStoredHistory } from './desktop-conversation-reader.js';

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const MAX_TEXT = 32000, MAX_LINE = 32 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
type Skip = { status: 'skipped_busy' | 'skipped_unknown' | 'skipped_unreachable'; reason: string };
export interface ConversationResolvedTarget { thread_id: string; rollout_path: string }
export interface ConversationTransportInput { threadId: string; rolloutPath?: string; codexHome?: string; onResolvedTarget?: (target: ConversationResolvedTarget) => void; signal: AbortSignal; deadline: number }
export interface ConversationReadInput extends ConversationTransportInput {}
export interface ConversationSendInput extends ConversationTransportInput { requestId: string; text: string; beforeSend: () => void; onAccepted: (turnId: string) => void }
export type ConversationReadResult = { status: 'completed'; title?: string; context_json: string; source_complete: boolean; desktop_state: DesktopIdleSnapshot } | ({ status: 'completed' } & NativeStoredHistory) | Skip;
export type ConversationSendResult = { status: 'completed'; turn_id: string; reply: string } | Skip | { status: 'uncertain'; reason: string };
export interface ConversationTransportTesting { connect: () => net.Socket; pollMs?: number; nativeReader?: NativeReaderTesting }
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
/** Fixed handle bound to the exact native or explicitly configured path. */
class ConversationLog {
  private fd: number; private original: ReturnType<typeof fstatSync>; private offset: number; private maxSize: number; private bytes = Buffer.alloc(0);
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
  close() { closeSync(this.fd); this.bytes = Buffer.alloc(0); }
  async reply(turnId: string, sentAt: number, input: ConversationTransportInput, pollMs: number): Promise<string> {
    while (true) {
      if (input.signal.aborted) throw failure('closed'); if (Date.now() >= input.deadline) throw failure('reply_timeout'); const size = this.validate(); const newline = this.bytes.indexOf(10);
      if (newline >= 0) {
        if (newline > MAX_LINE) throw failure('log_invalid'); const line = this.bytes.subarray(0, newline); this.bytes = this.bytes.subarray(newline + 1); if (!line.length) continue;
        const record = parse(line); if (record.type !== 'event_msg' || record.payload?.turn_id !== turnId) continue; const event = record.payload;
        if (['turn_aborted', 'task_failed'].includes(event.type)) throw failure('reply_failed'); if (event.type !== 'task_complete') continue;
        const start = stamp(event.started_at), complete = stamp(event.completed_at), now = Date.now();
        if (typeof event.last_agent_message !== 'string' || !start || !complete || !Number.isFinite(event.duration_ms) || event.duration_ms < 0 || complete.ms < start.ms || [start, complete].some(time => time.ms < sentAt - time.quantization || time.ms > now + time.quantization)) throw failure('reply_invalid');
        if (event.last_agent_message.length > MAX_TEXT) throw failure('reply_too_large'); return event.last_agent_message;
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
  try {
    check(input); if (!UUID.test(input.requestId) || typeof input.text !== 'string' || !input.text.length || input.text.length > MAX_TEXT) throw failure('invalid_input');
    const ipc = await runDesktopMessageIpc({ ...input, beforeSend: (meta?: { threadId: string; rolloutPath?: string }) => {
      try {
        check(input); const path = resolvedPath(input, meta); log = new ConversationLog(path, input.threadId); sentAt = log.captureEof();
        input.onResolvedTarget?.({ thread_id: input.threadId, rollout_path: path }); input.beforeSend(); check(input); log.validate(); sent = true;
      } catch (error) { preflightError = error; throw error; }
    } }, testing);
    if (ipc.status !== 'accepted') return preflightError ? { status: 'skipped_unknown', reason: reason(preflightError) } : ipc;
    if (!sent || sentAt === undefined) throw failure('reply_invalid');
    try { input.onAccepted(ipc.turnId); } catch { throw failure('acceptance_not_persisted'); }
    const reply = await log!.reply(ipc.turnId, sentAt, input, testing?.pollMs ?? 100);
    return { status: 'completed', turn_id: ipc.turnId, reply };
  } catch (error) { return { status: sent ? 'uncertain' : 'skipped_unknown', reason: reason(error) }; }
  finally { log?.close(); }
}
