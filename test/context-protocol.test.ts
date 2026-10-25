import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { TaskStore } from '../src/task-store.js';
import { ProbeEvents } from '../src/events.js';
import { createProductionService, contextSchemas } from '../src/bridge.js';
import { ContextServiceError, type ContextService } from '../src/context-service.js';

const tokens = { caller: 'a'.repeat(64), worker: 'b'.repeat(64) };
const contextNames = Object.keys(contextSchemas).sort();
type Args = Record<string, unknown>;
type ContextMock = { enabled: boolean; get(args: unknown): Promise<unknown>; update(args: unknown): unknown;
  forget(args: unknown): unknown; close(): Promise<void> };

async function fixture(context: ContextMock | undefined, operation: (f: {
  store: TaskStore; rpc(method: string, params?: Args, token?: string): Promise<{status: number; body: any}>;
  control(name: string, args: Args, token?: string): Promise<{status: number; body: any}>;
}) => Promise<void>) {
  const store = new TaskStore(':memory:');
  const service = createProductionService(store, new ProbeEvents(store, async () => ({status: 200, body: '{}'}), 'tasks'),
    tokens, undefined, undefined, undefined, undefined, undefined, context as unknown as ContextService);
  try {
    const endpoint = await service.start(); let id = 0;
    const rpc = async (method: string, params: Args = {}, token = tokens.worker) => {
      const response = await fetch(new URL('mcp/dot', endpoint), {method: 'POST',
        headers: {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Connection: 'close',
          'X-Codex-Dots-Worker-Token': token, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method,
          ...(method === 'tools/call' ? {'Mcp-Name': String(params.name)} : {})},
        body: JSON.stringify({jsonrpc: '2.0', id: ++id, method, params: {...params,
          _meta: {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}}}}),
        signal: AbortSignal.timeout(5000)});
      return {status: response.status, body: await response.json()};
    };
    const control = async (name: string, args: Args, token = tokens.caller) => {
      const response = await fetch(new URL('control/' + name, endpoint), {method: 'POST',
        headers: {'content-type': 'application/json', Connection: 'close', authorization: 'Bearer ' + token},
        body: JSON.stringify(args), signal: AbortSignal.timeout(5000)});
      return {status: response.status, body: await response.json()};
    };
    await operation({store, rpc, control});
  } finally { await service.close(); store.close(); }
}
const unpack = (body: any) => {
  assert.ok(!body.error); assert.equal(body.result.isError, false);
  return JSON.parse(body.result.content[0].text);
};
const emptyState = () => ({task: [], requirements: [], completed: [], pending: [], execution: [], gaps: []});

test('disabled continuation cannot start source reads; worker forward queue retains its original tools', async () => {
  for (const enabled of [undefined, false]) {
    let called = 0;
    const context = enabled === undefined ? undefined : {enabled, get: async () => {called++;}, update: () => {called++;},
      forget: () => {called++;}, close: async () => {}};
    await fixture(context, async f => {
      const names = (await f.rpc('tools/list')).body.result.tools.map((tool: any) => tool.name);
      assert.deepEqual(names.sort(), ['list_tasks','get_task','claim_task','checkpoint_task','request_input',
        'complete_task','fail_task','ack_cancel','notify_owner','dots_chat_send','dots_chat_status'].sort());
      for (const name of contextNames) assert.equal(names.includes(name), false);
      const rejected = await f.control('codex_get_context', {request_id: randomUUID(), thread_id: randomUUID()});
      assert.equal(rejected.status, 409); assert.equal(rejected.body.error, 'context_read_disabled');
      assert.equal(called, 0); assert.equal(f.store.status().tasks.length, 0);
    });
  }
});

