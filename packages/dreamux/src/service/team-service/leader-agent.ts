import type {
  AgentRuntimeMcpServer,
  AgentRuntimeSkillSource,
  AgentRuntimeSystemPrompt,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { DreamuxConfig } from '../../config/config.js';
import type { TeamMateIdentityStore } from '../teammate-collection/identity-store.js';
import type { TeamMateTurnsStore } from '../teammate-collection/turns-store.js';
import type { TeamMateIdentity } from '../teammate-collection/types.js';
import type { CompletionEnvelope } from '../completion-router/index.js';
import {
  createTeammateService,
} from '../teammate-service/factory.js';
import type { TeammateService } from '../teammate-service/index.js';
import type { WorktreeManager } from '../worktree/manager.js';

export interface TeamLeaderAgentDeps {
  dispatcherId: string;
  identity: TeamMateIdentity;
  mcpServers: readonly AgentRuntimeMcpServer[];
  skillSources: readonly AgentRuntimeSkillSource[];
  disableFeatures: readonly string[];
  systemPrompt?: AgentRuntimeSystemPrompt;
  config: DreamuxConfig;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  identities: TeamMateIdentityStore;
  turnsStore: TeamMateTurnsStore;
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
  return createTeammateService({
    dispatcherId: deps.dispatcherId,
    identity: deps.identity,
    launch: { kind: 'agent-ref' },
    options: {
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
