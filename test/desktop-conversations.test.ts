import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, writeFileSync } from 'node:fs';
import { DesktopConversationsService, type DesktopConversationsOptions, type DesktopConversationsTransport, type DesktopConversationResult } from '../src/desktop-conversations.js';

// Synthetic IPC/log results only. No desktop connection or real rollout read.
function fixture(transport: DesktopConversationsTransport, options: DesktopConversationsOptions = {}) {
  const db = new Database(':memory:'), thread = randomUUID(), thread2 = randomUUID(), turn = randomUUID(), request = randomUUID();
  const path = join(tmpdir(), `never-opened-${thread}.jsonl`);
  const config = { enabled: true as const, targets: [{ thread_id: thread, rollout_path: path, title: '本机已核实标题' }, { thread_id: thread2, rollout_path: join(tmpdir(), `never-opened-${thread2}.jsonl`) }] };
  const service = new DesktopConversationsService(db, config, { timeoutMs: 100, transport, ...options });
  return { db, config, service, thread, thread2, turn, request, path, async cleanup() { await service.close(); db.close(); } };
}
const noRead: DesktopConversationsTransport['runRead'] = async () => { assert.fail('unexpected read'); };
const noSend: DesktopConversationsTransport['runSend'] = async () => { assert.fail('unexpected send'); };
const storedRead = (id: string, text = '保留原文🌟') => ({ status: 'completed' as const, verification: 'native_stored_history' as const, history_source: 'codex_app_server' as const, stored_history_complete: true as const, source_complete: false as const,
  context_json: JSON.stringify({ thread: { id, status: { type: 'notLoaded' }, turns: [{ id: randomUUID(), itemsView: 'full', items: [{ type: 'agentMessage', text }] }] }, turns_source: 'thread/turns/list:full' }) });
function localFixture(transport: DesktopConversationsTransport, capabilities = { read: true, send: true }) {
  const db = new Database(':memory:'), thread = randomUUID(), thread2 = randomUUID(), request = randomUUID(), turn = randomUUID();
  const home = join(tmpdir(), `never-opened-codex-${randomUUID()}`);
  const config = { enabled: true, mode: 'local', codex_home: home, ...capabilities };
  const service = new DesktopConversationsService(db, config, { transport, timeoutMs: 1000 });
  const resolved = (id = thread) => ({ thread_id: id, rollout_path: join(home, 'sessions', `rollout-${id}.jsonl`) });
  return { db, config, service, thread, thread2, request, turn, home, resolved, async cleanup() { await service.close(); db.close(); } };
}
async function finish(f: ReturnType<typeof fixture>, request_id = f.request): Promise<DesktopConversationResult> { return f.service.get({ request_id, wait_seconds: 1 }); }

test('local stored read binds home and exact ID without sender path, persists all pages and reopens without rereading', async () => {
  let calls = 0, f: ReturnType<typeof localFixture>, context: string | undefined;
  f = localFixture({ runSend: noSend, runRead: async input => { calls++; assert.equal(input.codexHome, f.home); const result = storedRead(input.threadId, '完整历史🌟'.repeat(20000)); context = result.context_json; return result; } });
  let reopened: DesktopConversationsService | undefined;
  try {
    f.service.read({ request_id: f.request, thread_id: f.thread }); const first = await f.service.get({ request_id: f.request, wait_seconds: 1 });
    assert.equal(first.verification, 'native_stored_history'); assert.equal(first.history_source, 'codex_app_server'); assert.equal(first.stored_history_complete, true); assert.equal(first.source_complete, false); assert.equal(Object.hasOwn(first, 'desktop_state'), false);
    const durable = JSON.parse((f.db.prepare('SELECT data FROM desktop_conversation_requests WHERE request_id=?').get(f.request) as { data: string }).data);
    assert.equal(Object.hasOwn(durable, 'resolved_target'), false); assert.equal(durable.sent, false);
    await f.service.close(); reopened = new DesktopConversationsService(f.db, f.config, { transport: { runRead: noRead, runSend: noSend } });
    let offset: number | null = 0, combined = '';
    while (offset !== null) {
      const page = await reopened.get({ request_id: f.request, offset }); combined += page.context_chunk; offset = page.next_offset!;
      assert.equal(page.verification, first.verification); assert.equal(page.history_source, 'codex_app_server'); assert.equal(page.stored_history_complete, true); assert.equal(page.receipt_nonce, first.receipt_nonce); assert.equal(page.context_sha256, first.context_sha256); assert.equal(Object.hasOwn(page, 'desktop_state'), false);
    }
    assert.equal(combined, context); assert.equal(reopened.read({ request_id: f.request, thread_id: f.thread }).context_chunk, first.context_chunk); assert.equal(calls, 1);
  } finally { await reopened?.close(); await f.cleanup(); }
});
test('local stored read stays independent while sends retain per-thread busy reservations', async () => {
  let release!: () => void, sends = 0, f: ReturnType<typeof localFixture>;
  f = localFixture({ runRead: async input => storedRead(input.threadId), runSend: async input => {
    sends++; input.onResolvedTarget?.(f.resolved()); input.beforeSend(); input.onAccepted(f.turn); await new Promise<void>(resolve => { release = resolve; }); return { status: 'completed', turn_id: f.turn, reply: 'fresh reply' };
  } });
  try {
    f.service.send({ request_id: f.request, thread_id: f.thread, text: 'first' }); await new Promise(resolve => setImmediate(resolve));
    const readId = randomUUID(); assert.equal(f.service.read({ request_id: readId, thread_id: f.thread }).status, 'pending'); assert.equal((await f.service.get({ request_id: readId, wait_seconds: 1 })).verification, 'native_stored_history');
    const blocked = f.service.send({ request_id: randomUUID(), thread_id: f.thread, text: 'second' }); assert.equal(blocked.status, 'skipped_busy'); assert.equal(sends, 1);
    release(); assert.equal((await f.service.get({ request_id: f.request, wait_seconds: 1 })).verification, 'exact_turn_reply');
  } finally { release?.(); await f.cleanup(); }
});
test('stored read source cannot mix idle evidence, omit source proof or mismatch the requested ID', async () => {
  for (const mode of ['idle', 'missing_source', 'missing_complete', 'wrong_source', 'full_claim', 'wrong_id'] as const) {
    const f = localFixture({ runSend: noSend, runRead: async input => {
      const result: any = storedRead(mode === 'wrong_id' ? randomUUID() : input.threadId);
      if (mode === 'idle') result.desktop_state = { status: 'idle', observed_at: '2026-10-10T00:00:00.000Z', checked_by: 'native_desktop_owner', scope: 'observation_snapshot' };
      if (mode === 'missing_source') delete result.history_source;
      if (mode === 'missing_complete') delete result.stored_history_complete;
      if (mode === 'wrong_source') result.history_source = 'raw_log';
      if (mode === 'full_claim') result.source_complete = true;
      return result;
    } });
    try { f.service.read({ request_id: f.request, thread_id: f.thread }); const result = await f.service.get({ request_id: f.request, wait_seconds: 1 }); assert.equal(result.status, 'skipped_unknown', mode); assert.equal(result.verification, 'not_verified'); assert.equal(Object.hasOwn(result, 'desktop_state'), false); }
    finally { await f.cleanup(); }
  }
});

