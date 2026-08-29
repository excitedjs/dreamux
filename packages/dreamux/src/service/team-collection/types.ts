import {
  assertNotReservedAgentName,
  type AgentEntityIdentityStatus,
  type AgentEntityRuntimeStatus,
  type AgentEntitySubmissionResult,
  type AgentEntityWorktreeIdentity,
} from '../agent-entity/types.js';
import type {
  AgentRuntimeSkillSource,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { DreamuxConfig } from '../../config/config.js';
import type { AgentNameRegistry } from '../agent-entity/identity-store.js';
import type { AdmissionLedger } from '../teammate-service/admission-ledger.js';
import type { TeammateAgentMcp } from '../teammate-service/types.js';
import type { DispatcherCoreEventPublisher } from '../dispatcher-core-events/index.js';
import type { ConversationProjection } from '../../channel/conversation-projection.js';
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
   * The `team/` collection root the dispatcher bound at construction. This
   * collection appends only the concrete Team name; each `TeamService` then
   * receives that Team root and composes its own children from it.
   */
  root: string;
  /** The dispatcher-global agent-name namespace. */
  names: AgentNameRegistry;
  admissions: AdmissionLedger;
  // Shared per-dispatcher deps `DispatcherService` always supplies; forwarded
  // unchanged into each team's own collection so it stays topology-free (#233).
  completionDelivery: CompletionDeliveryPolicy;
  /**
   * The dispatcher's own Agent, where a TeamLeader's completions are delivered.
   * A Team's own TeamMates report to their leader instead; each owner supplies
   * the recipient it knows rather than deriving one from the producing record.
   */
  dispatcherCompletionInitiator: () => Promise<CompletionInitiator | null>;
  isShuttingDown: () => boolean;
  admitOperation?: <T>(task: () => Promise<T>) => Promise<T>;
  trackAcceptedOperation?: <T>(task: () => Promise<T>) => Promise<T>;
  /**
   * Build one TeamLeader's Agent-facing MCP surface.
   *
   * The Team layer supplies the identity and nothing else. Every object those
   * servers reach — channels, Teams, TeamMates, schedulers — is dispatcher-owned,
   * so the dispatcher assembles them; a Team that built its own leader's tools
   * would be re-deciding a role question it does not own.
   */
  leaderMcp: (input: {
    teamId: string;
    leaderName: string;
  }) => TeammateAgentMcp;
  log: DreamuxLogger;
  workflowLog?: DreamuxLogger;
  coreEvents?: DispatcherCoreEventPublisher;
  conversationProjection?: ConversationProjection;
  nameSuffixGenerator?: SuffixGenerator;
  agentNameSuffixGenerator?: SuffixGenerator;
}

export const TEAM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type TeamStatus = 'starting' | 'running' | 'closed';

export type TeamDissolveRequesterKind =
  | 'dispatcher'
  | 'team_leader';

/**
 * Where an accepted dissolve currently is.
 *
 * There is no idle phase. A dissolve is a destructive stop-and-reclaim: its
 * first runtime act is to fence admission and stop the runtimes, never to wait
 * for a turn to end on its own. `blocked_after_stop` is the one phase that
 * ends an operation without closing the Team — the post-stop recheck found
 * work worth keeping, so the operation is abandoned and ordinary admission
 * reopens over stopped children that reopen lazily like any other.
 */
export type TeamDissolvePhase =
  | 'stopping_runtimes'
  | 'closing_resources'
  | 'worktree_cleanup_pending'
  | 'complete'
  | 'failed'
  | 'blocked_after_stop';

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
  /**
   * The caller's explicit authorization to discard uncommitted, untracked, or
   * unmerged work in this Team's own managed worktree. It is recorded because
   * a background cleanup that resumes after a restart must destroy exactly
   * what the operator authorized, not what a later reader assumes.
   */
  force: boolean;
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
  /**
   * The stable TeamLeader creation inputs this Team owns, kept beside the other
   * leader-creation fields: the identity prompt and the already-normalized
   * skill sources the leader was created from.
   *
   * They are creation inputs, not a second Agent identity — no session, status,
   * or other mutable Agent state belongs here. They are read only when this
   * Team has no aligned leader Identity to restore; an aligned Identity is
   * always restored exactly as stored and is never compared against them.
   *
   * Both are additive: a record written before they existed reads back as no
   * identity prompt and no admin-supplied skill sources.
   */
  leader_identity_prompt: string | null;
  leader_skill_sources: readonly AgentRuntimeSkillSource[];
  runtime_cwd: string;
  worktree: AgentEntityWorktreeIdentity;
  status: TeamStatus;
  intent: string | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  close_note: string | null;
  /**
   * The accepted `team.create` request identity that produced this Team, and
   * the canonical hash of its payload. Both are null for a Team created through
   * an internal path that carries no request identity. Together they make this
   * record the only authority a replay is decided against.
   */
  create_request_id: string | null;
  create_payload_hash: string | null;
  /** Missing on older additive records and normalized to null by TeamStore. */
  dissolve: TeamDissolveRecord | null;
}

/** One accepted `team.create` request, as stored in the Team record. */
export interface TeamCreateRequestIdentity {
  requestId: string;
  payloadHash: string;
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
 * Create request for one concrete candidate name.
 *
 * The name is a candidate, not a reservation: nothing owns it until the Team
 * record is published. Omitting `createRequest` is how an internal caller
 * creates a Team that carries no `team.create` request identity.
 */
export interface TeamCreateAtNameInput extends TeamCreateOptions {
  name: string;
  createRequest?: TeamCreateRequestIdentity;
}

export interface TeamDissolveInput {
  teamId: string;
  /** Required dissolve reason recorded on the team record (issue #182 PR-3). */
  note: string;
  /**
   * Discard local work in this Team's managed worktree so the checkout can be
   * removed. It authorizes losing uncommitted, untracked, and unmerged changes
   * there and nothing else: never a reused cwd, a source repository, a
   * repository root, the managed branch, or committed history.
   */
  force?: boolean;
}

export type TeamDissolveRequester =
  | { kind: 'dispatcher' }
  | { kind: 'team_leader'; leaderName: string };

export interface TeamDissolveRequest extends TeamDissolveInput {
  requester: TeamDissolveRequester;
}

/**
 * What a settled dissolve reports.
 *
 * `accepted` and `status` are not two stages of one answer. A caller reaches
 * this only after the operation reached durable logical close, so both are
 * true at once. Reclaiming the managed checkout continues behind the answer
 * and cannot change it; a dissolve that is refused or fails throws instead of
 * returning a receipt.
 */
export interface TeamDissolveReceipt {
  accepted: true;
  team_name: string;
  status: 'closed';
}

/** Internal handle. Every caller-facing surface projects only its receipt. */
export interface AcceptedTeamDissolve {
  operationId: string;
  receipt: TeamDissolveReceipt;
  /**
   * Settles when this operation's logical close is durable: the post-stop
   * worktree check passed, every child runtime has exited, and the Team
   * record is closed. Reclaiming the checkout happens after it and is never
   * awaited here. A caller that joins an operation somebody else accepted
   * waits on that same milestone, and one that joins after it settled reads
   * the settled result.
   */
  logicalClosed: Promise<TeamSummary>;
}

/** Input consumed by the Team resource-close half of an accepted dissolve. */
export interface AcceptedTeamLogicalClose {
  operationId: string;
  teamId: string;
  note: string;
  dissolve: TeamDissolveRecord;
  worktree: AgentEntityWorktreeIdentity;
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

export interface TeamLeaderLease {
  teamId: string;
  leaderName: string;
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
