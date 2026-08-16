import type { AgentRuntimeSkillSource } from '@excitedjs/dreamux-types';

import type { CompletionInitiator } from '../completion-router/index.js';
import type {
  AgentEntityRuntimeStatus,
  AgentEntitySubmissionResult,
} from '../agent-entity/types.js';
import type { TeamMateSharedWorkspace } from '../teammate-collection/types.js';

export interface TeamAvailability {
  admit<T>(task: () => Promise<T>): Promise<T>;
  completionInitiator(delegate: CompletionInitiator): CompletionInitiator;
}

export interface TeamLiveWriter {
  name: string;
  waitIdle: (() => Promise<void>) | undefined;
}

export interface TeamServiceCreateInput {
  teamId: string;
  name: string;
  nameClaimToken: string;
  prompt?: string;
  leaderAgentRuntime: string;
  intent: string;
  identity?: string;
  skillSources?: readonly AgentRuntimeSkillSource[];
  workspace: TeamMateSharedWorkspace;
}

export interface TeamSchedulerLifecycle {
  start(): Promise<void>;
  stop(): void;
}

export interface TeamServiceCreateOutput<Service> {
  service: Service;
  schedulerLifecycle: TeamSchedulerLifecycle;
  leaderResult: {
    teammate: AgentEntityRuntimeStatus;
    submission: AgentEntitySubmissionResult | null;
  };
}
