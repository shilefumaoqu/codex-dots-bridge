import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type net from 'node:net';
import Database from 'better-sqlite3';
import { runRead, runSend } from '../src/desktop-conversations-transport.js';
import { DesktopConversationsService } from '../src/desktop-conversations.js';
import { readerFixture } from './desktop-conversation-reader-fixture.js';
import { fixedEchoPrompt, runDesktopEchoIpc } from '../src/desktop-echo-ipc.js';

const encode = (value: object) => { const body = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4); header.writeUInt32LE(body.length); return Buffer.concat([header, body]); };
class Socket extends EventEmitter {
  destroyed = false; closed = false; frames: any[] = [];
  constructor(private responder: (message: any, socket: Socket) => void) { super(); queueMicrotask(() => this.emit('connect')); }
  write(bytes: Buffer) { const frame = JSON.parse(bytes.subarray(4).toString('utf8')); this.frames.push(frame); queueMicrotask(() => { if (!this.destroyed) this.responder(frame, this); }); return true; }
  receive(...frames: object[]) { this.emit('data', Buffer.concat(frames.map(encode))); }
  destroy() { if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => { this.closed = true; this.emit('close'); }); } return this; }
}
type Mode = 'idle' | 'busy' | 'unknown' | 'changed' | 'wrong_owner' | 'offline' | 'ack_loss';
async function fixture(action: (f: ReturnType<typeof setup>) => Promise<void>, mode: Mode = 'idle') {
  const f = setup(mode); try { await action(f); } finally { f.controller.abort(); rmSync(f.root, { recursive: true, force: true }); }
}
function setup(mode: Mode) {
  const root = mkdtempSync(join(tmpdir(), 'desktop-conversation-test-')), threadId = randomUUID(), requestId = randomUUID(), turnId = randomUUID();
  const rolloutPath = join(root, 'rollout.jsonl'); const append = (record: object) => appendFileSync(rolloutPath, JSON.stringify(record) + '\n');
  append({ type: 'session_meta', payload: { id: threadId } }); const controller = new AbortController();
  mkdirSync(join(root, 'sessions')); mkdirSync(join(root, 'archived_sessions'));
  const nativePath = join(root, 'sessions', `${threadId}.jsonl`); writeFileSync(nativePath, JSON.stringify({ type: 'session_meta', payload: { id: threadId } }) + '\n');
  let before = 0, accepted: string | undefined, onStart: (() => void) | undefined, snapshotPath: string | undefined = nativePath, secondSnapshotPath: string | undefined;
  const firstId = randomUUID(), tailId = randomUUID(), firstKey = 'turn:' + firstId, tailKey = 'tail:0:local:' + randomUUID();
  const page = () => ({ olderCursor: null, isLoadingOlder: false, hasLoadedOldest: true });
  const history: any = {
    historyMode: 'paginated', turns: [], turnsPagination: { ...page(), oldestLoadedTurnId: firstId }, boundedCloudHistory: false, canonicalVoiceHistory: false,
    paginatedHistory: { itemsBackwardsCursor: 'opaque-native-cursor' },
    turnHistory: { kind: 'canonical', history: { generation: 1, isComplete: true, entitiesByKey: {
      [firstKey]: { turnId: firstId, status: 'completed', params: { input: [{ type: 'text', text: '原始上下文' }] }, itemsPagination: page(), items: [
        { type: 'userMessage', content: [{ type: 'text', text: '# AGENTS.md instructions\n<environment_context>上下文</environment_context>' }] },
        { type: 'reasoning', summary: ['原生思维条目'] }, { type: 'agentMessage', text: '助手中间消息', phase: 'commentary' },
        { type: 'commandExecution', command: 'synthetic command', aggregatedOutput: 'synthetic output' }, { type: 'mcpToolCall', result: { synthetic: true } },
        { type: 'userMessage', content: [{ type: 'text', text: '原生问题' }] }, { type: 'agentMessage', text: '原生最终回复', phase: 'final_answer' }
      ] },
      [tailKey]: { turnId: tailId, status: 'completed', params: { input: [], turnTrigger: 'app_tool_send_message', toolOutput: { output: '计算99+1' } }, items: [{ type: 'functionCallOutput', output: '计算99+1' }, { type: 'agentMessage', text: '100', phase: 'final_answer' }] }
    }, islands: [{ id: 'tail:0', entries: [{ key: firstKey, value: firstKey }, { key: tailKey, value: tailKey }], olderBoundary: { status: 'exhausted' }, newerBoundary: { status: 'exhausted' } }] } }
  };
  const complete = (id = turnId, reply = '普通回复🌟', time = Date.now()) => ({ type: 'event_msg', payload: { type: 'task_complete', turn_id: id, started_at: new Date(time).toISOString(), completed_at: new Date(time).toISOString(), duration_ms: 0, last_agent_message: reply } });
  const socket = new Socket((message, s) => {
    const reply = (result: object) => s.receive({ type: 'response', requestId: message.requestId, method: message.method, handledByClientId: 'owner', resultType: 'success', result });
    if (mode === 'offline') { s.emit('error', new Error('private-location')); return; }
    if (message.method === 'initialize') reply({ clientId: 'follower' });
    else if (message.method === 'thread-owner-discovery') reply({});
    else if (message.method === 'thread-stream-following-changed' && message.params.following) {
      const state = { id: threadId, title: '测试线程', ...(snapshotPath !== undefined ? { rolloutPath: snapshotPath } : {}), resumeState: mode === 'unknown' ? 'restoring' : 'resumed', threadRuntimeStatus: { type: mode === 'busy' ? 'active' : 'idle' }, ...history, connectionSecret: 'EXCLUDED_UI_CONNECTION', requests: [{ private: true }] };
      const frame = { type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: mode === 'wrong_owner' ? 'other' : 'owner', targetClientIds: ['follower'], params: { conversationId: threadId, hostId: 'local', change: { type: 'snapshot', conversationState: state } } };
      s.receive(frame, ...(secondSnapshotPath !== undefined ? [{ ...frame, params: { ...frame.params, change: { type: 'snapshot', conversationState: { ...state, rolloutPath: secondSnapshotPath } } } }] : []), ...(mode === 'changed' ? [{ ...frame, params: { ...frame.params, change: { type: 'update' } } }] : []));
    } else if (message.method === 'thread-follower-start-turn') {
      assert.equal(before, 1); if (mode === 'ack_loss') { s.destroy(); return; }
      onStart?.(); reply({ result: { turn: { id: turnId } } });
    }
  });
  const input = () => ({ threadId, rolloutPath, signal: controller.signal, deadline: Date.now() + 150 });
  const testing = { connect: () => socket as unknown as net.Socket, pollMs: 2 };
  const send = (overrides: object = {}) => runSend({ ...input(), requestId, text: '请回答我的普通问题', beforeSend: () => { before++; }, onAccepted: id => { accepted = id; }, ...overrides }, testing);
  const read = () => runRead(input(), testing);
  const localInput = () => ({ threadId, codexHome: root, signal: controller.signal, deadline: Date.now() + 150 });
  const localRead = (onResolvedTarget?: (target: {thread_id:string; rollout_path:string}) => void) => runRead({ ...localInput(), onResolvedTarget }, { ...testing, nativeReader: readerFixture(threadId).testing });
  const localSend = (onResolvedTarget?: (target: {thread_id:string; rollout_path:string}) => void) => runSend({ ...localInput(), requestId, text: '普通问题', onResolvedTarget, beforeSend: () => { before++; }, onAccepted: id => { accepted = id; } }, testing);
  return { root, threadId, requestId, turnId, rolloutPath, nativePath, socket, controller, append, complete, send, read, localRead, localSend, input, testing, history, snapshotPath: (path?: string) => { snapshotPath = path; }, secondSnapshot: (path: string) => { secondSnapshotPath = path; }, persist: () => { before++; }, before: () => before, accepted: () => accepted, onStart: (fn: () => void) => { onStart = fn; } };
}

