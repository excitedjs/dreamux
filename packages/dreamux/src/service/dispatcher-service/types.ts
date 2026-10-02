import type { AgentRuntimeStatus } from '@excitedjs/dreamux-types';

export interface DispatcherSummary {
  dispatcher_id: string;
  channel_identity: string;
  status: AgentRuntimeStatus;
  session_id: string | null;
  enabled: boolean;
}

/** One dispatcher's runtime-status projection, live or cold, always speaking `AgentRuntimeStatus`. */
export interface DispatcherRuntimeStatus {
  status: AgentRuntimeStatus;
  sessionId: string | null;
  lastError: string | null;
}
