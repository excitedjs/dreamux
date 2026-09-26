import {
  assertNotReservedAgentName,
  type AgentEntityIdentityStatus,
  type AgentEntityWorktreeIdentity,
} from '../agent/identity.js';
import type {
  AgentRuntimeSkillSource,
  DreamuxLogger,
  Team,
  TeamStatus,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { ConfigReader } from '../../config/service.js';
import type { AgentNameRegistry } from '../agent/store.js';
import type { AgentServiceFactory } from '../agent/factory.js';
import type { TeammateAgentMcp } from '../agent/service-types.js';
import type { TeamMateSharedWorkspace } from '../agent/types.js';
import type { DispatcherCoreEventPublisher } from '../dispatcher-core-events/index.js';
import type { ConversationProjection } from '../dispatcher-core-events/conversation-projection.js';
import type {
  CompletionDeliveryPolicy,
  CompletionInitiator,
} from '../completion-router/index.js';
import type { SuffixGenerator } from '../name-allocator.js';
import type { ClosedListener } from '../../platform/closed-fact.js';
import type { WorktreeManager } from '../worktree/manager.js';
import type { TeamMateWorktreeRequest } from '../worktree/types.js';
import { RuleViolation } from '../../platform/errors.js';
import type { TeamStore } from './store.js';

export interface TeamCollectionOptions {
  /** The dispatcher this collection belongs to (issue #233 ownership sinking). */
  dispatcherId: string;
  config: ConfigReader;
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
  agentServiceFactory: AgentServiceFactory;
  // Shared per-dispatcher deps `DispatcherService` always supplies; forwarded
  // unchanged into each team's own collection so it stays topology-free (#233).
  completionDelivery: CompletionDeliveryPolicy;
  /**
   * The dispatcher's own Agent, where a TeamLeader's completions are delivered.
   * A Team's own TeamMates report to their leader instead; each owner supplies
   * the recipient it knows rather than deriving one from the producing record.
   * Named to match `TeamServiceDeps`'s own field for the same fact, so
   * `TeamCollection.depsBase()` forwards it unchanged instead of remapping it.
   */
  leaderCompletionInitiator: () => Promise<CompletionInitiator | null>;
  admitOperation: <T>(task: () => Promise<T>) => Promise<T>;
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
  /** Fires the owning Dispatcher's `team` hook for a just-constructed Team; never throws. */
  announceTeam: (team: Team, ctx: { origin: 'create' | 'rebuild' }) => void;
  log: DreamuxLogger;
  workflowLog: DreamuxLogger;
  coreEvents: DispatcherCoreEventPublisher;
  conversationProjection: ConversationProjection;
  nameSuffixGenerator?: SuffixGenerator;
  agentNameSuffixGenerator?: SuffixGenerator;
}

export const TEAM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type TeamDissolveRequesterKind = 'dispatcher' | 'team_leader';

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
  /**
   * Authorization to discard uncommitted, untracked, or unmerged work while
   * reclaiming this Team's own managed worktree.
   *
   * It exists for exactly as long as that physical reclamation is still owed: a
   * cleanup that resumes after a restart must destroy what the caller
   * authorized, not what a later reader assumes. It is written only alongside a
   * `cleanup-pending` worktree and cleared the moment that state is terminal,
   * so a Team with nothing left to reclaim always reads `false`.
   */
  worktree_cleanup_force: boolean;
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
  identity?: string | undefined;
  /** Additional admin-supplied TeamLeader skill roots. */
  skillSources?: readonly AgentRuntimeSkillSource[];
  prompt?: string | undefined;
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
  /**
   * Whether the leader's first-turn completion (when `prompt` is given)
   * reports back to the Dispatcher Agent. `team.submit`'s
   * `deliverCompletionToDispatcher` states the same recipient decision for a
   * follow-up turn; a create with a prompt needs the identical statement for
   * its own first turn.
   */
  deliverCompletionToDispatcher: boolean;
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
  force?: boolean | undefined;
}

/**
 * What a dissolve submission reports.
 *
 * Submitted, not settled: the caller is answered as soon as the Team owns the
 * one background operation that will stop it, close it, and reclaim its
 * checkout. Nothing that happens afterwards revises this receipt — a background
 * refusal leaves the Team open and is logged, so a caller learns the outcome by
 * reading the Team, not by waiting here.
 */
