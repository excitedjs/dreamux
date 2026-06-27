import type { CompletionEnvelope, DreamuxLogger } from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { DreamuxConfig } from '../../config/config.js';
import type { TeamMateIdentityStore } from '../teammate-collection/identity-store.js';
import type { TeamMateTurnsStore } from '../teammate-collection/turns-store.js';
import type {
  TeamMateIdentity,
  TeamMateLaunchPolicy,
} from '../teammate-collection/types.js';
import {
  createTeammateService,
} from '../teammate-service/factory.js';
import type { TeammateService } from '../teammate-service/index.js';
import type { WorktreeManager } from '../worktree/manager.js';

export interface TeamLeaderAgentDeps {
  dispatcherId: string;
  identity: TeamMateIdentity;
  launchPolicy: TeamMateLaunchPolicy;
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
    options: { launchPolicy: deps.launchPolicy },
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
