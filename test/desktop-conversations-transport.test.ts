import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type net from 'node:net';
import Database from 'better-sqlite3';
import { runRead, runReply, runSend } from '../src/desktop-conversations-transport.js';
import type { DesktopReplyBinding } from '../src/desktop-reply.js';
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
type Mode = 'idle' | 'busy' | 'unknown' | 'changed' | 'wrong_owner' | 'offline' | 'ack_loss' | 'invalid_ack';
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
      onStart?.(); reply({ result: { turn: { id: mode === 'invalid_ack' ? 'not-a-turn-id' : turnId } } });
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

test('send persists source identity and original EOF before the only frame, then accepts the exact turn',async()=>fixture(async f=>{
  const order:string[]=[],before=statSync(f.rolloutPath,{bigint:true});let binding:DesktopReplyBinding|undefined;
  f.onStart(()=>f.append(f.complete()));
  const result=await f.send({onReplyBinding:(value:DesktopReplyBinding)=>{order.push('binding');binding=value;},beforeSend:()=>{order.push('intent');f.persist();},onAccepted:()=>{order.push('ack');}});
  assert.equal(result.status,'completed');assert.deepEqual(order,['binding','intent','ack']);
  assert.equal(binding?.offset,Number(before.size));assert.equal(binding?.inode,before.ino.toString());assert.equal(binding?.path,f.rolloutPath);assert.equal(binding?.thread_id,f.threadId);
  assert.deepEqual(await runReply({binding:binding!,turnId:f.turnId,signal:f.controller.signal,deadline:Date.now()+1000}),{status:'completed',turn_id:f.turnId,reply:'普通回复🌟'});
  assert.equal(f.socket.frames.filter(frame=>frame.method==='thread-follower-start-turn').length,1);
}));

test('source-binding persistence failure prevents the native send frame',async()=>fixture(async f=>{
  const result=await f.send({onReplyBinding:()=>{throw new Error('private storage error');}});
  assert.equal(result.status,'skipped_unknown');assert.equal(f.before(),0);assert.equal(f.socket.frames.filter(frame=>frame.method==='thread-follower-start-turn').length,0);
}));

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

test('matching abort or failure in the fast reply path retains the ACK and sends only once',async()=>{
  for(const type of ['turn_aborted','task_failed'])await fixture(async f=>{
    f.onStart(()=>f.append({type:'event_msg',payload:{type,turn_id:f.turnId}}));
    assert.deepEqual(await f.send(),{status:'uncertain',reason:'reply_failed'});
    assert.equal(f.accepted(),f.turnId);
    assert.equal(f.socket.frames.filter(frame=>frame.method==='thread-follower-start-turn').length,1);
  });
});

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

test('invalid native ACK and acceptance save failure never begin reply timing or a new budget', async () => {
  for (const mode of ['invalid_ack', 'save_failure'] as const) await fixture(async f => {
    let accepted = 0; const stages: string[] = [];
    const result = await f.send({ onAccepted: () => { accepted++; throw new Error('private-save-error'); }, onStageTiming: (stage: string) => stages.push(stage) });
    assert.equal(result.status, 'uncertain'); assert.equal(accepted, mode === 'invalid_ack' ? 0 : 1);
    assert.deepEqual(stages, ['owner_lookup', 'send_ack']);
    assert.equal(f.socket.frames.filter(frame => frame.method === 'thread-follower-start-turn').length, 1);
    assert(!JSON.stringify(result).includes('private-save-error'));
  }, mode === 'invalid_ack' ? 'invalid_ack' : 'idle');
});

function missingOwnerSocket() {
  return new Socket((message, socket) => {
    if (message.method === 'initialize') socket.receive({ type: 'response', requestId: message.requestId, method: message.method, resultType: 'success', result: { clientId: 'missing-follower' } });
    if (message.method === 'thread-owner-discovery') socket.receive({ type: 'response', requestId: message.requestId, resultType: 'error', error: 'no-client-found' });
  });
}
test('definitive missing owner warms once, reconnects and sends once using fresh identity', async () => fixture(async f => {
  let connects = 0, navigations = 0, accepted: string | undefined;
  const absent = missingOwnerSocket();
  f.onStart(() => appendFileSync(f.nativePath, JSON.stringify(f.complete()) + '\n'));
  const result = await runSend({ threadId: f.threadId, codexHome: f.root, requestId: f.requestId, text: 'ordinary message', signal: f.controller.signal, deadline: Date.now() + 1000, beforeSend: f.persist, onAccepted: id => { accepted = id; } }, {
    ...f.testing, connect: () => { if (++connects === 1) return absent as unknown as net.Socket; queueMicrotask(() => f.socket.emit('connect')); return f.socket as unknown as net.Socket; },
    warmLoad: async input => { navigations++; assert.equal(input.threadId, f.threadId); assert.equal(f.before(), 0); assert.equal(absent.closed, true); return { status: 'accepted' }; },
  });
  assert.equal(result.status, 'completed'); assert.equal(accepted, f.turnId); assert.equal(navigations, 1); assert.equal(connects, 2); assert.equal(f.before(), 1);
  assert.equal(f.socket.frames.filter(frame => frame.method === 'thread-follower-start-turn').length, 1);
}));

