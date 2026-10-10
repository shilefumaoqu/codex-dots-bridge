import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readNativeStoredHistory } from '../src/desktop-conversation-reader.js';
import { readerFixture } from './desktop-conversation-reader-fixture.js';

async function fixture(action: (home: string, id: string, signal: AbortSignal) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'native-reader-')), id = randomUUID(), controller = new AbortController();
  try { await action(home, id, controller.signal); } finally { controller.abort(); rmSync(home, { recursive: true, force: true }); }
}
test('notLoaded native read uses only metadata and full ascending pages, preserves every item and cleans process', async () => fixture(async (home, id, signal) => {
  const f = readerFixture(id), result = await readNativeStoredHistory({ threadId: id, codexHome: home, signal, deadline: Date.now() + 1000 }, f.testing);
  assert.equal(result.verification, 'native_stored_history'); assert.equal(result.history_source, 'codex_app_server'); assert.equal(result.stored_history_complete, true); assert.equal(result.source_complete, false);
  assert.deepEqual(JSON.parse(result.context_json), { thread: { ...f.thread, turns: f.turns }, turns_source: 'thread/turns/list:full' });
  assert.equal(Object.hasOwn(result, 'desktop_state'), false); assert.equal(f.killed(), true); assert(f.child.stdin.destroyed); assert(f.child.stdout.destroyed);
  assert.deepEqual(f.args(), ['app-server', '--stdio']); assert.equal(f.options().env.CODEX_HOME, home); assert.equal(f.options().shell, false); assert.equal(f.options().windowsHide, true); assert.deepEqual(f.options().stdio, ['pipe', 'pipe', 'ignore']);
  assert.deepEqual(f.frames.map(frame => frame.method), ['initialize', 'initialized', 'thread/read', 'thread/turns/list', 'thread/turns/list']);
  assert.equal(f.frames[2].params.includeTurns, false); assert.equal(f.frames[3].params.itemsView, 'full'); assert.equal(f.frames[3].params.sortDirection, 'asc'); assert.equal(f.frames[4].params.cursor, 'opaque-next');
}));
test('UTF8 chunks can split an emoji and preserve long tool output without truncation', async () => fixture(async (home, id, signal) => {
  const f = readerFixture(id, (frame, f) => {
    if (frame.method !== 'thread/turns/list') return false;
    const bytes = Buffer.from(JSON.stringify({ id: frame.id, result: { data: f.turns, nextCursor: null } }) + '\n');
    const start = bytes.indexOf(Buffer.from('🌟')); f.receive(bytes.subarray(0, start + 2)); f.receive(bytes.subarray(start + 2)); return true;
  });
  f.turns[1].items[0].aggregatedOutput = '完整原始工具🌟'.repeat(10000);
  const result = await readNativeStoredHistory({ threadId: id, codexHome: home, signal, deadline: Date.now() + 1000 }, f.testing);
  assert(result.context_json.length > 32000); assert.deepEqual(JSON.parse(result.context_json).thread.turns, f.turns); assert.equal(f.killed(), true);
}));
for (const mode of ['identity', 'missing_cursor', 'cursor_loop', 'duplicate', 'summary', 'error', 'stdout_error', 'server_request', 'invalid_utf8', 'oversize', 'early_close', 'timeout', 'abort'] as const) {
  test(`${mode} cannot complete, perform execution or leak source errors; own child is cleaned`, async () => fixture(async (home, id) => {
    const controller = new AbortController();
    const f = readerFixture(id, (frame, f) => {
      if (mode === 'identity' && frame.method === 'thread/read') { f.receive({ id: frame.id, result: { thread: { ...f.thread, id: randomUUID() } } }); return true; }
      if (frame.method !== 'thread/turns/list') return false;
      if (mode === 'timeout') return true;
      if (mode === 'abort') { controller.abort(); return true; }
      if (mode === 'stdout_error') { f.child.stdout.emit('error', Object.assign(new Error('SECRET_PIPE_ERROR'), { code: 'EIO' })); return true; }
      if (mode === 'error') { f.receive({ id: frame.id, error: { code: -1, message: 'SECRET_PRIVATE_PATH' } }); return true; }
      if (mode === 'server_request') { f.receive({ id: 999, method: 'item/commandExecution/requestApproval', params: { command: 'DO_NOT_EXEC' } }); return true; }
      if (mode === 'invalid_utf8') { f.receive(Buffer.from([0xff, 10])); return true; }
      if (mode === 'oversize') { f.receive(Buffer.alloc(32 * 1024 * 1024 + 1, 120)); return true; }
      if (mode === 'early_close') { f.child.emit?.('close', 0); return true; }
      if (mode === 'missing_cursor') { f.receive({ id: frame.id, result: { data: f.turns } }); return true; }
      if (mode === 'summary') { f.receive({ id: frame.id, result: { data: [{ ...f.turns[0], itemsView: 'summary' }], nextCursor: null } }); return true; }
      if (mode === 'cursor_loop') { f.receive({ id: frame.id, result: { data: [{ ...f.turns[0], id: randomUUID() }], nextCursor: 'same-cursor' } }); return true; }
      if (mode === 'duplicate') { f.receive({ id: frame.id, result: { data: [f.turns[0]], nextCursor: frame.params.cursor ? null : 'next' } }); return true; }
      return false;
    });
    await assert.rejects(readNativeStoredHistory({ threadId: id, codexHome: home, signal: controller.signal, deadline: Date.now() + (mode === 'timeout' ? 25 : 1000) }, f.testing), error => {
      assert(!String(error).includes('SECRET')); assert(!String(error).includes(home)); return true;
    });
    if (mode !== 'early_close') assert.equal(f.killed(), true); assert(f.child.stdin.destroyed); assert(f.child.stdout.destroyed);
    assert(f.frames.every(frame => ['initialize', 'initialized', 'thread/read', 'thread/turns/list'].includes(frame.method)));
  }));
}
test('remote homes and already aborted inputs never start a process', async () => {
  const signal = new AbortController().signal, testing = { spawn: () => { assert.fail('no process'); } };
  await assert.rejects(readNativeStoredHistory({ threadId: randomUUID(), codexHome: String.raw`\\remote\share`, signal, deadline: Date.now() + 1000 }, testing), /target_path_invalid/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readNativeStoredHistory({ threadId: randomUUID(), codexHome: 'unused', signal: controller.signal, deadline: Date.now() + 1000 }, testing), /closed/);
});
