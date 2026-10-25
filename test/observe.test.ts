import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { TaskStore, type TaskStatus } from '../src/task-store.js';
import { observeDatabase, type ObserveResponse } from '../src/observe.js';
import { createProductionService } from '../src/bridge.js';
import { ProbeEvents } from '../src/events.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dots-observe-'));
  const path = join(dir, 'tasks.sqlite'); const instance = randomUUID();
  let time = Date.parse('2026-10-09T00:00:00Z'); let store = new TaskStore(path, () => time);
  return { path, instance, get store() { return store; }, advance(ms: number) { time += ms; },
    observe(request: unknown) { return store.observe(request, instance); },
    restart() { store.close(); store = new TaskStore(path, () => time); },
    close() { store.close(); const rel = relative(resolve(tmpdir()), resolve(dir));
      assert.ok(rel.startsWith('dots-observe-') && !rel.startsWith('..') && !isAbsolute(rel)); rmSync(dir, { recursive: true, force: true }); } };
}
const tables = ['tasks', 'task_operations', 'task_subscriptions', 'task_events', 'task_deliveries', 'task_evidence'];
function records(store: TaskStore) { return JSON.stringify(tables.map(table => store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())); }
function files(path: string) { return [path, path + '-wal'].map(file => existsSync(file) ? readFileSync(file) : null); }
function submit(store: TaskStore, key: string) { return store.submit({ idempotency_key: key, title: key, input: { text: 'PRIVATE_INPUT' }, logical_session_id: 'PRIVATE_LOGICAL_SESSION' }); }
function owned(store: TaskStore, id: string, key = 'claim') { return { task_id: id, claim_token: store.claim({ task_id: id, claim_key: key }).claim_token }; }
function finished(store: TaskStore, key: string, result = { data: { count: 2 } }) {
  const task = submit(store, key), claim = owned(store, task.task_id);
  store.checkpoint({ ...claim, input_revision: 1, summary: 'Current checkpoint' });
  return store.complete({ ...claim, input_revision: 1, completion_key: 'done', result });
}

test('observer is SELECT-only on every table and database bytes; no sweep, read, ACK or acceptance', () => {
  const f = fixture(); try {
    const done = finished(f.store, 'done');
    const pending = submit(f.store, 'pending'); owned(f.store, pending.task_id);
    f.store.audit('global_diagnostic', null, { token: 'PRIVATE_EVIDENCE' });
    f.advance(48 * 3_600_000); // The normal get/list/status paths would mutate this running task.
    f.store.db.pragma('wal_checkpoint(TRUNCATE)');
    const before = records(f.store), bytes = files(f.path);
    for (let n = 0; n < 3; n++) {
      const snapshot = f.observe({ mode: 'snapshot', limit: 1 });
      assert.equal(snapshot.complete, true); assert.equal(snapshot.has_more, true);
      assert.equal(f.observe({ mode: 'task', task_id: pending.task_id }).tasks[0]?.status, 'running');
      assert.equal(f.observe({ mode: 'task', task_id: done.task_id }).tasks[0]?.result?.result_id, done.result_id);
      f.observe({ mode: 'changes', cursor: 0 });
    }
    assert.equal(records(f.store), before); assert.deepEqual(files(f.path), bytes);
    const observer = new Database(f.path, { readonly: true, fileMustExist: true });
    try { assert.equal(observeDatabase(observer, { mode: 'task', task_id: done.task_id }, f.instance).tasks[0]?.result?.result_id, done.result_id); }
    finally { observer.close(); }
    assert.equal(records(f.store), before); assert.deepEqual(files(f.path), bytes);
    const raw = JSON.parse((f.store.db.prepare('SELECT data FROM tasks WHERE id=?').get(done.task_id) as { data: string }).data);
    assert.equal(raw.results[0].result_read_at, undefined); assert.equal(raw.results[0].codex_ack_at, undefined);
    assert.equal(raw.results[0].user_accepted, undefined); assert.equal(raw.results[0].user_accepted_at, undefined);
  } finally { f.close(); }
});