test('owner becoming ready during a one-shot discovery requires a new lookup, then one correlated send', async () => fixture(async f => {
  let connects = 0, navigations = 0, ready = false, accepted: string | undefined;
  const deadline = Date.now() + 1500, stages: Record<string, number[]> = {}, sockets: Socket[] = [];
  const staleDiscovery = new Socket((message, socket) => {
    if (message.method === 'initialize') socket.receive({ type: 'response', requestId: message.requestId, resultType: 'success', result: { clientId: 'stale-follower' } });
    else if (message.method === 'thread-owner-discovery') {
      // The router captured false canHandle before the thread acquired ownership.
      ready = true;
      setTimeout(() => socket.receive({ type: 'response', requestId: message.requestId, resultType: 'error', error: 'no-client-found' }), 25);
    }
  });
  f.onStart(() => {
    appendFileSync(f.nativePath, JSON.stringify(f.complete(randomUUID(), 'unrelated reply')) + '\n');
    appendFileSync(f.nativePath, JSON.stringify(f.complete(f.turnId, 'fresh correlated reply')) + '\n');
  });
  const result = await runSend({ threadId: f.threadId, codexHome: f.root, requestId: f.requestId, text: 'same request', signal: f.controller.signal, deadline, beforeSend: f.persist, onAccepted: id => { accepted = id; }, onStageTiming: (stage, ms) => { (stages[stage] ??= []).push(ms); } }, {
    ...f.testing, connect: () => {
      connects++;
      const socket = connects === 1 ? missingOwnerSocket() : connects === 2 ? staleDiscovery : f.socket;
      if (connects > 1) { if (connects === 3) assert(ready); queueMicrotask(() => socket.emit('connect')); }
      sockets.push(socket); return socket as unknown as net.Socket;
    },
    warmLoad: async input => { navigations++; assert.equal(input.deadline, deadline); assert.equal(input.signal, f.controller.signal); assert.equal(input.threadId, f.threadId); return { status: 'accepted' }; },
  });
  assert.deepEqual(result, { status: 'completed', turn_id: f.turnId, reply: 'fresh correlated reply' });
  assert.equal(accepted, f.turnId); assert.equal(navigations, 1); assert.equal(connects, 3); assert.equal(f.before(), 1);
  assert.equal(sockets.flatMap(socket => socket.frames).filter(frame => frame.method === 'thread-follower-start-turn').length, 1);
  assert.equal(stages.autoload?.length, 1); assert.equal(stages.send_ack?.length, 1); assert.equal(stages.reply_wait?.length, 1);
  assert(stages.owner_lookup?.some(ms => ms >= 200));
}));

