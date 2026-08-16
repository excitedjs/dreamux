import {
  assertNotReservedAgentName,
  type AgentEntityIdentity,
  type AgentEntityIdentityStatus,
  type AgentEntityRuntimeStatus,
  type AgentEntitySubmissionResult,
  type AgentEntityWorktreeIdentity,
} from '../agent-entity/types.js';
import type {
  AgentRuntimeMcpServer,
  AgentRuntimeSkillSource,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { DreamuxConfig } from '../../config/config.js';
import type { AgentIdentityStore } from '../agent-entity/identity-store.js';
import type { AgentTurnsStore } from '../agent-entity/turns-store.js';
import type { DispatcherCoreEventPublisher } from '../dispatcher-core-events/index.js';
import type {
  CompletionDeliveryPolicy,
  CompletionInitiator,
} from '../completion-router/index.js';
import type { SuffixGenerator } from '../name-allocator.js';
import type { TeamMateWorktreeRequest } from '../teammate-collection/types.js';
import type { WorktreeManager } from '../worktree/manager.js';

export interface TeamCollectionOptions {
  /** The dispatcher this collection belongs to (issue #233 ownership sinking). */
  dispatcherId: string;
  config: DreamuxConfig;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  worktrees: WorktreeManager;
  /**
   * The dispatcher's identity + turns store pair (issue #233 R4). Supplied by
   * `DispatcherService` (the same pair the dispatcher agent + dispatcher-scope
   * collection share) and forwarded into every per-team collection so no team
   * news its own. Read-path probes (`leaderState` / `memberCount`) read the
   * identity store directly, never a throwaway collection. The stores are
   * stateless (paths by role + team_id), so one pair safely serves all scopes.
   */
  identities: AgentIdentityStore;
  turnsStore: AgentTurnsStore;
  // Shared per-dispatcher deps `DispatcherService` always supplies; forwarded
  // unchanged into each team's own collection so it stays topology-free (#233).
  completionDelivery: CompletionDeliveryPolicy;
  initiatorFor: (
    producer: AgentEntityIdentity,
  ) => Promise<CompletionInitiator | null>;
  isShuttingDown: () => boolean;
  admitOperation?: <T>(task: () => Promise<T>) => Promise<T>;
  trackAcceptedOperation?: <T>(task: () => Promise<T>) => Promise<T>;
  adminSocketPath: string;
  /**
   * Build a team_leader's channel-egress MCP descriptors from the dispatcher's
   * live channels. Channels are dispatcher-owned, so the team layer only asks
   * for its own leader's set — it never reaches into the channel layer itself.
   */
  leaderChannelDescriptors: (input: {
    teamId: string;
    leaderName: string;
  }) => readonly AgentRuntimeMcpServer[];
  log: DreamuxLogger;
  workflowLog?: DreamuxLogger;
  coreEvents?: DispatcherCoreEventPublisher;
  nameSuffixGenerator?: SuffixGenerator;
  agentNameSuffixGenerator?: SuffixGenerator;
}

export const TEAM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type TeamStatus = 'starting' | 'running' | 'closed';

export type TeamDissolveRequesterKind =
  | 'dispatcher'
  | 'team_leader'
  | 'collaboration_target';

export type TeamDissolvePhase =
  | 'waiting_for_team_idle'
  | 'closing_resources'
  | 'worktree_cleanup_pending'
  | 'complete'
  | 'failed';

export type TeamDissolvePublicError =
  | 'worktree-dirty'
  | 'worktree-unmerged'
  | 'worktree-unique-commits'
  | 'worktree-assessment-failed'
  | 'resource-close-failed'
  | 'worktree-cleanup-failed';

/** Server-owned durable lifecycle fact for one accepted Team dissolve. */
export interface TeamDissolveRecord {
  operation_id: string;
  requester_kind: TeamDissolveRequesterKind;
  /** Descriptor-bound generation for TeamLeader self-dissolve. */
  leader_name: string | null;
  /** Opaque exact-target handoffs attached before target-owned runners start. */
  target_handoff_ids: string[];
  note: string;
  accepted_at: number;
  phase: TeamDissolvePhase;
  last_error: TeamDissolvePublicError | null;
  cleanup_attempts: number;
  next_retry_at: number | null;
}

export interface TeamRecord {
  version: 1;
  dispatcher_id: string;
  team_id: string;
  name: string;
  repo_cwd: string;
  source_repo: string | null;
  leader_name: string;
  leader_agent_runtime: string;
  runtime_cwd: string;
  worktree: AgentEntityWorktreeIdentity;
  status: TeamStatus;
  intent: string | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  close_note: string | null;
  /** Missing on older additive records and normalized to null by TeamStore. */
  dissolve: TeamDissolveRecord | null;
}

interface TeamCreateOptions {
  /**
   * Explicit repository cwd for the Team workspace (issue #199). Omitted when
   * the caller passes no `repo`: the Team then runs in a plain
   * dispatcher-default workspace (isolated under `.workspace/work/<team_name>/`,
   * or the dispatcher cwd itself when workspace isolation is disabled). A managed
   * git worktree is created only for an explicit `worktree` request.
   */
  repoCwd?: string;
  leaderAgentRuntime: string;
  worktree?: TeamMateWorktreeRequest;
  /** Required recovery subject for the Team (issue #182 PR-3). */
  intent: string;
  identity?: string;
  /** Additional admin-supplied TeamLeader skill roots. */
  skillSources?: readonly AgentRuntimeSkillSource[];
  prompt?: string;
}

/** Dispatcher-facing request: `namePrefix` is never the durable Team address. */
export interface TeamCreateInput extends TeamCreateOptions {
  namePrefix: string;
}

/**
 * Internal create request for a concrete name already allocated and durably
 * reserved by its owner (for example a collaboration target claim).
 */
export interface TeamCreateAtNameInput extends TeamCreateOptions {
  name: string;
  /**
   * Authority for a previously persisted concrete-name claim. Omit only when
   * TeamCollection itself should claim this exact name before creating it.
   */
  nameClaimToken?: string;
}

export interface TeamNameClaim {
  name: string;
  token: string;
}

export interface TeamDissolveInput {
  teamId: string;
  /** Required dissolve reason recorded on the team record (issue #182 PR-3). */
  note: string;
}

export type TeamDissolveRequester =
  | { kind: 'dispatcher' }
  | { kind: 'team_leader'; leaderName: string }
  | {
      kind: 'collaboration_target';
      leaderName: string | null;
      handoffId: string;
    };

export interface TeamDissolveRequest extends TeamDissolveInput {
  requester: TeamDissolveRequester;
  /** Dispatcher-only absolute deadline for pre-acceptance safety work. */
  decisionDeadlineAt?: number;
}

export interface TeamDissolveReceipt {
  accepted: true;
  team_name: string;
  status: 'closing';
}

/**
 * Internal handle. MCP projects only its receipt; target close joins logical
 * closure.
 */
export interface AcceptedTeamDissolve {
  operationId: string;
  receipt: TeamDissolveReceipt;
  logicalClosed: Promise<TeamSummary>;
}

/** Input consumed by the dispatcher-side route/resource close executor. */
export interface AcceptedTeamLogicalClose {
  operationId: string;
  teamId: string;
  note: string;
  owner: {
    kind: 'team';
    teamName: string;
    leaderName: string;
  };
  dissolve: TeamDissolveRecord;
  worktree: AgentEntityWorktreeIdentity;
}

export type TeamLogicalCloseExecutor = (
  input: AcceptedTeamLogicalClose,
) => Promise<TeamSummary>;

/** Active channel target marker surfaced by the Team read tools. */
export interface TeamChannelBindingSummary {
  channel_id: string;
  provider: string;
  target_type: string;
  target_key: string;
  display: string | null;
  canonical_url: string | null;
}

/**
 * Public Team record view (issue #199 Slice 2). The status surface speaks the
 * concrete `team_name`; the duplicate `name` / `team_id`, the machine-local
 * `repo_cwd` / `runtime_cwd` / flattened `worktree`, and the persisted `version`
 * are projected away. The persisted {@link TeamRecord} keeps them for internal
 * orchestration and storage (the storage rewrite is Slice 3).
 */
export interface TeamView {
  team_name: string;
  status: TeamStatus;
  intent: string | null;
  source_repo: string | null;
  leader_name: string;
  leader_agent_runtime: string;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  close_note: string | null;
  dissolve_phase: TeamDissolvePhase | null;
  dissolve_accepted_at: number | null;
  worktree_cleanup: AgentEntityWorktreeIdentity['cleanup_state'];
  dissolve_error: TeamDissolvePublicError | null;
}

export interface TeamSummary {
  team: TeamView;
  leader: AgentEntityRuntimeStatus | null;
  member_count: number;
}

/**
 * Compact scan row for `team.list` (issue #199 Slice 1/2). Keyed by the concrete
 * `team_name`; the duplicate `team_id` and the machine-local `repo_cwd` /
 * `worktree_mode` are no longer projected — reach for `team.status` for detail.
 */
export interface TeamListRow {
  team_name: string;
  status: TeamStatus;
  intent: string | null;
  source_repo: string | null;
  leader_name: string;
  leader_state: AgentEntityIdentityStatus | null;
  member_count: number;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  dissolve_phase: TeamDissolvePhase | null;
  dissolve_accepted_at: number | null;
  worktree_cleanup: AgentEntityWorktreeIdentity['cleanup_state'];
  dissolve_error: TeamDissolvePublicError | null;
}

/**
 * Filterable recovery search over Teams (issue #182 PR-7), the Team-side mirror
 * of the TeamMate `history` surface: it finds Teams (including closed ones) by
 * name / status / repo / intent text / time range, rather than reading one
 * team's raw lifecycle event timeline (which no longer exists).
 */
export interface TeamHistoryQuery {
  name?: string;
  /** Lifecycle status filter (the retired `close_status` is gone). */
  status?: TeamStatus;
  /** Substring match over `source_repo` / `repo_cwd`. */
  repo?: string;
  /** Substring match over team_name / intent / repo / leader name. */
  grep?: string;
  /** Inclusive lower/upper bounds on `updated_at`. */
  since?: number;
  until?: number;
  limit?: number;
  cursor?: string;
}

/**
 * Public Team recovery row (issue #199 Slice 1). A compact projection keyed by
 * the concrete `team_name` (`name`): no `team_id`, no `close_status` duplicate of
 * `status`, and no machine-local `repo_cwd`/`runtime_cwd`/`worktree` paths.
 */
export interface TeamHistoryRow {
  team_name: string;
  status: TeamStatus;
  intent: string | null;
  source_repo: string | null;
  leader_name: string;
  leader_agent_runtime: string;
  leader_state: AgentEntityIdentityStatus | null;
  member_count: number;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  close_note: string | null;
  close_note_preview: string | null;
  dissolve_phase: TeamDissolvePhase | null;
  dissolve_accepted_at: number | null;
  worktree_cleanup: AgentEntityWorktreeIdentity['cleanup_state'];
  dissolve_error: TeamDissolvePublicError | null;
}

export interface TeamHistoryResult {
  items: TeamHistoryRow[];
  next_cursor: string | null;
}

export interface TeamCreateResult extends TeamSummary {
  /**
   * The leader's first-turn result, or `null` when the team was created without
   * an explicit `prompt` (the leader starts idle and fires no turn at creation).
   */
  status: AgentEntitySubmissionResult['status'] | null;
  error?: string;
}

export interface TeamLeaderSendResult extends AgentEntitySubmissionResult {
  team: TeamView;
  leader: AgentEntityRuntimeStatus;
}

export interface TeamLeaderLease {
  teamId: string;
  leaderName: string;
}

export interface TeamRouteProjection {
  team_name: string;
  leader_name: string;
  leader_agent_runtime: string;
  runtime_cwd: string;
}

export function validateTeamId(id: string): string {
  if (!TEAM_ID_PATTERN.test(id)) {
    throw new Error(
      'Team id must be 1-64 ASCII letters, digits, dots, underscores, ' +
        `or dashes, starting with a letter or digit: ${id}`,
    );
  }
  assertNotReservedAgentName(id);
  return id;
}
