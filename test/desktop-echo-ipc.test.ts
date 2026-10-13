import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type net from 'node:net';
import { assessIdle, fixedEchoPrompt, runDesktopEchoIpc, runDesktopReadIpc, type DesktopIpcDiagnostic, type DesktopThreadMetadata } from '../src/desktop-echo-ipc.js';

const frame = (value: object) => { const body = Buffer.from(JSON.stringify(value)); const head = Buffer.alloc(4); head.writeUInt32LE(body.length); return Buffer.concat([head, body]); };
class FakeSocket extends EventEmitter {
  destroyed = false; closed = false; frames: any[] = [];
  constructor(private responder: (message: any, socket: FakeSocket) => void, connected = true) { super(); if (connected) queueMicrotask(() => this.emit('connect')); }
  write(bytes: Buffer) { const message = JSON.parse(bytes.subarray(4).toString('utf8')); this.frames.push(message); queueMicrotask(() => { if (!this.destroyed) this.responder(message, this); }); return true; }
  receive(...messages: object[]) { this.emit('data', Buffer.concat(messages.map(frame))); }
  destroy() { if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => { this.closed = true; this.emit('close'); }); } return this; }
}
function idle(id: string) { return { id, resumeState: 'resumed', threadRuntimeStatus: { type: 'idle' }, turnHistory: { kind: 'legacy' }, turns: [] }; }
function setup(mode: 'idle' | 'busy' | 'unknown' | 'race' | 'wrong_owner' | 'ack_loss' | 'ack_timeout' | 'owner_timeout' | 'oversize' = 'idle', options: { ackDelayMs?: number; ownerDelayMs?: number; ownerError?: 'no-client-found'; deadlineMs?: number; rolloutPath?: string } = {}) {
  const threadId = randomUUID(), requestId = randomUUID(), turnId = randomUUID(); const controller = new AbortController(); let sends = 0, lateAck: (() => void) | undefined; const metadata: (DesktopThreadMetadata | undefined)[] = [];
  const socket = new FakeSocket((message, s) => {
    const reply = (result: object, handledByClientId = 'owner') => s.receive({ type: 'response', requestId: message.requestId, resultType: 'success', method: message.method, handledByClientId, result });
    if (message.method === 'initialize') reply({ clientId: 'follower' });
    else if (message.method === 'thread-owner-discovery' && mode !== 'owner_timeout') {
      const ownerReply = () => options.ownerError ? s.receive({ type: 'response', requestId: message.requestId, resultType: 'error', error: options.ownerError }) : reply({});
      if (options.ownerDelayMs) setTimeout(ownerReply, options.ownerDelayMs); else ownerReply();
    }
    else if (message.method === 'thread-stream-following-changed' && message.params.following) {
      const state = { ...idle(threadId), ...(options.rolloutPath !== undefined ? { rolloutPath: options.rolloutPath } : {}) };
      if (mode === 'busy') state.threadRuntimeStatus.type = 'active'; if (mode === 'unknown') state.resumeState = 'restoring';
      const event = { type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: mode === 'wrong_owner' ? 'forged' : 'owner', targetClientIds: ['follower'], params: { conversationId: threadId, hostId: 'local', change: { type: 'snapshot', conversationState: state } } };
      if (mode === 'oversize') { const head = Buffer.alloc(4); head.writeUInt32LE(32 * 1024 * 1024 + 1); s.emit('data', head); }
      else if (mode === 'race') s.receive(event, { ...event, params: { ...event.params, change: { type: 'update' } } });
      else s.receive(event);
    } else if (message.method === 'thread-follower-start-turn') {
      lateAck = () => reply({ result: { turn: { id: turnId } } });
      if (mode === 'ack_loss') s.destroy();
      else if (mode !== 'ack_timeout') { if (options.ackDelayMs) setTimeout(lateAck, options.ackDelayMs); else lateAck(); }
    }
  });
  const run = () => runDesktopEchoIpc({ threadId, requestId, signal: controller.signal, deadline: Date.now() + (options.deadlineMs ?? 150), beforeSend: meta => { sends++; metadata.push(meta); } }, { connect: () => socket as unknown as net.Socket });
  return { run, socket, controller, threadId, requestId, turnId, metadata, sends: () => sends, lateAck: () => lateAck?.() };
}
test('assessIdle accepts only explicit metadata and skips uncertain layouts', () => {
  const id = randomUUID(); assert.equal(assessIdle(idle(id), id).status, 'idle');
  assert.equal(assessIdle({ ...idle(id), unconfirmedTurnSubmissions: [{}] }, id).status, 'busy');
  assert.equal(assessIdle({ ...idle(id), turns: [{ turnId: 'x', status: 'inProgress' }] }, id).status, 'busy');
  assert.equal(assessIdle({ ...idle(id), turns: [{ turnId: 'x', status: 'alien' }] }, id).status, 'unknown');
  assert.equal(assessIdle({ ...idle(id), turnHistory: { kind: 'canonical', history: { entitiesByKey: {} } } }, id).status, 'idle');
  assert.equal(assessIdle(idle(randomUUID()), id).status, 'unknown');
});
test('exact v11 snapshot and v2 fixed echo start inherit settings, with no free methods', async () => {
  const f = setup(); const result = await f.run(); assert.deepEqual(result, { status: 'accepted', turnId: f.turnId }); assert.equal(f.sends(), 1);
  const start = f.socket.frames.find(value => value.method === 'thread-follower-start-turn');
  assert.equal(start.version, 2); assert.equal(start.targetClientId, 'owner');
  assert.equal(start.params.turnStart.context.inheritThreadSettings, true);
  assert.equal(start.params.turnStart.request.input[0].text, fixedEchoPrompt(f.requestId));
  assert.equal(start.params.turnStart.request.threadId, f.threadId);
  assert(f.socket.frames.every(value => ['initialize', 'thread-owner-discovery', 'thread-stream-following-changed', 'thread-follower-start-turn'].includes(value.method)));
  assert.equal(f.socket.closed, true);
});
for (const mode of ['busy', 'unknown', 'race', 'wrong_owner', 'oversize'] as const) test(`IPC ${mode} skips without start`, async () => {
  const f = setup(mode); const result = await f.run(); assert.equal(result.status, mode === 'busy' ? 'skipped_busy' : 'skipped_unknown'); assert.equal(f.sends(), 0); assert(!f.socket.frames.some(value => value.method === 'thread-follower-start-turn')); assert.equal(f.socket.closed, true);
});
test('ACK loss never resends and is uncertain', async () => { const f = setup('ack_loss'); assert.equal((await f.run()).status, 'uncertain'); assert.equal(f.sends(), 1); assert.equal(f.socket.frames.filter(value => value.method === 'thread-follower-start-turn').length, 1); });