test('legacy new reads require official local mode and never open IPC or logs', async () => {
  for (const mode of ['idle', 'busy', 'unknown', 'offline'] as const) await fixture(async f => {
    rmSync(f.rolloutPath);
    assert.deepEqual(await f.read(), { status: 'skipped_unknown', reason: 'official_read_requires_local_mode' });
    assert.equal(f.socket.frames.length, 0); assert.equal(f.before(), 0);
  }, mode);
});

test('saved legacy read receipt retains idle evidence, chunks and identity after reopen', async () => fixture(async f => {
  (Object.values(f.history.turnHistory.history.entitiesByKey)[0] as any).items[0].content[0].text = '原文🌟'.repeat(15000);
  const dbPath = join(f.root, 'receipts.sqlite'), config = { enabled: true, targets: [{ thread_id: f.threadId, rollout_path: f.rolloutPath }] };
  let db = new Database(dbPath), calls = 0, originalContext: string | undefined;
  let service = new DesktopConversationsService(db, config, { timeoutMs: 1000, transport: { runRead: async input => {
    calls++; const result = { status: 'completed' as const, context_json: JSON.stringify(f.history), source_complete: true, desktop_state: { status: 'idle' as const, observed_at: new Date().toISOString(), checked_by: 'native_desktop_owner' as const, scope: 'observation_snapshot' as const } };
    if (result.status === 'completed') originalContext = result.context_json; return result;
  }, runSend: async () => { assert.fail('unexpected send'); } } });
  try {
    service.read({ request_id: f.requestId, thread_id: f.threadId }); const first = await service.get({ request_id: f.requestId, wait_seconds: 1 });
    assert.equal(first.status, 'completed'); assert.equal(first.desktop_state?.status, 'idle'); assert(first.next_offset);
    const state = structuredClone(first.desktop_state), nonce = first.receipt_nonce;
    first.desktop_state!.observed_at = 'mutated';
    assert.deepEqual(service.read({ request_id: f.requestId, thread_id: f.threadId }).desktop_state, state); assert.equal(calls, 1);
    await service.close(); db.close(); db = new Database(dbPath);
    service = new DesktopConversationsService(db, config, { transport: { runRead: async () => { assert.fail('restart must not read again'); }, runSend: async () => { assert.fail('unexpected send'); } } });
    let offset: number | null = 0, assembled = '';
    while (offset !== null) {
      const page = await service.get({ request_id: f.requestId, offset });
      assert.deepEqual(page.desktop_state, state); assert.equal(page.receipt_nonce, nonce); assembled += page.context_chunk; offset = page.next_offset!;
    }
    assert.equal(assembled, originalContext); assert.deepEqual(JSON.parse(assembled), f.history); assert.equal(calls, 1);
  } finally { await service.close(); db.close(); }
}));

