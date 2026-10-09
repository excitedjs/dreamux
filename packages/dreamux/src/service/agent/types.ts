import type {
  AgentRuntimeProvider,
  AgentRuntimeSkillSource,
} from '@excitedjs/dreamux-types';

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
} from './identity.js';
import type { TeamMateWorktreeRequest } from '../worktree/types.js';

export interface SpawnTeamMateInput {
  name: string;
  prompt: string;
  agentRuntime?: string | undefined;
  cwd?: string;
  worktree?: TeamMateWorktreeRequest;
  intent: string;
  identity?: string | undefined;
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

/**
 * The provider and config one running runtime generation was launched with. It
 * lives here, below the runtime generation that produces it and the activity
 * reader that consumes it, so neither has to import the other.
 */
export interface RunningLaunch {
  provider: AgentRuntimeProvider<unknown>;
  config: unknown;
}

/** The scoped operations exposed by either member collection. */
export interface TeammateOps {
  spawn(input: SpawnTeamMateInput): Promise<AgentEntitySpawnResult>;
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
  getCapabilities(): Promise<AgentEntityCapabilities>;
}
