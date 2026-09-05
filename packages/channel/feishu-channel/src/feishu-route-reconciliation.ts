/**
 * Remove routes whose Team can no longer answer.
 *
 * Two authoritative signals converge here: Core publishes a closed Team, or a
 * Command rejects a still-installed route as missing/closed. Both remove the
 * same durable rows; only the real close is announced to its conversations.
 */
import type { ChannelCoreEvent, DreamuxLogger } from '@excitedjs/dreamux-types';

import type { FeishuCotSessionSeam } from './feishu-cot-session.js';
import { errorMessage } from './feishu-submit.js';
import type { FeishuRemovedRoute, FeishuRouting } from './routing/index.js';
import { describeTarget } from './routing/target.js';

export type UnavailableTeamReason = 'team_closed' | 'stale_route';

export class FeishuRouteReconciliation {
  constructor(private readonly opts: {
    dispatcherId: string;
    channelId: string;
    log: DreamuxLogger;
    routing: FeishuRouting;
    cot: FeishuCotSessionSeam;
    announceTeamClosed(input: {
      teamName: string;
      removed: readonly FeishuRemovedRoute[];
    }): void;
  }) {}

  /**
   * The single subscription, demultiplexed.
   *
   * Nothing here awaits. The COT seam projects synchronously, and a closed
   * Team's routes are removed through the store's ordinary commit, queued
   * rather than waited on, because the event stream must not stall behind a
   * disk write. Until that commit lands one more message can still route to
   * the closed Team — Core rejects it before admission, and the fallback
   * removes the route again on its way to the Dispatcher Agent.
   */
  onCoreEvent(event: ChannelCoreEvent): void {
    try {
      this.opts.cot.handle(event);
      if (event.kind !== 'team.state' || event.status !== 'closed') return;
      void this.forgetTeamRoutes(event.team_name, 'team_closed');
    } catch (error) {
      this.opts.log.warn(
        {
          dispatcher_id: this.opts.dispatcherId,
          channel_id: this.opts.channelId,
          event_kind: event.kind,
          err: { message: errorMessage(error) },
        },
        'Feishu core-event listener failed',
      );
    }
  }

  /**
   * Commit the removal of every route to a Team, and say what it removed.
   *
   * Both reasons reach the same durable change, so they share the one commit
   * path the store owns rather than growing a second authority beside it. A
   * commit that fails is logged and nothing more: the route is still live, and
   * the next message to it earns the same rejection and the same attempt.
   *
   * Only a closed Team is announced. That is a transition the conversation
   * lived through — it had a Team, and the Team ended — while a stale route is
   * this Channel correcting its own document on the way to delivering a
   * message, and telling a group about it would be noise about nothing the
   * group did.
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
      if (reason === 'team_closed') {
        this.opts.announceTeamClosed({ teamName, removed });
      }
    } catch (error) {
      this.opts.log.warn(
        { ...scope, err: { message: errorMessage(error) } },
        'could not commit the removal of Feishu bindings',
      );
    }
  }
}
