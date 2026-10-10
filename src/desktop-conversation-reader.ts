import { spawn, type ChildProcess } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { findCodexCommand } from './maintenance.js';
import { normalizeConversationPath } from './desktop-conversation-path.js';

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const MAX_BYTES = 32 * 1024 * 1024;
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
export interface NativeReadInput { threadId: string; codexHome: string; signal: AbortSignal; deadline: number }
export interface NativeStoredHistory { title?: string; context_json: string; source_complete: false; verification: 'native_stored_history'; history_source: 'codex_app_server'; stored_history_complete: true }
export type ReaderChild = Pick<ChildProcess, 'on' | 'once' | 'removeListener' | 'kill' | 'exitCode' | 'signalCode'> & { stdin: Writable; stdout: Readable };
export interface NativeReaderTesting { command?: string; spawn?: (command: string, args: string[], options: { env: NodeJS.ProcessEnv; windowsHide: boolean; shell: false; stdio: ['pipe', 'pipe', 'ignore'] }) => ReaderChild }

function localPath(value: string): string {
  const path = normalizeConversationPath(value);
  for (let cursor = path;;) {
    if (lstatSync(cursor).isSymbolicLink()) fail('target_path_invalid');
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  const actual = normalizeConversationPath(realpathSync(path));
  if (process.platform === 'win32' ? path.toLowerCase() !== actual.toLowerCase() : path !== actual) fail('target_path_invalid');
  return actual;
}
/** Prefer the desktop's current official CLI, without pinning a personal version directory. */
export function findConversationReaderCommand(): string {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    try {
      const root = localPath(join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin'));
      const dirs = readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory() && !item.isSymbolicLink())
        .map(item => ({ path: join(root, item.name), modified: lstatSync(join(root, item.name)).mtimeMs })).sort((a, b) => b.modified - a.modified);
      for (const directory of dirs) {
        try { const exe = localPath(join(directory.path, 'codex.exe')); if (lstatSync(exe).isFile()) return exe; } catch {}
      }
    } catch {}
  }
  const command = findCodexCommand();
  if (process.platform !== 'win32') return command;
  const path = localPath(command); if (!path.toLowerCase().endsWith('.exe') || !lstatSync(path).isFile()) fail('native_reader_unavailable'); return path;
}

