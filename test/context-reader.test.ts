import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readContextBatch } from '../src/context-reader.js';
import { readerFixture } from './desktop-conversation-reader-fixture.js';

async function fixture(action: (input: any, f: ReturnType<typeof contextFixture>) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'context-reader-')), id = randomUUID(), controller = new AbortController();
  try { await action({ threadId: id, codexHome: home, signal: controller.signal, deadline: Date.now() + 20000 }, contextFixture(id)); }
  finally { controller.abort(); rmSync(home, { recursive: true, force: true }); }
}
function contextFixture(id: string) {
  let customize: ((frame: any, f: ReturnType<typeof readerFixture>) => boolean) | undefined;
  const f = readerFixture(id, (frame, native) => {
    if (customize?.(frame, native)) return true;
    if (frame.method === 'thread/turns/list') {
      const offset = frame.params.cursor ? Number(frame.params.cursor.split(':')[1]) : 0;
      const data = native.turns.slice().reverse().slice(offset, offset + 100).map(turn => ({ id: turn.id, status: turn.status, itemsView: 'notLoaded', items: [] }));
      native.receive({ id: frame.id, result: { data, nextCursor: offset + 100 < native.turns.length ? `turns:${offset + 100}` : null } }); return true;
    }
    if (frame.method === 'thread/items/list') {
      const turn = native.turns.find(turn => turn.id === frame.params.turnId);
      if (!turn) { native.receive({ id: frame.id, error: { message: 'PRIVATE_ERROR' } }); return true; }
      const offset = frame.params.cursor ? Number(frame.params.cursor.split(':')[1]) : 0;
      const data = turn.items.slice(offset, offset + 2).map((item: any) => ({ turnId: turn.id, item }));
      native.receive({ id: frame.id, result: { data, nextCursor: offset + 2 < turn.items.length ? `items:${offset + 2}` : null } }); return true;
    }
    return false;
  });
  return { ...f, customize(fn: typeof customize) { customize = fn; } };
}

test('bootstrap builds the whole unfinished-turn index, projects public material and preserves legacy transport isolation', async () => fixture(async (input, f) => {
  f.turns[0].status = 'inProgress';
  f.turns[0].items.push({ id: 'private', type: 'reasoning', summary: ['PRIVATE_REASON'], content: ['PRIVATE_REASON'] }, { id: 'hook', type: 'hookPrompt', fragments: [{ text: 'PRIVATE_HOOK' }] });
  f.turns[1].items.push({ id: 'plan', type: 'plan', text: '公开计划', model: 'PRIVATE_MODEL', reasoningEffort: 'PRIVATE_EFFORT' });
  const result = await readContextBatch(input, f.testing);
  assert.equal(result.coverage.indexComplete, true); assert.equal(result.coverage.historyComplete, true);
  assert.deepEqual(result.watermark.unfinishedTurnIds, [f.turns[0].id]); assert.equal(result.turns.length, 2);
  assert(result.turns.every(turn => turn.replaceItems && turn.complete));
  assert(!JSON.stringify(result).includes('PRIVATE_')); assert(!JSON.stringify(result).includes('UNTRUSTED_NO_EXEC'));
  assert(result.turns.flatMap(turn => turn.items).every(item => item.source_ref.endsWith(item.fingerprint)));
  assert(f.frames.filter(frame => frame.method === 'thread/turns/list').every(frame => frame.params.itemsView === 'notLoaded' && frame.params.sortDirection === 'desc'));
  assert(f.frames.every(frame => ['initialize', 'initialized', 'thread/read', 'thread/turns/list', 'thread/items/list'].includes(frame.method)));
  assert.equal(f.killed(), true); assert.equal(result.coverage.historicalEditsDetectable, false);
}));

