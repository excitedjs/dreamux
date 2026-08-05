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
import type { CompletionEnvelope } from '../completion-router/index.js';
import type { WorktreeManager } from '../worktree/manager.js';

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
  /** Increments per submission across the whole collection so sourceIds stay unique. */
  nextSubmissionSeq: () => number;
  /** Tracks an in-flight settle capture so the collection can drain on shutdown. */
  trackSettleCapture?: (capture: Promise<void>) => void;
  /**
   * Route a settled, send-initiated turn's completion to whoever initiated it,
   * via the per-dispatcher `CompletionRouter`. The collection wires this to
   * `router.settle(completionKey(producerName, turnId), envelope)`.
   */
  routeSettledCompletion: SettledCompletionRoute;
}

/** A per-entity destination for every turn settled by that TeamMate. */
export type SettledCompletionRoute = (
  producerName: string,
  turnId: string,
  completion: CompletionEnvelope,
) => Promise<void>;

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
