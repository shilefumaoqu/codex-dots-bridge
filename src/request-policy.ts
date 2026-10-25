import { ProbeError } from './store.js';

export const BUSINESS_ARGUMENT_BYTES = 1024 * 1024;
export const PROTOCOL_ENVELOPE_BYTES = 2 * 1024 * 1024;

/** Count the actual UTF-8 wire representation, including JSON escaping. */
export function boundedArguments<T>(args: T): T {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(args); } catch { throw new ProbeError('invalid_parameters'); }
  if (encoded === undefined) throw new ProbeError('invalid_parameters');
  if (Buffer.byteLength(encoded, 'utf8') > BUSINESS_ARGUMENT_BYTES) throw new ProbeError('arguments_too_large');
  return args;
}

export function requestFailure(error: unknown, fallbackCode: string) {
  const nativeCode = (error as {code?: unknown})?.code;
  if (nativeCode === 'FST_ERR_CTP_BODY_TOO_LARGE' || fallbackCode === 'arguments_too_large')
    return {status: 413, body: {error: 'arguments_too_large', category: 'capacity', retryable: false}};
  if (nativeCode === 'FST_ERR_CTP_INVALID_JSON_BODY' || ['invalid_parameters','invalid_argument','invalid_response_mode'].includes(fallbackCode))
    return {status: 400, body: {error: nativeCode === 'FST_ERR_CTP_INVALID_JSON_BODY' ? 'invalid_parameters' : fallbackCode, category: 'validation', retryable: false}};
  if (['thread_send_in_progress', 'conversation_send_busy', 'context_read_capacity', 'read_capacity_exceeded', 'history_read_capacity'].includes(fallbackCode))
    return {status: 409, body: {error: fallbackCode, category: 'capacity', retryable: true, accepted: false}};
  if (['local_service_unreachable','local_service_failed','service_not_started','service_not_running','tray_status_unavailable','context_service_closed','storage_maintenance_required'].includes(fallbackCode))
    return {status: 503, body: {error: fallbackCode, category: 'availability', retryable: true}};
  if (fallbackCode !== 'bridge_operation_failed')
    return {status: 409, body: {error: fallbackCode, category: 'state', retryable: false}};
  return {status: 500, body: {error: fallbackCode, category: 'internal', retryable: false}};
}
