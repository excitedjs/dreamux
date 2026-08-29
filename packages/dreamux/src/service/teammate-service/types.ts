import type {
  AgentRuntimeSkillSource,
  AgentRuntimeSystemPrompt,
  DreamuxLogger,
  JsonSchema,
  TeammateRole,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { DreamuxConfig } from '../../config/config.js';
import type {
  AgentEntityCollectionStore,
  AgentIdentityStore,
} from '../agent-entity/identity-store.js';
import type { AgentEntityIdentity } from '../agent-entity/types.js';
import type { AgentEntityCloseResult } from '../agent-entity/types.js';
import type { WorktreeManager } from '../worktree/manager.js';
import type { McpLeaseRegistry } from '../mcp/leases.js';
import type { McpServerDelegate } from '../mcp/types.js';
import type { AdmissionLedger } from './admission-ledger.js';
import type { TurnAdmission } from './turn-recording.js';
import type { ConversationProjection } from '../../channel/conversation-projection.js';

export interface TeammateServiceDeps {
  config: DreamuxConfig;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  /**
   * This entity's identity storage, already bound to its resolved directory by
   * the owner that materialized it. The service never composes a path itself.
   */
  identities: AgentIdentityStore;
  /**
   * The collection this entity belongs to, used only to refuse a managed
   * worktree path a sibling already owns. Omitted for an owner-root Agent (the
   * dispatcher Agent, a TeamLeader), which has no sibling collection.
   */
  peers?: AgentEntityCollectionStore;
  /**
   * The one dispatcher-lifetime duplicate ledger. Required: dedupe has to
   * outlive an entity's service object, which is rematerialized on reopen and
   * dropped on retire.
   */
  admissions: AdmissionLedger;
  /**
   * The worktree manager backing `close` (cleanup) and a closed-teammate reopen
   * (reprepare). Omitted only for the dispatcher agent (issue #233 Phase 5),
   * which never closes or reopens, so it never reaches the manager.
   */
  worktrees?: WorktreeManager;
  conversationProjection?: ConversationProjection;
  log: DreamuxLogger;
}

export type EntityPhase = 'active' | 'closing' | 'closedHeld' | 'retired';

export interface TeammateClosedFact {
  readonly schema_version: 1;
  readonly kind: 'teammate.closed';
  readonly dispatcher_id: string;
  readonly team_id: string | null;
  readonly name: string;
  readonly closed_at: number;
}

export interface TeammateClosedSubscription {
  unsubscribe(): void;
}

export interface WorkflowTeammateSubmitInput {
  prompt: string;
  /** The provenance name the Workflow owner submits its step prompts under. */
  source: string;
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
  systemPrompt?: AgentRuntimeSystemPrompt;
  /**
   * Optional JSON Schema constraining every turn's final assistant message.
   * Bound once to the runtime session through the create context: a provider
   * that applies schema natively per turn stores this fixed value and reapplies
   * it, and no later submission can change it. In-memory only — never persisted
   * to identity.
   */
  outputSchema?: JsonSchema;
  runtimeId: string;
  /**
   * The runtime role of this entity, derived by its owner: `dispatcher` for the
   * Dispatcher Service's own Agent, `team_leader` for a Team's leader, and
   * `teammate` for every Agent held by a TeammateCollection. It is used for
   * presentation and routing only and is never persisted.
   */
  role: TeammateRole;
  ownsWorktreeOnClose: boolean;
  loggerFields?: Record<string, unknown>;
  assertIdentityScope?: (
    identity: AgentEntityIdentity,
    dispatcherId: string,
  ) => void;
}
