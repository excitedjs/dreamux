import type { AgentRuntimeTurnResult } from '@excitedjs/dreamux-types';

import type { AgentEntityRuntimeStatus } from '../agent-entity/types.js';
import type { SettledCompletionRoute } from '../teammate-service/index.js';
import type { SpawnTeamMateInput } from './types.js';

declare const ownedTeammateOwnerBrand: unique symbol;

/** Process-local identity of one operation that exclusively owns TeamMates. */
export type OwnedTeammateOwner = symbol & {
  readonly [ownedTeammateOwnerBrand]: never;
};

export function createOwnedTeammateOwner(): OwnedTeammateOwner {
  return Symbol('owned TeamMate operation') as OwnedTeammateOwner;
}

/** Inputs that bind every turn from a fresh TeamMate to one exclusive owner. */
export interface SpawnOwnedTeamMateOptions {
  owner: OwnedTeammateOwner;
  routeSettledCompletion: SettledCompletionRoute;
  outputSchema?: Record<string, unknown>;
}

/** Internal owned-spawn result before adapting the runtime turn to admin DTOs. */
export interface OwnedTeamMateSpawnResult {
  teammate: AgentEntityRuntimeStatus;
  turn: AgentRuntimeTurnResult;
}

/**
 * Server-local authority for creating and closing exclusively owned TeamMates.
 * It intentionally stays off the admin-facing teammate operations surface.
 */
export interface OwnedTeammateOps {
  spawnOwned(
    input: SpawnTeamMateInput,
    options: SpawnOwnedTeamMateOptions,
  ): Promise<OwnedTeamMateSpawnResult>;
  releaseAllOwned(owner: OwnedTeammateOwner): Promise<void>;
}
