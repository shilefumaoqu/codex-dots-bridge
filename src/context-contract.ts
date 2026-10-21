import { z } from 'zod';

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const ref = z.string().min(1).max(1024);
export const contextFactSchema = z.object({
  id: z.string().min(1).max(128), text: z.string().min(1).max(16000),
  classification: z.enum(['reported', 'observed', 'inferred', 'caller_correction']),
  source_refs: z.array(ref).max(256), supersedes: z.array(z.string().min(1).max(128)).max(128).optional(),
}).strict().refine(value => value.classification === 'inferred' || value.classification === 'caller_correction' || value.source_refs.length > 0, { message: 'source_refs_required' });
const facts = z.array(contextFactSchema).max(256);
export const contextStateSchema = z.object({
  task: facts, requirements: facts, completed: facts, pending: facts, execution: facts, gaps: facts,
  consumer_thread_id: uuid.optional(), derived_from: uuid.optional(),
}).strict().refine(value => JSON.stringify(value).length <= 262144, { message: 'state_too_large' });
export const contextGetSchema = z.object({
  request_id: uuid, thread_id: uuid, mode: z.enum(['view', 'continue', 'evidence']).default('continue'),
  refs: z.array(ref).max(256).optional(), continuation_token: z.string().min(1).max(256).optional(),
  evidence_offset: z.number().int().nonnegative().max(8388608).optional(),
  delivery_cursor: z.string().min(1).max(256).optional(), wait_seconds: z.number().min(0).max(20).optional(),
}).strict().refine(value => value.evidence_offset === undefined || value.mode === 'evidence' && value.refs?.length === 1, {message:'evidence_offset_requires_single_ref'});
export const contextUpdateSchema = z.object({
  operation_id: uuid, thread_id: uuid, expected_epoch: z.number().int().nonnegative(),
  expected_revision: z.number().int().nonnegative(), read_receipt_id: uuid,
  state: contextStateSchema, processed_refs: z.array(ref).max(8192).optional(),
}).strict();
export const contextForgetSchema = z.object({
  operation_id: uuid, thread_id: uuid, expected_epoch: z.number().int().nonnegative(), expected_revision: z.number().int().nonnegative(),
}).strict();
export type ContextState = z.infer<typeof contextStateSchema>;
export type ContextGetArgs = z.infer<typeof contextGetSchema>;
export type ContextUpdateArgs = z.infer<typeof contextUpdateSchema>;
export type ContextForgetArgs = z.infer<typeof contextForgetSchema>;
export interface ContextOwnerObservation { status: 'busy' | 'idle' | 'unknown'; observed_at: string; checked_by: 'native_desktop_owner' | 'unavailable'; active_turn_id?: string }
export interface ContextCoverage {
  fetched_refs: string[]; delivered_refs: string[]; processed_refs: string[];
  source_complete: false; public_history_complete: boolean; public_projection_complete: boolean;
  limited: boolean; delivery_complete: boolean; continuous: boolean; gaps: string[];
  /** Invalid old basis notices that a complete stable rebuild has resolved. */
  resolved_gaps?: string[];
  observed_at?: string; source_watermark?: unknown; processed_watermark?: unknown;
}
export interface ContextEvidence { ref: string; text: string; [key: string]: unknown }
export interface ContextGetResult {
  request_id: string; thread_id: string; status: 'pending' | 'ready' | 'partial' | 'reconciliation_required' | 'failed' | 'forgotten';
  epoch: number; revision: number; state: ContextState | null; read_receipt_id?: string;
  evidence?: ContextEvidence[]; coverage?: ContextCoverage; delivery_cursor?: string; continuation_token?: string;
  owner_observation: ContextOwnerObservation; reason?: string; basis_valid?: boolean;
}
export interface ContextMutationResult { thread_id: string; epoch: number; revision: number; status: 'updated' | 'forgotten'; coverage?: ContextCoverage }
export class ContextError extends Error { constructor(public readonly code: string) { super(code); } }

