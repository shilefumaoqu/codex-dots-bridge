import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { spawn } from 'node:child_process';
import { warmLoadDesktopThread } from '../src/desktop-warm-load.js';

function fixture(output: unknown, code = 0, close = true) {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: () => { killed++; return true; } });
  let calls = 0, killed = 0, args: readonly string[] = [], options: any;
  const launch = ((executable: string, argv: readonly string[], opts: unknown) => {
    calls++; args = argv; options = opts;
    assert(executable.endsWith('powershell.exe')); assert(!executable.endsWith('ChatGPT.exe'));
    queueMicrotask(() => { if (output !== undefined) child.stdout.emit('data', Buffer.from(typeof output === 'string' ? output : JSON.stringify(output))); if (close) child.emit('close', code); });
    return child;
  }) as unknown as typeof spawn;
  return { launch, calls: () => calls, killed: () => killed, args: () => args, options: () => options };
}
const accepted = () => ({ schema: 'native-window-autoload/v1', mode: 'Navigate', status: 'protocol_accepted', reason: 'receiver_accepted', message_attempted: true, navigation_state: 'possibly_navigated', target_ready_verified: false, pid: 42, window_match_count: 1, win32_error: 0, receiver_ack: true, requires_target_owner_verification: true });
const input = () => ({ threadId: randomUUID(), signal: new AbortController().signal, deadline: Date.now() + 1000 });

test('one hidden helper receives argument-array UUID; ACK is only navigation acceptance', async () => {
  const f = fixture(accepted()), i = input();
  assert.deepEqual(await warmLoadDesktopThread(i, { platform: 'win32', spawn: f.launch }), { status: 'accepted' });
  assert.equal(f.calls(), 1); assert.equal(f.killed(), 0); assert.equal(f.options().windowsHide, true);
  assert(f.args().includes('-AutoDiscover')); assert.equal(f.args().at(-1), i.threadId); assert.equal(f.options().shell, undefined);
});
test('offline and ambiguous receipts do not authorize a target send', async () => {
  for (const [status, reason, expected] of [['offline', 'offline', 'native_desktop_offline'], ['ambiguous', 'endpoint_ambiguous', 'native_window_ambiguous']] as const) {
    const f = fixture({ ...accepted(), status, reason, message_attempted: false, navigation_state: 'not_attempted', receiver_ack: null, pid: 0, window_match_count: status === 'offline' ? 0 : 2, win32_error: null });
    const result = await warmLoadDesktopThread(input(), { platform: 'win32', spawn: f.launch });
    assert.equal('reason' in result && result.reason, expected); assert.equal(f.calls(), 1);
  }
});
test('unconfirmed navigation, malformed and forged ready output never become accepted or leak metadata', async () => {
  for (const output of [{ ...accepted(), receiver_ack: false }, { ...accepted(), target_ready_verified: true }, { ...accepted(), profile: 'PRIVATE_PROFILE' }, 'PRIVATE_ERROR invalid json']) {
    const f = fixture(output), result = await warmLoadDesktopThread(input(), { platform: 'win32', spawn: f.launch });
    assert.notEqual(result.status, 'accepted'); assert(!JSON.stringify(result).includes('PRIVATE')); assert.equal(f.calls(), 1);
  }
});
test('deadline or abort kills only the helper and does not retry an uncertain navigation', async () => {
  const f = fixture(undefined, 0, false), controller = new AbortController();
  const result = warmLoadDesktopThread({ ...input(), signal: controller.signal }, { platform: 'win32', spawn: f.launch });
  controller.abort();
  assert.deepEqual(await result, { status: 'skipped_unknown', reason: 'native_navigation_unconfirmed' });
  assert.equal(f.calls(), 1); assert.equal(f.killed(), 1);
});
test('invalid ID, expired request and unsupported platform never spawn', async () => {
  for (const i of [{ ...input(), threadId: 'bad&command' }, { ...input(), deadline: Date.now() - 1 }, { ...input(), threadId: '00000000-0000-0000-0000-000000000000' }]) {
    const f = fixture(accepted()); assert.notEqual((await warmLoadDesktopThread(i, { platform: 'win32', spawn: f.launch })).status, 'accepted'); assert.equal(f.calls(), 0);
  }
  const f = fixture(accepted()); await warmLoadDesktopThread(input(), { platform: 'linux', spawn: f.launch }); assert.equal(f.calls(), 0);
});
