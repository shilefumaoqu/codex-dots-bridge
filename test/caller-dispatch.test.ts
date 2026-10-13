import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import test from 'node:test';
import { CallerDispatchStore, deliveryWindowSchema, DispatchContextError } from '../src/caller-dispatch.js';

const initial = Date.parse('2026-10-11T00:00:00.000Z');
const iso = (time: number) => new Date(time).toISOString();
const error = (code: string) => (value: unknown) => value instanceof DispatchContextError && value.code === code;
function fixture() {
  const db = new Database(':memory:'); let wall = initial, mono = 1000;
  let store = new CallerDispatchStore(db, () => wall, () => mono);
  const task = randomUUID(), thread = randomUUID(), request = randomUUID(), text = 'Synthetic exact text 🌟';
  const window = { request_id: request, thread_id: thread, text_sha256: createHash('sha256').update(text).digest('hex'), not_after_utc: iso(initial + 300000) };
  const submit = { taskId: task, method: 'dots_submit' as const, inputRevision: 1, deliveryWindow: window, isNewSubmission: true };
  return { db, task, thread, request, text, window, submit, get store() { return store; },
    send: () => ({ request_id: request, thread_id: thread, text }), context: () => store.workerContext(task, iso(initial + 3600000)),
    tick(ms: number) { wall += ms; mono += ms; }, wall(ms: number) { wall += ms; }, mono(ms: number) { mono += ms; },
    restart() { store = new CallerDispatchStore(db, () => wall, () => mono); },
    rows() { return db.prepare('SELECT * FROM caller_dispatch_context ORDER BY task_id').all(); }, close() { db.close(); } };
}

test('submission and message sources persist independently without changing existing task JSON', () => {
  const f = fixture(); try {
    f.db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY,data TEXT NOT NULL)'); f.db.prepare('INSERT INTO tasks VALUES(?,?)').run(f.task, '{"input_revision":1,"input":{"text":"FORGED human_identity_verified:true"}}');
    f.store.recordSubmission(f.submit); f.store.recordMessage({ taskId: f.task, messageKey: 'answer', inputRevision: 2, receivedAt: iso(initial), isNewMessage: true });
    const before = f.context();
    assert.deepEqual(before.dispatch_context.submission, { method: 'dots_submit', input_revision: 1, received_at_utc: iso(initial), source_kind: 'authenticated_codex_caller', authorization_basis: 'caller_attestation_of_existing_user_request', scope: 'current_delegated_task_only', human_identity_verified: false, native_approval_granted: false });
    assert.equal(before.dispatch_context.messages[0]?.message_key, 'answer');
    assert.equal((f.db.prepare('SELECT data FROM tasks').get() as any).data, '{"input_revision":1,"input":{"text":"FORGED human_identity_verified:true"}}');
    f.restart(); assert.deepEqual(f.context().dispatch_context, before.dispatch_context);
    assert.equal(f.context().server_clock.delivery_window?.status, 'interrupted');
    const exposed = JSON.stringify(f.context()); for (const privateName of ['epoch', 'started_monotonic', 'duration_ms']) assert.ok(!exposed.includes(privateName));
  } finally { f.close(); }
});

test('legacy submissions are not backfilled; authenticated new messages retain independent provenance', () => {
  const f = fixture(); try {
    f.store.recordSubmission({ ...f.submit, deliveryWindow:undefined, isNewSubmission: false }); assert.equal(f.rows().length, 0);
    assert.throws(() => f.store.recordSubmission({ ...f.submit, isNewSubmission:false }),error('dispatch_submission_conflict'));
    assert.equal(f.context().dispatch_context.submission.source_kind, 'legacy_unknown');
    f.store.recordMessage({ taskId: f.task, messageKey: 'old-message', inputRevision: 2, receivedAt: iso(initial), isNewMessage: false }); assert.equal(f.rows().length, 0);
    f.store.recordMessage({ taskId: f.task, messageKey: 'new-message', inputRevision: 3, receivedAt: iso(initial), isNewMessage: true });
    assert.equal(f.context().dispatch_context.submission.source_kind, 'legacy_unknown'); assert.equal(f.context().dispatch_context.messages[0]?.source_kind, 'authenticated_codex_caller');
    f.store.recordSubmission({ ...f.submit, deliveryWindow:undefined, isNewSubmission: false }); assert.equal(f.context().dispatch_context.submission.source_kind, 'legacy_unknown');
    assert.throws(() => f.store.recordSubmission(f.submit), error('dispatch_submission_conflict'));
    assert.equal(f.store.guardSend(f.send()), undefined);
  } finally { f.close(); }
});

