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

export type TeamMateRole = 'teammate' | 'team_leader' | 'team_member';

export interface TeamMateIdentity {
  version: 1;
  dispatcher_id: string;
  name: string;
  owner: TeamMateOwner;
  role: TeamMateRole;
  team_id: string | null;
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
  intent: string | null;
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
  role: TeamMateRole;
  team_id: string | null;
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
  role: TeamMateRole;
  team_id: string | null;
  agent_runtime: string;
  source_cwd: string;
  source_repo: string | null;
  cwd: string;
  runtime_cwd: string;
  worktree: TeamMateWorktreeIdentity;
  intent: string | null;
  status: TeamMateIdentityStatus;
  runtime_status: DispatcherStatus | null;
  checkpoint: AgentRuntimeResumeCheckpoint | null;
  last_error: string | null;
  closed_at: number | null;
  close_note: string | null;
}

export type TeamMateOwner =
  | {
      kind: 'dispatcher';
      dispatcher_id: string;
    }
  | {
      kind: 'team';
      dispatcher_id: string;
      team_id: string;
      leader_name: string;
    };

export type TeamMateCallerPrincipal =
  | {
      kind: 'dispatcher';
      dispatcherId: string;
    }
  | {
      kind: 'team_leader';
      dispatcherId: string;
      teamId: string;
      leaderName: string;
    }
  | {
      kind: 'teammate';
      dispatcherId: string;
    };

export interface TeamMateDispatcherOwner {
  kind: 'dispatcher';
  dispatcher_id: string;
}

/**
 * Where a teammate turn was submitted from, recorded per turn id at submit
 * time and resolved again when the turn settles. This is what decides where
 * the completion is delivered: a `channel` turn on a TeamLeader stays
 * pull-only (team ledger), while a `dispatcher`-initiated turn returns to the
 * dispatcher runtime as a completion. A settle whose turn id was never
 * recorded (e.g. submitted before a server restart) resolves to `null` and
 * the facade picks the safe default for the role.
 */
export type TeamMateTurnOrigin = 'channel' | 'dispatcher' | 'team_leader';

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

export interface CreateTeamLeaderInput {
  dispatcherId: string;
  teamId: string;
  name: string;
  prompt: string;
  agentRuntime: string;
  sourceCwd: string;
  sourceRepo: string | null;
  runtimeCwd: string;
  worktree: TeamMateWorktreeIdentity;
  intent?: string | null;
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

export interface TeamMateHistoryQuery {
  dispatcherId: string;
  principal?: TeamMateCallerPrincipal;
  id?: string;
  name?: string;
  agentRuntime?: string;
  state?: TeamMateIdentityStatus | 'active';
  closeStatus?: 'open' | 'closed';
  sourceCwd?: string;
  runtimeCwd?: string;
  grep?: string;
  limit?: number;
  cursor?: string;
}

export interface TeamMateLedgerResumeHint {
  tool: 'send';
  name: string;
  checkpoint: AgentRuntimeResumeCheckpoint | null;
}

export interface TeamMateLedgerRow {
  id: string;
  name: string;
  team_id: string | null;
  role: TeamMateRole;
  owner: TeamMateOwner;
  agent_runtime: string;
  source_cwd: string;
  source_repo: string | null;
  cwd: string;
  runtime_cwd: string;
  worktree: TeamMateWorktreeIdentity;
  created_at: number;
  updated_at: number;
  last_seen_at: number;
  state: TeamMateIdentityStatus;
  status: TeamMateIdentityStatus;
  runtime_status: DispatcherStatus | null;
  checkpoint: AgentRuntimeResumeCheckpoint | null;
  intent: string | null;
  close_status: 'open' | 'closed';
  closed_at: number | null;
  close_note: string | null;
  close_note_preview: string | null;
  last_prompt_preview: string | null;
  last_assistant_preview: string | null;
  cleanup_state: TeamMateWorktreeCleanupState;
  resume: TeamMateLedgerResumeHint | null;
}

export interface TeamMateHistoryResult {
  items: TeamMateLedgerRow[];
  next_cursor: string | null;
}

export interface TeamMateHistoryEventsResult {
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

export function dispatcherPrincipal(dispatcherId: string): TeamMateCallerPrincipal {
  return { kind: 'dispatcher', dispatcherId };
}

export function teamLeaderPrincipal(input: {
  dispatcherId: string;
  teamId: string;
  leaderName: string;
}): TeamMateCallerPrincipal {
  return {
    kind: 'team_leader',
    dispatcherId: input.dispatcherId,
    teamId: input.teamId,
    leaderName: input.leaderName,
  };
}

export function teammatePrincipal(dispatcherId: string): TeamMateCallerPrincipal {
  return { kind: 'teammate', dispatcherId };
}

export function principalDispatcherId(principal: TeamMateCallerPrincipal): string {
  return principal.dispatcherId;
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