test('all nine original task states are preserved without inferring cancellation or completion', () => {
  const statuses: TaskStatus[] = ['queued', 'running', 'waiting_input', 'cancel_requested', 'reconciliation_required', 'completed', 'failed', 'cancelled', 'expired'];
  for (const status of statuses) {
    const f = fixture(); try {
      const t = submit(f.store, status);
      if (['running', 'waiting_input', 'cancel_requested', 'reconciliation_required', 'completed', 'failed'].includes(status)) {
        const claim = owned(f.store, t.task_id);
        if (status === 'waiting_input') f.store.requestInput({ ...claim, question_key: 'q', question: 'Question?', requires_platform_action: true, action_url: 'https://example.com/action', options: ['A', 'B'] });
        if (status === 'cancel_requested') f.store.cancel({ task_id: t.task_id, request_key: 'cancel' });
        if (status === 'reconciliation_required') { f.advance(1_800_001); f.store.sweep(); }
        if (status === 'completed' || status === 'failed') {
          f.store.checkpoint({ ...claim, input_revision: 1 });
          if (status === 'completed') f.store.complete({ ...claim, completion_key: 'done', input_revision: 1, result: { data: { only: 'data' } } });
          else f.store.fail({ ...claim, failure_key: 'fail', input_revision: 1, error: { code: 'blocked', message: 'Current failure' } });
        }
      }
      if (status === 'cancelled') f.store.cancel({ task_id: t.task_id, request_key: 'cancel' });
      if (status === 'expired') { f.advance(24 * 3_600_000 + 1); f.store.sweep(); }
      const before = records(f.store), task = f.observe({ mode: 'task', task_id: t.task_id }).tasks[0]!;
      assert.equal(task.status, status); assert.equal(records(f.store), before);
      if (status === 'completed') assert.deepEqual(task.result?.result, { data: { only: 'data' } });
      if (status === 'failed') assert.deepEqual(task.error, { code: 'blocked', message: 'Current failure' });
      if (status === 'waiting_input') assert.equal(task.question?.requires_platform_action, true);
      if (status === 'waiting_input' || status === 'failed') {
        const kind = status === 'waiting_input' ? 'question_saved' : 'failed';
        assert.equal(task.notice_sequence, f.observe({ mode: 'changes', cursor: 0 }).events.find(e => e.kind === kind)?.sequence);
      }
      for (const secret of ['PRIVATE_INPUT', 'PRIVATE_LOGICAL_SESSION', 'claim_token', 'claim_key', 'question_key', 'result_read_at', 'parent_context'])
        assert.ok(!JSON.stringify(task).includes(secret), secret);
    } finally { f.close(); }
  }
});

test('snapshot pages share a baseline and changes bridge interleaved writes, including global evidence', () => {
  const f = fixture(); try {
    for (let n = 0; n < 5; n++) submit(f.store, 'page-' + n);
    const first = f.observe({ mode: 'snapshot', limit: 2 }); const baseline = first.cursor;
    assert.equal(first.has_more, true); assert.ok(first.next_task_id); assert.equal(first.complete, true);
    const late = submit(f.store, 'created-between-pages'); const expected = (f.store.db.prepare('SELECT id FROM tasks ORDER BY id').all() as { id: string }[]).map(r => r.id);
    const seen = [...first.tasks]; let page = first;
    while (page.has_more) {
      page = f.observe({ mode: 'snapshot', limit: 2, after_task_id: page.next_task_id, watermark: baseline });
      assert.equal(page.cursor, baseline); seen.push(...page.tasks);
    }
    f.store.message({task_id:late.task_id,message_key:'interleaved-message',text:'Additional committed change for pagination'});
    const change = f.observe({ mode: 'changes', cursor: baseline, limit: 1 });
    assert.equal(change.has_more, true); assert.equal(change.events.length, 1); assert.equal(change.events[0]?.task_id, late.task_id);
    const tail = f.observe({ mode: 'changes', cursor: change.cursor });
    assert.ok(tail.events.length > 0); assert.equal(tail.has_more, false);
    assert.deepEqual([...new Set([...seen.map(t => t.task_id), ...change.events.concat(tail.events).flatMap(e => e.task_id ? [e.task_id] : [])])].sort(), expected);
    f.store.audit('global_sample', null, { token: 'PRIVATE_EVIDENCE' });
    const global = f.observe({ mode: 'changes', cursor: tail.cursor });
    assert.equal(global.events.length, 1); assert.equal(global.events[0]?.task_id, undefined); assert.ok(global.cursor > tail.cursor);
    assert.ok(!JSON.stringify(global).includes('PRIVATE_EVIDENCE'));
    assert.deepEqual(f.observe({ mode: 'changes', cursor: global.cursor }).events, []);
  } finally { f.close(); }
});