test('later reads target new turns, latest turn and every previously unfinished turn', async () => fixture(async (input, f) => {
  f.turns[0].status = 'inProgress';
  const initial = await readContextBatch(input, f.testing);
  // Fresh child fixture represents a separate app-server process.
  const next = contextFixture(input.threadId); next.turns.splice(0, next.turns.length, ...structuredClone(f.turns));
  next.turns.push({ id: randomUUID(), status: 'completed', itemsView: 'full', items: [{ id: 'new', type: 'agentMessage', text: '新增回复' }] });
  const result = await readContextBatch({ ...input, previous: initial.watermark }, next.testing);
  assert.deepEqual(new Set(result.turns.map(turn => turn.turnId)), new Set([next.turns[0].id, next.turns[2].id]));
  assert(!next.frames.some(frame => frame.method === 'thread/items/list' && frame.params.turnId === next.turns[1].id));
}));

test('same item changes and deletion replace only a fully observed turn collection', async () => fixture(async (input, f) => {
  const first = await readContextBatch(input, f.testing), next = contextFixture(input.threadId);
  next.turns.splice(0, next.turns.length, ...structuredClone(f.turns));
  next.turns[1].items = [{ id: 'three', type: 'commandExecution', aggregatedOutput: '更新结果', exitCode: 0 }];
  const result = await readContextBatch({ ...input, previous: first.watermark }, next.testing);
  const old = first.turns.find(turn => turn.turnId === next.turns[1].id)!, changed = result.turns.find(turn => turn.turnId === next.turns[1].id)!;
  assert.notEqual(old.items[0]!.fingerprint, changed.items[0]!.fingerprint); assert.equal(changed.replaceItems, true);
  assert.deepEqual(changed.itemIds, ['three']);
}));

test('output turn limit resumes with stable pending IDs and does not reread already delivered bootstrap turns', async () => fixture(async (input, f) => {
  const first = await readContextBatch({ ...input, limits: { maxTurns: 1 } }, f.testing);
  assert(first.continuation); assert.equal(first.coverage.historyComplete, false);
  assert.equal(Object.hasOwn(first.continuation, 'cursor'), false);
  const next = contextFixture(input.threadId); next.turns.splice(0, next.turns.length, ...structuredClone(f.turns));
  const last = await readContextBatch({ ...input, continuation: first.continuation, limits: { maxTurns: 1 } }, next.testing);
  assert.equal(last.turns.length, 1); assert.notEqual(last.turns[0]!.turnId, first.turns[0]!.turnId);
  assert.equal(last.continuation, undefined);
}));

test('long public items are explicit gaps and can be expanded with stable source references', async () => fixture(async (input, f) => {
  f.turns[1].items[0].aggregatedOutput = '公开长输出🌟'.repeat(1000);
  const first = await readContextBatch({ ...input, limits: { maxItemChars: 128 } }, f.testing);
  const item = first.turns.find(turn => turn.turnId === f.turns[1].id)!.items[0]!;
  assert.equal(item.truncated, true); assert.equal(first.coverage.historyComplete, false);
  const next = contextFixture(input.threadId); next.turns.splice(0, next.turns.length, ...structuredClone(f.turns));
  const expanded = await readContextBatch({ ...input, evidence: { turnId: f.turns[1].id, itemId: item.id, offset: item.text.length }, limits: { maxItemChars: 128 } }, next.testing);
  const tail = expanded.turns[0]!.items[0]!; assert.equal(tail.source_ref, item.source_ref); assert.equal(tail.textOffset, item.text.length);
  assert.equal(expanded.turns[0]!.complete, false); assert.equal(expanded.turns[0]!.itemSetVerified, true);
}));

test('within-turn growth during pagination is detected by final overlap re-read', async () => fixture(async (input, f) => {
  const target = f.turns[1]; let reads = 0;
  f.customize((frame, native) => {
    if (frame.method === 'thread/items/list' && frame.params.turnId === target.id && !frame.params.cursor && ++reads === 2) target.items[0].aggregatedOutput = '边界时的新输出';
    return false;
  });
  const result = await readContextBatch(input, f.testing);
  assert.equal(result.coverage.observedStable, false); assert.equal(result.coverage.historyComplete, false);
  assert(result.gaps.some(gap => gap.code === 'turn_changed_during_read'));
  assert(result.turns.every(turn => !turn.replaceItems)); assert(result.continuation?.pendingTurnIds.includes(target.id));
}));