test('autoload readiness preserves the service request and persisted acceptance across repeated lookups', async () => fixture(async f => {
  const db = new Database(':memory:'); let executions = 0, connects = 0, navigations = 0;
  const service = new DesktopConversationsService(db, { enabled: true, mode: 'local', codex_home: f.root, read: false, send: true }, {
    timeoutMs: 1000, transport: { runRead: async () => assert.fail('no read'), runSend: input => {
      executions++; assert.equal(input.requestId, f.requestId);
      return runSend({ ...input, beforeSend: () => { input.beforeSend(); f.persist(); } }, {
        ...f.testing, connect: () => { if (++connects <= 2) return missingOwnerSocket() as unknown as net.Socket; queueMicrotask(() => f.socket.emit('connect')); return f.socket as unknown as net.Socket; },
        warmLoad: async () => { navigations++; return { status: 'accepted' }; },
      });
    } },
  });
  f.onStart(() => appendFileSync(f.nativePath, JSON.stringify(f.complete()) + '\n'));
  try {
    const args = { request_id: f.requestId, thread_id: f.threadId, text: 'same persisted request' };
    service.send(args); const result = await service.get({ request_id: f.requestId, wait_seconds: 2 });
    assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.request_id, f.requestId); assert.equal(result.reply, '普通回复🌟');
    const stored = JSON.parse((db.prepare('SELECT data FROM desktop_conversation_requests WHERE request_id = ?').get(f.requestId) as { data: string }).data);
    assert.equal(stored.accepted_turn_id, f.turnId); assert.equal(stored.sent, true);
    const identity = statSync(f.nativePath, {bigint:true});
    assert.equal(stored.reply_binding.version, 2); assert.equal(stored.reply_binding.inode, identity.ino.toString());
    assert.equal(stored.reply_binding.device, identity.dev.toString()); assert.equal(stored.reply_binding.birthtime_ns, identity.birthtimeNs.toString());
    assert.equal(service.send(args).status, 'completed'); assert.equal(executions, 1); assert.equal(connects, 3); assert.equal(navigations, 1); assert.equal(f.before(), 1);
    assert.equal(f.socket.frames.filter(frame => frame.method === 'thread-follower-start-turn').length, 1);
  } finally { await service.close(); db.close(); }
}));

test('warm loading consumes pre-send time but durable ACK opens a fresh real log reply wait', async () => fixture(async f => {
  const db = new Database(':memory:'); let connects = 0, ackSaves = 0, completion: NodeJS.Timeout | undefined;
  const service = new DesktopConversationsService(db, { enabled: true, mode: 'local', codex_home: f.root, read: false, send: true }, {
    timeoutMs: 600, transport: { runRead: async () => assert.fail('no read'), runSend: input => runSend({ ...input, beforeSend: () => { input.beforeSend(); f.persist(); } }, {
      ...f.testing,
      connect: () => { if (++connects === 1) return missingOwnerSocket() as unknown as net.Socket; queueMicrotask(() => f.socket.emit('connect')); return f.socket as unknown as net.Socket; },
      warmLoad: async () => { await new Promise(resolve => setTimeout(resolve, 550)); return { status: 'accepted' }; },
    }) },
  });
  f.onStart(() => { completion = setTimeout(() => appendFileSync(f.nativePath, JSON.stringify(f.complete()) + '\n'), 100); });
  db.function('ack_saved', () => { ackSaves++; return 1; });
  db.exec("CREATE TRIGGER count_ack AFTER UPDATE ON desktop_conversation_requests WHEN json_extract(NEW.data, '$.accepted_turn_id') IS NOT NULL AND json_extract(OLD.data, '$.accepted_turn_id') IS NULL BEGIN SELECT ack_saved(); END");
  try {
    const args = { request_id: f.requestId, thread_id: f.threadId, text: 'slow warm, fresh reply' };
    service.send(args); const result = await service.get({ request_id: f.requestId, wait_seconds: 2 });
    assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.reply, '普通回复🌟'); assert.equal(ackSaves, 1);
    assert.equal(result.timing.stages_ms?.busy_wait, undefined);
    for (const stage of ['owner_lookup', 'autoload', 'send_ack', 'reply_wait'] as const) assert(Number.isFinite(result.timing.stages_ms?.[stage]));
    assert(result.timing.stages_ms!.autoload! >= 500); assert(result.timing.stages_ms!.reply_wait! >= 50);
    assert(!JSON.stringify(result).includes('follower')); assert(!JSON.stringify(result).includes(f.root));
    assert.equal(service.send(args).status, 'completed'); assert.equal(connects, 2);
    assert.equal(f.socket.frames.filter(frame => frame.method === 'thread-follower-start-turn').length, 1);
  } finally { clearTimeout(completion); await service.close(); db.close(); }
}));
test('warm ACK followed by busy returns selection evidence; persistent absence exhausts the original deadline', async () => {
  await fixture(async f => {
    let connects = 0, navigations = 0;
    const active = randomUUID(), startedAtMs = Date.now() - 1000;
    f.history.turnHistory.history.entitiesByKey.active = { turnId: active, turnStartedAtMs: startedAtMs, status: 'inProgress' };
    const absent = missingOwnerSocket();
    const result = await runSend({ threadId: f.threadId, codexHome: f.root, requestId: f.requestId, text: 'message', signal: f.controller.signal, deadline: Date.now() + 1000, beforeSend: f.persist, onAccepted: () => assert.fail('busy must not accept') }, { ...f.testing, connect: () => { if (++connects === 1) return absent as unknown as net.Socket; queueMicrotask(() => f.socket.emit('connect')); return f.socket as unknown as net.Socket; }, warmLoad: async () => { navigations++; return { status: 'accepted' }; } });
    assert.equal(result.status, 'skipped_busy'); assert.equal(f.before(), 0); assert.equal(navigations, 1); assert.equal(connects, 2);
    if (result.status === 'skipped_busy') { assert.equal(result.busy_state?.active_turn_id, active); assert.equal(result.busy_state?.active_turn_started_at_ms, startedAtMs); assert.equal(result.busy_owner, createHash('sha256').update('owner').digest('hex')); }
  }, 'busy');
  await fixture(async f => {
    let connects = 0, navigations = 0; const sockets: Socket[] = [], started = Date.now();
    const result = await runSend({ threadId: f.threadId, codexHome: f.root, requestId: f.requestId, text: 'message', signal: f.controller.signal, deadline: started + 600, beforeSend: () => assert.fail('missing owner must not persist'), onAccepted: () => assert.fail('missing owner must not accept') }, { ...f.testing, connect: () => { connects++; const socket = missingOwnerSocket(); sockets.push(socket); return socket as unknown as net.Socket; }, warmLoad: async () => { navigations++; return { status: 'accepted' }; } });
    assert.deepEqual(result, { status: 'skipped_unknown', reason: 'native_owner_unavailable_after_load' }); assert.equal(navigations, 1);
    assert(connects >= 3 && connects <= 4); assert(Date.now() - started >= 590 && Date.now() - started < 1500);
    assert(sockets.every(socket => socket.closed && !socket.frames.some(frame => frame.method === 'thread-follower-start-turn')));
  });
});