/** Separate read-only app-server session. No owner discovery, resume, turn, or tool execution. */
export async function readNativeStoredHistory(input: NativeReadInput, testing: NativeReaderTesting = {}): Promise<NativeStoredHistory> {
  let terminal: Error | undefined;
  const deadline = Math.min(input.deadline, Date.now() + 60000);
  const check = () => { if (input.signal.aborted) fail('closed'); if (Date.now() >= deadline) fail('timeout'); if (terminal) throw terminal; };
  check(); if (!UUID.test(input.threadId) || !Number.isFinite(input.deadline)) fail('invalid_input');
  const home = localPath(input.codexHome); if (!lstatSync(home).isDirectory()) fail('target_path_invalid');
  const command = testing.command ?? findConversationReaderCommand(); check();
  const options = { env: { ...process.env, CODEX_HOME: home }, windowsHide: true, shell: false as const, stdio: ['pipe', 'pipe', 'ignore'] as ['pipe', 'pipe', 'ignore'] };
  const child: ReaderChild = testing.spawn ? testing.spawn(command, ['app-server', '--stdio'], options) : spawn(command, ['app-server', '--stdio'], options) as ReaderChild;
  let stopped = false, nextId = 0, received = 0, partBytes = 0;
  let parts: Buffer[] = [];
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const terminate = (code: string) => {
    if (terminal) return; terminal = Object.assign(new Error(code), { code });
    for (const request of pending.values()) request.reject(terminal); pending.clear();
  };
  const onError = () => terminate('native_reader_unavailable');
  const onClose = () => { stopped = true; if (!terminal) terminate('native_reader_closed'); };
  const abort = () => terminate('closed');
  const timer = setTimeout(() => terminate('timeout'), Math.max(1, deadline - Date.now()));
  const onData = (chunk: Buffer) => {
    try {
      received += chunk.length; if (received > MAX_BYTES + 1024 * 1024) fail('context_too_large');
      for (let offset = 0; offset < chunk.length;) {
        const end = chunk.indexOf(10, offset), after = end < 0 ? chunk.length : end;
        const part = chunk.subarray(offset, after); parts.push(part); partBytes += part.length;
        if (partBytes > MAX_BYTES) fail('context_too_large');
        if (end < 0) break;
        const bytes = Buffer.concat(parts, partBytes); parts = []; partBytes = 0; offset = end + 1;
        if (!bytes.length) fail('native_reader_protocol_invalid');
        let frame: unknown;
        try { frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('native_reader_protocol_invalid'); }
        if (!object(frame)) return fail('native_reader_protocol_invalid');
        // Notifications are source observations only. Server requests would
        // require a capability this reader never grants and are rejected.
        if (typeof frame.method === 'string') { if (Object.hasOwn(frame, 'id')) fail('native_reader_protocol_invalid'); continue; }
        if (!Number.isInteger(frame.id) || !pending.has(frame.id) || Object.hasOwn(frame, 'result') === Object.hasOwn(frame, 'error')) fail('native_reader_protocol_invalid');
        const request = pending.get(frame.id)!; pending.delete(frame.id);
        if (Object.hasOwn(frame, 'error')) request.reject(Object.assign(new Error('native_reader_request_failed'), { code: 'native_reader_request_failed' }));
        else request.resolve(frame.result);
      }
    } catch (error) { terminate((error as { code?: string }).code ?? 'native_reader_protocol_invalid'); }
  };
  child.stdout.on('data', onData); child.stdout.on('error', onError); child.on('error', onError); child.on('close', onClose); child.stdin.on('error', onError);
  input.signal.addEventListener('abort', abort, { once: true });
  if (input.signal.aborted) abort();
  const request = (method: 'initialize' | 'thread/read' | 'thread/turns/list', params: object) => {
    check(); if (terminal) return Promise.reject(terminal); const id = ++nextId;
    return new Promise<any>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); } catch { terminate('native_reader_unavailable'); }
    });
  };
  try {
    const initialized = await request('initialize', { clientInfo: { name: 'codex-dots-bridge-readonly', version: '1' }, capabilities: { experimentalApi: true } });
    if (!object(initialized)) fail('native_reader_protocol_invalid'); check();
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const metadata = await request('thread/read', { threadId: input.threadId, includeTurns: false }); check();
    if (!object(metadata) || !object(metadata.thread) || metadata.thread.id !== input.threadId || !Array.isArray(metadata.thread.turns) || metadata.thread.turns.length) fail('native_reader_identity_invalid');
    const thread = metadata.thread, turns: Record<string, any>[] = [], cursors = new Set<string>(), ids = new Set<string>();
    let cursor: string | undefined, bytes = Buffer.byteLength(JSON.stringify(thread), 'utf8');
    if (bytes > MAX_BYTES) fail('context_too_large');
    do {
      const page = await request('thread/turns/list', { threadId: input.threadId, itemsView: 'full', sortDirection: 'asc', limit: 20, ...(cursor !== undefined ? { cursor } : {}) }); check();
      if (!object(page) || !Array.isArray(page.data) || !(page.nextCursor === null || typeof page.nextCursor === 'string' && page.nextCursor.length > 0)) fail('native_reader_protocol_invalid');
      for (const turn of page.data) {
        if (!object(turn) || !UUID.test(turn.id ?? '') || ids.has(turn.id) || !Array.isArray(turn.items) || turn.itemsView !== 'full') fail('native_reader_protocol_invalid');
        ids.add(turn.id); bytes += Buffer.byteLength(JSON.stringify(turn), 'utf8'); if (bytes > MAX_BYTES) fail('context_too_large'); turns.push(turn);
      }
      if (page.nextCursor === null) break;
      if (!page.data.length || cursors.has(page.nextCursor) || page.nextCursor.length > 65536) fail('native_reader_protocol_invalid');
      cursor = page.nextCursor; cursors.add(page.nextCursor);
    } while (true);
    const context_json = JSON.stringify({ thread: { ...thread, turns }, turns_source: 'thread/turns/list:full' });
    if (Buffer.byteLength(context_json, 'utf8') > MAX_BYTES) fail('context_too_large'); check();
    return { verification: 'native_stored_history', history_source: 'codex_app_server', stored_history_complete: true, source_complete: false, context_json,
      ...(typeof thread.name === 'string' && thread.name.length > 0 && thread.name.length <= 512 ? { title: thread.name } : {}) };
  } finally {
    clearTimeout(timer); input.signal.removeEventListener('abort', abort); terminate('closed'); parts = []; partBytes = 0;
    child.stdout.removeListener('data', onData);
    const closed = new Promise<void>(resolve => { if (stopped) resolve(); else child.once('close', () => resolve()); });
    child.stdin.destroy(); child.stdout.destroy(); if (!stopped) child.kill();
    let cleanup: NodeJS.Timeout | undefined;
    try { await Promise.race([closed, new Promise<void>(resolve => { cleanup = setTimeout(resolve, 500); })]); } finally { if (cleanup) clearTimeout(cleanup); }
    child.removeListener('error', onError); child.removeListener('close', onClose); child.stdin.removeListener('error', onError); child.stdout.removeListener('error', onError);
    if (!stopped) fail('native_reader_cleanup_failed');
  }
}
