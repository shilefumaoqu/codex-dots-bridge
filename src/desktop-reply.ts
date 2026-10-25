import { isAbsolute } from 'node:path';
import { z } from 'zod';

/** Private durable evidence captured before the only send. Never accepted from MCP input. */
const common = {
  path: z.string().refine(path => isAbsolute(path) && !path.includes('\0')),
  thread_id: z.string().uuid(),
  offset: z.number().int().nonnegative(), sent_at_ms: z.number().finite().nonnegative(),
};
const exactInteger = z.string().regex(/^(0|[1-9][0-9]{0,29})$/);
export const replyBindingSchema = z.discriminatedUnion('version', [
  z.object({ ...common, version: z.literal(1), device: z.number().int().nonnegative(),
    inode: z.number().int().nonnegative(), birthtime_ms: z.number().finite().nonnegative() }).strict(),
  // NTFS file IDs can exceed Number.MAX_SAFE_INTEGER. JSON decimal strings
  // preserve every bit and distinguish adjacent IDs after service restart.
  z.object({ ...common, version: z.literal(2), device: exactInteger, inode: exactInteger,
    birthtime_ns: exactInteger }).strict(),
]);
export type DesktopReplyBinding = z.infer<typeof replyBindingSchema>;
export interface DesktopReplyInput {
  binding: DesktopReplyBinding; turnId: string; signal: AbortSignal; deadline: number;
}
export type DesktopReplyResult =
  | { status: 'completed'; turn_id: string; reply: string }
  | { status: 'pending'; next_offset: number }
  | { status: 'unavailable'; reason: string };
