/**
 * Every routing decision an operator can make, and what it does to live state.
 *
 * A bind is four things at once — the durable row, the presentation fence for
 * whoever used to own the target, the fence release for whoever owns it now,
 * and the card that tells the conversation, which once it is on screen is also
 * the new Team leader's first COT anchor if it has none. Keeping them in one
 * place is what stops three of them from drifting apart, which is how the Core
 * version of this ended up re-deriving route ownership in two services.
 *
 * Route removal is the same authority from its other end: a Team's final
 * closed event and a delivery this Channel already routed coming back
 * rejected are the only two proofs that a route no longer answers, and both
 * commit through the one path bind/unbind already own rather than growing a
 * second authority beside it.
 *
 * Card delivery is handed in rather than done here: it needs the session's
 * lifecycle fence and bounded-send policy, and this module needs neither.
 */
import type { FeishuOutbound } from '../outbound/index.js';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import { PublicInvokeFailure } from '@excitedjs/dreamux-utils';

import {
  bindingBoundCard,
  bindingRouteEndedCard,
  bindingUnboundCard,
  spaceBoundCard,
  spaceUnboundCard,
  teamDissolvedCard,
} from '../cards/binding-notification.js';
import type { FeishuCotAdapter } from '../cot/adapter.js';
import type { FeishuCoreCommands } from '../feishu-core-commands.js';
import { errorMessage } from '../feishu-submit.js';
import type { FeishuSpaceRecord } from './document.js';
import type { FeishuRemovedRoute, FeishuRouting } from './index.js';
import {
  chatTarget,
  describeTarget,
  isBindableTarget,
  sameTarget,
  type FeishuTarget,
} from './target.js';

export type RouteRemovalNotice = 'team_closed' | 'route_ended' | 'silent';

/** `bindSpace`'s own input — the Collaboration Space policy an operator sets. */
export interface FeishuSpacePolicyInput {
  spaceName: string;
  chatId: string;
  display: string | null;
  leaderAgentRuntime: string;
  identity: string | null;
  repo: { path: string; base_ref: string | null } | null;
}

/**
 * What a rejected delivery tells the conversation.
 *
 * The message itself is already on its way to the Dispatcher Agent, and that
 * answer says nothing about routing, so this is the only chance to say the
 * route is gone. `TEAM_CLOSED` also covers a dissolve that is still pending and
 * may yet fail, so it proves only that this route ended — the final
 * `team.state` is what proves the Team closed. A `TEAM_NOT_FOUND` rejection is
 * this Channel correcting its own document, which the group did not do and
 * does not need told.
 */
export function rejectedDeliveryNotice(
  code: 'TEAM_NOT_FOUND' | 'TEAM_CLOSED',
): RouteRemovalNotice {
  return code === 'TEAM_CLOSED' ? 'route_ended' : 'silent';
}

export interface FeishuBindingOperationsOptions {
  readonly dispatcherId: string;
  readonly channelId: string;
  readonly log: DreamuxLogger;
  readonly routing: FeishuRouting;
  readonly cot: FeishuCotAdapter;
  readonly commands: FeishuCoreCommands;
  /**
   * Send a card into a target, best effort, replying under `replyTo` when the
   * caller has one. For a `group`/`p2p` target `replyTo` is always `null` — a
   * fresh top-level message is the only option. For a topic, `null` means the
   * caller knows no root for it: the notifier asks the platform, and skips
   * only when that cannot say either, rather than guess where in the topic to
   * land. `onSent` runs only once the platform accepted the card.
   */
  readonly outbound: Pick<FeishuOutbound, 'notify'>;
}

export class FeishuBindingOperations {
  constructor(private readonly opts: FeishuBindingOperationsOptions) {}