test('cancel during autoload readiness pause stops before another discovery or send', async () => fixture(async f => {
  let connects = 0, navigations = 0; const sockets: Socket[] = []; let cancellation: NodeJS.Timeout | undefined, cancelledAt = 0;
  try {
    const result = await runSend({ threadId: f.threadId, codexHome: f.root, requestId: f.requestId, text: 'cancelled', signal: f.controller.signal, deadline: Date.now() + 1500, beforeSend: () => assert.fail('cancelled request must not reserve'), onAccepted: () => assert.fail('must not accept') }, {
      ...f.testing, connect: () => { connects++; const socket = missingOwnerSocket(); sockets.push(socket); return socket as unknown as net.Socket; },
      warmLoad: async () => { navigations++; cancellation = setTimeout(() => { cancelledAt = Date.now(); f.controller.abort(); }, 50); return { status: 'accepted' }; },
    });
    assert.deepEqual(result, { status: 'skipped_unknown', reason: 'closed' }); assert.equal(connects, 2); assert.equal(navigations, 1);
    assert(cancelledAt > 0 && Date.now() - cancelledAt < 200); assert(sockets.every(socket => socket.closed));
  } finally { clearTimeout(cancellation); }
}));

test('guard invalidated during readiness waiting refuses the eventual idle send without retry', async () => fixture(async f => {
  let connects = 0, navigations = 0, allowed = true, guardChecks = 0; let invalidation: NodeJS.Timeout | undefined;
  try {
    const result = await runSend({ threadId: f.threadId, codexHome: f.root, requestId: f.requestId, text: 'guarded', signal: f.controller.signal, deadline: Date.now() + 1500, beforeSend: () => { guardChecks++; assert.equal(allowed, false); throw new Error('private guard refusal'); }, onAccepted: () => assert.fail('must not accept') }, {
      ...f.testing, connect: () => { if (++connects <= 2) return missingOwnerSocket() as unknown as net.Socket; queueMicrotask(() => f.socket.emit('connect')); return f.socket as unknown as net.Socket; },
      warmLoad: async () => { navigations++; invalidation = setTimeout(() => { allowed = false; }, 50); return { status: 'accepted' }; },
    });
    assert.deepEqual(result, { status: 'skipped_unknown', reason: 'log_unavailable' }); assert.equal(guardChecks, 1); assert.equal(connects, 3); assert.equal(navigations, 1);
    assert(!f.socket.frames.some(frame => frame.method === 'thread-follower-start-turn'));
  } finally { clearTimeout(invalidation); }
}));

