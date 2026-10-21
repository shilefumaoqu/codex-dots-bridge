import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { productionWorker, callerSchemas, workerSchemas } from '../src/bridge.js';
import { TaskStore } from '../src/task-store.js';
import { ProbeEvents } from '../src/events.js';
import { xingduIcons } from '../src/xingdu-icons.js';

test('worker discovery and every enabled tool publish the finalized icon without changing tool behavior', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xingdu-icon-protocol-'));
  const store = new TaskStore(join(dir, 'tasks.sqlite'));
  const events = new ProbeEvents(store, async () => ({ status: 200, body: '{}' }), 'tasks');
  // Optional tools are enumerated only; no history, message, echo, or notification handler is called.
  const handler = createMcpHandler(() => productionWorker(store, events, undefined,
    { enabled: true } as any, { enabled: true } as any), { legacy: 'reject', responseMode: 'json' });
  try {
    const rpc = async (method: string) => {
      const response = await handler.fetch(new Request('http://localhost/mcp/dot', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', connection: 'close',
          'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }),
      }));
      assert.equal(response.status, 200);
      const body = await response.json() as any;
      assert.ok(!body.error, JSON.stringify(body));
      return body.result;
    };
    const discovered = await rpc('server/discover');
    assert.deepEqual(discovered._meta['io.modelcontextprotocol/serverInfo'].icons, xingduIcons());
    const listed = await rpc('tools/list');
    assert.deepEqual(listed.tools.map((tool: any) => tool.name).sort(), [
      ...Object.keys(workerSchemas), 'codex_desktop_echo', 'codex_desktop_echo_status',
      'codex_read_conversation', 'codex_send_message', 'codex_conversation_status', 'dots_chat_send', 'dots_chat_status',
    ].sort());
    for (const tool of listed.tools) assert.deepEqual(tool.icons, xingduIcons(), tool.name);
    assert.equal(store.status().tasks.length, 0);
  } finally {
    await handler.close();
    store.close();
    const owned = relative(resolve(tmpdir()), resolve(dir));
    assert.ok(!isAbsolute(owned) && owned.startsWith('xingdu-icon-protocol-') && !owned.includes('..'));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stdio initialize and caller tools list publish the same finalized icon', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    "import { startProductionCaller } from './src/bridge.ts'; await startProductionCaller('unused-icon-test-data');"],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buffer = '', stderr = '', next = 0;
  const pending = new Map<number, (value: any) => void>();
  child.stderr.on('data', chunk => stderr += String(chunk));
  child.stdout.on('data', chunk => {
    buffer += String(chunk);
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      const value = JSON.parse(line);
      pending.get(value.id)?.(value); pending.delete(value.id);
    }
  });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const call = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP icon ${method} timeout: ${stderr}`)); }, 10000);
    pending.set(id, value => { clearTimeout(timer); resolve(value); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    const initialized = await call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'icon-test', version: '1' } });
    assert.ok(!initialized.error, JSON.stringify(initialized));
    assert.deepEqual(initialized.result.serverInfo.icons, xingduIcons());
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const listed = await call('tools/list');
    assert.deepEqual(listed.result.tools.map((tool: any) => tool.name).sort(), Object.keys(callerSchemas).sort());
    for (const tool of listed.result.tools) assert.deepEqual(tool.icons, xingduIcons(), tool.name);
    assert.equal(stderr, '');
  } finally {
    child.stdin.end();
    child.kill();
    await exited;
  }
});
