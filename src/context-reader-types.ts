import type { NativeReadInput } from './desktop-conversation-reader.js';

export interface ContextSourceIdentity {
  threadId: string;
  codexHome: string;
  rolloutPath?: string;
  cwd?: string;
  createdAt?: number;
  identityHash: string;
}
export interface ContextTurnIndex { turnId: string; status: string; fingerprint: string }
export interface ContextPublicItem {
  id: string;
  type: string;
  text: string;
  fingerprint: string;
  source_ref: string;
  status?: string;
  truncated: boolean;
  textOffset: number;
  totalTextLength: number;
}
export interface ContextReadTurn {
  turnId: string;
  status: string;
  fingerprint: string;
  items: ContextPublicItem[];
  /** All current public item IDs only when native item pagination was exhausted. */
  itemIds: string[];
  complete: boolean;
  /** Complete native public-item collection, independent of delivery text fragments. */
  itemSetVerified?: boolean;
  itemFingerprints?: Record<string, string>;
  /** Permits deleting absent/obsolete refs from a verified collection; does not imply full body delivery. */
  replaceItems: boolean;
}
export interface ContextGap { code: string; turnId?: string; itemId?: string; offset?: number; detail?: string }
export interface ContextWatermark {
  version: 1;
  sourceIdentity: ContextSourceIdentity;
  index: ContextTurnIndex[];
  indexComplete: boolean;
  headTurnId?: string;
  unfinishedTurnIds: string[];
  turnFingerprints: Record<string, string>;
  pendingTurnIds?: string[];
  exclusionGaps?: ContextGap[];
  observedAt: string;
}
export interface ContextReadContinuation {
  version: 1;
  sourceIdentity: ContextSourceIdentity;
  index: ContextTurnIndex[];
  indexComplete: boolean;
  pendingTurnIds: string[];
  turnFingerprints?: Record<string, string>;
  exclusionGaps?: ContextGap[];
  /** Restart index traversal using stable IDs, never a saved opaque server cursor. */
  indexPages?: number;
  currentTurn?: { turnId: string; fingerprint: string; nextItemIndex: number };
  currentItem?: { turnId: string; itemId: string; fingerprint: string; nextOffset: number };
  /** Recheck previously delivered latest/active turns once the historical pending queue drains. */
  recheckTurnIds?: string[];
  startedAt: string;
}
export interface ContextReadInput extends NativeReadInput {
  previous?: ContextWatermark;
  continuation?: ContextReadContinuation;
  turnIds?: string[];
  evidence?: { turnId: string; itemId: string; offset?: number };
  limits?: { maxTurns?: number; maxBytes?: number; maxItemChars?: number; maxRpc?: number; maxIndexPages?: number };
}
export interface ContextReadBatch {
  sourceIdentity: ContextSourceIdentity;
  observation: { startedAt: string; finishedAt: string; startHeadTurnId?: string; endHeadTurnId?: string };
  turns: ContextReadTurn[];
  gaps: ContextGap[];
  watermark: ContextWatermark;
  continuation?: ContextReadContinuation;
  coverage: { indexComplete: boolean; projectionComplete: boolean; historyComplete: boolean; observedStable: boolean; historicalEditsDetectable: false };
  invalidated: boolean;
  metrics: { rpcCount: number; sourceBytes: number; evidenceBytes: number; indexTurns: number; excludedItems: number };
}