test('a prior idle read never authorizes send: each send reconnects and checks fresh busy or unknown state', async () => {
  for (const status of ['busy', 'unknown'] as const) await fixture(async f => {
    const prior = { desktop_state: { status: 'idle', observed_at: new Date().toISOString(), checked_by: 'native_desktop_owner', scope: 'observation_snapshot' } }; // persisted legacy observation
    const fresh = new Socket((message, socket) => {
      const reply = (result: object) => socket.receive({ type: 'response', requestId: message.requestId, method: message.method, handledByClientId: 'owner', resultType: 'success', result });
      if (message.method === 'initialize') reply({ clientId: 'fresh-follower' });
      else if (message.method === 'thread-owner-discovery') reply({});
      else if (message.method === 'thread-stream-following-changed' && message.params.following) socket.receive({ type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: 'owner', targetClientIds: ['fresh-follower'], params: { conversationId: f.threadId, hostId: 'local', change: { type: 'snapshot', conversationState: { id: f.threadId, resumeState: status === 'unknown' ? 'restoring' : 'resumed', threadRuntimeStatus: { type: status === 'busy' ? 'active' : 'idle' }, ...f.history } } } });
    });
    const result = await runSend({ ...f.input(), requestId: randomUUID(), text: 'message', beforeSend: () => { assert.fail('must not persist send'); }, onAccepted: () => { assert.fail('must not accept'); }, desktop_state: prior.desktop_state } as any, { connect: () => fresh as unknown as net.Socket });
    assert.equal(result.status, status === 'busy' ? 'skipped_busy' : 'skipped_unknown'); assert(!fresh.frames.some(frame => frame.method === 'thread-follower-start-turn')); assert(fresh.frames.some(frame => frame.method === 'thread-owner-discovery'));
  });
});

