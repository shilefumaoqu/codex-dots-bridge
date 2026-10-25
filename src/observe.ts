import { readStoredTask } from './task-persistence.js';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { StoredTask, TaskResult, TaskStatus } from './task-store.js';
import { ProbeError } from './store.js';

const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const limit = z.number().int().min(1).max(100).optional();
export const observeSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('snapshot'), after_task_id: z.string().uuid().optional(), watermark: sequence.optional(), limit }).strict()
    .refine(v => (v.after_task_id === undefined) === (v.watermark === undefined), 'Snapshot continuation requires both after_task_id and watermark'),
  z.object({ mode: z.literal('changes'), cursor: sequence, limit }).strict(),
  z.object({ mode: z.literal('task'), task_id: z.string().uuid() }).strict(),
]);
export type ObserveRequest = z.infer<typeof observeSchema>;
export interface ObservedQuestion {
  question_id: string; input_revision: number; question: string; options?: string[];
  requires_platform_action: boolean; action_url?: string; created_at: string;
}
export interface ObservedResult { result_id: string; input_revision: number; at: string; result: TaskResult }
export interface ObservedTask {
  task_id: string; title: string; status: TaskStatus; input_revision: number; change_sequence: number;
  notice_sequence?: number;
  created_at: string; updated_at: string;
  checkpoint?: { at: string; input_revision: number; summary?: string };
  question?: ObservedQuestion; result?: ObservedResult; error?: { code: string; message: string };
  cancellation_ack?: { at: string; note?: string };
}
export interface ObservedEvent {
  sequence: number; kind: string; at: string; task_id?: string; task?: ObservedTask;
  question?: ObservedQuestion; result?: ObservedResult; error?: { code: string; message: string };
}
export interface ObserveResponse {
  protocol_version: 1; instance_id: string; observed_at: string; complete: boolean;
  cursor: number; has_more: boolean; next_task_id?: string; tasks: ObservedTask[]; events: ObservedEvent[];
}
type Question = StoredTask['questions'][number];
type Result = StoredTask['results'][number];
// Explicit whitelists: task inputs, parent context, operation keys and receipts never leave this adapter.
export function observedQuestion(q: Question): ObservedQuestion {
  return { question_id: q.question_id, input_revision: q.input_revision, question: q.question,
    ...(q.options === undefined ? {} : { options: q.options }), requires_platform_action: q.requires_platform_action,
    ...(q.action_url === undefined ? {} : { action_url: q.action_url }), created_at: q.created_at };
}
export function observedResult(r: Result): ObservedResult {
  const result: TaskResult = { ...(r.result.text === undefined ? {} : { text: r.result.text }),
    ...(r.result.data === undefined ? {} : { data: r.result.data }),
    ...(r.result.links === undefined ? {} : { links: r.result.links.map(link => ({ url: link.url,
      ...(link.label === undefined ? {} : { label: link.label }) })) }) };
  return { result_id: r.result_id, input_revision: r.input_revision, at: r.at, result };
}
export function observedTask(t: StoredTask): ObservedTask {
  const checkpoint = t.attempts.find(a => a.number === t.attempt)?.checkpoints.filter(c => c.input_revision === t.input_revision).at(-1);
  const question = t.questions.find(q => q.question_id === t.active_question_id && q.input_revision === t.input_revision && !q.answer);
  const result = t.results.find(r => r.result_id === t.result_id && r.accepted_as_final && r.input_revision === t.input_revision);
  return { task_id: t.task_id, title: t.title, status: t.status, input_revision: t.input_revision,
    change_sequence: t.change_sequence, created_at: t.created_at, updated_at: t.updated_at,
    ...(checkpoint ? { checkpoint: { at: checkpoint.at, input_revision: checkpoint.input_revision,
      ...(checkpoint.summary === undefined ? {} : { summary: checkpoint.summary }) } } : {}),
    ...(question ? { question: observedQuestion(question) } : {}), ...(result ? { result: observedResult(result) } : {}),
    ...(t.error ? { error: { code: t.error.code, message: t.error.message } } : {}),
    ...(t.cancellation_ack ? { cancellation_ack: { at: t.cancellation_ack.at,
      ...(t.cancellation_ack.note === undefined ? {} : { note: t.cancellation_ack.note }) } } : {}) };
}

