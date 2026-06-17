import type { DreamuxConfig } from '../../config/config.js';
import { ensureDispatcherWorkspace } from '../dispatcher-service/workspace.js';
import type { TeamMateIdentityStore } from '../teammate-collection/identity-store.js';
import type {
  SpawnTeamMateRequest,
  TeamMateSharedWorkspace,
} from '../teammate-collection/index.js';
import type { TeamMateIdentity } from '../teammate-collection/types.js';
import {
  type PreparedTeamMateWorkspace,
  WorktreeManager,
} from './manager.js';

export async function resolveSpawnWorkspace(input: {
  config: DreamuxConfig;
  worktrees: WorktreeManager;
  dispatcherId: string;
  name: string;
  request: SpawnTeamMateRequest;
}): Promise<PreparedTeamMateWorkspace | TeamMateSharedWorkspace> {
  if (input.request.sharedWorkspace !== undefined) {
    return input.request.sharedWorkspace;
  }
  if (
    input.request.worktree === undefined &&
    (input.request.cwd === undefined || input.request.cwd.trim() === '')
  ) {
    return input.worktrees.prepareDefaultWorkspace({
      dispatcherWorkspace: await dispatcherWorkspace(
        input.config,
        input.dispatcherId,
      ),
      slug: input.name,
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
          dispatcherWorkspace: await dispatcherWorkspace(
            input.config,
            input.dispatcherId,
          ),
        }
      : {}),
    request: input.request.worktree,
  });
}

export async function reprepareDeletedManagedWorktree(input: {
  config: DreamuxConfig;
  identities: TeamMateIdentityStore;
  worktrees: WorktreeManager;
  identity: TeamMateIdentity;
}): Promise<TeamMateIdentity> {
  if (
    input.identity.worktree.mode !== 'managed' ||
    input.identity.worktree.cleanup_state !== 'deleted'
  ) {
    return input.identity;
  }
  const workspace = await input.worktrees.prepare({
    dispatcherId: input.identity.dispatcher_id,
    teammateName: input.identity.name,
    cwd: input.identity.source_cwd,
    dispatcherWorkspace: await dispatcherWorkspace(
      input.config,
      input.identity.dispatcher_id,
    ),
    request: {
      mode: 'managed',
      ...(input.identity.worktree.slug !== null
        ? { slug: input.identity.worktree.slug }
        : {}),
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
    identities: input.identities,
    dispatcherId: input.identity.dispatcher_id,
    name: input.identity.name,
    worktree: workspace.worktree,
  });
  return input.identities.update(input.identity, {
    sourceCwd: workspace.sourceCwd,
    sourceRepo: workspace.sourceRepo,
    cwd: workspace.runtimeCwd,
    runtimeCwd: workspace.runtimeCwd,
    worktree: workspace.worktree,
  });
}

export async function assertManagedWorktreeAvailable(input: {
  identities: TeamMateIdentityStore;
  dispatcherId: string;
  name: string;
  worktree: TeamMateIdentity['worktree'];
}): Promise<void> {
  if (input.worktree.mode !== 'managed') return;
  const identities = await input.identities.list(input.dispatcherId);
  const collision = identities.find(
    (identity) =>
      identity.name !== input.name &&
      identity.worktree.mode === 'managed' &&
      identity.worktree.path === input.worktree.path,
  );
  if (collision !== undefined) {
    throw new Error(
      `managed worktree path ${JSON.stringify(input.worktree.path)} is already ` +
        `owned by TeamMate ${JSON.stringify(collision.name)}`,
    );
  }
}

export function dispatcherWorkspace(
  config: DreamuxConfig,
  dispatcherId: string,
): Promise<string> {
  return ensureDispatcherWorkspace(config, dispatcherId);
}
