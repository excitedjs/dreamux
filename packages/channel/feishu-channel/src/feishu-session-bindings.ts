/**
 * Every routing decision an operator can make, and what it does to live state.
 *
 * A bind is four things at once — the durable row, the presentation fence for
 * whoever used to own the target, the fence release for whoever owns it now,
 * and the card that tells the conversation. Keeping them in one place is what
 * stops three of them from drifting apart, which is how the Core version of
 * this ended up re-deriving route ownership in two services.
 *
 * Card delivery is handed in rather than done here: it needs the session's
 * lifecycle fence and bounded-send policy, and this module needs neither.
 */
import type { JsonValue } from '@excitedjs/dreamux-types';
import { PublicInvokeFailure } from '@excitedjs/dreamux-utils';

import { commandErrorCode } from './feishu-submit.js';

import {
  bindingBoundCard,
  bindingUnboundCard,
  spaceBoundCard,
  spaceUnboundCard,
} from './feishu-binding-notification-card.js';
import type { FeishuCotSessionSeam } from './feishu-cot-session.js';
import type { FeishuSpaceRecord } from './routing/document.js';
import type {
  FeishuRemovedRoute,
  FeishuRouting,
} from './routing/index.js';
import {
  chatTarget,
  isBindableTarget,
  topicTarget,
  type FeishuTarget,
} from './routing/target.js';
import type {
  FeishuBindTargetSelector,
  FeishuSpacePolicyInput,
} from './tools/types.js';

export interface FeishuBindingOperationsOptions {
  readonly routing: FeishuRouting;
  readonly cot: FeishuCotSessionSeam;
  /** Ask Core a canonical Command, through the neutral in-process port. */
  invoke(command: string, payload: JsonValue): Promise<JsonValue>;
  /**
   * Send a card into a target, best effort. `anchorTeamName` is the Team whose
   * next presentation may fall back to the sent message.
   */
  notify(
    target: FeishuTarget,
    card: unknown,
    anchorTeamName: string | null,
  ): void;
}

export class FeishuBindingOperations {
  constructor(private readonly opts: FeishuBindingOperationsOptions) {}

  async bindChannel(input: {
    target: FeishuBindTargetSelector;
    teamName: string;
    display: string | null;
    /** Set when the caller may only claim free or already-own routes. */
    requireOwner?: string;
  }): Promise<{ team_name: string; previous_team_name: string | null }> {
    const target = selectorTarget(input.target);
    if (!isBindableTarget(target)) {
      throw new PublicInvokeFailure(
        'A Feishu direct message chat cannot be bound to a Team. Bind a ' +
          'group, or a topic inside one.',
      );
    }
    await this.requireRoutableTeam(input.teamName);
    const { previousTeamName } = await this.opts.routing.bind({
      target,
      teamName: input.teamName,
      display: input.display,
      origin: 'manual',
      spaceId: null,
      ...(input.requireOwner !== undefined
        ? { requireOwner: input.requireOwner }
        : {}),
    });
    if (previousTeamName !== null && previousTeamName !== input.teamName) {
      this.opts.cot.onRouteReleased({ teamName: previousTeamName, target });
    }
    this.opts.cot.onRouteClaimed({ teamName: input.teamName, target });
    this.opts.notify(
      target,
      bindingBoundCard({
        target,
        display: input.display,
        teamName: input.teamName,
        spaceName: null,
      }),
      input.teamName,
    );
    return { team_name: input.teamName, previous_team_name: previousTeamName };
  }

