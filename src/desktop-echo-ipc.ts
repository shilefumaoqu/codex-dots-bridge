import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';

const MAX_FRAME = 32 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
export const DESKTOP_PIPE = String.raw`\\.\pipe\codex-ipc`;
type State = Record<string, any>;
export type IdleDecision = { status: 'idle' | 'busy' | 'unknown'; reason: string };
/** Native owner observation only; it grants no permission or atomic idle lock. */
export interface DesktopIdleSnapshot {
  status: 'idle'; observed_at: string; checked_by: 'native_desktop_owner'; scope: 'observation_snapshot';
}
export interface DesktopBusySnapshot {
  status: 'busy'; observed_at: string; checked_by: 'native_desktop_owner'; scope: 'observation_snapshot';
  active_turn_id?: string; active_turn_started_at_ms?: number;
}
function visibleTurns(state: State | undefined): State[] {
  const entities = state?.turnHistory?.kind === 'canonical' ? state.turnHistory.history?.entitiesByKey : undefined;
  return [...(Array.isArray(state?.turns) ? state.turns : []), ...(entities && typeof entities === 'object' && !Array.isArray(entities) ? Object.values(entities) : [])] as State[];
}
function busySnapshot(state: State, observedAt: string): DesktopBusySnapshot {
  const active = visibleTurns(state).filter(turn => turn?.status === 'inProgress');
  const ids = new Set(active.map(turn => turn.turnId));
  const turn = ids.size === 1 ? active[0] : undefined;
  const valid = turn && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(turn.turnId) && Number.isFinite(turn.turnStartedAtMs) && turn.turnStartedAtMs >= 0;
  return { status: 'busy', observed_at: observedAt, checked_by: 'native_desktop_owner', scope: 'observation_snapshot', ...(valid ? { active_turn_id: turn.turnId, active_turn_started_at_ms: turn.turnStartedAtMs } : {}) };
}
/** Metadata only; a snapshot is not an atomic idle/start lock. */
export function assessIdle(state: State | undefined, threadId: string): IdleDecision {
  const result = (status: IdleDecision['status'], reason: string) => ({ status, reason });
  if (!state || state.id !== threadId) return result('unknown', 'invalid_state_identity');
  if (state.unconfirmedTurnSubmissions !== undefined && !Array.isArray(state.unconfirmedTurnSubmissions)) return result('unknown', 'unknown_submissions');
  if (state.unconfirmedTurnSubmissions?.length) return result('busy', 'unconfirmed_submission');
  const entities = state.turnHistory?.kind === 'canonical' ? state.turnHistory.history?.entitiesByKey : undefined;
  const visible = [...(Array.isArray(state.turns) ? state.turns : []), ...(entities && typeof entities === 'object' && !Array.isArray(entities) ? Object.values(entities) : [])] as State[];
  if (visible.some(turn => turn?.status === 'inProgress')) return result('busy', 'turn_in_progress');
  if (state.turns !== undefined && !Array.isArray(state.turns)) return result('unknown', 'unknown_turn_history');
  if (state.resumeState !== 'resumed') return result('unknown', 'resume_state');
  if (state.threadRuntimeStatus?.type !== 'idle') return result(state.threadRuntimeStatus?.type === 'active' ? 'busy' : 'unknown', 'runtime_not_idle');
  let turns: State[];
  if (state.turnHistory?.kind === 'canonical') {
    if (!entities || typeof entities !== 'object' || Array.isArray(entities)) return result('unknown', 'unknown_canonical_history');
    turns = Object.values(entities);
  } else if (state.turnHistory?.kind === 'legacy' && Array.isArray(state.turns)) turns = state.turns;
  else return result('unknown', 'unknown_turn_history');
  if (Array.isArray(state.turns)) turns = [...turns, ...state.turns];
  if (turns.some(turn => !turn || !['completed', 'failed', 'interrupted'].includes(turn.status) || typeof turn.turnId !== 'string' || !turn.turnId)) return result('unknown', 'unknown_turn');
  return result('idle', 'explicit_idle');
}
export const echoMarker = (requestId: string) => `CODEX_IDLE_EXPERIMENT_${requestId}`;
export const fixedEchoPrompt = (requestId: string) => `这是一次受控空闲文本实验。不要调用工具或执行任何操作，只原样回复：${echoMarker(requestId)}`;
/** Internal binding metadata from the same verified owner snapshot. */
export interface DesktopThreadMetadata { threadId: string; rolloutPath?: string }
export const DESKTOP_TIMING_STAGES = ['owner_lookup', 'autoload', 'busy_wait', 'send_ack', 'reply_wait'] as const;
export type DesktopTimingStage = typeof DESKTOP_TIMING_STAGES[number];
export const DESKTOP_IPC_DIAGNOSTIC_CODES = ['buffer_limit_exceeded', 'invalid_frame_size', 'invalid_utf8', 'invalid_json', 'invalid_frame', 'invalid_transport', 'snapshot_timeout', 'request_timeout', 'transport_closed', 'unreachable', 'remote_error', 'no-client-found', 'invalid_response', 'invalid_ack', 'aborted', 'other'] as const;
export interface DesktopIpcDiagnostic { phase: string; diagnostic_code: typeof DESKTOP_IPC_DIAGNOSTIC_CODES[number]; received_frames: number; state_frames: number; matched_state_frames: number; largest_frame_bytes: number }
export interface DesktopIpcInput { threadId: string; requestId: string; signal: AbortSignal; deadline: number; beforeSend: (meta?: DesktopThreadMetadata) => void; onStageTiming?: (stage: DesktopTimingStage, elapsedMs: number) => void; onDiagnostic?: (event: DesktopIpcDiagnostic) => void; afterTurn?: { id: string; startedAtMs: number; ownerHash: string } }
export type DesktopIpcResult = { status: 'accepted'; turnId: string } | { status: 'skipped_busy' | 'skipped_unknown' | 'skipped_unreachable' | 'uncertain'; reason: string; busy_state?: DesktopBusySnapshot; busy_owner?: string };
type IpcMethod = 'initialize' | 'thread-owner-discovery' | 'thread-follower-start-turn';
const failure = (code: string, method?: IpcMethod) => Object.assign(new Error(code), { code, method });
/** Fixed public reasons only; remote error text and native paths never leave IPC. */
export const DESKTOP_IPC_FAILURE_REASONS = ['native_owner_unavailable', 'ipc_connect_unavailable', 'ipc_initialize_failed', 'ipc_owner_discovery_failed', 'ipc_snapshot_unavailable', 'ipc_before_send_failed', 'ipc_aborted'] as const;

