/**
 * Remove routes whose Team can no longer answer.
 *
 * Two proofs reach here, and only these two: Core publishes a Team's final
 * closed state, or a delivery this Channel already routed comes back rejected.
 * Both remove the same durable rows; only what the conversation is told
 * differs. A rejected slash command is not a third proof — see the note on the
 * command path in `feishu-channel.ts`.
 */
import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import { errorMessage } from './feishu-submit.js';
import type { FeishuRemovedRoute, FeishuRouting } from './routing/index.js';
import { describeTarget } from './routing/target.js';

export type RouteRemovalNotice = 'team_closed' | 'route_ended' | 'silent';

/**
 * What a rejected delivery tells the conversation.
 *
 * The message itself is already on its way to the Dispatcher Agent, and that
 * answer says nothing about routing, so this is the only chance to say the
 * route is gone. `TEAM_CLOSED` also covers a dissolve that is still pending and
 * may yet fail, so it proves only that this route ended — the final
 * `team.state` is what proves the Team closed. Any other rejection is this Channel correcting
 * its own document, which the group did not do and does not need told.
 */
export function rejectedDeliveryNotice(code: string | null): RouteRemovalNotice {
  return code === 'TEAM_CLOSED' ? 'route_ended' : 'silent';
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
   * The first caller to empty the rows is also the only one with anything to
   * announce, so the notice is the caller's to state and never derived from
   * the removal. A final closed event announces dissolution; a rejected
   * delivery announces only that the route ended. Silent is a full removal
   * whose conversation has nothing to be told.
   */
  async forgetTeamRoutes(
    teamName: string,
    notice: RouteRemovalNotice,
  ): Promise<void> {
    const scope = {
      dispatcher_id: this.opts.dispatcherId,
      channel_id: this.opts.channelId,
      team_name: teamName,
      reason: notice,
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
      if (notice !== 'silent') {
        this.opts.announceRoutesRemoved({ teamName, removed, reason: notice });
      }
    } catch (error) {
      this.opts.log.warn(
        { ...scope, err: { message: errorMessage(error) } },
        'could not commit the removal of Feishu bindings',
      );
    }
  }
}
