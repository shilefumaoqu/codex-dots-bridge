import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const utc = z.string().datetime({ precision: 3 }).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
export const deliveryWindowSchema = z.object({
  request_id: uuid, thread_id: uuid,
  text_sha256: z.string().regex(/^[a-f0-9]{64}$/i).transform(value => value.toLowerCase()),
  not_after_utc: utc,
}).strict();
export type DeliveryWindow = z.infer<typeof deliveryWindowSchema>;
export class DispatchContextError extends Error {
  constructor(public readonly code: string) { super(code); }
}
const fail = (code: string): never => { throw new DispatchContextError(code); };
const source = {
  source_kind: 'authenticated_codex_caller',
  authorization_basis: 'caller_attestation_of_existing_user_request',
  scope: 'current_delegated_task_only',
  human_identity_verified: false,
  native_approval_granted: false,
} as const;
const submissionSchema = z.object({ taskId: uuid, method: z.enum(['dots_submit', 'dots_followup']), inputRevision: z.number().int().positive(), deliveryWindow: deliveryWindowSchema.optional(), isNewSubmission: z.boolean() }).strict();
const messageSchema = z.object({ taskId: uuid, messageKey: z.string().min(1).max(512), inputRevision: z.number().int().positive(), receivedAt: utc, isNewMessage: z.boolean() }).strict();
const sendSchema = z.object({ request_id: uuid, thread_id: uuid, text: z.string() }).strict();
type Submission = typeof source & { method: 'dots_submit' | 'dots_followup'; input_revision: number; received_at_utc: string };
type Message = typeof source & { message_key: string; input_revision: number; received_at_utc: string };
interface RecordData {
  submission?: Submission; messages: Message[]; delivery_window?: DeliveryWindow;
  // Never exposed: elapsed-time authority is valid only in this running instance.
  epoch?: string; started_monotonic?: number; duration_ms?: number;
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input); if (!parsed.success) return fail('invalid_dispatch_context'); return parsed.data;
}

