import type { ChannelRouteOwner, ChannelService } from '../channel-service/index.js';
import type { CollaborationSpaceService } from '../collaboration-space/index.js';
import type { TeamCollection } from '../team-collection/index.js';
import { TeamDissolveInterruptedError } from '../team-collection/errors.js';
import { projectInProgressDissolve } from '../team-collection/dissolve-lifecycle.js';
import type {
  AcceptedTeamDissolve,
  TeamDissolveCleanupPendingResult,
  TeamDissolveInput,
  TeamLeaderLease,
  TeamSummary,
} from '../team-collection/types.js';
import { invokeDispatcherChannelTool } from './channel-tool-invocation.js';

const TEAM_DISSOLVE_RESULT_BUDGET_MS = 9_000;

interface TeamChannelCoordinatorOptions {
  teams: TeamCollection;
  channels: ChannelService;
  collaborationSpaces: CollaborationSpaceService;
}

interface TeamChannelBindInput {
  teamId: string;
  channelId?: string;
  meta: Record<string, unknown>;
}

interface TeamLeaderChannelBindInput {
  lease: TeamLeaderLease;
  channelId?: string;
  meta: Record<string, unknown>;
}

/** Coordinates explicit Team lifecycle changes across collaboration and routes. */
export class TeamChannelCoordinator {
  constructor(private readonly opts: TeamChannelCoordinatorOptions) {}

  async dissolve(input: TeamDissolveInput, publicMethodEnteredAt: number) {
    const deadlineAt = publicMethodEnteredAt + TEAM_DISSOLVE_RESULT_BUDGET_MS;
    const accepted = await this.opts.collaborationSpaces.dissolveTeam({
      ...input,
      decisionDeadlineAt: deadlineAt,
    });
    return projectDispatcherDissolveResult(
      accepted,
      Math.max(0, deadlineAt - Date.now()),
    );
  }

  async dissolveForTeamLeader(input: {
    lease: TeamLeaderLease;
    note: string;
  }) {
    return (await this.opts.collaborationSpaces.dissolveTeamForLeader(input))
      .receipt;
  }

  async invokeChannelTool(
    input: Omit<
      Parameters<typeof invokeDispatcherChannelTool>[0],
      'channels'
    >,
  ): Promise<unknown> {
    if (input.caller.kind === 'team_leader') {
      return this.opts.teams.withTeamLeaderLease(
        {
          teamId: input.caller.teamId,
          leaderName: input.caller.leaderName,
        },
        () => invokeDispatcherChannelTool({
          channels: this.opts.channels,
          ...input,
        }),
      );
    }
    return invokeDispatcherChannelTool({
      channels: this.opts.channels,
      ...input,
    });
  }

  async bind(input: TeamChannelBindInput) {
    // Fail before detaching collaboration intent when the requested Team is
    // already unusable. The leased check inside the mutation closes the race
    // with a Team that starts dissolving after this inexpensive preflight.
    await this.opts.teams.requireRoutableTeamOwner(input.teamId);
    const channelId = this.opts.channels.resolveChannelId(input.channelId);
    const target = await this.opts.channels.resolveTarget(input.meta, channelId);
    return this.opts.collaborationSpaces.bindTargetRoute({
      teamId: input.teamId,
      channelId,
      target,
    });
  }

  async bindForTeamLeader(input: TeamLeaderChannelBindInput) {
    const channelId = this.opts.channels.resolveChannelId(input.channelId);
    const target = await this.opts.channels.resolveTarget(input.meta, channelId);
    return this.opts.collaborationSpaces.bindLeasedTargetRoute({
      lease: input.lease,
      channelId,
      target,
    });
  }

  async transferBack(input: {
    expectedOwner?: ChannelRouteOwner;
    channelId?: string;
    meta: Record<string, unknown>;
  }) {
    const channelId = this.opts.channels.resolveChannelId(input.channelId);
    const target = await this.opts.channels.resolveTarget(input.meta, channelId);
    return this.opts.collaborationSpaces.mutateTargetRoute(
      {
        channelId,
        target,
        ...(input.expectedOwner !== undefined
          ? { expectedOwner: input.expectedOwner }
          : {}),
      },
      () => this.opts.channels.transferResolvedTargetBack({
        ...(input.expectedOwner !== undefined
          ? { expectedOwner: input.expectedOwner }
          : {}),
        channelId,
        target,
      }),
    );
  }

  async transferBackForTeamLeader(input: {
    lease: TeamLeaderLease;
    channelId?: string;
    meta: Record<string, unknown>;
  }) {
    const channelId = this.opts.channels.resolveChannelId(input.channelId);
    const target = await this.opts.channels.resolveTarget(input.meta, channelId);
    const expectedOwner: ChannelRouteOwner = {
      kind: 'team',
      teamName: input.lease.teamId,
      leaderName: input.lease.leaderName,
    };
    return this.opts.collaborationSpaces.mutateLeasedTargetRoute(
      { lease: input.lease, channelId, target },
      () => this.opts.channels.transferResolvedTargetBack({
        expectedOwner,
        channelId,
        target,
      }),
    );
  }
}

/** Project a bounded Dispatcher result without cancelling accepted work. */
async function projectDispatcherDissolveResult(
  handle: AcceptedTeamDissolve,
  budgetMs: number,
): Promise<
  TeamSummary |
  AcceptedTeamDissolve['receipt'] |
  TeamDissolveCleanupPendingResult
> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), budgetMs);
    timer.unref();
  });
  try {
    const outcome = await Promise.race([
      handle.completed.then((summary) => ({ summary })),
      timeout,
    ]);
    return outcome === 'timeout'
      ? projectInProgressDissolve(handle)
      : outcome.summary;
  } catch (error) {
    if (error instanceof TeamDissolveInterruptedError) {
      return projectInProgressDissolve(handle);
    }
    throw error;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
