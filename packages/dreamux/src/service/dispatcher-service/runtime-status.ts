import type { DispatcherRow } from '../../state/dispatcher-store.js';
import { runtimeStatusToIdentityStatus } from '../agent/identity.js';
import type { AgentService } from '../agent/service.js';
import type {
  DispatcherRuntimeStatus,
  DispatcherSummary,
  LiveDispatcherRuntimeStatus,
} from './types.js';

export function dispatcherRuntimeStatus(
  agent: AgentService | null,
): DispatcherRuntimeStatus {
  const runtimeStatus = agent?.runtimeStatus() ?? null;
  const identity = agent?.current() ?? null;
  return {
    status: runtimeStatus,
    sessionId: agent?.sessionId() ?? identity?.session_id ?? null,
    lastError: identity?.last_error ?? null,
  };
}

export function liveDispatcherRuntimeStatus(
  agent: AgentService | null,
): LiveDispatcherRuntimeStatus | null {
  const runtimeStatus = agent?.runtimeStatus() ?? null;
  if (runtimeStatus === null) return null;
  const identity = agent?.current() ?? null;
  return {
    status: runtimeStatus,
    sessionId: agent?.sessionId() ?? identity?.session_id ?? null,
    lastError: identity?.last_error ?? null,
  };
}

export function dispatcherSummary(
  row: DispatcherRow,
  agent: AgentService | null,
): DispatcherSummary {
  const runtimeStatus = agent?.runtimeStatus() ?? null;
  const identity = agent?.current() ?? null;
  return {
    dispatcher_id: row.dispatcher_id,
    channel_identity: row.channel_identity,
    status:
      runtimeStatus !== null
        ? runtimeStatusToIdentityStatus(runtimeStatus)
        : (identity?.status ?? 'stopped'),
    session_id: agent?.sessionId() ?? identity?.session_id ?? null,
    enabled: row.enabled === 1,
  };
}
