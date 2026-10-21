import { z } from 'zod';

const methods = new Set(['server/discover','tools/list','tools/call','events/list','events/subscribe','events/unsubscribe','other']);
const tools = new Set(['list_tasks','get_task','claim_task','checkpoint_task','request_input','complete_task','fail_task','ack_cancel','notify_owner','codex_desktop_echo','codex_desktop_echo_status','codex_read_conversation','codex_send_message','codex_conversation_status','codex_get_context','codex_update_context','codex_forget_context','dots_chat_send','dots_chat_status']);
const stages = new Set(['coverage_started','coverage_stopped','audit_gap','arrived','auth_accepted','auth_rejected','body_rejected','handler_entered','tool_invoked','handler_failed','http_finished','http_aborted']);
const reasons = new Set(['host_rejected','origin_rejected','worker_token_rejected','invalid_json','body_too_large','request_error','handler_error','connection_closed','audit_write_failed']);
export const diagnosticUuid = (value: unknown): value is string => z.string().uuid().safeParse(value).success;
export const diagnosticMethod = (value: unknown) => typeof value === 'string' && methods.has(value) ? value : 'other';
export const diagnosticTool = (value: unknown): value is string => typeof value === 'string' && tools.has(value);
export function workerDiagnosticField(kind: string, key: string, value: unknown) {
  const ingress = kind === 'worker_ingress';
  if (!ingress && kind !== 'worker_protocol_request' && kind !== 'worker_protocol_response') return false;
  return key === 'method' && typeof value === 'string' && methods.has(value)
    || key === 'tool_name' && diagnosticTool(value)
    || ['request_id','task_id'].includes(key) && diagnosticUuid(value)
    || key === 'bridge_version' && typeof value === 'string' && value.length <= 64 && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?$/.test(value)
    || key === 'http_status' && typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    || !ingress && key === 'phase' && (value === 'received' || value === 'responded')
    || ingress && (key === 'ingress_id' && diagnosticUuid(value)
      || key === 'endpoint' && value === 'mcp_dot'
      || key === 'stage' && typeof value === 'string' && stages.has(value)
      || key === 'reason' && typeof value === 'string' && reasons.has(value));
}
