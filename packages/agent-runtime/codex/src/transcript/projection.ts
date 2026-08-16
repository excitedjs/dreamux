import type {
  AgentRuntimeTranscriptBlock,
  AgentRuntimeTranscriptTurn,
} from '@excitedjs/dreamux-types';
import { renderTranscriptValue } from '@excitedjs/dreamux-utils';

export interface CodexProjectionRecord {
  value: Record<string, unknown>;
}

export function projectCodexTurn(
  lines: readonly CodexProjectionRecord[],
  includeTools: boolean,
): AgentRuntimeTranscriptTurn {
  const responseBlocks: AgentRuntimeTranscriptBlock[] = [];
  const fallbackMessages: AgentRuntimeTranscriptBlock[] = [];
  const calls = new Map<string, number | null>();
  let startedAt: number | null = null;
  let endedAt: number | null = null;

  for (const line of lines) {
    const timestamp = timestampMs(line.value['timestamp']);
    const marker = eventMarker(line.value);
    if (isStartMarker(marker)) startedAt ??= timestamp;
    if (isCompleteMarker(marker)) endedAt = timestamp ?? endedAt;
    const type = stringValue(line.value['type']);
    const payload = recordValue(line.value['payload']);
    if (type === 'event_msg') {
      const eventType = stringValue(payload?.['type']);
      if (eventType === 'user_message' || eventType === 'agent_message') {
        const text =
          stringValue(payload?.['message']) ??
          stringValue(payload?.['text']);
        if (text !== null) {
          fallbackMessages.push({
            kind: 'message',
            role: eventType === 'user_message' ? 'user' : 'assistant',
            text,
            truncated: false,
          });
        }
      }
      continue;
    }
    if (type !== 'response_item' || payload === null) continue;
    const itemType = stringValue(payload['type']);
    if (itemType === 'message') {
      const role = payload['role'];
      if (role !== 'user' && role !== 'assistant') continue;
      const text = contentText(payload['content']);
      if (text !== '') {
        responseBlocks.push({
          kind: 'message',
          role,
          text,
          truncated: false,
        });
      }
      continue;
    }
    if (itemType === 'function_call' || itemType === 'custom_tool_call') {
      const callId = stringValue(payload['call_id']);
      const name = stringValue(payload['name']);
      if (callId === null || name === null) continue;
      const blockIndex = includeTools ? responseBlocks.length : null;
      calls.set(callId, blockIndex);
      if (includeTools) {
        responseBlocks.push({
          kind: 'tool',
          name,
          input: renderNativeValue(
            itemType === 'function_call'
              ? payload['arguments']
              : payload['input'],
          ),
          output: null,
          status: 'error',
          inputTruncated: false,
          outputTruncated: false,
        });
      }
      continue;
    }
    if (
      itemType === 'function_call_output' ||
      itemType === 'custom_tool_call_output'
    ) {
      const callId = stringValue(payload['call_id']);
      if (callId === null) continue;
      const blockIndex = calls.get(callId);
      if (blockIndex === null || blockIndex === undefined) continue;
      const block = responseBlocks[blockIndex];
      if (block?.kind === 'tool') {
        block.output = renderNativeValue(payload['output']);
        block.status = nativeOutputHasError(payload) ? 'error' : 'ok';
      }
    }
  }

  return {
    startedAt,
    endedAt,
    blocks:
      responseBlocks.length > 0 ? responseBlocks : fallbackMessages,
  };
}

function eventMarker(value: Record<string, unknown>): string | null {
  if (value['type'] !== 'event_msg') return null;
  return stringValue(recordValue(value['payload'])?.['type']);
}

function isStartMarker(value: string | null): boolean {
  return value === 'task_started' || value === 'turn_started';
}

function isCompleteMarker(value: string | null): boolean {
  return value === 'task_complete' || value === 'turn_complete';
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .flatMap((entry) => {
      const item = recordValue(entry);
      const type = stringValue(item?.['type']);
      const text = stringValue(item?.['text']);
      return (
          type === 'input_text' ||
          type === 'output_text' ||
          type === 'text'
        ) &&
        text !== null
        ? [text]
        : [];
    })
    .join('');
}

function renderNativeValue(value: unknown): string | null {
  if (typeof value === 'string') {
    try {
      return renderTranscriptValue(JSON.parse(value));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) {
    const text = value
      .map((entry) => stringValue(recordValue(entry)?.['text']))
      .filter((entry): entry is string => entry !== null)
      .join('');
    if (text !== '') return text;
  }
  return renderTranscriptValue(value);
}

function nativeOutputHasError(value: Record<string, unknown>): boolean {
  if (value['is_error'] === true) return true;
  const status = stringValue(value['status']);
  if (status === 'error' || status === 'failed') return true;
  const output = value['output'];
  return (
    Array.isArray(output) &&
    output.some((entry) => recordValue(entry)?.['is_error'] === true)
  );
}

function timestampMs(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