test('fast question-answer-completion retains immutable event content, isolates old revisions, and survives restart', () => {
  const f = fixture(); try {
    const t = submit(f.store, 'fast'); const baseline = f.observe({ mode: 'snapshot' }).cursor;
    const claim = owned(f.store, t.task_id);
    f.store.checkpoint({ ...claim, input_revision: 1, summary: 'OLD_CHECKPOINT' });
    const waiting = f.store.requestInput({ ...claim, question_key: 'q', question: 'Original question?', options: ['A'] });
    f.store.message({ task_id: t.task_id, message_key: 'answer', question_id: waiting.active_question_id, text: 'A' });
    const resumed = owned(f.store, t.task_id, 'resume');
    f.store.complete({ ...resumed, input_revision: 1, completion_key: 'stale', result: { text: 'OLD_RESULT' } });
    assert.equal(f.observe({ mode: 'task', task_id: t.task_id }).tasks[0]?.checkpoint, undefined);
    assert.equal(f.observe({ mode: 'task', task_id: t.task_id }).tasks[0]?.result, undefined);
    f.store.checkpoint({ ...resumed, input_revision: 2, summary: 'New checkpoint' });
    const done = f.store.complete({ ...resumed, input_revision: 2, completion_key: 'done', result: { data: { value: 42 }, links: [{ url: 'https://example.com/report', label: 'Report' }] } });
    const before = records(f.store); const changes = f.observe({ mode: 'changes', cursor: baseline });
    const question = changes.events.find(e => e.kind === 'question_saved')!;
    assert.equal(question.question?.question_id, waiting.active_question_id); assert.equal(question.question?.input_revision, 1);
    assert.equal(question.task?.status, 'completed'); assert.equal(question.task?.question, undefined);
    const result = changes.events.find(e => e.kind === 'result_saved')!;
    assert.equal(result.result?.result_id, done.result_id); assert.equal(result.result?.input_revision, 2);
    assert.deepEqual(result.result?.result.data, { value: 42 });
    assert.equal(changes.events.find(e => e.kind === 'result_evidence')?.result, undefined);
    assert.ok(!JSON.stringify(changes).includes('OLD_RESULT')); assert.equal(records(f.store), before);
    const content = JSON.stringify(changes.events); f.restart();
    assert.equal(JSON.stringify(f.observe({ mode: 'changes', cursor: baseline }).events), content);
    assert.equal(f.observe({ mode: 'changes', cursor: changes.cursor }).events.length, 0);
  } finally { f.close(); }
});

test('notice origin distinguishes completion during snapshot pagination from old result metadata changes', () => {
  const f = fixture(); try {
    const candidates = [submit(f.store, 'first'), submit(f.store, 'second')];
    const first = f.observe({ mode: 'snapshot', limit: 1 });
    const later = candidates.find(t => t.task_id !== first.tasks[0]!.task_id)!;
    // FIFO may select the task that sorts first; finish it so the later page's task can own the slot.
    const head = candidates[0]!;
    if (head.task_id !== later.task_id) {
      const claim = owned(f.store, head.task_id);
      f.store.checkpoint({ ...claim, input_revision: 1 });
      f.store.complete({ ...claim, completion_key: 'head-done', input_revision: 1, result: { text: 'Head output' } });
    }
    const claim = owned(f.store, later.task_id);
    f.store.checkpoint({ ...claim, input_revision: 1 });
    const done = f.store.complete({ ...claim, completion_key: 'during-page', input_revision: 1, result: { data: { page: 2 } } });
    const second = f.observe({ mode: 'snapshot', limit: 1, after_task_id: first.next_task_id, watermark: first.cursor });
    const task = second.tasks[0]!;
    assert.equal(task.task_id, later.task_id); assert.equal(second.cursor, first.cursor);
    assert.ok(task.notice_sequence! > first.cursor, 'new result must not be adopted as historical baseline');
    const result = f.observe({ mode: 'changes', cursor: first.cursor }).events.find(e => e.kind === 'result_saved' && e.result?.result_id === done.result_id)!;
    assert.equal(task.notice_sequence, result.sequence);
    f.store.markRead(done.task_id); f.store.ack({ task_id: done.task_id, result_id: done.result_id!, user_accepted: true });
    const afterAck = f.observe({ mode: 'task', task_id: done.task_id }).tasks[0]!;
    assert.ok(afterAck.change_sequence > task.change_sequence);
    assert.equal(afterAck.notice_sequence, task.notice_sequence, 'read/ACK/acceptance must not create a new result origin');
  } finally { f.close(); }
});

test('manual completion and cancellation acknowledgments expose only their intended evidence', () => {
  const f = fixture(); try {
    const t = submit(f.store, 'manual'), claim = owned(f.store, t.task_id);
    f.advance(1_800_001); f.store.sweep();
    f.store.resolve({ task_id: t.task_id, resolution_key: 'resolve', decision: 'complete', basis: 'PRIVATE_BASIS', result: { text: 'Actual resolved output' } });
    const manual = f.observe({ mode: 'changes', cursor: 0 }).events.find(e => e.kind === 'manually_resolved')!;
    assert.equal(manual.result?.result.text, 'Actual resolved output');
    assert.equal(f.observe({ mode: 'task', task_id: t.task_id }).tasks[0]?.notice_sequence, manual.sequence);
    const c = submit(f.store, 'cancel'), ownedCancel = owned(f.store, c.task_id);
    f.store.cancel({ task_id: c.task_id, request_key: 'cancel', reason: 'PRIVATE_REASON' });
    f.store.ackCancel({ ...ownedCancel, ack_key: 'ack', note: 'Worker stopped' });
    const observed = f.observe({ mode: 'snapshot' });
    assert.equal(observed.tasks.find(t => t.task_id === c.task_id)?.cancellation_ack?.note, 'Worker stopped');
    assert.ok(!JSON.stringify(observed).includes(claim.claim_token));
    assert.ok(!JSON.stringify(observed).includes('PRIVATE_BASIS')); assert.ok(!JSON.stringify(observed).includes('PRIVATE_REASON'));
  } finally { f.close(); }
});