test('autoload readiness terminates on connection, discovery, unknown state and uncertain ACK outcomes', async () => {
  for (const mode of ['offline', 'discovery_error', 'unknown', 'ack_loss'] as const) await fixture(async f => {
    let connects = 0, navigations = 0;
    const errorSocket = new Socket((message, socket) => {
      if (message.method === 'initialize') socket.receive({ type: 'response', requestId: message.requestId, resultType: 'success', result: { clientId: 'error-follower' } });
      else if (message.method === 'thread-owner-discovery') socket.receive({ type: 'response', requestId: message.requestId, resultType: 'error', error: 'private remote failure' });
    });
    const result = await runSend({ threadId: f.threadId, codexHome: f.root, requestId: f.requestId, text: 'message', signal: f.controller.signal, deadline: Date.now() + 1000, beforeSend: f.persist, onAccepted: () => assert.fail('must not accept') }, {
      ...f.testing, connect: () => { if (++connects === 1) return missingOwnerSocket() as unknown as net.Socket; const socket = mode === 'discovery_error' ? errorSocket : f.socket; queueMicrotask(() => socket.emit('connect')); return socket as unknown as net.Socket; },
      warmLoad: async () => { navigations++; return { status: 'accepted' }; },
    });
    assert.deepEqual(result, ({ offline: { status: 'skipped_unreachable', reason: 'ipc_initialize_failed' }, discovery_error: { status: 'skipped_unknown', reason: 'ipc_owner_discovery_failed' }, unknown: { status: 'skipped_unknown', reason: 'resume_state' }, ack_loss: { status: 'uncertain', reason: 'send_outcome_unknown' } })[mode]);
    assert.equal(connects, 2); assert.equal(navigations, 1); assert.equal(f.before(), mode === 'ack_loss' ? 1 : 0);
    assert.equal(f.socket.frames.filter(frame => frame.method === 'thread-follower-start-turn').length, mode === 'ack_loss' ? 1 : 0);
  }, mode === 'discovery_error' ? 'idle' : mode);
});

test('unconfirmed navigation is never repeated or followed by another owner discovery', async () => fixture(async f => {
  let connects = 0, navigations = 0;
  const result = await runSend({ threadId: f.threadId, codexHome: f.root, requestId: f.requestId, text: 'message', signal: f.controller.signal, deadline: Date.now() + 1000, beforeSend: () => assert.fail('must not reserve'), onAccepted: () => assert.fail('must not accept') }, {
    ...f.testing, connect: () => { connects++; return missingOwnerSocket() as unknown as net.Socket; }, warmLoad: async () => { navigations++; return { status: 'skipped_unknown', reason: 'native_navigation_unconfirmed' }; },
  });
  assert.deepEqual(result, { status: 'skipped_unknown', reason: 'native_navigation_unconfirmed' }); assert.equal(connects, 1); assert.equal(navigations, 1);
}));
test('offline, discovery error, existing owner and uncertain send never navigate', async () => {
  for (const mode of ['idle', 'busy', 'offline', 'ack_loss'] as const) await fixture(async f => {
    let navigations = 0;
    f.onStart(() => appendFileSync(f.nativePath, JSON.stringify(f.complete()) + '\n'));
    await runSend({ threadId: f.threadId, codexHome: f.root, requestId: f.requestId, text: 'message', signal: f.controller.signal, deadline: Date.now() + 150, beforeSend: f.persist, onAccepted: () => {} }, { ...f.testing, warmLoad: async () => { navigations++; return { status: 'accepted' }; } });
    assert.equal(navigations, 0);
  }, mode);
});

