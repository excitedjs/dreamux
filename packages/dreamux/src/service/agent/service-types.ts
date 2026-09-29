import type {
  AgentRuntimeSkillSource,
  AgentRuntimeSystemPrompt,
  DreamuxLogger,
  JsonSchema,
  TeammateRole,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { ConfigReader } from '../../config/service.js';
import type { AgentIdentityStore } from './store.js';
import type {
  AgentEntityCloseResult,
  AgentEntityIdentity,
} from './identity.js';
import type { WorktreeManager } from '../worktree/manager.js';
import type { McpLeaseRegistry } from '../mcp/leases.js';
import type { McpServerDelegate } from '../mcp/types.js';
import type { AdmissionLedger } from './admission.js';
import type { TurnAdmission } from './turn.js';
import type { ConversationProjection } from '../dispatcher-core-events/conversation-projection.js';

export interface TeammateServiceDeps {
  config: ConfigReader;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  /**
   * This entity's identity storage, already bound to its resolved directory by
   * `AgentServiceFactory`. The service never composes a path itself.
   */
  identities: AgentIdentityStore;
  /**
   * Fired after a create, an upsert, or an update that changed status.
   * `AgentIdentityStoreBinding` has no construction-time answer for this —
   * the entity that materialized publishes to a Collection's cache, a Team's
   * roster projection, or a dispatcher's own state, each a different owner —
   * so the caller that asked `AgentServiceFactory` to build this entity passes
   * its own publish hook explicitly instead.
   */
  onPersisted: (identity: AgentEntityIdentity) => void;
  /**
   * The collection's own occupancy query, asked fresh (never a snapshot
   * taken at construction) for one candidate path at a time, only to refuse
   * a managed worktree path a sibling already owns on a reopen. Omitted for
   * an owner-root Agent (the dispatcher Agent, a TeamLeader), which has no
   * sibling collection.
   */
  findManagedWorktreeOwner?: (
    path: string,
    excludingName: string,
  ) => Promise<string | null>;
  /**
   * The one dispatcher-lifetime duplicate ledger. Required: dedupe has to
   * outlive an entity's service object, which is rematerialized on reopen and
   * dropped on retire.
   */
  admissions: AdmissionLedger;
  /** Dispatcher-scoped worktree capability, bound by AgentServiceFactory. */
  worktrees: WorktreeManager;
  conversationProjection: ConversationProjection;
  log: DreamuxLogger;
}

/**
 * Where one entity is in its own lifecycle.
 *
 * Three states, because there are three: taking work, converging on closed, and
 * durably closed. "Held closed by a Workflow" is not a fourth — it is `closed`
 * plus a lock, and the lock already says so.
 */
export type EntityPhase = 'active' | 'closing' | 'closed';

export interface TeammateClosedFact {
  readonly schema_version: 1;
  readonly kind: 'teammate.closed';
  readonly dispatcher_id: string;
  readonly team_id: string | null;
  readonly name: string;
  readonly closed_at: number;
}

/** The fact a TeamMate publishes once its identity is durably closed. */
export function teammateClosedFact(
  identity: AgentEntityIdentity,
  closedAt: number,
): TeammateClosedFact {
  return Object.freeze({
    schema_version: 1,
    kind: 'teammate.closed',
    dispatcher_id: identity.dispatcher_id,
    team_id: identity.team_id,
    name: identity.name,
    closed_at: closedAt,
  });
}

export interface WorkflowTeammateSubmitInput {
  prompt: string;
  /** The provenance name the Workflow owner submits its step prompts under. */
  source: string;
}

export interface CreateLockedTeammateOptions {
  systemPromptAppend?: readonly string[];
  outputSchema?: JsonSchema | undefined;
}

export interface LockedTeammate {
  readonly name: string;
  submit(input: WorkflowTeammateSubmitInput): Promise<TurnAdmission>;
  close(input: { note: string }): Promise<AgentEntityCloseResult>;
  unlock(): void;
}

/**
 * The Agent-facing MCP servers one entity gets, and the registry its leases are
 * minted into.
 *
 * They travel together because they are one decision: a role either publishes
 * tools to its model or it does not. Only the two conversational roles set it —
 * an ordinary TeamMate has no Agent-facing tool surface of its own.
 *
 * Delegates are built once, with the entity, because a catalog is a property of
 * the caller. What is rebuilt per runtime generation is the lease each delegate
 * is reachable under, which is why the registry is here rather than a token.
 */
export interface TeammateAgentMcp {
  leases: McpLeaseRegistry;
  delegates: readonly McpServerDelegate[];
  adminSocketPath: string;
}

export interface TeammateServiceOptions {
  mcp?: TeammateAgentMcp;
  skillSources?: readonly AgentRuntimeSkillSource[];
  disabledFeatures?: readonly string[];
  systemPrompt?: AgentRuntimeSystemPrompt | undefined;
  /**
   * Optional JSON Schema constraining every turn's final assistant message.
   * Bound once to the runtime session through the create context: a provider
   * that applies schema natively per turn stores this fixed value and reapplies
   * it, and no later submission can change it. In-memory only — never persisted
   * to identity.
   */
  outputSchema?: JsonSchema | undefined;
  runtimeId: string;
  /**
   * The runtime role of this entity, derived by its owner: `dispatcher` for the
   * Dispatcher Service's own Agent, `team_leader` for a Team's leader, and
   * `teammate` for every Agent held by a TeammateCollection. It is used for
   * presentation and routing only and is never persisted.
   */
  role: TeammateRole;
  loggerFields?: Record<string, unknown>;
}

/**
 * The noun phrase an error message uses for one entity, worded by the actual
 * role its owner constructed it with. `AgentService` holds a Dispatcher's own
 * Agent and a Team's leader as well as ordinary TeamMates, so a hardcoded
 * "TeamMate" is wrong for the other two roles.
 */
export function agentRoleNoun(role: TeammateRole, name: string): string {
  switch (role) {
    case 'dispatcher':
      return 'the Dispatcher agent';
    case 'team_leader':
      return `Team leader ${JSON.stringify(name)}`;
    case 'teammate':
      return `TeamMate ${JSON.stringify(name)}`;
  }
}
