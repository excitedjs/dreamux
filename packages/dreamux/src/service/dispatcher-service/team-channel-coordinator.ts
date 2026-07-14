import type { ChannelRouteOwner, ChannelService } from '../channel-service/index.js';
import type { CollaborationSpaceService } from '../collaboration-space/index.js';
import type { TeamCollection } from '../team-collection/index.js';
import type { TeamDissolveInput } from '../team-collection/types.js';

interface TeamChannelCoordinatorOptions {
  teams: TeamCollection;
  channels: ChannelService;
  collaborationSpaces: CollaborationSpaceService;
}

/** Coordinates explicit Team lifecycle changes across collaboration and routes. */
export class TeamChannelCoordinator {
  constructor(private readonly opts: TeamChannelCoordinatorOptions) {}

  async dissolve(input: TeamDissolveInput) {
    return this.opts.collaborationSpaces.dissolveTeam(input);
  }

  async bind(input: {
    teamId: string;
    channelId?: string;
    meta: Record<string, unknown>;
  }) {
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
}