for (const kind of ['invalid_utf8', 'invalid_json', 'invalid_frame_size', 'transport_closed', 'snapshot_timeout'] as const) test(`private diagnostics distinguish ${kind} while preserving the public failure and zero sends`, async () => {
  const threadId = randomUUID(), requestId = randomUUID(), diagnostics: DesktopIpcDiagnostic[] = [];
  const socket = new FakeSocket((message, s) => {
    if (message.method === 'initialize') s.receive({type:'response',requestId:message.requestId,resultType:'success',result:{clientId:'follower'}});
    else if (message.method === 'thread-owner-discovery') s.receive({type:'response',requestId:message.requestId,resultType:'success',handledByClientId:'owner'});
    else if (message.method === 'thread-stream-following-changed' && message.params.following) {
      if (kind === 'transport_closed') s.destroy();
      else if (kind === 'invalid_frame_size') { const head=Buffer.alloc(4);head.writeUInt32LE(32*1024*1024+1);s.emit('data',head); }
      else if (kind !== 'snapshot_timeout') { const body=kind==='invalid_utf8'?Buffer.from([0xc3,0x28]):Buffer.from('{"private":"PRIVATE_SNAPSHOT_SECRET"');const head=Buffer.alloc(4);head.writeUInt32LE(body.length);s.emit('data',Buffer.concat([head,body])); }
    }
  });
  const result=await runDesktopEchoIpc({threadId,requestId,signal:new AbortController().signal,deadline:Date.now()+5000,beforeSend:()=>assert.fail('must not send'),onDiagnostic:event=>diagnostics.push(event)},{connect:()=>socket as unknown as net.Socket});
  assert.deepEqual(result,{status:'skipped_unknown',reason:'ipc_snapshot_unavailable'});
  assert.equal(diagnostics.length,1);assert.equal(diagnostics[0]!.phase,'ipc_snapshot_unavailable');assert.equal(diagnostics[0]!.diagnostic_code,kind);
  assert.equal(diagnostics[0]!.received_frames,2);assert.equal(diagnostics[0]!.matched_state_frames,0);
  assert(!JSON.stringify(diagnostics).includes('PRIVATE'));assert(!JSON.stringify(result).includes('diagnostic'));
  assert.equal(socket.frames.filter(x=>x.method==='thread-follower-start-turn').length,0);assert.equal(socket.closed,true);
});

