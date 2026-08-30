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
  /**
   * This preparation is what created the managed checkout.
   *
   * Whoever prepared it is the only one who may undo it: a checkout that was
   * already there belongs to whatever put it there, and an attempt that fails
   * must not reclaim it. The fact lives and dies with this in-memory result —
   * once the owning record exists, that record is the authority on the
   * checkout's fate, so persisting a second copy would only let the two drift.
   */
  createdCheckout: boolean;
}

/**
 * A Team's runtime directory, lent to an Agent that runs inside it.
 *
 * There is no worktree identity here on purpose. The Team's own record is the
 * single owner of the managed checkout it prepared and the single authority on
 * what happened to it; an Agent that merely runs in that directory records a
 * plain reuse-cwd workspace, so it can neither clean the Team's checkout on its
 * own close nor hold a second, drifting copy of the Team's cleanup state.
 */
export interface TeamWorkspaceLoan {
  sourceCwd: string;
  sourceRepo: string | null;
  runtimeCwd: string;
}

export type SpawnTeamMateRequest = SpawnTeamMateInput & {
  sharedWorkspace?: TeamWorkspaceLoan;
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
