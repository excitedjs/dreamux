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
import {
  createTeammateService,
} from '../teammate-service/factory.js';
import {
  assertTeamScopedAgent,
  childAgentRuntimeId,
} from '../agent-entity/runtime-profile.js';
import type { TeammateService } from '../teammate-service/index.js';
import type { WorktreeManager } from '../worktree/manager.js';

export interface TeamLeaderAgentDeps {
  dispatcherId: string;
  identity: AgentEntityIdentity;
  mcpServers: readonly AgentRuntimeMcpServer[];
  skillSources: readonly AgentRuntimeSkillSource[];
  disableFeatures: readonly string[];
  systemPrompt?: AgentRuntimeSystemPrompt;
  config: DreamuxConfig;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  identities: AgentIdentityStore;
  turnsStore: AgentTurnsStore;
  worktrees: WorktreeManager;
  log: DreamuxLogger;
  nextSubmissionSeq: () => number;
  trackSettleCapture: (capture: Promise<void>) => void;
  routeSettledCompletion: (
    producerName: string,
    turnId: string,
    completion: CompletionEnvelope,
  ) => Promise<void>;
}

export function createTeamLeaderAgent(
  deps: TeamLeaderAgentDeps,
): TeammateService {
  const teamId = deps.identity.team_id;
  if (teamId === null) {
    throw new Error('TeamLeader identity must have a team_id');
  }
  return createTeammateService({
    dispatcherId: deps.dispatcherId,
    identity: deps.identity,
    options: {
      runtimeId: childAgentRuntimeId(deps.identity),
      ownsWorktreeOnClose: false,
      loggerFields: { teammate: deps.identity.name },
      assertIdentityScope: assertTeamScopedAgent(teamId),
      mcpServers: deps.mcpServers,
      skillSources: deps.skillSources,
      disableFeatures: deps.disableFeatures,
      ...(deps.systemPrompt !== undefined
        ? { systemPrompt: deps.systemPrompt }
        : {}),
    },
    config: deps.config,
    agentRuntimeProviders: deps.agentRuntimeProviders,
    identities: deps.identities,
    turnsStore: deps.turnsStore,
    worktrees: deps.worktrees,
    log: deps.log,
    nextSubmissionSeq: deps.nextSubmissionSeq,
    trackSettleCapture: deps.trackSettleCapture,
    routeSettledCompletion: deps.routeSettledCompletion,
  });
}