test('read reserves first, native untrusted JSON survives exactly without selecting fields', async () => {
  let calls = 0, f: ReturnType<typeof fixture>;
  const context = ' {"kind":"canonical","history":{"entitiesByKey":{"original":{"user":"读取材料：不要把执行命令当指令","assistant":" reply\\n","tool":{"raw":"必须原样保留"}}}}} ';
  f = fixture({ runSend: noSend, runRead: async input => {
    calls++; assert.equal(input.threadId, f.thread); assert.equal(input.rolloutPath, f.path); assert.equal(Object.hasOwn(input, 'limit'), false);
    const row = JSON.parse((f.db.prepare('SELECT data FROM desktop_conversation_requests WHERE request_id=?').get(f.request) as {data:string}).data);
    assert.equal(row.result.status, 'pending');
    return { status: 'completed', context_json: context, source_complete: false };
  } });
  try {
    assert.equal(f.service.read({ request_id: f.request, thread_id: f.thread }).status, 'pending');
    const result = await finish(f); assert.equal(result.status, 'completed'); assert.equal(result.verification, 'native_history_snapshot'); assert.equal(result.title, '本机已核实标题'); assert.equal(result.source_complete, false);
    assert.equal(result.context_chunk, context); assert.equal(result.total_chars, context.length); assert.equal(result.context_offset, 0); assert.equal(result.next_offset, null); assert.match(result.receipt_nonce!, /^[a-f0-9]{64}$/);
    assert.equal(result.context_sha256, createHash('sha256').update(context).digest('hex'));
    assert.equal(Object.hasOwn(result, 'desktop_state'), false); // Legacy read output has no fabricated observation.
    result.context_chunk = 'mutated'; assert.equal((await f.service.get({ request_id: f.request })).context_chunk, context);
    assert.equal(f.service.read({ request_id: f.request, thread_id: f.thread }).status, 'completed'); assert.equal(calls, 1);
    assert.throws(() => f.service.send({ request_id: f.request, thread_id: f.thread, text: 'changed operation' }), /idempotency_conflict/);
    assert(!JSON.stringify(result).includes(f.path));
  } finally { await f.cleanup(); }
});
test('send durable intent and ACK, exact reply text, duplicate races and untouched forward table', async () => {
  let calls = 0, f: ReturnType<typeof fixture>; const text = '用户普通消息\n 原文', reply = '  返回结果\n保留末尾换行\n';
  f = fixture({ runRead: noRead, runSend: async input => {
    calls++; assert.equal(input.text, text); assert.equal(input.requestId, f.request); input.beforeSend();
    let stored = JSON.parse((f.db.prepare('SELECT data FROM desktop_conversation_requests WHERE request_id=?').get(f.request) as {data:string}).data); assert.equal(stored.sent, true); assert.match(stored.sent_at, /^\d{4}-/);
    input.onAccepted(f.turn); stored = JSON.parse((f.db.prepare('SELECT data FROM desktop_conversation_requests WHERE request_id=?').get(f.request) as {data:string}).data); assert.equal(stored.accepted_turn_id, f.turn);
    return { status: 'completed', turn_id: f.turn, reply };
  } });
  f.db.exec("CREATE TABLE tasks(id TEXT,data TEXT); INSERT INTO tasks VALUES('forward','unchanged')"); const before = f.db.prepare('SELECT * FROM tasks').all();
  try {
    const initial = Array.from({ length: 16 }, () => f.service.send({ request_id: f.request, thread_id: f.thread, text })); assert(initial.every(result => result.status === 'pending'));
    const result = await finish(f); assert.equal(result.status, 'completed'); assert.equal(result.reply, reply); assert.equal(result.turn_id, f.turn); assert.equal(result.verification, 'exact_turn_reply'); assert.match(result.receipt_nonce!, /^[a-f0-9]{64}$/); assert.equal(calls, 1);
    assert.throws(() => f.service.send({ request_id: f.request, thread_id: f.thread, text: text + 'extra' }), /idempotency_conflict/);
    assert.throws(() => f.service.send({ request_id: f.request, thread_id: f.thread2, text }), /idempotency_conflict/);
    assert.deepEqual(f.db.prepare('SELECT * FROM tasks').all(), before); assert(!JSON.stringify(result).includes(f.path));
  } finally { await f.cleanup(); }
});
test('strict allowlist and schemas reject arbitrary paths, extra arguments and sizes', async () => {
  const f = fixture({ runRead: noRead, runSend: noSend });
  try {
    assert.throws(() => f.service.read({ request_id: randomUUID(), thread_id: randomUUID() }), /thread_not_allowed/);
    assert.throws(() => f.service.read({ request_id: f.request, thread_id: f.thread, rollout_path: 'other' } as any), /invalid_request/);
    assert.throws(() => f.service.read({ request_id: f.request, thread_id: f.thread, limit: 3 } as any), /invalid_request/);
    assert.throws(() => f.service.send({ request_id: f.request, thread_id: f.thread, text: '' }), /invalid_request/);
    assert.throws(() => f.service.send({ request_id: f.request, thread_id: f.thread, text: 'message', desktop_state: { status: 'idle' } } as any), /invalid_request/);
    assert.throws(() => f.service.send({ request_id: f.request, thread_id: f.thread, text: 'x'.repeat(8001) }), /invalid_request/);
    await assert.rejects(f.service.get({ request_id: f.request, wait_seconds: 21 }), /invalid_request/);
    await assert.rejects(f.service.get({ request_id: f.request, thread_id: f.thread } as any), /invalid_request/);
    assert.throws(() => new DesktopConversationsService(f.db, { enabled: true, targets: [f.config.targets[0], f.config.targets[0]] }), /invalid_config/);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM desktop_conversation_requests').get() && (f.db.prepare('SELECT count(*) AS n FROM desktop_conversation_requests').get() as {n:number}).n, 0);
  } finally { await f.cleanup(); }
});
for (const status of ['skipped_busy', 'skipped_unknown', 'skipped_unreachable'] as const) test(`${status} is a permanent terminal receipt without retransmit`, async () => {
  let calls = 0; const f = fixture({ runRead: noRead, runSend: async () => { calls++; return { status, reason: 'ipc_unavailable' }; } });
  try { f.service.send({ request_id: f.request, thread_id: f.thread, text: 'message' }); const result = await finish(f); assert.equal(result.status, status); assert.equal(result.receipt_nonce, undefined); assert.equal(f.service.send({ request_id: f.request, thread_id: f.thread, text: 'message' }).status, status); assert.equal(calls, 1); }
  finally { await f.cleanup(); }
});
test('per-thread sends reject concurrent work; different threads remain independent', async () => {
  let resolve!: () => void, calls = 0, f: ReturnType<typeof fixture>;
  f = fixture({ runRead: async () => ({ status: 'completed', context_json: '{}', source_complete: false }), runSend: async input => { calls++; input.beforeSend(); input.onAccepted(f.turn); await new Promise<void>(done => { if (input.threadId === f.thread) resolve = done; else done(); }); return { status: 'completed', turn_id: f.turn, reply: input.text }; } });
  try {
    f.service.send({ request_id: f.request, thread_id: f.thread, text: 'first' }); const secondId = randomUUID(); assert.equal(f.service.send({ request_id: secondId, thread_id: f.thread, text: 'second' }).status, 'skipped_busy');
    const readId = randomUUID(); assert.equal(f.service.read({ request_id: readId, thread_id: f.thread }).status, 'pending'); assert.equal((await finish(f, readId)).status, 'completed');
    const otherId = randomUUID(); f.service.send({ request_id: otherId, thread_id: f.thread2, text: 'parallel' }); assert.equal((await finish(f, otherId)).status, 'completed'); resolve(); assert.equal((await finish(f)).status, 'completed'); assert.equal(calls, 2);
    assert.equal(f.service.send({ request_id: secondId, thread_id: f.thread, text: 'second' }).status, 'skipped_busy');
  } finally { resolve?.(); await f.cleanup(); }
});
test('ACK loss and transport errors are uncertain, with no raw error leakage or retry', async () => {
  let calls = 0; const f = fixture({ runRead: noRead, runSend: async input => { calls++; input.beforeSend(); throw Object.assign(new Error('secret absolute path and raw protocol'), { code: 'secret_code' }); } });
  try { f.service.send({ request_id: f.request, thread_id: f.thread, text: 'message' }); const result = await finish(f); assert.equal(result.status, 'uncertain'); assert.equal(result.verification, 'not_verified'); assert.equal(result.receipt_nonce, undefined); assert(!JSON.stringify(result).includes('secret')); f.service.send({ request_id: f.request, thread_id: f.thread, text: 'message' }); assert.equal(calls, 1); }
  finally { await f.cleanup(); }
});
test('wrong ACK turn, missing callbacks and oversized reply cannot become completed', async () => {
  for (const mode of ['wrong_turn', 'no_ack', 'no_intent', 'large_reply'] as const) {
    let f: ReturnType<typeof fixture>; f = fixture({ runRead: noRead, runSend: async input => { if (mode !== 'no_intent') input.beforeSend(); if (!['no_ack', 'no_intent'].includes(mode)) input.onAccepted(f.turn); return { status: 'completed', turn_id: mode === 'wrong_turn' ? randomUUID() : f.turn, reply: mode === 'large_reply' ? 'x'.repeat(32001) : 'reply' }; } });
    try { f.service.send({ request_id: f.request, thread_id: f.thread, text: 'message' }); const result = await finish(f); assert.equal(result.status, mode === 'no_intent' ? 'skipped_unknown' : 'uncertain'); assert.equal(result.receipt_nonce, undefined); if (mode === 'large_reply') assert.equal(result.reason, 'reply_too_large'); }
    finally { await f.cleanup(); }
  }
});
test('native context schema rejects oversize, invalid JSON, missing completeness and transport fields', async () => {
  for (const mode of ['oversize', 'invalid_json', 'missing_flag', 'extra', 'malformed_unicode'] as const) {
    const context = mode === 'oversize' ? JSON.stringify({ text: 'x'.repeat(32 * 1024 * 1024) }) : mode === 'invalid_json' ? '{broken' : mode === 'malformed_unicode' ? '{"text":"\ud800"}' : '{}';
    const f = fixture({ runSend: noSend, runRead: async () => ({ status: 'completed', context_json: context, ...(mode === 'missing_flag' ? {} : { source_complete: true }), ...(mode === 'extra' ? { connectionId: 'private transport' } : {}) } as any) }, { timeoutMs: 1000 });
    try { f.service.read({ request_id: f.request, thread_id: f.thread }); const result = await finish(f); assert.equal(result.status, 'skipped_unknown', mode); assert.equal(result.receipt_nonce, undefined); if (mode === 'oversize') assert.equal(result.reason, 'context_too_large'); }
    finally { await f.cleanup(); }
  }
});