test('source identity changes invalidate prior history and rebuild without using opaque cursors', async () => fixture(async (input, f) => {
  const first = await readContextBatch(input, f.testing), next = contextFixture(input.threadId);
  next.turns.splice(0, next.turns.length, ...structuredClone(f.turns)); next.thread.path = 'replacement-visible-source';
  const result = await readContextBatch({ ...input, previous: first.watermark }, next.testing);
  assert.equal(result.invalidated, true); assert.equal(result.turns.length, 2); assert(result.gaps.some(gap => gap.code === 'source_identity_changed'));
}));

test('rollback with a missing previous head rebuilds and never trusts the previous tail', async () => fixture(async (input, f) => {
  const first = await readContextBatch(input, f.testing), next = contextFixture(input.threadId);
  next.turns.splice(0, next.turns.length, structuredClone(f.turns[0]));
  const result = await readContextBatch({ ...input, previous: first.watermark }, next.testing);
  assert.equal(result.invalidated, true); assert.equal(result.watermark.index.length, 1);
}));

test('item cursor loops produce partial coverage, no deletion and a resumable batch', async () => fixture(async (input, f) => {
  f.customize((frame, native) => {
    if (frame.method !== 'thread/items/list') return false;
    const turn = native.turns.find(turn => turn.id === frame.params.turnId)!;
    native.receive({ id: frame.id, result: { data: [{ turnId: turn.id, item: turn.items[0] }], nextCursor: 'loop' } }); return true;
  });
  const result = await readContextBatch(input, f.testing);
  assert.equal(result.coverage.historyComplete, false); assert(result.gaps.some(gap => gap.code === 'item_cursor_loop'));
  assert(result.turns.every(turn => !turn.replaceItems && !turn.complete)); assert(result.continuation);
}));

test('index resource limits retain unknown unfinished intervals and grow index allowance on resume', async () => fixture(async (input, f) => {
  f.turns.splice(0, f.turns.length, ...Array.from({ length: 105 }, () => ({ id: randomUUID(), status: 'completed', itemsView: 'full', items: [] })));
  const first = await readContextBatch({ ...input, limits: { maxIndexPages: 1, maxTurns: 1 } }, f.testing);
  assert.equal(first.watermark.indexComplete, false); assert(first.continuation); assert(first.gaps.some(gap => gap.code === 'unfinished_turns_outside_index_unknown'));
  const next = contextFixture(input.threadId); next.turns.splice(0, next.turns.length, ...structuredClone(f.turns));
  const second = await readContextBatch({ ...input, continuation: first.continuation, limits: { maxIndexPages: 1, maxTurns: 1 } }, next.testing);
  assert.equal(second.watermark.indexComplete, true); assert.equal(second.watermark.index.length, 105);
}));

test('multiple public items continue by verified item position and reset when the current turn changes', async () => fixture(async (input, f) => {
  f.turns[1].items = Array.from({ length: 8 }, (_, i) => ({ id: `part-${i}`, type: 'agentMessage', text: '公开内容'.repeat(80) }));
  const first = await readContextBatch({ ...input, limits: { maxBytes: 2048 } }, f.testing);
  assert(first.continuation?.currentTurn); assert(first.turns[0]!.items.length < 8);
  const next = contextFixture(input.threadId); next.turns.splice(0, next.turns.length, ...structuredClone(f.turns));
  const second = await readContextBatch({ ...input, continuation: first.continuation, limits: { maxBytes: 2048 } }, next.testing);
  assert(second.turns[0]!.items[0]!.id !== first.turns[0]!.items[0]!.id); assert.equal(second.turns[0]!.complete, false); assert.equal(second.turns[0]!.itemSetVerified, true);
  const changed = contextFixture(input.threadId); changed.turns.splice(0, changed.turns.length, ...structuredClone(f.turns));
  changed.turns[1].items[0].text = '已更新';
  const retry = await readContextBatch({ ...input, continuation: first.continuation, limits: { maxBytes: 2048 } }, changed.testing);
  assert.equal(retry.turns[0]!.items[0]!.id, 'part-0'); assert(retry.gaps.some(gap => gap.code === 'turn_changed_between_batches'));
}));