/** SELECT-only observation also supports an independently opened readonly production database. */
export function observeDatabase(db: Database.Database, request: unknown, instanceId: string, now: () => number = Date.now): ObserveResponse {
  const params = observeSchema.parse(request);
  if (!z.string().uuid().safeParse(instanceId).success) throw new ProbeError('observer_identity_unconfigured');
  return db.transaction(() => {
    const hasCursor=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_cursor'").get();
    const maximum = hasCursor?(db.prepare('SELECT highwater FROM task_cursor WHERE singleton=1').get() as {highwater:number}).highwater:(db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM task_evidence').get() as { id: number }).id;
    if (!Number.isSafeInteger(maximum)) throw new ProbeError('observer_sequence_exhausted');
    const response: ObserveResponse = { protocol_version: 1, instance_id: instanceId, observed_at: new Date(now()).toISOString(),
      complete: true, cursor: maximum, has_more: false, tasks: [], events: [] };
    const readTask = (id: string): StoredTask | undefined => {
      const row = db.prepare('SELECT data FROM tasks WHERE id=?').get(id) as { data: string } | undefined;
      return row ? readStoredTask(db,row.data) : undefined;
    };
    const projections = new Map<string, ObservedTask>();
    const project = (task: StoredTask): ObservedTask => {
      const cached = projections.get(task.task_id);
      if (cached) return cached;
      const value = observedTask(task);
      if (value.result || value.question || task.status === 'failed') {
        const evidence = (db.prepare("SELECT id,kind,detail FROM task_evidence WHERE task_id=? AND kind IN ('result_saved','question_saved','failed','manually_resolved') ORDER BY id").all(task.task_id) as {
          id: number; kind: string; detail: string;
        }[]).map(row => ({ ...row, detail: JSON.parse(row.detail) as Record<string, unknown> }));
        let origin = evidence.find(row => value.result ? row.kind === 'result_saved' && row.detail.result_id === value.result.result_id
          : value.question ? row.kind === 'question_saved' && row.detail.question_id === value.question.question_id
            : row.kind === 'failed' && row.detail.accepted_as_final === true && row.detail.revision === task.input_revision);
        // Older manual-resolution evidence has no result ID. A completed task cannot be edited or
        // resolved again, so its sole complete resolution owns the immutable current manual result.
        // Require that proof to be unique; missing/conflicting evidence does not become a fresh notice.
        if (!origin && (value.result && task.results.some(r => r.result_id === value.result!.result_id && r.disposition === 'manual_resolution')
          || task.status === 'failed' && task.error?.code === 'manually_resolved')) {
          const decision = value.result ? 'complete' : 'fail';
          const manual = evidence.filter(row => row.kind === 'manually_resolved' && row.detail.decision === decision);
          if (manual.length === 1) origin = manual[0];
        }
        if (origin) value.notice_sequence = origin.id;
      }
      projections.set(task.task_id, value); return value;
    };
    if (params.mode === 'task') {
      const task = readTask(params.task_id);
      if (!task) throw new ProbeError('task_not_found');
      response.tasks = [project(task)];
    } else if (params.mode === 'snapshot') {
      const watermark = params.watermark ?? maximum;
      if (watermark > maximum) throw new ProbeError('invalid_observer_cursor');
      const size = params.limit ?? 50;
      const rows = db.prepare('SELECT data FROM tasks WHERE id>? ORDER BY id LIMIT ?').all(params.after_task_id ?? '', size + 1) as { data: string }[];
      response.cursor = watermark;
      response.has_more = rows.length > size;
      response.tasks = rows.slice(0, size).map(row => project(readStoredTask(db,row.data)));
      if (response.has_more) response.next_task_id = response.tasks.at(-1)!.task_id;
    } else {
      if (params.cursor > maximum) throw new ProbeError('invalid_observer_cursor');
      const size = params.limit ?? 50;
      const rows = db.prepare('SELECT id,at,kind,task_id,detail FROM task_evidence WHERE id>? ORDER BY id LIMIT ?').all(params.cursor, size + 1) as {
        id: number; at: string; kind: string; task_id: string | null; detail: string;
      }[];
      response.has_more = rows.length > size;
      response.events = rows.slice(0, size).map(row => {
        const event: ObservedEvent = { sequence: row.id, kind: row.kind, at: row.at };
        if (!row.task_id) return event; // Global evidence must still advance the observer cursor.
        event.task_id = row.task_id;
        const task = readTask(row.task_id);
        if (!task) return event; // Missing source data does not claim task deletion.
        event.task = project(task);
        const detail = JSON.parse(row.detail) as Record<string, unknown>;
        if (row.kind === 'question_saved') {
          const question = task.questions.find(q => q.question_id === detail.question_id);
          if (question) event.question = observedQuestion(question);
        }
        if (row.kind === 'result_saved' || row.kind === 'manually_resolved' && detail.decision === 'complete') {
          const resultId = row.kind === 'result_saved' ? detail.result_id : task.result_id;
          const result = task.results.find(r => r.result_id === resultId && r.accepted_as_final);
          if (result) event.result = observedResult(result);
        }
        if (row.kind === 'failed' && detail.accepted_as_final === true && task.error)
          event.error = { code: task.error.code, message: task.error.message };
        return event;
      });
      response.cursor = response.has_more ? response.events.at(-1)!.sequence : maximum;
    }
    return response;
  })();
}
