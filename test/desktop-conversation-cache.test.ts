import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DesktopConversationsService, type DesktopConversationsOptions, type DesktopConversationsTransport } from '../src/desktop-conversations.js';

// Synthetic transport and an isolated database; these checks never read a
// real Codex history or send to a desktop thread.
const noSend: DesktopConversationsTransport['runSend'] = async () => { assert.fail('unexpected send'); };
const noRead: DesktopConversationsTransport['runRead'] = async () => { assert.fail('cached/recovered reads must not reconnect'); };
function storedRead(thread: string, text: string) {
  return { status: 'completed' as const, verification: 'native_stored_history' as const, history_source: 'codex_app_server' as const, stored_history_complete: true as const, source_complete: false as const,
    context_json: JSON.stringify({ thread: { id: thread, turns: [{ id: randomUUID(), itemsView: 'full', items: [{ type: 'agentMessage', text }] }] }, turns_source: 'thread/turns/list:full' }) };
}
function fixture(runRead: DesktopConversationsTransport['runRead'], options: DesktopConversationsOptions = {}, runSend = noSend) {
  const db = new Database(':memory:'), thread = randomUUID(), other = randomUUID();
  const config = { enabled: true, mode: 'local', codex_home: join(tmpdir(), `not-opened-${randomUUID()}`), read: true, send: true };
  const service = new DesktopConversationsService(db, config, { transport: { runRead, runSend }, ...options });
  return { db, thread, other, config, service, async finish(request: string, target = thread) {
    service.read({ request_id: request, thread_id: target }); return service.get({ request_id: request, wait_seconds: 1 });
  }, async cleanup() { await service.close(); db.close(); } };
}
// Count only request-row loads and envelope parses, independent of transport
// JSON validation, initial reconciliation scans, and the test's own assertions.
async function countLoads(db: Database.Database, action: () => Promise<void>) {
  let loads = 0, parses = 0;
  const prepare = db.prepare, parse = JSON.parse;
  db.prepare = function (sql: string) { if (sql === 'SELECT data FROM desktop_conversation_requests WHERE request_id=?') loads++; return prepare.call(this, sql); } as typeof db.prepare;
  JSON.parse = function (text: string, reviver?: Parameters<typeof JSON.parse>[1]) { if (text.startsWith('{"binding":')) parses++; return parse(text, reviver); };
  try { await action(); return { loads, parses }; } finally { db.prepare = prepare; JSON.parse = parse; }
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

test('persisted completion is immediately reusable; cold recovery parses once and warm chunks do not load the DB', async () => {
  let context = '', calls = 0;
  const f = fixture(async input => { calls++; const output = storedRead(input.threadId, '原始正文🌟'.repeat(40000)); context = output.context_json; return output; });
  let reopened: DesktopConversationsService | undefined;
  try {
    const request = randomUUID(), first = await f.finish(request);
    assert.equal(first.status, 'completed'); assert.equal(first.context_sha256, digest(context));
    const immediate = await countLoads(f.db, async () => {
      const again = await f.service.get({ request_id: request }); assert.deepEqual(again, first);
      again.timing.started_at = 'caller mutation'; again.context_chunk = 'caller mutation';
      assert.deepEqual(await f.service.get({ request_id: request }), first);
    });
    assert.deepEqual(immediate, { loads: 0, parses: 0 });
    await f.service.close(); reopened = new DesktopConversationsService(f.db, f.config, { transport: { runRead: noRead, runSend: noSend } });
    const cold = await countLoads(f.db, async () => { assert.deepEqual(await reopened!.get({ request_id: request }), first); });
    assert.deepEqual(cold, { loads: 1, parses: 1 });
    const warm = await countLoads(f.db, async () => {
      let assembled = '', offset: number | null = 0;
      while (offset !== null) { const page = await reopened!.get({ request_id: request, offset }); assembled += page.context_chunk; offset = page.next_offset!; assert.equal(page.receipt_nonce, first.receipt_nonce); }
      assert.equal(assembled, context); assert.equal(digest(assembled), first.context_sha256);
      assert.deepEqual(reopened!.read({ request_id: request, thread_id: f.thread }), first);
    });
    assert.deepEqual(warm, { loads: 0, parses: 0 }); assert.equal(calls, 1);
  } finally { await reopened?.close(); await f.cleanup(); }
});

test('duplicate and interleaved offsets preserve Unicode boundaries and exact result identity', async () => {
  const context = '{"text":"' + 'a'.repeat(31999 - 9) + '😀' + '中'.repeat(70000) + '"}';
  const f = fixture(async input => { input.onResolvedTarget!({ thread_id: input.threadId, rollout_path: join(f.config.codex_home, 'sessions', 'unused.jsonl') }); return { status: 'completed', context_json: context, source_complete: true }; });
  try {
    const request = randomUUID(), first = await f.finish(request); assert.equal(first.next_offset, 31999);
    const offsets = [31999, 0, 63999, 31999, context.length, 0];
    const pages = await Promise.all(offsets.map(offset => f.service.get({ request_id: request, offset })));
    for (const [index, page] of pages.entries()) { const offset = offsets[index]!; assert.equal(page.context_offset, offset); assert.equal(page.context_chunk, context.slice(offset, offset === 0 ? 31999 : offset + 32000)); assert.equal(page.context_chunk!.isWellFormed(), true); assert.equal(page.context_sha256, first.context_sha256); assert.equal(page.receipt_nonce, first.receipt_nonce); }
    assert.deepEqual(pages[0], pages[3]); assert.deepEqual(pages[1], pages[5]);
    await assert.rejects(f.service.get({ request_id: request, offset: 32000 }), /invalid_offset/);
    await assert.rejects(f.service.get({ request_id: request, offset: context.length + 1 }), /invalid_offset/);
  } finally { await f.cleanup(); }
});

test('two targets and multiple requests for one target keep independent immutable snapshots', async () => {
  let calls = 0;
  const f = fixture(async input => storedRead(input.threadId, `snapshot ${++calls}: ${input.threadId}`));
  try {
    const a = randomUUID(), b = randomUUID(), c = randomUUID();
    const results = await Promise.all([f.finish(a), f.finish(b, f.other), f.finish(c)]);
    assert.equal(calls, 3); assert.equal(new Set(results.map(value => value.context_sha256)).size, 3); assert.equal(new Set(results.map(value => value.receipt_nonce)).size, 3);
    for (const [index, request] of [c, a, b, c, b, a].entries()) {
      const expected = results[[2, 0, 1, 2, 1, 0][index]!]!;
      assert.deepEqual(await f.service.get({ request_id: request }), expected);
    }
    assert.throws(() => f.service.read({ request_id: a, thread_id: f.other }), /idempotency_conflict/);
    assert.equal(calls, 3);
  } finally { await f.cleanup(); }
});

test('warm cache still applies enabled and scope checks; disabled new reads retain existing get semantics', async () => {
  const f = fixture(async input => storedRead(input.threadId, 'bound'));
  let reopened: DesktopConversationsService | undefined;
  try {
    const request = randomUUID(), result = await f.finish(request);
    // Deliberately mutate private configuration to exercise a warm hit under
    // changed authorization, without relying only on a cold restart check.
    const mutable = f.service as any, home = mutable.localConfig.codex_home;
    mutable.localConfig.codex_home = join(home, 'different');
    await assert.rejects(f.service.get({ request_id: request }), /request_binding_conflict/); mutable.localConfig.codex_home = home;
    mutable.enabled = false; await assert.rejects(f.service.get({ request_id: request }), /desktop_conversations_disabled/); mutable.enabled = true;
    mutable.readEnabled = false; assert.deepEqual(await f.service.get({ request_id: request }), result);
    assert.throws(() => f.service.read({ request_id: randomUUID(), thread_id: f.thread }), /desktop_conversations_read_disabled/);
    await f.service.close(); reopened = new DesktopConversationsService(f.db, { ...f.config, codex_home: join(home, 'different') }, { transport: { runRead: noRead, runSend: noSend } });
    await assert.rejects(reopened.get({ request_id: request }), /request_binding_conflict/);
  } finally { await reopened?.close(); await f.cleanup(); }
});

test('legacy persisted receipts validate target/path binding on warm hits and stay readable without transport', async () => {
  const db = new Database(':memory:'), thread = randomUUID(), request = randomUUID(), path = join(tmpdir(), 'never-read-legacy.jsonl');
  const config = { enabled: true, targets: [{ thread_id: thread, rollout_path: path }] };
  const f = new DesktopConversationsService(db, config, { transport: { runRead: async () => ({ status: 'completed', context_json: '{"legacy":"snapshot"}', source_complete: true }), runSend: noSend } });
  let reopened: DesktopConversationsService | undefined;
  try {
    f.read({ request_id: request, thread_id: thread }); const result = await f.get({ request_id: request, wait_seconds: 1 });
    const targets = (f as any).targets as Map<string, { thread_id: string; rollout_path: string }>;
    targets.set(thread, { thread_id: thread, rollout_path: path + '.changed' }); await assert.rejects(f.get({ request_id: request }), /request_binding_conflict/);
    targets.delete(thread); await assert.rejects(f.get({ request_id: request }), /thread_not_allowed/);
    await f.close(); reopened = new DesktopConversationsService(db, { enabled: true, mode: 'local', codex_home: tmpdir(), read: true, send: false, legacy_targets: config.targets }, { transport: { runRead: noRead, runSend: noSend } });
    assert.deepEqual(await reopened.get({ request_id: request }), result); assert.deepEqual(await reopened.get({ request_id: request }), result);
    (reopened as any).legacyTargets.clear(); await assert.rejects(reopened.get({ request_id: request }), /request_binding_conflict/);
  } finally { await reopened?.close(); await f.close(); db.close(); }
});

test('LRU capacity, idle expiry, oversize bypass and close reload the original persisted snapshot', async () => {
  let now = 1000, calls = 0;
  const f = fixture(async input => { calls++; return storedRead(input.threadId, 'cached snapshot'); }, { now: () => now, readCacheIdleMs: 100 });
  let reopened: DesktopConversationsService | undefined;
  try {
    const a = randomUUID(), b = randomUUID(), c = randomUUID();
    const first = await f.finish(a); now++;
    assert.equal(f.service.resourceStatus.read_cache_entries, 1);
    assert.ok(f.service.resourceStatus.read_cache_estimated_bytes > 0);
    // Fit exactly two equal-size fixtures without tying this test to home path
    // length or future metadata additions in the persisted envelope.
    (f.service as any).readCacheMaxBytes = f.service.resourceStatus.read_cache_estimated_bytes * 2;
    const second = await f.finish(b); now++;
    assert.equal((f.service as any).readCache.size, 2);
    await f.service.get({ request_id: a }); now++;
    const third = await f.finish(c);
    assert.equal((f.service as any).readCache.size, 2);
    const retained = await countLoads(f.db, async () => { assert.deepEqual(await f.service.get({ request_id: a }), first); }); assert.equal(retained.loads, 0);
    const evicted = await countLoads(f.db, async () => { assert.deepEqual(await f.service.get({ request_id: b }), second); }); assert.deepEqual(evicted, { loads: 1, parses: 1 });
    now += 100;
    const expired = await countLoads(f.db, async () => { assert.deepEqual(await f.service.get({ request_id: c }), third); }); assert.deepEqual(expired, { loads: 1, parses: 1 });
    await f.service.close(); assert.equal((f.service as any).readCache.size, 0); assert.equal((f.service as any).readCacheTimer, undefined);
    reopened = new DesktopConversationsService(f.db, f.config, { transport: { runRead: noRead, runSend: noSend }, readCacheMaxBytes: 1 });
    const oversize = await countLoads(f.db, async () => { assert.deepEqual(await reopened!.get({ request_id: a }), first); assert.deepEqual(await reopened!.get({ request_id: a }), first); }); assert.deepEqual(oversize, { loads: 2, parses: 2 });
    assert.equal(calls, 3);
  } finally { await reopened?.close(); await f.cleanup(); }
});

test('idle entries expire without another request and close cancels expiry timer', async () => {
  const f = fixture(async input => storedRead(input.threadId, 'idle'), { readCacheIdleMs: 10 });
  try {
    await f.finish(randomUUID()); assert.equal(f.service.resourceStatus.read_cache_entries, 1);
    await new Promise(resolve => setTimeout(resolve, 35)); assert.equal(f.service.resourceStatus.read_cache_entries, 0); assert.equal(f.service.resourceStatus.read_cache_estimated_bytes, 0);
  } finally { await f.cleanup(); }
});

test('failed completion saves never enter memory delivery or rerun transport, including missing durable rows', async () => {
  for (const mode of ['sqlite_failure', 'missing_row'] as const) {
    let calls = 0; const request = randomUUID();
    const f = fixture(async input => { calls++; if (mode === 'missing_row') f.db.prepare('DELETE FROM desktop_conversation_requests WHERE request_id=?').run(request); return storedRead(input.threadId, 'must persist first'); });
    let reopened: DesktopConversationsService | undefined;
    try {
      if (mode === 'sqlite_failure') f.db.exec("CREATE TRIGGER fail_completion BEFORE UPDATE ON desktop_conversation_requests WHEN json_extract(NEW.data,'$.result.status')='completed' BEGIN SELECT RAISE(FAIL,'synthetic write failure'); END");
      f.service.read({ request_id: request, thread_id: f.thread });
      if (mode === 'sqlite_failure') assert.equal((await f.service.get({ request_id: request, wait_seconds: 1 })).status, 'pending');
      else await assert.rejects(f.service.get({ request_id: request, wait_seconds: 1 }), /request_not_found/);
      assert.equal((f.service as any).readCache.size, 0); assert.equal(calls, 1);
      await f.service.close(); reopened = new DesktopConversationsService(f.db, f.config, { transport: { runRead: noRead, runSend: noSend } });
      if (mode === 'sqlite_failure') { assert.equal((await reopened.get({ request_id: request })).status, 'reconciliation_required'); assert.equal(reopened.read({ request_id: request, thread_id: f.thread }).status, 'reconciliation_required'); }
      else await assert.rejects(reopened.get({ request_id: request }), /request_not_found/);
      assert.equal(calls, 1);
    } finally { await reopened?.close(); await f.cleanup(); }
  }
});

test('pending, skipped and completed-send receipts always bypass the read cache', async () => {
  let release!: () => void, calls = 0; const turn = randomUUID();
  const f = fixture(async input => { calls++; if (input.threadId === f.other) return { status: 'skipped_unknown', reason: 'native_reader_request_failed' }; await new Promise<void>(resolve => { release = resolve; }); return storedRead(input.threadId, 'completed after wait'); }, {}, async input => {
    input.onResolvedTarget!({ thread_id: input.threadId, rollout_path: join(f.config.codex_home, 'sessions', 'unused.jsonl') }); input.beforeSend(); input.onAccepted(turn); return { status: 'completed', turn_id: turn, reply: 'sent receipt' };
  });
  try {
    const pending = randomUUID(); f.service.read({ request_id: pending, thread_id: f.thread }); await new Promise(resolve => setImmediate(resolve));
    const loads = await countLoads(f.db, async () => { for (let i = 0; i < 2; i++) assert.equal((await f.service.get({ request_id: pending })).status, 'pending'); }); assert.deepEqual(loads, { loads: 2, parses: 2 }); assert.equal((f.service as any).readCache.size, 0);
    const skipped = randomUUID(); await f.finish(skipped, f.other);
    const send = randomUUID(); f.service.send({ request_id: send, thread_id: f.other, text: 'authorized synthetic send' }); const receipt = await f.service.get({ request_id: send, wait_seconds: 1 }); assert.equal(receipt.status, 'completed');
    const terminal = await countLoads(f.db, async () => { for (let i = 0; i < 2; i++) { assert.equal((await f.service.get({ request_id: skipped })).status, 'skipped_unknown'); assert.deepEqual(await f.service.get({ request_id: send }), receipt); } }); assert.deepEqual(terminal, { loads: 4, parses: 4 }); assert.equal((f.service as any).readCache.size, 0);
    release(); assert.equal((await f.service.get({ request_id: pending, wait_seconds: 1 })).status, 'completed'); assert.equal(calls, 2);
  } finally { release?.(); await f.cleanup(); }
});
