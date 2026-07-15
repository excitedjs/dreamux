import type { DreamuxConfig } from '../../config/config.js';
import { defaultWorkspaceEnabled } from '../../config/config.js';
import type { WorktreeManager } from '../worktree/manager.js';
import { dispatcherWorkspace } from '../worktree/workspaces.js';
import type { TeamCreateInput } from './types.js';

export async function prepareTeamWorkspace(input: {
  config: DreamuxConfig;
  dispatcherId: string;
  worktrees: WorktreeManager;
  teamId: string;
  request: Pick<TeamCreateInput, 'repoCwd' | 'worktree'>;
}) {
  const workspaceRoot = await dispatcherWorkspace(
    input.config,
    input.dispatcherId,
  );
  if (input.request.worktree === undefined && input.request.repoCwd === undefined) {
    return input.worktrees.prepareDefaultWorkspace({
      dispatcherWorkspace: workspaceRoot,
      slug: input.teamId,
      workspaceEnabled: defaultWorkspaceEnabled(
        input.config,
        input.dispatcherId,
      ),
    });
  }
  return input.worktrees.prepare({
    dispatcherId: input.dispatcherId,
    teammateName: `team-${input.teamId}`,
    cwd: input.request.repoCwd ?? workspaceRoot,
    dispatcherWorkspace: workspaceRoot,
    request: input.request.worktree ?? {
      mode: 'managed',
      slug: `team-${input.teamId}`,
      cleanup: 'keep',
    },
  });
}
