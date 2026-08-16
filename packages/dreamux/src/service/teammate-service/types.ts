import type {
  AgentRuntimeMcpServer,
  AgentRuntimeSkillSource,
  AgentRuntimeSystemPrompt,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { DreamuxConfig } from '../../config/config.js';
import type { AgentIdentityStore } from '../agent-entity/identity-store.js';
import type { AgentTurnsStore } from '../agent-entity/turns-store.js';
import type { AgentEntityIdentity } from '../agent-entity/types.js';
import type {
  AgentEntityCloseResult,
  AgentEntityTurnOrigin,
} from '../agent-entity/types.js';
import type { WorktreeManager } from '../worktree/manager.js';
import type { TurnAdmission } from './turn-recording.js';

export interface TeammateServiceDeps {
  config: DreamuxConfig;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  identities: AgentIdentityStore;
  turnsStore: AgentTurnsStore;
  /**
   * The worktree manager backing `close` (cleanup) and a closed-teammate reopen
   * (reprepare). Omitted only for the dispatcher agent (issue #233 Phase 5),
   * which never closes or reopens, so it never reaches the manager.
   */
  worktrees?: WorktreeManager;
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
  turnOrigin: AgentEntityTurnOrigin;
  outputSchema?: Record<string, unknown>;
}

export interface LockedTeammate {
  readonly name: string;
  submit(input: WorkflowTeammateSubmitInput): Promise<TurnAdmission>;
  close(input: { note: string }): Promise<AgentEntityCloseResult>;
  unlock(): void;
}

export interface TeammateServiceOptions {
  mcpServers?: readonly AgentRuntimeMcpServer[];
  skillSources?: readonly AgentRuntimeSkillSource[];
  disableFeatures?: readonly string[];
  systemPrompt?: AgentRuntimeSystemPrompt;
  /**
   * Optional JSON Schema constraining every turn's final assistant message for
   * this runtime's lifetime. Flows into the create context so runtimes that
   * apply schema at spawn time (e.g. claude-code `--json-schema`) pick it up;
   * runtimes that support per-turn schema natively ignore it. In-memory only —
   * never persisted to identity.
   */
  outputSchema?: Record<string, unknown>;
  runtimeId: string;
  ownsWorktreeOnClose: boolean;
  loggerFields?: Record<string, unknown>;
  assertIdentityScope?: (
    identity: AgentEntityIdentity,
    dispatcherId: string,
  ) => void;
}