  /**
   * What a bind card does once it is really on screen: it is offered as the
   * Team leader's first COT anchor, which the leader takes only while it has
   * none. The card's own message id is the whole offer. The topic root the
   * card replied under is a reply address, a different fact, and nothing here
   * reads it back.
   *
   * The send is asynchronous, so the row that announced the Team may be gone or
   * moved by the time the card lands. The offer is judged against the routing
   * document then, not against the bind that scheduled it: a card in a
   * conversation the Team no longer serves anchors nothing.
   */
  private offerAsFirstAnchor(
    teamName: string,
    target: FeishuTarget,
  ): (messageId: string) => void {
    return (messageId) => {
      const binding = this.opts.routing.bindingFor(target);
      if (binding?.team_name !== teamName) return;
      this.opts.cot.setFallbackAnchorIfAbsent(teamName, {
        chatId: target.chatId,
        messageId,
        target,
        servingTarget: target,
      });
    };
  }

  async bindChannel(input: {
    target: FeishuTarget;
    teamName: string;
    display: string | null;
    /** Announce in the conversation that requested the bind, when provided. */
    announceIn?: FeishuTarget;
    /**
     * The message `/bind` was typed in reply-chain terms, when the command
     * pipeline has one. Used only when `announceIn` is a topic with no
     * binding of its own yet, so its own announcement still has a root to
     * reply under; a `bindChannel` call with no message id in hand (MCP
     * `bind_channel`, an extension's `bindTeam`) simply omits it.
     */
    announceMessageId?: string;
    /** Set when the caller may only claim free or already-own routes. */
    requireOwner?: string;
  }): Promise<{ team_name: string; previous_team_name: string | null }> {
    const target = input.target;
    if (!isBindableTarget(target)) {
      throw new PublicInvokeFailure(
        'A Feishu direct message chat cannot be bound to a Team. Bind a ' +
          'group, or a topic inside one.',
      );
    }
    const team = await this.opts.commands.teamStatus(input.teamName);
    if (team.status === 'closed') {
      throw new PublicInvokeFailure(
        `Team ${JSON.stringify(input.teamName)} is closed and can no longer ` +
          'answer here. Bind an open Team instead.',
      );
    }
    if (
      team.team_name === '' ||
      team.leader_name === '' ||
      team.leader_agent_runtime === '' ||
      team.runtime_cwd === '' ||
      team.leader_state === null
    ) {
      throw new PublicInvokeFailure(
        `Team ${JSON.stringify(input.teamName)} has no readable TeamLeader identity; its creation did not complete.`,
      );
    }
    // No manual bind path (this one, MCP `bind_channel`, an extension's
    // `bindTeam`) ever has a message id to give — only automatic provisioning
    // does, directly through `FeishuRouting.bind`, which keeps the root a
    // provisioned topic already holds when a rebind (e.g. moving it to another
    // Team) carries none. A topic still without one learns it afterwards: from
    // the first message accepted in it, or from the platform when a notice
    // needs it first.
    const { previousTeamName, rootMessageId } = await this.opts.routing.bind({
      target,
      teamName: input.teamName,
      display: input.display,
      spaceId: null,
      rootMessageId: null,
      ...(input.requireOwner !== undefined
        ? { requireOwner: input.requireOwner }
        : {}),
    });
    this.presentCommittedBind({
      ...input,
      previousTeamName,
      rootMessageId,
      leaderName: team.leader_name,
      agentRuntime: team.leader_agent_runtime,
      runtimeCwd: team.runtime_cwd,
    });
    return { team_name: input.teamName, previous_team_name: previousTeamName };
  }

  async unbindChannel(
    target: FeishuTarget,
    requireOwner?: string,
  ): Promise<{ team_name: string | null }> {
    const removed = await this.opts.routing.unbind(target, requireOwner);
    if (removed === null) return { team_name: null };
    const { teamName, display } = removed;
    this.opts.cot.onRouteReleased({ teamName, target });
    this.opts.outbound.notify(
      target,
      bindingUnboundCard({ target, display, teamName }),
      target.kind === 'topic' ? removed.rootMessageId : null,
    );
    return { team_name: teamName };
  }

  async bindSpace(input: FeishuSpacePolicyInput): Promise<FeishuSpaceRecord> {
    const space = await this.opts.routing.bindSpace({
      spaceName: input.spaceName,
      containerChatId: input.chatId,
      display: input.display,
      leaderAgentRuntime: input.leaderAgentRuntime,
      identity: input.identity,
      repo: input.repo,
    });
    this.opts.outbound.notify(
      chatTarget(input.chatId, 'group'),
      spaceBoundCard(space),
      null,
    );
    return space;
  }

