import type {
  AgentRuntimeSkillSource,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { ConversationProjection } from '../../channel/conversation-projection.js';
import type { DreamuxConfig } from '../../config/config.js';
import type {
  CompletionDeliveryPolicy,
  CompletionInitiator,
} from '../completion-router/index.js';
import type {
  AgentEntityRuntimeStatus,
  AgentEntitySubmissionResult,
} from '../agent-entity/types.js';
import type { AgentNameRegistry } from '../agent-entity/identity-store.js';
import type { DispatcherCoreEventPublisher } from '../dispatcher-core-events/index.js';
import type { SuffixGenerator } from '../name-allocator.js';
import type { AdmissionLedger } from '../teammate-service/admission-ledger.js';
import type { TeammateAgentMcp } from '../teammate-service/types.js';
import type { TeamMateSharedWorkspace } from '../teammate-collection/types.js';
import type { TeamStore } from '../team-collection/store.js';
import type {
  TeamCreateRequestIdentity,
  TeamLeaderLease,
} from '../team-collection/types.js';
import type { WorktreeManager } from '../worktree/manager.js';
import type { TeamService } from './index.js';

export interface TeamAvailability {
  admit<T>(task: () => Promise<T>): Promise<T>;
  completionInitiator(delegate: CompletionInitiator): CompletionInitiator;
}

export interface TeamServiceCreateInput {
  teamId: string;
  name: string;
  /** Written into the published Team record; absent for internal creation. */
  createRequest?: TeamCreateRequestIdentity;
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

export interface TeamServiceDeps {
  dispatcherId: string;
  config: DreamuxConfig;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  worktrees: WorktreeManager;
  /**
   * This Team's own root directory, bound by `TeamCollection` when it
   * constructed this service. The TeamLeader's `identity.json`, the Team
   * `record.json`, this Team's cron jobs, and its `teammate/` collection all sit
   * directly under it — the Team never rebuilds the path from ids.
   */
  teamRoot: string;
  /** The dispatcher-global agent-name namespace. */
  names: AgentNameRegistry;
  admissions: AdmissionLedger;
  conversationProjection?: ConversationProjection;
  completionDelivery: CompletionDeliveryPolicy;
  /**
   * Where a completion is delivered, resolved from ownership rather than from
   * the producing record: this Team's own leader reports to the dispatcher
   * Agent, and every TeamMate this Team owns reports to this Team's leader.
   */
  leaderCompletionInitiator: () => Promise<CompletionInitiator | null>;
  teamMateCompletionInitiator: () => Promise<CompletionInitiator | null>;
  isShuttingDown: () => boolean;
  admitOperation: <T>(task: () => Promise<T>) => Promise<T>;
  availability: TeamAvailability;
  withTeamLeaderLease: <T>(
    lease: TeamLeaderLease,
    task: (service: TeamService) => Promise<T>,
  ) => Promise<T>;
  leaderMcp: (input: {
    teamId: string;
    leaderName: string;
  }) => TeammateAgentMcp;
  trackMaterialized: (service: TeamService) => void;
  store: TeamStore;
  agentNameSuffixGenerator?: SuffixGenerator;
  coreEvents?: DispatcherCoreEventPublisher;
  evict: (service: TeamService) => void;
  log: DreamuxLogger;
  workflowLog: DreamuxLogger;
}
