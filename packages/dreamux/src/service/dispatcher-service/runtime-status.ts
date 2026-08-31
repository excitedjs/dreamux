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
  const runtimeStatus = agent?.runtimeStatus() ?? null;
  const identity = agent?.current() ?? null;
  return {
    status: runtimeStatus,
    sessionId: agent?.sessionId() ?? identity?.session?.id ?? null,
    lastError: identity?.last_error ?? null,
  };
}

export function liveDispatcherRuntimeStatus(
  agent: TeammateService | null,
): LiveDispatcherRuntimeStatus | null {
  const runtimeStatus = agent?.runtimeStatus() ?? null;
  if (runtimeStatus === null) return null;
  const identity = agent?.current() ?? null;
  return {
    status: runtimeStatus,
    sessionId: agent?.sessionId() ?? identity?.session?.id ?? null,
    lastError: identity?.last_error ?? null,
  };
}

export function dispatcherSummary(
  row: DispatcherRow,
  agent: TeammateService | null,
): DispatcherSummary {
  const runtimeStatus = agent?.runtimeStatus() ?? null;
  const identity = agent?.current() ?? null;
  return {
    dispatcher_id: row.dispatcher_id,
    channel_identity: row.channel_identity,
    status: runtimeStatus !== null
      ? runtimeStatusToIdentityStatus(runtimeStatus)
      : (identity?.status ?? 'stopped'),
    session_id: agent?.sessionId() ?? identity?.session?.id ?? null,
    enabled: row.enabled === 1,
  };
}