test('HTTP observation requires caller role, local origin, configured identity; rejects invalid/future ranges and reports missing task 404', async () => {
  const f = fixture(); const tokens = { caller: 'caller-fixture', worker: 'worker-fixture' };
  const service = createProductionService(f.store, new ProbeEvents(f.store, undefined, 'tasks'), tokens, undefined, undefined, f.instance);
  const unconfigured = createProductionService(f.store, new ProbeEvents(f.store, undefined, 'tasks'), tokens);
  const request = (body: unknown, headers: Record<string, string> = {}) => service.app.inject({ method: 'POST', url: '/control/observe', headers: { host: 'localhost', authorization: 'Bearer ' + tokens.caller, ...headers }, payload: body });
  try {
    finished(f.store, 'http'); const before = records(f.store);
    const ok = await request({ mode: 'snapshot' }); const body = ok.json<ObserveResponse>();
    assert.equal(ok.statusCode, 200); assert.equal(body.protocol_version, 1); assert.equal(body.instance_id, f.instance);
    assert.ok(Number.isFinite(Date.parse(body.observed_at))); assert.equal(records(f.store), before);
    assert.equal((await request({ mode: 'snapshot' }, { authorization: 'Bearer ' + tokens.worker })).statusCode, 401);
    assert.equal((await request({ mode: 'snapshot' }, { origin: 'http://localhost' })).statusCode, 403);
    assert.equal((await request({ mode: 'snapshot' }, { host: 'external.example' })).statusCode, 403);
    for (const invalid of [{ mode: 'changes', cursor: -1 }, { mode: 'changes', cursor: 1.1 }, { mode: 'changes', cursor: Number.MAX_SAFE_INTEGER + 1 }, { mode: 'changes', cursor: body.cursor + 1 }, { mode: 'snapshot', limit: 0 }, { mode: 'snapshot', limit: 101 }, { mode: 'snapshot', after_task_id: randomUUID() }, { mode: 'snapshot', watermark: body.cursor }, { mode: 'snapshot', after_task_id: randomUUID(), watermark: body.cursor + 1 }, { mode: 'task', task_id: 'invalid' }, { mode: 'snapshot', credential: 'extra' }])
      assert.equal((await request(invalid)).statusCode, 400, JSON.stringify(invalid));
    const missing = await request({ mode: 'task', task_id: randomUUID() }); assert.equal(missing.statusCode, 404); assert.equal(missing.json().error, 'task_not_found');
    const noIdentity = await unconfigured.app.inject({ method: 'POST', url: '/control/observe', headers: { host: 'localhost', authorization: 'Bearer ' + tokens.caller }, payload: { mode: 'snapshot' } });
    assert.equal(noIdentity.statusCode, 503); assert.equal(noIdentity.json().error, 'observer_identity_unconfigured');
    assert.equal(records(f.store), before);
  } finally { await service.close(); await unconfigured.close(); f.close(); }
});

test('observer coexists with owner-notify fifth argument without invoking adapter or changing task receipts', async () => {
  const f = fixture(); let sends = 0; let bindingReads = 0;
  const service = createProductionService(f.store, new ProbeEvents(f.store, undefined, 'tasks'), { caller: 'fixture', worker: 'worker' }, undefined, {
    instanceId: f.instance,
    notifier: { async send() { sends++; throw new Error('observer must never send'); } },
    readCurrentConfig() { bindingReads++; throw new Error('observer must not use worker binding guards'); },
  }, f.instance);
  try {
    finished(f.store, 'owner-coexistence'); const before = records(f.store);
    const response = await service.app.inject({ method: 'POST', url: '/control/observe', headers: { host: 'localhost', authorization: 'Bearer fixture' }, payload: { mode: 'snapshot' } });
    assert.equal(response.statusCode, 200); assert.equal(response.json().instance_id, f.instance);
    assert.equal(sends, 0); assert.equal(bindingReads, 0); assert.equal(records(f.store), before);
  } finally { await service.close(); f.close(); }
});
