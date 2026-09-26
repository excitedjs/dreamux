import type { DreamuxLogger, LaunchDraft } from '@excitedjs/dreamux-types';
import type { AsyncSeriesHook } from 'tapable';

import {
  DISABLE_FEATURE_CRON,
  type AgentRuntimeProviderCatalog,
} from '../../agent-runtime/index.js';
import type { ConversationProjection } from '../dispatcher-core-events/conversation-projection.js';
import type { ConfigReader } from '../../config/service.js';
import type { AgentIdentityStore } from '../agent/store.js';
import type { AgentServiceFactory } from '../agent/factory.js';
import { dispatcherRuntimeId } from '../agent/runtime-id.js';
import type { AgentService } from '../agent/service.js';
import type { AgentEntityIdentity } from '../agent/identity.js';
import type { TeammateAgentMcp } from '../agent/service-types.js';
import {
  DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS,
  DREAMUX_DISPATCHER_BASE_INSTRUCTIONS,
} from './base-prompt.js';
import {
  bundledDispatcherSkillRoot,
  bundledSharedSkillRoot,
} from '../../platform/paths.js';
import { composeLaunchDraft } from '../../plugin/hooks.js';

export interface DispatcherAgentDeps {
  id: string;
  /**
   * Forwarded verbatim into {@link AgentServiceFactory.create}'s own `config`
   * field: this factory itself never reads a fact off it, only builds the
   * contained `AgentService` that will call `.current()` at each launch
   * (`config/service.ts`'s `ConfigReader` doc).
   */
  config: ConfigReader;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  log: DreamuxLogger;
  mcp: TeammateAgentMcp;
  identity: AgentEntityIdentity;
  identities: AgentIdentityStore;
  onPersisted: (identity: AgentEntityIdentity) => void;
  agentServiceFactory: AgentServiceFactory;
  conversationProjection: ConversationProjection;
  /** This Dispatcher's `beforeLaunch` hook, run once per Agent construction. */
  beforeLaunch: AsyncSeriesHook<[LaunchDraft]>;
}

/**
 * Build the dispatcher's own agent as a contained {@link AgentService} (issue
 * #233 Phase 5). The dispatcher *has an* agent rather than *being* one: the
 * shared entity owns the runtime lifecycle (start/resume/stop), the
 * in-process Turn lifecycle and `completionInput` as a delivery target,
 * while `DispatcherService` keeps the dispatcher-only concerns (channel sessions,
 * restart-intent injection, MCP delegate assembly).
 *
 * The agent's runtime is resolved through the same `identity.agent_runtime ->
 * agents[]` path used by TeamLeader and TeamMate. Its `identity.json` is the
 * authoritative runtime recovery state.
 *
 * Plugin launch-draft instructions follow the built-in prompt on both prompt
 * channels, because Codex reads only `replace` and Claude Code only `append`;
 * plugin skill roots follow the bundled roots, fenced against them.
 */
export async function createDispatcherAgent(
  deps: DispatcherAgentDeps,
): Promise<AgentService> {
  const builtinSkills = [
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
  ];
  const draft = await composeLaunchDraft(deps.beforeLaunch, builtinSkills);
  return deps.agentServiceFactory.create({
    identity: deps.identity,
    config: deps.config,
    agentRuntimeProviders: deps.agentRuntimeProviders,
    identities: deps.identities,
    onPersisted: deps.onPersisted,
    conversationProjection: deps.conversationProjection,
    // The dispatcher agent has no worktree — it neither spawns nor closes, so it
    // never reaches the worktree manager (issue #233 Phase 5).
    log: deps.log,
    options: {
      mcp: deps.mcp,
      runtimeId: dispatcherRuntimeId(deps.id),
      // This Agent is the Dispatcher Service's own; the role follows from that.
      role: 'dispatcher',
      loggerFields: {},
      skillSources: [...builtinSkills, ...draft.skillSources],
      disabledFeatures: [DISABLE_FEATURE_CRON],
      systemPrompt: {
        replace: [
          DREAMUX_DISPATCHER_BASE_INSTRUCTIONS,
          ...draft.instructions,
        ].join('\n\n'),
        append: [DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS, ...draft.instructions],
      },
    },
  });
}
