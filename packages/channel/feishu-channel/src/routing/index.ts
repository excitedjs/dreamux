/**
 * Feishu's authoritative answer to "where does this message go".
 *
 * This is the whole of what Core gave up. Core used to hold a binding store, a
 * target resolver, a fallback rule, a route-owner index, and a Collaboration
 * Space entity — all of them Core re-deriving facts only Feishu could state.
 * Here they are one small service over one document, and what leaves it is a
 * `team_name`.
 *
 * Every read is synchronous, against the last committed document; every write
 * is a commit, and a caller told that a route now exists or is gone is being
 * told what disk says. Nothing in progress lives here: automatic provisioning
 * is process-local work, and it reaches this service only as the final binding
 * it installs.
 */
import { PublicInvokeFailure } from '@excitedjs/dreamux-utils';

import type { FeishuRoutingStore } from './store.js';
import type {
  FeishuBindingRecord,
  FeishuSpaceRecord,
  FeishuSpaceRepoPolicy,
  FeishuTargetRecord,
} from './document.js';
import { spaceId as deriveSpaceId } from './naming.js';
import {
  isBindableTarget,
  resolutionChain,
  targetKey,
  type FeishuTarget,
} from './target.js';

export interface FeishuRoutingPlanBound {
  readonly kind: 'bound';
  readonly teamName: string;
  /** The row that answered, which may be the parent group of a topic. */
  readonly matched: FeishuTarget;
}

export interface FeishuRoutingPlanProvision {
  readonly kind: 'provision';
  /**
   * The policy snapshot this provisioning runs under. It is the record as it
   * was committed when the plan was made, and a later policy update publishes
   * a new record rather than changing this one.
   */
  readonly space: FeishuSpaceRecord;
}

/**
 * Nothing this Channel routes to a Team answers here.
 *
 * It is a decision, not a gap: the message still reaches the Dispatcher Agent,
 * which is the recipient for every conversation an operator has not handed to
 * a Team — a direct chat with the bot, and a group nobody has bound.
 */
export interface FeishuRoutingPlanDispatcher {
  readonly kind: 'dispatcher';
  readonly reason: 'no_binding' | 'not_bindable';
}

export type FeishuRoutingPlan =
  | FeishuRoutingPlanBound
  | FeishuRoutingPlanProvision
  | FeishuRoutingPlanDispatcher;

export interface FeishuBindingView {
  readonly target_kind: FeishuTargetRecord['kind'];
  readonly chat_id: string;
  readonly thread_id: string | null;
  readonly display: string | null;
  readonly team_name: string;
  readonly origin: FeishuBindingRecord['origin'];
  readonly space_name: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

/**
 * A route that no longer exists, in the terms its removal is announced in.
 *
 * The row is gone from disk, so its display can no longer be read back; it
 * travels with the target because a caller telling a conversation it was
 * released names it the way the bind did.
 */
export interface FeishuRemovedRoute {
  readonly target: FeishuTarget;
  readonly display: string | null;
}

export class FeishuRouting {
  constructor(private readonly opts: {
    readonly dispatcherId: string;
    readonly channelId: string;
    readonly store: FeishuRoutingStore;
  }) {}

  // ── Resolution ─────────────────────────────────────────────────────────

  /**
   * Where an inbound message goes, decided entirely from local state.
   *
   * The order is the product rule: an exact binding wins, a topic's parent
   * group answers next, and only a target that matched nothing at all may be
   * provisioned. A message that reaches none of those goes to the Dispatcher
   * Agent, which is what an unbound conversation with this bot has always
   * been talking to — including after a restart, when provisioning that never
   * finished has simply left no binding behind.
   */
  plan(
    target: FeishuTarget,
    containerChatId: string | null,
  ): FeishuRoutingPlan {
    for (const candidate of resolutionChain(target)) {
      const binding = this.bindingFor(candidate);
      if (binding !== undefined) {
        return {
          kind: 'bound',
          teamName: binding.team_name,
          matched: candidate,
        };
      }
    }
    if (!isBindableTarget(target)) {
      return { kind: 'dispatcher', reason: 'not_bindable' };
    }
    const space = containerChatId === null
      ? undefined
      : this.spaceForContainer(containerChatId);
    return space === undefined
      ? { kind: 'dispatcher', reason: 'no_binding' }
      : { kind: 'provision', space };
  }

  bindingFor(target: FeishuTarget): FeishuBindingRecord | undefined {
    const key = targetKey(target);
    return this.opts.store.current.bindings.find(
      (row) => targetKey(fromRecord(row.target)) === key,
    );
  }

