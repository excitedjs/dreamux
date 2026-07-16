import type { ChannelTaskSnapshotItem } from '@excitedjs/dreamux-types';

import type { TaskTargetRecord } from './types.js';
import { taskResourceProjection } from './resources.js';

export function taskSnapshotItem(record: TaskTargetRecord): ChannelTaskSnapshotItem {
  const projection = taskResourceProjection(record);
  return {
    receipt: structuredClone(record.receipt),
    container: {
      container_type: record.container.container_type,
      container_key: record.container.container_key,
    },
    phase: record.phase,
    revision: record.revision,
    terminal: structuredClone(record.terminal),
    blocked: record.blocked !== null
      ? {
          code: record.blocked.code,
          retryable: record.blocked.retryable,
        }
      : record.finalizer?.last_error_code === 'TASK_FINALIZER_RETRY_REQUIRED'
        ? { code: 'TASK_FINALIZER_RETRY_REQUIRED', retryable: true }
        : null,
    resources: projection.resources,
    resources_truncated: projection.resourcesTruncated,
    turns_truncated: projection.turnsTruncated,
    updated_at: record.updated_at,
    tombstone: record.tombstone,
  };
}