test('read evidence rejects non-native, non-idle, malformed time and authority claims', async () => {
  const baseline = { status: 'idle', observed_at: '2026-10-10T00:00:00.000Z', checked_by: 'native_desktop_owner', scope: 'observation_snapshot' };
  for (const desktop_state of [
    { ...baseline, status: 'busy' }, { ...baseline, status: 'unknown' }, { ...baseline, checked_by: 'remote_caller' },
    { ...baseline, observed_at: 'yesterday' }, { ...baseline, observed_at: '2026-02-30T00:00:00.000Z' },
    { ...baseline, scope: 'atomic_idle_lock' }, { ...baseline, grants_permission: true },
  ]) {
    const f = fixture({ runSend: noSend, runRead: async () => ({ status: 'completed', context_json: '{}', source_complete: false, desktop_state } as any) });
    try { f.service.read({ request_id: f.request, thread_id: f.thread }); const result = await finish(f); assert.equal(result.status, 'skipped_unknown'); assert.equal(result.reason, 'invalid_transport_result'); assert.equal(Object.hasOwn(result, 'desktop_state'), false); }
    finally { await f.cleanup(); }
  }
});
test('all native snapshot pages concatenate losslessly, preserve surrogate pairs and resume after restart', async () => {
  // Put an emoji across the nominal first page boundary (high surrogate at 31999).
  const context = '{"text":"' + 'a'.repeat(31999 - 9) + '😀' + '中'.repeat(40000) + '","extra":{"raw":"preserved"}}';
  let calls = 0; const f = fixture({ runSend: noSend, runRead: async () => { calls++; return { status: 'completed', context_json: context, source_complete: true }; } }, { timeoutMs: 1000 });
  let recovered: DesktopConversationsService | undefined;
  try {
    f.service.read({ request_id: f.request, thread_id: f.thread }); const first = await finish(f); assert.equal(first.context_chunk!.length, 31999); assert.equal(first.next_offset, 31999); assert.equal(first.source_complete, true);
    await assert.rejects(f.service.get({ request_id: f.request, offset: 32000 }), /invalid_offset/);
    await f.service.close(); recovered = new DesktopConversationsService(f.db, f.config, { transport: { runRead: noRead, runSend: noSend } });
    let offset = first.next_offset!, assembled = first.context_chunk!;
    while (offset !== null) {
      const page = await recovered.get({ request_id: f.request, offset }); assert.equal(page.context_offset, offset); assert(page.context_chunk!.length <= 32000); assert.equal(page.context_chunk!.isWellFormed(), true); assert.equal(page.receipt_nonce, first.receipt_nonce); assert.equal(page.context_sha256, first.context_sha256); assert.equal(page.total_chars, context.length);
      assert.equal(Object.hasOwn(page, 'desktop_state'), false); // Older durable reads stay compatible after restart.
      assembled += page.context_chunk; offset = page.next_offset!;
    }
    assert.equal(assembled, context); assert.deepEqual(JSON.parse(assembled), JSON.parse(context)); assert.equal(calls, 1);
    assert.equal(recovered.read({ request_id: f.request, thread_id: f.thread }).context_chunk, first.context_chunk);
    const final = await recovered.get({ request_id: f.request, offset: context.length }); assert.equal(final.context_chunk, ''); assert.equal(final.next_offset, null);
    await assert.rejects(recovered.get({ request_id: f.request, offset: context.length + 1 }), /invalid_offset/);
    await assert.rejects(recovered.get({ request_id: f.request, offset: -1 }), /invalid_request/);
    await assert.rejects(recovered.get({ request_id: f.request, offset: 1.5 }), /invalid_request/);
  } finally { await recovered?.close(); await f.cleanup(); }
});
test('offset is only valid for completed reads and cannot change an existing request operation', async () => {
  let resolve!: () => void; const f = fixture({ runSend: async input => { input.beforeSend(); input.onAccepted(randomUUID()); return { status: 'uncertain', reason: 'send_outcome_unknown' }; }, runRead: async () => { await new Promise<void>(done => { resolve = done; }); return { status: 'completed', context_json: '{}', source_complete: false }; } }, { timeoutMs: 1000 });
  try {
    f.service.read({ request_id: f.request, thread_id: f.thread }); await new Promise(done => setTimeout(done, 1)); await assert.rejects(f.service.get({ request_id: f.request, offset: 0 }), /offset_not_available/); resolve(); await finish(f);
    const sendId = randomUUID(); f.service.send({ request_id: sendId, thread_id: f.thread, text: 'message' }); await finish(f, sendId); await assert.rejects(f.service.get({ request_id: sendId, offset: 0 }), /offset_not_available/);
    assert.throws(() => f.service.send({ request_id: f.request, thread_id: f.thread, text: 'operation changed' }), /idempotency_conflict/);
  } finally { resolve?.(); await f.cleanup(); }
});
test('bounded get returns pending, shutdown aborts and settles before db.close', async () => {
  let aborted = 0; const f = fixture({ runRead: noRead, runSend: async input => { input.beforeSend(); await new Promise<void>(resolve => input.signal.addEventListener('abort', () => { aborted++; resolve(); }, { once: true })); return { status: 'uncertain', reason: 'closed' }; } }, { timeoutMs: 1000 });
  try {
    f.service.send({ request_id: f.request, thread_id: f.thread, text: 'message' }); assert.equal((await f.service.get({ request_id: f.request, wait_seconds: 0.005 })).status, 'pending');
    await f.service.close(); assert.equal(aborted, 1); assert.equal((await f.service.get({ request_id: f.request })).status, 'uncertain');
    assert.throws(() => f.service.send({ request_id: randomUUID(), thread_id: f.thread, text: 'new' }), /desktop_conversations_closed/); await f.service.close();
  } finally { await f.cleanup(); }
});
test('restart pending is reconciliation_required and never reconnects; target binding remains fixed', async () => {
  const f = fixture({ runRead: noRead, runSend: async () => ({ status: 'skipped_unknown', reason: 'ipc_unavailable' }) });
  try {
    f.service.send({ request_id: f.request, thread_id: f.thread, text: 'message' }); await finish(f); await f.service.close();
    const stored = JSON.parse((f.db.prepare('SELECT data FROM desktop_conversation_requests WHERE request_id=?').get(f.request) as {data:string}).data); stored.sent = true; stored.accepted_turn_id = f.turn; stored.result.status = 'pending'; f.db.prepare('UPDATE desktop_conversation_requests SET data=? WHERE request_id=?').run(JSON.stringify(stored), f.request);
    const recovered = new DesktopConversationsService(f.db, f.config, { transport: { runRead: noRead, runSend: noSend } });
    assert.equal((await recovered.get({ request_id: f.request })).status, 'reconciliation_required'); assert.equal(recovered.send({ request_id: f.request, thread_id: f.thread, text: 'message' }).status, 'reconciliation_required'); await recovered.close();
    const changed = new DesktopConversationsService(f.db, { enabled: true, targets: [{ thread_id: f.thread, rollout_path: join(tmpdir(), 'different.jsonl') }] }); await assert.rejects(changed.get({ request_id: f.request }), /request_binding_conflict/); await changed.close();
  } finally { await f.cleanup(); }
});
test('database failure leaves pending rather than exposing in-memory completion', async () => {
  let calls = 0, f: ReturnType<typeof fixture>; f = fixture({ runSend: noSend, runRead: async () => { calls++; return { status: 'completed', context_json: '{"full":"unchanged"}', source_complete: true }; } });
  try {
    f.db.exec("CREATE TRIGGER reject_update BEFORE UPDATE ON desktop_conversation_requests BEGIN SELECT RAISE(FAIL,'private db error'); END;");
    f.service.read({ request_id: f.request, thread_id: f.thread }); const result = await finish(f); assert.equal(result.status, 'pending'); assert.equal(result.receipt_nonce, undefined); assert.equal(f.service.read({ request_id: f.request, thread_id: f.thread }).status, 'pending'); assert.equal(calls, 1);
  } finally { await f.cleanup(); }
});
test('unconfigured service is disabled and same db cannot host two active executors', async () => {
  const f = fixture({ runRead: noRead, runSend: noSend });
  try { assert.throws(() => new DesktopConversationsService(f.db, f.config), /desktop_conversations_already_open/); await f.service.close(); const disabled = new DesktopConversationsService(f.db); assert.equal(disabled.enabled, false); await assert.rejects(disabled.get({ request_id: f.request }), /desktop_conversations_disabled/); await disabled.close(); }
  finally { await f.cleanup(); }
});

