import type { NativeReaderTesting } from './desktop-conversation-reader.js';
import { withNativeReadSession } from './desktop-conversation-reader.js';
import { contentHash, projectPublicItem, publicItemSlice } from './context-public-content.js';
import type { ContextReadInput, ContextReadBatch, ContextSourceIdentity, ContextTurnIndex, ContextGap, ContextReadTurn, ContextPublicItem, ContextReadContinuation } from './context-reader-types.js';
export type * from './context-reader-types.js';

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
const terminalStatus = (status: string): boolean => ['completed', 'interrupted', 'failed', 'cancelled', 'canceled'].includes(status);
const limit = (value: number | undefined, fallback: number, min: number, max: number): number => value === undefined ? fallback
  : Number.isSafeInteger(value) && value >= min && value <= max ? value : fail('invalid_input');
const unique = (ids: string[]): string[] => [...new Set(ids)];
const excludedGap = (gap: ContextGap): boolean => ['attachment_body_unavailable', 'compaction_body_unavailable', 'structured_tool_body_not_projected'].includes(gap.code);

function identity(thread: Record<string, any>, home: string): ContextSourceIdentity {
  const source = { threadId: thread.id as string, codexHome: home,
    ...(typeof thread.path === 'string' ? { rolloutPath: thread.path } : {}),
    ...(typeof thread.cwd === 'string' ? { cwd: thread.cwd } : {}),
    ...(typeof thread.createdAt === 'number' ? { createdAt: thread.createdAt } : {}) };
  return { ...source, identityHash: contentHash(source) };
}
function parsePage(page: unknown): { data: any[]; nextCursor: string | null } {
  if (!object(page) || !Array.isArray(page.data) || !(page.nextCursor === null || typeof page.nextCursor === 'string' && page.nextCursor.length > 0 && page.nextCursor.length <= 65536)) fail('native_reader_protocol_invalid');
  return page as { data: any[]; nextCursor: string | null };
}
function indexTurn(turn: unknown): ContextTurnIndex {
  if (!object(turn) || !UUID.test(turn.id ?? '') || turn.itemsView !== 'notLoaded' || !Array.isArray(turn.items) || turn.items.length || typeof turn.status !== 'string') fail('native_reader_protocol_invalid');
  const row = turn as Record<string, any>;
  return { turnId: row.id, status: row.status, fingerprint: contentHash({ id: row.id, status: row.status }) };
}

