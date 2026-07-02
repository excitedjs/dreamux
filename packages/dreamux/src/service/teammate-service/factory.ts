import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { DreamuxConfig } from '../../config/config.js';
import type { CompletionEnvelope } from '../completion-router/index.js';
import type { TeamMateIdentityStore } from '../teammate-collection/identity-store.js';
import type { TeamMateTurnsStore } from '../teammate-collection/turns-store.js';
import type { TeamMateIdentity } from '../teammate-collection/types.js';
import type { WorktreeManager } from '../worktree/manager.js';
import {
  TeammateService,
  type RuntimeLaunchSpec,
  type TeammateServiceDeps,
  type TeammateServiceOptions,
} from './index.js';

type TeammateServiceBuildLaunch = NonNullable<TeammateServiceDeps['buildLaunch']>;

export type TeammateServiceLaunch =
  | {
      kind: 'agent-ref';
    }
  | {
      kind: 'inline';
      build: TeammateServiceBuildLaunch;
    };

export interface CreateTeammateServiceInput {
  dispatcherId: string;
  identity: TeamMateIdentity;
  launch: TeammateServiceLaunch;
  options?: TeammateServiceOptions;
  config: DreamuxConfig;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  identities: TeamMateIdentityStore;
  turnsStore: TeamMateTurnsStore;
  worktrees?: WorktreeManager;
  log: DreamuxLogger;
  nextSubmissionSeq: () => number;
  trackSettleCapture: (capture: Promise<void>) => void;
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
    ...(input.launch.kind === 'inline' ? { buildLaunch: input.launch.build } : {}),
    nextSubmissionSeq: input.nextSubmissionSeq,
    trackSettleCapture: input.trackSettleCapture,
    routeSettledCompletion: input.routeSettledCompletion,
  };

  return new TeammateService(
    deps,
    input.dispatcherId,
    input.identity,
    input.options,
  );
}

export type { RuntimeLaunchSpec };
