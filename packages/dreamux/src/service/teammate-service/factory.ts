import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { DreamuxConfig } from '../../config/config.js';
import type { CompletionEnvelope } from '../completion-router/index.js';
import type { AgentIdentityStore } from '../agent-entity/identity-store.js';
import type { AgentTurnsStore } from '../agent-entity/turns-store.js';
import type { AgentEntityIdentity } from '../agent-entity/types.js';
import type { WorktreeManager } from '../worktree/manager.js';
import {
  TeammateService,
  type TeammateServiceDeps,
  type TeammateServiceOptions,
} from './index.js';

export interface CreateTeammateServiceInput {
  dispatcherId: string;
  identity: AgentEntityIdentity;
  options: TeammateServiceOptions;
  config: DreamuxConfig;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  identities: AgentIdentityStore;
  turnsStore: AgentTurnsStore;
  worktrees?: WorktreeManager;
  log: DreamuxLogger;
  nextSubmissionSeq: () => number;
  trackSettleCapture?: (capture: Promise<void>) => void;
  routeSettledCompletion: (
    producerName: string,
    turnId: string,
    completion: CompletionEnvelope,
  ) => Promise<void>;
}

export function createTeammateService(
  input: CreateTeammateServiceInput,
): TeammateService {
  const deps: TeammateServiceDeps = {
    config: input.config,
    agentRuntimeProviders: input.agentRuntimeProviders,
    identities: input.identities,
    turnsStore: input.turnsStore,
    ...(input.worktrees !== undefined ? { worktrees: input.worktrees } : {}),
    log: input.log,
    nextSubmissionSeq: input.nextSubmissionSeq,
    ...(input.trackSettleCapture !== undefined
      ? { trackSettleCapture: input.trackSettleCapture }
      : {}),
    routeSettledCompletion: input.routeSettledCompletion,
  };

  return new TeammateService(
    deps,
    input.dispatcherId,
    input.identity,
    input.options,
  );
}
