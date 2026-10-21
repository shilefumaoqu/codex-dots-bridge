import { createHash } from 'node:crypto';
import type { ContextGap, ContextPublicItem } from './context-reader-types.js';

export const contentHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const textContent = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value)
  ? value.filter(part => object(part) && ['text', 'inputText', 'input_text'].includes(part.type) && typeof part.text === 'string').map(part => part.text).join('\n') : '';

/** No spreads of native objects: unknown fields, reasoning and model metadata never escape. */
export function projectPublicItem(threadId: string, turnId: string, item: Record<string, any>, gaps: ContextGap[]): ContextPublicItem | undefined {
  let text: string;
  switch (item.type) {
    case 'userMessage':
      text = textContent(item.content);
      if (Array.isArray(item.content) && item.content.some(part => !object(part) || part.type !== 'text')) gaps.push({ code: 'attachment_body_unavailable', turnId, itemId: item.id });
      break;
    case 'agentMessage': case 'plan': text = typeof item.text === 'string' ? item.text : ''; break;
    case 'functionCallOutput': text = textContent(item.output); break;
    case 'commandExecution':
      text = `${typeof item.exitCode === 'number' ? `exitCode=${item.exitCode}\n` : ''}${typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : ''}`;
      break;
    case 'fileChange':
      text = Array.isArray(item.changes) ? item.changes.filter(object).map(change => `${typeof change.path === 'string' ? change.path : ''}\n${typeof change.diff === 'string' ? change.diff : ''}`).join('\n') : '';
      break;
    case 'mcpToolCall':
      text = object(item.result) ? textContent(item.result.content) : '';
      if (object(item.result) && item.result.structuredContent != null) gaps.push({ code: 'structured_tool_body_not_projected', turnId, itemId: item.id });
      break;
    case 'dynamicToolCall': text = textContent(item.contentItems); break;
    case 'enteredReviewMode': case 'exitedReviewMode': text = typeof item.review === 'string' ? item.review : ''; break;
    case 'contextCompaction': gaps.push({ code: 'compaction_body_unavailable', turnId, itemId: item.id }); return undefined;
    case 'imageView': case 'imageGeneration': gaps.push({ code: 'attachment_body_unavailable', turnId, itemId: item.id }); return undefined;
    default: return undefined;
  }
  const toolContent = item.type === 'functionCallOutput' ? item.output : item.type === 'dynamicToolCall' ? item.contentItems : item.type === 'mcpToolCall' && object(item.result) ? item.result.content : undefined;
  if (Array.isArray(toolContent) && toolContent.some(part => !object(part) || !['text', 'input_text', 'inputText'].includes(part.type))) gaps.push({ code: 'attachment_body_unavailable', turnId, itemId: item.id });
  const status = typeof item.status === 'string' ? item.status : undefined;
  const fingerprint = contentHash({ type: item.type, text, ...(status ? { status } : {}) });
  return { id: item.id, type: item.type, text, fingerprint, source_ref: `${threadId}/${turnId}/${item.id}/${fingerprint}`,
    ...(status ? { status } : {}), truncated: false, textOffset: 0, totalTextLength: text.length };
}

/** UTF-16 offsets match existing Bridge delivery conventions; don't split surrogate pairs. */
export function publicItemSlice(item: ContextPublicItem, offset: number, chars: number): ContextPublicItem {
  let start = Math.min(offset, item.text.length), end = Math.min(item.text.length, start + chars);
  if (start > 0 && /[\uDC00-\uDFFF]/.test(item.text[start]!)) start--;
  if (end > start && /[\uD800-\uDBFF]/.test(item.text[end - 1]!)) end--;
  return { ...item, text: item.text.slice(start, end), textOffset: start, truncated: start > 0 || end < item.text.length };
}