test('local mode accepts arbitrary own thread IDs, persists native resolution before send and separates request identity', async () => {
  let f: ReturnType<typeof localFixture>, reads = 0, sends = 0;
  f = localFixture({ runRead: async input => {
    reads++; assert.equal(input.rolloutPath, undefined); assert.equal(input.codexHome, f.home);
    input.onResolvedTarget!(f.resolved(input.threadId)); input.onResolvedTarget!(f.resolved(input.threadId));
    return { status: 'completed', context_json: JSON.stringify({ thread: input.threadId }), source_complete: true };
  }, runSend: async input => {
    sends++; input.onResolvedTarget!(f.resolved(input.threadId));
    const stored = JSON.parse((f.db.prepare('SELECT data FROM desktop_conversation_requests WHERE request_id=?').get(input.requestId) as { data: string }).data);
    assert.deepEqual(stored.resolved_target, f.resolved(input.threadId)); assert.equal(stored.sent, false);
    input.beforeSend(); input.onAccepted(f.turn); return { status: 'completed', turn_id: f.turn, reply: input.text };
  } });
  try {
    assert.deepEqual(f.service.accessStatus, { enabled: true, mode: 'local', read: true, send: true });
    for (const id of [f.thread, f.thread2]) {
      const request_id = randomUUID(); f.service.read({ request_id, thread_id: id });
      assert.equal(f.service.read({ request_id, thread_id: id }).status, 'pending');
      assert.equal((await f.service.get({ request_id, wait_seconds: 1 })).context_chunk, JSON.stringify({ thread: id }));
    }
    f.service.send({ request_id: f.request, thread_id: f.thread2, text: 'explicit user text' });
    assert.equal((await f.service.get({ request_id: f.request, wait_seconds: 1 })).reply, 'explicit user text');
    assert.equal(f.service.send({ request_id: f.request, thread_id: f.thread2, text: 'explicit user text' }).status, 'completed');
    assert.throws(() => f.service.send({ request_id: f.request, thread_id: f.thread, text: 'explicit user text' }), /idempotency_conflict/);
    assert.throws(() => f.service.send({ request_id: f.request, thread_id: f.thread2, text: 'changed' }), /idempotency_conflict/);
    assert.equal(reads, 2); assert.equal(sends, 1);
  } finally { await f.cleanup(); }
});