test('duplicate native item IDs cannot authorize collection replacement', async () => fixture(async (input, f) => {
  f.turns[1].items.push({ ...f.turns[1].items[0], aggregatedOutput: '同ID不同结果' });
  const result = await readContextBatch(input, f.testing);
  assert.equal(result.turns[0]!.complete, false); assert.equal(result.turns[0]!.replaceItems, false);
  assert(result.gaps.some(gap => gap.code === 'duplicate_item')); assert(result.continuation);
}));

test('known text variants of public function and dynamic tool outputs are projected while encrypted data is excluded', async () => fixture(async (input, f) => {
  f.turns[1].items.push({ id: 'fn', type: 'functionCallOutput', output: [{ type: 'input_text', text: '函数结果' }, { type: 'encrypted_content', encrypted_content: 'PRIVATE_ENCRYPTED' }] },
    { id: 'dynamic', type: 'dynamicToolCall', contentItems: [{ type: 'inputText', text: '动态结果' }], arguments: { secret: 'PRIVATE_ARGUMENT' } });
  const result = await readContextBatch(input, f.testing);
  assert(result.turns[0]!.items.some(item => item.text === '函数结果')); assert(result.turns[0]!.items.some(item => item.text === '动态结果'));
  assert(!JSON.stringify(result).includes('PRIVATE_'));
}));

test('RPC limit returns a resumable partial batch and does not leave boundary checks falsely complete', async () => fixture(async (input, f) => {
  f.turns[1].items = Array.from({ length: 12 }, (_, i) => ({ id: `rpc-${i}`, type: 'agentMessage', text: '公开' }));
  const result = await readContextBatch({ ...input, limits: { maxRpc: 8 } }, f.testing);
  assert.equal(result.coverage.historyComplete, false); assert.equal(result.coverage.observedStable, false);
  assert(result.continuation); assert(result.continuation.pendingTurnIds.length > 0);
  assert(result.gaps.some(gap => gap.code === 'observation_boundary_unverified'));
}));

test('known compaction and image exclusions preserve reusable projected coverage and subsequent incrementality', async () => fixture(async (input, f) => {
  f.turns.splice(1, 0, { id: randomUUID(), status: 'completed', itemsView: 'full', items: [{ id: 'middle', type: 'plan', text: '历史计划' }] });
  f.turns[2].items.push({ id: 'compact', type: 'contextCompaction', summary: 'PRIVATE_COMPACT' }, { id: 'image', type: 'imageView', path: 'PRIVATE_IMAGE_PATH' });
  const first = await readContextBatch({ ...input, limits: { maxTurns: 1 } }, f.testing);
  assert(first.continuation); assert.equal(first.coverage.projectionComplete, false);
  const next = contextFixture(input.threadId); next.turns.splice(0, next.turns.length, ...structuredClone(f.turns));
  const last = await readContextBatch({ ...input, continuation: first.continuation }, next.testing);
  assert.equal(last.coverage.projectionComplete, true); assert.equal(last.coverage.historyComplete, false);
  assert(last.gaps.some(gap => gap.code === 'compaction_body_unavailable')); assert(!JSON.stringify(last).includes('PRIVATE_'));
  assert.equal(Object.keys(last.watermark.turnFingerprints).length, 3);
  const warm = contextFixture(input.threadId); warm.turns.splice(0, warm.turns.length, ...structuredClone(f.turns));
  const delta = await readContextBatch({ ...input, previous: last.watermark }, warm.testing);
  assert.equal(delta.turns.length, 1); assert.equal(delta.turns[0]!.turnId, f.turns[2].id);
  assert.equal(delta.coverage.projectionComplete, true); assert.equal(delta.coverage.historyComplete, false);
  assert(!warm.frames.some(frame => frame.method === 'thread/items/list' && frame.params.turnId === f.turns[1].id));
}));

