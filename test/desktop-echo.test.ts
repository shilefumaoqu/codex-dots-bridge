import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopEchoService, type DesktopEchoOptions, type DesktopEchoConfig } from '../src/desktop-echo.js';
import { echoMarker } from '../src/desktop-echo-ipc.js';

// These are synthetic local-log/IPC simulations, not a desktop acceptance test.
function fixture(options: DesktopEchoOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cdb-desktop-echo-')); const db = new Database(':memory:');
  const thread = randomUUID(), request = randomUUID(), turn = randomUUID();
  const path = join(dir, 'rollout.jsonl'); writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { id: thread } }) + '\n');
  const config: DesktopEchoConfig = { enabled: true, thread_id: thread, request_id: request, rollout_path: path, expires_at: new Date(Date.now() + 240000).toISOString() };
  const service = new DesktopEchoService(db, config, { timeoutMs: 100, pollMs: 2, ...options });
  return { dir, db, path, config, service, thread, request, turn,
    complete(text = echoMarker(request), turnId = turn, timing?: { started_at: string | number; completed_at: string | number }) { appendFileSync(path, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId, last_agent_message: text, started_at: new Date().toISOString(), completed_at: new Date().toISOString(), duration_ms: 1, ...timing } }) + '\n'); },
    async cleanup() { await service.close(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function terminal(f: ReturnType<typeof fixture>) {
  for (let i = 0; i < 100; i++) { const value = f.service.get({ request_id: f.request }); if (value.status !== 'pending') return value; await new Promise(done => setTimeout(done, 5)); }
  assert.fail('executor did not settle');
}
test('durable single reservation: concurrent duplicates, exact ACK turn and future marker, nonce, unchanged forward tables', async () => {
  let calls = 0; let f: ReturnType<typeof fixture>;
  // This checks reservation/identity semantics, not a 100ms performance deadline.
  // Leave room for Windows filesystem and runner scheduling; timeout cases keep
  // the short fixture budget. The production 60-second limit is unchanged.
  f = fixture({ timeoutMs: 2000, runIpc: async input => {
    calls++; assert.equal(input.threadId, f.thread); assert.equal(input.requestId, f.request);
    const stored = JSON.parse((f.db.prepare('SELECT data FROM desktop_echo_requests WHERE request_id=?').get(f.request) as {data: string}).data);
    assert.equal(stored.result.status, 'pending'); assert.equal(stored.sent, false);
    input.beforeSend(); f.complete(echoMarker(f.request), randomUUID()); f.complete(); return { status: 'accepted', turnId: f.turn };
  } });
  f.db.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY,data TEXT); INSERT INTO tasks VALUES ('forward', 'untouched')");
  const before = f.db.prepare('SELECT * FROM tasks').all();
  try {
    const values = await Promise.all(Array.from({ length: 20 }, async () => f.service.start({ request_id: f.request })));
    assert(values.every(value => value.status === 'pending')); const result = await terminal(f);
    assert.equal(result.status, 'completed_match', JSON.stringify(result)); assert.equal(result.verification, 'exact_turn_echo'); assert.equal(result.echo, echoMarker(f.request)); assert.match(result.receipt_nonce!, /^[a-f0-9]{64}$/);
    assert.deepEqual(f.service.start({ request_id: f.request }), result); assert.equal(calls, 1);
    const stored = JSON.parse((f.db.prepare('SELECT data FROM desktop_echo_requests WHERE request_id=?').get(f.request) as {data:string}).data);
    assert.equal(stored.turn_id, f.turn); assert.match(stored.acknowledged_at, /^\d{4}-/);
    assert.match(stored.sent_at, /^\d{4}-/);
    assert.deepEqual(f.db.prepare('SELECT * FROM tasks').all(), before);
    const publicText = JSON.stringify(result); assert(!publicText.includes(f.path)); assert(!publicText.includes(f.thread)); assert(!publicText.includes(f.turn));
  } finally { await f.cleanup(); }
});
for (const status of ['skipped_busy', 'skipped_unknown', 'skipped_unreachable'] as const) test(`${status} does not send or repeat`, async () => {
  let calls = 0; const f = fixture({ runIpc: async () => { calls++; return { status, reason: 'ipc_unavailable' }; } });
  try { f.service.start({ request_id: f.request }); assert.equal((await terminal(f)).status, status); f.service.start({ request_id: f.request }); assert.equal(calls, 1); }
  finally { await f.cleanup(); }
});
test('ACK loss is uncertain, sanitized, no retransmission', async () => {
  let calls = 0; const f = fixture({ runIpc: async input => { calls++; input.beforeSend(); throw new Error('secret target path raw error'); } });
  try { f.service.start({ request_id: f.request }); const result = await terminal(f); assert.equal(result.status, 'uncertain'); assert(!JSON.stringify(result).includes('secret')); f.service.start({ request_id: f.request }); assert.equal(calls, 1); }
  finally { await f.cleanup(); }
});
test('expired config cannot send, remains queryable; new request and extra remote keys rejected', async () => {
  let calls = 0; let now = Date.now(); const f = fixture({ now: () => now, runIpc: async () => { calls++; return { status: 'skipped_unknown', reason: 'ipc_unavailable' }; } });
  try {
    now += 300000; assert.throws(() => f.service.start({ request_id: randomUUID() }), /request_not_configured/);
    assert.throws(() => f.service.start({ request_id: f.request, text: 'free command' } as any), /invalid_request/);
    f.service.start({ request_id: f.request }); const result = await terminal(f); assert.equal(result.reason, 'config_expired'); assert.equal(calls, 0); assert.deepEqual(f.service.get({ request_id: f.request }), result);
  } finally { await f.cleanup(); }
});
test('foreign target log and invalid EOF fail closed before IPC', async () => {
  for (const content of [JSON.stringify({ type: 'session_meta', payload: { id: randomUUID() } }) + '\n', '{"type":"session_meta"}']) {
    let calls = 0; const f = fixture({ runIpc: async () => { calls++; return { status: 'skipped_unknown', reason: 'ipc_unavailable' }; } });
    try { writeFileSync(f.path, content); f.service.start({ request_id: f.request }); assert.equal((await terminal(f)).status, 'skipped_unknown'); assert.equal(calls, 0); }
    finally { await f.cleanup(); }
  }
});
test('historical matching echo and late wrong-turn echo never verify', async () => {
  let f: ReturnType<typeof fixture>; f = fixture({ runIpc: async input => { input.beforeSend(); f.complete(echoMarker(f.request), randomUUID()); return { status: 'accepted', turnId: f.turn }; } });
  try { f.complete(); f.service.start({ request_id: f.request }); const result = await terminal(f); assert.equal(result.status, 'uncertain'); assert.equal(result.verification, 'not_verified'); assert.equal(result.receipt_nonce, undefined); }
  finally { await f.cleanup(); }
});
test('exact turn echo mismatch is uncertain without exposing response', async () => {
  let f: ReturnType<typeof fixture>; f = fixture({ runIpc: async input => { input.beforeSend(); f.complete('private conversation text'); return { status: 'accepted', turnId: f.turn }; } });
  try { f.service.start({ request_id: f.request }); const result = await terminal(f); assert.equal(result.status, 'uncertain'); assert.equal(result.reason, 'echo_mismatch'); assert(!JSON.stringify(result).includes('private conversation')); }
  finally { await f.cleanup(); }
});
test('close aborts live IPC and settles before db.close; no new executor', async () => {
  let aborted = false; const f = fixture({ runIpc: async input => { input.beforeSend(); await new Promise<void>(resolve => input.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true })); return { status: 'uncertain', reason: 'send_outcome_unknown' }; } });
  try {
    f.service.start({ request_id: f.request }); await new Promise(done => setTimeout(done, 5)); await f.service.close(); assert.equal(aborted, true);
    assert.equal(f.service.get({ request_id: f.request }).status, 'uncertain');
    assert.throws(() => new DesktopEchoService(f.db, { ...f.config, request_id: randomUUID(), expires_at: new Date(Date.now() + 360000).toISOString() }), /invalid_config/);
  } finally { await f.cleanup(); }
});
test('startup reservations require reconciliation and config binding is immutable', async () => {
  const f = fixture();
  try {
    // Simulate crash by seeding a durable reservation after the prior instance closes.
    await f.service.close();
    const service = new DesktopEchoService(f.db, f.config, { runIpc: async () => { assert.fail('restart must not connect'); } });
    service.start({ request_id: f.request }); await service.close();
    const row = JSON.parse((f.db.prepare('SELECT data FROM desktop_echo_requests WHERE request_id=?').get(f.request) as {data:string}).data);
    row.result.status = 'pending'; row.sent = true; f.db.prepare('UPDATE desktop_echo_requests SET data=? WHERE request_id=?').run(JSON.stringify(row), f.request);
    const recovered = new DesktopEchoService(f.db, f.config); assert.equal(recovered.get({ request_id: f.request }).status, 'reconciliation_required'); assert.equal(recovered.start({ request_id: f.request }).status, 'reconciliation_required'); await recovered.close();
    const foreign = new DesktopEchoService(f.db, { ...f.config, thread_id: randomUUID() }); assert.throws(() => foreign.get({ request_id: f.request }), /request_binding_conflict/); await foreign.close();
    const expired = new DesktopEchoService(f.db, f.config, { now: () => Date.now() + 300000 }); assert.equal(expired.get({ request_id: f.request }).status, 'reconciliation_required'); await expired.close();
  } finally { await f.cleanup(); }
});
test('second service on live database is rejected without rewriting active reservation', async () => {
  const f = fixture(); try { assert.throws(() => new DesktopEchoService(f.db, f.config), /desktop_echo_already_open/); } finally { await f.cleanup(); }
});
test('fatal UTF8 in session identity and future log lines fails closed', async () => {
  for (const atHead of [true, false]) {
    let calls = 0; let f: ReturnType<typeof fixture>;
    f = fixture({ runIpc: async input => { calls++; input.beforeSend(); appendFileSync(f.path, Buffer.from([0xff, 0x0a])); f.complete(); return { status: 'accepted', turnId: f.turn }; } });
    try { if (atHead) writeFileSync(f.path, Buffer.from([0xff, 0x0a])); f.service.start({ request_id: f.request }); const result = await terminal(f); assert.equal(result.status, atHead ? 'skipped_unknown' : 'uncertain'); assert.equal(calls, atHead ? 0 : 1); }
    finally { await f.cleanup(); }
  }
});
test('marker must match byte-for-byte; surrounding whitespace does not verify', async () => {
  for (const wrap of [(text: string) => ` ${text}`, (text: string) => `${text}\n`, (text: string) => `\t${text} `]) {
    let f: ReturnType<typeof fixture>; f = fixture({ runIpc: async input => { input.beforeSend(); f.complete(wrap(echoMarker(f.request))); return { status: 'accepted', turnId: f.turn }; } });
    try { f.service.start({ request_id: f.request }); const result = await terminal(f); assert.equal(result.status, 'uncertain'); assert.equal(result.reason, 'echo_mismatch'); assert.equal(result.receipt_nonce, undefined); }
    finally { await f.cleanup(); }
  }
});
test('future EOF completion still rejects old dates, future dates and reversed timing', async () => {
  for (const mode of ['old', 'future', 'reverse'] as const) {
    let f: ReturnType<typeof fixture>; f = fixture({ runIpc: async input => {
      input.beforeSend(); const now = Date.now();
      const started_at = new Date(mode === 'old' ? now - 86400000 : mode === 'future' ? now + 86400000 : now).toISOString();
      const completed_at = new Date(mode === 'old' ? now - 86400000 + 1 : mode === 'future' ? now + 86400000 + 1 : now - 1).toISOString();
      f.complete(echoMarker(f.request), f.turn, { started_at, completed_at }); return { status: 'accepted', turnId: f.turn };
    } });
    try { f.service.start({ request_id: f.request }); const result = await terminal(f); assert.equal(result.status, 'uncertain', mode); assert.equal(result.reason, 'echo_invalid', mode); assert.equal(result.receipt_nonce, undefined); }
    finally { await f.cleanup(); }
  }
});
test('official epoch-second timestamps allow one-second quantization for current completion', async () => {
  let f: ReturnType<typeof fixture>; f = fixture({ runIpc: async input => { input.beforeSend(); const seconds = Math.floor(Date.now() / 1000); f.complete(echoMarker(f.request), f.turn, { started_at: seconds, completed_at: seconds }); return { status: 'accepted', turnId: f.turn }; } });
  try { f.service.start({ request_id: f.request }); assert.equal((await terminal(f)).status, 'completed_match'); }
  finally { await f.cleanup(); }
});