  spaceForContainer(chatId: string): FeishuSpaceRecord | undefined {
    return this.opts.store.current.spaces.find(
      (row) => row.container_chat_id === chatId,
    );
  }

  spaceByName(spaceName: string): FeishuSpaceRecord | undefined {
    return this.opts.store.current.spaces.find(
      (row) => row.space_name === spaceName,
    );
  }

  // ── Bindings ───────────────────────────────────────────────────────────

  /**
   * Install or move one route, and report what it displaced.
   *
   * The previous team is read inside the change rather than before it, because
   * the change is what the commit serializes: reading first would answer from
   * a document another commit may already have replaced. `requireOwner` is
   * checked in the same place and for the same reason — a precondition read
   * outside the commit is a precondition about a document that has moved on.
   */
  async bind(input: {
    target: FeishuTarget;
    teamName: string;
    display: string | null;
    origin: FeishuBindingRecord['origin'];
    spaceId: string | null;
    /**
     * When set, refuse a target another Team currently holds instead of
     * moving it. A Team may claim what is free and keep what is already its
     * own; taking a route away from another Team is a Dispatcher decision.
     */
    requireOwner?: string;
  }): Promise<{ previousTeamName: string | null }> {
    const displaced: { teamName: string | null } = { teamName: null };
    await this.opts.store.update((document) => {
      const key = targetKey(input.target);
      const now = Date.now();
      const existing = document.bindings.find(
        (row) => targetKey(fromRecord(row.target)) === key,
      );
      if (existing !== undefined) {
        if (
          input.requireOwner !== undefined &&
          existing.team_name !== input.requireOwner
        ) {
          // Deliberately says only that it belongs to someone else. Which
          // Team owns a route is a Dispatcher read, and a refusal is not the
          // place to hand it out.
          throw new PublicInvokeFailure(
            'This Feishu conversation is already routed to another Team. ' +
              'Ask the Dispatcher to move it.',
          );
        }
        displaced.teamName = existing.team_name;
        if (
          existing.team_name === input.teamName &&
          existing.display === input.display &&
          existing.origin === input.origin &&
          existing.space_id === input.spaceId
        ) {
          return false;
        }
        existing.team_name = input.teamName;
        existing.display = input.display;
        existing.origin = input.origin;
        existing.space_id = input.spaceId;
        existing.updated_at = now;
        return true;
      }
      document.bindings.push({
        target: toRecord(input.target),
        display: input.display,
        team_name: input.teamName,
        origin: input.origin,
        space_id: input.spaceId,
        created_at: now,
        updated_at: now,
      });
      return true;
    });
    return { previousTeamName: displaced.teamName };
  }

  /**
   * Remove one route. `requireOwner` restricts it to that Team's own routes.
   *
   * A target nobody routes is not a failure under either authority — there is
   * simply nothing to release, and the answer says so. A target another Team
   * holds is refused, because releasing it would end that Team's conversation.
   */
  async unbind(
    target: FeishuTarget,
    requireOwner?: string,
  ): Promise<string | null> {
    const removed: { teamName: string | null } = { teamName: null };
    await this.opts.store.update((document) => {
      const key = targetKey(target);
      const kept = document.bindings.filter((row) => {
        if (targetKey(fromRecord(row.target)) !== key) return true;
        if (requireOwner !== undefined && row.team_name !== requireOwner) {
          throw new PublicInvokeFailure(
            'This Feishu conversation is routed to another Team. Only the ' +
              'Dispatcher can release it.',
          );
        }
        removed.teamName = row.team_name;
        return false;
      });
      if (kept.length === document.bindings.length) return false;
      document.bindings = kept;
      return true;
    });
    return removed.teamName;
  }

  /**
   * Forget every route to a Team.
   *
   * Two kinds of evidence lead here — Core said the Team closed, or a
   * submission was rejected before admission — and both go through this one
   * commit, because a second synchronous authority would only disagree with
   * disk. Repeating it is free: a Team with no rows left changes nothing and
   * writes nothing, which is what closes the window between a Team closing and
   * the commit that records it.
   */
  async forgetTeam(teamName: string): Promise<{
    removed: readonly FeishuRemovedRoute[];
  }> {
    const removed: FeishuRemovedRoute[] = [];
    await this.opts.store.update((document) => {
      const kept = document.bindings.filter((row) => {
        if (row.team_name !== teamName) return true;
        removed.push({ target: fromRecord(row.target), display: row.display });
        return false;
      });
      if (kept.length === document.bindings.length) return false;
      document.bindings = kept;
      return true;
    });
    return { removed };
  }

