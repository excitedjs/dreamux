import {
  defaultWorkspaceEnabled,
  type DreamuxConfig,
} from '../../config/config.js';
import type { AgentEntityIdentity } from '../agent/identity.js';
import type {
  AgentEntityCollectionStore,
  AgentIdentityUpdateInput,
} from '../agent/store.js';
import type {
  SpawnTeamMateInput,
  TeamMateSharedWorkspace,
} from '../agent/types.js';
import { ensureDispatcherWorkspace } from '../dispatcher-workspace.js';
import { WorktreeManager } from './manager.js';

export async function resolveSpawnWorkspace(input: {
  config: DreamuxConfig;
  worktrees: WorktreeManager;
  dispatcherId: string;
  name: string;
  request: SpawnTeamMateInput;
}): Promise<TeamMateSharedWorkspace> {
  if (
    input.request.worktree === undefined &&
    (input.request.cwd === undefined || input.request.cwd.trim() === '')
  ) {
    return input.worktrees.prepareDefaultWorkspace({
      dispatcherWorkspace: await ensureDispatcherWorkspace(
        input.config,
        input.dispatcherId,
      ),
      slug: input.name,
      workspaceEnabled: defaultWorkspaceEnabled(
        input.config,
        input.dispatcherId,
      ),
    });
  }
  const cwd = input.request.cwd;
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new Error('TeamMate spawn requires cwd');
  }
  const managedMode =
    (input.request.worktree?.mode ?? 'reuse-cwd') === 'managed';
  return input.worktrees.prepare({
    dispatcherId: input.dispatcherId,
    teammateName: input.name,
    cwd,
    ...(managedMode
      ? {
          dispatcherWorkspace: await ensureDispatcherWorkspace(
            input.config,
            input.dispatcherId,
          ),
        }
      : {}),
    request: input.request.worktree,
  });
}

/**
 * Compute the patch that recovers a managed worktree whose checkout was
 * deleted, or the empty patch when there is nothing to recover.
 *
 * Returns a patch rather than writing it: the caller holds the one write
 * authority over this entity's identity (`AgentRuntimeStateStore.update`),
 * and a second writer reaching back into the identity store from inside this
 * function would be the nested `update()` call `TransactionalStore`'s own
 * `change` contract forbids.
 */
export async function reprepareDeletedManagedWorktree(input: {
  config: DreamuxConfig;
  /**
   * The collection's own occupancy query: the name of whichever sibling
   * already owns a given managed worktree path, or `null` when it is free.
   * Absent for an owner-root Agent (the dispatcher Agent, a TeamLeader),
   * which has no sibling collection.
   */
  siblings: Pick<AgentEntityCollectionStore, 'findManagedWorktreeOwner'> | null;
  worktrees: WorktreeManager;
  identity: AgentEntityIdentity;
}): Promise<AgentIdentityUpdateInput> {
  if (
    input.identity.worktree.mode !== 'managed' ||
    input.identity.worktree.cleanup_state !== 'deleted'
  ) {
    return {};
  }
  const workspace = await input.worktrees.prepare({
    dispatcherId: input.identity.dispatcher_id,
    teammateName: input.identity.name,
    cwd: input.identity.source_cwd,
    dispatcherWorkspace: await ensureDispatcherWorkspace(
      input.config,
      input.identity.dispatcher_id,
    ),
    request: {
      mode: 'managed',
      ...(input.identity.worktree.base_ref !== null
        ? { base_ref: input.identity.worktree.base_ref }
        : {}),
      ...(input.identity.worktree.branch !== null
        ? { branch: input.identity.worktree.branch }
        : {}),
      cleanup: input.identity.worktree.cleanup,
    },
  });
  await assertManagedWorktreeAvailable({
    siblings: input.siblings,
    name: input.identity.name,
    worktree: workspace.worktree,
  });
  return {
    sourceCwd: workspace.sourceCwd,
    sourceRepo: workspace.sourceRepo,
    cwd: workspace.runtimeCwd,
    runtimeCwd: workspace.runtimeCwd,
    worktree: workspace.worktree,
  };
}

/**
 * Refuse a managed worktree path another Agent in the same collection owns.
 *
 * `siblings` is the caller's actual collection-scoped occupancy
 * query, asked fresh for this one candidate path rather than handing over
 * every sibling's identity: an owner-root Agent (the dispatcher Agent, a
 * TeamLeader) has no sibling collection and never takes a managed worktree of
 * its own, so a null sibling owner means there is nothing to collide with.
 */
export async function assertManagedWorktreeAvailable(input: {
  siblings: Pick<AgentEntityCollectionStore, 'findManagedWorktreeOwner'> | null;
  name: string;
  worktree: AgentEntityIdentity['worktree'];
}): Promise<void> {
  if (input.worktree.mode !== 'managed' || input.siblings === null) {
    return;
  }
  const owner = await input.siblings.findManagedWorktreeOwner(
    input.worktree.path,
    input.name,
  );
  if (owner !== null) {
    throw new Error(
      `managed worktree path ${JSON.stringify(input.worktree.path)} is already ` +
        `owned by TeamMate ${JSON.stringify(owner)}`,
    );
  }
}
