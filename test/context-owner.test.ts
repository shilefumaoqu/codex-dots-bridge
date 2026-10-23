import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { observeDesktopContextState, runDesktopEchoIpc, runDesktopMessageIpc, runDesktopReadIpc, type DesktopContextStateSnapshot } from '../src/desktop-echo-ipc.js';
import { idleOwnerState, ownerFixture } from './context-owner-fixture.js';

function snapshot(result: DesktopContextStateSnapshot, start: number, checkedBy = 'native_desktop_owner') {
  assert.equal(result.checked_by, checkedBy); assert.equal(result.scope, 'observation_snapshot');
  assert(Number.isFinite(Date.parse(result.observed_at))); assert(Date.parse(result.observed_at) >= start); assert(Date.parse(result.observed_at) <= Date.now());
  assert(!JSON.stringify(result).includes('PRIVATE')); assert(!Object.hasOwn(result, 'history')); assert(!Object.hasOwn(result, 'rolloutPath')); assert(!Object.hasOwn(result, 'title'));
}
function released(f: ReturnType<typeof ownerFixture>) {
  assert.equal(f.connections(), 1); assert.equal(f.socket.destroyed, true); assert.equal(f.socket.closed, true);
  assert(f.socket.frames.every(frame => ['initialize', 'thread-owner-discovery', 'thread-stream-following-changed'].includes(frame.method)));
  assert.equal(f.socket.frames.filter(frame => frame.method === 'thread-owner-discovery').length, 1);
  const follow = f.socket.frames.filter(frame => frame.method === 'thread-stream-following-changed');
  if (follow.length) assert.deepEqual(follow.map(frame => frame.params.following), [true, false]);
}
for (const kind of ['legacy', 'canonical'] as const) test(`busy ${kind} owner returns activity metadata and observation time without history`, async () => {
  const turnId = randomUUID(), startedAt = Date.now() - 1000, start = Date.now();
  const turn = { turnId, turnStartedAtMs: startedAt, status: 'inProgress', items: [{ content: 'PRIVATE_REASONING_AND_TOOL_BODY' }] };
  const f = ownerFixture({ state: id => ({ ...idleOwnerState(id), title: 'PRIVATE_TITLE', rolloutPath: 'PRIVATE_PATH', ...(kind === 'legacy' ? { turns: [turn] } : { turnHistory: { kind: 'canonical', history: { entitiesByKey: { [turnId]: turn } } } }) }) });
  const result = await f.run(); snapshot(result, start); assert.equal(result.status, 'busy'); assert.equal(result.active_turn_id, turnId); assert.equal(result.active_turn_started_at_ms, startedAt); assert.equal(result.reason, 'turn_in_progress'); released(f);
});
test('explicit idle owner has timestamp but does not expose full history or native paths', async () => {
  const start = Date.now(), f = ownerFixture({ state: id => ({ ...idleOwnerState(id), turns: [{ turnId: randomUUID(), status: 'completed', items: [{ content: 'PRIVATE_HISTORY' }] }], historyMode: 'PRIVATE_HISTORY_MODE', rolloutPath: 'PRIVATE_PATH', title: 'PRIVATE_TITLE' }) });
  const result = await f.run(); snapshot(result, start); assert.equal(result.status, 'idle'); assert.equal(result.reason, 'explicit_idle'); assert(!Object.hasOwn(result, 'active_turn_id')); released(f);
});
for (const state of [
  (id: string) => ({ ...idleOwnerState(id), unconfirmedTurnSubmissions: [{}] }),
  (id: string) => ({ ...idleOwnerState(id), threadRuntimeStatus: { type: 'active' } }),
  (id: string) => ({ ...idleOwnerState(id), turns: [{ turnId: 'invalid', status: 'inProgress', turnStartedAtMs: 1 }] }),
  (id: string) => ({ ...idleOwnerState(id), turns: [randomUUID(), randomUUID()].map(turnId => ({ turnId, status: 'inProgress', turnStartedAtMs: 1 })) }),
]) test('busy stays busy when a unique valid active turn cannot be identified', async () => {
  const start = Date.now(), f = ownerFixture({ state }); const result = await f.run(); snapshot(result, start); assert.equal(result.status, 'busy'); assert(!Object.hasOwn(result, 'active_turn_id')); released(f);
});
for (const state of [
  (id: string) => ({ ...idleOwnerState(id), resumeState: 'restoring' }),
  (id: string) => ({ ...idleOwnerState(id), threadRuntimeStatus: { type: 'notLoaded' } }),
  (id: string) => ({ ...idleOwnerState(id), turnHistory: { kind: 'canonical', history: { entitiesByKey: null } } }),
  (id: string) => ({ ...idleOwnerState(id), turns: [{ turnId: randomUUID(), status: 'alien' }] }),
  () => idleOwnerState(randomUUID()),
]) test('uncertain native snapshot never becomes idle', async () => {
  const start = Date.now(), f = ownerFixture({ state }); const result = await f.run(); snapshot(result, start); assert.equal(result.status, 'unknown'); assert(result.reason); released(f);
});
test('an update after an idle snapshot remains unknown', async () => {
  const start = Date.now(), f = ownerFixture({ updateAfterSnapshot: true }); const result = await f.run(); snapshot(result, start); assert.equal(result.status, 'unknown'); assert.equal(result.reason, 'state_changed_after_snapshot'); released(f);
});
for (const options of [{ noOwner: true }, { discoveryError: 'PRIVATE_NATIVE_ERROR' }] as const) test('unavailable owner remains unknown with a sanitized timestamped failure', async () => {
  const start = Date.now(), f = ownerFixture(options), result = await f.run(); snapshot(result, start, 'unavailable'); assert.equal(result.status, 'unknown'); assert.equal(result.reason, options.noOwner ? 'native_owner_unavailable' : 'ipc_owner_discovery_failed'); released(f);
});
for (const deadline of [30, 3000]) test(`wrong owner snapshot is ignored until ${deadline === 30 ? 'the overall deadline' : 'the snapshot budget'} closes the connection without navigation or send`, async t => {
  // Keep Date and timers on one clock: real timers can fire just before the
  // Date.now boundary, making a snapshot timeout race the overall deadline.
  const start = Date.now(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  const f = ownerFixture({ source: 'forged-owner' }); let settled = false;
  const pending = f.run(deadline).then(result => { settled = true; return result; });
  t.after(async () => { f.controller.abort(); await pending; });
  // The fixture delivers its forged snapshot in microtasks. Let those finish
  // before checking that the observation still waits for a trusted owner.
  await new Promise<void>(setImmediate);
  assert.equal(settled, false);
  assert.deepEqual(f.socket.frames.filter(frame => frame.method === 'thread-stream-following-changed').map(frame => frame.params.following), [true]);
  const expires = Math.min(deadline, 2000);
  t.mock.timers.tick(expires - 1); await new Promise<void>(setImmediate);
  assert.equal(settled, false); assert.equal(f.socket.closed, false);
  t.mock.timers.tick(1);
  const result = await pending; snapshot(result, start, 'unavailable'); assert.equal(result.status, 'unknown');
  assert.equal(result.reason, deadline === 30 ? 'ipc_aborted' : 'ipc_snapshot_unavailable');
  assert.equal(f.connections(), 1); assert.equal(f.socket.closed, true); assert.equal(f.socket.destroyed, true);
  assert.deepEqual(f.socket.frames.filter(frame => frame.method === 'thread-stream-following-changed').map(frame => frame.params.following), deadline === 30 ? [true] : [true, false]);
  assert(f.socket.frames.every(frame => ['initialize', 'thread-owner-discovery', 'thread-stream-following-changed'].includes(frame.method)));
});
for (const stopAt of ['connect', 'initialize', 'discovery', 'snapshot'] as const) for (const cause of ['signal', 'deadline'] as const) test(`${cause} during ${stopAt} settles unknown and releases its injected connection`, async () => {
  const start = Date.now(), f = ownerFixture({ stopAt });
  const timer = cause === 'signal' ? setTimeout(() => f.controller.abort(), 20) : undefined;
  try {
    const result = await f.run(cause === 'signal' ? 1000 : 30); snapshot(result, start, 'unavailable'); assert.equal(result.status, 'unknown'); assert.equal(result.reason, 'ipc_aborted');
    assert.equal(f.connections(), 1); assert.equal(f.socket.closed, true); assert.equal(f.socket.destroyed, true);
    assert(f.socket.frames.every(frame => ['initialize', 'thread-owner-discovery', 'thread-stream-following-changed'].includes(frame.method)));
  } finally { clearTimeout(timer); }
});
test('pre-cancelled observation never opens a connection', async () => {
  const controller = new AbortController(); controller.abort(); const start = Date.now();
  const result = await observeDesktopContextState({ threadId: randomUUID(), signal: controller.signal, deadline: Date.now() + 100 }, { connect: () => assert.fail('must not connect to real or fake IPC') });
  snapshot(result, start, 'unavailable'); assert.equal(result.status, 'unknown'); assert.equal(result.reason, 'ipc_aborted');
});
test('snapshot transport failure releases the socket and gives no native status', async () => {
  const start = Date.now(), f = ownerFixture({ disconnectAtSnapshot: true }), result = await f.run(); snapshot(result, start, 'unavailable'); assert.equal(result.status, 'unknown'); assert.equal(result.reason, 'ipc_snapshot_unavailable'); assert.equal(f.socket.closed, true);
});
test('legacy full read preserves history while the new observation only returns metadata', async () => {
  const state = (id: string) => ({ ...idleOwnerState(id), historyMode: 'full', turns: [{ turnId: 'old-turn', status: 'completed', items: [{ text: 'old raw history' }] }], title: 'legacy-title', rolloutPath: 'legacy-path' });
  const f = ownerFixture({ state }), result = await runDesktopReadIpc(f.input(), f.testing);
  assert.equal(result.status, 'ready'); if (result.status !== 'ready') return;
  assert.deepEqual(result.history, { historyMode: 'full', turnHistory: { kind: 'legacy' }, turns: state(f.threadId).turns }); assert.equal(result.title, 'legacy-title'); assert.equal(result.rolloutPath, 'legacy-path'); released(f);
});
test('legacy busy echo result and busy guided message keep their original contracts', async () => {
  const turnId = randomUUID(), startedAt = Date.now() - 100;
  const state = (id: string) => ({ ...idleOwnerState(id), turns: [{ turnId, turnStartedAtMs: startedAt, status: 'inProgress' }] });
  const echo = ownerFixture({ state });
  const echoResult = await runDesktopEchoIpc({ ...echo.input(), requestId: randomUUID(), beforeSend: () => assert.fail('busy echo must not send') }, echo.testing);
  assert.deepEqual(echoResult, { status: 'skipped_busy', reason: 'turn_in_progress' }); released(echo);
  const message = ownerFixture({ state });
  const messageResult = await runDesktopMessageIpc({ ...message.input(), requestId: randomUUID(), text: 'retained guidance', beforeSend: () => assert.fail('busy message must not send') }, message.testing);
  assert.equal(messageResult.status, 'skipped_busy'); if (messageResult.status !== 'skipped_busy') return;
  assert.equal(messageResult.busy_state?.active_turn_id, turnId); assert.equal(messageResult.busy_state?.active_turn_started_at_ms, startedAt); assert.equal(messageResult.busy_state?.checked_by, 'native_desktop_owner'); assert.match(messageResult.busy_owner!, /^[0-9a-f]{64}$/); released(message);
});
