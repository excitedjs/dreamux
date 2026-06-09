import type {
  AgentRuntimeCapabilities,
  AgentRuntimeContextSnapshot,
  AgentRuntimeLastResult,
  AgentRuntimeResumeCheckpoint,
} from '../../agent-runtime/index.js';
import type { DispatcherStatus } from '../../state/dispatcher-store.js';

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
  owner: TeamMateOwner;
  /**
   * The `agents[].id` this teammate runs (persisted so resume re-resolves the
   * runtime config from `DreamuxConfig.agents`). Replaces the former
   * `provider_ref`: a teammate references an agent, not a provider directly.
   */
  agent_runtime: string;
  /**
   * The caller-supplied workspace cwd. `cwd` remains the runtime cwd for
   * compatibility with pre-#169 clients and equals either this value
   * (`reuse-cwd`) or the prepared managed worktree path.
   */
  source_cwd: string;
  source_repo: string | null;
  cwd: string;
  runtime_cwd: string;
  worktree: TeamMateWorktreeIdentity;
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
  // Legacy event, no longer written (the `resume` verb was removed in #155;
  // send now subsumes it). Retained so pre-#155 history files still parse.
  | 'resume'
  | 'close'
  | 'state';

export interface TeamMateHistoryEvent {
  version: 1;
  event_id: number;
  timestamp: number;
  dispatcher_id: string;
  name: string;
  owner: TeamMateOwner;
  type: TeamMateHistoryEventType;
  agent_runtime: string;
  source_cwd: string;
  source_repo: string | null;
  cwd: string;
  runtime_cwd: string;
  worktree: TeamMateWorktreeIdentity;
  checkpoint: AgentRuntimeResumeCheckpoint | null;
  prompt_preview: string | null;
  turn_id: string | null;
  status: TeamMateIdentityStatus;
  note: string | null;
}

export interface TeamMateRuntimeStatus {
  name: string;
  owner: TeamMateOwner;
  agent_runtime: string;
  source_cwd: string;
  source_repo: string | null;
  cwd: string;
  runtime_cwd: string;
  worktree: TeamMateWorktreeIdentity;
  status: TeamMateIdentityStatus;
  runtime_status: DispatcherStatus | null;
  checkpoint: AgentRuntimeResumeCheckpoint | null;
  last_error: string | null;
  closed_at: number | null;
  close_note: string | null;
}

export interface TeamMateOwner {
  kind: 'dispatcher';
  dispatcher_id: string;
}

export interface SpawnTeamMateInput {
  dispatcherId: string;
  name: string;
  prompt: string;
  /**
   * The `agents[].id` this teammate runs. Resolved against the global agents
   * map (`DreamuxConfig.agents`) into a `{ provider, config }` runtime. Omitted
   * falls back to the dispatcher's own `agentRuntime` id. A teammate may name a
   * different agent than its dispatcher (e.g. a claude teammate under a codex
   * dispatcher) — its config comes from that agent, never inherited.
   */
  agentRuntime?: string;
  cwd: string;
  worktree?: TeamMateWorktreeRequest;
  intent?: string;
}

export interface TeamMateWorktreeRequest {
  mode: 'reuse-cwd' | 'managed';
  slug?: string;
  base_ref?: string;
  branch?: string;
  cleanup?: 'keep' | 'delete-on-close';
}

export type TeamMateWorktreeCleanupPolicy = 'keep' | 'delete-on-close';

export type TeamMateWorktreeCleanupState =
  | 'not-managed'
  | 'managed-active'
  | 'kept'
  | 'deleted'
  | 'retained-dirty'
  | 'retained-unmerged'
  | 'retained-unique-commits'
  | 'retained-error';

export interface TeamMateWorktreeIdentity {
  mode: 'reuse-cwd' | 'managed';
  slug: string | null;
  path: string;
  branch: string | null;
  base_ref: string | null;
  cleanup: TeamMateWorktreeCleanupPolicy;
  cleanup_state: TeamMateWorktreeCleanupState;
  cleanup_error: string | null;
}

export interface SendTeamMateInput {
  dispatcherId: string;
  name: string;
  prompt: string;
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

export interface TeamMateAgentRuntimeCapability {
  /** The spawnable `agents[].id`; pass this as `spawn.agent_runtime`. */
  id: string;
  /** Copyable argument fragment for `spawn({ agent_runtime: id, ... })`. */
  spawn: { agent_runtime: string };
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
  agent_runtimes: TeamMateAgentRuntimeCapability[];
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