/** Source-only observed coverage. It never claims semantic readiness or owner idleness. */
export async function readContextBatch(input: ContextReadInput, testing: NativeReaderTesting = {}): Promise<ContextReadBatch> {
  const now = testing.now ?? Date.now;
  const readDeadline = Math.min(input.deadline, now() + 60000);
  const maxTurns = limit(input.limits?.maxTurns, 12, 1, 1000), maxBytes = limit(input.limits?.maxBytes, 128000, 2048, 8 * 1024 * 1024);
  const maxItemChars = limit(input.limits?.maxItemChars, 8000, 128, 2 * 1024 * 1024), maxRpc = limit(input.limits?.maxRpc, 1000, 8, 10000);
  const maxIndexPages = limit(input.limits?.maxIndexPages, 200, 1, 5000);
  if (input.turnIds?.some(id => !UUID.test(id)) || input.evidence && (!UUID.test(input.evidence.turnId) || typeof input.evidence.itemId !== 'string' || !input.evidence.itemId || input.evidence.itemId.length > 2048
    || input.evidence.offset !== undefined && (!Number.isSafeInteger(input.evidence.offset) || input.evidence.offset < 0))) fail('invalid_input');
  return withNativeReadSession(input, async session => {
    const startedAt = new Date(now()).toISOString(), gaps: ContextGap[] = [{ code: 'history_generation_unavailable', detail: 'Stable IDs and overlap hashes cannot detect arbitrary edits to older, unobserved turns.' }];
    let rpcCount = 0, excludedItems = 0, evidenceBytes = 0, invalidated = false, indexComplete = false;
    let rpcEstimateMs = 0, itemPages = 0;
    const rpc = async (method: 'thread/read' | 'thread/turns/list' | 'thread/items/list', params: object, mode: 'index' | 'items' | 'final' = 'index'): Promise<any> => {
      if (rpcCount >= maxRpc || session.receivedBytes() >= 24 * 1024 * 1024) fail('context_resource_limit');
      // Reserve final identity/head checks, a second pass over acquired item pages,
      // the next RPC itself, and child cleanup. Use observed latency, not a fixed turn count.
      const reservedRpc = mode === 'final' ? 1 : (mode === 'items' ? 4 : 3) + itemPages;
      if (now() + reservedRpc * rpcEstimateMs + 500 >= readDeadline) fail('context_time_budget');
      rpcCount++; const before = now();
      try { return await session.request(method, params); }
      finally { rpcEstimateMs = Math.max(rpcEstimateMs, now() - before); if (mode === 'items') itemPages++; }
    };
    const metadata = async (mode: 'index' | 'final' = 'index'): Promise<Record<string, any>> => {
      const result = await rpc('thread/read', { threadId: input.threadId, includeTurns: false }, mode);
      if (!object(result) || !object(result.thread) || result.thread.id !== input.threadId || !Array.isArray(result.thread.turns) || result.thread.turns.length) fail('native_reader_identity_invalid');
      return result.thread;
    };
    const sourceIdentity = identity(await metadata(), session.home);
    let previous = input.previous, continuation = input.continuation;
    for (const basis of [previous, continuation]) if (basis && (basis.version !== 1 || basis.sourceIdentity?.identityHash !== sourceIdentity.identityHash)) invalidated = true;
    if (invalidated) { previous = undefined; continuation = undefined; gaps.push({ code: 'source_identity_changed' }); }
    gaps.push(...(previous?.exclusionGaps ?? []), ...(continuation?.exclusionGaps ?? []));
    const headPage = parsePage(await rpc('thread/turns/list', { threadId: input.threadId, itemsView: 'notLoaded', sortDirection: 'desc', limit: 100 }));
    const firstRows = headPage.data.map(indexTurn), startHeadTurnId = firstRows[0]?.turnId;
    const knownIndex = continuation?.indexComplete ? continuation.index : previous?.indexComplete ? previous.index : undefined;
    let index: ContextTurnIndex[] = [], cursor: string | null = headPage.nextCursor, pages = 1;
    const seenIds = new Set<string>(), seenCursors = new Set<string>(); let indexIntegrity = true;
    const append = (rows: ContextTurnIndex[]) => {
      for (const row of rows) {
        if (seenIds.has(row.turnId)) { indexIntegrity = false; gaps.push({ code: 'duplicate_turn', turnId: row.turnId }); continue; }
        seenIds.add(row.turnId); index.push(row);
      }
    };
    append(firstRows);
    const attachKnownTail = (): boolean => {
      if (!knownIndex?.length) return false;
      // The former latest stable ID is the overlap anchor, never the opaque cursor.
      const anchor = knownIndex[0]!, at = index.findIndex(row => row.turnId === anchor.turnId);
      if (at < 0) return false;
      if (index[at]!.fingerprint !== anchor.fingerprint) return false;
      // A former older turn becoming the head means rollback/shortening, not append.
      if (startHeadTurnId && knownIndex.findIndex(row => row.turnId === startHeadTurnId) > 0) return false;
      const overlap = index.slice(at + 1);
      if (overlap.some((row, offset) => row.turnId !== knownIndex[offset + 1]?.turnId || row.fingerprint !== knownIndex[offset + 1]?.fingerprint)) return false;
      // Status observations for all formerly active turns must be refreshed before
      // reusing an older index tail; otherwise a now-completed old turn stays stale.
      if (knownIndex.some(row => !terminalStatus(row.status) && !seenIds.has(row.turnId))) return false;
      append(knownIndex.slice(1 + overlap.length)); indexComplete = true; return true;
    };
    let reusedTail = attachKnownTail();
    try {
      while (cursor !== null && !reusedTail) {
        if (pages >= Math.min(5000, maxIndexPages + (continuation?.indexPages ?? 0))) { gaps.push({ code: 'index_resource_limit' }); break; }
        if (!index.length || seenCursors.has(cursor)) { gaps.push({ code: 'turn_cursor_loop' }); break; }
        seenCursors.add(cursor);
        const page = parsePage(await rpc('thread/turns/list', { threadId: input.threadId, itemsView: 'notLoaded', sortDirection: 'desc', limit: 100, cursor }));
        pages++;
        const rows = page.data.map(indexTurn), before = index.length; append(rows);
        if (index.length === before && page.nextCursor !== null) { gaps.push({ code: 'turn_cursor_no_progress' }); break; }
        cursor = page.nextCursor; reusedTail = attachKnownTail();
      }
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (!['context_resource_limit', 'context_time_budget', 'timeout', 'native_reader_request_failed'].includes(code ?? '')) throw error;
      gaps.push({ code: code === 'native_reader_request_failed' ? 'turn_cursor_invalid' : code! });
    }
    if (cursor === null) indexComplete = true;
    if (!indexIntegrity) indexComplete = false;
    if (knownIndex && indexComplete && !reusedTail && (knownIndex.some(row => !seenIds.has(row.turnId)) || startHeadTurnId && knownIndex.findIndex(row => row.turnId === startHeadTurnId) > 0)) {
      invalidated = true; gaps.push({ code: 'history_anchor_missing_or_rollback' });
    }
    const unfinishedTurnIds = index.filter(row => !terminalStatus(row.status)).map(row => row.turnId);
    const oldIds = new Set(previous?.index.map(row => row.turnId) ?? []);
    let pending = continuation?.indexComplete && !invalidated ? continuation.pendingTurnIds.filter(id => seenIds.has(id)) : [];
    const requested = input.evidence ? [input.evidence.turnId] : input.turnIds;
    if (requested) pending = unique(requested);
    else if (continuation?.indexComplete && !invalidated) pending = unique([...pending,
      ...index.filter(row => !continuation!.index.some(old => old.turnId === row.turnId && old.fingerprint === row.fingerprint)).map(row => row.turnId)]);
    else if (!previous || invalidated) pending = unique([...pending, ...index.map(row => row.turnId)]);
    else pending = unique([...index.filter(row => !oldIds.has(row.turnId) || !previous!.turnFingerprints[row.turnId]).map(row => row.turnId),
      ...index.filter(row => previous!.index.find(old => old.turnId === row.turnId)?.fingerprint !== row.fingerprint).map(row => row.turnId),
      ...(previous.pendingTurnIds ?? []), ...pending, ...(startHeadTurnId ? [startHeadTurnId] : []), ...previous.unfinishedTurnIds, ...unfinishedTurnIds]).filter(id => seenIds.has(id));
    const recheckTurnIds = new Set(requested ? [] : unique([...(continuation?.recheckTurnIds ?? []),
      ...(startHeadTurnId ? [startHeadTurnId] : []), ...(previous?.unfinishedTurnIds ?? []),
      ...(continuation?.index.filter(row => !terminalStatus(row.status)).map(row => row.turnId) ?? []), ...unfinishedTurnIds]).filter(id => seenIds.has(id)));
    const turns: ContextReadTurn[] = [];
    const collectionCandidates = new Set<string>();
    let currentTurn: ContextReadContinuation['currentTurn'];
    let currentItem: ContextReadContinuation['currentItem'];
    const fingerprints = { ...(!invalidated ? previous?.turnFingerprints : {}), ...(!invalidated ? continuation?.turnFingerprints : {}) };
    const readTurn = async (turnId: string, verifying = false): Promise<{ items: ContextPublicItem[]; all: boolean; fingerprint: string }> => {
      const items: ContextPublicItem[] = [], ids = new Set<string>(), cursors = new Set<string>(); let itemCursor: string | undefined, all = false, integrity = true;
      try {
        while (true) {
          const page = parsePage(await rpc('thread/items/list', { threadId: input.threadId, turnId, sortDirection: 'asc', limit: 100,
            ...(itemCursor ? { cursor: itemCursor } : {}) }, verifying ? 'final' : 'items'));
          for (const entry of page.data) {
            if (!object(entry) || entry.turnId !== turnId || !object(entry.item) || typeof entry.item.id !== 'string' || !entry.item.id || entry.item.id.length > 2048) fail('native_reader_protocol_invalid');
            if (ids.has(entry.item.id)) { integrity = false; gaps.push({ code: 'duplicate_item', turnId, itemId: entry.item.id }); continue; }
            ids.add(entry.item.id);
            const item = projectPublicItem(input.threadId, turnId, entry.item, gaps);
            if (item) items.push(item); else excludedItems++;
          }
          if (page.nextCursor === null) { all = integrity; break; }
          if (!page.data.length || cursors.has(page.nextCursor)) { gaps.push({ code: 'item_cursor_loop', turnId }); break; }
          cursors.add(page.nextCursor); itemCursor = page.nextCursor;
        }
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (!['context_resource_limit', 'context_time_budget', 'timeout', 'native_reader_request_failed'].includes(code ?? '')) throw error;
        gaps.push({ code: code === 'native_reader_request_failed' ? 'item_cursor_invalid_or_turn_unavailable' : code!, turnId });
      }
      return { items, all, fingerprint: contentHash(items.map(item => [item.id, item.fingerprint])) };
    };
    if (!indexComplete) gaps.push({ code: 'unfinished_turns_outside_index_unknown' });
    while (pending.length && turns.length < maxTurns && rpcCount < maxRpc - 2) {
      const turnId = pending[0]!, row = index.find(entry => entry.turnId === turnId);
      if (!row) { gaps.push({ code: 'requested_turn_unavailable', turnId }); pending.shift(); continue; }
      const fetched = await readTurn(turnId);
      if (!fetched.all && !fetched.items.length) break;
      let from = 0;
      if (continuation?.currentTurn?.turnId === turnId && !input.evidence) {
        if (fetched.fingerprint === continuation.currentTurn.fingerprint) from = continuation.currentTurn.nextItemIndex;
        else gaps.push({ code: 'turn_changed_between_batches', turnId });
      }
      const delivered: ContextPublicItem[] = [];
      let next = from;
      for (; next < fetched.items.length; next++) {
        const full = fetched.items[next]!;
        if (input.evidence && full.id !== input.evidence.itemId) continue;
        const resumedItem = continuation?.currentItem;
        const resumeOffset = resumedItem?.turnId === turnId && resumedItem.itemId === full.id && resumedItem.fingerprint === full.fingerprint
          ? resumedItem.nextOffset : 0;
        let item = publicItemSlice(full, input.evidence?.offset ?? resumeOffset, maxItemChars);
        let bytes = Buffer.byteLength(JSON.stringify(item));
        // One long item remains fetchable by text offset; do not produce an unbounded first item.
        if (bytes > maxBytes - evidenceBytes && !delivered.length && !turns.length) {
          item = publicItemSlice(full, input.evidence?.offset ?? resumeOffset, Math.max(128, Math.floor((maxBytes - 1024) / 4)));
          bytes = Buffer.byteLength(JSON.stringify(item));
        }
        if (bytes > maxBytes - evidenceBytes) break;
        delivered.push(item); evidenceBytes += bytes;
        const end = item.textOffset + item.text.length;
        if (end < item.totalTextLength) {
          gaps.push({ code: 'item_text_truncated', turnId, itemId: item.id, offset: end });
          currentItem = { turnId, itemId: item.id, fingerprint: item.fingerprint, nextOffset: end };
          break;
        }
      }
      const deliveredAll = next === fetched.items.length && from === 0 && !input.evidence;
      if (input.evidence && !delivered.length) gaps.push({ code: 'requested_item_unavailable', turnId, itemId: input.evidence.itemId });
      const complete = fetched.all && deliveredAll && !delivered.some(item => item.truncated);
      turns.push({ turnId, status: row.status, fingerprint: fetched.fingerprint, items: delivered, itemIds: fetched.all ? fetched.items.map(item => item.id) : [],
        ...(fetched.all ? { itemFingerprints: Object.fromEntries(fetched.items.map(item => [item.id, item.fingerprint])) } : {}), complete, replaceItems: false });
      if (fetched.all) collectionCandidates.add(turnId);
      if (fetched.all && next === fetched.items.length) { fingerprints[turnId] = fetched.fingerprint; pending.shift(); }
      else { currentTurn = { turnId, fingerprint: fetched.fingerprint, nextItemIndex: fetched.all ? next : 0 }; break; }
    }
    let observedStable = false, endHeadTurnId: string | undefined;
    try {
      let itemsStable = true;
      // Metadata and an unchanged head ID cannot detect streamed updates within a turn.
      for (const turn of turns) {
        const checked = await readTurn(turn.turnId, true);
        if (!checked.all || checked.fingerprint !== turn.fingerprint) {
          collectionCandidates.delete(turn.turnId);
          itemsStable = false; gaps.push({ code: 'turn_changed_during_read', turnId: turn.turnId });
          pending = unique([turn.turnId, ...pending]);
        }
      }
      // Historical work goes first. Recheck already delivered latest/active turns
      // only when this continuation chain is otherwise ready to finish, so a
      // maxTurns=1 stream cannot repeatedly read the head and starve older turns.
      if (continuation && !pending.length && !requested) for (const turnId of [...recheckTurnIds]) {
        if (collectionCandidates.has(turnId)) { recheckTurnIds.delete(turnId); continue; }
        const checked = await readTurn(turnId, true);
        if (!checked.all) { itemsStable = false; continue; }
        recheckTurnIds.delete(turnId);
        if (checked.fingerprint !== fingerprints[turnId]) {
          itemsStable = false; gaps.push({ code: 'continuation_turn_changed', turnId });
          pending = unique([...pending, turnId]);
        }
      }
      else if (!continuation && !pending.length) for (const turnId of collectionCandidates) recheckTurnIds.delete(turnId);
      // Observe the source boundary last, including growth during item verification.
      const finalIdentity = identity(await metadata('final'), session.home);
      const finalHead = parsePage(await rpc('thread/turns/list', { threadId: input.threadId, itemsView: 'notLoaded', sortDirection: 'desc', limit: 100 }, 'final')).data.map(indexTurn);
      endHeadTurnId = finalHead[0]?.turnId;
      const headerStable = finalIdentity.identityHash === sourceIdentity.identityHash && contentHash(finalHead) === contentHash(firstRows);
      observedStable = itemsStable && headerStable;
      if (!headerStable) {
        gaps.push({ code: 'source_changed_during_read' });
        pending = unique([...finalHead.map(row => row.turnId), ...pending, ...unfinishedTurnIds]);
        if (finalIdentity.identityHash !== sourceIdentity.identityHash) { invalidated = true; gaps.push({ code: 'source_identity_changed_during_read' }); }
      }
    } catch (error) {
      if (!['context_resource_limit', 'context_time_budget', 'timeout'].includes((error as { code?: string }).code ?? '')) throw error;
      gaps.push({ code: 'observation_boundary_unverified' });
      pending = unique([...turns.map(turn => turn.turnId), ...pending]);
    }
    for (const turn of turns) turn.itemSetVerified = turn.replaceItems = collectionCandidates.has(turn.turnId) && observedStable;
    const finishedAt = new Date(now()).toISOString();
    const exclusionGaps = [...new Map(gaps.filter(excludedGap).map(gap => [`${gap.code}/${gap.turnId ?? ''}/${gap.itemId ?? ''}`, gap])).values()];
    const watermark = { version: 1 as const, sourceIdentity, index, indexComplete, ...(startHeadTurnId ? { headTurnId: startHeadTurnId } : {}), unfinishedTurnIds,
      turnFingerprints: fingerprints, pendingTurnIds: unique([...pending, ...recheckTurnIds]), exclusionGaps, observedAt: finishedAt };
    if (pending.length) gaps.push({ code: 'pending_turns' });
    const resume = pending.length || recheckTurnIds.size || !indexComplete || !observedStable ? { version: 1 as const, sourceIdentity, index, indexComplete, pendingTurnIds: pending,
      recheckTurnIds: [...recheckTurnIds], turnFingerprints: fingerprints, exclusionGaps,
      ...(!indexComplete ? { indexPages: pages } : {}), ...(currentTurn ? { currentTurn } : {}), ...(currentItem ? { currentItem } : {}), startedAt: continuation?.startedAt ?? startedAt } : undefined;
    return { sourceIdentity, observation: { startedAt, finishedAt, ...(startHeadTurnId ? { startHeadTurnId } : {}), ...(endHeadTurnId ? { endHeadTurnId } : {}) }, turns, gaps, watermark,
      ...(resume ? { continuation: resume } : {}), coverage: { indexComplete, projectionComplete: indexComplete && !pending.length && !recheckTurnIds.size && observedStable && !input.turnIds && !input.evidence,
        historyComplete: indexComplete && !pending.length && !recheckTurnIds.size && observedStable && !input.turnIds && !input.evidence
          && !gaps.some(gap => gap.code === 'item_text_truncated' || excludedGap(gap)),
        observedStable, historicalEditsDetectable: false }, invalidated,
      metrics: { rpcCount, sourceBytes: session.receivedBytes(), evidenceBytes, indexTurns: index.length, excludedItems } };
  }, testing);
}
