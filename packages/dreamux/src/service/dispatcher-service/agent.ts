import type {
  AgentRuntimeMcpServer,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import {
  DISABLE_FEATURE_CRON,
  type AgentRuntimeProviderCatalog,
} from '../../agent-runtime/index.js';
import type { ConversationProjection } from '../../channel/conversation-projection.js';
import type { DreamuxConfig } from '../../config/config.js';
import type { AgentIdentityStore } from '../agent-entity/identity-store.js';
import {
  createTeammateService,
} from '../teammate-service/factory.js';
import {
  assertDispatcherRootAgent,
  dispatcherRuntimeId,
} from '../agent-entity/runtime-profile.js';
import type { TeammateService } from '../teammate-service/index.js';
import type { AgentEntityIdentity } from '../agent-entity/types.js';
import {
  DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS,
  DREAMUX_DISPATCHER_BASE_INSTRUCTIONS,
} from './base-prompt.js';
import {
  bundledDispatcherSkillRoot,
  bundledSharedSkillRoot,
} from '../../platform/paths.js';

export interface DispatcherAgentDeps {
  id: string;
  config: DreamuxConfig;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  log: DreamuxLogger;
  mcpServers: readonly AgentRuntimeMcpServer[];
  identity: AgentEntityIdentity;
  identities: AgentIdentityStore;
  conversationProjection: ConversationProjection;
}

/**
 * Build the dispatcher's own agent as a contained {@link TeammateService} (issue
 * #233 Phase 5). The dispatcher *has an* agent rather than *being* one: the
 * shared entity owns the runtime lifecycle (start/resume/stop), the
 * in-process Turn lifecycle and `completionInput` as a delivery target,
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
    conversationProjection: deps.conversationProjection,
    // The dispatcher agent has no worktree — it neither spawns nor closes, so it
    // never reaches the worktree manager (issue #233 Phase 5).
    log: deps.log,
    options: {
      mcpServers: deps.mcpServers,
      runtimeId: dispatcherRuntimeId(deps.id),
      ownsWorktreeOnClose: false,
      loggerFields: {},
      assertIdentityScope: assertDispatcherRootAgent,
      skillSources: [
        {
          name: 'dispatcher',
          path: bundledDispatcherSkillRoot(),
          source: 'dreamux-core',
        },
        {
          name: 'shared',
          path: bundledSharedSkillRoot(),
          source: 'dreamux-core',
        },
      ],
      disableFeatures: [DISABLE_FEATURE_CRON],
      systemPrompt: {
        replace: DREAMUX_DISPATCHER_BASE_INSTRUCTIONS,
        append: [DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS],
      },
    },
  });
  return agent;
}
