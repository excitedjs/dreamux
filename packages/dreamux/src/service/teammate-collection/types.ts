import type {
  AgentRuntimeSkillSource,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { DreamuxConfig } from '../../config/config.js';
import type { AgentIdentityStore } from '../agent-entity/identity-store.js';
import type { AgentTurnsStore } from '../agent-entity/turns-store.js';
import type {
  AgentEntityCapabilities,
  AgentEntityCloseResult,
  AgentEntityHistoryQuery,
  AgentEntityHistoryResult,
  AgentEntityIdentity,
  AgentEntityLastResult,
  AgentEntityRuntimeStatus,
  AgentEntitySendResult,
  AgentEntitySpawnResult,
  AgentEntityWorktreeIdentity,
} from '../agent-entity/types.js';
import type {
  CompletionInitiator,
  CompletionRouter,
} from '../completion-router/index.js';
import type {
  TaskOperationInvocation,
  TaskTeamSubmissionBridge,
} from '../task-runtime-submission.js';
import type { WorktreeManager } from '../worktree/manager.js';
import type { SuffixGenerator } from './name-allocator.js';

export interface TeammateCollectionOptions {
  dispatcherId: string;
  teamScope: string | null;
  config: DreamuxConfig;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  worktrees: WorktreeManager;
  identities: AgentIdentityStore;
  turnsStore: AgentTurnsStore;
  router?: CompletionRouter;
  initiatorFor?: (
    producer: AgentEntityIdentity,
  ) => Promise<CompletionInitiator | null>;
  isShuttingDown?: () => boolean;
  taskSubmissionBridge?: TaskTeamSubmissionBridge;
  suffixGenerator?: SuffixGenerator;
  log: DreamuxLogger;
}

export interface TeamMateSharedWorkspace {
  sourceCwd: string;
  sourceRepo: string | null;
  runtimeCwd: string;
  worktree: AgentEntityWorktreeIdentity;
}

export type SpawnTeamMateRequest = SpawnTeamMateInput & {
  sharedWorkspace?: TeamMateSharedWorkspace;
};

export interface TeammateOps {
  spawn(
    input: Omit<SpawnTeamMateRequest, 'sharedWorkspace'>,
  ): Promise<AgentEntitySpawnResult>;
  send(input: SendTeamMateInput): Promise<AgentEntitySendResult>;
  close(input: CloseTeamMateInput): Promise<AgentEntityCloseResult>;
  list(): Promise<AgentEntityRuntimeStatus[]>;
  status(name: string): Promise<AgentEntityRuntimeStatus>;
  history(
    input: Omit<AgentEntityHistoryQuery, 'teamId'>,
  ): Promise<AgentEntityHistoryResult>;
  last(name: string, turns?: number): Promise<AgentEntityLastResult>;
  getCapabilities(): AgentEntityCapabilities;
}

export interface TeamMateWorktreeRequest {
  mode: 'reuse-cwd' | 'managed';
  slug?: string;
  base_ref?: string;
  branch?: string;
  cleanup?: 'keep' | 'delete-on-close';
}

export interface SpawnTeamMateInput {
  name: string;
  prompt: string;
  agentRuntime?: string;
  cwd?: string;
  worktree?: TeamMateWorktreeRequest;
  intent: string;
  identity?: string;
  /** Additional admin-supplied runtime skill roots; bundled role policy is separate. */
  skillSources?: readonly AgentRuntimeSkillSource[];
  /** Core-only task operation identity; never accepted from provider payloads. */
  taskInvocation?: TaskOperationInvocation;
}

export interface SendTeamMateInput {
  name: string;
  prompt: string;
  intent?: string;
  /** Core-only task operation identity; never accepted from provider payloads. */
  taskInvocation?: TaskOperationInvocation;
}

export interface CloseTeamMateInput {
  name: string;
  note: string;
}
