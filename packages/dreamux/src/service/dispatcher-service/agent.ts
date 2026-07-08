import type {
  AgentRuntimeMcpServer,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import {
  DISABLE_FEATURE_CRON,
  type AgentRuntimeProviderCatalog,
} from '../../agent-runtime/index.js';
import type { DreamuxConfig } from '../../config/config.js';
import {
  completionKey,
  type CompletionEnvelope,
  type CompletionRouter,
} from '../completion-router/index.js';
import type { AgentIdentityStore } from '../agent-entity/identity-store.js';
import {
  createTeammateService,
} from '../teammate-service/factory.js';
import {
  assertDispatcherRootAgent,
  dispatcherRuntimeId,
} from '../agent-entity/runtime-profile.js';
import type { TeammateService } from '../teammate-service/index.js';
import type { AgentTurnsStore } from '../agent-entity/turns-store.js';
import type { AgentEntityIdentity } from '../agent-entity/types.js';
import {
  DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS,
  DREAMUX_DISPATCHER_BASE_INSTRUCTIONS,
} from './base-prompt.js';
import { bundledDispatcherSkillRoot } from '../../platform/paths.js';

export interface DispatcherAgentDeps {
  id: string;
  config: DreamuxConfig;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  router: CompletionRouter;
  log: DreamuxLogger;
  mcpServers: readonly AgentRuntimeMcpServer[];
  identity: AgentEntityIdentity;
  /**
   * The identity + turns store pair, constructed once by `DispatcherService` and
   * shared with the dispatcher-scope `TeammateCollection` (issue #233). The stores
   * are stateless (paths by role + team_id), so one pair safely serves the
   * dispatcher agent's root identity (role `dispatcher`) and the collection's
   * teammate reads (role `teammate`).
   */
  identities: AgentIdentityStore;
  turnsStore: AgentTurnsStore;
}

/**
 * Build the dispatcher's own agent as a contained {@link TeammateService} (issue
 * #233 Phase 5). The dispatcher *has an* agent rather than *being* one: the
 * shared entity owns the runtime lifecycle (start/resume/stop), the
 * `onTurnSettled` → router capture, and `completionInput` as a delivery target,
 * while `DispatcherService` keeps the dispatcher-only concerns (channel sessions,
 * restart-intent injection, MCP descriptor assembly).
 *
 * The agent's runtime is resolved through the same `identity.agent_runtime ->
 * agents[]` path used by TeamLeader and TeamMate. Its `identity.json` is the
 * authoritative runtime recovery state.
 */
export function createDispatcherAgent(deps: DispatcherAgentDeps): TeammateService {
  const agent = createTeammateService({
    dispatcherId: deps.id,
    identity: deps.identity,
    config: deps.config,
    agentRuntimeProviders: deps.agentRuntimeProviders,
    identities: deps.identities,
    turnsStore: deps.turnsStore,
    // The dispatcher agent has no worktree — it neither spawns nor closes, so it
    // never reaches the worktree manager (issue #233 Phase 5).
    log: deps.log,
    nextSubmissionSeq: createDispatcherSubmissionSeq(),
    routeSettledCompletion: (producerName, turnId, completion) =>
      routeSettled(deps.router, producerName, turnId, completion),
    options: {
      mcpServers: deps.mcpServers,
      runtimeId: dispatcherRuntimeId(deps.id),
      ownsWorktreeOnClose: false,
      loggerFields: {},
      assertIdentityScope: assertDispatcherRootAgent,
      skillSources: [{
        name: 'dispatcher',
        path: bundledDispatcherSkillRoot(),
        source: 'dreamux-core',
      }],
      disableFeatures: [DISABLE_FEATURE_CRON],
      systemPrompt: {
        replace: DREAMUX_DISPATCHER_BASE_INSTRUCTIONS,
        append: [DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS],
      },
    },
  });
  return agent;
}

function createDispatcherSubmissionSeq(): () => number {
  let seq = 0;
  return () => ++seq;
}

async function routeSettled(
  router: CompletionRouter,
  producerName: string,
  turnId: string,
  completion: CompletionEnvelope,
): Promise<void> {
  await router.settle(completionKey(producerName, turnId), completion);
}