test('a throwing advisory diagnostic sink never alters failure disposition or retries',async()=>{
  const f=setup('ack_loss');
  const result=await runDesktopEchoIpc({threadId:f.threadId,requestId:f.requestId,signal:f.controller.signal,deadline:Date.now()+5000,beforeSend:()=>{},onDiagnostic:()=>{throw new Error('PRIVATE_SINK_FAILURE');}},{connect:()=>f.socket as unknown as net.Socket});
  assert.deepEqual(result,{status:'uncertain',reason:'send_outcome_unknown'});
  assert.equal(f.socket.frames.filter(x=>x.method==='thread-follower-start-turn').length,1);assert.equal(f.socket.closed,true);
});

test('only matching method, owner and UUID ACK can be accepted; rejection never retries', async () => {
  for (const fault of ['method', 'owner', 'turn_id'] as const) {
    const threadId = randomUUID(), stages: Record<string, number> = {}; let sends = 0;
    const socket = new FakeSocket((message, s) => {
      const reply = (result: object) => s.receive({ type: 'response', requestId: message.requestId, method: message.method, handledByClientId: 'owner', resultType: 'success', result });
      if (message.method === 'initialize') reply({ clientId: 'follower' });
      else if (message.method === 'thread-owner-discovery') reply({});
      else if (message.method === 'thread-stream-following-changed' && message.params.following) s.receive({ type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: 'owner', targetClientIds: ['follower'], params: { conversationId: threadId, hostId: 'local', change: { type: 'snapshot', conversationState: idle(threadId) } } });
      else if (message.method === 'thread-follower-start-turn') s.receive({ type: 'response', requestId: message.requestId, method: fault === 'method' ? 'other-method' : message.method, handledByClientId: fault === 'owner' ? 'forged-owner' : 'owner', resultType: 'success', result: { result: { turn: { id: fault === 'turn_id' ? 'invalid' : randomUUID() } } } });
    });
    const result = await runDesktopEchoIpc({ threadId, requestId: randomUUID(), signal: new AbortController().signal, deadline: Date.now() + 1000, beforeSend: () => { sends++; }, onStageTiming: (stage, ms) => { stages[stage] = ms; } }, { connect: () => socket as unknown as net.Socket });
    assert.deepEqual(result, { status: 'uncertain', reason: 'send_outcome_unknown' }); assert.equal(sends, 1);
    assert.equal(socket.frames.filter(value => value.method === 'thread-follower-start-turn').length, 1);
    assert.deepEqual(Object.keys(stages), ['owner_lookup', 'send_ack']);
    assert(Object.values(stages).every(ms => Number.isFinite(ms) && ms >= 0));
  }
});
test('same verified snapshot binds optional rollout metadata before the start; no path is guessed', async () => {
  const rolloutPath = String.raw`\\?\C:\synthetic\sessions\rollout.jsonl`;
  const f = setup('idle', { rolloutPath }); assert.equal((await f.run()).status, 'accepted'); assert.deepEqual(f.metadata, [{ threadId: f.threadId, rolloutPath }]);
  const missing = setup(); assert.equal((await missing.run()).status, 'accepted'); assert.deepEqual(missing.metadata, [{ threadId: missing.threadId }]);
  const forged = setup('wrong_owner', { rolloutPath }); assert.equal((await forged.run()).status, 'skipped_unknown'); assert.deepEqual(forged.metadata, []);
});
test('read probe retains the verified optional rollout path only in its internal DTO and never sends', async () => {
  const rolloutPath = String.raw`C:\synthetic\sessions\rollout.jsonl`, f = setup('idle', { rolloutPath });
  const result = await runDesktopReadIpc({ threadId: f.threadId, signal: f.controller.signal, deadline: Date.now() + 150 }, { connect: () => f.socket as unknown as net.Socket });
  assert.equal(result.status, 'ready'); if (result.status !== 'ready') return; assert.equal(result.rolloutPath, rolloutPath); assert(!Object.hasOwn(result.history, 'rolloutPath')); assert.equal(f.sends(), 0); assert(!f.socket.frames.some(value => value.method === 'thread-follower-start-turn')); assert.equal(f.socket.closed, true);
});
test('start ACK arriving after two seconds is accepted once within its fifteen-second budget', async () => {
  const f = setup('idle', { ackDelayMs: 2100, deadlineMs: 20000 });
  const result = await f.run(); assert.deepEqual(result, { status: 'accepted', turnId: f.turnId });
  assert.equal(f.sends(), 1); assert.equal(f.socket.frames.filter(value => value.method === 'thread-follower-start-turn').length, 1);
  const start = f.socket.frames.find(value => value.method === 'thread-follower-start-turn'); assert.equal(start.timeoutMs, 15000); assert.equal(start.params.turnStart.request.input[0].text, fixedEchoPrompt(f.requestId));
  assert.equal(f.socket.frames.find(value => value.method === 'initialize').timeoutMs, 2000);
  assert.equal(f.socket.frames.find(value => value.method === 'thread-owner-discovery').timeoutMs, 12000); assert.equal(f.socket.closed, true);
});
test('owner discovery after two seconds succeeds within its twelve-second budget and starts once', async () => {
  const f = setup('idle', { ownerDelayMs: 2100, deadlineMs: 20000 });
  assert.deepEqual(await f.run(), { status: 'accepted', turnId: f.turnId });
  assert.equal(f.socket.frames.find(value => value.method === 'initialize').timeoutMs, 2000);
  assert.equal(f.socket.frames.find(value => value.method === 'thread-owner-discovery').timeoutMs, 12000);
  assert.equal(f.sends(), 1); assert.equal(f.socket.frames.filter(value => value.method === 'thread-owner-discovery').length, 1);
  assert.equal(f.socket.frames.filter(value => value.method === 'thread-follower-start-turn').length, 1); assert.equal(f.socket.closed, true);
});
test('explicit no-client-found after the router ten-second wait remains native_owner_unavailable without sending', async () => {
  const f = setup('idle', { ownerDelayMs: 10010, ownerError: 'no-client-found', deadlineMs: 20000 });
  assert.deepEqual(await f.run(), { status: 'skipped_unknown', reason: 'native_owner_unavailable' });
  assert.equal(f.sends(), 0); assert.equal(f.socket.frames.filter(value => value.method === 'thread-owner-discovery').length, 1);
  assert(!f.socket.frames.some(value => ['thread-stream-following-changed', 'thread-follower-start-turn'].includes(value.method))); assert.equal(f.socket.closed, true);
});
test('owner discovery still obeys a shorter overall deadline or abort without retry or send', async () => {
  for (const cause of ['deadline', 'signal'] as const) {
    const f = setup('owner_timeout', { deadlineMs: cause === 'deadline' ? 80 : 20000 }); const startedAt = Date.now(), pending = f.run();
    const timer = cause === 'signal' ? setTimeout(() => f.controller.abort(), 20) : undefined;
    try {
      assert.deepEqual(await pending, { status: 'skipped_unknown', reason: 'ipc_aborted' }); assert(Date.now() - startedAt < 2000);
      const discovery = f.socket.frames.filter(value => value.method === 'thread-owner-discovery'); assert.equal(discovery.length, 1);
      assert(discovery[0].timeoutMs > 0); assert(discovery[0].timeoutMs <= (cause === 'deadline' ? 80 : 12000));
      assert.equal(f.sends(), 0); assert(!f.socket.frames.some(value => ['thread-stream-following-changed', 'thread-follower-start-turn'].includes(value.method))); assert.equal(f.socket.closed, true);
    } finally { clearTimeout(timer); }
  }
});
test('real ACK timeout obeys the overall deadline, closes, and a late ACK never retransmits', async () => {
  const f = setup('ack_timeout', { deadlineMs: 80 }); const result = await f.run();
  assert.deepEqual(result, { status: 'uncertain', reason: 'send_outcome_unknown' }); assert.equal(f.sends(), 1); assert.equal(f.socket.closed, true);
  const start = f.socket.frames.find(value => value.method === 'thread-follower-start-turn'); assert(start.timeoutMs <= 80); assert(start.timeoutMs > 0);
  f.lateAck(); assert.equal(f.socket.frames.filter(value => value.method === 'thread-follower-start-turn').length, 1);
});
test('abort while awaiting a start ACK settles and closes without retransmission', async () => {
  const f = setup('ack_timeout', { deadlineMs: 20000 }); const pending = f.run(); const timer = setTimeout(() => f.controller.abort(), 20);
  try { assert.deepEqual(await pending, { status: 'uncertain', reason: 'send_outcome_unknown' }); assert.equal(f.sends(), 1); assert.equal(f.socket.closed, true); assert.equal(f.socket.frames.filter(value => value.method === 'thread-follower-start-turn').length, 1); }
  finally { clearTimeout(timer); }
});
test('offline connection skips, sanitized', async () => {
  const controller = new AbortController();
  const socket = new FakeSocket(() => {}, false); queueMicrotask(() => socket.emit('error', new Error('private path')));
  const result = await runDesktopEchoIpc({ threadId: randomUUID(), requestId: randomUUID(), signal: controller.signal, deadline: Date.now() + 100, beforeSend: () => assert.fail('must not send') }, { connect: () => socket as unknown as net.Socket });
  assert.deepEqual(result, { status: 'skipped_unreachable', reason: 'ipc_connect_unavailable' }); assert(!JSON.stringify(result).includes('private path'));
});

