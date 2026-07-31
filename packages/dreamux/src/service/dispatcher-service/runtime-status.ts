import type { DispatcherRow } from '../../state/dispatcher-store.js';
import { runtimeStatusToIdentityStatus } from '../agent-entity/types.js';
import type { TeammateService } from '../teammate-service/index.js';
import type {
  DispatcherRuntimeStatus,
  DispatcherSummary,
  LiveDispatcherRuntimeStatus,
} from './types.js';

export function dispatcherRuntimeStatus(
  agent: TeammateService | null,
): DispatcherRuntimeStatus {
  const runtime = agent?.getRuntime() ?? null;
  const identity = agent?.current() ?? null;
  return {
    status: runtime?.getStatus() ?? null,
    threadId: runtime?.getCheckpoint()?.id ?? identity?.session_id ?? null,
    lastError: identity?.last_error ?? null,
  };
}

export function liveDispatcherRuntimeStatus(
  agent: TeammateService | null,
): LiveDispatcherRuntimeStatus | null {
  const runtime = agent?.getRuntime() ?? null;
  if (runtime === null) return null;
  const identity = agent?.current() ?? null;
  return {
    status: runtime.getStatus(),
    threadId: runtime.getCheckpoint()?.id ?? identity?.session_id ?? null,
    lastError: identity?.last_error ?? null,
  };
}

export function dispatcherSummary(
  row: DispatcherRow,
  agent: TeammateService | null,
): DispatcherSummary {
  const runtime = agent?.getRuntime() ?? null;
  const identity = agent?.current() ?? null;
  return {
    dispatcher_id: row.dispatcher_id,
    channel_identity: row.channel_identity,
    status: runtime !== null
      ? runtimeStatusToIdentityStatus(runtime.getStatus())
      : (identity?.status ?? 'stopped'),
    thread_id: runtime?.getCheckpoint()?.id ?? identity?.session_id ?? null,
    enabled: row.enabled === 1,
  };
}