/** Called by the authenticated caller route inside its task transaction. No task JSON is changed. */
export class CallerDispatchStore {
  private readonly epoch = randomUUID();
  private readonly windowBudgets = new Map<string, { deadline: number; lastMonotonic: number }>();
  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now, private readonly monotonic: () => number = () => performance.now()) {
    db.exec('CREATE TABLE IF NOT EXISTS caller_dispatch_context(task_id TEXT PRIMARY KEY, request_id TEXT UNIQUE, data TEXT NOT NULL)');
  }
  private load(taskId: string): RecordData | undefined {
    const row = this.db.prepare('SELECT data FROM caller_dispatch_context WHERE task_id=?').get(taskId) as { data: string } | undefined;
    if (!row) return undefined;
    try { return JSON.parse(row.data) as RecordData; } catch { return fail('dispatch_record_invalid'); }
  }
  private save(taskId: string, data: RecordData) {
    this.db.prepare('INSERT INTO caller_dispatch_context(task_id,request_id,data) VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET request_id=excluded.request_id,data=excluded.data')
      .run(taskId, data.delivery_window?.request_id ?? null, JSON.stringify(data));
  }
  private clocks() {
    const wall = this.now(), mono = this.monotonic();
    if (!Number.isFinite(wall) || !Number.isFinite(mono) || !Number.isFinite(new Date(wall).getTime())) return fail('dispatch_clock_invalid');
    return { wall, mono };
  }
  recordSubmission(input: z.input<typeof submissionSchema>): void {
    const args = parse(submissionSchema, input);
    this.db.transaction(() => {
      const existing = this.load(args.taskId);
      if (existing?.submission) {
        if (existing.submission.method !== args.method || existing.submission.input_revision !== args.inputRevision || JSON.stringify(existing.delivery_window) !== JSON.stringify(args.deliveryWindow)) fail('dispatch_submission_conflict');
        return;
      }
      if (!args.isNewSubmission) {
        if (args.deliveryWindow) fail('dispatch_submission_conflict');
        return; // Never infer a legacy submission's source or attach a new window on retry.
      }
      if (existing) fail('dispatch_submission_conflict');
      if (args.deliveryWindow) {
        const owner = this.db.prepare('SELECT task_id FROM caller_dispatch_context WHERE request_id=?').get(args.deliveryWindow.request_id);
        if (owner) fail('delivery_window_request_conflict');
      }
      const { wall, mono } = this.clocks();
      const duration = args.deliveryWindow ? Date.parse(args.deliveryWindow.not_after_utc) - wall : undefined;
      if (duration !== undefined && duration <= 0) fail('delivery_window_expired');
      if (duration !== undefined && duration > 300000) fail('delivery_window_too_long');
      this.save(args.taskId, { submission: { ...source, method: args.method, input_revision: args.inputRevision, received_at_utc: new Date(wall).toISOString() }, messages: [],
        ...(args.deliveryWindow ? { delivery_window: args.deliveryWindow, epoch: this.epoch, started_monotonic: mono, duration_ms: duration } : {}) });
    })();
  }
  recordMessage(input: z.input<typeof messageSchema>): void {
    const args = parse(messageSchema, input);
    this.db.transaction(() => {
      const data = this.load(args.taskId) ?? { messages: [] };
      const previous = data.messages.find(message => message.message_key === args.messageKey);
      if (previous) {
        if (previous.input_revision !== args.inputRevision || previous.received_at_utc !== args.receivedAt) fail('dispatch_message_conflict');
        return;
      }
      if (!args.isNewMessage) return;
      data.messages.push({ ...source, message_key: args.messageKey, input_revision: args.inputRevision, received_at_utc: args.receivedAt });
      this.save(args.taskId, data);
    })();
  }
  private windowClock(data: RecordData, wall: number, mono: number) {
    if (!data.delivery_window) return undefined;
    if (data.epoch !== this.epoch) return { not_after_utc: data.delivery_window.not_after_utc, remaining_ms: 0, status: 'interrupted' as const };
    if (!Number.isFinite(data.started_monotonic) || !Number.isFinite(data.duration_ms) || mono < data.started_monotonic!) fail('dispatch_clock_invalid');
    const prior = this.windowBudgets.get(data.delivery_window.request_id);
    if (prior && mono < prior.lastMonotonic) fail('dispatch_clock_invalid');
    // A wall-clock advance may shorten the window, but rollback must never
    // restore that budget or resurrect an already observed expired window.
    const deadline = Math.min(prior?.deadline ?? data.started_monotonic! + data.duration_ms!, mono + Date.parse(data.delivery_window.not_after_utc) - wall);
    this.windowBudgets.set(data.delivery_window.request_id, { deadline, lastMonotonic: mono });
    const remaining = Math.max(0, deadline - mono);
    return { not_after_utc: data.delivery_window.not_after_utc, remaining_ms: remaining, status: remaining > 0 ? 'active' as const : 'expired' as const };
  }
  workerContext(taskId: string, taskDeadline: string) {
    const id = parse(uuid, taskId), deadline = parse(utc, taskDeadline), data = this.load(id);
    const { wall, mono } = this.clocks();
    const window = data ? this.windowClock(data, wall, mono) : undefined;
    return {
      dispatch_context: {
        submission: data?.submission ? { method: data.submission.method, input_revision: data.submission.input_revision, received_at_utc: data.submission.received_at_utc, ...source } : { source_kind: 'legacy_unknown' as const },
        messages: (data?.messages ?? []).map(message => ({ message_key: message.message_key, input_revision: message.input_revision, received_at_utc: message.received_at_utc, ...source })),
        ...(data?.delivery_window ? { delivery_window: { ...data.delivery_window } } : {}),
      },
      server_clock: { time_source: 'bridge_host_clock' as const, server_time_utc: new Date(wall).toISOString(), task_deadline_utc: deadline, remaining_ms: Math.max(0, Date.parse(deadline) - wall), ...(window ? { delivery_window: window } : {}) },
    };
  }
  guardSend(input: { request_id: string; thread_id: string; text: string }): { task_id: string; remaining_ms: number } | undefined {
    const args = parse(sendSchema, input);
    const row = this.db.prepare('SELECT task_id,data FROM caller_dispatch_context WHERE request_id=?').get(args.request_id) as { task_id: string; data: string } | undefined;
    if (!row) return undefined; // Ordinary sends retain their existing access policy.
    const data = this.load(row.task_id)!;
    if (data.delivery_window?.thread_id !== args.thread_id || data.delivery_window.text_sha256 !== createHash('sha256').update(args.text, 'utf8').digest('hex')) fail('delivery_window_input_mismatch');
    const { wall, mono } = this.clocks(), window = this.windowClock(data, wall, mono)!;
    if (window.status === 'interrupted') fail('delivery_window_interrupted');
    if (window.status === 'expired') fail('delivery_window_expired');
    return { task_id: row.task_id, remaining_ms: window.remaining_ms };
  }
}