async function probeFailure(stopAt: 'initialize' | 'thread-owner-discovery' | 'thread-stream-following-changed', response: 'missing_owner' | 'secret_error' | 'invalid_error' | 'disconnect' | 'timeout') {
  const threadId = randomUUID(); let connections = 0;
  const socket = new FakeSocket((message, s) => {
    if (message.method === stopAt) {
      if (response === 'disconnect') s.destroy();
      else if (response !== 'timeout') s.receive({ type: 'response', requestId: message.requestId, resultType: response === 'invalid_error' ? 'invalid' : 'error', error: response === 'secret_error' ? 'C:\\private\\SECRET-body-token' : 'no-client-found' });
      return;
    }
    if (message.method === 'initialize') s.receive({ type: 'response', requestId: message.requestId, resultType: 'success', result: { clientId: 'follower' } });
    else if (message.method === 'thread-owner-discovery') s.receive({ type: 'response', requestId: message.requestId, resultType: 'success', handledByClientId: 'owner' });
  });
  const result = await runDesktopReadIpc({ threadId, signal: new AbortController().signal, deadline: Date.now() + (response === 'timeout' ? stopAt === 'thread-owner-discovery' ? 13000 : 3000 : 150) }, { connect: () => { connections++; return socket as unknown as net.Socket; } });
  assert.equal(connections, 1); assert.equal(socket.closed, true);
  assert(!socket.frames.some(value => value.method === 'thread-follower-start-turn'));
  assert(!JSON.stringify(result).includes('SECRET')); assert(!JSON.stringify(result).includes('private'));
  return result;
}
test('only an explicit owner-discovery no-client-found reports unavailable native owner', async () => {
  assert.deepEqual(await probeFailure('thread-owner-discovery', 'missing_owner'), { status: 'skipped_unknown', reason: 'native_owner_unavailable' });
  assert.deepEqual(await probeFailure('initialize', 'missing_owner'), { status: 'skipped_unknown', reason: 'ipc_initialize_failed' });
  assert.deepEqual(await probeFailure('thread-owner-discovery', 'invalid_error'), { status: 'skipped_unknown', reason: 'ipc_owner_discovery_failed' });
});
test('arbitrary remote error text is replaced with the fixed failed stage', async () => {
  assert.deepEqual(await probeFailure('initialize', 'secret_error'), { status: 'skipped_unknown', reason: 'ipc_initialize_failed' });
  assert.deepEqual(await probeFailure('thread-owner-discovery', 'secret_error'), { status: 'skipped_unknown', reason: 'ipc_owner_discovery_failed' });
});
test('owner and snapshot disconnects remain separate stages and never retry or send', async () => {
  assert.deepEqual(await probeFailure('thread-owner-discovery', 'disconnect'), { status: 'skipped_unknown', reason: 'ipc_owner_discovery_failed' });
  assert.deepEqual(await probeFailure('thread-stream-following-changed', 'disconnect'), { status: 'skipped_unknown', reason: 'ipc_snapshot_unavailable' });
});
test('owner query timeout and missing snapshot retain their failed stages', async () => {
  assert.deepEqual(await probeFailure('thread-owner-discovery', 'timeout'), { status: 'skipped_unknown', reason: 'ipc_owner_discovery_failed' });
  assert.deepEqual(await probeFailure('thread-stream-following-changed', 'timeout'), { status: 'skipped_unknown', reason: 'ipc_snapshot_unavailable' });
});
test('aborted read reports a fixed cancellation reason without connecting', async () => {
  const controller = new AbortController(), stages: string[] = []; controller.abort();
  const result = await runDesktopReadIpc({ threadId: randomUUID(), signal: controller.signal, deadline: Date.now() + 100, onStageTiming: stage => stages.push(stage) }, { connect: () => assert.fail('must not connect') });
  assert.deepEqual(result, { status: 'skipped_unknown', reason: 'ipc_aborted' }); assert.deepEqual(stages, []);
});
test('cancellation during connection retains ipc_aborted when socket close settles the wait', async () => {
  for (const cause of ['signal', 'deadline'] as const) {
    const controller = new AbortController(), socket = new FakeSocket(() => assert.fail('must not write'), false); let connections = 0;
    const timer = cause === 'signal' ? setTimeout(() => controller.abort(), 10) : undefined;
    try {
      const result = await runDesktopReadIpc({ threadId: randomUUID(), signal: controller.signal, deadline: Date.now() + (cause === 'signal' ? 1000 : 20) }, { connect: () => { connections++; return socket as unknown as net.Socket; } });
      assert.deepEqual(result, { status: 'skipped_unknown', reason: 'ipc_aborted' });
      assert.equal(connections, 1); assert.equal(socket.destroyed, true); assert.equal(socket.closed, true); assert.deepEqual(socket.frames, []);
    } finally { clearTimeout(timer); }
  }
});
test('connection close without cancellation remains a connection failure', async () => {
  const socket = new FakeSocket(() => assert.fail('must not write'), false); queueMicrotask(() => socket.destroy());
  const result = await runDesktopReadIpc({ threadId: randomUUID(), signal: new AbortController().signal, deadline: Date.now() + 1000 }, { connect: () => socket as unknown as net.Socket });
  assert.deepEqual(result, { status: 'skipped_unknown', reason: 'ipc_connect_unavailable' }); assert.equal(socket.closed, true); assert.deepEqual(socket.frames, []);
});
