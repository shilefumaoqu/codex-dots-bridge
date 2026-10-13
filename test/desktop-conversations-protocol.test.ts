import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { TaskStore } from '../src/task-store.js';
import { ProbeEvents } from '../src/events.js';
import { createProductionService } from '../src/bridge.js';
import { DesktopConversationsError, type DesktopConversationsService } from '../src/desktop-conversations.js';
import type { DesktopEchoService } from '../src/desktop-echo.js';

const tokens = { caller: 'a'.repeat(64), worker: 'b'.repeat(64) };
const names = ['codex_read_conversation', 'codex_send_message', 'codex_conversation_status'];
type Args = Record<string, unknown>;
type Mock = {
  enabled: boolean;
  read: (args: Args) => unknown | Promise<unknown>;
  send: (args: Args) => unknown | Promise<unknown>;
  get: (args: Args) => unknown | Promise<unknown>;
  close: () => Promise<void>;
};

async function fixture(mock: Mock | undefined, operation: (ctx: {
  store: TaskStore;
  rpc: (method: string, params?: Args, token?: string) => Promise<{ status: number; body: any }>;
  control: (name: string, args: Args) => Promise<{ status: number; body: any }>;
}) => Promise<void>) {
  // Only an isolated in-memory forward store. No real database or desktop channel.
  const store = new TaskStore(':memory:');
  const service = createProductionService(store, new ProbeEvents(store, async () => ({ status: 200, body: '{}' }), 'tasks'), tokens,
    undefined, undefined, undefined, undefined, mock as unknown as DesktopConversationsService | undefined);
  try {
    const endpoint = await service.start();
    let nextId = 1;
    const rpc = async (method: string, params: Args = {}, token = tokens.worker) => {
      const response = await fetch(new URL('mcp/dot', endpoint), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Connection: 'close',
          'X-Codex-Dots-Worker-Token': token, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method,
          ...(method === 'tools/call' ? { 'Mcp-Name': String(params.name) } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params: { ...params,
          _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }),
        signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, body: await response.json() as any };
    };
    const control = async (name: string, args: Args) => {
      const response = await fetch(new URL(`control/${name}`, endpoint), { method: 'POST',
        headers: { 'content-type': 'application/json', Connection: 'close', authorization: `Bearer ${tokens.caller}` },
        body: JSON.stringify(args), signal: AbortSignal.timeout(5000) });
      return { status: response.status, body: await response.json() as any };
    };
    await operation({ store, rpc, control });
  } finally { await service.close(); store.close(); }
}

const parsed = (body: any) => { assert.ok(!body.error); assert.equal(body.result?.isError ?? false, false); return JSON.parse(body.result.content[0].text); };
const rejected = (body: any) => assert.ok(body.error || body.result?.isError === true);

test('conversation tools are absent by default and when explicitly disabled; legacy worker and forward submit remain available', async () => {
  for (const enabled of [undefined, false]) {
    let closed = 0, dispatched = 0;
    const rejectDispatch = () => { dispatched++; throw Error('disabled service must not run'); };
    const mock = enabled === undefined ? undefined : { enabled, read: rejectDispatch, send: rejectDispatch, get: rejectDispatch, close: async () => { closed++; } };
    await fixture(mock, async ({ store, rpc, control }) => {
      const tools = (await rpc('tools/list')).body.result.tools;
      for (const name of names) assert.equal(tools.some((tool: any) => tool.name === name), false);
      assert.ok(tools.some((tool: any) => tool.name === 'claim_task'));
      const submitted = await control('dots_submit', { idempotency_key: randomUUID(), title: 'synthetic forward task', input: { text: 'synthetic' } });
      assert.equal(submitted.status, 200); assert.equal(submitted.body.status, 'queued');
      const read = parsed((await rpc('tools/call', { name: 'get_task', arguments: { task_id: submitted.body.task_id } })).body);
      assert.equal(read.task_id, submitted.body.task_id); assert.equal(store.status().tasks.length, 1);
      for (const name of names) rejected((await rpc('tools/call', { name, arguments: { request_id: randomUUID() } })).body);
      assert.equal(dispatched, 0);
    });
    assert.equal(closed, enabled === undefined ? 0 : 1);
  }
});