test('send rechecks a native state change during beforeSend before writing the start frame', async () => fixture(async f => {
  const result = await f.send({ beforeSend: () => { f.socket.receive({ type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: 'owner', targetClientIds: ['follower'], params: { conversationId: f.threadId, hostId: 'local', change: { type: 'update' } } }); } });
  assert.equal(result.status, 'skipped_unknown'); assert(!f.socket.frames.some(frame => frame.method === 'thread-follower-start-turn'));
}));

test('custom message inherits settings, persists before write, binds ACK and accepts arbitrary exact-turn reply', async () => fixture(async f => {
  f.append(f.complete(f.turnId, 'HISTORY_MUST_NOT_WIN', Date.now() - 10000));
  f.onStart(() => { f.append(f.complete(randomUUID(), 'UNRELATED_MUST_NOT_WIN')); f.append(f.complete()); });
  const result = await f.send(); assert.deepEqual(result, { status: 'completed', turn_id: f.turnId, reply: '普通回复🌟' }); assert.equal(f.accepted(), f.turnId);
  const start = f.socket.frames.find(frame => frame.method === 'thread-follower-start-turn'); assert.equal(start.version, 2); assert.equal(start.params.turnStart.request.input[0].text, '请回答我的普通问题'); assert.equal(start.params.turnStart.context.inheritThreadSettings, true);
  assert(!Object.hasOwn(start.params.turnStart.request, 'model')); assert(!Object.hasOwn(start.params.turnStart.request, 'cwd')); assert(!Object.hasOwn(start.params.turnStart.request, 'approvalPolicy'));
  assert(f.socket.frames.every(frame => ['initialize', 'thread-owner-discovery', 'thread-stream-following-changed', 'thread-follower-start-turn'].includes(frame.method))); assert.equal(f.socket.closed, true);
}));

test('ordinary sender never retries on busy or ACK loss', async () => {
  await fixture(async f => { assert.equal((await f.send()).status, 'skipped_busy'); assert.equal(f.before(), 0); }, 'busy');
  await fixture(async f => { assert.equal((await f.send()).status, 'uncertain'); assert.equal(f.before(), 1); assert.equal(f.accepted(), undefined); assert.equal(f.socket.frames.filter(frame => frame.method === 'thread-follower-start-turn').length, 1); }, 'ack_loss');
});

test('beforeSend persistence failure blocks the frame; acceptance failure is uncertain', async () => {
  await fixture(async f => { const result = await f.send({ beforeSend: () => { throw new Error('private-store'); } }); assert.equal(result.status, 'skipped_unknown'); assert(!f.socket.frames.some(frame => frame.method === 'thread-follower-start-turn')); assert(!JSON.stringify(result).includes('private-store')); });
  await fixture(async f => { f.onStart(() => f.append(f.complete())); assert.deepEqual(await f.send({ onAccepted: () => { throw new Error('private-store'); } }), { status: 'uncertain', reason: 'acceptance_not_persisted' }); });
});

test('only fresh ACK completion wins, oversized replies remain uncertain', async () => {
  for (const mode of ['wrong_turn', 'old_time', 'oversize', 'partial', 'utf8'] as const) await fixture(async f => {
    f.onStart(() => {
      if (mode === 'partial') appendFileSync(f.rolloutPath, JSON.stringify(f.complete()));
      else if (mode === 'utf8') appendFileSync(f.rolloutPath, Buffer.from([0xff, 10]));
      else f.append(f.complete(mode === 'wrong_turn' ? randomUUID() : f.turnId, mode === 'oversize' ? 'x'.repeat(32001) : 'reply', mode === 'old_time' ? Date.now() - 10000 : Date.now()));
    });
    const result = await f.send(); assert.equal(result.status, 'uncertain'); if (result.status === 'uncertain') assert.equal(result.reason, ({ wrong_turn: 'reply_timeout', old_time: 'reply_invalid', oversize: 'reply_too_large', partial: 'reply_timeout', utf8: 'log_invalid' })[mode]);
  });
});

