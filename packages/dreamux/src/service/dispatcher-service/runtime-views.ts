import type { AgentRuntime, AgentRuntimeStatus } from '@excitedjs/dreamux-types';

import type { DreamuxConfig } from '../../config/config.js';
import type { DispatcherRow } from '../../state/dispatcher-store.js';
import { runtimeStatusToIdentityStatus } from '../agent-entity/types.js';
import type { AgentEntityIdentityStatus } from '../agent-entity/types.js';
import type { TeammateService } from '../teammate-service/index.js';

export interface DispatcherSummary {
  dispatcher_id: string;
  channel_identity: string;
  status: AgentEntityIdentityStatus;
  thread_id: string | null;
  enabled: boolean;
}

export interface DispatcherRuntimeStatus {
  status: string | null;
  threadId: string | null;
  lastError: string | null;
}

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

export function requiredDispatcherRuntime(
  agent: TeammateService | null,
  dispatcherId: string,
): AgentRuntime {
  const runtime = agent?.getRuntime() ?? null;
  if (runtime === null) {
    throw new Error(`dispatcher '${dispatcherId}' agent runtime is not running`);
  }
  return runtime;
}

export function configuredDispatcherAgentRuntime(
  config: DreamuxConfig,
  dispatcherId: string,
): string {
  const dispatcher = config.dispatchers.find((entry) => entry.id === dispatcherId);
  if (dispatcher === undefined) {
    throw new Error(`dispatcher '${dispatcherId}' has no config entry`);
  }
  return dispatcher.agentRuntime;
}

export function liveDispatcherRuntimeStatus(agent: TeammateService | null): {
  status: AgentRuntimeStatus;
  threadId: string | null;
  lastError: string | null;
} | null {
  const runtime = agent?.getRuntime() ?? null;
  if (runtime === null) return null;
  const identity = agent?.current() ?? null;
  return {
    status: runtime.getStatus(),
    threadId: runtime.getCheckpoint()?.id ?? identity?.session_id ?? null,
    lastError: identity?.last_error ?? null,
  };
}

export type LiveDispatcherRuntimeStatus = ReturnType<
  typeof liveDispatcherRuntimeStatus
>;

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