test('enabled conversation tools have strict worker-only schemas and correct read/write annotations', async () => {
  const seen: { method: string; args: Args }[] = []; let closed = 0;
  const handler = (method: string) => async (args: Args) => { await Promise.resolve(); seen.push({ method, args }); return { request_id: args.request_id, status: 'pending' }; };
  await fixture({ enabled: true, read: handler('read'), send: handler('send'), get: handler('get'), close: async () => { closed++; } }, async ({ rpc, control }) => {
    const tools = (await rpc('tools/list')).body.result.tools;
    for (const [name, properties, readOnly] of [
      ['codex_read_conversation', ['request_id', 'thread_id'], true],
      ['codex_send_message', ['request_id', 'thread_id', 'text', 'delivery_mode'], false],
      ['codex_conversation_status', ['request_id', 'wait_seconds', 'offset'], true],
    ] as const) {
      const tool = tools.find((value: any) => value.name === name); assert.ok(tool);
      assert.equal(tool.annotations.readOnlyHint, readOnly); assert.equal(tool.annotations.idempotentHint, true);
      assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), [...properties].sort()); assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal((await rpc('tools/call', { name, arguments: { request_id: randomUUID() } }, tokens.caller)).status, 401);
      const caller = await control(name, { request_id: randomUUID() }); assert.notEqual(caller.status, 200);
    }
    const readDescription = tools.find((tool: any) => tool.name === 'codex_read_conversation').description;
    const sendSchema = tools.find((tool: any) => tool.name === 'codex_send_message').inputSchema;
    assert.deepEqual(sendSchema.properties.delivery_mode.enum, ['current_turn', 'next_turn']);
    assert.equal(sendSchema.required.includes('delivery_mode'), false);
    assert.match(readDescription, /codex_conversation_status/); assert.match(readDescription, /(?:same|stable) request(?:_id)?/i);
    assert.match(readDescription, /offset/); assert.match(readDescription, /next_offset(?:\s*(?:=|:)\s*null|\s+until\s+null)/);
    assert.match(readDescription, /source_complete\s*(?:=|:)\s*false/);
    assert.equal(seen.length, 0);
    const request_id = randomUUID(), thread_id = randomUUID();
    const cases: [string, Args[]][] = [
      ['codex_read_conversation', [
        { request_id, thread_id, extra: true }, { request_id: 'invalid', thread_id }, { request_id, thread_id: 'invalid' },
        { request_id, thread_id, limit: 0 }, { request_id, thread_id, limit: 1 }, { request_id, thread_id, limit: 5 },
        { request_id, thread_id, limit: 6 }, { request_id, thread_id, limit: 1.5 }, { request_id, thread_id, limit: '1' },
        { request_id, thread_id, offset: 0 }, { request_id },
      ]],
      ['codex_send_message', [
        { request_id, thread_id, text: 'synthetic', extra: true }, { request_id: 'invalid', thread_id, text: 'synthetic' },
        { request_id, thread_id: 'invalid', text: 'synthetic' }, { request_id, thread_id, text: '' },
        { request_id, thread_id, text: 'x'.repeat(8001) }, { request_id, thread_id, text: 5 }, { request_id, thread_id },
        { request_id, thread_id, text: 'synthetic', offset: 0 }, { request_id, thread_id, text: 'synthetic', offset: 32000 },
        { request_id, thread_id, text: 'synthetic', delivery_mode: 'immediate' },
        { request_id, thread_id, text: 'synthetic', delivery_mode: null },
      ]],
      ['codex_conversation_status', [
        { request_id, extra: true }, { request_id: 'invalid' }, { request_id, wait_seconds: -1 },
        { request_id, wait_seconds: 20.1 }, { request_id, wait_seconds: '1' }, { request_id, wait_seconds: null },
        { request_id, offset: -1 }, { request_id, offset: 33554433 }, { request_id, offset: 0.5 },
        { request_id, offset: '0' }, { request_id, offset: null }, { request_id, limit: 1 },
      ]],
    ];
    for (const [name, argsList] of cases) for (const args of argsList) rejected((await rpc('tools/call', { name, arguments: args })).body);
    assert.equal(seen.length, 0);
    {
      const args = { request_id, thread_id };
      assert.equal(parsed((await rpc('tools/call', { name: 'codex_read_conversation', arguments: args })).body).status, 'pending');
      assert.deepEqual(seen.at(-1), { method: 'read', args });
    }
    for (const text of ['x', 'x'.repeat(8000)]) {
      const args = { request_id, thread_id, text };
      parsed((await rpc('tools/call', { name: 'codex_send_message', arguments: args })).body); assert.deepEqual(seen.at(-1), { method: 'send', args });
    }
    for (const delivery_mode of ['current_turn', 'next_turn']) {
      const args = { request_id, thread_id, text: 'synthetic', delivery_mode };
      parsed((await rpc('tools/call', { name: 'codex_send_message', arguments: args })).body);
      assert.deepEqual(seen.at(-1), { method: 'send', args });
    }
    for (const wait_seconds of [undefined, 0, 0.25, 20]) {
      const args = { request_id, ...(wait_seconds === undefined ? {} : { wait_seconds }) };
      parsed((await rpc('tools/call', { name: 'codex_conversation_status', arguments: args })).body); assert.deepEqual(seen.at(-1), { method: 'get', args });
    }
    for (const offset of [0, 32000, 33554432]) {
      const args = { request_id, wait_seconds: 20, offset };
      parsed((await rpc('tools/call', { name: 'codex_conversation_status', arguments: args })).body); assert.deepEqual(seen.at(-1), { method: 'get', args });
    }
  });
  assert.equal(closed, 1);
});