test('both authenticated entries expose one continuation service; metadata does not retain evidence or state', async () => {
  const calls: {name: string; args: any}[] = []; let closed = 0;
  const context = {enabled: true, get: async (args: unknown) => {
    calls.push({name: 'get', args}); return {status: 'pending', evidence: 'SECRET_EVIDENCE'};
  }, update: (args: unknown) => {calls.push({name: 'update', args}); return {status: 'updated'};},
  forget: (args: unknown) => {calls.push({name: 'forget', args}); return {status: 'forgotten'};},
  close: async () => {closed++;}};
  await fixture(context, async f => {
    const tools = (await f.rpc('tools/list')).body.result.tools;
    for (const name of contextNames) assert.ok(tools.some((tool: any) => tool.name === name));
    assert.equal(tools.find((tool: any) => tool.name === 'codex_get_context').annotations.readOnlyHint, true);
    assert.equal(tools.find((tool: any) => tool.name === 'codex_forget_context').annotations.destructiveHint, true);
    const get = {request_id: randomUUID(), thread_id: randomUUID(), mode: 'evidence', refs: ['SECRET_REF']};
    assert.equal(unpack((await f.rpc('tools/call', {name: 'codex_get_context', arguments: get})).body).status, 'pending');
    assert.equal((await f.control('codex_get_context', get)).body.status, 'pending');
    assert.deepEqual(calls[0]?.args, calls[1]?.args);
    const mutation = {operation_id: randomUUID(), thread_id: get.thread_id, expected_epoch: 0,
      expected_revision: 0, read_receipt_id: randomUUID(), state: emptyState()};
    assert.equal(unpack((await f.rpc('tools/call', {name: 'codex_update_context', arguments: mutation})).body).status, 'updated');
    assert.equal((await f.control('codex_update_context', mutation)).body.status, 'updated');
    const forget = {operation_id: randomUUID(), thread_id: get.thread_id, expected_epoch: 0, expected_revision: 0};
    assert.equal((await f.control('codex_forget_context', forget)).body.status, 'forgotten');
    assert.equal(unpack((await f.rpc('tools/call', {name: 'codex_forget_context', arguments: forget})).body).status, 'forgotten');
    assert.deepEqual(calls.map(c => c.name), ['get','get','update','update','forget','forget']);
    assert.equal(f.store.status().tasks.length, 0);
    const audit = JSON.stringify(f.store.evidence());
    assert.ok(audit.includes('codex_get_context')); assert.ok(audit.includes(get.request_id));
    for (const secret of ['SECRET_EVIDENCE','SECRET_REF','source_refs','processed_refs']) assert.equal(audit.includes(secret), false);
  });
  assert.equal(closed, 1);
});

test('wrong credentials and unknown parameters cannot call context methods; queue behavior stays independent', async () => {
  let called = 0;
  await fixture({enabled: true, get: async () => {called++;}, update: () => {called++;},
    forget: () => {called++;}, close: async () => {}}, async f => {
    const args = {request_id: randomUUID(), thread_id: randomUUID()};
    assert.equal((await f.control('codex_get_context', args, tokens.worker)).status, 401);
    assert.equal((await f.rpc('tools/call', {name: 'codex_get_context', arguments: args}, tokens.caller)).status, 401);
    assert.equal((await f.control('codex_get_context', {...args, arbitrary_path: 'NO_ACCESS'})).status, 400);
    const invalid = (await f.rpc('tools/call', {name: 'codex_get_context', arguments: {...args, complete: true}})).body;
    assert.ok(invalid.error || invalid.result?.isError);
    assert.equal(called, 0);
    const task = (await f.control('dots_submit', {idempotency_key: 'context-isolation', title: 'Synthetic',
      input: {text: 'no real operation'}})).body;
    const claimed = unpack((await f.rpc('tools/call', {name: 'claim_task',
      arguments: {task_id: task.task_id, claim_key: 'synthetic-claim'}})).body);
    assert.equal(claimed.status, 'running');
    const got = unpack((await f.rpc('tools/call', {name: 'get_task', arguments: {task_id: task.task_id}})).body);
    assert.equal(got.worker_rules.rules_version, 'v8');
    assert.ok(got.worker_rules.instructions.includes('codex_get_context'));
    assert.equal(called, 0);
  });
});

test('safe context errors remain distinguishable without exposing raw exceptions', async () => {
  await fixture({enabled: true, get: async () => {throw new ContextServiceError('receipt_not_found');},
    update: () => {throw Error('SECRET_EXCEPTION');}, forget: () => {}, close: async () => {}}, async f => {
    const get = {request_id: randomUUID(), thread_id: randomUUID()};
    const result = (await f.rpc('tools/call', {name: 'codex_get_context', arguments: get})).body;
    assert.equal(JSON.parse(result.result.content[0].text).error, 'receipt_not_found');
    const update = {operation_id: randomUUID(), thread_id: get.thread_id, expected_epoch: 0,
      expected_revision: 0, read_receipt_id: randomUUID(), state: emptyState()};
    const error = (await f.control('codex_update_context', update)).body;
    assert.equal(error.error, 'bridge_operation_failed');
    assert.equal(JSON.stringify(error).includes('SECRET_EXCEPTION'), false);
  });
});