  listBindings(): readonly FeishuBindingView[] {
    const spaces = new Map(
      this.opts.store.current.spaces.map((row) => [row.space_id, row]),
    );
    return this.opts.store.current.bindings.map((row) => ({
      target_kind: row.target.kind,
      chat_id: row.target.chat_id,
      thread_id: row.target.thread_id ?? null,
      display: row.display,
      team_name: row.team_name,
      origin: row.origin,
      space_name: row.space_id === null
        ? null
        : spaces.get(row.space_id)?.space_name ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  }

  // ── Collaboration Space policy ─────────────────────────────────────────

  async bindSpace(input: {
    spaceName: string;
    containerChatId: string;
    display: string | null;
    leaderAgentRuntime: string;
    identity: string | null;
    repo: FeishuSpaceRepoPolicy | null;
  }): Promise<FeishuSpaceRecord> {
    const id = deriveSpaceId({
      dispatcherId: this.opts.dispatcherId,
      channelId: this.opts.channelId,
      containerChatId: input.containerChatId,
    });
    const committed: { record: FeishuSpaceRecord | undefined } = {
      record: undefined,
    };
    await this.opts.store.update((document) => {
      const now = Date.now();
      const existing = document.spaces.find((row) => row.space_id === id);
      const conflicting = document.spaces.find(
        (row) => row.space_name === input.spaceName && row.space_id !== id,
      );
      if (conflicting !== undefined) {
        throw new PublicInvokeFailure(
          `Collaboration space ${JSON.stringify(input.spaceName)} is ` +
            'already bound to another Feishu chat. Choose another name, or ' +
            'unbind that space first.',
        );
      }
      if (existing === undefined) {
        const created: FeishuSpaceRecord = {
          space_id: id,
          space_name: input.spaceName,
          container_chat_id: input.containerChatId,
          display: input.display,
          generation: 1,
          leader_agent_runtime: input.leaderAgentRuntime,
          identity: input.identity,
          repo: input.repo,
          created_at: now,
          updated_at: now,
        };
        document.spaces.push(created);
        committed.record = created;
        return true;
      }
      // Only creation facts advance the generation: a rename or a new display
      // names the same policy snapshot. Either way the update reaches Team
      // creations that start after it and no others — a creation already under
      // way holds the record this document replaced.
      const rebound =
        existing.leader_agent_runtime !== input.leaderAgentRuntime ||
        existing.identity !== input.identity ||
        JSON.stringify(existing.repo) !== JSON.stringify(input.repo);
      existing.space_name = input.spaceName;
      existing.display = input.display;
      existing.leader_agent_runtime = input.leaderAgentRuntime;
      existing.identity = input.identity;
      existing.repo = input.repo;
      existing.updated_at = now;
      if (rebound) existing.generation += 1;
      committed.record = existing;
      return true;
    });
    const saved = committed.record;
    if (saved === undefined) {
      throw new Error('feishu space policy was not saved');
    }
    return saved;
  }

  /**
   * Stop provisioning for a space without touching what it already produced.
   *
   * The Teams it created are ordinary Teams and the bindings it installed keep
   * routing. Removing a policy is a statement about the future only — it is
   * never a dissolve, never a bulk unbind, and never a cancellation of a Team
   * creation already under way.
   */
  async unbindSpace(spaceName: string): Promise<FeishuSpaceRecord | null> {
    const removed: { record: FeishuSpaceRecord | undefined } = {
      record: undefined,
    };
    await this.opts.store.update((document) => {
      const kept = document.spaces.filter((row) => {
        if (row.space_name !== spaceName) return true;
        removed.record = row;
        return false;
      });
      if (kept.length === document.spaces.length) return false;
      document.spaces = kept;
      return true;
    });
    return removed.record ?? null;
  }

  listSpaces(): readonly FeishuSpaceRecord[] {
    return this.opts.store.current.spaces;
  }
}

function toRecord(target: FeishuTarget): FeishuTargetRecord {
  return {
    kind: target.kind,
    chat_id: target.chatId,
    ...(target.threadId !== undefined ? { thread_id: target.threadId } : {}),
  };
}

function fromRecord(record: FeishuTargetRecord): FeishuTarget {
  return {
    kind: record.kind,
    chatId: record.chat_id,
    ...(record.thread_id !== undefined ? { threadId: record.thread_id } : {}),
  };
}
