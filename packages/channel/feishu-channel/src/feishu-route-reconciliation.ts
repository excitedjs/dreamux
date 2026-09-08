/**
 * Remove routes whose Team can no longer answer.
 *
 * Two authoritative signals converge here: Core publishes a closed Team, or a
 * Command rejects a still-installed route as missing or closed. Both remove the
 * same durable rows; only what the conversation is told differs.
 */
import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import { errorMessage } from './feishu-submit.js';
import type { FeishuRemovedRoute, FeishuRouting } from './routing/index.js';
import { describeTarget } from './routing/target.js';

export type UnavailableTeamReason = 'team_closed' | 'route_ended' | 'stale_route';

/**
 * Which reason a rejected Command is evidence of.
 *
 * `TEAM_CLOSED` also covers a pending dissolve that may still be refused, so it
 * is only proof that this route ended — the final `team.state` is what proves
 * the Team closed. Every other proof that a route cannot answer is this Channel
 * correcting its own document, and says nothing to the group.
 */
export function unavailableTeamReason(
  code: string | null,
): UnavailableTeamReason {
  return code === 'TEAM_CLOSED' ? 'route_ended' : 'stale_route';
}

export class FeishuRouteReconciliation {
  constructor(private readonly opts: {
    dispatcherId: string;
    channelId: string;
    log: DreamuxLogger;
    routing: FeishuRouting;
    announceRoutesRemoved(input: {
      teamName: string;
      removed: readonly FeishuRemovedRoute[];
      reason: 'team_closed' | 'route_ended';
    }): void;
  }) {}

  /**
   * Commit the removal of every route to a Team, and say what it removed.
   *
   * All reasons reach the same durable change, so they share the one commit
   * path the store owns rather than growing a second authority beside it. A
   * commit that fails is logged and nothing more: the route is still live, and
   * the next message to it earns the same rejection and the same attempt.
   *
   * A final closed event announces dissolution; an admission rejection only
   * announces that the route ended. A missing Team stays silent: that is this
   * Channel correcting its own document on the way to delivering a message,
   * and telling a group about it would be noise about nothing the group did.
   */
  async forgetTeamRoutes(
    teamName: string,
    reason: UnavailableTeamReason,
  ): Promise<void> {
    const scope = {
      dispatcher_id: this.opts.dispatcherId,
      channel_id: this.opts.channelId,
      team_name: teamName,
      reason,
    };
    try {
      const { removed } = await this.opts.routing.forgetTeam(teamName);
      if (removed.length === 0) return;
      this.opts.log.info(
        { ...scope, targets: removed.map((row) => describeTarget(row.target)) },
        'removed Feishu bindings for a Team that can no longer answer',
      );
      // Past the commit: the rows are gone from disk, and what follows is
      // presentation over what they said.
      if (reason !== 'stale_route') {
        this.opts.announceRoutesRemoved({ teamName, removed, reason });
      }
    } catch (error) {
      this.opts.log.warn(
        { ...scope, err: { message: errorMessage(error) } },
        'could not commit the removal of Feishu bindings',
      );
    }
  }
}
