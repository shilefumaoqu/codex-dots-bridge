import { z } from 'zod';

const methods = new Set(['server/discover','tools/list','tools/call','events/list','events/subscribe','events/unsubscribe','other']);
const tools = new Set(['list_tasks','get_task','claim_task','checkpoint_task','request_input','complete_task','fail_task','ack_cancel','notify_owner','codex_desktop_echo','codex_desktop_echo_status','codex_read_conversation','codex_send_message','codex_conversation_status','codex_get_context','codex_update_context','codex_forget_context','dots_chat_send','dots_chat_status']);
const stages = new Set(['coverage_started','coverage_stopped','audit_gap','arrived','auth_accepted','auth_rejected','body_rejected','handler_entered','tool_invoked','tool_finished','handler_failed','http_finished','http_aborted']);
const reasons = new Set(['host_rejected','origin_rejected','worker_token_rejected','invalid_json','body_too_large','request_error','handler_error','connection_closed','audit_write_failed']);
const taskTools = new Set(['list_tasks','get_task','claim_task','checkpoint_task','request_input','complete_task','fail_task','ack_cancel']);
// Literal task-store/caller-dispatch error codes only; never accept arbitrary exception codes.
const taskErrors = new Set([
  'invalid_json','invalid_argument','invalid_deadline','invalid_links','invalid_link','invalid_result',
  'reply_subscription_unavailable','task_not_found','idempotency_conflict','invalid_claim_token','chat_route_unavailable','parent_not_completed',
  'invalid_limit','not_queued','execution_slot_occupied','not_queue_head','task_not_editable','question_not_found','answer_conflict','old_question','question_id_required',
  'attempt_not_current','invalid_revision','invalid_options','platform_action_url_required','not_running','task_terminal','cancel_already_requested',
  'cancellation_not_pending','result_not_found','result_not_read','acceptance_conflict','resolution_not_required','cancellation_pending','deadline_expired','invalid_resolution','another_subscription_active',
  'delivery_attempt_changed','delivery_task_not_running','delivery_input_not_acknowledged','invalid_dispatch_context','dispatch_record_invalid','dispatch_clock_invalid',
  'dispatch_submission_conflict','delivery_window_request_conflict','delivery_window_expired','delivery_window_too_long','dispatch_message_conflict','delivery_window_input_mismatch','delivery_window_interrupted',
  'invalid_parameters','unclassified_tool_error',
]);
export type TaskToolOutcome = { outcome: 'returned' } | { outcome: 'error'; error_code: string };
export type TaskToolFinish = (outcome: TaskToolOutcome) => void;
export const diagnosticTaskTool = (value: unknown): value is string => typeof value === 'string' && taskTools.has(value);
export const diagnosticTaskError = (value: unknown): string => typeof value === 'string' && taskErrors.has(value) ? value : 'unclassified_tool_error';
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
      || key === 'outcome' && (value === 'returned' || value === 'error')
      || key === 'error_code' && typeof value === 'string' && taskErrors.has(value)
      || key === 'reason' && typeof value === 'string' && reasons.has(value));
}