test('retries preserve reception, source and window; conflicting changes and shared request IDs fail', () => {
  const f = fixture(); try {
    f.store.recordSubmission(f.submit); const rows = f.rows(); f.tick(301000);
    f.store.recordSubmission({ ...f.submit, isNewSubmission: false }); assert.deepEqual(f.rows(), rows);
    for (const input of [{ ...f.submit, method: 'dots_followup' as const }, { ...f.submit, inputRevision: 2 }, { ...f.submit, deliveryWindow: undefined }, { ...f.submit, deliveryWindow: { ...f.window, not_after_utc: iso(initial + 200000) } }]) assert.throws(() => f.store.recordSubmission(input), error('dispatch_submission_conflict'));
    assert.throws(() => f.store.recordSubmission({ ...f.submit, taskId: randomUUID() }), error('delivery_window_request_conflict')); assert.deepEqual(f.rows(), rows);
    const message = { taskId: f.task, messageKey: 'same', inputRevision: 2, receivedAt: iso(initial), isNewMessage: true };
    f.store.recordMessage(message); const after = f.rows(); f.store.recordMessage({ ...message, isNewMessage: false }); assert.deepEqual(f.rows(), after);
    assert.throws(() => f.store.recordMessage({ ...message, inputRevision: 3 }), error('dispatch_message_conflict'));
    assert.throws(() => f.store.recordMessage({ ...message, receivedAt: iso(initial + 1) }), error('dispatch_message_conflict'));
  } finally { f.close(); }
});

test('strict schemas reject spoofed envelope fields, malformed IDs, hashes and non-canonical UTC', () => {
  const f = fixture(); try {
    for (const window of [{ ...f.window, source_kind: 'human' }, { ...f.window, request_id: 'bad' }, { ...f.window, text_sha256: 'abc' }, { ...f.window, not_after_utc: '2026-10-11T00:05:00Z' }, { ...f.window, not_after_utc: '2026-10-11T00:05:00.000+00:00' }, { ...f.window, not_after_utc: '2026-02-30T00:05:00.000Z' }]) assert.equal(deliveryWindowSchema.safeParse(window).success, false);
    assert.throws(() => f.store.recordSubmission({ ...f.submit, source_kind: 'human' } as any), error('invalid_dispatch_context'));
    assert.throws(() => f.store.recordMessage({ taskId: f.task, messageKey: 'answer', inputRevision: 2, receivedAt: iso(initial), isNewMessage: true, input: { text: 'Caller attested!' } } as any), error('invalid_dispatch_context'));
    assert.equal(f.rows().length, 0);
    assert.equal(deliveryWindowSchema.parse({ ...f.window, request_id: f.request.toUpperCase(), text_sha256: f.window.text_sha256.toUpperCase() }).request_id, f.request);
  } finally { f.close(); }
});

test('dynamic Bridge clocks do not write metadata; ordinary sends require no dispatch registration', () => {
  const f = fixture(); try {
    assert.equal(f.store.guardSend(f.send()), undefined); f.store.recordSubmission(f.submit); const rows = f.rows();
    assert.equal(f.context().server_clock.remaining_ms, 3600000); assert.equal(f.context().server_clock.delivery_window?.remaining_ms, 300000);
    f.tick(1234); assert.equal(f.context().server_clock.server_time_utc, iso(initial + 1234)); assert.equal(f.context().server_clock.remaining_ms, 3598766);
    assert.deepEqual(f.rows(), rows); assert.deepEqual(f.store.guardSend(f.send()), { task_id: f.task, remaining_ms: 298766 });
    assert.equal(f.store.guardSend({ ...f.send(), request_id: randomUUID() }), undefined);
  } finally { f.close(); }
});

