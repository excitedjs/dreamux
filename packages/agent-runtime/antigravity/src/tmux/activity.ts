import type {
  AgentRuntimeEventSink,
  JsonValue,
} from '@excitedjs/dreamux-types';

import type { NativeRecord } from '../transcript/records.js';

/** Project only activities with identity supplied by the transcript. */
export function reportActivity(
  events: AgentRuntimeEventSink,
  record: NativeRecord,
): void {
  const occurredAt = record.occurredAt ?? Date.now();
  if (record.type === 'PLANNER_RESPONSE') {
    if (record.id && record.content) {
      events({
        kind: 'assistant.message',
        id: record.id,
        occurredAt,
        text: record.content,
      });
    }
    if (record.id && record.thinking) {
      events({
        kind: 'assistant.reasoning',
        id: record.id,
        occurredAt,
        partIndex: 0,
        text: record.thinking,
        status: 'completed',
      });
    }
    for (const call of record.toolCalls) {
      if (!call.id) continue;
      events({
        kind: 'tool.call',
        id: call.id,
        occurredAt,
        status: 'started',
        toolName: call.name,
        action: null,
        summary: null,
        invocation: null,
        items: [],
        arguments: (call.args ?? null) as JsonValue,
        result: null,
        error: null,
      });
    }
  } else if (
    record.type === 'CONTEXT_COMPACTION' &&
    record.id &&
    record.status === 'DONE'
  ) {
    events({ kind: 'context.compacted', id: record.id, occurredAt });
  }
}