test('text resource limits automatically resume verified slices until projected delivery is complete', async () => fixture(async (input, f) => {
  const body = '公开材料'.repeat(75); f.turns[1].items[0].aggregatedOutput = body;
  let result = await readContextBatch({ ...input, limits: { maxItemChars: 128 } }, f.testing);
  const slices = result.turns[0]!.items.map(item => item.text), ref = result.turns[0]!.items[0]!.source_ref;
  assert(result.continuation?.currentItem); assert.equal(result.coverage.projectionComplete, false);
  for (let attempt = 0; result.continuation && attempt < 5; attempt++) {
    const next = contextFixture(input.threadId); next.turns.splice(0, next.turns.length, ...structuredClone(f.turns));
    result = await readContextBatch({ ...input, continuation: result.continuation, limits: { maxItemChars: 128 } }, next.testing);
    for (const item of result.turns.flatMap(turn => turn.items).filter(item => item.id === 'three')) { slices.push(item.text); assert.equal(item.source_ref, ref); }
  }
  assert.equal(result.continuation, undefined); assert.equal(result.coverage.projectionComplete, true);
  assert.equal(slices.join(''), body);
}));

test('observed slow RPC latency reserves overlap verification and returns useful partial data before the 60-second hard deadline', async () => fixture(async (input, f) => {
  f.turns.splice(0, f.turns.length, ...Array.from({ length: 301 }, (_, i) => ({ id: randomUUID(), status: 'completed', itemsView: 'full', items: [{ id: `slow-${i}`, type: 'agentMessage', text: '公开消息' }] })));
  const start = Date.now(); let clock = start;
  f.customize(frame => { if (frame.id) clock += 3200; return false; });
  const result = await readContextBatch({ ...input, deadline: start + 60000 }, { ...f.testing, now: () => clock });
  assert(result.turns.length > 0 && result.turns.length < 12); assert(result.continuation);
  assert.equal(result.coverage.projectionComplete, false); assert.equal(result.coverage.observedStable, true);
  assert(result.gaps.some(gap => gap.code === 'context_time_budget')); assert(clock - start < 60000);
  assert.equal(f.killed(), true);
  const next = contextFixture(input.threadId); next.turns.splice(0, next.turns.length, ...structuredClone(f.turns));
  const remaining = await readContextBatch({ ...input, deadline: Date.now() + 60000, continuation: result.continuation, limits: { maxTurns: 1 } }, next.testing);
  assert.notEqual(remaining.turns[0]!.turnId, result.turns[0]!.turnId);
}));

test('previously unfinished older turns are reread after they complete and append final output', async () => fixture(async (input, f) => {
  f.turns[0].status = 'inProgress';
  const first = await readContextBatch(input, f.testing), next = contextFixture(input.threadId);
  next.turns.splice(0, next.turns.length, ...structuredClone(f.turns));
  next.turns[0].status = 'completed'; next.turns[0].items.push({ id: 'final', type: 'agentMessage', text: '较旧轮次的最终结果' });
  const result = await readContextBatch({ ...input, previous: first.watermark }, next.testing);
  assert(result.turns.find(turn => turn.turnId === next.turns[0].id)!.items.some(item => item.id === 'final'));
  assert.deepEqual(result.watermark.unfinishedTurnIds, []); assert.equal(result.coverage.projectionComplete, true);
}));

