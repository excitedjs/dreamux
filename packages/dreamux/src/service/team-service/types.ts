import type {
  AgentRuntimeSkillSource,
  DreamuxLogger,
  TeamSubmitResult,
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
import type { TurnAdmission } from '../teammate-service/turn-recording.js';
import type { TeammateAgentMcp } from '../teammate-service/types.js';
import type { TeamMateSharedWorkspace } from '../teammate-collection/types.js';
import type { TeamStore } from '../team-collection/store.js';
import type {
  TeamCreateRequestIdentity,
} from '../team-collection/types.js';
import type { WorktreeManager } from '../worktree/manager.js';

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

/**
 * What one Team is built from.
 *
 * Collaborators and shared dispatcher facts only: nothing here reaches back
 * into the collection that constructed the Team. A Team is handed what it
 * needs, does its own work with it, and states what happened by publishing its
 * own terminal fact — so its owner learns of its end without the Team ever
 * calling upward into its owner's lifecycle.
 */
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
   * Where this Team's own leader reports: the dispatcher Agent that owns the
   * Team. Every TeamMate this Team owns reports to this Team's leader, which
   * the Team answers for itself.
   */
  leaderCompletionInitiator: () => Promise<CompletionInitiator | null>;
  admitOperation: <T>(task: () => Promise<T>) => Promise<T>;
  leaderMcp: (input: {
    teamId: string;
    leaderName: string;
  }) => TeammateAgentMcp;
  store: TeamStore;
  agentNameSuffixGenerator?: SuffixGenerator;
  coreEvents?: DispatcherCoreEventPublisher;
  log: DreamuxLogger;
  workflowLog: DreamuxLogger;
}

/**
 * One Team is over.
 *
 * Published once, after that Team's own record is durably `closed` — the only
 * fact that makes it true. Its owner drops the exact instance that published
 * it; nothing else is asked of a listener, and nothing a listener does can
 * change what already happened.
 */
export interface TeamClosedFact {
  readonly schema_version: 1;
  readonly kind: 'team.closed';
  readonly dispatcher_id: string;
  readonly team_id: string;
  readonly closed_at: number;
}

export interface TeamClosedSubscription {
  unsubscribe(): void;
}

/**
 * The canonical public receipt of one TeamLeader submission.
 *
 * The one submission projection that is not a copy: the provider seam's
 * internal `skipped` is normalized to `stopped` here, and a duplicate is
 * reported without a turn identity it never got. Both caller-facing surfaces
 * read this, so the receipt cannot mean two things.
 */
export function teamSubmitResult(admission: TurnAdmission): TeamSubmitResult {
  switch (admission.status) {
    case 'submitted':
      return { status: 'submitted', turn_id: admission.turn.id };
    case 'duplicate':
      // Core returned before runtime admission, so there is no second turn
      // identity to report.
      return { status: 'duplicate' };
    case 'stopped':
      return { status: 'stopped' };
    // The provider seam's internal `skipped` is normalized at this boundary.
    case 'skipped':
      return {
        status: 'stopped',
        error: { code: 'TURN_SKIPPED', message: 'turn skipped' },
      };
    case 'failed':
      return {
        status: 'failed',
        error: { code: 'TEAM_SUBMIT_FAILED', message: admission.error.message },
      };
    case 'ambiguous':
      return {
        status: 'ambiguous',
        error: {
          code: 'TEAM_SUBMIT_AMBIGUOUS',
          message: admission.error.message,
        },
      };
  }
}