  async unbindSpace(spaceName: string): Promise<FeishuSpaceRecord | null> {
    const space = await this.opts.routing.unbindSpace(spaceName);
    if (space === null) return null;
    this.opts.outbound.notify(
      chatTarget(space.container_chat_id, 'group'),
      spaceUnboundCard(space),
      null,
    );
    return space;
  }

  /**
   * Announce committed route removal using only its confirmed cause.
   *
   * Private: `forgetTeamRoutes` is its only caller now that route removal and
   * its announcement live on the same class.
   */
  private announceRoutesRemoved(input: {
    teamName: string;
    removed: readonly FeishuRemovedRoute[];
    reason: 'team_closed' | 'route_ended';
  }): void {
    const card =
      input.reason === 'team_closed'
        ? teamDissolvedCard
        : bindingRouteEndedCard;
    for (const route of input.removed) {
      this.opts.outbound.notify(
        route.target,
        card({
          target: route.target,
          display: route.display,
          teamName: input.teamName,
        }),
        route.target.kind === 'topic' ? route.rootMessageId : null,
      );
    }
  }

  /** Present a committed bind, then announce it in the requested conversation. */
  presentCommittedBind(input: {
    previousTeamName: string | null;
    rootMessageId: string | null;
    target: FeishuTarget;
    display: string | null;
    teamName: string;
    leaderName: string;
    agentRuntime: string;
    runtimeCwd: string;
    announceIn?: FeishuTarget;
    announceMessageId?: string;
  }): void {
    const { previousTeamName } = input;
    const displaced =
      previousTeamName !== null && previousTeamName !== input.teamName;
    if (displaced) {
      this.opts.cot.onRouteReleased({
        teamName: previousTeamName,
        target: input.target,
      });
    }
    this.opts.cot.onRouteClaimed({
      teamName: input.teamName,
      target: input.target,
    });
    const announce = input.announceIn ?? input.target;
    // The bound target uses its committed root. An alternate receipt uses its
    // own topic root, then the invoking message, then the notifier's lookup.
    const replyTo = sameTarget(announce, input.target)
      ? input.rootMessageId
      : (this.opts.routing.bindingFor(announce)?.root_message_id ??
        input.announceMessageId ??
        null);
    this.opts.outbound.notify(
      announce,
      bindingBoundCard({
        target: input.target,
        display: input.display,
        teamName: input.teamName,
        leaderName: input.leaderName,
        agentRuntime: input.agentRuntime,
        runtimeCwd: input.runtimeCwd,
        ...(displaced ? { previousTeamName } : {}),
      }),
      replyTo,
      // An alternate receipt must not become the bound Team's first card.
      sameTarget(announce, input.target)
        ? this.offerAsFirstAnchor(input.teamName, input.target)
        : undefined,
    );
  }

  /**
   * Commit the removal of everything that reaches a Team — its routes and the
   * documents it followed — and say what it removed.
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
      const { removed, subscriptions } =
        await this.opts.routing.forgetTeam(teamName);
      if (removed.length === 0 && subscriptions.length === 0) return;
      this.opts.log.info(
        {
          ...scope,
          targets: removed.map((row) => describeTarget(row.target)),
          // Logged rather than announced: a dropped subscription has no
          // conversation to announce into.
          document_tokens: subscriptions.map((row) => row.file_token),
        },
        'removed Feishu routes for a Team that can no longer answer',
      );
      // Past the commit: the rows are gone from disk, and what follows is
      // presentation over what they said.
      for (const route of removed) {
        this.opts.cot.onRouteReleased({ teamName, target: route.target });
      }
      if (notice !== 'silent') {
        this.announceRoutesRemoved({ teamName, removed, reason: notice });
      }
    } catch (error) {
      this.opts.log.warn(
        { ...scope, err: { message: errorMessage(error) } },
        'could not commit the removal of Feishu routes',
      );
    }
  }
}