/** Fixed protocol only. Never retries or changes settings. */
export const DESKTOP_HISTORY_FIELDS = ['historyMode', 'turnHistory', 'turns', 'turnsPagination', 'paginatedHistory', 'boundedCloudHistory', 'canonicalVoiceHistory'] as const;
export type DesktopHistory = Partial<Record<typeof DESKTOP_HISTORY_FIELDS[number], any>>;
export type DesktopProbeResult = { status: 'ready'; title?: string; rolloutPath?: string; history: DesktopHistory; desktop_state: DesktopIdleSnapshot } | Exclude<DesktopIpcResult, { status: 'accepted' }>;
export async function runDesktopEchoIpc(input: DesktopIpcInput, testing?: { connect: () => net.Socket }): Promise<DesktopIpcResult> {
  return runDesktopIpc(input, fixedEchoPrompt(input.requestId), false, testing) as Promise<DesktopIpcResult>;
}
export async function runDesktopMessageIpc(input: DesktopIpcInput & { text: string }, testing?: { connect: () => net.Socket }): Promise<DesktopIpcResult> {
  return runDesktopIpc(input, input.text, false, testing, true) as Promise<DesktopIpcResult>;
}
export async function runDesktopReadIpc(input: Omit<DesktopIpcInput, 'requestId' | 'beforeSend'>, testing?: { connect: () => net.Socket }): Promise<DesktopProbeResult> {
  return runDesktopIpc({ ...input, requestId: '', beforeSend: () => {} }, '', true, testing) as Promise<DesktopProbeResult>;
}
async function runDesktopIpc(input: DesktopIpcInput, text: string, readOnly: boolean, testing?: { connect: () => net.Socket }, guideBusy = false): Promise<DesktopIpcResult | DesktopProbeResult> {
  let socket: net.Socket | undefined, clientId: string | undefined, owner: string | undefined;
  let buffer = Buffer.alloc(0), transportError: Error | undefined, followed = false, sent = false, aborted = false;
  let stageReason: string = 'ipc_connect_unavailable';
  let receivedFrames = 0, stateFrames = 0, matchedStateFrames = 0, largestFrameBytes = 0;
  let timingStage: DesktopTimingStage | undefined, stageStarted = 0;
  const finishStage = () => { if (timingStage) input.onStageTiming?.(timingStage, Math.max(0, performance.now() - stageStarted)); timingStage = undefined; };
  let observed: IdleDecision | undefined, observedAt: string | undefined, title: string | undefined, rolloutPath: string | undefined, history: DesktopHistory = {};
  let latestState: State | undefined;
  let snapshot: { resolve: () => void; reject: (error: Error) => void } | undefined;
  const pending = new Map<string, { method: IpcMethod; resolve: (frame: State) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const rejectAll = (error: Error) => { transportError = error; for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); snapshot?.reject(error); };
  const abort = () => { aborted = true; rejectAll(failure('aborted')); socket?.destroy(); };
  const write = (frame: State) => {
    if (input.signal.aborted || transportError || !socket || socket.destroyed) throw transportError ?? failure('transport_closed');
    const body = Buffer.from(JSON.stringify(frame));
    if (!body.length || body.length > MAX_FRAME) throw failure('invalid_frame_size');
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length); socket.write(Buffer.concat([header, body]));
  };
  const following = (flag: boolean) => write({ type: 'broadcast', method: 'thread-stream-following-changed', sourceClientId: clientId, targetClientIds: [owner], version: 1, params: { conversationId: input.threadId, hostId: 'local', following: flag } });
  const request = (method: IpcMethod, params: State, version = 1, targetClientId?: string): Promise<State> => {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      // Router discovery itself can wait ten seconds. Allow its terminal reply
      // a bounded margin; initialization and start ACK retain their own budgets.
      const requestBudgetMs = method === 'thread-owner-discovery' ? 12000 : method === 'thread-follower-start-turn' ? 15000 : 2000;
      const timeoutMs = Math.max(1, Math.min(requestBudgetMs, input.deadline - Date.now()));
      const timer = setTimeout(() => { pending.delete(requestId); reject(failure('request_timeout', method)); }, timeoutMs);
      pending.set(requestId, { method, resolve, reject, timer });
      try { write({ type: 'request', requestId, sourceClientId: clientId ?? 'initializing-client', ...(targetClientId ? { targetClientId } : {}), version, method, timeoutMs, params }); }
      catch (error) { pending.delete(requestId); clearTimeout(timer); reject(error); }
    });
  };
  const receive = (chunk: Buffer) => {
    try {
      // Keep at most one bounded frame in memory, even for a malicious chunk.
      if (buffer.length + chunk.length > MAX_FRAME + 4) throw failure('buffer_limit_exceeded');
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readUInt32LE(0); largestFrameBytes = Math.max(largestFrameBytes, size);
        if (!size || size > MAX_FRAME) throw failure('invalid_frame_size');
        if (buffer.length < size + 4) return;
        let decoded: string;
        try { decoded = utf8.decode(buffer.subarray(4, size + 4)); } catch { throw failure('invalid_utf8'); }
        let frame: State;
        try { frame = JSON.parse(decoded); } catch { throw failure('invalid_json'); }
        buffer = buffer.subarray(size + 4); receivedFrames++;
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw failure('invalid_frame');
        if (frame.type === 'broadcast' && frame.method === 'thread-stream-state-changed') stateFrames++;
        if (frame.type === 'client-discovery-request' && typeof frame.requestId === 'string') { write({ type: 'client-discovery-response', requestId: frame.requestId, response: { canHandle: false } }); continue; }
        const item = frame.type === 'response' ? pending.get(frame.requestId) : undefined;
        if (item) { clearTimeout(item.timer); pending.delete(frame.requestId); if (frame.resultType === 'success') item.resolve(frame); else item.reject(failure(frame.resultType === 'error' && frame.error === 'no-client-found' ? 'no-client-found' : 'remote_error', item.method)); continue; }
        if (frame.type === 'broadcast' && frame.method === 'thread-stream-state-changed' && frame.version === 11 && frame.sourceClientId === owner && Array.isArray(frame.targetClientIds) && frame.targetClientIds.length === 1 && frame.targetClientIds[0] === clientId && frame.params?.conversationId === input.threadId && frame.params.hostId === 'local') {
          matchedStateFrames++;
          if (frame.params.change?.type === 'snapshot') { const state = frame.params.change.conversationState; const decision = assessIdle(state, input.threadId); if (!observed || observed.status === 'idle') { observed = decision; observedAt = new Date().toISOString(); latestState = state; } if (typeof state?.title === 'string' && state.title.length <= 512) title = state.title; if (state?.id === input.threadId) { rolloutPath = typeof state.rolloutPath === 'string' && state.rolloutPath.length > 0 ? state.rolloutPath : undefined; if (readOnly) history = Object.fromEntries(DESKTOP_HISTORY_FIELDS.filter(key => Object.hasOwn(state, key)).map(key => [key, state[key]])); } snapshot?.resolve(); }
          else if (observed?.status === 'idle') observed = { status: 'unknown', reason: 'state_changed_after_snapshot' };
        }
      }
    } catch (error) { const code = (error as { code?: unknown })?.code; rejectAll(failure(typeof code === 'string' && ['buffer_limit_exceeded', 'invalid_frame_size', 'invalid_utf8', 'invalid_json', 'invalid_frame'].includes(code) ? code : 'invalid_transport')); socket?.destroy(); }
  };
  const overall = setTimeout(abort, Math.max(1, input.deadline - Date.now()));
  input.signal.addEventListener('abort', abort, { once: true });
  try {
    if (input.signal.aborted) throw failure('aborted');
    // Owner lookup covers connection, initialization, discovery and snapshot.
    // Repeated probes each report a measured segment for the service to sum.
    timingStage = 'owner_lookup'; stageStarted = performance.now();
    socket = testing ? testing.connect() : net.createConnection(DESKTOP_PIPE); socket.on('data', receive);
    socket.on('error', () => rejectAll(failure('unreachable'))); socket.on('close', () => rejectAll(failure('transport_closed')));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(failure('unreachable')); }, Math.max(1, Math.min(2000, input.deadline - Date.now())));
      const cleanup = () => { clearTimeout(timer); socket?.off('connect', connect); socket?.off('error', error); socket?.off('close', closed); };
      const connect = () => { cleanup(); resolve(); }, error = () => { cleanup(); reject(failure('unreachable')); }, closed = () => { cleanup(); reject(failure('transport_closed')); };
      socket!.once('connect', connect); socket!.once('error', error); socket!.once('close', closed);
    });
    stageReason = 'ipc_initialize_failed';
    clientId = (await request('initialize', { clientType: 'farfield' })).result?.clientId;
    if (typeof clientId !== 'string' || !clientId) throw failure('invalid_response');
    stageReason = 'ipc_owner_discovery_failed';
    owner = (await request('thread-owner-discovery', { hostId: 'local', conversationId: input.threadId })).handledByClientId;
    if (typeof owner !== 'string' || !owner || owner === clientId) throw failure('invalid_response');
    const ownerHash = createHash('sha256').update(owner).digest('hex');
    if (input.afterTurn && ownerHash !== input.afterTurn.ownerHash) return { status: 'skipped_unknown', reason: 'next_turn_owner_changed' };
    stageReason = 'ipc_snapshot_unavailable';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { snapshot = undefined; reject(failure('snapshot_timeout')); }, Math.max(1, Math.min(2000, input.deadline - Date.now())));
      snapshot = { resolve: () => { clearTimeout(timer); snapshot = undefined; resolve(); }, reject: error => { clearTimeout(timer); snapshot = undefined; reject(error); } };
      try { followed = true; following(true); } catch (error) { snapshot.reject(error as Error); }
    });
    if (input.afterTurn) {
      const turns = visibleTurns(latestState), previous = turns.filter(turn => turn?.turnId === input.afterTurn!.id);
      // Do not silently move a chosen next-turn delivery past another turn.
      if (!previous.length || previous.some(turn => turn.turnStartedAtMs !== input.afterTurn!.startedAtMs) || turns.some(turn => turn?.turnId !== input.afterTurn!.id && (turn?.status === 'inProgress' || Number.isFinite(turn?.turnStartedAtMs) && turn.turnStartedAtMs >= input.afterTurn!.startedAtMs))) return { status: 'skipped_unknown', reason: 'next_turn_changed' };
    }
    if (!observed || observed.status !== 'idle') return { status: observed?.status === 'busy' ? 'skipped_busy' : 'skipped_unknown', reason: observed?.reason ?? 'unknown_state', ...(guideBusy && observed?.status === 'busy' && latestState && observedAt ? { busy_state: busySnapshot(latestState, observedAt), busy_owner: ownerHash } : {}) };
    if (input.signal.aborted || Date.now() >= input.deadline) throw failure('aborted');
    if (readOnly) return { status: 'ready', ...(title !== undefined ? { title } : {}), ...(rolloutPath !== undefined ? { rolloutPath } : {}), history, desktop_state: { status: 'idle', observed_at: observedAt!, checked_by: 'native_desktop_owner', scope: 'observation_snapshot' } };
    finishStage();
    stageReason = 'ipc_before_send_failed';
    input.beforeSend({ threadId: input.threadId, ...(rolloutPath !== undefined ? { rolloutPath } : {}) }); // durable intent and fresh expiry/log checks precede the write
    if (input.signal.aborted || Date.now() >= input.deadline || observed.status !== 'idle') throw failure('aborted');
    sent = true;
    timingStage = 'send_ack'; stageStarted = performance.now();
    const ack = await request('thread-follower-start-turn', { conversationId: input.threadId, turnStart: { request: { threadId: input.threadId, input: [{ type: 'text', text, text_elements: [] }], clientUserMessageId: randomUUID(), additionalContext: {} }, context: { localTurnMetadata: null, attachments: [], commentAttachments: [], inheritThreadSettings: true, mcpAppModelContextAttachments: [] } } }, 2, owner);
    const turnId = ack.result?.result?.turn?.id;
    if (ack.method !== 'thread-follower-start-turn' || ack.handledByClientId !== owner || typeof turnId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(turnId)) throw failure('invalid_ack');
    return { status: 'accepted', turnId };
  } catch (error) {
    const code = aborted || input.signal.aborted || Date.now() >= input.deadline ? 'aborted' : (error as { code?: string } | null)?.code;
    const diagnosticCode = DESKTOP_IPC_DIAGNOSTIC_CODES.find(value => value === code) ?? 'other';
    // Diagnostics are metadata only. Their failure must never change delivery,
    // retry a message, or replace the existing public stage/status contract.
    try { input.onDiagnostic?.({ phase: sent ? 'send_ack' : stageReason, diagnostic_code: diagnosticCode, received_frames: receivedFrames, state_frames: stateFrames, matched_state_frames: matchedStateFrames, largest_frame_bytes: largestFrameBytes }); } catch {}
    const noOwner = stageReason === 'ipc_owner_discovery_failed' && code === 'no-client-found' && (error as { method?: string } | null)?.method === 'thread-owner-discovery';
    return { status: sent ? 'uncertain' : code === 'unreachable' ? 'skipped_unreachable' : 'skipped_unknown', reason: sent ? 'send_outcome_unknown' : noOwner ? 'native_owner_unavailable' : code === 'aborted' ? 'ipc_aborted' : stageReason };
  } finally {
    finishStage();
    clearTimeout(overall); input.signal.removeEventListener('abort', abort);
    if (followed && socket && !socket.destroyed && !transportError) { try { following(false); } catch {} }
    rejectAll(failure('transport_closed')); buffer = Buffer.alloc(0);
    if (socket && !socket.closed) await new Promise<void>(resolve => { socket!.once('close', resolve); socket!.destroy(); });
  }
}