  /**
   * Refuse to route a conversation to a Team that cannot answer in it.
   *
   * Where a message goes is this Channel's own decision, but whether a Team
   * exists and is open is Core's fact, so it is asked rather than assumed —
   * before the row is written and before the conversation is told, since a
   * binding card naming a Team that is gone is worse than no binding at all.
   * This is the only moment the question can be asked; a Team that dissolves
   * afterwards still converges through the `team.closed` event.
   *
   * Only a definite answer refuses. Core proving the Team missing or closed is
   * one, and so is a `closed` status; any other reply already proves a Team
   * answered to that name, whatever else it says.
   */
  private async requireRoutableTeam(teamName: string): Promise<void> {
    let answer: JsonValue;
    try {
      answer = await this.opts.invoke('team.status', { team_name: teamName });
    } catch (error) {
      const code = commandErrorCode(error);
      if (code !== 'TEAM_NOT_FOUND' && code !== 'TEAM_CLOSED') throw error;
      throw new PublicInvokeFailure(
        `There is no Team named ${JSON.stringify(teamName)} to route this ` +
          'conversation to. Bind an open Team, or create one first.',
      );
    }
    if (teamStatusOf(answer) === 'closed') {
      throw new PublicInvokeFailure(
        `Team ${JSON.stringify(teamName)} is closed and can no longer ` +
          'answer here. Bind an open Team instead.',
      );
    }
  }

  async unbindChannel(
    selector: FeishuBindTargetSelector,
    requireOwner?: string,
  ): Promise<{ team_name: string | null }> {
    const target = selectorTarget(selector);
    const display = this.opts.routing.bindingFor(target)?.display ?? null;
    const teamName = await this.opts.routing.unbind(target, requireOwner);
    if (teamName === null) return { team_name: null };
    this.opts.cot.onRouteReleased({ teamName, target });
    this.opts.notify(
      target,
      bindingUnboundCard({ target, display, teamName }),
      null,
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
    this.opts.notify(
      chatTarget(input.chatId, 'group'),
      spaceBoundCard(space),
      null,
    );
    return space;
  }

  async unbindSpace(spaceName: string): Promise<FeishuSpaceRecord | null> {
    const space = await this.opts.routing.unbindSpace(spaceName);
    if (space === null) return null;
    this.opts.notify(
      chatTarget(space.container_chat_id, 'group'),
      spaceUnboundCard(space),
      null,
    );
    return space;
  }

  /**
   * A closed Team's routes are gone; announce it where each one served.
   *
   * Removal already committed, and this only says so. Every row gets the same
   * two effects a manual unbind gets — the COT route release and the unbound
   * card — because to the conversation nothing else happened: it was routed to
   * a Team, and now it is not. The card falls back to the target description
   * when the removed row carried no display, exactly as an unbind does.
   *
   * Nothing here is awaited or retried. A card that does not arrive leaves the
   * route removed, which is the fact that mattered.
   */
  announceTeamClosed(input: {
    teamName: string;
    removed: readonly FeishuRemovedRoute[];
  }): void {
    for (const route of input.removed) {
      this.opts.cot.onRouteReleased({
        teamName: input.teamName,
        target: route.target,
      });
      this.opts.notify(
        route.target,
        bindingUnboundCard({
          target: route.target,
          display: route.display,
          teamName: input.teamName,
        }),
        null,
      );
    }
  }

  /** Automatic provisioning installed a route; announce it where it serves. */
  announceProvisioned(input: {
    target: FeishuTarget;
    display: string | null;
    teamName: string;
    spaceName: string;
  }): void {
    this.opts.cot.onRouteClaimed({
      teamName: input.teamName,
      target: input.target,
    });
    this.opts.notify(
      input.target,
      bindingBoundCard({
        target: input.target,
        display: input.display,
        teamName: input.teamName,
        spaceName: input.spaceName,
      }),
      input.teamName,
    );
  }
}

/** Read the Team status out of a `team.status` answer, if it states one. */
function teamStatusOf(answer: JsonValue): string | null {
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) {
    return null;
  }
  const team = (answer as Record<string, unknown>)['team'];
  if (team === null || typeof team !== 'object' || Array.isArray(team)) {
    return null;
  }
  const status = (team as Record<string, unknown>)['status'];
  return typeof status === 'string' ? status : null;
}

export function selectorTarget(
  selector: FeishuBindTargetSelector,
): FeishuTarget {
  return selector.threadId === undefined || selector.threadId === ''
    ? chatTarget(selector.chatId, 'group')
    : topicTarget(selector.chatId, selector.threadId);
}
