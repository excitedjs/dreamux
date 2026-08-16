import type { AgentRuntimeSkillSource } from '@excitedjs/dreamux-types';

import type {
  AgentEntityCapabilities,
  AgentEntityCloseResult,
  AgentEntityHistoryQuery,
  AgentEntityHistoryResult,
  AgentEntityLastQuery,
  AgentEntityLastResult,
  AgentEntityRuntimeStatus,
  AgentEntitySendResult,
  AgentEntitySpawnResult,
  AgentEntityWorktreeIdentity,
} from '../agent-entity/types.js';

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
}

export interface SendTeamMateInput {
  name: string;
  prompt: string;
  intent?: string;
}

export interface CloseTeamMateInput {
  name: string;
  note: string;
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

/**
 * The narrow teammate-operations surface a dispatcher or team exposes to the
 * admin layer (issue #233). `TeammateCollection` implements it; the owning
 * service hands it out via a `get teammates()` so callers can drive the
 * collection without the service re-forwarding each verb. `Omit` hides the
 * scope-internal inputs — `sharedWorkspace` (injected by `TeamService.spawnTeamMate`)
 * and the history `teamId` (the scope is baked into the collection) — and the
 * lifecycle methods (`turns` / `stopAll` / `dispatcherWorkspace`) stay off the
 * interface entirely.
 */
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
  last(
    name: string,
    query?: number | AgentEntityLastQuery,
  ): Promise<AgentEntityLastResult>;
  getCapabilities(): AgentEntityCapabilities;
}