test('async conversation errors are safe and the forward claim/checkpoint/complete path remains usable', async () => {
  const throwing = async () => { await Promise.resolve(); throw Object.assign(Error('PRIVATE_PATH_SENTINEL C:\\private\\secret'), { code: 'PRIVATE_RAW_CODE' }); };
  await fixture({ enabled: true, read: throwing, send: throwing, get: throwing, close: async () => {} }, async ({ rpc, control, store }) => {
    const request_id = randomUUID(), thread_id = randomUUID();
    for (const [name, args] of [
      ['codex_read_conversation', { request_id, thread_id }],
      ['codex_send_message', { request_id, thread_id, text: 'synthetic' }],
      ['codex_conversation_status', { request_id, wait_seconds: 0 }],
    ] as const) {
      const response = (await rpc('tools/call', { name, arguments: args })).body;
      assert.equal(response.result.isError, true); assert.deepEqual(JSON.parse(response.result.content[0].text), { error: 'bridge_operation_failed' });
      assert.ok(!JSON.stringify(response).includes('PRIVATE_')); assert.ok(!JSON.stringify(response).includes('secret'));
    }
    const submitted = await control('dots_submit', { idempotency_key: randomUUID(), title: 'synthetic untouched forward path', input: { text: 'synthetic' } });
    assert.equal(submitted.status, 200);
    const task_id = submitted.body.task_id;
    const claim = parsed((await rpc('tools/call', { name: 'claim_task', arguments: { task_id, claim_key: randomUUID() } })).body);
    assert.equal(claim.status, 'running'); assert.equal(typeof claim.claim_token, 'string');
    const input_revision = claim.input_revision, claim_token = claim.claim_token;
    const checkpoint = parsed((await rpc('tools/call', { name: 'checkpoint_task', arguments: { task_id, claim_token, input_revision, summary: 'synthetic checkpoint' } })).body);
    assert.equal(checkpoint.acknowledged, true);
    const result = parsed((await rpc('tools/call', { name: 'complete_task', arguments: { task_id, claim_token, input_revision, completion_key: randomUUID(), result: { text: 'synthetic completed' } } })).body);
    assert.equal(result.accepted_as_final, true); assert.equal(result.status, 'completed'); assert.equal(store.status().tasks.length, 1);
  });
});

test('shutdown aborts both optional desktop services before HTTP clients are drained', async () => {
  const store = new TaskStore(':memory:'); let echoAborted = false, conversationsAborted = false, drainEntered = false;
  let release: () => void = () => {};
  const desktop = { enabled: false, close: async () => { echoAborted = true; } } as unknown as DesktopEchoService;
  const conversations = { enabled: false, close: async () => { conversationsAborted = true; } } as unknown as DesktopConversationsService;
  const service = createProductionService(store, new ProbeEvents(store, async () => ({ status: 200, body: '{}' }), 'tasks'), tokens,
    undefined, undefined, undefined, desktop, conversations);
  const originalClose = service.app.close.bind(service.app);
  service.app.close = (() => {
    drainEntered = true; assert.equal(echoAborted, true); assert.equal(conversationsAborted, true);
    return new Promise<void>(done => { release = done; });
  }) as typeof service.app.close;
  try {
    const closing = service.close(); await Promise.resolve(); await Promise.resolve();
    assert.equal(echoAborted, true); assert.equal(conversationsAborted, true); assert.equal(drainEntered, true);
    release(); await closing;
  } finally { await originalClose(); store.close(); }
});

test('recognized conversation errors preserve their safe code without exposing attached raw details', async () => {
  const throwing = async () => { await Promise.resolve(); const error = new DesktopConversationsError('thread_not_allowed'); error.message = 'PRIVATE_PATH_SENTINEL C:\\private\\secret'; throw error; };
  await fixture({ enabled: true, read: throwing, send: throwing, get: throwing, close: async () => {} }, async ({ rpc }) => {
    const request_id = randomUUID(), thread_id = randomUUID();
    for (const [name, args] of [
      ['codex_read_conversation', { request_id, thread_id }],
      ['codex_send_message', { request_id, thread_id, text: 'synthetic' }],
      ['codex_conversation_status', { request_id, wait_seconds: 0 }],
    ] as const) {
      const body = (await rpc('tools/call', { name, arguments: args })).body;
      assert.equal(body.result.isError, true); assert.deepEqual(JSON.parse(body.result.content[0].text), { error: 'thread_not_allowed' });
      assert.ok(!JSON.stringify(body).includes('PRIVATE_')); assert.ok(!JSON.stringify(body).includes('secret'));
    }
  });
});