test('local read and send capabilities require explicit independent opt-in; remote target claims stay rejected', async () => {
  for (const capabilities of [{ read: true, send: false }, { read: false, send: true }]) {
    const f = localFixture({ runRead: async () => ({ status: 'skipped_busy', reason: 'runtime_not_idle' }), runSend: async () => ({ status: 'skipped_busy', reason: 'runtime_not_idle' }) }, capabilities);
    try {
      if (capabilities.read) assert.throws(() => f.service.send({ request_id: f.request, thread_id: f.thread, text: 'message' }), /desktop_conversations_send_disabled/);
      else assert.throws(() => f.service.read({ request_id: f.request, thread_id: f.thread }), /desktop_conversations_read_disabled/);
      for (const extra of [{ rollout_path: f.resolved().rollout_path }, { codex_home: f.home }, { desktop_state: { status: 'idle' } }]) {
        assert.throws(() => f.service.read({ request_id: f.request, thread_id: f.thread, ...extra } as any), /invalid_request/);
        assert.throws(() => f.service.send({ request_id: f.request, thread_id: f.thread, text: 'message', ...extra } as any), /invalid_request/);
      }
      assert.deepEqual(f.service.accessStatus, { enabled: true, mode: 'local', ...capabilities });
    } finally { await f.cleanup(); }
  }
  for (const config of [
    { enabled: true, mode: 'local', codex_home: tmpdir(), read: false, send: false },
    { enabled: true, mode: 'local', codex_home: tmpdir(), read: true },
    { enabled: true, mode: 'local', codex_home: 'relative', read: true, send: true },
    { enabled: true, mode: 'local', codex_home: tmpdir(), read: true, send: true, targets: [] },
    { enabled: false, mode: 'local', codex_home: tmpdir(), read: true, send: false },
    { enabled: false, mode: 'local', codex_home: tmpdir(), read: false, send: true },
  ]) {
    const db = new Database(':memory:'); try { assert.throws(() => new DesktopConversationsService(db, config), /invalid_config/); } finally { db.close(); }
  }
});