test('binding, partial EOF and truncation are rejected', async () => {
  for (const mode of ['binding', 'partial'] as const) await fixture(async f => {
    if (mode === 'binding') writeFileSync(f.rolloutPath, JSON.stringify({ type: 'session_meta', payload: { id: randomUUID() } }) + '\n'); else appendFileSync(f.rolloutPath, '{');
    assert.equal((await f.send()).status, 'skipped_unknown'); assert.equal(f.before(), 0);
  });
  await fixture(async f => {
    f.onStart(() => { truncateSync(f.rolloutPath, 0); });
    assert.deepEqual(await f.send(), { status: 'uncertain', reason: 'log_changed' });
  });
});

test('symlink ancestors are rejected where sandbox permits junction creation', async t => fixture(async f => {
  const alias = `${f.root}-alias`; try { symlinkSync(f.root, alias, 'junction'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; t.skip('sandbox denies junction creation'); return; }
  try { const result = await f.send({ rolloutPath: join(alias, 'rollout.jsonl') }); assert.equal(result.status, 'skipped_unknown'); assert.equal(f.before(), 0); } finally { rmSync(alias, { recursive: true, force: true }); }
}));

test('replacement of an open log is rejected where the operating system allows it', async t => fixture(async f => {
  let blocked = false;
  f.onStart(() => { try { renameSync(f.rolloutPath, `${f.rolloutPath}.old`); writeFileSync(f.rolloutPath, JSON.stringify(f.complete()) + '\n'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; blocked = true; } });
  const result = await f.send(); if (blocked) { t.skip('Windows disallows replacing this open file'); return; }
  assert.deepEqual(result, { status: 'uncertain', reason: 'log_changed' });
}));

test('abort during reply wait settles; fixed echo prompt remains unchanged', async () => {
  await fixture(async f => { f.onStart(() => setTimeout(() => f.controller.abort(), 5)); const result = await f.send(); assert.deepEqual(result, { status: 'uncertain', reason: 'closed' }); });
  await fixture(async f => { const result = await runDesktopEchoIpc({ ...f.input(), requestId: f.requestId, beforeSend: f.persist }, f.testing); assert.equal(result.status, 'accepted'); const start = f.socket.frames.find(frame => frame.method === 'thread-follower-start-turn'); assert.equal(start.params.turnStart.request.input[0].text, fixedEchoPrompt(f.requestId)); });
});

test('local read resolves unrelated stable IDs using native stored history, independent of owners and paths', async () => {
  const ids = new Set<string>();
  for (let i = 0; i < 2; i++) await fixture(async f => {
    ids.add(f.threadId); let resolutions = 0;
    rmSync(f.nativePath); f.snapshotPath(undefined);
    const result = await f.localRead(() => { resolutions++; }); assert.equal(result.status, 'completed'); if (result.status !== 'completed') return;
    assert.equal(result.verification, 'native_stored_history'); assert.equal(result.history_source, 'codex_app_server'); assert.equal(result.stored_history_complete, true); assert.equal(result.source_complete, false);
    assert.equal(JSON.parse(result.context_json).thread.id, f.threadId); assert.equal(JSON.parse(result.context_json).thread.status.type, 'notLoaded');
    assert.equal(resolutions, 0); assert.equal(Object.hasOwn(result, 'desktop_state'), false); assert.equal(f.socket.frames.length, 0); assert.equal(f.before(), 0);
  }, 'busy');
  assert.equal(ids.size, 2);
});
test('native local read failure never falls back to owner IPC or raw logs', async () => fixture(async f => {
  const reader = readerFixture(f.threadId, (frame, r) => { if (frame.method !== 'thread/read') return false; r.receive({ id: frame.id, error: { message: 'SECRET' } }); return true; });
  const result = await runRead({ threadId: f.threadId, codexHome: f.root, signal: f.controller.signal, deadline: Date.now() + 1000 }, { ...f.testing, nativeReader: reader.testing });
  assert.deepEqual(result, { status: 'skipped_unknown', reason: 'native_reader_request_failed' }); assert.equal(f.socket.frames.length, 0); assert.equal(f.before(), 0);
}));
test('local send uses the same final snapshot metadata; a prior different path never binds the send', async () => fixture(async f => {
  // The first snapshot has an invalid target file. Only the second exact idle
  // snapshot can bind this attempt, and only that file receives completion.
  writeFileSync(f.nativePath, JSON.stringify({ type: 'session_meta', payload: { id: randomUUID() } }) + '\n');
  const lastPath = join(f.root, 'archived_sessions', 'last.jsonl'); writeFileSync(lastPath, JSON.stringify({ type: 'session_meta', payload: { id: f.threadId } }) + '\n'); f.secondSnapshot(lastPath);
  let resolved: string | undefined; f.onStart(() => appendFileSync(lastPath, JSON.stringify(f.complete()) + '\n'));
  const result = await f.localSend(target => { assert.equal(f.before(), 0); resolved = target.rollout_path; });
  assert.equal(resolved, lastPath); assert.deepEqual(result, { status: 'completed', turn_id: f.turnId, reply: '普通回复🌟' }); assert.equal(f.before(), 1); assert.equal(f.socket.frames.filter(frame => frame.method === 'thread-follower-start-turn').length, 1);
}));
test('local native missing path, outside home, UNC, foreign identity and non-files skip without send', async () => {
  for (const mode of ['missing', 'outside', 'unc', 'foreign', 'directory'] as const) {
    const configure = (f: ReturnType<typeof setup>) => {
      if (mode === 'missing') f.snapshotPath(undefined);
      else if (mode === 'outside') f.snapshotPath(f.rolloutPath);
      else if (mode === 'unc') f.snapshotPath(String.raw`\\outside-host\share\rollout.jsonl`);
      else if (mode === 'foreign') writeFileSync(f.nativePath, JSON.stringify({ type: 'session_meta', payload: { id: randomUUID() } }) + '\n');
      else { const directory = join(f.root, 'sessions', 'directory'); mkdirSync(directory); f.snapshotPath(directory); }
    };
    for (const operation of ['send'] as const) await fixture(async f => {
      configure(f); let resolutions = 0; const resolved = () => { resolutions++; };
      const result = await f.localSend(resolved);
      assert.equal(result.status, 'skipped_unknown', mode); if (result.status !== 'skipped_unknown') return;
      assert.equal(result.reason, ({ missing: 'native_path_missing', outside: 'target_path_invalid', unc: 'target_path_invalid', foreign: 'log_binding_invalid', directory: 'log_unavailable' })[mode]);
      assert.equal(resolutions, 0); assert.equal(f.before(), 0); assert(!f.socket.frames.some(frame => frame.method === 'thread-follower-start-turn')); assert(!JSON.stringify(result).includes(f.root));
    });
  }
});
test('Windows extended native metadata path normalizes to a safe local target', async t => {
  if (process.platform !== 'win32') { t.skip('Windows extended path fixture'); return; }
  await fixture(async f => { f.snapshotPath('\\\\?\\' + f.nativePath); const result = await f.localRead(() => assert.fail('native reader must not bind sender paths')); assert.equal(result.status, 'completed'); });
  await fixture(async f => { f.snapshotPath('\\\\?\\' + f.nativePath); f.onStart(() => appendFileSync(f.nativePath, JSON.stringify(f.complete()) + '\n')); assert.equal((await f.localSend()).status, 'completed'); });
});
test('local symlink redirection is rejected before persistence and sending', async t => fixture(async f => {
  const alias = join(f.root, 'sessions', 'alias');
  try { symlinkSync(join(f.root, 'archived_sessions'), alias, 'junction'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; t.skip('sandbox denies synthetic junction creation'); return; }
  const actual = join(f.root, 'archived_sessions', 'redirect.jsonl'); writeFileSync(actual, JSON.stringify({ type: 'session_meta', payload: { id: f.threadId } }) + '\n'); f.snapshotPath(join(alias, 'redirect.jsonl'));
  const result = await f.localSend(); assert.deepEqual(result, { status: 'skipped_unknown', reason: 'target_path_invalid' }); assert.equal(f.before(), 0); assert(!f.socket.frames.some(frame => frame.method === 'thread-follower-start-turn'));
}));
