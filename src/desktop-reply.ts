import { isAbsolute } from 'node:path';
import { z } from 'zod';

/** Private durable evidence captured before the only send. Never accepted from MCP input. */
export const replyBindingSchema = z.object({
  version: z.literal(1),
  path: z.string().refine(path => isAbsolute(path) && !path.includes('\0')),
  thread_id: z.string().uuid(),
  device: z.number().int().nonnegative(), inode: z.number().int().nonnegative(),
  birthtime_ms: z.number().finite().nonnegative(),
  offset: z.number().int().nonnegative(), sent_at_ms: z.number().finite().nonnegative(),
}).strict();
export type DesktopReplyBinding = z.infer<typeof replyBindingSchema>;
export interface DesktopReplyInput {
  binding: DesktopReplyBinding; turnId: string; signal: AbortSignal; deadline: number;
}
export type DesktopReplyResult =
  | { status: 'completed'; turn_id: string; reply: string }
  | { status: 'pending'; next_offset: number }
  | { status: 'unavailable'; reason: string };