export interface TeamDissolveReceipt {
  accepted: true;
  team_name: string;
  status: 'submitted';
}

/** What one Team is asked to dissolve itself with, once the caller is known. */
export interface TeamDissolveCommand {
  note: string;
  force: boolean;
  requester: TeamDissolveRequesterKind;
}

/**
 * Compact scan row for `team.list`: the same names and meanings as the
 * matching `TeamSummary` fields, and nothing a list does not need — no leader
 * runtime state, no machine-local `runtime_cwd`, no full `close_note`. Read
 * from records alone; `team.status` is where a single Team's detail lives.
 */
export interface TeamListRow {
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
  worktree_cleanup: AgentEntityWorktreeIdentity['cleanup_state'];
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
  worktree_cleanup: AgentEntityWorktreeIdentity['cleanup_state'];
}

export interface TeamHistoryResult {
  items: TeamHistoryRow[];
  next_cursor: string | null;
}

export function validateTeamId(id: string): string {
  if (!TEAM_ID_PATTERN.test(id)) {
    throw new RuleViolation(
      'Team id must be 1-64 ASCII letters, digits, dots, underscores, ' +
        `or dashes, starting with a letter or digit: ${id}`,
    );
  }
  assertNotReservedAgentName(id);
  return id;
}

export interface TeamServiceCreateInput {
  teamId: string;
  name: string;
  /** Written into the published Team record; absent for internal creation. */
  createRequest?: TeamCreateRequestIdentity | undefined;
  prompt?: string | undefined;
  /**
   * Whether a given `prompt`'s first-turn completion reports back to the
   * Dispatcher Agent; consulted only when `prompt` is present.
   */
  deliverCompletionToDispatcher: boolean;
  leaderAgentRuntime: string;
  intent: string;
  identity?: string | undefined;
  skillSources?: readonly AgentRuntimeSkillSource[] | undefined;
  workspace: TeamMateSharedWorkspace;
}

/**
 * What one Team is built from.
 *
 * Collaborators and shared dispatcher facts only: nothing here reaches back
 * into the collection that constructed the Team. A Team is handed what it
 * needs, does its own work with it, and states what happened by publishing its
 * own terminal fact — so its owner learns of its end without the Team ever
 * calling upward into its owner's lifecycle.
 *
 * Everything but the three fields below is forwarded unchanged from the
 * `TeamCollectionOptions` the owning `TeamCollection` was itself constructed
 * with (`depsBase()` spreads it directly); `root` and `nameSuffixGenerator`
 * are collection-only concerns a Team never needs.
 */
export type TeamServiceDeps = Omit<
  TeamCollectionOptions,
  'root' | 'nameSuffixGenerator'
> & {
  /**
   * This Team's own root directory, bound by `TeamCollection` when it
   * constructed this service. The TeamLeader's `identity.json`, the Team
   * `record.json`, this Team's cron jobs, and its `teammate/` collection all sit
   * directly under it — the Team never rebuilds the path from ids.
   */
  teamRoot: string;
  store: TeamStore;
  /**
   * Finish the physical reclamation a closed Team's record still owes, through
   * the same record-only path the collection's own startup sweep uses. A
   * plain constructor-supplied value rather than a collection import: `store`
   * ← `service` ← `collection` is the declared direction, so the service tier
   * must not import the collection tier that holds this method.
   */
  settleWorktreeCleanup: (teamId: string) => Promise<void>;
};

/**
 * One Team is over.
 *
 * Published once, after that Team's own record is durably `closed` — the only
 * fact that makes it true. Its owner drops the exact instance that published
 * it; nothing else is asked of a listener, and nothing a listener does can
 * change what already happened.
 */
export interface TeamClosedFact {
  readonly schema_version: 1;
  readonly kind: 'team.closed';
  readonly dispatcher_id: string;
  readonly team_id: string;
  readonly closed_at: number;
}

export type TeamClosedListener = ClosedListener<TeamClosedFact>;

/** The fact a Team publishes from the record that made it closed. */
export function teamClosedFact(record: TeamRecord): TeamClosedFact {
  return Object.freeze({
    schema_version: 1,
    kind: 'team.closed',
    dispatcher_id: record.dispatcher_id,
    team_id: record.team_id,
    closed_at: record.closed_at ?? Date.now(),
  });
}
