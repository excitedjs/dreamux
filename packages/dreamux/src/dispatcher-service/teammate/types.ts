import type {
  AgentRuntimeCapabilities,
  AgentRuntimeContextSnapshot,
  AgentRuntimeLastResult,
  AgentRuntimeResumeCheckpoint,
} from '../../agent-runtime/index.js';
import type { DispatcherStatus } from '../../runtime/dispatcher-store.js';

export const TEAMMATE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type TeamMateIdentityStatus =
  | 'starting'
  | 'running'
  | 'degraded'
  | 'closed'
  | 'stopped';

export interface TeamMateIdentity {
  version: 1;
  dispatcher_id: string;
  name: string;
  provider_ref: string;
  cwd: string;
  created_at: number;
  updated_at: number;
  status: TeamMateIdentityStatus;
  checkpoint: AgentRuntimeResumeCheckpoint | null;
  last_error: string | null;
  closed_at: number | null;
  close_note: string | null;
}

export type TeamMateHistoryEventType =
  | 'spawn'
  | 'send'
  | 'resume'
  | 'close'
  | 'state';

export interface TeamMateHistoryEvent {
  version: 1;
  event_id: number;
  timestamp: number;
  dispatcher_id: string;
  name: string;
  type: TeamMateHistoryEventType;
  provider_ref: string;
  cwd: string;
  checkpoint: AgentRuntimeResumeCheckpoint | null;
  prompt_preview: string | null;
  turn_id: string | null;
  status: TeamMateIdentityStatus;
  note: string | null;
}

export interface TeamMateRuntimeStatus {
  name: string;
  provider_ref: string;
  cwd: string;
  status: TeamMateIdentityStatus;
  runtime_status: DispatcherStatus | null;
  checkpoint: AgentRuntimeResumeCheckpoint | null;
  last_error: string | null;
  closed_at: number | null;
  close_note: string | null;
}

export interface SpawnTeamMateInput {
  dispatcherId: string;
  name: string;
  prompt: string;
  providerRef?: string;
  cwd?: string;
}

export interface SendTeamMateInput {
  dispatcherId: string;
  name: string;
  prompt: string;
}

export interface ResumeTeamMateInput {
  dispatcherId: string;
  name: string;
  prompt?: string;
}

export interface CloseTeamMateInput {
  dispatcherId: string;
  name: string;
  note?: string;
}

export interface TeamMateTurnResult {
  status: 'submitted' | 'duplicate' | 'stopped' | 'failed';
  turn_id?: string;
  error?: string;
}

export interface TeamMateSpawnResult {
  teammate: TeamMateRuntimeStatus;
  turn: TeamMateTurnResult;
}

export interface TeamMateSendResult {
  teammate: TeamMateRuntimeStatus;
  turn: TeamMateTurnResult;
}

export interface TeamMateResumeResult {
  teammate: TeamMateRuntimeStatus;
  turn?: TeamMateTurnResult;
}

export interface TeamMateCloseResult {
  teammate: TeamMateRuntimeStatus;
}

export interface TeamMateHistoryResult {
  teammate: TeamMateRuntimeStatus | null;
  events: TeamMateHistoryEvent[];
}

export interface TeamMateLastResult {
  teammate: TeamMateRuntimeStatus;
  last: AgentRuntimeLastResult | null;
}

export interface TeamMateContextResult {
  teammate: TeamMateRuntimeStatus;
  context: AgentRuntimeContextSnapshot | null;
}

export interface TeamMateProviderCapability {
  provider_ref: string;
  runtime_available: boolean;
  resume: AgentRuntimeCapabilities['resume'];
  steer: AgentRuntimeCapabilities['steer'];
  events: AgentRuntimeCapabilities['events'];
  last: AgentRuntimeCapabilities['last'];
  context: AgentRuntimeCapabilities['context'];
  unsupported_reason: string | null;
}

export interface TeamMateCapabilities {
  verbs: string[];
  providers: TeamMateProviderCapability[];
}

export function validateTeamMateName(name: string): string {
  if (!TEAMMATE_NAME_PATTERN.test(name)) {
    throw new Error(
      'TeamMate name must be 1-64 ASCII letters, digits, dots, underscores, ' +
        `or dashes, starting with a letter or digit: ${name}`,
    );
  }
  return name;
}

export function runtimeStatusToIdentityStatus(
  status: DispatcherStatus,
): TeamMateIdentityStatus {
  switch (status) {
    case 'ready':
      return 'running';
    case 'starting':
      return 'starting';
    case 'degraded':
      return 'degraded';
    case 'stopping':
    case 'stopped':
      return 'stopped';
    case 'declared':
      return 'stopped';
  }
}