test('chosen next turn waits only for the same native turn, sends once and returns the exact new reply', async () => fixture(async f => {
  const active = randomUUID(), startedAtMs = Date.now() - 1000; let connects = 0, waiting = 0, writes = 0;
  const stages: Record<string, number[]> = {};
  const result = await runSend({ threadId: f.threadId, codexHome: f.root, requestId: f.requestId, text: 'next text', signal: f.controller.signal, deadline: Date.now() + 1000, afterTurn: { id: active, startedAtMs, ownerHash: createHash('sha256').update('owner').digest('hex') }, onWaiting: () => { waiting++; }, beforeSend: f.persist, onAccepted: () => {}, onStageTiming: (stage, ms) => { (stages[stage] ??= []).push(ms); } }, {
    pollMs: 2, warmLoad: async () => { assert.fail('waiting never navigates'); }, connect: () => {
      const busy = ++connects < 3;
      return new Socket((message, socket) => {
        const reply = (result: object) => socket.receive({ type: 'response', requestId: message.requestId, method: message.method, handledByClientId: 'owner', resultType: 'success', result });
        if (message.method === 'initialize') reply({ clientId: 'waiting-follower' });
        else if (message.method === 'thread-owner-discovery') reply({});
        else if (message.method === 'thread-stream-following-changed' && message.params.following) socket.receive({ type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: 'owner', targetClientIds: ['waiting-follower'], params: { conversationId: f.threadId, hostId: 'local', change: { type: 'snapshot', conversationState: { id: f.threadId, rolloutPath: f.nativePath, resumeState: 'resumed', threadRuntimeStatus: { type: busy ? 'active' : 'idle' }, turnHistory: { kind: 'canonical', history: { entitiesByKey: { active: { turnId: active, turnStartedAtMs: startedAtMs, status: busy ? 'inProgress' : 'completed' } } } } } } } });
        else if (message.method === 'thread-follower-start-turn') { writes++; assert.equal(f.before(), 1); appendFileSync(f.nativePath, JSON.stringify(f.complete(f.turnId, 'new reply')) + '\n'); reply({ result: { turn: { id: f.turnId } } }); }
      }) as unknown as net.Socket;
    },
  });
  assert.deepEqual(result, { status: 'completed', turn_id: f.turnId, reply: 'new reply' }); assert.equal(waiting, 2); assert.equal(connects, 3); assert.equal(writes, 1);
  assert.equal(stages.owner_lookup?.length, 3); assert.equal(stages.busy_wait?.length, 2);
  assert.equal(stages.send_ack?.length, 1); assert.equal(stages.reply_wait?.length, 1); assert.equal(stages.autoload, undefined);
  assert(Object.values(stages).flat().every(ms => Number.isFinite(ms) && ms >= 0));
}));
test('chosen next turn never passes an intervening different turn or waits for a lost owner', async () => {
  for (const mode of ['different', 'missing', 'replaced'] as const) await fixture(async f => {
    const active = randomUUID(), other = randomUUID(); let connects = 0;
    const result = await runSend({ threadId: f.threadId, codexHome: f.root, requestId: f.requestId, text: 'not sent', signal: f.controller.signal, deadline: Date.now() + 1000, afterTurn: { id: active, startedAtMs: 1, ownerHash: createHash('sha256').update('owner').digest('hex') }, beforeSend: () => assert.fail('must not reserve'), onAccepted: () => assert.fail('must not accept') }, {
      pollMs: 2, warmLoad: async () => { assert.fail('must not reload lost owner while waiting'); }, connect: () => {
        connects++;
        return new Socket((message, socket) => {
          const owner = mode === 'replaced' && connects > 1 ? 'replacement-owner' : 'owner';
          const reply = (result: object) => socket.receive({ type: 'response', requestId: message.requestId, method: message.method, handledByClientId: owner, resultType: 'success', result });
          if (message.method === 'initialize') reply({ clientId: 'waiting-follower' });
          else if (message.method === 'thread-owner-discovery') { if (mode === 'missing' && connects > 1) socket.receive({ type: 'response', requestId: message.requestId, resultType: 'error', error: 'no-client-found' }); else reply({}); }
          else if (message.method === 'thread-stream-following-changed' && message.params.following) socket.receive({ type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: 'owner', targetClientIds: ['waiting-follower'], params: { conversationId: f.threadId, hostId: 'local', change: { type: 'snapshot', conversationState: { id: f.threadId, resumeState: 'resumed', threadRuntimeStatus: { type: 'active' }, turnHistory: { kind: 'canonical', history: { entitiesByKey: { active: { turnId: active, turnStartedAtMs: 1, status: 'inProgress' }, ...(mode === 'different' ? { other: { turnId: other, turnStartedAtMs: 2, status: 'inProgress' } } : {}) } } } } } } });
        }) as unknown as net.Socket;
      },
    });
    assert.equal(result.status, 'skipped_unknown'); if (result.status === 'skipped_unknown') assert.equal(result.reason, mode === 'different' ? 'next_turn_changed' : mode === 'replaced' ? 'next_turn_owner_changed' : 'native_owner_unavailable');
    assert.equal(connects, mode === 'different' ? 1 : 2);
  });
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