test('the index refresh reaches a previously unfinished turn outside the first head page', async () => fixture(async (input, f) => {
  f.turns.splice(0, f.turns.length, ...Array.from({ length: 102 }, (_, i) => ({ id: randomUUID(), status: i === 0 ? 'inProgress' : 'completed', itemsView: 'full', items: [{ id: `old-${i}`, type: 'agentMessage', text: '已有输出' }] })));
  const first = await readContextBatch({ ...input, limits: { maxTurns: 1000 } }, f.testing), next = contextFixture(input.threadId);
  next.turns.splice(0, next.turns.length, ...structuredClone(f.turns));
  next.turns[0].status = 'completed'; next.turns[0].items[0].text = '现在已完成';
  const result = await readContextBatch({ ...input, previous: first.watermark }, next.testing);
  assert(result.turns.find(turn => turn.turnId === next.turns[0].id)!.items.some(item => item.text === '现在已完成'));
  assert.equal(result.watermark.index.find(row => row.turnId === next.turns[0].id)!.status, 'completed');
  assert.equal(result.watermark.unfinishedTurnIds.length, 0);
}));

test('continuation drains historical pending turns before rechecking a streamed head with unchanged ID and status', async () => fixture(async (input, f) => {
  f.turns[1].status = 'inProgress';
  const first = await readContextBatch({ ...input, limits: { maxTurns: 1 } }, f.testing), next = contextFixture(input.threadId);
  next.turns.splice(0, next.turns.length, ...structuredClone(f.turns)); next.turns[1].items[0].aggregatedOutput = '头轮的新公开输出';
  const second = await readContextBatch({ ...input, continuation: first.continuation, limits: { maxTurns: 1 } }, next.testing);
  assert.equal(second.turns[0]!.turnId, f.turns[0].id); // Old pending work was not starved.
  assert.equal(second.coverage.projectionComplete, false); assert(second.gaps.some(gap => gap.code === 'continuation_turn_changed'));
  assert(second.continuation?.pendingTurnIds.includes(f.turns[1].id));
  const last = contextFixture(input.threadId); last.turns.splice(0, last.turns.length, ...structuredClone(next.turns));
  const third = await readContextBatch({ ...input, continuation: second.continuation, limits: { maxTurns: 1 } }, last.testing);
  assert(third.turns[0]!.items.some(item => item.text === '头轮的新公开输出')); assert.equal(third.coverage.projectionComplete, true);
  assert.equal(third.continuation, undefined);
}));

test('cross-batch delivery still exposes a verified deletion set and every current item fingerprint', async () => fixture(async (input, f) => {
  const first = await readContextBatch(input, f.testing), next = contextFixture(input.threadId);
  next.turns.splice(0, next.turns.length, ...structuredClone(f.turns));
  next.turns[1].items = Array.from({ length: 8 }, (_, i) => ({ id: `remaining-${i}`, type: 'agentMessage', text: '剩余内容'.repeat(80) }));
  let result = await readContextBatch({ ...input, previous: first.watermark, limits: { maxBytes: 2048 } }, next.testing);
  assert.equal(result.turns[0]!.complete, false); assert.equal(result.turns[0]!.itemSetVerified, true);
  for (let attempt = 0; result.continuation && attempt < 12; attempt++) {
    const more = contextFixture(input.threadId); more.turns.splice(0, more.turns.length, ...structuredClone(next.turns));
    result = await readContextBatch({ ...input, previous: first.watermark, continuation: result.continuation, limits: { maxBytes: 2048 } }, more.testing);
  }
  assert.equal(result.continuation, undefined); assert.equal(result.coverage.projectionComplete, true);
  const finished = result.turns[0]!;
  assert.equal(finished.complete, false); assert.equal(finished.itemSetVerified, true); assert.equal(finished.replaceItems, true);
  assert(!finished.itemIds.includes('three')); assert.equal(Object.keys(finished.itemFingerprints!).length, 8);
}));