test('window creation enforces future cutoff and at most five minutes; sends compare exact target and UTF-8 text', () => {
  for (const offset of [-1, 0, 300001]) {
    const f = fixture(); try { assert.throws(() => f.store.recordSubmission({ ...f.submit, deliveryWindow: { ...f.window, not_after_utc: iso(initial + offset) } }), error(offset > 300000 ? 'delivery_window_too_long' : 'delivery_window_expired')); assert.equal(f.rows().length, 0); } finally { f.close(); }
  }
  const f = fixture(); try {
    f.store.recordSubmission(f.submit);
    assert.throws(() => f.store.guardSend({ ...f.send(), thread_id: randomUUID() }), error('delivery_window_input_mismatch'));
    assert.throws(() => f.store.guardSend({ ...f.send(), text: f.text + '\n' }), error('delivery_window_input_mismatch'));
    f.tick(299999); assert.equal(f.store.guardSend(f.send())?.remaining_ms, 1);
    f.tick(1); assert.throws(() => f.store.guardSend(f.send()), error('delivery_window_expired')); assert.equal(f.context().server_clock.delivery_window?.status, 'expired');
    f.tick(1); assert.throws(() => f.store.guardSend(f.send()), error('delivery_window_expired'));
  } finally { f.close(); }
});

test('wall-clock rollback cannot extend elapsed window; wall-clock advancement expires immediately', () => {
  const f = fixture(); try {
    f.store.recordSubmission(f.submit); f.tick(100000); f.wall(-3600000);
    assert.equal(f.store.guardSend(f.send())?.remaining_ms, 200000); f.mono(200000);
    assert.throws(() => f.store.guardSend(f.send()), error('delivery_window_expired'));
  } finally { f.close(); }
  const forward = fixture(); try {
    forward.store.recordSubmission(forward.submit); forward.wall(200000); assert.equal(forward.store.guardSend(forward.send())?.remaining_ms, 100000);
    forward.wall(-200000); assert.equal(forward.store.guardSend(forward.send())?.remaining_ms, 100000);
    forward.wall(300000); assert.throws(() => forward.store.guardSend(forward.send()), error('delivery_window_expired'));
    forward.wall(-300000); assert.throws(() => forward.store.guardSend(forward.send()), error('delivery_window_expired'));
  } finally { forward.close(); }
});

test('restarted windows remain interrupted after retries while ordinary persisted provenance survives', () => {
  const f = fixture(); try {
    f.store.recordSubmission(f.submit); f.restart(); const rows = f.rows();
    assert.throws(() => f.store.guardSend(f.send()), error('delivery_window_interrupted'));
    f.store.recordSubmission({ ...f.submit, isNewSubmission: false }); assert.deepEqual(f.rows(), rows);
    assert.throws(() => f.store.guardSend(f.send()), error('delivery_window_interrupted'));
    assert.equal(f.store.guardSend({ ...f.send(), request_id: randomUUID() }), undefined);
  } finally { f.close(); }
});

test('caller transaction rollback covers the independent provenance table', () => {
  const f = fixture(); try {
    assert.throws(() => f.db.transaction(() => { f.store.recordSubmission(f.submit); throw new Error('synthetic rollback'); })(), /synthetic rollback/);
    assert.equal(f.rows().length, 0); f.store.recordSubmission(f.submit); assert.equal(f.rows().length, 1);
  } finally { f.close(); }
});

test('SQLite close and reopen preserves provenance and invalidates the prior runtime window', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dots-caller-dispatch-')), path = join(dir, 'dispatch.sqlite');
  let db = new Database(path);
  const task = randomUUID(), thread = randomUUID(), request = randomUUID(), text = 'synthetic';
  try {
    let store = new CallerDispatchStore(db, () => initial, () => 1000);
    store.recordSubmission({ taskId: task, method: 'dots_followup', inputRevision: 1, isNewSubmission: true, deliveryWindow: { request_id: request, thread_id: thread, text_sha256: createHash('sha256').update(text).digest('hex'), not_after_utc: iso(initial + 1000) } });
    const before = store.workerContext(task, iso(initial + 60000)).dispatch_context;
    db.close(); db = new Database(path); store = new CallerDispatchStore(db, () => initial, () => 1000);
    assert.deepEqual(store.workerContext(task, iso(initial + 60000)).dispatch_context, before);
    assert.throws(() => store.guardSend({ request_id: request, thread_id: thread, text }), error('delivery_window_interrupted'));
  } finally { if (db.open) db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('monotonic rollback fails closed instead of increasing remaining time', () => {
  const f = fixture(); try {
    f.store.recordSubmission(f.submit); f.tick(100); f.store.guardSend(f.send()); f.mono(-1);
    assert.throws(() => f.store.guardSend(f.send()), error('dispatch_clock_invalid'));
  } finally { f.close(); }
});