test('local resolution cannot switch path or identity, leave home, or omit resolution before completed read/send', async () => {
  for (const mode of ['change', 'wrong_thread', 'relative', 'outside', 'missing_read', 'missing_send'] as const) {
    let f: ReturnType<typeof localFixture>;
    f = localFixture({ runRead: async input => {
      if (mode === 'missing_read') return { status: 'completed', context_json: '{}', source_complete: true };
      const target = f.resolved(input.threadId);
      if (mode === 'change') { input.onResolvedTarget!(target); input.onResolvedTarget!({ ...target, rollout_path: join(f.home, 'sessions', 'different.jsonl') }); }
      else input.onResolvedTarget!({ thread_id: mode === 'wrong_thread' ? f.thread2 : input.threadId, rollout_path: mode === 'relative' ? 'relative.jsonl' : mode === 'outside' ? join(tmpdir(), 'outside.jsonl') : target.rollout_path });
      return { status: 'completed', context_json: '{}', source_complete: true };
    }, runSend: async input => { input.beforeSend(); assert.fail('unresolved send must not proceed'); } });
    try {
      if (mode === 'missing_send') f.service.send({ request_id: f.request, thread_id: f.thread, text: 'message' }); else f.service.read({ request_id: f.request, thread_id: f.thread });
      const result = await f.service.get({ request_id: f.request, wait_seconds: 1 }); assert.equal(result.status, 'skipped_unknown', mode); assert.equal(result.reason, 'invalid_transport_result', mode);
      const stored = JSON.parse((f.db.prepare('SELECT data FROM desktop_conversation_requests WHERE request_id=?').get(f.request) as { data: string }).data);
      assert.equal(stored.sent, false); if (mode === 'change') assert.deepEqual(stored.resolved_target, f.resolved());
    } finally { await f.cleanup(); }
  }
});

