import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const DESKTOP_WARM_LOAD_REASONS = ['native_desktop_offline', 'native_window_ambiguous', 'native_autoload_unavailable', 'native_navigation_unconfirmed', 'native_owner_unavailable_after_load'] as const;
export type DesktopWarmLoadResult = { status: 'accepted' } | { status: 'skipped_unknown' | 'skipped_unreachable'; reason: typeof DESKTOP_WARM_LOAD_REASONS[number] };
export interface DesktopWarmLoadInput { threadId: string; signal: AbortSignal; deadline: number }
export interface DesktopWarmLoadTesting { platform?: NodeJS.Platform; spawn?: typeof spawn }
const receiptSchema = z.object({
  schema: z.literal('native-window-autoload/v1'), mode: z.literal('Navigate'),
  status: z.enum(['not_sent', 'offline', 'ambiguous', 'protocol_accepted', 'navigation_unconfirmed']),
  reason: z.string().max(64), message_attempted: z.boolean(),
  navigation_state: z.enum(['not_attempted', 'possibly_navigated']), target_ready_verified: z.literal(false),
  pid: z.number().int().nonnegative(), window_match_count: z.number().int().nonnegative(),
  win32_error: z.number().int().nullable(), receiver_ack: z.boolean().nullable(), requires_target_owner_verification: z.literal(true),
}).strict();
const unavailable = (): DesktopWarmLoadResult => ({ status: 'skipped_unknown', reason: 'native_autoload_unavailable' });

/** One warm deep-link delivery to an existing desktop only. Never launches Codex.
 * A receiver ACK requires fresh target/owner/idle validation by the caller. */
export async function warmLoadDesktopThread(input: DesktopWarmLoadInput, testing?: DesktopWarmLoadTesting): Promise<DesktopWarmLoadResult> {
  if (!z.string().uuid().safeParse(input.threadId).success || input.threadId === '00000000-0000-0000-0000-000000000000' || !Number.isFinite(input.deadline) || input.signal.aborted || Date.now() >= input.deadline || (testing?.platform ?? process.platform) !== 'win32') return unavailable();
  const script = fileURLToPath(new URL('../scripts/desktop-warm-load.ps1', import.meta.url));
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn> | undefined, timer: NodeJS.Timeout | undefined, finished = false, output = '';
    const finish = (result: DesktopWarmLoadResult, terminate = false) => {
      if (finished) return; finished = true; if (timer) clearTimeout(timer); input.signal.removeEventListener('abort', abort);
      if (terminate) child?.kill(); resolve(result);
    };
    // On cancellation/timeout navigation may have happened. Never retry it.
    const abort = () => finish({ status: 'skipped_unknown', reason: 'native_navigation_unconfirmed' }, true);
    try {
      child = (testing?.spawn ?? spawn)(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-AutoDiscover', '-Mode', 'Navigate', '-ThreadId', input.threadId.toLowerCase()], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      child.on('error', () => finish(unavailable()));
      child.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8'); if (output.length > 8192) abort();
      });
      child.on('close', code => {
        if (finished) return;
        let receipt: z.infer<typeof receiptSchema>;
        try { receipt = receiptSchema.parse(JSON.parse(output.replace(/^\uFEFF/, '').trim())); } catch { finish(unavailable()); return; }
        if (code !== 0) { finish(unavailable()); return; }
        if (receipt.status === 'protocol_accepted' && receipt.message_attempted && receipt.navigation_state === 'possibly_navigated' && receipt.receiver_ack === true && receipt.window_match_count === 1 && receipt.pid > 0 && receipt.reason === 'receiver_accepted') finish({ status: 'accepted' });
        else if (receipt.status === 'offline' && !receipt.message_attempted && receipt.reason === 'offline') finish({ status: 'skipped_unreachable', reason: 'native_desktop_offline' });
        else if (receipt.status === 'ambiguous' && !receipt.message_attempted && receipt.reason === 'endpoint_ambiguous') finish({ status: 'skipped_unknown', reason: 'native_window_ambiguous' });
        else if (receipt.message_attempted) finish({ status: 'skipped_unknown', reason: 'native_navigation_unconfirmed' });
        else finish(unavailable());
      });
      input.signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(abort, Math.max(1, Math.min(8000, input.deadline - Date.now())));
      if (input.signal.aborted || Date.now() >= input.deadline) abort();
    } catch { finish(unavailable(), true); }
  });
}