test('local read paging and replay survive offline restart without native resolution; connection root stays bound', async () => {
  const context = JSON.stringify({ text: '未筛选原文🌟'.repeat(15000) }); let f: ReturnType<typeof localFixture>, calls = 0;
  f = localFixture({ runSend: noSend, runRead: async input => { calls++; input.onResolvedTarget!(f.resolved()); return { status: 'completed', context_json: context, source_complete: true }; } });
  let recovered: DesktopConversationsService | undefined;
  try {
    f.service.read({ request_id: f.request, thread_id: f.thread }); const first = await f.service.get({ request_id: f.request, wait_seconds: 1 }); assert(first.next_offset);
    await f.service.close(); recovered = new DesktopConversationsService(f.db, f.config, { transport: { runRead: noRead, runSend: noSend } });
    assert.equal(recovered.read({ request_id: f.request, thread_id: f.thread }).receipt_nonce, first.receipt_nonce);
    let offset: number | null = 0, assembled = '';
    while (offset !== null) { const page = await recovered.get({ request_id: f.request, offset }); assembled += page.context_chunk; offset = page.next_offset!; }
    assert.equal(assembled, context); assert.equal(calls, 1); await recovered.close();
    recovered = new DesktopConversationsService(f.db, { ...f.config, codex_home: join(f.home, 'different') });
    await assert.rejects(recovered.get({ request_id: f.request }), /request_binding_conflict/);
  } finally { await recovered?.close(); await f.cleanup(); }
});

test('local uncertain and restart reconciliation receipts never resend or resolve a new path', async () => {
  let f: ReturnType<typeof localFixture>, sends = 0;
  f = localFixture({ runRead: noRead, runSend: async input => { sends++; input.onResolvedTarget!(f.resolved()); input.beforeSend(); return { status: 'uncertain', reason: 'send_outcome_unknown' }; } });
  let recovered: DesktopConversationsService | undefined;
  try {
    f.service.send({ request_id: f.request, thread_id: f.thread, text: 'message' }); assert.equal((await f.service.get({ request_id: f.request, wait_seconds: 1 })).status, 'uncertain');
    await f.service.close(); recovered = new DesktopConversationsService(f.db, f.config, { transport: { runRead: noRead, runSend: noSend } });
    assert.equal(recovered.send({ request_id: f.request, thread_id: f.thread, text: 'message' }).status, 'uncertain'); await recovered.close();
    const stored = JSON.parse((f.db.prepare('SELECT data FROM desktop_conversation_requests WHERE request_id=?').get(f.request) as { data: string }).data); stored.result.status = 'pending'; f.db.prepare('UPDATE desktop_conversation_requests SET data=? WHERE request_id=?').run(JSON.stringify(stored), f.request);
    recovered = new DesktopConversationsService(f.db, f.config, { transport: { runRead: noRead, runSend: noSend } });
    assert.equal(recovered.send({ request_id: f.request, thread_id: f.thread, text: 'message' }).status, 'reconciliation_required'); assert.equal(sends, 1);
  } finally { await recovered?.close(); await f.cleanup(); }
});

test('legacy targets validate old receipts after files disappear and never limit new local requests', async () => {
  const f = fixture({ runRead: async () => ({ status: 'completed', context_json: '{"old":"original"}', source_complete: true }), runSend: noSend });
  const home = join(tmpdir(), `not-opened-home-${randomUUID()}`); let recovered: DesktopConversationsService | undefined;
  try {
    writeFileSync(f.path, 'synthetic old file'); f.service.read({ request_id: f.request, thread_id: f.thread }); const first = await finish(f);
    await f.service.close(); rmSync(f.path);
    const config = { enabled: true, mode: 'local', codex_home: home, read: true, send: true, legacy_targets: [f.config.targets[0]] };
    recovered = new DesktopConversationsService(f.db, config, { transport: { runSend: noSend, runRead: async input => { input.onResolvedTarget!({ thread_id: input.threadId, rollout_path: join(home, 'archived_sessions', 'new.jsonl') }); return { status: 'completed', context_json: '{"new":"original"}', source_complete: true }; } } });
    assert.equal((await recovered.get({ request_id: f.request })).context_chunk, first.context_chunk); assert.equal(recovered.read({ request_id: f.request, thread_id: f.thread }).receipt_nonce, first.receipt_nonce);
    const request_id = randomUUID(), newThread = randomUUID(); recovered.read({ request_id, thread_id: newThread }); assert.equal((await recovered.get({ request_id, wait_seconds: 1 })).status, 'completed');
    assert.deepEqual(recovered.accessStatus, { enabled: true, mode: 'local', read: true, send: true });
    await recovered.close(); recovered = new DesktopConversationsService(f.db, { ...config, legacy_targets: [{ ...f.config.targets[0], rollout_path: join(tmpdir(), 'wrong-old-path.jsonl') }] });
    await assert.rejects(recovered.get({ request_id: f.request }), /request_binding_conflict/);
  } finally { rmSync(f.path, { force: true }); await recovered?.close(); await f.cleanup(); }
});

test('local access can close without deleting receipts and reopen on the same home without retransmission', async () => {
  let f: ReturnType<typeof localFixture>, reads = 0, sends = 0;
  f = localFixture({ runRead: async input => { reads++; input.onResolvedTarget!(f.resolved(input.threadId)); return { status: 'completed', context_json: '{"saved":"original"}', source_complete: true }; },
    runSend: async input => { sends++; input.onResolvedTarget!(f.resolved(input.threadId)); input.beforeSend(); return { status: 'uncertain', reason: 'send_outcome_unknown' }; } });
  let current: DesktopConversationsService | undefined;
  const sendRequest = randomUUID();
  try {
    f.service.read({ request_id: f.request, thread_id: f.thread }); const readReceipt = await f.service.get({ request_id: f.request, wait_seconds: 1 });
    f.service.send({ request_id: sendRequest, thread_id: f.thread2, text: 'explicit text' }); const sendReceipt = await f.service.get({ request_id: sendRequest, wait_seconds: 1 }); assert.equal(sendReceipt.status, 'uncertain');
    await f.service.close(); const before = f.db.prepare('SELECT request_id,data FROM desktop_conversation_requests ORDER BY request_id').all();
    const disabled = { ...f.config, enabled: false, read: false, send: false, legacy_targets: [{ thread_id: randomUUID(), rollout_path: join(f.home, 'sessions', 'old.jsonl') }] };
    current = new DesktopConversationsService(f.db, disabled, { transport: { runRead: noRead, runSend: noSend } });
    assert.equal(current.enabled, false); assert.equal(current.readEnabled, false); assert.equal(current.sendEnabled, false);
    assert.deepEqual(current.accessStatus, { enabled: false, mode: 'disabled', read: false, send: false });
    assert.throws(() => current!.read({ request_id: f.request, thread_id: f.thread }), /desktop_conversations_disabled/);
    assert.throws(() => current!.send({ request_id: sendRequest, thread_id: f.thread2, text: 'explicit text' }), /desktop_conversations_disabled/);
    await assert.rejects(current.get({ request_id: f.request }), /desktop_conversations_disabled/);
    assert.deepEqual(f.db.prepare('SELECT request_id,data FROM desktop_conversation_requests ORDER BY request_id').all(), before);
    await current.close(); current = new DesktopConversationsService(f.db, { ...disabled, enabled: true, read: true, send: true }, { transport: { runRead: noRead, runSend: noSend } });
    assert.deepEqual(await current.get({ request_id: f.request }), readReceipt); assert.deepEqual(await current.get({ request_id: sendRequest }), sendReceipt);
    assert.equal(current.read({ request_id: f.request, thread_id: f.thread }).receipt_nonce, readReceipt.receipt_nonce);
    assert.equal(current.send({ request_id: sendRequest, thread_id: f.thread2, text: 'explicit text' }).status, 'uncertain');
    assert.equal(reads, 1); assert.equal(sends, 1);
  } finally { await current?.close(); await f.cleanup(); }
});
